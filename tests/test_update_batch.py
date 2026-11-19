"""The lighter Poisoned Card, the Ofc! emote, move timing, and a profile for every guest."""
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from game import Card, GolfGame, Rules, Slot
from match_history import MatchHistory, guest_id
from player_stats import BOT_ID, GUESTS_ID, build_stats
from progression import GUESTS_ID as BOARD_GUESTS, Progression
from scoring import POISON_POINTS, active_rule_effects
from server import Emote, Room, Store, create_app, snapshot


def hand(ranks, visible=True):
    return [Slot(Card(rank, 'SHDC'[index % 4]), visible) for index, rank in enumerate(ranks)]


class SmallChangeTests(unittest.TestCase):
    def test_the_poisoned_card_adds_one_point(self):
        self.assertEqual(POISON_POINTS, 1)
        game = GolfGame(rules=Rules(poisoned_card=True))
        game.players[0] = hand([1, 3, 5, 9, 10, 12])
        game.finisher = 0
        with_poison = game.score(0)
        game.finisher = 1
        self.assertEqual(with_poison - game.score(0), 1)
        self.assertIn('Poisoned Card: +1', active_rule_effects(game.players[0], game.rules, poisoned=True))

    def test_ofc_is_an_emote_players_can_send(self):
        self.assertEqual(Emote(emote='ofc').emote, 'ofc')


class MoveTimeTests(unittest.TestCase):
    def room(self, **fields):
        room = Room('r', 'Table', Rules(), 3, 'host', False, ['a', 'b'], ['A', 'B'], **fields)
        room.clients = {'a': {object()}, 'b': {object()}}  # both have the table open
        room.start_round()
        room.game.phase, room.game.current = 'choose', 0
        return room

    def turn(self, room, now, turns, current, phase='choose'):
        room.game.turns, room.game.current, room.game.phase = turns, current, phase
        room.track_turn_time(now)

    def test_each_turn_is_timed_from_when_it_starts_until_it_ends(self):
        room = self.room()
        room.track_turn_time(100)     # A's turn starts
        room.track_turn_time(104)     # A flips: still the same turn
        self.turn(room, 112, 1, 1)    # A's turn ends after 12 s; B's starts
        self.turn(room, 120, 2, 0)    # B took 8 s
        self.turn(room, 123, 3, 1, 'over')  # A took 3 s and the game is over
        self.assertEqual((room.move_seconds, room.move_counts), ([15.0, 8.0], [2, 1]))
        with patch.object(room.game, 'score', side_effect=lambda seat: [1, 5][seat]):
            room.record_result()
        self.assertEqual((room.history[-1]['move_seconds'], room.history[-1]['move_counts']), ([15.0, 8.0], [2, 1]))
        room.start_round()
        self.assertEqual((room.move_seconds, room.move_counts, room.turn_clock), ([0.0, 0.0], [0, 0], None))

    def test_a_turn_you_leave_or_disconnect_during_is_not_timed(self):
        room = self.room()
        room.track_turn_time(100)
        room.drop_turn_time(1)        # the other player dropping out changes nothing for A
        room.drop_turn_time(0)        # A walks away mid-turn
        self.turn(room, 4000, 1, 1)   # and comes back much later to finish it
        self.assertEqual((room.move_seconds, room.move_counts), ([0.0, 0.0], [0, 0]))
        self.turn(room, 4006, 2, 0)   # B's turn counts as usual
        self.assertEqual((room.move_seconds, room.move_counts), ([0.0, 6.0], [0, 1]))

    def test_a_turn_that_starts_while_you_are_away_is_not_timed(self):
        room = self.room()
        room.clients['b'] = set()     # B has no connection when their turn comes up
        room.track_turn_time(100)
        self.turn(room, 105, 1, 1)
        room.clients['b'] = {object()}
        self.turn(room, 900, 2, 0)
        self.assertEqual((room.move_seconds, room.move_counts), ([5.0, 0.0], [1, 0]))

    def test_a_turn_spent_with_the_page_in_the_background_is_not_timed(self):
        room = self.room()
        socket = next(iter(room.clients['a']))
        room.track_turn_time(100)
        room.away.add(socket)         # A switches to another tab or app mid-turn
        self.assertFalse(room.seat_present(0))
        room.drop_turn_time(0)
        room.away.discard(socket)
        self.turn(room, 700, 1, 1)
        self.assertEqual(room.move_counts, [0, 0])

    def test_golfbot_and_the_opening_flips_are_never_timed(self):
        room = Room('r', 'Solo', Rules(), None, 'host', True, ['a', None], ['A', 'Golfbot'])
        room.clients = {'a': {object()}}
        room.start_round()
        room.track_turn_time(50)      # still the opening flips
        self.assertIsNone(room.turn_clock)
        self.turn(room, 100, 0, 1)    # Golfbot to play
        self.turn(room, 130, 1, 0)
        self.turn(room, 137, 2, 1)
        self.assertEqual((room.move_seconds, room.move_counts), ([7.0, 0.0], [1, 0]))

    def test_resuming_a_saved_game_does_not_time_the_turn_in_progress(self):
        room = self.room()
        room.turn_clock = None        # as after a restore
        room.drop_turn_time()
        self.turn(room, 9000, 1, 1)
        self.assertEqual(room.move_counts, [0, 0])

    def test_the_average_is_seconds_per_timed_turn_across_games(self):
        def game(scores, seconds=None, counts=None):
            result = {'scores': scores, 'rules': {}}
            if seconds is not None:
                result.update(move_seconds=seconds, move_counts=counts)
            return result
        match = {'names': ['A', 'B'], 'solo': False, 'rules': {}, 'status': 'finished', 'winner': 0,
                 'rounds': [game([1, 9], [30.0, 8.0], [3, 2]), game([2, 9], [10.0, 0.0], [1, 0]),
                            game([3, 9])]}  # the last game predates the record
        stats = build_stats([match], 'player:A', 'player:B')
        self.assertEqual(stats['player']['overall']['average_move_seconds'], 10)   # 40 s over 4 turns
        self.assertEqual(stats['player']['overall']['timed_turns'], 4)
        self.assertEqual(stats['comparison']['overall']['average_move_seconds'], 4)
        untimed = build_stats([{**match, 'rounds': [game([3, 9])]}], 'player:A')
        self.assertIsNone(untimed['player']['overall']['average_move_seconds'])


class GuestProfileTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.clients = []

    def guest(self, name, score):
        """A new browser plays one Practice game as a guest; returns its session."""
        client = TestClient(create_app(self.store), base_url='https://sleptsov.dev')
        self.addCleanup(client.close)
        self.clients.append(client)
        session = client.get('/golf/api/session').json()
        state = client.post('/golf/api/solo', json={'username': name, 'practice': True}).json()
        room = self.store.rooms[state['id']]
        self.assertEqual(state['player_ids'], [session['player_id'], BOT_ID])
        room.game.phase = 'over'
        with patch.object(room.game, 'score', side_effect=lambda seat: score if seat == 0 else 5):
            room.record_result()
        client.post(f"/golf/api/lobbies/{room.id}/leave").raise_for_status()
        return session

    def test_guests_who_share_a_name_each_have_their_own_profile(self):
        first, second = self.guest('Sam', 2), self.guest('Sam', 9)
        self.assertNotEqual(first['player_id'], second['player_id'])
        self.assertTrue(first['player_id'].startswith('browser:'))
        results = self.store.history.results()
        won = build_stats(results, first['player_id'])
        lost = build_stats(results, second['player_id'])
        self.assertEqual((won['player']['profile']['label'], won['player']['overall']['round_wins']), ('Sam (guest)', 1))
        self.assertEqual((lost['player']['overall']['rounds'], lost['player']['overall']['round_wins']), (1, 0))
        # but advanced stats show every guest as one Guest, which is where a guest's page opens
        mine = self.clients[1].get('/golf/api/stats', params={'house_rules': 'false'}).json()
        self.assertEqual(mine['player']['profile']['id'], GUESTS_ID)
        self.assertEqual([player['label'] for player in mine['players']].count('Guest'), 1)
        overall = mine['player']['overall']
        self.assertEqual((overall['rounds'], overall['round_wins'], overall['round_losses']), (2, 1, 1))

    def test_the_rankings_show_every_guest_as_one_guest(self):
        self.guest('Sam', 2), self.guest('Sam', 9), self.guest('Lee', 1)
        board = build_stats(self.store.history.results())['leaderboard']
        self.assertEqual([row['profile']['id'] for row in board], [GUESTS_ID, BOT_ID])
        guests = board[0]
        self.assertEqual((guests['profile']['label'], guests['profile']['guests']), ('Guest', 3))
        self.assertEqual((guests['rounds'], guests['round_wins'], guests['round_losses']), (3, 2, 1))
        self.assertEqual(guests['average_points'], 4)
        boards = self.clients[0].get('/golf/api/leaderboards').json()
        self.assertEqual([(row['id'], row['label'], row['guests']) for row in boards['solo']], [(BOARD_GUESTS, 'Guest', 3)])
        self.assertEqual((boards['solo'][0]['wins'], boards['solo'][0]['losses'], boards['solo'][0]['best_streak']), (2, 1, 1))

    def test_games_saved_before_guests_had_ids_are_split_by_browser(self):
        history = MatchHistory()
        self.addCleanup(history.close)
        for token, score in (('one', 1), ('two', 9)):
            room = Room(token, 'Old', Rules(), None, 'host', True, [token, None], ['Sam', 'Golfbot'], history_store=history)
            room.start_round()
            room.game.phase = 'over'
            with patch.object(room.game, 'score', side_effect=lambda seat: score if seat == 0 else 5):
                room.record_result()
        results = history.results()
        self.assertEqual(sorted(match['participants'][0]['id'] for match in results), sorted([guest_id('one'), guest_id('two')]))
        self.assertTrue(all(match['participants'][1] is None for match in results))  # Golfbot's seat
        self.assertEqual(build_stats(results, guest_id('one'))['player']['overall']['round_wins'], 1)
        self.assertEqual(build_stats(results, guest_id('two'))['player']['overall']['round_wins'], 0)


