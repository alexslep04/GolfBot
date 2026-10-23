"""Locked presets, continuous results, presence, invitations and official stats."""
from contextlib import ExitStack
from dataclasses import asdict
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from game import Rules
from match_settings import HOUSE_VERSION, house_rules
from player_stats import build_stats
from server import COOKIE, Store, create_app


class LobbyFeatureTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        app = create_app(self.store, google_client_id='')
        self.host = self.context.enter_context(TestClient(app))
        self.guest, self.other = TestClient(app), TestClient(app)
        for client in (self.host, self.guest, self.other):
            self.addCleanup(client.close)
            client.get('/Golfgame/api/session').raise_for_status()

    def create(self, **values):
        response = self.host.post('/Golfgame/api/lobbies', json={'username': 'Host', **values})
        self.assertEqual(response.status_code, 200, response.text)
        self.id = response.json()['id']
        self.room = self.store.rooms[self.id]
        self.path = '/Golfgame/api/lobbies/' + self.id
        return response.json()

    def presence(self, client, username):
        response = client.post('/Golfgame/api/presence', json={'username': username})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def finish(self, scores):
        self.room.game.phase = 'over'
        with patch.object(self.room.game, 'score', side_effect=lambda player: scores[player]):
            self.room.record_result()

    def test_house_preset_overrides_tampered_settings_and_locks_solo_rules(self):
        with patch('server.secrets.randbelow', return_value=1):
            response = self.host.post('/Golfgame/api/solo', json={
                'house_rules': True, 'first': 'host', 'rules': {'beggars': True},
            })
        self.assertEqual(response.status_code, 200)
        state = response.json()
        self.assertEqual(state['first'], 'random')
        self.assertEqual(state['game']['first_player'], 1)
        self.assertEqual(state['rules'], house_rules())
        self.assertFalse(state['rules']['beggars'])
        self.assertFalse(state['game']['legal']['set_rules'])
        self.assertEqual(state['house_version'], HOUSE_VERSION)
        for action in ('set_rule', 'set_rules'):
            response = self.host.post(f"/Golfgame/api/lobbies/{state['id']}/action", json={
                'action': action, 'version': state['version'], 'rule': 'beggars',
                'enabled': True, 'rules': {'beggars': True},
            })
            self.assertEqual(response.status_code, 403)
        self.assertEqual(self.host.get('/Golfgame/api/match-options').json()['house_rules'], house_rules())

    def test_continuous_has_no_win_target_and_finishes_after_both_leave(self):
        state = self.create(best_of=None, house_rules=True)
        self.assertIsNone(state['target'])
        self.guest.post(self.path + '/join', json={'username': 'Guest'}).raise_for_status()
        for _ in range(12):
            self.finish([2, 8])
            self.assertEqual(self.room.status, 'round_over')
            self.room.start_round()
        self.assertEqual(self.room.wins, [12, 0])
        self.assertIsNone(self.room.champion)
        self.host.post(self.path + '/leave').raise_for_status()
        self.assertIsNone(self.store.history.results()[0]['winner'])
        self.guest.post(self.path + '/leave').raise_for_status()
        record = self.store.history.results()[0]
        self.assertEqual((record['status'], record['winner']), ('finished', 0))
        self.assertEqual(len(record['rounds']), 12)
        self.assertTrue(record['house_rules'])
        self.assertEqual(record['rounds'][0]['house_version'], HOUSE_VERSION)
        self.assertIn('turns', record['rounds'][0])

    def test_continuous_tiebreaks_use_total_points_then_no_winner(self):
        for results, winner in (([[0, 5], [8, 1]], 1), ([[0, 5], [5, 0]], None)):
            with self.subTest(results=results):
                self.create(best_of=None)
                self.guest.post(self.path + '/join', json={'username': 'Guest'}).raise_for_status()
                for scores in results:
                    self.finish(scores)
                    self.room.start_round()
                self.host.post(self.path + '/leave').raise_for_status()
                self.guest.post(self.path + '/leave').raise_for_status()
                self.assertEqual(self.room.champion, winner)
                record = next(record for record in self.store.history.results() if record['id'] == self.room.match_id)
                self.assertEqual(record['status'], 'finished')
                stats = build_stats([record], 'player:Host')['player']['overall']
                self.assertEqual(stats['rounds'], 2)
                self.assertEqual(stats['completed_matches'], 1)
                self.assertEqual(stats['match_draws'], int(winner is None))

    def test_solo_continuous_closes_both_seats_when_the_human_leaves(self):
        state = self.host.post('/Golfgame/api/solo', json={'best_of': None}).json()
        self.room = self.store.rooms[state['id']]
        self.finish([1, 5])
        self.host.post(f"/Golfgame/api/lobbies/{state['id']}/leave").raise_for_status()
        self.assertEqual(self.room.departed, [True, True])
        self.assertEqual(self.store.history.results()[0]['winner'], 0)

    def test_lobby_count_invites_accept_and_private_identity_boundaries(self):
        self.presence(self.guest, 'Guest')
        state = self.create(best_of=None, house_rules=True, name='House table')
        self.assertEqual(self.presence(self.guest, 'Guest')['available_lobbies'], 1)
        online = self.presence(self.host, 'Host')
        target = online['players'][0]['id']
        self.assertEqual(self.other.post(self.path + '/invite', json={'player_id': target}).status_code, 403)
        for _ in range(2):
            self.host.post(self.path + '/invite', json={'player_id': target}).raise_for_status()
        self.assertEqual(len(self.store.invitations), 1)
        received = self.presence(self.guest, 'Guest')
        invitation = received['invitations'][0]
        self.assertEqual(invitation['host'], 'Host')
        self.assertEqual(invitation['lobby']['name'], 'House table')
        self.assertTrue(invitation['lobby']['house_rules'])
        response_path = '/Golfgame/api/invitations/' + invitation['id'] + '/respond'
        self.assertEqual(self.other.post(response_path, json={'accept': True}).status_code, 404)
        accepted = self.guest.post(response_path, json={'accept': True, 'username': 'Guest'})
        self.assertEqual(accepted.status_code, 200, accepted.text)
        self.assertEqual(accepted.json()['game']['phase'], 'setup')
        self.assertEqual(self.presence(self.other, 'Other')['available_lobbies'], 0)
        self.assertEqual(self.store.invitations, {})
        self.assertFalse(self.presence(self.other, 'Other')['players'])
        for session in self.store.sessions.values():
            self.assertNotIn(session.token, str(received))
        self.assertNotIn('google_sub', str(received))

    def test_decline_expiry_offline_and_busy_players(self):
        self.create()
        self.presence(self.guest, 'Guest')
        target = self.presence(self.host, 'Host')['players'][0]['id']
        self.host.post(self.path + '/invite', json={'player_id': target}).raise_for_status()
        invitation_id = next(iter(self.store.invitations))
        self.guest.post(f'/Golfgame/api/invitations/{invitation_id}/respond', json={'accept': False}).raise_for_status()
        self.assertEqual(self.room.status, 'waiting')
        self.host.post(self.path + '/invite', json={'player_id': target}).raise_for_status()
        next(iter(self.store.invitations.values()))['expires'] = 0
        self.assertFalse(self.presence(self.guest, 'Guest')['invitations'])
        guest = self.store.sessions[self.guest.cookies.get(COOKIE)]
        guest.online_until = 0
        self.assertFalse(self.presence(self.host, 'Host')['players'])
        self.assertEqual(self.host.post(self.path + '/invite', json={'player_id': target}).status_code, 409)

    def test_official_filter_is_default_and_custom_filters_require_unlocking(self):
        self.create(house_rules=True)
        self.guest.post(self.path + '/join', json={'username': 'Guest'}).raise_for_status()
        self.room.game.turns = 18
        self.finish([1, 9])
        stats = self.host.get('/Golfgame/api/stats', params={'player': 'player:Host'}).json()
        self.assertTrue(stats['filters']['house_rules'])
        self.assertEqual(stats['player']['overall']['average_turns'], 18)
        self.assertEqual(stats['player']['overall']['average_rules_in_play'], 12)
        self.assertEqual(self.host.get('/Golfgame/api/stats?enabled=beggars').status_code, 422)
        custom = self.host.get('/Golfgame/api/stats?house_rules=false&disabled=beggars')
        self.assertEqual(custom.status_code, 200)
        self.assertEqual(custom.json()['player']['overall']['rounds'], 1)


class NewStatsTests(unittest.TestCase):
    def test_house_markers_old_turn_records_and_rule_counts_are_independent(self):
        record = {'names': ['A', 'B'], 'solo': False, 'rules': {}, 'status': 'finished', 'winner': 0,
                  'rounds': [{'scores': [1, 9], 'house_rules': True, 'house_version': 'old', 'turns': 10, 'rules': {'v10': True}},
                             {'scores': [8, 1], 'turns': 20, 'rules': {'v10': True, 'beggars': True}},
                             {'scores': [2, 9], 'rules': {'v10': True}}]}
        overall = build_stats([record], 'player:A')['player']['overall']
        self.assertEqual(overall['average_turns'], 15)
        self.assertEqual(overall['known_turn_games'], 2)
        self.assertAlmostEqual(overall['average_rules_in_play'], 4 / 3)
        official = build_stats([record], 'player:A', house_only=True)['player']['overall']
        self.assertEqual(official['rounds'], 1)
        self.assertEqual(official['average_turns'], 10)
        self.assertEqual(official['completed_matches'], 0)


if __name__ == '__main__':
    unittest.main()
