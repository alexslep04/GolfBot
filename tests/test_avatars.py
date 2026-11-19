"""Cosmetic avatars: catalog, seat assignment, validation, and page assets."""
from contextlib import ExitStack
import re
import unittest

from fastapi.testclient import TestClient

from avatars import AVATARS, BOT_AVATAR, DEFAULT_AVATAR, catalog, clean_avatar
from server import Store, create_app


class AvatarCatalogTests(unittest.TestCase):
    def test_catalog_reserves_fields_for_future_perks(self):
        entries = catalog()
        self.assertEqual(len({entry['id'] for entry in entries}), len(entries))
        for entry in entries:
            self.assertEqual(set(entry), {'id', 'name', 'icon', 'selectable', 'shared', 'rules', 'bonuses', 'abilities'})
            # Avatars are cosmetic for now: nothing may change rules or scores yet.
            self.assertEqual((entry['rules'], entry['bonuses'], entry['abilities']), ((), (), ()))
        self.assertTrue(next(entry for entry in entries if entry['id'] == DEFAULT_AVATAR)['selectable'])
        self.assertFalse(next(entry for entry in entries if entry['id'] == BOT_AVATAR)['selectable'])

    def test_only_selectable_avatars_can_be_chosen(self):
        self.assertEqual(clean_avatar('bird'), 'bird')
        for value in (BOT_AVATAR, 'dragon', '', None):
            with self.assertRaises(ValueError):
                clean_avatar(value)


class AvatarSeatTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        app = create_app(self.store, google_client_id='')
        self.host = self.context.enter_context(TestClient(app))
        self.guest, self.third = TestClient(app), TestClient(app)
        for client in (self.host, self.guest, self.third):
            self.addCleanup(client.close)
            client.get('/Golfgame/api/session').raise_for_status()

    def test_catalog_endpoint_and_session_default(self):
        body = self.host.get('/Golfgame/api/avatars').json()
        self.assertEqual(body['default'], DEFAULT_AVATAR)
        self.assertEqual([entry['id'] for entry in body['avatars']], [avatar.id for avatar in AVATARS])
        self.assertEqual(self.host.get('/Golfgame/api/session').json()['avatar'], DEFAULT_AVATAR)

    def test_solo_seats_the_player_avatar_and_the_bot(self):
        state = self.host.post('/Golfgame/api/solo', json={'username': 'Host', 'avatar': 'cat'}).json()
        self.assertEqual(state['avatars'], ['cat', BOT_AVATAR])
        self.assertEqual(self.host.get('/Golfgame/api/session').json()['avatar'], 'cat')

    def test_host_and_guest_avatars_follow_their_seats(self):
        lobby = self.host.post('/Golfgame/api/lobbies', json={'username': 'Host', 'avatar': 'tree'}).json()
        self.assertEqual(lobby['avatars'][0], 'tree')
        path = '/Golfgame/api/lobbies/' + lobby['id']
        joined = self.guest.post(path + '/join', json={'username': 'Guest', 'avatar': 'fish'}).json()
        self.assertEqual(joined['avatars'], ['tree', 'fish'])
        self.assertEqual(self.host.get(path).json()['avatars'], ['tree', 'fish'])

    def test_an_avatar_belongs_to_one_player_per_table_except_the_golf_club(self):
        lobby = self.host.post('/Golfgame/api/lobbies', json={
            'username': 'Host', 'avatar': 'club', 'game_type': 'many'}).json()
        path = '/Golfgame/api/lobbies/' + lobby['id']
        self.guest.post(path + '/join', json={'username': 'Guest', 'avatar': 'fish'}).raise_for_status()
        self.third.post(path + '/join', json={'username': 'Third', 'avatar': 'fish'}).raise_for_status()
        # the second Fish plays as the shared Golf Club, but keeps Fish as their choice
        self.assertEqual(self.host.get(path).json()['avatars'], ['club', 'fish', 'club'])
        self.assertEqual(self.third.get('/Golfgame/api/session').json()['avatar'], 'fish')

    def test_quickplay_twins_get_the_golf_club(self):
        from avatars import unique_avatars
        self.assertEqual(unique_avatars(['dog', 'dog', 'club', 'club', 'cat']), ['dog', 'club', 'club', 'club', 'cat'])

    def test_waiting_guest_leaving_clears_the_seat_avatar(self):
        lobby = self.host.post('/Golfgame/api/lobbies', json={
            'username': 'Host', 'avatar': 'tree', 'game_type': 'many'}).json()
        path = '/Golfgame/api/lobbies/' + lobby['id']
        self.guest.post(path + '/join', json={'username': 'Guest', 'avatar': 'fish'}).raise_for_status()
        self.third.post(path + '/join', json={'username': 'Third', 'avatar': 'hare'}).raise_for_status()
        self.assertEqual(self.host.get(path).json()['avatars'], ['tree', 'fish', 'hare'])
        self.guest.post(path + '/leave').raise_for_status()
        info = self.host.get(path).json()
        self.assertEqual((info['names'], info['avatars']), (['Host', 'Third'], ['tree', 'hare']))

    def test_unknown_or_reserved_avatar_is_rejected(self):
        for avatar in ('dragon', BOT_AVATAR):
            response = self.host.post('/Golfgame/api/solo', json={'username': 'Host', 'avatar': avatar})
            self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.store.rooms, {})

    def test_omitting_the_avatar_keeps_the_previous_choice(self):
        self.host.post('/Golfgame/api/presence', json={'username': 'Host', 'avatar': 'bird'}).raise_for_status()
        state = self.host.post('/Golfgame/api/solo', json={'username': 'Host'}).json()
        self.assertEqual(state['avatars'][0], 'bird')

    def test_presence_lists_avatars_and_queue_size(self):
        self.guest.post('/Golfgame/api/presence', json={'username': 'Guest', 'avatar': 'cup'}).raise_for_status()
        seen = self.host.post('/Golfgame/api/presence', json={'username': 'Host'}).json()
        self.assertEqual([(player['display_name'], player['avatar']) for player in seen['players']], [('Guest', 'cup')])
        self.assertEqual(seen['queue_size'], 0)
        self.guest.post('/Golfgame/api/queue/join', json={'username': 'Guest'}).raise_for_status()
        self.assertEqual(self.host.post('/Golfgame/api/presence', json={'username': 'Host'}).json()['queue_size'], 1)


class PageAssetTests(unittest.TestCase):
    def test_every_script_and_stylesheet_is_versioned_and_served(self):
        with TestClient(create_app(Store(), google_client_id='')) as client:
            page = client.get('/Golfgame/').text
            assets = re.findall(r'"(static/[\w./-]+\.(?:js|css))(\?v=[a-f0-9]{16})?"', page)
            self.assertGreaterEqual({name for name, _ in assets},
                                    {'static/app.js', 'static/board.js', 'static/motion.js', 'static/ui.js', 'static/gamepad.js',
                                     'static/icons.js', 'static/style.css'})
            for name, version in assets:
                self.assertTrue(version, name + ' is not versioned')
                self.assertEqual(client.get('/Golfgame/' + name).status_code, 200, name)


if __name__ == '__main__':
    unittest.main()
