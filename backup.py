"""Back up the game data: the database and the small settings files beside it.

    python3 backup.py --to /mnt/golf-backup/golf --to ~/golf-backups

Each run writes one archive, golf-YYYYMMDD-HHMMSS.tar.gz, to every folder given.
The database is copied through SQLite's own backup, so it is safe to run while
the server is up, and the copy is checked before it is archived. Old archives
are thinned out: the newest ones are kept, plus one a month for a year.

Standard library only: it runs on the system Python, without the game's environment.
"""
import argparse
from datetime import datetime
import logging
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parent
DATABASE = 'matches.sqlite3'
ARCHIVE = re.compile(r'golf-(\d{8})-(\d{6})\.tar\.gz')
log = logging.getLogger('golf.backup')


class BackupError(Exception):
    pass


def copy_database(source, target):
    """A consistent copy of a database that may be in use, checked for damage."""
    original = sqlite3.connect(str(source), timeout=30)  # (only read from)
    try:
        copy = sqlite3.connect(str(target))
        try:
            original.backup(copy)
            problems = [row[0] for row in copy.execute('PRAGMA integrity_check')]
            if problems != ['ok']:
                raise BackupError(f'{source.name} failed its integrity check: {"; ".join(problems[:5])}')
            return {name: copy.execute(f'SELECT COUNT(*) FROM "{name}"').fetchone()[0]
                    for (name,) in copy.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        finally:
            copy.close()
    finally:
        original.close()


def make_archive(data, archive):
    """Gather the database and every .json file in `data` into `archive`. Returns what went in."""
    database = data / DATABASE
    if not database.is_file():
        raise BackupError(f'There is no database at {database}.')
    with tempfile.TemporaryDirectory() as staging:
        staging = Path(staging)
        rows = copy_database(database, staging / DATABASE)
        for extra in sorted(data.glob('*.json')):
            shutil.copy2(extra, staging / extra.name)
        names = sorted(path.name for path in staging.iterdir())
        with tarfile.open(archive, 'w:gz') as tar:
            for name in names:
                tar.add(staging / name, arcname=name)
    # read it back: an archive that cannot be listed is not a backup
    with tarfile.open(archive, 'r:gz') as tar:
        if sorted(tar.getnames()) != names:
            raise BackupError('The archive did not read back as written.')
    return names, rows


def archives(folder):
    return sorted(path for path in folder.iterdir() if ARCHIVE.fullmatch(path.name))


def prune(folder, keep, months=12):
    """Keep the `keep` newest archives, and the first of each of the last `months` months."""
    found = archives(folder)
    wanted = set(found[-keep:]) if keep else set()
    monthly = {}
    for path in found:
        monthly.setdefault(ARCHIVE.fullmatch(path.name).group(1)[:6], path)
    wanted.update(monthly[month] for month in sorted(monthly)[-months:])
    removed = [path for path in found if path not in wanted]
    for path in removed:
        path.unlink()
    return removed


def run(data, destinations, keep=30, now=None):
    """Write one archive to each destination. Every destination is tried; any failure raises at the end."""
    name = f'golf-{(now or datetime.now()).strftime("%Y%m%d-%H%M%S")}.tar.gz'
    with tempfile.TemporaryDirectory() as work:
        archive = Path(work) / name
        names, rows = make_archive(Path(data), archive)
        size = archive.stat().st_size
        log.info('Archived %s (%.1f MB): %s; %s', name, size / 1e6, ', '.join(names),
                 ', '.join(f'{table} {count}' for table, count in sorted(rows.items())))
        failures = []
        for destination in map(Path, destinations):
            try:
                destination.mkdir(parents=True, exist_ok=True)
                partial = destination / (name + '.partial')
                shutil.copyfile(archive, partial)
                if partial.stat().st_size != size:
                    raise BackupError('the copy is not the size of the archive')
                partial.replace(destination / name)
                removed = prune(destination, keep)
                log.info('Saved to %s (%d kept, %d old removed)', destination, len(archives(destination)), len(removed))
            except (OSError, BackupError) as error:
                failures.append(destination)
                log.error('Could not save to %s: %s', destination, error)
    if failures:
        raise BackupError('The backup did not reach: ' + ', '.join(map(str, failures)))
    return name


def main(argv=None):
    parser = argparse.ArgumentParser(description='Back up the Golf database and settings.')
    parser.add_argument('--data', type=Path, default=ROOT / 'data', help='the game data folder (default: data/ beside this file)')
    parser.add_argument('--to', type=Path, action='append', required=True, metavar='FOLDER',
                        help='where to write the archive; give it more than once for several copies')
    parser.add_argument('--keep', type=int, default=30, help='how many of the newest archives to keep in each folder (default 30)')
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s', stream=sys.stdout)
    try:
        run(args.data, [folder.expanduser() for folder in args.to], args.keep)
    except (BackupError, OSError, sqlite3.Error) as error:
        log.error('Backup failed: %s', error)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
