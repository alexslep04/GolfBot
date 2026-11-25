"""Hosting: the backup tool, the server log, the health report and the deploy request."""
from datetime import datetime
import logging
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import backup
import logs
import server
from server import Store, create_app


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.data = self.root / 'data'
        self.data.mkdir()
        database = sqlite3.connect(self.data / 'matches.sqlite3')
        with database:
            database.execute('CREATE TABLE matches (id TEXT)')
            database.executemany('INSERT INTO matches VALUES (?)', [('a',), ('b',), ('c',)])
        database.close()
        (self.data / 'push-keys.json').write_text('{"key": 1}')
        (self.data / 'matches-backup-old.sqlite3').write_text('not part of a backup')
        logging.disable(logging.CRITICAL)
        self.addCleanup(logging.disable, logging.NOTSET)

    def test_an_archive_holds_a_sound_copy_of_the_database_and_the_settings_files(self):
        first, second = self.root / 'drive' / 'golf', self.root / 'local'
        # (taken while another connection has the database open, as the server does)
        live = sqlite3.connect(self.data / 'matches.sqlite3')
        self.addCleanup(live.close)
        name = backup.run(self.data, [first, second], now=datetime(2026, 11, 24, 4, 30))
        self.assertEqual(name, 'golf-20261124-043000.tar.gz')
        for folder in (first, second):
            self.assertEqual([path.name for path in folder.iterdir()], [name])
            with tarfile.open(folder / name) as tar:
                self.assertEqual(sorted(tar.getnames()), ['matches.sqlite3', 'push-keys.json'])
                tar.extractall(self.root / 'restored' / folder.name, filter='data')
            restored = sqlite3.connect(self.root / 'restored' / folder.name / 'matches.sqlite3')
            self.addCleanup(restored.close)
            self.assertEqual(restored.execute('SELECT COUNT(*) FROM matches').fetchone(), (3,))

    def test_a_folder_that_cannot_be_written_fails_the_run_but_not_the_other_copy(self):
        blocked = self.root / 'blocked'
        blocked.write_text('a file where the folder should be')
        with self.assertRaises(backup.BackupError):
            backup.run(self.data, [blocked / 'golf', self.root / 'local'])
        self.assertEqual(len(backup.archives(self.root / 'local')), 1)
        with patch('backup.logging.basicConfig'):
            self.assertEqual(backup.main(['--data', str(self.data), '--to', str(blocked / 'golf')]), 1)

    def test_a_missing_or_damaged_database_is_not_archived(self):
        with self.assertRaises(backup.BackupError):
            backup.run(self.root / 'nowhere', [self.root / 'local'])
        (self.data / 'matches.sqlite3').write_bytes(b'SQLite format 3\x00' + b'\x07' * 4096)
        with self.assertRaises((backup.BackupError, sqlite3.Error)):
            backup.run(self.data, [self.root / 'local'])
        self.assertFalse((self.root / 'local').exists() and backup.archives(self.root / 'local'))

    def test_old_archives_are_thinned_to_the_newest_and_one_a_month(self):
        folder = self.root / 'drive'
        folder.mkdir()
        days = [f'2026{month:02d}{day:02d}' for month in (8, 9, 10, 11) for day in (1, 2, 15, 28)]
        for day in days:
            (folder / f'golf-{day}-043000.tar.gz').write_text('x')
        (folder / 'holiday-photos.zip').write_text('not ours')
        removed = backup.prune(folder, keep=3)
        kept = sorted(path.name[5:13] for path in backup.archives(folder))
        # the three newest, and the first of each month
        self.assertEqual(kept, ['20260801', '20260901', '20261001', '20261101', '20261102', '20261115', '20261128'])
        self.assertEqual(len(removed), len(days) - len(kept))
        self.assertTrue((folder / 'holiday-photos.zip').exists())


