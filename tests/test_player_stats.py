import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from game import Card, Rules, Slot
from match_history import MatchHistory
from player_stats import BOT_ID, build_stats
from server import Room, Store, create_app


def result(scores, rules=None, divisors=None, activations=None):
    own, other = scores
    value = {'scores': scores, 'winner': None if own == other else int(own > other)}
    if rules is not None:
        value['rules'] = rules
    if divisors is not None:
        value['divisors'] = divisors
    if activations is not None:
        value['activations'] = activations
    return value


def match(names, rounds, winner=None, status='finished', solo=False, rules=None):
    return {'names': names, 'rounds': rounds, 'winner': winner, 'status': status,
            'solo': solo, 'rules': rules or {}}


class StatsTests(unittest.TestCase):
    def setUp(self):
        self.matches = [
            match(['tester', 'GolfBot'], [result([-2, 5], activations=[['v10', 'royal_pairs'], []]), result([3, 3]), result([4, 10], activations=[['v10'], ['gamblers_row']])], 0, solo=True),
            match(['Rival', 'tester'], [result([2, 8], activations=[[], ['poisoned_card']])], 0),
            match(['tester', 'GolfBot'], [result([10, 1], activations=[[], []])], status='interrupted', solo=True),
        ]

    def test_overall_and_head_to_head_count_rounds_series_draws_and_scores(self):
        data = build_stats(self.matches, 'player:tester', BOT_ID)
        overall = data['player']['overall']
        self.assertEqual((overall['rounds'], overall['round_wins'], overall['round_losses'], overall['round_draws']), (5, 2, 2, 1))
        self.assertEqual(overall['round_win_rate'], 2 / 5)
        self.assertEqual((overall['completed_matches'], overall['match_wins'], overall['match_losses']), (2, 1, 1))
        self.assertEqual(overall['match_win_rate'], .5)
        self.assertEqual(overall['unfinished_matches'], 1)
        self.assertEqual(overall['total_points'], 23)
        self.assertEqual(overall['average_points'], 4.6)
        self.assertEqual(overall['average_advantage'], 0.4)
        self.assertEqual((overall['best_round'], overall['worst_round']), (-2, 10))
        head = data['player']['head_to_head']
        reverse = data['comparison']['head_to_head']
        self.assertEqual((head['rounds'], head['round_wins'], head['round_losses'], head['round_draws']), (4, 2, 1, 1))
        self.assertEqual(head['match_win_rate'], 1)
        self.assertEqual(reverse['round_wins'], head['round_losses'])
        self.assertEqual(reverse['total_points'], 19)
        self.assertLess(head['average_advantage'], 0)
        self.assertEqual(head['average_advantage'], -reverse['average_advantage'])
        self.assertEqual(data['comparison']['profile']['label'], 'Golf (solo AI)')

    def test_rule_activation_rates_and_conditional_win_rates_ignore_unknown_details(self):
        overall = build_stats(self.matches, 'player:tester')['player']['overall']
        self.assertEqual((overall['known_activation_games'], overall['unknown_activation_games']), (4, 1))
        rules = {row['key']: row for row in overall['rule_activations']}
        self.assertEqual((rules['v10']['games'], rules['v10']['rate'], rules['v10']['win_rate']), (2, .5, 1))
        self.assertEqual(rules['poisoned_card']['win_rate'], 0)
        self.assertIsNone(rules['angels_row']['win_rate'])

    def test_rule_filters_use_round_settings_and_full_matching_series_only(self):
        matches = [
            match(['tester', 'Rival'], [result([1, 4], {'v10': True}), result([5, 2], {'v10': False})], 0, rules={'v10': False}),
            match(['tester', 'Rival'], [result([2, 8])], 0, rules={'v10': True}),
            match(['tester', 'Rival'], [result([9, 3])], 1, rules={'v10': True, 'roman_fives': True}),
        ]
        filtered = build_stats(matches, 'player:tester', 'player:Rival', ['v10'], ['roman_fives'])['player']['overall']
        self.assertEqual((filtered['rounds'], filtered['total_points']), (2, 3))
        self.assertEqual((filtered['completed_matches'], filtered['match_wins']), (1, 1))
        off = build_stats(matches, 'player:tester', disabled=['v10'])['player']['overall']
        self.assertEqual((off['rounds'], off['total_points'], off['completed_matches']), (1, 5, 0))

    def test_ai_identity_is_separate_from_human_named_golfbot_and_shared_names_combine(self):
        self.matches += [match(['tester', 'GolfBot'], [result([0, 2])], 0),
                         match(['tester', 'tester'], [result([0, 3])], 0)]
        data = build_stats(self.matches, 'player:tester', BOT_ID)
        ids = [player['id'] for player in data['players']]
        self.assertIn(BOT_ID, ids)
        self.assertIn('player:GolfBot', ids)
        self.assertEqual(data['player']['overall']['rounds'], 6)
        self.assertEqual(data['player']['overall']['ambiguous_matches'], 1)
        self.assertEqual(data['player']['head_to_head']['rounds'], 4)

    def test_empty_data_unplayed_pair_and_invalid_selections(self):
        self.assertIsNone(build_stats([])['player'])
        data = build_stats(self.matches, 'player:Rival', BOT_ID)
        self.assertEqual(data['player']['head_to_head']['rounds'], 0)
        self.assertIsNone(data['player']['head_to_head']['round_win_rate'])
        self.assertIsNone(data['player']['head_to_head']['average_points'])
        for player, opponent in [('player:missing', None), ('player:tester', 'player:missing'), ('player:tester', 'player:tester')]:
            with self.assertRaises(ValueError):
                build_stats(self.matches, player, opponent)


