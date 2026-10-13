"""A small, two-player Golf game. The rules engine has no UI dependencies."""

from dataclasses import dataclass
import random


@dataclass(frozen=True)
class Card:
    rank: int
    suit: str

    @property
    def label(self):
        return {1: "A", 11: "J", 12: "Q", 13: "K"}.get(self.rank, str(self.rank))

    @property
    def points(self):
        return -2 if self.rank == 2 else 0 if self.rank == 13 else min(self.rank, 10)


@dataclass
class Slot:
    card: Card
    visible: bool = False


class GolfGame:
    def __init__(self, seed=None):
        self.rng = random.Random(seed)
        self.draw_pile = [Card(rank, suit) for suit in "SHDC" for rank in range(1, 14)]
        self.rng.shuffle(self.draw_pile)
        self.players = [[Slot(self.draw_pile.pop()) for _ in range(6)] for _ in range(2)]
        self.discard_pile = [self.draw_pile.pop()]
        self.current = 0
        self.phase = "setup"
        self.flipped = None
        self.held_card = None
        self.finisher = None
        self.final_player = None
        self.turns = 0
        self.message = "Select one of your cards, then press Flip. Reveal two to start."
        self.last_move = "A fresh deck. You are the dealer and play first."

    def visible_count(self, player):
        return sum(slot.visible for slot in self.players[player])

    def score(self, player, visible_only=False):
        total = 0
        for column in range(3):
            pair = [self.players[player][column], self.players[player][column + 3]]
            if visible_only:
                pair = [slot for slot in pair if slot.visible]
            if len(pair) == 2 and pair[0].card.rank == pair[1].card.rank:
                continue
            total += sum(slot.card.points for slot in pair)
        return total

    def reveal(self, index):
        if self.phase not in ("setup", "choose") or index not in range(6):
            raise ValueError("You cannot flip a card right now.")
        slot = self.players[self.current][index]
        if slot.visible:
            raise ValueError("Choose a face-down card to flip.")
        slot.visible = True
        if self.phase == "setup":
            if self.visible_count(0) == 2:
                for other_index in self.rng.sample(range(6), 2):
                    self.players[1][other_index].visible = True
                self.phase = "choose"
                self.message = "Your turn: flip a hidden card, flip the draw pile, or skip."
            else:
                self.message = "Reveal one more of your cards to start."
        else:
            self.flipped = index
            self.phase = "act"
            self.message = "Swap the card you just flipped, or draw and discard."

    def skip_flip(self):
        if self.phase != "choose":
            raise ValueError("You cannot skip flipping right now.")
        self.flipped = None
        self.phase = "act"
        self.message = "Select any of your face-up cards to swap, or draw and discard."

    def draw_first(self):
        if self.phase != "choose":
            raise ValueError("You can draw first only at the start of your turn.")
        self.held_card = self._draw()
        self.phase = "drawn"
        self.message = "Select one of your cards and Swap drawn, or Discard drawn."

    def discard_drawn(self):
        if self.phase != "drawn":
            raise ValueError("There is no drawn card to discard.")
        card = self.held_card
        self.discard_pile.append(card)
        self.held_card = None
        who = "You" if self.current == 0 else "Opponent"
        self.last_move = f"{who} drew and discarded {card.label}{card.suit}."
        self._finish_turn()

    def targets(self):
        if self.phase == "drawn":
            return list(range(6))
        if self.phase != "act":
            return []
        return [self.flipped] if self.flipped is not None else [
            i for i, slot in enumerate(self.players[self.current]) if slot.visible
        ]

    def _draw(self):
        if not self.draw_pile:
            top = self.discard_pile[-1]
            self.draw_pile = self.discard_pile[:-1]
            self.rng.shuffle(self.draw_pile)
            self.discard_pile = [top]
        if not self.draw_pile:
            raise ValueError("No cards available to draw.")
        return self.draw_pile.pop()

    def swap(self, index, source):
        sources = ("held",) if self.phase == "drawn" else ("discard", "draw")
        if index not in self.targets() or source not in sources:
            raise ValueError("Select an eligible card from your own layout.")
        if source == "held":
            incoming = self.held_card
            self.held_card = None
        else:
            incoming = self.discard_pile.pop() if source == "discard" else self._draw()
        outgoing = self.players[self.current][index].card
        self.players[self.current][index] = Slot(incoming, True)
        self.discard_pile.append(outgoing)
        who = "You" if self.current == 0 else "Opponent"
        self.last_move = f"{who} swapped {outgoing.label}{outgoing.suit} for {incoming.label}{incoming.suit}."
        self._finish_turn()

    def draw_discard(self):
        if self.phase != "act":
            raise ValueError("First flip a card or choose Skip flip.")
        card = self._draw()
        self.discard_pile.append(card)
        who = "You" if self.current == 0 else "Opponent"
        self.last_move = f"{who} drew and discarded {card.label}{card.suit}."
        self._finish_turn()

    def _finish_turn(self):
        self.turns += 1
        self.flipped = None
        if self.current == self.final_player:
            for layout in self.players:
                for slot in layout:
                    slot.visible = True
            self.phase = "over"
            mine, theirs = self.score(0), self.score(1)
            self.message = "You win!" if mine < theirs else "Opponent wins." if mine > theirs else "It's a draw!"
            return
        if self.finisher is None and self.visible_count(self.current) == 6:
            self.finisher = self.current
            self.final_player = 1 - self.current
        self.current = 1 - self.current
        self.phase = "choose"
        self.message = "Your turn: flip a hidden card, flip the draw pile, or skip." if self.current == 0 else "Opponent is thinking..."
        if self.current == self.final_player:
            self.message = "Your final turn! Flip a card, draw first, or skip." if self.current == 0 else "Opponent is taking their final turn..."

    def opponent_turn(self):
        """A deliberately basic opponent. Decisions only read its visible cards."""
        if self.current != 1 or self.phase != "choose":
            return
        hidden = [i for i, slot in enumerate(self.players[1]) if not slot.visible]
        if hidden:
            self.reveal(self.rng.choice(hidden))
        else:
            self.skip_flip()
        top = self.discard_pile[-1]

        def column_value(index, replacement=None):
            partner = self.players[1][(index + 3) % 6]
            card = replacement or self.players[1][index].card
            if partner.visible and partner.card.rank == card.rank:
                return 0
            return card.points + (partner.card.points if partner.visible else 0)

        targets = self.targets()
        best = max(targets, key=lambda i: column_value(i) - column_value(i, top))
        if column_value(best, top) < column_value(best):
            self.swap(best, "discard")
        elif column_value(best) > 4:
            self.swap(best, "draw")
        else:
            self.draw_discard()


