import json
from pathlib import Path
import secrets
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from game import Rules
from match_history import MatchHistory, browser_key
from server import COOKIE, Move, Room, Store, apply_move, create_app


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.addCleanup(self.store.history.close)
        self.room = Room('room', 'Friends table', Rules(poisoned_card=True), 3, 'alternate', False,
                         ['host-token', 'guest-token'], ['Alex', 'Guest'], history_store=self.store.history)

    def finish(self, scores):
        self.room.start_round()
        self.room.game.phase = 'over'
        with patch.object(self.room.game, 'score', side_effect=lambda player: scores[player]):
            self.room.record_result()
            self.room.record_result()  # Repeated delivery cannot duplicate a game.

    def test_series_contains_each_game_ties_winner_and_summed_points(self):
        for scores in ([10, 1], [2, 2], [-4, 5], [3, -2]):
            self.finish(scores)
        records = self.store.history.for_browser('host-token')
        self.assertEqual(len(records), 1)
        match = records[0]
        self.assertEqual(match['points'], [11, 6])
        self.assertEqual(match['wins'], [1, 2])
        self.assertEqual(match['winner'], 1)
        self.assertEqual(match['status'], 'finished')
        self.assertEqual([r['scores'] for r in match['rounds']], [[10, 1], [2, 2], [-4, 5], [3, -2]])
        self.assertIsNone(match['rounds'][1]['winner'])
        self.assertEqual(match['viewer'], 0)
        guest = self.store.history.for_browser('guest-token')[0]
        self.assertEqual(guest['viewer'], 1)
        self.assertEqual(guest['points'], match['points'])

    def test_series_winner_uses_wins_not_total_points(self):
        for scores in ([-30, 0], [3, 2], [3, 2]):
            self.finish(scores)
        match = self.store.history.for_browser('host-token')[0]
        self.assertEqual(match['points'], [-24, 4])
        self.assertEqual(match['winner'], 1)

    def test_rematch_retains_old_results_and_gets_new_match_id(self):
        for scores in ([0, 10], [-2, 1]):
            self.finish(scores)
        old = self.store.history.for_browser('host-token')[0]
        apply_move(self.room, 'host-token', Move(action='rematch', version=self.room.version))
        self.assertNotEqual(self.room.match_id, old['id'])
        self.assertEqual(self.room.history, [])
        self.finish([4, 9])
        matches = self.store.history.for_browser('host-token')
        self.assertEqual(len(matches), 2)
        self.assertEqual(matches[0]['status'], 'in_progress')
        self.assertEqual(matches[0]['points'], [4, 9])
        self.assertEqual(matches[1]['points'], [-2, 11])
        self.assertEqual(matches[1]['rounds'], old['rounds'])

    def test_history_privacy_and_no_card_or_session_secret_payloads(self):
        self.finish([4, 10])
        self.assertEqual(self.store.history.for_browser('outsider'), [])
        payload = json.dumps(self.store.history.for_browser('host-token'))
        for forbidden in ('host-token', 'guest-token', 'draw_pile', 'held_card', 'golf_session'):
            self.assertNotIn(forbidden, payload)
        self.assertEqual(len(browser_key('host-token')), 64)

    def test_leaving_or_cleanup_records_unfinished_series(self):
        self.finish([4, 10])
        self.store.history.save(self.room, abandoned=True)
        match = self.store.history.for_browser('host-token')[0]
        self.assertEqual(match['status'], 'abandoned')
        self.assertIsNone(match['winner'])
        self.assertEqual(match['points'], [4, 10])

    def test_solo_results_and_completed_match_survive_abandon_save(self):
        self.room.solo, self.room.best_of = True, 1
        self.room.seats[1], self.room.names[1] = None, 'GolfBot'
        self.finish([2, 7])
        self.store.history.save(self.room, abandoned=True)
        match = self.store.history.for_browser('host-token')[0]
        self.assertTrue(match['solo'])
        self.assertEqual(match['status'], 'finished')
        self.assertEqual(match['winner'], 0)

    def test_api_pages_old_matches_and_rejects_unauthenticated_access(self):
        with TestClient(create_app(self.store)) as client:
            self.assertEqual(client.get('/api/history').status_code, 401)
            client.get('/api/session')
            self.room.seats[0] = client.cookies.get(COOKIE)
            self.room.history, self.room.wins, self.room.champion = [{'round': 1, 'scores': [2, 3], 'winner': 0}], [1, 0], 0
            for index in range(51):
                self.room.match_id = f'match-{index}'
                self.store.history.save(self.room)
            first = client.get('/api/history').json()
            second = client.get('/api/history?offset=50').json()
            self.assertEqual((len(first['matches']), len(second['matches'])), (50, 1))
            self.assertEqual(first['next_offset'], 50)
            self.assertIsNone(second['next_offset'])
            self.assertEqual(len({m['id'] for m in first['matches'] + second['matches']}), 51)
            self.assertEqual(client.get('/api/history?offset=-1').status_code, 422)
            stranger = TestClient(create_app(self.store))
            stranger.get('/api/session')
            self.assertEqual(stranger.get('/api/history').json()['matches'], [])
            stranger.close()

    def test_history_page_reload_and_rule_catalog(self):
        with TestClient(create_app(self.store)) as client:
            self.assertEqual(client.get('/history').status_code, 200)
            catalog = {r['key']: r['description'] for r in client.get('/api/rules').json()}
            self.assertIn('poisoned_card', catalog)
            self.assertIn('Repeated ranks', catalog['v10'])
            self.assertIn("opponent's score", catalog['tricky_straights'])


class PersistenceTests(unittest.TestCase):
    def test_opening_database_does_not_interrupt_live_series(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'history.sqlite3'
            history = MatchHistory(path)
            self.addCleanup(history.close)
            room = Room('room', 'Table', Rules(), 3, 'host', False,
                        ['host', 'guest'], ['Host', 'Guest'], history_store=history)
            room.history = [{'round': 1, 'scores': [2, 3], 'winner': 0}]
            history.save(room)
            observer = MatchHistory(path)
            try:
                self.assertEqual(observer.for_browser('host')[0]['status'], 'in_progress')
            finally:
                observer.close()
                history.close()

    def test_disk_history_and_browser_cookie_survive_server_restart(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'history.sqlite3'
            store = Store(path)
            with TestClient(create_app(store)) as client:
                client.get('/api/session')
                token = client.cookies.get(COOKIE)
                room = Room('room', 'Persistent series', Rules(), 3, 'host', False,
                            [token, secrets.token_urlsafe(32)], ['Alex', 'Guest'], history_store=store.history)
                room.history, room.wins = [{'round': 1, 'scores': [-4, 7], 'winner': 0}], [1, 0]
                store.history.save(room)
            restarted = Store(path)
            with TestClient(create_app(restarted)) as client:
                client.cookies.set(COOKIE, token, domain='testserver.local', path='/')
                self.assertIsNone(client.get('/api/session').json()['room_id'])
                self.assertEqual(client.cookies.get(COOKIE), token)
                match = client.get('/api/history').json()['matches'][0]
                self.assertEqual(match['status'], 'interrupted')
                self.assertEqual(match['points'], [-4, 7])
                self.assertEqual(match['names'], ['Alex', 'Guest'])
                client.cookies.clear()
                client.cookies.set(COOKIE, 'invalid', domain='testserver.local', path='/')
                client.get('/api/session')
                self.assertNotEqual(client.cookies.get(COOKIE), 'invalid')
                self.assertEqual(client.get('/api/history').json()['matches'], [])


if __name__ == '__main__':
    unittest.main()
