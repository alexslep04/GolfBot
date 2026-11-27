"""Tournaments: the bracket (tournament.py), and its matches played at real tables (server.py)."""
import asyncio
import random
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from server import Store, create_app
from tournament import BYE, Tournament, bracket_size, seed_order


def entered(format, count, fill='byes', seeding='mmr'):
    tournament = Tournament('t', 'Cup', 'e1', format, seeding, fill)
    for player in range(count):
        tournament.add(f'P{player + 1}', token=f'token{player}', rating=1500 - player * 50)
    return tournament


def play_out(tournament, rng, draw=0.0):
    """Play every match with a coin toss; returns how often each entrant lost."""
    losses = {entrant: 0 for entrant in tournament.entrants}
    for _ in range(500):
        if tournament.status != 'live':
            return losses
        for match in tournament.ready():
            match.status = 'live'
        playing = [player for match in tournament.live() for player in match.players]
        assert len(playing) == len(set(playing)), 'someone is in two matches at once'
        match = rng.choice(tournament.live())
        winner = None if tournament.format == 'round_robin' and rng.random() < draw else rng.choice([0, 1])
        tournament.report(match.id, winner, score=[1, 0], points=[rng.randrange(40), rng.randrange(40)])
        if winner is not None:
            losses[match.players[1 - winner]] += 1
    raise AssertionError('the tournament never finished')


