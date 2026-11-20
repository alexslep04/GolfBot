"""The Leaderboard's all-time records."""
import time
import unittest

from records import build_records, most_games_today, player_card, time_played


def match(rounds, names=('Ann', 'Bob')):
    return {'names': list(names), 'participants': [None] * len(names), 'rounds': rounds}


class RecordTests(unittest.TestCase):
    def test_empty_history_has_no_records(self):
        self.assertEqual(build_records([]), {'highest_elo': None, 'comeback': None, 'most_modifier': None,
                                             'least_modifier': None, 'comeback_modifier': None,
                                             'pvp_streak': None, 'games_today': None, 'modifiers_in_game': None, 'most_time': None,
                                             'yapper': None, 'longest_pvp': None, 'bogey': None, 'party': None,
                                             'always_in_play': ['Poisoned Card'],
                                             'never_most': ['Beggars Will be Choosers']})

    def test_highest_elo_counts_past_peaks_and_current_ratings(self):
        results = [match([{'elo': [{'id': 'a', 'label': 'Ann', 'after': 1040}, {'id': 'b', 'label': 'Bob', 'after': 960}]},
                          {'elo': [{'id': 'a', 'label': 'Ann', 'after': 1010}, {'id': 'b', 'label': 'Bob', 'after': 990}]}])]
        self.assertEqual(build_records(results)['highest_elo']['elo'], 1040)
        self.assertEqual(build_records(results, [{'id': 'c', 'label': 'Cy', 'elo': 1100}])['highest_elo']['label'], 'Cy')

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

    def test_most_common_is_the_most_activated_never_beggars(self):
        # Devil's Row is on in only one game but activated by both players twice over;
        # Royal Pairs is on in every game but activated less often in total
        often = {'rules': {'royal_pairs': True, 'angel_numbers': True, 'beggars': True},
                 'activations': [['angel_numbers', 'beggars'], ['angel_numbers', 'beggars']]}
        rare = {'rules': {'royal_pairs': True, 'beggars': True}, 'activations': [['royal_pairs', 'beggars'], ['beggars']]}
        records = build_records([match([often, often, rare, rare])])
        most = records['most_modifier']
        self.assertEqual((most['key'], most['activations']), ('angel_numbers', 4))

    def test_pvp_streak_counts_1v1_wins_in_a_row_against_people_only(self):
        won = lambda winner, at: {'winner': winner, 'scores': [1, 2], 'ended_at': at}
        results = [match([won(0, 1), won(0, 2), won(1, 3), won(0, 4)]),  # Ann: 2, then broken
                   match([won(0, 5), won(0, 6), won(0, 7)], names=('Bob', 'Cy')),  # Bob: 3
                   {**match([won(0, 8)] * 5), 'solo': True}]  # wins against Golfbot never count
        streak = build_records(results)['pvp_streak']
        self.assertEqual((streak['label'], streak['streak']), ('Bob', 3))

    def test_player_card_has_elo_own_best_streak_and_only_records_held(self):
        won = lambda winner, at: {'winner': winner, 'scores': [1, 2], 'ended_at': at}
        results = [match([won(0, 1), won(0, 2), won(1, 3), won(0, 4)]),  # Ann: 2
                   match([won(0, 5), won(0, 6), won(0, 7)], names=('Bob', 'Cy'))]  # Bob: 3
        ratings = [{'id': 'player:Ann', 'label': 'Ann', 'elo': 1080}, {'id': 'player:Bob', 'label': 'Bob', 'elo': 1010}]
        ann = player_card(results, ratings, 'player:Ann')
        self.assertEqual((ann['elo'], ann['pvp_streak']), (1080, 2))
        self.assertEqual(set(ann['records']), {'highest_elo'})
        bob = player_card(results, ratings, 'player:Bob')
        # Bob also finished a game on the most points anyone has (2, reached first)
        self.assertEqual((bob['elo'], bob['pvp_streak'], set(bob['records'])), (1010, 3, {'pvp_streak', 'most_time', 'bogey'}))
        self.assertEqual(player_card(results, ratings, 'player:Nobody'), {'id': 'player:Nobody', 'elo': None, 'pvp_streak': 0, 'seconds_played': 0, 'records': {}})

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
