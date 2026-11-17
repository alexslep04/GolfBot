import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from accounts import Accounts
from match_history import MatchHistory
from progression import Progression


A = {'id': 'account:one', 'kind': 'account', 'unique_name': 'one', 'display_name': 'One'}
B = {'id': 'guest:browser-hash', 'kind': 'guest', 'display_name': 'Guest'}


class ProgressionTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / 'history.sqlite'
        self.history = MatchHistory(self.path)
        self.addCleanup(lambda: self.history.close())
        self.service = Progression(self.history)

    def test_solo_record_counts_draws_and_is_separate_from_rated_games(self):
        for event, winner in [('w1',0),('d1',None),('l1',1),('w2',0)]:
            self.service.practice_result(event, A, winner)
        self.service.practice_result('w1', A, 0)
        self.service.rate_game('rated', [A,B],1)
        row = self.service.leaderboard()['solo'][0]
        self.assertEqual((row['wins'],row['draws'],row['losses'],row['win_rate']), (2,1,1,.5))
        self.assertEqual(self.service.leaderboard()['pvp'][0]['wins'],1)
        self.history.close()
        self.history=MatchHistory(self.path)
        self.service=Progression(self.history)
        self.assertEqual(self.service.leaderboard()['solo'][0],row)

    def test_solo_record_transfers_to_account_only_once(self):
        guest={'id':'browser:guest','display_name':'Guest'}
        self.service.practice_result('guestwin',guest,0)
        self.service.practice_result('guestdraw',guest,None)
        self.service.practice_result('accountloss',A,1)
        self.service.retain_guest_practice(guest,A)
        self.service.retain_guest_practice(guest,A)
        row=self.service.leaderboard()['solo'][0]
        self.assertEqual((row['id'],row['wins'],row['draws'],row['losses']), (A['id'],1,1,1))
        self.assertAlmostEqual(row['win_rate'],1/3)

    def test_existing_solo_results_backfill_once_from_saved_events(self):
        guest={'id':'browser:'+'a'*32,'display_name':'Guest'}
        for match_id, identity in [('accountmatch',A),('guestmatch',guest)]:
            for index,winner in enumerate((0,None,1),1):
                self.service.practice_result(f'{match_id}:{index}',identity,winner)
            payload={'solo':True,'participants':[identity]}
            with self.history.connection:
                self.history.connection.execute('INSERT INTO matches VALUES (?,?,?,?,?)',
                    (match_id,'a'*64,None,0,json.dumps(payload)))
        with self.history.connection:
            for column in ('solo_wins','solo_draws','solo_losses'):
                self.history.connection.execute(f'ALTER TABLE progression_players DROP COLUMN {column}')
        self.service=Progression(self.history)
        rows=self.service.leaderboard()['solo']
        self.assertEqual(len(rows),2)
        for row in rows:
            self.assertEqual((row['wins'],row['draws'],row['losses']),(1,1,1))
        self.service=Progression(self.history)
        self.assertEqual(self.service.leaderboard()['solo'],rows)

    def test_initial_profile_and_safe_identity(self):
        identity = {**A, 'google_sub': 'private-sub', 'token': 'private-token'}
        self.assertEqual(self.service.profile(identity), {
            'id': A['id'], 'label': 'one', 'elo': 1000, 'wins': 0, 'draws': 0,
            'losses': 0, 'current_streak': 0, 'best_streak': 0,
            'draws_in_row': 0, 'best_at': None})
        self.assertNotIn('private-', json.dumps(self.service.leaderboard('1.2.0')))

    def test_ratings_wdl_expected_score_and_idempotency(self):
        first = self.service.rate_game('g1', [A, B], 0)
        self.assertEqual([r['elo'] for r in first], [1016, 984])
        self.service.rate_game('g2', [A, B], None)
        self.assertEqual(self.service.rate_game('g1', [A, B], 0), first)
        profile = self.service.profile(A)
        self.assertEqual((profile['elo'], profile['wins'], profile['draws'], profile['losses']), (1015, 1, 1, 0))
        row = self.service.leaderboard('1.2.0')['pvp'][0]
        self.assertEqual(row['win_rate'], .5)
        self.assertEqual(set(row), {'id', 'label', 'elo', 'wins', 'draws', 'losses', 'win_rate'})
        self.assertEqual(self.service.profile(B)['losses'], 1)

    def test_forfeit_is_positive_prediction_without_mutation(self):
        self.assertEqual(self.service.forfeit_loss([A, B], 0), 16)
        self.service.rate_game('g', [A, B], 0)
        self.assertEqual(self.service.forfeit_loss([A, B], 0), 17)
        self.assertEqual(self.service.forfeit_loss([A, B], 1), 15)
        self.assertEqual(self.service.profile(A)['wins'], 1)

    def test_streak_draws_losses_reset_and_event_replay(self):
        self.assertEqual(self.service.practice_result('w1', B, 0, '1.2.0'), {'current': 1, 'best': 1, 'draws': 0})
        self.assertEqual(self.service.practice_result('d1', B, None, '1.2.0'), {'current': 1, 'best': 1, 'draws': 1})
        self.assertEqual(self.service.practice_result('d2', B, None, '1.2.0'), {'current': 0, 'best': 1, 'draws': 2})
        self.service.practice_result('w2', B, 0, '1.2.0')
        self.service.practice_result('w3', B, 0, '1.2.0')
        self.assertEqual(self.service.practice_result('loss', B, 1, '1.2.0'), {'current': 0, 'best': 2, 'draws': 0})
        self.assertEqual(self.service.practice_result('w1', B, 0, '1.2.0'), {'current': 1, 'best': 1, 'draws': 0})
        self.assertEqual(self.service.profile(B)['current_streak'], 0)
        self.service.practice_result('w4', B, 0, '1.2.0')
        self.service.reset_streak(B, '1.2.0')
        self.assertEqual(self.service.profile(B)['current_streak'], 0)
        self.assertEqual(self.service.profile(B)['best_streak'], 2)

    def test_patch_scoping_and_earliest_best_tie(self):
        with patch('progression.time.time', return_value=20):
            self.service.practice_result('a', A, 0, '1.2.0')
        with patch('progression.time.time', return_value=10):
            self.service.practice_result('b', B, 0, '1.2.0')
        self.assertEqual([r['id'] for r in self.service.leaderboard('1.2.0')['solo']], [B['id'], A['id']])
        self.service.rate_game('same', [A, B], 0, 'old')
        self.service.rate_game('same', [A, B], 1, '1.2.0')
        self.service.practice_result('a', A, 0, 'old')
        self.assertEqual(self.service.profile(A)['elo'], 984)
        self.assertEqual(self.service.leaderboard('old')['pvp'][0]['elo'], 1016)
        self.assertEqual(self.service.leaderboard('empty'), {'pvp': [], 'solo': [], 'patch': 'empty'})
        self.assertEqual(self.service.profile(A)['best_at'], 20)

    def test_persistence_practice_snapshot_and_shared_lock_concurrency(self):
        payload = {'phase': 'play', 'nested': {'cards': [1, 2]}}
        self.service.save_practice('one', payload)
        payload['nested']['cards'].append(3)
        self.assertEqual(self.service.load_practice('one')['nested']['cards'], [1, 2])
        self.assertIsNone(self.service.load_practice('other'))
        with ThreadPoolExecutor(max_workers=4) as pool:
            list(pool.map(lambda _: self.service.rate_game('once', [A, B], 0), range(12)))
        self.history.close()
        self.history = MatchHistory(self.path)
        self.service = Progression(self.history)
        self.assertEqual(self.service.profile(A)['wins'], 1)
        self.assertEqual(self.service.profile(B)['elo'], 984)
        self.assertEqual(self.service.load_practice('one')['phase'], 'play')
        self.service.delete_practice('one')
        self.service.delete_practice('one')
        self.assertIsNone(self.service.load_practice('one'))

    def test_merge_stay_backs_up_original_and_changes_only_unambiguous_guest(self):
        accounts = Accounts(self.history)
        account, _ = accounts.login('private-google-sub')
        accounts.choose_name(account['id'], 'slep')
        legacy = {'id': 'player:STAY', 'display_name': 'STAY', 'kind': 'guest'}
        records = [
            {'participants': [legacy, B], 'patch': '1.1.0', 'rounds': [{'winner': 0}], 'winner': 0},
            {'participants': [{**legacy, 'kind': 'account'}, B], 'patch': '1.0.0'},
            {'participants': [{**legacy, 'display_name': 'Other'}, B]},
            {'participants': [legacy, legacy]},
        ]
        with self.history.connection:
            for i, payload in enumerate(records):
                self.history.connection.execute('INSERT INTO matches VALUES (?, ?, ?, ?, ?)', (str(i), 'hash', None, i, json.dumps(payload)))
        self.service.merge_stay()
        rows = dict(self.history.connection.execute('SELECT id,payload FROM matches'))
        merged = json.loads(rows['0'])
        self.assertEqual(merged['participants'][0], {'id': 'account:' + account['id'], 'kind': 'account', 'unique_name': 'slep', 'display_name': 'STAY'})
        self.assertEqual(merged['rounds'], records[0]['rounds'])
        self.assertEqual(merged['patch'], '1.1.0')
        for i in range(1, 4):
            self.assertEqual(json.loads(rows[str(i)]), records[i])
        backups = self.history.connection.execute('SELECT payload FROM progression_migration_backup').fetchall()
        self.assertEqual([json.loads(row[0]) for row in backups], [records[0]])
        self.service.merge_stay()
        self.assertEqual(dict(self.history.connection.execute('SELECT id,payload FROM matches')), rows)
        self.assertEqual(self.history.connection.execute('SELECT count(*) FROM progression_migration_backup').fetchone()[0], 1)

    def test_merge_without_target_retries_after_account_created_and_named(self):
        accounts = Accounts(self.history)
        original = json.dumps({'participants': [
            {'id': 'player:STAY', 'display_name': 'STAY', 'kind': 'guest'}, B],
            'patch': '1.1.0', 'rounds': [{'winner': 0}]})
        with self.history.connection:
            self.history.connection.execute('INSERT INTO matches VALUES (?,?,?,?,?)',
                                            ('late-account', 'hash', None, 1, original))
        self.assertEqual(self.service.merge_stay(), 0)
        account, _ = accounts.login('late-account-sub')
        self.assertEqual(self.service.merge_stay(), 0)
        accounts.choose_name(account['id'], 'slep')
        self.assertEqual(self.service.merge_stay(), 1)
        merged = json.loads(self.history.connection.execute('SELECT payload FROM matches').fetchone()[0])
        self.assertEqual(merged['participants'][0]['id'], 'account:' + account['id'])
        self.assertEqual(self.service.merge_stay(), 0)
        self.assertEqual(self.history.connection.execute('SELECT payload FROM progression_migration_backup').fetchone()[0], original)



