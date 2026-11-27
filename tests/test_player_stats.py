import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from game import Card, Rules, Slot
from match_history import MatchHistory, browser_key, guest_id
from player_stats import BOT_ID, GUESTS_ID, build_stats
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
            match(['tester', 'GolfBot'], [result([-2, 5], activations=[['v10', 'royal_pairs'], []]), result([3, 3]), result([4, 10], activations=[['v10'], ['angel_numbers']])], 0, solo=True),
            match(['Rival', 'tester'], [result([2, 8], activations=[[], ['poisoned_card']])], 0),
            match(['tester', 'GolfBot'], [result([10, 1], activations=[[], []])], status='interrupted', solo=True),
        ]

    def test_advanced_stats_merge_every_guest_into_one_guest(self):
        account = {'id': 'account:7', 'kind': 'account', 'unique_name': 'ace', 'display_name': 'Ace'}
        browser = {'id': 'browser:abc', 'kind': 'guest', 'display_name': 'Sam'}
        games = self.matches + [
            {**match(['Ace', 'Sam'], [result([1, 9]), result([7, 2])], None, status='abandoned'),
             'participants': [account, browser]},
        ]
        data = build_stats(games, browser['id'], 'account:7', profiles=[browser], merge_guests=True)
        # tester, Rival and Sam are one choice; the account and Golfbot keep their own
        self.assertEqual(sorted(player['label'] for player in data['players']), ['@ace', 'Golfbot (solo CPU)', 'Guest'])
        self.assertEqual(data['player']['profile']['id'], GUESTS_ID)
        # tester's solo games and Sam's games against Ace count for Guest, and a guest-vs-guest
        # game (Rival v tester) counts from both seats, as the ranking sums every guest's record
        overall = data['player']['overall']
        self.assertEqual((overall['rounds'], overall['round_wins'], overall['round_losses']), (4 + 2 + 2, 4, 3))
        self.assertEqual(overall['ambiguous_matches'], 0)
        self.assertEqual(data['player']['head_to_head']['rounds'], 2)
        self.assertEqual(build_stats(games, 'player:Rival', BOT_ID, merge_guests=True)['player']['profile']['label'], 'Guest')
        with self.assertRaises(ValueError):  # two guests are now the same player
            build_stats(games, 'player:tester', 'browser:abc', merge_guests=True)

    def test_leaderboard_ranks_by_game_win_rate_with_unplayed_filters_last(self):
        data = build_stats(self.matches)
        board = data['leaderboard']
        # Rival won their only game; tester won 2 of 5; Golfbot 1 of 4.
        # Every guest is one "Guest" on the ranking: Rival won their only game and
        # tester won 2 of 5, so together 3 of 6. Golfbot won 1 of 4.
        self.assertEqual([row['profile']['id'] for row in board], [GUESTS_ID, BOT_ID])
        self.assertEqual([row['round_win_rate'] for row in board], [3 / 6, 1 / 4])
        self.assertEqual((board[0]['round_wins'], board[0]['round_losses'], board[0]['round_draws']), (3, 2, 1))
        self.assertEqual((board[0]['profile']['label'], board[0]['profile']['guests']), ('Guest', 2))
        # each guest still has their own record
        self.assertEqual(build_stats(self.matches, 'player:Rival')['player']['overall']['round_win_rate'], 1)
        self.assertEqual(build_stats(self.matches, 'player:tester')['player']['overall']['round_win_rate'], 2 / 5)
        # A filter nobody has played under leaves every rate empty, and nobody is dropped.
        empty = build_stats(self.matches, enabled=['angel_numbers'])['leaderboard']
        self.assertEqual(len(empty), 2)
        self.assertTrue(all(row['rounds'] == 0 and row['round_win_rate'] is None for row in empty))

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
        self.assertEqual(data['comparison']['profile']['label'], 'Golfbot (solo CPU)')

    def test_rule_activation_rates_and_conditional_win_rates_ignore_unknown_details(self):
        overall = build_stats(self.matches, 'player:tester')['player']['overall']
        self.assertEqual((overall['known_activation_games'], overall['unknown_activation_games']), (4, 1))
        rules = {row['key']: row for row in overall['rule_activations']}
        self.assertEqual((rules['v10']['games'], rules['v10']['rate'], rules['v10']['win_rate']), (2, .5, 1))
        self.assertEqual(rules['poisoned_card']['win_rate'], 0)
        self.assertIsNone(rules['angel_numbers']['win_rate'])

    def test_each_rule_is_broken_into_its_parts_over_the_games_that_record_them(self):
        games = [match(['tester', 'GolfBot'], [
            {**result([-2, 5], activations=[['angel_numbers', 'holdem'], []]),
             'subrule_activations': [['angel_numbers:777', 'angel_numbers:999', 'holdem:flush', 'bogus:part'], []]},
            {**result([6, 3], activations=[['angel_numbers'], []]),
             'subrule_activations': [['angel_numbers:777'], []]},
            # an older game: whole rules only, so it is left out of the parts
            result([1, 4], activations=[['angel_numbers'], []]),
        ], 0, solo=True)]
        overall = build_stats(games, 'player:tester')['player']['overall']
        self.assertEqual(overall['known_subrule_games'], 2)
        rules = {row['key']: row for row in overall['rule_activations']}
        self.assertEqual(rules['angel_numbers']['games'], 3)
        parts = {part['key']: part for part in rules['angel_numbers']['subrules']}
        self.assertEqual(list(parts), ['666', '777', '888', '999'])
        self.assertEqual((parts['777']['games'], parts['777']['rate'], parts['777']['win_rate']), (2, 1, .5))
        self.assertEqual((parts['999']['games'], parts['999']['win_rate']), (1, 1))
        self.assertEqual((parts['666']['games'], parts['666']['win_rate']), (0, None))
        self.assertEqual([part['name'] for part in rules['holdem']['subrules']],
                         ['Flush', 'Straight', 'Full house', 'Four of a kind'])
        self.assertEqual(rules['v10']['subrules'], [])

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
        self.assertIsNone(build_stats([], 'player:cleared', BOT_ID)['player'])
        data = build_stats(self.matches, 'player:Rival', BOT_ID)
        self.assertEqual(data['player']['head_to_head']['rounds'], 0)
        self.assertIsNone(data['player']['head_to_head']['round_win_rate'])
        self.assertIsNone(data['player']['head_to_head']['average_points'])
        for player, opponent in [('player:missing', None), ('player:tester', 'player:missing'), ('player:tester', 'player:tester')]:
            with self.assertRaises(ValueError):
                build_stats(self.matches, player, opponent)


