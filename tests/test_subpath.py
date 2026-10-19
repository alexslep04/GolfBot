"""The public subpath must work for invitations, cookies, HTTP and live games."""
from contextlib import ExitStack
from hashlib import sha256
from pathlib import Path
import re
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from server import Store, create_app


class SubpathTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        self.host = self.context.enter_context(TestClient(create_app(self.store), base_url='https://sleptsov.dev'))
        self.guest = TestClient(self.host.app, base_url='https://sleptsov.dev')
        self.addCleanup(self.guest.close)
        for client in (self.host, self.guest):
            client.get('/Golfgame/api/session').raise_for_status()

    def test_pages_assets_and_trailing_slash_stay_under_game_path(self):
        for path in ('/Golfgame/', '/Golfgame/history', '/Golfgame/lobby/invite'):
            response = self.host.get(path)
            self.assertEqual(response.status_code, 200)
            self.assertIn('<base href="/Golfgame/"', response.text)
            self.assertEqual(response.headers['cache-control'], 'no-store')
        redirect = self.host.get('/Golfgame', follow_redirects=False)
        self.assertEqual(redirect.headers['location'], 'https://sleptsov.dev/Golfgame/')
        for asset in ('app.js', 'style.css', 'emotes/laughing.png'):
            self.assertEqual(self.host.get('/Golfgame/static/' + asset).status_code, 200)
        self.assertIn('<base href="/"', self.host.get('/').text)
        self.assertEqual(self.host.get('/health').json(), {'status': 'ok'})

    def test_session_cookie_is_scoped_and_api_is_not_cached(self):
        response = self.host.get('/Golfgame/api/session')
        cookie = response.headers['set-cookie']
        for attribute in ('Path=/Golfgame/', 'Secure', 'HttpOnly', 'SameSite=lax'):
            self.assertIn(attribute, cookie)
        self.assertEqual(response.headers['cache-control'], 'no-store')
        # The subpath cookie is not sent to other applications at the domain root.
        self.assertEqual(self.host.get('/api/history').status_code, 401)
        self.assertEqual(self.host.get('/Golfgame/api/history').status_code, 200)

    def test_asset_versions_bypass_previous_release_cache_and_follow_content_changes(self):
        def assets(page):
            return dict(re.findall(r'"(static/(?:app.js|style.css))\?v=([a-f0-9]+)"', page))

        original = assets(self.host.get('/Golfgame/stats').text)
        self.assertEqual(set(original), {'static/app.js', 'static/style.css'})
        for asset, version in original.items():
            response = self.host.get(f'/Golfgame/{asset}?v={version}')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(version, sha256(response.content).hexdigest()[:16])
        self.assertEqual(original, assets(self.host.get('/stats').text))
        read_bytes = Path.read_bytes

        def updated_content(path):
            content = read_bytes(path)
            return content + b'\n// next release' if path.name == 'app.js' else content

        with patch.object(Path, 'read_bytes', updated_content):
            updated = assets(self.host.get('/Golfgame/stats').text)
        self.assertNotEqual(updated['static/app.js'], original['static/app.js'])
        self.assertEqual(updated['static/style.css'], original['static/style.css'])

    def test_multiplayer_and_emotes_work_through_prefixed_http_and_websocket(self):
        response = self.host.post('/Golfgame/api/lobbies', json={'username': 'Host'}, headers={'Origin': 'https://sleptsov.dev'})
        self.assertEqual(response.status_code, 200, response.text)
        lobby = response.json()['id']
        self.guest.post(f'/Golfgame/api/lobbies/{lobby}/join', json={'username': 'Guest'}).raise_for_status()
        with self.host.websocket_connect(f'wss://sleptsov.dev/Golfgame/ws/{lobby}', headers={'Origin': 'https://sleptsov.dev'}) as ws:
            state = ws.receive_json()
            self.assertEqual(state['viewer'], 0)
            self.assertEqual(state['names'], ['Host', 'Guest'])
            self.assertTrue(all(card['card'] is None for hand in state['game']['players'] for card in hand))
            self.guest.post(f'/Golfgame/api/lobbies/{lobby}/emote', json={'emote': 'laughing'}).raise_for_status()
            self.assertEqual(ws.receive_json()['emotes'][0]['id'], 'laughing')

    def test_subpath_does_not_bypass_origin_or_seat_checks(self):
        response = self.host.post('/Golfgame/api/lobbies', json={}, headers={'Origin': 'https://evil.invalid'})
        self.assertEqual(response.status_code, 403)
        lobby = self.host.post('/Golfgame/api/lobbies', json={}).json()['id']
        self.assertEqual(self.guest.get(f'/Golfgame/api/lobbies/{lobby}/state').status_code, 403)
        with self.assertRaises(WebSocketDisconnect):
            with self.host.websocket_connect(f'wss://sleptsov.dev/Golfgame/ws/{lobby}', headers={'Origin': 'https://evil.invalid'}):
                pass
