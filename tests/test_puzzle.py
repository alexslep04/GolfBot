from contextlib import ExitStack
from datetime import date, timedelta
import unittest
from unittest import mock

from fastapi.testclient import TestClient

import puzzle
from game import PUZZLE_MOVES, GolfGame, rules_from
from match_history import MatchHistory
from match_settings import HOUSE_KEYS, house_rules
from server import Store, create_app


def play_out(game, flip_every=0):
    """Finish a puzzle with simple moves: draw and discard, with a flip every so many
    actions if asked (Golfbot plays its own)."""
    moves = 0
    while game.phase != "over":
        if game.decision_player == 1:
            game.opponent_turn()
        elif game.phase == "choose":
            hidden = [i for i, slot in enumerate(game.players[0]) if not slot.visible]
            game.reveal(hidden[0]) if hidden and flip_every and moves % flip_every == 0 else game.draw()
        elif game.phase in ("drawn", "drawn_revealed"):
            game.discard()
        elif game.phase == "revealed":
            game.end_turn()
        elif game.phase == "bonus":
            game.bonus_swap(("discard", None), (0, 0))
        elif game.phase == "arrange":
            game.arrange_four(None)
        moves += 1
    return game


class PuzzleGameTests(unittest.TestCase):
    def test_a_day_deals_the_same_puzzle_every_time_and_days_differ(self):
        day = date(2026, 12, 1)
        spec = puzzle.candidates(day, 1)[0]
        first, second = puzzle.new_puzzle(spec), puzzle.new_puzzle(spec)
        self.assertEqual([s.card for s in first.players[0]], [s.card for s in second.players[0]])
        self.assertEqual(first.draw_pile, second.draw_pile)
        self.assertEqual([[s.card for s in hand] for hand in first.players], [[s.card for s in hand] for hand in second.players])
        self.assertEqual([[s.visible for s in hand] for hand in first.players], [[s.visible for s in hand] for hand in second.players])
        self.assertNotEqual(first.draw_pile, puzzle.new_puzzle(puzzle.candidates(date(2026, 12, 2), 1)[0]).draw_pile)
        self.assertEqual(puzzle.puzzle_number(puzzle.FIRST_DAY), 1)

    def test_a_hand_against_golfbot_two_cards_up_each_and_you_play_first(self):
        game = GolfGame(seed=3, rules=rules_from(house_rules()), puzzle=True)
        self.assertEqual((game.player_count, game.phase, game.current), (2, "choose", 0))
        self.assertEqual((game.visible_count(0), game.visible_count(1)), (2, 2))
        self.assertEqual(len(game.draw_pile), 52 - 13)

    def test_it_runs_a_set_number_of_moves_each_and_ends_with_golfbots_last(self):
        game = GolfGame(seed=11, rules=rules_from(house_rules()), puzzle=True)
        self.assertEqual(game.puzzle_moves_left, PUZZLE_MOVES)
        game = play_out(game)
        self.assertEqual((game.phase, game.turns, game.puzzle_moves_left), ("over", 2 * PUZZLE_MOVES, 0))
        self.assertTrue(all(slot.visible for hand in game.players for slot in hand))
        self.assertIsNone(GolfGame(seed=11).puzzle_moves_left)

    def test_turning_your_last_card_face_up_ends_it_at_once_whatever_moves_are_left(self):
        # a flip each turn: two cards start face up, so the fourth flip is the last card
        game = play_out(GolfGame(seed=11, puzzle=True), flip_every=1)
        self.assertEqual((game.phase, game.turns, game.puzzle_moves_left), ("over", 7, PUZZLE_MOVES - 3))
        self.assertTrue(all(slot.visible for hand in game.players for slot in hand))
        # the same by a swap into the last face-down place: PuzzleBot gets no reply
        game = GolfGame(seed=11, puzzle=True)
        for slot in game.players[0][:5]:
            slot.visible = True
        game.players[0][5].visible = False
        game.swap(5)
        self.assertEqual((game.phase, game.turns, game.puzzle_moves_left), ("over", 1, PUZZLE_MOVES))
        # five face up is not six: the hand goes on
        game = GolfGame(seed=11, puzzle=True)
        game.reveal(next(i for i, slot in enumerate(game.players[0]) if not slot.visible))
        game.end_turn()
        self.assertEqual((game.phase, game.current), ("choose", 1))

    def test_puzzlebot_turning_its_last_card_face_up_does_not_end_it(self):
        game = GolfGame(seed=11, puzzle=True)
        for slot in game.players[1]:
            slot.visible = True
        game.draw()
        game.discard()
        game.opponent_turn()
        self.assertEqual((game.phase, game.current, game.puzzle_moves_left), ("choose", 0, PUZZLE_MOVES - 1))

    def test_a_puzzle_may_set_its_own_moves_and_cards_face_up(self):
        for moves, face_up in ((3, 0), (7, 4)):
            game = GolfGame(seed=5, rules=rules_from(house_rules()), puzzle=True, puzzle_moves=moves, puzzle_face_up=face_up)
            self.assertEqual((game.visible_count(0), game.visible_count(1), game.puzzle_moves_left), (face_up, face_up, moves))
            game = play_out(game)
            self.assertEqual((game.phase, game.turns), ("over", 2 * moves))
        with self.assertRaises(ValueError):
            GolfGame(seed=5, puzzle=True, puzzle_moves=0)

    def test_a_row_the_last_reveal_completes_earns_its_angel_number(self):
        # (a puzzle ends on its moves, not by going out: the cards turned up at the end count in full)
        game = GolfGame(seed=5, rules=rules_from({"angel_numbers": True}), puzzle=True, puzzle_moves=1)
        sixes = [card for card in game.draw_pile if card.rank == 6][:3]
        game.draw_pile = [card for card in game.draw_pile if card not in sixes]
        for index, card in zip((3, 4, 5), sixes):
            game.players[0][index].card, game.players[0][index].visible = card, index == 3
        game.draw()
        game.discard()
        game.opponent_turn()
        self.assertEqual(game.phase, "over")
        self.assertIn(6, game.angels_earned[0])
        self.assertIn("angel_numbers", game.activated_rules[0])
        # (666: PuzzleBot's score six times what it would be)
        earned, game.angels_earned[0] = game.angels_earned[0], set()
        plain = game.score(1)
        game.angels_earned[0] = earned
        self.assertEqual(game.score(1), plain * 6)

    def test_the_deck_is_never_reshuffled(self):
        # (were it to run out, the hand would end there; the set moves end it long before)
        game = GolfGame(seed=11, rules=rules_from(house_rules()), puzzle=True)
        game.draw_pile = []
        with self.assertRaises(ValueError):
            game.draw()


