import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from accounts import Accounts
from match_history import MatchHistory
from progression import PATCH, Progression


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
        self.service.rate_series('rated', [A,B],1)
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
        self.assertNotIn('private-', json.dumps(self.service.leaderboard(PATCH)))

    def test_game_and_series_ratings_are_glicko_separate_and_idempotent(self):
        # two unrated players start at 1000 with the widest deviation: a first win moves a lot
        first = self.service.rate_game('g1', [A, B], 0)
        self.assertEqual([(r['before'], r['after'], r['delta']) for r in first], [(1000, 1162, 162), (1000, 838, -162)])
        self.assertLess(first[0]['rd'], 350)
        self.service.rate_game('g2', [A, B], None)
        self.assertEqual(self.service.rate_game('g1', [A, B], 1), first)  # a retry changes nothing
        ratings = self.service.ratings(A['id'])
        self.assertEqual((ratings['game']['wins'], ratings['game']['draws'], ratings['game']['losses']), (1, 1, 0))
        # the series rating (MMR) has not moved: games do not touch it
        self.assertEqual(ratings['series'], {'rating': 1000, 'rd': 350, 'provisional': True, 'wins': 0, 'draws': 0, 'losses': 0})
        self.assertEqual(self.service.leaderboard(PATCH)['pvp'], [])  # nobody is ranked before a series
        series = self.service.rate_series('m:series', [A, B], 1)
        self.assertEqual(self.service.rate_series('m:series', [A, B], 0), series)
        rows = self.service.leaderboard(PATCH, combine_guests=False)['pvp']
        self.assertEqual([(row['id'], row['mmr'], row['wins'], row['losses'], row['win_rate']) for row in rows],
                         [(B['id'], 1162, 1, 0, 1.0), (A['id'], 838, 0, 1, 0.0)])
        self.assertEqual(rows[1]['games'], {'wins': 1, 'draws': 1, 'losses': 0})
        self.assertEqual(set(rows[0]), {'id', 'label', 'mmr', 'rd', 'provisional', 'wins', 'draws', 'losses', 'win_rate',
                                        'game_rating', 'games'})
        self.assertEqual(self.service.mmr(B), 1162)

    def test_a_rating_settles_with_play_and_loosens_with_time_and_a_new_patch(self):
        with patch('progression.time.time', return_value=1000.0):
            for game in range(12):
                self.service.rate_series(f's{game}', [A, B], game % 2)
            settled = self.service.ratings(A['id'])['series']['rd']
        self.assertLess(settled, 200)
        with patch('progression.time.time', return_value=1000.0 + 90 * 86400):
            away = self.service.ratings(A['id'])['series']
        self.assertGreater(away['rd'], settled)  # three months away: less sure
        with patch('progression.time.time', return_value=1000.0):
            later = self.service.ratings(A['id'], 'next-patch')['series']
            self.assertGreater(later['rd'], settled)  # a new patch: less sure, once
            self.assertEqual(later['rating'], self.service.ratings(A['id'])['series']['rating'])  # but it carries over
            self.service.rate_series('new', [A, B], 0, 'next-patch')
            again = self.service.ratings(A['id'], 'next-patch')['series']['rd']
            self.assertLess(again, later['rd'])

    def test_forfeit_is_positive_prediction_without_mutation(self):
        predicted = self.service.forfeit_loss([A, B], 0)
        self.assertEqual(predicted, 162)
        self.assertEqual(self.service.ratings(A['id'])['series']['losses'], 0)  # nothing was recorded
        series = self.service.rate_series('s', [A, B], 1)
        self.assertEqual(-series[0]['delta'], predicted)
        # the lower-rated player now has less to lose, and neither prediction is negative
        self.assertGreater(self.service.forfeit_loss([A, B], 1), self.service.forfeit_loss([A, B], 0))
        self.assertGreaterEqual(self.service.forfeit_loss([A, B], 0), 0)

    def test_streak_draws_losses_reset_and_event_replay(self):
        self.assertEqual(self.service.practice_result('w1', B, 0, PATCH), {'current': 1, 'best': 1, 'draws': 0})
        self.assertEqual(self.service.practice_result('d1', B, None, PATCH), {'current': 1, 'best': 1, 'draws': 1})
        self.assertEqual(self.service.practice_result('d2', B, None, PATCH), {'current': 0, 'best': 1, 'draws': 2})
        self.service.practice_result('w2', B, 0, PATCH)
        self.service.practice_result('w3', B, 0, PATCH)
        self.assertEqual(self.service.practice_result('loss', B, 1, PATCH), {'current': 0, 'best': 2, 'draws': 0})
        self.assertEqual(self.service.practice_result('w1', B, 0, PATCH), {'current': 1, 'best': 1, 'draws': 0})
        self.assertEqual(self.service.profile(B)['current_streak'], 0)
        self.service.practice_result('w4', B, 0, PATCH)
        self.service.reset_streak(B, PATCH)
        self.assertEqual(self.service.profile(B)['current_streak'], 0)
        self.assertEqual(self.service.profile(B)['best_streak'], 2)

    def test_patch_scoping_and_earliest_best_tie(self):
        with patch('progression.time.time', return_value=20):
            self.service.practice_result('a', A, 0, PATCH)
        with patch('progression.time.time', return_value=10):
            self.service.practice_result('b', B, 0, PATCH)
        self.assertEqual([r['id'] for r in self.service.leaderboard(PATCH, combine_guests=False)['solo']], [B['id'], A['id']])
        # the same event id under another patch is another event
        self.service.rate_series('same', [A, B], 0, 'old')
        self.service.rate_series('same', [A, B], 1, PATCH)
        self.service.practice_result('a', A, 0, 'old')
        # MMR carries on from patch to patch, and the Solo board is all time: both
        # read the same whichever patch is asked for
        empty = self.service.leaderboard('empty', combine_guests=False)
        self.assertEqual(empty['patch'], 'empty')
        self.assertEqual(sorted((row['id'], row['wins'], row['losses']) for row in empty['pvp']),
                         sorted([(A['id'], 1, 1), (B['id'], 1, 1)]))
        self.assertEqual([(r['id'], r['best_streak'], r['wins']) for r in empty['solo']], [(B['id'], 1, 1), (A['id'], 1, 2)])
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
        self.assertEqual(self.service.ratings(A['id'])['game']['wins'], 1)
        self.assertEqual(self.service.ratings(B['id'])['game']['rating'], 838)
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
            self.history.connection.execute("""CREATE TRIGGER reject_rating BEFORE INSERT ON ratings
                WHEN NEW.id='guest:browser-hash' BEGIN SELECT RAISE(ABORT,'test failure'); END""")
        with self.assertRaises(sqlite3.IntegrityError):
            self.service.rate_game('retry', [A, B], 0)
        # the first player's rating was written before the second failed: both are undone
        self.assertEqual(self.service.ratings(A['id'])['game'], {'rating': 1000, 'rd': 350, 'provisional': True,
                                                                 'wins': 0, 'draws': 0, 'losses': 0})
        with self.history.connection:
            self.history.connection.execute('DROP TRIGGER reject_rating')
        self.assertEqual(self.service.rate_game('retry', [A, B], 0)[0]['after'], 1162)

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
        self.assertEqual(self.service.ratings(B['id'])['game']['losses'], 1)
        self.assertEqual(self.service.ratings(other['id'])['game']['wins'], 1)
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
        self.service.profile(A, '1.10.0')  # A future row must not seed an older patch.
        new = self.service.profile(A, '1.3.0')
        self.assertEqual((new['current_streak'], new['draws_in_row']), (1, 1))
        self.assertEqual((new['best_streak'], new['best_at']), (0, None))
        board = self.service.leaderboard('1.3.0')
        self.assertEqual((board['patch'], board['pvp']), ('1.3.0', []))
        # the Solo board is all time: the 1.2.0 best is still shown, with the streak still running
        self.assertEqual([(r['id'], r['best_streak'], r['current_streak']) for r in board['solo']], [(A['id'], 1, 1)])
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

    def test_forfeit_prediction_matches_the_series_it_predicts_however_far_apart(self):
        for game in range(8):
            self.service.rate_series(f'warm{game}', [A, B], 0)
        for seat in (0, 1):
            predicted = self.service.forfeit_loss([A, B], seat)
            self.assertGreaterEqual(predicted, 0)
        predicted = self.service.forfeit_loss([A, B], 1)
        self.assertEqual(-self.service.rate_series('next', [A, B], 0)[1]['delta'], predicted)
        # a lost cause costs next to nothing: the far lower-rated player was expected to lose
        with self.history.connection:
            self.history.connection.execute("UPDATE ratings SET rating=9000, rd=30 WHERE id=? AND kind='series'", (A['id'],))
            self.history.connection.execute("UPDATE ratings SET rating=1000, rd=30 WHERE id=? AND kind='series'", (B['id'],))
        self.assertEqual(self.service.forfeit_loss([A, B], 1), 0)
        self.assertEqual(self.service.rate_series('zero', [A, B], 0)[1]['delta'], 0)


if __name__ == '__main__':
    unittest.main()
