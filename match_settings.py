"""Versioned house presets; change the version for rule or scoring revisions."""
from game import Rules

HOUSE_VERSION = "13"  # 8: the ripped 5 reworked; 9: Poisoned Card +1; 10: Crazy 888 joins; 11: ripped 5 opposite row only; 12: Angel numbers; 13: Suited rows joins
HOUSE_KEYS = frozenset({
    'royal_pairs', 'angel_numbers', 'king_queen',
    'holdem', 'v10', 'tricky_straights', 'ripped_five', 'roman_fives',
    'poisoned_card', 'all_in_color', 'suited_rows',
})


def house_rules():
    return {key: key in HOUSE_KEYS for key in Rules.__dataclass_fields__}
