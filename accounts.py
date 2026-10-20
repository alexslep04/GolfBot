"""Persistent Google identities and opaque local login sessions."""
import hashlib
import re
import secrets
import sqlite3
import time

LOGIN_DAYS = 30
ACCOUNT_COOKIE = 'golf_account'
UNIQUE_NAME = re.compile(r'[a-z0-9_]{3,24}\Z')


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

    @staticmethod
    def public(row):
        return {'id': row[0], 'unique_name': row[1]} if row else None

    def login(self, google_sub):
        with self.lock, self.db:
            self.db.execute('INSERT OR IGNORE INTO accounts VALUES (?, ?, NULL)', (secrets.token_hex(16), google_sub))
            row = self.db.execute('SELECT id, unique_name FROM accounts WHERE google_sub=?', (google_sub,)).fetchone()
            token = secrets.token_urlsafe(32)
            self.db.execute('DELETE FROM account_sessions WHERE expires <= ?', (time.time(),))
            self.db.execute('INSERT INTO account_sessions VALUES (?, ?, ?)',
                            (hashlib.sha256(token.encode()).hexdigest(), row[0], time.time() + LOGIN_DAYS * 86400))
        return self.public(row), token

    def from_token(self, token):
        if not token or not re.fullmatch(r'[A-Za-z0-9_-]{43}', token):
            return None
        with self.lock:
            row = self.db.execute('SELECT a.id, a.unique_name FROM accounts a JOIN account_sessions s ON a.id=s.account_id WHERE s.token_hash=? AND s.expires > ?',
                                  (hashlib.sha256(token.encode()).hexdigest(), time.time())).fetchone()
        return self.public(row)

    def logout(self, token):
        if token:
            with self.lock, self.db:
                self.db.execute('DELETE FROM account_sessions WHERE token_hash=?', (hashlib.sha256(token.encode()).hexdigest(),))

    def choose_name(self, account_id, name):
        name = name.strip().lower()
        if not UNIQUE_NAME.fullmatch(name):
            raise ValueError('Use 3–24 letters, numbers or underscores for your unique name.')
        with self.lock, self.db:
            row = self.db.execute('SELECT id, unique_name FROM accounts WHERE id=?', (account_id,)).fetchone()
            if row is None:
                raise ValueError('Please sign in again.')
            if row[1] and row[1] != name:
                raise ValueError('Your unique name is permanent. Your display name can change each game.')
            try:
                self.db.execute('UPDATE accounts SET unique_name=? WHERE id=?', (name, account_id))
            except sqlite3.IntegrityError as error:
                raise ValueError('That unique name is already taken.') from error
        return {'id': account_id, 'unique_name': name}


def participant(account, display_name):
    if account:
        if not account['unique_name']:
            raise ValueError('Choose your unique name before joining a game.')
        return {'id': 'account:' + account['id'], 'unique_name': account['unique_name'],
                'display_name': display_name, 'kind': 'account'}
    return {'id': 'player:' + display_name, 'display_name': display_name, 'kind': 'guest'}