class SeededProfileStatsTests(unittest.TestCase):
    def test_new_account_and_bot_have_zero_stats_on_current_patch(self):
        from patches import PATCH_VERSION
        profiles = [{'id': 'account:new', 'unique_name': 'new_user', 'display_name': 'New User', 'kind': 'account'},
                    {'id': BOT_ID, 'kind': 'bot', 'display_name': 'Golfbot'}]
        data = build_stats([], 'account:new', BOT_ID, patch=PATCH_VERSION, profiles=profiles)
        self.assertEqual(data['player']['profile'], {
            'id': 'account:new', 'username': 'new_user', 'unique_name': 'new_user',
            'is_bot': False, 'display_names': ['New User'], 'is_guest': False, 'label': '@new_user'})
        self.assertEqual(data['comparison']['profile']['label'], 'Golfbot (solo CPU)')
        for entry in (data['player'], data['comparison']):
            for scope in ('overall', 'head_to_head'):
                self.assertEqual(entry[scope]['rounds'], 0)
                self.assertEqual(entry[scope]['total_points'], 0)
                self.assertIsNone(entry[scope]['round_win_rate'])
        self.assertEqual(data['filters']['patch'], PATCH_VERSION)

    def test_seeded_guest_is_distinct_from_account_with_same_display_name(self):
        profiles = [{'id': 'player:Same', 'display_name': 'Same', 'kind': 'guest'},
                    {'id': BOT_ID, 'display_name': 'Golfbot', 'kind': 'bot'}]
        saved = {**match(['Same', 'Rival'], [result([1, 5])], 0),
                 'participants': [{'id': 'account:same', 'unique_name': 'registered'}, None]}
        data = build_stats([saved], 'player:Same', BOT_ID, profiles=profiles)
        self.assertEqual(data['player']['profile']['label'], 'Same (guest)')
        self.assertTrue(data['player']['profile']['is_guest'])
        self.assertEqual(data['player']['overall']['rounds'], 0)
        self.assertIn('account:same', [p['id'] for p in data['players']])

    def test_seed_refreshes_public_name_and_merges_historical_aliases(self):
        saved = {**match(['Old display', 'Golfbot'], [result([1, 5])], 0, solo=True),
                 'participants': [{'id': 'account:viewer', 'unique_name': 'old_name'}, None]}
        seed = {'id': 'account:viewer', 'unique_name': 'current_name', 'display_name': 'Current display', 'kind': 'account'}
        original = dict(seed)
        data = build_stats([saved], 'account:viewer', BOT_ID, profiles=[seed, {'id': BOT_ID, 'display_name': 'Golfbot'}])
        profile = data['player']['profile']
        self.assertEqual(profile['username'], 'current_name')
        self.assertEqual(profile['display_names'], ['Current display', 'Old display'])
        self.assertEqual(data['player']['overall']['rounds'], 1)
        self.assertEqual(len(data['players']), 2)
        self.assertEqual(seed, original)

    def test_seeded_default_uses_viewer_and_explicit_selections_still_validate(self):
        saved = [match(['Aaron', 'Rival'], [result([1, 5])], 0)]
        profiles = [{'id': 'player:Zoe', 'display_name': 'Zoe', 'kind': 'guest'},
                    {'id': BOT_ID, 'display_name': 'Golfbot', 'kind': 'bot'}]
        self.assertEqual(build_stats(saved, profiles=profiles)['player']['profile']['id'], 'player:Zoe')
        self.assertEqual(build_stats(saved, 'player:Aaron', profiles=profiles)['player']['overall']['rounds'], 1)
        self.assertEqual(build_stats(saved)['player']['profile']['id'], 'player:Aaron')
        for selected, opponent in [('player:missing', None), ('player:Zoe', 'player:missing'), ('player:Zoe', 'player:Zoe')]:
            with self.assertRaises(ValueError):
                build_stats(saved, selected, opponent, profiles=profiles)


