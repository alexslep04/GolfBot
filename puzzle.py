"""The Daily Puzzle: one hand a day, the same deal for everyone and every attempt.

A puzzle is one hand of Golf against Golfbot, as PuzzleBot (see GolfGame's
puzzle mode): a seeded deck that never reshuffles, and you play first. It runs a
set number of moves each: Golfbot's last move ends it, as does the deck running
out, or you turning your last card face up (then it ends at once). Your score is your margin over Golfbot (its points minus yours, so +5 is a
win by 5 points); the biggest margin wins the day.

Each day's puzzle is made, not just dealt (see generate):
- The day has a theme, in a rotation that never repeats one two days running.
  A theme is a combination of rules that play off each other (House rules or
  not), or a twist on the deal itself: every card face down, four face up, three
  moves to make count. Each sets the rules, and the moves and cards face up it
  may have.
- Several deals of that theme are played out by Golfbot on both sides, once
  thinking ahead and once taking the move that looks best right now. The deal
  kept is the one where thinking ahead pays most, the theme's rules come into
  play, and the hand is winnable but not easy.
The puzzle made is kept (PuzzleScores.save_spec): it stays the same all day.
A day runs midnight to midnight, server time (as the "today" records do).
"""
import hashlib
import json
import random
import time
from dataclasses import dataclass
from datetime import date, datetime

from game import RULE_OPTIONS, GolfGame, rules_from
from match_settings import HOUSE_KEYS

# puzzle #1 is the first day there was one
FIRST_DAY = date(2026, 11, 24)
BOARD_SIZE = 50  # best scores kept on the day's board
CANDIDATES = 16  # deals of the day's theme played out to choose from
SEARCH_BUDGET = 300  # how hard Golfbot thinks while trying them (the live PuzzleBot thinks harder)


def today(now=None):
    return datetime.fromtimestamp(time.time() if now is None else now).date()


def puzzle_number(day):
    return (day - FIRST_DAY).days + 1


@dataclass(frozen=True)
class Theme:
    key: str
    name: str
    blurb: str  # what makes it, for the player
    rules: frozenset
    moves: tuple  # the moves each it may run to
    face_up: tuple  # the cards each it may start with face up


ALL_RULES = frozenset(key for key, _ in RULE_OPTIONS)
EVERY_PUZZLE = frozenset({"royal_pairs"})  # rules in every puzzle, on top of its theme's
THEMES = (
    Theme("royal_court", "Royal Court", "Jacks and Queens earn swaps; Kings and Queens score by color",
          frozenset({"royal_pairs", "king_queen", "all_in_color"}), (5, 6), (2,)),
    Theme("poker_night", "Poker Night", "Make a poker hand: a flush, a straight, four of a kind",
          frozenset({"holdem", "four_kind", "suited_rows"}), (5, 6, 7), (2, 3)),
    Theme("angel_numbers", "Angel Numbers", "Rows of 6s to 9s, and Vs that divide your score",
          frozenset({"angel_numbers", "roman_fives", "v10"}), (5, 6), (2, 3)),
    Theme("straight_lines", "Straight Lines", "Rows that run up, run down, or keep to one suit",
          frozenset({"tricky_straights", "suited_rows", "holdem"}), (4, 5, 6), (2, 3)),
    Theme("beggars_banquet", "Beggars' Banquet", "Guess the card before it flips; four of a kind moves into place",
          frozenset({"beggars", "royal_pairs", "four_kind"}), (5, 6), (2,)),
    Theme("seeing_red", "Seeing Red", "Colors and suits decide it: red rows hurt, black rows help",
          frozenset({"all_in_color", "suited_rows", "king_queen", "ripped_five"}), (5, 6), (2, 3)),
    Theme("high_fives", "High Fives", "Fives and Vs: the ripped 5, V2 and the V10 engine",
          frozenset({"ripped_five", "roman_fives", "v10", "tricky_straights"}), (5, 6), (2,)),
    Theme("sprint", "Sprint", "Three moves each to make count",
          frozenset({"royal_pairs", "four_kind", "v10"}), (3,), (3,)),
    Theme("blind_draw", "Blind Draw", "House rules, every card face down",
          HOUSE_KEYS, (5, 6), (0,)),
    Theme("open_book", "Open Book", "House rules, four cards face up each, and only a few moves",
          HOUSE_KEYS, (3, 4), (4,)),
    Theme("everything", "Everything Goes", "Every rule in the book at once",
          ALL_RULES, (5, 6), (2,)),
    Theme("pure_golf", "Pure Golf", "Nothing but the Jack and Queen swaps: just the lowest hand",
          frozenset(), (4, 5), (2, 3)),
    Theme("house", "House Rules", "The House rules, as you know them",
          HOUSE_KEYS, (5,), (2,)),
)
BY_KEY = {theme.key: theme for theme in THEMES}


