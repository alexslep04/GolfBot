import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from accounts import Accounts, ACCOUNT_COOKIE, verify_google_token
from game import Rules
from match_history import MatchHistory
from player_stats import build_stats
from server import Store, create_app


class AccountTests(unittest.TestCase):
    def login(self, client, subject='google-private-sub'):
        session = client.get('/Golfgame/api/session').json()
        with patch('server.verify_google_token', return_value=subject) as verify:
            response = client.post('/Golfgame/api/auth/google', json={'credential': 'test-token', 'csrf_token': session['csrf_token']})
            self.assertEqual(response.status_code, 200, response.text)
            verify.assert_called_once_with('test-token', 'test.apps.googleusercontent.com', session['google_nonce'])
        return response

    def name(self, client, name):
        session = client.get('/Golfgame/api/session').json()
        return client.post('/Golfgame/api/account/name', json={'unique_name': name, 'csrf_token': session['csrf_token']})

    def test_google_token_checks_expected_audience_nonce_subject_and_issuer(self):
        claims = {'sub': 'private-subject', 'iss': 'https://accounts.google.com', 'nonce': 'expected'}
        with patch('google.oauth2.id_token.verify_oauth2_token', return_value=claims) as verify:
            self.assertEqual(verify_google_token('credential', 'client', 'expected'), 'private-subject')
            self.assertEqual(verify.call_args.kwargs['audience'], 'client')
            for invalid in ({**claims, 'nonce': 'wrong'}, {**claims, 'iss': 'attacker'}, {**claims, 'sub': ''}):
                verify.return_value = invalid
                with self.assertRaises(ValueError):
                    verify_google_token('credential', 'client', 'expected')
            verify.side_effect = ValueError('expired or invalid signature')
            with self.assertRaises(ValueError):
                verify_google_token('credential', 'client', 'expected')

    def test_accounts_survive_restart_and_only_hash_login_cookies(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'history.sqlite3'
            with TestClient(create_app(Store(path), 'test.apps.googleusercontent.com'), base_url='https://sleptsov.dev') as client:
                response = self.login(client)
                cookie = response.headers['set-cookie']
                for flag in ('HttpOnly', 'Secure', 'SameSite=lax', 'Path=/Golfgame/'):
                    self.assertIn(flag, cookie)
                self.assertEqual(self.name(client, 'My_Name').json()['account']['unique_name'], 'my_name')
                account_id = response.json()['account']['id']
                login_cookie = client.cookies.get(ACCOUNT_COOKIE)
                session_cookie = dict(client.cookies)
            restored = Store(path)
            with TestClient(create_app(restored, 'test.apps.googleusercontent.com'), base_url='https://sleptsov.dev') as client:
                client.cookies.update(session_cookie)
                session = client.get('/Golfgame/api/session').json()
                self.assertEqual(session['account'], {'id': account_id, 'unique_name': 'my_name'})
                row = restored.history.connection.execute('SELECT token_hash FROM account_sessions').fetchone()
                self.assertNotEqual(row[0], login_cookie)
                self.assertNotIn('google-private-sub', json.dumps(session))
                self.assertEqual(client.post('/Golfgame/api/auth/logout', json={'csrf_token': 'wrong'}).status_code, 403)
                client.post('/Golfgame/api/auth/logout', json={'csrf_token': session['csrf_token']}).raise_for_status()
                self.assertIsNone(restored.accounts.from_token(login_cookie))

    def test_unique_names_reserve_separate_accounts_and_require_signin(self):
        store = Store()
        with TestClient(create_app(store, 'test.apps.googleusercontent.com'), base_url='https://sleptsov.dev') as first:
            second = TestClient(first.app, base_url='https://sleptsov.dev')
            try:
                self.assertEqual(self.name(second, 'guest').status_code, 401)
                self.login(first, 'one')
                self.assertEqual(first.post('/Golfgame/api/solo', json={'username': 'Alias'}).status_code, 409)
                self.assertEqual(self.name(first, 'tester').status_code, 200)
                self.login(second, 'two')
                self.assertEqual(self.name(second, 'TESTER').status_code, 422)
                self.assertEqual(self.name(second, 'invalid name').status_code, 422)
                self.assertEqual(self.name(second, 'second').status_code, 200)
                self.assertEqual(self.name(first, 'renamed').status_code, 422)
            finally:
                second.close()

    def test_login_requires_csrf_valid_google_proof_and_fresh_nonce(self):
        store = Store()
        with TestClient(create_app(store, 'test.apps.googleusercontent.com')) as client:
            session = client.get('/api/session').json()
            body = {'credential': 'fake', 'csrf_token': session['csrf_token']}
            with patch('server.verify_google_token') as verify:
                self.assertEqual(client.post('/api/auth/google', json={**body, 'csrf_token': 'bad'}).status_code, 403)
                verify.assert_not_called()
                verify.side_effect = ValueError('forged')
                self.assertEqual(client.post('/api/auth/google', json=body).status_code, 401)
                verify.side_effect, verify.return_value = None, 'valid-sub'
                self.assertEqual(client.post('/api/auth/google', json=body).status_code, 200)
                self.assertEqual(client.post('/api/auth/google', json=body).status_code, 401)
            self.assertEqual(client.post('/api/auth/logout', json={'csrf_token': session['csrf_token']}, headers={'Origin': 'https://evil.test'}).status_code, 403)

    def test_two_display_names_share_account_stats_but_matching_guest_name_does_not(self):
        store = Store()
        with TestClient(create_app(store, 'test.apps.googleusercontent.com'), base_url='https://sleptsov.dev') as client:
            self.login(client)
            account = self.name(client, 'unique_player').json()['account']
            for display, score in (('Alias One', 2), ('Alias Two', 8)):
                state = client.post('/Golfgame/api/solo', json={'username': display}).json()
                room = store.rooms[state['id']]
                room.game.phase = 'over'
                with patch.object(room.game, 'score', side_effect=lambda seat: score if seat == 0 else 5):
                    room.record_result()
                client.post(f'/Golfgame/api/lobbies/{room.id}/leave').raise_for_status()
            session = client.get('/Golfgame/api/session').json()
            client.post('/Golfgame/api/auth/logout', json={'csrf_token': session['csrf_token']}).raise_for_status()
            state = client.post('/Golfgame/api/solo', json={'username': 'unique_player'}).json()
            room = store.rooms[state['id']]
            room.game.phase = 'over'
            room.record_result()
            result = build_stats(store.history.results(), 'account:' + account['id'])
            self.assertEqual(result['player']['profile']['label'], '@unique_player')
            self.assertEqual(result['player']['profile']['display_names'], ['Alias One', 'Alias Two'])
            self.assertEqual(result['player']['overall']['rounds'], 2)
            self.assertIn('player:unique_player', [p['id'] for p in result['players']])
            self.assertNotIn('google-private-sub', json.dumps(result))

    def test_history_reset_prevents_an_old_host_reinserting_a_cached_series(self):
        history = MatchHistory()
        try:
            payload = {'started_at': 1, 'rounds': []}
            history.connection.execute('INSERT INTO matches VALUES (?, ?, ?, ?, ?)', ('old', 'host', None, 1, json.dumps(payload)))
            history.connection.commit()
            self.assertEqual(history.clear_history(), 1)
            history.connection.execute('INSERT INTO matches VALUES (?, ?, ?, ?, ?)', ('old', 'host', None, 2, json.dumps(payload)))
            self.assertEqual(history.results(), [])
        finally:
            history.close()

    def test_signin_is_optional_and_unconfigured_hosts_do_not_accept_credentials(self):
        with TestClient(create_app(Store(), '')) as client:
            session = client.get('/api/session').json()
            self.assertEqual(session['google_client_id'], '')
            self.assertEqual(client.post('/api/auth/google', json={'credential': 'fake', 'csrf_token': session['csrf_token']}).status_code, 503)
            self.assertEqual(client.post('/api/solo', json={'username': 'Guest'}).status_code, 200)
            for path in ('/account', '/Golfgame/account', '/privacy', '/Golfgame/privacy'):
                self.assertEqual(client.get(path).status_code, 200)
