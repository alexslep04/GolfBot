"""Statistics from saved results, grouped by account or guest display name."""
from collections import Counter
from game import RULE_OPTIONS
from patches import PATCH_VERSION

BOT_ID = 'bot:golfbot'
GUESTS_ID = 'guests'  # the single row every guest shares on the ranking


def identities(match):
    participants = match.get('participants') or [None] * len(match['names'])
    return [(participants[seat] or {}).get('id') or
            (BOT_ID if seat == 1 and match.get('solo') else 'player:' + match['names'][seat]) for seat in range(len(match['names']))]


def merged_id(player_id):
    """Accounts and bots keep their own ids; every guest (by browser or by name) is one Guest."""
    if player_id is None or player_id == GUESTS_ID or player_id.startswith(('account:', 'bot:')):
        return player_id
    return GUESTS_ID


def merge_guest_seats(match):
    """A copy of a saved match with each guest seat sitting as the one shared Guest."""
    participants = list(match.get('participants') or [None] * len(match['names']))
    for seat, player_id in enumerate(identities(match)):
        if merged_id(player_id) == GUESTS_ID:
            participants[seat] = {'id': GUESTS_ID, 'kind': 'guest', 'display_name': 'Guest'}
    return {**match, 'participants': participants}


def player_catalog(matches, profiles=()):
    players = {}

    def add(player_id, profile, display_name):
        if player_id == GUESTS_ID:
            players[player_id] = {'id': GUESTS_ID, 'username': 'Guest', 'unique_name': None, 'is_bot': False,
                                  'display_names': [], 'is_guest': True, 'label': 'Guest'}
            return
        bot = player_id == BOT_ID
        unique = profile.get('unique_name')
        name = 'Golfbot' if bot else unique or display_name
        aliases = set(players.get(player_id, {}).get('display_names', [])) | {display_name}
        players[player_id] = {'id': player_id, 'username': name, 'unique_name': unique, 'is_bot': bot,
                              'display_names': sorted(aliases), 'is_guest': not bot and not unique,
                              'label': 'Golfbot (solo AI)' if bot else '@' + unique if unique else name + ' (guest)'}

    for match in matches:
        for seat, player_id in enumerate(identities(match)):
            profile = ((match.get('participants') or [None] * len(match['names']))[seat] or {})
            add(player_id, profile, match['names'][seat])
    # Current public identities refresh names while retaining historical aliases.
    for profile in profiles:
        add(profile['id'], profile, profile.get('display_name') or profile.get('unique_name') or
            ('Golfbot' if profile['id'] == BOT_ID else profile['id'].removeprefix('player:')))
    return sorted(players.values(), key=lambda player: (player['is_bot'], player['username'].casefold(), player['id']))


def matches_rules(rules, enabled, disabled):
    return all(rules.get(key, False) for key in enabled) and all(not rules.get(key, False) for key in disabled)


def result_patch(result, match):
    return result.get('patch', match.get('patch')) or 'legacy'


def recorded_modifier_counts(result, seat, player_count):
    """Read a source-owned final snapshot; legacy activation sets lack multiplicity."""
    recorded = result.get('modifier_counts')
    if not isinstance(recorded, list) or len(recorded) != player_count:
        return None
    counts = recorded[seat]
    rule_keys = {key for key, _ in RULE_OPTIONS}
    if not isinstance(counts, dict) or any(
            key not in rule_keys or type(value) is not int or value < 0 for key, value in counts.items()):
        return None
    return counts


def recorded_move_time(result, seat, player_count):
    """(seconds, turns) this seat was timed for in one game, or None if it has no record."""
    seconds, counts = result.get('move_seconds'), result.get('move_counts')
    if not (isinstance(seconds, list) and isinstance(counts, list) and len(seconds) == len(counts) == player_count):
        return None
    if type(counts[seat]) is not int or counts[seat] <= 0 or not isinstance(seconds[seat], (int, float)) or seconds[seat] < 0:
        return None
    return seconds[seat], counts[seat]


def combine_guests(rows):
    """Fold every guest's standing into one "Guest" row; accounts and Golfbot stay as they are."""
    guests = [row for row in rows if row['profile']['is_guest']]
    if not guests:
        return rows
    total = {key: sum(row[key] for row in guests) for key in (
        'rounds', 'round_wins', 'round_losses', 'round_draws',
        'completed_matches', 'match_wins', 'match_losses', 'match_draws')}
    points = sum(row['average_points'] * row['rounds'] for row in guests if row['rounds'])
    combined = {'profile': {'id': GUESTS_ID, 'username': 'Guest', 'unique_name': None, 'is_bot': False,
                            'display_names': [], 'is_guest': True, 'label': 'Guest', 'guests': len(guests)},
                **total,
                'round_win_rate': total['round_wins'] / total['rounds'] if total['rounds'] else None,
                'match_win_rate': total['match_wins'] / total['completed_matches'] if total['completed_matches'] else None,
                'average_points': points / total['rounds'] if total['rounds'] else None}
    return [row for row in rows if not row['profile']['is_guest']] + [combined]


