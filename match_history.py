"""Persistent, browser-scoped match summaries; no cards or session secrets saved."""
from dataclasses import asdict
import hashlib
import json
from pathlib import Path
import sqlite3
import threading
import time


def browser_key(token):
    return hashlib.sha256(token.encode()).hexdigest() if token else None


class MatchHistory:
    def __init__(self, path=":memory:"):
        if str(path) != ":memory:":
            Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(str(path), check_same_thread=False)
        self.lock = threading.Lock()
        with self.connection:
            self.connection.execute("CREATE TABLE IF NOT EXISTS matches (id TEXT PRIMARY KEY, host TEXT NOT NULL, guest TEXT, updated REAL NOT NULL, payload TEXT NOT NULL)")
            self.connection.execute("CREATE INDEX IF NOT EXISTS matches_host ON matches(host)")
            self.connection.execute("CREATE INDEX IF NOT EXISTS matches_guest ON matches(guest)")

    def interrupt_open_matches(self):
        """Called when the serving application starts, not by read-only importers."""
        with self.lock, self.connection:
            for match_id, payload in self.connection.execute("SELECT id, payload FROM matches").fetchall():
                match = json.loads(payload)
                if match["status"] == "in_progress":
                    match["status"] = "interrupted"
                    self.connection.execute("UPDATE matches SET payload=? WHERE id=?", (json.dumps(match), match_id))

    def save(self, room, abandoned=False):
        if not room.history:
            return
        payload = {
            "id": room.match_id, "lobby_name": room.name, "names": list(room.names),
            "solo": room.solo, "best_of": room.best_of, "rules": asdict(room.rules),
            "started_at": room.started_at, "updated_at": time.time(),
            "status": "finished" if room.champion is not None else "abandoned" if abandoned else "in_progress",
            "winner": room.champion, "wins": list(room.wins),
            "rounds": room.history,
            "points": [sum(result["scores"][seat] for result in room.history) for seat in (0, 1)],
        }
        with self.lock, self.connection:
            self.connection.execute("INSERT INTO matches VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated, payload=excluded.payload",
                                    (room.match_id, browser_key(room.seats[0]), browser_key(room.seats[1]), payload["updated_at"], json.dumps(payload)))

    def for_browser(self, token, limit=100, offset=0):
        key = browser_key(token)
        with self.lock:
            rows = self.connection.execute("SELECT host, payload FROM matches WHERE host=? OR guest=? ORDER BY updated DESC, id LIMIT ? OFFSET ?", (key, key, limit, offset)).fetchall()
        return [{**json.loads(payload), "viewer": 0 if host == key else 1} for host, payload in rows]

    def close(self):
        self.connection.close()
