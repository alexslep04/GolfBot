# Golf

A browser-playable variant of six-card Golf, with solo play and two-player lobbies. Python runs the rules on a FastAPI server served by Uvicorn; the browser displays the table and receives live updates over WebSockets.

## Play on your computer

Install Python 3.11 or newer. On Windows, double-click **play.bat**. It creates a virtual environment, installs dependencies, starts the server, and opens the menu at **http://localhost:8000/Golfgame/**. Leave that window running; Ctrl+C stops the server. Existing localhost URLs at `/` also work.

Or start it yourself:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe launch.py
```

After updating the source, stop and restart the server so the Python backend and browser UI use the same version.

The menu offers **Join lobby**, **Host lobby**, and **Play solo**.

- **Solo:** choose a best-of-1/3/5/7/9 or Continuous match against Golf. House rules defaults on, locking every optional rule on except Beggars, which stays off, and fixing the first-player policy to random. Turn it off to customize the rules and first player. Rematches keep your match settings. Solo games and series are saved in match history.
- **Host:** choose your display name, lobby name, match length, and house or custom rules. Share the lobby link or use **Invite player** to invite an available online player. The game starts automatically when a guest joins or accepts an invitation.
- **Join:** browse existing tables or open an invite link. Review the rules, enter your name, and join to start playing.

The red number on **Join lobby** counts open tables other than your own. Presence and invitation updates poll every five seconds; a player is online for 30 seconds after their last heartbeat. Only players outside a table appear in the invitation list; signed-in duplicates are grouped by account. Invitations expire after 90 seconds and disappear when the table fills or closes. They show host, lobby, match length, house status, and expandable rule/start details, with Accept and Decline. Presence IDs are separate from private session cookies; invitations are in memory and clear on restart.

**Continuous** has no win target. Ready up after each game to continue. The first departure closes play; after both players explicitly leave, most game wins decides the series, then lower total points. An exact tie keeps the game results without a series winner. Solo departure closes both seats. An abandoned table eventually expires under the existing 12-hour cleanup; temporary disconnects still preserve the seat. Unfinished games are not scored.

Golf uses sampled lookahead to maximize the expected point difference **your score minus its score**. It considers its current turn and your reply, up to six decisions, including enabled scoring effects and bonus actions. Hidden cards and future draws are sampled from the unseen 52-card deck; the bot cannot inspect their actual identities or change the deal. The bounded search runs off the server event loop so other tables and emotes remain responsive. This is an approximate search, not a guarantee of the mathematically best move.

Run `python -m benchmarks.bot_strength --deals 16` to compare the search and old basic bot on the same fixed deals against a basic opponent, with alternating starting seats. It reports wins and average point advantage; small samples describe these deals rather than overall playing strength.

On mobile, each hand keeps its upright 2-by-3 layout, with the player name vertically on the left and Visible/Active scores vertically on the right. The draw and discard piles sit between the hands as compact sideways cards; a drawn card appears beside them while you decide.

With House rules off, use **Select all rules** in match setup or the editable solo rules panel to enable every optional rule; unchecking it clears them all.

Both players choose two opening cards. Click a card to select or unselect it; use **Flip**, **Swap**, **Draw**, or **Discard**. Selecting the go-fish pile and pressing Flip also draws. After a layout flip, **End turn** appears; Enter works too. Draw-first allows immediate discard, replacing an already visible card, or flipping a hidden card before replacing it.

Double-tap an eligible face-down card in your own hand to flip it directly. Two taps on the same card within 400 ms activate this shortcut; a single tap still selects it. Card taps suppress double-tap zoom while keeping pinch zoom available.

The combined **J-J / Q-Q** rule uses the same Swap button with two selected table cards. Each physical Jack or Queen may activate it only once; both cards in a new pair must be unused, including after final reveal. Beggars presents a rank guess to the eligible opponent; 4 of a Kind presents column choices. Hover or focus **?** for concise rule explanations. Each hand shows **Visible** points and **Active** points with current effects, including multipliers. Hidden cards are excluded. The effects sidebar lists the individual adjustments.

**V10 engine** accepts any three 10s, Jacks, or Queens in either V, including repeated ranks. **Tricky straights** adds an ascending row's rightmost base points to the opponent, or subtracts a descending row's rightmost base points from its owner. **Poisoned Card** adds 3 to the first player to reveal all six cards. **Angels 999** earns an opponent score ×9 once from a revealed row of 9s and keeps it if the row breaks. **Devils 666** locks its row; **Gamblers 777** earns /7. All additions happen first, then multiplication and division, with one final upward rounding. Pattern detection uses unmodified card values.

Use the top-right **☺** button in the action panel to switch between game actions and the four **Quick emotes**. Both players’ reactions appear prominently in the middle of the screen, labeled with the sender’s name, and fade after four seconds. Send an emote again to replay it and restart its timer; both players can react at once. Emotes work on either player’s turn and do not consume an action or clear card selections. The **bell**, shown only in the Quick emotes menu beside the back arrow, mutes your opponent’s emotes; it leaves your own emotes visible and remembers your choice in this browser.

## Match history

Open the **Match history** tab to see everyone’s games on this server, including games against Golf and best-of series. You can view matches you did not participate in. Bot matches are labeled **Vs Golf** with their match length. Each record shows every completed game's scores and winner, the series winner and game wins, total points per player, and combined points. Series winners are decided by game wins; Continuous uses lower summed points only to break a tie on wins. Rematches create separate records; unfinished series are labeled in progress, abandoned, or interrupted.

Switching tabs keeps your current table open; use **Play** to return. Refresh updates the list, and Load older matches retrieves earlier entries. History starts with the first completed game. Retained older bot records are included, but solo games that were never saved by previous versions cannot be reconstructed.

Results are saved in `data/matches.sqlite3`. Keep that file to retain history across server restarts. Anyone who can access this game server can browse saved match summaries, including player names, scores, and winners. History is shared across browsers and devices using the same server. The browser cookie is used only to mark your seat with **You** when you participated; it does not limit which records you can see. Session identifiers and hidden cards are not exposed. Google sign-in is optional; account identities are separate from display names. Google identifiers, login tokens, and browser session identifiers are never exposed in public results.

## Player stats

Open **Player stats** beside Match history. Signed-in players appear as **@unique_name** across display-name changes and devices. Guests are grouped by display name and labeled **(guest)**. The solo AI remains separate. Compare overall and head-to-head game/series wins, win rates, average points, point advantage, total points, and best/worst games. Accounts and guests using the same text are distinct; ambiguous same-name guest games are excluded.

**House rules** defaults on and shows official results from games created with a locked, versioned house preset. Turn it off to unlock custom filters and include earlier unmarked results. Rule filters offer **Any**, **On**, or **Off** for each rule. **All on** and **All off** apply every rule at once; **Reset rules** returns to overall stats. Filters apply to both players and both comparison tables; selections can be bookmarked. Stats use all saved results. Opening stats keeps your current table open.

A game is one deal; a series is a full match. Average turns counts completed turns by both players and excludes older games without turn records. Average rules in play counts enabled optional rules, independently of activations. Game win rate includes draws in the denominator. Series win rate uses completed series only; with filters, every game in the series must match. Completed games from unfinished series count toward game stats. Point advantage is your average minus your opponent’s; negative means you scored fewer points.

The **View rule activation** dropdown reports each rule's activation percentage and win rate in games where that player activated it. Activation percentage uses all filtered games with activation records, including games with the rule disabled. Each rule counts at most once per player per game, even if triggered repeatedly. An effect targeting the opponent is credited to its creator. The log preserves earlier activations even if the layout later changes. Static scoring rules also count when they apply at final reveal. Older games without activation records are excluded from these percentages; they cannot be reconstructed from final scores.

## Optional Google accounts

Use the Google button to the right of Player stats, then choose a unique name once. Unique names are lowercase, 3–24 letters/numbers/underscores, and reserved per account. The table uses the independent display name chosen when joining. Signing in does not claim previous guest games; leave the current table before changing sign-in. A series keeps the identity used when joining.

Accounts and hashed local login sessions persist in the same SQLite database. Login lasts up to 30 days and survives server restarts. Follow [GOOGLE_SIGNIN.md](GOOGLE_SIGNIN.md) to configure a Google web client ID. Without configuration, guests can play normally and the sign-in page explains its availability. The app stores no Google email, photo, password, or access token.

To intentionally clear **all match history and derived player stats**, run `python manage.py clear-history --confirm`. This is a one-time local command, never a startup reset or public endpoint. It preserves accounts. Database guards prevent a series already in memory before the reset from reappearing afterward; start a new series to record results again.

## Self-host and invite someone

**On your Wi-Fi/LAN:** run play.bat, find your computer's local IPv4 address with `ipconfig`, and open `http://YOUR_LOCAL_IP:8000` on both devices. Host the lobby from that address so Copy link creates a link reachable by your opponent. Windows may ask whether to allow Python on your private network.

