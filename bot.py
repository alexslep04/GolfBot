"""Bounded, public-information lookahead for the live solo opponent."""
from copy import copy
from dataclasses import asdict
from hashlib import sha256
from itertools import combinations, product
import random
from time import monotonic

from game import Card, Slot


def public_position(game):
    """Detach a position, removing every unknown card before search sees it."""
    position = copy(game)
    # Eligible target indexes are public UI information, including a retained
    # 666 lock on a card moved face down by a bonus swap.
    position._public_targets = (game._public_targets if any(slot.card is None for hand in game.players for slot in hand)
                                else tuple(game.targets()))
    position.players = [[Slot(slot.card if slot.visible else None, slot.visible)
                         for slot in hand] for hand in game.players]
    position.draw_pile = [None] * len(game.draw_pile)
    position.discard_pile = list(game.discard_pile)
    position.locked_cards = set(game.locked_cards)
    position.used_pairs = set(game.used_pairs)
    position.used_bonus_cards = set(game.used_bonus_cards)
    position.activated_rules = [set(keys) for keys in game.activated_rules]
    position.final_bonus_queue = list(game.final_bonus_queue)
    position.final_turn_queue = list(game.final_turn_queue) if game.final_turn_queue is not None else None
    position.turn_order = list(game.turn_order)
    position.gambler_earned = list(game.gambler_earned)
    position.angel_earned = list(game.angel_earned)
    position.four_offered = [set(ranks) for ranks in game.four_offered]
    position.guess_pending = dict(game.guess_pending) if game.guess_pending else None
    position.arrange_pending = dict(game.arrange_pending) if game.arrange_pending else None
    position.rules = copy(game.rules)
    position.rng = random.Random(0)
    return position


def observation(game):
    """A stable seed/group key containing only information visible at the table."""
    return repr((
        [[(slot.card, slot.visible) if slot.visible else None for slot in hand] for hand in game.players],
        len(game.draw_pile), game.discard_pile, game.held_card, asdict(game.rules),
        game.current, game.phase, game.turns, game.flipped, game.finisher,
        getattr(game, "_public_targets", tuple(game.targets())),
        game.final_player, game.is_final_turn, game.bonus_remaining,
        game.scoring_reveal, game.final_bonus_queue, game.final_turn_queue, game.turn_order,
        sorted((sorted(pair, key=repr) for pair in game.used_pairs), key=repr),
        sorted(game.locked_cards, key=repr), game.gambler_earned,
        sorted(game.used_bonus_cards, key=repr), game.angel_earned,
        [sorted(ranks) for ranks in game.four_offered], game.guess_pending, game.arrange_pending,
    ))


def sample_positions(game, count):
    """Resample unknown locations at each decision, avoiding clairvoyant replies."""
    public = public_position(game)
    rng = random.Random(sha256(observation(public).encode()).digest())
    known = {slot.card for hand in public.players for slot in hand if slot.visible}
    known.update(public.discard_pile)
    if public.held_card:
        known.add(public.held_card)
    unseen = [Card(rank, suit) for suit in "SHDC" for rank in range(1, 14)
              if Card(rank, suit) not in known]
    for _ in range(count):
        cards = list(unseen)
        rng.shuffle(cards)
        world = public_position(public)
        hidden = [(p, i, slot) for p, hand in enumerate(world.players)
                  for i, slot in enumerate(hand) if not slot.visible]
        if public.phase == "choose":
            # Assign publicly blocked hidden targets first, then preserve the
            # complementary fact that an eligible target cannot be locked.
            hidden.sort(key=lambda item: not (item[0] == public.current and item[1] not in public._public_targets))
        for player, index, slot in hidden:
            pool = cards
            if public.phase == "choose" and player == public.current:
                blocked = index not in public._public_targets
                pool = [card for card in cards if (card in public.locked_cards) == blocked]
            slot.card = rng.choice(pool)
            cards.remove(slot.card)
        world.draw_pile = cards[:len(public.draw_pile)]
        yield world


def legal_actions(game):
    """Use the same phase/target restrictions as the rules engine."""
    phase = game.phase
    if phase in ("over", "setup"):
        return []
    if phase == "guess":
        return [("guess", rank) for rank in range(1, 14)] + [("guess", None)]
    if phase == "guess_trade":
        own, other = game.guess_trade_targets()
        return [("trade", a, b) for a, b in product(own, other)]
    if phase == "arrange":
        pending = game.arrange_pending
        return [("arrange", None)] + [("arrange", cols) for cols in combinations(range(3), 2)
                if game.arrangement_plan(pending["player"], pending["rank"], cols)]
    if phase == "bonus":
        return [("bonus", a, b) for a, b in combinations(game.table_refs(), 2)]
    actions = [("swap", index) for index in game.targets()]
    if phase in ("choose", "drawn"):
        actions += [("flip", i) for i, slot in enumerate(game.players[game.current]) if not slot.visible]
    if phase in ("choose", "revealed") and (game.draw_pile or len(game.discard_pile) > 1):
        actions.append(("draw",))
    if phase == "revealed":
        actions.append(("end",))
    if phase in ("drawn", "drawn_revealed"):
        actions.append(("discard",))
    return actions


