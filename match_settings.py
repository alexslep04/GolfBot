"""Versioned house presets; change the version for rule or scoring revisions."""
from game import Rules

HOUSE_VERSION = "11"  # 8: the ripped 5 reworked; 9: Poisoned Card +1; 10: Crazy 888 joins; 11: ripped 5 opposite row only
HOUSE_KEYS = frozenset({
    'royal_pairs', 'devils_row', 'gamblers_row', 'angels_row', 'king_queen',
    'holdem', 'v10', 'tricky_straights', 'ripped_five', 'roman_fives',
    'poisoned_card', 'all_in_color', 'crazy_eights',
})


def house_rules():
    return {key: key in HOUSE_KEYS for key in Rules.__dataclass_fields__}
