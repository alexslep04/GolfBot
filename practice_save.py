"""Private, versioned JSON snapshots for signed-in practice games."""
import random
from dataclasses import asdict
from game import GolfGame, Card, Slot, Rules, rules_from
from scoring import ANGEL_RANKS

SCHEMA = 1


def encode(value):
    if isinstance(value, Card):
        return {'$card': [value.rank, value.suit, value.deck]}
    if isinstance(value, Slot):
        return {'$slot': [encode(value.card), value.visible]}
    if isinstance(value, Rules):
        return {'$rules': asdict(value)}
    if isinstance(value, random.Random):
        return {'$rng': encode(value.getstate())}
    # frozenset is not a subclass of set: the J-J / Q-Q bonus keeps each used
    # pair as one, so it needs its own tag or json.dumps fails mid-game
    if isinstance(value, frozenset):
        return {'$frozenset': [encode(v) for v in value]}
    if isinstance(value, (set, tuple)):
        return {'$set' if isinstance(value, set) else '$tuple': [encode(v) for v in value]}
    if isinstance(value, list):
        return [encode(v) for v in value]
    if isinstance(value, dict):
        return {k: encode(v) for k, v in value.items()}
    return value


def decode(value):
    if isinstance(value, list):
        return [decode(v) for v in value]
    if not isinstance(value, dict):
        return value
    if '$card' in value:
        return Card(*value['$card'])
    if '$slot' in value:
        return Slot(decode(value['$slot'][0]), value['$slot'][1])
    if '$rules' in value:
        return rules_from(value['$rules'])
    if '$tuple' in value:
        return tuple(decode(v) for v in value['$tuple'])
    if '$set' in value:
        return set(decode(v) for v in value['$set'])
    if '$frozenset' in value:
        return frozenset(decode(v) for v in value['$frozenset'])
    if '$rng' in value:
        rng = random.Random()
        rng.setstate(decode(value['$rng']))
        return rng
    return {k: decode(v) for k, v in value.items()}


ROOM_FIELDS = ('id', 'name', 'best_of', 'first', 'names', 'status', 'ready', 'wins',
               'history', 'version', 'round_recorded', 'last_winner', 'champion',
               'match_id', 'started_at', 'participants', 'house_rules', 'house_version',
               'series_mode', 'game_type', 'patch', 'series_complete', 'avatars')


def save(room):
    return {'schema': SCHEMA, 'patch': room.patch,
            'room': {key: getattr(room, key) for key in ROOM_FIELDS},
            'rules': asdict(room.rules), 'game': encode(vars(room.game))}


def restore_game(payload):
    game = GolfGame.__new__(GolfGame)
    game.__dict__.update(decode(payload))
    if not hasattr(game, 'activated_subrules'):
        # saved before the parts of each rule were tracked: they count from here on
        game.activated_subrules = [set() for _ in game.players]
    if not hasattr(game, 'angels_earned'):
        # saved before 666/777/888/999 became Angel numbers: 777 and 999 were
        # earned flags, and a 666 row left its cards locked in the hand
        locked = game.__dict__.pop('locked_cards', set())
        gamblers = game.__dict__.pop('gambler_earned', [False] * game.player_count)
        angels = game.__dict__.pop('angel_earned', [False] * game.player_count)
        game.angels_earned = [{rank for rank, earned in ((6, any(slot.card in locked for slot in hand)),
                                                         (7, gamblers[p]), (9, angels[p])) if earned}
                              for p, hand in enumerate(game.players)]
        if game.rules.angel_numbers:
            # Crazy 888 only counted a row still in the hand; a face-up row earns it now
            for p, hand in enumerate(game.players):
                for row in (hand[:3], hand[3:]):
                    if all(slot.visible and slot.card.rank == row[0].card.rank for slot in row) and row[0].card.rank in ANGEL_RANKS:
                        game.angels_earned[p].add(row[0].card.rank)
    return game
