"""Launcher recovery and isolation, without installing anything in unit tests."""
from contextlib import redirect_stdout
import io
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import bootstrap


class BootstrapTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.project = self.root / 'OneDrive' / 'Golf with spaces'
        self.project.mkdir(parents=True)
        (self.project / 'requirements.txt').write_text('fastapi==0.143.0\n')
        self.cache = self.root / 'LocalCache'
        self.key = bootstrap.environment_key(self.project)
        self.silent = redirect_stdout(io.StringIO())
        self.silent.__enter__()
        self.addCleanup(self.silent.__exit__, None, None, None)

    def create_fake_environment(self, directory):
        python = bootstrap.environment_python(directory)
        python.parent.mkdir(parents=True)
        python.write_text('fake interpreter')

    def test_dependency_and_interpreter_changes_get_different_environments(self):
        (self.project / 'requirements.txt').write_text('fastapi==0.144.0\n')
        self.assertNotEqual(bootstrap.environment_key(self.project), self.key)
        with patch('bootstrap.sys.executable', str(self.root / 'different-python.exe')):
            alternate = bootstrap.environment_key(self.project)
        self.assertNotEqual(bootstrap.environment_key(self.project), alternate)

    def test_healthy_local_environment_is_reused_without_reinstalling(self):
        python = bootstrap.environment_python(self.cache / self.key)
        with patch('bootstrap.healthy', return_value=True), patch('bootstrap.venv.EnvBuilder') as builder, patch('bootstrap.subprocess.run') as run:
            self.assertEqual(bootstrap.prepare_environment(self.project, self.cache), python)
        builder.assert_not_called()
        run.assert_not_called()

    def test_broken_environment_is_replaced_without_changing_old_or_synced_files(self):
        old = self.cache / self.key
        self.create_fake_environment(old)
        synced = self.project / '.venv' / 'old-data'
        synced.parent.mkdir()
        synced.write_text('keep this')
        with patch('bootstrap.healthy', side_effect=[False, True]), patch('bootstrap.venv.EnvBuilder') as builder, patch('bootstrap.subprocess.run') as run:
            builder.return_value.create.side_effect = self.create_fake_environment
            python = bootstrap.prepare_environment(self.project, self.cache)
        self.assertNotEqual(python.parent.parent, old)
        self.assertTrue(python.is_relative_to(self.cache))
        self.assertEqual(bootstrap.environment_python(old).read_text(), 'fake interpreter')
        self.assertEqual(synced.read_text(), 'keep this')
        self.assertEqual((self.cache / (self.key + '.current')).read_text(), python.parent.parent.name)
        command = run.call_args.args[0]
        self.assertEqual(command[:4], [str(python), '-I', '-m', 'pip'])
        self.assertIn(str(self.project / 'requirements.txt'), command)

    def test_another_machines_or_untrusted_pointer_cannot_select_an_external_python(self):
        self.cache.mkdir()
        pointer = self.cache / (self.key + '.current')
        pointer.write_text('../foreign-machine/python.exe')
        with patch('bootstrap.healthy', side_effect=[False, True]) as health, patch('bootstrap.venv.EnvBuilder') as builder, patch('bootstrap.subprocess.run'):
            builder.return_value.create.side_effect = self.create_fake_environment
            python = bootstrap.prepare_environment(self.project, self.cache)
        self.assertEqual(health.call_args_list[0].args[0], bootstrap.environment_python(self.cache / self.key))
        self.assertTrue(python.is_relative_to(self.cache))

    def test_cache_inside_shared_checkout_is_rejected(self):
        with self.assertRaisesRegex(RuntimeError, 'outside'):
            bootstrap.prepare_environment(self.project, self.project / 'cache')

    def test_failed_dependency_install_does_not_replace_current_pointer(self):
        self.cache.mkdir()
        pointer = self.cache / (self.key + '.current')
        pointer.write_text(self.key)
        with patch('bootstrap.healthy', return_value=False), patch('bootstrap.venv.EnvBuilder') as builder, patch('bootstrap.subprocess.run', side_effect=subprocess.CalledProcessError(1, 'pip')):
            builder.return_value.create.side_effect = self.create_fake_environment
            with self.assertRaises(subprocess.CalledProcessError):
                bootstrap.prepare_environment(self.project, self.cache)
        self.assertEqual(pointer.read_text(), self.key)

    def test_health_probe_checks_compiled_imports_and_ignores_external_python_paths(self):
        python = self.root / 'python.exe'
        python.touch()
        with patch('bootstrap.subprocess.run', return_value=subprocess.CompletedProcess([], 1)) as run:
            self.assertFalse(bootstrap.healthy(python))
        command = run.call_args.args[0]
        self.assertEqual(command[1:3], ['-I', '-c'])
        self.assertIn('from pydantic_core import ArgsKwargs', command[3])
        self.assertIn('sys.version_info[:3]', command[3])

    def test_check_only_prepares_environment_without_starting_a_server(self):
        with patch('bootstrap.prepare_environment', return_value=self.root / 'python.exe'), patch('bootstrap.subprocess.call') as launch:
            self.assertEqual(bootstrap.main(['--check-only']), 0)
        launch.assert_not_called()

    def test_launch_preserves_arguments_without_inheriting_python_path(self):
        python = self.root / 'local python.exe'
        with patch('bootstrap.prepare_environment', return_value=python), patch('bootstrap.subprocess.call', return_value=0) as launch:
            self.assertEqual(bootstrap.main(['--no-browser', '--port', '8016']), 0)
        command = launch.call_args.args[0]
        self.assertEqual(command[:2], [str(python), '-E'])
        self.assertEqual(command[3:], ['--no-browser', '--port', '8016'])


if __name__ == '__main__':
    unittest.main()