def _seed(*parts):
    return int.from_bytes(hashlib.sha256(":".join(["golf-daily-puzzle", *map(str, parts)]).encode()).digest()[:8], "big")


def theme_for(day):
    """The day's theme: the themes in a shuffled order, a new order each time round
    (the first of one round never the last of the one before)."""
    index = (day - FIRST_DAY).days
    def order(cycle):
        themes = list(THEMES)
        random.Random(_seed("cycle", cycle)).shuffle(themes)
        if cycle > 0 and themes[0] == order(cycle - 1)[-1]:
            themes[0], themes[1] = themes[1], themes[0]
        return themes
    cycle, at = divmod(index, len(THEMES))
    return order(max(cycle, 0))[at]


def candidates(day, count=CANDIDATES):
    """The deals the day's puzzle is chosen from: its theme's, each with its own moves and cards face up."""
    theme = theme_for(day)
    rng = random.Random(_seed("candidates", day.isoformat()))
    # (the Jack-Jack and Queen-Queen swaps are in every puzzle, whatever its theme)
    rules = sorted(theme.rules | EVERY_PUZZLE)
    return [{"theme": theme.key, "seed": _seed("deal", day.isoformat(), i), "moves": rng.choice(theme.moves),
             "face_up": rng.choice(theme.face_up), "rules": rules} for i in range(count)]


def new_puzzle(spec):
    rules = rules_from({key: key in spec["rules"] for key in ALL_RULES})
    return GolfGame(seed=spec["seed"], rules=rules, puzzle=True,
                    puzzle_moves=spec["moves"], puzzle_face_up=spec["face_up"])


def is_house(spec):
    return frozenset(spec["rules"]) == HOUSE_KEYS


def describe(spec):
    """The puzzle as players are told it: its theme, and how it is played."""
    theme = BY_KEY.get(spec["theme"])
    return {"key": spec["theme"], "name": theme.name if theme else "Daily Puzzle", "blurb": theme.blurb if theme else "",
            "moves": spec["moves"], "face_up": spec["face_up"], "rules": list(spec["rules"]), "house_rules": is_house(spec)}


def preview(spec):
    """The starting hand as everyone sees it: the face-up cards, the rest hidden."""
    game = new_puzzle(spec)
    return [{"visible": slot.visible,
             "card": {"rank": slot.card.rank, "label": slot.card.label, "suit": slot.card.suit,
                      "points": slot.card.base_points} if slot.visible else None}
            for slot in game.players[0]]


def play_out(spec, careful):
    """Golfbot plays both sides of a puzzle to its end: you thinking ahead (careful),
    or taking whatever looks best this move; PuzzleBot always thinks ahead."""
    from bot import Search, legal_actions, play_action, public_position
    game = new_puzzle(spec)
    for _ in range(400):
        if game.phase == "over":
            break
        game._public_targets = tuple(game.targets())
        actions = set(legal_actions(game))
        if game.decision_player == 0 and not careful:
            ranked = Search(samples=4).rank(public_position(game), [10 ** 6], actions)
            action = ranked[0][1] if ranked else None
        else:
            action = Search(transitions=SEARCH_BUDGET).choose(game)
        play_action(game, action or sorted(actions)[0])
    return game


