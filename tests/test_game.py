import unittest
from game import Card, GolfGame, Slot


class GolfTests(unittest.TestCase):
    def start(self, seed=1):
        game = GolfGame(seed)
        game.reveal(0)
        game.reveal(1)
        return game

    def assert_conservation(self, game):
        cards = game.draw_pile + game.discard_pile + [slot.card for hand in game.players for slot in hand]
        if game.held_card is not None:
            cards.append(game.held_card)
        self.assertEqual(len(cards), 52)
        self.assertEqual(len(set(cards)), 52)

    def test_deal_and_opening(self):
        game = GolfGame(4)
        self.assertEqual(len(game.draw_pile), 39)
        self.assertEqual(game.visible_count(0), 0)
        self.assertEqual(game.visible_count(1), 0)
        game.reveal(5)
        self.assertEqual(game.phase, "setup")
        with self.assertRaises(ValueError):
            game.skip_flip()
        game.reveal(2)
        self.assertEqual(game.phase, "choose")
        self.assertEqual(game.visible_count(1), 2)
        self.assertEqual(game.current, 0)
        self.assert_conservation(game)

    def test_flip_restricts_swap_to_new_card(self):
        game = self.start()
        game.reveal(3)
        self.assertEqual(game.targets(), [3])
        with self.assertRaises(ValueError):
            game.swap(0, "discard")
        incoming, outgoing = game.discard_pile[-1], game.players[0][3].card
        game.swap(3, "discard")
        self.assertEqual(game.players[0][3].card, incoming)
        self.assertEqual(game.discard_pile[-1], outgoing)
        self.assertEqual(game.current, 1)
        self.assert_conservation(game)

    def test_skip_only_allows_visible_targets(self):
        game = self.start()
        game.skip_flip()
        self.assertEqual(game.targets(), [0, 1])
        with self.assertRaises(ValueError):
            game.swap(4, "draw")
        incoming, outgoing = game.draw_pile[-1], game.players[0][1].card
        game.swap(1, "draw")
        self.assertEqual(game.players[0][1], Slot(incoming, True))
        self.assertEqual(game.discard_pile[-1], outgoing)
        self.assert_conservation(game)

    def test_draw_discard_keeps_layout(self):
        game = self.start()
        with self.assertRaises(ValueError):
            game.draw_discard()
        game.skip_flip()
        before = [(s.card, s.visible) for s in game.players[0]]
        top = game.draw_pile[-1]
        game.draw_discard()
        self.assertEqual(before, [(s.card, s.visible) for s in game.players[0]])
        self.assertEqual(game.discard_pile[-1], top)
        self.assert_conservation(game)

    def test_draw_first_holds_one_card_until_decision(self):
        game = GolfGame(1)
        with self.assertRaises(ValueError):
            game.draw_first()
        game.reveal(0)
        game.reveal(1)
        top = game.draw_pile[-1]
        before = [(s.card, s.visible) for s in game.players[0]]
        game.draw_first()
        self.assertEqual(game.held_card, top)
        self.assertEqual(game.phase, "drawn")
        self.assertEqual(game.turns, 0)
        self.assertEqual(game.current, 0)
        self.assertEqual(before, [(s.card, s.visible) for s in game.players[0]])
        self.assert_conservation(game)
        for action in (game.draw_first, game.skip_flip, game.draw_discard, lambda: game.reveal(2), lambda: game.swap(0, "discard")):
            with self.assertRaises(ValueError):
                action()
        self.assertEqual(game.held_card, top)
        self.assert_conservation(game)

    def test_drawn_card_can_replace_hidden_or_visible_card(self):
        for target in (0, 4):
            game = self.start()
            incoming, outgoing = game.draw_pile[-1], game.players[0][target].card
            game.draw_first()
            game.swap(target, "held")
            self.assertEqual(game.players[0][target], Slot(incoming, True))
            self.assertEqual(game.discard_pile[-1], outgoing)
            self.assertIsNone(game.held_card)
            self.assertEqual(game.current, 1)
            self.assertEqual(game.turns, 1)
            self.assert_conservation(game)

    def test_discard_drawn_does_not_draw_a_second_card(self):
        game = self.start()
        before = [(s.card, s.visible) for s in game.players[0]]
        game.draw_first()
        drawn = game.held_card
        deck_size = len(game.draw_pile)
        game.discard_drawn()
        self.assertEqual(len(game.draw_pile), deck_size)
        self.assertEqual(game.discard_pile[-1], drawn)
        self.assertEqual(before, [(s.card, s.visible) for s in game.players[0]])
        self.assertIsNone(game.held_card)
        self.assertEqual(game.turns, 1)
        self.assert_conservation(game)

    def test_drawn_card_replacement_can_start_final_turn(self):
        game = self.start()
        for slot in game.players[0][:5]:
            slot.visible = True
        game.draw_first()
        self.assertIsNone(game.finisher)
        game.swap(5, "held")
        self.assertEqual(game.final_player, 1)
        game.opponent_turn()
        self.assertEqual(game.phase, "over")
        self.assert_conservation(game)

    def test_rank_matching_and_negative_twos(self):
        game = GolfGame(1)
        game.players[0] = [Slot(Card(r, s), True) for r, s in [(2, "H"), (11, "H"), (9, "H"), (2, "S"), (12, "S"), (9, "S")]]
        self.assertEqual(game.score(0), 20)  # JJ/Q are distinct; both 2s and both 9s cancel.
        game.players[0][3] = Slot(Card(13, "S"), True)
        self.assertEqual(game.score(0), 18)

    def test_visible_subtotal_does_not_inspect_hidden_partner(self):
        game = GolfGame(1)
        game.players[0] = [Slot(Card(13, "H"), True) for _ in range(6)]
        game.players[0][0] = Slot(Card(9, "H"), True)
        game.players[0][3] = Slot(Card(9, "S"), False)
        self.assertEqual(game.score(0, visible_only=True), 9)
        self.assertEqual(game.score(0), 0)

    def test_last_reveal_waits_for_action_and_one_final_turn(self):
        game = self.start()
        for i in range(5):
            game.players[0][i].visible = True
        game.reveal(5)
        self.assertIsNone(game.finisher)
        self.assertEqual(game.phase, "act")
        game.draw_discard()
        self.assertEqual(game.final_player, 1)
        game.opponent_turn()
        self.assertEqual(game.phase, "over")
        self.assertEqual(game.turns, 2)
        self.assertEqual(game.visible_count(0), 6)
        self.assertEqual(game.visible_count(1), 6)
        self.assert_conservation(game)

    def test_empty_deck_preserves_discard_top(self):
        game = self.start()
        game.discard_pile = game.draw_pile + game.discard_pile
        game.draw_pile = []
        top = game.discard_pile[-1]
        game.skip_flip()
        game.swap(0, "draw")
        self.assertEqual(game.discard_pile[0], top)
        self.assertEqual(len(game.draw_pile), 38)
        self.assert_conservation(game)

    def test_two_hundred_complete_rounds(self):
        for seed in range(200):
            game = self.start(seed)
            while game.phase != "over":
                if game.current == 1:
                    game.opponent_turn()
                else:
                    if game.rng.randrange(3) == 0:
                        game.draw_first()
                        self.assert_conservation(game)
                        if game.rng.randrange(2):
                            game.discard_drawn()
                        else:
                            game.swap(game.rng.randrange(6), "held")
                        self.assert_conservation(game)
                        continue
                    hidden = [i for i, slot in enumerate(game.players[0]) if not slot.visible]
                    if hidden:
                        game.reveal(game.rng.choice(hidden))
                    else:
                        game.skip_flip()
                    action = game.rng.randrange(3)
                    if action == 0:
                        game.draw_discard()
                    else:
                        game.swap(game.rng.choice(game.targets()), "draw" if action == 1 else "discard")
                self.assert_conservation(game)
                self.assertLessEqual(game.turns, 10)
            self.assertEqual(game.visible_count(0), 6)
            self.assertEqual(game.visible_count(1), 6)


if __name__ == "__main__":
    unittest.main()
