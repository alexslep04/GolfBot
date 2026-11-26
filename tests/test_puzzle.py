from contextlib import ExitStack
from datetime import date
import unittest

from fastapi.testclient import TestClient

import puzzle
from game import GolfGame, rules_from
from match_history import MatchHistory
from match_settings import house_rules
from server import Store, create_app


def play_out(game, flip_every=3):
    """Finish a puzzle with simple moves: flip now and then, otherwise draw and discard (Golfbot plays its own)."""
    moves = 0
    while game.phase != "over":
        if game.decision_player == 1:
            game.opponent_turn()
        elif game.phase == "choose":
            hidden = [i for i, slot in enumerate(game.players[0]) if not slot.visible]
            game.reveal(hidden[0]) if hidden and moves % flip_every == 0 else game.draw()
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
        first, second = puzzle.new_puzzle(day), puzzle.new_puzzle(day)
        self.assertEqual([s.card for s in first.players[0]], [s.card for s in second.players[0]])
        self.assertEqual(first.draw_pile, second.draw_pile)
        self.assertEqual([[s.card for s in hand] for hand in first.players], [[s.card for s in hand] for hand in second.players])
        self.assertEqual([[s.visible for s in hand] for hand in first.players], [[s.visible for s in hand] for hand in second.players])
        self.assertNotEqual(first.draw_pile, puzzle.new_puzzle(date(2026, 12, 2)).draw_pile)
        self.assertEqual(puzzle.puzzle_number(puzzle.FIRST_DAY), 1)

    def test_a_hand_against_golfbot_two_cards_up_each_and_you_play_first(self):
        game = GolfGame(seed=3, rules=rules_from(house_rules()), puzzle=True)
        self.assertEqual((game.player_count, game.phase, game.current), (2, "choose", 0))
        self.assertEqual((game.visible_count(0), game.visible_count(1)), (2, 2))
        self.assertEqual(len(game.draw_pile), 52 - 13)

    def test_it_ends_as_a_hand_does_once_someone_has_every_card_up_and_the_other_has_had_a_last_turn(self):
        game = play_out(GolfGame(seed=11, rules=rules_from(house_rules()), puzzle=True), flip_every=1)
        self.assertEqual(game.phase, "over")
        self.assertTrue(all(slot.visible for hand in game.players for slot in hand))

    def test_the_deck_is_never_reshuffled(self):
        # (were it to run out, the hand would end there; Golfbot finishes long before)
        game = GolfGame(seed=11, rules=rules_from(house_rules()), puzzle=True)
        game.draw_pile = []
        with self.assertRaises(ValueError):
            game.draw()


class PuzzleScoreTests(unittest.TestCase):
    def test_best_scores_rank_lowest_first_and_attempts_add_up(self):
        scores = puzzle.PuzzleScores(MatchHistory())
        day = date(2026, 12, 1)
        scores.attempt(day, "a", "Ann", "dog")
        self.assertTrue(scores.finish(day, "a", "Ann", "dog", 12, now=1))
        scores.attempt(day, "a", "Ann", "dog")
        self.assertFalse(scores.finish(day, "a", "Ann", "dog", 15, now=2))
        self.assertTrue(scores.finish(day, "b", "Bo", "cat", -4, now=3))
        self.assertEqual([(row["name"], row["score"]) for row in scores.board(day)], [("Bo", -4), ("Ann", 12)])
        self.assertEqual(scores.mine(day, "a"), {"best": 12, "attempts": 2, "rank": 2})
        self.assertEqual(scores.mine(day, "nobody"), {"best": None, "attempts": 0, "rank": None})
        self.assertEqual(scores.board(date(2026, 12, 2)), [])


class PuzzleServerTests(unittest.TestCase):
    def setUp(self):
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
        self.assertEqual((len(state['game']['players']), state['names'][1]), (2, 'Golfbot'))
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
        # no streak, no saved match: the puzzle is its own thing
        self.assertIsNone(state['streak'])
        self.assertEqual(self.client.get('/api/history?mine=true').json()['matches'], [])
        self.assertTrue(state['puzzle']['last']['new_best'])
        self.assertEqual(state['puzzle']['best'], score)
        info = self.client.get('/api/puzzle').json()
        self.assertEqual((info['best'], info['rank'], info['attempts']), (score, 1, 1))
        self.assertTrue(info['board'][0]['mine'])
        # unlimited attempts, the same cards each time
        again = self.act(state, 'retry')
        self.assertEqual(again['status'], 'playing')
        self.assertEqual([slot['card'] for slot in again['game']['players'][0]], start)
        self.assertEqual(self.client.get('/api/puzzle').json()['attempts'], 2)
        # a puzzle is not on the Spectate list, and leaving just puts it away
        self.assertEqual(self.client.get('/api/spectate').json(), [])
        self.assertEqual(self.client.post(f"/api/lobbies/{state['id']}/leave").status_code, 200)
        self.assertNotIn(state['id'], self.store.rooms)
