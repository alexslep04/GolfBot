"""Turn and Ranked queue notifications: pushed only while no page of yours is in front."""
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

def real_subscription():
    """A subscription a browser could have made: its own key pair and auth secret."""
    from cryptography.hazmat.primitives.asymmetric import ec
    key = ec.generate_private_key(ec.SECP256R1())
    public = key.public_key().public_bytes(serialization.Encoding.X962, serialization.PublicFormat.UncompressedPoint)
    b64 = lambda raw: base64.urlsafe_b64encode(raw).decode().rstrip('=')
    return {'endpoint': 'https://push.example/abc', 'keys': {'p256dh': b64(public), 'auth': b64(b'0123456789abcdef')}}


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

        # only the network is faked: the real signing and encryption run, so a
        # sender claim the push library refuses fails this test
        class Sent:
            status_code = 201
            text = ''

        def fake_post(endpoint, data=None, headers=None, **kwargs):
            self.pushed.append((endpoint, headers))
            self.sent.set()
            return Sent()
        patcher = patch('requests.post', side_effect=fake_post)
        patcher.start()
        self.addCleanup(patcher.stop)

    def move(self, client, room, action, **extra):
        response = client.post(f'/api/lobbies/{room.id}/action', json={'action': action, 'version': room.version, **extra})
        self.assertEqual(response.status_code, 200, response.text)

    def test_key_subscribe_and_one_push_per_turn_while_away(self):
        self.assertTrue(self.host.get('/api/push/key').json()['key'])
        self.assertEqual(self.host.post('/api/push/subscribe', json={'subscription': {'endpoint': 'http://x'}}).status_code, 422)
        for client in (self.host, self.guest):
            client.post('/api/push/subscribe', json={'subscription': real_subscription()}).raise_for_status()
        room_id = self.host.post('/api/lobbies', json={'username': 'A'}).json()['id']
        self.guest.post(f'/api/lobbies/{room_id}/join', json={'username': 'B'}).raise_for_status()
        room = self.store.rooms[room_id]
        for client in (self.host, self.guest):
            for index in (0, 1):
                self.move(client, room, 'flip', index=index)
        # the opening flips are done: whoever goes first is told, once
        self.assertTrue(self.sent.wait(5))
        self.assertEqual(len(self.pushed), 1)
        endpoint, headers = self.pushed[0]
        self.assertEqual(endpoint, 'https://push.example/abc')
        self.assertTrue(headers['Authorization'].startswith('vapid '))  # signed, as push services require
        # the same turn redrawn does not tell them again
        self.host.get(f'/api/lobbies/{room_id}/state')
        self.assertEqual(len(self.pushed), 1)

    def test_no_push_while_the_table_is_open_in_front(self):
        self.host.post('/api/push/subscribe', json={'subscription': real_subscription()}).raise_for_status()
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

    def test_someone_joining_ranked_tells_those_who_asked_once_in_a_while(self):
        self.host.post('/api/push/subscribe', json={'subscription': real_subscription(), 'queue': True}).raise_for_status()
        self.guest.post('/api/queue/join', json={'username': 'B'}).raise_for_status()
        self.assertTrue(self.sent.wait(5))
        self.assertEqual(len(self.pushed), 1)
        # leaving and joining again soon after does not tell them again
        self.sent.clear()
        self.guest.post('/api/queue/leave').raise_for_status()
        self.guest.post('/api/queue/join', json={'username': 'B'}).raise_for_status()
        self.assertFalse(self.sent.wait(0.5))
        self.assertEqual(len(self.pushed), 1)

    def test_ranked_notifications_are_only_for_those_who_asked_and_are_away(self):
        # turn notifications alone say nothing about the queue
        self.host.post('/api/push/subscribe', json={'subscription': real_subscription()}).raise_for_status()
        self.guest.post('/api/queue/join', json={'username': 'B'}).raise_for_status()
        self.assertFalse(self.sent.wait(0.5))
        # asked for, but with Golf in front of them: the page shows its own note
        self.guest.post('/api/queue/leave').raise_for_status()
        self.host.post('/api/push/subscribe', json={'subscription': real_subscription(), 'turn': False, 'queue': True}).raise_for_status()
        self.host.post('/api/presence', json={'username': 'A', 'visible': True}).raise_for_status()
        self.guest.post('/api/queue/join', json={'username': 'B'}).raise_for_status()
        self.assertFalse(self.sent.wait(0.5))
        self.assertEqual(self.pushed, [])
        # and no "your turn" either, once only the queue is asked for
        self.assertEqual([wanted['turn'] for wanted in self.store.push_subscriptions.values()], [False])

    def test_a_subscription_keeps_whether_it_wants_records_and_friend_invites(self):
        self.host.post('/api/push/subscribe', json={'subscription': real_subscription()}).raise_for_status()
        wanted = next(iter(self.store.push_subscriptions.values()))
        self.assertEqual((wanted['records'], wanted['invites']), (True, True))
        self.host.post('/api/push/subscribe', json={'subscription': real_subscription(), 'records': False, 'invites': False}).raise_for_status()
        wanted = next(iter(self.store.push_subscriptions.values()))
        self.assertEqual((wanted['records'], wanted['invites']), (False, False))


