#!/usr/bin/env bash
# One-time setup of the Golf server on a Raspberry Pi (or any Debian machine).
# Run it from the checkout that will serve the game, as the user who owns it:
#
#     ./deploy/pi/install.sh
#
# It installs: the server as a service that starts at boot (golf.service), the
# deploy that GitHub triggers (golf-deploy.path -> golf-deploy.service), and the
# daily backup (golf-backup.timer). Safe to run again: it rewrites the same files.
set -euo pipefail

APP="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUN_AS="$(id -un)"
PORT="${GOLF_PORT:-8000}"
ENV_FILE=/etc/golf.env

if [ "$RUN_AS" = root ]; then
  echo "Run this as the user who owns $APP, not as root (it asks for sudo itself)." >&2
  exit 1
fi

echo "== Packages"
sudo apt-get update -qq
sudo apt-get install -y -qq git python3 python3-venv curl cifs-utils
python3 -c 'import sys; sys.exit(sys.version_info < (3, 11))' || {
  echo "Golf needs Python 3.11 or newer; this is $(python3 --version). Use Raspberry Pi OS Bookworm or newer." >&2
  exit 1
}

echo "== Settings ($ENV_FILE)"
if ! sudo test -f "$ENV_FILE"; then
  # the secret GitHub must present to start a deploy; made here, shown once at the end
  TOKEN="$(python3 -c 'import secrets; print(secrets.token_urlsafe(32))')"
  sudo install -m 600 -o "$RUN_AS" -g "$(id -gn)" /dev/null "$ENV_FILE"
  cat > "$ENV_FILE" <<EOF
# Settings for the Golf server, its deploys and its backups.
GOLFBOT_DEPLOY_TOKEN=$TOKEN
GOLF_PORT=$PORT
# Where the daily backup goes. The first is the network drive; the second is a
# small local copy for the days the drive cannot be reached.
GOLF_BACKUP_DIRS="/mnt/golf-backup/golf $HOME/golf-backups"
# A deploy waits this long (seconds) for games between people to finish.
GOLF_DEPLOY_WAIT=600
EOF
  NEW_TOKEN=1
fi

echo "== Services"
sudo tee /etc/systemd/system/golf.service > /dev/null <<EOF
[Unit]
Description=Golf game server
After=network-online.target
Wants=network-online.target

[Service]
User=$RUN_AS
WorkingDirectory=$APP
EnvironmentFile=$ENV_FILE
Environment=PYTHONUNBUFFERED=1
ExecStart=/usr/bin/python3 $APP/bootstrap.py --no-browser --port $PORT
Restart=always
RestartSec=3
TimeoutStopSec=20

[Install]
WantedBy=multi-user.target
EOF

# The server writes data/deploy-request when GitHub asks for a deploy; this runs it.
sudo tee /etc/systemd/system/golf-deploy.path > /dev/null <<EOF
[Unit]
Description=Deploy Golf when asked

[Path]
PathChanged=$APP/data/deploy-request

[Install]
WantedBy=multi-user.target
EOF

sudo tee /etc/systemd/system/golf-deploy.service > /dev/null <<EOF
[Unit]
Description=Update Golf to main and restart it

[Service]
Type=oneshot
User=$RUN_AS
WorkingDirectory=$APP
EnvironmentFile=$ENV_FILE
ExecStart=/bin/bash $APP/deploy/pi/deploy.sh
TimeoutStartSec=45min
EOF

sudo tee /etc/systemd/system/golf-backup.service > /dev/null <<EOF
[Unit]
Description=Back up the Golf game data
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=$RUN_AS
WorkingDirectory=$APP
EnvironmentFile=$ENV_FILE
ExecStart=/bin/bash $APP/deploy/pi/backup.sh
EOF

sudo tee /etc/systemd/system/golf-backup.timer > /dev/null <<EOF
[Unit]
Description=Back up the Golf game data every day

[Timer]
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=10min
# (a backup missed while the Pi was off runs when it is next on)
Persistent=true

[Install]
WantedBy=timers.target
EOF

# the deploy and the backup run as $RUN_AS and need exactly these two things as root
echo "$RUN_AS ALL=(root) NOPASSWD: /usr/bin/systemctl restart golf.service, /usr/bin/mount /mnt/golf-backup" | sudo tee /etc/sudoers.d/golf > /dev/null
sudo chmod 440 /etc/sudoers.d/golf
sudo visudo -cf /etc/sudoers.d/golf > /dev/null

mkdir -p "$APP/data" "$HOME/golf-backups"
chmod +x "$APP"/deploy/pi/*.sh

echo "== Python environment (the first time takes several minutes on a Pi)"
python3 "$APP/bootstrap.py" --check-only

sudo systemctl daemon-reload
sudo systemctl enable --now golf.service golf-deploy.path golf-backup.timer
sudo systemctl restart golf.service

echo "== Waiting for the server"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:$PORT/health" > /dev/null 2>&1; then
    echo "Golf is running: http://$(hostname -I | awk '{print $1}'):$PORT/golf/"
    break
  fi
  sleep 2
done
curl -fsS "http://127.0.0.1:$PORT/health" > /dev/null || {
  echo "The server did not answer. See: journalctl -u golf -n 50" >&2
  exit 1
}

if [ "${NEW_TOKEN:-}" = 1 ]; then
  echo
  echo "Deploy token (save it as the GitHub secret DEPLOY_TOKEN; it is also in $ENV_FILE):"
  echo "  $TOKEN"
fi
