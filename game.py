"""Rules and turn state for 52-card Golf; importing this module needs no Pygame."""
from dataclasses import dataclass, replace
from itertools import combinations
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

    @property
    def red(self):
        return self.suit in "HD"


@dataclass
class Slot:
    card: Card
    visible: bool = False


@dataclass
class Rules:
    queen_swap: bool = False
    jack_swap: bool = False
    devils_row: bool = False
    gamblers_row: bool = False
    king_queen: bool = False


RULE_OPTIONS = [
    ("queen_swap", "Queen-Queen: bonus swap"),
    ("jack_swap", "Jack-Jack: bonus swap"),
    ("devils_row", "666: locked row"),
    ("gamblers_row", "777: final score / 7"),
    ("king_queen", "King-Queen: color scoring"),
]


class GolfGame:
    def __init__(self, seed=None, rules=None):
        self.rules = replace(rules) if rules else Rules()
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
        self.is_final_turn = False
        self.turns = 0
        self.bonus_remaining = 0
        self.used_pairs = set()
        self.locked_cards = set()
        self.gambler_earned = [False, False]
        self.message = "Select one of your cards and Flip. Reveal two to start."
        self.last_move = "You are the dealer and play first."

    def set_rule(self, key, enabled):
        if self.phase != "setup" or key not in {key for key, _ in RULE_OPTIONS}:
            raise ValueError("Choose rules during the opening reveal, before the round starts.")
        setattr(self.rules, key, bool(enabled))
        self.locked_cards.clear()
        self.gambler_earned = [False, False]
        self._update_combos()

    def visible_count(self, player):
        return sum(slot.visible for slot in self.players[player])

    def score(self, player, visible_only=False):
        total = 0
        for column in range(3):
            pair = [self.players[player][column], self.players[player][column + 3]]
            if visible_only:
                pair = [slot for slot in pair if slot.visible]
            if len(pair) == 2:
                first, second = (slot.card for slot in pair)
                if first.rank == second.rank:
                    continue
                if self.rules.king_queen and {first.rank, second.rank} == {12, 13}:
                    total += 5 if first.red == second.red else 15
                    continue
            total += sum(slot.card.points for slot in pair)
        if not visible_only and self.rules.gamblers_row and self.gambler_earned[player]:
            total = (total + 6) // 7
        return total

    def _update_combos(self):
        for player, layout in enumerate(self.players):
            for row in (layout[:3], layout[3:]):
                if not all(slot.visible for slot in row):
                    continue
                if self.rules.devils_row and all(slot.card.rank == 6 for slot in row):
                    self.locked_cards.update(slot.card for slot in row)
                if self.rules.gamblers_row and all(slot.card.rank == 7 for slot in row):
                    self.gambler_earned[player] = True

    def _mark_finish(self):
        if self.finisher is None:
            for player in (self.current, 1 - self.current):
                if self.visible_count(player) == 6:
                    self.finisher = player
                    self.final_player = 1 - player
                    break

    def reveal(self, index):
        if self.phase not in ("setup", "choose", "drawn") or index not in range(6):
            raise ValueError("You cannot flip a layout card right now.")
        slot = self.players[self.current][index]
        if slot.visible:
            raise ValueError("Choose a face-down card to flip.")
        slot.visible = True
        self._update_combos()
        if self.phase == "setup":
            if self.visible_count(0) == 2:
                for other_index in self.rng.sample(range(6), 2):
                    self.players[1][other_index].visible = True
                self.phase = "choose"
                self.message = "Your turn: Flip your card, Draw, or Swap with the discard."
            else:
                self.message = "Reveal one more of your cards to start."
        else:
            self.flipped = index
            self.phase = "drawn_revealed" if self.held_card else "revealed"
            self._mark_finish()
            self.message = ("Swap the revealed card with your draw, or Discard the draw."
                            if self.held_card else "Swap with the discard, Draw, or End turn.")

    def _draw(self):
        if not self.draw_pile:
            top = self.discard_pile[-1]
            self.draw_pile = self.discard_pile[:-1]
            self.rng.shuffle(self.draw_pile)
            self.discard_pile = [top]
        if not self.draw_pile:
            raise ValueError("No cards available to draw.")
        return self.draw_pile.pop()

    def draw(self):
        if self.phase not in ("choose", "revealed"):
            raise ValueError("You may draw once, before or after flipping your own card.")
        self.held_card = self._draw()
        self.phase = "drawn_revealed" if self.flipped is not None else "drawn"
        self.message = ("Swap the revealed card with your draw, or Discard the draw."
                        if self.flipped is not None else
                        "Swap your draw with any own card, or Flip a hidden card to decide.")

    def targets(self):
        if self.phase in ("choose", "drawn"):
            indexes = range(6)
        elif self.phase in ("revealed", "drawn_revealed"):
            indexes = [self.flipped]
        else:
            indexes = []
        return [i for i in indexes if self.players[self.current][i].card not in self.locked_cards]

    def swap(self, index, source=None):
        expected = "held" if self.held_card else "discard"
        if index not in self.targets() or source not in (None, expected):
            raise ValueError("Select an eligible card from your own layout.")
        incoming = self.held_card if self.held_card else self.discard_pile.pop()
        outgoing = self.players[self.current][index].card
        self.players[self.current][index] = Slot(incoming, True)
        self.held_card = None
        self.discard_pile.append(outgoing)
        who = "You" if self.current == 0 else "Opponent"
        self.last_move = f"{who} swapped {outgoing.label}{outgoing.suit} for {incoming.label}{incoming.suit}."
        self._finish_turn()

    def discard(self):
        if self.phase != "drawn_revealed":
            raise ValueError("Flip one of your own cards before discarding the draw.")
        card = self.held_card
        self.discard_pile.append(card)
        self.held_card = None
        who = "You" if self.current == 0 else "Opponent"
        self.last_move = f"{who} discarded {card.label}{card.suit}."
        self._finish_turn()

    def end_turn(self):
        if self.phase != "revealed":
            raise ValueError("You may end without another action only after flipping your own card.")
        card = self.players[self.current][self.flipped].card
        who = "You" if self.current == 0 else "Opponent"
        self.last_move = f"{who} revealed {card.label}{card.suit} and ended the turn."
        self._finish_turn()

    def _collect_bonuses(self):
        for column in range(3):
            first, second = self.players[self.current][column], self.players[self.current][column + 3]
            enabled = ((first.card.rank == 12 and self.rules.queen_swap) or
                       (first.card.rank == 11 and self.rules.jack_swap))
            if first.visible and second.visible and enabled and first.card.rank == second.card.rank:
                pair = frozenset((first.card, second.card))
                if pair not in self.used_pairs:
                    self.used_pairs.add(pair)
                    self.bonus_remaining += 1

    def _finish_turn(self):
        self._update_combos()
        self._mark_finish()
        self.flipped = None
        self._collect_bonuses()
        if self.bonus_remaining:
            self.phase = "bonus"
            self.message = ("Bonus swap! Select any TWO table cards, then Swap." if self.current == 0
                            else "Opponent earned a bonus swap and is thinking...")
        else:
            self._complete_turn()

    def table_refs(self):
        refs = [(player, index) for player in range(2) for index in range(6)]
        if self.draw_pile:
            refs.append(("draw", None))
        if self.discard_pile:
            refs.append(("discard", None))
        return refs

    def table_slot(self, ref):
        if ref not in self.table_refs():
            raise ValueError("Choose an existing table card.")
        owner, index = ref
        if owner == "draw":
            return Slot(self.draw_pile[-1], False)
        if owner == "discard":
            return Slot(self.discard_pile[-1], True)
        slot = self.players[owner][index]
        return Slot(slot.card, slot.visible)

    def _put_slot(self, ref, slot):
        owner, index = ref
        if owner == "draw":
            self.draw_pile[-1] = slot.card
        elif owner == "discard":
            self.discard_pile[-1] = slot.card
        else:
            self.players[owner][index] = Slot(slot.card, slot.visible)

    def bonus_swap(self, first, second):
        if self.phase != "bonus" or first == second:
            raise ValueError("Select two different table cards for the bonus swap.")
        a, b = self.table_slot(first), self.table_slot(second)
        self._put_slot(first, b)
        self._put_slot(second, a)
        self.bonus_remaining -= 1
        self.last_move = ("You" if self.current == 0 else "Opponent") + " used a bonus swap."
        # Visibility follows cards into layouts. Piles use their own orientation.
        # Bonus swaps override locks, but an already locked card retains its lock.
        self._update_combos()
        self._mark_finish()
        self._collect_bonuses()
        if self.bonus_remaining:
            self.message = (f"{self.bonus_remaining} bonus swap(s) left. Select two cards and Swap."
                            if self.current == 0 else "Opponent is taking another bonus swap...")
        else:
            self._complete_turn()

    def _complete_turn(self):
        self.turns += 1
        if self.is_final_turn:
            for layout in self.players:
                for slot in layout:
                    slot.visible = True
            self.phase = "over"
            mine, theirs = self.score(0), self.score(1)
            self.message = "You win!" if mine < theirs else "Opponent wins." if mine > theirs else "It's a draw!"
            return
        self.current = self.final_player if self.final_player is not None else 1 - self.current
        self.is_final_turn = self.current == self.final_player
        self.phase = "choose"
        self.message = "Your turn: Flip your card, Draw, or Swap with the discard." if self.current == 0 else "Opponent is thinking..."
        if self.current == self.final_player:
            self.message = "Your FINAL turn: Flip, Draw, or Swap." if self.current == 0 else "Opponent's final turn..."

    def _visible_column(self, player, index, replacement=None):
        slot = self.players[player][index]
        partner = self.players[player][(index + 3) % 6]
        card = replacement if replacement is not None else slot.card
        if partner.visible and partner.card.rank == card.rank:
            return 0
        if partner.visible and self.rules.king_queen and {card.rank, partner.card.rank} == {12, 13}:
            return 5 if card.red == partner.card.red else 15
        return card.points + (partner.card.points if partner.visible else 0)

    def opponent_turn(self):
        """A basic bot that only evaluates public cards and its actual revealed draw."""
        if self.current != 1:
            return
        if self.phase == "bonus":
            public = [ref for ref in self.table_refs() if self.table_slot(ref).visible]
            best_pair, best_value = None, float("inf")
            for first, second in combinations(public, 2):
                a, b = self.table_slot(first), self.table_slot(second)
                self._put_slot(first, b)
                self._put_slot(second, a)
                value = self.score(1, True) - self.score(0, True)
                self._put_slot(first, a)
                self._put_slot(second, b)
                if value < best_value:
                    best_pair, best_value = (first, second), value
            self.bonus_swap(*best_pair)
            return
        if self.phase != "choose":
            return
        hidden = [i for i, slot in enumerate(self.players[1]) if not slot.visible]
        if hidden:
            self.reveal(self.rng.choice(hidden))
            targets = self.targets()
            if targets:
                index = targets[0]
                if self._visible_column(1, index, self.discard_pile[-1]) < self._visible_column(1, index):
                    self.swap(index)
                    return
                if self._visible_column(1, index) > 4:
                    self.draw()
                    if self._visible_column(1, index, self.held_card) < self._visible_column(1, index):
                        self.swap(index)
                    else:
                        self.discard()
                    return
            self.end_turn()
        else:
            self.draw()
            targets = self.targets()
            if targets:
                best = max(targets, key=lambda i: self._visible_column(1, i) - self._visible_column(1, i, self.held_card))
                self.swap(best)
                return


def run(screenshot=None, engine=None):
    from ui import run as run_ui
    run_ui(screenshot=screenshot, engine=engine)


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Play 52-card Golf against a simple bot.")
    parser.add_argument("--screenshot", help="Render the opening screen to a PNG and exit.")
    args = parser.parse_args()
    run(args.screenshot)
