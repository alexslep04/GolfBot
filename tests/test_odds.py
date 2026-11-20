"""Spectators' chance-of-winning estimate."""
import random
import unittest

from game import Card, GolfGame, Rules, Slot
from odds import odds_key, play_out, step, win_odds


def started(seed, players=2, rules=None):
    game = GolfGame(seed=seed, rules=rules, multiplayer=True, player_count=players)
    rng = random.Random(seed)
    while game.phase == "setup":
        step(game, rng)
    return game


class OddsTests(unittest.TestCase):
    def test_chances_add_up_for_every_table_size(self):
        for players in (2, 3, 5):
            game = started(players, players)
            odds = win_odds(game, samples=60, seconds=5)
            self.assertEqual(len(odds), players)
            self.assertAlmostEqual(sum(odds), 100, delta=0.5)

    def test_face_down_cards_never_change_the_estimate(self):
        game = started(7)
        other = started(7)
        # the same table, with two face-down cards traded between the hands
        a = next(i for i, slot in enumerate(other.players[0]) if not slot.visible)
        b = next(i for i, slot in enumerate(other.players[1]) if not slot.visible)
        other.players[0][a], other.players[1][b] = other.players[1][b], other.players[0][a]
        self.assertEqual(odds_key(game), odds_key(other))
        self.assertEqual(win_odds(game, samples=50, seconds=5), win_odds(other, samples=50, seconds=5))

    def test_a_far_better_hand_is_the_favorite(self):
        game = started(11)
        low = [Card(13, "S"), Card(13, "H"), Card(2, "S"), Card(13, "D"), Card(13, "C"), Card(2, "H")]
        high = [Card(10, "S"), Card(9, "H"), Card(12, "S"), Card(11, "D"), Card(8, "C"), Card(12, "H")]
        game.players[0] = [Slot(card, True) for card in low]
        game.players[1] = [Slot(card, i < 5) for i, card in enumerate(high)]
        game.draw_pile = [card for card in game.draw_pile if card not in low + high]
        game.discard_pile = [card for card in game.discard_pile if card not in low + high] or [Card(5, "S")]
        odds = win_odds(game, samples=80, seconds=5)
        self.assertGreater(odds[0], 90)

    def test_finished_game_has_no_estimate(self):
        game = started(3)
        play_out(game, random.Random(1))
        self.assertEqual(game.phase, "over")
        self.assertIsNone(win_odds(game))

    def test_playouts_finish_under_house_rules(self):
        from server import house_rules
        from game import rules_from
        from game import RULE_OPTIONS
        every = Rules(**{key: True for key, _ in RULE_OPTIONS})
        for seed in range(30):
            rules = rules_from(house_rules()) if seed % 2 else every
            game = started(seed, 2 + seed % 4, rules)
            play_out(game, random.Random(seed))
            self.assertEqual(game.phase, "over")


if __name__ == "__main__":
    unittest.main()
