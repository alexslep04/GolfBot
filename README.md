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

- **Solo:** choose a best-of-1/3/5/7/9 match against Golf and who starts: you, Golf, alternate, random, previous winner, or previous loser. Pick rules in setup or before your second opening flip. After each game, continue the series until someone reaches the required wins; ties do not count as wins. Rematches keep your match settings. Solo games and series are saved in match history.
- **Host:** choose your username, lobby name, rules, best-of match length, and starting-player policy. Share the lobby link. The game starts automatically when a guest joins.
- **Join:** browse existing tables or open an invite link. Review the rules, enter your name, and join to start playing.

Golf uses sampled lookahead to maximize the expected point difference **your score minus its score**. It considers its current turn and your reply, up to six decisions, including enabled scoring effects and bonus actions. Hidden cards and future draws are sampled from the unseen 52-card deck; the bot cannot inspect their actual identities or change the deal. The bounded search runs off the server event loop so other tables and emotes remain responsive. This is an approximate search, not a guarantee of the mathematically best move.

Run `python -m benchmarks.bot_strength --deals 16` to compare the search and old basic bot on the same fixed deals against a basic opponent, with alternating starting seats. It reports wins and average point advantage; small samples describe these deals rather than overall playing strength.

On mobile, each hand keeps its upright 2-by-3 layout, with the player name vertically on the left and Visible/Active scores vertically on the right. The draw and discard piles sit between the hands as compact sideways cards; a drawn card appears beside them while you decide.

Use **Select all rules** in match setup or the editable solo rules panel to enable every optional rule; unchecking it clears them all.

Both players choose two opening cards. Click a card to select or unselect it; use **Flip**, **Swap**, **Draw**, or **Discard**. Selecting the go-fish pile and pressing Flip also draws. After a layout flip, **End turn** appears; Enter works too. Draw-first allows immediate discard, replacing an already visible card, or flipping a hidden card before replacing it.

Double-tap an eligible face-down card in your own hand to flip it directly. Two taps on the same card within 400 ms activate this shortcut; a single tap still selects it. Card taps suppress double-tap zoom while keeping pinch zoom available.

Enabled bonus swaps use the same Swap button with two selected table cards. Beggars presents a rank guess to the eligible opponent; 4 of a Kind presents column choices. Hover or focus **?** for concise rule explanations. Each hand shows **Visible** points and **Active** points with current effects, including multipliers. Hidden cards are excluded. The effects sidebar lists the individual adjustments.

**V10** accepts any three 10s, Jacks, or Queens in either V, including repeated ranks. **Tricky straights** adds an ascending row's rightmost base points to the opponent, or subtracts a descending row's rightmost base points from its owner. **Poisoned Card** adds 5 to the first player to reveal all six cards. All score additions/subtractions happen before divisions, using unmodified card values to detect patterns.

Use the top-right **☺** button in the action panel to switch between game actions and the four **Quick emotes**. Both players’ reactions appear prominently in the middle of the screen, labeled with the sender’s name, and fade after four seconds. Send an emote again to replay it and restart its timer; both players can react at once. Emotes work on either player’s turn and do not consume an action or clear card selections. The **bell**, shown only in the Quick emotes menu beside the back arrow, mutes your opponent’s emotes; it leaves your own emotes visible and remembers your choice in this browser.

## Match history

Open the **Match history** tab to see everyone’s games on this server, including games against Golf and best-of series. You can view matches you did not participate in. Bot matches are labeled **Vs Golf** with their match length. Each record shows every completed game's scores and winner, the series winner and game wins, total points per player, and combined points. The overall series winner is decided by wins, even if the other player has fewer summed points. Rematches create separate records; unfinished series are labeled in progress, abandoned, or interrupted.

Switching tabs keeps your current table open; use **Play** to return. Refresh updates the list, and Load older matches retrieves earlier entries. History starts with the first completed game. Retained older bot records are included, but solo games that were never saved by previous versions cannot be reconstructed.

