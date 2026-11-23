"""All-time records for the Leaderboard's Records tab, read from saved results."""
import time

from game import RULE_OPTIONS
from player_stats import BOT_ID, identities

RULE_NAMES = dict(RULE_OPTIONS)
# Rules that come into play in every game they are on (the Poisoned Card always
# lands on whoever finishes), so they would always top "most common".
ALWAYS_IN_PLAY = ('poisoned_card',)


def _rounds(results):
    for match in results:
        for game in match.get('rounds') or []:
            yield match, game


def highest_elo(results, ratings=(), player=None):
    """The highest Elo anyone (or one player) has reached: after any rated game, or as stored now."""
    best = None
    for match, game in _rounds(results):
        for entry in game.get('elo') or []:
            if player is not None and entry['id'] != player:
                continue
            if best is None or entry['after'] > best['elo']:
                best = {'id': entry['id'], 'label': entry['label'], 'elo': entry['after'],
                        'at': game.get('ended_at'), 'patch': game.get('patch') or match.get('patch')}
    for row in ratings:
        if player is not None and row['id'] != player:
            continue
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


def largest_comeback(results, player=None):
    """The most points a game's winner was ever behind the leader, by the scores showing after each turn."""
    best = None
    for match, game in _rounds(results):
        winner = game.get('winner')
        if player is not None and (winner is None or winner >= len(identities(match)) or identities(match)[winner] != player):
            continue
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
    in play); the least is by rate."""
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
    contenders = [entry for entry in ranked if entry['key'] not in ALWAYS_IN_PLAY]
    most = max(contenders, key=lambda entry: entry['activations'], default=None)
    return {'most': most if most and most['activations'] else None,
            'least': ranked[0] if len(ranked) > 1 else None}


def favorite_modifier(results, player):
    """The modifier one player has brought into play most often (never one always in play, as for the record)."""
    counts = {}
    for _, game, seats in _played(results):
        activations = game.get('activations') or []
        for seat, who, _ in seats:
            if who == player and seat < len(activations):
                for key in set(activations[seat]) & set(RULE_NAMES) - set(ALWAYS_IN_PLAY):
                    entry = counts.setdefault(key, {'key': key, 'name': RULE_NAMES[key], 'activations': 0})
                    entry['activations'] += 1
    return max(counts.values(), key=lambda entry: entry['activations'], default=None)


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


def games_today(results, now=None):
    """How many games each player has finished since midnight (server time), bots aside."""
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
    return counts


def most_games_today(results, now=None):
    """Who has finished the most games since midnight (server time)."""
    return max(games_today(results, now).values(), key=lambda entry: entry['games'], default=None)


def most_modifiers_in_a_game(results, only=None):
    """The most different modifiers one player had come into play in a single game."""
    best = None
    for _, game, seats in _played(results):
        activations = game.get('activations') or []
        for seat, player, name in seats:
            if only is not None and player != only:
                continue
            keys = [key for key in (activations[seat] if seat < len(activations) else []) if key in RULE_NAMES]
            if keys and (best is None or len(keys) > best['count']):
                best = {'id': player, 'label': name, 'count': len(keys),
                        'rules': [RULE_NAMES[key] for key in keys], 'at': game.get('ended_at')}
    return best


def biggest_yapper(results):
    """Who has sent the most emotes at the table, over every game since they were counted."""
    return max(emotes_sent(results).values(), key=lambda entry: entry['emotes'], default=None)


def emotes_sent(results):
    """Emotes each player has sent at the table, over every game since they were counted."""
    counts = {}
    for _, game, seats in _played(results):
        sent = game.get('emotes') or []
        for seat, player, name in seats:
            if player != BOT_ID and seat < len(sent) and sent[seat]:
                entry = counts.setdefault(player, {'id': player, 'label': name, 'emotes': 0})
                entry['emotes'] += sent[seat]
                entry['label'] = name
    return counts


def longest_pvp_game(results, player=None):
    """The 1v1 game between two people that took the most turns to finish (the first to reach it holds it)."""
    best = None
    for match, game in _rounds(results):
        turns = game.get('turns') or 0
        names, winner = match.get('names') or [], game.get('winner')
        if (match.get('solo') or len(names) != 2 or game.get('forfeit') or turns <= 0
                or (best and turns <= best['turns'])):
            continue
        ids = identities(match)
        if player is not None and player not in ids:
            continue
        best = {'turns': turns, 'players': list(names), 'scores': game.get('scores'),
                'id': ids[winner] if winner is not None and winner < len(ids) else None,
                'label': names[winner] if winner is not None and winner < len(names) else None,
                'at': game.get('ended_at')}
    return best


def highest_score(results, only=None):
    """The most points any person has finished a single game with."""
    best = None
    for _, game, seats in _played(results):
        scores = game.get('scores') or []
        if game.get('forfeit'):
            continue
        for seat, player, name in seats:
            if only is not None and player != only:
                continue
            if player != BOT_ID and seat < len(scores) and (best is None or scores[seat] > best['points']):
                best = {'id': player, 'label': name, 'points': scores[seat], 'scores': scores,
                        'at': game.get('ended_at')}
    return best


def lowest_score(results, only=None):
    """The fewest points any person has finished a single game with (the first to reach it holds it)."""
    best = None
    for _, game, seats in _played(results):
        scores = game.get('scores') or []
        if game.get('forfeit'):
            continue
        for seat, player, name in seats:
            if only is not None and player != only:
                continue
            if player != BOT_ID and seat < len(scores) and (best is None or scores[seat] < best['points']):
                best = {'id': player, 'label': name, 'points': scores[seat], 'scores': scores,
                        'at': game.get('ended_at')}
    return best


def biggest_party(results, player=None):
    """The game with the most signed-in players at one table (the first to reach it holds it)."""
    best = None
    for match, game in _rounds(results):
        names = match.get('names') or []
        if player is not None and player not in identities(match):
            continue
        signed_in = [names[seat] for seat, player in enumerate(identities(match)) if (player or '').startswith('account:')]
        if len(signed_in) >= 2 and (best is None or len(signed_in) > best['count']):
            best = {'count': len(signed_in), 'players': signed_in, 'seats': len(names), 'at': game.get('ended_at')}
    return best


# a game is counted for at most this long, so a table left open doesn't run up the clock
GAME_TIME_CAP = 30 * 60


def time_played(results):
    """Seconds each player has spent in games (bots aside): from each game's deal to its end.
    Games saved before their start was recorded are timed from the end of the game before
    them (or the series' start)."""
    totals = {}
    for match in results:
        names, ids = match.get('names') or [], identities(match)
        previous = match.get('started_at')
        for game in match.get('rounds') or []:
            ended = game.get('ended_at')
            started = game.get('started_at')
            started = previous if started is None else started
            previous = ended or previous
            if not (isinstance(ended, (int, float)) and isinstance(started, (int, float))):
                continue
            seconds = min(max(ended - started, 0), GAME_TIME_CAP)
            for seat in range(min(len(names), len(game.get('scores') or names))):
                if ids[seat] == BOT_ID:
                    continue
                entry = totals.setdefault(ids[seat], {'id': ids[seat], 'label': names[seat], 'seconds': 0})
                entry['seconds'] += seconds
                entry['label'] = names[seat]
    return totals


def most_time_played(results):
    return max(time_played(results).values(), key=lambda entry: entry['seconds'], default=None)


HELD_RECORDS = ('highest_elo', 'pvp_streak', 'comeback', 'games_today', 'modifiers_in_game', 'most_time',
                'yapper', 'bogey', 'lowest')


def player_card(results, ratings, player):
    """What the name-tag popup shows: a player's Elo, their best 1v1 win streak, and the records they hold."""
    records = build_records(results, ratings)
    rating = next((row for row in ratings if row['id'] == player), None)
    return {'id': player, 'elo': rating['elo'] if rating else None,
            'pvp_streak': (pvp_streaks(results).get(player) or {}).get('streak', 0),
            'seconds_played': round((time_played(results).get(player) or {}).get('seconds', 0)),
            'records': {key: records[key] for key in HELD_RECORDS
                        if records.get(key) and records[key].get('id') == player}}


def personal_records(results, ratings, player):
    """One player's own best at each record, for the box under its card (None where they have none)."""
    if not player or player == BOT_ID:
        return {}
    streak = pvp_streaks(results).get(player)
    seconds = time_played(results).get(player)
    return {'id': player, 'highest_elo': highest_elo(results, ratings, player), 'pvp_streak': streak,
            'comeback': largest_comeback(results, player), 'games_today': games_today(results).get(player),
            'most_modifier': favorite_modifier(results, player),
            'modifiers_in_game': most_modifiers_in_a_game(results, player),
            'yapper': emotes_sent(results).get(player), 'longest_pvp': longest_pvp_game(results, player),
            'bogey': highest_score(results, player), 'lowest': lowest_score(results, player),
            'party': biggest_party(results, player), 'most_time': seconds}


def build_records(results, ratings=()):
    modifiers = modifier_frequency(results)
    return {'highest_elo': highest_elo(results, ratings), 'comeback': largest_comeback(results),
            'most_modifier': modifiers['most'], 'least_modifier': modifiers['least'],
            'comeback_modifier': comeback_modifier(results),
            'pvp_streak': best_pvp_streak(results), 'games_today': most_games_today(results),
            'modifiers_in_game': most_modifiers_in_a_game(results),
            'most_time': most_time_played(results),
            'yapper': biggest_yapper(results), 'longest_pvp': longest_pvp_game(results),
            'bogey': highest_score(results), 'lowest': lowest_score(results),
            'party': biggest_party(results),
            'always_in_play': [RULE_NAMES[key] for key in ALWAYS_IN_PLAY]}
