from contextlib import ExitStack
import unittest

from fastapi.testclient import TestClient

from accounts import ACCOUNT_COOKIE
from friends import Friends
from match_history import MatchHistory
from server import Store, create_app


class FriendsTests(unittest.TestCase):
    def test_request_accept_and_remove(self):
        friends = Friends(MatchHistory())
        self.assertEqual(friends.request("a", "b", now=1), "requested")
        self.assertEqual(friends.request("a", "b"), "requested")  # asking again changes nothing
        self.assertEqual(friends.list("a"), [{"id": "b", "status": "outgoing", "since": 1}])
        self.assertEqual(friends.list("b")[0]["status"], "incoming")
        self.assertFalse(friends.accept("a", "b"))  # your own request is not yours to accept
        self.assertFalse(friends.are_friends("a", "b"))
        # asking someone who already asked you makes you friends
        self.assertEqual(friends.request("b", "a", now=5), "accepted")
        self.assertTrue(friends.are_friends("b", "a"))
        self.assertEqual(friends.list("b"), [{"id": "a", "status": "friend", "since": 5}])
        self.assertEqual(friends.request("a", "b"), "friends")
        self.assertTrue(friends.remove("a", "b"))
        self.assertEqual(friends.list("a"), [])
        with self.assertRaises(ValueError):
            friends.request("a", "a")

    def test_last_seen_keeps_the_latest_time_and_avatar(self):
        friends = Friends(MatchHistory())
        friends.seen("a", "dog", now=10)
        friends.seen("a", None, now=20)
        self.assertEqual(friends.last_seen(["a", "z"]), {"a": (20, "dog")})


class FriendsServerTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.app = create_app(self.store)
        self.context = ExitStack()
        self.addCleanup(self.context.close)

    def signed_in(self, subject, unique_name, display_name):
        client = self.context.enter_context(TestClient(self.app))
        account, token = self.store.accounts.login(subject)
        self.store.accounts.choose_name(account['id'], unique_name)
        self.store.accounts.save_display_name(account['id'], display_name)
        client.cookies.set(ACCOUNT_COOKIE, token)
        client.get('/api/session')
        return client

    def test_add_a_friend_by_unique_name_and_see_what_they_are_up_to(self):
        ann = self.signed_in('ann-sub', 'ann', 'Ann')
        bo = self.signed_in('bo-sub', 'bobo', 'Bo')
        self.assertEqual(ann.post('/api/friends', json={'unique_name': '@Nobody'}).status_code, 404)
        self.assertEqual(ann.post('/api/friends', json={'unique_name': '@BOBO'}).json()['outcome'], 'requested')
        listing = bo.get('/api/friends').json()
        self.assertEqual([row['unique_name'] for row in listing['incoming']], ['ann'])
        self.assertEqual(bo.post('/api/friends/ann/accept').status_code, 200)
        # Bo has not been on Golf yet: offline, never seen
        friend = ann.get('/api/friends').json()['friends'][0]
        self.assertEqual((friend['display_name'], friend['status'], friend['last_seen']), ('Bo', 'offline', None))
        bo.post('/api/presence', json={'username': 'Bo', 'avatar': 'dog', 'visible': True})
        friend = ann.get('/api/friends').json()['friends'][0]
        self.assertEqual(friend['status'], 'online')
        self.assertTrue(friend['invite_id'])
        bo.post('/api/puzzle')
        self.assertEqual(ann.get('/api/friends').json()['friends'][0]['status'], 'puzzle')
        self.assertEqual(ann.delete('/api/friends/bobo').status_code, 200)
        self.assertEqual(ann.get('/api/friends').json()['friends'], [])

    def test_a_host_can_notify_a_friend_who_is_not_on_to_join_their_table(self):
        from unittest import mock
        import server
        ann = self.signed_in('ann-sub', 'ann', 'Ann')
        bo = self.signed_in('bo-sub', 'bobo', 'Bo')
        cy = self.signed_in('cy-sub', 'cyrus', 'Cy')
        ann.post('/api/friends', json={'unique_name': 'bobo'})
        bo.post('/api/friends/ann/accept')
        room = ann.post('/api/lobbies', json={'username': 'Ann', 'name': 'Ann table'}).json()['id']
        path = f'/api/lobbies/{room}/invite-friend'
        # (not a friend; then a friend with no notifications on)
        self.assertEqual(ann.post(path, json={'unique_name': 'cyrus'}).status_code, 404)
        self.assertEqual(ann.post(path, json={'unique_name': 'bobo'}).status_code, 409)
        # Bo's phone is subscribed, and Bo is gone (the server restarted: no session)
        bo_id = 'account:' + self.store.accounts.by_unique_name('bobo')['id']
        self.store.push_subscriptions['old-token'] = {'endpoint': 'https://push.example/x', 'keys': {}, 'player': bo_id}
        with mock.patch.object(server, 'push_keys', create=True), mock.patch('pywebpush.webpush') as push:
            sent = ann.post(path, json={'unique_name': '@BoBo'})
        self.assertEqual(sent.json(), {'sent': True})
        # only the host may ask
        self.assertEqual(cy.post(path, json={'unique_name': 'bobo'}).status_code, 403)

    def test_a_profile_says_who_a_player_is_and_whether_you_are_friends(self):
        ann = self.signed_in('ann-sub', 'ann', 'Ann')
        bo = self.signed_in('bo-sub', 'bobo', 'Bo')
        bo_id = 'account:' + self.store.accounts.by_unique_name('bobo')['id']
        profile = ann.get('/api/profile', params={'player': bo_id}).json()
        self.assertEqual((profile['label'], profile['unique_name'], profile['friend'], profile['self']), ('Bo', 'bobo', 'none', False))
        self.assertEqual((profile['solo_streak'], profile['pvp_streak'], profile['mmr']), (0, 0, None))
        self.assertIn('personal', profile)
        ann.post('/api/friends', json={'unique_name': 'bobo'})
        self.assertEqual(ann.get('/api/profile', params={'player': bo_id}).json()['friend'], 'outgoing')
        self.assertEqual(bo.get('/api/profile', params={'player': 'account:' + self.store.accounts.by_unique_name('ann')['id']}).json()['friend'], 'incoming')
        self.assertEqual(bo.get('/api/profile', params={'player': bo_id}).json()['friend'], 'self')
        # a guest sees the profile too, and is told to sign in to add friends
        guest = self.context.enter_context(TestClient(self.app))
        guest.get('/api/session')
        self.assertEqual(guest.get('/api/profile', params={'player': bo_id}).json()['friend'], 'signin')
        self.assertEqual(guest.get(f'/player/{bo_id}').status_code, 200)

    def test_the_friends_list_gives_each_friends_player_id(self):
        ann = self.signed_in('ann-sub', 'ann', 'Ann')
        bo = self.signed_in('bo-sub', 'bobo', 'Bo')
        ann.post('/api/friends', json={'unique_name': 'bobo'})
        bo.post('/api/friends', json={'unique_name': 'ann'})
        bo_id = 'account:' + self.store.accounts.by_unique_name('bobo')['id']
        self.assertEqual([friend['id'] for friend in ann.get('/api/friends').json()['friends']], [bo_id])

    def test_a_guest_has_no_friends_list(self):
        guest = self.context.enter_context(TestClient(self.app))
        guest.get('/api/session')
        self.assertFalse(guest.get('/api/friends').json()['signed_in'])
        self.assertEqual(guest.post('/api/friends', json={'unique_name': 'ann'}).status_code, 403)
