"""Turn notifications: pushed once per turn, only while no page of yours is in front."""
import base64
import threading
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from fastapi.testclient import TestClient

try:
    from py_vapid import Vapid
    from cryptography.hazmat.primitives import serialization
except ImportError:  # pragma: no cover - the push extra is not installed
    Vapid = None

from server import Store, create_app

SUBSCRIPTION = {'endpoint': 'https://push.example/abc', 'keys': {'p256dh': 'x', 'auth': 'y'}}


@unittest.skipIf(Vapid is None, 'pywebpush is not installed')
class TurnNotificationTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        vapid = Vapid()
        vapid.generate_keys()
        public = vapid.public_key.public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
        # keys made here, so the test never writes data/push-keys.json
        self.store.push_keys = {'private': vapid.private_pem().decode(),
                                'public': base64.urlsafe_b64encode(public).decode().rstrip('=')}
        app = create_app(self.store, google_client_id='')
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        self.host = self.context.enter_context(TestClient(app))
        self.guest = TestClient(app)
        self.addCleanup(self.guest.close)
        for client in (self.host, self.guest):
            client.get('/api/session').raise_for_status()
        self.pushed = []
        self.sent = threading.Event()

        def fake_webpush(subscription_info, data, **kwargs):
            self.pushed.append((subscription_info['endpoint'], data))
            self.sent.set()
        patcher = patch('pywebpush.webpush', side_effect=fake_webpush)
        patcher.start()
        self.addCleanup(patcher.stop)

    def move(self, client, room, action, **extra):
        response = client.post(f'/api/lobbies/{room.id}/action', json={'action': action, 'version': room.version, **extra})
        self.assertEqual(response.status_code, 200, response.text)

    def test_key_subscribe_and_one_push_per_turn_while_away(self):
        self.assertTrue(self.host.get('/api/push/key').json()['key'])
        self.assertEqual(self.host.post('/api/push/subscribe', json={'subscription': {'endpoint': 'http://x'}}).status_code, 422)
        for client in (self.host, self.guest):
            client.post('/api/push/subscribe', json={'subscription': SUBSCRIPTION}).raise_for_status()
        room_id = self.host.post('/api/lobbies', json={'username': 'A'}).json()['id']
        self.guest.post(f'/api/lobbies/{room_id}/join', json={'username': 'B'}).raise_for_status()
        room = self.store.rooms[room_id]
        for client in (self.host, self.guest):
            for index in (0, 1):
                self.move(client, room, 'flip', index=index)
        # the opening flips are done: whoever goes first is told, once
        self.assertTrue(self.sent.wait(5))
        self.assertEqual(len(self.pushed), 1)
        self.assertIn('Your turn', self.pushed[0][1])
        # the same turn redrawn does not tell them again
        self.host.get(f'/api/lobbies/{room_id}/state')
        self.assertEqual(len(self.pushed), 1)

    def test_no_push_while_the_table_is_open_in_front(self):
        self.host.post('/api/push/subscribe', json={'subscription': SUBSCRIPTION}).raise_for_status()
        state = self.host.post('/api/solo', json={'username': 'A'}).json()
        room = self.store.rooms[state['id']]
        with self.host.websocket_connect(f"/ws/{room.id}") as ws:
            ws.receive_json()
            ws.send_text('visible')
            ws.receive_json()
            for index in (0, 1):
                self.move(self.host, room, 'flip', index=index)
            self.assertFalse(self.sent.wait(0.5))
        self.assertEqual(self.pushed, [])


if __name__ == '__main__':
    unittest.main()
