# The server on the Raspberry Pi

The public game (`https://sleptsov.dev/golf/`) runs on a Raspberry Pi, from the checkout `~/golf`. The Pi runs four things, all set up by the scripts in `deploy/pi/`:

| What | Unit | Look at it |
| --- | --- | --- |
| The game server, started at boot and restarted if it stops | `golf.service` | `journalctl -u golf -f` |
| The Cloudflare tunnel | `cloudflared.service` | `journalctl -u cloudflared -f` |
| Deploys: main on GitHub → the Pi, after the tests pass | `golf-deploy.path` → `golf-deploy.service` | `journalctl -u golf-deploy -n 80` |
| The daily backup, which the PC then copies | `golf-backup.timer` → `golf-backup.service` | `journalctl -u golf-backup -n 40` |

Everything the game saves is in `~/golf/data/`: `matches.sqlite3` (matches, accounts, ratings, progression), `google-signin.json`, `push-keys.json` and `push-subscriptions.json`. Settings for the units are in `/etc/golf.env`.

`~/golf` is a deploy-only checkout: every deploy resets it to `origin/main`, so do not edit files there.

Everyday commands, on the Pi:

```bash
systemctl status golf                 # is it running?
sudo systemctl restart golf           # restart it (ends the tables in play)
sudo systemctl start golf-deploy      # deploy main now, without waiting for GitHub
sudo systemctl start golf-backup      # make a backup now
```

## Deploys

A push or merge to `main` runs the **Tests** workflow. When it passes, the **Deploy** workflow (`.github/workflows/deploy.yml`) sends `POST /golf/api/deploy` with the repository secret `DEPLOY_TOKEN`, then waits until `/golf/health` reports the new commit. It can also be run by hand from GitHub → Actions → **Deploy** → **Run workflow**. On the Pi, `deploy/pi/deploy.sh` then:

1. archives the data to `~/golf-backups/before-deploy/` (the last ten are kept);
2. waits up to ten minutes (`GOLF_DEPLOY_WAIT` in `/etc/golf.env`) for games between people to finish, since a restart ends every table. Games against Golfbot are saved and resume;
3. moves the checkout to `origin/main`, rebuilds the Python environment if `requirements.txt` changed, and restarts the server;
4. checks the server answers. If it does not, it goes back to the commit that was running and the workflow fails (GitHub emails you).

The request cannot choose what is run: it only makes the Pi fetch `main` from GitHub. That is why this is used instead of a self-hosted GitHub runner, which on a public repository can be made to run a stranger's pull request on the Pi.

If the workflow's first step fails:

- **502:** a second copy of the tunnel is running on another machine, and Cloudflare sent the request there. Only the Pi may run it.
- **403 with a Cloudflare page:** Cloudflare's bot protection is stopping GitHub's servers. Add a WAF rule that skips it for the path `/golf/api/deploy`.
- **403 "Wrong deploy token":** the `DEPLOY_TOKEN` secret does not match `GOLFBOT_DEPLOY_TOKEN` in `/etc/golf.env`.

## Logs

The server writes one log to two places: the journal (`journalctl -u golf`) and `~/golf/data/logs/golf.log`, which rotates at 2 MB and keeps ten files. It records:

- starts and stops, with the patch and commit;
- every request that changes something (tables hosted, joined and left, sign-ins, queue, tournaments, invitations), with the player, the result and how long it took;
- each finished game (table, kind, scores, winner) and each forfeit;
- any request that fails on the server or takes over a second, and every error with its traceback;
- deploy requests, including ones with a wrong token.

Moves, emotes and the presence check every few seconds are left out unless they fail. `--access-log` on `launch.py` adds every request; `GOLFBOT_LOG_LEVEL=DEBUG` and `GOLFBOT_LOG_DIR` in `/etc/golf.env` change the level and the folder.

```bash
journalctl -u golf -f                       # follow the server
journalctl -u golf --since today -p warning # today's warnings and errors
grep "game .* over" ~/golf/data/logs/golf.log | tail
```

## Backups

**On the Pi.** Every day at about 04:30 (and at the next start if the Pi was off), `golf-backup` writes `golf-YYYYMMDD-HHMMSS.tar.gz` to `~/golf-backups` (`GOLF_BACKUP_DIRS` in `/etc/golf.env`). The archive holds a consistent copy of the database, taken through SQLite's own backup while the server keeps running and checked with `PRAGMA integrity_check`, plus the `.json` files. The newest 30 archives are kept, and one a month for a year.

```bash
systemctl list-timers golf-backup.timer
journalctl -u golf-backup -n 20 --no-pager
```

**On the PC.** The scheduled task **Golf backups** runs `%USERPROFILE%\GolfBackups\pull-backups.ps1` every day at 09:00, or as soon as the PC is next on. It copies every archive newer than the ones it has, so days the PC was off are caught up, opens each copy to check it before keeping it, and keeps the newest 60 plus one a month. The data is then on two machines: the Pi's SD card and the PC.

Each run adds a line to `pull.log` in that folder. A run fails, and says why there, when the Pi cannot be reached, a copy is damaged, or the newest backup is more than two days old (the Pi has stopped making them). Nothing pops up when it fails, so look at the log now and then:

```powershell
Get-Content $env:USERPROFILE\GolfBackups\pull.log -Tail 5
```

```powershell
Get-ScheduledTaskInfo 'Golf backups' | Format-List LastRunTime, LastTaskResult, NextRunTime
```

`LastTaskResult` 0 means it worked. To remove the task: `Unregister-ScheduledTask 'Golf backups'`.

**Restoring** an archive, on the Pi (to use one that is only on the PC, `scp` it to the Pi's `~/golf-backups` first):

```bash
sudo systemctl stop golf
mkdir -p ~/golf-restore && tar -xzf ~/golf-backups/golf-20261124-043000.tar.gz -C ~/golf-restore
mv ~/golf/data/matches.sqlite3 ~/golf/data/matches.damaged.sqlite3
rm -f ~/golf/data/matches.sqlite3-wal ~/golf/data/matches.sqlite3-shm
cp ~/golf-restore/* ~/golf/data/
sudo systemctl start golf
```

## Setting up a replacement Pi

Only needed if the Pi or its SD card is replaced. On Raspberry Pi OS Bookworm or newer (Python 3.11+):

1. Clone and install: `git clone https://github.com/alexslep04/GolfBot.git ~/golf && cd ~/golf && ./deploy/pi/install.sh`. It prints a new deploy token; save it as the repository secret `DEPLOY_TOKEN`.
2. Restore the newest backup into `~/golf/data/` as above.
3. Run the tunnel: `./deploy/pi/tunnel.sh credentials.json`, with the tunnel's credentials file (on the old Pi it is `/etc/cloudflared/golf.json`). Make sure no other machine is still running the tunnel.
4. On the PC, add its SSH key to the new Pi's `~/.ssh/authorized_keys`, then run `pull-backups.ps1 -Pi USER@HOST -Install` (`deploy/pc/`).
