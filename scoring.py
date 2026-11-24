"""Optional score adjustments; ranks stay distinct from Golf point values."""
from collections import Counter
from itertools import combinations
from math import prod

V_PATTERNS = ((0, 4, 2), (3, 1, 5))
POISON_POINTS = 1
# Angel numbers: a face-up row of three earns its rank for the rest of the game.
ANGEL_MULTIPLIERS = (6, 8)  # every opponent's final score times the rank
ANGEL_DIVISORS = (7, 9)     # your own final score divided by the rank
ANGEL_RANKS = ANGEL_MULTIPLIERS + ANGEL_DIVISORS


def angel_divisor(rules, earned):
    return prod(rank for rank in ANGEL_DIVISORS if rank in earned) if rules.angel_numbers else 1


def angel_multiplier(rules, earned):
    return prod(rank for rank in ANGEL_MULTIPLIERS if rank in earned) if rules.angel_numbers else 1


def v_pattern_effects(layout, rules, visible_only=False):
    """Detect Vs from immutable card values, independently of all score effects."""
    patterns = [[layout[i] for i in pattern] for pattern in V_PATTERNS]
    cards = [[slot.card for slot in pattern] for pattern in patterns
             if not visible_only or all(slot.visible for slot in pattern)]
    effects = []
    if rules.roman_fives and any(sum(card.base_points for card in pattern) == 10 for pattern in cards):
        effects.append(("V2", 2))
    if rules.v10 and any({card.rank for card in pattern} == {10, 11, 12} for pattern in cards):
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


def suited_rows(layout, rules, visible_only=False):
    if rules.suited_rows:
        for index, row in enumerate((layout[:3], layout[3:])):
            if (not visible_only or all(slot.visible for slot in row)) and len({slot.card.suit for slot in row}) == 1:
                yield index + 1, row[1].card.red, row[1].card.base_points


def all_color(layout, rules, visible_only=False):
    if not rules.all_in_color or (visible_only and not all(slot.visible for slot in layout)):
        return None
    colors = {slot.card.red for slot in layout}
    return next(iter(colors)) if len(colors) == 1 else None


def color_multiplier(layout, rules, visible_only=False):
    return 2 if all_color(layout, rules, visible_only) is True else 1


def opponent_adjustment(layout, rules, visible_only=False):
    return straight_adjustments(layout, rules, visible_only)[1] + sum(
        value for _, red, value in suited_rows(layout, rules, visible_only) if red)


def score_adjustments(layout, rules, visible_only=False):
    cards = [slot.card for slot in layout if slot.visible or not visible_only]
    adjustment, divisor = 0, 1
    if rules.holdem:
        categories = holdem_categories(cards)
        if categories & {"flush", "straight", "full_house", "four_kind"}:
            adjustment -= 5
    adjustment += straight_adjustments(layout, rules, visible_only)[0]
    adjustment -= sum(value for _, red, value in suited_rows(layout, rules, visible_only) if not red)
    # Divisions are final-score operations, never included in visible subtotals.
    if not visible_only:
        divisor *= prod(factor for _, factor in v_pattern_effects(layout, rules))
        if all_color(layout, rules) is False:
            divisor *= 2
    return adjustment, divisor


