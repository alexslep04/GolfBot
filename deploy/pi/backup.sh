#!/usr/bin/env bash
# The daily backup (golf-backup.timer). By hand:  sudo systemctl start golf-backup
# Writes one archive to every folder in GOLF_BACKUP_DIRS (/etc/golf.env); by
# default that is ~/golf-backups, which the PC copies from (deploy/pc/pull-backups.ps1).
set -euo pipefail
app="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

args=()
for folder in ${GOLF_BACKUP_DIRS:-$HOME/golf-backups}; do
  args+=(--to "$folder")
done
exec python3 "$app/backup.py" "${args[@]}"
