"""All-time records for the Leaderboard's Records tab, read from saved results."""
import time

from game import RULE_OPTIONS
from player_stats import BOT_ID, identities

RULE_NAMES = dict(RULE_OPTIONS)
# Rules that come into play in every game they are on (the Poisoned Card always
# lands on whoever finishes), so they would always top "most common".
ALWAYS_IN_PLAY = ('poisoned_card',)
# Never named the most common modifier.
NOT_MOST_COMMON = ('beggars',)


def _rounds(results):
    for match in results:
        for game in match.get('rounds') or []:
            yield match, game


def highest_elo(results, ratings=()):
    """The highest Elo anyone has reached: after any rated game, or as stored now."""
    best = None
    for match, game in _rounds(results):
        for entry in game.get('elo') or []:
            if best is None or entry['after'] > best['elo']:
                best = {'id': entry['id'], 'label': entry['label'], 'elo': entry['after'],
                        'at': game.get('ended_at'), 'patch': game.get('patch') or match.get('patch')}
    for row in ratings:
        if best is None or row['elo'] > best['elo']:
            best = {'id': row['id'], 'label': row['label'], 'elo': row['elo'], 'at': None, 'patch': None}
    return best


def _deficit(game):
    """How far a game's winner was ever behind the leader (0 if never), by the scores showing after each turn."""
    winner, timeline = game.get('winner'), game.get('timeline') or []
    if winner is None:
        return 0
    return max((scores[winner] - min(s for p, s in enumerate(scores) if p != winner)
                for scores in timeline if len(scores) > winner), default=0)


def largest_comeback(results):
    """The most points a game's winner was ever behind the leader, by the scores showing after each turn."""
    best = None
    for match, game in _rounds(results):
        winner = game.get('winner')
        deficit = _deficit(game)
        if deficit > 0 and (best is None or deficit > best['points']):
            names = match.get('names') or []
            best = {'id': identities(match)[winner] if winner < len(names) else None,
                    'label': names[winner] if winner < len(names) else 'Player',
                    'points': deficit, 'scores': game.get('scores'),
                    'opponents': [name for p, name in enumerate(names) if p != winner],
                    'at': game.get('ended_at')}
    return best


def comeback_modifier(results):
    """The modifier most often in play for a winner who had been behind (a comeback win)."""
    counts = {}
    for _, game in _rounds(results):
        activations = game.get('activations') or []
        winner = game.get('winner')
        if _deficit(game) <= 0 or winner is None or winner >= len(activations):
            continue
        for key in set(activations[winner]) & set(RULE_NAMES):
            entry = counts.setdefault(key, {'key': key, 'name': RULE_NAMES[key], 'wins': 0})
            entry['wins'] += 1
    return max(counts.values(), key=lambda entry: entry['wins'], default=None)


def modifier_frequency(results):
    """For each rule: in how many games it was on, in how many it came into play, and how many times
    any player brought it into play. The most common is simply the most activated (never one always
    in play, nor Beggars, whose guess is offered rather than earned); the least is by rate."""
    counts = {}
    for _, game in _rounds(results):
        rules, activations = game.get('rules') or {}, game.get('activations')
        if activations is None:
            continue
        active = {key for keys in activations for key in keys}
        for key, enabled in rules.items():
            if not enabled or key not in RULE_NAMES:
                continue
            entry = counts.setdefault(key, {'key': key, 'name': RULE_NAMES[key], 'games': 0, 'active': 0, 'activations': 0})
            entry['games'] += 1
            entry['active'] += key in active
            entry['activations'] += sum(key in keys for keys in activations)
    ranked = sorted(counts.values(), key=lambda entry: (entry['active'] / entry['games'], entry['games']))
    for entry in ranked:
        entry['rate'] = entry['active'] / entry['games']
    contenders = [entry for entry in ranked if entry['key'] not in ALWAYS_IN_PLAY + NOT_MOST_COMMON]
    most = max(contenders, key=lambda entry: entry['activations'], default=None)
    return {'most': most if most and most['activations'] else None,
            'least': ranked[0] if len(ranked) > 1 else None}