def _squash(points, cap=40):
    # (Angel numbers multiply a hand by 6 or 8: no one deal may win on that alone)
    return max(-cap, min(cap, points))


def evaluate(spec):
    """How a deal plays: margins thinking ahead and not, and the rules each side set off."""
    careful, greedy = play_out(spec, True), play_out(spec, False)
    if careful.phase != "over" or greedy.phase != "over":
        return None
    return {"careful": careful.score(1) - careful.score(0), "greedy": greedy.score(1) - greedy.score(0),
            "fired": sorted(careful.activated_rules[0]), "bot_fired": sorted(careful.activated_rules[1]),
            "greedy_fired": sorted(greedy.activated_rules[0])}


def fun(spec, metrics):
    """A deal's score as a puzzle (higher is better):
    - thinking ahead should pay: the careful margin well above the greedy one;
    - the theme's rules should come into play, yours above all;
    - it should be winnable with care, and not won without it."""
    if metrics is None:
        return float("-inf")
    careful, greedy = _squash(metrics["careful"]), _squash(metrics["greedy"])
    # (the rules every puzzle has are no part of what makes the day's theme)
    theme = set(spec["rules"]) - (EVERY_PUZZLE - set(BY_KEY[spec["theme"]].rules) if spec.get("theme") in BY_KEY else set())
    yours = len(theme & set(metrics["fired"]))
    either = len(theme & (set(metrics["fired"]) | set(metrics["bot_fired"])))
    score = 1.2 * max(0, min(careful - greedy, 25)) + 10 * yours + 3 * either
    # (a theme with rules is no theme if none of them come into your hand;
    # a rule-free one is judged on play alone)
    score -= 15 if theme and not yours else 0
    score += 10 if 0 < careful <= 25 else 0  # winnable with care, and not a walkover
    score -= 5 if careful <= 0 else 0
    score -= 8 if greedy > 10 else 0  # too easy: won without thinking
    score -= 6 if careful < -10 else 0  # too hard: lost even with care
    return score


def choose(options, results):
    """The deal to keep: the most fun of those played out (the first, should they tie)."""
    best = max(range(len(options)), key=lambda i: (fun(options[i], results[i]), -i))
    return {**options[best], "metrics": results[best]}


def generate(day, count=CANDIDATES, evaluate_with=None):
    """The day's puzzle: the best of `count` deals of its theme (with one, that one).
    `evaluate_with` maps evaluate over the deals (a process pool's map, say)."""
    options = candidates(day, count)
    if len(options) == 1:
        return {**options[0], "metrics": None}
    return choose(options, list((evaluate_with or map)(evaluate, options)))


