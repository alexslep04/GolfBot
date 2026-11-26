"""Your Deck: each player's custom card designs, shown at the tables they sit at."""
from contextlib import ExitStack
import unittest

from fastapi.testclient import TestClient

import server
from game import GolfGame
from server import Store, create_app


class DiscardOwnerTests(unittest.TestCase):
    def test_the_top_discard_is_owned_by_whoever_put_it_there(self):
        game = GolfGame(seed=3)
        self.assertIsNone(game.discard_owner)  # (the card dealt to start the pile)
        game.phase = "choose"
        game.current = 0
        game.draw()
        game.discard()
        self.assertEqual(game.discard_owner, 0)


class DeckServerTests(unittest.TestCase):
    def setUp(self):
        server.DECK_SKINS.clear()
        self.addCleanup(server.DECK_SKINS.clear)
        self.store = Store()
        self.app = create_app(self.store)
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        self.host = self.context.enter_context(TestClient(self.app))
        self.guest = TestClient(self.app)
        self.addCleanup(self.guest.close)
        for client in (self.host, self.guest):
            client.get('/api/session')
        self.id = self.host.post('/api/lobbies', json={'username': 'Alex', 'name': 'Test table'}).json()['id']
        self.assertEqual(self.guest.post(f'/api/lobbies/{self.id}/join', json={'username': 'Sam'}).status_code, 200)
        self.room = self.store.rooms[self.id]

    def test_each_seats_designs_are_in_the_table_state(self):
        sent = self.host.post('/api/deck', json={'choices': {'AS': 'hole-in-one', 'ZZ': 'bad', 'KH': 'Not OK!'}})
        self.assertEqual(sent.status_code, 200)
        state = lambda: server.snapshot(self.room, next(iter(self.room.seats)))
        self.assertEqual(state()['skins'], [{'AS': 'hole-in-one'}, {}])
        self.assertIn('discard_owner', state()['game'])
        # (cleared, they are gone again)
        self.host.post('/api/deck', json={'choices': {}})
        self.assertEqual(state()['skins'], [{}, {}])


if __name__ == '__main__':
    unittest.main()