class PuzzleMakingTests(unittest.TestCase):
    def test_every_theme_comes_round_and_never_two_days_running(self):
        days = [puzzle.FIRST_DAY + timedelta(days=i) for i in range(4 * len(puzzle.THEMES))]
        themes = [puzzle.theme_for(day).key for day in days]
        for start in range(0, len(themes), len(puzzle.THEMES)):
            self.assertEqual(set(themes[start:start + len(puzzle.THEMES)]), set(puzzle.BY_KEY))
        self.assertTrue(all(a != b for a, b in zip(themes, themes[1:])))
        # (the same day, the same theme: it is worked out, not remembered)
        self.assertEqual(puzzle.theme_for(days[20]), puzzle.theme_for(days[20]))

    def test_themes_mix_house_and_other_rules_and_twists_on_the_deal(self):
        self.assertTrue(any(theme.rules - HOUSE_KEYS for theme in puzzle.THEMES))
        self.assertTrue(any(0 in theme.face_up for theme in puzzle.THEMES))
        self.assertGreater(len({moves for theme in puzzle.THEMES for moves in theme.moves}), 2)
        for theme in puzzle.THEMES:
            self.assertLessEqual(theme.rules, puzzle.ALL_RULES)
            # (nobody goes out in a puzzle: Poisoned Card would never come into it as a theme)
            self.assertTrue("poisoned_card" not in theme.rules or theme.rules >= HOUSE_KEYS)

    def test_the_candidates_are_the_days_theme(self):
        day = date(2026, 12, 9)
        theme = puzzle.theme_for(day)
        options = puzzle.candidates(day, 5)
        self.assertEqual(len({option["seed"] for option in options}), 5)
        for option in options:
            # (the Jack and Queen swaps are in every puzzle)
            self.assertEqual((option["theme"], set(option["rules"])), (theme.key, set(theme.rules) | {"royal_pairs"}))
            self.assertIn(option["moves"], theme.moves)
            self.assertIn(option["face_up"], theme.face_up)
            game = puzzle.new_puzzle(option)
            self.assertEqual({key for key, _ in puzzle.RULE_OPTIONS if getattr(game.rules, key)}, set(theme.rules) | {"royal_pairs"})
            self.assertEqual(game.visible_count(0), option["face_up"])
        self.assertEqual(puzzle.candidates(day, 5), options)

    def test_the_deal_kept_rewards_thinking_ahead_and_brings_the_rules_in(self):
        day = date(2026, 12, 2)  # (Royal Court)
        rules = sorted(puzzle.theme_for(day).rules)
        flat = {"careful": 2, "greedy": 1, "fired": [], "bot_fired": [], "greedy_fired": []}
        deep = {"careful": 12, "greedy": -10, "fired": [], "bot_fired": [], "greedy_fired": []}
        royal = {"careful": 6, "greedy": 0, "fired": rules[:2], "bot_fired": [], "greedy_fired": []}
        easy = {"careful": 30, "greedy": 25, "fired": [], "bot_fired": [], "greedy_fired": []}
        canned = [flat, None, deep, easy, royal]
        spec = puzzle.generate(day, 5, evaluate_with=lambda _, options: canned[:len(options)])
        # (the theme's rules in your hand count for more than thinking ahead alone)
        self.assertEqual(spec["metrics"], royal)
        self.assertEqual(spec["seed"], puzzle.candidates(day, 5)[4]["seed"])
        self.assertGreater(puzzle.fun(puzzle.candidates(day, 1)[0], deep), puzzle.fun(puzzle.candidates(day, 1)[0], flat))
        option = puzzle.candidates(day, 1)[0]
        self.assertGreater(puzzle.fun(option, royal), puzzle.fun(option, flat))
        self.assertGreater(puzzle.fun(option, flat), puzzle.fun(option, easy))
        # (one candidate: taken as it is, nothing played out)
        self.assertIsNone(puzzle.generate(day, 1)["metrics"])

    def test_a_deal_is_played_out_both_ways(self):
        spec = {**puzzle.candidates(date(2026, 12, 1), 1)[0], "moves": 2}
        metrics = puzzle.evaluate(spec)
        self.assertEqual(set(metrics), {"careful", "greedy", "fired", "bot_fired", "greedy_fired"})
        self.assertTrue(all(isinstance(metrics[key], int) for key in ("careful", "greedy")))

    def test_a_days_puzzle_is_kept_once_made(self):
        scores = puzzle.PuzzleScores(MatchHistory())
        day = date(2026, 12, 1)
        self.assertIsNone(scores.saved_spec(day))
        made = puzzle.generate(day, 1)
        self.assertEqual(scores.save_spec(day, made), made)
        # (the first kept stands)
        self.assertEqual(scores.save_spec(day, {**made, "seed": 1}), made)


