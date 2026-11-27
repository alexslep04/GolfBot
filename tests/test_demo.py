import os
import unittest
from unittest import mock

from fastapi.testclient import TestClient

from server import Store, create_app


class DemoTablesTests(unittest.TestCase):
    def test_a_debug_server_has_three_demo_games_on_watch_and_demo_players_on_the_pvp_board(self):
        with mock.patch.dict(os.environ, {"GOLFBOT_DEBUG": "1"}):
            store = Store()
            with TestClient(create_app(store)) as client:
                client.get('/api/session')
                # (the demo tournament's matches are on Watch too)
                games = {row['name']: row for row in client.get('/api/spectate').json() if not row['tournament']}
                self.assertEqual(set(games), {'Demo: five players', 'Demo: one on one', 'Demo: solo', 'Demo: 32 players'})
                self.assertEqual(len(games['Demo: 32 players']['names']), 32)
                self.assertEqual(len(games['Demo: five players']['names']), 5)
                self.assertEqual(games['Demo: five players']['mmr'][:3], [1284, 1172, 1046])
                self.assertTrue(games['Demo: solo']['solo'])
                board = client.get('/api/leaderboards').json()['pvp']
                self.assertEqual([row['label'] for row in board[:3]], ['Ace', 'Birdie', 'Bogey'])
                # a demo player's profile
                self.assertEqual(client.get('/api/profile', params={'player': 'demo:ace'}).json()['mmr'], 1284)
                # nothing of them is saved
                self.assertEqual(client.get('/api/history').json()['matches'], [])

    def test_a_debug_server_runs_a_demo_tournament_of_demo_players_that_is_never_saved(self):
        with mock.patch.dict(os.environ, {"GOLFBOT_DEBUG": "1"}):
            with TestClient(create_app(Store())) as client:
                client.get('/api/session')
                cups = {cup['name']: cup for cup in client.get('/api/tournaments').json()}
                self.assertEqual({name: (cup['status'], cup['entrants'], cup['format']) for name, cup in cups.items()},
                                 {'Demo Cup': ('live', 5, 'single'), 'Demo Open': ('live', 32, 'single'),
                                  'Demo Double': ('live', 8, 'double'), 'Demo Round Robin': ('live', 6, 'round_robin')})
                cups = [cups['Demo Cup'], cups['Demo Open']]
                big = client.get(f"/api/tournaments/{cups[1]['id']}").json()
                self.assertEqual(len({entrant['name'] for entrant in big['entrants']}), 32)
                self.assertEqual(sum(match['status'] == 'live' for match in big['matches']), 16)
                view = client.get(f"/api/tournaments/{cups[0]['id']}").json()
                # (five players: the top three seeds have byes; the 4th and 5th seeds play, and so do
                # the 2nd and 3rd, whose byes have already put them through)
                self.assertEqual({entrant['name'] for entrant in view['entrants']}, {'Ace', 'Birdie', 'Bogey', 'Caddie', 'Eagle'})
                self.assertEqual(sum(match['note'] == 'bye' for match in view['matches']), 3)
                self.assertEqual(sum(match['status'] == 'live' for match in view['matches']), 2)
                self.assertEqual(client.get('/api/tournament-history').json(), [])

    def test_a_finished_series_stays_on_watch_a_minute_with_its_winner(self):
        import time
        with mock.patch.dict(os.environ, {"GOLFBOT_DEBUG": "1"}):
            store = Store()
            with TestClient(create_app(store)) as client:
                client.get('/api/session')
                room = next(room for room in store.rooms.values() if room.name == 'Demo: one on one')
                room.status, room.champion, room.round_recorded = 'finished', 1, True
                room.history = [{'round': 1, 'scores': [9, 4], 'winner': 1, 'ended_at': time.time() - 5}]
                row = next(row for row in client.get('/api/spectate').json() if row['id'] == room.id)
                self.assertEqual((row['finished'], row['champion'], row['scores']), (True, 1, None))
                room.history[-1]['ended_at'] = time.time() - 61
                self.assertNotIn(room.id, [row['id'] for row in client.get('/api/spectate').json()])

    def test_watch_lists_friends_games_first_then_the_most_recent_move_first(self):
        import time
        with mock.patch.dict(os.environ, {"GOLFBOT_DEBUG": "1"}):
            store = Store()
            with TestClient(create_app(store)) as client:
                client.get('/api/session')
                rooms = {room.name: room for room in store.rooms.values() if room.name.startswith('Demo:')}
                now = time.time()
                rooms['Demo: solo'].moved_at = now - 300
                rooms['Demo: one on one'].moved_at = now - 1
                rooms['Demo: five players'].moved_at = now - 20
                rooms['Demo: 32 players'].moved_at = now - 100
                listed = [row['name'] for row in client.get('/api/spectate').json() if row['name'].startswith('Demo:')]
                self.assertEqual(listed, ['Demo: one on one', 'Demo: five players', 'Demo: 32 players', 'Demo: solo'])
                # a friend's game leads, however quiet
                with mock.patch.object(store.friends, 'list', return_value=[{'id': 'birdie-account', 'status': 'friend'}]), \
                        mock.patch.object(store.accounts, 'from_token', return_value={'id': 'me'}):
                    rooms['Demo: solo'].participants[0] = {'id': 'account:birdie-account', 'kind': 'player', 'display_name': 'Birdie'}
                    listed = [row['name'] for row in client.get('/api/spectate').json() if row['name'].startswith('Demo:')]
                self.assertEqual(listed[0], 'Demo: solo')

    def test_an_ordinary_server_has_none(self):
        with mock.patch.dict(os.environ, {"GOLFBOT_DEBUG": ""}):
            with TestClient(create_app(Store())) as client:
                client.get('/api/session')
                self.assertEqual(client.get('/api/spectate').json(), [])
                self.assertEqual(client.get('/api/tournaments').json(), [])
                self.assertFalse(any(row['id'].startswith('demo:') for row in client.get('/api/leaderboards').json()['pvp']))
                # (nor does it make up a demo player's profile or numbers when asked for one)
                self.assertIsNone(client.get('/api/profile', params={'player': 'demo:ace'}).json().get('mmr'))


if __name__ == '__main__':
    unittest.main()