def summarize(matches, player_id, enabled=(), disabled=(), opponent_id=None, house_only=False, patch=None):
    wins = losses = draws = total_points = opponent_points = 0
    match_wins = match_losses = completed_matches = unfinished_matches = ambiguous_matches = 0
    match_draws = 0
    points, activations, activation_wins = [], Counter(), Counter()
    known_activations = 0
    turns, modifier_counts = [], []
    move_seconds, move_turns = 0.0, 0
    # who had the first turn (recorded from 1.4.0): games started, and wins either way
    first_games = first_wins = later_games = later_wins = 0
    for match in matches:
        seats = identities(match)
        if player_id not in seats:
            continue
        # The one shared Guest plays every guest seat at a table (as the ranking sums
        # every guest's record); anyone else must be told apart by a single seat.
        if (player_id != GUESTS_ID and seats.count(player_id) != 1) or (
                opponent_id not in (None, GUESTS_ID) and seats.count(opponent_id) > 1):
            # Without accounts these two seats cannot be distinguished by name.
            ambiguous_matches += 1
            continue
        if opponent_id is not None and opponent_id not in seats:
            continue
        for seat in [p for p, player in enumerate(seats) if player == player_id]:
            opponents = ([p for p, player in enumerate(seats) if player == opponent_id] if opponent_id
                         else [p for p in range(len(seats)) if p != seat])
            rounds = [result for result in match['rounds']
                      if (not house_only or result.get('house_rules', False))
                      and (not patch or result_patch(result, match) == patch)
                      and matches_rules(result.get('rules', match['rules']), enabled, disabled)]
            for result in rounds:
                own = result['scores'][seat]
                other_scores = [result['scores'][p] for p in opponents]
                other = sum(other_scores) / len(other_scores)
                comparison = min(other_scores)
                wins += own < comparison
                losses += own > comparison
                draws += own == comparison
                points.append(own)
                total_points += own
                opponent_points += other
                if type(result.get('turns')) is int:
                    turns.append(result['turns'])
                if type(result.get('first')) is int and 0 <= result['first'] < len(seats) and not result.get('forfeit'):
                    if result['first'] == seat:
                        first_games += 1
                        first_wins += own < comparison
                    else:
                        later_games += 1
                        later_wins += own < comparison
                timed = recorded_move_time(result, seat, len(seats))
                if timed:
                    move_seconds += timed[0]
                    move_turns += timed[1]
                counts = recorded_modifier_counts(result, seat, len(seats))
                if counts is not None:
                    modifier_counts.append(sum(counts.values()))
                recorded = result.get('activations')
                if isinstance(recorded, list) and len(recorded) == len(seats) and isinstance(recorded[seat], list):
                    known_activations += 1
                    for key in set(recorded[seat]) & {key for key, _ in RULE_OPTIONS}:
                        activations[key] += 1
                        activation_wins[key] += own < comparison
            if rounds:
                if match['status'] != 'finished':
                    unfinished_matches += 1
                elif len(rounds) == len(match['rounds']):
                    # A mixed-rule series is only counted if every round fits.
                    completed_matches += 1
                    if opponent_id and len(seats) > 2:
                        totals = match['points']
                        match_wins += totals[seat] < totals[opponents[0]]
                        match_losses += totals[seat] > totals[opponents[0]]
                        match_draws += totals[seat] == totals[opponents[0]]
                    else:
                        match_wins += match['winner'] == seat
                        tied = match.get('series_leaders', list(range(len(seats))))
                        match_losses += (match['winner'] is not None and match['winner'] != seat) or (match['winner'] is None and seat not in tied)
                        match_draws += match['winner'] is None and seat in tied
    count = len(points)
    return {
        'rounds': count, 'round_wins': wins, 'round_losses': losses, 'round_draws': draws,
        'round_win_rate': wins / count if count else None,
        'completed_matches': completed_matches, 'match_wins': match_wins, 'match_losses': match_losses,
        'match_draws': match_draws,
        'match_win_rate': match_wins / completed_matches if completed_matches else None,
        'unfinished_matches': unfinished_matches, 'ambiguous_matches': ambiguous_matches,
        'total_points': total_points, 'average_points': total_points / count if count else None,
        'average_opponent_points': opponent_points / count if count else None,
        'average_advantage': (total_points - opponent_points) / count if count else None,
        'average_turns': sum(turns) / len(turns) if turns else None,
        'known_turn_games': len(turns),
        # the first turn: how often it was theirs, and how they did with and without it
        'known_first_games': first_games + later_games,
        'first_games': first_games,
        'first_rate': first_games / (first_games + later_games) if first_games + later_games else None,
        'first_wins': first_wins, 'first_win_rate': first_wins / first_games if first_games else None,
        'later_games': later_games, 'later_wins': later_wins,
        'later_win_rate': later_wins / later_games if later_games else None,
        # seconds per turn, over the turns the player was at the table for
        'average_move_seconds': move_seconds / move_turns if move_turns else None,
        'timed_turns': move_turns,
        # Keep the public metric key, now counting actual final modifier instances.
        'average_rules_in_play': sum(modifier_counts) / len(modifier_counts) if modifier_counts else None,
        'known_modifier_games': len(modifier_counts), 'unknown_modifier_games': count - len(modifier_counts),
        'best_round': min(points) if count else None, 'worst_round': max(points) if count else None,
        'known_activation_games': known_activations, 'unknown_activation_games': count - known_activations,
        'rule_activations': [{'key': key, 'name': name, 'games': activations[key],
                              'rate': activations[key] / known_activations if known_activations else None,
                              'wins': activation_wins[key],
                              'win_rate': activation_wins[key] / activations[key] if activations[key] else None}
                             for key, name in RULE_OPTIONS],
    }


