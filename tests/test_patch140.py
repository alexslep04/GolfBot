"""Patch 1.4.0: Glicko-2 Ranked play, what each game now records, and the smaller fixes."""
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from accounts import ACCOUNT_COOKIE
from game import GolfGame
from player_stats import summarize
from server import Move, Store, apply_move, create_app


class Patch140Tests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.app = create_app(self.store)
        self.client = self.player()

    def player(self):
        client = TestClient(self.app)
        client.get('/api/session')
        self.addCleanup(client.close)
        return client

    def rated(self):
        other = self.player()
        self.client.post('/api/queue/join', json={'username': 'One'})
        other.post('/api/queue/join', json={'username': 'Two'})
        offer = self.client.post('/api/presence', json={'username': 'One'}).json()['queue']['id']
        self.client.post(f'/api/queue/offers/{offer}/respond', json={'accept': True})
        result = other.post(f'/api/queue/offers/{offer}/respond', json={'accept': True}).json()
        return other, self.store.rooms[result['room_id']]

    def finish(self, room, scores):
        room.game.phase = 'over'
        with patch.object(room.game, 'score', side_effect=lambda seat, *args: scores[seat]):
            room.record_result()

    def ratings(self, room):
        return [self.store.progression.ratings(player['id']) for player in room.progression_players]

    # ---------- Ranked on Glicko-2 ----------
    def test_every_ranked_game_moves_the_game_rating_and_the_series_moves_mmr_once(self):
        other, room = self.rated()
        self.assertEqual(self.client.get(f'/api/lobbies/{room.id}/state').json()['ratings'], [1000, 1000])
        # seat 1 wins three games narrowly, but seat 0 has the lowest total over five
        for game, scores in enumerate(([9, 8], [9, 8], [9, 8], [0, 20], [0, 20])):
            if game:
                room.start_round()
            self.finish(room, scores)
            self.assertEqual(len(room.history[-1]['game_rating']), 2)
            self.assertEqual('mmr' in room.history[-1], game == 4)
        self.assertEqual((room.status, room.champion), ('finished', 0))
        one, two = self.ratings(room)
        self.assertEqual((one['game']['wins'], one['game']['losses'], one['series']['wins'], one['series']['losses']), (2, 3, 1, 0))
        self.assertEqual((two['game']['wins'], two['game']['losses'], two['series']['wins'], two['series']['losses']), (3, 2, 0, 1))
        # the two ratings are separate: the series moved MMR once, the five games moved the game rating
        self.assertGreater(one['series']['rating'], two['series']['rating'])
        self.assertEqual(one['series']['rating'], 1162)
        self.assertNotEqual(one['game']['rating'], one['series']['rating'])
        self.assertEqual(room.history[-1]['mmr'][0]['after'], one['series']['rating'])
        self.assertEqual(room.history[-1]['series_winner'], 0)
        board = self.client.get('/api/leaderboards').json()
        self.assertEqual([row['mmr'] for row in board['pvp']], [1000])  # both are guests: one Guest row, at their average
        self.assertEqual(board['records']['highest_mmr']['mmr'], one['series']['rating'])

    def test_a_ranked_rematch_starts_only_when_both_players_ask(self):
        other, room = self.rated()
        for game in range(room.best_of):
            if game:
                room.start_round()
            self.finish(room, [2, 9])
        self.assertEqual(room.status, 'finished')
        first_series, mmr = room.match_id, [rating['series']['rating'] for rating in self.ratings(room)]
        # one player asking changes nothing but the note that they asked (and asking twice is the same)
        before = room.version
        for _ in range(2):
            apply_move(room, room.seats[1], Move(action='rematch', version=room.version))
        self.assertGreater(room.version, before)  # so the other player's table shows the request
        self.assertEqual((room.status, room.match_id, sorted(room.rematch_votes)), ('finished', first_series, [1]))
        self.assertEqual(self.client.get(f'/api/lobbies/{room.id}/state').json()['rematch_votes'], [1])
        # the other agreeing starts a new Ranked series between the two
        apply_move(room, room.seats[0], Move(action='rematch', version=room.version))
        self.assertEqual((room.status, room.history, room.wins, room.rematch_votes), ('playing', [], [0, 0], set()))
        self.assertTrue(room.rated and room.match_id != first_series)
        # ...which is rated like the first: its result moves MMR again
        for game in range(room.best_of):
            if game:
                room.start_round()
            self.finish(room, [2, 9])
        again = [rating['series']['rating'] for rating in self.ratings(room)]
        self.assertTrue(again[0] > mmr[0] and again[1] < mmr[1])

    def test_a_table_closed_after_its_series_still_says_the_series_was_decided(self):
        guest = self.player()
        table = self.client.post('/api/lobbies', json={'username': 'Host', 'best_of': 1}).json()
        guest.post(f"/api/lobbies/{table['id']}/join", json={'username': 'Guest'}).raise_for_status()
        room = self.store.rooms[table['id']]
        self.assertFalse(self.client.get(f"/api/lobbies/{room.id}/state").json()['series_complete'])
        self.finish(room, [2, 9])
        guest.post(f"/api/lobbies/{room.id}/leave").raise_for_status()
        # the host keeps the result on screen (with Rematch greyed out: nobody is left to play)
        state = self.client.get(f"/api/lobbies/{room.id}/state").json()
        self.assertEqual((state['status'], state['series_complete'], state['champion'], len(state['history'])), ('closed', True, 0, 1))
        self.assertEqual(self.client.post(f"/api/lobbies/{room.id}/action", json={'action': 'rematch', 'version': state['version']}).status_code, 409)
        # leaving mid-game is different: nothing was decided
        other = self.client.post('/api/lobbies', json={'username': 'Host'})
        self.assertEqual(other.status_code, 409)  # (still seated at the closed table until they go back to the menu)

    def test_level_totals_draw_the_series(self):
        other, room = self.rated()
        for game, scores in enumerate(([1, 2], [2, 1], [3, 3], [3, 3], [3, 3])):
            if game:
                room.start_round()
            self.finish(room, scores)
        self.assertIsNone(room.champion)
        self.assertEqual([rating['series']['draws'] for rating in self.ratings(room)], [1, 1])
        self.assertEqual([entry['delta'] for entry in room.history[-1]['mmr']], [0, 0])

    def test_leaving_between_games_loses_the_series_but_no_game(self):
        other, room = self.rated()
        self.finish(room, [1, 2])
        predicted = other.get(f'/api/lobbies/{room.id}/state').json()['forfeit_mmr_loss']
        self.assertGreater(predicted, 0)
        other.post(f'/api/lobbies/{room.id}/leave').raise_for_status()
        one, two = self.ratings(room)
        self.assertEqual(len(room.history), 1)  # no game is invented
        self.assertEqual((one['game']['wins'], one['series']['wins'], two['game']['losses'], two['series']['losses']), (1, 1, 1, 1))
        self.assertEqual(-room.history[-1]['mmr'][1]['delta'], predicted)
        self.assertEqual((room.history[-1]['series_winner'], room.history[-1]['series_forfeit']), (0, 1))

    def test_a_mutual_void_keeps_finished_games_and_rates_no_series(self):
        other, room = self.rated()
        self.finish(room, [1, 2])
        room.start_round()
        self.client.post(f'/api/lobbies/{room.id}/void-offer').raise_for_status()
        other.post(f'/api/lobbies/{room.id}/void-reply', json={'accept': True}).raise_for_status()
        one, two = self.ratings(room)
        self.assertEqual((one['game']['wins'], two['game']['losses']), (1, 1))
        self.assertEqual(sum(rating['series'][key] for rating in (one, two) for key in ('wins', 'draws', 'losses')), 0)
        self.assertEqual(self.store.progression.leaderboard()['pvp'], [])

    def test_advanced_stats_show_both_ratings_for_an_account(self):
        account, token = self.store.accounts.login('subject')
        self.store.accounts.choose_name(account['id'], 'tester')
        self.client.cookies.set(ACCOUNT_COOKIE, token)
        me = {'id': 'account:' + account['id'], 'kind': 'account', 'unique_name': 'tester'}
        self.store.progression.rate_series('s', [me, {'id': 'browser:x', 'display_name': 'X'}], 0)
        stats = self.client.get('/api/stats').json()
        self.assertEqual(stats['player']['ratings']['series']['rating'], 1162)
        self.assertEqual(stats['player']['ratings']['game'], {'rating': 1000, 'rd': 350, 'provisional': True, 'wins': 0, 'draws': 0, 'losses': 0})
        self.assertNotIn('ratings', stats['comparison'])  # Golfbot has none
        # ...and the records they hold: here the best MMR, and being the newest account
        self.assertEqual(set(stats['player']['records']), {'highest_mmr', 'recruit'})
        self.assertNotIn('records', stats['comparison'])

    # ---------- what a game records ----------
    def test_a_game_records_who_went_first_and_how_many_watched(self):
        state = self.client.post('/api/solo', json={'username': 'Tester', 'practice': True}).json()
        room = self.store.rooms[state['id']]
        fans = [self.player() for _ in range(2)]
        for fan in fans:
            fan.post(f'/api/spectate/{room.id}').raise_for_status()
            with fan.websocket_connect(f'/ws/{room.id}') as socket:
                socket.receive_json()
        first = room.game.first_player
        self.finish(room, [1, 2])
        game = room.history[-1]
        self.assertEqual((game['first'], game['first_random'], game['spectators']), (first, True, 2))
        # nobody is watching the next game: its count starts again
        room.start_round()
        self.finish(room, [1, 2])
        self.assertEqual(room.history[-1]['spectators'], 0)
        # a table whose host goes first by rule was not left to chance
        custom = self.player().post('/api/solo', json={'username': 'Custom', 'practice': False, 'first': 'host', 'best_of': 3}).json()
        room = self.store.rooms[custom['id']]
        self.finish(room, [1, 2])
        self.assertEqual((room.history[-1]['first'], room.history[-1]['first_random']), (0, False))

    def test_stats_count_first_turns_and_wins_with_and_without_them(self):
        game = lambda first, scores: {'scores': scores, 'first': first, 'rules': {}}
        matches = [{'names': ['Ann', 'Bob'], 'participants': [None, None], 'status': 'finished', 'winner': 0, 'rules': {},
                    'rounds': [game(0, [1, 5]), game(0, [9, 5]), game(1, [1, 5]), game(1, [2, 5]), game(0, [3, 5]),
                               {'scores': [4, 5], 'rules': {}},                          # before it was recorded
                               {'scores': [0, 1], 'first': 0, 'forfeit': True, 'rules': {}}]}]  # no game was played
        stats = summarize(matches, 'player:Ann')
        self.assertEqual((stats['known_first_games'], stats['first_games'], stats['first_wins'], stats['later_games'], stats['later_wins']),
                         (5, 3, 2, 2, 2))
        self.assertAlmostEqual(stats['first_rate'], 0.6)
        self.assertAlmostEqual(stats['first_win_rate'], 2 / 3)
        self.assertEqual(stats['later_win_rate'], 1.0)
        self.assertIsNone(summarize([], 'player:Ann')['first_rate'])

    def test_up_in_counts_the_turns_until_each_seat_plays(self):
        game = GolfGame(multiplayer=True, player_count=4, first_player=2, turn_order=[2, 0, 3, 1])
        self.assertEqual(game.up_in, [None] * 4)  # nobody is waiting during the opening flips
        game.phase = 'choose'
        self.assertEqual(game.up_in, [1, 3, None, 2])  # seat 2 is playing; 0 is next, then 3, then 1
        game.current = 3
        self.assertEqual(game.up_in, [3, 1, 2, None])  # after seat 3 come 1, then 2, then 0
        # the last round: only those still owed a final turn are waiting
        game.finisher, game.final_turn_queue = 2, [1]
        self.assertEqual(game.up_in, [None, 1, None, None])
        state = self.client.post('/api/solo', json={'username': 'Tester', 'practice': True}).json()
        self.assertIn('up_in', state['game'])

    # ---------- invite links, accounts ----------
    def test_joining_by_invite_link_counts_once_for_the_host(self):
        table = self.client.post('/api/lobbies', json={'username': 'Host', 'game_type': 'many'}).json()
        friends = [self.player() for _ in range(3)]
        url = f"/api/lobbies/{table['id']}/join"
        friends[0].post(url, json={'username': 'Ann', 'via': 'link'}).raise_for_status()
        friends[1].post(url, json={'username': 'Bob', 'via': 'link'}).raise_for_status()
        friends[2].post(url, json={'username': 'Cy'}).raise_for_status()  # from the list of open tables: no link
        self.assertEqual([(row['label'], row['count']) for row in self.store.accounts.invite_counts()], [('Host', 2)])
        # the same friend coming back through another link of the host's is still one person
        friends[0].post(f"/api/lobbies/{table['id']}/leave").raise_for_status()
        friends[0].post(url, json={'username': 'Ann', 'via': 'link'}).raise_for_status()
        self.assertEqual(self.store.accounts.invite_counts()[0]['count'], 2)
        gospel = self.client.get('/api/leaderboards').json()['records']['gospel']
        self.assertEqual((gospel['label'], gospel['count']), ('Host', 2))
        self.assertEqual(friends[1].post(url, json={'username': 'Bob', 'via': 'email'}).status_code, 422)

    def test_the_newest_account_is_the_newest_recruit(self):
        self.assertIsNone(self.store.accounts.newest())
        first, _ = self.store.accounts.login('one')
        self.store.accounts.choose_name(first['id'], 'first')
        second, _ = self.store.accounts.login('two')
        self.assertEqual(self.store.accounts.newest()['unique_name'], 'first')  # no unique name yet: not counted
        self.store.accounts.choose_name(second['id'], 'second')
        newest = self.store.accounts.newest()
        self.assertEqual((newest['id'], newest['unique_name']), ('account:' + second['id'], 'second'))
        self.assertIsNotNone(newest['created_at'])
        recruit = self.client.get('/api/leaderboards').json()['records']['recruit']
        self.assertEqual((recruit['label'], recruit['at']), ('second', newest['created_at']))

    # ---------- smaller fixes ----------
    def test_a_new_display_name_shows_at_the_solo_table_at_once(self):
        state = self.client.post('/api/solo', json={'username': 'Old name', 'practice': True}).json()
        room = self.store.rooms[state['id']]
        self.assertEqual(room.names[0], 'Old name')
        version = room.version
        self.client.post('/api/name', json={'username': 'New name'}).raise_for_status()
        self.assertEqual(room.names, ['New name', 'Golfbot'])
        self.assertEqual(room.participants[0]['display_name'], 'New name')
        self.assertGreater(room.version, version)
        self.assertEqual(self.client.get(f'/api/lobbies/{room.id}/state').json()['names'][0], 'New name')

    def test_spectate_lists_the_streak_of_a_player_against_golfbot(self):
        state = self.client.post('/api/solo', json={'username': 'Tester', 'practice': True}).json()
        room = self.store.rooms[state['id']]
        for event in ('a', 'b', 'c'):
            self.store.progression.practice_result(event, room.progression_players[0], 0)
        fan = self.player()
        (listed,) = fan.get('/api/spectate').json()
        self.assertEqual(listed['streak'], {'current': 3, 'draws': 0})
        # a table between people has no streak to show
        table = self.player()
        hosted = table.post('/api/lobbies', json={'username': 'Host'}).json()
        self.player().post(f"/api/lobbies/{hosted['id']}/join", json={'username': 'Guest'}).raise_for_status()
        streaks = {game['id']: game['streak'] for game in fan.get('/api/spectate').json()}
        self.assertIsNone(streaks[hosted['id']])

    def test_host_a_table_solo_is_a_custom_match_against_golfbot_with_no_streak(self):
        state = self.client.post('/api/solo', json={'username': 'Tester', 'practice': False, 'best_of': 3, 'series_mode': 'points',
                                                    'house_rules': False, 'rules': {'suited_rows': True}, 'first': 'guest',
                                                    'game_type': '1v1', 'name': 'Friendly Golf'}).json()
        room = self.store.rooms[state['id']]
        self.assertTrue(room.solo and not room.practice and not room.counts_streak)
        self.assertEqual((room.best_of, room.series_mode, room.game.first_player, room.rules.suited_rows), (3, 'points', 1, True))

    def test_someone_playing_golfbot_can_still_be_invited_to_a_table(self):
        table = self.client.post('/api/lobbies', json={'username': 'Host', 'name': 'Come play'}).json()
        soloist, seated, partner = self.player(), self.player(), self.player()
        solo = soloist.post('/api/solo', json={'username': 'Soloist'}).json()
        # (two others are at a table together: they are not offered)
        other = seated.post('/api/lobbies', json={'username': 'Seated'}).json()
        partner.post(f"/api/lobbies/{other['id']}/join", json={'username': 'Partner'}).raise_for_status()
        for client, name in ((soloist, 'Soloist'), (seated, 'Seated'), (partner, 'Partner')):
            client.post('/api/presence', json={'username': name}).raise_for_status()
        (offered,) = self.client.post('/api/presence', json={'username': 'Host'}).json()['players']
        self.assertEqual((offered['display_name'], offered['solo']), ('Soloist', True))
        self.client.post(f"/api/lobbies/{table['id']}/invite", json={'player_id': offered['id']}).raise_for_status()
        # the invitation reaches them at their game, and waits there
        (invitation,) = soloist.post('/api/presence', json={'username': 'Soloist'}).json()['invitations']
        self.assertEqual((invitation['host'], invitation['lobby']['name']), ('Host', 'Come play'))
        reply = f"/api/invitations/{invitation['id']}/respond"
        # they leave the game against Golfbot to take it up (the page does that for them)
        self.assertEqual(soloist.post(reply, json={'accept': True, 'username': 'Soloist'}).status_code, 409)
        soloist.post(f"/api/lobbies/{solo['id']}/leave").raise_for_status()
        joined = soloist.post(reply, json={'accept': True, 'username': 'Soloist'}).json()
        self.assertEqual((joined['id'], joined['names']), (table['id'], ['Host', 'Soloist']))
        self.assertEqual(self.store.invitations, {})


if __name__ == '__main__':
    unittest.main()
