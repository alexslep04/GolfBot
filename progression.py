"""Persistent progression on MatchHistory's connection and synchronization lock.

Identities contain a public stable id and display_name (unique_name for accounts).
Guest ids must already be browser-derived hashes supplied by the host. Solo
winner 0 means the human won; 1 means the bot won; None means a draw.
"""
import json
import time

from patches import PATCH_VERSION as PATCH  # one release label for the whole server


class Progression:
    def __init__(self, history):
        self.db, self.lock = history.connection, history.lock
        with self.lock, self.db:
            self.db.execute('''CREATE TABLE IF NOT EXISTS progression_players (
                patch TEXT NOT NULL, id TEXT NOT NULL, label TEXT NOT NULL,
                elo INTEGER NOT NULL DEFAULT 1000, wins INTEGER NOT NULL DEFAULT 0,
                draws INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0,
                current_streak INTEGER NOT NULL DEFAULT 0,
                best_streak INTEGER NOT NULL DEFAULT 0,
                draws_in_row INTEGER NOT NULL DEFAULT 0, best_at REAL,
                solo_games INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(patch, id))''')
            self.db.execute('''CREATE TABLE IF NOT EXISTS progression_events (
                patch TEXT NOT NULL, mode TEXT NOT NULL, event_id TEXT NOT NULL,
                result TEXT NOT NULL, PRIMARY KEY(patch, mode, event_id))''')
            self.db.execute('''CREATE TABLE IF NOT EXISTS progression_practice (
                account_id TEXT PRIMARY KEY, payload TEXT NOT NULL)''')
            self.db.execute('''CREATE TABLE IF NOT EXISTS progression_migration_backup (
                migration TEXT NOT NULL, match_id TEXT NOT NULL, payload TEXT NOT NULL,
                backed_up_at REAL NOT NULL, PRIMARY KEY(migration, match_id))''')
            columns = {row[1] for row in self.db.execute('PRAGMA table_info(progression_players)')}
            if 'solo_wins' not in columns:
                for column in ('solo_wins', 'solo_draws', 'solo_losses'):
                    self.db.execute(f'ALTER TABLE progression_players ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0')
                self._restore_solo_records()

    def _restore_solo_records(self):
        # Recover practice outcomes from pre-counter events and saved identities.
        matches = {match_id: (host, json.loads(payload)) for match_id, host, payload in
                   self.db.execute('SELECT id,host,payload FROM matches')}
        for patch, event_id, payload in self.db.execute(
                "SELECT patch,event_id,result FROM progression_events WHERE mode='solo'").fetchall():
            match_id, _, _round = event_id.rpartition(':')
            if match_id not in matches:
                continue
            host, match = matches[match_id]
            profiles = match.get('participants') or []
            identity = profiles[0] if profiles else None
            player_id = identity['id'] if identity and identity.get('kind') == 'account' else 'browser:' + host[:32]
            result = json.loads(payload)
            draw = result['draws'] > 0
            win = not draw and result['current'] > 0
            self.db.execute('''UPDATE progression_players SET solo_wins=solo_wins+?,
                solo_draws=solo_draws+?,solo_losses=solo_losses+? WHERE patch=? AND id=?''',
                (int(win), int(draw), int(not win and not draw), patch, player_id))


    @staticmethod
    def _label(identity):
        return identity.get('unique_name') or identity.get('display_name') or identity.get('label') or 'Guest'

    @staticmethod
    def _patch_version(patch):
        parts = patch.split('.')
        return tuple(map(int, parts)) if len(parts) == 3 and all(p.isdigit() for p in parts) else None

    def _player(self, identity, patch):
        current, draws = 0, 0
        exists = self.db.execute('SELECT 1 FROM progression_players WHERE patch=? AND id=?',
                                 (patch, identity['id'])).fetchone()
        version = self._patch_version(patch)
        if not exists and version is not None:
            older = []
            for previous_patch, streak, previous_draws in self.db.execute(
                    'SELECT patch,current_streak,draws_in_row FROM progression_players WHERE id=?',
                    (identity['id'],)):
                previous_version = self._patch_version(previous_patch)
                if previous_version is not None and previous_version < version:
                    older.append((previous_version, streak, previous_draws))
            if older:
                _, current, draws = max(older)
        self.db.execute('''INSERT INTO progression_players(patch,id,label,current_streak,draws_in_row)
            VALUES (?,?,?,?,?) ON CONFLICT(patch,id) DO UPDATE SET label=excluded.label''',
            (patch, identity['id'], self._label(identity), current, draws))
        row = self.db.execute('''SELECT id,label,elo,wins,draws,losses,
            current_streak,best_streak,draws_in_row,best_at
            FROM progression_players WHERE patch=? AND id=?''', (patch, identity['id'])).fetchone()
        return dict(zip(('id', 'label', 'elo', 'wins', 'draws', 'losses',
                         'current_streak', 'best_streak', 'draws_in_row', 'best_at'), row))

    def profile(self, identity, patch=PATCH):
        """Return public fields; a new patch inherits only ongoing streak and draws."""
        with self.lock, self.db:
            return self._player(identity, patch)

    def _event(self, event_id, mode, patch):
        row = self.db.execute('''SELECT result FROM progression_events
            WHERE patch=? AND mode=? AND event_id=?''', (patch, mode, event_id)).fetchone()
        return json.loads(row[0]) if row else None

    def _record(self, event_id, mode, patch, result):
        self.db.execute('INSERT INTO progression_events VALUES (?,?,?,?)',
                        (patch, mode, event_id, json.dumps(result)))
        return result

    @staticmethod
    def _expected(elo, opponent):
        # Clamping the exponent avoids overflow for very widely separated ratings.
        return 1 / (1 + 10 ** max(-300, min(300, (opponent - elo) / 400)))

    def _rating_delta(self, ratings, winner):
        score = .5 if winner is None else int(winner == 0)
        return round(32 * (score - self._expected(ratings[0], ratings[1])))

    @staticmethod
    def _participants(participants):
        if len(participants) != 2 or participants[0]['id'] == participants[1]['id']:
            raise ValueError('Two distinct participants are required.')

    @staticmethod
    def _winner(winner):
        if winner is not None and (type(winner) is not int or winner not in (0, 1)):
            raise ValueError('Winner must be seat 0, seat 1, or None.')

    def rate_game(self, event_id, participants, winner, patch=PATCH):
        """Rate one game; retries return its original ratings without changing totals.

        Each rating has id, label, before, after, delta, and elo (equal to after).
        Elo uses K=32 and integer rounding with a zero-sum delta.
        """
        self._participants(participants)
        self._winner(winner)
        with self.lock, self.db:
            previous = self._event(event_id, 'pvp', patch)
            if previous is not None:
                return previous
            players = [self._player(identity, patch) for identity in participants]
            delta = self._rating_delta([p['elo'] for p in players], winner)
            result = []
            for seat, player in enumerate(players):
                change = delta if seat == 0 else -delta
                after = player['elo'] + change
                self.db.execute('''UPDATE progression_players SET elo=?, wins=wins+?,
                    draws=draws+?, losses=losses+? WHERE patch=? AND id=?''',
                    (after, int(winner == seat), int(winner is None),
                     int(winner is not None and winner != seat), patch, player['id']))
                result.append({'id': player['id'], 'label': player['label'],
                               'before': player['elo'], 'after': after, 'delta': change, 'elo': after})
            return self._record(event_id, 'pvp', patch, result)

    def forfeit_loss(self, participants, seat, patch=PATCH):
        """Predict the exact nonnegative Elo loss without recording or creating players."""
        self._participants(participants)
        if type(seat) is not int or seat not in (0, 1):
            raise ValueError('Seat must be 0 or 1.')
        with self.lock:
            ratings = []
            for identity in participants:
                row = self.db.execute('SELECT elo FROM progression_players WHERE patch=? AND id=?',
                                      (patch, identity['id'])).fetchone()
                ratings.append(row[0] if row else 1000)
        delta = self._rating_delta(ratings, 1 - seat)
        return -delta if seat == 0 else delta

    def practice_result(self, event_id, identity, winner, patch=PATCH):
        """Record a human/bot game; consecutive draw two and later reset current."""
        self._winner(winner)
        with self.lock, self.db:
            previous = self._event(event_id, 'solo', patch)
            if previous is not None:
                return previous
            player = self._player(identity, patch)
            current, best = player['current_streak'], player['best_streak']
            draws = player['draws_in_row'] + 1 if winner is None else 0
            if winner == 0:
                current += 1
            elif winner == 1 or draws >= 2:
                current = 0
            best_at = player['best_at']
            if current > best:
                best, best_at = current, time.time()
            self.db.execute('''UPDATE progression_players SET current_streak=?,
                best_streak=?, draws_in_row=?, best_at=?, solo_games=solo_games+1,
                solo_wins=solo_wins+?,solo_draws=solo_draws+?,solo_losses=solo_losses+?
                WHERE patch=? AND id=?''', (current, best, draws, best_at,
                    int(winner == 0), int(winner is None), int(winner == 1), patch, identity['id']))
            return self._record(event_id, 'solo', patch, {'current': current, 'best': best, 'draws': draws})

    def retain_guest_practice(self, guest, account, patch=PATCH):
        """Move only browser streak state, preserving the account's stronger run.

        Completed event ids stay untouched, so replaying a guest result cannot
        count it again after adoption. Keep a zeroed source row to prevent reuse
        (including inheritance from an older patch).
        """
        if not guest['id'].startswith('browser:') or not account['id'].startswith('account:'):
            raise ValueError('Practice retention requires a browser and an account.')
        with self.lock, self.db:
            source = self._player(guest, patch)
            target = self._player(account, patch)
            current, draws = target['current_streak'], target['draws_in_row']
            if source['current_streak'] >= current:
                current, draws = source['current_streak'], source['draws_in_row']
            best, best_at = target['best_streak'], target['best_at']
            if source['best_streak'] > best:
                best, best_at = source['best_streak'], source['best_at']
            elif best > 0 and source['best_streak'] == best:
                achievements = [at for at in (best_at, source['best_at']) if at is not None]
                best_at = min(achievements) if achievements else None
            record = self.db.execute('SELECT solo_wins,solo_draws,solo_losses FROM progression_players WHERE patch=? AND id=?',
                                     (patch, guest['id'])).fetchone()
            self.db.execute('''UPDATE progression_players SET current_streak=?,
                draws_in_row=?,best_streak=?,best_at=?,solo_games=solo_games+?,
                solo_wins=solo_wins+?,solo_draws=solo_draws+?,solo_losses=solo_losses+?
                WHERE patch=? AND id=?''',
                (current, draws, best, best_at,
                 sum(record), *record, patch, account['id']))
            self.db.execute('''UPDATE progression_players SET current_streak=0,
                draws_in_row=0,best_streak=0,best_at=NULL,solo_games=0,
                solo_wins=0,solo_draws=0,solo_losses=0
                WHERE patch=? AND id=?''', (patch, guest['id']))

    def reset_streak(self, identity, patch=PATCH):
        """Reset current and consecutive draws, retaining personal best and its date."""
        with self.lock, self.db:
            self._player(identity, patch)
            self.db.execute('''UPDATE progression_players SET current_streak=0,draws_in_row=0
                WHERE patch=? AND id=?''', (patch, identity['id']))

    def leaderboard(self, patch=PATCH):
        with self.lock:
            pvp = self.db.execute('''SELECT id,label,elo,wins,draws,losses FROM progression_players
                WHERE patch=? AND wins+draws+losses>0 ORDER BY elo DESC,id''', (patch,)).fetchall()
            solo = self.db.execute('''SELECT id,label,best_streak,current_streak,best_at,solo_wins,solo_draws,solo_losses
                FROM progression_players WHERE patch=? AND solo_games>0
                ORDER BY best_streak DESC,best_at IS NULL,best_at,id''', (patch,)).fetchall()
        return {'pvp': [dict(zip(('id', 'label', 'elo', 'wins', 'draws', 'losses', 'win_rate'),
                                (*r, r[3] / sum(r[3:6])))) for r in pvp],
                'solo': [dict(zip(('id', 'label', 'best_streak', 'current_streak', 'best_at', 'wins', 'draws', 'losses', 'win_rate'), (*r, r[5] / sum(r[5:8]) if sum(r[5:8]) else None))) for r in solo],
                'patch': patch}

    def save_practice(self, account_id, payload):
        if not isinstance(payload, dict):
            raise ValueError('Practice payload must be a dictionary.')
        encoded = json.dumps(payload)
        with self.lock, self.db:
            self.db.execute('''INSERT INTO progression_practice VALUES (?,?)
                ON CONFLICT(account_id) DO UPDATE SET payload=excluded.payload''', (account_id, encoded))

    def load_practice(self, account_id):
        with self.lock:
            row = self.db.execute('SELECT payload FROM progression_practice WHERE account_id=?',
                                  (account_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def delete_practice(self, account_id):
        with self.lock, self.db:
            self.db.execute('DELETE FROM progression_practice WHERE account_id=?', (account_id,))

    def merge_stay(self):
        """Explicit post-Accounts migration; return number of changed match payloads.

        Exact legacy guest identities qualify, as do missing identities whose seat
        name is STAY (the owner confirms that name was never reused). Registered
        identities are never inferred. Back up exact original JSON in the same
        transaction before rewriting and preserve all other payload fields.
        """
        changed = 0
        with self.lock, self.db:
            targets = self.db.execute("SELECT id,unique_name FROM accounts WHERE unique_name='slep' COLLATE NOCASE").fetchall()
            if len(targets) != 1:
                return 0
            account_id, name = targets[0]
            target_id = 'account:' + account_id
            for match_id, original in self.db.execute('SELECT id,payload FROM matches').fetchall():
                payload = json.loads(original)
                names = payload.get('names')
                names = names if isinstance(names, list) else []
                participants = payload.get('participants')
                if participants is None:
                    participants = [None] * len(names)
                elif isinstance(participants, list):
                    participants = list(participants)
                    participants.extend([None] * max(0, len(names) - len(participants)))
                else:
                    continue
                candidates = []
                for seat, participant in enumerate(participants):
                    if participant is None:
                        if seat < len(names) and names[seat] == 'STAY':
                            candidates.append(seat)
                    elif (isinstance(participant, dict)
                          and participant.get('id') == 'player:STAY'
                          and participant.get('kind') == 'guest'
                          and participant.get('display_name') == 'STAY'):
                        candidates.append(seat)
                if len(candidates) != 1 or any(isinstance(p, dict) and p.get('id') == target_id
                                               for p in participants):
                    continue
                self.db.execute('''INSERT OR IGNORE INTO progression_migration_backup
                    VALUES (?,?,?,?)''', ('stay-to-slep', match_id, original, time.time()))
                participants[candidates[0]] = {'id': target_id, 'kind': 'account',
                                              'unique_name': name, 'display_name': 'STAY'}
                payload['participants'] = participants
                self.db.execute('UPDATE matches SET payload=? WHERE id=?', (json.dumps(payload), match_id))
                changed += 1
        return changed
