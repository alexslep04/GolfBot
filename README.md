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

The menu offers **Join lobby**, **Host lobby**, and **Play solo**.

- **Solo:** play the existing game against GolfBot. Choose optional rules before your second opening flip.
- **Host:** choose your username, lobby name, rules, best-of match length, and starting-player policy. Share the lobby link, wait for the guest to mark ready, then press Start game.
- **Join:** browse existing tables or open an invite link. Review the rules, enter your name, join, and mark ready.

Both players choose two opening cards. Click a card to select or unselect it; use **Flip**, **Swap**, **Draw**, or **Discard**. Selecting the go-fish pile and pressing Flip also draws. After a layout flip, **End turn** appears; Enter works too. Draw-first allows immediate discard, replacing an already visible card, or flipping a hidden card before replacing it.

Enabled bonus swaps use the same Swap button with two selected table cards. Beggars presents a rank guess to the eligible opponent; 4 of a Kind presents column choices. Hover or focus **?** for concise rule explanations. The effects sidebar lists individual numeric adjustments and totals separately from the turn prompt.

## Self-host and invite someone

**On your Wi-Fi/LAN:** run play.bat, find your computer's local IPv4 address with `ipconfig`, and open `http://YOUR_LOCAL_IP:8000` on both devices. Host the lobby from that address so Copy link creates a link reachable by your opponent. Windows may ask whether to allow Python on your private network.

**Across the internet:** with play.bat still running, double-click **share.bat**. It downloads a pinned, checksum-verified portable Cloudflare helper into the ignored `.artifacts/tools` directory and prints a temporary HTTPS address. No account, domain, router port forwarding, or permanent installation is needed. Open that public address on your own computer, host a lobby there, and share its **Copy link** URL. Localhost and the public address have separate browser cookies; creating the lobby through the public address lets you use that same address as the host.

Keep your computer awake and both server and tunnel windows running. Ctrl+C in the sharing window stops the public link; restarting sharing produces a new address. This is a temporary testing link with no uptime guarantee. See [Cloudflare Quick Tunnels](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).

**stop-hosting.bat** stops the server started by play.bat and any sharing helper started by share.bat, including background runs. It checks that recorded process IDs still belong to this checkout before stopping them.

The public address exposes this game server and its lobby directory. There are no player accounts or private-lobby passwords; anyone with that address can browse lobby names and occupy an open guest seat. Each occupied seat is protected by a random HttpOnly browser cookie. Hidden cards remain on the server. Reloading or briefly disconnecting preserves your seat; leaving an active match closes the table. Use a separate browser or browser profile to test two players on one computer.

## Rules and matches

[RULES.md](RULES.md) is the single source of truth, including descriptions loaded by the browser. All optional rules start disabled. Multiplayer rules are fixed for the match.

Best of 3 means first to 2 wins; best of 5 means first to 3, and so on. Tied rounds award neither player a win and can extend the series. Both players mark ready for the next round. Alternate starts with the host; random chooses independently each round. Winner/loser policies use the previous decisive result, falling back to alternate when the previous round tied. The host may offer a rematch after a completed match; the guest marks ready again.

Visible subtotals and effects exclude hidden cards. These are scoring aids. Future score-advantage and win-probability evaluation bars, stronger search, and reinforcement learning can use the UI-independent engine and server API.

## Deployment and development

Run **one Uvicorn worker**: lobbies, sessions, and match history currently live in memory. Server restarts clear them. Multiple workers or multiple servers need a shared persistent store before they can serve the same lobbies.

```powershell
.\.venv\Scripts\python.exe -m uvicorn server:app --host 0.0.0.0 --port 8000 --workers 1
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m unittest discover -s tests -v
```

For Docker: `docker build -t golfbot .` then `docker run --rm -p 8000:8000 golfbot`. A hosted deployment should route both HTTP and WebSockets to this single process and terminate HTTPS at its proxy. Uvicorn trusts forwarded scheme headers from localhost by default; configure trusted proxy addresses explicitly for other hosts.

`game.py` contains turn state and the basic solo bot; `scoring.py` contains score effects; `rule_help.py` reads RULES.md; `server.py` validates player actions and sends public state; `web/` contains the responsive browser interface. Pygame is no longer required. Tests cover existing rules, role authorization, hidden-card privacy, stale moves, lobby lifecycle, match policies, and live WebSocket updates.
