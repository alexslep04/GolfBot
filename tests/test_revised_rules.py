import unittest
from itertools import product

from game import Card, GolfGame, Rules, Slot
from scoring import active_rule_effects, score_adjustments, straight_adjustments, visible_effect_total, V_PATTERNS


def hand(ranks):
    return [Slot(Card(rank, suit), True) for rank, suit in zip(ranks, "SHDCSH")]


class RevisedRulesTests(unittest.TestCase):
    def test_v10_accepts_all_repeated_rank_combinations_in_both_vs(self):
        for pattern in V_PATTERNS:
            for ranks in product((10, 11, 12), repeat=3):
                with self.subTest(pattern=pattern, ranks=ranks):
                    layout = hand([1, 3, 4, 5, 6, 8])
                    for index, rank, suit in zip(pattern, ranks, "SHD"):
                        layout[index] = Slot(Card(rank, suit), True)
                    rules = Rules(v10=True)
                    self.assertEqual(score_adjustments(layout, rules)[1], 5)
                    self.assertIn("V10 engine /5", active_rule_effects(layout, rules))
                    layout[pattern[1]].visible = False
                    self.assertNotIn("V10 engine /5", active_rule_effects(layout, rules))

    def test_v10_excludes_other_ranks_and_applies_once(self):
        for ranks in ((10, 11, 13), (10, 9, 12), (8, 11, 12)):
            layout = hand([ranks[0], 1, ranks[2], 3, ranks[1], 4])
            self.assertEqual(score_adjustments(layout, Rules(v10=True))[1], 1)
        both = hand([10, 11, 12, 10, 11, 12])
        self.assertEqual(score_adjustments(both, Rules(v10=True))[1], 5)

    def test_straight_directions_target_correct_player_using_base_points(self):
        rules = Rules(tricky_straights=True)
        layout = hand([1, 2, 3, 5, 4, 3])
        self.assertEqual(straight_adjustments(layout, rules), (-3, 3))
        self.assertEqual(score_adjustments(layout, rules)[0], -3)
        # Descending 4-3-2 subtracts -2, increasing the owner's score by 2.
        self.assertEqual(straight_adjustments(hand([4, 3, 2, 10, 11, 12]), rules), (2, 10))
        self.assertEqual(straight_adjustments(hand([12, 13, 1, 1, 13, 12]), rules), (-10, 1))
        layout[1].visible = False
        self.assertEqual(straight_adjustments(layout, rules, True), (-3, 0))

    def test_incoming_straights_use_recipients_divisions(self):
        game = GolfGame(rules=Rules(tricky_straights=True, roman_fives=True))
        game.players[0] = hand([1, 2, 3, 6, 6, 6])  # Own total 20, /3; exports +3.
        game.players[1] = hand([8, 4, 2, 3, 4, 10])  # Own total 19, incoming +3, /3.
        self.assertEqual(game.score(0), 7)
        self.assertEqual(game.score(1), 8)
        self.assertEqual(visible_effect_total(game.players[1], game.rules, opponent_layout=game.players[0]), 8)
        effects = active_rule_effects(game.players[1], game.rules, opponent_layout=game.players[0])
        self.assertIn("Incoming straight row 1: +3", effects)
        game.players[0][0].visible = False
        self.assertEqual(game.score(1, True), 19)
        self.assertEqual(visible_effect_total(game.players[1], game.rules, opponent_layout=game.players[0]), 7)

    def test_poison_targets_first_finisher_before_divisions(self):
        game = GolfGame(rules=Rules(poisoned_card=True, roman_fives=True))
        game.players[0] = hand([8, 4, 2, 3, 4, 9])
        game.players[1] = hand([1, 4, 1, 5, 11, 1])
        self.assertEqual(game.score(0), 6)
        game.players[0][5].visible = False
        game.players[1][5].visible = False
        game.phase = 'choose'
        game.reveal(5)
        self.assertEqual(game.finisher, 0)
        self.assertEqual(game.score(0), 7)  # ceil((18 + 2) / 3).
        game.end_turn()
        game.draw()
        game.discard()
        self.assertEqual(game.phase, 'over')
        self.assertEqual(game.finisher, 0)
        self.assertEqual(game.score(1), 7)  # Final scoring reveals do not poison player 1.
        self.assertEqual(visible_effect_total(game.players[0], game.rules, poisoned=True), 7)
        self.assertIn('Poisoned Card: +2', active_rule_effects(game.players[0], game.rules, poisoned=True))

    def test_bonus_finishing_opponent_assigns_poison_once_and_keeps_it(self):
        game = GolfGame(rules=Rules(poisoned_card=True))
        game.players[0] = hand([3, 4, 5, 8, 9, 10])
        game.players[1] = hand([1, 4, 1, 5, 11, 1])
        game.players[0][5].visible = False
        game.players[1][5].visible = False
        game.current, game.phase, game.bonus_remaining = 0, 'bonus', 1
        game.bonus_swap((1, 5), ('discard', None))
        self.assertEqual(game.finisher, 1)
        game.players[1][0].visible = False  # A later bonus can carry a hidden card in.
        game._mark_finish()
        self.assertEqual(game.finisher, 1)
        poisoned = game.score(1)
        game.rules.poisoned_card = False
        self.assertEqual(poisoned - game.score(1), 2)
        self.assertNotIn('Poisoned Card: +2', active_rule_effects(game.players[1], game.rules, poisoned=True))

    def test_live_totals_agree_with_scores_when_all_cards_known(self):
        for seat in (0, 1):
            game = GolfGame(rules=Rules(tricky_straights=True, poisoned_card=True, v10=True, roman_fives=True, gamblers_row=True))
            game.players = [hand([1, 2, 3, 6, 6, 6]), hand([12, 4, 10, 5, 11, 1])]
            game.finisher = seat
            game.gambler_earned = [True, True]
            for player in (0, 1):
                self.assertEqual(game.score(player), visible_effect_total(game.players[player], game.rules, True, game.players[1-player], seat == player))


if __name__ == '__main__':
    unittest.main()
