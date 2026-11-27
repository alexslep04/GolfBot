"""Flags: achievements earned in play, worked out from saved games.

Each saved game keeps every player's moves in it as a string of codes, one a
move (see MOVE_CODES; the opening reveal is not counted), beside the rules each
seat set off. A flag is earned by one game that passes its test (some count
only games against other people: not Golfbot, not pass & play), by a number of
games that do (a counted flag), or, for a career flag, by every game a player has
finished, in order. Each unlocks something once earned: an emote, a theme, or a
custom card for Your Deck.
How near a player is to each flag is worked out the same way, as a fraction.
"""
import re

GAME_TIME_CAP = 30 * 60  # (one game counts for at most this long: as records.py times them)

MOVE_CODES = {"flip": "f", "draw": "d", "discard": "x", "swap": "s", "end_turn": "e", "guess": "g", "arrange": "a"}


def only_hand_flips(moves):
    """Every move a flip of a card in your own hand (and ending the turn on it):
    no swaps, no cards drawn from the Go Fish pile."""
    return "f" in moves and set(moves) <= {"f", "e", "g", "a"}


DRAWS_DISCARDED = 5  # Here we go...: Go Fish cards drawn and thrown away in a row


def five_draws_discarded(moves):
    """Five cards in a row drawn from the Go Fish pile and thrown away, and nothing
    else all game: no swaps, no flips of your own cards. (How far along: the
    longest such run in the game, out of five.)"""
    if "s" in moves or "f" in moves:
        return 0
    # (a guess at someone's card, or leaving a four of a kind where it is, is not a move of your own hand)
    runs = re.findall(r"(?:dx)+", moves.replace("g", "").replace("a", ""))
    return min(1, max((len(run) // 2 for run in runs), default=0) / DRAWS_DISCARDED)


SOLO_RUN = 50  # Adult swim: solo games in a row


def solo_run(games):
    """`games`: a player's finished games, oldest first, as (ended at, against Golfbot?,
    seconds it took).
    When they had played SOLO_RUN games against Golfbot back to back (none against
    people in between), or None; and how far along the run they are on now is."""
    run = 0
    for ended_at, solo, *_ in games:
        run = run + 1 if solo else 0
        if run >= SOLO_RUN:
            return ended_at, 1
    return None, run / SOLO_RUN


GOOD_SPORT_SECONDS = 5 * 60  # Good Sport: time spent playing


def time_spent(games):
    """When a player's games, oldest first (see solo_run), had added up to
    GOOD_SPORT_SECONDS of play, or None; and how far along they are."""
    total = 0
    for ended_at, _, seconds in games:
        total += seconds
        if total >= GOOD_SPORT_SECONDS:
            return ended_at, 1
    return None, total / GOOD_SPORT_SECONDS


BLACK_HANDS = 10  # Black out!: hands with black suited rows, all in black
HEART_FLUSHES = 10  # Cupid's porcelain throne: games ended with a heart flush (Hold 'em) in hand
RIPPED_FIVES = 3  # Tear it up!: games where the ripped 5 tore up a 5
NIGHT_HOURS = {23, 0, 1, 2, 3, 4, 5}  # Just one more game: from 11pm until 6am, where the player is
LOSSES = 100  # Washed?: games lost against people
FANTASTIC_HANDS = 5  # 5 Fantastic 4s: games ended with four of a kind in hand (Fantastic 4 on)


def seat_rules(game, seat):
    """The rules (as "rule:part" keys) this seat set off in the game."""
    parts = game.get("subrule_activations") or []
    return set(parts[seat]) if seat < len(parts) else set()


def seat_activated(game, seat):
    """The rules this seat set off in the game (as rule keys)."""
    parts = game.get("activations") or []
    return set(parts[seat]) if seat < len(parts) else set()


def won(game, seat):
    """Whether this seat won the game (a draw is not a win)."""
    return game.get("winner") == seat


def seat_moves(game, seat):
    moves = game.get("moves") or []
    return moves[seat] if seat < len(moves) else ""


# name: (how it is earned, which games count ("pvp": against people; "any": any
# but pass & play; "count": any, until `need` of them pass; "pvp count": against
# people, until `need` of them pass; "match count": whole matches (a series, its
# test given the match and the seat), until `need` of them pass; "career": every game,
# in order), the test of one game (the saved game and the player's seat in it:
# passed, or how far along, 0 to 1) or of a career, what it unlocks: (kind,
# which), and for a counted flag, how many games it needs)
FLAGS = {
    "Wait for my cue...": (
        "Win a PvP game where your only moves are flips of your own cards. No swaps. No Go Fish draws.",
        "pvp", lambda game, seat: won(game, seat) and only_hand_flips(seat_moves(game, seat)), ("emote", "rushing")),
    "Here we go...": (
        "Win a PvP game where you draw 5 Go Fish cards in a row and discard them all. No swaps. No flips of your own cards.",
        "pvp", lambda game, seat: five_draws_discarded(seat_moves(game, seat)) if won(game, seat) else 0, ("emote", "dragging")),
    "Let's go gambling!": (
        "Activate Angel Numbers' 777s in a game.",
        "any", lambda game, seat: "angel_numbers:777" in seat_rules(game, seat),
        ("theme", "poker")),
    "Adult swim": (
        f"Play {SOLO_RUN} solo games in a row against Golfbot.",
        "career", solo_run, ("theme", "pool")),
    "Black out!": (
        f"Activate Suited Rows and All in Black in the same hand {BLACK_HANDS} times.",
        "count", lambda game, seat: {"suited_rows:black", "all_in_color:black"} <= seat_rules(game, seat),
        ("theme", "focus"), BLACK_HANDS),
    "Cupid's porcelain throne": (
        f"Finish {HEART_FLUSHES} games with a heart flush in your final hand.",
        "count", lambda game, seat: "holdem:flush_hearts" in seat_rules(game, seat),
        ("emote", "giveheart"), HEART_FLUSHES),
    "Tear it up!": (
        f"Activate the Ripped 5 rule in {RIPPED_FIVES} games.",
        "count", lambda game, seat: "ripped_five" in seat_activated(game, seat),
        ("card", "ripped-5d"), RIPPED_FIVES),
    "Just one more game": (
        "Finish a game between 11pm and 6am.",
        "any", lambda game, seat: (((game.get("local_hours") or [])[seat:seat + 1] or [None])[0]) in NIGHT_HOURS,
        ("theme", "night")),
    "5 Fantastic 4s": (
        f"Finish {FANTASTIC_HANDS} games with Fantastic 4 active in your final hand.",
        "count", lambda game, seat: "four_kind:final" in seat_rules(game, seat),
        ("emote", "pogcat"), FANTASTIC_HANDS),
    "Washed?": (
        f"Lose {LOSSES} PvP games.",
        "pvp count", lambda game, seat: game.get("winner") is not None and game.get("winner") != seat,
        ("emote", "poop"), LOSSES),
}
FLAGS["Chat disabled for 3s."] = (
    "Send the same emote 3 times in a row within 2 seconds while a game is being played.",
    "any", lambda game, seat: bool(((game.get("emote_spam") or [])[seat:seat + 1] or [False])[0]),
    ("emote", "save"))
TAKE_FIVE = 5  # Take 5!: rules in play at once in a final hand
FLAGS["Take 5!"] = (
    f"Finish a game with {TAKE_FIVE} rules in play in your final hand.",
    "any", lambda game, seat: len((((game.get("modifier_counts") or [])[seat:seat + 1]) or [{}])[0] or {}) >= TAKE_FIVE,
    ("emote", "crocscreech"))
FLAGS["Good Sport"] = (
    "Play 5 minutes of Golf.",
    "career", time_spent, ("emote", "gg"))
RANKED_MATCHES = 3  # Join Ranked!: Ranked matches played
FLAGS["No longer a casual"] = (
    f"Play {RANKED_MATCHES} Ranked matches.",
    "match count", lambda match, seat: bool(match.get("rated")),
    ("emote", "ranked"), RANKED_MATCHES)
WATCHED_WINS = 3  # Under Pressure: games won with someone watching
FLAGS["Under Pressure"] = (
    f"Win {WATCHED_WINS} games with at least 1 spectator watching.",
    "count", lambda game, seat: game.get("winner") == seat and (game.get("spectators") or 0) >= 1,
    ("emote", "isit"), WATCHED_WINS)
COUNTED = ("count", "pvp count", "match count")  # the scopes counted up to a number of games
# a flag's emote, or theme, is for those who have earned it
FLAG_EMOTES = {flag[3][1]: name for name, flag in FLAGS.items() if flag[3][0] == "emote"}
FLAG_THEMES = {flag[3][1]: name for name, flag in FLAGS.items() if flag[3][0] == "theme"}
FLAG_CARDS = {flag[3][1]: name for name, flag in FLAGS.items() if flag[3][0] == "card"}


def against_people(match):
    """A game between people: no Golfbot or CPU in any seat, and not pass & play."""
    if match.get("solo") or match.get("local"):
        return False
    seats = match.get("participants") or []
    return len(seats) >= 2 and all(isinstance(seat, dict) and seat.get("kind") != "bot" for seat in seats)


def standing(results, player):
    """How this player stands on every flag: {name: (when it was earned (the end of
    the game that earned it), or None; how far along, 0 to 1)}."""
    found = {name: [None, 0] for name in FLAGS}
    if not player:
        return {name: tuple(at) for name, at in found.items()}
    career = []  # every game they finished: (ended at, against Golfbot?, seconds it took)
    counted = {name: [] for name, flag in FLAGS.items() if flag[1] in COUNTED}  # when each passing game ended
    for match in results:
        if match.get("local"):
            continue  # (pass & play: one device, every seat; nobody's own game)
        seats = [seat.get("id") if isinstance(seat, dict) else None for seat in match.get("participants") or []]
        if player not in seats:
            continue
        seat = seats.index(player)
        people = against_people(match)
        previous = match.get("started_at")
        for game in match.get("rounds") or []:
            at = game.get("ended_at") or 0
            # (from its deal to its end; a game saved before deals were timed, from the
            # end of the one before it, as Most hours played counts them)
            started = game.get("started_at", previous)
            previous = at or previous
            took = min(max(at - started, 0), GAME_TIME_CAP) if at and isinstance(started, (int, float)) else 0
            career.append((at, bool(match.get("solo")), took))
            for name, (_, scope, test, *_) in FLAGS.items():
                if scope in ("count", "pvp count"):
                    if (scope == "count" or people) and test(game, seat):
                        counted[name].append(at)
                elif scope == "any" or (scope == "pvp" and people):
                    passed = float(test(game, seat))
                    mark = found[name]
                    mark[1] = max(mark[1], min(passed, 1))
                    if passed >= 1:
                        mark[0] = at if mark[0] is None else min(mark[0], at)
        # (a whole match counts once, when its last game ended)
        ended = [game.get("ended_at") or 0 for game in match.get("rounds") or []]
        for name, (_, scope, test, *_) in FLAGS.items():
            if scope == "match count" and ended and test(match, seat):
                counted[name].append(max(ended))
    for name, (_, scope, test, *rest) in FLAGS.items():
        if scope == "career":
            found[name] = list(test(sorted(career)))
        elif scope in COUNTED:
            need, times = rest[1], sorted(counted[name])
            found[name] = [times[need - 1] if len(times) >= need else None, min(len(times), need) / need]
    return {name: (at, 1 if at is not None else progress) for name, (at, progress) in found.items()}


def earned(results, player):
    """The flags this player has earned: {name: when (the end of the first game that earned it)}."""
    return {name: at for name, (at, _) in standing(results, player).items() if at is not None}


def unlocked(names, kind):
    return sorted(FLAGS[name][3][1] for name in names if name in FLAGS and FLAGS[name][3][0] == kind)


def unlocked_emotes(names):
    return unlocked(names, "emote")