class BracketTests(unittest.TestCase):
    def test_seeds_are_placed_so_the_best_meet_last(self):
        self.assertEqual(seed_order(8), [1, 8, 4, 5, 2, 7, 3, 6])
        self.assertEqual([bracket_size(count) for count in (1, 2, 3, 4, 5, 8, 9)], [2, 2, 4, 4, 8, 8, 16])
        tournament = entered('single', 8).start()
        pairs = [[tournament.entrants[player].seed for player in match.players]
                 for match in tournament.matches.values() if match.round == 1]
        self.assertEqual(pairs, [[1, 8], [4, 5], [2, 7], [3, 6]])
        # seeded by MMR: the highest rating is the top seed
        self.assertEqual([entrant.name for entrant in tournament.entrants.values()][:2], ['P1', 'P2'])

    def test_byes_send_the_top_seeds_straight_through(self):
        tournament = entered('single', 5).start()
        byes = [match for match in tournament.matches.values() if match.note == 'bye']
        self.assertEqual(len(byes), 3)
        self.assertTrue(all(match.status == 'done' for match in byes))
        # only the 4th and 5th seeds have to play in the first round; seeds 2 and 3
        # both had byes, so their semifinal can start at once
        self.assertEqual([[tournament.entrants[player].seed for player in match.players] for match in tournament.ready()],
                         [[4, 5], [2, 3]])
        self.assertEqual([match.id for match in tournament.ready()], ['W1-2', 'W2-2'])

    def test_ai_opponents_fill_the_bracket_and_can_win_it(self):
        tournament = entered('single', 3, fill='ai').start()
        self.assertEqual(len(tournament.entrants), 4)
        ai = next(entrant for entrant in tournament.entrants.values() if entrant.ai)
        self.assertFalse(any(match.note == 'bye' for match in tournament.matches.values()))
        while tournament.status == 'live':
            for match in tournament.ready():
                match.status = 'live'
            match = tournament.live()[0]
            tournament.report(match.id, match.players.index(ai.id) if ai.id in match.players else 0)
        self.assertEqual(tournament.champion, ai.id)
        # a lone host may start against an AI, but not against nobody
        self.assertTrue(entered('single', 1, fill='ai').can_start)
        self.assertFalse(entered('single', 1, fill='byes').can_start)

    def test_single_elimination_puts_out_everyone_who_loses_once(self):
        rng = random.Random(3)
        for count in range(2, 12):
            tournament = entered('single', count).start(rng)
            losses = play_out(tournament, rng)
            self.assertEqual(tournament.status, 'finished')
            self.assertEqual(losses[tournament.champion], 0)
            self.assertEqual(sum(losses.values()), count - 1)  # every match but the byes puts one player out
            self.assertTrue(all(tournament.eliminated(entrant) for entrant in tournament.entrants if entrant != tournament.champion))

    def test_double_elimination_takes_two_losses_and_replays_the_final_when_the_losers_side_wins_it(self):
        rng = random.Random(5)
        replays = 0
        for count in range(2, 12):
            for _ in range(20):
                tournament = entered('double', count).start(rng)
                losses = play_out(tournament, rng)
                self.assertLess(losses[tournament.champion], 2)
                self.assertTrue(all(losses[entrant] == 2 for entrant in tournament.entrants if entrant != tournament.champion))
                final = tournament.matches['F1-1']
                self.assertEqual('F2-1' in tournament.matches, final.winner == 1)
                replays += 'F2-1' in tournament.matches
        self.assertGreater(replays, 0)

    def test_round_robin_plays_everyone_once_and_one_sits_out_each_round_of_an_odd_field(self):
        tournament = entered('round_robin', 5).start()
        self.assertEqual(len(tournament.matches), 10)
        pairs = {frozenset(match.players) for match in tournament.matches.values()}
        self.assertEqual(len(pairs), 10)
        self.assertEqual(sorted(tournament.sitting_out), [1, 2, 3, 4, 5])
        self.assertEqual(len(set(tournament.sitting_out.values())), 5)  # everyone sits out exactly once
        # an AI makes the field even instead, so nobody sits out
        even = entered('round_robin', 5, fill='ai').start()
        self.assertEqual((len(even.entrants), len(even.matches), even.sitting_out), (6, 15, {}))
        # nobody starts a later round while they still owe an earlier one
        for match in tournament.ready():
            self.assertEqual(match.round, 1)

    def test_round_robin_ranks_by_wins_then_fewest_points(self):
        tournament = entered('round_robin', 3).start()
        ids = list(tournament.entrants)
        results = {frozenset(ids[:2]): (ids[0], [10, 30]), frozenset(ids[1:]): (ids[1], [5, 40]), frozenset([ids[0], ids[2]]): (ids[2], [50, 9])}
        while tournament.status == 'live':
            for match in tournament.ready():
                match.status = 'live'
            match = tournament.live()[0]
            winner, points = results[frozenset(match.players)]
            # points were written in the order of the pair as listed in `ids`
            first = min(match.players, key=ids.index)
            ordered = points if match.players[0] == first else points[::-1]
            tournament.report(match.id, match.players.index(winner), points=ordered)
        table = tournament.standings()
        # one win each: fewest card points decides it (P1: 10+50, P2: 30+5, P3: 40+9)
        self.assertEqual([(row['id'], row['wins'], row['points']) for row in table], [(ids[1], 1, 35), (ids[2], 1, 49), (ids[0], 1, 60)])
        self.assertEqual(tournament.champion, ids[1])
        # a draw is half a win
        drawn = entered('round_robin', 2).start()
        drawn.report(next(iter(drawn.matches)), None, points=[7, 7])
        self.assertEqual([row['score'] for row in drawn.standings()], [0.5, 0.5])
        with self.assertRaises(ValueError):
            entered('single', 2).start().report('W1-1', None)

    def test_leaving_gives_every_match_still_to_come_to_the_opponent(self):
        tournament = entered('single', 4).start()
        leaver = tournament.matches['W1-1'].players[0]
        tournament.withdraw(leaver)
        first = tournament.matches['W1-1']
        self.assertEqual((first.status, first.winner, first.note), ('done', 1, 'forfeit'))
        self.assertTrue(tournament.eliminated(leaver))
        self.assertEqual(tournament.view()['entrants'][0]['withdrawn'], True)
        self.assertNotIn('token', str(tournament.view()))  # nothing private goes to the page


class TournamentServerTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.app = create_app(self.store)
        self.clients = []
        self.host = self.player()

    def player(self):
        client = TestClient(self.app)
        client.get('/api/session')
        self.addCleanup(client.close)
        self.clients.append(client)
        return client

    def token(self, client):
        return client.cookies.get('golf_session')

    def create(self, **settings):
        body = {'username': 'Host', 'name': 'Friday Cup', 'format': 'single', 'best_of': 1, 'series_mode': 'wins',
                'house_rules': True, **settings}
        response = self.host.post('/api/tournaments', json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def tick(self):
        """One pass of the server's once-a-second tournament loop."""
        asyncio.run(self.app.state.advance_tournaments())

    def finish(self, room, scores):
        room.game.phase = 'over'
        with patch.object(room.game, 'score', side_effect=lambda seat, *args: scores[seat]):
            room.record_result()

    def test_lobby_join_ai_and_start(self):
        view = self.create(fill='ai')
        tid = view['id']
        self.assertEqual((view['status'], view['you']['host'], len(view['entrants']), view['can_start']), ('open', True, 1, True))
        guest = self.player()
        joined = guest.post(f'/api/tournaments/{tid}/join', json={'username': 'Guest', 'via': 'link'}).json()
        self.assertEqual([entrant['name'] for entrant in joined['entrants']], ['Host', 'Guest'])
        self.assertFalse(joined['you']['host'])
        # joining by the tournament's link counts for the host, like a table's invite link
        self.assertEqual([(row['label'], row['count']) for row in self.store.accounts.invite_counts()], [('Host', 1)])
        # only the host removes entrants and starts
        self.assertEqual(guest.post(f'/api/tournaments/{tid}/start').status_code, 403)
        extra = self.player()
        added = extra.post(f'/api/tournaments/{tid}/join', json={'username': 'Extra'}).json()['you']['entrant']
        self.assertEqual(guest.post(f'/api/tournaments/{tid}/remove', json={'entrant': added}).status_code, 403)
        self.host.post(f'/api/tournaments/{tid}/remove', json={'entrant': added}).raise_for_status()
        self.assertIsNone(extra.post('/api/presence', json={'username': 'Extra'}).json()['tournament'])
        # (AIs are no longer added by hand: they only fill the places left at the start)
        self.assertEqual(self.host.post(f'/api/tournaments/{tid}/ai').status_code, 404)
        listed = guest.get('/api/tournaments').json()
        self.assertEqual([(row['name'], row['status'], row['entrants'], row['mine']) for row in listed], [('Friday Cup', 'open', 2, True)])
        presence = guest.post('/api/presence', json={'username': 'Guest'}).json()['tournament']
        self.assertEqual((presence['id'], presence['status'], presence['room_id']), (tid, 'open', None))
        started = self.host.post(f'/api/tournaments/{tid}/start').json()
        self.assertEqual(started['status'], 'live')
        # two players in a two-place bracket: one match, at a real table, both seated
        (match,) = started['matches']
        room = self.store.rooms[match['room_id']]
        self.assertEqual((match['status'], room.status, room.tournament['match'], room.must_decide), ('live', 'playing', 'W1-1', True))
        self.assertEqual(sorted(room.seats), sorted([self.token(self.host), self.token(guest)]))
        self.assertEqual(guest.post('/api/presence', json={'username': 'Guest'}).json()['tournament']['room_id'], room.id)
        self.assertEqual(guest.post(f'/api/tournaments/{tid}/join', json={'username': 'Guest'}).json()['you']['room_id'], room.id)
        # it is not offered as a table to join, and cannot be replayed or voided
        self.assertEqual(self.host.get('/api/lobbies').json(), [])
        late = self.player()
        self.assertEqual(late.post(f'/api/tournaments/{tid}/join', json={'username': 'Late'}).status_code, 409)

    def test_its_players_emote_at_the_end_beside_their_name(self):
        tid = self.create()['id']
        guest = self.player()
        guest.post(f'/api/tournaments/{tid}/join', json={'username': 'Guest'}).raise_for_status()
        outsider = self.player()
        self.host.post(f'/api/tournaments/{tid}/start').raise_for_status()
        path = f'/api/tournaments/{tid}/emote'
        # (not while it is on)
        self.assertEqual(self.host.post(path, json={'emote': 'wow'}).status_code, 409)
        tournament = self.store.tournaments[tid]
        (match,) = tournament.live()
        self.finish(self.store.rooms[match.room_id], [3, 9])
        self.tick()
        self.assertEqual(tournament.status, 'finished')
        view = self.host.post(path, json={'emote': 'wow'}).json()
        host = view['you']['entrant']
        self.assertEqual([(item['entrant'], item['id']) for item in view['emotes']], [(host, 'wow')])
        # everyone looking sees it, beside the host's name; a flag's emote waits for the flag
        self.assertEqual([item['id'] for item in guest.get(f'/api/tournaments/{tid}').json()['emotes']], ['wow'])
        self.assertEqual(guest.post(path, json={'emote': 'ranked'}).status_code, 403)
        # only its players
        self.assertEqual(outsider.post(path, json={'emote': 'wow'}).status_code, 403)
        # and each goes after its few seconds
        tournament.emotes[host]['at'] -= 10
        self.assertEqual(self.host.get(f'/api/tournaments/{tid}').json()['emotes'], [])

    def test_a_match_result_moves_the_bracket_on_and_crowns_a_champion(self):
        tid = self.create()['id']
        others = [self.player() for _ in range(3)]
        for number, client in enumerate(others):
            client.post(f'/api/tournaments/{tid}/join', json={'username': f'P{number + 2}'}).raise_for_status()
        self.host.post(f'/api/tournaments/{tid}/start').raise_for_status()
        tournament = self.store.tournaments[tid]
        self.assertEqual(len(tournament.live()), 2)
        for match in tournament.live():
            self.finish(self.store.rooms[match.room_id], [3, 9])  # the first seat of each table wins
        self.tick()
        final = tournament.matches['W2-1']
        self.assertEqual(final.status, 'live')
        winners = [match.players[match.winner] for match in (tournament.matches['W1-1'], tournament.matches['W1-2'])]
        self.assertEqual(final.players, winners)
        self.assertEqual(tournament.matches['W1-1'].score, [1, 0])
        room = self.store.rooms[final.room_id]
        # a level game cannot decide a knockout match: it is played again
        self.finish(room, [5, 5])
        self.assertEqual((room.status, room.series_complete), ('round_over', False))
        room.start_round()
        self.finish(room, [8, 2])
        self.tick()
        self.assertEqual((tournament.status, tournament.champion), ('finished', final.players[1]))
        view = self.host.get(f'/api/tournaments/{tid}').json()
        self.assertEqual(view['standings'][0]['id'], tournament.champion)
        # a finished tournament is kept
        saved = self.store.history.connection.execute('SELECT id FROM tournaments').fetchall()
        self.assertEqual(saved, [(tid,)])
        self.assertIsNone(self.host.post('/api/presence', json={'username': 'Host'}).json()['tournament'])
        # ...in Match history: off the list of tournaments to join or watch, and its matches in a list of their own
        self.assertEqual(self.host.get('/api/tournaments').json(), [])
        (row,) = self.host.get('/api/tournament-history').json()
        self.assertEqual((row['id'], row['name'], row['status'], row['entrants'], row['champion'], row['mine']),
                         (tid, 'Friday Cup', 'finished', 4, tournament.entrants[tournament.champion].name, True))
        history = lambda kind: [saved['lobby_name'] for saved in self.host.get(f'/api/history?kind={kind}').json()['matches']]
        self.assertEqual(sorted(history('tournament')), ['Friday Cup: Final', 'Friday Cup: Semifinal', 'Friday Cup: Semifinal'])
        self.assertEqual((history('pvp'), history('solo')), ([], []))
        self.assertEqual(self.host.get('/api/history?kind=other').status_code, 422)
        # once the server has let go of it, its bracket is still there to look at
        del self.store.tournaments[tid]
        kept = others[0].get(f'/api/tournaments/{tid}').json()
        self.assertEqual((kept['status'], kept['champion'], len(kept['matches']), kept['you']['host']), ('finished', tournament.champion, 3, False))
        self.assertEqual(kept['you']['entrant'], tournament.by_token(self.token(others[0])).id)
        self.assertEqual(self.host.get('/api/tournaments/nope').status_code, 404)

    def test_match_history_keeps_tables_between_players_and_games_against_golfbot_apart(self):
        guest = self.player()
        table = self.host.post('/api/lobbies', json={'username': 'Host', 'name': 'Friendly', 'best_of': 1}).json()
        guest.post(f"/api/lobbies/{table['id']}/join", json={'username': 'Guest'}).raise_for_status()
        self.finish(self.store.rooms[table['id']], [3, 9])
        solo = self.player()
        game = solo.post('/api/solo', json={'username': 'Solo', 'best_of': 1, 'practice': False}).json()
        self.finish(self.store.rooms[game['id']], [2, 8])
        history = lambda kind: [saved['lobby_name'] for saved in self.host.get('/api/history' + kind).json()['matches']]
        self.assertEqual(history('?kind=pvp'), ['Friendly'])
        self.assertEqual(len(history('?kind=solo')), 1)
        self.assertEqual(history('?kind=tournament'), [])
        self.assertEqual(len(history('')), 2)  # (with no kind: everything)

    def test_the_host_invites_a_player_who_is_online_to_the_tournament(self):
        tid = self.create()['id']
        guest, other = self.player(), self.player()
        for client, name in ((guest, 'Guest'), (other, 'Other')):
            client.post('/api/presence', json={'username': name}).raise_for_status()  # online, at no table
        online = {player['display_name']: player['id'] for player in self.host.post('/api/presence', json={'username': 'Host'}).json()['players']}
        self.assertEqual(set(online), {'Guest', 'Other'})
        # only the host invites
        self.assertEqual(guest.post(f'/api/tournaments/{tid}/invite', json={'player_id': online['Other']}).status_code, 403)
        self.host.post(f'/api/tournaments/{tid}/invite', json={'player_id': online['Guest']}).raise_for_status()
        self.assertEqual(self.host.post('/api/presence', json={'username': 'Host'}).json()['invited'], [online['Guest']])
        (invitation,) = guest.post('/api/presence', json={'username': 'Guest'}).json()['invitations']
        self.assertEqual((invitation['host'], invitation['tournament']['id'], invitation['tournament']['name'], invitation['tournament']['format_name']),
                         ('Host', tid, 'Friday Cup', 'Single elimination'))
        joined = guest.post(f"/api/invitations/{invitation['id']}/respond", json={'accept': True, 'username': 'Guest'}).json()
        self.assertEqual(([entrant['name'] for entrant in joined['entrants']], joined['you']['host']), (['Host', 'Guest'], False))
        # someone in a tournament is not offered for another invitation, and theirs is used up
        presence = self.host.post('/api/presence', json={'username': 'Host'}).json()
        self.assertEqual(([player['display_name'] for player in presence['players']], presence['invited']), (['Other'], []))
        # an invitation can be declined, and one to a tournament that has started is gone
        self.host.post(f'/api/tournaments/{tid}/invite', json={'player_id': online['Other']}).raise_for_status()
        (second,) = other.post('/api/presence', json={'username': 'Other'}).json()['invitations']
        self.host.post(f'/api/tournaments/{tid}/start').raise_for_status()
        self.assertEqual(other.post('/api/presence', json={'username': 'Other'}).json()['invitations'], [])
        self.assertEqual(other.post(f"/api/invitations/{second['id']}/respond", json={'accept': True}).status_code, 404)
        self.assertEqual(self.host.post(f'/api/tournaments/{tid}/invite', json={'player_id': online['Other']}).status_code, 409)

    def test_leaving_a_match_forfeits_it_and_leaving_the_tournament_forfeits_the_rest(self):
        tid = self.create(format='double')['id']
        guest = self.player()
        guest.post(f'/api/tournaments/{tid}/join', json={'username': 'Guest'}).raise_for_status()
        self.host.post(f'/api/tournaments/{tid}/start').raise_for_status()
        tournament = self.store.tournaments[tid]
        first = tournament.matches['W1-1']
        room = self.store.rooms[first.room_id]
        guest.post(f'/api/lobbies/{room.id}/leave').raise_for_status()
        self.tick()
        host_place = first.players.index(tournament.by_token(self.token(self.host)).id)
        self.assertEqual((first.status, first.winner, first.note), ('done', host_place, 'forfeit'))
        # double elimination: the two meet again in the grand final, at a new table
        final = tournament.matches['F1-1']
        self.assertEqual(final.status, 'live')
        self.assertNotEqual(final.room_id, room.id)
        guest.post(f'/api/tournaments/{tid}/leave').raise_for_status()
        self.assertEqual((tournament.status, tournament.champion), ('finished', tournament.by_token(self.token(self.host)).id))

    def test_a_player_meets_an_ai_at_a_solo_table_and_two_ais_play_each_other(self):
        tid = self.create(fill='ai')['id']
        tournament = self.store.tournaments[tid]
        tournament.add_ai()
        tournament.add_ai()
        started = self.host.post(f'/api/tournaments/{tid}/start').json()
        self.assertEqual(len(started['entrants']), 4)  # the host, two AIs already in, and one to fill the bracket
        rooms = [self.store.rooms[match.room_id] for match in tournament.live()]
        mine = next(room for room in rooms if not room.ai_match)
        theirs = next(room for room in rooms if room.ai_match)
        self.assertTrue(mine.solo and mine.seats[0] == self.token(self.host) and mine.tournament)
        self.assertIsNone(mine.progression)  # no solo streak, no rating
        self.assertFalse(self.host.get(f'/api/lobbies/{mine.id}/state').json()['game']['legal']['set_rules'])
        # the AI table can be watched like any other
        self.assertEqual(theirs.history_store, None)
        watcher = self.player()
        listed = watcher.get('/api/spectate').json()
        self.assertEqual({game['id'] for game in listed}, {mine.id, theirs.id})
        self.assertTrue(watcher.post(f'/api/spectate/{theirs.id}').json()['ai_match'])
        self.finish(theirs, [9, 2])
        self.finish(mine, [1, 7])
        self.tick()
        final = tournament.matches['W2-1']
        self.assertEqual(final.status, 'live')
        room = self.store.rooms[final.room_id]
        self.assertTrue(room.solo and not room.ai_match)
        self.finish(room, [30, 4])
        self.tick()
        champion = tournament.entrants[tournament.champion]
        self.assertTrue(champion.ai)  # an AI can win the whole thing

    def test_ranked_tournaments_use_house_rules_and_move_ratings(self):
        view = self.create(ranked=True, house_rules=False, rules={'suited_rows': True}, best_of=3, series_mode='points')
        self.assertTrue(view['ranked'] and view['settings']['house_rules'])
        tid = view['id']
        guest = self.player()
        guest.post(f'/api/tournaments/{tid}/join', json={'username': 'Guest'}).raise_for_status()
        self.host.post(f'/api/tournaments/{tid}/start').raise_for_status()
        tournament = self.store.tournaments[tid]
        room = self.store.rooms[tournament.matches['W1-1'].room_id]
        self.assertTrue(room.rated and room.house_rules)
        for game, scores in enumerate(([2, 9], [3, 8], [4, 7])):
            if game:
                room.start_round()
            self.finish(room, scores)
        self.assertEqual(room.status, 'finished')
        self.assertEqual(room.history[-1]['mmr'][0]['delta'], 162)
        board = self.store.progression.leaderboard(combine_guests=False)['pvp']
        self.assertEqual([(row['wins'], row['losses']) for row in board], [(1, 0), (0, 1)])
        self.tick()
        self.assertEqual(tournament.matches['W1-1'].score, [9, 24])
        self.assertEqual(tournament.status, 'finished')
        # an unranked tournament leaves the board alone
        self.assertEqual(self.host.post('/api/lobbies', json={'username': 'Host'}).status_code, 409)  # still at the finished table

    def test_the_host_can_award_a_stuck_match(self):
        tid = self.create()['id']
        guest = self.player()
        guest.post(f'/api/tournaments/{tid}/join', json={'username': 'Guest'}).raise_for_status()
        self.host.post(f'/api/tournaments/{tid}/start').raise_for_status()
        tournament = self.store.tournaments[tid]
        match = tournament.matches['W1-1']
        self.assertEqual(guest.post(f'/api/tournaments/{tid}/matches/W1-1/award', json={'winner': 0}).status_code, 403)
        self.host.post(f'/api/tournaments/{tid}/matches/W1-1/award', json={'winner': 1}).raise_for_status()
        self.assertEqual((match.status, match.winner, match.note), ('done', 1, 'awarded'))
        self.assertEqual(self.store.rooms[match.room_id].status, 'closed')
        self.assertEqual(tournament.status, 'finished')

    def test_the_host_leaving_the_lobby_closes_the_tournament(self):
        tid = self.create()['id']
        guest = self.player()
        guest.post(f'/api/tournaments/{tid}/join', json={'username': 'Guest'}).raise_for_status()
        self.host.post(f'/api/tournaments/{tid}/leave').raise_for_status()
        # nothing of it is kept, as with a table whose host has left
        self.assertEqual(self.store.tournaments, {})
        self.assertEqual(self.host.get('/api/tournament-history').json(), [])
        self.assertEqual(guest.get(f'/api/tournaments/{tid}').status_code, 404)
        self.assertEqual(guest.get('/api/tournaments').json(), [])
        self.assertIsNone(guest.post('/api/presence', json={'username': 'Guest'}).json()['tournament'])


if __name__ == '__main__':
    unittest.main()
