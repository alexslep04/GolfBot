"""The Leaderboard's all-time records."""
import time
import unittest

from records import build_records, most_games_today


def match(rounds, names=('Ann', 'Bob')):
    return {'names': list(names), 'participants': [None] * len(names), 'rounds': rounds}


class RecordTests(unittest.TestCase):
    def test_empty_history_has_no_records(self):
        self.assertEqual(build_records([]), {'highest_elo': None, 'comeback': None, 'most_modifier': None,
                                             'least_modifier': None, 'comeback_modifier': None,
                                             'pvp_streak': None, 'games_today': None, 'modifiers_in_game': None,
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
        results = [match([comeback(0, [['devils_row', 'royal_pairs'], ['king_queen']]),
                          comeback(1, [['devils_row'], ['royal_pairs']]),
                          {'winner': 0, 'timeline': [[1, 9]], 'activations': [['devils_row'], []]}])]  # never behind
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
        often = {'rules': {'royal_pairs': True, 'devils_row': True, 'beggars': True},
                 'activations': [['devils_row', 'beggars'], ['devils_row', 'beggars']]}
        rare = {'rules': {'royal_pairs': True, 'beggars': True}, 'activations': [['royal_pairs', 'beggars'], ['beggars']]}
        records = build_records([match([often, often, rare, rare])])
        most = records['most_modifier']
        self.assertEqual((most['key'], most['activations']), ('devils_row', 4))

    def test_pvp_streak_counts_1v1_wins_in_a_row_against_people_only(self):
        won = lambda winner, at: {'winner': winner, 'scores': [1, 2], 'ended_at': at}
        results = [match([won(0, 1), won(0, 2), won(1, 3), won(0, 4)]),  # Ann: 2, then broken
                   match([won(0, 5), won(0, 6), won(0, 7)], names=('Bob', 'Cy')),  # Bob: 3
                   {**match([won(0, 8)] * 5), 'solo': True}]  # wins against Golfbot never count
        streak = build_records(results)['pvp_streak']
        self.assertEqual((streak['label'], streak['streak']), ('Bob', 3))

    def test_most_games_today_skips_earlier_days_and_bots(self):
        now = time.time()
        today, yesterday = now - 60, now - 3 * 86400
        game = lambda at: {'winner': 0, 'scores': [1, 2], 'ended_at': at}
        results = [match([game(today), game(today)]), match([game(today)], names=('Cy', 'Ann')),
                   match([game(yesterday)] * 5, names=('Dee', 'Eve'))]
        record = most_games_today(results, now)
        self.assertEqual((record['label'], record['games']), ('Ann', 3))

    def test_most_modifiers_in_a_single_game(self):
        game = {'winner': 0, 'scores': [1, 2], 'activations': [['royal_pairs', 'devils_row'], ['holdem', 'v10', 'beggars']]}
        record = build_records([match([game])])['modifiers_in_game']
        self.assertEqual((record['label'], record['count']), ('Bob', 3))

    def test_modifiers_rank_by_how_often_they_come_into_play_when_on(self):
        game = lambda active: {'rules': {'royal_pairs': True, 'devils_row': True, 'beggars': False},
                               'activations': [active, []]}
        results = [match([game(['royal_pairs']), game(['royal_pairs', 'devils_row']), game([])])]
        records = build_records(results)
        self.assertEqual((records['most_modifier']['key'], records['most_modifier']['active']), ('royal_pairs', 2))
        self.assertEqual((records['least_modifier']['key'], records['least_modifier']['games']), ('devils_row', 3))


if __name__ == '__main__':
    unittest.main()