class GuestBoardTests(unittest.TestCase):
    def setUp(self):
        self.history = MatchHistory()
        self.addCleanup(self.history.close)
        self.service = Progression(self.history)
        self.account = {'id': 'account:one', 'kind': 'account', 'unique_name': 'one', 'display_name': 'One'}
        self.guests = [{'id': f'browser:{name}', 'kind': 'guest', 'display_name': name} for name in ('ann', 'bob')]

    def test_pvp_shows_one_guest_with_the_average_elo_and_summed_record(self):
        ann, bob = self.guests
        self.service.rate_game('g1', [self.account, ann], 1)   # ann beats the account
        self.service.rate_game('g2', [ann, bob], 0)            # ann beats bob
        raw = {row['id']: row for row in self.service.leaderboard(combine_guests=False)['pvp']}
        board = self.service.leaderboard()['pvp']
        self.assertEqual(sorted(row['id'] for row in board), sorted(['account:one', BOARD_GUESTS]))
        guest = next(row for row in board if row['id'] == BOARD_GUESTS)
        self.assertEqual(guest['elo'], round((raw['browser:ann']['elo'] + raw['browser:bob']['elo']) / 2))
        self.assertEqual((guest['label'], guest['guests'], guest['wins'], guest['losses'], guest['draws']), ('Guest', 2, 2, 1, 0))
        self.assertEqual(guest['win_rate'], 2 / 3)
        self.assertEqual([row['id'] for row in board], [BOARD_GUESTS, 'account:one'])  # ranked by Elo with everyone else

    def test_solo_shows_the_best_guest_streak_and_a_board_without_guests_is_unchanged(self):
        ann, bob = self.guests
        for event, guest, winner in (('a1', ann, 0), ('a2', ann, 0), ('a3', ann, 1), ('b1', bob, 0)):
            self.service.practice_result(event, guest, winner)
        self.service.practice_result('o1', self.account, 0)
        solo = self.service.leaderboard()['solo']
        guest = next(row for row in solo if row['id'] == BOARD_GUESTS)
        self.assertEqual((guest['best_streak'], guest['current_streak'], guest['wins'], guest['losses']), (2, 1, 3, 1))
        self.assertEqual([row['id'] for row in solo], [BOARD_GUESTS, 'account:one'])
        only_accounts = [row for row in self.service.leaderboard(combine_guests=False)['solo'] if row['id'].startswith('account:')]
        self.assertEqual(Progression._combine_guests(only_accounts, True), only_accounts)


class TableIdentityTests(unittest.TestCase):
    def test_the_table_says_who_is_in_each_seat(self):
        room = Room('r', 'Table', Rules(), 1, 'host', False, ['a', 'b'], ['A', 'B'],
                    participants=[{'id': 'account:x'}, None])
        self.assertEqual(snapshot(room, 'a')['player_ids'], ['account:x', None])


if __name__ == '__main__':
    unittest.main()
