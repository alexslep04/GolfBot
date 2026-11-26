"""Friends between signed-in players, and when each account was last seen.

A friendship is one row per pair (the two account ids in order). It starts as
a request from one of them and becomes a friendship once the other accepts;
asking someone who has already asked you accepts straight away.
"""
import time


class Friends:
    LIMIT = 200  # friends and requests one account can have

    def __init__(self, history):
        self.db, self.lock = history.connection, history.lock
        with self.lock, self.db:
            self.db.execute('CREATE TABLE IF NOT EXISTS friends (a TEXT NOT NULL, b TEXT NOT NULL, '
                            'requested_by TEXT NOT NULL, accepted_at REAL, at REAL NOT NULL, PRIMARY KEY(a, b))')
            self.db.execute('CREATE INDEX IF NOT EXISTS friends_b ON friends(b)')
            # each account's last moment on Golf, and the avatar it had then
            self.db.execute('CREATE TABLE IF NOT EXISTS account_seen (account_id TEXT PRIMARY KEY, at REAL NOT NULL, avatar TEXT)')

    @staticmethod
    def _pair(first, second):
        return (first, second) if first < second else (second, first)

    def _row(self, first, second):
        return self.db.execute('SELECT requested_by, accepted_at FROM friends WHERE a=? AND b=?',
                               self._pair(first, second)).fetchone()

    def request(self, account_id, other_id, now=None):
        """Ask to be friends. Returns "requested", "accepted" or "friends" (already)."""
        if account_id == other_id:
            raise ValueError("That's you!")
        now = time.time() if now is None else now
        with self.lock, self.db:
            row = self._row(account_id, other_id)
            if row is not None:
                requested_by, accepted_at = row
                if accepted_at is not None:
                    return "friends"
                if requested_by == account_id:
                    return "requested"
                self.db.execute('UPDATE friends SET accepted_at=? WHERE a=? AND b=?', (now, *self._pair(account_id, other_id)))
                return "accepted"
            count = self.db.execute('SELECT COUNT(*) FROM friends WHERE a=? OR b=?', (account_id, account_id)).fetchone()[0]
            if count >= self.LIMIT:
                raise ValueError("Your friends list is full.")
            self.db.execute('INSERT INTO friends (a, b, requested_by, accepted_at, at) VALUES (?, ?, ?, NULL, ?)',
                            (*self._pair(account_id, other_id), account_id, now))
            return "requested"

    def accept(self, account_id, other_id, now=None):
        """Accept another's request; False when there is none to accept."""
        with self.lock, self.db:
            row = self._row(account_id, other_id)
            if row is None or row[0] == account_id or row[1] is not None:
                return False
            self.db.execute('UPDATE friends SET accepted_at=? WHERE a=? AND b=?',
                            (time.time() if now is None else now, *self._pair(account_id, other_id)))
            return True

    def remove(self, account_id, other_id):
        """Unfriend, decline a request, or take back your own request."""
        with self.lock, self.db:
            return self.db.execute('DELETE FROM friends WHERE a=? AND b=?', self._pair(account_id, other_id)).rowcount > 0

    def are_friends(self, account_id, other_id):
        with self.lock:
            row = self._row(account_id, other_id)
        return bool(row and row[1] is not None)

    def list(self, account_id):
        """Everyone this account is friends with or has a request with.

        Each: {id, status: "friend" | "incoming" | "outgoing", since}.
        """
        with self.lock:
            rows = self.db.execute('SELECT a, b, requested_by, accepted_at, at FROM friends WHERE a=? OR b=?',
                                   (account_id, account_id)).fetchall()
        result = []
        for a, b, requested_by, accepted_at, at in rows:
            other = b if a == account_id else a
            status = ("friend" if accepted_at is not None else
                      "outgoing" if requested_by == account_id else "incoming")
            result.append({"id": other, "status": status, "since": accepted_at or at})
        return result

    def seen(self, account_id, avatar=None, now=None):
        with self.lock, self.db:
            self.db.execute('INSERT INTO account_seen (account_id, at, avatar) VALUES (?, ?, ?) '
                            'ON CONFLICT(account_id) DO UPDATE SET at=excluded.at, avatar=COALESCE(excluded.avatar, avatar)',
                            (account_id, time.time() if now is None else now, avatar))

    def last_seen(self, account_ids):
        """{account id: (when, avatar)} for those that have been seen."""
        ids = list(account_ids)
        if not ids:
            return {}
        with self.lock:
            rows = self.db.execute(f'SELECT account_id, at, avatar FROM account_seen WHERE account_id IN ({",".join("?" * len(ids))})',
                                   ids).fetchall()
        return {account_id: (at, avatar) for account_id, at, avatar in rows}
