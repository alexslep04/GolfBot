"""Versioned house presets; change the version for rule or scoring revisions."""
from game import Rules

HOUSE_VERSION = "4"
HOUSE_KEYS = frozenset({
    'royal_pairs', 'devils_row', 'gamblers_row', 'angels_row', 'king_queen',
    'holdem', 'v10', 'tricky_straights', 'ripped_five', 'roman_fives',
    'poisoned_card',
})


def house_rules():
    return {key: key in HOUSE_KEYS for key in Rules.__dataclass_fields__}
