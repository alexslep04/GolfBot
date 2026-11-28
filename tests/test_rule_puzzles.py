"""Rule puzzles: one move, one rule, judged on the score a move gives on average."""
import random
import time
import unittest
from contextlib import ExitStack

from fastapi.testclient import TestClient

import rule_puzzles as rp
from match_history import MatchHistory
from server import Store, create_app

S, H, D, C = "SHDC"


def deal(rule, hand, up, discard, opp=None, deck=None):
    """A table set out by hand: the rest of the pack is PuzzleBot's hand and the go-fish pile."""
    used = set(hand) | {discard}
    rest = [card for card in rp.DECK if card not in used]
    opp = opp or rest[:6]
    deck = deck or [card for card in rest if card not in opp]
    return {"rule": rule, "hand": list(hand), "up": list(up), "opp": list(opp), "discard": discard, "deck": list(deck), "seed": 1}


class ScoringTests(unittest.TestCase):
    def test_the_solvers_scores_are_the_games_scores(self):
        rng = random.Random(4)
        for rule in rp.RULES + (None,):
            for n in range(600):
                deck = list(rp.DECK)
                rng.shuffle(deck)
                if n % 2:  # (hands the rules bite on: few ranks, few suits)
                    ranks, suits = rng.sample(range(1, 14), 4), rng.sample("SHDC", 2)
                    head = [card for card in deck if card[0] in ranks or card[1] in suits][:14]
                    rng.shuffle(head)
                    deck = head + [card for card in deck if card not in head]
                hand, opp = deck[:6], deck[6:12]
                if not rp._quiet(opp, rule or ""):
                    continue
                game = rp.new_game(deal(rule or "none", hand, range(6), deck[12], opp))
                game._update_combos()
                self.assertEqual(rp.hand_score(hand, rule), game.score(0), (rule, hand))

    def test_an_angel_number_earned_on_a_flip_stays_when_the_card_goes(self):
        hand = [(7, S), (7, H), (2, C), (13, S), (13, H), (3, D)]
        self.assertEqual(rp.hand_score(hand, "angel_numbers"), 15)
        self.assertEqual(rp.hand_score(hand, "angel_numbers", (7,)), 3)  # 15 / 7, rounded up
        hand[2] = (9, C)
        self.assertEqual(rp.hand_score(hand, "angel_numbers", (7,)), 4)  # 26 / 7, rounded up


class GameTests(unittest.TestCase):
    def test_a_rule_puzzle_is_one_move_of_yours_and_none_of_puzzlebots(self):
        spec = deal("king_queen", [(13, S), (4, H), (9, D), (8, C), (6, S), (5, H)], [0, 3], (12, C))
        game = rp.new_game(spec)
        self.assertEqual((game.phase, game.decision_player, game.visible_count(0), game.visible_count(1)), ("choose", 0, 2, 6))
        self.assertTrue(game.rules.king_queen and not game.rules.royal_pairs)
        self.assertIsNone(game.puzzle_moves_left)
        game.swap(3)  # the Queen of clubs under the King of spades: 5 for the column
        self.assertEqual((game.phase, game.turns), ("over", 1))
        self.assertTrue(all(slot.visible for slot in game.players[0]))
        self.assertEqual(game.score(0), 5 + 4 + 6 + 9 + 5)

    def test_going_fish_and_flipping_are_moves_too(self):
        spec = deal("holdem", [(13, S), (4, H), (9, D), (8, C), (6, S), (5, H)], [0, 3], (12, C))
        game = rp.new_game(spec)
        game.draw()
        game.reveal(1)
        self.assertEqual(game.phase, "drawn_revealed")
        game.discard()
        self.assertEqual(game.phase, "over")

    def test_a_pair_of_jacks_earns_your_swap_but_never_puzzlebots(self):
        opp = [(11, H), (2, S), (3, S), (11, D), (4, S), (6, C)]  # (a Jack-Jack column of its own)
        spec = deal("royal_pairs", [(11, S), (4, H), (9, D), (8, C), (6, S), (5, H)], range(6), (11, C), opp)
        game = rp.new_game(spec)
        game.swap(3)
        self.assertEqual((game.phase, game.decision_player, game.bonus_remaining), ("bonus", 0, 1))
        game.bonus_swap((0, 2), (1, 1))  # your 9 for its 2
        self.assertEqual(game.phase, "over")
        self.assertEqual(game.score(0), 4 + 6 - 2 + 5)


