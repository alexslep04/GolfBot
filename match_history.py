"""Shared match summaries; no cards or session secrets saved or exposed."""
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
            self.connection.execute('CREATE TABLE IF NOT EXISTS history_meta (key TEXT PRIMARY KEY, value REAL NOT NULL)')
            # Older hosts may still have a pre-reset series in memory. Prevent
            # those summaries from repopulating the database after a reset.
            for event in ('INSERT', 'UPDATE'):
                self.connection.execute(f'''CREATE TRIGGER IF NOT EXISTS history_reset_{event.lower()}
                    BEFORE {event} ON matches WHEN
                    COALESCE(json_extract(NEW.payload, '$.started_at'), 0) <
                    COALESCE((SELECT value FROM history_meta WHERE key='reset_at'), 0)
                    BEGIN SELECT RAISE(IGNORE); END''')

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
            "participants": room.participants,
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
        """List everyone's matches; identify the viewer's seat only if they played."""
        key = browser_key(token)
        with self.lock:
            rows = self.connection.execute("SELECT host, guest, payload FROM matches ORDER BY updated DESC, id LIMIT ? OFFSET ?", (limit, offset)).fetchall()
        return [{**json.loads(payload), "viewer": (0 if host == key else 1 if guest == key else None) if key else None}
                for host, guest, payload in rows]

    def results(self):
        """All result payloads for aggregation, without private browser keys."""
        with self.lock:
            rows = self.connection.execute('SELECT payload FROM matches').fetchall()
        return [json.loads(payload) for (payload,) in rows]

    def stats_results(self):
        return self.results()

    def clear_history(self):
        """Explicit local maintenance only; never exposed as a public endpoint."""
        with self.lock, self.connection:
            count = self.connection.execute('SELECT COUNT(*) FROM matches').fetchone()[0]
            self.connection.execute("INSERT INTO history_meta VALUES ('reset_at', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (time.time(),))
            self.connection.execute('DELETE FROM matches')
        return count

    def close(self):
        self.connection.close()
