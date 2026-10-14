"""HTTP/WebSocket authorization, hidden information, and multiplayer flow."""
from contextlib import ExitStack
import random
import time
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from game import Card, GolfGame, Rules, Slot
from server import COOKIE, Move, Room, Store, apply_move, create_app, snapshot


class WebTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.app = create_app(self.store)
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        self.host = self.context.enter_context(TestClient(self.app))
        self.guest = TestClient(self.app)
        self.outsider = TestClient(self.app)
        self.addCleanup(self.guest.close)
        self.addCleanup(self.outsider.close)
        for client in (self.host, self.guest, self.outsider):
            client.get('/api/session')

    def create(self, **settings):
        response = self.host.post('/api/lobbies', json={'username': 'Alex', 'name': 'Test table', **settings})
        self.assertEqual(response.status_code, 200, response.text)
        self.id = response.json()['id']
        self.room = self.store.rooms[self.id]
        return response.json()

    def state(self, client=None):
        response = (client or self.host).get(f'/api/lobbies/{self.id}/state')
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def move(self, action, client=None, status=200, **extra):
        client = client or self.host
        response = client.post(f'/api/lobbies/{self.id}/action', json={'action': action, 'version': self.room.version, **extra})
        self.assertEqual(response.status_code, status, response.text)
        return response.json()

    def start(self, **settings):
        self.create(**settings)
        self.assertEqual(self.guest.post(f'/api/lobbies/{self.id}/join', json={'username': 'Sam'}).status_code, 200)
        self.move('ready', self.guest)
        self.move('start')
        for client in (self.host, self.guest):
            for index in (0, 1):
                self.move('flip', client, index=index)

    def test_menu_assets_and_rule_catalog(self):
        for path in ('/', '/lobby/invite', '/static/app.js', '/static/style.css', '/health'):
            self.assertEqual(self.host.get(path).status_code, 200)
        catalog = self.host.get('/api/rules').json()
        self.assertEqual({item['key'] for item in catalog}, set(Rules.__dataclass_fields__))
        self.assertTrue(all(item['description'] for item in catalog))
        cookie = self.host.get('/api/session').headers['set-cookie']
        self.assertIn('HttpOnly', cookie)
        self.assertIn('SameSite=lax', cookie)

    def test_lobby_configuration_membership_and_host_start(self):
        created = self.create(first='guest', best_of=5, rules={'queen_swap': True})
        self.assertTrue(created['rules']['queen_swap'])
        self.assertEqual(created['target'], 3)
        self.move('start', status=409)
        self.assertEqual(self.outsider.get(f'/api/lobbies/{self.id}/state').status_code, 403)
        self.guest.post(f'/api/lobbies/{self.id}/join', json={'username': 'Sam'})
        self.assertEqual(self.outsider.post(f'/api/lobbies/{self.id}/join', json={'username': 'Third'}).status_code, 409)
        self.move('start', self.guest, status=409)
        self.move('ready', status=409)
        self.move('ready', self.guest)
        state = self.move('start')
        self.assertEqual(state['game']['first_player'], 1)
        self.assertEqual(state['game']['phase'], 'setup')
        self.assertEqual(state['names'], ['Alex', 'Sam'])

    def test_both_players_choose_exactly_two_opening_cards(self):
        self.create(first='guest')
        self.guest.post(f'/api/lobbies/{self.id}/join', json={'username': 'Sam'})
        self.move('ready', self.guest)
        self.move('start')
        self.move('flip', self.guest, index=4)
        self.move('flip', self.guest, index=5)
        self.move('flip', self.guest, index=3, status=422)
        self.assertEqual(self.state()['game']['phase'], 'setup')
        self.move('flip', index=1)
        final = self.move('flip', index=3)
        self.assertEqual(final['game']['phase'], 'choose')
        self.assertEqual(final['game']['current'], 1)
        self.move('draw', status=403)
        self.move('draw', self.guest)
        self.move('discard', self.guest)
        self.assertEqual(self.state()['game']['current'], 0)

    def test_hidden_cards_never_serialized_even_to_owner(self):
        self.start()
        before = self.state()
        # Alter every hidden card: every public field must stay identical.
        for layout in self.room.game.players:
            for slot in layout:
                if not slot.visible:
                    slot.card = Card(12, 'D')
        self.room.game.draw_pile[-1] = Card(11, 'S')
        self.assertEqual(before, self.state())
        for client in (self.host, self.guest):
            game = self.state(client)['game']
            self.assertNotIn('draw_pile', game)
            self.assertTrue(all(slot['card'] is None for hand in game['players'] for slot in hand if not slot['visible']))
        info = self.outsider.get(f'/api/lobbies/{self.id}').json()
        self.assertNotIn('game', info)

    def test_roman_fives_public_state_agrees_with_final_scores(self):
        self.start(rules={'roman_fives': True, 'king_queen': True, 'ripped_five': True, 'holdem': True, 'tricky_straights': True})
        for ranks, cancelled_column in (([1, 4, 1, 5, 11, 1], 3), ([8, 4, 2, 3, 4, 10], 2)):
            with self.subTest(ranks=ranks):
                self.room.game.players[0] = [Slot(Card(rank, suit), True) for rank, suit in zip(ranks, 'SHDCSH')]
                public = self.state()['game']
                self.assertIn('Roman 5s /3', public['effects'][0])
                self.assertTrue(any(effect.startswith(f'Column {cancelled_column} pair: 0') for effect in public['effects'][0]))
                self.assertEqual(public['effect_totals'][0], 7)
                for rank, slot in zip(ranks, public['players'][0]):
                    self.assertEqual(slot['card']['rank'], rank)
                    self.assertEqual(slot['card']['points'], -2 if rank == 2 else min(rank, 10))
                self.room.game.phase = 'over'
                self.room.record_result()
                final = self.state()['game']
                self.assertEqual(final['scores'][0], 7)
                self.assertEqual(final['effect_totals'][0], 7)
                self.room.game.phase = 'choose'
                self.room.status = 'playing'
                self.room.round_recorded = False

    def test_draw_discard_and_visible_swap_paths(self):
        self.start()
        old_hand = self.state()['game']['players'][0]
        self.move('draw')
        self.move('swap', index=2, status=422)
        self.move('discard')
        self.assertEqual(self.state()['game']['players'][0], old_hand)
        self.assertEqual(self.room.game.current, 1)
        self.move('draw', self.guest)
        held = self.room.game.held_card
        self.move('swap', self.guest, index=0)
        self.assertEqual(self.room.game.players[1][0].card, held)
        self.move('draw')
        self.move('flip', index=2)
        self.move('swap', index=1, status=422)
        self.move('swap', index=2)

    def test_stale_and_malformed_moves_do_not_change_game(self):
        self.start()
        version = self.room.version
        self.move('draw')
        response = self.host.post(f'/api/lobbies/{self.id}/action', json={'action': 'discard', 'version': version})
        self.assertEqual(response.status_code, 409)
        before = self.state()
        for body in ({'action': 'swap', 'index': True}, {'action': 'swap', 'index': 6}, {'action': 'flip'}, {'action': 'invented'}):
            response = self.host.post(f'/api/lobbies/{self.id}/action', json={'version': self.room.version, **body})
            self.assertEqual(response.status_code, 422)
            self.assertEqual(before, self.state())
        self.move('set_rule', rule='queen_swap', enabled=True, status=403)

    def test_beggars_decision_belongs_to_opponent_and_resumes(self):
        self.start(rules={'beggars': True})
        game = self.room.game
        game.players = [
            [Slot(Card(rank, 'S'), i < 2) for i, rank in enumerate([3, 4, 5, 6, 7, 8])],
            [Slot(Card(rank, 'H'), i < 2) for i, rank in enumerate([12, 11, 9, 10, 1, 2])],
        ]
        state = self.move('flip', index=2)
        self.assertEqual(state['game']['phase'], 'guess')
        self.assertEqual(state['game']['players'][0][2]['card'], None)
        self.move('guess', rank=5, status=403)
        guessed = self.move('guess', self.guest, rank=5)
        self.assertEqual(guessed['game']['phase'], 'guess_trade')
        self.move('swap', refs=[[1, 0], [0, 0]], status=403)
        traded = self.move('swap', self.guest, refs=[[1, 0], [0, 0]])
        self.assertEqual(traded['game']['decision_player'], 0)
        self.assertEqual(traded['game']['phase'], 'revealed')
        self.move('end_turn')

    def test_bonus_can_move_opponent_and_pile_without_exposing_hidden_card(self):
        self.start(rules={'queen_swap': True})
        game = self.room.game
        game.players[0][0] = Slot(Card(12, 'S'), True)
        game.players[0][3] = Slot(Card(12, 'H'), True)
        self.move('draw')
        bonus = self.move('discard')
        self.assertTrue(bonus['game']['legal']['bonus'])
        self.move('swap', refs=[['draw', None], ['draw', None]], status=422)
        self.move('swap', refs=[[2, 0], ['discard', None]], status=422)
        hidden = game.players[1][2].card
        done = self.move('swap', refs=[[1, 2], ['draw', None]])
        self.assertEqual(game.draw_pile[-1], hidden)
        self.assertIsNone(done['game']['players'][1][2]['card'])

    def test_four_kind_api_offers_arrangement_and_resumes_turn(self):
        self.start(rules={'four_kind': True})
        game = self.room.game
        game.players[0] = [Slot(Card(rank, suit), visible) for rank, suit, visible in
                           [(9, 'S', True), (9, 'H', True), (9, 'D', False), (9, 'C', True), (3, 'S', False), (4, 'S', False)]]
        self.move('flip', index=2)
        self.assertEqual(self.state()['game']['phase'], 'arrange')
        self.move('arrange', self.guest, columns=[0, 1], status=403)
        state = self.move('arrange', columns=[0, 1])
        self.assertEqual(state['game']['phase'], 'revealed')
        self.assertEqual(sum(slot.visible for slot in game.players[0]), 4)
        self.move('end_turn')

    def test_final_turn_records_result_once_and_both_ready_for_next(self):
        self.start(first='alternate', best_of=3)
        game = self.room.game
        for i in (2, 3, 4):
            game.players[0][i].visible = True
        self.move('flip', index=5)
        self.assertEqual(self.room.history, [])
        self.move('end_turn')
        self.assertTrue(self.state(self.guest)['game']['final_turn'])
        self.move('draw', self.guest)
        result = self.move('discard', self.guest)
        self.assertEqual(len(result['history']), 1)
        self.assertEqual(result['status'], 'round_over')
        self.assertTrue(all(slot['card'] for hand in result['game']['players'] for slot in hand))
        self.move('discard', self.guest, status=409)
        self.move('next_round')
        self.assertEqual(self.room.status, 'round_over')
        next_state = self.move('next_round', self.guest)
        self.assertEqual(next_state['game']['phase'], 'setup')
        self.assertEqual(next_state['game']['first_player'], 1)
        self.assertEqual(len(next_state['history']), 1)

    def test_websocket_broadcast_reconnect_and_nonmember_rejection(self):
        self.create()
        with self.host.websocket_connect(f'/ws/{self.id}') as ws:
            self.assertTrue(ws.receive_json()['connected'][0])
            self.guest.post(f'/api/lobbies/{self.id}/join', json={'username': 'Sam'})
            self.assertEqual(ws.receive_json()['players'], 2)
            self.move('ready', self.guest)
            self.assertTrue(ws.receive_json()['ready'][1])
        with self.host.websocket_connect(f'/ws/{self.id}') as ws:
            state = ws.receive_json()
            self.assertEqual(state['viewer'], 0)
            self.assertTrue(state['ready'][1])
            ws.send_text('ping')
            self.assertEqual(ws.receive_json()['version'], self.room.version)
        with self.assertRaises(WebSocketDisconnect):
            with self.outsider.websocket_connect(f'/ws/{self.id}'):
                pass
        with self.assertRaises(WebSocketDisconnect):
            with self.host.websocket_connect(f'/ws/{self.id}', headers={'Origin': 'https://evil.invalid'}):
                pass

    def test_leave_reopens_waiting_guest_seat_and_closes_active_table(self):
        self.create()
        self.guest.post(f'/api/lobbies/{self.id}/join', json={'username': 'Sam'})
        self.guest.post(f'/api/lobbies/{self.id}/leave')
        self.assertEqual(self.state()['players'], 1)
        self.outsider.post(f'/api/lobbies/{self.id}/join', json={'username': 'New guest'})
        self.move('ready', self.outsider)
        self.move('start')
        self.outsider.post(f'/api/lobbies/{self.id}/leave')
        self.assertEqual(self.state()['status'], 'closed')
        self.move('draw', status=409)
        self.assertEqual(self.host.get('/api/lobbies').json(), [])

    def test_invalid_settings_and_cross_origin_requests(self):
        for body in ({'best_of': 2}, {'best_of': True}, {'username': '   '}, {'rules': {'not_a_rule': True}}, {'first': 'other'}):
            self.assertEqual(self.host.post('/api/lobbies', json=body).status_code, 422)
        self.assertEqual(self.host.post('/api/lobbies', json={}, headers={'Origin': 'https://evil.invalid'}).status_code, 403)
        self.assertEqual(TestClient(self.app).post('/api/lobbies', json={}).status_code, 401)

    def test_solo_preserves_rules_and_computer_turn(self):
        response = self.host.post('/api/solo', json={'username': 'Alex'})
        self.id = response.json()['id']
        self.room = self.store.rooms[self.id]
        self.move('set_rule', rule='king_queen', enabled=True)
        self.move('flip', index=0)
        self.move('flip', index=1)
        self.assertEqual(self.room.game.visible_count(1), 2)
        self.move('draw')
        self.move('discard')
        for _ in range(50):
            if self.state()['game']['current'] == 0:
                break
            time.sleep(0.1)
        self.assertEqual(self.room.game.current, 0)
        self.assertTrue(self.room.game.rules.king_queen)
        self.assertEqual(self.host.get('/api/lobbies').json(), [])


