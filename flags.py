"""Flags: achievements earned in play, worked out from saved games.

Each saved game keeps every player's moves in it as a string of codes, one a
move (see MOVE_CODES; the opening reveal is not counted), beside the rules each
seat set off. A flag is earned by one game that passes its test (some count
only games against other people: not Golfbot, not pass & play), or, for a career
flag, by every game a player has finished, in order. Each unlocks something once
earned: a text emote, or a theme.
"""

MOVE_CODES = {"flip": "f", "draw": "d", "discard": "x", "swap": "s", "end_turn": "e", "guess": "g", "arrange": "a"}


def only_hand_flips(moves):
    """Every move a flip of a card in your own hand (and ending the turn on it):
    no swaps, no cards drawn from the Go Fish pile."""
    return "f" in moves and set(moves) <= {"f", "e", "g", "a"}


def five_draws_discarded(moves):
    """Five cards in a row drawn from the Go Fish pile and thrown away, and nothing
    else all game: no swaps, no flips of your own cards."""
    if "s" in moves or "f" in moves:
        return False
    # (a guess at someone's card, or leaving a four of a kind where it is, is not a move of your own hand)
    return "dx" * 5 in moves.replace("g", "").replace("a", "")


SOLO_RUN = 50  # Adult swim: solo games in a row


def solo_run(games):
    """`games`: a player's finished games, oldest first, as (ended at, against Golfbot?).
    When they had played SOLO_RUN games against Golfbot back to back (none against
    people in between), or None."""
    run = 0
    for ended_at, solo in games:
        run = run + 1 if solo else 0
        if run >= SOLO_RUN:
            return ended_at
    return None


def seat_moves(game, seat):
    moves = game.get("moves") or []
    return moves[seat] if seat < len(moves) else ""


# name: (how it is earned, which games count ("pvp": against people; "any": any
# but pass & play; "career": every game, in order), the test of one game (the
# saved game and the player's seat in it) or of a career, and what it unlocks:
# (kind, which))
FLAGS = {
    "Wait for my cue...": (
        "Finish a PvP game where your only moves are flips of your own cards. No swaps. No Go Fish draws.",
        "pvp", lambda game, seat: only_hand_flips(seat_moves(game, seat)), ("emote", "rushing")),
    "Here we go...": (
        "Finish a PvP game where you draw 5 Go Fish cards in a row and discard them all. No swaps. No flips of your own cards.",
        "pvp", lambda game, seat: five_draws_discarded(seat_moves(game, seat)), ("emote", "dragging")),
    "Let's Go Gambling!": (
        "Activate the Angel Numbers' 777s rule in game.",
        "any", lambda game, seat: "angel_numbers:777" in ((game.get("subrule_activations") or [])[seat:seat + 1] or [[]])[0],
        ("theme", "poker")),
    "Adult swim": (
        f"Play {SOLO_RUN} solo games in a row against Golfbot.",
        "career", solo_run, ("theme", "pool")),
}
# a flag's emote, or theme, is for those who have earned it
FLAG_EMOTES = {which: name for name, (_, _, _, (kind, which)) in FLAGS.items() if kind == "emote"}
FLAG_THEMES = {which: name for name, (_, _, _, (kind, which)) in FLAGS.items() if kind == "theme"}


def against_people(match):
    """A game between people: no Golfbot or CPU in any seat, and not pass & play."""
    if match.get("solo") or match.get("local"):
        return False
    seats = match.get("participants") or []
    return len(seats) >= 2 and all(isinstance(seat, dict) and seat.get("kind") != "bot" for seat in seats)


def earned(results, player):
    """The flags this player has earned: {name: when (the end of the first game that earned it)}."""
    found = {}
    if not player:
        return found
    career = []  # every game they finished: (ended at, against Golfbot?)
    for match in results:
        if match.get("local"):
            continue  # (pass & play: one device, every seat; nobody's own game)
        seats = [seat.get("id") if isinstance(seat, dict) else None for seat in match.get("participants") or []]
        if player not in seats:
            continue
        seat = seats.index(player)
        people = against_people(match)
        for game in match.get("rounds") or []:
            at = game.get("ended_at") or 0
            career.append((at, bool(match.get("solo"))))
            for name, (_, scope, test, _) in FLAGS.items():
                if scope == "any" or (scope == "pvp" and people):
                    if test(game, seat):
                        found[name] = min(found.get(name, at), at)
    for name, (_, scope, test, _) in FLAGS.items():
        if scope == "career" and (at := test(sorted(career))) is not None:
            found[name] = at
    return found


def unlocked(names, kind):
    return sorted(FLAGS[name][3][1] for name in names if name in FLAGS and FLAGS[name][3][0] == kind)


def unlocked_emotes(names):
    return unlocked(names, "emote")
