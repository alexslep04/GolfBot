# Hosting on a Raspberry Pi

The Pi runs four things, all set up by the scripts in `deploy/pi/`:

| What | Unit | Look at it |
| --- | --- | --- |
| The game server, started at boot and restarted if it stops | `golf.service` | `journalctl -u golf -f` |
| The Cloudflare tunnel (`https://sleptsov.dev/golf/`) | `cloudflared.service` | `journalctl -u cloudflared -f` |
| Deploys: main on GitHub → the Pi, after the tests pass | `golf-deploy.path` → `golf-deploy.service` | `journalctl -u golf-deploy -n 80` |
| The daily backup to the network drive | `golf-backup.timer` → `golf-backup.service` | `journalctl -u golf-backup -n 40` |

Everything the game saves is in `~/golf/data/`: `matches.sqlite3` (matches, accounts, ratings, progression), `google-signin.json`, `push-keys.json` and `push-subscriptions.json`.

## Moving the server to the Pi

You need Raspberry Pi OS Bookworm or newer (64-bit recommended; the game needs Python 3.11+), SSH turned on, and an address for the Pi that does not change (reserve one for it in the router). Below, `pi@raspberrypi.local` stands for your user and Pi.

**1. On the Pi: get the game and install it.** The first run builds the Python environment, which takes several minutes on a Pi.

```bash
sudo apt-get install -y git
git clone https://github.com/alexslep04/GolfBot.git ~/golf
cd ~/golf && ./deploy/pi/install.sh
```

It ends by printing the address on your network (`http://<pi>:8000/golf/`) and a **deploy token**. Keep the token for step 5. Open the address from another device to see the game running, with no data yet.

**2. On the PC: stop the old server and copy the data across.** Stopping it first means nothing is written while the files are copied. In PowerShell:

```powershell
$server = (Get-NetTCPConnection -LocalPort 8000 -State Listen -ErrorAction SilentlyContinue).OwningProcess
Get-CimInstance Win32_Process -Filter "Name='python.exe'" | Where-Object { $_.ProcessId -eq $server -or $_.ParentProcessId -eq $server } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
ssh pi@raspberrypi.local "sudo systemctl stop golf"
scp C:\Users\adsle\GolfLive\data\matches.sqlite3 C:\Users\adsle\GolfLive\data\google-signin.json C:\Users\adsle\GolfLive\data\push-keys.json C:\Users\adsle\GolfLive\data\push-subscriptions.json pi@raspberrypi.local:golf/data/
scp C:\Users\adsle\OneDrive\Documents\ChatGPT\GolfGame\.artifacts\cloudflare\credentials.json pi@raspberrypi.local:credentials.json
ssh pi@raspberrypi.local "sudo systemctl start golf"
```

(If `matches.sqlite3-wal` exists beside the database after the server has stopped, copy it too.) Reload `http://<pi>:8000/golf/`: the leaderboard and match history should be there.

**3. On the Pi: take over the tunnel.**

```bash
cd ~/golf && ./deploy/pi/tunnel.sh ~/credentials.json && rm ~/credentials.json
```

This runs the same tunnel from the Pi, so the public address and its DNS record do not change.

**4. On the PC: stop the old tunnel.** Until you do, Cloudflare sends some visitors to the PC, where no server is answering.

```powershell
Stop-Process -Name cloudflared -Force
```

Check `https://sleptsov.dev/golf/`. From here on, do not run `redeploy-golf.ps1`, `play.bat` + `share.bat` or `share.ps1` for the public site: they would start a second copy of the tunnel on the PC. Keep `C:\Users\adsle\GolfLive\data` for a week or two as a fallback, then delete it.

**5. Turn on automatic deploys.** Save the token from step 1 as the repository secret `DEPLOY_TOKEN` (GitHub → Settings → Secrets and variables → Actions → New repository secret), or from the PC:

```powershell
gh secret set DEPLOY_TOKEN --repo alexslep04/GolfBot
```

