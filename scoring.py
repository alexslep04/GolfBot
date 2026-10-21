"""Optional score adjustments; ranks stay distinct from Golf point values."""
from collections import Counter
from itertools import combinations
from math import prod

V_PATTERNS = ((0, 4, 2), (3, 1, 5))
POISON_POINTS = 3


def v_pattern_effects(layout, rules, visible_only=False):
    """Detect Vs from immutable card values, independently of all score effects."""
    patterns = [[layout[i] for i in pattern] for pattern in V_PATTERNS]
    cards = [[slot.card for slot in pattern] for pattern in patterns
             if not visible_only or all(slot.visible for slot in pattern)]
    effects = []
    if rules.roman_fives and any(sum(card.base_points for card in pattern) == 10 for pattern in cards):
        effects.append(("Roman 5s", 2))
    if rules.v10 and any(all(card.rank in (10, 11, 12) for card in pattern) for pattern in cards):
        effects.append(("V10 engine", 5))
    return effects


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


def straight_adjustments(layout, rules, visible_only=False):
    """Return (own adjustment, opponent adjustment) from base-point row values."""
    own, opponent = 0, 0
    for _, direction, value in straight_rows(layout, rules, visible_only):
        if direction == 1:
            opponent += value
        else:
            own -= value
    return own, opponent


def straight_rows(layout, rules, visible_only=False):
    if rules.tricky_straights:
        for index, row in enumerate((layout[:3], layout[3:])):
            if not visible_only or all(slot.visible for slot in row):
                direction = straight_direction([slot.card for slot in row])
                if direction:
                    yield index + 1, direction, row[-1].card.base_points


def score_adjustments(layout, rules, visible_only=False):
    cards = [slot.card for slot in layout if slot.visible or not visible_only]
    adjustment, divisor = 0, 1
    if rules.holdem:
        categories = holdem_categories(cards)
        if categories & {"flush", "straight", "full_house", "four_kind"}:
            adjustment -= 5
    adjustment += straight_adjustments(layout, rules, visible_only)[0]
    # Divisions are final-score operations, never included in visible subtotals.
    if not visible_only:
        divisor *= prod(factor for _, factor in v_pattern_effects(layout, rules))
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
        total += sum(layout[i].card.base_points for i in indexes)
    return total


def scoring_rule_keys(layout, rules):
    """Scoring rules activated by known cards; independent of adjusted points."""
    keys = set()
    cards = [slot.card for slot in layout if slot.visible]
    for name, _ in v_pattern_effects(layout, rules, True):
        keys.add('v10' if name == 'V10 engine' else 'roman_fives')
    if rules.holdem and holdem_categories(cards) & {'flush', 'straight', 'full_house', 'four_kind'}:
        keys.add('holdem')
    if any(straight_rows(layout, rules, True)):
        keys.add('tricky_straights')
    if any(source == 'ripped' for _, source in cancellation_pairs(layout, rules, True)):
        keys.add('ripped_five')
    if rules.king_queen and any(layout[i].visible and layout[i + 3].visible and
                               {layout[i].card.rank, layout[i + 3].card.rank} == {12, 13} for i in range(3)):
        keys.add('king_queen')
    return keys


def active_rule_effects(layout, rules, gambler_earned=False, locked_cards=(), opponent_layout=None, poisoned=False,
                        angel_earned=False, opponent_angel_earned=False):
    """Report effects proven by visible cards, without exposing hidden cards."""
    effects = []
    cards = [slot.card for slot in layout if slot.visible]
    for pair, source in cancellation_pairs(layout, rules, True):
        reduction = -sum(layout[i].card.base_points for i in pair)
        label = "Ripped 5" if source == "ripped" else f"Column {pair[0] + 1} pair"
        effects.append(f"{label}: 0 ({reduction:+d})")
    effects.extend(f"{name} /{divisor}" for name, divisor in v_pattern_effects(layout, rules, True))
    if rules.gamblers_row and gambler_earned:
        effects.append("Gamblers 777 /7")
    if rules.angels_row and angel_earned:
        effects.append("Angels 999: opponent ×9")
    if rules.angels_row and opponent_angel_earned:
        effects.append("Incoming Angels 999: ×9")
    if rules.devils_row and any(card in locked_cards for card in cards):
        effects.append(f"Devils 666: {sum(card in locked_cards for card in cards)} locked")
    if rules.holdem:
        categories = holdem_categories(cards) & {"flush", "straight", "full_house", "four_kind"}
        if categories:
            effects.append("Hold 'em: -5 (" + ", ".join(category.replace("_", " ") for category in sorted(categories)) + ")")
    for row, direction, value in straight_rows(layout, rules, True):
        target = "opponent " if direction == 1 else ""
        effects.append(f"Straight row {row}: {target}{value if direction == 1 else -value:+d}")
    if opponent_layout is not None:
        for row, direction, value in straight_rows(opponent_layout, rules, True):
            if direction == 1:
                effects.append(f"Incoming straight row {row}: {value:+d}")
    if rules.poisoned_card and poisoned:
        effects.append(f"Poisoned Card: +{POISON_POINTS}")
    if rules.king_queen:
        for i in range(3):
            if layout[i].visible and layout[i + 3].visible and {layout[i].card.rank, layout[i + 3].card.rank} == {12, 13}:
                value = 5 if layout[i].card.red == layout[i + 3].card.red else 15
                effects.append(f"King-Queen column {i + 1}: {value} ({value - 10:+d})")
    return effects


def visible_effect_total(layout, rules, gambler_earned=False, opponent_layout=None, poisoned=False,
                         opponent_angel_earned=False):
    subtotal = column_score(layout, rules, True) + score_adjustments(layout, rules, True)[0]
    if opponent_layout is not None:
        subtotal += straight_adjustments(opponent_layout, rules, True)[1]
    if rules.poisoned_card and poisoned:
        subtotal += POISON_POINTS
    divisor = 7 if rules.gamblers_row and gambler_earned else 1
    divisor *= prod(factor for _, factor in v_pattern_effects(layout, rules, True))
    subtotal *= 9 if rules.angels_row and opponent_angel_earned else 1
    return (subtotal + divisor - 1) // divisor
