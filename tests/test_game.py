import unittest
from itertools import product
from game import Card, GolfGame, Rules, Slot


def place_cards(game, player, placements):
    """Arrange real cards by exchanging positions, preserving the full deck."""
    for index, desired in placements.items():
        outgoing = game.players[player][index].card
        found = False
        for layout in game.players:
            for slot in layout:
                if slot.card == desired:
                    slot.card = outgoing
                    found = True
                    break
            if found:
                break
        if not found:
            for pile in (game.draw_pile, game.discard_pile):
                if desired in pile:
                    pile[pile.index(desired)] = outgoing
                    found = True
                    break
        assert found, desired
        game.players[player][index].card = desired


class GolfTests(unittest.TestCase):
    def start(self, seed=1, rules=None):
        game = GolfGame(seed, rules)
        game.reveal(0)
        game.reveal(1)
        return game

    def assert_conservation(self, game):
        cards = game.draw_pile + game.discard_pile + [slot.card for hand in game.players for slot in hand]
        if game.held_card is not None:
            cards.append(game.held_card)
        self.assertEqual(len(cards), 52)
        self.assertEqual(len(set(cards)), 52)

    def prepare_pair(self, rank=12, rules=None):
        game = self.start(rules=rules or Rules(queen_swap=True, jack_swap=True))
        place_cards(game, 0, {0: Card(rank, "H"), 3: Card(rank, "S")})
        game.players[0][3].visible = True
        return game

    def test_opening_and_rules_configuration(self):
        rules = Rules()
        game = GolfGame(4, rules)
        self.assertEqual(len(game.draw_pile), 39)
        self.assertEqual(game.visible_count(0), 0)
        game.set_rule("queen_swap", True)
        self.assertFalse(rules.queen_swap)
        for action in (game.draw, game.end_turn, game.discard, lambda: game.swap(0)):
            with self.assertRaises(ValueError):
                action()
        game.reveal(5)
        game.reveal(2)
        self.assertEqual(game.visible_count(1), 2)
        self.assertEqual(game.phase, "choose")
        with self.assertRaises(ValueError):
            game.set_rule("queen_swap", False)
        self.assert_conservation(game)

    def test_flip_then_end(self):
        game = self.start()
        before = len(game.draw_pile)
        game.reveal(3)
        game.end_turn()
        self.assertEqual(game.current, 1)
        self.assertEqual(game.visible_count(0), 3)
        self.assertEqual(len(game.draw_pile), before)

    def test_flip_then_discard_swap_restricts_target(self):
        game = self.start()
        top = game.discard_pile[-1]
        old = game.players[0][3].card
        game.reveal(3)
        self.assertEqual(game.targets(), [3])
        with self.assertRaises(ValueError):
            game.swap(0)
        game.swap(3)
        self.assertEqual(game.players[0][3], Slot(top, True))
        self.assertEqual(game.discard_pile[-1], old)
        self.assert_conservation(game)

    def test_initial_discard_swap_accepts_hidden_or_visible_target(self):
        for index in (0, 4):
            game = self.start()
            top = game.discard_pile[-1]
            old = game.players[0][index].card
            game.swap(index)
            self.assertEqual(game.players[0][index], Slot(top, True))
            self.assertEqual(game.discard_pile[-1], old)
            self.assertEqual(game.turns, 1)
            self.assert_conservation(game)

    def test_flip_then_draw_keep_or_discard(self):
        for keep in (False, True):
            game = self.start()
            game.reveal(4)
            own = game.players[0][4].card
            drawn = game.draw_pile[-1]
            game.draw()
            self.assertEqual(game.phase, "drawn_revealed")
            self.assertEqual(game.targets(), [4])
            if keep:
                game.swap(4)
                self.assertEqual(game.players[0][4].card, drawn)
                self.assertEqual(game.discard_pile[-1], own)
            else:
                game.discard()
                self.assertEqual(game.players[0][4], Slot(own, True))
                self.assertEqual(game.discard_pile[-1], drawn)
            self.assert_conservation(game)

    def test_draw_first_can_immediately_swap_any_own_card(self):
        for index in (0, 5):
            game = self.start()
            drawn, old = game.draw_pile[-1], game.players[0][index].card
            game.draw()
            self.assertEqual(game.current, 0)
            self.assertEqual(game.turns, 0)
            self.assert_conservation(game)
            with self.assertRaises(ValueError):
                game.draw()
            game.swap(index)
            self.assertEqual(game.players[0][index], Slot(drawn, True))
            self.assertEqual(game.discard_pile[-1], old)
            self.assertIsNone(game.held_card)
            self.assert_conservation(game)

    def test_draw_then_flip_keep_or_discard(self):
        for keep in (False, True):
            game = self.start()
            own = game.players[0][5].card
            game.draw()
            drawn, size = game.held_card, len(game.draw_pile)
            game.reveal(5)
            self.assertEqual(game.targets(), [5])
            with self.assertRaises(ValueError):
                game.swap(0)
            with self.assertRaises(ValueError):
                game.end_turn()
            if keep:
                game.swap(5)
                self.assertEqual(game.players[0][5].card, drawn)
                self.assertEqual(game.discard_pile[-1], own)
            else:
                game.discard()
                self.assertEqual(game.players[0][5], Slot(own, True))
                self.assertEqual(game.discard_pile[-1], drawn)
            self.assertEqual(len(game.draw_pile), size)
            self.assert_conservation(game)

    def test_draw_first_discard_ends_turn_and_preserves_layout(self):
        game = self.start()
        before = [(slot.card, slot.visible) for slot in game.players[0]]
        size = len(game.draw_pile)
        drawn = game.draw_pile[-1]
        with self.assertRaises(ValueError):
            game.discard()
        game.draw()
        game.discard()
        self.assertEqual([(slot.card, slot.visible) for slot in game.players[0]], before)
        self.assertEqual(game.discard_pile[-1], drawn)
        self.assertEqual(len(game.draw_pile), size - 1)
        self.assertIsNone(game.held_card)
        self.assertEqual(game.turns, 1)
        self.assertEqual(game.current, 1)
        self.assertEqual(game.phase, "choose")
        self.assert_conservation(game)

    def test_draw_first_discard_still_resolves_bonus_and_final_turn(self):
        game = self.prepare_pair()
        game.draw()
        game.discard()
        self.assertEqual(game.phase, "bonus")
        self.assertEqual(game.current, 0)
        game.bonus_swap(("draw", None), ("discard", None))
        self.assertEqual(game.current, 1)
        self.assertEqual(game.turns, 1)
        self.assert_conservation(game)
        game = self.start()
        game.current, game.final_player, game.finisher, game.is_final_turn = 0, 0, 1, True
        game.draw()
        game.discard()
        self.assertEqual(game.phase, "over")
        self.assertEqual(game.visible_count(0), 6)
        self.assertEqual(game.visible_count(1), 6)
        self.assert_conservation(game)

    def test_rank_matching_negative_twos_and_visible_subtotals(self):
        game = GolfGame(1)
        game.players[0] = [Slot(Card(r, s), True) for r, s in [(2, "H"), (11, "H"), (9, "H"), (2, "S"), (12, "S"), (9, "S")]]
        self.assertEqual(game.score(0), 20)
        game.players[0][3] = Slot(Card(13, "S"), True)
        self.assertEqual(game.score(0), 18)
        game.players[0][5].visible = False
        self.assertEqual(game.score(0, True), 27)
        self.assertEqual(game.score(0), 18)

    def test_final_turn_waits_for_action(self):
        game = self.start()
        for slot in game.players[0][:5]:
            slot.visible = True
        game.reveal(5)
        self.assertEqual(game.final_player, 1)
        self.assertEqual(game.turns, 0)
        self.assertEqual(game.phase, "revealed")
        game.end_turn()
        game.opponent_turn()
        self.assertEqual(game.phase, "over")
        self.assertEqual(game.turns, 2)
        self.assertEqual(game.visible_count(1), 6)
        self.assert_conservation(game)

    def test_empty_draw_pile_refill(self):
        game = self.start()
        game.discard_pile = game.draw_pile + game.discard_pile
        game.draw_pile = []
        top = game.discard_pile[-1]
        game.draw()
        self.assertEqual(game.discard_pile, [top])
        self.assertEqual(len(game.draw_pile), 38)
        self.assert_conservation(game)

    def test_queen_and_jack_toggles_are_independent(self):
        for rank, enabled in product((11, 12), (False, True)):
            rule = Rules(queen_swap=enabled) if rank == 12 else Rules(jack_swap=enabled)
            game = self.prepare_pair(rank, rule)
            game.reveal(2)
            game.end_turn()
            self.assertEqual(game.phase == "bonus", enabled)
            if enabled:
                self.assertEqual(game.current, 0)
                self.assertEqual(game.turns, 0)
            self.assert_conservation(game)
        for rank, rule in ((11, Rules(queen_swap=True)), (12, Rules(jack_swap=True))):
            game = self.prepare_pair(rank, rule)
            game.reveal(2)
            game.end_turn()
            self.assertEqual(game.current, 1)

    def test_hidden_pair_does_not_trigger(self):
        game = self.prepare_pair()
        game.players[0][3].visible = False
        game.reveal(2)
        game.end_turn()
        self.assertNotEqual(game.phase, "bonus")

    def test_bonus_swaps_opponent_and_piles_without_peeking(self):
        pairs = [((0, 1), (1, 5)), (("draw", None), (1, 5)), (("discard", None), (1, 5)), (("draw", None), ("discard", None))]
        for first, second in pairs:
            game = self.prepare_pair()
            game.reveal(2)
            game.end_turn()
            a, b = game.table_slot(first), game.table_slot(second)
            game.bonus_swap(first, second)
            self.assertEqual(game.table_slot(first).card, b.card)
            self.assertEqual(game.table_slot(second).card, a.card)
            if isinstance(first[0], int):
                self.assertEqual(game.table_slot(first).visible, b.visible)
            if isinstance(second[0], int):
                self.assertEqual(game.table_slot(second).visible, a.visible)
            self.assertEqual(game.current, 1)
            self.assert_conservation(game)

    def test_same_pair_cannot_farm_repeated_bonus(self):
        game = self.prepare_pair()
        game.reveal(2)
        game.end_turn()
        game.bonus_swap((0, 1), (1, 1))
        game.opponent_turn()
        game.reveal(4)
        game.end_turn()
        self.assertEqual(game.current, 1)
        self.assertNotEqual(game.phase, "bonus")

    def test_bonus_does_not_cancel_final_turn(self):
        game = self.prepare_pair()
        for slot in game.players[0]:
            slot.visible = True
        game.draw()
        game.swap(2)
        self.assertEqual(game.phase, "bonus")
        hidden = next(i for i, slot in enumerate(game.players[1]) if not slot.visible)
        game.bonus_swap((0, 1), (1, hidden))
        self.assertEqual(game.visible_count(0), 5)
        self.assertEqual(game.final_player, 1)
        game.opponent_turn()
        while game.phase == "bonus":
            game.opponent_turn()
        self.assertEqual(game.phase, "over")
        self.assert_conservation(game)

    def test_multiple_pairs_queue_separate_bonus_swaps(self):
        game = self.prepare_pair()
        place_cards(game, 0, {1: Card(11, "H"), 4: Card(11, "S")})
        game.players[0][4].visible = True
        game.reveal(2)
        game.end_turn()
        self.assertEqual(game.bonus_remaining, 2)
        game.bonus_swap((0, 2), (1, 0))
        self.assertEqual(game.phase, "bonus")
        self.assertEqual(game.bonus_remaining, 1)
        game.bonus_swap((0, 2), (1, 0))
        self.assertEqual(game.current, 1)
        self.assert_conservation(game)

    def test_bonus_revealing_opponents_last_card_schedules_own_final_turn(self):
        game = self.prepare_pair()
        for slot in game.players[1][:5]:
            slot.visible = True
        game.players[1][5].visible = False
        game.reveal(2)
        game.end_turn()
        game.bonus_swap((0, 1), (1, 5))
        self.assertEqual(game.finisher, 1)
        self.assertEqual(game.final_player, 0)
        self.assertEqual(game.current, 0)
        self.assertEqual(game.phase, "choose")
        self.assertTrue(game.is_final_turn)
        self.assertEqual(game.turns, 1)
        game.reveal(4)
        game.end_turn()
        self.assertEqual(game.phase, "over")
        self.assertEqual(game.turns, 2)
        self.assert_conservation(game)

    def test_666_locks_only_revealed_row_and_bonus_overrides(self):
        game = self.prepare_pair(rules=Rules(queen_swap=True, devils_row=True))
        place_cards(game, 1, {0: Card(6, "H"), 1: Card(6, "S"), 2: Card(6, "D")})
        for slot in game.players[1][:3]:
            slot.visible = True
        game.reveal(2)
        self.assertEqual(len(game.locked_cards), 3)
        game.end_turn()
        six = game.players[1][0].card
        game.bonus_swap((1, 0), (0, 1))
        self.assertEqual(game.players[0][1].card, six)
        self.assertIn(six, game.locked_cards)
        game.opponent_turn()
        self.assertNotIn(1, game.targets())
        with self.assertRaises(ValueError):
            game.swap(1)
        self.assert_conservation(game)

    def test_777_earned_once_persists_and_rounds_up(self):
        game = self.start(rules=Rules(gamblers_row=True))
        place_cards(game, 0, {0: Card(7, "H"), 1: Card(7, "S"), 2: Card(7, "D"), 3: Card(13, "H"), 4: Card(13, "S"), 5: Card(13, "D")})
        self.assertFalse(game.gambler_earned[0])
        game.reveal(2)
        self.assertTrue(game.gambler_earned[0])
        self.assertEqual(game.score(0), 3)
        self.assertEqual(game.score(0, True), 21)
        game.draw()
        game.swap(2)
        self.assertTrue(game.gambler_earned[0])
        self.assertEqual(game.score(0), (game.score(0, True) + 6) // 7)

    def test_king_queen_color_scores_and_disabled_baseline(self):
        game = GolfGame(1, Rules(king_queen=True))
        game.players[0] = [Slot(Card(r, s), True) for r, s in [(13, "H"), (13, "S"), (2, "H"), (12, "D"), (12, "D"), (2, "S")]]
        self.assertEqual(game.score(0), 20)
        game.rules.king_queen = False
        self.assertEqual(game.score(0), 20)
        game.players[0][4].card = Card(12, "C")
        game.rules.king_queen = True
        self.assertEqual(game.score(0), 10)

    def test_five_hundred_rounds_with_rules_and_every_path(self):
        for seed in range(500):
            game = self.start(seed, Rules(**{key: bool(seed & (1 << i)) for i, key in enumerate(Rules.__dataclass_fields__)}))
            for step in range(100):
                if game.phase == "over":
                    break
                if game.current == 1:
                    game.opponent_turn()
                elif game.phase == "bonus":
                    game.bonus_swap(*game.rng.sample(game.table_refs(), 2))
                else:
                    hidden = [i for i, slot in enumerate(game.players[0]) if not slot.visible]
                    path = game.rng.randrange(3)
                    if path == 0 and hidden:
                        game.reveal(game.rng.choice(hidden))
                        if game.rng.randrange(2):
                            game.end_turn()
                        else:
                            game.draw()
                            if game.targets() and game.rng.randrange(2):
                                game.swap(game.targets()[0])
                            else:
                                game.discard()
                    elif path == 1 or not game.targets():
                        game.draw()
                        if hidden and game.rng.randrange(2):
                            game.reveal(game.rng.choice(hidden))
                            if game.targets() and game.rng.randrange(2):
                                game.swap(game.targets()[0])
                            else:
                                game.discard()
                        else:
                            game.swap(game.rng.choice(game.targets()))
                    else:
                        game.swap(game.rng.choice(game.targets()))
                self.assert_conservation(game)
            self.assertEqual(game.phase, "over", f"seed {seed}, phase {game.phase}")
            self.assertEqual(game.visible_count(0), 6)
            self.assertEqual(game.visible_count(1), 6)


if __name__ == "__main__":
    unittest.main()