class StatsApiTests(unittest.TestCase):
    def test_reading_stats_keeps_a_live_game_unchanged(self):
        store = Store()
        with TestClient(create_app(store)) as client:
            client.get('/api/session')
            state = client.post('/api/solo', json={'username': 'tester'}).json()
            lobby = state['id']
            room = store.rooms[lobby]
            game = room.game
            version = room.version
            response = client.get('/api/stats')
            self.assertEqual(response.status_code, 200)
            self.assertIs(room.game, game)
            self.assertEqual(room.version, version)
            self.assertEqual(room.game.phase, 'setup')
            self.assertEqual(client.get('/api/session').json()['room_id'], lobby)

    def test_shared_api_aggregates_all_records_and_rejects_invalid_filters(self):
        store = Store()
        with TestClient(create_app(store), base_url='https://sleptsov.dev') as client:
            self.assertEqual(client.get('/Golfgame/api/stats').status_code, 401)
            client.get('/Golfgame/api/session')
            for index in range(65):
                payload = {**match(['tester', 'GolfBot'], [result([-2, 4])], 0, solo=True), 'id': str(index)}
                with store.history.connection:
                    store.history.connection.execute('INSERT INTO matches VALUES (?, ?, ?, ?, ?)',
                        (str(index), 'private-host-key', 'private-guest-key', index, json.dumps(payload)))
            response = client.get('/Golfgame/api/stats', params={'player': 'player:tester', 'opponent': BOT_ID})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['player']['overall']['rounds'], 65)
            self.assertEqual(response.headers['cache-control'], 'no-store')
            for secret in ('private-host-key', 'private-guest-key', 'golf_session', 'TunnelSecret'):
                self.assertNotIn(secret, response.text)
            for params in ({'enabled': 'fake_rule'}, {'enabled': 'v10', 'disabled': 'v10'}, {'player': 'player:missing'}):
                self.assertEqual(client.get('/Golfgame/api/stats', params=params).status_code, 422)
            for path in ('/stats', '/Golfgame/stats'):
                self.assertEqual(client.get(path).status_code, 200)

    def test_round_rules_and_actual_divisors_are_saved_without_cards_and_survive_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'history.sqlite3'
            history = MatchHistory(database)
            room = Room('room', 'Table', Rules(v10=True, roman_fives=True, gamblers_row=True), 3, 'host', True,
                        ['secret-token', None], ['tester', 'GolfBot'], history_store=history)
            room.start_round()
            # Top V is three ten-valued ranks; bottom V has 5+4+1=10.
            room.game.players[0] = [Slot(Card(rank, suit), True) for rank, suit in zip([10, 4, 11, 5, 12, 1], 'SHDCSH')]
            room.game.gambler_earned[0] = True
            room.game.phase = 'over'
            with patch.object(room.game, 'score', side_effect=lambda seat: [1, 2][seat]):
                room.record_result()
            room.rules = Rules()
            room.start_round()
            room.game.phase = 'over'
            with patch.object(room.game, 'score', side_effect=lambda seat: [3, 5][seat]):
                room.record_result()
            history.close()
            restored = MatchHistory(database)
            try:
                records = restored.results()
                rounds = records[0]['rounds']
                self.assertEqual(rounds[0]['divisors'][0], 105)
                self.assertEqual(rounds[1]['divisors'][0], 1)
                self.assertTrue(rounds[0]['rules']['v10'])
                self.assertFalse(rounds[1]['rules']['v10'])
                self.assertNotIn('secret-token', json.dumps(records))
                self.assertNotIn('players', json.dumps(records))
                stats = build_stats(records, 'player:tester', enabled=['v10'])['player']['overall']
                self.assertEqual(stats['rounds'], 1)
                self.assertIn('v10', rounds[0]['activations'][0])
                self.assertEqual(next(row for row in stats['rule_activations'] if row['key'] == 'v10')['win_rate'], 1)
            finally:
                restored.close()
