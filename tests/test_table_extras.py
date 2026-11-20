"""Emote counting, saved solo runs and House rules, account settings, and the newer records."""
import unittest
from dataclasses import replace
from unittest.mock import patch

from fastapi.testclient import TestClient

from accounts import ACCOUNT_COOKIE
from match_settings import HOUSE_VERSION
from records import build_records
from server import Store, create_app


class TableExtrasTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.client = TestClient(create_app(self.store))
        self.client.get('/api/session')
        self.addCleanup(self.client.close)

    def rated(self):
        other = TestClient(self.client.app)
        self.addCleanup(other.close)
        other.get('/api/session')
        self.client.post('/api/queue/join', json={'username': 'One'})
        other.post('/api/queue/join', json={'username': 'Two'})
        offer = self.client.post('/api/presence', json={'username': 'One'}).json()['queue']['id']
        self.client.post(f'/api/queue/offers/{offer}/respond', json={'accept': True})
        result = other.post(f'/api/queue/offers/{offer}/respond', json={'accept': True}).json()
        return other, self.store.rooms[result['room_id']]

    def finish_game(self, room, scores):
        room.game.phase = 'over'
        with patch.object(room.game, 'score', side_effect=lambda seat: scores[seat]):
            room.record_result()

    def board(self, room):
        rows = {row['id']: row for row in self.store.progression.leaderboard(combine_guests=False)['pvp']}
        return [rows[player['id']] for player in room.progression_players]

    def test_emotes_are_counted_per_player_for_the_biggest_yapper(self):
        other, room = self.rated()
        url = f'/api/lobbies/{room.id}/emote'
        for client, count in ((self.client, 2), (other, 1)):
            for _ in range(count):
                client.post(url, json={'emote': 'wow'}).raise_for_status()
        self.finish_game(room, [1, 2])
        self.assertEqual(room.history[-1]['emotes'], [2, 1])
        # one sent after the game ended still counts, once the table is saved
        other.post(url, json={'emote': 'thanks'}).raise_for_status()
        other.post(url, json={'emote': 'thanks'}).raise_for_status()
        other.post(url, json={'emote': 'thanks'}).raise_for_status()
        other.post(f'/api/lobbies/{room.id}/leave').raise_for_status()
        self.assertEqual(room.history[-1]['emotes'], [2, 4])
        yapper = build_records(self.store.history.stats_results())['yapper']
        self.assertEqual((yapper['label'], yapper['emotes']), ('Two', 4))

    def test_a_saved_practice_run_takes_up_the_current_house_rules_on_its_next_deal(self):
        state = self.client.post('/api/solo', json={'username': 'Tester', 'practice': True}).json()
        room = self.store.rooms[state['id']]
        # as restored from a save made before Suited rows joined the House rules
        room.rules, room.house_version = replace(room.rules, suited_rows=False), '12'
        room.start_round()
        self.assertTrue(room.rules.suited_rows)
        self.assertTrue(room.game.rules.suited_rows)
        self.assertEqual(room.house_version, HOUSE_VERSION)
        # a rule that joins House rules later reaches the run too, even if the
        # House version was never raised for it
        room.rules = replace(room.rules, suited_rows=False)
        room.start_round()
        self.assertTrue(room.game.rules.suited_rows)

    def test_a_finished_game_leaves_the_spectate_list_but_keeps_its_spectators(self):
        state = self.client.post('/api/solo', json={'username': 'Tester', 'practice': True}).json()
        room = self.store.rooms[state['id']]
        fan = TestClient(self.client.app)
        self.addCleanup(fan.close)
        fan.get('/api/session')
        listed = lambda: [game['id'] for game in fan.get('/api/spectate').json()]
        count = lambda: fan.post('/api/presence', json={'username': 'Fan'}).json()['spectatable_games']
        self.assertEqual((listed(), count()), ([room.id], 1))
        fan.post(f'/api/spectate/{room.id}').raise_for_status()
        self.finish_game(room, [1, 2])
        self.assertEqual((listed(), count()), ([], 0))
        # whoever was watching is still at the table, on its final board
        self.assertEqual(fan.post('/api/spectate-follow').json()['id'], room.id)
        room.start_round()
        self.assertEqual(listed(), [room.id])

    def test_settings_are_saved_to_a_signed_in_account_only(self):
        body = {'preferences': {'theme': 'night', 'haptics': False, 'padDrag': 'toggle'}}
        self.assertEqual(self.client.post('/api/account/preferences', json=body).status_code, 401)
        self.assertIsNone(self.client.get('/api/session').json()['preferences'])
        account, token = self.store.accounts.login('test-subject')
        self.store.accounts.choose_name(account['id'], 'tester')
        self.client.cookies.set(ACCOUNT_COOKIE, token)
        self.assertIsNone(self.client.get('/api/session').json()['preferences'])
        self.client.post('/api/account/preferences', json=body).raise_for_status()
        # another device signed in to the same account gets them
        laptop = TestClient(self.client.app)
        self.addCleanup(laptop.close)
        laptop.cookies.set(ACCOUNT_COOKIE, token)
        self.assertEqual(laptop.get('/api/session').json()['preferences'], body['preferences'])
        for bad in ({'theme': {'nested': True}}, {'theme': 'x' * 3000}):
            self.assertEqual(self.client.post('/api/account/preferences', json={'preferences': bad}).status_code, 422)


class NewRecordTests(unittest.TestCase):
    def test_longest_pvp_game_and_bogey_monster(self):
        game = lambda scores, turns, **extra: {'winner': scores.index(min(scores)), 'scores': scores, 'turns': turns,
                                               'ended_at': turns, **extra}
        results = [{'names': ['Ann', 'Bob'], 'participants': [None, None],
                    'rounds': [game([3, 9], 14), game([30, 2], 22), game([1, 0], 99, forfeit=True)]},
                   # a longer, higher game against Golfbot: not PVP, and the bot holds no records
                   # more players and more turns, but not 1v1; three of the four are signed in
                   {'names': ['Ann', 'Bob', 'Cy', 'Di'],
                    'participants': [{'id': 'account:1'}, {'id': 'account:2'}, None, {'id': 'account:4'}],
                    'rounds': [game([3, 9, 4, 5], 60)]},
                   {'names': ['Ann', 'Bob'], 'participants': [{'id': 'account:1'}, {'id': 'account:2'}],
                    'rounds': [game([3, 9], 5)]},
                   {'names': ['Cy', 'Golfbot'], 'solo': True,
                    'participants': [None, {'id': 'bot:golfbot', 'kind': 'bot', 'display_name': 'Golfbot'}],
                    'rounds': [game([4, 50], 40)]}]
        records = build_records(results)
        self.assertEqual((records['longest_pvp']['turns'], records['longest_pvp']['players'], records['longest_pvp']['label']),
                         (22, ['Ann', 'Bob'], 'Bob'))
        self.assertEqual((records['bogey']['label'], records['bogey']['points']), ('Ann', 30))
        self.assertIsNone(records['yapper'])
        self.assertEqual(records['party'], {'count': 3, 'players': ['Ann', 'Bob', 'Di'], 'seats': 4, 'at': 60})


if __name__ == '__main__':
    unittest.main()
