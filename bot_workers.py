"""Bounded CPU workers, separate from the web server and its I/O threads."""
import asyncio
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool
import logging
import multiprocessing
import os

from bot import choose_action

log = logging.getLogger(__name__)


class BotWorkers:
    def __init__(self, workers=None, timeout=4):
        # Leave CPU capacity for the web server. Never start a process per game.
        self.workers = workers or min(2, max(1, (os.cpu_count() or 2) - 1))
        self.timeout = timeout
        self.pool = None
        self.pending = set()

    async def choose(self, position):
        # Do not queue unlimited CPU work. At capacity the game uses a quick
        # legal move instead of waiting behind searches from other tables.
        if len(self.pending) >= self.workers:
            return None
        if self.pool is None:
            self.pool = ProcessPoolExecutor(
                max_workers=self.workers,
                mp_context=multiprocessing.get_context("spawn"),
            )
        pool = self.pool
        try:
            future = asyncio.get_running_loop().run_in_executor(pool, choose_action, position)
            self.pending.add(future)
            future.add_done_callback(self._finished)
            # Keep a timed-out/cancelled search counted until the process really
            # finishes. Cancelling the await does not stop CPU work in a child.
            return await asyncio.wait_for(asyncio.shield(future), self.timeout)
        except BrokenProcessPool:
            log.exception("AI worker exited; using a legal fallback and replacing the pool")
            pool.shutdown(wait=False, cancel_futures=True)
            if self.pool is pool:
                self.pool = None
        except Exception:
            log.exception("AI search failed or timed out; using a legal fallback")
        return None

    def _finished(self, future):
        self.pending.discard(future)
        if not future.cancelled():
            # Consume exceptions even if the table left or the wait timed out.
            future.exception()

    async def close(self):
        if self.pool is not None:
            pool, self.pool = self.pool, None
            await asyncio.to_thread(pool.shutdown, wait=True, cancel_futures=True)
