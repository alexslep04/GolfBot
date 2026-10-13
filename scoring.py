"""Optional score adjustments; ranks stay distinct from Golf point values."""
from collections import Counter
from itertools import combinations

V_PATTERNS = ((0, 4, 2), (3, 1, 5))


def holdem_categories(cards):
    categories = set()
    for hand in combinations(cards, 5):
        ranks = {card.rank for card in hand}
        counts = sorted(Counter(card.rank for card in hand).values())
        flush = len({card.suit for card in hand}) == 1
        straight = len(ranks) == 5 and (max(ranks) - min(ranks) == 4 or ranks == {1, 10, 11, 12, 13})
        if flush:
            categories.add("flush")
        if straight:
            categories.add("straight")
        if counts == [2, 3]:
            categories.add("full_house")
        if 4 in counts:
            categories.add("four_kind")
        if flush and ranks == {1, 10, 11, 12, 13}:
            categories.add("royal_flush")
    return categories


def straight_direction(cards):
    for ace in (1, 14):
        ranks = [ace if card.rank == 1 else card.rank for card in cards]
        if all(b - a == 1 for a, b in zip(ranks, ranks[1:])):
            return 1
        if all(b - a == -1 for a, b in zip(ranks, ranks[1:])):
            return -1
    return 0


def score_adjustments(layout, rules, visible_only=False):
    cards = [slot.card for slot in layout if slot.visible or not visible_only]
    adjustment, divisor = 0, 1
    if rules.holdem:
        categories = holdem_categories(cards)
        bonuses = {"flush": 2, "straight": 2, "full_house": 5, "four_kind": 5, "royal_flush": 10}
        adjustment -= sum(bonuses[category] for category in categories)
    if rules.ripped_five and any(card.rank == 5 and card.suit == "D" for card in cards) and sum(card.rank == 5 for card in cards) >= 2:
        adjustment -= 5
    if rules.tricky_straights:
        for row in (layout[:3], layout[3:]):
            if not visible_only or all(slot.visible for slot in row):
                adjustment += straight_direction([slot.card for slot in row]) * row[-1].card.points
    # Divisions are final-score operations, never included in visible subtotals.
    if not visible_only:
        patterns = [[layout[i].card for i in pattern] for pattern in V_PATTERNS]
        if rules.roman_fives and any(all(card.points == 10 for card in pattern) for pattern in patterns):
            divisor *= 3
        if rules.v10 and any({card.rank for card in pattern} == {10, 11, 12} for pattern in patterns):
            divisor *= 5
    return adjustment, divisor