if __name__ == '__main__':
    unittest.main()


class OneMoveRulesTests(unittest.TestCase):
    def test_a_rule_one_swap_from_play_is_flagged(self):
        from game import Card, GolfGame, Rules, Slot
        from server import one_move_rules
        game = GolfGame(rules=Rules(king_queen=True, holdem=True))
        game.players[0] = [Slot(Card(13, 'H'), True), Slot(Card(2, 'S'), True), Slot(Card(9, 'C')),
                           Slot(Card(4, 'D')), Slot(Card(6, 'S'), True), Slot(Card(8, 'H'))]
        game.phase, game.current = 'choose', 0
        game.discard_pile.append(Card(12, 'D'))  # a Queen under the King makes a King-Queen column
        self.assertIn('king_queen', one_move_rules(game, 0))
        # already in play: not "one move away"
        game.players[0][3] = Slot(Card(12, 'S'), True)
        self.assertNotIn('king_queen', one_move_rules(game, 0))
        # nothing to tell before the opening flips are done
        game.phase = 'setup'
        self.assertEqual(one_move_rules(game, 0), [])

    def test_any_single_card_counts_not_just_the_discard(self):
        from game import Card, GolfGame, Rules, Slot
        from server import one_move_rules
        game = GolfGame(rules=Rules(roman_fives=True))
        # 8 top-left and 4 bottom-middle: a 2 (-2 points) top-right would make a V of 10
        game.players[0] = [Slot(Card(8, 'H'), True), Slot(Card(13, 'S'), True), Slot(Card(9, 'C')),
                           Slot(Card(3, 'D'), True), Slot(Card(4, 'S'), True), Slot(Card(6, 'H'))]
        game.phase, game.current = 'choose', 0
        game.discard_pile.append(Card(13, 'D'))  # nothing useful on the discard
        self.assertEqual(one_move_rules(game, 0), ['roman_fives'])

    def test_hosts_who_turn_off_score_previews_turn_this_off_too(self):
        store = Store()
        app = create_app(store, google_client_id='')
        with TestClient(app) as host, TestClient(app) as guest:
            for client in (host, guest):
                client.get('/api/session').raise_for_status()
            room_id = host.post('/api/lobbies', json={'username': 'A', 'score_preview': False}).json()['id']
            guest.post(f'/api/lobbies/{room_id}/join', json={'username': 'B'}).raise_for_status()
            room = store.rooms[room_id]
            room.game.phase = 'choose'
            with patch('server.one_move_rules', return_value=['king_queen']):
                self.assertEqual(host.get(f'/api/lobbies/{room_id}/state').json()['game']['near_rules'], [])
                room.score_preview = True
                self.assertEqual(host.get(f'/api/lobbies/{room_id}/state').json()['game']['near_rules'], ['king_queen'])
