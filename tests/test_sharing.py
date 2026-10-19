"""Exercise Windows sharing without an account or a public network connection."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


@unittest.skipUnless(os.name == 'nt', 'Windows DPAPI and PowerShell sharing helper')
class SharingTests(unittest.TestCase):
    def check_case(self, name):
        with tempfile.TemporaryDirectory(prefix='golf-sharing test ') as directory:
            result = subprocess.run(
                ['powershell.exe', '-NoProfile', '-File',
                 str(Path(__file__).with_name('sharing_checks.ps1')),
                 # PowerShell resolves Windows short (8.3) temp paths to long names.
                 '-Case', name, '-Directory', str(Path(directory).resolve())],
                capture_output=True, text=True, timeout=30,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f'PASS {name}', result.stdout)

    def test_only_assigned_https_hostnames_are_accepted(self):
        self.check_case('urls')

    def test_encrypted_settings_survive_a_new_process(self):
        self.check_case('persistence')

    def test_corrupt_settings_require_setup(self):
        self.check_case('bad-settings')

    def test_launch_keeps_token_out_of_arguments_and_restores_environment(self):
        self.check_case('launch')

    def test_failed_helper_restarts_at_same_address_and_stops_cleanly(self):
        self.check_case('reconnect')

    def test_explicit_stop_prevents_retry(self):
        self.check_case('stop-during-retry')

    def test_supervisor_rejects_duplicates_and_releases_lock_between_sessions(self):
        self.check_case('supervisor')

    def test_stop_hosting_stops_supervisor_first_and_rejects_unrelated_processes(self):
        self.check_case('stop-hosting')
