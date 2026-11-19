import unittest
from copy import deepcopy
from game import Card, GolfGame, Rules, Slot
import scoring
from server import Room, snapshot


def layout(ranks, suits='SHDCSH', visible=True):
    return [Slot(Card(rank, suit, i), visible) for i, (rank, suit) in enumerate(zip(ranks, suits))]


class RulePreviewTests(unittest.TestCase):
    def game(self, ranks, rules, suits='SHDCSH'):
        game = GolfGame(rules=rules)
        game.players = [layout(ranks, suits), layout([1, 4, 8, 10, 6, 3], visible=False)]
        return game

    def preview(self, game):
        return scoring.rule_preview_data(game)

    def test_columns_and_rows_union_only_contributors(self):
        game = self.game([13, 12, 3, 12, 13, 8], Rules(king_queen=True))
        self.assertEqual(self.preview(game), [{'king_queen': {'indices': [0, 1, 3, 4]}}, {}])
        game.players[0][4].visible = False
        self.assertEqual(self.preview(game)[0]['king_queen']['indices'], [0, 3])
        game = self.game([3, 4, 5, 8, 9, 10], Rules(tricky_straights=True, suited_rows=True), 'HHHSSS')
        self.assertEqual(self.preview(game)[0], {key: {'indices': list(range(6))} for key in ('tricky_straights', 'suited_rows')})
        game.players[0][5].visible = False
        self.assertEqual(self.preview(game)[0], {key: {'indices': [0, 1, 2]} for key in ('tricky_straights', 'suited_rows')})

    def test_nonstacking_vs_choose_one_visible_pattern(self):
        for key, ranks in [('roman_fives', [3, 4, 3, 3, 4, 3]), ('v10', [10, 11, 12, 10, 11, 12])]:
            game = self.game(ranks, Rules(**{key: True}))
            self.assertEqual(self.preview(game)[0][key]['indices'], [0, 2, 4])
            game.players[0][0].visible = False
            self.assertEqual(self.preview(game)[0][key]['indices'], [1, 3, 5])

    def test_ripped_uses_actual_uncancelled_pair(self):
        game = self.game([5, 3, 8, 4, 5, 9], Rules(ripped_five=True), 'DSHCHS')
        self.assertEqual(self.preview(game)[0], {'ripped_five': {'indices': [0, 4]}})
        # in a column pair now, the 5 of diamonds still rips the other 5
        game.players[0][3] = Slot(Card(5, 'C'), True)
        self.assertEqual(self.preview(game)[0], {'ripped_five': {'indices': [0, 4]}})
        # with no uncanceled 5 left to rip, nothing shows
        game.players[0][4] = Slot(Card(4, 'H'), True)
        self.assertEqual(self.preview(game)[0], {})

    def test_holdem_selects_qualifying_five_not_first_five(self):
        game = self.game([2, 1, 10, 11, 12, 13], Rules(holdem=True), 'SHHHHH')
        self.assertEqual(self.preview(game)[0], {'holdem': {'indices': [1, 2, 3, 4, 5]}})
        game.players[0][5].visible = False
        self.assertEqual(self.preview(game)[0], {})

    def test_color_locks_and_poison_only_visible_slots(self):
        game = self.game([1, 3, 5, 8, 10, 13], Rules(all_in_color=True, devils_row=True, poisoned_card=True), 'HHHHHH')
        game.locked_cards = {game.players[0][1].card, game.players[0][4].card}
        game.finisher = 0
        self.assertEqual(self.preview(game)[0]['all_in_color']['indices'], list(range(6)))
        game.players[0][4].visible = False
        data = self.preview(game)[0]
        self.assertNotIn('all_in_color', data)
        self.assertEqual(data['devils_row']['indices'], [1])
        self.assertEqual(data['poisoned_card']['indices'], [0, 1, 2, 3, 5])
        self.assertIn('note', data['poisoned_card'])

    def test_earned_effects_survive_broken_or_hidden_rows(self):
        for key, rank, flag in [('gamblers_row', 7, 'gambler_earned'), ('angels_row', 9, 'angel_earned')]:
            game = self.game([rank] * 3 + [1, 4, 8], Rules(**{key: True}))
            getattr(game, flag)[0] = True
            self.assertEqual(self.preview(game)[0][key]['indices'], [0, 1, 2])
            game.players[0][0].visible = False
            entry = self.preview(game)[0][key]
            self.assertEqual(entry['indices'], [])
            self.assertIn('earned earlier', entry['note'].lower())
            self.assertEqual(self.preview(game)[1], {})

    def test_royal_pairs_stay_visible_after_use_without_modifier_count(self):
        game = self.game([11, 12, 3, 11, 12, 8], Rules(royal_pairs=True))
        game.used_bonus_cards.update(slot.card for slot in game.players[0])
        self.assertEqual(self.preview(game)[0], {'royal_pairs': {'indices': [0, 1, 3, 4]}})
        self.assertEqual(scoring.modifier_data(game)['modifier_counts'][0], {})

    def test_interactive_rules_require_pending_decision_and_correct_owner(self):
        game = self.game([8, 8, 8, 8, 2, 3], Rules(four_kind=True, beggars=True))
        self.assertEqual(self.preview(game), [{}, {}])
        game.phase = 'arrange'
        game.arrange_pending = {'player': 0, 'rank': 8}
        self.assertEqual(self.preview(game), [{'four_kind': {'indices': [0, 1, 2, 3]}}, {}])
        game.phase = 'guess'
        game.guess_pending = {'player': 0, 'target': 3}
        self.assertEqual(self.preview(game), [{'beggars': {'indices': [0, 1, 2, 3]}}, {}])
        game.phase = 'revealed'
        self.assertEqual(self.preview(game), [{}, {}])

    def test_snapshot_is_public_viewer_independent_and_hidden_replacement_invariant(self):
        game = self.game([3, 4, 5, 8, 9, 10], Rules(tricky_straights=True, suited_rows=True, holdem=True, all_in_color=True), 'HHHHHH')
        game.players[0][5].visible = False
        room = Room('test', 'Preview', game.rules, 3, 'host', False, ['host', 'guest'], ['Host', 'Guest'], status='playing', game=game)
        before = deepcopy(game.activated_rules)
        host = snapshot(room, 'host')
        self.assertEqual(host['game']['rule_previews'], self.preview(game))
        self.assertEqual(host['game']['rule_previews'], snapshot(room, 'guest')['game']['rule_previews'])
        game.players[0][5].card = Card(13, 'C', 99)
        for slot in game.players[1]:
            slot.card = Card(12, 'D', 100)
        self.assertEqual(host, snapshot(room, 'host'))
        self.assertEqual(game.activated_rules, before)
        for seat, entries in enumerate(host['game']['rule_previews']):
            for entry in entries.values():
                self.assertLessEqual(set(entry), {'indices', 'note'})
                self.assertTrue(all(type(i) is int and 0 <= i < 6 and game.players[seat][i].visible for i in entry['indices']))


if __name__ == '__main__':
    unittest.main()
