"""Rule puzzles: one move, one rule, and the lowest score you can get from it.

A rule puzzle is a table dealt for the purpose (see make_deal): your six cards with
some of them face up (two at least), a discard, and PuzzleBot's hand face up beside
them. One rule is in play, and the cards are set out so that it matters. You make ONE
move (any a turn allows: swap with the discard, flip a card first, go fish), PuzzleBot
makes none, and then every card is turned up and scored. The aim is the lowest score.

Since a move may turn up or draw a card nobody has seen, a move is judged on the score
it gives ON AVERAGE, over every card that could have come (see Solver): a lucky draw
does not make a poor move a good one, nor an unlucky one spoil the best. A puzzle is
got right (correct) by making the best play, every decision of the turn; a player's
accuracy is the share of their puzzles they got right.

Each puzzle made is checked (see generate): it has one best first move, clear of the
next, and its rule is what makes that move the best (or worth what it is).
"""
import random
import time
from collections import Counter
from itertools import combinations, permutations
from math import perm

# the rules a puzzle may be about (the others need an opponent who moves)
RULES = ("royal_pairs", "angel_numbers", "king_queen", "holdem", "v10", "tricky_straights",
         "ripped_five", "roman_fives", "suited_rows", "all_in_color")
BP = (0, 1, -2, 3, 4, 5, 6, 7, 8, 9, 10, 10, 10, 0)  # base Golf points by rank
ROWS = ((0, 1, 2), (3, 4, 5))
VS = ((0, 4, 2), (3, 1, 5))
DECK = tuple((rank, suit) for suit in "SHDC" for rank in range(1, 14))
POSITIONS = ("top left", "top middle", "top right", "bottom left", "bottom middle", "bottom right")
SUIT_SIGNS = {"S": "♠", "H": "♥", "D": "♦", "C": "♣"}
SAMPLES = 320  # the hidden cards a move is averaged over, when they cannot all be counted
SPARES = 3
TOLERANCE = 0.02  # moves this close (in points on average) are as good as each other
MIN_GAP = 0.4  # how far the best first move must stand clear of the next
MIN_RULE = 1.0  # how much the rule must be worth to the best move, in points on average
WEEK = 7 * 24 * 3600


def red(card):
    return card[1] in "HD"


def card_name(card):
    return {1: "A", 11: "J", 12: "Q", 13: "K"}.get(card[0], str(card[0])) + SUIT_SIGNS[card[1]]


def _direction(ranks):
    for ace in (1, 14):
        a, b, c = (ace if rank == 1 else rank for rank in ranks)
        if b - a == 1 and c - b == 1:
            return 1
        if b - a == -1 and c - b == -1:
            return -1
    return 0


def _poker(cards):
    """Whether five of the six make a flush, a straight, a full house or four of a kind."""
    suits = [card[1] for card in cards]
    if max(suits.count(suit) for suit in "SHDC") >= 5:
        return True
    ranks = [card[0] for card in cards]
    counts = sorted(Counter(ranks).values(), reverse=True)
    if counts[0] >= 4 or (counts[0] == 3 and counts[1] >= 2):
        return True
    have = set(ranks)
    return {1, 10, 11, 12, 13} <= have or any(all(rank in have for rank in range(low, low + 5)) for low in range(1, 10))


