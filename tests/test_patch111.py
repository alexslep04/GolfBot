"""Patch 1.1.1 scoring, many-player turns, queue acceptance and saved results."""
from contextlib import ExitStack
import asyncio
import random
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from bot import legal_actions, play_action
from game import Card, GolfGame, Rules, Slot
from match_settings import house_rules
from patches import PATCH_VERSION
from player_stats import build_stats
from scoring import active_rule_effects, column_score, visible_effect_total
from server import Room, Store, create_app, snapshot


def hand(ranks, suits='SHDCHS', visible=True):
    return [Slot(Card(rank, suit), visible) for rank, suit in zip(ranks, suits)]


class Scoring111Tests(unittest.TestCase):
    def test_house_includes_all_in_color_but_excludes_four_kind_beggars_and_suited_rows(self):
        preset = house_rules()
        for key in ('four_kind', 'beggars', 'suited_rows'):
            self.assertFalse(preset[key])
        self.assertTrue(preset['all_in_color'])
        self.assertEqual(sum(preset.values()), 12)

    def test_red_and_black_suited_rows_use_middle_base_points(self):
        game = GolfGame(rules=Rules(suited_rows=True))
        game.players = [hand([8, 2, 4, 3, 5, 10], 'HHHCCC'), hand([1, 4, 8, 6, 9, 13])]
        # Red 2 gives the opponent -2; black 5 gives its owner -5.
        self.assertEqual(game.score(0), column_score(game.players[0], game.rules) - 5)
        self.assertEqual(game.score(1), column_score(game.players[1], game.rules) - 2)
        effects = active_rule_effects(game.players[0], game.rules)
        self.assertIn('Suited row 1: opponents -2', effects)
        self.assertIn('Suited row 2: -5', effects)
        game._record_scoring_effects()
        self.assertIn('suited_rows', game.activated_rules[0])

    def test_rows_require_identical_suit_not_just_color_and_each_row_counts(self):
        game = GolfGame(rules=Rules(suited_rows=True))
        game.players[0] = hand([1, 5, 3, 4, 6, 8], 'HDHHHH')
        game.players[1] = hand([2, 4, 7, 9, 11, 13], 'SCHDSC')
        baseline = column_score(game.players[1], game.rules)
        self.assertEqual(game.score(1), baseline + 6)
        game.players[0][1].card = Card(5, 'H')
        self.assertEqual(game.score(1), baseline + 11)

    def test_middle_value_is_independent_of_column_cancellation_and_divisions(self):
        game = GolfGame(rules=Rules(suited_rows=True,roman_fives=True))
        game.players[0] = hand([8,2,4,3,2,6],'SSSHDH')
        # The 2s cancel in their column; the suited black row still subtracts
        # the middle card's -2 (adding 2). Its V independently earns /2.
        self.assertEqual(column_score(game.players[0],game.rules),21)
        self.assertEqual(game.score(0),12)

    def test_colors_and_suited_effects_apply_additions_then_multiply_then_divide(self):
        game = GolfGame(rules=Rules(suited_rows=True, all_in_color=True))
        game.players = [hand([1, 3, 4, 5, 6, 8], 'HHHDDD'), hand([3, 5, 7, 9, 10, 12], 'SSSCCC')]
        # Black's own rows subtract 5+10, red's rows add 3+6.
        total = (column_score(game.players[1], game.rules) - 15 + 9) * 2
        self.assertEqual(game.score(1), (total + 1) // 2)
        self.assertEqual(game.score_divisor(1), 2)
        self.assertEqual(visible_effect_total(game.players[1], game.rules, opponent_layout=game.players[0]), game.score(1))

    def test_hidden_cards_do_not_activate_provisional_color_or_row_effects(self):
        game = GolfGame(rules=Rules(all_in_color=True, suited_rows=True))
        game.players = [hand([1, 3, 4, 5, 6, 8], 'HHHDDD', False), hand([3, 5, 7, 9, 10, 12])]
        game.players[0][0].visible = True
        self.assertEqual(visible_effect_total(game.players[1], game.rules, opponent_layout=game.players[0]), column_score(game.players[1], game.rules))
        self.assertNotIn('All in red: opponents ×2', active_rule_effects(game.players[0], game.rules))

    def test_multiple_opponents_stack_incoming_additions_and_multiplications(self):
        game = GolfGame(rules=Rules(all_in_color=True, suited_rows=True, angels_row=True), multiplayer=True, player_count=3)
        game.players = [hand([1, 3, 4, 5, 6, 8], 'HHHDDD'), hand([3, 4, 5, 6, 7, 8], 'DDDHHH'), hand([1, 4, 7, 3, 8, 12])]
        game.angel_earned = [True, True, False]
        expected = (column_score(game.players[2], game.rules) + 3 + 6 + 4 + 7) * 2 * 2 * 9 * 9
        self.assertEqual(game.score(2), expected)
        room = Room('r', 'Table', game.rules, 1, 'random', False, ['a', 'b', 'c'], ['A', 'B', 'C'], game=game, game_type='many', status='playing')
        room.resize_seats()
        view = snapshot(room, 'c')
        self.assertEqual(view['game']['effect_totals'][2], expected)
        self.assertIn('Incoming Angels 999: ×81', view['game']['effects'][2])


class ManyPlayerEngineTests(unittest.TestCase):
    def test_deck_count_and_unique_physical_cards(self):
        for count, decks in ((2,1),(3,2),(5,2),(6,3),(8,3),(9,4),(12,5),(30,11)):
            game = GolfGame(player_count=count, multiplayer=True)
            cards = game.draw_pile + game.discard_pile + [slot.card for hand in game.players for slot in hand]
            self.assertEqual(game.deck_count, decks)
            self.assertEqual(len(cards), 52 * decks)
            self.assertEqual(len(set(cards)), len(cards))

    def test_turn_order_and_every_other_player_gets_one_final_turn(self):
        game = GolfGame(seed=4, multiplayer=True, player_count=4, turn_order=[2,0,3,1], first_player=2)
        for p in range(4):
            for i in (0,1):
                game.opening_reveal(p,i)
        self.assertEqual(game.current, 2)
        for slot in game.players[2][:5]:
            slot.visible = True
        game.reveal(5)
        game.end_turn()
        for expected in (0,3,1):
            self.assertEqual(game.current, expected)
            self.assertTrue(game.is_final_turn)
            game.draw()
            game.discard()
        self.assertEqual(game.phase, 'over')
        self.assertEqual(game.turns, 4)
        self.assertTrue(all(slot.visible for hand in game.players for slot in hand))

    def test_bonus_finishing_nonacting_player_gives_actor_a_fresh_final_turn(self):
        game = GolfGame(multiplayer=True, player_count=3, turn_order=[0,2,1])
        game.phase = 'bonus'
        game.bonus_remaining = 1
        for slot in game.players[2]:
            slot.visible = True
        game.players[2][5].visible = False
        game.players[0][0].visible = True
        game.bonus_swap((0,0),(2,5))
        self.assertEqual(game.finisher,2)
        self.assertEqual(game.current,1)
        self.assertEqual(game.final_turn_queue,[0])

    def test_duplicate_jacks_are_distinct_and_reused_cards_do_not_retrigger(self):
        game = GolfGame(multiplayer=True, player_count=3, rules=Rules(royal_pairs=True))
        first, second, third, fourth = [Card(11,'S',deck) for deck in range(4)]
        game.players[0][0], game.players[0][3] = Slot(first,True), Slot(second,True)
        self.assertEqual(game._new_bonuses(0),1)
        game.players[0][0] = Slot(third,True)
        self.assertEqual(game._new_bonuses(0),0)
        game.players[0][3] = Slot(fourth,True)
        self.assertEqual(game._new_bonuses(0),1)

    def test_random_many_player_games_conserve_cards_and_complete(self):
        for seed in range(6):
            rules = Rules(**{key: True for key in Rules.__dataclass_fields__})
            game = GolfGame(seed=seed, multiplayer=True, player_count=3, rules=rules)
            for p in range(3):
                game.opening_reveal(p,0)
                game.opening_reveal(p,1)
            rng = random.Random(seed)
            for _ in range(600):
                if game.phase == 'over':
                    break
                actions = legal_actions(game)
                play_action(game,rng.choice(actions))
                cards = game.draw_pile + game.discard_pile + ([game.held_card] if game.held_card else []) + [slot.card for hand in game.players for slot in hand]
                self.assertEqual(len(cards),104)
                self.assertEqual(len(set(cards)),104)
            self.assertEqual(game.phase,'over')

    def test_five_matching_cards_with_extra_decks_can_arrange_four(self):
        game = GolfGame(multiplayer=True,player_count=3,rules=Rules(four_kind=True))
        game.players[0] = [Slot(Card(8,'S',deck),True) for deck in range(5)] + [Slot(Card(1,'H'),False)]
        game.phase='revealed'; game.flipped=4
        self.assertTrue(game._offer_four('revealed'))
        original = {slot.card for slot in game.players[0]}
        game.arrange_four((0,1))
        self.assertEqual({slot.card for slot in game.players[0]},original)
        self.assertTrue(all(game.players[0][i].card.rank == 8 for i in (0,1,3,4)))


class Web111Tests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        app = create_app(self.store,google_client_id='')
        self.host = self.context.enter_context(TestClient(app))
        self.guest, self.third = TestClient(app), TestClient(app)
        for client in (self.host,self.guest,self.third):
            self.addCleanup(client.close)
            client.get('/Golfgame/api/session').raise_for_status()

    def post(self,client,path,body=None,status=200):
        response = client.post('/Golfgame/api'+path,json=body)
        self.assertEqual(response.status_code,status,response.text)
        return response.json()

    def test_many_lobby_manual_host_start_and_hidden_cards(self):
        state = self.post(self.host,'/lobbies',{'username':'A','game_type':'many','series_mode':'points','best_of':3,'house_rules':True})
        path = '/lobbies/'+state['id']
        self.post(self.guest,path+'/join',{'username':'B'})
        room = self.store.rooms[state['id']]
        self.post(self.host,path+'/action',{'action':'start','version':room.version},409)
        self.post(self.third,path+'/join',{'username':'C'})
        self.assertIsNone(room.game)
        self.post(self.guest,path+'/action',{'action':'start','version':room.version},409)
        state = self.post(self.host,path+'/action',{'action':'start','version':room.version})
        self.assertEqual(state['game']['deck_count'],2)
        self.assertEqual(sorted(state['game']['turn_order']),[0,1,2])
        self.assertEqual(state['game']['first_player'],state['game']['turn_order'][0])
        self.assertTrue(all(slot['card'] is None for layout in state['game']['players'] for slot in layout))
        self.post(self.third,path+'/action',{'action':'flip','version':room.version,'index':0})
        self.assertTrue(room.game.players[2][0].visible)

    def test_many_waiting_guest_can_leave_without_corrupting_seats(self):
        state = self.post(self.host,'/lobbies',{'game_type':'many'})
        path = '/lobbies/'+state['id']
        self.post(self.guest,path+'/join',{'username':'B'})
        self.post(self.third,path+'/join',{'username':'C'})
        self.post(self.guest,path+'/leave')
        room = self.store.rooms[state['id']]
        self.assertEqual(room.names,['Player','C'])
        self.assertEqual([len(getattr(room,key)) for key in ('ready','participants','departed')],[2,2,2])

    def test_many_next_game_waits_for_every_player(self):
        state = self.post(self.host,'/lobbies',{'game_type':'many','best_of':3,'series_mode':'points'})
        path = '/lobbies/'+state['id']
        for client, name in ((self.guest,'B'),(self.third,'C')):
            self.post(client,path+'/join',{'username':name})
        room = self.store.rooms[state['id']]
        room.start_round(); room.game.phase='over'; room.record_result()
        for client in (self.guest,self.host):
            self.post(client,path+'/action',{'action':'next_round','version':room.version})
            self.assertEqual(room.status,'round_over')
        result = self.post(self.third,path+'/action',{'action':'next_round','version':room.version})
        self.assertEqual(result['game']['phase'],'setup')
        self.assertEqual(result['round'],2)

    def test_slow_viewer_does_not_delay_broadcast_to_other_players(self):
        state = self.post(self.host,'/lobbies',{'game_type':'many'})
        path = '/lobbies/'+state['id']
        self.post(self.guest,path+'/join',{'username':'B'})
        self.post(self.third,path+'/join',{'username':'C'})
        room = self.store.rooms[state['id']]
        room.start_round()
        delivery = {'slow_done':False,'fast_before_slow':False}
        class Slow:
            async def send_json(self, value):
                await asyncio.sleep(.05)
                delivery['slow_done'] = True
        class Fast:
            async def send_json(self, value):
                delivery['fast_before_slow'] = not delivery['slow_done']
        room.clients = {room.seats[0]:{Slow()},room.seats[1]:{Fast()}}
        self.post(self.host,path+'/action',{'action':'flip','version':room.version,'index':0})
        self.assertTrue(delivery['fast_before_slow'])

    def test_series_draw_only_counts_for_the_tied_lowest_players(self):
        room = Room('r','Tie',Rules(),1,'random',False,['a','b','c'],['A','B','C'],game_type='many',series_mode='points',history_store=self.store.history)
        room.resize_seats(); room.start_round(); room.game.phase='over'
        with patch.object(room.game,'score',side_effect=lambda p:[2,2,5][p]):
            room.record_result()
        records = self.store.history.results()
        self.assertEqual(records[0]['series_leaders'],[0,1])
        self.assertEqual(build_stats(records,'player:A')['player']['overall']['match_draws'],1)
        stats = build_stats(records,'player:C')['player']['overall']
        self.assertEqual((stats['match_losses'],stats['match_draws']),(1,0))

    def test_many_host_can_invite_after_second_player_joins(self):
        state = self.post(self.host,'/lobbies',{'game_type':'many'})
        self.post(self.guest,'/lobbies/'+state['id']+'/join',{'username':'B'})
        self.post(self.third,'/presence',{'username':'C'})
        presence = self.post(self.host,'/presence',{'username':'A'})
        player = next(p for p in presence['players'] if p['display_name']=='C')
        self.post(self.host,'/lobbies/'+state['id']+'/invite',{'player_id':player['id']})
        invitation = self.post(self.third,'/presence',{'username':'C'})['invitations'][0]
        result = self.post(self.third,'/invitations/'+invitation['id']+'/respond',{'accept':True,'username':'C'})
        self.assertEqual(result['players'],3)
        self.assertEqual(result['status'],'waiting')

    def test_fixed_series_play_all_scheduled_games_and_use_totals_not_wins(self):
        for length in (3,5,9):
            room = Room('r','Fixed',Rules(),length,'alternate',False,['a','b'],['A','B'],series_mode='points')
            for index in range(length):
                room.start_round()
                room.game.phase = 'over'
                scores = [-100,0] if index == 0 else [2,1]
                with patch.object(room.game,'score',side_effect=lambda p:scores[p]):
                    room.record_result()
                self.assertEqual(room.status,'finished' if index+1==length else 'round_over')
            self.assertIsNone(room.target)
            self.assertEqual(room.champion,0)
            self.assertEqual(len(room.history),length)

    def test_fixed_series_tie_is_saved_as_finished_and_counted_as_draw(self):
        room = Room('r','Tie',Rules(),3,'alternate',False,['a','b'],['A','B'],series_mode='points',history_store=self.store.history)
        for scores in ([0,2],[2,0],[3,3]):
            room.start_round(); room.game.phase = 'over'
            with patch.object(room.game,'score',side_effect=lambda p:scores[p]):
                room.record_result()
        match = self.store.history.results()[0]
        self.assertEqual(match['status'],'finished')
        self.assertIsNone(match['winner'])
        self.assertEqual(match['patch'],PATCH_VERSION)
        stats = build_stats([match],'player:A')['player']['overall']
        self.assertEqual((stats['match_wins'],stats['match_losses'],stats['match_draws']),(0,0,1))

    def test_queue_requires_both_accept_and_only_then_interrupts_solo(self):
        solo = self.post(self.host,'/solo',{'username':'A','best_of':3})
        old = self.store.rooms[solo['id']]
        # One completed game is retained, the next incomplete game is excluded.
        old.game.phase = 'over'
        old.record_result(); old.start_round()
        first = self.post(self.host,'/queue/join',{'username':'A'})
        self.assertEqual(first['status'],'waiting')
        offer = self.post(self.guest,'/queue/join',{'username':'B'})
        self.assertEqual(offer['status'],'offer')
        self.post(self.third,'/queue/offers/'+offer['id']+'/respond',{'accept':True},404)
        self.post(self.host,'/queue/offers/'+offer['id']+'/respond',{'accept':True})
        self.assertEqual(old.status,'playing')
        matched = self.post(self.guest,'/queue/offers/'+offer['id']+'/respond',{'accept':True})
        self.assertEqual(matched['status'],'matched')
        self.assertEqual(old.status,'closed')
        state = self.post(self.host,'/queue/enter')
        self.assertEqual(self.post(self.host,'/queue/enter')['id'],state['id'])
        self.assertEqual((state['best_of'],state['series_mode'],state['house_rules']),(5,'points',True))
        self.assertEqual(state['rules'],house_rules())
        result = self.store.history.results()[0]
        self.assertEqual(len(result['rounds']),1)
        self.assertEqual(result['status'],'abandoned')
        self.assertEqual(self.post(self.guest,'/queue/enter')['id'],state['id'])

    def test_queue_declines_and_offline_expirations_cancel_both_players(self):
        self.post(self.host,'/queue/join',{'username':'A'})
        offer = self.post(self.guest,'/queue/join',{'username':'B'})
        self.post(self.host,'/queue/offers/'+offer['id']+'/respond',{'accept':False})
        self.assertFalse(self.store.queue_offers)
        self.assertFalse(self.store.queue)
        self.post(self.host,'/queue/join',{'username':'A'})
        offer = self.post(self.guest,'/queue/join',{'username':'B'})
        self.store.queue_offers[offer['id']]['expires'] = 0
        result = self.post(self.host,'/presence',{'username':'A'})
        self.assertEqual(result['queue']['status'],'off')
        self.assertFalse(self.store.queue_offers)

    def test_queue_rejects_players_already_in_human_lobby(self):
        self.post(self.host,'/lobbies',{})
        self.post(self.host,'/queue/join',{'username':'A'},409)

    def test_patch_pages_and_stats_preserve_legacy_and_filter_both_columns(self):
        self.assertEqual(self.host.get('/Golfgame/patch-notes').status_code,200)
        self.assertEqual(self.host.get('/Golfgame/api/patch-notes').json()['current'],PATCH_VERSION)
        room = Room('r','Stats',Rules(),1,'host',True,['a',None],['A','Golfbot'],history_store=self.store.history)
        room.start_round(); room.game.phase='over'; room.record_result()
        current = self.store.history.results()[0]
        legacy = {**current,'id':'old','patch':None,'rounds':[{k:v for k,v in current['rounds'][0].items() if k != 'patch'}]}
        result = build_stats([current,legacy],'player:A','bot:golfbot',patch=PATCH_VERSION)
        self.assertEqual(result['player']['overall']['rounds'],1)
        self.assertEqual(result['comparison']['head_to_head']['rounds'],1)
        self.assertIn('legacy',result['patches'])
        self.assertEqual(build_stats([current,legacy],'player:A',patch='legacy')['player']['overall']['rounds'],1)

    def test_history_uses_game_end_time_and_identifies_third_seat_privately(self):
        for name, ended in (('Newer',200),('Older',100)):
            room = Room(name,name,Rules(),1,'random',False,['a','b','c'],['A','B','C'],game_type='many',series_mode='points')
            room.resize_seats(); room.start_round(); room.game.phase='over'; room.record_result()
            room.history[0]['ended_at'] = ended
            self.store.history.save(room)
        records = self.store.history.for_browser('c')
        self.assertEqual([record['lobby_name'] for record in records],['Newer','Older'])
        self.assertEqual(records[0]['viewer'],2)
        self.assertNotIn('browser',str(records))
        stats = build_stats(records,'player:C')['player']['overall']
        self.assertEqual(stats['rounds'],2)


if __name__ == '__main__':
    unittest.main()
