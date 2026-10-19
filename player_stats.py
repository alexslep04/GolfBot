"""Statistics from saved results, grouped by username rather than browser identity."""
from collections import Counter

BOT_ID = 'bot:golfbot'


def identities(match):
    return ['player:' + match['names'][0],
            BOT_ID if match.get('solo') else 'player:' + match['names'][1]]


def player_catalog(matches):
    players = {}
    for match in matches:
        for seat, player_id in enumerate(identities(match)):
            bot = player_id == BOT_ID
            name = 'GolfBot' if bot else match['names'][seat]
            players[player_id] = {'id': player_id, 'username': name, 'is_bot': bot,
                                  'label': 'GolfBot (solo AI)' if bot else name + (' (player)' if name == 'GolfBot' else '')}
    return sorted(players.values(), key=lambda player: (player['is_bot'], player['username'].casefold(), player['id']))


def matches_rules(rules, enabled, disabled):
    return all(rules.get(key, False) for key in enabled) and all(not rules.get(key, False) for key in disabled)


def summarize(matches, player_id, enabled=(), disabled=(), opponent_id=None):
    wins = losses = draws = total_points = opponent_points = 0
    match_wins = match_losses = completed_matches = unfinished_matches = ambiguous_matches = 0
    points, divisors = [], Counter()
    for match in matches:
        seats = identities(match)
        if player_id not in seats:
            continue
        if seats[0] == seats[1]:
            # Without accounts these two seats cannot be distinguished by name.
            ambiguous_matches += 1
            continue
        seat = seats.index(player_id)
        if opponent_id is not None and seats[1 - seat] != opponent_id:
            continue
        rounds = [result for result in match['rounds']
                  if matches_rules(result.get('rules', match['rules']), enabled, disabled)]
        for result in rounds:
            own, other = result['scores'][seat], result['scores'][1 - seat]
            wins += own < other
            losses += own > other
            draws += own == other
            points.append(own)
            total_points += own
            opponent_points += other
            recorded = result.get('divisors')
            if (isinstance(recorded, list) and len(recorded) == 2
                    and type(recorded[seat]) is int and recorded[seat] >= 1):
                divisors[recorded[seat]] += 1
        if rounds:
            if match['status'] != 'finished':
                unfinished_matches += 1
            elif len(rounds) == len(match['rounds']):
                # A mixed-rule series is only counted if every round fits.
                completed_matches += 1
                match_wins += match['winner'] == seat
                match_losses += match['winner'] == 1 - seat
    count = len(points)
    known = sum(divisors.values())
    return {
        'rounds': count, 'round_wins': wins, 'round_losses': losses, 'round_draws': draws,
        'round_win_rate': wins / count if count else None,
        'completed_matches': completed_matches, 'match_wins': match_wins, 'match_losses': match_losses,
        'match_win_rate': match_wins / completed_matches if completed_matches else None,
        'unfinished_matches': unfinished_matches, 'ambiguous_matches': ambiguous_matches,
        'total_points': total_points, 'average_points': total_points / count if count else None,
        'average_opponent_points': opponent_points / count if count else None,
        'average_advantage': (opponent_points - total_points) / count if count else None,
        'best_round': min(points) if count else None, 'worst_round': max(points) if count else None,
        'known_multiplier_rounds': known, 'unknown_multiplier_rounds': count - known,
        'multipliers': [{'divisor': divisor, 'count': occurrences, 'rate': occurrences / known}
                        for divisor, occurrences in sorted(divisors.items(), key=lambda item: (-item[1], item[0]))],
    }


def build_stats(matches, player_id=None, opponent_id=None, enabled=(), disabled=()):
    players = player_catalog(matches)
    by_id = {player['id']: player for player in players}
    if player_id is None and players:
        player_id = players[0]['id']
    if player_id is not None and player_id not in by_id:
        raise ValueError('That player has no saved results.')
    if opponent_id is not None and opponent_id not in by_id:
        raise ValueError('That comparison player has no saved results.')
    if player_id is not None and player_id == opponent_id:
        raise ValueError('Choose two different players to compare.')

    def entry(selected, opponent):
        return {'profile': by_id[selected], 'overall': summarize(matches, selected, enabled, disabled),
                'head_to_head': summarize(matches, selected, enabled, disabled, opponent) if opponent else None}

    return {'players': players, 'player': entry(player_id, opponent_id) if player_id else None,
            'comparison': entry(opponent_id, player_id) if opponent_id else None,
            'filters': {'enabled': list(enabled), 'disabled': list(disabled)}}
