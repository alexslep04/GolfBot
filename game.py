"""UI-independent rules and turn state for 52-card Golf."""
from dataclasses import dataclass, replace
from itertools import combinations, permutations
from collections import Counter
import random
from scoring import score_adjustments, column_score, straight_adjustments


@dataclass(frozen=True)
class Card:
    """Immutable face rank/suit; scoring effects never change a card's base points."""
    rank: int
    suit: str

    @property
    def label(self):
        return {1: "A", 11: "J", 12: "Q", 13: "K"}.get(self.rank, str(self.rank))

    @property
    def base_points(self):
        """Intrinsic Golf value: A=1, 2=-2, J/Q=10, K=0."""
        return -2 if self.rank == 2 else 0 if self.rank == 13 else min(self.rank, 10)

    @property
    def points(self):
        """Compatibility alias for base_points, never an adjusted layout value."""
        return self.base_points

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
    holdem: bool = False
    v10: bool = False
    tricky_straights: bool = False
    ripped_five: bool = False
    roman_fives: bool = False
    beggars: bool = False
    four_kind: bool = False
    poisoned_card: bool = False


RULE_OPTIONS = [
    ("queen_swap", "Queen-Queen: bonus swap"),
    ("jack_swap", "Jack-Jack: bonus swap"),
    ("devils_row", "666: locked row"),
    ("gamblers_row", "777: final score / 7"),
    ("king_queen", "King-Queen: color scoring"),
    ("holdem", "Hold 'em"),
    ("v10", "V10"),
    ("tricky_straights", "Tricky straights"),
    ("ripped_five", "The ripped 5"),
    ("roman_fives", "Roman 5s"),
    ("beggars", "Beggars Will be Choosers"),
    ("four_kind", "4 of a Kind"),
    ("poisoned_card", "Poisoned Card"),
]


