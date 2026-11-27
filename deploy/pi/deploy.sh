#!/usr/bin/env bash
# Update this checkout to main on GitHub and restart the server.
# Started by golf-deploy.service when GitHub asks (see .github/workflows/deploy.yml),
# or by hand:  sudo systemctl start golf-deploy   (follow it with: journalctl -fu golf-deploy)
#
# Steps: back up the data, wait for games between people to finish, move to
# origin/main, prepare the Python environment, restart, and check the server
# answers. If it does not, go back to the commit that was running.
set -euo pipefail

# (the whole script is inside main so that updating this file mid-run cannot change what is running)
main() {
  local app port patience request
  app="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  port="${GOLF_PORT:-8000}"
  patience="${GOLF_DEPLOY_WAIT:-600}"
  request="$app/data/deploy-request"
  cd "$app"

  while :; do
    local asked before target
    asked="$(cat "$request" 2>/dev/null || true)"
    before="$(git rev-parse HEAD)"
    git fetch --quiet origin main
    target="$(git rev-parse origin/main)"
    if [ "$before" = "$target" ] && healthy; then
      say "Already on ${target:0:7}; nothing to do."
    else
      update "$before" "$target"
    fi
    # another push may have arrived while this one was going in
    [ "$(cat "$request" 2>/dev/null || true)" = "$asked" ] && break
    say "Another deploy was asked for meanwhile; going again."
  done
}

say() { echo "[deploy] $*"; }

health() { curl -fsS --max-time 5 "http://127.0.0.1:${GOLF_PORT:-8000}/health" 2>/dev/null; }

healthy() { health > /dev/null; }

# how many games between people are being played right now
games_in_play() {
  health | python3 -c 'import json, sys; print(json.load(sys.stdin).get("playing", 0))' 2>/dev/null || echo 0
}

start_and_check() {
  sudo /usr/bin/systemctl restart golf.service
  for _ in $(seq 1 90); do
    sleep 2
    healthy && return 0
  done
  return 1
}

update() {
  local before="$1" target="$2" waited=0
  say "Updating ${before:0:7} -> ${target:0:7}"

  # a copy of the data as it was before this version touched it
  python3 backup.py --to "$HOME/golf-backups/before-deploy" --keep 10 || say "WARNING: the pre-deploy backup failed; continuing."

  # a restart ends every table: give games between people a while to finish
  while [ "$waited" -lt "$patience" ] && [ "$(games_in_play)" != 0 ]; do
    [ "$waited" = 0 ] && say "Waiting up to ${patience}s for $(games_in_play) game(s) in play to finish."
    sleep 15
    waited=$((waited + 15))
  done
  [ "$(games_in_play)" != 0 ] && say "Games are still in play after ${patience}s; restarting anyway."

  git reset --hard --quiet "$target"
  # build the Python environment before stopping anything (only needed when requirements.txt changed)
  if python3 bootstrap.py --check-only && start_and_check; then
    say "Deployed $(git log --oneline -1)"
    return 0
  fi

  say "ERROR: ${target:0:7} did not come up. Going back to ${before:0:7}."
  journalctl -u golf.service -n 30 --no-pager 2>/dev/null || true
  git reset --hard --quiet "$before"
  python3 bootstrap.py --check-only && start_and_check && say "Back on ${before:0:7}."
  exit 1
}

main "$@"
exit
