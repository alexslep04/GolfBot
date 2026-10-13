"""Exercise the actual mouse event loop with a headless SDL display."""
import os
os.environ["SDL_VIDEODRIVER"] = "dummy"
os.environ["SDL_AUDIODRIVER"] = "dummy"
os.environ["PYGAME_HIDE_SUPPORT_PROMPT"] = "1"

import itertools
import unittest
from unittest.mock import patch
import pygame
import game


class MouseFlowTests(unittest.TestCase):
    def test_draw_pile_selection_swap_and_discard(self):
        engine = game.GolfGame(seed=42)
        first_draw = engine.draw_pile[-1]
        replaced = engine.players[0][5].card

        def click(x, y):
            return [pygame.event.Event(pygame.MOUSEBUTTONDOWN, button=1, pos=(x, y))]

        frames = [
            click(100, 400), click(110, 768),  # Cannot draw during the opening reveal.
            click(395, 490), click(110, 768),
            click(503, 490), click(110, 768),
            click(100, 400), click(100, 400), click(110, 768),  # Unselected pile cannot draw.
            click(100, 400), click(110, 768),
            click(611, 620), click(629, 768), [], [],  # Swap drawn into hidden slot 5.
            click(100, 400), click(110, 768), click(800, 768), [], [],  # Discard held card.
            click(283, 768), click(800, 768), [], [],  # Old skip + draw/discard still works.
            [pygame.event.Event(pygame.QUIT)],
        ]
        events, ticks = iter(frames), itertools.count(0, 2000)
        snapshots = []
        original_flip = pygame.display.flip

        def record_frame():
            snapshots.append((engine.phase, engine.held_card, len(engine.draw_pile), engine.discard_pile[-1]))
            original_flip()

        with patch.object(game, "GolfGame", return_value=engine), \
             patch.object(pygame.event, "get", side_effect=lambda: next(events)), \
             patch.object(pygame.time, "get_ticks", side_effect=lambda: next(ticks)), \
             patch.object(pygame.display, "flip", side_effect=record_frame):
            game.run()
        self.assertEqual(snapshots[1][0], "setup")
        self.assertEqual(snapshots[8][0], "choose")
        self.assertEqual(snapshots[10][:2], ("drawn", first_draw))
        self.assertEqual(snapshots[12][3], replaced)
        self.assertEqual(engine.players[0][5], game.Slot(first_draw, True))
        self.assertEqual(snapshots[17][2], snapshots[16][2])  # Discard consumes no extra draw.
        self.assertEqual(snapshots[17][3], snapshots[16][1])
        self.assertEqual(engine.turns, 6)
        self.assertIsNone(engine.held_card)

    def test_play_complete_round_through_buttons(self):
        engine = game.GolfGame(seed=12)

        def click(x, y):
            return [pygame.event.Event(pygame.MOUSEBUTTONDOWN, button=1, pos=(x, y))]

        frames = [
            click(395, 155), click(110, 768),  # Opponent selection cannot flip.
            click(395, 490), click(395, 490), click(110, 768),  # Toggle off: flip disabled.
            click(395, 490), click(110, 768),
            click(503, 490), click(110, 768),  # Opening two reveals.
            click(611, 490), click(110, 768),  # Reveal third card.
            click(395, 490), click(456, 768),  # Wrong target: swap disabled.
            click(611, 490), click(456, 768), [], [],
        ]
        for x in (395, 503, 611):
            frames += [click(x, 620), click(110, 768), click(800, 768), [], []]
        frames += [[pygame.event.Event(pygame.QUIT)]]
        events = iter(frames)
        ticks = itertools.count(0, 2000)
        observed = []
        original_flip = pygame.display.flip

        def record_frame():
            observed.append((engine.phase, engine.visible_count(0), engine.current))
            original_flip()

        with patch.object(game, "GolfGame", return_value=engine), \
             patch.object(pygame.event, "get", side_effect=lambda: next(events)), \
             patch.object(pygame.time, "get_ticks", side_effect=lambda: next(ticks)), \
             patch.object(pygame.display, "flip", side_effect=record_frame):
            game.run()
        self.assertEqual(observed[1], ("setup", 0, 0))
        self.assertEqual(observed[4], ("setup", 0, 0))
        self.assertEqual(observed[12], ("act", 3, 0))
        self.assertEqual(engine.phase, "over")
        self.assertEqual(engine.visible_count(0), 6)
        self.assertEqual(engine.visible_count(1), 6)
        self.assertEqual(engine.turns, 8)


if __name__ == "__main__":
    unittest.main()
