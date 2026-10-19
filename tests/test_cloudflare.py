"""Windows tunnel lifecycle checks; never connect to a Cloudflare account."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


@unittest.skipUnless(os.name == 'nt', 'Windows sharing helper')
class CloudflareTests(unittest.TestCase):
    def check_case(self, name):
        with tempfile.TemporaryDirectory(prefix='golf cloudflare test ') as directory:
            result = subprocess.run(
                ['powershell.exe', '-NoProfile', '-File',
                 str(Path(__file__).with_name('cloudflare_checks.ps1')),
                 '-Case', name, '-Directory', str(Path(directory).resolve())],
                capture_output=True, text=True, timeout=30,
            )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f'PASS {name}', result.stdout)

    def test_configuration_reserves_other_paths_and_keeps_credentials_separate(self):
        self.check_case('configuration')

    def test_helper_checksum_and_invalid_download_rejection(self):
        self.check_case('download-verification')

    def test_launch_uses_saved_named_tunnel_with_quoted_path(self):
        self.check_case('launch')

    def test_failed_helper_restarts_same_tunnel(self):
        self.check_case('reconnect')

    def test_explicit_stop_prevents_retry(self):
        self.check_case('stop-during-retry')

    def test_duplicate_helpers_and_reopening_sessions(self):
        self.check_case('supervisor')
