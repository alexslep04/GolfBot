import unittest

from game import Card, GolfGame, Rules, Slot
from scoring import modifier_instance_counts, modifier_data


def layout(ranks, suits="SHDCSH", visible=True):
    return [Slot(Card(rank, suit, i), visible) for i, (rank, suit) in enumerate(zip(ranks, suits))]


class ModifierCountTests(unittest.TestCase):
    def test_each_king_queen_column_is_an_instance(self):
        hand = layout([13, 12, 13, 12, 13, 12])
        self.assertEqual(modifier_instance_counts(hand, Rules(king_queen=True)), {"king_queen": 3})
        hand[4].visible = False
        self.assertEqual(modifier_instance_counts(hand, Rules(king_queen=True)), {"king_queen": 2})
        self.assertEqual(modifier_instance_counts(hand, Rules(king_queen=True), visible_only=False), {"king_queen": 3})

    def test_rows_stack_but_holdem_and_color_do_not(self):
        hand = layout([3, 4, 5, 8, 9, 10], "HHHHHH")
        rules = Rules(tricky_straights=True, suited_rows=True, holdem=True, all_in_color=True)
        self.assertEqual(modifier_instance_counts(hand, rules),
                         {"tricky_straights": 2, "suited_rows": 2, "holdem": 1, "all_in_color": 1})

    def test_two_qualifying_vs_are_one_nonstacking_effect(self):
        hand = layout([3, 4, 3, 3, 4, 3])
        self.assertEqual(modifier_instance_counts(hand, Rules(roman_fives=True)), {"roman_fives": 1})
        hand = layout([10, 11, 12, 10, 11, 12])
        self.assertEqual(modifier_instance_counts(hand, Rules(v10=True)), {"v10": 1})

    def test_ripped_five_needs_another_uncancelled_five(self):
        rules = Rules(ripped_five=True)
        self.assertEqual(modifier_instance_counts(layout([5, 3, 8, 4, 5, 9], "DSHCHS"), rules), {"ripped_five": 1})
        # its only partner already canceled with it in the column: nothing left to rip
        self.assertEqual(modifier_instance_counts(layout([5, 3, 8, 5, 4, 9], "DSHCHS"), rules), {})
        # a column pair, plus another 5 in the opposite row: that one is ripped
        self.assertEqual(modifier_instance_counts(layout([5, 3, 8, 5, 4, 5], "DSHCHS"), rules), {"ripped_five": 1})
        # but not one in its own row
        self.assertEqual(modifier_instance_counts(layout([5, 5, 8, 5, 4, 9], "DSHCHS"), rules), {})

    def test_earned_effects_count_once_each_and_respect_enabled_rules(self):
        hand = layout([6, 6, 6, 6, 6, 6])
        flags = dict(angels_earned={6, 7, 9}, poisoned=True)
        rules = Rules(angel_numbers=True, poisoned_card=True)
        self.assertEqual(modifier_instance_counts(hand, rules, **flags),
                         {"angel_numbers": 3, "poisoned_card": 1})
        self.assertEqual(modifier_instance_counts(hand, Rules(), **flags), {})

    def test_public_counts_never_expose_hidden_patterns(self):
        hand = layout([3, 4, 5, 8, 9, 10], "HHHHHH", visible=False)
        rules = Rules(tricky_straights=True, suited_rows=True, holdem=True, all_in_color=True)
        self.assertEqual(modifier_instance_counts(hand, rules), {})

    def test_counts_belong_to_causer_even_with_many_recipients(self):
        game = GolfGame(player_count=3, multiplayer=True,
                        rules=Rules(tricky_straights=True, suited_rows=True, all_in_color=True, angel_numbers=True))
        game.players = [layout([3, 4, 5, 8, 9, 10], "HHHHHH"),
                        layout([1, 4, 8, 10, 6, 3]), layout([1, 4, 8, 10, 6, 3])]
        game.angels_earned[0] = {9}
        game.activated_rules[0].add("royal_pairs")
        data = modifier_data(game)
        self.assertEqual(data["modifier_counts"],
                         [{"tricky_straights": 2, "suited_rows": 2, "all_in_color": 1, "angel_numbers": 1}, {}, {}])
        self.assertEqual(data["activations"][0], ["all_in_color", "angel_numbers", "royal_pairs", "suited_rows", "tricky_straights"])
        self.assertEqual(game.activated_rules[0], {"royal_pairs"})

    def test_parts_of_each_rule_are_recorded_with_the_rule(self):
        rules = Rules(tricky_straights=True, suited_rows=True, holdem=True, all_in_color=True,
                      king_queen=True, angel_numbers=True, royal_pairs=True)
        game = GolfGame(rules=rules)
        # an ascending heart row and a descending diamond row: two straights, two red
        # suited rows, all red, and a five-card straight; the other hand has a King-Queen column
        game.players = [layout([3, 4, 5, 8, 7, 6], "HHHDDD"), layout([13, 13, 1, 12, 12, 4], "SHCDSC")]
        game.angels_earned[0] = {7}
        game.activated_subrules[1].add("royal_pairs:queens")
        parts = modifier_data(game, visible_only=False)["subrule_activations"]
        self.assertEqual(parts[0], ["all_in_color:red", "angel_numbers:777", "holdem:straight",
                                    "suited_rows:red", "tricky_straights:down", "tricky_straights:up"])
        # K♠ over Q♦ differs in color; and the bonus swap is kept as it happened
        self.assertEqual(parts[1], ["king_queen:mixed", "royal_pairs:queens"])
        # a face-up row of three earns its Angel number, part and all
        game.players[0] = layout([9, 9, 9, 2, 3, 4], "SHDCSH")
        game._update_combos()
        self.assertIn("angel_numbers:999", game.activated_subrules[0])

    def test_final_counts_do_not_reuse_cumulative_activation_keys(self):
        game = GolfGame(rules=Rules(king_queen=True, angel_numbers=True, poisoned_card=True))
        game.players = [layout([1, 4, 8, 10, 6, 3]), layout([1, 4, 8, 10, 6, 3])]
        game.activated_rules[0].add("king_queen")
        game.angels_earned[0] = {7}
        game.finisher = 1
        self.assertEqual(modifier_data(game, visible_only=False)["modifier_counts"],
                         [{"angel_numbers": 1}, {"poisoned_card": 1}])