class LoggingTests(unittest.TestCase):
    def test_the_log_goes_to_a_rotating_file_as_well_as_the_console(self):
        root = logging.getLogger()
        before, level = list(root.handlers), root.level
        with tempfile.TemporaryDirectory() as directory:
            try:
                path = logs.setup_logging(directory)
                logging.getLogger('server').info('Table %s game over', 'ABCD')
                logging.getLogger('uvicorn.error').warning('from Uvicorn')
                for handler in root.handlers:
                    handler.flush()
                text = path.read_text(encoding='utf-8')
            finally:
                for handler in list(root.handlers):
                    root.removeHandler(handler)
                    handler.close()
                for handler in before:
                    root.addHandler(handler)
                root.setLevel(level)
        self.assertRegex(text, r'\d{4}-\d\d-\d\d \d\d:\d\d:\d\d INFO    server: Table ABCD game over')
        self.assertIn('WARNING uvicorn.error: from Uvicorn', text)


class HostingEndpointTests(unittest.TestCase):
    def make(self, token=''):
        with patch.dict('os.environ', {'GOLFBOT_DEPLOY_TOKEN': token}), patch('server.running_commit', return_value='abc1234def'):
            client = TestClient(create_app(Store()))
        self.addCleanup(client.close)
        return client

    def test_health_reports_the_patch_the_commit_and_the_games_between_people(self):
        client = self.make()
        self.assertEqual(client.get('/health').json(),
                         {'status': 'ok', 'patch': server.PATCH_VERSION, 'commit': 'abc1234def', 'playing': 0})
        # a game against Golfbot is not one a deploy waits for
        client.get('/api/session')
        client.post('/api/solo', json={'username': 'Solo'}).raise_for_status()
        self.assertEqual(client.get('/health').json()['playing'], 0)

    def test_a_deploy_is_only_queued_for_the_right_token(self):
        closed, client = self.make(), self.make('s3cret')
        with tempfile.TemporaryDirectory() as directory, patch('server.ROOT', Path(directory)):
            note = Path(directory) / 'data' / 'deploy-request'
            # no token configured: the door is not there at all
            self.assertEqual(closed.post('/api/deploy', headers={'Authorization': 'Bearer '}).status_code, 404)
            for headers in ({}, {'Authorization': 'Bearer wrong'}, {'Authorization': 's3cret'}):
                with self.assertLogs('server', 'WARNING'):
                    self.assertEqual(client.post('/api/deploy', headers=headers).status_code, 403)
            self.assertFalse(note.exists())
            with self.assertLogs('server', 'INFO') as logged:
                reply = client.post('/api/deploy', headers={'Authorization': 'Bearer s3cret'})
            self.assertEqual((reply.status_code, reply.json()), (202, {'status': 'queued', 'commit': 'abc1234def'}))
            self.assertTrue(note.read_text().strip())
            self.assertTrue(any('Deploy requested' in line for line in logged.output))

    def test_requests_that_change_something_are_logged_and_the_frequent_ones_are_not(self):
        client = self.make()
        client.get('/api/session')
        with self.assertLogs('server', 'INFO') as logged:
            table = client.post('/api/lobbies', json={'username': 'Host'}).json()
            client.post('/api/presence', json={'username': 'Host'}).raise_for_status()
            client.get('/api/lobbies')
            client.post(f"/api/lobbies/{table['id']}/leave").raise_for_status()
            client.post('/api/lobbies/NOPE/join', json={'username': 'Host'})
        lines = [line for line in logged.output if ' -> ' in line]
        self.assertEqual(len(lines), 3, lines)
        self.assertRegex(lines[0], r"POST /api/lobbies -> 200 in \d+ ms \('Host' \S+\)")
        self.assertIn(f"POST /api/lobbies/{table['id']}/leave -> 200", lines[1])
        self.assertIn('POST /api/lobbies/NOPE/join -> 404', lines[2])


if __name__ == '__main__':
    unittest.main()
