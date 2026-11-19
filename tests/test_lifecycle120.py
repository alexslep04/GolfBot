import asyncio
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from fastapi.testclient import TestClient
from accounts import ACCOUNT_COOKIE
from server import Store, create_app, COOKIE


class LifecycleTests(unittest.TestCase):
    def setUp(self):
        self.store = Store()
        self.client = TestClient(create_app(self.store))
        self.client.get('/api/session')
        self.addCleanup(self.client.close)

    def practice(self, client=None):
        response = (client or self.client).post('/api/solo', json={'username':'Tester','practice':True})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def rated(self):
        other = TestClient(self.client.app)
        self.addCleanup(other.close)
        other.get('/api/session')
        self.client.post('/api/queue/join', json={'username':'One'})
        other.post('/api/queue/join', json={'username':'Two'})
        offer = self.client.post('/api/presence', json={'username':'One'}).json()['queue']['id']
        self.client.post(f'/api/queue/offers/{offer}/respond', json={'accept':True})
        result = other.post(f'/api/queue/offers/{offer}/respond', json={'accept':True}).json()
        return other, self.store.rooms[result['room_id']]

    def test_practice_enforces_continuous_house_and_random(self):
        state = self.practice()
        self.assertTrue(state['practice'])
        self.assertTrue(state['house_rules'])
        self.assertIsNone(state['best_of'])
        self.assertEqual(state['first'], 'random')
        self.assertEqual(state['streak']['current'], 0)

    def test_practice_with_custom_rules_counts_toward_the_streak(self):
        response = self.client.post('/api/solo', json={'username': 'Tester', 'practice': True, 'house_rules': False,
                                                       'first': 'host', 'rules': {}})
        self.assertEqual(response.status_code, 200, response.text)
        state = response.json()
        self.assertTrue(state['practice'])
        self.assertFalse(state['house_rules'])
        self.assertIsNone(state['best_of'])
        self.assertEqual(state['first'], 'host')
        self.assertEqual(state['streak']['current'], 0)
        room = self.store.rooms[state['id']]
        # any ruleset counts toward the streak against Golfbot, not just House rules
        self.assertTrue(room.counts_streak)
        room.game.phase = 'over'
        with patch.object(self.store.progression, 'practice_result') as result:
            room.record_result()
        result.assert_called_once()

    def test_practice_info_reports_no_saved_game_for_guests(self):
        self.assertEqual(self.client.get('/api/practice').json(), {'saved': False})

    def test_guest_leave_resets_streak_and_discards_game(self):
        state = self.practice()
        room = self.store.rooms[state['id']]
        self.store.progression.practice_result('win1', room.progression_players[0], 0)
        self.client.post(f"/api/lobbies/{room.id}/leave")
        fresh = self.practice()
        self.assertNotEqual(fresh['id'], room.id)
        self.assertEqual(fresh['streak']['current'], 0)

    def test_explicit_forfeit_counts_once_and_only_current_game(self):
        other, room = self.rated()
        self.assertTrue(room.rated)
        first = room.game
        first.phase = 'over'
        room.record_result()
        self.assertEqual(len(room.history), 1)
        room.start_round()
        response = self.client.post(f'/api/lobbies/{room.id}/leave')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(room.history), 2)
        self.assertEqual(room.history[-1]['winner'], 1)
        self.assertTrue(room.history[-1]['forfeit'])
        self.client.post(f'/api/lobbies/{room.id}/leave')
        self.assertEqual(len(room.history), 2)
        rows = self.client.get('/api/leaderboards').json()['pvp']
        self.assertEqual(sum(r['wins']+r['draws']+r['losses'] for r in rows),4)

    def test_void_pauses_then_discards_only_current_game(self):
        other, room = self.rated()
        room.game.phase = 'over'
        room.record_result()
        room.start_round()
        before = self.client.get('/api/leaderboards').json()
        url = f'/api/lobbies/{room.id}'
        self.assertEqual(self.client.post(url+'/void-offer').status_code,200)
        move = self.client.post(url+'/action',json={'action':'flip','index':0,'version':room.version})
        self.assertEqual(move.status_code,409)
        self.assertEqual(other.post(url+'/void-reply',json={'accept':True}).status_code,200)
        self.assertEqual(room.status,'closed')
        self.assertEqual(len(room.history),1)
        self.assertEqual(before,self.client.get('/api/leaderboards').json())

    def test_void_decline_limits_each_player_once_per_game(self):
        other, room = self.rated()
        url = f'/api/lobbies/{room.id}'
        self.client.post(url+'/void-offer')
        self.assertEqual(self.client.post(url+'/void-reply',json={'accept':True}).status_code,403)
        other.post(url+'/void-reply',json={'accept':False})
        self.assertEqual(self.client.post(url+'/void-offer').status_code,409)
        self.assertEqual(other.post(url+'/void-offer').status_code,200)
        self.client.post(url+'/void-reply',json={'accept':False})
        room.start_round()
        self.assertEqual(self.client.post(url+'/void-offer').status_code,200)

    def test_account_game_survives_restart_and_new_browser(self):
        with tempfile.TemporaryDirectory() as directory:
            db = Path(directory)/'game.sqlite3'
            store = Store(db)
            account, token = store.accounts.login('test-subject')
            store.accounts.choose_name(account['id'],'tester')
            with TestClient(create_app(store)) as client:
                client.cookies.set(ACCOUNT_COOKIE, token)
                client.get('/api/session')
                initial = self.practice(client)
                room = store.rooms[initial['id']]
                client.post(f'/api/lobbies/{room.id}/action',json={'action':'flip','index':0,'version':room.version}).raise_for_status()
                cards = [[slot.card for slot in hand] for hand in room.game.players]
                client.post(f'/api/lobbies/{room.id}/leave').raise_for_status()
            restored = Store(db)
            with TestClient(create_app(restored)) as client:
                client.cookies.set(ACCOUNT_COOKIE,token)
                client.get('/api/session')
                state = self.practice(client)
                self.assertEqual(state['id'], initial['id'])
                self.assertTrue(state['game']['players'][0][0]['visible'])
                self.assertEqual(cards,[[slot.card for slot in hand] for hand in restored.rooms[state['id']].game.players])

    def test_future_incompatible_save_preserves_streak(self):
        account, token = self.store.accounts.login('other-sub')
        self.store.accounts.choose_name(account['id'],'tester')
        self.client.cookies.set(ACCOUNT_COOKIE,token)
        state = self.practice()
        room = self.store.rooms[state['id']]
        self.store.progression.practice_result('win1',room.progression_players[0],0)
        self.client.post(f'/api/lobbies/{room.id}/leave')
        saved = self.store.progression.load_practice(account['id'])
        saved['schema'] = -1
        self.store.progression.save_practice(account['id'],saved)
        fresh = self.practice()
        self.assertNotEqual(fresh['id'],state['id'])
        self.assertEqual(fresh['streak']['current'],1)

    def test_timeout_forfeit_and_reconnect_grace(self):
        # Lifespan's monitor enforces timeouts even without HTTP requests.
        with TestClient(self.client.app):
            other, room = self.rated()
            import time
            room.disconnected = [time.time() - 29, None]
            time.sleep(.1)
            self.assertEqual(room.status, 'playing')
            with self.client.websocket_connect(f'/ws/{room.id}') as ws:
                ws.receive_json()
                self.assertIsNone(room.disconnected[0])
            room.disconnected = [time.time() - 31, None]
            time.sleep(1.1)
            self.assertEqual(room.status, 'closed')
            self.assertEqual(len(room.history), 1)
            self.assertEqual(room.history[0]['winner'], 1)

    def test_offer_timeout_declines_and_leaving_pending_still_forfeits(self):
        other, room = self.rated()
        url = f'/api/lobbies/{room.id}'
        self.client.post(url+'/void-offer').raise_for_status()
        room.void_offer['expires_at'] = 0
        state = self.client.get(url+'/state').json()
        self.assertIsNone(state['void_offer'])
        self.assertTrue(state['void_offered'][0])
        other.post(url+'/void-offer').raise_for_status()
        self.client.post(url+'/leave').raise_for_status()
        self.assertEqual(room.history[-1]['winner'], 1)

    def test_private_lobby_cannot_offer_or_gain_elo(self):
        state = self.client.post('/api/lobbies',json={'username':'Tester'}).json()
        self.assertFalse(state['rated'])
        self.assertNotIn('ratings',state)
        self.assertEqual(self.client.post(f"/api/lobbies/{state['id']}/void-offer").status_code,409)

    def test_legacy_redirect_preserves_suffix_query_and_post(self):
        response = self.client.get('/Golfgame/stats?patch=1.1.2',follow_redirects=False)
        self.assertEqual(response.status_code,308)
        self.assertTrue(response.headers['location'].endswith('/golf/stats?patch=1.1.2'))
        self.client.get('/golf/api/session')
        response = self.client.post('/Golfgame/api/solo',json={'practice':True})
        self.assertEqual(response.status_code,200,response.text)
        self.assertTrue(response.json()['practice'])

if __name__ == '__main__':
    unittest.main()