class ProgressionAtomicityTests(unittest.TestCase):
    def setUp(self):
        self.history = MatchHistory()
        self.addCleanup(self.history.close)
        self.service = Progression(self.history)

    def test_rating_failure_rolls_back_both_players_and_event(self):
        import sqlite3
        with self.history.connection:
            self.history.connection.execute("""CREATE TRIGGER reject_rating BEFORE UPDATE ON progression_players
                WHEN NEW.id='guest:browser-hash' BEGIN SELECT RAISE(ABORT,'test failure'); END""")
        with self.assertRaises(sqlite3.IntegrityError):
            self.service.rate_game('retry', [A, B], 0)
        self.assertEqual(self.service.profile(A)['elo'], 1000)
        self.assertEqual(self.service.profile(A)['wins'], 0)
        with self.history.connection:
            self.history.connection.execute('DROP TRIGGER reject_rating')
        self.assertEqual(self.service.rate_game('retry', [A, B], 0)[0]['elo'], 1016)

    def test_best_date_survives_equal_best_draw_and_reset(self):
        with patch('progression.time.time', return_value=10):
            self.service.practice_result('first', A, 0)
        self.service.reset_streak(A)
        with patch('progression.time.time', return_value=20):
            self.service.practice_result('equal', A, 0)
            self.service.practice_result('draw', A, None)
        self.assertEqual(self.service.profile(A)['best_at'], 10)
        self.service.practice_result('clear-draw', A, 0)
        self.assertEqual(self.service.profile(A)['draws_in_row'], 0)

    def test_same_label_guests_are_separate_and_private_fields_not_saved(self):
        other = {**B, 'id': 'guest:another-browser-hash', 'token': 'private-token'}
        self.service.rate_game('guests', [B, other], 1)
        self.assertEqual(self.service.profile(B)['losses'], 1)
        self.assertEqual(self.service.profile(other)['wins'], 1)
        self.assertNotIn('private-token', '\n'.join(self.history.connection.iterdump()))

    def test_invalid_game_does_not_change_ratings(self):
        for players, winner in (([A], 0), ([A, A], 0), ([A, B], 2)):
            with self.assertRaises(ValueError):
                self.service.rate_game('bad', players, winner)
        self.assertEqual(self.service.leaderboard()['pvp'], [])

    def test_migration_failure_rolls_back_backup_and_payload(self):
        import sqlite3
        accounts = Accounts(self.history)
        account, _ = accounts.login('migration-sub')
        accounts.choose_name(account['id'], 'slep')
        original = json.dumps({'participants': [
            {'id': 'player:STAY', 'display_name': 'STAY', 'kind': 'guest'}, B],
            'patch': 'old', 'rounds': [{'winner': 1}]})
        with self.history.connection:
            self.history.connection.execute('INSERT INTO matches VALUES (?,?,?,?,?)', ('legacy', 'hash', None, 1, original))
            self.history.connection.execute("""CREATE TRIGGER reject_migration BEFORE UPDATE ON matches
                BEGIN SELECT RAISE(ABORT,'test failure'); END""")
        with self.assertRaises(sqlite3.IntegrityError):
            self.service.merge_stay()
        self.assertEqual(self.history.connection.execute('SELECT payload FROM matches').fetchone()[0], original)
        self.assertEqual(self.history.connection.execute('SELECT count(*) FROM progression_migration_backup').fetchone()[0], 0)
        with self.history.connection:
            self.history.connection.execute('DROP TRIGGER reject_migration')
        self.assertEqual(self.service.merge_stay(), 1)
        self.assertEqual(self.history.connection.execute('SELECT payload FROM progression_migration_backup').fetchone()[0], original)



