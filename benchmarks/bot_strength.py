"""Compare old and new bots on fixed deals: python -m benchmarks.bot_strength."""
import argparse
import json
from statistics import mean
from time import perf_counter

from bot import choose_action, play_action
from game import GolfGame


def mirror(game):
    """Temporarily map seat zero to the legacy bot's seat-one interface."""
    game.players.reverse()
    game.gambler_earned.reverse()
    game.four_offered.reverse()
    for attr in ("current", "first_player", "finisher", "final_player"):
        value = getattr(game, attr)
        if value is not None:
            setattr(game, attr, 1 - value)
    for pending in (game.guess_pending, game.arrange_pending):
        if pending:
            pending["player"] = 1 - pending["player"]


def baseline_step(game):
    flipped = game.decision_player == 0
    if flipped:
        mirror(game)
    try:
        game._opponent_step()
    finally:
        if flipped:
            mirror(game)


def play_deal(seed, search):
    game = GolfGame(seed, multiplayer=True, first_player=seed % 2)
    for player in (0, 1):
        for index in (0, 1):
            game.opening_reveal(player, index)
    for _ in range(200):
        if game.phase == "over":
            return game.score(0) - game.score(1)
        if search and game.decision_player == 1:
            play_action(game, choose_action(game))
        else:
            baseline_step(game)
    raise RuntimeError(f"Deal {seed} did not finish")


def compare(deals):
    started = perf_counter()
    results = []
    for seed in range(deals):
        # Same opening deal, starting seat and basic opponent in both matches.
        results.append({"seed": seed, "baseline_margin": play_deal(seed, False),
                        "search_margin": play_deal(seed, True)})
    return {"deals": deals,
            "baseline_wins": sum(row["baseline_margin"] > 0 for row in results),
            "search_wins": sum(row["search_margin"] > 0 for row in results),
            "baseline_mean_margin": mean(row["baseline_margin"] for row in results),
            "search_mean_margin": mean(row["search_margin"] for row in results),
            "seconds": round(perf_counter() - started, 2), "results": results}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--deals", type=int, default=16)
    args = parser.parse_args()
    if args.deals < 1:
        parser.error("--deals must be positive")
    print(json.dumps(compare(args.deals), indent=2))
