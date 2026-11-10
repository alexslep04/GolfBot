"""Lookahead tactics, information boundaries, and legal search transitions."""
from copy import deepcopy
import random
import unittest

from bot import Search, legal_actions, play_action, public_position, sample_positions
from game import Card, GolfGame, Rules, Slot


def hand(ranks, suits="SHDCHS"):
    return [Slot(Card(rank, suit), True) for rank, suit in zip(ranks, suits)]


class BotTests(unittest.TestCase):
    def start(self, seed=6, rules=None):
        game = GolfGame(seed, rules, multiplayer=True, first_player=1)
        for player in (0, 1):
            game.opening_reveal(player, 0)
            game.opening_reveal(player, 1)
        return game

    def test_lookahead_avoids_feeding_the_humans_column_pair(self):
        game = self.start()
        game.phase = "drawn"
        game.held_card = Card(13, "D")
        game.players = [hand([10, 3, 4, 5, 3, 4]), hand([10, 9, 13, 1, 2, 13], "CDSHDC")]
        game.discard_pile = [Card(8, "H")]
        # Greedily removing the 10 saves one more point immediately, but gives
        # the player a pair. Removing the 9 produces a better final difference.
        baseline = deepcopy(game)
        baseline._opponent_step()
        self.assertEqual(baseline.discard_pile[-1].rank, 10)
        self.assertEqual(Search().choose(game), ("swap", 1))

    def test_preserves_a_divisor_instead_of_only_reducing_column_points(self):
        game = self.start(rules=Rules(v10=True))
        game.phase, game.is_final_turn = "drawn", True
        game.held_card = Card(13, "D")
        game.players[1] = hand([10, 5, 11, 12, 12, 2])
        baseline = deepcopy(game)
        baseline._opponent_step()
        self.assertEqual(baseline.players[1][0].card.rank, 13)
        action = Search().choose(game)
        self.assertEqual(action, ("swap", 3))
        play_action(game, action)
        self.assertEqual(game.phase, "over")
        self.assertLess(game.score(1), baseline.score(1))

    def test_search_cannot_read_unknown_cards_or_change_the_deal(self):
        game = self.start()
        before = deepcopy(game.__dict__)
        rng_state = game.rng.getstate()
        policy = Search(samples=4, transitions=800)
        action = policy.choose(game)
        self.assertEqual(game.rng.getstate(), rng_state)
        for key in before:
            if key != "rng":
                self.assertEqual(game.__dict__[key], before[key], key)
        observation = public_position(game)
        self.assertTrue(all(slot.card is None for layout in observation.players for slot in layout if not slot.visible))
        self.assertTrue(all(card is None for card in observation.draw_pile))
        # Redeal every unknown location and change the engine RNG. Publicly
        # identical positions must receive exactly the same recommendation.
        hidden = [slot for layout in game.players for slot in layout if not slot.visible]
        cards = [slot.card for slot in hidden] + game.draw_pile
        for seed in range(3):
            random.Random(seed).shuffle(cards)
            for slot, card in zip(hidden, cards):
                slot.card = card
            game.draw_pile = cards[len(hidden):]
            game.rng.seed(seed + 99)
            self.assertEqual(policy.choose(game), action)

    def test_final_reveal_search_preserves_the_pending_players_queue(self):
        game = self.start()
        for layout in game.players:
            for slot in layout:
                slot.visible = True
        game.phase, game.current = 'bonus', 1
        game.scoring_reveal, game.bonus_remaining, game.final_bonus_queue = True, 1, [0]
        observed = public_position(game)
        self.assertIsNot(observed.final_bonus_queue, game.final_bonus_queue)
        action = Search(samples=1, transitions=200).choose(game)
        self.assertEqual(game.final_bonus_queue, [0])
        self.assertIn(action, legal_actions(game))
        play_action(game, action)
        self.assertEqual((game.current, game.phase), (0, 'bonus'))

    def test_samples_keep_public_cards_and_conserve_the_deck(self):
        game = self.start()
        for world in sample_positions(game, 12):
            cards = [slot.card for layout in world.players for slot in layout] + world.draw_pile + world.discard_pile
            self.assertEqual(len(cards), 52)
            self.assertEqual(len(set(cards)), 52)
            for before, after in zip(game.players, world.players):
                self.assertEqual([s.card for s in before if s.visible], [s.card for s in after if s.visible])

    def test_publicly_blocked_hidden_lock_remains_ineligible(self):
        game = self.start(rules=Rules(devils_row=True))
        locked = game.players[1][3].card
        game.locked_cards.add(locked)
        game.players[1][3].visible = False
        for world in sample_positions(game, 8):
            self.assertNotIn(3, world.targets())
        action = Search(samples=4, transitions=700).choose(game)
        self.assertNotEqual(action, ("swap", 3))
        play_action(game, action)

    def test_search_handles_special_decisions_and_refill(self):
        game = self.start(rules=Rules(**dict.fromkeys(Rules.__dataclass_fields__, True)))
        game.phase, game.bonus_remaining = "bonus", 1
        action = Search(samples=3, transitions=500).choose(game)
        self.assertIn(action, legal_actions(game))
        play_action(game, action)
        game = self.start()
        game.draw_pile = []
        game.discard_pile += [Card(8, "D"), Card(9, "D")]
        play_action(game, ("draw",))
        self.assertIsNotNone(game.held_card)
        self.assertIn(Search(samples=3, transitions=500).choose(game), legal_actions(game))

    def test_four_kind_search_preserves_a_hidden_retained_lock(self):
        game = self.start(rules=Rules(four_kind=True, devils_row=True))
        game.players[1] = hand([9, 9, 1, 9, 9, 6], "SHSCDH")
        game.players[1][5].visible = False
        game.locked_cards = {game.players[1][5].card}
        game.phase, game.flipped = "arrange", 0
        game.arrange_pending = {"player": 1, "rank": 9, "resume": "revealed", "finish": False}
        allowed = legal_actions(game)
        self.assertNotIn(("arrange", (0, 2)), allowed)
        observation = public_position(game)
        observation._root_actions = set(allowed)
        action = Search(samples=4, transitions=700).choose(observation)
        self.assertIn(action, allowed)
        play_action(game, action)
        self.assertEqual(game.players[1][5].card, Card(6, "H"))

    def test_all_rule_search_smoke_games_preserve_cards_and_legality(self):
        policy = Search(samples=3, transitions=350, beam=2, root_beam=4)
        phases = set()
        for seed in range(4):
            game = self.start(seed, Rules(**dict.fromkeys(Rules.__dataclass_fields__, True)))
            for _ in range(120):
                if game.phase == "over":
                    break
                phases.add(game.phase)
                action = policy.choose(game)
                self.assertIn(action, legal_actions(game), (seed, game.phase, action))
                play_action(game, action)
                cards = [slot.card for layout in game.players for slot in layout] + game.draw_pile + game.discard_pile
                if game.held_card:
                    cards.append(game.held_card)
                self.assertEqual(len(cards), 52)
                self.assertEqual(len(set(cards)), 52)
            self.assertEqual(game.phase, "over", seed)
        self.assertIn("choose", phases)
        self.assertIn("drawn", phases)