def hand_score(cards, rule=None, earned=()):
    """A hand's final score with one rule in play (or none), every card counted: what
    GolfGame.score gives a hand that no other hand's cards bear on. `earned` is the
    Angel numbers it earned along the way (they stay, should the row break)."""
    total = 0
    if rule == "ripped_five":
        canceled = {i for column in (0, 1, 2) if cards[column][0] == cards[column + 3][0] for i in (column, column + 3)}
        diamond = next((i for i in range(6) if cards[i] == (5, "D")), None)
        if diamond is not None:
            other = next((i for i in range(6) if i not in canceled and i // 3 != diamond // 3 and cards[i][0] == 5), None)
            if other is not None:
                canceled.update((diamond, other))
        total = sum(BP[cards[i][0]] for i in range(6) if i not in canceled)
    else:
        royal = rule == "king_queen"
        for column in (0, 1, 2):
            first, second = cards[column], cards[column + 3]
            if first[0] == second[0]:
                continue
            if royal and first[0] + second[0] == 25:  # (a King and a Queen)
                total += 5 if (first[1] in "HD") == (second[1] in "HD") else 15
            else:
                total += BP[first[0]] + BP[second[0]]
    divisor = 1
    if rule == "holdem":
        if _poker(cards):
            total -= 5
    elif rule == "tricky_straights":
        for row in ROWS:
            if _direction([cards[i][0] for i in row]) == -1:
                total -= BP[cards[row[2]][0]]
    elif rule == "suited_rows":
        for a, b, c in ROWS:
            suit = cards[a][1]
            if suit in "SC" and cards[b][1] == suit and cards[c][1] == suit:
                total -= BP[cards[b][0]]
    elif rule == "roman_fives":
        # (V2 stacks: each V that adds up to 10 halves the score)
        divisor = 2 ** sum(BP[cards[a][0]] + BP[cards[b][0]] + BP[cards[c][0]] == 10 for a, b, c in VS)
    elif rule == "v10":
        if any({cards[a][0], cards[b][0], cards[c][0]} == {10, 11, 12} for a, b, c in VS):
            divisor = 5
    elif rule == "all_in_color":
        if all(card[1] in "SC" for card in cards):
            divisor = 2
    elif rule == "angel_numbers":
        for rank in (7, 9):
            if rank in earned or any(all(cards[i][0] == rank for i in row) for row in ROWS):
                divisor *= rank
    return (total + divisor - 1) // divisor


def describe(action, node, discard=None, held=None, hidden=()):
    """A move in words, as the result tells it ("Swap the discard (7♣) with your top left card")."""
    kind = action[0]
    if kind == "bonus":
        names = []
        for owner, index in action[1]:
            names.append("the discard" if owner == "discard" else "the top of the go-fish pile" if owner == "draw"
                         else f"{'your' if owner == 0 else 'PuzzleBot’s'} {POSITIONS[index]} card")
        return f"Bonus swap: {names[0]} with {names[1]}" if names[0] != names[1] else "Bonus swap: nothing that changes your hand"
    if kind == "pass":
        return "Bonus swap: nothing that changes your hand"
    if node == "choose":
        if kind == "swap":
            return f"Swap the discard ({card_name(discard)}) with your {'face-down ' if action[1] in hidden else ''}{POSITIONS[action[1]]} card"
        return f"Flip your {POSITIONS[action[1]]} card first" if kind == "flip" else "Go fish"
    if node == "revealed":
        return (f"Swap the card you flipped with the discard ({card_name(discard)})" if kind == "swap"
                else "Keep the card you flipped" if kind == "end" else "Go fish after flipping")
    if node == "drawn":
        if kind == "swap":
            return f"Swap your draw ({card_name(held)}) with your {'face-down ' if action[1] in hidden else ''}{POSITIONS[action[1]]} card"
        return f"Flip your {POSITIONS[action[1]]} card before deciding" if kind == "flip" else f"Discard your draw ({card_name(held)})"
    return (f"Swap the card you flipped with your draw ({card_name(held)})" if kind == "swap"
            else f"Discard your draw ({card_name(held)}) and keep the card you flipped")


class Solver:
    """What each move is worth, in points on average, from what the table shows.

    The cards nobody has seen (your face-down cards and the go-fish pile) are equally
    likely to be any of the unseen ones. A move that turns one up is worth the average,
    over each card it could be, of the best that can be done once it shows. Where the
    hidden cards left are too many to count every way they could fall, the same
    `samples` ways are used for every move, so moves are compared like for like."""

    def __init__(self, hand, up, opp, discard, rule, seed=0, samples=SAMPLES, memo=None):
        self.rule, self.discard, self.samples = rule, discard, samples
        self.hidden = [i for i in range(6) if i not in up]
        # (only what is face up is read: the hidden cards are not the solver's to know)
        self.base = [hand[i] if i in up else None for i in range(6)]
        seen = {card for card in self.base if card} | set(opp) | {discard}
        self.unseen = [card for card in DECK if card not in seen]
        rng = random.Random(seed)
        self.worlds = [rng.sample(self.unseen, len(self.hidden) + SPARES) for _ in range(samples)]
        self.memo = dict(memo or {})

    def ev(self, assign=(), earned=(), exclude=None):
        """The average final score with the cards in `assign` ((slot, card), ...) in place,
        every other face-up card where it is, and the rest unseen (but for `exclude`)."""
        key = (assign, earned, exclude)
        if key in self.memo:
            return self.memo[key]
        cards = list(self.base)
        taken = {exclude} if exclude else set()
        for slot, card in assign:
            cards[slot] = card
            taken.add(card)
        free = [i for i in self.hidden if cards[i] is None]
        rule, total = self.rule, 0
        pool = [card for card in self.unseen if card not in taken]
        ways = perm(len(pool), len(free))
        if ways <= self.samples:
            for fill in permutations(pool, len(free)):
                for i, card in zip(free, fill):
                    cards[i] = card
                total += hand_score(cards, rule, earned)
            value = total / ways
        else:
            first_spare = len(self.hidden)
            slots = [(n, i) for n, i in enumerate(self.hidden) if cards[i] is None]
            for world in self.worlds:
                spare = first_spare
                for n, i in slots:
                    card = world[n]
                    if card in taken:  # (seen now: the next unseen card stands in for it)
                        while world[spare] in taken:
                            spare += 1
                        card = world[spare]
                        spare += 1
                    cards[i] = card
                total += hand_score(cards, rule, earned)
            value = total / len(self.worlds)
        self.memo[key] = value
        return value

    def place(self, slot, card, earned=()):
        return self.ev(((slot, card),), earned)

    def flip_earned(self, slot, card):
        """The Angel number a flipped card earns by completing its row (kept if the card is then swapped away)."""
        if self.rule != "angel_numbers" or card[0] not in (7, 9):
            return ()
        row = ROWS[slot // 3]
        return (card[0],) if all(i == slot or (self.base[i] and self.base[i][0] == card[0]) for i in row) else ()

    def after_flip(self, slot, card, pick=min, held=None):
        """The moves once `slot` shows `card` (holding `held`, if you went fish first)."""
        earned, keep = self.flip_earned(slot, card), self.place(slot, card)
        if held is not None:
            return {("swap", slot): self.place(slot, held, earned), ("discard",): keep}
        others = [draw for draw in self.unseen if draw != card]
        return {("swap", slot): self.place(slot, self.discard, earned), ("end",): keep,
                ("draw",): sum(pick(self.place(slot, draw, earned), keep) for draw in others) / len(others)}

    def after_draw(self, held, pick=min):
        """The moves holding `held`, drawn before anything else."""
        options = {("discard",): self.ev((), (), held)}
        for slot in range(6):
            options[("swap", slot)] = self.place(slot, held)
        others = [card for card in self.unseen if card != held]
        for slot in self.hidden:
            options[("flip", slot)] = sum(pick(self.after_flip(slot, card, pick, held).values()) for card in others) / len(others)
        return options

    def root(self, pick=min):
        options = {("swap", slot): self.place(slot, self.discard) for slot in range(6)}
        for slot in self.hidden:
            options[("flip", slot)] = sum(pick(self.after_flip(slot, card, pick).values()) for card in self.unseen) / len(self.unseen)
        options[("draw",)] = sum(pick(self.after_draw(card, pick).values()) for card in self.unseen) / len(self.unseen)
        return options

    def options(self, game):
        """The moves at the table as it stands, and what each is worth: (node, {move: value})."""
        phase = game.phase
        held = (game.held_card.rank, game.held_card.suit) if game.held_card else None
        if phase == "choose":
            return phase, getattr(self, "known_root", None) or self.root()
        if phase == "drawn":
            return phase, self.after_draw(held)
        card = game.players[0][game.flipped].card
        return phase, self.after_flip(game.flipped, (card.rank, card.suit), min, held)


class RoyalSolver:
    """The Jack-Jack and Queen-Queen puzzles: every card of yours is face up, so only the
    go-fish pile is unseen. A pair made in a column earns a swap of any two table cards
    (and a pair that swap makes, another); each is worth the best hand it can lead to."""

    def __init__(self, hand, up, opp, discard, rule="royal_pairs", seed=0, samples=SAMPLES, memo=None):
        self.rule, self.discard, self.hidden = rule, discard, []
        self.hand, self.opp = tuple(hand), tuple(opp)
        self.unseen = [card for card in DECK if card not in set(hand) | set(opp) | {discard}]
        self.memo = dict(memo or {})

    @staticmethod
    def new_pairs(own, used):
        """The unused Jack-Jack and Queen-Queen columns in a hand: (how many, the cards used once they are counted)."""
        count = 0
        for column in (0, 1, 2):
            first, second = own[column], own[column + 3]
            if first[0] == second[0] and first[0] in (11, 12) and first not in used and second not in used:
                used = used | {first, second}
                count += 1
        return count, used

    def swaps(self, own, opp, top, pool):
        """Every bonus swap that changes your hand, as (the two table cards, the outcomes it may have):
        an outcome is (chance, your hand, PuzzleBot's, the discard, the unseen cards)."""
        found = []
        for a, b in combinations(range(6), 2):
            hand = list(own)
            hand[a], hand[b] = hand[b], hand[a]
            found.append((((0, a), (0, b)), [(1, tuple(hand), opp, top, pool)]))
        for a in range(6):
            for b in range(6):
                hand, other = list(own), list(opp)
                hand[a], other[b] = other[b], hand[a]
                found.append((((0, a), (1, b)), [(1, tuple(hand), tuple(other), top, pool)]))
            hand = list(own)
            hand[a] = top
            found.append((((0, a), ("discard", None)), [(1, tuple(hand), opp, own[a], pool)]))
            if pool:
                outcomes = []
                for card in pool:
                    hand = list(own)
                    hand[a] = card
                    outcomes.append((1 / len(pool), tuple(hand), opp, top, tuple(other for other in pool if other != card)))
                found.append((((0, a), ("draw", None)), outcomes))
        return found

    def value(self, own, opp, top, pool, used, remaining, pick=min, depth=0):
        """The hand's worth with `remaining` bonus swaps still to take (after any just earned)."""
        earned, used = self.new_pairs(own, used)
        remaining += earned
        if remaining <= 0 or depth >= 3:
            return hand_score(own)
        return pick(self.bonus_options(own, opp, top, pool, used, remaining, pick, depth).values())

    def bonus_options(self, own, opp, top, pool, used, remaining, pick=min, depth=0):
        key = (own, opp, top, pool, frozenset(used), remaining, pick is min)
        if key not in self.memo:
            # (a swap that leaves your hand as it is, PuzzleBot's cards among themselves, say)
            options = {("pass",): self.value(own, opp, top, pool, used, remaining - 1, pick, depth + 1)}
            for refs, outcomes in self.swaps(own, opp, top, pool):
                options[("bonus", refs)] = sum(chance * self.value(hand, other, discard, left, used, remaining - 1, pick, depth + 1)
                                               for chance, hand, other, discard, left in outcomes)
            self.memo[key] = options
        return self.memo[key]

    def settled(self, own, top, pool, pick=min):
        """A hand's worth once the turn's own move is made (any pair it made earns its swap)."""
        return self.value(own, self.opp, top, pool, frozenset(), 0, pick)

    def after_draw(self, held, pick=min):
        pool = tuple(card for card in self.unseen if card != held)
        options = {("discard",): self.settled(self.hand, held, pool, pick)}
        for slot in range(6):
            hand = list(self.hand)
            hand[slot] = held
            options[("swap", slot)] = self.settled(tuple(hand), self.hand[slot], pool, pick)
        return options

    def root(self, pick=min):
        pool, options = tuple(self.unseen), {}
        for slot in range(6):
            hand = list(self.hand)
            hand[slot] = self.discard
            options[("swap", slot)] = self.settled(tuple(hand), self.hand[slot], pool, pick)
        options[("draw",)] = sum(pick(self.after_draw(card, pick).values()) for card in self.unseen) / len(self.unseen)
        return options

    def options(self, game):
        phase = game.phase
        if phase == "choose":
            return phase, getattr(self, "known_root", None) or self.root()
        if phase == "drawn":
            return phase, self.after_draw((game.held_card.rank, game.held_card.suit))
        # a bonus swap: the table as it stands (every card of both hands is face up)
        own = tuple((slot.card.rank, slot.card.suit) for slot in game.players[0])
        opp = tuple((slot.card.rank, slot.card.suit) for slot in game.players[1])
        top = (game.discard_pile[-1].rank, game.discard_pile[-1].suit)
        pool = tuple(card for card in self.unseen if card not in set(own) | set(opp) | {top})
        used = frozenset((card.rank, card.suit) for card in game.used_bonus_cards)
        return phase, self.bonus_options(own, opp, top, pool, used, game.bonus_remaining)


def solver_for(spec, memo=None):
    kind = RoyalSolver if spec["rule"] == "royal_pairs" else Solver
    solver = kind(spec["hand"], set(spec["up"]), spec["opp"], spec["discard"], spec["rule"], spec["seed"],
                spec.get("samples", SAMPLES), memo if memo is not None else spec.get("memo"))
    solver.known_root = spec.get("root")  # (worked out when the puzzle was made)
    return solver


def step(solver, game, action, index=None, refs=None):
    """A move about to be made at a puzzle's table, marked: what it is worth against the
    best there is at that point ({"loss", "chosen", "best", ...}), or None if it is not one to mark."""
    node, options = solver.options(game)
    key = action_key(action, index, refs)
    if key not in options:
        if ("pass",) not in options or key[0] != "bonus":
            return None
        key = ("pass",)
    low = min(options.values())
    best = min(options, key=options.get)
    held = (game.held_card.rank, game.held_card.suit) if game.held_card else None
    top = game.discard_pile[-1]
    words = lambda move: describe(move, node, (top.rank, top.suit), held, solver.hidden)
    return {"node": node, "loss": max(0.0, options[key] - low), "chosen": words(key), "best": words(best),
            "value": round(options[key], 1), "best_value": round(low, 1)}


def action_key(action, index=None, refs=None):
    """A table move ("swap", "flip", "draw", "discard", "end_turn") as the solver names it."""
    if refs is not None:
        own = sorted((tuple(ref) for ref in refs), key=lambda ref: (ref[0] != 0, str(ref[0]), ref[1] or 0))
        if own[0][0] != 0:
            return ("pass",)
        return ("bonus", (own[0], own[1]))
    if action in ("swap", "flip"):
        return (action, index)
    return {"draw": ("draw",), "discard": ("discard",), "end_turn": ("end",)}[action]


# ---------- dealing a puzzle around its rule ----------
def _take(deck, rng, want=lambda card: True):
    """Take a random card that fits from the cards left (None if there is none)."""
    fits = [card for card in deck if want(card)]
    if not fits:
        return None
    card = rng.choice(fits)
    deck.remove(card)
    return card


def _plant(rule, rng, deck):
    """The cards that set the rule up: ({slot: card} face up in your hand, the discard or None).
    The discard is the card the rule wants most of the time; now and then it is not,
    and the pile (or leaving well alone) is the question."""
    hand, discard, key = {}, None, rng.random() < 0.65
    if rule in ("angel_numbers", "tricky_straights", "suited_rows"):
        row = rng.choice(ROWS)
        there = rng.sample(row, 2)
        if rule == "angel_numbers":
            rank = rng.choice((7, 9))
            wanted = {slot: (lambda card, rank=rank: card[0] == rank) for slot in row}
        elif rule == "tricky_straights":
            high = rng.randint(3, 14)  # (a row running down from it: an Ace may be high)
            ranks = [1 if rank == 14 else rank for rank in (high, high - 1, high - 2)]
            wanted = {slot: (lambda card, rank=rank: card[0] == rank) for slot, rank in zip(row, ranks)}
        else:
            suit = rng.choice("SC")
            wanted = {slot: (lambda card, suit=suit: card[1] == suit) for slot in row}
        for slot in there:
            hand[slot] = _take(deck, rng, wanted[slot])
        last = next(slot for slot in row if slot not in there)
        discard = _take(deck, rng, wanted[last]) if key else None
    elif rule in ("v10", "roman_fives"):
        v = rng.choice(VS)
        there = rng.sample(v, 2)
        if rule == "v10":
            ranks = rng.sample((10, 11, 12), 3)
            for slot, rank in zip(there, ranks):
                hand[slot] = _take(deck, rng, lambda card, rank=rank: card[0] == rank)
            discard = _take(deck, rng, lambda card: card[0] == ranks[2]) if key else None
        else:
            first = _take(deck, rng)
            second = _take(deck, rng, lambda card: any(BP[first[0]] + BP[card[0]] + BP[rank] == 10 for rank in range(1, 14)))
            hand[there[0]], hand[there[1]] = first, second
            discard = _take(deck, rng, lambda card: BP[first[0]] + BP[second[0]] + BP[card[0]] == 10) if key else None
    elif rule == "king_queen":
        column = rng.randrange(3)
        king, queen = rng.sample((column, column + 3), 2)
        shape = rng.choice(("queen", "king", "mixed"))
        if shape == "mixed":  # a King over a Queen of the other color: 15 points to be rid of
            hand[king] = _take(deck, rng, lambda card: card[0] == 13)
            hand[queen] = _take(deck, rng, lambda card: card[0] == 12 and red(card) != red(hand[king]))
            discard = _take(deck, rng, lambda card: card[0] in (12, 13) and red(card) == red(hand[king])) if key else None
        else:
            there, rank, other = (king, 13, 12) if shape == "queen" else (queen, 12, 13)
            hand[there] = _take(deck, rng, lambda card: card[0] == rank)
            same = rng.random() < 0.7  # (the other color makes it 15: a trap)
            discard = _take(deck, rng, lambda card: card[0] == other and (red(card) == red(hand[there])) == same) if key else None
    elif rule == "holdem":
        shape = rng.choice(("flush", "flush", "straight", "full_house"))
        slots = rng.sample(range(6), 4)
        if shape == "flush":
            suit = rng.choice("SHDC")
            for slot in slots:
                hand[slot] = _take(deck, rng, lambda card: card[1] == suit)
            discard = _take(deck, rng, lambda card: card[1] == suit) if key else None
        elif shape == "straight":
            low = rng.randint(1, 10)
            ranks = rng.sample([1 if rank == 14 else rank for rank in range(low, low + 5)], 5)
            for slot, rank in zip(slots, ranks):
                hand[slot] = _take(deck, rng, lambda card, rank=rank: card[0] == rank)
            discard = _take(deck, rng, lambda card: card[0] == ranks[4]) if key else None
        else:
            three, two = rng.sample(range(1, 14), 2)
            for slot, rank in zip(slots, (three, three, three, two)):
                hand[slot] = _take(deck, rng, lambda card, rank=rank: card[0] == rank)
            discard = _take(deck, rng, lambda card: card[0] == two) if key else None
    elif rule == "ripped_five":
        slot = rng.randrange(6)
        if rng.random() < 0.5:  # the 5 of diamonds is yours: another 5 is wanted across from it
            hand[slot] = _take(deck, rng, lambda card: card == (5, "D"))
            discard = _take(deck, rng, lambda card: card[0] == 5) if key else None
        else:
            hand[slot] = _take(deck, rng, lambda card: card[0] == 5 and card[1] != "D")
            discard = _take(deck, rng, lambda card: card == (5, "D")) if key else None
    elif rule == "all_in_color":
        slots = rng.sample(range(6), rng.choice((4, 5, 5, 6)))
        odd = rng.choice(slots)
        for slot in slots:
            hand[slot] = _take(deck, rng, lambda card, slot=slot: red(card) == (slot == odd))
        discard = _take(deck, rng, lambda card: not red(card)) if key else None
    elif rule == "royal_pairs":
        rank, slot = rng.choice((11, 12)), rng.randrange(6)
        hand[slot] = _take(deck, rng, lambda card: card[0] == rank)
        discard = _take(deck, rng, lambda card: card[0] == rank) if key else None
    return hand, discard


def _quiet(opp, rule):
    """Whether PuzzleBot's hand leaves your score alone under the rule (it only sits there)."""
    if rule == "angel_numbers" and any(all(opp[i][0] == rank for i in row) for row in ROWS for rank in (6, 8)):
        return False
    if rule == "tricky_straights" and any(_direction([opp[i][0] for i in row]) == 1 for row in ROWS):
        return False
    if rule == "suited_rows" and any(len({opp[i][1] for i in row}) == 1 and red(opp[row[0]]) for row in ROWS):
        return False
    return not (rule == "all_in_color" and all(red(card) for card in opp))


def make_deal(rule, rng):
    """A table set up around a rule: the planted cards face up, at least two of yours showing,
    and everything face down dealt at random from what is left."""
    deck = list(DECK)
    planted, discard = _plant(rule, rng, deck)
    if any(card is None for card in planted.values()):
        return None
    count = 6 if rule == "royal_pairs" else max(len(planted), rng.choice((2, 3, 3, 4, 4, 4, 5, 5, 6)))
    up = set(planted) | set(rng.sample([i for i in range(6) if i not in planted], count - len(planted)))
    rng.shuffle(deck)
    for _ in range(20):
        opp = deck[:6]
        if _quiet(opp, rule):
            break
        rng.shuffle(deck)
    else:
        return None
    deck = deck[6:]
    hand = [planted.get(slot) or deck.pop() for slot in range(6)]
    return {"rule": rule, "hand": hand, "up": sorted(up), "opp": opp, "discard": discard or deck.pop(), "deck": deck,
            "seed": rng.getrandbits(48)}


def _best(options):
    low = min(options.values())
    return [action for action, value in options.items() if value <= low + TOLERANCE]


def analyze(deal, samples=SAMPLES):
    """A deal as a puzzle: what each first move is worth, the best and the worst that can
    be made of it, and what the rule is worth to the best move. None if it is no puzzle:
    no one best move clear of the rest, or the rule has no part in it."""
    solver = solver_for({**deal, "samples": samples}, {})
    root = solver.root()
    best = _best(root)
    low = root[best[0]]
    # (moves that come to the same thing, a card put on either of two like cards, are one answer)
    rest = [value for action, value in root.items() if value > low + TOLERANCE]
    if not rest or min(rest) - low < MIN_GAP or len(best) > 2:
        return None
    worst = max(solver.root(max).values())
    if worst - low < 2:
        return None
    # without the rule: is the best move still the best, and worth the same?
    vanilla = solver_for({**deal, "rule": None, "samples": min(samples, 120)}, {}).root()
    if set(_best(vanilla)) & set(best) and abs(vanilla[best[0]] - low) < MIN_RULE:
        return None
    return {**deal, "samples": samples, "root": root, "best": best, "best_value": low, "worst_value": worst,
            "memo": solver.memo}


def generate(rule=None, seed=None, samples=SAMPLES, tries=400):
    """A checked puzzle about `rule` (any, if None): see analyze. None if `tries` deals gave none."""
    rng = random.Random(seed)
    for _ in range(tries):
        deal = make_deal(rule or rng.choice(RULES), rng)
        puzzle = deal and analyze(deal, samples)
        if puzzle:
            return puzzle
    return None


def new_game(spec):
    """The table a puzzle is played at: its rule alone in play, one move of yours, then the scores."""
    from game import RULE_OPTIONS, GolfGame, rules_from
    rules = rules_from({key: key == spec["rule"] for key, _ in RULE_OPTIONS})
    return GolfGame(rules=rules, puzzle=True, puzzle_deal=spec)


def public(spec):
    """A puzzle as its player is told of it before a move is made (nothing of what is hidden, or best)."""
    return {"rule": spec["rule"], "face_up": len(spec["up"])}


def grade(spec, steps):
    """A finished puzzle's marks from the moves made (each {"loss": points given up on average, ...}):
    the loss in all, and whether it was the best play (correct: an accuracy of 100, or of 0)."""
    loss = sum(made["loss"] for made in steps)
    best = loss <= TOLERANCE
    return {"loss": round(loss, 2), "best": best, "accuracy": 100.0 if best else 0.0,
            "expected": round(spec["best_value"] + loss, 1), "best_expected": round(spec["best_value"], 1)}


class PuzzleResults:
    """Every rule puzzle each player has finished: when, its rule, and how well they played it."""

    def __init__(self, history):
        self.db, self.lock = history.connection, history.lock
        with self.lock, self.db:
            self.db.execute('CREATE TABLE IF NOT EXISTS rule_puzzle_results (id INTEGER PRIMARY KEY, player TEXT NOT NULL, '
                            'at REAL NOT NULL, rule TEXT NOT NULL, accuracy REAL NOT NULL, best INTEGER NOT NULL, loss REAL NOT NULL)')
            self.db.execute('CREATE INDEX IF NOT EXISTS rule_puzzle_results_player ON rule_puzzle_results (player, at)')

    def record(self, player, rule, accuracy, best, loss, now=None):
        with self.lock, self.db:
            self.db.execute('INSERT INTO rule_puzzle_results (player, at, rule, accuracy, best, loss) VALUES (?, ?, ?, ?, ?, ?)',
                            (player, time.time() if now is None else now, rule, accuracy, int(bool(best)), loss))

    def stats(self, player, now=None):
        """A player's accuracy over every puzzle and over the last seven days (None for none played):
        {"all": {...}, "week": {...}}, each {"accuracy", "puzzles", "best"}."""
        now = time.time() if now is None else now
        found = {}
        with self.lock:
            for name, since in (("all", 0), ("week", now - WEEK)):
                puzzles, best = self.db.execute(
                    'SELECT COUNT(*), COALESCE(SUM(best), 0) FROM rule_puzzle_results WHERE player=? AND at>=?',
                    (player, since)).fetchone()
                # (accuracy: the share of puzzles got right)
                found[name] = {"accuracy": round(100 * best / puzzles, 1) if puzzles else None, "puzzles": puzzles, "best": best}
        return found
