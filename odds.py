"""Each player's chance of winning the game in play, for spectators.

Only what the table shows is used: every face-down card and the draw pile are
dealt again at random from the cards nobody has seen, and the rest of the game
is played out many times with a quick rule-of-thumb player in every seat. A
player's chance is the share of those games they win (a tie splits the win).
"""
from collections import Counter
from hashlib import sha256
from itertools import combinations
import random
from time import monotonic

from bot import observation, public_position
from game import Card

HIDDEN = 4.5  # what a face-down card is guessed to cost (a deck averages ~5.5; pairs bring it down)


def odds_key(game):
    """Changes whenever anything a spectator can see changes."""
    return observation(public_position(game))


def deal_world(public, rng):
    """One way the unseen cards could lie, consistent with everything showing."""
    world = public_position(public)
    seen = Counter(slot.card for hand in public.players for slot in hand if slot.visible)
    seen.update(public.discard_pile)
    if public.held_card:
        seen[public.held_card] += 1
    unseen = []
    for card in (Card(rank, suit, deck) for deck in range(public.deck_count) for suit in "SHDC" for rank in range(1, 14)):
        if seen[card]:
            seen[card] -= 1
        else:
            unseen.append(card)
    rng.shuffle(unseen)
    for hand in world.players:
        for slot in hand:
            if not slot.visible:
                slot.card = unseen.pop()
    world.draw_pile = unseen[:len(public.draw_pile)]
    world.rng = random.Random(rng.random())
    return world


def column(layout, c, swap=None):
    """A column's points as its owner sees them; swap=(index, card) lays a card face up first."""
    cards = []
    for i in (c, c + 3):
        if swap and swap[0] == i:
            cards.append(swap[1])
        else:
            cards.append(layout[i].card if layout[i].visible else None)
    a, b = cards
    if a is not None and b is not None:
        return 0 if a.rank == b.rank else a.base_points + b.base_points
    return sum(HIDDEN if card is None else card.base_points for card in cards)


def hand(layout, swap=None):
    return sum(column(layout, c, swap) for c in range(3))


def best_swap(game, player, card, indexes):
    """The slot where card helps most, and how many points it saves there."""
    layout = game.players[player]
    now = hand(layout)
    gains = [(now - hand(layout, (i, card)), i) for i in indexes]
    gain, index = max(gains)
    return index, gain


def leading(game, player, layout_after=None):
    """Whether the player expects to be lowest once their hand is all face up."""
    mine = layout_after if layout_after is not None else hand(game.players[player])
    return all(mine <= hand(game.players[p]) for p in game.opponents(player))


def would_go_out(game, player, index):
    hidden = [i for i, slot in enumerate(game.players[player]) if not slot.visible]
    return hidden == [index]


def step(game, rng):
    """Play one decision for whoever is to make it."""
    phase, me = game.phase, game.decision_player
    layout = game.players[me]
    hidden = [i for i, slot in enumerate(layout) if not slot.visible]
    if phase == "setup":
        for p in range(game.player_count):
            if game.visible_count(p) < 2 and (game.multiplayer or p == 0):
                game.opening_reveal(p, rng.choice([i for i, s in enumerate(game.players[p]) if not s.visible]))
                return
        raise ValueError("stuck in setup")
    if phase == "guess":
        game.submit_guess(None)
        return
    if phase == "guess_trade":
        own, other = game.guess_trade_targets()
        game.guess_trade(own[0], other[0])
        return
    if phase == "arrange":
        pending = game.arrange_pending
        best, value = None, hand(game.players[pending["player"]])
        for cols in combinations(range(3), 2):
            plan = game.arrangement_plan(pending["player"], pending["rank"], cols)
            if plan and hand(plan) < value:
                best, value = cols, hand(plan)
        game.arrange_four(best)
        return
    if phase == "bonus":
        # trade your costliest face-up card for the cheapest one showing anywhere else
        mine = [((me, i), layout[i].card.base_points) for i in range(6) if layout[i].visible]
        others = [((p, i), slot.card.base_points) for p, other in enumerate(game.players) if p != me
                  for i, slot in enumerate(other) if slot.visible]
        if mine and others:
            (a, worst), (b, cheapest) = max(mine, key=lambda m: m[1]), min(others, key=lambda m: m[1])
            if cheapest < worst:
                game.bonus_swap(a, b)
                return
        refs = game.table_refs()
        game.bonus_swap(refs[0], refs[1]) if ("draw", None) not in refs else game.bonus_swap(("draw", None), ("discard", None))
        return
    def safe(index, card):
        # going out only when it looks like a win
        if not would_go_out(game, me, index):
            return True
        return leading(game, me, hand(layout, (index, card)))
    if phase == "choose":
        top = game.discard_pile[-1]
        index, gain = best_swap(game, me, top, range(6))
        if gain >= 2 and safe(index, top):
            game.swap(index)
        elif game.draw_pile or len(game.discard_pile) > 1:
            game.draw()
        else:
            game.reveal(rng.choice(hidden)) if hidden else game.swap(index)
        return
    if phase == "drawn":
        card = game.held_card
        index, gain = best_swap(game, me, card, range(6))
        if gain >= 1 and safe(index, card):
            game.swap(index)
        elif len(hidden) > 1 or (hidden and leading(game, me)):
            game.reveal(rng.choice(hidden))
        else:
            game.discard()
        return
    if phase == "revealed":
        index = game.flipped
        if best_swap(game, me, game.discard_pile[-1], [index])[1] >= 1:
            game.swap(index)
        elif column(layout, index % 3) > 6 and (game.draw_pile or len(game.discard_pile) > 1):
            game.draw()
        else:
            game.end_turn()
        return
    if phase == "drawn_revealed":
        index = game.flipped
        if best_swap(game, me, game.held_card, [index])[1] >= 1:
            game.swap(index)
        else:
            game.discard()
        return
    raise ValueError(f"no move for phase {phase}")


def play_out(world, rng, limit=600):
    for _ in range(limit):
        if world.phase == "over":
            break
        step(world, rng)
    if world.phase == "over":
        scores = [world.score(p) for p in range(world.player_count)]
    else:  # a game that ran on too long is judged by the hands as they stand
        scores = [hand(layout) for layout in world.players]
    low = min(scores)
    winners = [p for p, score in enumerate(scores) if score == low]
    return winners


def win_odds(game, samples=400, seconds=0.12):
    """Each player's chance of winning, as whole percents (None once the game is over)."""
    if game.phase == "over":
        return None
    public = public_position(game)
    rng = random.Random(sha256(observation(public).encode()).digest())
    wins = [0.0] * game.player_count
    played = 0
    deadline = monotonic() + seconds
    while played < samples and (played < 40 or monotonic() < deadline):
        world = deal_world(public, rng)
        try:
            winners = play_out(world, rng)
        except (ValueError, IndexError, KeyError, TypeError):
            continue
        finally:
            played += 1
        for p in winners:
            wins[p] += 1 / len(winners)
    total = sum(wins)
    if not total:
        return None
    return [round(100 * w / total, 1) for w in wins]
