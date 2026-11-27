"""Where the server's log goes: the console, and a file that rotates.

The file is data/logs/golf.log (GOLFBOT_LOG_DIR moves it), kept to ten files of
2 MB, so it never fills a small disk. Under systemd the console copy is the
journal: journalctl -u golf.
"""
import logging
from logging.handlers import RotatingFileHandler
import os
from pathlib import Path

FORMAT = '%(asctime)s %(levelname)-7s %(name)s: %(message)s'


def setup_logging(directory=None, level=None):
    """Send every logger (the game's and Uvicorn's) to the console and the log file."""
    directory = Path(directory or os.environ.get('GOLFBOT_LOG_DIR') or Path(__file__).parent / 'data' / 'logs')
    level = (level or os.environ.get('GOLFBOT_LOG_LEVEL') or 'INFO').upper()
    formatter = logging.Formatter(FORMAT, '%Y-%m-%d %H:%M:%S')
    handlers = [logging.StreamHandler()]
    try:
        directory.mkdir(parents=True, exist_ok=True)
        handlers.append(RotatingFileHandler(directory / 'golf.log', maxBytes=2_000_000, backupCount=9, encoding='utf-8'))
    except OSError as error:
        # (a read-only folder must not stop the game: the console still gets everything)
        print(f'Could not open the log file in {directory}: {error}')
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
    for handler in handlers:
        handler.setFormatter(formatter)
        root.addHandler(handler)
    root.setLevel(level)
    return directory / 'golf.log'
