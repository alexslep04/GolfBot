"""Clickable Pygame table and rule selection for GolfBot."""
import os
os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
import pygame
from game import GolfGame, RULE_OPTIONS
from rule_help import load_rule_help
from scoring import active_rule_effects


class GolfUI:
    def __init__(self, engine=None):
        pygame.init()
        self.window = pygame.display.set_mode((1080, 850), pygame.RESIZABLE)
        self.screen = pygame.Surface((1080, 850))
        pygame.display.set_caption("GolfBot - 52-card Golf")
        self.clock = pygame.time.Clock()
        self.game = engine if engine is not None else GolfGame()
        self.selected = []
        self.opponent_due = None
        self.bg, self.panel = (15, 39, 34), (24, 53, 46)
        self.white, self.muted, self.gold = (242, 241, 229), (164, 186, 174), (229, 187, 100)
        self.green = (119, 224, 161)
        self.fonts = {size: pygame.font.SysFont("Segoe UI", size) for size in (14, 16, 18, 20, 24, 32)}
        self.symbols = pygame.font.SysFont("Segoe UI Symbol", 40)
        self.suits = {"S": "♠", "H": "♥", "D": "♦", "C": "♣"}
        self.cards = {(player, index): pygame.Rect(349 + index % 3 * 108, (100 if player == 1 else 432) + index // 3 * 132, 92, 116)
                      for player in range(2) for index in range(6)}
        self.deck_rect = pygame.Rect(53, 343, 92, 116)
        self.discard_rect = pygame.Rect(165, 343, 92, 116)
        self.held_rect = pygame.Rect(108, 541, 92, 116)
        self.buttons = {name: pygame.Rect(30 + i * 260, 745, 240, 47)
                        for i, name in enumerate(("Flip", "Swap", "Draw", "Discard"))}
        self.new_rect = pygame.Rect(894, 20, 156, 38)
        self.end_rect = pygame.Rect(884, 696, 166, 32)
        self.rule_rects = {key: pygame.Rect(724, 147 + i * 23, 300, 22)
                           for i, (key, _) in enumerate(RULE_OPTIONS)}
        self.help_rects = {key: pygame.Rect(1008, rect.y + 1, 22, 21) for key, rect in self.rule_rects.items()}
        self.rule_help = load_rule_help()
        self.modal_rect = pygame.Rect(265, 224, 550, 385)
        self.guess_rects = {rank: pygame.Rect(292 + (rank - 1) % 7 * 69, 374 + (rank - 1) // 7 * 54, 59, 43)
                            for rank in range(1, 14)}
        self.pass_rect = pygame.Rect(458, 510, 164, 40)
        self.arrange_rects = {columns: pygame.Rect(292 + i * 170, 391, 155, 45)
                              for i, columns in enumerate(((0, 1), (0, 2), (1, 2)))}

    def viewport(self):
        width, height = self.window.get_size()
        scale = min(width / 1080, height / 850)
        size = (max(1, round(1080 * scale)), max(1, round(850 * scale)))
        return pygame.Rect((width - size[0]) // 2, (height - size[1]) // 2, *size)

    def table_position(self, position):
        viewport = self.viewport()
        return ((position[0] - viewport.x) * 1080 / viewport.width,
                (position[1] - viewport.y) * 850 / viewport.height)

    def mouse_position(self):
        return self.table_position(pygame.mouse.get_pos())

    def text(self, value, x, y, size=18, color=None):
        self.screen.blit(self.fonts[size].render(value, True, color or self.white), (x, y))

    def wrap(self, value, x, y, max_width, size=16, color=None):
        line = ""
        for word in value.split():
            candidate = f"{line} {word}".strip()
            if self.fonts[size].size(candidate)[0] > max_width and line:
                self.text(line, x, y, size, color or self.muted)
                y += size + 7
                line = word
            else:
                line = candidate
        if line:
            self.text(line, x, y, size, color or self.muted)
            y += size + 7
        return y

    def card(self, rect, card=None, picked=False, eligible=False, locked=False):
        pygame.draw.rect(self.screen, (7, 27, 22), rect.move(3, 4), border_radius=9)
        pygame.draw.rect(self.screen, self.white if card else (40, 79, 67), rect, border_radius=9)
        if card:
            color = (176, 54, 66) if card.red else (31, 48, 43)
            self.text(card.label, rect.x + 10, rect.y + 6, 24, color)
            glyph = self.symbols.render(self.suits[card.suit], True, color)
            self.screen.blit(glyph, glyph.get_rect(center=rect.center))
            small = self.fonts[16].render(card.label + self.suits[card.suit], True, color)
            self.screen.blit(small, (rect.right - small.get_width() - 9, rect.bottom - 28))
        else:
            inner = rect.inflate(-12, -12)
            pygame.draw.rect(self.screen, (80, 117, 97), inner, width=1, border_radius=6)
            for offset in range(-80, 150, 12):
                start = (inner.x + max(0, offset), inner.y + max(0, -offset))
                end = (inner.x + min(inner.width, offset + inner.height), inner.y + min(inner.height, inner.width - offset))
                if start[0] <= inner.right and start[1] <= inner.bottom and end[0] >= inner.x and end[1] >= inner.y:
                    pygame.draw.line(self.screen, (49, 88, 72), start, end)
            badge = self.fonts[32].render("G", True, self.gold)
            self.screen.blit(badge, badge.get_rect(center=rect.center))
        if eligible:
            pygame.draw.rect(self.screen, (80, 151, 116), rect.inflate(4, 4), width=1, border_radius=10)
        if picked:
            pygame.draw.rect(self.screen, self.green, rect.inflate(8, 8), width=3, border_radius=12)
        if locked:
            self.text("LOCK", rect.x + 39, rect.y + 8, 14, (158, 111, 50))

    def selected_own(self):
        return len(self.selected) == 1 and self.selected[0][0] == 0

    def available(self, name):
        game = self.game
        if name == "New game":
            return True
        if game.decision_player != 0 or game.phase == "over":
            return False
        if name == "End turn":
            return game.phase == "revealed"
        if name == "Draw":
            return game.phase in ("choose", "revealed")
        if name == "Discard":
            return game.phase in ("drawn", "drawn_revealed")
        if name == "Flip":
            if self.selected == [("draw", None)]:
                return game.phase in ("choose", "revealed")
            return (game.phase in ("setup", "choose", "drawn") and self.selected_own()
                    and not game.players[0][self.selected[0][1]].visible)
        if name == "Swap":
            if game.phase == "guess_trade":
                own, other = game.guess_trade_targets()
                return (len(self.selected) == 2 and
                        ((self.selected[0] in own and self.selected[1] in other) or
                         (self.selected[1] in own and self.selected[0] in other)))
            if game.phase == "bonus":
                return len(self.selected) == 2 and all(ref in game.table_refs() for ref in self.selected)
            return self.selected_own() and self.selected[0][1] in game.targets()
        return False

    def select(self, ref):
        if ref in self.selected:
            self.selected.remove(ref)
        elif self.game.phase in ("bonus", "guess_trade") and self.game.decision_player == 0:
            if ref in self.game.table_refs():
                self.selected = (self.selected + [ref])[-2:]
        else:
            self.selected = [ref]

    def activate(self, name):
        if not self.available(name):
            return
        game = self.game
        if name == "New game":
            self.game = GolfGame(rules=game.rules)
            self.opponent_due = None
            self.selected = []
        elif name == "End turn":
            game.end_turn()
            self.selected = []
        elif name == "Flip":
            if self.selected == [("draw", None)]:
                game.draw()
                self.selected = []
            else:
                game.reveal(self.selected[0][1])
        elif name == "Draw":
            game.draw()
            self.selected = []
        elif name == "Swap":
            if game.phase == "guess_trade":
                game.guess_trade(*self.selected)
            elif game.phase == "bonus":
                game.bonus_swap(*self.selected)
            else:
                game.swap(self.selected[0][1])
            self.selected = []
        elif name == "Discard":
            game.discard()
            self.selected = []

    def click(self, pos):
        game = self.game
        if game.decision_player == 0 and game.phase in ("guess", "arrange"):
            if self.pass_rect.collidepoint(pos):
                game.submit_guess() if game.phase == "guess" else game.arrange_four()
                self.selected = []
                return
            if game.phase == "guess":
                for rank, rect in self.guess_rects.items():
                    if rect.collidepoint(pos):
                        game.submit_guess(rank)
                        self.selected = []
                        return
            else:
                for columns, rect in self.arrange_rects.items():
                    if rect.collidepoint(pos) and game.arrangement_plan(game.arrange_pending["player"], game.arrange_pending["rank"], columns):
                        game.arrange_four(columns)
                        self.selected = []
                        return
            return
        if any(rect.collidepoint(pos) for rect in self.help_rects.values()):
            return
        for key, rect in self.rule_rects.items():
            if rect.collidepoint(pos):
                if self.game.phase == "setup":
                    self.game.set_rule(key, not getattr(self.game.rules, key))
                return
        if self.new_rect.collidepoint(pos):
            self.activate("New game")
            return
        if self.end_rect.collidepoint(pos) and self.available("End turn"):
            self.activate("End turn")
            return
        for name, rect in self.buttons.items():
            if rect.collidepoint(pos):
                self.activate(name)
                return
        for ref, rect in list(self.cards.items()) + [(("draw", None), self.deck_rect), (("discard", None), self.discard_rect)]:
            if rect.collidepoint(pos):
                self.select(ref)
                return

    def button(self, label, rect, enabled=True):
        hover = rect.collidepoint(self.mouse_position())
        color = (74, 125, 94) if enabled and hover else (49, 97, 75) if enabled else (28, 54, 46)
        pygame.draw.rect(self.screen, color, rect, border_radius=9)
        text = self.fonts[16].render(label, True, self.white if enabled else (101, 127, 113))
        self.screen.blit(text, text.get_rect(center=rect.center))

    def tooltip_key(self, pos):
        return next((key for key, rect in self.help_rects.items() if rect.collidepoint(pos)), None)

    def draw_tooltip(self, key):
        title, body = self.rule_help[key]
        lines, line = [], ""
        for word in body.split():
            candidate = (line + " " + word).strip()
            if self.fonts[14].size(candidate)[0] > 396 and line:
                lines.append(line)
                line = word
            else:
                line = candidate
        lines.append(line)
        height = 58 + 20 * len(lines)
        mouse = self.mouse_position()
        rect = pygame.Rect(max(12, mouse[0] - 434), min(mouse[1] + 15, 836 - height), 428, height)
        pygame.draw.rect(self.screen, (9, 29, 24), rect.move(4, 4), border_radius=10)
        pygame.draw.rect(self.screen, (39, 69, 54), rect, border_radius=10)
        pygame.draw.rect(self.screen, self.gold, rect, 1, border_radius=10)
        self.text(title, rect.x + 15, rect.y + 12, 16, self.gold)
        for i, line in enumerate(lines):
            self.text(line, rect.x + 15, rect.y + 42 + i * 20, 14)

    def draw_modal(self):
        game = self.game
        veil = pygame.Surface((1080, 850), pygame.SRCALPHA)
        veil.fill((0, 0, 0, 155))
        self.screen.blit(veil, (0, 0))
        pygame.draw.rect(self.screen, (29, 61, 48), self.modal_rect, border_radius=15)
        pygame.draw.rect(self.screen, self.gold, self.modal_rect, 1, border_radius=15)
        if game.phase == "guess":
            self.text("Beggars Will be Choosers", 292, 251, 24, self.gold)
            target = game.guess_pending["target"]
            self.wrap(f"Guess the rank of the opponent's selected card: row {target // 3 + 1}, column {target % 3 + 1}. It is still face down.", 292, 298, 492, 18)
            for rank, rect in self.guess_rects.items():
                label = {1: "A", 11: "J", 12: "Q", 13: "K"}.get(rank, str(rank))
                self.button(label, rect)
            self.button("Pass", self.pass_rect)
        else:
            self.text("4 of a Kind", 292, 251, 24, self.gold)
            self.wrap("Choose two columns for the four matching cards. Other cards move into the remaining column; hidden cards stay hidden. You can keep your current layout.", 292, 298, 492, 18)
            pending = game.arrange_pending
            for columns, rect in self.arrange_rects.items():
                allowed = game.arrangement_plan(pending["player"], pending["rank"], columns) is not None
                self.button(f"Columns {columns[0] + 1} + {columns[1] + 1}", rect, allowed)
            self.button("Keep layout", self.pass_rect)

    def render(self):
        game = self.game
        self.screen.fill(self.bg)
        self.text("GOLF", 30, 18, 32)
        self.text("52 cards  /  lowest score wins", 140, 30, 16, self.muted)
        self.button("New game", self.new_rect)
        pygame.draw.rect(self.screen, self.panel, (30, 83, 250, 595), border_radius=16)
        pygame.draw.rect(self.screen, self.panel, (704, 83, 346, 373), border_radius=16)
        pygame.draw.rect(self.screen, self.panel, (704, 469, 346, 209), border_radius=16)
        self.text("THE TABLE", 52, 105, 16, self.gold)
        self.text("Two rows. Three columns.", 52, 139, 16)
        tip = ("BEGGARS: select one highlighted highest card of yours and one highlighted lowest opponent card, then Swap."
               if game.phase == "guess_trade" and game.decision_player == 0 else
               "BONUS: select two cards anywhere, including either player's layout and both pile tops, then Swap."
               if game.phase == "bonus" and game.current == 0 else
               "Select your card and Swap to take the discard. Draw reveals a card before you decide.")
        self.wrap(tip, 52, 174, 207, color=self.gold if game.phase == "bonus" and game.current == 0 else self.muted)
        self.text("Draw pile", 53, 309, 16, self.muted)
        self.text("Discard", 165, 309, 16, self.muted)
        bonus = game.current == 0 and game.phase == "bonus"
        self.card(self.deck_rect, picked=("draw", None) in self.selected, eligible=bonus and bool(game.draw_pile))
        self.card(self.discard_rect, game.discard_pile[-1], ("discard", None) in self.selected, bonus)
        self.text(f"{len(game.draw_pile)} cards", 53, 473, 16)
        self.text("top card", 165, 473, 16)
        if game.held_card:
            self.text("Your drawn card", 92, 511, 16, self.gold)
            self.card(self.held_rect, game.held_card)
        else:
            self.wrap("Same-rank column pairs score zero. Flip to learn a hidden card. Hidden cards stay unknown.", 52, 530, 208)
        self.text("Opponent", 349, 68, 20)
        self.text("Your cards", 349, 399, 20, self.green)
        targets = game.targets() if game.current == 0 else []
        trade_targets = sum(game.guess_trade_targets(), []) if game.phase == "guess_trade" and game.decision_player == 0 else []
        for ref, rect in self.cards.items():
            player, index = ref
            slot = game.players[player][index]
            self.card(rect, slot.card if slot.visible else None, ref in self.selected,
                      bonus or ref in trade_targets or (player == 0 and index in targets),
                      slot.visible and slot.card in game.locked_cards)
        for player, y in ((1, 352), (0, 682)):
            effects = active_rule_effects(game.players[player], game.rules, game.gambler_earned[player], game.locked_cards)
            score = game.score(player, game.phase != "over")
            label = "Score" if game.phase == "over" else "Visible"
            self.text(f"{label}: {score}", 349, y, 14)
            self.wrap("Effects: " + (", ".join(effects) if effects else "None"), 349, y + 19, 326, 14, self.gold)
        self.text("Rules in play", 728, 100, 20, self.gold)
        self.text("Choose before your second opening flip." if game.phase == "setup" else "New game to change rules.", 728, 128, 14, self.muted)
        for key, label in RULE_OPTIONS:
            rect = self.rule_rects[key]
            enabled = getattr(game.rules, key)
            checkbox = pygame.Rect(rect.x + 3, rect.y + 3, 17, 17)
            pygame.draw.rect(self.screen, (48, 85, 67), checkbox, border_radius=4)
            pygame.draw.rect(self.screen, self.green if enabled else self.muted, checkbox, width=1, border_radius=4)
            if enabled:
                pygame.draw.lines(self.screen, self.green, False,
                                  [(checkbox.x + 3, checkbox.y + 8), (checkbox.x + 6, checkbox.y + 12),
                                   (checkbox.x + 13, checkbox.y + 4)], 2)
            self.text(label, rect.x + 30, rect.y + 1, 14, self.white if enabled else self.muted)
            help_rect = self.help_rects[key]
            pygame.draw.circle(self.screen, self.muted, help_rect.center, 9, 1)
            self.text("?", help_rect.x + 7, help_rect.y, 14, self.gold)
        self.text("Hover over ? for the rule explanation.", 728, 431, 14, self.muted)
        heading = "Opening reveal" if game.phase == "setup" else "Bonus swap" if game.phase == "bonus" else "Round over" if game.phase == "over" else "Your turn" if game.current == 0 else "Opponent's turn"
        if game.phase in ("guess", "guess_trade", "arrange"):
            heading = "Your rule decision" if game.decision_player == 0 else "Opponent's rule decision"
        elif game.is_final_turn:
            heading = "Your final turn" if game.current == 0 else "Opponent's final turn"
        self.text(heading, 728, 484, 20, self.green if game.decision_player == 0 else self.gold)
        self.wrap(game.message, 728, 517, 292, 14, self.white)
        if game.phase == "over":
            self.text(f"You: {game.score(0)}   Opponent: {game.score(1)}", 728, 592, 20)
        else:
            self.text("Visible only (not final scores):", 728, 587, 14, self.muted)
            self.text(f"You: {game.score(0, True)}   Opponent: {game.score(1, True)}", 728, 607, 18)
        self.wrap(game.last_move, 728, 646, 292, 14)
        self.text(game.message, 30, 705, 16)
        if self.available("End turn"):
            self.button("End turn  [Enter]", self.end_rect)
        for name, rect in self.buttons.items():
            self.button(name, rect, self.available(name))
        hint = ("Correct guess: select one of your highest visible cards and one of the opponent's lowest, then Swap."
                if game.phase == "guess_trade" else
                "Click to select / unselect. Swap uses your drawn card, otherwise the discard. Bonus swaps need two selections.")
        self.text(hint, 30, 811, 14, self.muted)
        if game.phase in ("guess", "arrange") and game.decision_player == 0:
            self.draw_modal()
        else:
            tooltip = self.tooltip_key(self.mouse_position())
            if tooltip and tooltip in self.rule_help:
                self.draw_tooltip(tooltip)
        viewport = self.viewport()
        self.window.fill(self.bg)
        self.window.blit(pygame.transform.smoothscale(self.screen, viewport.size), viewport)
        pygame.display.flip()


def run(screenshot=None, engine=None):
    app = GolfUI(engine)
    running = True
    while running:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
            elif event.type == pygame.KEYDOWN:
                if event.key == pygame.K_ESCAPE:
                    running = False
                elif event.key == pygame.K_RETURN:
                    app.activate("End turn")
            elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                if app.viewport().collidepoint(event.pos):
                    app.click(app.table_position(event.pos))
        game = app.game
        if game.decision_player == 1 and game.phase not in ("setup", "over"):
            if app.opponent_due is None:
                app.opponent_due = pygame.time.get_ticks() + 1000
            elif pygame.time.get_ticks() >= app.opponent_due:
                game.opponent_turn()
                app.opponent_due = None
                app.selected = []
        app.render()
        if screenshot:
            pygame.image.save(app.screen, screenshot)
            running = False
        app.clock.tick(60)
    pygame.quit()
