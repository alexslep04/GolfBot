"""Release labels stored with results; older unlabelled games stay unlabelled."""
PATCH_VERSION = "1.3.0"

PATCH_NOTES = [{
    "version": PATCH_VERSION,
    # this patch names its sections itself; older ones use the default headings
    "labels": {"revisions": "Reworked rules", "additions": "New Rules", "changes": "Gameplay"},
    "rules": {
        "revisions": [
            "The Ripped 5: the 5 of diamonds now cancels out any other 5 in the opposite row, regardless of whether or not it is in an already canceled-out column.",
            "Poisoned Card: going out first now adds 1 point instead of 2.",
            "Beggars Will be Choosers: at a table of three or more, only the player who comes next can guess.",
            "Roman 5s is now called V2.",
            "Suited rows is now part of House rules.",
        ],
        "additions": [
            "Angel numbers! 666, 777, 888 and 999 are now one rule. A face-up row of three 6s or 8s multiplies every opponent's final score by 6 or 8; three 7s or 9s divide your own by 7 or 9. Once earned, a number counts even if the row breaks.",
        ],
    },
    "changes": [
        "New themes! Original is still the goat tho 🙂‍↕️",
        "Auto Ranked! Turn on \"Join Ranked on open\" in settings to be placed into the Ranked queue as soon as you open Golf.",
        "Records! A new records tab has dropped in the leaderboard page.",
        "Score Previews! Preview your score before you confirm the move. This feature can be disabled for all players by the host of a PvP game.",
        "Players 5-8 now have their own colors! Orange, dark blue, dark green, and light purple.",
        "Profiles! Pick your avatar and display name once in Settings, and skip choosing them before every game.",
        "New text emotes! \"Good luck!\", \"Wow!\", \"What a save!\", \"Ofc!\" and \"Not my tempo.\"",
        "New emote! Cackling.",
        "Every guest now has their own stats profile. The leaderboards show all guests together as one Guest.",
        "New stat: average time spent on move.",
        "Notifications! Get alerted when it's your turn.",
        "High contrast cards! Turn them on in settings for orange diamonds and blue clubs.",
        "Practice is now Play Solo: one tap starts a House rules game against Golfbot, or picks up the one you left.",
        "Quickplay is now Ranked.",
        "New records: Biggest yapper, Longest 1v1 game, Bogey monster and It's a party.",
        "A game that has ended no longer shows in the Spectate list.",
        "The Solo leaderboard and Advanced stats now show all time.",
        "Settings follow your account to every device you sign in on.",
        "Spectate! Watch any game in play, solo games included, and cheer with emotes as a Spectator. You'll follow the players to their next game.",
    ],
}, {
    "version": "1.2.0",
    "rules": {"revisions": [], "additions": []},
    "changes": [
        "Elo updates after each completed Quickplay game.",
        "Leaderboards include PVP, Solo, and Advanced views.",
        "Practice supports saving and resuming games and tracking streaks.",
        "Voiding a game ends its series.",
        "Rule counts and examples make scoring easier to follow.",
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
