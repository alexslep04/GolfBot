# GolfBot

A browser-playable variant of six-card Golf, with solo play and two-player lobbies. Python runs the rules on a FastAPI server served by Uvicorn; the browser displays the table and receives live updates over WebSockets.

## Play on your computer

Install Python 3.11 or newer. On Windows, double-click **play.bat**. It creates a virtual environment, installs dependencies, starts the server, and opens the menu at **http://localhost:8000**. Leave that window running; Ctrl+C stops the server.

Or start it yourself:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe launch.py
```

After updating the source, stop and restart the server so the Python backend and browser UI use the same version.

The menu offers **Join lobby**, **Host lobby**, and **Play solo**.

- **Solo:** choose a best-of-1/3/5/7/9 match against GolfBot and who starts: you, GolfBot, alternate, random, previous winner, or previous loser. Pick rules in setup or before your second opening flip. After each round, continue the series until someone reaches the required wins; ties do not count as wins. Rematches keep your match settings. Solo rounds and series are saved in match history.
- **Host:** choose your username, lobby name, rules, best-of match length, and starting-player policy. Share the lobby link. The game starts automatically when a guest joins.
- **Join:** browse existing tables or open an invite link. Review the rules, enter your name, and join to start playing.

GolfBot uses sampled lookahead to maximize the expected point difference **your score minus its score**. It considers its current turn and your reply, up to six decisions, including enabled scoring effects and bonus actions. Hidden cards and future draws are sampled from the unseen 52-card deck; the bot cannot inspect their actual identities or change the deal. The bounded search runs off the server event loop so other tables and emotes remain responsive. This is an approximate search, not a guarantee of the mathematically best move.

Run `python -m benchmarks.bot_strength --deals 16` to compare the search and old basic bot on the same fixed deals against a basic opponent, with alternating starting seats. It reports wins and average point advantage; small samples describe these deals rather than overall playing strength.

On mobile, each hand keeps its upright 2-by-3 layout, with the player name vertically on the left and Visible/Active scores vertically on the right. The draw and discard piles sit between the hands as compact sideways cards; a drawn card appears beside them while you decide.

Use **Select all rules** in match setup or the editable solo rules panel to enable every optional rule; unchecking it clears them all.

Both players choose two opening cards. Click a card to select or unselect it; use **Flip**, **Swap**, **Draw**, or **Discard**. Selecting the go-fish pile and pressing Flip also draws. After a layout flip, **End turn** appears; Enter works too. Draw-first allows immediate discard, replacing an already visible card, or flipping a hidden card before replacing it.

Enabled bonus swaps use the same Swap button with two selected table cards. Beggars presents a rank guess to the eligible opponent; 4 of a Kind presents column choices. Hover or focus **?** for concise rule explanations. Each hand shows **Visible** points and **Active** points with current effects, including multipliers. Hidden cards are excluded. The effects sidebar lists the individual adjustments.

**V10** accepts any three 10s, Jacks, or Queens in either V, including repeated ranks. **Tricky straights** adds an ascending row's rightmost base points to the opponent, or subtracts a descending row's rightmost base points from its owner. **Poisoned Card** adds 5 to the first player to reveal all six cards. All score additions/subtractions happen before divisions, using unmodified card values to detect patterns.

Use the top-right **☺** button in the action panel to switch between game actions and the four **Quick emotes**. Both players’ reactions appear prominently in the middle of the screen, labeled with the sender’s name, and fade after four seconds. Send an emote again to replay it and restart its timer; both players can react at once. Emotes work on either player’s turn and do not consume an action or clear card selections. The **bell**, shown only in the Quick emotes menu beside the back arrow, mutes your opponent’s emotes; it leaves your own emotes visible and remembers your choice in this browser.

## Match history

Open the **Match history** tab to see everyone’s games on this server, including games against GolfBot and best-of series. You can view matches you did not participate in. Bot matches are labeled **Vs GolfBot** with their match length. Each record shows every completed game's scores and winner, the series winner and round wins, total points per player, and combined points. The overall series winner is decided by wins, even if the other player has fewer summed points. Rematches create separate records; unfinished series are labeled in progress, abandoned, or interrupted.

Switching tabs keeps your current table open; use **Play** to return. Refresh updates the list, and Load older matches retrieves earlier entries. History starts with the first completed round. Retained older bot records are included, but solo games that were never saved by previous versions cannot be reconstructed.

Results are saved in `data/matches.sqlite3`. Keep that file to retain history across server restarts. Anyone who can access this game server can browse saved match summaries, including player names, scores, and winners. History is shared across browsers and devices using the same server. The browser cookie is used only to mark your seat with **You** when you participated; it does not limit which records you can see. Session identifiers and hidden cards are not exposed. There are no player accounts.

## Self-host and invite someone

**On your Wi-Fi/LAN:** run play.bat, find your computer's local IPv4 address with `ipconfig`, and open `http://YOUR_LOCAL_IP:8000` on both devices. Host the lobby from that address so Copy link creates a link reachable by your opponent. Windows may ask whether to allow Python on your private network.