class GolfGame:
    def __init__(self, seed=None, rules=None, multiplayer=False, first_player=0):
        if first_player not in (0, 1):
            raise ValueError("First player must be seat 0 or 1.")
        self.multiplayer = multiplayer
        self.first_player = first_player
        self.rules = replace(rules) if rules else Rules()
        self.rng = random.Random(seed)
        self.draw_pile = [Card(rank, suit) for suit in "SHDC" for rank in range(1, 14)]
        self.rng.shuffle(self.draw_pile)
        self.players = [[Slot(self.draw_pile.pop()) for _ in range(6)] for _ in range(2)]
        self.discard_pile = [self.draw_pile.pop()]
        self.current = first_player
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
        self.four_offered = [set(), set()]
        self.arrange_pending = None
        self.guess_pending = None
        self.message = "Select one of your cards and Flip. Reveal two to start."
        self.last_move = "Reveal two cards each to start."

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
        total = column_score(self.players[player], self.rules, visible_only)
        adjustment, divisor = score_adjustments(self.players[player], self.rules, visible_only)
        total += adjustment
        total += straight_adjustments(self.players[1 - player], self.rules, visible_only)[1]
        if self.rules.poisoned_card and self.finisher == player:
            total += 5
        if not visible_only:
            if self.rules.gamblers_row and self.gambler_earned[player]:
                divisor *= 7
            total = (total + divisor - 1) // divisor
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
        if self.phase == "setup":
            self.opening_reveal(self.current, index)
            return
        if self.phase not in ("setup", "choose", "drawn") or index not in range(6):
            raise ValueError("You cannot flip a layout card right now.")
        slot = self.players[self.current][index]
        if slot.visible:
            raise ValueError("Choose a face-down card to flip.")
        if self.phase != "setup" and self.rules.beggars:
            visible = [[i for i, card_slot in enumerate(layout) if card_slot.visible] for layout in self.players]
            highest = [max((self.players[p][i].card.base_points for i in visible[p]), default=None) for p in range(2)]
            other = 1 - self.current
            if highest[other] is not None and (highest[self.current] is None or highest[other] > highest[self.current]):
                self.guess_pending = {"player": other, "target": index, "phase": self.phase}
                self.phase = "guess"
                self.message = "Beggars: guess the selected opponent card's rank, or pass."
                return
        self._reveal_now(index)

    def _reveal_now(self, index):
        slot = self.players[self.current][index]
        slot.visible = True
        self._update_combos()
        self.flipped = index
        self.phase = "drawn_revealed" if self.held_card else "revealed"
        self._mark_finish()
        self.message = ("Swap the revealed card with your draw, or Discard the draw."
                        if self.held_card else "Swap with the discard, Draw, or End turn.")
        self._offer_four(self.phase)

    def opening_reveal(self, player, index):
        if (self.phase != "setup" or player not in (0, 1) or index not in range(6)
                or self.visible_count(player) >= 2 or (not self.multiplayer and player != 0)):
            raise ValueError("Reveal exactly two of your own cards to start.")
        slot = self.players[player][index]
        if slot.visible:
            raise ValueError("Choose a face-down card to flip.")
        slot.visible = True
        if not self.multiplayer and self.visible_count(0) == 2:
            for other_index in self.rng.sample(range(6), 2):
                self.players[1][other_index].visible = True
        if all(self.visible_count(p) == 2 for p in (0, 1)):
            self.phase = "choose"
            self.current = self.first_player
            self.message = "Your turn: Flip your card, Draw, or Swap with the discard."
        else:
            self.message = "Both players reveal two cards before play starts."

    @property
    def decision_player(self):
        if self.phase in ("guess", "guess_trade"):
            return self.guess_pending["player"]
        if self.phase == "arrange":
            return self.arrange_pending["player"]
        return self.current

    def submit_guess(self, rank=None):
        if self.phase != "guess" or (rank is not None and rank not in range(1, 14)):
            raise ValueError("Choose a card rank or pass on the guess.")
        pending = self.guess_pending
        target = self.players[self.current][pending["target"]]
        correct = rank is not None and rank == target.card.rank
        target.visible = True
        self.flipped = pending["target"]
        self.phase = "drawn_revealed" if self.held_card else "revealed"
        self._update_combos()
        self._mark_finish()
        pending["resume"] = self.phase
        if correct and all(self.guess_trade_targets()):
            self.phase = "guess_trade"
            self.message = "Correct guess! Select your highest and their lowest visible card; Swap."
        else:
            self.last_move = "Beggars: passed." if rank is None else "Beggars: guess missed." if not correct else "Beggars: correct, but the trade is locked."
            self._resume_guess()

    def guess_trade_targets(self):
        if self.guess_pending is None:
            return [], []
        player = self.guess_pending["player"]
        own = [(player, i) for i, slot in enumerate(self.players[player]) if slot.visible]
        other = [(1 - player, i) for i, slot in enumerate(self.players[1 - player]) if slot.visible]
        if not own or not other:
            return [], []
        highest = max(self.table_slot(ref).card.base_points for ref in own)
        lowest = min(self.table_slot(ref).card.base_points for ref in other)
        return ([ref for ref in own if self.table_slot(ref).card.base_points == highest and self.table_slot(ref).card not in self.locked_cards],
                [ref for ref in other if self.table_slot(ref).card.base_points == lowest and self.table_slot(ref).card not in self.locked_cards])

    def guess_trade(self, first, second):
        if self.phase != "guess_trade":
            raise ValueError("There is no guessed-card trade pending.")
        own, other = self.guess_trade_targets()
        if not ((first in own and second in other) or (second in own and first in other)):
            raise ValueError("Choose the guesser's highest and the opponent's lowest eligible visible card.")
        a, b = self.table_slot(first), self.table_slot(second)
        self._put_slot(first, b)
        self._put_slot(second, a)
        self.last_move = "Beggars: correct guess and highest/lowest trade."
        self._update_combos()
        self._mark_finish()
        self._resume_guess()

    def _resume_guess(self):
        self.phase = self.guess_pending["resume"]
        self.guess_pending = None
        self.message = "Continue: Swap with the discard, Draw, or End turn." if self.phase == "revealed" else "Continue: Swap the revealed card with your draw, or Discard."
        self._offer_four(self.phase)

    def arrangement_plan(self, player, rank, columns):
        if len(columns) != 2 or len(set(columns)) != 2 or any(c not in range(3) for c in columns):
            raise ValueError("Choose two distinct columns.")
        layout = self.players[player]
        group = [slot for slot in layout if slot.visible and slot.card.rank == rank]
        if len(group) != 4:
            return None
        rest = [slot for slot in layout if slot not in group]
        destinations = [c + row * 3 for c in sorted(columns) for row in (0, 1)]
        remaining = [i for i in range(6) if i not in destinations]
        best, movement = None, 7
        for ordered in permutations(group):
            for leftover in permutations(rest):
                plan = [None] * 6
                for i, slot in zip(destinations + remaining, ordered + leftover):
                    plan[i] = Slot(slot.card, slot.visible)
                if any(old.card in self.locked_cards and plan[i].card != old.card for i, old in enumerate(layout)):
                    continue
                moves = sum(old.card != plan[i].card for i, old in enumerate(layout))
                if moves < movement:
                    best, movement = plan, moves
        return best

    def _offer_four(self, resume, finish=False):
        if not self.rules.four_kind:
            return False
        for player in (self.current, 1 - self.current):
            counts = Counter(slot.card.rank for slot in self.players[player] if slot.visible)
            for rank, count in counts.items():
                if count == 4 and rank not in self.four_offered[player]:
                    if not any(self.arrangement_plan(player, rank, cols) for cols in combinations(range(3), 2)):
                        continue
                    self.four_offered[player].add(rank)
                    self.arrange_pending = {"player": player, "rank": rank, "resume": resume, "finish": finish}
                    self.phase = "arrange"
                    self.message = "4 of a Kind: choose two columns, or keep the layout."
                    return True
        return False

    def arrange_four(self, columns=None):
        if self.phase != "arrange":
            raise ValueError("There is no four-of-a-kind rearrangement pending.")
        pending = self.arrange_pending
        player = pending["player"]
        if columns is not None:
            plan = self.arrangement_plan(player, pending["rank"], columns)
            if plan is None:
                raise ValueError("This rearrangement would move a locked card.")
            flipped_card = self.players[self.current][self.flipped].card if self.flipped is not None else None
            self.players[player] = plan
            if player == self.current and flipped_card is not None:
                self.flipped = next(i for i, slot in enumerate(plan) if slot.card == flipped_card)
            self.last_move = "Four matching cards were arranged into two columns."
        self.phase = pending["resume"]
        self.arrange_pending = None
        self._update_combos()
        self._mark_finish()
        if self._offer_four(self.phase, pending["finish"]):
            return
        if pending["finish"]:
            self._finish_turn()
        else:
            self.message = "Continue: Swap, Draw, or End turn." if self.phase == "revealed" else "Continue: Swap or Discard."

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
                        "Swap your draw with a face-up card, Flip a hidden card, or Discard.")

    def targets(self):
        if self.phase == "choose":
            indexes = range(6)
        elif self.phase == "drawn":
            indexes = [i for i, slot in enumerate(self.players[self.current]) if slot.visible]
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
        if self.phase not in ("drawn", "drawn_revealed"):
            raise ValueError("Draw a card before discarding it.")
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
        if self._offer_four(self.phase, finish=True):
            return
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
        if self._offer_four("bonus", finish=True):
            return
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
        return card.base_points + (partner.card.base_points if partner.visible else 0)

    def opponent_turn(self):
        """A basic bot that only evaluates public cards and its actual revealed draw."""
        initial_turns = self.turns
        for _ in range(100):
            if self.decision_player != 1 or self.phase == "over":
                return
            self._opponent_step()
            if self.turns != initial_turns:
                return

    def _opponent_step(self):
        if self.phase == "guess":
            # A rank guess uses no knowledge of the selected hidden card.
            self.submit_guess(self.rng.randrange(1, 14))
            return
        if self.phase == "guess_trade":
            own, other = self.guess_trade_targets()
            self.guess_trade(self.rng.choice(own), self.rng.choice(other))
            return
        if self.phase == "arrange":
            pending = self.arrange_pending
            player, rank = pending["player"], pending["rank"]
            original = self.players[player]
            best, value = None, self.score(player, True)
            for columns in combinations(range(3), 2):
                plan = self.arrangement_plan(player, rank, columns)
                if plan:
                    self.players[player] = plan
                    candidate = self.score(player, True)
                    self.players[player] = original
                    if candidate < value:
                        best, value = columns, candidate
            self.arrange_four(best)
            return
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
        if self.phase == "choose":
            hidden = [i for i, slot in enumerate(self.players[1]) if not slot.visible]
            if hidden:
                self.reveal(self.rng.choice(hidden))
            else:
                self.draw()
            return
        if self.phase == "revealed":
            targets = self.targets()
            if targets:
                index = targets[0]
                if self._visible_column(1, index, self.discard_pile[-1]) < self._visible_column(1, index):
                    self.swap(index)
                    return
                if self._visible_column(1, index) > 4:
                    self.draw()
                    return
            self.end_turn()
        elif self.phase == "drawn_revealed":
            targets = self.targets()
            if targets and self._visible_column(1, targets[0], self.held_card) < self._visible_column(1, targets[0]):
                self.swap(targets[0])
            else:
                self.discard()
        elif self.phase == "drawn":
            hidden = [i for i, slot in enumerate(self.players[1]) if not slot.visible]
            if hidden:
                self.reveal(self.rng.choice(hidden))
                return
            targets = self.targets()
            if targets:
                best = max(targets, key=lambda i: self._visible_column(1, i) - self._visible_column(1, i, self.held_card))
                if self._visible_column(1, best, self.held_card) < self._visible_column(1, best):
                    self.swap(best)
                    return
            self.discard()


def run():
    import uvicorn
    uvicorn.run("server:app", host="0.0.0.0", port=8000, workers=1)


if __name__ == "__main__":
    run()