Results are saved in `data/matches.sqlite3`. Keep that file to retain history across server restarts. Anyone who can access this game server can browse saved match summaries, including player names, scores, and winners. History is shared across browsers and devices using the same server. The browser cookie is used only to mark your seat with **You** when you participated; it does not limit which records you can see. Session identifiers and hidden cards are not exposed. There are no player accounts.

## Player stats

Open **Player stats** beside Match history. Choose a saved username, then optionally choose another player or **Golf (solo AI)**. Compare their overall records and head-to-head results: game and series wins, win rates, average points, point advantage, total points, best/worst games, and most common final score divisions. Names are case-sensitive; everyone using the same saved username shares one record. A human named Golf remains separate from the solo AI. Games with identical human usernames in both seats are excluded because those seats cannot be distinguished.

Rule filters offer **Any**, **On**, or **Off** for each rule. Any ignores that rule, On requires it, and Off excludes it. **All on** and **All off** apply every rule at once; **Reset rules** returns to overall stats. Filters apply to both players and both comparison tables; selections can be bookmarked in the page URL. Stats use all saved results, including older history pages. Opening stats keeps your current game running; return with Play.

A game is one deal; a series is a full best-of match. Game win rate is wins divided by all matching games, including draws. Series win rate uses completed matches only; with rule filters, every game in a completed series must match. Completed games from unfinished series still count toward game averages and game win rates. Point advantage is your average minus your opponent’s; a negative value means you scored fewer points.

New completed games save their own rule settings and final score divisor, including stacked Roman 5s, V10, and 777 effects. Multiplier frequencies include ×1 (no division) and use only games with recorded divisors. Older results contribute scores and wins, but missing multiplier details stay unknown; they cannot be reconstructed from final scores. Older games without separate rule settings use their saved match rules. No cards or browser identifiers are added to these results.

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

[RULES.md](RULES.md) is the single source of truth, including descriptions loaded by the browser. All optional rules start disabled. Multiplayer rules are fixed for the match.

Best of 3 means first to 2 wins; best of 5 means first to 3, and so on. Tied games award neither player a win and can extend the series. Both players mark ready for the next game. Alternate starts with the host; random chooses independently each game. Winner/loser policies use the previous decisive result, falling back to alternate when the previous game tied. The host may offer a rematch after a completed match; the guest marks ready again.

Visible subtotals and effects exclude hidden cards. These are scoring aids. Future score-advantage and win-probability evaluation bars, stronger search, and reinforcement learning can use the UI-independent engine and server API.

## Deployment and development

Run **one Uvicorn worker**: active lobbies and games live in memory and clear on restart. Match summaries persist in SQLite; interrupted series keep their completed games. Multiple workers or multiple servers need shared live game state before they can serve the same lobbies. Set `GOLFBOT_HISTORY_DB` to choose another database path.

```powershell
.\.venv\Scripts\python.exe -m uvicorn server:app --host 0.0.0.0 --port 8000 --workers 1
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

For Docker: `docker build -t golfbot .` then `docker run --rm -p 8000:8000 -v golfbot-data:/app/data golfbot`. The named volume retains history after the container stops. A hosted deployment should route both HTTP and WebSockets to this single process and terminate HTTPS at its proxy. Uvicorn trusts forwarded scheme headers from localhost by default; configure trusted proxy addresses explicitly for other hosts.

`game.py` contains turn state and the basic solo bot; `scoring.py` contains score effects; `rule_help.py` reads RULES.md; `server.py` validates player actions and sends public state; `web/` contains the responsive browser interface. Pygame is no longer required. Tests cover existing rules, role authorization, hidden-card privacy, stale moves, lobby lifecycle, match policies, and live WebSocket updates.

Cards distinguish face rank (`Card.rank`, A=1 through K=13) from immutable Golf points (`Card.base_points`, including 2=-2 and K=0). `Card.points` remains an alias for base points; browser card payloads use `rank` and `points` for these same values. Column scoring and rule effects change the hand score, never either card value. Roman 5s and V10 share one pattern detector across final scoring, visible effect totals, and the effects list.