def play_action(game, action):
    kind, *args = action
    methods = {"swap": game.swap, "flip": game.reveal, "draw": game.draw,
               "end": game.end_turn, "discard": game.discard, "guess": game.submit_guess,
               "trade": game.guess_trade, "arrange": game.arrange_four, "bonus": game.bonus_swap}
    methods[kind](*args)
    game._public_targets = tuple(game.targets())


def copy_world(game):
    world = public_position(game)
    world.players = [[Slot(slot.card, slot.visible) for slot in hand] for hand in game.players]
    world.draw_pile = list(game.draw_pile)
    return world


def margin(game):
    # A positive margin favors the bot: low bot score, high human score.
    return game.score(0) - game.score(1)


class Search:
    """Two completed turns, at most six decisions, with sampled chance outcomes.

    Each future choice resamples from that player's public observation. It cannot
    select a move using the hidden cards in a particular imagined world.
    A beam and transition budget keep large bonus-swap trees responsive.
    """
    def __init__(self, samples=8, transitions=3200, beam=3, root_beam=8, max_seconds=None):
        self.samples = samples
        self.transitions = transitions
        self.beam = beam
        self.root_beam = root_beam
        self.max_seconds = max_seconds
        self.deadline = None

    def expired(self):
        return self.deadline is not None and monotonic() >= self.deadline

    def rank(self, game, budget, allowed=None):
        first = next(sample_positions(game, 1))
        actions = legal_actions(first)
        if allowed is not None:
            actions = [action for action in actions if action in allowed]
        if not actions:
            return []
        if budget[0] < len(actions):
            return []
        count = min(self.samples, max(1, budget[0] // len(actions)))
        worlds = list(sample_positions(game, count))
        if game.phase == "arrange":
            # A hidden, previously locked card can make a layout illegal. Do
            # not assume that a plan legal in one sampled world works in all.
            common = set.intersection(*(set(legal_actions(world)) for world in worlds))
            actions = [action for action in actions if action in common]
        ranked = []
        for action in actions:
            if self.expired():
                break
            children = []
            for world in worlds:
                child = copy_world(world)
                play_action(child, action)
                children.append(child)
            budget[0] -= count
            ranked.append((sum(map(margin, children)) / count, action, children))
        ranked.sort(key=lambda item: item[0], reverse=game.decision_player == 1)
        return ranked

    def value(self, game, turns, decisions, budget):
        if self.expired():
            return margin(game)
        if game.phase == "over":
            return margin(game)
        if turns <= 0 or decisions <= 0 or budget[0] <= 0:
            return sum(margin(world) for world in sample_positions(game, self.samples)) / self.samples
        ranked = self.rank(game, budget)
        if not ranked:
            return sum(margin(world) for world in sample_positions(game, self.samples)) / self.samples
        candidates = ranked[:self.beam]
        allowance = max(0, budget[0] // len(candidates))
        values = []
        for _, _, children in candidates:
            branch_budget = [allowance]
            values.append(self.outcomes(game, children, turns, decisions, branch_budget))
            budget[0] -= allowance - branch_budget[0]
        return (max if game.decision_player == 1 else min)(values)

    def outcomes(self, before, children, turns, decisions, budget):
        groups = {}
        for child in children:
            key = observation(child)
            if key in groups:
                groups[key][1] += 1
            else:
                groups[key] = [child, 1]
        allowance = max(0, budget[0] // len(groups))
        total = 0
        for child, weight in groups.values():
            branch_budget = [allowance]
            total += weight * self.value(child, turns - (child.turns - before.turns), decisions - 1, branch_budget)
            budget[0] -= allowance - branch_budget[0]
        return total / len(children)

    def choose(self, game):
        self.deadline = None if self.max_seconds is None else monotonic() + self.max_seconds
        position = public_position(game)
        budget = [self.transitions]
        allowed = game._root_actions if hasattr(game, "_root_actions") else set(legal_actions(game))
        ranked = self.rank(position, budget, allowed)
        if not ranked:
            return None
        candidates = ranked[:self.root_beam]
        values = []
        # Equal per-candidate budgets avoid giving an early move all the search.
        for immediate, action, children in candidates:
            if self.expired():
                # Finish comparing already ranked moves without more expansion.
                values.append((immediate, immediate, action))
                continue
            value = self.outcomes(position, children, 2, 6,
                                  [max(0, budget[0] // len(candidates))])
            values.append((value, immediate, action))
        choose = max if position.decision_player == 1 else min
        return choose(values, key=lambda item: (item[0], item[1]))[2]


def choose_action(game):
    return Search(max_seconds=1.0).choose(game)


def fallback_action(actions):
    """A fast, legal public-information move when search is busy or fails."""
    actions = list(actions)
    for kind in ("discard", "end", "arrange", "guess", "flip", "draw", "swap", "trade", "bonus"):
        for action in actions:
            if action[0] == kind:
                return action
    return None