class PuzzleScoreTests(unittest.TestCase):
    def test_best_margins_rank_biggest_first_and_attempts_add_up(self):
        scores = puzzle.PuzzleScores(MatchHistory())
        day = date(2026, 12, 1)
        scores.attempt(day, "a", "Ann", "dog")
        self.assertTrue(scores.finish(day, "a", "Ann", "dog", -4, now=1))
        scores.attempt(day, "a", "Ann", "dog")
        self.assertFalse(scores.finish(day, "a", "Ann", "dog", -7, now=2))
        self.assertTrue(scores.finish(day, "b", "Bo", "cat", 12, now=3))
        self.assertEqual([(row["name"], row["score"]) for row in scores.board(day)], [("Bo", 12), ("Ann", -4)])
        self.assertEqual(scores.mine(day, "a"), {"best": -4, "attempts": 2, "rank": 2})
        self.assertEqual(scores.mine(day, "nobody"), {"best": None, "attempts": 0, "rank": None})
        self.assertEqual(scores.board(date(2026, 12, 2)), [])
        # PuzzleBot's record: every attempt against it, all time and today, and by how many players
        scores.attempt(date(2026, 12, 2), "a", "Ann", "dog")
        self.assertEqual(scores.totals(day), {"attempts": 4, "players": 2, "today": 3})
        self.assertEqual(scores.totals(date(2026, 12, 2))["today"], 1)