def cancellation_pairs(layout, rules, visible_only=False):
    known = {i for i, slot in enumerate(layout) if slot.visible or not visible_only}
    pairs = [((i, i + 3), "column") for i in range(3)
             if i in known and i + 3 in known and layout[i].card.rank == layout[i + 3].card.rank]
    canceled = {i for pair, _ in pairs for i in pair}
    if rules.ripped_five:
        # The 5 of diamonds rips one other 5 in the opposite row, whether or not
        # it has already canceled a 5 in its own column. The ripped 5 is the
        # first one left to right there that nothing has canceled yet.
        diamond = next((i for i in sorted(known) if layout[i].card.rank == 5 and layout[i].card.suit == "D"), None)
        if diamond is not None:
            other = next((i for i in sorted(known - canceled) if i // 3 != diamond // 3 and layout[i].card.rank == 5), None)
            if other is not None:
                pairs.append(((diamond, other), "ripped"))
    return pairs


def column_score(layout, rules, visible_only=False):
    canceled = {i for pair, _ in cancellation_pairs(layout, rules, visible_only) for i in pair}
    total = 0
    for column in range(3):
        indexes = [i for i in (column, column + 3) if i not in canceled and (layout[i].visible or not visible_only)]
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
    if any(suited_rows(layout, rules, True)):
        keys.add('suited_rows')
    if all_color(layout, rules, True) is not None:
        keys.add('all_in_color')
    if any(source == 'ripped' for _, source in cancellation_pairs(layout, rules, True)):
        keys.add('ripped_five')
    if rules.king_queen and any(layout[i].visible and layout[i + 3].visible and
                               {layout[i].card.rank, layout[i + 3].card.rank} == {12, 13} for i in range(3)):
        keys.add('king_queen')
    return keys


def scoring_subrule_keys(layout, rules, visible_only=True):
    """Which way each scoring rule fired ("rule:part" keys), from the layout's cards.

    The parts the stats break each rule into: Hold 'em's hands, the straights'
    direction, the suited rows' and the six cards' color, and whether a King-Queen
    column matched colors. (Angel numbers, bonus swaps, Beggars and 4 of a Kind
    are recorded by the game as they happen.)
    """
    keys = set()
    cards = [slot.card for slot in layout if slot.visible or not visible_only]
    if rules.holdem:
        hands = holdem_categories(cards)
        keys.update(f'holdem:{hand}' for hand in ('flush', 'straight', 'full_house', 'four_kind') if hand in hands)
    for _, direction, _ in straight_rows(layout, rules, visible_only):
        keys.add('tricky_straights:up' if direction == 1 else 'tricky_straights:down')
    for _, red, _ in suited_rows(layout, rules, visible_only):
        keys.add('suited_rows:red' if red else 'suited_rows:black')
    color = all_color(layout, rules, visible_only)
    if color is not None:
        keys.add('all_in_color:red' if color else 'all_in_color:black')
    if rules.king_queen:
        for i in range(3):
            first, second = layout[i], layout[i + 3]
            if (not visible_only or first.visible and second.visible) and {first.card.rank, second.card.rank} == {12, 13}:
                keys.add('king_queen:same' if first.card.red == second.card.red else 'king_queen:mixed')
    return keys


def modifier_instance_counts(layout, rules, angels_earned=(), poisoned=False, *, visible_only=True):
    """Count optional modifier instances caused by this player's current layout.

    Incoming effects and ordinary column cancellations are not optional modifiers.
    Rows, King-Queen columns and earned Angel numbers stack; V patterns, Hold 'em,
    color and poison each apply once. Earned Angel numbers survive swaps.
    Hidden cards are ignored unless the caller explicitly requests final scoring.
    """
    counts = Counter()
    for name, _ in v_pattern_effects(layout, rules, visible_only):
        counts['v10' if name == 'V10 engine' else 'roman_fives'] = 1
    cards = [slot.card for slot in layout if slot.visible or not visible_only]
    if rules.holdem and holdem_categories(cards) & {'flush', 'straight', 'full_house', 'four_kind'}:
        counts['holdem'] = 1
    counts['tricky_straights'] = sum(1 for _ in straight_rows(layout, rules, visible_only))
    counts['suited_rows'] = sum(1 for _ in suited_rows(layout, rules, visible_only))
    if all_color(layout, rules, visible_only) is not None:
        counts['all_in_color'] = 1
    if any(source == 'ripped' for _, source in cancellation_pairs(layout, rules, visible_only)):
        counts['ripped_five'] = 1
    if rules.king_queen:
        counts['king_queen'] = sum(
            (not visible_only or layout[i].visible and layout[i + 3].visible) and
            {layout[i].card.rank, layout[i + 3].card.rank} == {12, 13} for i in range(3))
    if rules.angel_numbers:
        counts['angel_numbers'] = len(set(angels_earned) & set(ANGEL_RANKS))
    if rules.poisoned_card and poisoned:
        counts['poisoned_card'] = 1
    return {key: count for key, count in counts.items() if count}


def modifier_data(game, *, visible_only=True):
    """Return seat-ordered, source-owned modifier counts and activation keys.

    Public state uses the visible-only default. At round end record both payload
    keys with visible_only=False: modifier_counts is a final snapshot, activations
    retains the game's cumulative action/trigger tracker. Neither includes cards.
    Action-only rules (royal_pairs, beggars, four_kind) have no lasting modifier.
    """
    counts = [modifier_instance_counts(
        layout, game.rules, game.angels_earned[player], poisoned=game.finisher == player,
        visible_only=visible_only) for player, layout in enumerate(game.players)]
    subrules = getattr(game, 'activated_subrules', None) or [set() for _ in game.players]
    return {'modifier_counts': counts,
            'activations': [sorted(set(keys) | set(counts[player]))
                            for player, keys in enumerate(game.activated_rules)],
            # the parts of those rules ("angel_numbers:777", "holdem:flush", ...); older results lack them
            'subrule_activations': [sorted(set(subrules[player]) | scoring_subrule_keys(layout, game.rules, visible_only)
                                           | {f'angel_numbers:{str(rank) * 3}' for rank in game.angels_earned[player]
                                              if game.rules.angel_numbers})
                                    for player, layout in enumerate(game.players)]}



def rule_preview_data(game):
    """Seat-ordered public contributors: rule key -> indices and optional note.

    Modifier activity belongs to its source, never recipients or activation
    history. Only visible slots participate, including for the owning viewer.
    Action rules are previews, not additional scoring modifier instances.
    """
    result = []
    rules = game.rules
    for player, layout in enumerate(game.players):
        active = modifier_instance_counts(
            layout, rules, game.angels_earned[player], poisoned=game.finisher == player)
        visible = [i for i, slot in enumerate(layout) if slot.visible]
        entries = {}
        for key in active:
            indices = []
            note = None
            if key == 'king_queen':
                indices = [i for col in range(3)
                           if layout[col].visible and layout[col + 3].visible
                           and {layout[col].card.rank, layout[col + 3].card.rank} == {12, 13}
                           for i in (col, col + 3)]
            elif key in ('roman_fives', 'v10'):
                indices = next(list(pattern) for pattern in V_PATTERNS
                               if all(layout[i].visible for i in pattern)
                               and (sum(layout[i].card.base_points for i in pattern) == 10
                                    if key == 'roman_fives' else
                                    {layout[i].card.rank for i in pattern} == {10, 11, 12}))
            elif key in ('tricky_straights', 'suited_rows'):
                rows = straight_rows if key == 'tricky_straights' else suited_rows
                indices = [i for row, _, _ in rows(layout, rules, True)
                           for i in range((row - 1) * 3, row * 3)]
            elif key == 'ripped_five':
                indices = [i for pair, source in cancellation_pairs(layout, rules, True)
                           if source == 'ripped' for i in pair]
            elif key == 'holdem':
                indices = next(list(hand) for hand in combinations(visible, 5)
                               if holdem_categories([layout[i].card for i in hand])
                               & {'flush', 'straight', 'full_house', 'four_kind'})
            elif key == 'all_in_color':
                indices = visible
            elif key == 'angel_numbers':
                earned = game.angels_earned[player]
                indices = [i for row in (range(3), range(3, 6))
                           if all(layout[j].visible and layout[j].card.rank == layout[row[0]].card.rank for j in row)
                           and layout[row[0]].card.rank in earned
                           for i in row]
                if not indices:
                    note = 'Earned earlier; still applies.'
            elif key == 'poisoned_card':
                indices = visible
                note = 'Finisher penalty retained, including while cards are hidden.'
            entries[key] = {'indices': sorted(set(indices))}
            if note:
                entries[key]['note'] = note
        if rules.royal_pairs:
            indices = [i for col in range(3)
                       if layout[col].visible and layout[col + 3].visible
                       and layout[col].card.rank == layout[col + 3].card.rank
                       and layout[col].card.rank in (11, 12)
                       for i in (col, col + 3)]
            if indices:
                entries['royal_pairs'] = {'indices': sorted(indices)}
        pending = game.arrange_pending
        if rules.four_kind and game.phase == 'arrange' and pending and pending['player'] == player:
            indices = [i for i in visible if layout[i].card.rank == pending['rank']]
            if len(indices) >= 4:
                entries['four_kind'] = {'indices': indices}
        pending = game.guess_pending
        if rules.beggars and game.phase in ('guess', 'guess_trade') and pending and pending['player'] == player:
            highest = max((layout[i].card.base_points for i in visible), default=None)
            indices = [i for i in visible if layout[i].card.base_points == highest]
            entries['beggars'] = {'indices': indices}
        result.append(entries)
    return result


def active_rule_effects(layout, rules, angels_earned=(), opponent_layout=None, poisoned=False,
                        *, opponent_layouts=None, incoming_angels=()):
    """Report effects proven by visible cards, without exposing hidden cards."""
    effects = []
    cards = [slot.card for slot in layout if slot.visible]
    counted = set()
    for pair, source in cancellation_pairs(layout, rules, True):
        # a card already zeroed by an earlier pair (a 5 of diamonds in a column
        # pair, then ripping another 5) is not taken off twice
        reduction = -sum(layout[i].card.base_points for i in pair if i not in counted)
        counted.update(pair)
        label = "Ripped 5" if source == "ripped" else f"Column {pair[0] + 1} pair"
        effects.append(f"{label}: 0 ({reduction:+d})")
    effects.extend(f"{name} /{divisor}" for name, divisor in v_pattern_effects(layout, rules, True))
    if rules.angel_numbers:
        for rank in sorted(set(angels_earned) & set(ANGEL_RANKS)):
            effects.append(f"Angel {rank}{rank}{rank}: " + (f"opponents ×{rank}" if rank in ANGEL_MULTIPLIERS else f"/{rank}"))
    if rules.holdem:
        categories = holdem_categories(cards) & {"flush", "straight", "full_house", "four_kind"}
        if categories:
            effects.append("Hold 'em: -5 (" + ", ".join(category.replace("_", " ") for category in sorted(categories)) + ")")
    for row, direction, value in straight_rows(layout, rules, True):
        target = "opponent " if direction == 1 else ""
        effects.append(f"Straight row {row}: {target}{value if direction == 1 else -value:+d}")
    for row, red, value in suited_rows(layout, rules, True):
        effects.append(f"Suited row {row}: {'opponents ' if red else ''}{value if red else -value:+d}")
    color = all_color(layout, rules, True)
    if color is not None:
        effects.append("All in red: opponents ×2" if color else "All in black: /2")
    incoming = opponent_layouts if opponent_layouts is not None else [opponent_layout] if opponent_layout is not None else []
    for other_index, other_layout in enumerate(incoming):
        source = f" (opponent {other_index + 1})" if len(incoming) > 1 else ""
        for row, direction, value in straight_rows(other_layout, rules, True):
            if direction == 1:
                effects.append(f"Incoming straight row {row}{source}: {value:+d}")
        for row, red, value in suited_rows(other_layout, rules, True):
            if red:
                effects.append(f"Incoming suited row {row}{source}: {value:+d}")
        if all_color(other_layout, rules, True) is True:
            effects.append(f"Incoming All in red{source}: ×2")
    for other_index, earned in enumerate(incoming_angels if rules.angel_numbers else ()):
        source = f" (opponent {other_index + 1})" if len(incoming_angels) > 1 else ""
        for rank in sorted(set(earned) & set(ANGEL_MULTIPLIERS)):
            effects.append(f"Incoming Angel {rank}{rank}{rank}{source}: ×{rank}")
    if rules.poisoned_card and poisoned:
        effects.append(f"Poisoned Card: +{POISON_POINTS}")
    if rules.king_queen:
        for i in range(3):
            if layout[i].visible and layout[i + 3].visible and {layout[i].card.rank, layout[i + 3].card.rank} == {12, 13}:
                value = 5 if layout[i].card.red == layout[i + 3].card.red else 15
                effects.append(f"King-Queen column {i + 1}: {value} ({value - 10:+d})")
    return effects


def visible_effect_total(layout, rules, angels_earned=(), opponent_layout=None, poisoned=False,
                         *, opponent_layouts=None, incoming_angels=()):
    """incoming_angels: the Angel numbers each opponent has earned, one set per opponent."""
    subtotal = column_score(layout, rules, True) + score_adjustments(layout, rules, True)[0]
    incoming = opponent_layouts if opponent_layouts is not None else [opponent_layout] if opponent_layout is not None else []
    subtotal += sum(opponent_adjustment(other, rules, True) for other in incoming)
    if rules.poisoned_card and poisoned:
        subtotal += POISON_POINTS
    divisor = angel_divisor(rules, angels_earned)
    divisor *= prod(factor for _, factor in v_pattern_effects(layout, rules, True))
    if all_color(layout, rules, True) is False:
        divisor *= 2
    subtotal *= prod(angel_multiplier(rules, earned) for earned in incoming_angels)
    subtotal *= prod(color_multiplier(other, rules, True) for other in incoming)
    return (subtotal + divisor - 1) // divisor
