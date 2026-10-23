"""Release labels stored with results; older unlabelled games stay unlabelled."""
PATCH_VERSION = "1.1.1"

PATCH_NOTES = [{
    "version": PATCH_VERSION,
    "rules": {
        "revisions": [
            "4 of a Kind is no longer in House rules. It remains available in custom matches.",
            "Roman 5s divides by 2. Poisoned Card adds 3 points.",
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