class PuzzleServerTests(unittest.TestCase):
    def setUp(self):
        # (a House rules day: its theme decides what the hand below has to deal with)
        patcher = mock.patch.object(puzzle, 'today', return_value=date(2026, 12, 4))
        patcher.start()
        self.addCleanup(patcher.stop)
        self.store = Store()
        self.app = create_app(self.store)
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        self.client = self.context.enter_context(TestClient(self.app))
        self.client.get('/api/session')

    def act(self, state, action, **extra):
        response = self.client.post(f"/api/lobbies/{state['id']}/action",
                                    json={'action': action, 'version': state['version'], **extra})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_play_a_puzzle_to_the_end_then_try_again_on_the_same_deal(self):
        info = self.client.get('/api/puzzle').json()
        self.assertEqual((info['attempts'], info['best'], info['board']), (0, None, []))
        state = self.client.post('/api/puzzle').json()
        self.assertEqual((len(state['game']['players']), state['names'][1]), (2, 'PuzzleBot'))
        self.assertEqual(state['puzzle']['number'], info['number'])
        # the score preview is off: nothing to peek at before confirming
        self.assertFalse(state['score_preview'])
        self.assertEqual(state['game']['near_rules'], [])
        start = [slot['card'] for slot in state['game']['players'][0]]
        self.assertEqual([slot['card'] for slot in info['hand']], start)
        state = self.act(state, 'draw')
        preview = self.client.post(f"/api/lobbies/{state['id']}/preview",
                                   json={'action': 'discard', 'version': state['version']})
        self.assertEqual(preview.status_code, 403)
        room = self.store.rooms[state['id']]
        while state['status'] == 'playing':
            game = state['game']
            if room.game.decision_player == 1:
                # (Golfbot's turns: its own task does not run between a test's requests)
                room.game.opponent_turn()
                room.record_result()
                room.version += 1
                state = self.client.get(f"/api/lobbies/{state['id']}/state").json()
            elif game['legal']['discard']:
                state = self.act(state, 'discard')
            elif game['legal']['bonus']:
                state = self.act(state, 'swap', refs=[['discard', None], [0, 0]])
            elif game['legal']['keep_layout']:
                state = self.act(state, 'arrange')
            elif game['legal']['flip']:
                state = self.act(state, 'flip', index=game['legal']['flip'][0])
            elif game['legal']['end_turn']:
                state = self.act(state, 'end_turn')
            else:
                state = self.act(state, 'draw')
        self.assertEqual(state['status'], 'finished')
        last = state['puzzle']['last']
        score = last['score']
        self.assertEqual((score, last['bot']), (room.game.score(0), room.game.score(1)))
        self.assertEqual(last['won'], score < last['bot'])
        margin = last['bot'] - score
        self.assertEqual(last['margin'], margin)
        # no streak, no saved match: the puzzle is its own thing
        self.assertIsNone(state['streak'])
        self.assertEqual(self.client.get('/api/history?mine=true').json()['matches'], [])
        self.assertTrue(state['puzzle']['last']['new_best'])
        self.assertEqual(state['puzzle']['best'], margin)
        info = self.client.get('/api/puzzle').json()
        self.assertEqual((info['best'], info['rank'], info['attempts']), (margin, 1, 1))
        self.assertTrue(info['board'][0]['mine'])
        # (a guest's row opens their profile too, named as they played)
        self.assertTrue(info['board'][0]['id'].startswith('browser:'))
        profile = self.client.get('/api/profile', params={'player': info['board'][0]['id']}).json()
        self.assertEqual(profile['label'], info['board'][0]['name'])
        # unlimited attempts, the same cards each time
        again = self.act(state, 'retry')
        self.assertEqual(again['status'], 'playing')
        self.assertEqual([slot['card'] for slot in again['game']['players'][0]], start)
        self.assertEqual(self.client.get('/api/puzzle').json()['attempts'], 2)
        # a puzzle is not on the Spectate list, and leaving just puts it away
        self.assertEqual(self.client.get('/api/spectate').json(), [])
        self.assertEqual(self.client.post(f"/api/lobbies/{state['id']}/leave").status_code, 200)
        self.assertNotIn(state['id'], self.store.rooms)


class PuzzleRowTests(unittest.TestCase):
    def test_a_rows_mmr_shows_once_its_player_has_played_ranked(self):
        from server import puzzle_rows

        class Ratings:
            def ratings(self, player):
                played = player != 'browser:new'
                return {'series': {'rating': 1100, 'provisional': player == 'browser:fresh',
                                   'wins': int(played), 'draws': 0, 'losses': 0}}

        board = [{'player': player, 'name': 'X', 'avatar': None, 'score': 1, 'attempts': 1}
                 for player in ('account:a', 'browser:fresh', 'browser:new')]
        rows = puzzle_rows(board, 'account:a', progression=Ratings())
        self.assertEqual([(row['id'], row.get('mmr'), row.get('provisional')) for row in rows],
                         [('account:a', 1100, False), ('browser:fresh', 1100, True), ('browser:new', None, None)])
        self.assertTrue(rows[0]['mine'])
