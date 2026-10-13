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
        if categories & {"flush", "straight", "full_house", "four_kind"}:
            adjustment -= 5
    if rules.tricky_straights:
        for row in (layout[:3], layout[3:]):
            if not visible_only or all(slot.visible for slot in row):
                adjustment += straight_direction([slot.card for slot in row]) * row[-1].card.points
    # Divisions are final-score operations, never included in visible subtotals.
    if not visible_only:
        patterns = [[layout[i].card for i in pattern] for pattern in V_PATTERNS]
        if rules.roman_fives and any(sum(card.points for card in pattern) == 10 for pattern in patterns):
            divisor *= 3
        if rules.v10 and any({card.rank for card in pattern} == {10, 11, 12} for pattern in patterns):
            divisor *= 5
    return adjustment, divisor


def cancellation_pairs(layout, rules, visible_only=False):
    known = {i for i, slot in enumerate(layout) if slot.visible or not visible_only}
    pairs = [((i, i + 3), "column") for i in range(3)
             if i in known and i + 3 in known and layout[i].card.rank == layout[i + 3].card.rank]
    cancelled = {i for pair, _ in pairs for i in pair}
    if rules.ripped_five:
        diamond = next((i for i in sorted(known - cancelled) if layout[i].card.rank == 5 and layout[i].card.suit == "D"), None)
        if diamond is not None:
            other = next((i for i in sorted(known - cancelled) if i // 3 != diamond // 3 and layout[i].card.rank == 5), None)
            if other is not None:
                pairs.append(((diamond, other), "ripped"))
    return pairs


def column_score(layout, rules, visible_only=False):
    cancelled = {i for pair, _ in cancellation_pairs(layout, rules, visible_only) for i in pair}
    total = 0
    for column in range(3):
        indexes = [i for i in (column, column + 3) if i not in cancelled and (layout[i].visible or not visible_only)]
        if len(indexes) == 2:
            first, second = (layout[i].card for i in indexes)
            if rules.king_queen and {first.rank, second.rank} == {12, 13}:
                total += 5 if first.red == second.red else 15
                continue
        total += sum(layout[i].card.points for i in indexes)
    return total


def active_rule_effects(layout, rules, gambler_earned=False, locked_cards=()):
    """Report effects proven by visible cards, without exposing hidden cards."""
    effects = []
    cards = [slot.card for slot in layout if slot.visible]
    patterns = [[layout[i] for i in pattern] for pattern in V_PATTERNS]
    patterns = [[slot.card for slot in pattern] for pattern in patterns if all(slot.visible for slot in pattern)]
    for pair, source in cancellation_pairs(layout, rules, True):
        reduction = -sum(layout[i].card.points for i in pair)
        label = "Ripped 5" if source == "ripped" else f"Column {pair[0] + 1} pair"
        effects.append(f"{label}: 0 ({reduction:+d})")
    if rules.roman_fives and any(sum(card.points for card in pattern) == 10 for pattern in patterns):
        effects.append("Roman 5s /3")
    if rules.v10 and any({card.rank for card in pattern} == {10, 11, 12} for pattern in patterns):
        effects.append("V10 /5")
    if rules.gamblers_row and gambler_earned:
        effects.append("777 /7")
    if rules.devils_row and any(card in locked_cards for card in cards):
        effects.append(f"666: {sum(card in locked_cards for card in cards)} locked")
    if rules.holdem:
        categories = holdem_categories(cards) & {"flush", "straight", "full_house", "four_kind"}
        if categories:
            effects.append("Hold 'em: -5 (" + ", ".join(category.replace("_", " ") for category in sorted(categories)) + ")")
    if rules.tricky_straights:
        for row_index, row in enumerate((layout[:3], layout[3:])):
            if all(slot.visible for slot in row):
                direction = straight_direction([slot.card for slot in row])
                if direction:
                    effects.append(f"Straight row {row_index + 1}: {direction * row[-1].card.points:+d}")
    if rules.king_queen:
        for i in range(3):
            if layout[i].visible and layout[i + 3].visible and {layout[i].card.rank, layout[i + 3].card.rank} == {12, 13}:
                value = 5 if layout[i].card.red == layout[i + 3].card.red else 15
                effects.append(f"King-Queen column {i + 1}: {value} ({value - 10:+d})")
    return effects


def visible_effect_total(layout, rules, gambler_earned=False):
    subtotal = column_score(layout, rules, True) + score_adjustments(layout, rules, True)[0]
    patterns = [[layout[i] for i in pattern] for pattern in V_PATTERNS]
    patterns = [[slot.card for slot in pattern] for pattern in patterns if all(slot.visible for slot in pattern)]
    divisor = 7 if rules.gamblers_row and gambler_earned else 1
    if rules.roman_fives and any(sum(card.points for card in pattern) == 10 for pattern in patterns):
        divisor *= 3
    if rules.v10 and any({card.rank for card in pattern} == {10, 11, 12} for pattern in patterns):
        divisor *= 5
    return (subtotal + divisor - 1) // divisor