def _played(results):
    """Every finished game with its players: (match, game, [(seat, id, name)])."""
    for match, game in _rounds(results):
        names = match.get('names') or []
        ids = identities(match)
        yield match, game, [(seat, ids[seat], names[seat]) for seat in range(min(len(names), len(game.get('scores') or names)))]


def pvp_streaks(results):
    """Each player's most 1v1 games against another person won in a row (a draw or loss ends it)."""
    games = sorted(((game.get('ended_at') or 0, game, seats) for match, game, seats in _played(results)
                    if not match.get('solo') and len(seats) == 2), key=lambda item: item[0])
    current, best = {}, {}
    for at, game, seats in games:
        for seat, player, name in seats:
            current[player] = current.get(player, 0) + 1 if game.get('winner') == seat else 0
            if current[player] and current[player] > best.get(player, {}).get('streak', 0):
                best[player] = {'id': player, 'label': name, 'streak': current[player], 'at': at}
    return best


def best_pvp_streak(results):
    """The most 1v1 games against another person anyone has won in a row; the first to reach it holds it."""
    return max(pvp_streaks(results).values(), key=lambda entry: (entry['streak'], -entry['at']), default=None)


def most_games_today(results, now=None):
    """Who has finished the most games since midnight (server time), bots aside."""
    now = time.time() if now is None else now
    midnight = time.mktime(time.localtime(now)[:3] + (0, 0, 0, 0, 0, -1))
    counts = {}
    for _, game, seats in _played(results):
        if (game.get('ended_at') or 0) < midnight:
            continue
        for _, player, name in seats:
            if player != BOT_ID:
                entry = counts.setdefault(player, {'id': player, 'label': name, 'games': 0})
                entry['games'] += 1
                entry['label'] = name
    return max(counts.values(), key=lambda entry: entry['games'], default=None)


def most_modifiers_in_a_game(results):
    """The most different modifiers one player had come into play in a single game."""
    best = None
    for _, game, seats in _played(results):
        activations = game.get('activations') or []
        for seat, player, name in seats:
            keys = [key for key in (activations[seat] if seat < len(activations) else []) if key in RULE_NAMES]
            if keys and (best is None or len(keys) > best['count']):
                best = {'id': player, 'label': name, 'count': len(keys),
                        'rules': [RULE_NAMES[key] for key in keys], 'at': game.get('ended_at')}
    return best


HELD_RECORDS = ('highest_elo', 'pvp_streak', 'comeback', 'games_today', 'modifiers_in_game')


def player_card(results, ratings, player):
    """What the name-tag popup shows: a player's Elo, their best 1v1 win streak, and the records they hold."""
    records = build_records(results, ratings)
    rating = next((row for row in ratings if row['id'] == player), None)
    return {'id': player, 'elo': rating['elo'] if rating else None,
            'pvp_streak': (pvp_streaks(results).get(player) or {}).get('streak', 0),
            'records': {key: records[key] for key in HELD_RECORDS
                        if records.get(key) and records[key].get('id') == player}}


def build_records(results, ratings=()):
    modifiers = modifier_frequency(results)
    return {'highest_elo': highest_elo(results, ratings), 'comeback': largest_comeback(results),
            'most_modifier': modifiers['most'], 'least_modifier': modifiers['least'],
            'comeback_modifier': comeback_modifier(results),
            'pvp_streak': best_pvp_streak(results), 'games_today': most_games_today(results),
            'modifiers_in_game': most_modifiers_in_a_game(results),
            'always_in_play': [RULE_NAMES[key] for key in ALWAYS_IN_PLAY],
            'never_most': [RULE_NAMES[key] for key in NOT_MOST_COMMON]}
