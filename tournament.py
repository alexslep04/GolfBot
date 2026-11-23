"""Tournament brackets: who plays whom, in what order, and who goes through.

Only the bracket lives here. Each match-up is played at an ordinary 1v1 table
(server.py seats the players and reports the result back with `report`).

Three formats:
  single       lose once and you are out
  double       lose twice and you are out (a winners bracket, a losers bracket,
               and a grand final that is replayed if the losers' side wins it)
  round_robin  everyone plays everyone once; the best record wins

An elimination bracket has a power-of-two number of places. Places left over
are filled with AI opponents, or left as byes: a bye is a phantom entrant that
loses to anyone, so whoever meets one goes straight through.
"""
from dataclasses import dataclass, field
import random
import time

FORMATS = ('single', 'double', 'round_robin')
FORMAT_NAMES = {'single': 'Single elimination', 'double': 'Double elimination', 'round_robin': 'Round robin'}
BYE = 'bye'
MIN_ENTRANTS, MAX_ENTRANTS = 2, 32
AI_NAMES = ('Golfbot', 'Birdie', 'Bogey', 'Eagle', 'Caddie', 'Mulligan', 'Fairway', 'Albatross', 'Divot', 'Sandy',
            'Putter', 'Wedge', 'Tee', 'Driver', 'Rough', 'Bunker')


@dataclass
class Entrant:
    id: str
    name: str
    token: str | None = None      # the player's session; None for an AI
    avatar: str | None = None
    profile: dict | None = None   # their public identity at a table (id, kind, names)
    rating: int = 1000            # MMR when the tournament started (for seeding)
    ai: bool = False
    seed: int | None = None       # 1 is the top seed
    withdrawn: bool = False       # left after the start: every match of theirs is forfeit


@dataclass
class Match:
    id: str
    bracket: str                  # 'W' winners, 'L' losers, 'F' grand final, 'R' round robin
    round: int                    # 1-based within its bracket
    index: int                    # 1-based within its round
    players: list                 # an entrant id, BYE, or None while not yet known
    sources: list = field(default_factory=lambda: [None, None])  # (match id, 'winner' | 'loser') feeding each place
    status: str = 'pending'       # pending, live, done
    winner: int | None = None     # the place (0 or 1) that won; None once done means drawn
    score: list | None = None     # what decided it, per place: games won, or total points
    points: list | None = None    # total card points per place (round robin tie-break)
    note: str | None = None       # 'bye', 'forfeit', 'awarded'
    room_id: str | None = None
    started_at: float | None = None
    ended_at: float | None = None

    @property
    def loser(self):
        return None if self.winner is None else 1 - self.winner


def seed_order(size):
    """Bracket places by seed, so the top seeds can only meet late: 1 v 8, 4 v 5, 2 v 7, 3 v 6."""
    order = [1, 2]
    while len(order) < size:
        total = len(order) * 2 + 1
        order = [seed for top in order for seed in (top, total - top)]
    return order


def bracket_size(count):
    size = 2
    while size < count:
        size *= 2
    return size


