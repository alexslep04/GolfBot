"""A storage failure is logged and never strands a player or the table."""
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from server import Store, create_app


class StorageFailureTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.client = TestClient(create_app(self.store))
        self.addCleanup(self.client.close)
        self.client.get('/api/session')
        state = self.client.post('/api/solo', json={'username': 'Alex'}).json()
        self.room = self.store.rooms[state['id']]

    def finish_game(self):
        game = self.room.game
        for layout in game.players:
            for slot in layout:
                slot.visible = True
        game.phase = 'over'

    def test_leaving_a_solo_table_succeeds_when_history_cannot_be_saved(self):
        self.finish_game()
        self.room.record_result()
        with patch.object(self.store.history, 'save', side_effect=TypeError('not serializable')), \
                self.assertLogs('server', level='ERROR'):
            response = self.client.post(f'/api/lobbies/{self.room.id}/leave')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), {'left': True})
        self.assertEqual(self.room.status, 'closed')

    def test_a_finished_game_is_recorded_at_the_table_when_storage_fails(self):
        self.finish_game()
        with patch.object(self.store.history, 'save', side_effect=OSError('disk full')), \
                self.assertLogs('server', level='ERROR'):
            self.room.record_result()
        self.assertTrue(self.room.round_recorded)
        self.assertEqual(len(self.room.history), 1)


if __name__ == '__main__':
    unittest.main()
