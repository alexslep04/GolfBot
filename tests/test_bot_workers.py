"""CPU isolation, bounded admission, cancellation, and live decision deadlines."""
import asyncio
from concurrent.futures import Future
from concurrent.futures.process import BrokenProcessPool
from time import monotonic
import unittest
from unittest.mock import patch

from bot import Search, legal_actions, public_position
from bot_workers import BotWorkers
from game import GolfGame


def position():
    game = GolfGame(9, first_player=1)
    game.opening_reveal(0, 0)
    game.opening_reveal(0, 1)
    public = public_position(game)
    public._root_actions = set(legal_actions(game))
    return public


class WorkerTests(unittest.IsolatedAsyncioTestCase):
    async def test_real_spawned_worker_returns_a_legal_public_information_move(self):
        workers = BotWorkers(workers=1, timeout=8)
        try:
            game = position()
            self.assertIn(await workers.choose(game), game._root_actions)
        finally:
            await workers.close()

    async def test_capacity_timeout_and_cancellation_do_not_queue_more_cpu_work(self):
        for cancel in (False, True):
            with self.subTest(cancel=cancel), patch('bot_workers.ProcessPoolExecutor') as factory:
                running = Future()
                factory.return_value.submit.return_value = running
                workers = BotWorkers(workers=1, timeout=.02)
                task = asyncio.create_task(workers.choose(position()))
                await asyncio.sleep(0)
                self.assertIsNone(await workers.choose(position()))
                if cancel:
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):
                        await task
                else:
                    with self.assertLogs('bot_workers', level='ERROR'):
                        self.assertIsNone(await task)
                # An abandoned await must not release capacity for a still
                # running process or permit a growing background work queue.
                self.assertIsNone(await workers.choose(position()))
                self.assertEqual(factory.return_value.submit.call_count, 1)
                running.set_result(('draw',))
                await asyncio.sleep(.01)
                self.assertEqual(len(workers.pending), 0)
                await workers.close()

    async def test_search_deadline_stops_expanding_and_returns_promptly(self):
        game = position()
        search = Search(max_seconds=0)
        start = monotonic()
        self.assertIsNone(search.choose(game))
        self.assertLess(monotonic() - start, .2)

    async def test_crashed_worker_pool_is_replaced_for_the_next_decision(self):
        with patch('bot_workers.ProcessPoolExecutor') as factory:
            failed, recovered = Future(), Future()
            failed.set_exception(BrokenProcessPool('worker exited'))
            recovered.set_result(('draw',))
            factory.return_value.submit.side_effect = [failed, recovered]
            workers = BotWorkers(workers=1)
            with self.assertLogs('bot_workers', level='ERROR'):
                self.assertIsNone(await workers.choose(position()))
            self.assertIsNone(workers.pool)
            self.assertEqual(await workers.choose(position()), ('draw',))
            self.assertEqual(factory.call_count, 2)
            await workers.close()

    async def test_completed_future_releases_capacity_before_done_callback_runs(self):
        loop = asyncio.get_running_loop()
        for error in (None, BrokenProcessPool('worker exited')):
            with self.subTest(error=error), patch('bot_workers.ProcessPoolExecutor'):
                completed, recovered = loop.create_future(), loop.create_future()
                if error:
                    completed.set_exception(error)
                else:
                    completed.set_result(('draw',))
                recovered.set_result(('draw',))
                workers = BotWorkers(workers=1)
                # Already-completed futures can be awaited without yielding.
                # Their done callbacks remain queued until a later loop turn.
                with patch.object(loop, 'run_in_executor', side_effect=[completed, recovered]):
                    if error:
                        with self.assertLogs('bot_workers', level='ERROR'):
                            self.assertIsNone(await workers.choose(position()))
                    else:
                        self.assertEqual(await workers.choose(position()), ('draw',))
                    self.assertEqual(len(workers.pending), 0)
                    self.assertEqual(await workers.choose(position()), ('draw',))
                await workers.close()


if __name__ == '__main__':
    unittest.main()