class MatchTests(unittest.TestCase):
    def room(self, first='alternate'):
        return Room('id', 'Table', Rules(), 3, first, False, ['host', 'guest'], ['Host', 'Guest'])

    def test_start_policies(self):
        for policy, expected in [('host', 0), ('guest', 1), ('alternate', 1), ('winner', 1), ('loser', 0)]:
            room = self.room(policy)
            room.history = [{'round': 1}]
            room.last_winner = 1
            room.start_round()
            self.assertEqual(room.game.first_player, expected)
        for chosen in (0, 1):
            room = self.room('random')
            with patch('server.secrets.randbelow', return_value=chosen):
                room.start_round()
            self.assertEqual(room.game.first_player, chosen)

    def test_ties_and_first_to_target_then_rematch(self):
        room = self.room()
        for scores, expected in [([10, 10], [0, 0]), ([0, 12], [1, 0]), ([-3, 5], [2, 0])]:
            room.start_round()
            room.game.phase = 'over'
            room.game.score = lambda p, scores=scores: scores[p]
            room.record_result()
            room.record_result()
            self.assertEqual(room.wins, expected)
        self.assertEqual(len(room.history), 3)
        self.assertEqual(room.status, 'finished')
        self.assertEqual(room.champion, 0)
        apply_move(room, 'host', Move(action='rematch', version=room.version))
        self.assertEqual(room.history, [])
        self.assertEqual(room.status, 'waiting')
        self.assertEqual(room.ready, [False, False])

    def test_disconnected_room_cleanup(self):
        store = Store()
        room = self.room()
        room.touched = time.time() - 13 * 3600
        room.clients = {'host': set()}
        store.rooms[room.id] = room
        store.cleanup()
        self.assertNotIn(room.id, store.rooms)

    def test_all_rules_multiplayer_simulations_obey_roles_and_preserve_cards(self):
        rng = random.Random(153)
        for seed in range(50):
            room = self.room()
            room.rules = Rules(**{key: True for key in Rules.__dataclass_fields__})
            room.game = GolfGame(seed=seed, rules=room.rules, multiplayer=True, first_player=seed % 2)
            room.status = 'playing'
            for seat, token in enumerate(room.seats):
                for index in (0, 1):
                    apply_move(room, token, Move(action='flip', version=room.version, index=index))
            for _ in range(300):
                game = room.game
                if room.status != 'playing':
                    break
                token = room.seats[game.decision_player]
                public = snapshot(room, token)['game']
                phase = game.phase
                args = {}
                if phase == 'choose':
                    hidden = public['legal']['flip']
                    action = 'flip' if hidden else 'draw'
                    if hidden:
                        args['index'] = rng.choice(hidden)
                elif phase == 'revealed':
                    action = 'end_turn'
                elif phase in ('drawn', 'drawn_revealed'):
                    action = 'discard'
                elif phase == 'guess':
                    action = 'guess'
                    args['rank'] = rng.randint(1, 13)
                elif phase == 'guess_trade':
                    action = 'swap'
                    args['refs'] = [list(public['legal']['trade'][0][0]), list(public['legal']['trade'][1][0])]
                elif phase == 'arrange':
                    action = 'arrange'
                    args['columns'] = rng.choice(public['legal']['arrange']) if public['legal']['arrange'] else None
                elif phase == 'bonus':
                    action = 'swap'
                    args['refs'] = [list(ref) for ref in rng.sample(game.table_refs(), 2)]
                else:
                    self.fail(f'Unexpected phase {phase}')
                apply_move(room, token, Move(action=action, version=room.version, **args))
                cards = [slot.card for hand in game.players for slot in hand] + game.draw_pile + game.discard_pile
                if game.held_card:
                    cards.append(game.held_card)
                self.assertEqual(len(cards), 52)
                self.assertEqual(len(set(cards)), 52)
            self.assertNotEqual(room.status, 'playing', f'Seed {seed} did not finish')


if __name__ == '__main__':
    unittest.main()