**Across the internet, with a persistent address:** run **play.bat**, then double-click **share.bat**. The first run asks for a free ngrok account's assigned dev domain and authtoken. No purchased domain or router port forwarding is needed.

1. Create a [free ngrok account](https://dashboard.ngrok.com/signup).
2. Copy your assigned domain from [Domains](https://dashboard.ngrok.com/domains) into the sharing window. Use the assigned hostname, not a lobby URL.
3. Paste your [authtoken](https://dashboard.ngrok.com/get-started/your-authtoken) into the hidden token prompt on your own computer. Do not paste it into chat or commit it.

The helper downloads the official portable Windows x64 ngrok executable into `.artifacts/tools` and verifies its Authenticode signature and publisher before running it. It saves the address and a Windows DPAPI-encrypted token in ignored `.artifacts/share-settings.json`. Keep that file across restarts; it can only be decrypted by the same Windows user on the same computer. Run `share.bat -Setup` to change accounts or replace the token. If the game uses another port, run `share.bat -Port 8002` (substitute your port).

Open the printed public address on your own computer, host a lobby there, and share its **Copy link** URL. Localhost and the public address have separate browser cookies; creating the lobby through the public address lets you use that same address as the host.

Keep your computer awake and both windows running. Network outages reconnect automatically, and the sharing window retries a crashed tunnel helper with a delay of up to 30 seconds, always using the saved address. If the game server stops, the site is unavailable until you restart play.bat; the address stays the same. After closing sharing or restarting Windows, run play.bat and share.bat again. Nothing is installed as a startup service. Ctrl+C stops sharing. Logs are in `.artifacts/tunnel.stdout.log` and `.artifacts/tunnel.stderr.log`.

ngrok's assigned dev domain remains attached to your account across sessions. Its free plan has usage limits and a visitor confirmation page; it provides no uptime guarantee. See [ngrok dev domains](https://ngrok.com/docs/gateway/domains) and [free-plan limits](https://ngrok.com/docs/pricing-limits/free-plan-limits). The old random `trycloudflare.com` address cannot be retained; share the new ngrok address once after setup.

**The site address persists; live games do not.** A tunnel-only interruption preserves games while the game server keeps running. Restarting the game server clears active lobbies and rounds, so old lobby invite paths will no longer work; open the same site address and create a new lobby. Saved match history remains available.

**stop-hosting.bat** stops the sharing supervisor first, then the tunnel and the server started by play.bat, including background runs. It prevents automatic tunnel retries and checks that recorded process IDs still belong to this checkout before stopping them. It preserves sharing settings and match history.

The public address exposes this game server and its lobby directory. There are no player accounts or private-lobby passwords; anyone with that address can browse lobby names and occupy an open guest seat. Each occupied seat is protected by a random HttpOnly browser cookie. Hidden cards remain on the server. Reloading or briefly disconnecting preserves your seat; leaving an active match closes the table. Use a separate browser or browser profile to test two players on one computer.

## Rules and matches

[RULES.md](RULES.md) is the single source of truth, including descriptions loaded by the browser. All optional rules start disabled. Multiplayer rules are fixed for the match.

Best of 3 means first to 2 wins; best of 5 means first to 3, and so on. Tied rounds award neither player a win and can extend the series. Both players mark ready for the next round. Alternate starts with the host; random chooses independently each round. Winner/loser policies use the previous decisive result, falling back to alternate when the previous round tied. The host may offer a rematch after a completed match; the guest marks ready again.

Visible subtotals and effects exclude hidden cards. These are scoring aids. Future score-advantage and win-probability evaluation bars, stronger search, and reinforcement learning can use the UI-independent engine and server API.

## Deployment and development

Run **one Uvicorn worker**: active lobbies and rounds live in memory and clear on restart. Match summaries persist in SQLite; interrupted series keep their completed games. Multiple workers or multiple servers need shared live game state before they can serve the same lobbies. Set `GOLFBOT_HISTORY_DB` to choose another database path.

```powershell
.\.venv\Scripts\python.exe -m uvicorn server:app --host 0.0.0.0 --port 8000 --workers 1
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

For Docker: `docker build -t golfbot .` then `docker run --rm -p 8000:8000 -v golfbot-data:/app/data golfbot`. The named volume retains history after the container stops. A hosted deployment should route both HTTP and WebSockets to this single process and terminate HTTPS at its proxy. Uvicorn trusts forwarded scheme headers from localhost by default; configure trusted proxy addresses explicitly for other hosts.

`game.py` contains turn state and the basic solo bot; `scoring.py` contains score effects; `rule_help.py` reads RULES.md; `server.py` validates player actions and sends public state; `web/` contains the responsive browser interface. Pygame is no longer required. Tests cover existing rules, role authorization, hidden-card privacy, stale moves, lobby lifecycle, match policies, and live WebSocket updates.

Cards distinguish face rank (`Card.rank`, A=1 through K=13) from immutable Golf points (`Card.base_points`, including 2=-2 and K=0). `Card.points` remains an alias for base points; browser card payloads use `rank` and `points` for these same values. Column scoring and rule effects change the hand score, never either card value. Roman 5s and V10 share one pattern detector across final scoring, visible effect totals, and the effects list.
