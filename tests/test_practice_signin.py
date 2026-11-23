import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from accounts import ACCOUNT_COOKIE
from server import Store, create_app


class PracticeSigninTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.client = TestClient(create_app(self.store, 'test-client'))
        self.addCleanup(self.client.close)
        self.session = self.client.get('/api/session').json()

    def practice(self):
        response = self.client.post('/api/solo', json={'username': 'Guest', 'practice': True})
        self.assertEqual(response.status_code, 200, response.text)
        return self.store.rooms[response.json()['id']]

    def login(self, subject='subject'):
        with patch('server.verify_google_token', return_value=subject):
            return self.client.post('/api/auth/google', json={
                'credential': 'proof', 'csrf_token': self.session['csrf_token']})

    def test_adopts_unnamed_account_then_names_and_resumes(self):
        room = self.practice()
        guest = room.progression_players[0].copy()
        self.store.progression.practice_result('guest-win', guest, 0)
        self.store.progression.practice_result('guest-draw', guest, None)
        match_id = room.match_id
        game = room.game
        response = self.login()
        self.assertEqual(response.status_code, 200, response.text)
        account = response.json()['account']
        identity = 'account:' + account['id']
        self.assertIsNone(account['unique_name'])
        self.assertEqual(room.participants[0]['id'], identity)
        self.assertEqual(room.progression_players[0]['id'], identity)
        self.assertEqual(room.practice_account, account['id'])
        self.assertIs(room.game, game)
        self.assertEqual(room.match_id, match_id)
        profile = self.store.progression.profile(room.progression_players[0])
        self.assertEqual((profile['current_streak'], profile['best_streak'], profile['draws_in_row']), (1, 1, 1))
        reset = self.store.progression.profile(guest)
        self.assertEqual((reset['current_streak'], reset['best_streak'], reset['draws_in_row']), (0, 0, 0))
        # A completed guest event cannot become a second account result.
        self.store.progression.practice_result('guest-win', room.progression_players[0], 0)
        self.assertEqual(self.store.progression.profile(room.progression_players[0])['current_streak'], 1)
        named = self.client.post('/api/account/name', json={
            'unique_name': 'tester', 'csrf_token': self.session['csrf_token']})
        self.assertEqual(named.status_code, 200, named.text)
        self.assertEqual(room.participants[0]['unique_name'], 'tester')
        self.client.post(f'/api/lobbies/{room.id}/leave').raise_for_status()
        saved = self.store.progression.load_practice(account['id'])
        self.assertEqual(saved['room']['participants'][0]['id'], identity)
        resumed = self.client.post('/api/solo', json={'practice': True})
        self.assertEqual(resumed.status_code, 200, resumed.text)
        self.assertEqual(resumed.json()['id'], room.id)
        self.assertEqual(resumed.json()['streak']['current'], 1)
        self.store.progression.practice_result('second-draw', room.progression_players[0], None)
        self.assertEqual(self.store.progression.profile(room.progression_players[0])['current_streak'], 0)

    def test_existing_account_keeps_stronger_current_best_and_ranked_data(self):
        account, _ = self.store.accounts.login('subject')
        self.store.accounts.choose_name(account['id'], 'existing')
        target = {'id': 'account:' + account['id'], 'unique_name': 'existing'}
        for index in range(4):
            self.store.progression.practice_result(f'account-{index}', target, 0)
        self.store.progression.rate_game('ranked', [target, {'id': 'browser:other'}], 0)
        before = self.store.progression.profile(target)
        room = self.practice()
        self.store.progression.practice_result('guest', room.progression_players[0], 0)
        self.store.progression.practice_result('draw', room.progression_players[0], None)
        self.assertEqual(self.login().status_code, 200)
        after = self.store.progression.profile(target)
        self.assertEqual(after, before)

    def test_guest_longer_streak_transfers_without_ranked_history(self):
        room = self.practice()
        guest = room.progression_players[0].copy()
        self.store.progression.rate_game('guest-rated', [guest, {'id': 'browser:other'}], 0)
        for index in range(3):
            self.store.progression.practice_result(f'guest-{index}', guest, 0)
        self.assertEqual(self.login().status_code, 200)
        profile = self.store.progression.profile(room.progression_players[0])
        self.assertEqual((profile['current_streak'], profile['best_streak']), (3, 3))
        # the guest's Ranked record stays with the guest: only the solo streak moves
        self.assertEqual(self.store.progression.ratings(room.progression_players[0]['id'])['game']['wins'], 0)
        self.assertEqual(self.store.progression.ratings(guest['id'])['game']['wins'], 1)

    def test_csrf_and_invalid_proof_do_not_adopt(self):
        room = self.practice()
        original = room.participants[0].copy()
        with patch('server.verify_google_token', side_effect=ValueError('bad')) as verify:
            bad = self.client.post('/api/auth/google', json={'credential': 'proof', 'csrf_token': 'bad'})
            self.assertEqual(bad.status_code, 403)
            verify.assert_not_called()
            bad = self.client.post('/api/auth/google', json={'credential': 'proof', 'csrf_token': self.session['csrf_token']})
            self.assertEqual(bad.status_code, 401)
        self.assertEqual(room.participants[0], original)
        self.assertIsNone(room.practice_account)

    def test_private_and_nonpractice_seats_still_block_auth(self):
        for endpoint, settings in [('/api/lobbies', {}), ('/api/solo', {})]:
            with self.subTest(endpoint=endpoint):
                state = self.client.post(endpoint, json=settings).json()
                with patch('server.verify_google_token') as verify:
                    self.assertEqual(self.login().status_code, 409)
                    verify.assert_not_called()
                self.client.post(f"/api/lobbies/{state['id']}/leave").raise_for_status()

    def test_account_switch_and_logout_remain_blocked_after_adoption(self):
        self.practice()
        self.assertEqual(self.login().status_code, 200)
        self.session = self.client.get('/api/session').json()
        self.assertEqual(self.login('another').status_code, 409)
        self.assertEqual(self.client.post('/api/auth/logout', json={'csrf_token': self.session['csrf_token']}).status_code, 409)

    def test_verification_race_cannot_adopt_a_different_table(self):
        room = self.practice()
        def verify(*args):
            room.rated = True
            return 'subject'
        with patch('server.verify_google_token', side_effect=verify):
            result = self.client.post('/api/auth/google', json={'credential': 'proof', 'csrf_token': self.session['csrf_token']})
        self.assertEqual(result.status_code, 409)
        self.assertIsNone(room.practice_account)
        self.assertIsNone(self.store.sessions[room.seats[0]].account)

    def test_guest_decline_path_still_resets_without_account_save(self):
        room = self.practice()
        guest = room.progression_players[0]
        self.store.progression.practice_result('guest-win', guest, 0)
        self.client.post(f'/api/lobbies/{room.id}/leave').raise_for_status()
        self.assertEqual(self.store.progression.profile(guest)['current_streak'], 0)
        self.assertIsNone(room.practice_account)


    def test_equal_best_retains_first_achievement_for_leaderboard_order(self):
        room = self.practice()
        guest = room.progression_players[0].copy()
        account, _ = self.store.accounts.login('subject')
        self.store.accounts.choose_name(account['id'], 'existing')
        target = {'id': 'account:' + account['id'], 'unique_name': 'existing'}
        rival = {'id': 'account:rival', 'unique_name': 'rival'}
        with patch('progression.time.time', return_value=100):
            self.store.progression.practice_result('guest-first', guest, 0)
        with patch('progression.time.time', return_value=150):
            self.store.progression.practice_result('rival-next', rival, 0)
        with patch('progression.time.time', return_value=200):
            self.store.progression.practice_result('account-later', target, 0)
        self.assertEqual(self.login().status_code, 200)
        profile = self.store.progression.profile(target)
        self.assertEqual(profile['best_at'], 100)
        self.assertEqual(self.store.progression.leaderboard()['solo'][0]['id'], target['id'])

if __name__ == '__main__':
    unittest.main()
