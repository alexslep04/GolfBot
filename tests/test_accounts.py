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
        session = client.get('/golf/api/session').json()
        with patch('server.verify_google_token', return_value=subject) as verify:
            response = client.post('/golf/api/auth/google', json={'credential': 'test-token', 'csrf_token': session['csrf_token']})
            self.assertEqual(response.status_code, 200, response.text)
            verify.assert_called_once_with('test-token', 'test.apps.googleusercontent.com', session['google_nonce'])
        return response

    def name(self, client, name):
        session = client.get('/golf/api/session').json()
        return client.post('/golf/api/account/name', json={'unique_name': name, 'csrf_token': session['csrf_token']})

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
                for flag in ('HttpOnly', 'Secure', 'SameSite=lax', 'Path=/golf/'):
                    self.assertIn(flag, cookie)
                self.assertEqual(self.name(client, 'My_Name').json()['account']['unique_name'], 'my_name')
                account_id = response.json()['account']['id']
                login_cookie = client.cookies.get(ACCOUNT_COOKIE)
                session_cookie = dict(client.cookies)
            restored = Store(path)
            with TestClient(create_app(restored, 'test.apps.googleusercontent.com'), base_url='https://sleptsov.dev') as client:
                client.cookies.update(session_cookie)
                session = client.get('/golf/api/session').json()
                self.assertEqual(session['account'], {'id': account_id, 'unique_name': 'my_name', 'display_name': 'Player'})
                row = restored.history.connection.execute('SELECT token_hash FROM account_sessions').fetchone()
                self.assertNotEqual(row[0], login_cookie)
                self.assertNotIn('google-private-sub', json.dumps(session))
                self.assertEqual(client.post('/golf/api/auth/logout', json={'csrf_token': 'wrong'}).status_code, 403)
                client.post('/golf/api/auth/logout', json={'csrf_token': session['csrf_token']}).raise_for_status()
                self.assertIsNone(restored.accounts.from_token(login_cookie))

    def test_unique_names_reserve_separate_accounts_and_require_signin(self):
        store = Store()
        with TestClient(create_app(store, 'test.apps.googleusercontent.com'), base_url='https://sleptsov.dev') as first:
            second = TestClient(first.app, base_url='https://sleptsov.dev')
            try:
                self.assertEqual(self.name(second, 'guest').status_code, 401)
                self.login(first, 'one')
                self.assertEqual(first.post('/golf/api/solo', json={'username': 'Alias'}).status_code, 409)
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

    def test_boards_show_a_signed_in_player_as_they_are_now(self):
        import datetime
        store = Store()
        app = create_app(store, 'test.apps.googleusercontent.com')
        with TestClient(app, base_url='https://sleptsov.dev') as phone:
            phone.get('/golf/api/session').raise_for_status()
            self.login(phone)
            self.name(phone, 'spence').raise_for_status()
            phone.post('/golf/api/name', json={'username': 'Spenis'}).raise_for_status()
            me = 'account:' + phone.get('/golf/api/session').json()['account']['id']
            # a puzzle finished under the old name and look
            today = datetime.date.today()
            store.puzzles.finish(today, me, 'Spenis', 'golfer', 21)
            # then a new name and avatar, picked away from any table
            phone.post('/golf/api/name', json={'username': 'speeeeeeenis'}).raise_for_status()
            phone.post('/golf/api/presence', json={'username': 'speeeeeeenis', 'avatar': 'cup'}).raise_for_status()
            row = next(row for row in phone.get('/golf/api/puzzle').json()['board'] if row.get('id') == me)
            self.assertEqual((row['name'], row['avatar']), ('speeeeeeenis', 'cup'))

    def test_display_name_follows_the_account_to_every_device(self):
        store = Store()
        app = create_app(store, 'test.apps.googleusercontent.com')
        with TestClient(app, base_url='https://sleptsov.dev') as phone, TestClient(app, base_url='https://sleptsov.dev') as laptop:
            for client in (phone, laptop):
                client.get('/golf/api/session').raise_for_status()
            phone.post('/golf/api/presence', json={'username': 'Pocket'}).raise_for_status()
            self.login(phone)  # the guest name becomes the account's first saved name
            self.name(phone, 'pocket_golf').raise_for_status()
            self.login(laptop)
            self.assertEqual(laptop.get('/golf/api/session').json()['username'], 'Pocket')
            phone.post('/golf/api/name', json={'username': 'Spence'}).raise_for_status()
            # a device still sending the old name does not win it back
            presence = laptop.post('/golf/api/presence', json={'username': 'Pocket'}).json()
            self.assertEqual(presence['username'], 'Spence')
            self.assertEqual(laptop.get('/golf/api/session').json()['username'], 'Spence')
            # choosing a name to play under saves it too
            state = laptop.post('/golf/api/solo', json={'username': 'Laptop'}).json()
            self.assertEqual(state['names'][0], 'Laptop')
            self.assertEqual(phone.get('/golf/api/session').json()['username'], 'Laptop')

    def test_account_page_lists_previously_used_display_names_newest_first(self):
        store = Store()
        with TestClient(create_app(store, 'test.apps.googleusercontent.com'), base_url='https://sleptsov.dev') as client:
            client.get('/golf/api/session')
            self.assertEqual(client.get('/golf/api/account/display-names').status_code, 401)  # guests have no list
            self.login(client)
            self.name(client, 'namer')
            # a clock that ticks on every call, so each save has its own moment
            import itertools, time as clock
            start = clock.time()
            times = (start + tick for tick in itertools.count(1))
            with patch('accounts.time.time', side_effect=lambda: next(times)):
                for display in ('First', 'Second', 'Third', 'First'):
                    client.post('/golf/api/name', json={'username': display}).raise_for_status()
            names = client.get('/golf/api/account/display-names').json()['names']
            # the current name (First) is left out; the rest run from most to least recently chosen
            self.assertEqual(names[:2], ['Third', 'Second'])
            self.assertNotIn('First', names)
            # a name only ever played under, before names were recorded, is found in the saved games
            store.history.connection.execute('DELETE FROM account_display_names')
            state = client.post('/golf/api/solo', json={'username': 'Played As'}).json()
            room = store.rooms[state['id']]
            room.game.phase = 'over'
            room.record_result()
            client.post(f"/golf/api/lobbies/{room.id}/leave").raise_for_status()
            client.post('/golf/api/name', json={'username': 'Now'}).raise_for_status()
            # First was the name in use when Played As replaced it, so it was kept as well
            self.assertEqual(client.get('/golf/api/account/display-names').json()['names'], ['Played As', 'First'])

    def test_two_display_names_share_account_stats_but_matching_guest_name_does_not(self):
        store = Store()
        with TestClient(create_app(store, 'test.apps.googleusercontent.com'), base_url='https://sleptsov.dev') as client:
            self.login(client)
            account = self.name(client, 'uniq_player').json()['account']
            for display, score in (('Alias One', 2), ('Alias Two', 8)):
                state = client.post('/golf/api/solo', json={'username': display}).json()
                room = store.rooms[state['id']]
                room.game.phase = 'over'
                with patch.object(room.game, 'score', side_effect=lambda seat: score if seat == 0 else 5):
                    room.record_result()
                client.post(f'/golf/api/lobbies/{room.id}/leave').raise_for_status()
            session = client.get('/golf/api/session').json()
            client.post('/golf/api/auth/logout', json={'csrf_token': session['csrf_token']}).raise_for_status()
            state = client.post('/golf/api/solo', json={'username': 'uniq_player'}).json()
            room = store.rooms[state['id']]
            room.game.phase = 'over'
            room.record_result()
            result = build_stats(store.history.results(), 'account:' + account['id'])
            self.assertEqual(result['player']['profile']['label'], '@uniq_player')
            self.assertEqual(result['player']['profile']['display_names'], ['Alias One', 'Alias Two'])
            self.assertEqual(result['player']['overall']['rounds'], 2)
            # signed out, the same person is a guest again: their own profile, apart from the account
            guests = [p for p in result['players'] if p['is_guest']]
            self.assertEqual([(p['username'], p['id'].split(':')[0]) for p in guests], [('uniq_player', 'browser')])
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
            for path in ('/account', '/golf/account', '/privacy', '/golf/privacy'):
                self.assertEqual(client.get(path).status_code, 200)

    def test_google_popup_and_local_referrer_headers(self):
        for origin, policy in [('http://localhost', 'no-referrer-when-downgrade'),
                               ('http://127.0.0.1', 'no-referrer-when-downgrade'),
                               ('https://sleptsov.dev', 'strict-origin-when-cross-origin')]:
            with TestClient(create_app(Store(), ''), base_url=origin) as client:
                response = client.get('/golf/')
                self.assertEqual(response.headers['referrer-policy'], policy)
                self.assertEqual(response.headers['cross-origin-opener-policy'], 'same-origin-allow-popups')