**Across the internet:** the permanent game address is **https://sleptsov.dev/Golfgame/**. It uses a named Cloudflare Tunnel to your computer. No router port forwarding or ngrok account is needed.

One-time setup, as the owner of the unused Cloudflare domain `sleptsov.dev`:

1. Run **setup-cloudflare.bat**. The helper downloads a pinned, checksum-verified official `cloudflared` executable into ignored `.artifacts/tools`.
2. In the browser opened by Cloudflare, sign in, select **sleptsov.dev**, and authorize the tunnel tooling. Cloudflare saves its account authorization certificate in your Windows profile at `.cloudflared/cert.pem`.
3. The script creates the named tunnel `golfbot-sleptsov`, saves its credentials and configuration in ignored `.artifacts/cloudflare/`, and adds the proxied DNS route for `sleptsov.dev`. It does **not** overwrite an existing DNS record; if a parked or previous record conflicts, review it in Cloudflare and rerun setup. Existing tunnel names are not overwritten either.

Then run **play.bat** and **share.bat**, keeping both windows open and your computer awake. Open the public game address yourself, host a lobby there, and share **Copy link**. Invitations, history, assets, emotes, APIs, and WebSockets all stay under `/Golfgame/`. The game cookie is also scoped to this path. Localhost and the public address have separate browser cookies; host from the public address to use its invitation link yourself.

