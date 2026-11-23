"""The Leaderboard's all-time records."""
import time
import unittest

from records import build_records, most_games_today, personal_records, player_card, time_played


def match(rounds, names=('Ann', 'Bob')):
    return {'names': list(names), 'participants': [None] * len(names), 'rounds': rounds}


class RecordTests(unittest.TestCase):
    def test_empty_history_has_no_records(self):
        self.assertEqual(build_records([]), {'highest_mmr': None, 'comeback': None, 'most_modifier': None,
                                             'ai_vs_players': None, 'luck': None, 'gospel': None, 'spectacle': None,
                                             'recruit': None, 'upset': None,
                                             'least_modifier': None, 'comeback_modifier': None,
                                             'pvp_streak': None, 'games_today': None, 'modifiers_in_game': None, 'most_time': None,
                                             'yapper': None, 'longest_pvp': None, 'bogey': None, 'lowest': None, 'party': None,
                                             'always_in_play': ['Poisoned Card']})

    def test_highest_mmr_counts_past_peaks_and_current_ratings_but_not_the_old_elo(self):
        results = [match([{'mmr': [{'id': 'a', 'label': 'Ann', 'after': 1040}, {'id': 'b', 'label': 'Bob', 'after': 960}]},
                          {'mmr': [{'id': 'a', 'label': 'Ann', 'after': 1010}, {'id': 'b', 'label': 'Bob', 'after': 990}]},
                          # Elo from before 1.4.0 was another scale: never a record
                          {'elo': [{'id': 'a', 'label': 'Ann', 'after': 1500}, {'id': 'b', 'label': 'Bob', 'after': 500}]}])]
        self.assertEqual(build_records(results)['highest_mmr']['mmr'], 1040)
        self.assertEqual(build_records(results, [{'id': 'c', 'label': 'Cy', 'mmr': 1100}])['highest_mmr']['label'], 'Cy')

    def test_comeback_is_the_winners_largest_deficit(self):
        results = [match([{'winner': 1, 'scores': [12, 9], 'timeline': [[4, 4], [5, 19], [10, 12]]},
                          {'winner': 0, 'scores': [3, 9], 'timeline': [[2, 20]]},  # never behind
                          {'winner': None, 'scores': [5, 5], 'timeline': [[0, 30]]}])]  # a draw
        comeback = build_records(results)['comeback']
        self.assertEqual((comeback['label'], comeback['points'], comeback['opponents']), ('Bob', 14, ['Ann']))

    def test_comeback_modifier_counts_only_the_winners_modifiers_in_comeback_wins(self):
        comeback = lambda winner, active: {'winner': winner, 'timeline': [[20, 5], [5, 20]] if winner == 0 else [[5, 20], [20, 5]],
                                            'activations': active}
        results = [match([comeback(0, [['angel_numbers', 'royal_pairs'], ['king_queen']]),
                          comeback(1, [['angel_numbers'], ['royal_pairs']]),
                          {'winner': 0, 'timeline': [[1, 9]], 'activations': [['angel_numbers'], []]}])]  # never behind
        record = build_records(results)['comeback_modifier']
        self.assertEqual((record['key'], record['wins']), ('royal_pairs', 2))

    def test_rules_in_play_every_game_never_top_most_common(self):
        game = {'rules': {'poisoned_card': True, 'royal_pairs': True}, 'activations': [['poisoned_card'], ['royal_pairs']]}
        quiet = {'rules': {'poisoned_card': True, 'royal_pairs': True}, 'activations': [['poisoned_card'], []]}
        records = build_records([match([game, quiet])])
        self.assertEqual(records['most_modifier']['key'], 'royal_pairs')

    def test_most_common_is_the_most_activated_beggars_included(self):
        # Angel Numbers is on in only two games but activated by both players each time;
        # Royal Pairs is on in every game but activated less often in total
        often = {'rules': {'royal_pairs': True, 'angel_numbers': True},
                 'activations': [['angel_numbers'], ['angel_numbers']]}
        rare = {'rules': {'royal_pairs': True}, 'activations': [['royal_pairs'], []]}
        most = build_records([match([often, often, rare, rare])])['most_modifier']
        self.assertEqual((most['key'], most['activations']), ('angel_numbers', 4))
        # Beggars Will be Choosers counts like any other modifier
        begged = {'rules': {'beggars': True}, 'activations': [['beggars'], ['beggars']]}
        most = build_records([match([often, often, rare, rare, begged, begged, begged])])['most_modifier']
        self.assertEqual((most['key'], most['activations']), ('beggars', 6))

    def test_your_most_common_modifier_also_leaves_out_poisoned_card(self):
        game = {'rules': {'poisoned_card': True, 'royal_pairs': True}, 'scores': [1, 2],
                'activations': [['poisoned_card', 'royal_pairs'], ['poisoned_card']]}
        poisoned = {'rules': {'poisoned_card': True}, 'scores': [1, 2], 'activations': [['poisoned_card'], []]}
        mine = personal_records([match([game, poisoned, poisoned])], [], 'player:Ann')['most_modifier']
        self.assertEqual((mine['key'], mine['activations']), ('royal_pairs', 1))
        self.assertIsNone(personal_records([match([game])], [], 'player:Bob')['most_modifier'])

    def test_pvp_streak_counts_1v1_wins_in_a_row_against_people_only(self):
        won = lambda winner, at: {'winner': winner, 'scores': [1, 2], 'ended_at': at}
        results = [match([won(0, 1), won(0, 2), won(1, 3), won(0, 4)]),  # Ann: 2, then broken
                   match([won(0, 5), won(0, 6), won(0, 7)], names=('Bob', 'Cy')),  # Bob: 3
                   {**match([won(0, 8)] * 5), 'solo': True}]  # wins against Golfbot never count
        streak = build_records(results)['pvp_streak']
        self.assertEqual((streak['label'], streak['streak']), ('Bob', 3))

    def test_personal_records_are_each_players_own_bests(self):
        won = lambda winner, at, scores=(1, 2): {'winner': winner, 'scores': list(scores), 'ended_at': at}
        results = [match([won(0, 1, (4, 9)), won(1, 2, (12, 3)), won(0, 3, (-2, 8))]),
                   match([won(0, 4, (20, 25))], names=('Bob', 'Cy'))]
        ratings = [{'id': 'player:Ann', 'label': 'Ann', 'mmr': 1030}, {'id': 'player:Bob', 'label': 'Bob', 'mmr': 1080}]
        bob = personal_records(results, ratings, 'player:Bob')
        self.assertEqual(bob['id'], 'player:Bob')
        # Bob's own: not the table's lowest (-2, Ann's) but his, 3
        self.assertEqual((bob['lowest']['points'], bob['bogey']['points'], bob['highest_mmr']['mmr']), (3, 20, 1080))
        self.assertEqual(bob['pvp_streak']['streak'], 1)
        cy = personal_records(results, ratings, 'player:Cy')
        self.assertEqual((cy['highest_mmr'], cy['pvp_streak'], cy['lowest']['points']), (None, None, 25))
        self.assertEqual(personal_records(results, ratings, 'bot:golfbot'), {})

    def test_player_card_has_mmr_own_best_streak_and_only_records_held(self):
        won = lambda winner, at: {'winner': winner, 'scores': [1, 2], 'ended_at': at}
        results = [match([won(0, 1), won(0, 2), won(1, 3), won(0, 4)]),  # Ann: 2
                   match([won(0, 5), won(0, 6), won(0, 7)], names=('Bob', 'Cy'))]  # Bob: 3
        ratings = [{'id': 'player:Ann', 'label': 'Ann', 'mmr': 1080, 'provisional': True}, {'id': 'player:Bob', 'label': 'Bob', 'mmr': 1010}]
        ann = player_card(results, ratings, 'player:Ann')
        self.assertEqual((ann['mmr'], ann['provisional'], ann['pvp_streak']), (1080, True, 2))
        # Ann also finished a game on the fewest points anyone has (1, reached first)
        self.assertEqual(set(ann['records']), {'highest_mmr', 'lowest'})
        bob = player_card(results, ratings, 'player:Bob')
        # Bob also finished a game on the most points anyone has (2, reached first)
        self.assertEqual((bob['mmr'], bob['pvp_streak'], set(bob['records'])), (1010, 3, {'pvp_streak', 'most_time', 'bogey'}))
        self.assertEqual(player_card(results, ratings, 'player:Nobody'), {'id': 'player:Nobody', 'mmr': None, 'provisional': False, 'pvp_streak': 0, 'seconds_played': 0, 'records': {}})

    def test_the_records_added_in_1_4_0(self):
        solo = lambda scores, **extra: {'winner': scores.index(min(scores)), 'scores': scores, 'ended_at': 5, **extra}
        golfbot = {'id': 'bot:golfbot', 'kind': 'bot', 'display_name': 'Golfbot'}
        ann, bob = ({'id': f'account:{name}', 'kind': 'account', 'display_name': name.title()} for name in ('ann', 'bob'))
        # Ann against Golfbot: 21 games with a random first turn, 14 of them hers
        games = [solo([3, 9], first=0 if game < 14 else 1, first_random=True, spectators=game % 3) for game in range(21)]
        games.append(solo([1, 0], forfeit=True, first=0, first_random=True))  # a forfeit is no game
        results = [{'names': ['Ann', 'Golfbot'], 'solo': True, 'participants': [ann, golfbot], 'rounds': games, 'started_at': 100},
                   # Bob always chose to go first: that is no luck
                   {'names': ['Bob', 'Golfbot'], 'solo': True, 'participants': [bob, golfbot], 'started_at': 50,
                    'rounds': [solo([8, 2], first=0, first_random=False) for _ in range(30)]},
                   # a rated series the lower-rated player won, 6 points to 14
                   {'names': ['Ann', 'Bob'], 'participants': [ann, bob], 'status': 'finished', 'winner': 1, 'points': [14, 6],
                    'rounds': [{'winner': 1, 'scores': [14, 6], 'ended_at': 9, 'spectators': 4, 'series_winner': 1,
                                'mmr': [{'id': ann['id'], 'label': 'Ann', 'before': 1180, 'after': 1100},
                                        {'id': bob['id'], 'label': 'Bob', 'before': 950, 'after': 1030}]}]},
                   # an older series rated by Elo counts too, by the Elo each had at its first game
                   {'names': ['Ann', 'Bob'], 'participants': [ann, bob], 'status': 'finished', 'winner': 0, 'points': [3, 9],
                    'rounds': [{'winner': 0, 'scores': [3, 9], 'elo': [{'id': ann['id'], 'before': 990, 'after': 1006},
                                                                      {'id': bob['id'], 'before': 1040, 'after': 1024}]}]},
                   # the higher-rated player being left to it is no upset
                   {'names': ['Ann', 'Bob'], 'participants': [ann, bob], 'status': 'abandoned', 'winner': None, 'points': [1, 0],
                    'rounds': [{'winner': 0, 'scores': [0, 1], 'forfeit': True, 'series_winner': 0, 'series_forfeit': 1,
                                'mmr': [{'id': ann['id'], 'before': 600, 'after': 700}, {'id': bob['id'], 'before': 1500, 'after': 1400}]}]}]
        extras = {'invites': [{'id': bob['id'], 'label': 'bob', 'count': 3, 'at': 7}, {'id': ann['id'], 'label': 'ann', 'count': 1, 'at': 9}],
                  'newest': {'id': bob['id'], 'unique_name': 'bob', 'display_name': 'Bob', 'created_at': None}}
        records = build_records(results, extras=extras)
        ai = records['ai_vs_players']
        self.assertEqual((ai['id'], ai['bot_points'], ai['player_points'], ai['games']), ('bot:golfbot', 21 * 9 + 30 * 2, 21 * 3 + 30 * 8, 51))
        luck = records['luck']
        self.assertEqual((luck['label'], luck['first'], luck['games']), ('Ann', 14, 21))
        self.assertAlmostEqual(luck['rate'], 2 / 3)
        self.assertEqual((records['gospel']['label'], records['gospel']['count']), ('bob', 3))
        spectacle = records['spectacle']
        self.assertEqual((spectacle['count'], spectacle['players'], spectacle['scores'], spectacle['label']), (4, ['Ann', 'Bob'], [14, 6], 'Bob'))
        # no creation date was kept for Bob's account: the day of his first game stands in
        self.assertEqual(records['recruit'], {'id': bob['id'], 'label': 'Bob', 'unique_name': 'bob', 'at': 50})
        upset = records['upset']
        self.assertEqual((upset['label'], upset['opponent'], upset['gap'], upset['ratings'], upset['points'], upset['winner']),
                         ('Bob', 'Ann', 230, [950, 1180], [14, 6], 1))
        # Golfbot holds the AI record; the others are held by people
        self.assertEqual(set(player_card(results, [], 'bot:golfbot', extras)['records']), {'ai_vs_players'})
        self.assertEqual(set(player_card(results, [], bob['id'], extras)['records']) & {'gospel', 'recruit', 'upset', 'spectacle', 'luck'},
                         {'gospel', 'recruit', 'upset', 'spectacle'})

    def test_comeback_modifier_leaves_out_the_poisoned_card(self):
        comeback = lambda keys: {'winner': 0, 'scores': [3, 9], 'timeline': [[20, 2]], 'activations': [keys, []]}
        results = [match([comeback(['poisoned_card']), comeback(['poisoned_card', 'suited_rows']), comeback(['poisoned_card'])])]
        self.assertEqual(build_records(results)['comeback_modifier']['key'], 'suited_rows')
        self.assertIsNone(build_records([match([comeback(['poisoned_card'])])])['comeback_modifier'])

    def test_time_played_counts_each_game_for_its_players_capped_and_never_bots(self):
        timed = lambda start, end: {'winner': 0, 'scores': [1, 2], 'started_at': start, 'ended_at': end}
        results = [
            # recorded starts: 5 and 10 minutes
            match([timed(1000, 1300), timed(2000, 2600)]),
            # older games with no start: timed from the series' start, then from the game before
            {**match([{'winner': 0, 'scores': [1, 2], 'ended_at': 5240}, {'winner': 0, 'scores': [1, 2], 'ended_at': 5480}],
                     names=('Ann', 'Cy')), 'started_at': 5000},
            # a table left open all night counts for 30 minutes at most
            match([timed(0, 20000)], names=('Cy', 'Dee')),
            # Golfbot is never timed
            {**match([timed(0, 60)], names=('Ann', 'Golfbot')), 'solo': True},
        ]
        totals = time_played(results)
        self.assertEqual(totals['player:Ann']['seconds'], 300 + 600 + 240 + 240 + 60)
        self.assertEqual(totals['player:Bob']['seconds'], 900)
        self.assertEqual(totals['player:Cy']['seconds'], 480 + 1800)
        self.assertNotIn('bot:golfbot', totals)
        most = build_records(results)['most_time']
        self.assertEqual((most['label'], most['seconds']), ('Cy', 2280))
        self.assertEqual(player_card(results, [], 'player:Ann')['seconds_played'], 1440)

    def test_most_games_today_skips_earlier_days_and_bots(self):
        now = time.time()
        today, yesterday = now - 60, now - 3 * 86400
        game = lambda at: {'winner': 0, 'scores': [1, 2], 'ended_at': at}
        results = [match([game(today), game(today)]), match([game(today)], names=('Cy', 'Ann')),
                   match([game(yesterday)] * 5, names=('Dee', 'Eve'))]
        record = most_games_today(results, now)
        self.assertEqual((record['label'], record['games']), ('Ann', 3))

    def test_most_modifiers_in_a_single_game(self):
        game = {'winner': 0, 'scores': [1, 2], 'activations': [['royal_pairs', 'angel_numbers'], ['holdem', 'v10', 'beggars']]}
        record = build_records([match([game])])['modifiers_in_game']
        self.assertEqual((record['label'], record['count']), ('Bob', 3))

    def test_modifiers_rank_by_how_often_they_come_into_play_when_on(self):
        game = lambda active: {'rules': {'royal_pairs': True, 'angel_numbers': True, 'beggars': False},
                               'activations': [active, []]}
        results = [match([game(['royal_pairs']), game(['royal_pairs', 'angel_numbers']), game([])])]
        records = build_records(results)
        self.assertEqual((records['most_modifier']['key'], records['most_modifier']['active']), ('royal_pairs', 2))
        self.assertEqual((records['least_modifier']['key'], records['least_modifier']['games']), ('angel_numbers', 3))


if __name__ == '__main__':
    unittest.main()
