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
                self.assertEqual(set(games), {'Demo: five players', 'Demo: one on one', 'Demo: solo'})
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
                cups = sorted(client.get('/api/tournaments').json(), key=lambda cup: cup['entrants'])
                self.assertEqual([(cup['name'], cup['status'], cup['entrants']) for cup in cups], [('Demo Cup', 'live', 8), ('Demo Open', 'live', 32)])
                big = client.get(f"/api/tournaments/{cups[1]['id']}").json()
                self.assertEqual(len({entrant['name'] for entrant in big['entrants']}), 32)
                self.assertEqual(sum(match['status'] == 'live' for match in big['matches']), 16)
                view = client.get(f"/api/tournaments/{cups[0]['id']}").json()
                self.assertEqual({entrant['name'] for entrant in view['entrants']},
                                 {'Ace', 'Birdie', 'Bogey', 'Caddie', 'Eagle', 'Fairway', 'Mulligan', 'Golfbot'})
                self.assertEqual(sum(match['status'] == 'live' for match in view['matches']), 4)
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

    def test_an_ordinary_server_has_none(self):
        with mock.patch.dict(os.environ, {"GOLFBOT_DEBUG": ""}):
            with TestClient(create_app(Store())) as client:
                client.get('/api/session')
                self.assertEqual(client.get('/api/spectate').json(), [])
                self.assertEqual(client.get('/api/tournaments').json(), [])
                self.assertFalse(any(row['id'].startswith('demo:') for row in client.get('/api/leaderboards').json()['pvp']))


if __name__ == '__main__':
    unittest.main()
