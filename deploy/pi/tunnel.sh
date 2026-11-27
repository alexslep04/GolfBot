#!/usr/bin/env bash
# Run the game's existing Cloudflare tunnel from this machine.
#
#     ./deploy/pi/tunnel.sh ~/credentials.json
#
# The file is the tunnel's credentials from the computer that hosted the game
# (GolfGame\.artifacts\cloudflare\credentials.json). The tunnel and its DNS
# record stay as they are: only the machine answering changes. Stop the tunnel
# on the old computer afterwards, or Cloudflare shares visitors between the two.
set -euo pipefail

credentials="${1:-}"
port="${GOLF_PORT:-8000}"
host="${GOLF_HOSTNAME:-sleptsov.dev}"
[ -f "$credentials" ] || { echo "Usage: $0 PATH/TO/credentials.json" >&2; exit 1; }

tunnel="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1], encoding="utf-8-sig"))["TunnelID"])' "$credentials")"
case "$tunnel" in
  ????????-????-????-????-????????????) ;;
  *) echo "That file does not look like tunnel credentials." >&2; exit 1 ;;
esac

if ! command -v cloudflared > /dev/null; then
  echo "== Installing cloudflared from Cloudflare's package repository"
  sudo mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg > /dev/null
  echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' |
    sudo tee /etc/apt/sources.list.d/cloudflared.list > /dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq cloudflared
fi

sudo mkdir -p /etc/cloudflared
sudo install -m 600 "$credentials" /etc/cloudflared/golf.json
# Only the game's paths reach the server, as before; everything else is a 404.
sudo tee /etc/cloudflared/config.yml > /dev/null <<EOF
tunnel: $tunnel
credentials-file: /etc/cloudflared/golf.json
ingress:
  - hostname: $host
    path: '^/(golf|Golfgame)(/.*)?\$'
    service: http://127.0.0.1:$port
  - service: http_status:404
EOF
sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate

if systemctl list-unit-files cloudflared.service > /dev/null 2>&1 && systemctl cat cloudflared.service > /dev/null 2>&1; then
  sudo systemctl restart cloudflared
else
  sudo cloudflared service install
fi
sudo systemctl enable --now cloudflared
sleep 5
systemctl is-active cloudflared
echo "The tunnel is running here. Now stop it on the old computer, then check https://$host/golf/"
echo "You can delete $credentials; the copy the tunnel uses is /etc/cloudflared/golf.json."
