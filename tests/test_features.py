import unittest
from itertools import permutations
from game import Card, GolfGame, Rules, Slot, RULE_OPTIONS
from scoring import holdem_categories, score_adjustments, straight_direction, V_PATTERNS
from rule_help import load_rule_help
from test_game import place_cards
import test_game


def cards(ranks, suits="SHDCSH"):
    return [Card(rank, suit) for rank, suit in zip(ranks, suits)]


class FeatureTests(unittest.TestCase):
    def start(self, rules):
        game = GolfGame(4, rules)
        game.reveal(0)
        game.reveal(1)
        return game

    def assert_cards(self, game):
        test_game.GolfTests.assert_conservation(self, game)

    def test_holdem_categories_stack_once_with_six_card_subsets(self):
        royal = cards([1, 10, 11, 12, 13, 9], "HHHHHS")
        self.assertEqual(holdem_categories(royal), {"flush", "straight", "royal_flush"})
        adjustment, divisor = score_adjustments([Slot(c, True) for c in royal], Rules(holdem=True))
        self.assertEqual((adjustment, divisor), (-14, 1))
        six_same_suit = cards([1, 3, 5, 8, 10, 13], "SSSSSS")
        self.assertEqual(score_adjustments([Slot(c, True) for c in six_same_suit], Rules(holdem=True))[0], -2)
        four_and_pair = cards([8, 8, 8, 8, 2, 2], "SHDCSH")
        self.assertEqual(holdem_categories(four_and_pair), {"full_house", "four_kind"})
        self.assertEqual(score_adjustments([Slot(c, True) for c in four_and_pair], Rules(holdem=True))[0], -10)

    def test_straights_ace_low_high_no_wrap_and_distinct_ranks(self):
        for ranks in ([1, 2, 3, 4, 5], [10, 11, 12, 13, 1]):
            self.assertIn("straight", holdem_categories(cards(ranks)))
        for ranks in ([12, 13, 1, 2, 3], [3, 4, 4, 5, 6]):
            self.assertNotIn("straight", holdem_categories(cards(ranks)))
        self.assertEqual(straight_direction(cards([12, 13, 1])), 1)
        self.assertEqual(straight_direction(cards([1, 13, 12])), -1)
        self.assertEqual(straight_direction(cards([13, 1, 2])), 0)

    def test_holdem_and_ripped_five_do_not_use_hidden_cards_for_subtotals(self):
        hand = [Slot(c, i != 4) for i, c in enumerate(cards([1, 10, 11, 12, 13, 9], "HHHHHS"))]
        self.assertEqual(score_adjustments(hand, Rules(holdem=True), True)[0], 0)
        self.assertEqual(score_adjustments(hand, Rules(holdem=True), False)[0], -14)
        hand = [Slot(c, i != 2) for i, c in enumerate(cards([5, 5, 5, 13, 4, 8], "HSDCSH"))]
        self.assertEqual(score_adjustments(hand, Rules(ripped_five=True), True)[0], 0)
        self.assertEqual(score_adjustments(hand, Rules(ripped_five=True), False)[0], -5)

    def test_both_v_orientations_all_permutations_and_stacked_divisions(self):
        for pattern in V_PATTERNS:
            for ranks in permutations((10, 11, 12)):
                hand = [Slot(c, True) for c in cards([1, 3, 4, 5, 6, 8])]
                for index, rank in zip(pattern, ranks):
                    hand[index] = Slot(Card(rank, "S"), True)
                adjustment, divisor = score_adjustments(hand, Rules(v10=True, roman_fives=True))
                self.assertEqual((adjustment, divisor), (0, 15))
                self.assertEqual(score_adjustments(hand, Rules(v10=True, roman_fives=True), True)[1], 1)
        hand = [Slot(c, True) for c in cards([10, 11, 12, 10, 11, 12], "SHDCHS")]
        self.assertEqual(score_adjustments(hand, Rules(v10=True, roman_fives=True))[1], 15)
        hand = [Slot(c, True) for c in cards([11, 1, 11, 5, 11, 6])]
        self.assertEqual(score_adjustments(hand, Rules(v10=True, roman_fives=True))[1], 3)

    def test_tricky_rows_use_rank_order_and_golf_points_on_rightmost(self):
        hand = [Slot(c, True) for c in cards([1, 2, 3, 5, 4, 3])]
        self.assertEqual(score_adjustments(hand, Rules(tricky_straights=True))[0], 0)
        hand[5].visible = False
        self.assertEqual(score_adjustments(hand, Rules(tricky_straights=True), True)[0], 3)
        self.assertEqual(score_adjustments([Slot(c, True) for c in cards([4, 3, 2, 10, 11, 12])], Rules(tricky_straights=True))[0], 12)

    def test_ripped_five_once_and_only_with_diamonds(self):
        hand = [Slot(c, True) for c in cards([5, 5, 5, 5, 1, 13], "SHDCSH")]
        self.assertEqual(score_adjustments(hand, Rules(ripped_five=True))[0], -5)
        hand = [Slot(c, True) for c in cards([5, 5, 1, 3, 4, 13], "SHDCSH")]
        self.assertEqual(score_adjustments(hand, Rules(ripped_five=True))[0], 0)

    def test_final_scoring_additions_before_divisions_and_negative_rounding(self):
        game = GolfGame(1, Rules(v10=True, roman_fives=True, gamblers_row=True))
        game.players[0] = [Slot(c, True) for c in cards([10, 1, 12, 5, 11, 13])]
        game.gambler_earned[0] = True
        self.assertEqual(game.score(0), 1)  # 39 / (5 * 3 * 7), rounded up.
        game = GolfGame(1, Rules(holdem=True, ripped_five=True))
        game.players[0] = [Slot(c, True) for c in cards([5, 5, 13, 5, 5, 13], "SHSDCH")]
        self.assertEqual(game.score(0), -15)  # Three zero columns, full-house + four-kind + ripped 5.
        game.rules.gamblers_row = True
        game.gambler_earned[0] = True
        self.assertEqual(game.score(0), -2)

    def setup_four(self, rank=9, with_draw=False):
        game = self.start(Rules(four_kind=True))
        place_cards(game, 0, {0: Card(rank, "S"), 1: Card(rank, "H"), 2: Card(rank, "D"), 4: Card(rank, "C")})
        game.players[0][2].visible = True
        if with_draw:
            game.draw()
        game.reveal(4)
        self.assertEqual(game.phase, "arrange")
        return game

    def test_four_kind_all_column_choices_preserve_cards_visibility_and_flipped_identity(self):
        for columns in ((0, 1), (0, 2), (1, 2)):
            game = self.setup_four(with_draw=True)
            flipped = Card(9, "C")
            hidden = {slot.card for slot in game.players[0] if not slot.visible}
            held = game.held_card
            game.arrange_four(columns)
            self.assertEqual(game.phase, "drawn_revealed")
            self.assertEqual(game.held_card, held)
            self.assertEqual({slot.card for slot in game.players[0] if not slot.visible}, hidden)
            for column in columns:
                self.assertEqual(game.players[0][column].card.rank, 9)
                self.assertEqual(game.players[0][column + 3].card.rank, 9)
            self.assertEqual(game.players[0][game.flipped].card, flipped)
            self.assertEqual(game.targets(), [game.flipped])
            game.swap(game.flipped)
            self.assertEqual(game.current, 1)
            self.assert_cards(game)

    def test_four_kind_can_decline_and_does_not_repeat(self):
        game = self.setup_four()
        layout = [(slot.card, slot.visible) for slot in game.players[0]]
        game.arrange_four()
        self.assertEqual(layout, [(slot.card, slot.visible) for slot in game.players[0]])
        self.assertEqual(game.phase, "revealed")
        game.end_turn()
        game.opponent_turn()
        game.reveal(3)
        self.assertEqual(game.phase, "revealed")
        self.assert_cards(game)

    def test_four_kind_normal_replacement_offers_before_ending_turn(self):
        game = self.start(Rules(four_kind=True))
        place_cards(game, 0, {0: Card(9, "S"), 1: Card(9, "H"), 2: Card(9, "D"), 4: Card(9, "C")})
        game.players[0][2].visible = True
        # Put the fourth real 9 on the discard by exchanging it with the existing top.
        game.players[0][4].card, game.discard_pile[-1] = game.discard_pile[-1], game.players[0][4].card
        game.swap(4)
        self.assertEqual(game.phase, "arrange")
        self.assertEqual(game.turns, 0)
        game.arrange_four((0, 1))
        self.assertEqual(game.turns, 1)
        self.assertEqual(game.current, 1)
        self.assert_cards(game)

    def test_four_kind_cannot_override_666_locks(self):
        game = self.start(Rules(four_kind=True, devils_row=True))
        place_cards(game, 0, {0: Card(6, "S"), 1: Card(6, "H"), 2: Card(6, "D"), 4: Card(6, "C")})
        game.reveal(2)
        self.assertEqual(len(game.locked_cards), 3)
        game.end_turn()
        game.opponent_turn()
        game.reveal(4)
        self.assertEqual(game.phase, "revealed")
        self.assertTrue(all(game.arrangement_plan(0, 6, columns) is None for columns in ((0, 1), (0, 2), (1, 2))))
        self.assert_cards(game)

    def setup_beggars(self):
        game = self.start(Rules(beggars=True))
        place_cards(game, 0, {0: Card(12, "S"), 1: Card(11, "S")})
        place_cards(game, 1, {0: Card(8, "H"), 1: Card(6, "H"), 4: Card(3, "H")})
        for index, slot in enumerate(game.players[1]):
            slot.visible = index in (0, 1)
        game.current = 1
        game.reveal(4)
        self.assertEqual(game.phase, "guess")
        self.assertEqual(game.decision_player, 0)
        self.assertFalse(game.players[1][4].visible)
        return game

    def test_beggars_correct_guess_trade_ties_and_resume(self):
        game = self.setup_beggars()
        game.submit_guess(3)
        self.assertEqual(game.phase, "guess_trade")
        own, other = game.guess_trade_targets()
        self.assertEqual(own, [(0, 0), (0, 1)])
        self.assertEqual(other, [(1, 4)])
        with self.assertRaises(ValueError):
            game.guess_trade((0, 3), (1, 4))
        game.guess_trade((0, 1), (1, 4))
        self.assertEqual(game.players[0][1].card, Card(3, "H"))
        self.assertEqual(game.players[1][4].card, Card(11, "S"))
        self.assertEqual(game.phase, "revealed")
        self.assertEqual(game.current, 1)
        self.assertEqual(game.turns, 0)
        self.assertEqual(game.flipped, 4)
        game.opponent_turn()
        self.assertEqual(game.turns, 1)
        self.assert_cards(game)

    def test_beggars_wrong_guess_and_pass_reveal_without_trade(self):
        for rank in (None, 9):
            game = self.setup_beggars()
            before = [slot.card for layout in game.players for slot in layout]
            game.submit_guess(rank)
            self.assertEqual(game.phase, "revealed")
            self.assertEqual(before, [slot.card for layout in game.players for slot in layout])
            self.assertTrue(game.players[1][4].visible)
            self.assert_cards(game)

    def test_beggars_tied_high_values_do_not_prompt(self):
        game = self.start(Rules(beggars=True))
        place_cards(game, 0, {0: Card(12, "S")})
        place_cards(game, 1, {0: Card(11, "H")})
        game.players[1][0].visible = True
        game.reveal(4)
        self.assertEqual(game.phase, "revealed")

    def test_beggars_draw_then_reveal_preserves_held_card(self):
        game = self.setup_beggars()
        # Reset only the pending reveal to exercise the draw-first route.
        game.phase, game.guess_pending = "choose", None
        game.draw()
        held = game.held_card
        game.reveal(4)
        game.submit_guess(None)
        self.assertEqual(game.phase, "drawn_revealed")
        self.assertEqual(game.held_card, held)
        game.discard()
        self.assertEqual(game.discard_pile[-1], held)
        self.assert_cards(game)

    def test_help_for_every_rule_comes_from_single_rules_file(self):
        help_text = load_rule_help()
        self.assertEqual(set(help_text), {key for key, _ in RULE_OPTIONS})
        self.assertIn("top-left + bottom-middle + top-right", help_text["v10"][1])
        self.assertIn("bottom-left + top-middle + bottom-right", help_text["v10"][1])
        self.assertIn("royal flush", help_text["holdem"][1])

    def test_three_hundred_all_rules_rounds_no_stuck_decisions_or_missing_cards(self):
        for seed in range(300):
            game = GolfGame(seed, Rules(**{key: True for key in Rules.__dataclass_fields__}))
            game.reveal(0)
            game.reveal(1)
            for step in range(180):
                if game.phase == "over":
                    break
                if game.decision_player == 1:
                    game.opponent_turn()
                elif game.phase == "guess":
                    # Alternate passes, misses, and successful guesses to cover trade states.
                    game.submit_guess(game.players[game.current][game.guess_pending["target"]].card.rank if seed % 3 == 0 else None if seed % 3 == 1 else 1)
                elif game.phase == "guess_trade":
                    own, other = game.guess_trade_targets()
                    game.guess_trade(own[0], other[0])
                elif game.phase == "arrange":
                    pending = game.arrange_pending
                    allowed = [columns for columns in ((0, 1), (0, 2), (1, 2)) if game.arrangement_plan(pending["player"], pending["rank"], columns)]
                    game.arrange_four(game.rng.choice(allowed + [None]))
                elif game.phase == "bonus":
                    game.bonus_swap(*game.rng.sample(game.table_refs(), 2))
                elif game.phase == "choose":
                    hidden = [i for i, slot in enumerate(game.players[0]) if not slot.visible]
                    if hidden:
                        game.reveal(game.rng.choice(hidden))
                    else:
                        game.draw()
                elif game.phase == "revealed":
                    if game.rng.randrange(2):
                        game.end_turn()
                    else:
                        game.draw()
                elif game.phase == "drawn":
                    game.swap(game.rng.choice(game.targets()))
                elif game.phase == "drawn_revealed":
                    if game.targets() and game.rng.randrange(2):
                        game.swap(game.targets()[0])
                    else:
                        game.discard()
                else:
                    self.fail(f"Unhandled phase {game.phase}")
                self.assert_cards(game)
            self.assertEqual(game.phase, "over", f"seed {seed}, phase {game.phase}")


if __name__ == "__main__":
    unittest.main()