class PuzzleScores:
    """Each player's best margin over Golfbot and attempt count, per day.

    (The margins have their own table: the first puzzles were scored by raw points.)"""

    def __init__(self, history):
        self.db, self.lock = history.connection, history.lock
        with self.lock, self.db:
            # each day's puzzle as it was made (see generate): kept, so it stays the same all day
            self.db.execute('CREATE TABLE IF NOT EXISTS puzzle_specs (day TEXT PRIMARY KEY, spec TEXT NOT NULL)')
            self.db.execute('CREATE TABLE IF NOT EXISTS puzzle_margins (day TEXT NOT NULL, player TEXT NOT NULL, '
                            'name TEXT NOT NULL, avatar TEXT, best INTEGER, best_at REAL, attempts INTEGER NOT NULL DEFAULT 0, '
                            'PRIMARY KEY(day, player))')

    def saved_spec(self, day):
        with self.lock:
            row = self.db.execute('SELECT spec FROM puzzle_specs WHERE day=?', (day.isoformat(),)).fetchone()
        return json.loads(row[0]) if row else None

    def save_spec(self, day, spec):
        """Keep a day's puzzle (the first one kept stands, should two be made at once)."""
        with self.lock, self.db:
            self.db.execute('INSERT OR IGNORE INTO puzzle_specs (day, spec) VALUES (?, ?)', (day.isoformat(), json.dumps(spec)))
        return self.saved_spec(day)

    def attempt(self, day, player, name, avatar):
        """Count an attempt started (finished or not)."""
        with self.lock, self.db:
            self.db.execute('INSERT INTO puzzle_margins (day, player, name, avatar, attempts) VALUES (?, ?, ?, ?, 1) '
                            'ON CONFLICT(day, player) DO UPDATE SET attempts = attempts + 1, name = excluded.name, '
                            'avatar = excluded.avatar', (day.isoformat(), player, name, avatar))

    def finish(self, day, player, name, avatar, score, now=None):
        """Record a finished attempt's margin; returns whether it is the player's new best."""
        now = time.time() if now is None else now
        with self.lock, self.db:
            row = self.db.execute('SELECT best FROM puzzle_margins WHERE day=? AND player=?',
                                  (day.isoformat(), player)).fetchone()
            better = row is None or row[0] is None or score > row[0]
            if row is None:
                self.db.execute('INSERT INTO puzzle_margins (day, player, name, avatar, best, best_at, attempts) '
                                'VALUES (?, ?, ?, ?, ?, ?, 1)', (day.isoformat(), player, name, avatar, score, now))
            elif better:
                self.db.execute('UPDATE puzzle_margins SET best=?, best_at=?, name=?, avatar=? WHERE day=? AND player=?',
                                (score, now, name, avatar, day.isoformat(), player))
        return better

    def board(self, day, limit=BOARD_SIZE):
        """The day's best margins, biggest first (ties: whoever got there first)."""
        with self.lock:
            rows = self.db.execute('SELECT player, name, avatar, best, attempts FROM puzzle_margins '
                                   'WHERE day=? AND best IS NOT NULL ORDER BY best DESC, best_at LIMIT ?',
                                   (day.isoformat(), limit)).fetchall()
        return [{"player": player, "name": name, "avatar": avatar, "score": best, "attempts": attempts}
                for player, name, avatar, best, attempts in rows]

    def last_seen(self, player):
        """The name and avatar a player last played the puzzle under, or None."""
        with self.lock:
            row = self.db.execute('SELECT name, avatar FROM puzzle_margins WHERE player=? ORDER BY day DESC LIMIT 1',
                                  (player,)).fetchone()
        return tuple(row) if row else None

    def totals(self, day):
        """PuzzleBot's record: attempts made against it (all time and on `day`) and how many players made them."""
        with self.lock:
            attempts, players = self.db.execute('SELECT COALESCE(SUM(attempts), 0), COUNT(DISTINCT player) FROM puzzle_margins').fetchone()
            today = self.db.execute('SELECT COALESCE(SUM(attempts), 0) FROM puzzle_margins WHERE day=?', (day.isoformat(),)).fetchone()[0]
        return {"attempts": attempts, "players": players, "today": today}

    def mine(self, day, player):
        with self.lock:
            row = self.db.execute('SELECT best, attempts FROM puzzle_margins WHERE day=? AND player=?',
                                  (day.isoformat(), player)).fetchone()
        if row is None:
            return {"best": None, "attempts": 0, "rank": None}
        best, attempts = row
        rank = None
        if best is not None:
            with self.lock:
                rank = 1 + self.db.execute('SELECT COUNT(*) FROM puzzle_margins WHERE day=? AND best IS NOT NULL AND best > ?',
                                           (day.isoformat(), best)).fetchone()[0]
        return {"best": best, "attempts": attempts, "rank": rank}