(It asks you to paste the token. It is also on the Pi, in `/etc/golf.env`.) Test it from GitHub → Actions → **Deploy** → **Run workflow**.

**6. Connect the backup drive.** Give the script the drive's network share, `//HOST/SHARE`. It asks for the share's user name and password:

```bash
cd ~/golf && ./deploy/pi/backup-drive.sh //192.168.1.50/Backups
sudo systemctl start golf-backup && journalctl -u golf-backup -n 20 --no-pager
```

## Deploys

A push or merge to `main` runs the **Tests** workflow. When it passes, the **Deploy** workflow (`.github/workflows/deploy.yml`) sends `POST /golf/api/deploy` with the token, then waits until `/golf/health` reports the new commit. On the Pi, `deploy/pi/deploy.sh` then:

1. archives the data to `~/golf-backups/before-deploy/` (the last ten are kept);
2. waits up to ten minutes (`GOLF_DEPLOY_WAIT` in `/etc/golf.env`) for games between people to finish, since a restart ends every table. Games against Golfbot are saved and resume;
3. moves the checkout to `origin/main`, rebuilds the Python environment if `requirements.txt` changed, and restarts the server;
4. checks the server answers. If it does not, it goes back to the commit that was running and the workflow fails (GitHub emails you).

The request cannot choose what is run: it only makes the Pi fetch `main` from GitHub. That is why this is used instead of a self-hosted GitHub runner, which on a public repository can be made to run a stranger's pull request on the Pi. To deploy by hand: `sudo systemctl start golf-deploy`.

`~/golf` is a deploy-only checkout: the deploy resets it to `origin/main`, so do not edit files there.

If the workflow's first step gets a 403 page from Cloudflare rather than from the game, Cloudflare's bot protection is stopping GitHub's servers: add a WAF rule that skips it for the path `/golf/api/deploy`.

## Logs

The server writes one log to two places: the journal (`journalctl -u golf`) and `~/golf/data/logs/golf.log`, which rotates at 2 MB and keeps ten files. It records:

- starts and stops, with the patch and commit;
- every request that changes something (tables hosted, joined and left, sign-ins, queue, tournaments, invitations), with the player, the result and how long it took;
- each finished game (table, kind, scores, winner) and each forfeit;
- any request that fails on the server or takes over a second, and every error with its traceback;
- deploy requests, including ones with a wrong token.

Moves, emotes and the presence check every few seconds are left out unless they fail. `--access-log` on `launch.py` adds every request; `GOLFBOT_LOG_LEVEL=DEBUG` and `GOLFBOT_LOG_DIR` in `/etc/golf.env` change the level and the folder.

```bash
journalctl -u golf -f                      # follow the server
journalctl -u golf --since today -p warning # today's warnings and errors
grep "game .* over" ~/golf/data/logs/golf.log | tail
```

## Backups

Every day at about 04:30 (and at the next start if the Pi was off), `golf-backup` writes `golf-YYYYMMDD-HHMMSS.tar.gz` to each folder in `GOLF_BACKUP_DIRS`: the network drive (`/mnt/golf-backup/golf`) and a local copy (`~/golf-backups`). The archive holds a consistent copy of the database, taken through SQLite's own backup while the server keeps running and checked with `PRAGMA integrity_check`, plus the `.json` files. Each folder keeps the newest 30 archives and one a month for a year.

If the drive cannot be reached the local copy is still made and the run is marked failed. Check on it with:

```bash
systemctl list-timers golf-backup.timer
systemctl status golf-backup
ls -lh /mnt/golf-backup/golf | tail
```

**Restoring** an archive:

```bash
sudo systemctl stop golf
mkdir -p ~/golf-restore && tar -xzf /mnt/golf-backup/golf/golf-20261124-043000.tar.gz -C ~/golf-restore
mv ~/golf/data/matches.sqlite3 ~/golf/data/matches.damaged.sqlite3
rm -f ~/golf/data/matches.sqlite3-wal ~/golf/data/matches.sqlite3-shm
cp ~/golf-restore/* ~/golf/data/
sudo systemctl start golf
```
