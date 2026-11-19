"""Release labels stored with results; older unlabelled games stay unlabelled."""
PATCH_VERSION = "1.3.0"

PATCH_NOTES = [{
    "version": PATCH_VERSION,
    # this patch names its sections itself; older ones use the default headings
    "labels": {"revisions": "Reworked rules", "additions": "New Rules", "changes": "Gameplay"},
    "rules": {
        "revisions": [
            "The Ripped 5: the 5 of diamonds now cancels out any other 5 on the board, regardless of whether or not it is in an already canceled-out row.",
            "Poisoned Card: going out first now adds 1 point instead of 2.",
        ],
        "additions": [
            "Crazy 8s! Three 8s in a row divide your final score by 8, rounded up. Check the final hand; apply once, even with two rows of 8s, after additions and before rounding up once.",
        ],
    },
    "changes": [
        "New themes! Original is still the goat tho 🙂‍↕️",
        "Auto Quickplay! You're now automatically placed into the quick queue when opening Golf. This can be turned off in settings.",
        "Records! A new records tab has dropped in the leaderboard page.",
        "Score Previews! Preview your score before you confirm the move. This feature can be disabled for all players by the host of a PvP game.",
        "Players 5-8 now have their own colors! Orange, dark blue, dark green, and light purple.",
        "Avatars are now unique to each player, except for the golfer because we're all golfers 💯.",
        "New text emotes! \"Wow!\" and \"What a save!\"",
        "Notifications! Get alerted when it's your turn.",
    ],
}, {
    "version": "1.2.0",
    "rules": {"revisions": [], "additions": []},
    "changes": [
        "Elo updates after each completed Quickplay game.",
        "Leaderboards include PVP, Solo, and Advanced views.",
        "Practice supports saving and resuming games and tracking streaks.",
        "Voiding a game ends its series.",
        "Modifier counts and rule examples make scoring easier to follow.",
        "The public game address is sleptsov.dev/golf; legacy /Golfgame links redirect to /golf.",
    ],
}, {
    "version": "1.1.2",
    "rules": {
        "revisions": [
            "V10 engine requires one 10, one Jack, and one Queen in either V, in any order. Repeated ranks no longer qualify.",
            "Roman 5s divides the final score by 2 instead of 3, rounded up. The qualifying V still totals 10 base Golf points.",
        ],
        "additions": [],
    },
    "changes": [
        "The Windows sharing helper now uses checksum-verified cloudflared 2026.10.3, including Cloudflare's certificate security fix.",
    ],
}, {
    "version": "1.1.1",
    "rules": {
        "revisions": [
            "4 of a Kind is no longer in House rules. It remains available in custom matches.",
            "Roman 5s divides by 3. Poisoned Card adds 2 points.",
        ],
        "additions": [
            "Suited rows: a single-suit row uses the middle card’s base Golf points. Red adds them to every opponent; black subtracts them from your score.",
            "All in red/black: six red cards double every opponent’s score; six black cards halve your score.",
            "All in red/black is included in House rules. Suited rows remains available only in custom matches.",
        ],
    },
    "changes": [
        "Join the 1v1 queue for a five-game Classic match with House rules.",
        "Fixed-length series use total points; equal totals are a draw.",
        "Many-player lobbies have randomized turn order and extra decks. The host starts with at least three players.",
        "Swipe between opponents. Rules that affect opponents apply to every other player.",
        "Desktop and mobile share the compact table layout. Double-tap Go Fish to draw; your drawn card sits on the pile.",
        "Rules start collapsed, your turn is highlighted, history is sorted by the latest game ending, and stats can be filtered by patch.",
        "The solo opponent is now named Golfbot.",
    ],
}]