class Tournament:
    def __init__(self, id, name, host, format='single', seeding='random', fill='byes', ranked=False, settings=None):
        if format not in FORMATS:
            raise ValueError('Choose single elimination, double elimination or round robin.')
        if seeding not in ('random', 'mmr') or fill not in ('ai', 'byes'):
            raise ValueError('Choose a seeding and how to fill empty places.')
        self.id, self.name, self.host = id, name, host
        self.format, self.seeding, self.fill, self.ranked = format, seeding, fill, ranked
        self.settings = dict(settings or {})
        self.entrants = {}        # id -> Entrant, in the order they joined
        self.matches = {}         # id -> Match, in bracket order
        self.sitting_out = {}     # round robin: round -> the entrant with no match in it
        self.status = 'open'      # open, live, finished, cancelled
        self.champion = None
        self.created_at = self.touched = time.time()
        self.started_at = self.finished_at = None
        self._next = 0

    # ---------- the lobby ----------
    def add(self, name, token=None, avatar=None, profile=None, rating=1000, ai=False):
        if self.status != 'open':
            raise ValueError('This tournament has already started.')
        if len(self.entrants) >= MAX_ENTRANTS:
            raise ValueError(f'A tournament holds up to {MAX_ENTRANTS} players.')
        self._next += 1
        entrant = Entrant(f'e{self._next}', name, token, avatar, profile, rating, ai)
        self.entrants[entrant.id] = entrant
        self.touched = time.time()
        return entrant

    def add_ai(self, avatar=None):
        taken = {entrant.name for entrant in self.entrants.values()}
        name = next((name for name in AI_NAMES if name not in taken), None) or f'Golfbot {len(taken) + 1}'
        return self.add(name, avatar=avatar, ai=True)

    def remove(self, entrant_id):
        if self.status != 'open':
            raise ValueError('This tournament has already started.')
        self.entrants.pop(entrant_id, None)
        self.touched = time.time()

    def by_token(self, token):
        return next((entrant for entrant in self.entrants.values() if token and entrant.token == token), None)

    @property
    def can_start(self):
        """Two to play; a lone host may start against an AI when empty places go to AIs."""
        return self.status == 'open' and (len(self.entrants) >= MIN_ENTRANTS or (len(self.entrants) == 1 and self.fill == 'ai'))

    # ---------- the draw ----------
    def start(self, rng=None, ai_avatar=None):
        if not self.can_start:
            raise ValueError('A tournament needs at least two players.')
        rng = rng or random.Random()
        count = len(self.entrants)
        target = bracket_size(count) if self.format != 'round_robin' else count + count % 2
        if self.fill == 'ai':
            while len(self.entrants) < max(target, MIN_ENTRANTS):
                self.add_ai(ai_avatar)
        order = list(self.entrants.values())
        if self.seeding == 'mmr':
            # best rating first; people ahead of AIs on the same rating, then whoever joined first
            order.sort(key=lambda entrant: (-entrant.rating, entrant.ai))
        else:
            rng.shuffle(order)
        for seed, entrant in enumerate(order, 1):
            entrant.seed = seed
        self.entrants = {entrant.id: entrant for entrant in order}
        seeds = [entrant.id for entrant in order]
        if self.format == 'round_robin':
            self._round_robin(seeds)
        else:
            self._elimination(seeds)
        self.status, self.started_at = 'live', time.time()
        self._settle()
        return self

    def _match(self, bracket, round, index, players=None, sources=None):
        match = Match(f'{bracket}{round}-{index}', bracket, round, index, list(players or [None, None]),
                      list(sources or [None, None]))
        self.matches[match.id] = match
        return match

    def _elimination(self, seeds):
        size = bracket_size(len(seeds))
        rounds = size.bit_length() - 1
        places = [seeds[seed - 1] if seed <= len(seeds) else BYE for seed in seed_order(size)]
        for index in range(size // 2):
            self._match('W', 1, index + 1, places[2 * index:2 * index + 2])
        for round in range(2, rounds + 1):
            for index in range(1, size // 2 ** round + 1):
                self._match('W', round, index, sources=[(f'W{round - 1}-{2 * index - 1}', 'winner'),
                                                        (f'W{round - 1}-{2 * index}', 'winner')])
        if self.format != 'double':
            return
        last = None  # where the losers bracket's winner comes from
        if rounds == 1:
            last = ('W1-1', 'loser')
        else:
            for index in range(1, size // 4 + 1):
                self._match('L', 1, index, sources=[(f'W1-{2 * index - 1}', 'loser'), (f'W1-{2 * index}', 'loser')])
            for drop in range(2, rounds + 1):
                # the losers of winners round `drop` come in against the survivors so far,
                # in reverse order on alternate rounds, which keeps early rematches apart
                major, count = 2 * drop - 2, size // 2 ** drop
                for index in range(1, count + 1):
                    from_winners = count + 1 - index if drop % 2 == 0 else index
                    self._match('L', major, index, sources=[(f'L{major - 1}-{index}', 'winner'),
                                                            (f'W{drop}-{from_winners}', 'loser')])
                if drop < rounds:
                    for index in range(1, count // 2 + 1):
                        self._match('L', major + 1, index, sources=[(f'L{major}-{2 * index - 1}', 'winner'),
                                                                    (f'L{major}-{2 * index}', 'winner')])
            last = (f'L{2 * rounds - 2}-1', 'winner')
        self._match('F', 1, 1, sources=[(f'W{rounds}-1', 'winner'), last])

    def _round_robin(self, seeds):
        """The circle method: the first place stays put and the rest rotate, a round at a time."""
        circle = list(seeds) + ([BYE] if len(seeds) % 2 else [])
        half = len(circle) // 2
        for round in range(1, len(circle)):
            pairs = [(circle[place], circle[-1 - place]) for place in range(half)]
            index = 0
            for first, second in pairs:
                if BYE in (first, second):
                    self.sitting_out[round] = first if second == BYE else second
                    continue
                index += 1
                self._match('R', round, index, [first, second])
            circle = [circle[0], circle[-1]] + circle[1:-1]

    # ---------- results ----------
    def _out(self, player):
        """A place that cannot win: a bye, or an entrant who has left the tournament."""
        return player == BYE or (player in self.entrants and self.entrants[player].withdrawn)

    def _settle(self):
        """Fill in every place whose match is decided, and decide every match that needs no playing."""
        changed = True
        while changed:
            changed = False
            for match in self.matches.values():
                for place, source in enumerate(match.sources):
                    if match.players[place] is None and source:
                        feeder = self.matches[source[0]]
                        if feeder.status == 'done' and feeder.winner is not None:
                            match.players[place] = feeder.players[feeder.winner if source[1] == 'winner' else feeder.loser]
                            changed = True
                if match.status == 'pending' and None not in match.players and any(self._out(player) for player in match.players):
                    first_out, second_out = (self._out(player) for player in match.players)
                    match.winner = 1 if first_out and not second_out else 0
                    match.status, match.ended_at = 'done', time.time()
                    match.note = 'bye' if BYE in match.players else 'forfeit'
                    changed = True
            if self._grand_final():
                changed = True
        self._finish()

    def _grand_final(self):
        """Double elimination: the losers' side winning the final means both have lost once. Play it again."""
        final = self.matches.get('F1-1')
        if final is None or 'F2-1' in self.matches or final.status != 'done' or final.winner != 1 or final.note == 'bye':
            return False
        if any(self._out(player) for player in final.players):
            return False
        self._match('F', 2, 1, final.players)
        return True

    def _finish(self):
        if self.status != 'live' or any(match.status != 'done' for match in self.matches.values()):
            return
        if self.format == 'round_robin':
            table = self.standings()
            self.champion = table[0]['id'] if table else None
        else:
            # the last match played decides it: the final replay, the final, or the winners final
            decider = (self.matches.get('F2-1') or self.matches.get('F1-1')
                       or max((match for match in self.matches.values() if match.bracket == 'W'), key=lambda match: match.round))
            winner = decider.players[decider.winner] if decider.winner is not None else None
            self.champion = winner if winner in self.entrants else None
        self.status, self.finished_at = 'finished', time.time()

    def report(self, match_id, winner, score=None, points=None, note=None):
        """Record a played match: the winning place (0 or 1), or None for a drawn round-robin match."""
        match = self.matches[match_id]
        if match.status == 'done':
            return match
        if winner is None and match.bracket != 'R':
            raise ValueError('An elimination match needs a winner.')
        match.winner, match.score, match.points, match.note = winner, score, points, note
        match.status, match.ended_at = 'done', time.time()
        self.touched = time.time()
        self._settle()
        return match

    def withdraw(self, entrant_id):
        """Someone leaves a running tournament: their unplayed matches go to their opponents."""
        entrant = self.entrants.get(entrant_id)
        if entrant is None or self.status != 'live':
            return
        entrant.withdrawn = True
        self.touched = time.time()
        self._settle()

    # ---------- what happens next ----------
    def live(self):
        return [match for match in self.matches.values() if match.status == 'live']

    def ready(self):
        """Matches that can start now: both players known and free, and (in a round robin)
        done with their earlier rounds. Lowest round first."""
        busy = {player for match in self.live() for player in match.players}
        ready = []
        for match in sorted(self.matches.values(), key=lambda match: (match.bracket == 'F', match.round)):
            if match.status != 'pending' or None in match.players or busy & set(match.players):
                continue
            if match.bracket == 'R' and any(
                    other.status != 'done' and other.round < match.round and set(other.players) & set(match.players)
                    for other in self.matches.values()):
                continue
            ready.append(match)
            busy |= set(match.players)
        return ready

    def standings(self):
        """Everyone's record, best first. A round robin ranks by match points (a win 1, a draw
        a half), then fewest card points, then seed. An elimination bracket ranks by how far
        each entrant got: fewest losses, then most wins."""
        rows = {entrant.id: {'id': entrant.id, 'played': 0, 'wins': 0, 'draws': 0, 'losses': 0, 'points': 0, 'seed': entrant.seed}
                for entrant in self.entrants.values()}
        for match in self.matches.values():
            if match.status != 'done' or match.note == 'bye':
                continue
            for place, player in enumerate(match.players):
                row = rows.get(player)
                if row is None:
                    continue
                row['played'] += 1
                row['wins'] += match.winner == place
                row['draws'] += match.winner is None
                row['losses'] += match.winner is not None and match.winner != place
                if match.points:
                    row['points'] += match.points[place]
        for row in rows.values():
            row['score'] = row['wins'] + row['draws'] / 2
        if self.format == 'round_robin':
            order = lambda row: (-row['score'], row['points'], row['seed'] or 0)
        else:
            order = lambda row: (row['id'] != self.champion, row['losses'], -row['wins'], row['seed'] or 0)
        return sorted(rows.values(), key=order)

    def eliminated(self, entrant_id):
        """Out of an elimination bracket: lost as often as the format allows, or left."""
        entrant = self.entrants.get(entrant_id)
        if entrant is None or self.format == 'round_robin' or self.status == 'open':
            return bool(entrant and entrant.withdrawn)
        losses = sum(1 for match in self.matches.values() if match.status == 'done' and match.note != 'bye'
                     and match.winner is not None and entrant_id in match.players
                     and match.players[match.loser] == entrant_id)
        return entrant.withdrawn or losses >= (2 if self.format == 'double' else 1)

    def label(self, match):
        """What a match is called on the bracket."""
        if match.bracket == 'R':
            return f'Round {match.round}'
        if match.bracket == 'F':
            return 'Grand final' if match.round == 1 else 'Grand final replay'
        rounds = max(other.round for other in self.matches.values() if other.bracket == match.bracket)
        if match.bracket == 'L':
            return 'Losers final' if match.round == rounds else f'Losers round {match.round}'
        left = rounds - match.round
        name = 'Final' if left == 0 else 'Semifinal' if left == 1 else 'Quarterfinal' if left == 2 else f'Round {match.round}'
        return name if self.format == 'single' or left > 0 else 'Winners final'

    def view(self):
        """Everything the dashboard draws, with nothing private (no session tokens)."""
        return {
            'id': self.id, 'name': self.name, 'status': self.status, 'format': self.format,
            'format_name': FORMAT_NAMES[self.format], 'seeding': self.seeding, 'fill': self.fill,
            'ranked': self.ranked, 'settings': self.settings, 'host': self.host, 'champion': self.champion,
            'capacity': MAX_ENTRANTS, 'can_start': self.can_start,
            'created_at': self.created_at, 'started_at': self.started_at, 'finished_at': self.finished_at,
            'entrants': [{'id': entrant.id, 'name': entrant.name, 'avatar': entrant.avatar, 'ai': entrant.ai,
                          'seed': entrant.seed, 'rating': entrant.rating, 'withdrawn': entrant.withdrawn,
                          'out': self.eliminated(entrant.id),
                          'player_id': (entrant.profile or {}).get('id')} for entrant in self.entrants.values()],
            'matches': [{'id': match.id, 'bracket': match.bracket, 'round': match.round, 'index': match.index,
                         'label': self.label(match), 'players': list(match.players),
                         'status': match.status, 'winner': match.winner, 'score': match.score, 'note': match.note,
                         'room_id': match.room_id} for match in self.matches.values()],
            'sitting_out': {str(round): entrant for round, entrant in self.sitting_out.items()},
            'standings': self.standings() if self.status != 'open' else [],
        }
