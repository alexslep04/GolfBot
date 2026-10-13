"""Exercise actual Pygame mouse handling with a headless SDL display."""
import os
os.environ["SDL_VIDEODRIVER"] = "dummy"
os.environ["SDL_AUDIODRIVER"] = "dummy"
os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = "1"

import itertools
import unittest
from unittest.mock import patch
import pygame
from game import Card, GolfGame, Rules, Slot, run
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

    def test_resize_preserves_card_clicks_and_aspect_ratio(self):
        for size in ((540, 425), (1400, 900), (800, 1000)):
            self.app.window = pygame.display.set_mode(size, pygame.RESIZABLE)
            viewport = self.app.viewport()
            self.assertLessEqual(abs(viewport.width / viewport.height - 1080 / 850), .005)
            x, y = self.app.cards[(0, 0)].center
            position = (viewport.x + x * viewport.width / 1080,
                        viewport.y + y * viewport.height / 850)
            self.app.click(self.app.table_position(position))
            self.assertIn((0, 0), self.app.selected)
            self.app.click(self.app.table_position(position))
            self.assertNotIn((0, 0), self.app.selected)
            self.app.render()

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
        self.assertEqual(self.engine.phase, "drawn")
        self.card(0, 4)
        self.press("Flip")
        self.assertFalse(self.app.available("End turn"))
        self.press("Discard")
        self.assertEqual(self.engine.discard_pile[-1], held)
        self.assertEqual(len(self.engine.draw_pile), size)
        self.assertTrue(self.engine.players[0][4].visible)
        self.assertEqual(self.engine.current, 1)

    def test_draw_first_discard_button_ends_turn_without_revealing_layout(self):
        self.opening()
        before = [(slot.card, slot.visible) for slot in self.engine.players[0]]
        self.press("Draw")
        held, size = self.engine.held_card, len(self.engine.draw_pile)
        self.assertTrue(self.app.available("Discard"))
        self.press("Discard")
        self.assertEqual(self.engine.discard_pile[-1], held)
        self.assertEqual(len(self.engine.draw_pile), size)
        self.assertEqual([(slot.card, slot.visible) for slot in self.engine.players[0]], before)
        self.assertEqual(self.engine.current, 1)
        self.assertEqual(self.engine.turns, 1)
        self.assertIsNone(self.engine.held_card)
        self.assertFalse(self.app.available("Discard"))

    def test_draw_first_swap_button_rejects_hidden_targets(self):
        self.opening()
        self.press("Draw")
        held = self.engine.held_card
        self.card(0, 5)
        self.assertFalse(self.app.available("Swap"))
        self.press("Swap")
        self.assertEqual(self.engine.held_card, held)
        self.press("Flip")
        self.assertTrue(self.app.available("Swap"))
        self.press("Swap")
        self.assertEqual(self.engine.players[0][5].card, held)

    def test_many_effects_are_clipped_and_scroll_outside_turn_prompt(self):
        self.engine.rules = Rules(holdem=True, king_queen=True, gamblers_row=True)
        self.engine.gambler_earned = [True, True]
        for player in range(2):
            self.engine.players[player] = [Slot(Card(rank, suit), True)
                for rank, suit in [(13, 'H'), (13, 'S'), (13, 'C'), (12, 'D'), (12, 'H'), (12, 'S')]
            ]
        self.assertFalse(self.app.effects_rect.colliderect(self.app.prompt_rect))
        self.assertTrue(all(not rect.colliderect(self.app.prompt_rect) for rect in self.app.buttons.values()))
        self.app.screen.fill(self.app.bg)
        before = pygame.image.tobytes(self.app.screen.subsurface(self.app.prompt_rect), "RGB")
        self.app.draw_effects()
        after = pygame.image.tobytes(self.app.screen.subsurface(self.app.prompt_rect), "RGB")
        self.assertEqual(before, after)
        self.assertGreater(len(self.app.effects_lines()) * 20, self.app.effects_rect.height)
        self.app.scroll_effects(-50)
        self.assertGreater(self.app.effects_scroll, 0)
        self.app.scroll_effects(50)
        self.assertEqual(self.app.effects_scroll, 0)

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

    def test_question_mark_hover_explains_each_rule_without_toggling(self):
        for key, rect in self.app.help_rects.items():
            self.assertEqual(self.app.tooltip_key(rect.center), key)
            self.assertIn(key, self.app.rule_help)
            self.app.click(rect.center)
            self.assertFalse(getattr(self.engine.rules, key))
        with patch.object(pygame.mouse, "get_pos", return_value=self.app.help_rects["holdem"].center), \
             patch.object(self.app, "draw_tooltip", wraps=self.app.draw_tooltip) as tooltip:
            self.app.render()
            tooltip.assert_called_once_with("holdem")

    def test_four_kind_popup_choice_rearranges_and_resumes_flip(self):
        self.engine.set_rule("four_kind", True)
        self.opening()
        place_cards(self.engine, 0, {0: Card(9, "S"), 1: Card(9, "H"), 2: Card(9, "D"), 4: Card(9, "C")})
        self.engine.players[0][2].visible = True
        self.card(0, 4)
        self.press("Flip")
        self.assertEqual(self.engine.phase, "arrange")
        self.assertFalse(self.app.available("Draw"))
        self.app.render()
        self.app.click(self.app.arrange_rects[(0, 2)].center)
        self.assertEqual(self.engine.phase, "revealed")
        self.assertEqual(self.engine.players[0][self.engine.flipped].card, Card(9, "C"))
        for index in (0, 3, 2, 5):
            self.assertEqual(self.engine.players[0][index].card.rank, 9)

    def test_beggars_rank_popup_and_highest_lowest_trade(self):
        self.engine.set_rule("beggars", True)
        self.opening()
        place_cards(self.engine, 0, {0: Card(12, "S"), 1: Card(11, "S")})
        place_cards(self.engine, 1, {0: Card(8, "H"), 1: Card(6, "H"), 4: Card(3, "H")})
        for index, slot in enumerate(self.engine.players[1]):
            slot.visible = index in (0, 1)
        self.engine.current = 1
        self.engine.reveal(4)
        self.assertEqual(self.engine.phase, "guess")
        self.assertFalse(self.engine.players[1][4].visible)
        self.app.render()
        self.app.click(self.app.guess_rects[3].center)
        self.assertEqual(self.engine.phase, "guess_trade")
        self.card(0, 1)
        self.card(1, 4)
        self.assertTrue(self.app.available("Swap"))
        self.press("Swap")
        self.assertEqual(self.engine.phase, "revealed")
        self.assertEqual(self.engine.players[0][1].card, Card(3, "H"))
        self.assertEqual(self.engine.players[1][4].card, Card(11, "S"))
        self.assertEqual(self.engine.current, 1)


if __name__ == "__main__":
    unittest.main()