def run(screenshot=None):
    import os
    os.environ.setdefault("PYGAME_HIDE_SUPPORT_PROMPT", "1")
    import pygame

    pygame.init()
    width, height = 1080, 850
    screen = pygame.display.set_mode((width, height))
    pygame.display.set_caption("GolfBot - 52-card Golf")
    clock = pygame.time.Clock()
    game = GolfGame()
    selected = None
    opponent_due = None
    bg, panel = (15, 39, 34), (24, 53, 46)
    white, muted, gold = (242, 241, 229), (164, 186, 174), (229, 187, 100)
    green = (119, 224, 161)
    fonts = {size: pygame.font.SysFont("Segoe UI", size) for size in (14, 16, 18, 20, 24, 32)}
    symbols = pygame.font.SysFont("Segoe UI Symbol", 40)
    suits = {"S": "♠", "H": "♥", "D": "♦", "C": "♣"}
    cards = {(player, index): pygame.Rect(349 + index % 3 * 108, (100 if player == 1 else 432) + index // 3 * 132, 92, 116)
             for player in range(2) for index in range(6)}
    deck_rect, discard_rect = pygame.Rect(53, 343, 92, 116), pygame.Rect(165, 343, 92, 116)
    button_names = ["Flip", "Skip flip", "Swap discard", "Swap deck", "Draw & discard", "New game"]
    buttons = {name: pygame.Rect(30 + i * 173, 745, 160, 47) for i, name in enumerate(button_names)}

    def text(value, x, y, size=18, color=white):
        screen.blit(fonts[size].render(value, True, color), (x, y))

    def wrap(value, x, y, max_width, size=16, color=muted):
        line = ""
        for word in value.split():
            candidate = f"{line} {word}".strip()
            if fonts[size].size(candidate)[0] > max_width and line:
                text(line, x, y, size, color)
                y += size + 7
                line = word
            else:
                line = candidate
        if line:
            text(line, x, y, size, color)
            y += size + 7
        return y

    def draw_card(rect, card=None, picked=False, eligible=False):
        pygame.draw.rect(screen, (7, 27, 22), rect.move(3, 4), border_radius=9)
        pygame.draw.rect(screen, white if card else (40, 79, 67), rect, border_radius=9)
        if card:
            color = (176, 54, 66) if card.suit in "HD" else (31, 48, 43)
            text(card.label, rect.x + 10, rect.y + 6, 24, color)
            glyph = symbols.render(suits[card.suit], True, color)
            screen.blit(glyph, glyph.get_rect(center=rect.center))
            small = fonts[16].render(card.label + suits[card.suit], True, color)
            screen.blit(small, (rect.right - small.get_width() - 9, rect.bottom - 28))
        else:
            inner = rect.inflate(-12, -12)
            pygame.draw.rect(screen, (80, 117, 97), inner, width=1, border_radius=6)
            for offset in range(-80, 150, 12):
                start = (inner.x + max(0, offset), inner.y + max(0, -offset))
                end = (inner.x + min(inner.width, offset + inner.height), inner.y + min(inner.height, inner.width - offset))
                if start[0] <= inner.right and start[1] <= inner.bottom and end[0] >= inner.x and end[1] >= inner.y:
                    pygame.draw.line(screen, (49, 88, 72), start, end)
            badge = fonts[32].render("G", True, gold)
            screen.blit(badge, badge.get_rect(center=rect.center))
        if eligible:
            pygame.draw.rect(screen, (80, 151, 116), rect.inflate(4, 4), width=1, border_radius=10)
        if picked:
            pygame.draw.rect(screen, green, rect.inflate(8, 8), width=3, border_radius=12)

    def available(name):
        if name == "New game":
            return True
        if game.current != 0 or game.phase == "over":
            return False
        own = selected is not None and selected[0] == 0
        if name == "Flip":
            if selected == ("draw", None):
                return game.phase == "choose"
            return game.phase in ("setup", "choose") and own and not game.players[0][selected[1]].visible
        if name == "Skip flip":
            return game.phase == "choose"
        if name == "Swap discard":
            return game.phase == "act" and own and selected[1] in game.targets()
        if name == "Swap deck":
            return own and selected[1] in game.targets()
        return game.phase in ("act", "drawn")

    def activate(name):
        nonlocal game, selected, opponent_due
        if not available(name):
            return
        if name == "New game":
            game, selected, opponent_due = GolfGame(), None, None
        elif name == "Flip":
            if selected == ("draw", None):
                game.draw_first()
                selected = None
            else:
                game.reveal(selected[1])
        elif name == "Skip flip":
            game.skip_flip()
        elif name.startswith("Swap"):
            source = "held" if game.phase == "drawn" else "discard" if name == "Swap discard" else "draw"
            game.swap(selected[1], source)
            selected = None
        else:
            if game.phase == "drawn":
                game.discard_drawn()
            else:
                game.draw_discard()
            selected = None

    def render():
        screen.fill(bg)
        text("GOLF", 30, 18, 32, white)
        text("52 cards  /  lowest score wins", 140, 30, 16, muted)
        text("YOU vs SIMPLE BOT", 826, 30, 16, gold)
        pygame.draw.rect(screen, panel, (30, 83, 250, 595), border_radius=16)
        pygame.draw.rect(screen, panel, (704, 83, 346, 595), border_radius=16)
        text("THE TABLE", 52, 105, 16, gold)
        text("Two rows. Three columns.", 52, 139, 16)
        wrap("Same-rank cards in a column cancel to zero. Suits do not affect the base score.", 52, 174, 207)
        text("Drawn card" if game.held_card else "Draw pile", 53, 309, 16, muted)
        text("Discard", 165, 309, 16, muted)
        draw_card(deck_rect, game.held_card, selected == ("draw", None), game.current == 0 and game.phase == "choose")
        draw_card(discard_rect, game.discard_pile[-1])
        text(f"{len(game.draw_pile)} cards", 53, 473, 16)
        text("top card", 165, 473, 16)
        tip = "Select any of your six cards, then Swap drawn. Or Discard drawn to keep your layout unchanged." if game.held_card else "Click the draw pile, then Flip to see a card before deciding. Swap deck still takes a blind card."
        wrap(tip, 52, 530, 208)
        text("Opponent", 349, 68, 20)
        text("Your cards", 349, 399, 20, green)
        targets = game.targets() if game.current == 0 else []
        for key, rect in cards.items():
            player, index = key
            slot = game.players[player][index]
            draw_card(rect, slot.card if slot.visible else None, selected == key, player == 0 and index in targets)
        text("ROUND STATUS", 728, 105, 16, gold)
        if game.phase == "over":
            text(game.message, 728, 142, 24, green)
            text(f"You: {game.score(0)}   Opponent: {game.score(1)}", 728, 185, 20)
            wrap("All remaining cards are revealed for scoring. Press New game for another round.", 728, 227, 293)
        else:
            heading = "Opening reveal" if game.phase == "setup" else "Your turn" if game.current == 0 else "Opponent's turn"
            text(heading, 728, 143, 24)
            wrap(game.message, 728, 191, 293, 18, white)
            text("Visible subtotals", 728, 288, 16, gold)
            for player, label in [(0, "You"), (1, "Opponent")]:
                hidden = 6 - game.visible_count(player)
                text(f"{label}: {game.score(player, True)}  /  {hidden} hidden", 728, 321 + player * 30, 18)
            wrap("Hidden cards are not included. These are not final scores.", 728, 390, 293)
            if game.finisher is not None:
                wrap("FINAL TURN: the round ends after this turn.", 728, 451, 293, 18, gold)
        text("LAST ACTION", 728, 520, 16, gold)
        wrap(game.last_move, 728, 552, 293)
        text(f"Completed turns: {game.turns}", 728, 639, 14, muted)
        text(game.message, 30, 705, 18, white)
        mouse = pygame.mouse.get_pos()
        for name, rect in buttons.items():
            enabled = available(name)
            color = (74, 125, 94) if enabled and rect.collidepoint(mouse) else (49, 97, 75) if enabled else (28, 54, 46)
            pygame.draw.rect(screen, color, rect, border_radius=9)
            display_name = {"Swap deck": "Swap drawn", "Draw & discard": "Discard drawn"}.get(name, name) if game.phase == "drawn" else name
            label = fonts[16].render(display_name, True, white if enabled else (101, 127, 113))
            screen.blit(label, label.get_rect(center=rect.center))
        text("Click a card to select or unselect it. Green outlines show eligible swap targets.", 30, 811, 14, muted)
        pygame.display.flip()

    running = True
    while running:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False
            elif event.type == pygame.KEYDOWN and event.key == pygame.K_ESCAPE:
                running = False
            elif event.type == pygame.MOUSEBUTTONDOWN and event.button == 1:
                for name, rect in buttons.items():
                    if rect.collidepoint(event.pos):
                        activate(name)
                        break
                else:
                    if deck_rect.collidepoint(event.pos):
                        selected = None if selected == ("draw", None) else ("draw", None)
                        continue
                    for key, rect in cards.items():
                        if rect.collidepoint(event.pos):
                            selected = None if selected == key else key
                            break
        if game.current == 1 and game.phase == "choose":
            if opponent_due is None:
                opponent_due = pygame.time.get_ticks() + 1000
            elif pygame.time.get_ticks() >= opponent_due:
                game.opponent_turn()
                opponent_due = None
                selected = None
        render()
        if screenshot:
            pygame.image.save(screen, screenshot)
            running = False
        clock.tick(60)
    pygame.quit()


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Play 52-card Golf against a simple bot.")
    parser.add_argument("--screenshot", help="Render the opening screen to a PNG and exit.")
    args = parser.parse_args()
    run(args.screenshot)
