"""The Daily Puzzle: one hand a day, the same deal for everyone and every attempt.

A puzzle is one hand of Golf against Golfbot (see GolfGame's puzzle mode):
House rules, a seeded deck that never reshuffles, two cards each face up to
start, and you play first. It ends as any hand does (or when the deck runs
out). Your own points are your score; the lowest wins the day.
A day runs midnight to midnight, server time (as the "today" records do).
"""
import hashlib
import time
from datetime import date, datetime

from game import GolfGame, rules_from
from match_settings import house_rules

# puzzle #1 is the first day there was one
FIRST_DAY = date(2026, 11, 24)
BOARD_SIZE = 50  # best scores kept on the day's board


def today(now=None):
    return datetime.fromtimestamp(time.time() if now is None else now).date()


def puzzle_number(day):
    return (day - FIRST_DAY).days + 1


def puzzle_seed(day):
    """The day's deal: the same seed all day, for everyone."""
    return int.from_bytes(hashlib.sha256(f"golf-daily-puzzle:{day.isoformat()}".encode()).digest()[:8], "big")


def puzzle_rules():
    return rules_from(house_rules())


def new_puzzle(day):
    return GolfGame(seed=puzzle_seed(day), rules=puzzle_rules(), puzzle=True)


def preview(day):
    """The starting hand as everyone sees it: the two face-up cards, the rest hidden."""
    game = new_puzzle(day)
    return [{"visible": slot.visible,
             "card": {"rank": slot.card.rank, "label": slot.card.label, "suit": slot.card.suit,
                      "points": slot.card.base_points} if slot.visible else None}
            for slot in game.players[0]]


class PuzzleScores:
    """Each player's best score and attempt count, per day."""

    def __init__(self, history):
        self.db, self.lock = history.connection, history.lock
        with self.lock, self.db:
            self.db.execute('CREATE TABLE IF NOT EXISTS puzzle_scores (day TEXT NOT NULL, player TEXT NOT NULL, '
                            'name TEXT NOT NULL, avatar TEXT, best INTEGER, best_at REAL, attempts INTEGER NOT NULL DEFAULT 0, '
                            'PRIMARY KEY(day, player))')

    def attempt(self, day, player, name, avatar):
        """Count an attempt started (finished or not)."""
        with self.lock, self.db:
            self.db.execute('INSERT INTO puzzle_scores (day, player, name, avatar, attempts) VALUES (?, ?, ?, ?, 1) '
                            'ON CONFLICT(day, player) DO UPDATE SET attempts = attempts + 1, name = excluded.name, '
                            'avatar = excluded.avatar', (day.isoformat(), player, name, avatar))

    def finish(self, day, player, name, avatar, score, now=None):
        """Record a finished attempt; returns whether it is the player's new best."""
        now = time.time() if now is None else now
        with self.lock, self.db:
            row = self.db.execute('SELECT best FROM puzzle_scores WHERE day=? AND player=?',
                                  (day.isoformat(), player)).fetchone()
            better = row is None or row[0] is None or score < row[0]
            if row is None:
                self.db.execute('INSERT INTO puzzle_scores (day, player, name, avatar, best, best_at, attempts) '
                                'VALUES (?, ?, ?, ?, ?, ?, 1)', (day.isoformat(), player, name, avatar, score, now))
            elif better:
                self.db.execute('UPDATE puzzle_scores SET best=?, best_at=?, name=?, avatar=? WHERE day=? AND player=?',
                                (score, now, name, avatar, day.isoformat(), player))
        return better

    def board(self, day, limit=BOARD_SIZE):
        """The day's best scores, lowest first (ties: whoever got there first)."""
        with self.lock:
            rows = self.db.execute('SELECT player, name, avatar, best, attempts FROM puzzle_scores '
                                   'WHERE day=? AND best IS NOT NULL ORDER BY best, best_at LIMIT ?',
                                   (day.isoformat(), limit)).fetchall()
        return [{"player": player, "name": name, "avatar": avatar, "score": best, "attempts": attempts}
                for player, name, avatar, best, attempts in rows]

    def mine(self, day, player):
        with self.lock:
            row = self.db.execute('SELECT best, attempts FROM puzzle_scores WHERE day=? AND player=?',
                                  (day.isoformat(), player)).fetchone()
        if row is None:
            return {"best": None, "attempts": 0, "rank": None}
        best, attempts = row
        rank = None
        if best is not None:
            with self.lock:
                rank = 1 + self.db.execute('SELECT COUNT(*) FROM puzzle_scores WHERE day=? AND best IS NOT NULL AND best < ?',
                                           (day.isoformat(), best)).fetchone()[0]
        return {"best": best, "attempts": attempts, "rank": rank}