The saved tunnel identity and DNS record keep the address the same across restarts. Cloudflare reconnects temporary network outages; the sharing window retries an exited helper with a delay of up to 30 seconds. If the game server stops, the site remains unavailable until play.bat runs again; the address stays the same. After restarting Windows or closing the windows, run both files again. No startup service is installed. Use `share.bat -Port 8002` for a game server on another port, or pass `-Port` to setup-cloudflare.bat. Logs are in `.artifacts/tunnel.stdout.log` and `.artifacts/tunnel.stderr.log`.

Only `/Golfgame` and `/Golfgame/...` reach the game through the tunnel. Other public paths currently return 404, reserving the root for a future personal website. To host that website through this tunnel later, add a separate ingress rule after the game rule. To host it with another provider, add path routing at Cloudflare before changing the apex DNS; DNS alone cannot split `/Golfgame/` from `/`. See [Cloudflare named tunnels](https://developers.cloudflare.com/tunnel/get-started/) and [ingress rules](https://developers.cloudflare.com/tunnel/features/local-management/configuration-file/).

Keep `.artifacts/cloudflare/credentials.json` to reconnect this tunnel. Treat that file and your profile's `cert.pem` as secrets; never commit or share them. `config.yml` is regenerated from those credentials and the selected port on each run. The former temporary `trycloudflare.com` address cannot be retained. A stable site address does not preserve live games across game-server restarts: create a new lobby at the same address after restarting. Saved match history remains available.

**stop-hosting.bat** signals the sharing window to stop retrying, stops that supervisor, then stops its tunnel and the server started by play.bat. It checks that recorded process IDs still belong to this checkout before stopping them. Saved tunnel credentials and match history are retained.

The public address exposes this game server and its lobby directory. There are no player accounts or private-lobby passwords; anyone with that address can browse lobby names and occupy an open guest seat. Each occupied seat is protected by a random HttpOnly browser cookie. Hidden cards remain on the server. Reloading or briefly disconnecting preserves your seat; leaving an active match closes the table. Use a separate browser or browser profile to test two players on one computer.

## Rules and matches

[RULES.md](RULES.md) is the single source of truth, including descriptions loaded by the browser. House rules defaults on in the creation UI. Its versioned pool is defined in `match_settings.py`; increment the version when changing its rules or scoring. The server enforces the preset and random starting policy. API clients can request it with `house_rules: true`; omitted flags retain custom-match compatibility. Multiplayer rules are fixed for the match.

Best of 3 means first to 2 wins; best of 5 means first to 3, and so on. Tied games award neither player a win and can extend the series. Both players mark ready for the next game. Alternate starts with the host; random chooses independently each game. Winner/loser policies use the previous decisive result, falling back to alternate when the previous game tied. The host may offer a rematch after a completed match; the guest marks ready again.

Visible subtotals and effects exclude hidden cards. These are scoring aids. Future score-advantage and win-probability evaluation bars, stronger search, and reinforcement learning can use the UI-independent engine and server API.

## Deployment and development

Run **one Uvicorn worker**: active lobbies and games live in memory and clear on restart. Match summaries persist in SQLite; interrupted series keep their completed games. Multiple workers or multiple servers need shared live game state before they can serve the same lobbies. Set `GOLFBOT_HISTORY_DB` to choose another database path.

AI searches run in a separate process pool with at most two CPU workers (one on small machines), shared across all solo tables. Each search has a one-second expansion limit and a four-second response timeout, including worker startup. Busy or failed searches use a quick legal move so games keep moving without an unbounded work queue. Under heavy load this trades some bot strength for responsiveness. Leaving a table cancels its pending wait; detached work cannot change the abandoned game. Reconnecting also resumes a bot turn if its task stopped. These AI workers do not replace the single Uvicorn web worker.

Run `python -m benchmarks.bot_concurrency --games 8` for a repeatable eight-table HTTP responsiveness probe using fixed deals and an in-memory database. Add `--threads` to compare the previous threaded search. It does not touch live games or saved history.

```powershell
.\.venv\Scripts\python.exe -m uvicorn server:app --host 0.0.0.0 --port 8000 --workers 1
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

For Docker: `docker build -t golfbot .` then `docker run --rm -p 8000:8000 -v golfbot-data:/app/data golfbot`. The named volume retains history after the container stops. A hosted deployment should route both HTTP and WebSockets to this single process and terminate HTTPS at its proxy. Uvicorn trusts forwarded scheme headers from localhost by default; configure trusted proxy addresses explicitly for other hosts.

`game.py` contains turn state and the basic solo bot; `scoring.py` contains score effects; `rule_help.py` reads RULES.md; `server.py` validates player actions and sends public state; `web/` contains the responsive browser interface. Pygame is no longer required. Tests cover existing rules, role authorization, hidden-card privacy, stale moves, lobby lifecycle, match policies, and live WebSocket updates.

Cards distinguish face rank (`Card.rank`, A=1 through K=13) from immutable Golf points (`Card.base_points`, including 2=-2 and K=0). `Card.points` remains an alias for base points; browser card payloads use `rank` and `points` for these same values. Column scoring and rule effects change the hand score, never either card value. Roman 5s and V10 share one pattern detector across final scoring, visible effect totals, and the effects list.
