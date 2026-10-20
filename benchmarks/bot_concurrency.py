"""Exercise simultaneous solo tables and measure HTTP responsiveness.

python -m benchmarks.bot_concurrency --games 8
Use --threads to reproduce the previous CPU-sharing approach for comparison.
No live server, saved history, or player sessions are changed.
"""
import argparse
import asyncio
import json
from time import perf_counter


async def measure(games, threads):
    import httpx
    from itertools import count
    from unittest.mock import patch
    from bot import Search
    from game import GolfGame, Rules
    from server import Store, create_app

    class ThreadSearch:
        async def choose(self, position):
            return await asyncio.to_thread(Search().choose, position)

        async def close(self):
            pass

    store = Store()
    app = create_app(store, google_client_id='', bot_workers=ThreadSearch() if threads else None)
    clients = [httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') for _ in range(games)]
    latencies, lag, finished = [], [], []
    stop = asyncio.Event()
    seeds = count(100)

    def fixed_deal(*args, **kwargs):
        kwargs['seed'] = next(seeds)
        return GolfGame(*args, **kwargs)

    async def probe():
        while not stop.is_set():
            start = perf_counter()
            response = await clients[0].get('/health')
            response.raise_for_status()
            latencies.append((perf_counter() - start) * 1000)
            start = perf_counter()
            await asyncio.sleep(.01)
            lag.append(max(0, perf_counter() - start - .01) * 1000)

    async def play(client):
        await client.get('/api/session')
        state = (await client.post('/api/solo', json={
            'first': 'guest', 'rules': dict.fromkeys(Rules.__dataclass_fields__, True),
        })).json()
        path = f"/api/lobbies/{state['id']}"
        for index in (0, 1):
            response = await client.post(path + '/action', json={'action': 'flip', 'index': index, 'version': state['version']})
            response.raise_for_status()
            state = response.json()
        start = perf_counter()
        while perf_counter() - start < 20:
            state = (await client.get(path + '/state')).json()
            if state['game']['decision_player'] != 1 or state['status'] != 'playing':
                finished.append(round(perf_counter() - start, 3))
                return
            await asyncio.sleep(.03)
        raise RuntimeError('AI turn failed to complete within 20 seconds')

    with patch('server.GolfGame', side_effect=fixed_deal):
        async with app.router.lifespan_context(app):
            probe_task = asyncio.create_task(probe())
            try:
                await asyncio.gather(*(play(client) for client in clients))
            finally:
                stop.set()
                await probe_task
                await asyncio.gather(*(client.aclose() for client in clients))
    ordered = sorted(latencies)
    return {'mode': 'threads (previous)' if threads else 'bounded processes', 'games': games,
            'completed_bot_turns': len(finished), 'max_bot_turn_seconds': max(finished),
            'http_p95_ms': round(ordered[min(len(ordered) - 1, int(len(ordered) * .95))], 2),
            'http_max_ms': round(max(ordered), 2), 'event_loop_max_delay_ms': round(max(lag), 2)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--games', type=int, default=8, choices=range(1, 33))
    parser.add_argument('--threads', action='store_true')
    args = parser.parse_args()
    print(json.dumps(asyncio.run(measure(args.games, args.threads)), indent=2))