class ProgressionPatchAndLegacyTests(unittest.TestCase):
    def setUp(self):
        self.history = MatchHistory()
        self.addCleanup(self.history.close)
        self.service = Progression(self.history)

    def test_new_patch_carries_only_current_and_draws_from_latest_older(self):
        self.service.practice_result('old-win', A, 0, '1.2.0')
        self.service.practice_result('old-draw', A, None, '1.2.0')
        self.service.rate_game('rated', [A, B], 0, '1.2.0')
        self.service.profile(A, '1.10.0')  # A future row must not seed an older patch.
        new = self.service.profile(A, '1.3.0')
        self.assertEqual((new['current_streak'], new['draws_in_row']), (1, 1))
        self.assertEqual((new['elo'], new['wins'], new['draws'], new['losses'], new['best_streak'], new['best_at']), (1000, 0, 0, 0, 0, None))
        self.assertEqual(self.service.leaderboard('1.3.0'), {'patch': '1.3.0', 'pvp': [], 'solo': []})
        self.assertEqual(self.service.practice_result('second-draw', A, None, '1.3.0'), {'current': 0, 'best': 0, 'draws': 2})
        # Re-reading the profile must not re-seed it from the old patch.
        self.assertEqual(self.service.profile(A, '1.3.0')['current_streak'], 0)
        self.service.practice_result('next-win', A, 0, '1.3.0')
        self.assertEqual(self.service.profile(A, '1.4.0')['current_streak'], 1)
        # Numeric version order, not text order: 1.10 is newer than 1.3.
        self.service.practice_result('ten-win', A, 0, '1.10.0')
        self.assertEqual(self.service.profile(A, '1.11.0')['current_streak'], 2)

    def test_legacy_history_does_not_seed_initial_progression(self):
        original = json.dumps({'names': ['STAY', 'Golfbot'], 'patch': '1.1.0', 'solo': True,
                               'rounds': [{'winner': 0}, {'winner': 0}]})
        with self.history.connection:
            self.history.connection.execute('INSERT INTO matches VALUES (?,?,?,?,?)', ('legacy', 'hash', None, 1, original))
        profile = self.service.profile(A)
        self.assertEqual((profile['current_streak'], profile['draws_in_row'], profile['best_streak']), (0, 0, 0))

    def test_inferred_legacy_seats_preserve_other_metadata_and_registered_players(self):
        accounts = Accounts(self.history)
        account, _ = accounts.login('legacy-sub')
        accounts.choose_name(account['id'], 'slep')
        other = {'id': 'account:other', 'kind': 'account', 'unique_name': 'other', 'display_name': 'STAY', 'extra': 7}
        records = [
            {'names': ['STAY', 'Other']},
            {'names': ['Other', 'STAY'], 'participants': [None, None]},
            {'names': ['STAY', 'Other'], 'participants': [None, {**B, 'extra': 4}]},
            {'names': ['Other', 'STAY'], 'participants': [None, {'id': 'player:STAY', 'kind': 'guest', 'display_name': 'STAY'}]},
            {'names': ['STAY', 'Other'], 'participants': [other, None]},
            {'names': ['STAY', 'STAY']},
        ]
        with self.history.connection:
            for i, record in enumerate(records):
                record.update(patch='1.0.0', rounds=[{'winner': 0}], winner=0)
                self.history.connection.execute('INSERT INTO matches VALUES (?,?,?,?,?)', (str(i), 'hash', None, 1, json.dumps(record)))
        self.assertEqual(self.service.merge_stay(), 4)
        rows = {key: json.loads(value) for key, value in self.history.connection.execute('SELECT id,payload FROM matches')}
        for i, seat in ((0, 0), (1, 1), (2, 0), (3, 1)):
            self.assertEqual(rows[str(i)]['participants'][seat]['id'], 'account:' + account['id'])
            self.assertEqual(rows[str(i)]['rounds'], records[i]['rounds'])
            self.assertEqual(rows[str(i)]['patch'], records[i]['patch'])
        self.assertIsNone(rows['0']['participants'][1])
        self.assertIsNone(rows['1']['participants'][0])
        self.assertEqual(rows['2']['participants'][1], records[2]['participants'][1])
        self.assertEqual(rows['4'], records[4])
        self.assertEqual(rows['5'], records[5])
        self.assertEqual(self.service.merge_stay(), 0)
        self.assertEqual(self.history.connection.execute('SELECT count(*) FROM progression_migration_backup').fetchone()[0], 4)

    def test_forfeit_prediction_matches_zero_sum_rounding_and_zero_loss(self):
        # These complementary expected scores straddle a floating-point half boundary.
        def expected(elo, opponent):
            return .5156250000000001 if elo > opponent else .484375
        self.service.profile(A)
        self.service.profile(B)
        with self.history.connection:
            self.history.connection.execute('UPDATE progression_players SET elo=1001 WHERE id=?', (A['id'],))
        with patch.object(Progression, '_expected', side_effect=expected):
            predicted = self.service.forfeit_loss([A, B], 1)
            ratings = self.service.rate_game('boundary', [A, B], 0)
        self.assertEqual(predicted, -ratings[1]['delta'])
        with self.history.connection:
            self.history.connection.execute('UPDATE progression_players SET elo=10000 WHERE id=?', (A['id'],))
            self.history.connection.execute('UPDATE progression_players SET elo=1000 WHERE id=?', (B['id'],))
        self.assertEqual(self.service.forfeit_loss([A, B], 1), 0)
        self.assertEqual(self.service.rate_game('zero', [A, B], 0)[1]['delta'], 0)


if __name__ == '__main__':
    unittest.main()