def build_stats(matches, player_id=None, opponent_id=None, enabled=(), disabled=(), house_only=False, patch=None,
                profiles=(), merge_guests=False):
    """Seed public viewer/bot identities even before their first recorded round.

    The first supplied profile is the default viewer; explicit selections win.
    With no seeds, historical catalog selection and empty-history behavior stay the same.
    merge_guests: every guest is one "Guest" player (in the choices, the stats and the
    comparison); a game between two guests then has no single Guest seat and is left out.
    """
    profiles = tuple(profiles)
    if merge_guests:
        matches = [merge_guest_seats(match) for match in matches]
        profiles = tuple({'id': GUESTS_ID, 'kind': 'guest', 'display_name': 'Guest'}
                         if merged_id(profile['id']) == GUESTS_ID else profile for profile in profiles)
        player_id, opponent_id = merged_id(player_id), merged_id(opponent_id)
    players = player_catalog(matches, profiles)
    by_id = {player['id']: player for player in players}
    patches = sorted({result_patch(result, match) for match in matches for result in match['rounds']},
                     key=lambda value: (value != 'legacy', tuple(int(part) if part.isdigit() else -1 for part in value.split('.'))), reverse=True)
    if patch and patch not in patches:
        if patch != PATCH_VERSION:
            raise ValueError('Choose a patch from the available history.')
    if PATCH_VERSION not in patches:
        patches.insert(0, PATCH_VERSION)
    if not players:
        # Bookmarked selections should show an empty page after a history reset.
        player_id = opponent_id = None
    if player_id is None and players:
        player_id = profiles[0]['id'] if profiles else players[0]['id']
    if player_id is not None and player_id not in by_id:
        raise ValueError('That player has no saved results.')
    if opponent_id is not None and opponent_id not in by_id:
        raise ValueError('That comparison player has no saved results.')
    if player_id is not None and player_id == opponent_id:
        raise ValueError('Choose two different players to compare.')

    def entry(selected, opponent):
        return {'profile': by_id[selected], 'overall': summarize(matches, selected, enabled, disabled, house_only=house_only, patch=patch),
                'head_to_head': summarize(matches, selected, enabled, disabled, opponent, house_only, patch) if opponent else None}

    def standing(player):
        stats = summarize(matches, player['id'], enabled, disabled, house_only=house_only, patch=patch)
        return {'profile': player, **{key: stats[key] for key in (
            'rounds', 'round_wins', 'round_losses', 'round_draws', 'round_win_rate',
            'completed_matches', 'match_wins', 'match_losses', 'match_draws', 'match_win_rate', 'average_points')}}

    # Best game win rate first; players with no matching games last. Ties go to whoever has played more.
    # every guest has their own record, but the ranking shows them as one "Guest"
    leaderboard = sorted(combine_guests([standing(player) for player in players]),
                         key=lambda row: (row['round_win_rate'] is None, -(row['round_win_rate'] or 0), -row['rounds'],
                                          row['profile']['username'].casefold(), row['profile']['id']))

    return {'players': players, 'leaderboard': leaderboard,
            'player': entry(player_id, opponent_id) if player_id else None,
            'comparison': entry(opponent_id, player_id) if opponent_id else None,
            'patches': patches,
            'filters': {'enabled': list(enabled), 'disabled': list(disabled), 'house_rules': house_only, 'patch': patch}}
