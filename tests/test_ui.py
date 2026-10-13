"""Exercise actual Pygame mouse handling with a headless SDL display."""
import os
os.environ["SDL_VIDEODRIVER"] = "dummy"
os.environ["SDL_AUDIODRIVER"] = "dummy"
os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = "1"

import itertools
import unittest
from unittest.mock import patch
import pygame
from game import Card, GolfGame, Rules, run
from ui import GolfUI
from test_game import place_cards


class MouseFlowTests(unittest.TestCase):
    def setUp(self):
        self.engine = GolfGame(seed=42)
        self.app = GolfUI(self.engine)

    def tearDown(self):
        pygame.quit()

    def card(self, player, index):
        self.app.click(self.app.cards[(player, index)].center)

    def press(self, name):
        self.app.click(self.app.buttons[name].center)

    def opening(self):
        for index in (0, 1):
            self.card(0, index)
            self.press("Flip")

    def test_four_actions_and_selection_toggle(self):
        self.assertEqual(list(self.app.buttons), ["Flip", "Swap", "Draw", "Discard"])
        self.card(1, 0)
        self.press("Flip")
        self.assertEqual(self.engine.visible_count(1), 0)
        self.card(0, 0)
        self.card(0, 0)
        self.press("Flip")
        self.assertEqual(self.engine.visible_count(0), 0)
        self.assertFalse(self.app.available("Draw"))

    def test_rules_checkboxes_and_new_game_persistence(self):
        self.app.click(self.app.rule_rects["queen_swap"].center)
        self.assertTrue(self.engine.rules.queen_swap)
        self.assertFalse(self.engine.rules.jack_swap)
        self.opening()
        self.app.click(self.app.rule_rects["queen_swap"].center)
        self.assertTrue(self.engine.rules.queen_swap)
        self.app.click(self.app.new_rect.center)
        self.assertEqual(self.app.game.phase, "setup")
        self.assertTrue(self.app.game.rules.queen_swap)
        self.app.click(self.app.rule_rects["queen_swap"].center)
        self.assertFalse(self.app.game.rules.queen_swap)

    def test_direct_discard_swap_with_hidden_card(self):
        self.opening()
        top = self.engine.discard_pile[-1]
        self.card(0, 5)
        self.press("Swap")
        self.assertEqual(self.engine.players[0][5].card, top)
        self.assertTrue(self.engine.players[0][5].visible)
        self.assertEqual(self.engine.current, 1)

    def test_draw_then_flip_then_discard_through_mouse(self):
        self.opening()
        self.app.click(self.app.deck_rect.center)
        self.app.click(self.app.deck_rect.center)
        self.press("Flip")
        self.assertIsNone(self.engine.held_card)
        self.press("Draw")
        held, size = self.engine.held_card, len(self.engine.draw_pile)
        self.press("Discard")
        self.assertEqual(self.engine.phase, "drawn")
        self.card(0, 4)
        self.press("Flip")
        self.assertFalse(self.app.available("End turn"))
        self.press("Discard")
        self.assertEqual(self.engine.discard_pile[-1], held)
        self.assertEqual(len(self.engine.draw_pile), size)
        self.assertTrue(self.engine.players[0][4].visible)
        self.assertEqual(self.engine.current, 1)

    def test_flip_draw_swap_targets_only_newly_revealed_card(self):
        self.opening()
        self.card(0, 4)
        self.press("Flip")
        self.press("Draw")
        held = self.engine.held_card
        self.card(0, 0)
        self.press("Swap")
        self.assertEqual(self.engine.phase, "drawn_revealed")
        self.card(0, 4)
        self.press("Swap")
        self.assertEqual(self.engine.players[0][4].card, held)
        self.assertEqual(self.engine.current, 1)

    def test_end_turn_control_after_flip(self):
        self.opening()
        self.card(0, 2)
        self.press("Flip")
        self.assertTrue(self.app.available("End turn"))
        self.app.click(self.app.end_rect.center)
        self.assertEqual(self.engine.current, 1)
        self.assertEqual(self.engine.turns, 1)

    def test_bonus_requires_two_selections_and_can_target_piles(self):
        self.engine.set_rule("queen_swap", True)
        self.opening()
        place_cards(self.engine, 0, {0: Card(12, "H"), 3: Card(12, "S")})
        self.engine.players[0][3].visible = True
        self.card(0, 2)
        self.press("Flip")
        self.app.click(self.app.end_rect.center)
        self.assertEqual(self.engine.phase, "bonus")
        first, second = self.engine.draw_pile[-1], self.engine.discard_pile[-1]
        self.app.click(self.app.deck_rect.center)
        self.press("Swap")
        self.assertEqual(self.engine.phase, "bonus")
        self.app.click(self.app.discard_rect.center)
        self.assertEqual(len(self.app.selected), 2)
        self.app.click(self.app.discard_rect.center)
        self.assertEqual(len(self.app.selected), 1)
        self.app.click(self.app.discard_rect.center)
        self.press("Swap")
        self.assertEqual(self.engine.draw_pile[-1], second)
        self.assertEqual(self.engine.discard_pile[-1], first)
        self.assertEqual(self.engine.current, 1)

    def test_actual_event_loop_complete_round_and_enter(self):
        # A complete game via posted mouse events and the contextual Enter shortcut.
        engine = GolfGame(seed=12)
        def click(x, y):
            return [pygame.event.Event(pygame.MOUSEBUTTONDOWN, button=1, pos=(x, y))]
        frames = [click(395, 490), click(150, 768), click(503, 490), click(150, 768)]
        for x, y in ((611, 490), (395, 620), (503, 620), (611, 620)):
            frames += [click(x, y), click(150, 768), [pygame.event.Event(pygame.KEYDOWN, key=pygame.K_RETURN)], [], []]
        frames += [[pygame.event.Event(pygame.QUIT)]]
        events, ticks = iter(frames), itertools.count(0, 2000)
        with patch.object(pygame.event, "get", side_effect=lambda: next(events)), \
             patch.object(pygame.time, "get_ticks", side_effect=lambda: next(ticks)):
            run(engine=engine)
        self.assertEqual(engine.phase, "over")
        self.assertEqual(engine.turns, 8)
        self.assertEqual(engine.visible_count(0), 6)
        self.assertEqual(engine.visible_count(1), 6)


if __name__ == "__main__":
    unittest.main()
