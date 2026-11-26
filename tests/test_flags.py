"""Flags: earned from saved games, and what they unlock."""
from contextlib import ExitStack
import unittest

from fastapi.testclient import TestClient

import flags
from server import Store, create_app

ME, THEM = {'id': 'account:me', 'kind': 'account'}, {'id': 'account:them', 'kind': 'account'}
BOT = {'id': 'bot:golfbot', 'kind': 'bot'}


def match(rounds, seats=(ME, THEM), **extra):
    return {'participants': list(seats), 'rounds': rounds, **extra}


def game(moves, ended_at=1, **extra):
    return {'moves': moves, 'ended_at': ended_at, **extra}


class FlagTests(unittest.TestCase):
    def test_only_flipping_your_own_cards_earns_the_cue(self):
        earned = flags.earned([match([game(['fefefefe', 'dxdx'], 7)])], 'account:me')
        self.assertEqual(earned, {"Wait for my cue...": 7})
        # (a single draw, swap or discard and it is not that game)
        for moves in ('fefedx', 'fs', 'fefe' 'ds', ''):
            self.assertNotIn("Wait for my cue...", flags.earned([match([game([moves, ''])])], 'account:me'))

    def test_five_draws_thrown_away_in_a_row_and_nothing_else_earns_the_tempo(self):
        tempo = "Here we go..."
        self.assertIn(tempo, flags.earned([match([game(['dx' * 5, 'fe'])])], 'account:me'))
        # (someone's guess along the way is not a move of your hand)
        self.assertIn(tempo, flags.earned([match([game(['dxdxgdxdxdx', 'fe'])])], 'account:me'))
        for moves in ('dx' * 4, 'dx' * 5 + 'ds', 'fe' + 'dx' * 5, 'dxdxdxdxds' + 'dx'):
            self.assertNotIn(tempo, flags.earned([match([game([moves, 'fe'])])], 'account:me'))

    def test_the_move_flags_need_a_game_against_people(self):
        moves = [game(['fefefe', 'fefefe'])]
        for other in (match(moves, (ME, BOT), solo=True), match(moves, local=True), match(moves, (ME, BOT))):
            self.assertEqual(flags.earned([other], 'account:me'), {})
        self.assertEqual(flags.earned([match(moves)], 'account:nobody'), {})

    def test_777s_in_any_game_earn_lets_go_gambling(self):
        solo = match([game(['', ''], 3, subrule_activations=[['angel_numbers:777'], []])], (ME, BOT), solo=True)
        self.assertEqual(flags.earned([solo], 'account:me'), {"Let's Go Gambling!": 3})
        self.assertEqual(flags.earned([solo], 'bot:golfbot'), {})
        other = match([game(['', ''], subrule_activations=[['angel_numbers:666'], ['angel_numbers:777']])])
        self.assertEqual(flags.earned([other], 'account:me'), {})

    def test_fifty_solo_games_in_a_row_earn_adult_swim(self):
        solo = lambda start, count: match([{'ended_at': start + i} for i in range(count)], (ME, BOT), solo=True)
        self.assertEqual(flags.earned([solo(0, 50)], 'account:me'), {"Adult swim": 49})
        self.assertEqual(flags.earned([solo(0, 49)], 'account:me'), {})
        # (a game against people in between starts the count again)
        broken = [solo(0, 30), match([{'ended_at': 30.5}]), solo(31, 30)]
        self.assertEqual(flags.earned(broken, 'account:me'), {})
        self.assertEqual(flags.earned(broken + [solo(100, 20)], 'account:me'), {"Adult swim": 119})

    def test_what_each_flag_unlocks(self):
        names = list(flags.FLAGS)
        self.assertEqual(flags.unlocked_emotes(names), ['dragging', 'rushing'])
        self.assertEqual(flags.unlocked(names, 'theme'), ['poker', 'pool'])
        self.assertEqual(flags.FLAG_THEMES, {'poker': "Let's Go Gambling!", 'pool': 'Adult swim'})


class FlagServerTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.app = create_app(self.store)
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        self.host = self.context.enter_context(TestClient(self.app))
        self.guest = TestClient(self.app)
        self.addCleanup(self.guest.close)
        for client in (self.host, self.guest):
            client.get('/api/session')
        response = self.host.post('/api/lobbies', json={'username': 'Alex', 'name': 'Test table'})
        self.id = response.json()['id']
        self.room = self.store.rooms[self.id]
        self.assertEqual(self.guest.post(f'/api/lobbies/{self.id}/join', json={'username': 'Sam'}).status_code, 200)
        self.clients = (self.host, self.guest)
        for client in self.clients:
            for index in (0, 1):
                self.move(client, 'flip', index=index)

    def move(self, client, action, **extra):
        response = client.post(f'/api/lobbies/{self.id}/action', json={'action': action, 'version': self.room.version, **extra})
        self.assertEqual(response.status_code, 200, response.text)

    def test_each_seats_moves_are_logged_for_the_flags_and_saved_with_the_game(self):
        # (the opening reveal is not counted)
        self.assertEqual(self.room.move_log, [[], []])
        seat = self.room.game.current
        client = self.clients[seat]
        hidden = next(i for i, slot in enumerate(self.room.game.players[seat]) if not slot.visible)
        self.move(client, 'flip', index=hidden)
        self.move(client, 'end_turn')
        self.assertEqual(self.room.move_log[seat], ['f', 'e'])
        other = 1 - seat
        self.move(self.clients[other], 'draw')
        self.move(self.clients[other], 'discard')
        self.assertEqual(self.room.move_log[other], ['d', 'x'])

    def test_a_flags_emote_is_sent_only_once_it_is_earned(self):
        path = f'/api/lobbies/{self.id}/emote'
        self.assertEqual(self.host.get('/api/flags').json(), {'earned': [], 'emotes': [], 'themes': []})
        self.assertEqual(self.host.post(path, json={'emote': 'rushing'}).status_code, 403)
        self.assertEqual(self.host.post(path, json={'emote': 'luck'}).status_code, 200)
        # a finished game of nothing but flips, saved
        self.room.history = [game(['fefefefe', 'dxdxdx'], 5, scores=[10, 20], winner=0)]
        self.store.history.save(self.room)
        mine = self.host.get('/api/flags').json()
        self.assertEqual(mine['earned'], ["Wait for my cue..."])
        self.assertEqual(mine['emotes'], ['rushing'])
        self.assertEqual(self.host.post(path, json={'emote': 'rushing'}).status_code, 200)
        self.assertEqual(self.guest.post(path, json={'emote': 'rushing'}).status_code, 403)
        profile = self.guest.get('/api/profile', params={'player': self.room.participants[0]['id']}).json()
        self.assertEqual(profile['flags'], ["Wait for my cue..."])


if __name__ == '__main__':
    unittest.main()
