"""Flags: earned from saved games, and what they unlock."""
from contextlib import ExitStack
import unittest

from fastapi.testclient import TestClient

import flags
from server import Store, create_app

ME, THEM = {'id': 'account:me', 'kind': 'account'}, {'id': 'account:them', 'kind': 'account'}
BOT = {'id': 'bot:golfbot', 'kind': 'bot'}


def match(rounds, seats=(ME, THEM), **extra):
    return {'participants': list(seats), 'rounds': rounds, **extra}


def game(moves, ended_at=1, **extra):
    return {'moves': moves, 'ended_at': ended_at, **extra}


class FlagTests(unittest.TestCase):
    def test_only_flipping_your_own_cards_earns_the_cue(self):
        earned = flags.earned([match([game(['fefefefe', 'dxdx'], 7)])], 'account:me')
        self.assertEqual(earned, {"Wait for my cue...": 7})
        # (a single draw, swap or discard and it is not that game)
        for moves in ('fefedx', 'fs', 'fefe' 'ds', ''):
            self.assertNotIn("Wait for my cue...", flags.earned([match([game([moves, ''])])], 'account:me'))

    def test_five_draws_thrown_away_in_a_row_and_nothing_else_earns_the_tempo(self):
        tempo = "Here we go..."
        self.assertIn(tempo, flags.earned([match([game(['dx' * 5, 'fe'])])], 'account:me'))
        # (someone's guess along the way is not a move of your hand)
        self.assertIn(tempo, flags.earned([match([game(['dxdxgdxdxdx', 'fe'])])], 'account:me'))
        for moves in ('dx' * 4, 'dx' * 5 + 'ds', 'fe' + 'dx' * 5, 'dxdxdxdxds' + 'dx'):
            self.assertNotIn(tempo, flags.earned([match([game([moves, 'fe'])])], 'account:me'))

    def test_the_move_flags_need_a_game_against_people(self):
        moves = [game(['fefefe', 'fefefe'])]
        for other in (match(moves, (ME, BOT), solo=True), match(moves, local=True), match(moves, (ME, BOT))):
            self.assertEqual(flags.earned([other], 'account:me'), {})
        self.assertEqual(flags.earned([match(moves)], 'account:nobody'), {})

    def test_777s_in_any_game_earn_lets_go_gambling(self):
        solo = match([game(['', ''], 3, subrule_activations=[['angel_numbers:777'], []])], (ME, BOT), solo=True)
        self.assertEqual(flags.earned([solo], 'account:me'), {"Let's go gambling!": 3})
        self.assertEqual(flags.earned([solo], 'bot:golfbot'), {})
        other = match([game(['', ''], subrule_activations=[['angel_numbers:666'], ['angel_numbers:777']])])
        self.assertEqual(flags.earned([other], 'account:me'), {})

    def test_fifty_solo_games_in_a_row_earn_adult_swim(self):
        solo = lambda start, count: match([{'ended_at': start + i} for i in range(count)], (ME, BOT), solo=True)
        self.assertEqual(flags.earned([solo(0, 50)], 'account:me'), {"Adult swim": 49})
        self.assertEqual(flags.earned([solo(0, 49)], 'account:me'), {})
        # (a game against people in between starts the count again)
        broken = [solo(0, 30), match([{'ended_at': 30.5}]), solo(31, 30)]
        self.assertEqual(flags.earned(broken, 'account:me'), {})
        self.assertEqual(flags.earned(broken + [solo(100, 20)], 'account:me'), {"Adult swim": 119})

    def test_ten_hands_of_black_suited_rows_all_in_black_earn_back_in_black(self):
        black = lambda at: game(['', ''], at, subrule_activations=[['all_in_color:black', 'suited_rows:black'], []])
        solo = lambda hands: match(hands, (ME, BOT), solo=True)
        self.assertEqual(flags.earned([solo([black(i) for i in range(10)])], 'account:me'), {"Black out!": 9})
        nine = flags.standing([solo([black(i) for i in range(9)])], 'account:me')["Black out!"]
        self.assertEqual(nine, (None, 0.9))
        # (both in the same hand: one without the other is not counted)
        apart = [game(['', ''], i, subrule_activations=[[part], []]) for i, part in
                 enumerate(['all_in_color:black', 'suited_rows:black'] * 10)]
        self.assertEqual(flags.standing([solo(apart)], 'account:me')["Black out!"], (None, 0))
        red = [game(['', ''], i, subrule_activations=[['all_in_color:red', 'suited_rows:red'], []]) for i in range(10)]
        self.assertEqual(flags.earned([solo(red)], 'account:me'), {})

    def test_ten_games_ended_with_a_heart_flush_earn_heartthrob(self):
        hearts = lambda at: game(['', ''], at, subrule_activations=[['holdem:flush', 'holdem:flush_hearts'], []])
        people = match([hearts(i) for i in range(10)])
        self.assertEqual(flags.earned([people], 'account:me')["Cupid's porcelain throne"], 9)
        self.assertEqual(flags.standing([match([hearts(i) for i in range(4)])], 'account:me')["Cupid's porcelain throne"], (None, 0.4))
        # (any flush is not enough: it has to be hearts)
        spades = [game(['', ''], i, subrule_activations=[['holdem:flush'], []]) for i in range(10)]
        self.assertNotIn("Cupid's porcelain throne", flags.earned([match(spades)], 'account:me'))

    def test_ten_games_with_the_ripped_five_earn_rip_it_up(self):
        torn = lambda at, mine=True: game(['', ''], at, activations=[['ripped_five'] if mine else [], ['ripped_five']])
        self.assertEqual(flags.earned([match([torn(i) for i in range(3)])], 'account:me')["Tear it up!"], 2)
        self.assertEqual(flags.standing([match([torn(i) for i in range(2)])], 'account:me')["Tear it up!"], (None, 2 / 3))
        # (the opponent's ripped 5 is theirs, not yours)
        self.assertNotIn("Tear it up!", flags.earned([match([torn(i, False) for i in range(10)])], 'account:me'))
        self.assertEqual(flags.unlocked(["Tear it up!"], 'card'), ['ripped-5d'])

    def test_five_games_ended_with_a_fantastic_four_earn_the_flag(self):
        four = lambda at: game(['', ''], at, subrule_activations=[['four_kind:final', 'four_kind:kept'], []])
        self.assertEqual(flags.earned([match([four(i) for i in range(5)])], 'account:me')["5 Fantastic 4s"], 4)
        self.assertEqual(flags.standing([match([four(i) for i in range(2)])], 'account:me')["5 Fantastic 4s"], (None, 0.4))
        # (offered during the game, but not in the hand it ended with: not counted)
        offered = [game(['', ''], i, subrule_activations=[['four_kind:moved'], []]) for i in range(5)]
        self.assertNotIn("5 Fantastic 4s", flags.earned([match(offered)], 'account:me'))

    def test_a_game_finished_between_eleven_and_six_earns_just_one_more_game(self):
        name = "Just one more game"
        at = lambda hours: match([game(['', ''], 8, local_hours=hours)], (ME, BOT), solo=True)
        for hour in (23, 0, 3, 5):
            self.assertEqual(flags.earned([at([hour, None])], 'account:me').get(name), 8)
        # (six o'clock, ten at night, the other seat's hour, or an hour not known: no)
        for hours in ([6, None], [22, None], [12, 2], [None, 2], None):
            self.assertNotIn(name, flags.earned([at(hours)], 'account:me'))

    def test_a_hundred_pvp_games_lost_earn_washed(self):
        lost = lambda at, winner=1: game(['', ''], at, winner=winner)
        self.assertEqual(flags.earned([match([lost(i) for i in range(100)])], 'account:me')["Washed?"], 99)
        self.assertEqual(flags.standing([match([lost(i) for i in range(25)])], 'account:me')["Washed?"], (None, 0.25))
        # (won, drawn, or lost to Golfbot: not counted)
        others = [match([lost(i, 0) for i in range(50)] + [lost(i, None) for i in range(50)]),
                  match([lost(i) for i in range(100)], (ME, BOT), solo=True)]
        self.assertEqual(flags.standing(others, 'account:me')["Washed?"], (None, 0))

    def test_spamming_an_emote_in_a_game_earns_chat_disabled(self):
        name = "Chat disabled for 3s."
        self.assertEqual(flags.earned([match([game(['', ''], 6, emote_spam=[True, False])])], 'account:me'), {name: 6})
        for spam in ([False, True], None):
            self.assertNotIn(name, flags.earned([match([game(['', ''], 6, emote_spam=spam)])], 'account:me'))

    def test_three_ranked_matches_earn_ranked_up(self):
        ranked = lambda end, rated=True: match([game(['', ''], end - 1), game(['', ''], end)], rated=rated)
        self.assertEqual(flags.earned([ranked(10), ranked(20), ranked(30)], 'account:me')["No longer a casual"], 30)
        # (each match once, however many games in it; casual ones not at all)
        self.assertEqual(flags.standing([ranked(10), ranked(20, False), ranked(30, False)], 'account:me')["No longer a casual"], (None, 1 / 3))
        self.assertEqual(flags.standing([match([], rated=True)], 'account:me')["No longer a casual"], (None, 0))

    def test_five_rules_in_play_in_a_final_hand_earn_take_five(self):
        five = {'holdem': 1, 'suited_rows': 2, 'all_in_color': 1, 'king_queen': 1, 'v10': 1}
        hand = lambda counts: match([game(['', ''], 7, modifier_counts=[counts, five])])
        self.assertEqual(flags.earned([hand(five)], 'account:me').get("Take 5!"), 7)
        # (four rules, however many times each, or the opponent's five: no)
        four = {'holdem': 1, 'suited_rows': 3, 'all_in_color': 1, 'king_queen': 2}
        for counts in (four, {}, None):
            self.assertNotIn("Take 5!", flags.earned([hand(counts)], 'account:me'))

    def test_three_wins_with_someone_watching_earn_is_it(self):
        won = lambda at, watching=1, winner=0: game(['', ''], at, winner=winner, spectators=watching)
        self.assertEqual(flags.earned([match([won(i) for i in range(3)])], 'account:me')["Under Pressure"], 2)
        # (a win nobody watched, or a watched loss: not counted)
        others = [won(0, 0), won(1, 2, 1), won(2), won(3, None)]
        self.assertEqual(flags.standing([match(others)], 'account:me')["Under Pressure"], (None, 1 / 3))

    def test_five_minutes_of_play_earn_good_sport(self):
        timed = lambda start, end: {'started_at': start, 'ended_at': end}
        # two minutes, then four: the five come in the second game
        self.assertEqual(flags.earned([match([timed(0, 120), timed(200, 440)], (ME, BOT), solo=True)], 'account:me')["Good Sport"], 440)
        self.assertEqual(flags.standing([match([timed(0, 150)])], 'account:me')["Good Sport"], (None, 0.5))
        # (a game left open for hours counts for half an hour at most; pass & play not at all)
        self.assertEqual(flags.standing([match([timed(0, 99999)], local=True)], 'account:me')["Good Sport"], (None, 0))

    def test_how_far_along_each_flag_is(self):
        standing = flags.standing([match([game(['dxdxdxfe', 'fe'], 1), game(['dxdxdx', 'fe'], 2)])], 'account:me')
        self.assertEqual(standing["Here we go..."], (None, 0.6))  # three in a row (the game with a flip is not counted)
        self.assertEqual(standing["Wait for my cue..."], (None, 0))
        self.assertEqual(standing["Adult swim"], (None, 0))
        solo = match([{'ended_at': i} for i in range(20)], (ME, BOT), solo=True)
        self.assertEqual(flags.standing([solo], 'account:me')["Adult swim"], (None, 0.4))
        self.assertEqual(flags.standing([match([game(['fefe', ''], 4)])], 'account:me')["Wait for my cue..."], (4, 1))
        self.assertEqual(set(flags.standing([], None)), set(flags.FLAGS))

    def test_what_each_flag_unlocks(self):
        names = list(flags.FLAGS)
        self.assertEqual(flags.unlocked_emotes(names), ['crocscreech', 'dragging', 'gg', 'giveheart', 'isit', 'pogcat', 'poop', 'ranked', 'rushing', 'save'])
        self.assertEqual(flags.unlocked(names, 'theme'), ['focus', 'night', 'poker', 'pool'])
        self.assertEqual(flags.FLAG_THEMES, {'poker': "Let's go gambling!", 'pool': 'Adult swim', 'focus': 'Black out!',
                                             'night': 'Just one more game'})


