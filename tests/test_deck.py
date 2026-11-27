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

    def test_a_flags_design_is_worn_only_once_it_is_earned(self):
        state = lambda: server.snapshot(self.room, next(iter(self.room.seats)))
        self.host.post('/api/deck', json={'choices': {'5D': 'ripped-5d', 'AS': 'hole-in-one'}})
        self.assertEqual(state()['skins'][0], {'AS': 'hole-in-one'})
        # three saved games where the ripped 5 tore up a 5 earn Tear it up!, and the design with it
        self.room.history = [{'moves': ['', ''], 'ended_at': i, 'activations': [['ripped_five'], []], 'scores': [5, 9], 'winner': 0}
                             for i in range(10)]
        self.store.history.save(self.room)
        self.assertEqual(self.host.get('/api/flags').json()['cards'], ['ripped-5d'])
        self.host.post('/api/deck', json={'choices': {'5D': 'ripped-5d'}})
        self.assertEqual(state()['skins'][0], {'5D': 'ripped-5d'})


if __name__ == '__main__':
    unittest.main()
