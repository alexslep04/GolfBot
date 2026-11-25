#!/usr/bin/env bash
# The daily backup (golf-backup.timer). By hand:  sudo systemctl start golf-backup
# Writes one archive to every folder in GOLF_BACKUP_DIRS (/etc/golf.env).
set -euo pipefail
app="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
drive=/mnt/golf-backup
missing=

args=()
for folder in ${GOLF_BACKUP_DIRS:-$HOME/golf-backups}; do
  if [ "${folder#"$drive"/}" != "$folder" ] && ! mountpoint -q "$drive"; then
    # the drive may have been asleep or off when the Pi started: try it now
    sudo /usr/bin/mount "$drive" 2>/dev/null || true
    if ! mountpoint -q "$drive"; then
      # (never write into the empty folder of a drive that is not there: that fills the SD card)
      echo "[backup] ERROR: the backup drive is not mounted at $drive" >&2
      missing=1
      continue
    fi
  fi
  args+=(--to "$folder")
done

status=0
if [ "${#args[@]}" -gt 0 ]; then
  python3 "$app/backup.py" "${args[@]}" || status=$?
fi
# the local copy is still made when the drive is away, but the run is reported as failed
[ -z "$missing" ] || status=1
exit "$status"
