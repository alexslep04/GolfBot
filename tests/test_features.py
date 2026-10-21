import unittest
from itertools import permutations
from game import Card, GolfGame, Rules, Slot, RULE_OPTIONS
from scoring import holdem_categories, score_adjustments, straight_direction, V_PATTERNS, column_score, active_rule_effects, visible_effect_total
from rule_help import load_rule_help
from dataclasses import FrozenInstanceError
from itertools import product
from test_game import place_cards
import test_game


def cards(ranks, suits="SHDCSH"):
    return [Card(rank, suit) for rank, suit in zip(ranks, suits)]


class FeatureTests(unittest.TestCase):
    def test_face_rank_and_base_golf_points_are_distinct_and_immutable(self):
        expected = [1, -2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 0]
        for rank, points in enumerate(expected, 1):
            card = Card(rank, "S")
            self.assertEqual(card.rank, rank)
            self.assertEqual(card.base_points, points)
            self.assertEqual(card.points, points)  # Existing callers keep the same API.
            with self.assertRaises(FrozenInstanceError):
                card.rank = 0
            with self.assertRaises(FrozenInstanceError):
                card.base_points = 0

    def test_reported_roman_fives_examples_ignore_column_cancellations(self):
        for ranks, subtotal in (([1, 4, 1, 5, 11, 1], 20), ([8, 4, 2, 3, 4, 10], 19)):
            game = GolfGame(rules=Rules(roman_fives=True))
            hand = [Slot(card, True) for card in cards(ranks)]
            game.players[0] = hand
            before = [(slot.card.rank, slot.card.base_points) for slot in hand]
            self.assertEqual(column_score(hand, game.rules), subtotal)
            self.assertEqual(score_adjustments(hand, game.rules)[1], 2)
            self.assertIn("Roman 5s /2", active_rule_effects(hand, game.rules))
            self.assertEqual(visible_effect_total(hand, game.rules), 10)
            self.assertEqual(game.score(0), 10)
            self.assertEqual(before, [(slot.card.rank, slot.card.base_points) for slot in hand])

    def test_roman_fives_independent_of_other_scoring_rule_combinations(self):
        options = ("king_queen", "holdem", "ripped_five", "tricky_straights", "v10", "gamblers_row")
        for ranks in ([1, 4, 1, 5, 11, 1], [8, 4, 2, 3, 4, 10]):
            hand = [Slot(card, True) for card in cards(ranks)]
            for enabled in product((False, True), repeat=len(options)):
                rules = Rules(roman_fives=True, **dict(zip(options, enabled)))
                with self.subTest(ranks=ranks, rules=rules):
                    game = GolfGame(rules=rules)
                    game.players[0] = hand
                    game.players[1] = [Slot(card, True) for card in cards([3, 5, 8, 10, 12, 13])]
                    game.gambler_earned[0] = rules.gamblers_row
                    expected = 2 if rules.gamblers_row else 10
                    self.assertEqual(score_adjustments(hand, rules)[1], 2)
                    self.assertIn("Roman 5s /2", active_rule_effects(hand, rules, rules.gamblers_row))
                    self.assertEqual(game.score(0), expected)
                    self.assertEqual(visible_effect_total(hand, rules, rules.gamblers_row), expected)

    def test_roman_fives_eligibility_survives_score_changing_effects(self):
        fixtures = [
            # Ripped 5 cancels the 5D in the qualifying 5-4-A V.
            ([5, 8, 1, 13, 4, 5], "DSHCHS", Rules(roman_fives=True, ripped_five=True), 13, 7),
            # King-Queen reduces a column but the qualifying Q-K-K V stays 10-0-0.
            ([12, 8, 13, 13, 13, 4], "HSHDCH", Rules(roman_fives=True, king_queen=True), 17, 9),
            # A same-suit hand earns Hold 'em -5; its 6-A-3 V still totals 10.
            ([6, 8, 3, 5, 1, 13], "HHHHHH", Rules(roman_fives=True, holdem=True), 18, 9),
            # The A-6-3 V totals 10; the ascending row now adds 3 to the opponent.
            ([1, 2, 3, 6, 6, 6], "SHDCSH", Rules(roman_fives=True, tricky_straights=True), 20, 10),
        ]
        for ranks, suits, rules, subtotal, final in fixtures:
            with self.subTest(ranks=ranks, rules=rules):
                game = GolfGame(rules=rules)
                hand = [Slot(card, True) for card in cards(ranks, suits)]
                game.players[0] = hand
                game.players[1] = [Slot(card, True) for card in cards([3, 5, 8, 10, 12, 13])]
                self.assertEqual(column_score(hand, rules) + score_adjustments(hand, rules, True)[0], subtotal)
                self.assertEqual(score_adjustments(hand, rules)[1], 2)
                self.assertIn("Roman 5s /2", active_rule_effects(hand, rules))
                self.assertEqual(visible_effect_total(hand, rules), final)
                self.assertEqual(game.score(0), final)

    def test_roman_fives_and_v10_stack_using_independent_vs(self):
        game = GolfGame(rules=Rules(roman_fives=True, v10=True, gamblers_row=True))
        hand = [Slot(card, True) for card in cards([12, 4, 10, 5, 11, 1])]
        game.players[0] = hand
        self.assertEqual(score_adjustments(hand, game.rules)[1], 10)
        self.assertEqual(active_rule_effects(hand, game.rules), ["Roman 5s /2", "V10 engine /5"])
        self.assertEqual(game.score(0), 4)  # 40 / (2 * 5).
        self.assertEqual(visible_effect_total(hand, game.rules), 4)
        game.gambler_earned[0] = True
        self.assertEqual(game.score(0), 1)
        self.assertEqual(visible_effect_total(hand, game.rules, True), 1)

    def test_two_qualifying_vs_apply_roman_fives_only_once(self):
        game = GolfGame(rules=Rules(roman_fives=True))
        hand = [Slot(card, True) for card in cards([6, 4, 1, 5, 3, 1])]
        game.players[0] = hand
        self.assertEqual(score_adjustments(hand, game.rules)[1], 2)
        self.assertEqual(active_rule_effects(hand, game.rules).count("Roman 5s /2"), 1)
        self.assertEqual(game.score(0), 9)
        self.assertEqual(visible_effect_total(hand, game.rules), 9)

    def test_roman_fives_uses_negative_two_and_does_not_infer_hidden_points(self):
        hand = [Slot(card, True) for card in cards([8, 4, 2, 3, 4, 10])]
        rules = Rules(roman_fives=True)
        for index in (0, 4, 2):
            hand[index].visible = False
            self.assertNotIn("Roman 5s /2", active_rule_effects(hand, rules))
            self.assertEqual(visible_effect_total(hand, rules), column_score(hand, rules, True))
            hand[index].visible = True
        # A-7-2 has face ranks summing to 10 but Golf points summing to 6.
        not_a_match = [Slot(card, True) for card in cards([1, 9, 2, 13, 7, 13])]
        self.assertEqual(score_adjustments(not_a_match, rules)[1], 1)
        self.assertNotIn("Roman 5s /2", active_rule_effects(not_a_match, rules))

    def test_roman_fives_sum_ten_both_orientations(self):
        from scoring import active_rule_effects
        for pattern in V_PATTERNS:
            game = GolfGame(1, Rules(roman_fives=True))
            hand = [Slot(c, True) for c in cards([8, 9, 10, 11, 12, 13])]
            for index, rank in zip(pattern, (6, 1, 3)):
                hand[index] = Slot(Card(rank, "H"), True)
            game.players[0] = hand
            self.assertEqual(score_adjustments(hand, game.rules)[1], 2)
            self.assertEqual(game.score(0), (game.score(0, True) + 1) // 2)
            self.assertIn("Roman 5s /2", active_rule_effects(hand, game.rules))
            hand[pattern[1]].visible = False
            self.assertNotIn("Roman 5s /2", active_rule_effects(hand, game.rules))
            self.assertEqual(score_adjustments(hand, game.rules, True)[1], 1)
            game.rules.roman_fives = False
            self.assertEqual(score_adjustments(hand, game.rules)[1], 1)

    def start(self, rules):
        game = GolfGame(4, rules)
        game.reveal(0)
        game.reveal(1)
        return game

    def assert_cards(self, game):
        test_game.GolfTests.assert_conservation(self, game)

    def test_holdem_single_five_point_bonus_with_six_card_subsets(self):
        royal = cards([1, 10, 11, 12, 13, 9], "HHHHHS")
        self.assertEqual(holdem_categories(royal), {"flush", "straight", "royal_flush"})
        adjustment, divisor = score_adjustments([Slot(c, True) for c in royal], Rules(holdem=True))
        self.assertEqual((adjustment, divisor), (-5, 1))
        six_same_suit = cards([1, 3, 5, 8, 10, 13], "SSSSSS")
        self.assertEqual(score_adjustments([Slot(c, True) for c in six_same_suit], Rules(holdem=True))[0], -5)
        four_and_pair = cards([8, 8, 8, 8, 2, 2], "SHDCSH")
        self.assertEqual(holdem_categories(four_and_pair), {"full_house", "four_kind"})
        self.assertEqual(score_adjustments([Slot(c, True) for c in four_and_pair], Rules(holdem=True))[0], -5)

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
        self.assertEqual(score_adjustments(hand, Rules(holdem=True), False)[0], -5)
        hand = [Slot(c, i != 4) for i, c in enumerate(cards([5, 1, 3, 13, 5, 8], "DSHCHS"))]
        self.assertEqual(column_score(hand, Rules(ripped_five=True), True), 17)
        self.assertEqual(column_score(hand, Rules(ripped_five=True), False), 12)
        self.assertFalse(any("Ripped" in effect for effect in active_rule_effects(hand, Rules(ripped_five=True))))

    def test_both_v_orientations_all_permutations_and_stacked_divisions(self):
        for pattern in V_PATTERNS:
            for ranks in permutations((10, 11, 12)):
                hand = [Slot(c, True) for c in cards([1, 3, 4, 5, 6, 8])]
                for index, rank in zip(pattern, ranks):
                    hand[index] = Slot(Card(rank, "S"), True)
                adjustment, divisor = score_adjustments(hand, Rules(v10=True, roman_fives=True))
                self.assertEqual((adjustment, divisor), (0, 5))
                self.assertEqual(score_adjustments(hand, Rules(v10=True, roman_fives=True), True)[1], 1)
        hand = [Slot(c, True) for c in cards([10, 11, 12, 10, 11, 12], "SHDCHS")]
        self.assertEqual(score_adjustments(hand, Rules(v10=True, roman_fives=True))[1], 5)
        hand = [Slot(c, True) for c in cards([11, 1, 11, 5, 11, 6])]
        self.assertEqual(score_adjustments(hand, Rules(v10=True, roman_fives=True))[1], 5)

    def test_tricky_rows_use_rank_order_and_golf_points_on_rightmost(self):
        hand = [Slot(c, True) for c in cards([1, 2, 3, 5, 4, 3])]
        self.assertEqual(score_adjustments(hand, Rules(tricky_straights=True))[0], -3)
        hand[5].visible = False
        self.assertEqual(score_adjustments(hand, Rules(tricky_straights=True), True)[0], 0)
        self.assertEqual(score_adjustments([Slot(c, True) for c in cards([4, 3, 2, 10, 11, 12])], Rules(tricky_straights=True))[0], 2)

    def test_ripped_five_opposite_row_and_no_double_cancellation(self):
        rules = Rules(ripped_five=True)
        opposite = [Slot(c, True) for c in cards([5, 1, 3, 13, 5, 8], "DSHCHS")]
        self.assertEqual(column_score(opposite, rules), 12)
        self.assertIn("Ripped 5: 0 (-10)", active_rule_effects(opposite, rules))
        same_row = [Slot(c, True) for c in cards([5, 5, 3, 13, 1, 8], "DHSCHS")]
        self.assertEqual(column_score(same_row, rules), 22)
        paired_column = [Slot(c, True) for c in cards([5, 1, 3, 5, 13, 8], "DSHHCS")]
        self.assertEqual(column_score(paired_column, rules), 12)
        self.assertFalse(any("Ripped" in effect for effect in active_rule_effects(paired_column, rules)))
        multiple = [Slot(c, True) for c in cards([5, 1, 3, 8, 5, 5], "DHCSSH")]
        self.assertEqual(column_score(multiple, rules), 17)

    def test_final_scoring_additions_before_divisions_and_negative_rounding(self):
        game = GolfGame(1, Rules(v10=True, roman_fives=True, gamblers_row=True))
        game.players[0] = [Slot(c, True) for c in cards([10, 1, 12, 5, 11, 13])]
        game.gambler_earned[0] = True
        self.assertEqual(game.score(0), 2)  # 39 / (5 * 7), rounded up.
        game = GolfGame(1, Rules(holdem=True, ripped_five=True))
        game.players[0] = [Slot(c, True) for c in cards([5, 5, 13, 5, 5, 13], "SHSDCH")]
        self.assertEqual(game.score(0), -5)  # Three zero columns; one Hold 'em bonus, no reused fives.
        game.rules.gamblers_row = True
        game.gambler_earned[0] = True
        self.assertEqual(game.score(0), 0)

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
        self.assertIn("either V", help_text["v10"][1])
        self.assertIn("Apply once", help_text["holdem"][1])

    def test_multiple_effects_report_each_numeric_value(self):
        hand = [Slot(c, True) for c in cards([1, 2, 3, 5, 4, 3])]
        effects = active_rule_effects(hand, Rules(tricky_straights=True))
        self.assertIn("Straight row 1: opponent +3", effects)
        self.assertIn("Straight row 2: -3", effects)
        hand = [Slot(c, True) for c in cards([13, 13, 2, 12, 12, 2], "HSHDDS")]
        effects = active_rule_effects(hand, Rules(king_queen=True))
        self.assertIn("King-Queen column 1: 5 (-5)", effects)
        self.assertIn("King-Queen column 2: 15 (+5)", effects)

    def test_visible_effect_total_applies_only_proven_divisions(self):
        game = GolfGame(1, Rules(roman_fives=True))
        hand = [Slot(c, True) for c in cards([6, 8, 3, 5, 1, 13])]
        game.players[0] = hand
        self.assertEqual(visible_effect_total(hand, game.rules), game.score(0))
        hand[4].visible = False
        self.assertEqual(visible_effect_total(hand, game.rules), game.score(0, True))

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
