"""UI-independent rules and turn state for six-card Golf."""
from dataclasses import dataclass, replace
from itertools import combinations, permutations
from collections import Counter
from copy import copy
import random
from scoring import (score_adjustments, column_score, opponent_adjustment, color_multiplier, scoring_rule_keys,
                     scoring_subrule_keys,
                     angel_divisor, angel_multiplier, ANGEL_RANKS, POISON_POINTS)


@dataclass(frozen=True)
class Card:
    """Immutable face rank/suit; scoring effects never change a card's base points."""
    rank: int
    suit: str
    deck: int = 0

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
    royal_pairs: bool = False
    angel_numbers: bool = False
    king_queen: bool = False
    holdem: bool = False
    v10: bool = False
    tricky_straights: bool = False
    ripped_five: bool = False
    roman_fives: bool = False
    beggars: bool = False
    four_kind: bool = False
    poisoned_card: bool = False
    suited_rows: bool = False
    all_in_color: bool = False


RULE_OPTIONS = [
    ("royal_pairs", "J-J / Q-Q: bonus swap"),
    ("angel_numbers", "Angel numbers"),
    ("king_queen", "King-Queen: color scoring"),
    ("holdem", "Hold 'em"),
    ("v10", "V10 engine"),
    ("tricky_straights", "Tricky straights"),
    ("ripped_five", "The ripped 5"),
    ("roman_fives", "V2"),
    ("beggars", "Beggars Will be Choosers"),
    ("four_kind", "4 of a Kind"),
    ("poisoned_card", "Poisoned Card"),
    ("suited_rows", "Suited rows"),
    ("all_in_color", "All in red/black"),
]

# the parts each rule's activations are broken into in the stats ("rule:part"
# keys); a rule not listed here has none
SUBRULE_OPTIONS = {
    "royal_pairs": [("queens", "Queen-Queen"), ("jacks", "Jack-Jack")],
    "angel_numbers": [("666", "666"), ("777", "777"), ("888", "888"), ("999", "999")],
    "king_queen": [("same", "Same color"), ("mixed", "Different colors")],
    "holdem": [("flush", "Flush"), ("straight", "Straight"), ("full_house", "Full house"), ("four_kind", "Four of a kind")],
    "tricky_straights": [("up", "Ascending"), ("down", "Descending")],
    "beggars": [("right", "Guessed right"), ("wrong", "Guessed wrong"), ("passed", "Passed")],
    "four_kind": [("moved", "Moved into columns"), ("kept", "Left in place")],
    "suited_rows": [("red", "Red row"), ("black", "Black row")],
    "all_in_color": [("red", "All red"), ("black", "All black")],
}

# 666, 777, 888 and 999 were four rules before they became Angel numbers; saved
# games, results and settings that name them read as Angel numbers.
LEGACY_RULE_KEYS = {'devils_row': 'angel_numbers', 'gamblers_row': 'angel_numbers',
                    'crazy_eights': 'angel_numbers', 'angels_row': 'angel_numbers'}


def upgrade_rule_values(values):
    """A rules dict with retired keys folded into the rule that replaced them."""
    upgraded = {}
    for key, value in values.items():
        key = LEGACY_RULE_KEYS.get(key, key)
        upgraded[key] = bool(upgraded.get(key)) or value
    return upgraded


def upgrade_rule_keys(keys):
    """A list of rule keys with retired keys renamed, each kept once, in order."""
    return list(dict.fromkeys(LEGACY_RULE_KEYS.get(key, key) for key in keys))


def upgrade_rule_counts(counts):
    """Per-rule counts with retired keys summed into the rule that replaced them."""
    upgraded = {}
    for key, value in counts.items():
        key = LEGACY_RULE_KEYS.get(key, key)
        upgraded[key] = upgraded.get(key, 0) + value
    return upgraded


def rules_from(values):
    """Rules from a saved dict, including ones saved before a rule was retired."""
    values = upgrade_rule_values(values)
    return Rules(**{key: value for key, value in values.items() if key in Rules.__dataclass_fields__})


