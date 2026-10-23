"""Keep disposable Python binaries outside the shared/synced game checkout."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import subprocess
import sys
import sysconfig
import uuid
import venv


def cache_directory():
    if os.name == 'nt':
        local = Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData' / 'Local'))
    else:
        local = Path(os.environ.get('XDG_CACHE_HOME', Path.home() / '.cache'))
    return local / 'Golf' / 'python-envs'


def environment_key(project):
    # A different interpreter, ABI, or dependency list gets a separate
    # environment. Never upgrade a synced virtual environment in place.
    identity = '\n'.join((os.path.normcase(str(project.resolve())),
                          str(Path(sys.executable).resolve()), sys.version,
                          str(sysconfig.get_config_var('SOABI'))))
    digest = hashlib.sha256(identity.encode() + (project / 'requirements.txt').read_bytes())
    return digest.hexdigest()[:20]


def environment_python(directory):
    return directory / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')


def healthy(python):
    if not python.is_file():
        return False
    code = (f'import sys; assert sys.version_info[:3] == {sys.version_info[:3]!r}; '
            'import fastapi, uvicorn, websockets, google.auth; '
            'from pydantic_core import ArgsKwargs')
    try:
        return subprocess.run([str(python), '-I', '-c', code], capture_output=True,
                              timeout=30, check=False).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def prepare_environment(project, cache=None):
    project = project.resolve()
    cache = (cache or cache_directory()).resolve()
    if cache.is_relative_to(project):
        raise RuntimeError('The Python cache must be outside the shared project folder.')
    cache.mkdir(parents=True, exist_ok=True)
    key = environment_key(project)
    pointer = cache / (key + '.current')
    selected = key
    try:
        saved = pointer.read_text(encoding='utf-8').strip()
        if re.fullmatch(re.escape(key) + r'(-[0-9a-f]{8})?', saved):
            selected = saved
    except OSError:
        pass
    directory = cache / selected
    python = environment_python(directory)
    if healthy(python):
        return python
    if directory.exists():
        print('The cached Python environment is incompatible or incomplete; creating a fresh one.', flush=True)
    # Unique creation also avoids two simultaneous launches writing the same
    # environment. Retain old directories in case another process uses them.
    directory = cache / (key + '-' + uuid.uuid4().hex[:8])
    python = environment_python(directory)
    print(f'Creating a machine-local Python environment: {directory}', flush=True)
    venv.EnvBuilder(with_pip=True).create(directory)
    subprocess.run([str(python), '-I', '-m', 'pip', 'install', '--disable-pip-version-check',
                    '-r', str(project / 'requirements.txt')], cwd=project, check=True)
    if not healthy(python):
        raise RuntimeError('Dependency imports failed in the fresh environment. No game files were changed.')
    temporary_pointer = pointer.with_name(pointer.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary_pointer.write_text(directory.name, encoding='utf-8')
    temporary_pointer.replace(pointer)
    return python


def main(argv=None):
    if sys.version_info < (3, 11):
        print('Golf needs Python 3.11 or newer.', file=sys.stderr)
        return 1
    parser = argparse.ArgumentParser(description='Prepare Golf’s local Python environment.', add_help=False)
    parser.add_argument('--check-only', action='store_true')
    args, launch_args = parser.parse_known_args(argv)
    project = Path(__file__).resolve().parent
    try:
        python = prepare_environment(project)
        print(f'Python environment ready: {python}', flush=True)
        if args.check_only:
            return 0
        # Ignore inherited Python paths, while retaining the project on sys.path.
        return subprocess.call([str(python), '-E', str(project / 'launch.py'), *launch_args], cwd=project)
    except (OSError, RuntimeError, subprocess.SubprocessError) as error:
        print(f'Could not prepare or launch Golf: {error}', file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == '__main__':
    raise SystemExit(main())