class SolverTests(unittest.TestCase):
    def test_with_every_card_face_up_a_move_is_worth_exactly_its_score(self):
        hand = [(7, S), (7, H), (10, C), (13, S), (3, H), (2, D)]
        solver = rp.solver_for(deal("angel_numbers", hand, range(6), (7, C)))
        root = solver.root()
        # the third 7 makes 777: (7+0) + (7+3) + (7-2) = 22, divided by 7 and rounded up
        self.assertEqual(root[("swap", 2)], 4)
        self.assertEqual(root[("swap", 0)], rp.hand_score([(7, C)] + hand[1:], "angel_numbers"))
        self.assertEqual(min(root, key=root.get), ("swap", 2))
        # going fish is the average over every unseen card of the best that can be done with it
        draws = [min([rp.hand_score(hand, "angel_numbers")] + [rp.hand_score(hand[:i] + [card] + hand[i + 1:], "angel_numbers")
                                                              for i in range(6)]) for card in solver.unseen]
        self.assertAlmostEqual(root[("draw",)], sum(draws) / len(draws))

    def test_a_hidden_card_is_any_unseen_card_never_the_one_dealt(self):
        hand = [(13, S), (13, H), (10, C), (4, S), (3, H), (2, D)]
        first = rp.solver_for(deal("holdem", hand, [0, 1, 2, 3, 4], (9, C))).root()
        hand[5] = (12, D)  # (the same table to look at: only the face-down card differs)
        second = rp.solver_for(deal("holdem", hand, [0, 1, 2, 3, 4], (9, C), opp=[c for c in rp.DECK if c not in set(hand) | {(9, C), (2, D)}][:6])).root()
        self.assertEqual(set(first), set(second))
        self.assertIn(("flip", 5), first)

    def test_flipping_first_is_never_worse_than_swapping_blind(self):
        hand = [(13, S), (9, H), (10, C), (4, S), (3, H), (2, D)]
        root = rp.solver_for(deal("roman_fives", hand, [0, 1, 3], (5, C))).root()
        for slot in (2, 4, 5):
            self.assertLessEqual(root[("flip", slot)], root[("swap", slot)] + 1e-9)

    def test_the_worst_play_is_no_better_than_the_best(self):
        solver = rp.solver_for(deal("suited_rows", [(13, S), (9, S), (10, C), (4, S), (3, H), (2, D)], [0, 1, 3], (5, S)))
        self.assertGreater(max(solver.root(max).values()), min(solver.root().values()))

    def test_a_jack_pair_is_worth_the_best_swap_it_earns(self):
        opp = [(2, H), (9, S), (3, S), (9, D), (12, S), (7, C)]
        hand = [(11, S), (4, H), (10, D), (8, C), (6, S), (5, H)]
        solver = rp.solver_for(deal("royal_pairs", hand, range(6), (11, C), opp))
        root = solver.root()
        # the Jack under the Jack, then your 10 for PuzzleBot's 2: (0) + (4+6) + (-2+5)
        self.assertEqual(root[("swap", 3)], 13)
        self.assertEqual(min(root, key=root.get), ("swap", 3))
        game = rp.new_game(deal("royal_pairs", hand, range(6), (11, C), opp))
        game.swap(3)
        node, options = solver.options(game)
        self.assertEqual(node, "bonus")
        self.assertEqual(options[rp.action_key("swap", refs=[(1, 0), (0, 2)])], 13)
        self.assertEqual(rp.action_key("swap", refs=[(1, 0), (1, 2)]), ("pass",))


class PuzzleTests(unittest.TestCase):
    def test_a_puzzle_made_has_one_best_move_that_its_rule_makes(self):
        for rule in rp.RULES:
            puzzle = rp.generate(rule, seed=11, samples=60)
            self.assertIsNotNone(puzzle, rule)
            self.assertEqual(puzzle["rule"], rule)
            self.assertGreaterEqual(len(puzzle["up"]), 2)
            self.assertEqual(len(set(puzzle["hand"]) | set(puzzle["opp"]) | {puzzle["discard"]} | set(puzzle["deck"])), 52)
            rest = [value for value in puzzle["root"].values() if value > puzzle["best_value"] + rp.TOLERANCE]
            self.assertGreaterEqual(min(rest) - puzzle["best_value"], rp.MIN_GAP)
            self.assertGreater(puzzle["worst_value"], puzzle["best_value"])
            self.assertEqual(rp.generate(rule, seed=11, samples=60)["hand"], puzzle["hand"])  # (the same seed, the same puzzle)

    def test_a_puzzle_is_correct_only_with_no_points_given_up_on_average(self):
        spec = {"best_value": 4.0, "worst_value": 24.0}
        self.assertEqual(rp.grade(spec, [{"loss": 0.0}, {"loss": 0.01}])["accuracy"], 100.0)
        self.assertTrue(rp.grade(spec, [{"loss": 0.0}])["best"])
        # (right or not: a move that gave points up is not correct, however few)
        off = rp.grade(spec, [{"loss": 6.0}, {"loss": 4.0}])
        self.assertEqual((off["accuracy"], off["best"], off["loss"], off["expected"]), (0.0, False, 10.0, 14.0))
        self.assertEqual(rp.grade(spec, [{"loss": 0.5}])["accuracy"], 0.0)

    def test_accuracy_is_kept_for_all_time_and_for_the_last_seven_days(self):
        results = rp.PuzzleResults(MatchHistory(":memory:"))
        now = time.time()
        self.assertEqual(results.stats("me", now)["all"], {"accuracy": None, "puzzles": 0, "best": 0})
        results.record("me", "holdem", 0.0, False, 3.0, now - 8 * 24 * 3600)
        results.record("me", "v10", 100.0, True, 0.0, now - 3600)
        results.record("me", "v10", 0.0, False, 1.0, now)
        results.record("you", "v10", 0.0, False, 9.0, now)
        stats = results.stats("me", now)
        self.assertEqual(stats["all"], {"accuracy": 33.3, "puzzles": 3, "best": 1})
        self.assertEqual(stats["week"], {"accuracy": 50.0, "puzzles": 2, "best": 1})


class TableTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        self.client = self.context.enter_context(TestClient(create_app(self.store, google_client_id='')))
        self.client.get('/api/session').raise_for_status()

    def play(self, state, action, **extra):
        reply = self.client.post(f"/api/lobbies/{state['id']}/action", json={"action": action, "version": state["version"], **extra})
        reply.raise_for_status()
        return reply.json()

    def test_a_puzzle_is_dealt_played_marked_and_followed_by_the_next(self):
        state = self.client.post('/api/rule-puzzle').json()
        puzzle, game = state["puzzle"], state["game"]
        self.assertEqual((puzzle["kind"], puzzle["count"], puzzle["last"]), ("move", 1, None))
        self.assertIn(puzzle["rule"], rp.RULES)
        self.assertEqual(sum(slot["visible"] for slot in game["players"][0]), puzzle["face_up"])
        self.assertTrue(all(slot["visible"] for slot in game["players"][1]))
        self.assertEqual([key for key, on in state["rules"].items() if on is True], [puzzle["rule"]])
        room = self.store.rooms[state["id"]]
        best = room.puzzle["spec"]["best"][0]
        # the best first move, then the best at each point after it
        while state["game"]["phase"] != "over":
            node, options = room.puzzle["solver"].options(room.game)
            move = min(options, key=options.get)
            if move[0] == "bonus":
                state = self.play(state, "swap", refs=[list(ref) for ref in move[1]])
            elif move[0] == "pass":
                state = self.play(state, "swap", refs=[[1, 0], [1, 1]])
            else:
                state = self.play(state, {"end": "end_turn"}.get(move[0], move[0]), **({"index": move[1]} if len(move) > 1 else {}))
        last = state["puzzle"]["last"]
        self.assertEqual((state["status"], last["best"], last["accuracy"], last["loss"]), ("finished", True, 100.0, 0.0))
        self.assertEqual(last["stats"]["all"], {"accuracy": 100.0, "puzzles": 1, "best": 1})
        self.assertEqual(last["stats"]["week"]["puzzles"], 1)
        self.assertIsNone(last["better"])
        self.assertTrue(last["played"])
        self.assertIn(best, room.puzzle["spec"]["best"])
        self.assertEqual(self.client.get('/api/rule-puzzle').json()["all"]["puzzles"], 1)
        # the next one, at the same table
        after = self.client.post('/api/rule-puzzle').json()
        self.assertEqual((after["id"], after["puzzle"]["count"], after["status"], after["puzzle"]["last"]), (state["id"], 2, "playing", None))
        # (a rule puzzle is not tried again: each is played once)
        retry = self.client.post(f"/api/lobbies/{after['id']}/action", json={"action": "retry", "version": after["version"]})
        self.assertEqual(retry.status_code, 409)

    def test_a_poor_move_is_marked_down_and_told_what_was_better(self):
        state = self.client.post('/api/rule-puzzle').json()
        room = self.store.rooms[state["id"]]
        spec = room.puzzle["spec"]
        worst = max((move for move in spec["root"] if move[0] == "swap"), key=spec["root"].get)
        state = self.play(state, "swap", index=worst[1])
        while state["game"]["phase"] != "over":  # (a pair it happened to make: any swap ends it)
            state = self.play(state, "swap", refs=[[1, 0], [1, 1]])
        last = state["puzzle"]["last"]
        self.assertFalse(last["best"])
        self.assertEqual(last["accuracy"], 0.0)
        self.assertGreater(last["loss"], rp.MIN_GAP - 0.01)
        self.assertTrue(last["better"])
        self.assertEqual(last["stats"]["all"]["best"], 0)

    def test_leaving_a_puzzle_puts_it_away(self):
        state = self.client.post('/api/rule-puzzle').json()
        self.client.post(f"/api/lobbies/{state['id']}/leave").raise_for_status()
        self.assertNotIn(state["id"], self.store.rooms)
        self.assertEqual(self.client.get('/api/rule-puzzle').json()["all"]["puzzles"], 0)


if __name__ == '__main__':
    unittest.main()