class GolfGame:
    def __init__(self, seed=None, rules=None, multiplayer=False, first_player=0, player_count=2, turn_order=None,
                 puzzle=False):
        # a puzzle is one hand against Golfbot from a seeded deck: the player always
        # goes first, each side starts with the same two cards face up, and the deck
        # never reshuffles (should it run out, the hand ends there)
        if puzzle:
            player_count, first_player, turn_order, multiplayer = 2, 0, None, False
        elif type(player_count) is not int or not 2 <= player_count <= 32 or first_player not in range(player_count):
            raise ValueError("Choose 2–32 players and an existing first player.")
        if player_count > 2 and not multiplayer:
            raise ValueError("Many-player games require human players.")
        self.player_count = player_count
        self.turn_order = list(range(player_count)) if turn_order is None else list(turn_order)
        if sorted(self.turn_order) != list(range(player_count)):
            raise ValueError("Turn order must contain each player once.")
        self.multiplayer = multiplayer
        self.puzzle = puzzle
        self.first_player = first_player
        self.rules = replace(rules) if rules else Rules()
        self.rng = random.Random(seed)
        self.deck_count = 1 if player_count == 2 else 1 + player_count // 3
        self.draw_pile = [Card(rank, suit, deck) for deck in range(self.deck_count) for suit in "SHDC" for rank in range(1, 14)]
        self.rng.shuffle(self.draw_pile)
        self.players = [[Slot(self.draw_pile.pop()) for _ in range(6)] for _ in range(player_count)]
        self.discard_pile = [self.draw_pile.pop()]
        self.current = first_player
        self.phase = "setup"
        self.flipped = None
        self.held_card = None
        self.finisher = None
        self.final_player = None
        self.is_final_turn = False
        self.final_turn_queue = None
        self.turns = 0
        self.bonus_remaining = 0
        self.used_pairs = set()
        self.used_bonus_cards = set()
        self.activated_rules = [set() for _ in self.players]
        # which way each rule fired ("rule:part" keys, as SUBRULE_OPTIONS names them)
        self.activated_subrules = [set() for _ in self.players]
        self.scoring_reveal = False
        self.final_bonus_queue = []
        # Angel numbers each player has earned (6, 7, 8, 9); kept if the row breaks
        self.angels_earned = [set() for _ in self.players]
        self.four_offered = [set() for _ in self.players]
        self.arrange_pending = None
        self.guess_pending = None
        # the latest Beggars guess, for the table to report: who guessed what at whose card
        self.last_guess = None
        self.message = "Select one of your cards and Flip. Reveal two to start."
        self.last_move = "Reveal two cards each to start."
        if puzzle:
            # the opening cards are part of the puzzle: the same two each, every attempt
            for hand in self.players:
                for index in self.rng.sample(range(6), 2):
                    hand[index].visible = True
            self._record_scoring_effects()
            self.phase = "choose"
            self.message = "Your turn: Flip your card, Draw, or Swap with the discard."
            self.last_move = "The puzzle is dealt."

    def set_rule(self, key, enabled):
        if self.phase != "setup" or key not in {key for key, _ in RULE_OPTIONS}:
            raise ValueError("Choose rules during the opening reveal, before the game starts.")
        setattr(self.rules, key, bool(enabled))
        self.angels_earned = [set() for _ in self.players]
        self.activated_rules = [set() for _ in self.players]
        self.activated_subrules = [set() for _ in self.players]
        self._update_combos()

    def visible_count(self, player):
        return sum(slot.visible for slot in self.players[player])

    def next_player(self, player):
        return self.turn_order[(self.turn_order.index(player) + 1) % self.player_count]

    def players_from(self, player):
        index = self.turn_order.index(player)
        return self.turn_order[index:] + self.turn_order[:index]

    def opponents(self, player):
        return [p for p in self.turn_order if p != player]

    def score_divisor(self, player):
        divisor = score_adjustments(self.players[player], self.rules)[1]
        return divisor * angel_divisor(self.rules, self.angels_earned[player])

    def score(self, player, visible_only=False):
        total = column_score(self.players[player], self.rules, visible_only)
        adjustment, divisor = score_adjustments(self.players[player], self.rules, visible_only)
        total += adjustment
        total += sum(opponent_adjustment(self.players[p], self.rules, visible_only) for p in self.opponents(player))
        if self.rules.poisoned_card and self.finisher == player:
            total += POISON_POINTS
        if not visible_only:
            divisor *= angel_divisor(self.rules, self.angels_earned[player])
            for other in self.opponents(player):
                total *= angel_multiplier(self.rules, self.angels_earned[other])
                total *= color_multiplier(self.players[other], self.rules)
            total = (total + divisor - 1) // divisor
        return total

    def _record_scoring_effects(self):
        for player, layout in enumerate(self.players):
            self.activated_rules[player].update(scoring_rule_keys(layout, self.rules))
            self.activated_subrules[player].update(scoring_subrule_keys(layout, self.rules))

    def _update_combos(self):
        for player, layout in enumerate(self.players):
            for row in (layout[:3], layout[3:]):
                if not all(slot.visible for slot in row):
                    continue
                rank = row[0].card.rank
                if self.rules.angel_numbers and rank in ANGEL_RANKS and all(slot.card.rank == rank for slot in row):
                    self.angels_earned[player].add(rank)
                    self.activated_rules[player].add("angel_numbers")
                    self.activated_subrules[player].add(f"angel_numbers:{str(rank) * 3}")
        self._record_scoring_effects()

    def _mark_finish(self):
        if self.finisher is None:
            for player in self.players_from(self.current):
                if self.visible_count(player) == 6:
                    self.finisher = player
                    self.final_turn_queue = ([] if self.is_final_turn else
                                             [p for p in self.players_from(self.next_player(self.current)) if p != player])
                    self.final_player = self.final_turn_queue[0] if self.final_turn_queue else self.next_player(player)
                    if self.rules.poisoned_card:
                        self.activated_rules[player].add("poisoned_card")
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
            highest = [max((self.players[p][i].card.base_points for i in visible[p]), default=-3) for p in range(self.player_count)]
            leaders = [p for p, value in enumerate(highest) if value == max(highest)]
            other = leaders[0]
            # at a table of three or more, only the next player in turn can be the one to guess
            in_line = self.player_count <= 2 or other == self.next_player(self.current)
            if len(leaders) == 1 and other != self.current and highest[other] > -3 and in_line:
                self.guess_pending = {"player": other, "target": index, "phase": self.phase}
                self.activated_rules[other].add("beggars")
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
        if (self.phase != "setup" or player not in range(self.player_count) or index not in range(6)
                or self.visible_count(player) >= 2 or (not self.multiplayer and player != 0)):
            raise ValueError("Reveal exactly two of your own cards to start.")
        slot = self.players[player][index]
        if slot.visible:
            raise ValueError("Choose a face-down card to flip.")
        slot.visible = True
        self._record_scoring_effects()
        if not self.multiplayer and self.visible_count(0) == 2:
            for other_index in self.rng.sample(range(6), 2):
                self.players[1][other_index].visible = True
        if all(self.visible_count(p) == 2 for p in range(self.player_count)):
            self.phase = "choose"
            self.current = self.first_player
            self.message = "Your turn: Flip your card, Draw, or Swap with the discard."
        else:
            self.message = "Both players reveal two cards before play starts."

    @property
    def next_up(self):
        """Who plays after the turn in progress, or None when the round ends with it."""
        if self.phase in ("setup", "over"):
            return None
        if self.finisher is not None and self.final_turn_queue is not None:
            return self.final_turn_queue[0] if self.final_turn_queue else None
        if self.is_final_turn:
            return None
        return self.final_player if self.final_player is not None else self.next_player(self.current)

    @property
    def up_in(self):
        """For each seat, how many turns away its next turn is (1 = up next), or None if it
        is playing now or will not play again this game."""
        waits = [None] * self.player_count
        if self.phase in ("setup", "over"):
            return waits
        if self.finisher is not None and self.final_turn_queue is not None:
            upcoming = list(self.final_turn_queue)
        elif self.is_final_turn:
            upcoming = []
        elif self.final_player is not None:
            upcoming = [self.final_player]
        else:
            upcoming = self.players_from(self.next_player(self.current))[:-1]
        for wait, player in enumerate(upcoming, 1):
            waits[player] = wait
        return waits

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
        self.activated_subrules[pending["player"]].add(
            "beggars:" + ("passed" if rank is None else "right" if correct else "wrong"))
        target.visible = True
        self.last_guess = {"player": pending["player"], "owner": self.current, "target": pending["target"],
                           "rank": rank, "card": target.card.rank, "correct": correct,
                           "count": (getattr(self, "last_guess", None) or {}).get("count", 0) + 1}
        self.flipped = pending["target"]
        self.phase = "drawn_revealed" if self.held_card else "revealed"
        self._update_combos()
        self._mark_finish()
        pending["resume"] = self.phase
        if correct and all(self.guess_trade_targets()):
            self.phase = "guess_trade"
            self.message = "Correct guess! Select your highest and their lowest visible card; Swap."
        else:
            self.last_move = "Beggars: passed." if rank is None else "Beggars: guess missed." if not correct else "Beggars: correct, but there was nothing to trade."
            self._resume_guess()

    def guess_trade_targets(self):
        if self.guess_pending is None:
            return [], []
        player = self.guess_pending["player"]
        own = [(player, i) for i, slot in enumerate(self.players[player]) if slot.visible]
        other = [(self.current, i) for i, slot in enumerate(self.players[self.current]) if slot.visible]
        if not own or not other:
            return [], []
        highest = max(self.table_slot(ref).card.base_points for ref in own)
        lowest = min(self.table_slot(ref).card.base_points for ref in other)
        return ([ref for ref in own if self.table_slot(ref).card.base_points == highest],
                [ref for ref in other if self.table_slot(ref).card.base_points == lowest])

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
        matching = [slot for slot in layout if slot.visible and slot.card.rank == rank]
        if len(matching) < 4:
            return None
        destinations = [c + row * 3 for c in sorted(columns) for row in (0, 1)]
        remaining = [i for i in range(6) if i not in destinations]
        best, movement = None, 7
        for group in combinations(matching, 4):
            rest = [slot for slot in layout if slot not in group]
            for ordered in permutations(group):
                for leftover in permutations(rest):
                    plan = [None] * 6
                    for i, slot in zip(destinations + remaining, ordered + leftover):
                        plan[i] = Slot(slot.card, slot.visible)
                    moves = sum(old.card != plan[i].card for i, old in enumerate(layout))
                    if moves < movement:
                        best, movement = plan, moves
        return best

    def _offer_four(self, resume, finish=False):
        if not self.rules.four_kind:
            return False
        for player in self.players_from(self.current):
            counts = Counter(slot.card.rank for slot in self.players[player] if slot.visible)
            for rank, count in counts.items():
                if count >= 4 and rank not in self.four_offered[player]:
                    if not any(self.arrangement_plan(player, rank, cols) for cols in combinations(range(3), 2)):
                        continue
                    self.four_offered[player].add(rank)
                    self.activated_rules[player].add("four_kind")
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
        self.activated_subrules[player].add("four_kind:" + ("kept" if columns is None else "moved"))
        if columns is not None:
            plan = self.arrangement_plan(player, pending["rank"], columns)
            if plan is None:
                raise ValueError("Those columns can't hold the four matching cards.")
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
        if not self.draw_pile and getattr(self, "puzzle", False):
            raise ValueError("The deck is empty.")
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
            # A go-fish draw may replace any of your cards, face up or face down.
            indexes = range(6)
        elif self.phase in ("revealed", "drawn_revealed"):
            indexes = [self.flipped]
        else:
            indexes = []
        return list(indexes)

    def swap(self, index, source=None):
        expected = "held" if self.held_card else "discard"
        if index not in self.targets() or source not in (None, expected):
            raise ValueError("Select an eligible card from your own layout.")
        incoming = self.held_card if self.held_card else self.discard_pile.pop()
        outgoing = self.players[self.current][index].card
        self.players[self.current][index] = Slot(incoming, True)
        self.held_card = None
        self.discard_pile.append(outgoing)
        who = f"Player {self.current + 1}"
        self.last_move = f"{who} swapped {outgoing.label}{outgoing.suit} for {incoming.label}{incoming.suit}."
        self._finish_turn()

    def preview(self, index=None, refs=None):
        """A copy of the table as it would stand once a swap (or a table trade) is played.

        Only what the face-up cards prove is worked out: combos and who
        has gone out. The turn does not advance and nothing hidden is turned
        over, so scoring the copy from its face-up cards gives nothing away.
        With neither argument the copy is the table as it is (a discard).
        """
        sim = copy(self)
        sim.players = [list(layout) for layout in self.players]
        sim.draw_pile, sim.discard_pile = list(self.draw_pile), list(self.discard_pile)
        sim.angels_earned = [set(ranks) for ranks in self.angels_earned]
        sim.activated_rules = [set(keys) for keys in self.activated_rules]
        sim.activated_subrules = [set(keys) for keys in self.activated_subrules]
        if refs is not None:
            first, second = refs
            if self.phase not in ("bonus", "guess_trade") or first == second:
                raise ValueError("Select two different table cards.")
            a, b = sim.table_slot(first), sim.table_slot(second)
            sim._put_slot(first, b)
            sim._put_slot(second, a)
        elif index is not None:
            if index not in self.targets():
                raise ValueError("Select an eligible card from your own layout.")
            incoming = self.held_card if self.held_card else self.discard_pile[-1]
            sim.players[self.current][index] = Slot(incoming, True)
        sim._update_combos()
        sim._mark_finish()
        return sim

    def discard(self):
        if self.phase not in ("drawn", "drawn_revealed"):
            raise ValueError("Draw a card before discarding it.")
        card = self.held_card
        self.discard_pile.append(card)
        self.held_card = None
        who = f"Player {self.current + 1}"
        self.last_move = f"{who} discarded {card.label}{card.suit}."
        self._finish_turn()

    def end_turn(self):
        if self.phase != "revealed":
            raise ValueError("You may end without another action only after flipping your own card.")
        card = self.players[self.current][self.flipped].card
        who = f"Player {self.current + 1}"
        self.last_move = f"{who} revealed {card.label}{card.suit} and ended the turn."
        self._finish_turn()

    def _new_bonuses(self, player):
        count = 0
        for column in range(3):
            first, second = self.players[player][column], self.players[player][column + 3]
            enabled = self.rules.royal_pairs and first.card.rank in (11, 12)
            if first.visible and second.visible and enabled and first.card.rank == second.card.rank:
                pair = frozenset((first.card, second.card))
                if not pair & self.used_bonus_cards:
                    self.used_pairs.add(pair)
                    self.used_bonus_cards.update(pair)
                    self.activated_rules[player].add("royal_pairs")
                    self.activated_subrules[player].add("royal_pairs:" + ("queens" if first.card.rank == 12 else "jacks"))
                    count += 1
        return count

    def _collect_bonuses(self):
        self.bonus_remaining += self._new_bonuses(self.current)

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
        refs = [(player, index) for player in range(self.player_count) for index in range(6)]
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
        self.last_move = f"Player {self.current + 1} used a bonus swap."
        if self.scoring_reveal:
            self._resolve_scoring_reveal()
            return
        # Visibility follows cards into layouts. Piles use their own orientation.
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
        if getattr(self, "puzzle", False) and not self.draw_pile and self.finisher is None:
            # the deck is spent: the puzzle ends here, every card turned up and scored
            self.finisher = None
            self.scoring_reveal = True
            self._resolve_scoring_reveal()
            return
        if self.finisher is not None and self.final_turn_queue is not None:
            if self.final_turn_queue:
                self.current = self.final_turn_queue.pop(0)
                self.is_final_turn = True
                self.phase = "choose"
                self.message = "Final turn: Flip, Draw, or Swap."
                return
            self.scoring_reveal = True
            self._resolve_scoring_reveal()
            return
        if self.is_final_turn:
            self.scoring_reveal = True
            self._resolve_scoring_reveal()
            return
        self.current = self.final_player if self.final_player is not None else self.next_player(self.current)
        self.is_final_turn = self.current == self.final_player
        self.phase = "choose"
        self.message = "Your turn: Flip your card, Draw, or Swap with the discard." if self.current == 0 else "Opponent is thinking..."
        if self.current == self.final_player:
            self.message = "Your FINAL turn: Flip, Draw, or Swap." if self.current == 0 else "Opponent's final turn..."

    def _resolve_scoring_reveal(self):
        # Reserve both players' earned swaps before either can break a pair.
        # Only Q-Q/J-J activate here; scoring reveals do not earn Angel numbers or Poison.
        for layout in self.players:
            for slot in layout:
                slot.visible = True
        self._record_scoring_effects()
        for player in self.players_from(self.current):
            self.final_bonus_queue.extend([player] * self._new_bonuses(player))
        if self.final_bonus_queue:
            self.current = self.final_bonus_queue.pop(0)
            self.bonus_remaining = 1
            self.phase = "bonus"
            self.message = "Final reveal bonus: select any two table cards and Swap."
            return
        self.phase = "over"
        scores = [self.score(p) for p in range(self.player_count)]
        winners = [p for p, score in enumerate(scores) if score == min(scores)]
        self.message = f"Player {winners[0] + 1} wins." if len(winners) == 1 else "It's a draw!"

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
        """Basic baseline for rules stress tests; live solo games use bot.py search."""
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