class FinalHandTests(unittest.TestCase):
    def test_a_heart_flush_in_the_final_hand_is_recorded_at_the_end_only(self):
        from game import Card, Rules, Slot
        import scoring
        hand = lambda suits: [Slot(Card(rank, suit), True) for rank, suit in zip((2, 4, 6, 8, 10, 12), suits)]
        holdem = Rules(holdem=True)
        self.assertEqual(scoring.final_hand_keys(hand("HHHHHS"), holdem), {'holdem:flush_hearts'})
        self.assertEqual(scoring.final_hand_keys(hand("HHHHSS"), holdem), set())
        self.assertEqual(scoring.final_hand_keys(hand("SSSSSS"), holdem), set())
        self.assertEqual(scoring.final_hand_keys(hand("HHHHHH"), Rules()), set())
        quads = [Slot(Card(rank, suit), True) for rank, suit in zip((7, 7, 7, 7, 2, 3), "SHDCSH")]
        self.assertEqual(scoring.final_hand_keys(quads, Rules(four_kind=True)), {'four_kind:final'})
        self.assertEqual(scoring.final_hand_keys(quads, Rules()), set())


class NameTests(unittest.TestCase):
    def test_display_names_take_emoji_and_stop_at_twelve_characters(self):
        import server
        self.assertEqual(server.clean_display_name("  Golfer 🏌️‍♀️  "), "Golfer 🏌️‍♀️")
        self.assertEqual(len(server.name_characters("👍🏽🇺🇸👨‍👩‍👧")), 3)
        self.assertEqual(server.clean_display_name("abcdefghijklmnop"), "abcdefghijkl")
        self.assertEqual(server.name_characters(server.clean_display_name("🎉" * 20)), ["🎉"] * 12)

    def test_unique_names_are_letters_numbers_and_underscores_up_to_twelve(self):
        import accounts
        for good in ("abc", "golf_fan_123"):
            self.assertTrue(accounts.UNIQUE_NAME.fullmatch(good))
        for bad in ("ab", "golf_fan_1234", "golf🏌️", "golfé"):
            self.assertIsNone(accounts.UNIQUE_NAME.fullmatch(bad))


