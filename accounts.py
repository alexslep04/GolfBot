"""Persistent Google identities and opaque local login sessions."""
import hashlib
import json
import re
import secrets
import sqlite3
import time

LOGIN_DAYS = 30
ACCOUNT_COOKIE = 'golf_account'
UNIQUE_NAME = re.compile(r'[a-z0-9_]{3,12}\Z')  # (letters, numbers and _ only: no emoji)
PREFERENCE_LIMIT = 2000  # characters of saved settings, as JSON


def verify_google_token(credential, client_id, nonce):
    from google.auth.transport.requests import Request
    from google.oauth2.id_token import verify_oauth2_token
    transport = Request()
    def request(*args, **kwargs):
        return transport(*args, **{**kwargs, 'timeout': 10})
    claims = verify_oauth2_token(credential, request, audience=client_id)
    if (claims.get('iss') not in ('accounts.google.com', 'https://accounts.google.com')
            or not isinstance(claims.get('sub'), str) or not claims['sub']
            or not secrets.compare_digest(str(claims.get('nonce', '')), nonce)):
        raise ValueError('Invalid Google sign-in.')
    return claims['sub']


class Accounts:
    def __init__(self, history):
        self.db, self.lock = history.connection, history.lock
        with self.lock, self.db:
            self.db.execute('CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, google_sub TEXT UNIQUE NOT NULL, unique_name TEXT COLLATE NOCASE UNIQUE)')
            self.db.execute('CREATE TABLE IF NOT EXISTS account_sessions (token_hash TEXT PRIMARY KEY, account_id TEXT NOT NULL, expires REAL NOT NULL)')
            # the display name the player last chose, shared by every device they sign in on
            if 'display_name' not in {row[1] for row in self.db.execute('PRAGMA table_info(accounts)')}:
                self.db.execute('ALTER TABLE accounts ADD COLUMN display_name TEXT')
            # every display name an account has saved, and when it last chose it
            self.db.execute('CREATE TABLE IF NOT EXISTS account_display_names (account_id TEXT NOT NULL, name TEXT NOT NULL, used_at REAL NOT NULL, PRIMARY KEY(account_id, name))')
            # the settings a signed-in player chose, so every device they use has them
            self.db.execute('CREATE TABLE IF NOT EXISTS account_preferences (account_id TEXT PRIMARY KEY, payload TEXT NOT NULL)')
            # when each account was made (unknown for those made before this was kept)
            if 'created_at' not in {row[1] for row in self.db.execute('PRAGMA table_info(accounts)')}:
                self.db.execute('ALTER TABLE accounts ADD COLUMN created_at REAL')
            # who has joined whose table by opening its invite link: one row per pair
            self.db.execute('CREATE TABLE IF NOT EXISTS invite_joins (host TEXT NOT NULL, guest TEXT NOT NULL, host_label TEXT NOT NULL, at REAL NOT NULL, PRIMARY KEY(host, guest))')

    @staticmethod
    def public(row):
        return {'id': row[0], 'unique_name': row[1], 'display_name': row[2]} if row else None

    def login(self, google_sub):
        with self.lock, self.db:
            self.db.execute('INSERT OR IGNORE INTO accounts (id, google_sub, unique_name, created_at) VALUES (?, ?, NULL, ?)',
                            (secrets.token_hex(16), google_sub, time.time()))
            row = self.db.execute('SELECT id, unique_name, display_name FROM accounts WHERE google_sub=?', (google_sub,)).fetchone()
            token = secrets.token_urlsafe(32)
            self.db.execute('DELETE FROM account_sessions WHERE expires <= ?', (time.time(),))
            self.db.execute('INSERT INTO account_sessions VALUES (?, ?, ?)',
                            (hashlib.sha256(token.encode()).hexdigest(), row[0], time.time() + LOGIN_DAYS * 86400))
        return self.public(row), token

    def from_token(self, token):
        if not token or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
            return None
        with self.lock:
            row = self.db.execute('SELECT a.id, a.unique_name, a.display_name FROM accounts a JOIN account_sessions s ON a.id=s.account_id WHERE s.token_hash=? AND s.expires > ?',
                                  (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        return self.public(row)

    def logout(self, token):
        if token:
            with self.lock, self.db:
                self.db.execute('DELETE FROM account_sessions WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),))

    def choose_name(self, account_id, name):
        name = name.strip().lower()
        if not UNIQUE_NAME.fullmatch(name):
            raise ValueError('Use 3–12 letters, numbers or underscores for your unique name.')
        with self.lock, self.db:
            row = self.db.execute('SELECT id, unique_name, display_name FROM accounts WHERE id=?', (account_id,)).fetchone()
            if row is None:
                raise ValueError('Please sign in again.')
            if row[1] and row[1] != name:
                raise ValueError('Your unique name is permanent. Your display name can change each game.')
            try:
                self.db.execute('UPDATE accounts SET unique_name=? WHERE id=?', (name, account_id))
            except sqlite3.IntegrityError as error:
                raise ValueError('That unique name is already taken.') from error
        return {'id': account_id, 'unique_name': name, 'display_name': row[2]}

    def save_display_name(self, account_id, name):
        with self.lock, self.db:
            now = time.time()
            # the name being replaced is kept too, even if it was chosen before names were recorded
            previous = self.db.execute('SELECT display_name FROM accounts WHERE id=?', (account_id,)).fetchone()
            if previous and previous[0] and previous[0] != name:
                self.db.execute('INSERT OR IGNORE INTO account_display_names VALUES (?, ?, ?)', (account_id, previous[0], now - 1))
            self.db.execute('UPDATE accounts SET display_name=? WHERE id=?', (name, account_id))
            self.db.execute('''INSERT INTO account_display_names VALUES (?, ?, ?)
                ON CONFLICT(account_id, name) DO UPDATE SET used_at=excluded.used_at''', (account_id, name, now))

    def save_preferences(self, account_id, preferences):
        """Keep a small, flat set of settings (text, numbers, on/off) for an account."""
        if not isinstance(preferences, dict) or any(
                not isinstance(key, str) or not isinstance(value, (str, int, float, bool))
                for key, value in preferences.items()):
            raise ValueError('Settings must be simple values.')
        payload = json.dumps(preferences)
        if len(payload) > PREFERENCE_LIMIT:
            raise ValueError('Too many settings to save.')
        with self.lock, self.db:
            self.db.execute('''INSERT INTO account_preferences VALUES (?, ?)
                ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload''', (account_id, payload))

    def preferences(self, account_id):
        """The settings saved for this account, or None if it never saved any."""
        with self.lock:
            row = self.db.execute('SELECT payload FROM account_preferences WHERE account_id=?', (account_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def by_unique_name(self, name):
        """The account with this unique name (any case), or None."""
        with self.lock:
            row = self.db.execute('SELECT id, unique_name, display_name FROM accounts WHERE unique_name=?',
                                  (str(name).strip().lstrip('@').lower(),)).fetchone()
        return self.public(row)

    def by_ids(self, ids):
        """{id: account} for each of these account ids that exists."""
        ids = list(ids)
        if not ids:
            return {}
        with self.lock:
            rows = self.db.execute(f'SELECT id, unique_name, display_name FROM accounts WHERE id IN ({",".join("?" * len(ids))})',
                                   ids).fetchall()
        return {row[0]: self.public(row) for row in rows}

    def newest(self):
        """The account made most recently (with its unique name chosen), or None."""
        with self.lock:
            row = self.db.execute("""SELECT id, unique_name, display_name, created_at FROM accounts
                WHERE unique_name IS NOT NULL ORDER BY rowid DESC LIMIT 1""").fetchone()
        return {'id': 'account:' + row[0], 'unique_name': row[1], 'display_name': row[2], 'created_at': row[3]} if row else None

    def joined(self, player):
        """When a player's account was made (None for a guest, or an account from before that was kept)."""
        if not str(player or '').startswith('account:'):
            return None
        with self.lock:
            row = self.db.execute('SELECT created_at FROM accounts WHERE id=?', (player[len('account:'):],)).fetchone()
        return row[0] if row else None

    def record_invite(self, host, guest, host_label):
        """Note that `guest` joined a table of `host`'s through its invite link (player ids).
        Each pair counts once, however often they come back."""
        if not host or not guest or host == guest:
            return
        with self.lock, self.db:
            self.db.execute('INSERT OR IGNORE INTO invite_joins VALUES (?, ?, ?, ?)', (host, guest, host_label, time.time()))
            self.db.execute('UPDATE invite_joins SET host_label=? WHERE host=?', (host_label, host))

    def invite_counts(self):
        """How many different people each host has brought in by invite link, most first."""
        with self.lock:
            rows = self.db.execute("""SELECT host, MAX(host_label), COUNT(*), MAX(at) FROM invite_joins
                GROUP BY host ORDER BY COUNT(*) DESC, MIN(at)""").fetchall()
        return [{'id': host, 'label': label, 'count': count, 'at': at} for host, label, count, at in rows]

    def display_names(self, account_id):
        """Every display name this account has saved, with when it was last chosen."""
        with self.lock:
            return dict(self.db.execute('SELECT name, used_at FROM account_display_names WHERE account_id=?', (account_id,)).fetchall())


def participant(account, display_name, browser=None):
    """A seat's public identity: an account, or a guest known by their browser.

    Every guest browser is its own player, however many share a display name.
    Without a browser (older callers) a guest falls back to their name.
    """
    if account:
        if not account['unique_name']:
            raise ValueError('Choose your unique name before joining a game.')
        return {'id': 'account:' + account['id'], 'unique_name': account['unique_name'],
                'display_name': display_name, 'kind': 'account'}
    return {'id': 'browser:' + browser if browser else 'player:' + display_name,
            'display_name': display_name, 'kind': 'guest'}
