"""Practice saves survive the J-J / Q-Q bonus, and a failed save never breaks play."""
import json
import unittest

import practice_save
from bot import choose_action
from game import Card, Rules, Slot
from server import Room


def practice_room(progression):
    room = Room('t', 'Practice', Rules(royal_pairs=True), 1, 'host', True, ['me', None], ['Me', 'Golfbot'])
    room.practice, room.practice_account, room.progression = True, 'account-1', progression
    room.start_round()
    return room


class Recorder:
    def __init__(self):
        self.saved = None

    def save_practice(self, account_id, payload):
        self.saved = json.loads(json.dumps(payload))  # what the real store does


class Broken:
    def save_practice(self, account_id, payload):
        raise TypeError('storage failed')


class PracticeSaveSetTests(unittest.TestCase):
    def test_a_used_bonus_pair_saves_and_restores_as_a_frozenset(self):
        recorder = Recorder()
        room = practice_room(recorder)
        game = room.game
        jacks = (Card(11, 'S'), Card(11, 'H'))
        game.players[0][0], game.players[0][3] = Slot(jacks[0], True), Slot(jacks[1], True)
        # earning the bonus stores the pair as a frozenset, which used to break json.dumps
        self.assertEqual(game._new_bonuses(0), 1)
        self.assertIn(frozenset(jacks), game.used_pairs)
        room.save_practice()
        self.assertIsNotNone(recorder.saved)
        restored = practice_save.restore_game(recorder.saved['game'])
        self.assertEqual(restored.used_pairs, {frozenset(jacks)})
        self.assertTrue(all(isinstance(pair, frozenset) for pair in restored.used_pairs))
        # the same pair can't earn a second bonus after a restore
        self.assertEqual(restored._new_bonuses(0), 0)

    def test_a_failed_save_does_not_raise_into_the_move(self):
        room = practice_room(Broken())
        with self.assertLogs('server', level='ERROR'):
            room.save_practice()

    def test_a_single_legal_move_is_played_without_searching(self):
        class Position:
            _root_actions = {('discard',)}

        self.assertEqual(choose_action(Position()), ('discard',))


if __name__ == '__main__':
    unittest.main()