class ClockTests(unittest.TestCase):
    def test_the_hour_a_game_ends_is_where_each_player_is(self):
        import server
        self.addCleanup(server.PLAYER_ZONES.clear)
        client = TestClient(create_app(Store()))
        self.addCleanup(client.close)
        client.get('/api/session')
        self.assertEqual(client.post('/api/clock', json={'zone': 'Not/AZone'}).status_code, 422)
        self.assertEqual(client.post('/api/clock', json={'zone': 'America/New_York'}).status_code, 200)
        [(player, zone)] = server.PLAYER_ZONES.items()
        self.assertEqual(zone, 'America/New_York')
        # (half past three in the morning there: 08:30 UTC in January)
        self.assertEqual(server.local_hour(player, 1736497800), 3)
        self.assertIsNone(server.local_hour('account:nobody', 1736497800))


class FlagServerTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.app = create_app(self.store)
        self.context = ExitStack()
        self.addCleanup(self.context.close)
        self.host = self.context.enter_context(TestClient(self.app))
        self.guest = TestClient(self.app)
        self.addCleanup(self.guest.close)
        for client in (self.host, self.guest):
            client.get('/api/session')
        response = self.host.post('/api/lobbies', json={'username': 'Alex', 'name': 'Test table'})
        self.id = response.json()['id']
        self.room = self.store.rooms[self.id]
        self.assertEqual(self.guest.post(f'/api/lobbies/{self.id}/join', json={'username': 'Sam'}).status_code, 200)
        self.clients = (self.host, self.guest)
        for client in self.clients:
            for index in (0, 1):
                self.move(client, 'flip', index=index)

    def move(self, client, action, **extra):
        response = client.post(f'/api/lobbies/{self.id}/action', json={'action': action, 'version': self.room.version, **extra})
        self.assertEqual(response.status_code, 200, response.text)

    def test_each_seats_moves_are_logged_for_the_flags_and_saved_with_the_game(self):
        # (the opening reveal is not counted)
        self.assertEqual(self.room.move_log, [[], []])
        seat = self.room.game.current
        client = self.clients[seat]
        hidden = next(i for i, slot in enumerate(self.room.game.players[seat]) if not slot.visible)
        self.move(client, 'flip', index=hidden)
        self.move(client, 'end_turn')
        self.assertEqual(self.room.move_log[seat], ['f', 'e'])
        other = 1 - seat
        self.move(self.clients[other], 'draw')
        self.move(self.clients[other], 'discard')
        self.assertEqual(self.room.move_log[other], ['d', 'x'])

    def test_the_same_emote_three_times_in_two_seconds_while_playing_is_saved_as_spam(self):
        from unittest import mock
        import server
        path = f'/api/lobbies/{self.id}/emote'
        seat = 0  # (the host)
        now = [100.0]

        def send(emote, at):
            now[0] = at
            self.assertEqual(self.host.post(path, json={'emote': emote}).status_code, 200)

        with mock.patch.object(server.time, 'time', lambda: now[0]):
            for emote, at in (('wow', 100.0), ('oops', 100.5), ('wow', 101.0)):  # (not three of one)
                send(emote, at)
            self.assertFalse(self.room.emote_spam[seat])
            for at in (200.0, 201.0, 203.0):  # (three of one, but over three seconds)
                send('luck', at)
            self.assertFalse(self.room.emote_spam[seat])
            for at in (300.0, 300.6, 301.2):
                send('luck', at)
            self.assertTrue(self.room.emote_spam[seat])
            # (on the results screen it does not count)
            self.room.emote_spam[seat] = False
            self.room.status = 'round_over'
            for at in (400.0, 400.1, 400.2):
                send('luck', at)
            self.assertFalse(self.room.emote_spam[seat])

    def test_a_flags_emote_is_sent_only_once_it_is_earned(self):
        path = f'/api/lobbies/{self.id}/emote'
        self.assertEqual(self.host.get('/api/flags').json(), {'earned': [], 'emotes': [], 'themes': [], 'cards': [],
                                                              'progress': {name: 0 for name in flags.FLAGS}})
        self.assertEqual(self.host.post(path, json={'emote': 'rushing'}).status_code, 403)
        self.assertEqual(self.host.post(path, json={'emote': 'luck'}).status_code, 200)
        # a finished game of nothing but flips, saved
        self.room.history = [game(['fefefefe', 'dxdxdx'], 5, scores=[10, 20], winner=0)]
        self.store.history.save(self.room)
        mine = self.host.get('/api/flags').json()
        self.assertEqual(mine['earned'], ["Wait for my cue..."])
        self.assertEqual(mine['emotes'], ['rushing'])
        self.assertEqual(mine['progress']["Wait for my cue..."], 100)
        self.assertEqual(mine['progress']["Here we go..."], 0)
        self.assertEqual(self.host.post(path, json={'emote': 'rushing'}).status_code, 200)
        self.assertEqual(self.guest.post(path, json={'emote': 'rushing'}).status_code, 403)
        profile = self.guest.get('/api/profile', params={'player': self.room.participants[0]['id']}).json()
        self.assertEqual(profile['flags'], ["Wait for my cue..."])


if __name__ == '__main__':
    unittest.main()
