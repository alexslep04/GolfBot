"""Explicit local maintenance commands. Never run resets during startup."""
import argparse
from pathlib import Path
from match_history import MatchHistory


def main():
    parser = argparse.ArgumentParser(description='Local Golf database maintenance')
    parser.add_argument('command', choices=['clear-history'])
    parser.add_argument('--database', type=Path, default=Path(__file__).parent / 'data/matches.sqlite3')
    parser.add_argument('--confirm', action='store_true', help='Confirm deletion of all saved match history and derived player stats')
    args = parser.parse_args()
    if not args.confirm:
        parser.error('Pass --confirm to clear history and player stats.')
    if not args.database.is_file():
        parser.error('The database does not exist.')
    history = MatchHistory(args.database)
    try:
        count = history.clear_history()
        print(f'Cleared {count} saved matches and their derived player stats.')
    finally:
        history.close()


if __name__ == '__main__':
    main()