class ModifierStatsTests(unittest.TestCase):
    def test_average_uses_source_owned_instances_and_excludes_legacy_rounds(self):
        rounds = [
            {**result([1, 5], rules={"king_queen": True}, activations=[["king_queen"], []]), "modifier_counts": [{"king_queen": 3}, {}]},
            {**result([6, 2], rules={"v10": True}), "modifier_counts": [{}, {"v10": 1}]},
            result([0, 8], rules={"king_queen": True}, activations=[["king_queen"], []]),
        ]
        games = [match(["tester", "Rival"], rounds, 0)]
        own = build_stats(games, "player:tester")["player"]["overall"]
        other = build_stats(games, "player:Rival")["player"]["overall"]
        self.assertEqual(own["average_rules_in_play"], 1.5)
        self.assertEqual(other["average_rules_in_play"], .5)
        self.assertEqual((own["known_modifier_games"], own["unknown_modifier_games"]), (2, 1))
        self.assertEqual(next(row for row in own["rule_activations"] if row["key"] == "king_queen")["games"], 2)

    def test_older_enabled_rules_and_activation_sets_cannot_prove_instance_counts(self):
        games = [match(["tester", "Rival"], [result([1, 5], {"king_queen": True}, activations=[["king_queen"], []])], 0)]
        stats = build_stats(games, "player:tester")["player"]["overall"]
        self.assertIsNone(stats["average_rules_in_play"])
        self.assertEqual((stats["known_modifier_games"], stats["unknown_modifier_games"]), (0, 1))

    def test_malformed_counts_remain_unknown_but_empty_counts_are_known(self):
        bad = [None, [], [{"king_queen": True}, {}], [{"king_queen": -1}, {}],
               [{"king_queen": 1.5}, {}], [{"unrecognized": 1}, {}], [None, {}]]
        rounds = [{**result([1, 5]), "modifier_counts": value} for value in bad]
        rounds.append({**result([1, 5]), "modifier_counts": [{}, {}]})
        stats = build_stats([match(["tester", "Rival"], rounds, 0)], "player:tester")["player"]["overall"]
        self.assertEqual(stats["average_rules_in_play"], 0)
        self.assertEqual((stats["known_modifier_games"], stats["unknown_modifier_games"]), (1, len(bad)))

    def test_final_counts_do_not_claim_to_recover_cumulative_action_activations(self):
        game = match(["tester", "Rival"], [{**result([1, 5]), "modifier_counts": [{"v10": 1}, {}]}], 0)
        stats = build_stats([game], "player:tester")["player"]["overall"]
        self.assertEqual(stats["average_rules_in_play"], 1)
        self.assertEqual(stats["known_activation_games"], 0)
        self.assertEqual(stats["unknown_activation_games"], 1)

    def test_counts_follow_patch_rule_and_head_to_head_filters(self):
        rounds = [
            {**result([1, 5], {"king_queen": True}), "patch": "1.2.0", "modifier_counts": [{"king_queen": 2}, {}]},
            {**result([1, 5], {"king_queen": True}), "patch": "1.1.1", "modifier_counts": [{"king_queen": 3}, {}]},
        ]
        stats = build_stats([match(["tester", "Rival"], rounds, 0)], "player:tester", "player:Rival",
                            enabled=["king_queen"], patch="1.2.0")["player"]["head_to_head"]
        self.assertEqual(stats["average_rules_in_play"], 2)
        self.assertEqual(stats["known_modifier_games"], 1)


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
                        (str(index), browser_key('private-host-token'), 'private-guest-key', index, json.dumps(payload)))
            response = client.get('/Golfgame/api/stats', params={'player': guest_id('private-host-token'), 'opponent': BOT_ID, 'house_rules': 'false'})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['player']['overall']['rounds'], 65)
            self.assertEqual(response.headers['cache-control'], 'no-store')
            for secret in (browser_key('private-host-token'), 'private-host-token', 'private-guest-key', 'golf_session', 'TunnelSecret'):
                self.assertNotIn(secret, response.text)
            for params in ({'enabled': 'fake_rule'}, {'enabled': 'v10', 'disabled': 'v10'}, {'player': 'account:missing'}):
                self.assertEqual(client.get('/Golfgame/api/stats', params=params).status_code, 422)
            for path in ('/stats', '/Golfgame/stats'):
                self.assertEqual(client.get(path).status_code, 200)

    def test_round_rules_and_actual_divisors_are_saved_without_cards_and_survive_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            database = Path(directory) / 'history.sqlite3'
            history = MatchHistory(database)
            room = Room('room', 'Table', Rules(v10=True, roman_fives=True, angel_numbers=True), 3, 'host', True,
                        ['secret-token', None], ['tester', 'GolfBot'], history_store=history)
            room.start_round()
            # Top V is three ten-valued ranks; bottom V has 5+4+1=10.
            room.game.players[0] = [Slot(Card(rank, suit), True) for rank, suit in zip([10, 4, 11, 5, 12, 1], 'SHDCSH')]
            room.game.angels_earned[0] = {7}
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
                self.assertEqual(rounds[0]['divisors'][0], 70)
                self.assertEqual(rounds[1]['divisors'][0], 1)
                self.assertTrue(rounds[0]['rules']['v10'])
                self.assertFalse(rounds[1]['rules']['v10'])
                self.assertNotIn('secret-token', json.dumps(records))
                self.assertNotIn('players', json.dumps(records))
                stats = build_stats(records, guest_id('secret-token'), enabled=['v10'])['player']['overall']
                self.assertEqual(stats['rounds'], 1)
                self.assertIn('v10', rounds[0]['activations'][0])
                self.assertEqual(next(row for row in stats['rule_activations'] if row['key'] == 'v10')['win_rate'], 1)
            finally:
                restored.close()
