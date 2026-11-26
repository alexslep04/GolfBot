"""Single-process, server-authoritative Golf lobbies served by FastAPI/Uvicorn."""
import asyncio
from concurrent.futures import ProcessPoolExecutor
from datetime import timedelta
import multiprocessing
import base64
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass, field
from hashlib import sha256
from pathlib import Path
import os
import json
import logging
import re
import secrets
import random
import time
from urllib.parse import urlparse
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator

from copy import copy
from game import Card, GolfGame, Rules, RULE_OPTIONS, Slot, upgrade_rule_values, rules_from
from rule_help import load_rule_help
from match_history import MatchHistory
from progression import Progression
import practice_save
from player_stats import build_stats
from records import build_records, held_records, personal_records, player_card
from scoring import (active_rule_effects, column_score, visible_effect_total, modifier_data, rule_preview_data,
                     scoring_rule_keys, ANGEL_RANKS)
from bot import fallback_action, legal_actions, play_action, public_position
from bot_workers import BotWorkers
from odds import odds_key, win_odds
from accounts import Accounts, ACCOUNT_COOKIE, LOGIN_DAYS, participant, verify_google_token
from match_settings import HOUSE_VERSION, house_rules
from patches import PATCH_VERSION, PATCH_NOTES
from avatars import AVATARS, BOT_AVATAR, PUZZLE_BOT_AVATAR, DEFAULT_AVATAR, catalog as avatar_catalog, clean_avatar
from tournament import FORMAT_NAMES, MAX_ENTRANTS, Tournament
import puzzle as daily_puzzle
import flags as achievements
from friends import Friends

ROOT = Path(__file__).parent
COOKIE = "golf_session"
START_POLICIES = ("host", "guest", "alternate", "random", "winner", "loser")
EMOTE_SECONDS = 4
# Golfbot now and then reacts to an upset with an emote: a single move that swings
# the gap between the scores by this much, or flips the lead with a smaller swing
UPSET_SWING = 8
UPSET_FLIP_SWING = 5
REACTION_CHANCE = 0.4  # kept rare: most upsets pass without a word
REACTION_COOLDOWN = 60  # seconds between reactions
REACTION_DELAY = 0.9  # let the cards land first
reaction_roll = random.random  # replaced in tests
log = logging.getLogger(__name__)



class VersionedStatic(StaticFiles):
    """Static files. A versioned URL (?v=content hash, see page_response) never
    changes, so the browser keeps it rather than re-checking it on every reload."""

    async def get_response(self, path, scope):
        response = await super().get_response(path, scope)
        if b"v=" in scope.get("query_string", b"") and response.status_code == 200:
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return response

# Your Deck: the custom design each player has on each card ({"AS": "hole-in-one"}), by
# player, kept while the server runs (each browser sends its own again when it opens).
# A card in someone's hand wears their design; the top discard, the design of whoever
# put it there; a drawn card, the drawer's.
DECK_SKINS = {}
DECK_CARD = re.compile(r"^(A|[2-9]|10|J|Q|K)[SHDC]$")
DECK_SKIN = re.compile(r"^[a-z0-9-]{1,32}$")


class Deck(BaseModel):
    model_config = ConfigDict(extra="forbid")
    choices: dict[str, str] = Field(default_factory=dict, max_length=52)


class Emote(BaseModel):
    model_config = ConfigDict(extra="forbid")
    emote: Literal["unamused", "shocked", "laughing", "cackling", "nervous", "thanks", "oops", "wow", "save", "ofc", "luck", "tempo", "ranked",
                   "rushing", "dragging"]


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(default="Player", min_length=1, max_length=32)
    name: str = Field(default="Friendly Golf", min_length=1, max_length=48)
    best_of: StrictInt | None = Field(default=3, ge=1, le=9)
    first: Literal["host", "guest", "alternate", "random", "winner", "loser"] = "alternate"
    rules: dict[str, bool] = Field(default_factory=dict)
    house_rules: bool = False
    series_mode: Literal["wins", "points"] = "wins"
    game_type: Literal["1v1", "many"] = "1v1"
    # whether a staged move may show the score it would leave before Confirm
    score_preview: bool = True
    # whether spectators see each player's chance of winning
    show_odds: bool = True
    avatar: str | None = Field(default=None, max_length=32)

    @field_validator("best_of")
    @classmethod
    def odd_match_length(cls, value):
        if value is not None and value % 2 == 0:
            raise ValueError("Best of must be an odd number.")
        return value


class PassPlay(BaseModel):
    model_config = ConfigDict(extra="forbid")
    names: list[str] = Field(min_length=2, max_length=8)
    avatars: list[str] = Field(default_factory=list, max_length=8)
    house_rules: bool = True
    rules: dict[str, bool] = Field(default_factory=dict)
    first: Literal["host", "guest", "alternate", "random", "winner", "loser"] = "random"


class SoloSettings(Settings):
    practice: bool = False
    best_of: StrictInt | None = Field(default=1, ge=1, le=9)
    first: Literal["host", "guest", "alternate", "random", "winner", "loser"] = "host"


class TournamentSettings(Settings):
    """A tournament: the match every pairing plays (as for a table), and how the bracket is made."""
    name: str = Field(default="Golf Tournament", min_length=1, max_length=48)
    best_of: StrictInt = Field(default=1, ge=1, le=9)  # every match-up needs an end: no open-ended series
    format: Literal["single", "double", "round_robin"] = "single"
    seeding: Literal["random", "mmr"] = "random"
    # places nobody takes: AI opponents, or byes (whoever meets one goes straight through)
    fill: Literal["ai", "byes"] = "byes"
    ranked: bool = False


class TournamentAward(BaseModel):
    winner: Literal[0, 1]


class TournamentEntrant(BaseModel):
    entrant: str = Field(min_length=1, max_length=16)


class Join(BaseModel):
    username: str = Field(min_length=1, max_length=32)
    avatar: str | None = Field(default=None, max_length=32)
    # "link": the player arrived by opening the table's invite link
    via: Literal["link"] | None = None


class Presence(Join):
    visible: bool = False  # the page is in front of the player, not in a background tab


class FriendRequest(BaseModel):
    unique_name: str = Field(min_length=1, max_length=25)


class InvitePlayer(BaseModel):
    player_id: str = Field(min_length=1, max_length=32)


class InviteReply(BaseModel):
    accept: bool
    username: str = Field(default="Player", min_length=1, max_length=32)
    avatar: str | None = Field(default=None, max_length=32)


class DebugEdit(BaseModel):
    model_config = ConfigDict(extra="forbid")
    op: Literal["end", "flip", "set"]
    ref: list[StrictInt] | None = Field(default=None, min_length=2, max_length=2)
    rank: StrictInt | None = Field(default=None, ge=1, le=13)
    suit: Literal["S", "H", "D", "C"] | None = None


class Move(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["flip", "draw", "swap", "discard", "end_turn", "guess", "arrange", "set_rule", "set_rules", "ready", "start", "next_round", "rematch", "retry"]
    version: StrictInt = Field(ge=0)
    index: StrictInt | None = Field(default=None, ge=0, le=5)
    refs: list[list] = Field(default_factory=list, max_length=2)
    rank: StrictInt | None = Field(default=None, ge=1, le=13)
    columns: list[StrictInt] | None = Field(default=None, min_length=2, max_length=2)
    rule: str | None = None
    enabled: bool | None = None
    rules: dict[str, bool] | None = None


class VoidReply(BaseModel):
    accept: bool


class GoogleCredential(BaseModel):
    credential: str = Field(min_length=1, max_length=8192)
    csrf_token: str = Field(min_length=1, max_length=128)


class AccountName(BaseModel):
    unique_name: str = Field(min_length=3, max_length=24)
    csrf_token: str = Field(min_length=1, max_length=128)


class Preferences(BaseModel):
    preferences: dict


class Logout(BaseModel):
    csrf_token: str = Field(min_length=1, max_length=128)


@dataclass
class Session:
    token: str
    username: str = "Player"
    room_id: str | None = None
    touched: float = field(default_factory=time.time)
    account: dict | None = None
    csrf_token: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    google_nonce: str = field(default_factory=lambda: secrets.token_urlsafe(32))
    nonce_expires: float = field(default_factory=lambda: time.time() + 600)
    auth_attempts: list = field(default_factory=list)
    public_id: str = field(default_factory=lambda: secrets.token_urlsafe(12))
    online_until: float = 0
    seen_saved: float = 0  # when this signed-in player's "last seen" was last written down
    looking_until: float = 0  # a page of theirs was last in front (presence said so) until then
    invite_times: list = field(default_factory=list)
    avatar: str = DEFAULT_AVATAR
    # spectating: the table being watched, and its players (to follow them to their next table)
    watching: str | None = None
    watch_tokens: list = field(default_factory=list)
    # the tournament this player has entered, if any
    tournament_id: str | None = None


@dataclass
class Room:
    id: str
    name: str
    rules: Rules
    best_of: int | None
    first: str
    solo: bool
    seats: list
    names: list
    status: str = "waiting"
    ready: list = field(default_factory=lambda: [False, False])
    wins: list = field(default_factory=lambda: [0, 0])
    history: list = field(default_factory=list)
    game: GolfGame | None = None
    version: int = 0
    round_recorded: bool = False
    last_winner: int | None = None
    champion: int | None = None
    touched: float = field(default_factory=time.time)
    clients: dict = field(default_factory=dict)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    bot_task: asyncio.Task | None = None
    history_store: MatchHistory | None = None
    match_id: str = field(default_factory=lambda: secrets.token_urlsafe(12))
    started_at: float = field(default_factory=time.time)
    emotes: dict = field(default_factory=dict)
    emote_sequence: int = 0
    # emotes each seat has sent since the last game was saved (for the Biggest yapper record)
    emote_counts: list = field(default_factory=list)
    # each seat's moves this game, as flag codes (see flags.MOVE_CODES), saved with it
    move_log: list = field(default_factory=list)
    participants: list = field(default_factory=lambda: [None, None])
    house_rules: bool = False
    house_version: str | None = None
    departed: list = field(default_factory=lambda: [False, False])
    series_mode: str = "wins"
    game_type: str = "1v1"
    score_preview: bool = True
    show_odds: bool = True  # spectators see each player's chance of winning
    patch: str = PATCH_VERSION
    series_complete: bool = False
    avatars: list = field(default_factory=lambda: [DEFAULT_AVATAR, DEFAULT_AVATAR])
    # each player's showing score after every turn of the game in play, ending
    # with the final scores once it is over (drawn as the post-game graph)
    timeline: list = field(default_factory=list)
    reaction_at: float = 0.0
    streak: int = 0  # solo: games in a row the player has won against Golfbot
    pending_reaction: str | None = None
    bot_seats: list = field(default_factory=list)  # debug tables: seats the server plays itself
    demo: bool = False
    moved_at: float = 0.0  # when the last move was made (Watch puts the busiest tables first)  # a debug server's demo table: bots only, always playing (see keep_demo_tables)
    away: set = field(default_factory=set)  # sockets whose page is in the background
    # how long each person has spent on their turns in the game in play: seconds
    # and turns per seat, and the turn being timed now
    move_seconds: list = field(default_factory=list)
    move_counts: list = field(default_factory=list)
    turn_clock: dict | None = None
    # a Practice game changed from the debug menu: its result is never recorded
    debug_edited: bool = False
    # spectators' sockets by session token, and the seat each is watching from
    watchers: dict = field(default_factory=dict)
    watch_seats: dict = field(default_factory=dict)
    # each spectator's own row on wide screens, kept while they watch (lowest free first)
    watch_slots: dict = field(default_factory=dict)
    # spectators see each player's chance of winning: the last estimate, and the
    # table it was made from (see odds.py)
    odds: list | None = None
    odds_key: str | None = None
    odds_game: GolfGame | None = None
    odds_task: asyncio.Task | None = None
    # pass & play: everyone shares one device, whose session holds the first seat
    local: bool = False
    # when the game in play was dealt (saved with its result, for time played)
    round_started_at: float | None = None
    # everyone who has watched the game in play (saved with its result as a count)
    watched_by: set = field(default_factory=set)

    practice: bool = False
    rated: bool = False
    progression: object = None
    progression_players: list = field(default_factory=list)
    practice_account: str | None = None
    void_offer: dict | None = None
    void_offered: list = field(default_factory=lambda: [False, False])
    disconnected: list = field(default_factory=lambda: [None, None])
    resume_notice: str | None = None
    # a tournament match: {"id": tournament, "match": match}. Its series must
    # produce a winner when must_decide is set (extra games break a level total).
    tournament: dict | None = None
    must_decide: bool = False
    # both seats are played by Golfbot (a tournament match between two AIs)
    ai_match: bool = False
    # the seat that gave the match up by leaving or staying away, if any
    forfeited: int | None = None
    # a Ranked rematch needs both players: the seats that have asked for one
    rematch_votes: set = field(default_factory=set)
    # the Daily Puzzle: {"day": date, "number": n, "player": id, "avatar": ...,
    # "last": the attempt just finished}; puzzle_store keeps the day's best scores
    puzzle: dict | None = None
    puzzle_store: object = None

    @property
    def shows_previews(self):
        """Whether a move's score is shown before it is confirmed (always against Golfbot; never in a puzzle)."""
        return bool(self.score_preview or (self.solo and not self.puzzle))

    @property
    def shows_odds(self):
        """Whether win chances are shown (always against Golfbot; never in a puzzle)."""
        return bool(self.show_odds or (self.solo and not self.puzzle))

    @property
    def counts_streak(self):
        """Practice, with any rules, builds the streak the Solo leaderboard ranks."""
        return self.practice

    def save_practice(self):
        if self.practice and self.practice_account and self.progression and self.game:
            # Saving is a convenience: a failure must never undo the move around it.
            # It runs after the move has changed the table, so raising here used to
            # skip the broadcast and the bot's wake-up, leaving the player a stale
            # table ("The table changed") and Golfbot idle.
            try:
                self.progression.save_practice(self.practice_account, practice_save.save(self))
            except Exception:
                log.exception("Could not save practice game for table %s", self.id)

    def _turn_key(self):
        game = self.game
        if game is None or game.phase in ("setup", "over") or game.scoring_reveal:
            return None
        return game.turns, game.current

    def acting_seat(self):
        """Pass & play: the seat the shared device is playing for right now."""
        game = self.game
        if game is None or self.status != "playing" or game.phase == "over":
            return 0
        if game.phase == "setup":
            # opening flips go round the table, two each
            return next((p for p in game.turn_order if game.visible_count(p) < 2), 0)
        return game.decision_player

    def seat_present(self, seat):
        """A person (never a bot) with the table open and in front of them right now."""
        token = self.seats[seat] if seat < len(self.seats) else None
        return bool(token and seat not in self.bot_seats
                    and any(ws not in self.away for ws in self.clients.get(token, ())))

    def track_turn_time(self, now=None):
        """Time each turn from the moment it becomes a player's until it ends.

        A turn only counts if the player was at the table for all of it: one
        that starts while they are away, or that they leave or disconnect
        during, is dropped, so stepping away never drags their average.
        """
        now = time.time() if now is None else now
        count = len(self.seats)
        if len(self.move_seconds) != count:
            self.move_seconds, self.move_counts = [0.0] * count, [0] * count
        key, clock = self._turn_key(), self.turn_clock
        if clock and clock["key"] != key:
            if clock["counts"] and clock["player"] < count:
                self.move_seconds[clock["player"]] += max(0.0, now - clock["started"])
                self.move_counts[clock["player"]] += 1
            clock = None
        if key and clock is None:
            clock = {"key": key, "player": key[1], "started": now, "counts": self.seat_present(key[1])}
        self.turn_clock = clock

    def drop_turn_time(self, seat=None):
        """Leave the turn in progress out of the timing (for one seat, or whoever is playing)."""
        key = self._turn_key()
        if self.turn_clock is None and key:
            self.turn_clock = {"key": key, "player": key[1], "started": time.time(), "counts": False}
        if self.turn_clock and seat in (None, self.turn_clock["player"]):
            self.turn_clock["counts"] = False

    def expire_offer(self):
        if self.void_offer and self.void_offer['expires_at'] <= time.time():
            self.void_offer = None
            self.version += 1

    @property
    def capacity(self):
        return 32 if self.game_type == "many" else 2

    @property
    def has_open_seat(self):
        return self.status == "waiting" and (len(self.seats) < self.capacity or None in self.seats)

    @property
    def points(self):
        return [sum(result['scores'][p] for result in self.history) for p in range(len(self.seats))]

    @property
    def series_leaders(self):
        if self.champion is not None:
            return [self.champion]
        if not self.series_complete:
            return []
        candidates = list(range(len(self.seats)))
        if self.best_of is None:
            candidates = [p for p in candidates if self.wins[p] == max(self.wins)]
        minimum = min(self.points[p] for p in candidates)
        return [p for p in candidates if self.points[p] == minimum]

    def resize_seats(self):
        count = len(self.seats)
        for key, default in (('ready', False), ('wins', 0), ('participants', None), ('departed', False),
                             ('avatars', DEFAULT_AVATAR)):
            values = getattr(self, key)
            setattr(self, key, (values + [default] * count)[:count])

    @property
    def target(self):
        return self.best_of // 2 + 1 if self.best_of is not None and self.series_mode == 'wins' else None

    def finish_continuous(self):
        if self.best_of is not None or not all(self.departed) or not self.history:
            return
        leaders = [p for p, wins in enumerate(self.wins) if wins == max(self.wins)]
        best = min(self.points[p] for p in leaders)
        winners = [p for p in leaders if self.points[p] == best]
        self.champion = winners[0] if len(winners) == 1 else None
        self.series_complete = True

    def flush_emotes(self):
        """Put the emotes sent since the last saved game onto the newest game's record."""
        if not self.history or not any(self.emote_counts):
            return
        saved = self.history[-1].setdefault('emotes', [0] * len(self.seats))
        for seat, count in enumerate(self.emote_counts[:len(saved)]):
            saved[seat] += count
        self.emote_counts = []

    def start_round(self):
        self.round_started_at = time.time()
        self.watched_by = {token for token, sockets in self.watchers.items() if sockets}
        self.resize_seats()
        self.move_log = [[] for _ in self.seats]
        if self.practice and self.house_rules:
            # A saved Play solo run outlives updates, so each new deal is played with
            # the House rules as they are now. Compared rule by rule, not by version:
            # a rule added to House rules reaches saved runs even if nobody
            # remembered to raise HOUSE_VERSION.
            current = parse_rules(house_rules())
            if self.rules != current or self.house_version != HOUSE_VERSION:
                self.rules, self.house_version = current, HOUSE_VERSION
        self.void_offer = None
        self.void_offered = [False, False]
        if self.rated or self.tournament:
            self.disconnected = [None if self.clients.get(token) else time.time() for token in self.seats]
        round_index = len(self.history)
        first = (0 if self.first == "host" else 1 if self.first == "guest" else
                 secrets.randbelow(2) if self.first == "random" else
                 self.last_winner if self.first == "winner" and self.last_winner is not None else
                 1 - self.last_winner if self.first == "loser" and self.last_winner is not None else
                 round_index % 2)
        order = list(range(len(self.seats)))
        if self.game_type == 'many':
            secrets.SystemRandom().shuffle(order)
            first = order[0]
        self.game = GolfGame(rules=self.rules, multiplayer=not self.solo, first_player=first,
                             player_count=len(self.seats), turn_order=order)
        self.status = "playing"
        self.ready = [False] * len(self.seats)
        if self.solo:
            self.ready[1] = True
        for seat in self.bot_seats:
            self.ready[seat] = True
        self.round_recorded = False
        self.timeline = []
        self.move_seconds, self.move_counts = [0.0] * len(self.seats), [0] * len(self.seats)
        self.turn_clock = None
        self.emotes.clear()
        self.save_practice()

    def track_scores(self):
        """Add a point to the score timeline when a turn ends, and the final scores at the end."""
        game = self.game
        self.moved_at = time.time()
        self.track_turn_time()
        if game is None or game.phase == "setup" or (self.timeline and self.timeline[-1]["final"]):
            return
        if game.phase == "over":
            self.timeline.append({"turn": game.turns, "scores": [game.score(p) for p in range(game.player_count)],
                                  "final": True})
        elif not self.timeline or game.turns > self.timeline[-1]["turn"]:
            self.timeline.append({"turn": game.turns, "scores": showing_scores(game), "final": False})

    def start_puzzle(self):
        """Deal the day's puzzle again: the same cards as every attempt."""
        self.game = daily_puzzle.new_puzzle(self.puzzle["spec"])
        self.status, self.round_recorded, self.timeline = "playing", False, []
        self.puzzle["last"] = None
        self.round_started_at = time.time()
        self.move_seconds, self.move_counts, self.turn_clock = [0.0, 0.0], [0, 0], None
        self.emotes.clear()
        try:
            self.puzzle_store.attempt(self.puzzle["day"], self.puzzle["player"], self.names[0], self.avatars[0])
        except Exception:
            log.exception("Could not count a puzzle attempt at table %s", self.id)

    def record_puzzle(self):
        score, bot = self.game.score(0), self.game.score(1)
        self.round_recorded = True
        self.status = "finished"
        # the day's score is the margin: Golfbot's points minus yours (+5: you won by 5)
        margin = bot - score
        last = {"score": score, "bot": bot, "margin": margin, "won": score < bot, "drawn": score == bot, "new_best": False}
        try:
            last["new_best"] = self.puzzle_store.finish(self.puzzle["day"], self.puzzle["player"],
                                                        self.names[0], self.avatars[0], margin)
        except Exception:
            log.exception("Could not record the puzzle score at table %s", self.id)
        self.puzzle["last"] = last

    def record_result(self):
        if self.game is None or self.game.phase != "over" or self.round_recorded:
            return
        if self.puzzle:
            return self.record_puzzle()
        scores = [self.game.score(p) for p in range(len(self.seats))]
        self.game._record_scoring_effects()
        leaders = [p for p, score in enumerate(scores) if score == min(scores)]
        winner = leaders[0] if len(leaders) == 1 else None
        self.history.append({"round": len(self.history) + 1, "scores": scores, "winner": winner,
                             "rules": asdict(self.game.rules),
                             "house_rules": self.house_rules, "house_version": self.house_version,
                             "patch": self.patch,
                             "turns": self.game.turns,
                             # who had the first turn, and whether that was left to chance
                             "first": self.game.first_player,
                             "first_random": self.first == "random" or self.game_type == "many",
                             "spectators": len(self.watched_by),
                             "started_at": self.round_started_at,
                             # the scores showing after each turn (for the comeback record)
                             "timeline": [point["scores"] for point in self.timeline if not point["final"]],
                             "ended_at": time.time(),
                             # time each person spent on the turns they were at the table for
                             "move_seconds": [round(seconds, 1) for seconds in self.move_seconds],
                             "move_counts": list(self.move_counts),
                             # every seat's moves, as codes (what flags are earned by)
                             "moves": ["".join(log) for log in self.move_log],
                             "activations": [sorted(keys) for keys in self.game.activated_rules],
                             "divisors": [self.game.score_divisor(p) for p in range(len(self.seats))]})
        self.history[-1].update(modifier_data(self.game, visible_only=False))
        self.flush_emotes()
        self.last_winner = winner
        if self.solo:
            self.streak = self.streak + 1 if winner == 0 else 0
        self.round_recorded = True
        self.ready = [False] * len(self.seats)
        if self.solo:
            self.ready[1] = True
        for seat in self.bot_seats:
            self.ready[seat] = True
        if winner is not None:
            self.wins[winner] += 1
        if self.series_mode == 'points' and self.best_of is not None and len(self.history) >= self.best_of:
            leaders = [p for p, points in enumerate(self.points) if points == min(self.points)]
            self.champion = leaders[0] if len(leaders) == 1 else None
            if self.champion is None and self.must_decide:
                self.status = 'round_over'  # level on points: another game breaks the tie
            else:
                self.status = 'finished'
                self.series_complete = True
        elif self.target is not None and max(self.wins) >= self.target:
            self.champion = self.wins.index(max(self.wins))
            self.status = "finished"
            self.series_complete = True
        else:
            self.status = "round_over"
        # The game is already over at the table: a storage failure here must not
        # stop the move's broadcast, or the players never see the final cards.
        try:
            if self.debug_edited:
                pass  # cards were changed by hand: no stats, streak or history
            elif self.progression:
                event_id = self.match_id + ':' + str(len(self.history))
                if self.rated:
                    # every Ranked game moves the game rating; the series it decides moves MMR
                    self.history[-1]['game_rating'] = self.progression.rate_game(event_id, self.progression_players, winner, self.patch)
                    if self.series_complete:
                        self.history[-1]['mmr'] = self.progression.rate_series(
                            self.match_id + ':series', self.progression_players, self.champion, self.patch)
                        self.history[-1]['series_winner'] = self.champion
                if self.counts_streak:
                    self.progression.practice_result(event_id, self.progression_players[0], winner, self.patch)
            if self.history_store and not self.debug_edited:
                self.history_store.save(self)
        except Exception:
            log.exception("Could not record the result of table %s", self.id)
        self.save_practice()


class PuzzleMaker:
    """Makes each day's puzzle once (see puzzle.generate) and keeps it.

    The deals are played out in processes of their own, a few at a time, so the
    server keeps answering meanwhile; today's and tomorrow's are made ahead (see
    keep_puzzles_made), so nobody waits on one. With one candidate (a store in
    memory, as the tests use) the first deal is taken without playing it out."""
    def __init__(self, scores, candidates=daily_puzzle.CANDIDATES):
        self.scores, self.candidates = scores, candidates
        self.specs, self.locks, self.pool = {}, {}, None

    async def spec(self, day):
        if day in self.specs:
            return self.specs[day]
        async with self.locks.setdefault(day, asyncio.Lock()):
            if day not in self.specs:
                saved = await asyncio.to_thread(self.scores.saved_spec, day)
                if saved is None:
                    saved = await self.make(day)
                self.specs[day] = saved
        return self.specs[day]

    async def make(self, day):
        options = daily_puzzle.candidates(day, self.candidates)
        if len(options) > 1:
            try:
                if self.pool is None:
                    self.pool = ProcessPoolExecutor(max_workers=min(4, max(1, (os.cpu_count() or 2) - 1)),
                                                    mp_context=multiprocessing.get_context("spawn"))
                loop = asyncio.get_running_loop()
                results = await asyncio.gather(*(loop.run_in_executor(self.pool, daily_puzzle.evaluate, option)
                                                 for option in options))
                spec = daily_puzzle.choose(options, results)
                log.info("Daily puzzle for %s: %s, %s moves, %s face up, %s", day, spec["theme"],
                         spec["moves"], spec["face_up"], spec["metrics"])
            except Exception:
                # (not kept: the next try makes it properly)
                log.exception("Could not make the daily puzzle for %s; dealing its first candidate", day)
                return {**options[0], "metrics": None}
        else:
            spec = {**options[0], "metrics": None}
        return await asyncio.to_thread(self.scores.save_spec, day, spec)

    def close(self):
        if self.pool is not None:
            self.pool.shutdown(wait=False, cancel_futures=True)


class Store:
    def __init__(self, history_path=":memory:"):
        self.sessions = {}
        self.rooms = {}
        self.history = MatchHistory(history_path)
        self.accounts = Accounts(self.history)
        self.progression = Progression(self.history)
        self.progression.merge_stay()
        self.puzzles = daily_puzzle.PuzzleScores(self.history)
        self.puzzle_maker = PuzzleMaker(self.puzzles, 1 if str(history_path) == ":memory:" else daily_puzzle.CANDIDATES)
        self.friends = Friends(self.history)
        self.invitations = {}
        self.tournaments = {}
        self.queue = {}
        self.queue_offers = {}
        self.queue_results = {}
        self.queue_notices = {}
        self.queue_switching = set()
        # a declined pair: frozenset of two tokens -> (cooldown end, each one's queue join time then)
        self.queue_declined = {}
        self.queue_lock = asyncio.Lock()
        # turn and Ranked queue notifications: each browser's push subscription and
        # which of the two it wants (kept beside the match history so a restart
        # does not forget them), and the last turn it was told about
        self.push_file = None if str(history_path) == ":memory:" else Path(history_path).with_name("push-subscriptions.json")
        self.push_subscriptions = {}
        if self.push_file and self.push_file.exists():
            try:
                self.push_subscriptions = json.loads(self.push_file.read_text(encoding="utf-8"))
            except (OSError, ValueError):
                self.push_subscriptions = {}
        self.push_told = {}
        self.queue_alerted = {}  # token -> when it was last told someone joined the Ranked queue
        self.push_keys = None  # loaded or made on first use; False when pywebpush is missing
        self.push_contact = None

    def session(self, token):
        session = self.sessions.get(token)
        if session is None:
            raise HTTPException(401, "Open the home page to create a session.")
        session.touched = time.time()
        return session

    def table_count(self):
        """Tables counted against the server's limit: not a debug server's demo tables."""
        return sum(not room.demo for room in self.rooms.values())

    def cleanup(self):
        # (a table nobody is at, and that nothing has happened at, for 15 minutes is put away)
        cutoff = time.time() - TABLE_IDLE_SECONDS
        for key, room in list(self.rooms.items()):
            if room.touched < cutoff and not any(room.clients.values()):
                if room.bot_task:
                    room.bot_task.cancel()
                room.save_practice()
                room.departed = [True] * len(room.seats)
                if not (room.practice and room.practice_account):
                    room.finish_continuous()
                self.history.save(room, abandoned=True)
                del self.rooms[key]
        for token, session in list(self.sessions.items()):
            if session.touched < time.time() - 24 * 3600:
                del self.sessions[token]


TABLE_IDLE_SECONDS = 15 * 60  # how long an empty, idle table is kept
RATED_GRACE = 180  # seconds a rated player may be away before it counts as leaving


def debug_mode():
    return os.environ.get("GOLFBOT_DEBUG", "") not in ("", "0", "false")


# A debug server's demo players (named as the 8-bot debug table's bots are): they play
# the demo tables on Watch, and three of them sit on the PvP leaderboard. Nothing about
# them is saved.
DEMO_BOTS = ["Ace", "Birdie", "Bogey", "Caddie", "Eagle", "Fairway", "Mulligan"]
DEMO_AVATARS = {"Ace": "tree", "Birdie": "bird", "Bogey": "cat", "Caddie": "fish", "Eagle": "hare",
                "Fairway": "tortoise", "Mulligan": "ladybug"}
# (MMR, rating deviation, series won-drawn-lost, games won-drawn-lost)
DEMO_RANKED = {"Ace": (1284, 74, (19, 1, 6), (61, 2, 25)), "Birdie": (1172, 88, (12, 0, 9), (44, 1, 37)),
               "Bogey": (1046, 112, (5, 1, 7), (22, 2, 29))}


def demo_profile(name):
    return {'id': f'demo:{name.lower()}', 'kind': 'bot', 'display_name': name}


def demo_mmr(profile):
    """A demo player's MMR (None for anyone else)."""
    name = str((profile or {}).get('display_name', ''))
    return DEMO_RANKED[name][0] if str((profile or {}).get('id', '')).startswith('demo:') and name in DEMO_RANKED else None


def demo_stats_entry(player_id):
    """A demo player's numbers for a profile's comparison (None for one off the leaderboard)."""
    name = player_id.split(':', 1)[1].title()
    if name not in DEMO_RANKED:
        return None
    mmr, rd, series, games = DEMO_RANKED[name]
    played = sum(games)
    return {'profile': {'id': player_id, 'username': name, 'unique_name': None, 'is_bot': False, 'is_guest': False,
                        'display_names': [name], 'label': name},
            'overall': {'rounds': played, 'round_wins': games[0], 'round_draws': games[1], 'round_losses': games[2],
                        'round_win_rate': games[0] / played if played else 0, 'average_turns': 9.4,
                        'match_wins': series[0], 'match_draws': series[1], 'match_losses': series[2],
                        'match_win_rate': series[0] / sum(series) if sum(series) else None},
            'ratings': {'series': {'rating': mmr, 'rd': rd, 'provisional': False},
                        'game': {'rating': mmr - 20, 'rd': rd + 10, 'provisional': False}}}


def demo_leaderboard_rows():
    return [{'id': f'demo:{name.lower()}', 'label': name, 'mmr': mmr, 'rd': rd, 'provisional': False,
             'wins': series[0], 'draws': series[1], 'losses': series[2], 'win_rate': series[0] / sum(series),
             'game_rating': mmr - 20, 'games': {'wins': games[0], 'draws': games[1], 'losses': games[2]}}
            for name, (mmr, rd, series, games) in DEMO_RANKED.items()]


def clean_name(value):
    value = value.strip()
    if not value or any(ord(char) < 32 for char in value):
        raise HTTPException(422, "Please enter a name without control characters.")
    return value


def parse_rules(values):
    values = upgrade_rule_values(values)
    legacy = values.pop('queen_swap', False) or values.get('jack_swap', False)
    values.pop('jack_swap', None)
    if legacy:
        values.setdefault('royal_pairs', True)
    if set(values) - set(Rules.__dataclass_fields__):
        raise HTTPException(422, "Unknown rule selection.")
    return Rules(**values)


def choose_avatar(session, value):
    """Remember a requested avatar on the session; None keeps the current one."""
    if value is not None:
        try:
            session.avatar = clean_avatar(value)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error


def card_view(card):
    return {"rank": card.rank, "label": card.label, "suit": card.suit, "points": card.base_points}


def showing_scores(game):
    """What each player's face-up cards are worth with the rules in play (their score tag)."""
    return [game.score(p) if game.phase == "over" else visible_effect_total(
        game.players[p], game.rules, game.angels_earned[p], poisoned=game.finisher == p,
        opponent_layouts=[game.players[q] for q in game.opponents(p)],
        incoming_angels=[game.angels_earned[q] for q in game.opponents(p)]) for p in range(game.player_count)]


def score_view(game):
    """Every score tag and the rules behind it, read off the cards anyone can see."""
    return {
        "effect_totals": showing_scores(game),
        "effects": [active_rule_effects(game.players[p], game.rules, game.angels_earned[p],
            poisoned=game.finisher == p,
            opponent_layouts=[game.players[q] for q in game.opponents(p)],
            incoming_angels=[game.angels_earned[q] for q in game.opponents(p)]) for p in range(game.player_count)],
        "modifier_counts": [sum(counts.values()) for counts in modifier_data(game)["modifier_counts"]],
    }


def bot_reaction(room, game, before):
    """The emote Golfbot answers an upset with, if it reacts at all.

    The margin is the human's score minus Golfbot's: above zero, Golfbot is ahead
    (lower scores win). A big swing toward Golfbot gets a laugh; one against it
    gets shock when the lead changes hands, nerves when it is only closing in.
    """
    if not room.solo or before is None or room.game is not game or game.phase == "setup":
        return None
    if time.time() - room.reaction_at < REACTION_COOLDOWN:
        return None
    after = showing_scores(game)
    margin_before, margin_after = before[0] - before[1], after[0] - after[1]
    swing = margin_after - margin_before
    flipped = margin_before * margin_after < 0
    if abs(swing) < UPSET_SWING and not (flipped and abs(swing) >= UPSET_FLIP_SWING):
        return None
    if reaction_roll() >= REACTION_CHANCE:
        return None
    room.reaction_at = time.time()
    if swing > 0:
        return "laughing"
    return "shocked" if flipped else "nervous"


def public_room(room):
    return {"id": room.id, "name": room.name, "names": room.names, "status": room.status,
            "best_of": room.best_of, "first": room.first, "rules": asdict(room.rules),
            "players": sum(seat is not None for seat in room.seats), "solo": room.solo,
            "house_rules": room.house_rules, "house_version": room.house_version,
            "series_mode": room.series_mode, "game_type": room.game_type, "capacity": room.capacity,
            "score_preview": room.shows_previews, "show_odds": room.shows_odds,
            "patch": room.patch, "avatars": room.avatars, "practice": room.practice, "rated": room.rated,
            "rematch_votes": sorted(room.rematch_votes),
            "tournament": room.tournament, "ai_match": room.ai_match}


def message(room, viewer):
    game = room.game
    if room.void_offer:
        return "Gameplay paused: an offer to void this game is pending."
    if room.status == "closed":
        if room.tournament:
            return "This match is over. The bracket has the result, and your next match if there is one."
        return "The other player left. Return to the menu to find a new table."
    if game is None:
        return "The host starts with at least three players." if room.game_type == 'many' else "Waiting for a second player. The game starts when they join."
    if game.phase == "over" and room.puzzle:
        margin = game.score(1) - game.score(0)
        return f"Puzzle done: you have {game.score(0)} points, PuzzleBot {game.score(1)}: a margin of {margin:+d}."
    if game.phase == "over":
        result = room.history[-1]
        return "Game drawn." if result["winner"] is None else f"{room.names[result['winner']]} wins this game."
    if game.phase == "setup":
        return "Select and flip two of your cards to start." if game.visible_count(viewer) < 2 else "Waiting for the opponent's opening flips."
    if game.decision_player != viewer:
        return f"Waiting for {room.names[game.decision_player]}'s decision."
    return {
        "choose": "Your turn: Flip, Draw, or Swap with the discard.",
        "revealed": "Swap the card you flipped, Draw, or End turn.",
        "drawn": "Swap with any of your cards, Flip a hidden card, or Discard.",
        "drawn_revealed": "Swap with the card you flipped, or Discard your draw.",
        "bonus": f"Bonus swap ({game.bonus_remaining} left): select any two table cards.",
        "guess": "Guess the rank of the selected opponent card, or pass.",
        "guess_trade": "Correct! Select your highest and their lowest highlighted cards; Swap.",
        "arrange": "Choose two columns for four of a kind, or keep the layout.",
    }.get(game.phase, "Waiting...")


def public_emotes(room):
    now = time.time()
    return [{**emote, "remaining_ms": int((emote["expires_at"] - now) * 1000)}
            for emote in room.emotes.values() if emote["expires_at"] > now]


def spectator_odds(room):
    """Each player's chance of winning this game. Just after a move it is the last
    estimate, until the new one is ready (refresh_odds sends it on)."""
    game = room.game
    if (game is None or room.status != "playing" or game.phase == "over" or room.odds_game is not game
            or not room.shows_odds):  # the host can turn these off
        return None
    return room.odds


def odds_stale(room):
    game = room.game
    return (game is not None and room.status == "playing" and game.phase != "over" and room.shows_odds
            and any(room.watchers.values()) and odds_key(game) != room.odds_key)


async def refresh_odds(room, send):
    """Work out the chances again for a table that has changed, then show the spectators.

    It runs in a thread (it takes a moment), after the players have their update."""
    while odds_stale(room):
        game = room.game
        key = odds_key(game)
        try:
            odds = await asyncio.to_thread(win_odds, public_position(game), 300, 0.3)
        except Exception:
            log.exception("Win chances failed at table %s", room.id)
            return
        if room.game is game and odds_key(game) == key:
            room.odds, room.odds_key, room.odds_game = odds, key, game
            await send()


def puzzle_rows(board, me, friends=(), progression=None):
    """The day's puzzle board as a player sees it: whether each row is theirs or a
    friend's, whose profile it opens (a guest's public id is the one the leaderboards
    and records already show), and the MMR of anyone who has played a Ranked series
    (with "provisional" while it is still settling)."""
    rows = []
    for row in board:
        row = dict(row)
        player = row.pop("player")
        row["mine"] = player == me
        row["friend"] = player in friends
        if player.startswith(("account:", "browser:")):
            row["id"] = player
            if progression is not None:
                try:
                    series = progression.ratings(player)['series']
                    if series['wins'] + series['draws'] + series['losses']:
                        row["mmr"], row["provisional"] = series['rating'], series['provisional']
                except Exception:
                    log.exception("Could not look up the MMR of a puzzle player")
        rows.append(row)
    return rows


def snapshot(room, token, watch=False):
    """The table as one seat sees it; a spectator (watch) sees the first seat's view, with no moves."""
    if token not in room.seats and not watch:
        raise HTTPException(403, "You do not have a seat in this lobby.")
    room.expire_offer()
    viewer = 0 if watch else room.acting_seat() if room.local else room.seats.index(token)
    state = {**public_room(room), "viewer": viewer, "version": room.version,
             "spectator": watch, "watchers": sum(bool(sockets) for sockets in room.watchers.values()),
             # how many are watching from each player's seat (their name tag shows it)
             "watchers_by_seat": [sum(1 for other, sockets in room.watchers.items() if sockets
                                      and room.watch_seats.get(other, 0) == seat) for seat in range(len(room.seats))],
             "emotes": public_emotes(room),
             "ready": room.ready, "wins": room.wins, "target": room.target,
             "history": room.history, "champion": room.champion,
             # (a table that closed after its series was decided still shows that result)
             "series_complete": room.series_complete,
             "points": room.points, "timeline": room.timeline,
             # who is in each seat, for opening their stats from the table
             "player_ids": [(profile or {}).get("id") for profile in room.participants],
             # each seat's custom card designs (Your Deck), to draw their cards in
             "skins": [DECK_SKINS.get((profile or {}).get("id")) or {} for profile in room.participants],
             "streak": room.streak if room.solo and not room.practice and not room.tournament and not room.puzzle else None,
             "round": len(room.history) + (0 if room.round_recorded else 1),
             "connected": [p in room.bot_seats or room.local or room.ai_match or (bool(room.clients.get(seat)) if seat else room.solo and p == 1) for p, seat in enumerate(room.seats)],
             "local": room.local,
             # the debug 8-bot table, where the debug tools work as in Practice
             "debug_table": bool(room.bot_seats),
             "odds": spectator_odds(room) if watch else None,
             "message": message(room, viewer), "game": None}
    if room.progression:
        if room.rated:
            state['ratings'] = [room.progression.mmr(identity) for identity in room.progression_players]
            if not watch:
                state['forfeit_mmr_loss'] = room.progression.forfeit_loss(room.progression_players, viewer)
        if room.counts_streak:
            profile = room.progression.profile(room.progression_players[0])
            state['streak'] = {'current': profile['current_streak'], 'best': profile['best_streak'], 'draws': profile['draws_in_row']}
    if room.puzzle:
        store = room.puzzle_store
        day = room.puzzle["day"]
        state["puzzle"] = {"number": room.puzzle["number"], "day": day.isoformat(),
                           "theme": daily_puzzle.describe(room.puzzle["spec"]),
                           "last": room.puzzle.get("last"),
                           **(store.mine(day, room.puzzle["player"]) if store else {}),
                           # (who is who stays on the server: each row just says whether it is yours)
                           "board": puzzle_rows(store.board(day) if store else [], room.puzzle["player"], progression=room.progression)}
        # each attempt is dealt in afresh, like a new game
        state["round"] = state["puzzle"].get("attempts") or 1
    state['void_offer'] = room.void_offer
    state['void_offered'] = room.void_offered
    state['resume_notice'] = room.resume_notice
    game = room.game
    if game is None:
        return state
    active = not watch and room.status == "playing" and not room.void_offer and game.decision_player == viewer
    opening = not watch and room.status == "playing" and not room.void_offer and game.phase == "setup" and game.visible_count(viewer) < 2
    legal = {
        "flip": [i for i, slot in enumerate(game.players[viewer]) if not slot.visible]
                if opening or active and game.phase in ("choose", "drawn") else [],
        "swap": game.targets() if active else [],
        "draw": active and game.phase in ("choose", "revealed"),
        "discard": active and game.phase in ("drawn", "drawn_revealed"),
        "end_turn": active and game.phase == "revealed",
        "bonus": active and game.phase == "bonus",
        "guess": active and game.phase == "guess",
        "trade": game.guess_trade_targets() if active and game.phase == "guess_trade" else [[], []],
        "arrange": [list(cols) for cols in ((0, 1), (0, 2), (1, 2))
                    if game.arrangement_plan(game.arrange_pending["player"], game.arrange_pending["rank"], cols)]
                    if active and game.phase == "arrange" else [],
        "keep_layout": active and game.phase == "arrange",
        # solo: the rules can change until you flip your first card (House rules too)
        "set_rules": (not watch and room.solo and not room.tournament and viewer == 0
                      and game.phase == "setup" and game.visible_count(0) == 0),
    }
    last_move = game.last_move
    actor = re.match(r'^Player (\d+) ', last_move)
    if actor and int(actor[1]) <= len(room.names):
        last_move = room.names[int(actor[1]) - 1] + ' ' + last_move[actor.end():]
    elif last_move.startswith("You "):
        last_move = room.names[0] + last_move[3:]
    elif last_move.startswith("Opponent "):
        last_move = room.names[1] + last_move[8:]
    state["game"] = {
        "phase": game.phase, "current": game.current, "decision_player": game.decision_player,
        "first_player": game.first_player, "final_turn": game.is_final_turn, "ending": game.finisher is not None,
        "turn_order": game.turn_order, "turns": game.turns, "deck_count": game.deck_count,
        # (a puzzle: the moves PuzzleBot has left; the hand ends with its last)
        "bot_moves_left": game.puzzle_moves_left, "puzzle_moves": game.puzzle_moves,
        "next_up": game.next_up,
        # how many turns away each seat's next turn is (big tables: "Up in 3")
        "up_in": game.up_in,
        "players": [[{"visible": slot.visible,
                      "card": card_view(slot.card) if slot.visible else None} for slot in layout] for layout in game.players],
        "draw_count": len(game.draw_pile), "discard": card_view(game.discard_pile[-1]),
        "held": card_view(game.held_card) if game.held_card else None,
        # (whose design the top discard wears: who put it there)
        "discard_owner": getattr(game, "discard_owner", None),
        "scores": [game.score(p, game.phase != "over") for p in range(game.player_count)],
        # Plain card points (matching columns cancel, no optional rules), from the cards anyone can see.
        # effect_totals minus this is what the rules in play have done to each hand.
        "base_scores": [column_score(layout, Rules(), game.phase != "over") for layout in game.players],
        **score_view(game),
        "rule_previews": rule_preview_data(game),
        # part of the score preview, so a host who turns that off turns this off too
        "near_rules": one_move_rules(game, viewer) if not watch and room.shows_previews and room.status == "playing" else [],
        "legal": legal, "last_move": last_move,
        "guess_target": game.guess_pending["target"] if game.phase == "guess" else None,
        "last_guess": getattr(game, "last_guess", None),
        "table_refs": game.table_refs() if legal["bonus"] else [],
    }
    return state


def parse_ref(ref):
    if len(ref) != 2:
        raise HTTPException(422, "Invalid card selection.")
    owner, index = ref
    if type(owner) is int and 0 <= owner < 32 and type(index) is int and index in range(6):
        return owner, index
    if owner in ("draw", "discard") and index is None:
        return owner, None
    raise HTTPException(422, "Invalid card selection.")


def apply_move(room, token, move):
    room.expire_offer()
    if room.void_offer:
        raise HTTPException(409, "Respond to the pending offer before continuing play.")
    if room.tournament and move.action == "rematch":
        raise HTTPException(409, "A tournament match is played once.")
    if move.version != room.version:
        raise HTTPException(409, "The table changed. Please try your action again.")
    if token not in room.seats:
        raise HTTPException(403, "You do not have a seat.")
    # pass & play: the shared device moves for whoever's turn it is
    seat = room.acting_seat() if room.local and token == room.seats[0] else room.seats.index(token)
    game = room.game
    before = showing_scores(game) if room.solo and game is not None and room.status == "playing" and game.phase != "setup" else None
    if move.action == "ready":
        if room.status != "waiting" or seat != 1:
            raise HTTPException(409, "Only the guest can mark ready in a waiting lobby.")
        room.ready[seat] = True
    elif move.action == "start":
        enough = len(room.seats) >= 3 if room.game_type == 'many' else room.seats[1] is not None and room.ready[1]
        if seat != 0 or room.status != "waiting" or not enough:
            raise HTTPException(409, "The host can start when the guest is ready.")
        room.start_round()
    elif move.action == "retry":
        if not room.puzzle:
            raise HTTPException(409, "Only a puzzle can be tried again.")
        room.start_puzzle()
    elif move.action == "next_round":
        if room.status != "round_over":
            raise HTTPException(409, "The next game is not available yet.")
        room.ready[seat] = True
        if room.local:
            room.ready = [True] * len(room.seats)  # one device readies the whole table
        if all(room.ready):
            room.start_round()
    elif move.action == "rematch":
        # once a series is over, anyone at the table may start the next one;
        # a series still being played is only the host's to start over
        if room.status not in ("finished", "round_over"):
            raise HTTPException(409, "A rematch can start once the series is over.")
        if seat != 0 and room.status != "finished":
            raise HTTPException(409, "Only the host can restart a series in progress.")
        if room.rated:
            # another Ranked series counts for MMR, so it starts only once both players
            # have asked for it: nobody is pulled into a rated series they did not want
            if room.status != "finished":
                raise HTTPException(409, "A rematch can start once the series is over.")
            room.rematch_votes.add(seat)
            if len(room.rematch_votes) < len(room.seats):
                # (the table still changed: the other player is shown that this one asked)
                room.version += 1
                room.touched = time.time()
                return
        room.rematch_votes = set()
        room.forfeited = None
        room.wins, room.history, room.champion, room.last_winner = [0] * len(room.seats), [], None, None
        room.series_complete = False
        room.match_id, room.started_at = secrets.token_urlsafe(12), time.time()
        room.game, room.round_recorded = None, False
        room.ready, room.status = [False] * len(room.seats), "waiting"
        if room.solo or all(room.seats):
            room.start_round()
    else:
        if game is None or room.status != "playing":
            raise HTTPException(409, "This table is not playing a game.")
        if move.action == "flip" and game.phase == "setup":
            game.opening_reveal(seat, move.index)
        elif move.action in ("set_rule", "set_rules"):
            if not room.solo or room.tournament or seat != 0 or game.phase != "setup":
                raise HTTPException(403, "Lobby rules stay fixed during a match.")
            if game.visible_count(seat):
                raise HTTPException(409, "Rules can only change before you flip a card.")
            if move.action == "set_rules":
                if move.rules is None:
                    raise HTTPException(422, "Choose the rules to enable.")
                selected_rules = parse_rules(move.rules)
                for key, enabled in asdict(selected_rules).items():
                    game.set_rule(key, enabled)
            else:
                if move.enabled is None:
                    raise HTTPException(422, "Choose whether the rule is enabled.")
                game.set_rule(move.rule, move.enabled)
            room.rules = Rules(**asdict(game.rules))
            # still House rules only while every rule matches them
            room.house_rules = asdict(room.rules) == asdict(parse_rules(house_rules()))
            room.house_version = HOUSE_VERSION if room.house_rules else None
        else:
            if game.decision_player != seat:
                raise HTTPException(403, "It is not your decision.")
            if move.action == "flip":
                game.reveal(move.index)
            elif move.action == "draw":
                game.draw()
            elif move.action == "discard":
                game.discard()
            elif move.action == "end_turn":
                game.end_turn()
            elif move.action == "guess":
                game.submit_guess(move.rank)
            elif move.action == "arrange":
                game.arrange_four(tuple(move.columns) if move.columns is not None else None)
            elif move.action == "swap":
                if game.phase in ("bonus", "guess_trade"):
                    if len(move.refs) != 2:
                        raise HTTPException(422, "Select two different cards.")
                    refs = [parse_ref(ref) for ref in move.refs]
                    (game.bonus_swap if game.phase == "bonus" else game.guess_trade)(*refs)
                else:
                    game.swap(move.index)
            # (the move went through: it goes in the seat's log for the flags)
            if room.move_log and seat < len(room.move_log) and move.action in achievements.MOVE_CODES:
                room.move_log[seat].append(achievements.MOVE_CODES[move.action])
    room.track_scores()
    room.pending_reaction = bot_reaction(room, game, before)
    room.record_result()
    room.version += 1
    room.touched = time.time()
    room.save_practice()


def hand_rule_keys(layout, rules, can_go_out):
    """Every rule the face-up cards of one hand bring into play (no other hand needed)."""
    keys = set(scoring_rule_keys(layout, rules))
    for row in (range(3), range(3, 6)):
        ranks = {layout[i].card.rank for i in row if layout[i].visible}
        if len(ranks) == 1 and all(layout[i].visible for i in row):
            rank = ranks.pop()
            if rules.angel_numbers and rank in ANGEL_RANKS:
                keys.add('angel_numbers')
    if rules.royal_pairs and any(layout[i].visible and layout[i + 3].visible and layout[i].card.rank == layout[i + 3].card.rank
                                 and layout[i].card.rank in (11, 12) for i in range(3)):
        keys.add('royal_pairs')
    if rules.poisoned_card and can_go_out and all(slot.visible for slot in layout):
        keys.add('poisoned_card')
    return keys


EVERY_CARD = [Card(rank, suit) for rank in range(1, 14) for suit in "SHDC"]


def one_move_rules(game, player):
    """Rules not in play for this player that a single card would bring into play.

    One move is one card placed in one of their spots: every
    rank and suit is tried, whatever is on the discard right now, so a V one card
    short of V2 shows. Only face-up cards count; the rest stay unknown.
    """
    if game.phase in ("setup", "over"):
        return []
    layout, rules = game.players[player], game.rules
    can_go_out = game.finisher is None
    now = set(rule_preview_data(game)[player]) | hand_rule_keys(layout, rules, can_go_out)
    near = set()
    for index, slot in enumerate(layout):
        trial = list(layout)
        for card in EVERY_CARD:
            trial[index] = Slot(card, True)
            near |= hand_rule_keys(trial, rules, can_go_out)
    return sorted(near - now)


def preview_move(room, token, move):
    """The score tags as they would read once the viewer's swap or discard is played.

    Nothing is played and nothing hidden is used: the move is tried on a copy of
    the table, which is then scored from its face-up cards like any other.
    """
    if token not in room.seats:
        raise HTTPException(403, "You do not have a seat.")
    if not room.shows_previews:
        # the host turned previews off (and a puzzle never has them): no peeking here either
        raise HTTPException(403, "Score previews are off at this table.")
    game = room.game
    if game is None or room.status != "playing" or room.void_offer or move.version != room.version:
        raise HTTPException(409, "The table changed.")
    # (pass & play: the shared device decides for whoever is up)
    seat = room.acting_seat() if room.local and token == room.seats[0] else room.seats.index(token)
    if game.decision_player != seat:
        raise HTTPException(403, "It is not your decision.")
    if move.action == "discard" and game.phase in ("drawn", "drawn_revealed"):
        after = game.preview()
    elif move.action == "swap" and game.phase in ("bonus", "guess_trade"):
        if len(move.refs) != 2:
            raise HTTPException(422, "Select two different cards.")
        after = game.preview(refs=[parse_ref(ref) for ref in move.refs])
    elif move.action == "swap" and move.index is not None:
        after = game.preview(index=move.index)
    else:
        raise HTTPException(422, "Only a swap or a discard can be previewed.")
    return {"version": room.version, **score_view(after),
            "face_values": [sum(slot.card.base_points for slot in layout if slot.visible) for layout in after.players]}


def create_app(store=None, google_client_id=None, bot_workers=None):
    store = store or Store()
    bot_workers = bot_workers or BotWorkers()
    if google_client_id is None:
        config = ROOT / 'data' / 'google-signin.json'
        google_client_id = os.environ.get('GOLFBOT_GOOGLE_CLIENT_ID', '')
        if not google_client_id and config.exists():
            google_client_id = json.loads(config.read_text(encoding='utf-8')).get('client_id', '')
    @asynccontextmanager
    async def lifespan(app):
        try:
            store.history.interrupt_open_matches()
            monitor = asyncio.create_task(monitor_tables())
            demos = asyncio.create_task(keep_demo_tables()) if debug_mode() else None
            puzzles = asyncio.create_task(keep_puzzles_made())
            try:
                yield
            finally:
                monitor.cancel()
                puzzles.cancel()
                if demos:
                    demos.cancel()
                await asyncio.gather(monitor, puzzles, *([demos] if demos else []), return_exceptions=True)
                store.puzzle_maker.close()
                for room in store.rooms.values():
                    room.save_practice()
        finally:
            tasks = [room.bot_task for room in store.rooms.values() if room.bot_task and not room.bot_task.done()]
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            await bot_workers.close()
            store.history.close()
    app = FastAPI(title="Golf", docs_url=None, redoc_url=None, lifespan=lifespan)
    # text sent compressed (the icons, with their rough edges baked in, are half a megabyte as text)
    app.add_middleware(GZipMiddleware, minimum_size=1024)
    app.state.store = store

    @app.middleware("http")
    async def same_origin(request, call_next):
        origin = request.headers.get("origin")
        if request.method in ("POST", "DELETE", "PATCH") and origin and urlparse(origin).netloc != request.headers.get("host"):
            return Response("Cross-origin changes are not allowed.", status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        local_http = request.url.scheme == 'http' and request.url.hostname in ('localhost', '127.0.0.1', '::1')
        response.headers["Referrer-Policy"] = 'no-referrer-when-downgrade' if local_http else 'strict-origin-when-cross-origin'
        response.headers['Cross-Origin-Opener-Policy'] = 'same-origin-allow-popups'
        if request.url.path.removeprefix(request.scope.get("root_path", "")).startswith("/api"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def session_for(request):
        session = store.session(request.cookies.get(COOKIE))
        session.account = store.accounts.from_token(request.cookies.get(ACCOUNT_COOKIE))
        # a signed-in player always goes by their account's saved display name
        if session.account and session.account.get('display_name'):
            session.username = session.account['display_name']
        return session

    def set_name(session, name):
        """Take a display name the player chose, and save it to their account (if any) for every device."""
        session.username = clean_name(name)
        if session.account and session.account.get('display_name') != session.username:
            store.accounts.save_display_name(session.account['id'], session.username)
            session.account['display_name'] = session.username

    def session_view(session):
        return {"username": session.username, "room_id": session.room_id if session.room_id in store.rooms else None,
                "avatar": session.avatar, "account": session.account, "google_client_id": google_client_id,
                "csrf_token": session.csrf_token, "google_nonce": session.google_nonce, "patch": PATCH_VERSION,
                # this player's own stats profile: their account, or this browser as a guest
                "player_id": 'account:' + session.account['id'] if session.account else 'browser:' + browser_id(session),
                # a signed-in player's settings follow them (None until they save any)
                "preferences": store.accounts.preferences(session.account['id']) if session.account else None}

    def browser_id(session):
        return sha256(session.token.encode()).hexdigest()[:32]

    def csrf(session, token):
        if not secrets.compare_digest(session.csrf_token, token):
            raise HTTPException(403, 'Refresh the page and try again.')

    def profile_for(session):
        try:
            return participant(session.account, session.username, browser_id(session))
        except ValueError as error:
            raise HTTPException(409, str(error)) from error

    def account_practice_profile(session):
        # Retention can precede unique-name selection; ordinary joins still use
        # participant() and keep their existing name requirement.
        return {'id': 'account:' + session.account['id'], 'kind': 'account',
                'unique_name': session.account['unique_name'], 'display_name': session.username}

    def progression_profile(session):
        profile = account_practice_profile(session) if session.account else profile_for(session)
        if not session.account:
            profile = {**profile, 'id': 'browser:' + browser_id(session)}
        return profile

    def find_room(room_id):
        room = store.rooms.get(room_id)
        if room is None:
            raise HTTPException(404, "That lobby is no longer available.")
        return room

    async def broadcast(room):
        deliveries = []
        for token, sockets in list(room.clients.items()):
            if token not in room.seats:
                room.clients.pop(token, None)
                continue
            state = snapshot(room, token)
            for ws in list(sockets):
                deliveries.append((ws, sockets, state))
        if any(room.watchers.values()):
            watched = snapshot(room, None, watch=True)
            for sockets in list(room.watchers.values()):
                for ws in list(sockets):
                    deliveries.append((ws, sockets, watched))

        async def send(ws, sockets, state):
            try:
                await asyncio.wait_for(ws.send_json(state), timeout=3)
            except Exception:
                sockets.discard(ws)
        # A slow connection must not delay every other player at a large table.
        await asyncio.gather(*(send(*delivery) for delivery in deliveries))
        notify_turn(room)
        # spectators' win chances follow a moment later, once worked out
        if odds_stale(room) and (room.odds_task is None or room.odds_task.done()):
            async def send_watchers():
                watched = snapshot(room, None, watch=True)
                await asyncio.gather(*(send(ws, sockets, watched) for sockets in list(room.watchers.values())
                                       for ws in list(sockets)))
            room.odds_task = asyncio.create_task(refresh_odds(room, send_watchers))

    # ---------- turn and Ranked queue notifications (web push) ----------
    def push_keys():
        """The server's push signing keys, made once and kept in data/ (or None without pywebpush)."""
        if store.push_keys is not None:
            return store.push_keys or None
        try:
            from py_vapid import Vapid
            from cryptography.hazmat.primitives import serialization
        except ImportError:
            store.push_keys = False
            return None
        path = ROOT / 'data' / 'push-keys.json'
        if path.exists():
            store.push_keys = json.loads(path.read_text(encoding='utf-8'))
        else:
            vapid = Vapid()
            vapid.generate_keys()
            private = vapid.private_pem().decode()
            public = vapid.public_key.public_bytes(serialization.Encoding.X962,
                                                   serialization.PublicFormat.UncompressedPoint)
            store.push_keys = {'private': private,
                               'public': base64.urlsafe_b64encode(public).decode().rstrip('=')}
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(store.push_keys), encoding='utf-8')
        return store.push_keys

    def save_push_subscriptions():
        if store.push_file:
            try:
                store.push_file.write_text(json.dumps(store.push_subscriptions), encoding='utf-8')
            except OSError:
                log.warning('Could not save turn notification subscriptions')

    def send_push(token, subscription, payload):
        keys = push_keys()
        if not keys:
            return
        from pywebpush import WebPushException, webpush
        from py_vapid import Vapid
        try:
            webpush(subscription_info=subscription, data=json.dumps(payload), ttl=120,
                    vapid_private_key=Vapid.from_pem(keys['private'].encode()),
                    vapid_claims={'sub': store.push_contact or 'https://localhost'})
        except WebPushException as error:
            # a subscription the browser has dropped is forgotten
            if error.response is not None and error.response.status_code in (404, 410):
                store.push_subscriptions.pop(token, None)
                save_push_subscriptions()
            else:
                log.warning('Turn notification failed: %s', error)
        except Exception:
            log.exception('Turn notification failed')

    def notify_turn(room):
        """Tell the player whose turn it is, once per turn, if no page of theirs is in front."""
        game = room.game
        if game is None or room.status != 'playing' or game.phase in ('setup', 'over'):
            return
        seat = game.decision_player
        token = room.seats[seat] if seat < len(room.seats) else None
        subscription = store.push_subscriptions.get(token)
        if not subscription or not subscription.get('turn', True) or seat in room.bot_seats:
            return
        turn = f'{room.id}|{len(room.history)}|{game.turns}|{seat}'
        if store.push_told.get(token) == turn:
            return
        store.push_told[token] = turn
        if any(ws not in room.away for ws in room.clients.get(token, ())):
            return  # they are looking at the table already
        payload = {'title': 'Your turn in Golf', 'body': f'{room.name}: it\'s your move.',
                   'tag': 'golf-turn', 'url': f'lobby/{room.id}'}
        asyncio.get_running_loop().run_in_executor(None, send_push, token, subscription, payload)

    QUEUE_ALERT_GAP = 600  # seconds: one "someone joined Ranked" notification at most per player

    def notify_queue(joiner):
        """Tell everyone who asked for Ranked queue notifications that a player
        is waiting, unless they are in the queue or a game already, have Golf in
        front of them (the page shows its own note), or were told lately."""
        now = time.time()
        loop = asyncio.get_running_loop()
        for token, subscription in list(store.push_subscriptions.items()):
            if not subscription.get('queue') or token == joiner.token or token in store.queue:
                continue
            other = store.sessions.get(token)
            if other and (not queue_allowed(other) or other.looking_until > now
                          or joiner.account and other.account and joiner.account['id'] == other.account['id']):
                continue
            if now - store.queue_alerted.get(token, 0) < QUEUE_ALERT_GAP:
                continue
            store.queue_alerted[token] = now
            payload = {'title': 'Someone wants a Ranked match',
                       'body': f'{joiner.username} joined the Ranked queue. Join now to play them.',
                       'tag': 'golf-queue', 'url': ''}
            loop.run_in_executor(None, send_push, token, subscription, payload)

    def kick_bot(room):
        if room.ai_match:
            return  # a match between two AIs runs itself (ai_match_loop)
        if room.bot_seats and (room.bot_task is None or room.bot_task.done()):
            room.bot_task = asyncio.create_task(debug_bot_loop(room))
            return
        if room.solo and (not room.practice or room.clients.get(room.seats[0])) and room.game and room.status == "playing" and room.game.phase != "setup" and room.game.decision_player == 1 and (room.bot_task is None or room.bot_task.done()):
            room.bot_task = asyncio.create_task(bot_loop(room))

    def schedule_reaction(room):
        """Golfbot's emote, if a move just earned one, shown a beat after the cards land."""
        emote, room.pending_reaction = room.pending_reaction, None
        if emote:
            asyncio.create_task(react_later(room, emote))

    async def react_later(room, emote):
        await asyncio.sleep(REACTION_DELAY)
        async with room.lock:
            if room.id not in store.rooms or room.status not in ("playing", "round_over", "finished"):
                return
            room.emote_sequence += 1
            room.emotes[1] = {"id": emote, "player": 1, "sequence": room.emote_sequence,
                              "expires_at": time.time() + EMOTE_SECONDS}
            await broadcast(room)

    async def bot_loop(room):
        try:
            while True:
                # a Beggars guess holds up the player's own flip, so it comes quickly
                await asyncio.sleep(0.1 if room.game and room.game.phase == "guess" else 0.45)
                async with room.lock:
                    game = room.game
                    if room.id not in store.rooms or room.status != "playing" or (room.practice and not room.clients.get(room.seats[0])) or game.phase == "setup" or game.decision_player != 1:
                        return
                    version = room.version
                    position = public_position(game)
                    position._root_actions = set(legal_actions(game))
                    before = showing_scores(game)
                try:
                    action = await bot_workers.choose(position)
                except Exception:
                    log.exception("AI decision failed at table %s; using a legal fallback", room.id)
                    action = None
                async with room.lock:
                    if room.id not in store.rooms or room.status != "playing":
                        return
                    if room.game is not game or room.version != version:
                        # A player may have resolved an intervening decision.
                        # Re-evaluate instead of silently losing the bot task.
                        continue
                    if game.decision_player != 1:
                        return
                    allowed = legal_actions(game)
                    if action not in allowed:
                        action = fallback_action(allowed)
                    if action is None:
                        log.error("No legal AI move at table %s in phase %s", room.id, game.phase)
                        return
                    play_action(game, action)
                    room.track_scores()
                    room.pending_reaction = bot_reaction(room, game, before)
                    room.record_result()
                    room.version += 1
                    room.save_practice()
                    await broadcast(room)
                    schedule_reaction(room)
        except Exception:
            log.exception("Golfbot stopped unexpectedly at table %s", room.id)
        finally:
            if room.bot_task is asyncio.current_task():
                room.bot_task = None

    DEMO_TABLES = [
        # (name, players, best of, how a series is won, solo)
        ("Demo: five players", ["Ace", "Birdie", "Bogey", "Caddie", "Eagle"], 5, "points", False),
        ("Demo: one on one", ["Fairway", "Mulligan"], 3, "wins", False),
        ("Demo: solo", ["Birdie", "Golfbot"], None, "wins", True),
        ("Demo: 32 players", None, 3, "points", False),  # (the Demo Open's field: set below)
    ]

    def make_demo_table(name, players, best_of, series_mode, solo):
        seats = [f"demo-bot:{secrets.token_hex(6)}" for _ in players]
        room = Room(secrets.token_urlsafe(9), name, parse_rules(house_rules()), best_of, "random", solo, seats, list(players),
                    history_store=None, game_type="many" if len(players) > 2 else "1v1", series_mode=series_mode,
                    house_rules=True, house_version=HOUSE_VERSION)
        room.resize_seats()
        room.demo = True
        looks = ["tree", "bird", "dog", "cup", "fork", "club", "cat", "fish", "hare", "tortoise", "ladybug"]
        room.avatars = [BOT_AVATAR if player == "Golfbot" else DEMO_AVATARS.get(player, looks[i % len(looks)]) for i, player in enumerate(players)]
        room.participants = [{'id': 'bot:golfbot', 'kind': 'bot', 'display_name': 'Golfbot'} if player == "Golfbot"
                             else demo_profile(player) for player in players]
        room.bot_seats = list(range(len(players)))
        room.start_round()
        room.version += 1
        return room

    # A debug server's demo tournaments: the Demo Cup (the eight demo players, best of 3)
    # and the Demo Open (32 players, one game a match). (name, players, best of)
    DEMO_FIELD = DEMO_BOTS + ["Golfbot", "Albatross", "Divot", "Sandy", "Putter", "Wedge", "Tee", "Driver", "Rough",
                              "Bunker", "Hazard", "Chip", "Pitch", "Dogleg", "Fringe", "Links", "Niblick", "Spoon",
                              "Mashie", "Iron", "Hook", "Slice", "Shank", "Yips", "Gimme"]
    # (name, players, best of, format, how empty places are filled)
    DEMO_TOURNAMENTS = [("Demo Cup", DEMO_BOTS[:5], 3, "single", "byes"), ("Demo Open", DEMO_FIELD[:32], 1, "single", "ai"),
                        ("Demo Double", DEMO_FIELD[:8], 1, "double", "ai"), ("Demo Round Robin", DEMO_FIELD[:6], 1, "round_robin", "ai")]
    DEMO_TABLES[-1] = ("Demo: 32 players", [name for name in DEMO_FIELD if name != "Golfbot"][:31] + ["Golfbot"], 3, "points", False)
    DEMO_LOOKS = ["tree", "bird", "dog", "cup", "fork", "club", "cat", "fish", "hare", "tortoise", "ladybug"]

    def make_demo_tournament(name, players, best_of, format="single", fill="ai"):
        """Demo players in a single-elimination bracket, seeded by MMR. Its matches are
        played by the quick debug bots, and it is never saved."""
        tournament = Tournament(secrets.token_urlsafe(9), name, None, format, 'mmr', fill, False, settings={
            'best_of': best_of, 'series_mode': 'wins', 'first': 'random', 'house_rules': True,
            'house_version': HOUSE_VERSION, 'rules': asdict(parse_rules(house_rules())),
            'score_preview': True, 'show_odds': True})
        tournament.demo = True
        for i, player in enumerate(players):
            golfbot = player == "Golfbot"
            # (each named as a demo player, so the standings open their profile; the ones
            # off the leaderboard get a steady made-up rating from their place in the field)
            tournament.add(player, avatar=BOT_AVATAR if golfbot else DEMO_AVATARS.get(player, DEMO_LOOKS[i % len(DEMO_LOOKS)]),
                           profile={'id': 'bot:golfbot', 'kind': 'bot', 'display_name': 'Golfbot'} if golfbot else demo_profile(player),
                           rating=DEMO_RANKED.get(player, (1000 if i < 8 else 1240 - (i * 37) % 360,))[0], ai=True)
        tournament.start(ai_avatar=BOT_AVATAR)
        return tournament

    async def keep_demo_tournament():
        """A debug server always has its demo tournaments running; a finished one stays up
        a minute with its winner, then a fresh one is drawn."""
        for name, players, best_of, format, fill in DEMO_TOURNAMENTS:
            tournament = next((t for t in store.tournaments.values() if getattr(t, 'demo', False) and t.name == name), None)
            # (a match's table goes a minute after the match is decided: nothing needs it then)
            for match in (tournament.matches.values() if tournament else ()):
                room = store.rooms.get(match.room_id) if match.room_id else None
                if room is not None and room.demo and match.status == 'done' and time.time() - (match.ended_at or 0) > 60:
                    if room.bot_task:
                        room.bot_task.cancel()
                    store.rooms.pop(room.id, None)
            if tournament is not None and tournament.status == 'finished':
                done = max((match.ended_at or 0 for match in tournament.matches.values()), default=0)
                if time.time() - done < 60:
                    tournament.touched = time.time()
                    continue
                store.tournaments.pop(tournament.id, None)
                for match in tournament.matches.values():
                    room = store.rooms.pop(match.room_id, None) if match.room_id else None
                    if room is not None and room.bot_task:
                        room.bot_task.cancel()
                tournament = None
            if tournament is None:
                tournament = make_demo_tournament(name, players, best_of, format, fill)
                store.tournaments[tournament.id] = tournament
                await advance_tournament(tournament)
            tournament.touched = time.time()

    async def keep_demo_tables():
        """A debug server always has three demo games on Watch: five players, one on one,
        and a solo game. Bots play them; when one's series ends, a fresh one takes its place."""
        names = [table[0] for table in DEMO_TABLES]
        while True:
            try:
                for table in DEMO_TABLES:
                    room = next((room for room in store.rooms.values() if room.demo and room.name == table[0]), None)
                    if room is not None and room.status == "round_over":
                        async with room.lock:
                            if room.status == "round_over" and time.time() - (room.history[-1].get("ended_at") or 0) > 6:
                                room.start_round()
                                room.version += 1
                                await broadcast(room)
                    elif room is not None and room.status == "finished" and time.time() - (finished_at(room) or 0) < WATCH_FINISHED_FOR + 5:
                        pass  # (it stays on Watch a minute with its winner first)
                    elif room is None or room.status not in ("playing", "round_over"):
                        if room is not None:
                            store.rooms.pop(room.id, None)
                        room = make_demo_table(*table)
                        store.rooms[room.id] = room
                    room.touched = time.time()
                    kick_bot(room)
                await keep_demo_tournament()
            except Exception:
                log.exception("Could not keep the demo tables (%s)", ", ".join(names))
            await asyncio.sleep(3)

    async def debug_bot_loop(room):
        """Debug tables: every seat but yours is a quick bot playing legal moves (no search)."""
        rng = random.Random()
        try:
            while True:
                # (a demo table plays at a watchable pace)
                await asyncio.sleep(2.2 if room.demo else 0.6)
                async with room.lock:
                    if room.id not in store.rooms:
                        return
                    game = room.game
                    waiting = [seat for seat in room.bot_seats if game and game.visible_count(seat) < 2]
                    if room.status == "playing" and game and game.phase == "setup" and waiting:
                        # each bot turns up its two opening cards at once
                        for seat in waiting:
                            hidden = [i for i, slot in enumerate(game.players[seat]) if not slot.visible]
                            for index in rng.sample(hidden, 2 - game.visible_count(seat)):
                                game.opening_reveal(seat, index)
                        room.track_scores()
                        room.version += 1
                        await broadcast(room)
                    elif room.status == "playing" and game and game.phase not in ("setup", "over") and game.decision_player in room.bot_seats:
                        allowed = legal_actions(game)
                        moves = [action for action in allowed if action[0] != "bonus"] or allowed
                        action = fallback_action(allowed) if rng.random() < 0.55 else rng.choice(moves)
                        if action is None:
                            continue
                        play_action(game, action)
                        room.track_scores()
                        room.record_result()
                        room.version += 1
                        await broadcast(room)
                    elif not room.demo and not any(room.clients.values()) and time.time() - room.touched > 600:
                        return  # nobody watching: stop until someone plays again
        except Exception:
            log.exception("Debug bots stopped at table %s", room.id)
        finally:
            if room.bot_task is asyncio.current_task():
                room.bot_task = None

    @app.post("/api/pass-play")
    async def pass_play(body: PassPlay, request: Request):
        """Pass & play: a table of 2-8 players taking turns on this one device, each with
        their own name and avatar. Its games are not saved and count toward no stats, streak or Elo."""
        session = session_for(request)
        leave_old(session)
        cancel_queue(session.token)
        store.cleanup()
        if store.table_count() >= 200:
            raise HTTPException(503, "The server has too many tables.")
        names = [clean_name(name)[:32] for name in body.names]
        try:
            chosen = [clean_avatar(avatar) for avatar in body.avatars]
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        seats = [session.token] + [f"local:{secrets.token_hex(6)}" for _ in names[1:]]
        many = len(names) > 2
        # a bigger table always shuffles its turn order; House rules pick a random first player
        first = "random" if body.house_rules or many else body.first
        room = Room(secrets.token_urlsafe(9), "Pass & play", parse_rules(house_rules() if body.house_rules else body.rules),
                    None, first, False, seats, names, history_store=None, house_rules=body.house_rules,
                    house_version=HOUSE_VERSION if body.house_rules else None, game_type='many' if many else '1v1')
        room.local = True
        room.resize_seats()
        # anyone who didn't pick an avatar gets one nobody else has
        spare = [avatar.id for avatar in AVATARS if avatar.selectable and avatar.id not in chosen]
        room.avatars = [chosen[p] if p < len(chosen) else spare.pop(0) for p in range(len(names))]
        room.participants = [{'id': f'local:{p}', 'kind': 'guest', 'display_name': name} for p, name in enumerate(names)]
        store.rooms[room.id] = room
        session.room_id = room.id
        room.start_round()
        room.version += 1
        return snapshot(room, session.token)

    @app.post("/api/debug/bot-table")
    async def debug_bot_table(request: Request):
        """A ready-made 8-player table of bots and you (debug servers only)."""
        if not debug_mode():
            raise HTTPException(404, "Not found.")
        session = session_for(request)
        leave_old(session)
        cancel_queue(session.token)
        bots = ["Ace", "Birdie", "Bogey", "Caddie", "Eagle", "Fairway", "Mulligan"]
        icons = ["tree", "bird", "cat", "fish", "hare", "tortoise", "ladybug", "cup", "fork"]
        mine = session.avatar
        room = Room(secrets.token_urlsafe(9), "Debug: 8 bots", parse_rules(house_rules()), None, "random", False,
                    [session.token] + [f"debug-bot:{secrets.token_hex(6)}" for _ in bots],
                    [session.username] + bots, history_store=None, game_type="many")
        room.resize_seats()
        room.avatars = [mine] + [icon for icon in icons if icon != mine][:len(bots)]
        room.participants = [profile_for(session)] + [{'id': f'bot:debug-{name.lower()}', 'kind': 'bot', 'display_name': name} for name in bots]
        room.bot_seats = list(range(1, len(bots) + 1))
        store.rooms[room.id] = room
        session.room_id = room.id
        room.start_round()
        room.version += 1
        kick_bot(room)
        return snapshot(room, session.token)

    @app.post("/api/debug/practice/{room_id}")
    async def debug_practice(room_id: str, edit: DebugEdit, request: Request):
        """Change a Practice, Pass & Play or 8-bot debug game by hand (debug servers only):
        end it, or flip or replace any card."""
        if not debug_mode():
            raise HTTPException(404, "Not found.")
        session = session_for(request)
        room = find_room(room_id)
        if not (room.practice or room.local or room.bot_seats) or session.token not in room.seats:
            raise HTTPException(403, "Only your own Practice, Pass & Play or debug bot games can be changed.")
        async with room.lock:
            game = room.game
            if game is None or game.phase == "over":
                raise HTTPException(409, "There is no game in play.")
            room.debug_edited = True
            if edit.op == "end":
                # every card turns over and the game is scored, as at a final reveal
                if game.held_card:
                    game.discard_pile.append(game.held_card)
                game.held_card = game.flipped = game.guess_pending = game.arrange_pending = None
                game.bonus_remaining = 0
                game.scoring_reveal = True
                game._resolve_scoring_reveal()
                if game.phase == "bonus":
                    # straight to the result: skip the swaps the final reveal would hand out
                    game.final_bonus_queue, game.bonus_remaining = [], 0
                    game.phase = "over"
                    scores = [game.score(p) for p in range(game.player_count)]
                    winners = [p for p, score in enumerate(scores) if score == min(scores)]
                    game.message = f"Player {winners[0] + 1} wins." if len(winners) == 1 else "It's a draw!"
            else:
                if edit.ref is None:
                    raise HTTPException(422, "Choose a card.")
                player, index = edit.ref
                if not (0 <= player < game.player_count and 0 <= index < 6):
                    raise HTTPException(422, "That card is not on the table.")
                slot = game.players[player][index]
                if edit.op == "flip":
                    game.players[player][index] = Slot(slot.card, not slot.visible)
                else:
                    if edit.rank is None or edit.suit is None:
                        raise HTTPException(422, "Choose a rank and a suit.")
                    game.players[player][index] = Slot(Card(edit.rank, edit.suit, slot.card.deck), slot.visible)
                game._update_combos()
            room.track_scores()
            room.record_result()
            room.version += 1
            room.save_practice()
            await broadcast(room)
            kick_bot(room)
            return snapshot(room, session.token)

    class PushSubscription(BaseModel):
        subscription: dict | None = None
        turn: bool = True  # "your turn" notifications
        queue: bool = False  # "someone joined the Ranked queue" notifications

    @app.get('/api/push/key')
    async def push_key(request: Request):
        session_for(request)
        keys = await asyncio.to_thread(push_keys)
        if not keys:
            raise HTTPException(404, 'Notifications are not available on this server.')
        return {'key': keys['public']}

    @app.post('/api/push/subscribe')
    async def push_subscribe(body: PushSubscription, request: Request):
        session = session_for(request)
        subscription = body.subscription or {}
        endpoint = subscription.get('endpoint')
        if not isinstance(endpoint, str) or not endpoint.startswith('https://') or not isinstance(subscription.get('keys'), dict):
            raise HTTPException(422, 'That is not a push subscription.')
        store.push_subscriptions[session.token] = {'endpoint': endpoint, 'keys': subscription['keys'],
                                                   'turn': body.turn, 'queue': body.queue}
        save_push_subscriptions()
        # push services ask who is sending: the site this game is served from, as
        # a bare https://host (the signing library refuses a path or plain http)
        host = request.url.hostname or ''
        store.push_contact = f'https://{host if "." in host or ":" in host else "localhost"}'
        return {'ok': True}

    @app.post('/api/push/unsubscribe')
    async def push_unsubscribe(request: Request):
        session = session_for(request)
        store.push_subscriptions.pop(session.token, None)
        save_push_subscriptions()
        return {'ok': True}

    @app.get('/sw.js')
    async def service_worker():
        # served from the app's own root so it can cover every page
        return Response((ROOT / 'web' / 'sw.js').read_text(encoding='utf-8'), media_type='application/javascript',
                        headers={'Cache-Control': 'no-cache'})

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/api/session")
    async def get_session(request: Request, response: Response):
        return open_session(request, response)

    def open_session(request, response):
        """This browser's session (made on first visit), with its cookie set on `response`."""
        store.cleanup()
        token = request.cookies.get(COOKIE)
        if token not in store.sessions:
            # Keep the anonymous history identity after a restart; never accept arbitrary keys.
            if not token or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
                token = secrets.token_urlsafe(32)
            store.sessions[token] = Session(token)
        session = store.session(token)
        session.account = store.accounts.from_token(request.cookies.get(ACCOUNT_COOKIE))
        if session.account and session.account.get('display_name'):
            session.username = session.account['display_name']
        if session.nonce_expires <= time.time():
            session.google_nonce, session.nonce_expires = secrets.token_urlsafe(32), time.time() + 600
        response.set_cookie(COOKIE, token, path=request.scope.get("root_path", "") + "/",
                            httponly=True, samesite="lax", secure=request.url.scheme == "https", max_age=365 * 86400)
        request.state.golf_session = session
        return session_view(session)

    @app.post('/api/auth/google')
    async def google_signin(body: GoogleCredential, request: Request, response: Response):
        session = session_for(request)
        csrf(session, body.csrf_token)
        practice_room = signin_room(session)
        if not google_client_id:
            raise HTTPException(503, 'Google sign-in is not available yet. You can play as a guest.')
        session.auth_attempts = [when for when in session.auth_attempts if when > time.time() - 60]
        if len(session.auth_attempts) >= 8:
            raise HTTPException(429, 'Please wait a minute before trying again.')
        session.auth_attempts.append(time.time())
        if session.nonce_expires <= time.time():
            raise HTTPException(401, 'Refresh the page to sign in again.')
        nonce = session.google_nonce
        try:
            subject = await asyncio.to_thread(verify_google_token, body.credential, google_client_id, nonce)
        except Exception as error:
            raise HTTPException(401, 'Google sign-in could not be verified. Please try again.') from error
        if session.nonce_expires <= time.time() or session.google_nonce != nonce:
            raise HTTPException(401, 'Refresh the page to sign in again.')
        def complete_signin(room=None):
            if signin_room(session) is not practice_room:
                raise HTTPException(409, 'Your table changed. Please try signing in again.')
            session.nonce_expires = 0
            store.accounts.logout(request.cookies.get(ACCOUNT_COOKIE))
            session.account, login_token = store.accounts.login(subject)
            if session.account.get('display_name'):
                session.username = session.account['display_name']
            else:
                set_name(session, session.username)
            if room is not None:
                identity = account_practice_profile(session)
                store.progression.retain_guest_practice(room.progression_players[0], identity, room.patch)
                room.participants[0] = identity.copy()
                room.progression_players[0] = identity
                room.practice_account = session.account['id']
                room.version += 1
                room.save_practice()
            return login_token

        if practice_room is not None:
            async with practice_room.lock:
                login_token = complete_signin(practice_room)
                await broadcast(practice_room)
        else:
            login_token = complete_signin()
        response.set_cookie(ACCOUNT_COOKIE, login_token, path=request.scope.get('root_path', '') + '/',
                            httponly=True, secure=request.url.scheme == 'https', samesite='lax', max_age=LOGIN_DAYS * 86400)
        return session_view(session)

    @app.post('/api/account/name')
    async def choose_unique_name(body: AccountName, request: Request):
        session = session_for(request)
        csrf(session, body.csrf_token)
        if session.account is None:
            raise HTTPException(401, 'Sign in with Google first.')
        try:
            session.account = store.accounts.choose_name(session.account['id'], body.unique_name)
            store.progression.merge_stay()
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        room = store.rooms.get(session.room_id)
        if room and room.practice and room.practice_account == session.account['id']:
            async with room.lock:
                if room.seats[0] == session.token and not room.departed[0]:
                    identity = account_practice_profile(session)
                    room.participants[0] = identity.copy()
                    room.progression_players[0] = identity
                    store.progression.profile(identity, room.patch)
                    room.version += 1
                    room.save_practice()
                    await broadcast(room)
        return session_view(session)

    @app.get('/api/account/display-names')
    async def previous_display_names(request: Request):
        """The display names this account has gone by, most recently used first, without the current one."""
        session = session_for(request)
        if session.account is None:
            raise HTTPException(401, 'Sign in with Google first.')
        account_id = session.account['id']
        used = store.accounts.display_names(account_id)
        # names played under before they were recorded come from the saved games
        for match in await asyncio.to_thread(store.history.stats_results):
            when = match.get('last_game_ended_at') or match.get('updated_at') or 0
            for seat, profile in enumerate(match.get('participants') or []):
                if isinstance(profile, dict) and profile.get('id') == 'account:' + account_id:
                    names = match.get('names') or []
                    name = profile.get('display_name') or (names[seat] if seat < len(names) else None)
                    if name:
                        used[name] = max(used.get(name, 0), when)
        used.pop(session.username, None)
        return {'names': sorted(used, key=lambda name: (-used[name], name.casefold()))}

    @app.post('/api/auth/logout')
    async def logout(body: Logout, request: Request, response: Response):
        session = session_for(request)
        csrf(session, body.csrf_token)
        leave_old(session, 'changing sign-in')
        store.accounts.logout(request.cookies.get(ACCOUNT_COOKIE))
        session.account = None
        session.google_nonce, session.nonce_expires = secrets.token_urlsafe(32), time.time() + 600
        response.delete_cookie(ACCOUNT_COOKIE, path=request.scope.get('root_path', '') + '/')
        return session_view(session)

    def rules_data():
        descriptions = load_rule_help()
        return [{"key": key, "name": name, "title": descriptions[key][0], "description": descriptions[key][1]} for key, name in RULE_OPTIONS]

    def avatars_data():
        return {'default': DEFAULT_AVATAR, 'avatars': avatar_catalog()}

    def match_options_data():
        return {'house_rules': house_rules(), 'house_version': HOUSE_VERSION, 'first': 'random', 'patch': PATCH_VERSION}

    @app.get("/api/rules")
    async def rules_catalog():
        return rules_data()

    @app.get('/api/avatars')
    async def avatars():
        return avatars_data()

    @app.get('/api/match-options')
    async def match_options():
        return match_options_data()

    @app.get('/api/patch-notes')
    async def patch_notes():
        return {'current': PATCH_VERSION, 'patches': PATCH_NOTES}

    @app.get("/api/history")
    async def match_history(request: Request, offset: int = Query(default=0, ge=0),
                            kind: Literal["pvp", "solo", "tournament"] | None = Query(default=None),
                            mine: bool = False, limit: int = Query(default=50, ge=1, le=50)):
        """Saved matches, newest first. `kind` keeps one sort: games against Golfbot,
        tournament matches, or everything else (tables between players); `mine`, only your own."""
        matches = store.history.for_browser(session_for(request).token, limit=limit + 1, offset=offset, kind=kind, mine=mine)
        if mine:
            # your recent matches (the Play tab) show everyone's MMR beside their name
            for match in matches[:limit]:
                match["mmr"] = [None if not profile or str(profile.get("id", "")).startswith("bot:") else
                                store.progression.mmr(profile) for profile in (match.get("participants") or [])]
        return {"matches": matches[:limit], "next_offset": offset + limit if len(matches) > limit else None}

    @app.get("/api/stats")
    async def player_stats(request: Request,
                           player: str | None = Query(default=None, max_length=64),
                           opponent: str | None = Query(default=None, max_length=64),
                           enabled: list[str] = Query(default=[]), disabled: list[str] = Query(default=[]),
                           house_rules: bool = Query(default=True),
                           patch: str | None = Query(default=None, max_length=32)):
        session = session_for(request)
        known = set(Rules.__dataclass_fields__)
        if (set(enabled) | set(disabled)) - known or set(enabled) & set(disabled):
            raise HTTPException(422, "Choose valid, non-conflicting rule filters.")
        if house_rules and (enabled or disabled):
            raise HTTPException(422, 'Turn off House rules to choose custom rule filters.')
        try:
            viewer_profile = profile_for(session)
            profiles = [viewer_profile, {'id': 'bot:golfbot', 'kind': 'bot', 'display_name': 'Golfbot'}]
            selected = player if player is not None else viewer_profile['id']
            compared = (opponent or None) if opponent is not None else 'bot:golfbot'
            # every guest is one "Guest" here, as on the leaderboards
            results = await asyncio.to_thread(store.history.stats_results)
            # (guests are kept apart when a player is asked for by id: one guest's numbers are
            # their own, not every guest's added together)
            merge = player is None and opponent is None
            # (a demo player's numbers are filled in below; one with no saved games yet has none)
            demo = lambda who: bool(who) and str(who).startswith('demo:')
            build_selected = viewer_profile['id'] if demo(selected) else selected
            build_compared = None if demo(compared) else compared
            try:
                stats = await asyncio.to_thread(lambda: build_stats(results, build_selected, build_compared, enabled, disabled, house_rules, patch,
                                                                    profiles=profiles, merge_guests=merge))
            except ValueError:
                if not build_compared:
                    raise
                stats = await asyncio.to_thread(lambda: build_stats(results, build_selected, None, enabled, disabled, house_rules, patch,
                                                                    profiles=profiles, merge_guests=merge))
            # a debug server's demo players have no saved games: their numbers are their demo record
            for key, wanted in (('player', selected), ('comparison', compared)):
                if wanted and str(wanted).startswith('demo:'):
                    stats[key] = demo_stats_entry(wanted)
            # a signed-in player's two ratings: MMR (by series) and their game rating
            for entry in (stats['player'], stats['comparison']):
                if entry and entry['profile']['id'].startswith('account:'):
                    entry['ratings'] = store.progression.ratings(entry['profile']['id'])
            if stats['player']:
                # the records this player holds (all time: the filters above do not apply to them)
                ratings = store.progression.leaderboard(PATCH_VERSION, combine_guests=False)['pvp']
                records = await asyncio.to_thread(build_records, results, ratings, record_extras())
                stats['player']['records'] = held_records(records, stats['player']['profile']['id'])
            return stats
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

    @app.get('/api/leaderboards')
    async def leaderboards(request: Request):
        session = session_for(request)
        # the boards show every guest as one "Guest"; records still name the player
        boards = store.progression.leaderboard(PATCH_VERSION)
        if debug_mode():
            # (a debug server's demo players, ranked among the real ones)
            boards['pvp'] = sorted(boards['pvp'] + demo_leaderboard_rows(), key=lambda row: (-row['mmr'], row['id']))
        ratings = store.progression.leaderboard(PATCH_VERSION, combine_guests=False)['pvp']
        results = await asyncio.to_thread(store.history.stats_results)
        boards['records'] = await asyncio.to_thread(build_records, results, ratings, record_extras())
        # (each holder's avatar, as they last played with it, for their card)
        avatars = {}
        for match in results:
            for seat, profile in enumerate(match.get('participants') or []):
                if isinstance(profile, dict) and profile.get('id') and seat < len(match.get('avatars') or []):
                    avatars[profile['id']] = match['avatars'][seat] or avatars.get(profile['id'])
        for record in boards['records'].values():
            if isinstance(record, dict) and record.get('id') in avatars:
                record['avatar'] = avatars[record['id']]
        # and each ranked player's, beside their name on the boards
        for row in boards['pvp'] + boards['solo']:
            row.setdefault('avatar', avatars.get(row.get('id')) or (DEMO_AVATARS.get(row.get('label')) if str(row.get('id')).startswith('demo:') else None))
        # the viewer's own best at each, shown under its card
        me = 'account:' + session.account['id'] if session.account else 'browser:' + browser_id(session)
        boards['personal'] = await asyncio.to_thread(personal_records, results, ratings, me)
        return boards

    def record_extras():
        """What the records need that saved games cannot say."""
        return {'invites': store.accounts.invite_counts(), 'newest': store.accounts.newest()}

    @app.get('/api/player-card')
    async def player_card_view(request: Request, player: str = Query(max_length=64)):
        """A player's MMR, best 1v1 streak and held records, for their name-tag popup."""
        session_for(request)
        ratings = store.progression.leaderboard(PATCH_VERSION, combine_guests=False)['pvp']
        results = await asyncio.to_thread(store.history.stats_results)
        return await asyncio.to_thread(player_card, results, ratings, player, record_extras())

    @app.get('/api/profile')
    async def player_profile(request: Request, player: str = Query(max_length=64)):
        """Another player's profile: their card (MMR, streaks, time played), who they are and
        when they were last on, their own bests beside the viewer's, and whether the two are
        friends."""
        session = session_for(request)
        ratings = store.progression.leaderboard(PATCH_VERSION, combine_guests=False)['pvp']
        results = await asyncio.to_thread(store.history.stats_results)
        profile = await asyncio.to_thread(player_card, results, ratings, player, record_extras())
        try:
            viewer = profile_for(session)['id']
        except HTTPException:
            viewer = None
        profile['self'] = viewer == player
        profile['flags'] = sorted(await asyncio.to_thread(flags_for, player))
        profile['personal'] = await asyncio.to_thread(personal_records, results, ratings, player)
        profile['mine'] = (await asyncio.to_thread(personal_records, results, ratings, viewer)
                           if viewer and viewer != player else None)
        # games in a row won against Golfbot, as their own table counts them
        with store.progression.lock:
            row = store.progression.db.execute(
                'SELECT current_streak, best_streak FROM progression_players WHERE patch=? AND id=?',
                (PATCH_VERSION, player)).fetchone()
        profile['solo_streak'], profile['best_solo_streak'] = (row[0], row[1]) if row else (0, 0)
        profile.update(label=None, unique_name=None, avatar=None, status=None, last_seen=None, friend=None)
        if player == 'bot:golfbot':
            profile['label'], profile['avatar'] = 'Golfbot', BOT_AVATAR
        if player == 'bot:puzzlebot':
            # (its record is the Daily Puzzle's: every attempt made against it)
            profile['label'], profile['avatar'] = 'PuzzleBot', PUZZLE_BOT_AVATAR
            profile['puzzle'] = await asyncio.to_thread(store.puzzles.totals, daily_puzzle.today())
        if player.startswith('browser:'):
            # (a guest: named, with their avatar, as they last played)
            for match in results:
                for seat, seen in enumerate(match.get('participants') or []):
                    if isinstance(seen, dict) and seen.get('id') == player:
                        names, looks = match.get('names') or [], match.get('avatars') or []
                        profile['label'] = seen.get('display_name') or (names[seat] if seat < len(names) else None) or profile['label']
                        profile['avatar'] = (looks[seat] if seat < len(looks) else None) or profile['avatar']
            if not profile['label']:
                # (one who has only played the puzzle: as they last played it)
                seen = await asyncio.to_thread(store.puzzles.last_seen, player)
                if seen:
                    profile['label'], profile['avatar'] = seen
        if player.startswith('demo:'):
            # (a debug server's demo player: named, with their avatar and demo MMR)
            name = player.split(':', 1)[1].title()
            profile['label'], profile['avatar'] = name, DEMO_AVATARS.get(name)
            profile['mmr'] = DEMO_RANKED.get(name, (None,))[0]
        if player.startswith('account:'):
            account_id = player.split(':', 1)[1]
            account = store.accounts.by_ids([account_id]).get(account_id)
            if account:
                state = friend_status(account_id, store.friends.last_seen([account_id]))
                profile.update(label=account.get('display_name'), unique_name=account.get('unique_name'),
                               avatar=state.get('avatar'), status=state['status'], last_seen=state.get('last_seen'))
                if not session.account:
                    profile['friend'] = 'signin'
                elif session.account['id'] == account_id:
                    profile['friend'] = 'self'
                else:
                    mine = next((item for item in store.friends.list(session.account['id']) if item['id'] == account_id), None)
                    profile['friend'] = mine['status'] if mine else 'none'
        return profile

    @app.get("/api/lobbies")
    async def lobbies():
        store.cleanup()
        return [public_room(room) for room in store.rooms.values()
                if not room.solo and not room.local and not room.tournament and room.status != "closed"]

    def at_table(session):
        room = store.rooms.get(session.room_id)
        return bool(room and session.token in room.seats and not room.departed[room.seats.index(session.token)])

    def queue_allowed(session):
        room = store.rooms.get(session.room_id)
        return not at_table(session) or bool(room and room.solo)

    DECLINE_COOLDOWN = 10  # seconds before a declined pair may meet again

    def remember_decline(seats):
        """A declined pair is not offered to each other again until the cooldown has
        passed and one of them has newly joined the queue (not just kept waiting)."""
        store.queue_declined[frozenset(seats)] = (time.time() + DECLINE_COOLDOWN, {token: store.queue.get(token) for token in seats})

    def declined_pair(first, second, now):
        entry = store.queue_declined.get(frozenset((first, second)))
        if entry is None:
            return False
        until, joined = entry
        return now < until or all(store.queue.get(token) == joined[token] for token in (first, second))

    def cancel_queue(token, notice=None):
        """Take a player out of the queue. Their opponent in an open offer keeps
        waiting for someone else (the pair is not offered to each other again)."""
        store.queue.pop(token, None)
        for key, offer in list(store.queue_offers.items()):
            if token in offer['seats']:
                del store.queue_offers[key]
                remember_decline(offer['seats'])
                for other in offer['seats']:
                    if other != token and other in store.queue:
                        store.queue_notices[other] = notice or 'Your match was called off. Still looking for another player.'

    def prune_queue():
        now = time.time()
        for token in list(store.queue):
            player = store.sessions.get(token)
            if token not in store.queue_switching and (not player or player.online_until <= now or not queue_allowed(player)):
                cancel_queue(token)
        for offer in list(store.queue_offers.values()):
            if offer['expires'] <= now and not any(token in store.queue_switching for token in offer['seats']):
                # nobody answered in time: both leave the queue
                for token in offer['seats']:
                    store.queue_notices[token] = 'The queue offer expired. Join again when you are ready.'
                    store.queue.pop(token, None)
                cancel_queue(offer['seats'][0])
        for pair, (until, joined) in list(store.queue_declined.items()):
            # forgotten once the cooldown is over and either player has joined anew
            if until <= now and any(store.queue.get(token) != joined[token] for token in pair):
                del store.queue_declined[pair]
        offered = {token for offer in store.queue_offers.values() for token in offer['seats']}
        waiting = [token for token in store.queue if token not in offered]
        while len(waiting) >= 2:
            first = waiting.pop(0)
            one = store.sessions[first]
            second = next((token for token in waiting if not (
                one.account and store.sessions[token].account and one.account['id'] == store.sessions[token].account['id'])
                and not declined_pair(first, token, now)), None)
            if second is None:
                continue
            waiting.remove(second)
            store.queue_offers[secrets.token_urlsafe(12)] = {
                'seats': [first, second], 'accepted': set(), 'expires': now + 60,
            }

    def queue_view(session):
        if session.token in store.queue_results:
            return {'status': 'matched', 'room_id': store.queue_results[session.token]}
        for key, offer in store.queue_offers.items():
            if session.token in offer['seats']:
                other = next(token for token in offer['seats'] if token != session.token)
                return {'status': 'offer', 'id': key, 'opponent': store.sessions[other].username,
                        'accepted': session.token in offer['accepted'], 'expires_at': offer['expires'],
                        'lobby': {'name': 'Classic golf match', 'best_of': 5, 'series_mode': 'points',
                                  'first': 'random', 'house_rules': True, 'rules': house_rules()}}
        return {'status': 'waiting' if session.token in store.queue else 'off',
                'notice': store.queue_notices.pop(session.token, None)}

    def boot_queue(session):
        """Where this session stands in the queue, for the first page (leaves any notice for the poll)."""
        prune_queue()
        if session.token in store.queue_results or any(session.token in offer['seats']
                                                       for offer in store.queue_offers.values()):
            return queue_view(session)
        return {'status': 'waiting' if session.token in store.queue else 'off'}

    @app.post('/api/queue/join')
    async def join_queue(body: Join, request: Request):
        session = session_for(request)
        async with store.queue_lock:
            if not queue_allowed(session):
                raise HTTPException(409, 'Leave your multiplayer table before joining the queue.')
            profile_for(session)
            set_name(session, body.username)
            choose_avatar(session, body.avatar)
            session.online_until = time.time() + 30
            if len(store.queue) >= 500 and session.token not in store.queue:
                raise HTTPException(503, 'The queue is full. Try again shortly.')
            joined = session.token not in store.queue
            store.queue.setdefault(session.token, time.time())
            store.queue_notices.pop(session.token, None)
            prune_queue()
            if joined:
                notify_queue(session)
            return queue_view(session)

    @app.post('/api/queue/leave')
    async def leave_queue(request: Request):
        session = session_for(request)
        async with store.queue_lock:
            cancel_queue(session.token)
            return {'status': 'off'}

    @app.post('/api/queue/offers/{offer_id}/respond')
    async def respond_queue(offer_id: str, body: InviteReply, request: Request):
        session = session_for(request)
        async with store.queue_lock:
            prune_queue()
            offer = store.queue_offers.get(offer_id)
            if not offer or session.token not in offer['seats']:
                raise HTTPException(404, 'That queue offer is no longer available.')
            if not body.accept:
                # declining keeps both players in the queue, each looking for someone else
                del store.queue_offers[offer_id]
                remember_decline(offer['seats'])
                for other in offer['seats']:
                    if other != session.token:
                        store.queue_notices[other] = 'Your opponent declined. Still looking for another player.'
                prune_queue()
                return queue_view(session)
            choose_avatar(session, body.avatar)
            offer['accepted'].add(session.token)
            if len(offer['accepted']) == 2:
                if store.table_count() >= 200:
                    raise HTTPException(503, 'The server has too many tables. Try again shortly.')
                players = [store.sessions[token] for token in offer['seats']]
                profiles = [profile_for(player) for player in players]
                store.queue_switching.update(offer['seats'])
                try:
                    for player in players:
                        old = store.rooms.get(player.room_id)
                        if old and at_table(player):
                            # Only completed games are saved. The interrupted
                            # deal never enters history or activation stats.
                            await leave_table(old, player)
                    room = Room(secrets.token_urlsafe(9), 'Classic golf match', parse_rules(house_rules()),
                                5, 'random', False, list(offer['seats']), [player.username for player in players],
                                history_store=store.history, participants=profiles, house_rules=True,
                                house_version=HOUSE_VERSION, series_mode='points',
                                avatars=[player.avatar for player in players], rated=True,
                                progression=store.progression,
                                progression_players=[progression_profile(player) for player in players])
                    store.rooms[room.id] = room
                    room.start_round()
                    for player in players:
                        player.room_id = room.id
                        store.queue_results[player.token] = room.id
                        store.queue.pop(player.token, None)
                    del store.queue_offers[offer_id]
                finally:
                    store.queue_switching.difference_update(offer['seats'])
            return queue_view(session)

    @app.post('/api/queue/enter')
    async def enter_queue_match(request: Request):
        session = session_for(request)
        room_id = store.queue_results.get(session.token)
        if not room_id or session.room_id != room_id:
            store.queue_results.pop(session.token, None)
            raise HTTPException(404, 'There is no new queue match.')
        result = snapshot(find_room(room_id), session.token)
        # Keep this acknowledgement idempotent: a dropped response or another
        # browser tab must still be able to discover the accepted match.
        return result

    def prune_invites():
        for key, invitation in list(store.invitations.items()):
            target = store.sessions.get(invitation['target'])
            if invitation.get('tournament'):
                # to a tournament still gathering players
                cup = store.tournaments.get(invitation['tournament'])
                closed = (cup is None or cup.status != 'open' or len(cup.entrants) >= MAX_ENTRANTS
                          or bool(target and in_tournament(target)))
            else:
                room = store.rooms.get(invitation['room'])
                closed = not room or room.status != 'waiting' or not room.has_open_seat
            if invitation['expires'] <= time.time() or closed or not target or with_others(target):
                del store.invitations[key]

    def playing_golfbot(session):
        """At a table of their own against Golfbot (not a tournament match): free to be invited away."""
        room = store.rooms.get(session.room_id)
        return bool(at_table(session) and room.solo and not room.tournament)

    def with_others(session):
        """Sitting at a table with other people, so not someone to invite elsewhere."""
        return at_table(session) and not playing_golfbot(session)

    def available_players(session):
        players = {}
        for other in store.sessions.values():
            if (other.token == session.token or other.online_until <= time.time() or with_others(other)
                    or in_tournament(other)
                    or session.account and other.account and session.account['id'] == other.account['id']):
                continue
            identity = ('account', other.account['id']) if other.account else ('guest', other.public_id)
            players[identity] = other
        return list(players.values())

    def friend_status(account_id, seen):
        """What a friend is up to: in a game (and where to watch it), solving the puzzle, online, or last seen."""
        now = time.time()
        live = [other for other in store.sessions.values()
                if other.account and other.account['id'] == account_id and other.online_until > now]
        for other in live:
            room = store.rooms.get(other.room_id)
            if room and other.token in room.seats and room.status in ("playing", "round_over") and room.game:
                if room.puzzle:
                    return {"status": "puzzle", "avatar": other.avatar}
                return {"status": "in_game", "avatar": other.avatar,
                        "room_id": room.id if in_play(room) else None, "solo": room.solo}
        if live:
            # (online and free: they can be invited to a table)
            return {"status": "online", "avatar": live[0].avatar, "invite_id": live[0].public_id}
        at, avatar = seen.get(account_id, (None, None))
        return {"status": "offline", "avatar": avatar, "last_seen": at}

    def signed_in(session):
        if not session.account or not session.account.get('unique_name'):
            raise HTTPException(403, "Sign in and choose your unique name to add friends.")
        return session.account['id']

    @app.get('/api/friends')
    async def friends_list(request: Request):
        """Your friends (with what each is up to, busiest first) and the requests either way."""
        session = session_for(request)
        if not session.account or not session.account.get('unique_name'):
            return {"signed_in": False, "friends": [], "incoming": [], "outgoing": []}
        rows = store.friends.list(session.account['id'])
        accounts = store.accounts.by_ids(row['id'] for row in rows)
        seen = store.friends.last_seen(row['id'] for row in rows)
        result = {"signed_in": True, "friends": [], "incoming": [], "outgoing": []}
        for row in rows:
            account = accounts.get(row['id'])
            if account is None or not account.get('unique_name'):
                continue
            entry = {"unique_name": account['unique_name'],
                     "display_name": account.get('display_name') or account['unique_name'],
                     "since": row['since'],
                     # (their player id, as boards and tables name players: so each can mark them)
                     "id": 'account:' + row['id']}
            if row['status'] == 'friend':
                entry.update(friend_status(row['id'], seen))
                try:
                    entry["mmr"] = store.progression.mmr({'id': 'account:' + row['id']})
                except Exception:
                    entry["mmr"] = None
                result["friends"].append(entry)
            else:
                entry["avatar"] = seen.get(row['id'], (None, None))[1]
                result[row['status']].append(entry)
        order = {"in_game": 0, "puzzle": 1, "online": 2, "offline": 3}
        result["friends"].sort(key=lambda f: (order[f["status"]], -(f.get("last_seen") or 0), f["display_name"].lower()))
        return result

    @app.post('/api/friends')
    async def friend_request(body: FriendRequest, request: Request):
        session = session_for(request)
        me = signed_in(session)
        other = store.accounts.by_unique_name(body.unique_name)
        if other is None or not other.get('unique_name'):
            raise HTTPException(404, f"Nobody goes by @{body.unique_name.strip().lstrip('@').lower()}.")
        try:
            outcome = store.friends.request(me, other['id'])
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        return {"outcome": outcome, "unique_name": other['unique_name']}

    @app.post('/api/friends/{unique_name}/accept')
    async def friend_accept(unique_name: str, request: Request):
        session = session_for(request)
        me = signed_in(session)
        other = store.accounts.by_unique_name(unique_name)
        if other is None or not store.friends.accept(me, other['id']):
            raise HTTPException(404, "That friend request is no longer there.")
        return {"outcome": "accepted"}

    @app.delete('/api/friends/{unique_name}')
    async def friend_remove(unique_name: str, request: Request):
        """Unfriend, decline a request, or take your own back."""
        session = session_for(request)
        me = signed_in(session)
        other = store.accounts.by_unique_name(unique_name)
        if other is not None:
            store.friends.remove(me, other['id'])
        return {"removed": True}

    @app.post('/api/account/preferences')
    async def save_preferences(body: Preferences, request: Request):
        """Save a signed-in player's settings so their other devices pick them up."""
        session = session_for(request)
        if not session.account:
            raise HTTPException(401, 'Sign in to save your settings to your account.')
        try:
            store.accounts.save_preferences(session.account['id'], body.preferences)
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        return {'saved': True}

    async def rename_seat(session):
        """A new display name shows at once at the table the player is sitting at
        (a solo run is one long series, so it would otherwise never catch up)."""
        room = store.rooms.get(session.room_id)
        if room is None or session.token not in room.seats:
            return
        async with room.lock:
            seat = room.seats.index(session.token)
            if room.departed[seat] or room.names[seat] == session.username:
                return
            room.names[seat] = session.username
            for profiles in (room.participants, room.progression_players):
                if seat < len(profiles) and isinstance(profiles[seat], dict):
                    profiles[seat] = {**profiles[seat], 'display_name': session.username}
            room.version += 1
            room.save_practice()
            await broadcast(room)

    @app.post('/api/name')
    async def rename(body: Join, request: Request):
        session = session_for(request)
        set_name(session, body.username)
        await rename_seat(session)
        return session_view(session)

    @app.post('/api/presence')
    async def presence(body: Presence, request: Request):
        session = session_for(request)
        if not at_table(session) and not (session.account and session.account.get('display_name')):
            set_name(session, body.username)
            choose_avatar(session, body.avatar)
        session.online_until = time.time() + 30
        if session.account and session.seen_saved < time.time() - 60:
            # friends see when someone was last on (written once a minute at most)
            session.seen_saved = time.time()
            try:
                store.friends.seen(session.account['id'], session.avatar)
            except Exception:
                log.exception("Could not note when an account was seen")
        # a page in front polls every few seconds and says so (a background tab
        # does not, so this runs out soon after Golf is put away)
        if body.visible:
            session.looking_until = time.time() + 15
        prune_invites()
        prune_queue()
        invitations = []
        for key, item in store.invitations.items():
            if item['target'] != session.token:
                continue
            if item.get('tournament'):
                cup = store.tournaments[item['tournament']]
                host = cup.entrants.get(cup.host)
                invitations.append({'id': key, 'host': host.name if host else 'Host',
                                    'tournament': {'id': cup.id, 'name': cup.name, 'format_name': FORMAT_NAMES[cup.format],
                                                   'ranked': cup.ranked, 'best_of': cup.settings['best_of'],
                                                   'series_mode': cup.settings['series_mode'],
                                                   'house_rules': cup.settings['house_rules']}})
            else:
                room = store.rooms[item['room']]
                invitations.append({'id': key, 'lobby': public_room(room), 'host': room.names[0]})
        return {
            'available_lobbies': sum(not room.solo and room.has_open_seat
                                     and session.token not in room.seats for room in store.rooms.values()),
            # games in play someone else is playing, and tournaments being played (the Watch
            # tab's count: what it lists, a tournament's matches counted once, in its card)
            'spectatable_games': sum(in_play(room) and not room.tournament and session.token not in room.seats
                                     for room in store.rooms.values())
                                 + sum(tournament.status == 'live' for tournament in store.tournaments.values()),
            'players': [{'id': other.public_id, 'display_name': other.username, 'avatar': other.avatar,
                         'unique_name': (other.account or {}).get('unique_name'),
                         # (in a game against Golfbot: they can still be invited, and leave it to accept)
                         'solo': playing_golfbot(other)}
                        for other in available_players(session)],
            'invitations': invitations,
            'invited': [store.sessions[item['target']].public_id for item in store.invitations.values()
                        if item['host'] == session.token and item['target'] in store.sessions],
            'queue': queue_view(session),
            # the tournament this player is in, and their match when it is time to play
            'tournament': tournament_presence(session),
            'queue_size': len(store.queue),
            'username': session.username,
        }

    @app.post('/api/lobbies/{room_id}/invite')
    async def invite_player(room_id: str, body: InvitePlayer, request: Request):
        session = session_for(request)
        room = find_room(room_id)
        if room.solo or room.seats[0] != session.token or not room.has_open_seat:
            raise HTTPException(403, 'Only the host of an open lobby can invite players.')
        return send_invitation(session, body.player_id, 'room', room.id)

    def send_invitation(session, player_id, where, where_id):
        """Invite someone online to a table ('room') or to a tournament still gathering players."""
        target = next((other for other in available_players(session) if other.public_id == player_id), None)
        if not target:
            raise HTTPException(409, 'That player is no longer available.')
        prune_invites()
        for invitation in store.invitations.values():
            if invitation.get(where) == where_id and invitation['target'] == target.token:
                return {'sent': True}
        session.invite_times = [stamp for stamp in session.invite_times if stamp > time.time() - 60]
        if len(session.invite_times) >= 10:
            raise HTTPException(429, 'Please wait before sending more invitations.')
        session.invite_times.append(time.time())
        store.invitations[secrets.token_urlsafe(12)] = {
            'host': session.token, 'target': target.token, where: where_id, 'expires': time.time() + 90,
        }
        return {'sent': True}

    @app.post('/api/invitations/{invitation_id}/respond')
    async def respond_invitation(invitation_id: str, body: InviteReply, request: Request):
        session = session_for(request)
        prune_invites()
        invitation = store.invitations.get(invitation_id)
        if not invitation or invitation['target'] != session.token:
            raise HTTPException(404, 'That invitation is no longer available.')
        if not body.accept:
            del store.invitations[invitation_id]
            return {'declined': True}
        if invitation.get('tournament'):
            result = seat_in_tournament(find_tournament(invitation['tournament']), session, body.username, body.avatar)
        else:
            result = await take_seat(find_room(invitation['room']), session, body.username, body.avatar)
        prune_invites()
        return result

    def signin_room(session):
        room = store.rooms.get(session.room_id)
        if (session.token not in store.queue_switching and session.account is None
                and room and room.practice and room.solo and not room.rated
                and room.practice_account is None and room.seats[0] == session.token
                and not room.departed[0] and room.status in ('playing', 'round_over')
                and room.progression_players
                and room.progression_players[0]['id'] ==
                    'browser:' + browser_id(session)):
            return room
        leave_old(session, 'changing sign-in')
        return None

    def leave_old(session, reason='creating or joining another'):
        if session.token in store.queue_switching:
            raise HTTPException(409, 'Your Classic match is starting. Please wait a moment.')
        old = store.rooms.get(session.room_id)
        if old and session.token in old.seats and not old.departed[old.seats.index(session.token)]:
            raise HTTPException(409, f"Leave your current table before {reason}.")

    @app.post("/api/lobbies")
    async def host(settings: Settings, request: Request):
        session = session_for(request)
        leave_old(session)
        store.cleanup()
        if store.table_count() >= 200:
            raise HTTPException(503, "The server has too many tables. Try again later.")
        set_name(session, settings.username)
        choose_avatar(session, settings.avatar)
        cancel_queue(session.token)
        many = settings.game_type == 'many'
        room = Room(secrets.token_urlsafe(9), clean_name(settings.name), parse_rules(house_rules() if settings.house_rules else settings.rules), settings.best_of, 'random' if settings.house_rules or many else settings.first, False, [session.token] if many else [session.token, None], [session.username] if many else [session.username, "Waiting..."], history_store=store.history,
                    house_rules=settings.house_rules, house_version=HOUSE_VERSION if settings.house_rules else None,
                    series_mode=settings.series_mode, game_type=settings.game_type,
                    score_preview=settings.score_preview, show_odds=settings.show_odds)
        room.resize_seats()
        room.avatars[0] = session.avatar
        room.participants[0] = profile_for(session)
        store.rooms[room.id] = room
        session.room_id = room.id
        return snapshot(room, session.token)

    flag_cache = {}

    def flags_for(player):
        """The flags a player has earned (see flags.py), kept until another match is saved."""
        key = (player, store.history.saves)
        if key not in flag_cache:
            flag_cache.clear() if len(flag_cache) > 500 else None
            flag_cache[key] = achievements.earned(store.history.stats_results(), player)
        return flag_cache[key]

    @app.get("/api/flags")
    async def my_flags(request: Request):
        """The flags you have earned, and the emotes they unlock."""
        session = session_for(request)
        earned = await asyncio.to_thread(flags_for, puzzle_player(session))
        return {"earned": sorted(earned), "emotes": achievements.unlocked_emotes(earned),
                "themes": achievements.unlocked(earned, "theme")}

    async def keep_puzzles_made():
        """Today's puzzle and tomorrow's, made ahead (checked every half hour)."""
        while True:
            day = daily_puzzle.today()
            for ahead in (day, day + timedelta(days=1)):
                try:
                    await store.puzzle_maker.spec(ahead)
                except Exception:
                    log.exception("Could not make the daily puzzle for %s", ahead)
            await asyncio.sleep(1800)

    def puzzle_player(session):
        return 'account:' + session.account['id'] if session.account else 'browser:' + browser_id(session)

    @app.get("/api/puzzle")
    async def puzzle_today(request: Request, limit: int = Query(default=5, ge=1, le=daily_puzzle.BOARD_SIZE)):
        """Today's puzzle: its number, the starting hand, the best scores, and how you have done."""
        session = session_for(request)
        day = daily_puzzle.today()
        spec = await store.puzzle_maker.spec(day)
        me = puzzle_player(session)
        board = puzzle_rows(store.puzzles.board(day, limit), me, friend_ids(session), store.progression)
        return {"number": daily_puzzle.puzzle_number(day), "day": day.isoformat(),
                "hand": daily_puzzle.preview(spec), "board": board, "theme": daily_puzzle.describe(spec),
                "players": len(store.puzzles.board(day)), "moves": spec["moves"], **store.puzzles.mine(day, me)}

    @app.post("/api/puzzle")
    async def puzzle_start(request: Request):
        """Start (or start again) today's puzzle at a table of your own."""
        session = session_for(request)
        old = store.rooms.get(session.room_id)
        if old and old.puzzle and session.token in old.seats:
            # still at the puzzle: a fresh attempt at the same table
            async with old.lock:
                old.start_puzzle()
                old.version += 1
            return snapshot(old, session.token)
        leave_old(session, 'starting the puzzle')
        store.cleanup()
        if store.table_count() >= 200:
            raise HTTPException(503, "The server has too many tables.")
        cancel_queue(session.token)
        day = daily_puzzle.today()
        number = daily_puzzle.puzzle_number(day)
        spec = await store.puzzle_maker.spec(day)
        house = daily_puzzle.is_house(spec)
        room = Room(secrets.token_urlsafe(9), f"Daily Puzzle #{number}", daily_puzzle.new_puzzle(spec).rules, None, "host",
                    True, [session.token, None], [session.username, "PuzzleBot"], ready=[False, True], wins=[0, 0],
                    # (Golfbot itself, under the puzzle's own name, look and profile)
                    participants=[None, {'id': 'bot:puzzlebot', 'kind': 'bot', 'display_name': 'PuzzleBot'}],
                    departed=[False, False], avatars=[session.avatar, PUZZLE_BOT_AVATAR],
                    void_offered=[False, False], disconnected=[None, None], house_rules=house, house_version=HOUSE_VERSION if house else None,
                    # the puzzle is to work the score out yourself: no preview before you confirm
                    score_preview=False, show_odds=False,
                    puzzle={"day": day, "number": number, "player": puzzle_player(session), "spec": spec},
                    puzzle_store=store.puzzles)
        room.start_puzzle()
        store.rooms[room.id] = room
        session.room_id = room.id
        return snapshot(room, session.token)

    @app.post("/api/solo")
    async def solo(settings: SoloSettings, request: Request):
        session = session_for(request)
        reset_notice = None
        if settings.practice and session.account:
            saved = store.progression.load_practice(session.account["id"])
            if saved and (saved.get("schema") != practice_save.SCHEMA or saved.get("patch") != PATCH_VERSION):
                reset_notice = "Your saved game was reset for this update. Your solo streak is preserved."
        if settings.practice:
            choose_avatar(session, settings.avatar)
            resumed = await resume_practice(session)
            if resumed is not None:
                return resumed
        leave_old(session)
        store.cleanup()
        if store.table_count() >= 200:
            raise HTTPException(503, "The server has too many tables.")
        if settings.practice:
            # Play solo (Practice) is one open-ended run against Golfbot, always on House rules
            settings = settings.model_copy(update={'best_of': None, 'series_mode': 'wins', 'house_rules': True,
                                                   'first': 'random'})
        set_name(session, settings.username)
        choose_avatar(session, settings.avatar)
        if settings.game_type != '1v1':
            raise HTTPException(422, 'Solo games use 1v1 mode.')
        room = Room(secrets.token_urlsafe(9), "Solo table", parse_rules(house_rules() if settings.house_rules else settings.rules), settings.best_of, 'random' if settings.house_rules else settings.first, True, [session.token, None], [session.username, "Golfbot"], history_store=store.history,
                    house_rules=settings.house_rules, house_version=HOUSE_VERSION if settings.house_rules else None,
                    series_mode=settings.series_mode, practice=settings.practice,
                    progression=store.progression,
                    progression_players=[progression_profile(session)],
                    practice_account=session.account['id'] if session.account and settings.practice else None)
        room.names[0] = session.username
        room.resume_notice = reset_notice
        room.participants = [profile_for(session), {'id': 'bot:golfbot', 'kind': 'bot', 'display_name': 'Golfbot'}]
        room.progression_players = [progression_profile(session)]
        room.avatars = [session.avatar, BOT_AVATAR]
        room.streak = store.history.solo_streak(session.token)
        room.start_round()
        room.disconnected[0] = time.time()
        store.rooms[room.id] = room
        session.room_id = room.id
        return snapshot(room, session.token)

    @app.get("/api/practice")
    async def practice_info(request: Request):
        """Whether Practice will continue a saved game, and with which rules."""
        session = session_for(request)
        saved = store.progression.load_practice(session.account['id']) if session.account else None
        if not saved or saved.get('schema') != practice_save.SCHEMA or saved.get('patch') != PATCH_VERSION:
            return {'saved': False}
        return {'saved': True, 'house_rules': bool(saved['room'].get('house_rules')), 'rules': upgrade_rule_values(saved['rules'])}

    async def resume_practice(session):
        if not session.account:
            return None
        account_id = session.account['id']
        saved = store.progression.load_practice(account_id)
        if not saved:
            return None
        if saved.get('schema') != practice_save.SCHEMA or saved.get('patch') != PATCH_VERSION:
            store.progression.delete_practice(account_id)
            return None
        old = store.rooms.get(session.room_id)
        if old and not old.practice and not old.departed[old.seats.index(session.token)]:
            leave_old(session)
        room = store.rooms.get(saved['room']['id'])
        if room is None:
            fields = dict(saved['room'])
            room = Room(rules=rules_from(saved['rules']), solo=True, seats=[session.token, None],
                        history_store=store.history, practice=True, progression=store.progression,
                        practice_account=account_id, progression_players=[progression_profile(session)], **fields)
            room.game = practice_save.restore_game(saved['game'])
            room.drop_turn_time()  # the turn they come back to was not timed from its start
            store.rooms[room.id] = room
        else:
            if room.bot_task:
                room.bot_task.cancel()
            room.seats[0] = session.token
            room.clients.clear()
        room.departed = [False, False]
        # the avatar picked on the way in applies to the saved game too
        room.avatars = [session.avatar, *list(room.avatars)[1:]] if room.avatars else [session.avatar, BOT_AVATAR]
        if room.status in ('closed', 'paused'):
            room.status = 'round_over' if room.round_recorded else 'playing'
        room.version += 1
        room.touched = time.time()
        session.room_id = room.id
        if session.account.get('display_name'):
            # the saved run goes by the name the player has now
            room.names[0] = session.username
            for profiles in (room.participants, room.progression_players):
                if profiles and isinstance(profiles[0], dict):
                    profiles[0] = {**profiles[0], 'display_name': session.username}
        else:
            session.username = room.names[0]
        return snapshot(room, session.token)

    @app.get("/api/lobbies/{room_id}")
    async def lobby_info(room_id: str):
        return public_room(find_room(room_id))

    @app.post("/api/lobbies/{room_id}/join")
    async def join_lobby(room_id: str, body: Join, request: Request):
        session = session_for(request)
        room = find_room(room_id)
        return await take_seat(room, session, body.username, body.avatar, body.via)

    def credit_invite(host, guest):
        """A join through an invite link counts for the host (the Spreading the gospel record)."""
        try:
            if isinstance(host, dict) and isinstance(guest, dict):
                store.accounts.record_invite(host.get('id'), guest.get('id'), host.get('unique_name') or host.get('display_name') or 'Player')
        except Exception:
            log.exception("Could not record an invite link join")

    async def take_seat(room, session, username, avatar=None, via=None):
        async with room.lock:
            if session.token in room.seats:
                return snapshot(room, session.token)
            leave_old(session)
            if room.solo or not room.has_open_seat:
                raise HTTPException(409, "This lobby is full or already playing.")
            choose_avatar(session, avatar)
            seat_avatar = session.avatar  # any number of players may wear the same avatar
            set_name(session, username)
            profile = profile_for(session)
            if room.game_type == 'many':
                room.seats.append(session.token)
                room.names.append(session.username)
                room.resize_seats()
                seat = len(room.seats) - 1
            else:
                seat = 1
            room.seats[seat], room.names[seat] = session.token, session.username
            room.avatars[seat] = seat_avatar
            room.participants[seat] = profile
            if via == 'link':
                credit_invite(room.participants[0], profile)
            session.room_id = room.id
            cancel_queue(session.token)
            room.ready[seat] = True
            if room.game_type == '1v1':
                room.start_round()
            room.version += 1
            room.touched = time.time()
            await broadcast(room)
            return snapshot(room, session.token)

    @app.get("/api/lobbies/{room_id}/state")
    async def state(room_id: str, request: Request):
        session = session_for(request)
        room = find_room(room_id)
        result = snapshot(room, session.token)
        kick_bot(room)
        return result

    @app.post("/api/lobbies/{room_id}/preview")
    async def preview(room_id: str, move: Move, request: Request):
        session = session_for(request)
        room = find_room(room_id)
        if not room.shows_previews:
            raise HTTPException(403, "The host turned off score previews at this table.")
        try:
            return preview_move(room, session.token, move)
        except (ValueError, TypeError, IndexError) as error:
            raise HTTPException(422, str(error)) from error

    @app.post("/api/lobbies/{room_id}/action")
    async def action(room_id: str, move: Move, request: Request):
        session = session_for(request)
        room = find_room(room_id)
        async with room.lock:
            try:
                apply_move(room, session.token, move)
            except (ValueError, TypeError, IndexError) as error:
                raise HTTPException(422, str(error)) from error
            await broadcast(room)
            schedule_reaction(room)
            kick_bot(room)
            return snapshot(room, session.token)

    @app.post("/api/deck")
    async def set_deck(body: Deck, request: Request):
        """Your custom card designs, for the tables you sit at to draw your cards in."""
        session = session_for(request)
        player = puzzle_player(session)
        choices = {card: skin for card, skin in body.choices.items() if DECK_CARD.match(card) and DECK_SKIN.match(skin)}
        if (DECK_SKINS.get(player) or {}) == choices:
            return {"ok": True}
        if choices:
            DECK_SKINS[player] = choices
        else:
            DECK_SKINS.pop(player, None)
        # the tables they are at show the change
        for room in list(store.rooms.values()):
            if any((profile or {}).get("id") == player for profile in room.participants):
                await broadcast(room)
        return {"ok": True}

    @app.post("/api/lobbies/{room_id}/emote")
    async def send_emote(room_id: str, body: Emote, request: Request):
        session = session_for(request)
        room = find_room(room_id)
        async with room.lock:
            watching = session.token not in room.seats and session.watching == room.id
            if session.token not in room.seats and not watching:
                raise HTTPException(403, "You do not have a seat in this lobby.")
            if room.game is None or room.status not in ("playing", "round_over", "finished"):
                raise HTTPException(409, "Emotes are available at the game table.")
            flag = achievements.FLAG_EMOTES.get(body.emote)
            if flag and flag not in await asyncio.to_thread(flags_for, puzzle_player(session)):
                raise HTTPException(403, f"Earn the flag “{flag}” to use this emote.")
            # a spectator cheers on behalf of the player they watch from, under their
            # own name and in their own row ("spectator:<slot>")
            seat = room.watch_seats.get(session.token, 0) if watching else None
            slot = room.watch_slots.get(session.token, 0) if watching else None
            player = f"spectator:{slot}" if watching else room.seats.index(session.token)
            if not watching:
                room.emote_counts += [0] * (len(room.seats) - len(room.emote_counts))
                room.emote_counts[player] += 1
            room.emote_sequence += 1
            room.emotes[player] = {"id": body.emote, "player": player, "sequence": room.emote_sequence,
                                   "expires_at": time.time() + EMOTE_SECONDS,
                                   **({"seat": seat, "slot": slot, "name": session.username} if watching else {})}
            # Cosmetic events must not invalidate a simultaneous card action.
            await broadcast(room)
            return snapshot(room, session.token, watch=watching)

    # ---------- spectating ----------
    def watchable(room):
        return not room.puzzle and room.game is not None and room.status in ("playing", "round_over") and not all(room.departed)

    def in_play(room):
        # what the Spectate menu offers: a game still being played. One that has
        # ended drops off the list, though whoever is watching it stays.
        return watchable(room) and room.status == "playing" and room.game.phase != "over"

    @app.get("/api/spectate")
    async def spectate_list(request: Request):
        """Every game in play anyone can watch, solo games included, newest first."""
        session = session_for(request)
        friends = friend_ids(session)
        # in play, between games of a series, or (for a minute) just finished. Your friends'
        # games come first; then the rest, the most recent move first (so the busiest tables
        # lead and the quiet ones fall to the end).
        def order(room):
            with_friends = any(profile and profile.get('id') in friends for profile in room.participants)
            return (not with_friends, -(room.moved_at or room.started_at or 0))
        rooms = sorted((room for room in store.rooms.values() if on_watch(room)), key=order)
        return [{**public_room(room), "round": len(room.history) + (0 if room.round_recorded else 1),
                 # (the game in play: once it is over its scores are in the series' points)
                 "turns": room.game.turns, "scores": showing_scores(room.game) if room.status == "playing" and not room.round_recorded else None,
                 "finished": room.status == "finished", "champion": room.champion if room.status == "finished" else None,
                 "ended_at": finished_at(room),
                 "watchers": sum(bool(sockets) for sockets in room.watchers.values()),
                 "streak": solo_streak(room),
                 # (the Watch tab's cards: how long ago it began, the series so far, everyone's MMR)
                 "started_at": room.started_at, "wins": room.wins, "points": room.points,
                 "mmr": spectate_mmr(room), "moved_at": room.moved_at or None,
                 # (each seat: whether it is one of your friends)
                 "friends": [bool(profile and profile.get('id') in friends) for profile in room.participants],
                 "mine": session.token in room.seats} for room in rooms]

    def friend_ids(session):
        """The player ids of your friends (none when you are not signed in)."""
        if not session.account:
            return set()
        try:
            return {'account:' + row['id'] for row in store.friends.list(session.account['id']) if row['status'] == 'friend'}
        except Exception:
            return set()

    WATCH_FINISHED_FOR = 60  # seconds a finished series stays on Watch, with its winner

    def finished_at(room):
        return room.history[-1].get('ended_at') if room.status == 'finished' and room.history else None

    def on_watch(room):
        """Whether a table is on the Watch tab: in play, between the games of a series, or a
        series that has just finished (for a minute, showing who won)."""
        if room.puzzle or room.game is None:
            return False
        if room.status == 'finished':
            return time.time() - (finished_at(room) or 0) < WATCH_FINISHED_FOR
        return watchable(room) and (room.status == 'round_over' or room.game.phase != 'over')

    def spectate_mmr(room):
        values = []
        for profile in room.participants:
            try:
                if demo_mmr(profile) is not None:
                    values.append(demo_mmr(profile))
                    continue
                values.append(store.progression.mmr(profile) if profile and profile.get('id', '').startswith('account:') else None)
            except Exception:
                values.append(None)
        return values

    def solo_streak(room):
        """A solo player's win streak against Golfbot, as their own table shows it (None elsewhere)."""
        if not room.solo or room.tournament or room.puzzle:
            return None
        if room.counts_streak and room.progression and room.progression_players:
            profile = room.progression.profile(room.progression_players[0])
            return {'current': profile['current_streak'], 'draws': profile['draws_in_row']}
        return {'current': room.streak, 'draws': 0}

    def start_watching(session, room):
        session.watching = room.id
        session.watch_tokens = [token for token in room.seats if token in store.sessions and token != session.token]
        return snapshot(room, session.token, watch=True)

    @app.post("/api/spectate/{room_id}")
    async def spectate(room_id: str, request: Request):
        session = session_for(request)
        room = find_room(room_id)
        if session.token in room.seats:
            raise HTTPException(409, "You're playing at this table.")
        if room.game is None or room.status == "closed":
            raise HTTPException(409, "That game has ended.")
        result = start_watching(session, room)
        await broadcast(room)
        return result

    @app.post("/api/spectate-follow")
    async def spectate_follow(request: Request):
        """Keep watching: the same table while it's open, else the next one its players sit down at."""
        session = session_for(request)
        room = store.rooms.get(session.watching)
        if room is not None and room.status != "closed" and room.game is not None:
            return snapshot(room, session.token, watch=True)
        tokens = set(session.watch_tokens)
        found = [other for other in store.rooms.values() if watchable(other) and session.token not in other.seats
                 and any(token in tokens and not other.departed[seat] for seat, token in enumerate(other.seats))]
        if not found:
            raise HTTPException(404, "The players haven't started another game yet.")
        room = max(found, key=lambda other: other.started_at or 0)
        session.watching = room.id  # the players being followed stay the same
        return snapshot(room, session.token, watch=True)

    @app.post("/api/spectate-stop")
    async def spectate_stop(request: Request):
        session = session_for(request)
        session.watching, session.watch_tokens = None, []
        return {"stopped": True}

    async def watch_socket(ws, room, token):
        await ws.accept()
        room.watchers.setdefault(token, set()).add(ws)
        room.watched_by.add(token)
        if token not in room.watch_slots:
            taken = set(room.watch_slots.values())
            room.watch_slots[token] = next(slot for slot in range(len(taken) + 1) if slot not in taken)
        try:
            await broadcast(room)  # the players see one more watching
            while True:
                text = await ws.receive_text()
                session = store.sessions.get(token)
                if session is None or session.watching != room.id:
                    await ws.close(code=4403)
                    return
                session.touched = time.time()
                # "seat:N": the spectator turned the table to watch from player N's seat
                seat = text.removeprefix("seat:")
                if seat != text and seat.isdigit() and int(seat) < len(room.seats):
                    room.watch_seats[token] = int(seat)
                    await broadcast(room)
                    continue
                await ws.send_json(snapshot(room, token, watch=True))
        except WebSocketDisconnect:
            pass
        finally:
            room.watchers.get(token, set()).discard(ws)
            if not room.watchers.get(token):
                room.watchers.pop(token, None)
                room.watch_seats.pop(token, None)
                room.watch_slots.pop(token, None)
            await broadcast(room)

    @app.post("/api/lobbies/{room_id}/leave")
    async def leave(room_id: str, request: Request):
        session = session_for(request)
        if session.token in store.queue_switching:
            raise HTTPException(409, 'Your Classic match is starting. Please wait a moment.')
        room = find_room(room_id)
        return await leave_table(room, session)

    async def leave_table(room, session):
        async with room.lock:
            if session.token not in room.seats:
                raise HTTPException(403, "You are not at this table.")
            seat = room.seats.index(session.token)
            if room.departed[seat]:
                return {'left': True}
            if session.room_id == room.id:
                session.room_id = None
            if room.puzzle:
                # a puzzle is nobody else's: leaving just puts it away
                room.status, room.departed = "closed", [True, True]
                store.rooms.pop(room.id, None)
                return {"left": True}
            if store.queue_results.get(session.token) == room.id:
                store.queue_results.pop(session.token, None)
            if room.status == "waiting" and seat != 0:
                if room.game_type == 'many':
                    for key in ('seats', 'names', 'ready', 'wins', 'participants', 'departed', 'avatars'):
                        getattr(room, key).pop(seat)
                else:
                    room.seats[1], room.names[1], room.ready[1] = None, "Waiting...", False
                    room.participants[1] = None
                    room.avatars[1] = DEFAULT_AVATAR
            else:
                # Leaving must always succeed: storage trouble is logged, never
                # returned as a server error that keeps the player at the table.
                try:
                    if room.practice and room.practice_account:
                        room.save_practice()
                    elif room.counts_streak and not room.round_recorded:
                        store.progression.reset_streak(room.progression_players[0], room.patch)
                    if room.rated or room.tournament:
                        forfeit(room, seat)
                except Exception:
                    log.exception("Could not record the departure from table %s", room.id)
                room.drop_turn_time(seat)
                room.status = "closed"
                room.departed[seat] = True
                if room.solo:
                    room.departed[1] = True
                try:
                    if not (room.practice and room.practice_account):
                        room.finish_continuous()
                    room.flush_emotes()
                    store.history.save(room, abandoned=True)
                except Exception:
                    log.exception("Could not save the history of table %s", room.id)
                if room.bot_task:
                    room.bot_task.cancel()
            room.version += 1
            await broadcast(room)
            return {"left": True}

    def forfeit(room, seat):
        """`seat` gives up the match by leaving (or staying away too long).

        At a Ranked table the game in play is lost, and so is the series: the player
        who stayed wins it. Games never dealt count for nothing. A tournament match
        that is not Ranked simply ends, with the seat noted for the bracket.
        """
        if room.status not in ('playing', 'round_over') or room.series_complete:
            return
        room.void_offer = None
        room.forfeited = seat
        winner = 1 - seat
        if room.rated:
            if not room.round_recorded:
                scores = [0, 0]
                scores[seat] = 1
                room.history.append({'round': len(room.history) + 1, 'scores': scores,
                                     'winner': winner, 'forfeit': True, 'rules': asdict(room.rules),
                                     'house_rules': room.house_rules, 'house_version': room.house_version,
                                     'patch': room.patch, 'ended_at': time.time(), 'turns': room.game.turns})
                room.wins[winner] += 1
                room.round_recorded = True
                event_id = room.match_id + ':' + str(len(room.history))
                room.history[-1]['game_rating'] = store.progression.rate_game(event_id, room.progression_players, winner, room.patch)
            series = store.progression.rate_series(room.match_id + ':series', room.progression_players, winner, room.patch)
            room.history[-1].update(mmr=series, series_winner=winner, series_forfeit=seat)
        # A forfeit ends early; never award a full series victory from synthetic points.
        room.champion = None
        room.series_complete = False
        room.status = 'closed'
        if room.history_store:
            room.history_store.save(room, abandoned=True)

    async def monitor_tables():
        swept = time.time()
        while True:
            await asyncio.sleep(1)
            # (idle tables are put away within a minute of their time running out, not only
            # when someone next opens a table)
            if time.time() - swept > 60:
                swept = time.time()
                try:
                    store.cleanup()
                except Exception:
                    log.exception("Could not put idle tables away")
            for room in list(store.rooms.values()):
                async with room.lock:
                    had_offer = room.void_offer is not None
                    room.expire_offer()
                    changed = had_offer and room.void_offer is None
                    # Leaving the site and coming back keeps your seat. Only a rated
                    # player gone for longer than RATED_GRACE forfeits (so nobody can
                    # stall an opponent); a practice table simply waits for you.
                    if (room.rated or room.tournament) and not room.ai_match and room.status in ('playing', 'round_over'):
                        for seat, since in enumerate(room.disconnected):
                            if room.solo and seat == 1:
                                continue  # Golfbot is always there
                            if since is not None and time.time() - since >= RATED_GRACE and not room.clients.get(room.seats[seat]):
                                forfeit(room, seat)
                                if room.tournament:
                                    absent_from_tournament(room, seat)
                                room.version += 1
                                changed = True
                                break
                    if changed:
                        await broadcast(room)
            try:
                await advance_tournaments()
            except Exception:
                log.exception("Could not advance the tournaments")

    @app.post('/api/lobbies/{room_id}/void-offer')
    async def offer_void(room_id: str, request: Request):
        session = session_for(request)
        room = find_room(room_id)
        async with room.lock:
            if session.token not in room.seats:
                raise HTTPException(403, 'You are not at this table.')
            seat = room.seats.index(session.token)
            room.expire_offer()
            if room.tournament:
                raise HTTPException(409, 'A tournament match cannot be voided.')
            if not room.rated or room.status != 'playing' or room.round_recorded or room.void_offer or room.void_offered[seat]:
                raise HTTPException(409, 'You may offer once during each Ranked game.')
            room.void_offered[seat] = True
            room.void_offer = {'by': seat, 'expires_at': time.time() + 30}
            room.version += 1
            await broadcast(room)
            return snapshot(room, session.token)

    @app.post('/api/lobbies/{room_id}/void-reply')
    async def reply_void(room_id: str, body: VoidReply, request: Request):
        session = session_for(request)
        room = find_room(room_id)
        async with room.lock:
            if session.token not in room.seats:
                raise HTTPException(403, 'You are not at this table.')
            room.expire_offer()
            offer = room.void_offer
            if not offer:
                raise HTTPException(409, 'That offer has expired.')
            if room.seats.index(session.token) == offer['by']:
                raise HTTPException(403, 'Only your opponent can respond.')
            room.void_offer = None
            if body.accept:
                room.status = 'closed'
                room.champion = None
                room.series_complete = False
                store.history.save(room, abandoned=True)
            room.version += 1
            await broadcast(room)
            return snapshot(room, session.token)

    # ---------- tournaments ----------
    # A tournament is a bracket (tournament.py) whose match-ups are played at
    # ordinary 1v1 tables. Once a second (monitor_tables) each running tournament
    # reads the results of its tables into the bracket and seats whoever plays next.
    TOURNAMENT_NEXT_GAME = 45  # seconds a finished game waits for "Next game" before it is dealt anyway
    AI_MATCH_PACE = 0.55       # two AIs play briskly, so the bracket is not kept waiting
    AI_MATCH_BREAK = 4         # ...with a pause on each result for whoever is watching

    def find_tournament(tournament_id):
        tournament = store.tournaments.get(tournament_id)
        if tournament is None or tournament.status == 'cancelled':
            raise HTTPException(404, "That tournament is no longer available.")
        return tournament

    def in_tournament(session):
        """The running or open tournament this player is still part of, if any."""
        tournament = store.tournaments.get(session.tournament_id)
        entrant = tournament.by_token(session.token) if tournament else None
        if entrant is None or entrant.withdrawn or tournament.status not in ('open', 'live'):
            return None
        return tournament

    def tournament_presence(session):
        tournament = in_tournament(session)
        if tournament is None:
            return None
        entrant = tournament.by_token(session.token)
        match = next((match for match in tournament.live() if entrant.id in match.players), None)
        return {'id': tournament.id, 'name': tournament.name, 'status': tournament.status,
                'room_id': match.room_id if match else None}

    def by_place(room, values):
        """A table's per-seat values in the order of the bracket's two places."""
        slots = room.tournament['slots']
        return [values[slots.index(place)] for place in (0, 1)]

    def tournament_view(tournament, session):
        view = tournament.view()
        for row in view['matches']:
            room = store.rooms.get(row['room_id']) if row['room_id'] else None
            if room is not None and room.tournament and row['status'] == 'live':
                # the match as it stands, for the dashboard
                row['live'] = {'game': len(room.history) + (0 if room.round_recorded else 1),
                               'wins': by_place(room, room.wins), 'points': by_place(room, room.points),
                               'scores': by_place(room, showing_scores(room.game)) if room.game and room.status == 'playing' else None,
                               'watchers': sum(bool(sockets) for sockets in room.watchers.values())}
        entrant = tournament.by_token(session.token)
        match = next((match for match in tournament.live() if entrant and entrant.id in match.players), None)
        view['you'] = {'entrant': entrant.id if entrant else None,
                       'host': bool(entrant and entrant.id == tournament.host),
                       'match': match.id if match else None, 'room_id': match.room_id if match else None}
        return view

    def enter_tournament(tournament, session):
        profile = profile_for(session)
        if any(other.profile and other.profile.get('id') == profile['id'] for other in tournament.entrants.values()):
            raise HTTPException(409, "You are already in this tournament on another device.")
        try:
            entrant = tournament.add(session.username, session.token, session.avatar, profile,
                                     store.progression.mmr(progression_profile(session)))
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        session.tournament_id = tournament.id
        return entrant

    @app.get('/api/tournaments')
    async def tournaments(request: Request):
        """Tournaments to join or follow: open ones and running ones. (Finished ones are in Match history.)"""
        session = session_for(request)
        rows = []
        for tournament in store.tournaments.values():
            if tournament.status not in ('open', 'live'):
                continue
            host, champion = tournament.entrants.get(tournament.host), tournament.entrants.get(tournament.champion)
            rows.append({'id': tournament.id, 'name': tournament.name, 'status': tournament.status,
                         'format': tournament.format, 'format_name': FORMAT_NAMES[tournament.format],
                         'ranked': tournament.ranked, 'entrants': len(tournament.entrants),
                         'host': host.name if host else '', 'champion': champion.name if champion else None,
                         'live': len(tournament.live()), 'settings': tournament.settings,
                         # (the Watch tab's card: when it began, and how many are watching its matches)
                         'started_at': tournament.started_at, 'watchers': tournament_watchers(tournament),
                         'mine': tournament.by_token(session.token) is not None, 'created_at': tournament.created_at})
        return sorted(rows, key=lambda row: (('live', 'open').index(row['status']), -row['created_at']))

    def tournament_watchers(tournament):
        """Everyone watching one of a tournament's matches now."""
        total = 0
        for match in tournament.live():
            room = store.rooms.get(match.room_id) if match.room_id else None
            if room is not None:
                total += sum(bool(sockets) for sockets in room.watchers.values())
        return total

    @app.get('/api/tournament-history')
    async def tournament_history(request: Request):
        """Finished tournaments, newest first, for Match history."""
        viewer = profile_for(session_for(request))['id']
        rows = []
        for saved in store.history.tournaments():
            entrants = {entrant['id']: entrant for entrant in saved.get('entrants') or []}
            host, champion = entrants.get(saved.get('host')), entrants.get(saved.get('champion'))
            rows.append({'id': saved['id'], 'name': saved.get('name'), 'status': 'finished',
                         'format': saved.get('format'), 'format_name': saved.get('format_name'),
                         'ranked': bool(saved.get('ranked')), 'entrants': len(entrants),
                         'host': host['name'] if host else '', 'champion': champion['name'] if champion else None,
                         'live': 0, 'settings': saved.get('settings'), 'finished_at': saved.get('finished_at'),
                         'mine': any(entrant.get('player_id') == viewer for entrant in entrants.values())})
        return rows

    @app.post('/api/tournaments')
    async def host_tournament(settings: TournamentSettings, request: Request):
        session = session_for(request)
        leave_old(session)
        if in_tournament(session):
            raise HTTPException(409, "Leave your current tournament before hosting another.")
        if len(store.tournaments) >= 30:
            raise HTTPException(503, "The server has too many tournaments. Try again later.")
        set_name(session, settings.username)
        choose_avatar(session, settings.avatar)
        cancel_queue(session.token)
        # a Ranked tournament is always played on House rules, so MMR measures one game
        house = settings.house_rules or settings.ranked
        rules = parse_rules(house_rules() if house else settings.rules)
        tournament = Tournament(secrets.token_urlsafe(9), clean_name(settings.name), None, settings.format,
                                settings.seeding, settings.fill, settings.ranked, settings={
                                    'best_of': settings.best_of, 'series_mode': settings.series_mode,
                                    'first': 'random' if house else settings.first, 'house_rules': house,
                                    'house_version': HOUSE_VERSION if house else None, 'rules': asdict(rules),
                                    'score_preview': settings.score_preview, 'show_odds': settings.show_odds})
        tournament.host = enter_tournament(tournament, session).id
        store.tournaments[tournament.id] = tournament
        return tournament_view(tournament, session)

    @app.get('/api/tournaments/{tournament_id}')
    async def tournament_state(tournament_id: str, request: Request):
        session = session_for(request)
        if tournament_id not in store.tournaments:
            # one that finished a while ago: its saved bracket, to look at
            saved = store.history.tournament(tournament_id)
            if saved:
                viewer = profile_for(session)['id']
                mine = next((entrant['id'] for entrant in saved.get('entrants') or [] if entrant.get('player_id') == viewer), None)
                return {**saved, 'can_start': False, 'you': {'entrant': mine, 'host': False, 'match': None, 'room_id': None}}
        return tournament_view(find_tournament(tournament_id), session)

    def seat_in_tournament(tournament, session, username, avatar, via=None):
        """Enter a tournament still gathering players (from its page, its link, or an invitation)."""
        if tournament.by_token(session.token):
            return tournament_view(tournament, session)
        if tournament.status != 'open':
            raise HTTPException(409, "This tournament has already started.")
        leave_old(session)
        if in_tournament(session):
            raise HTTPException(409, "Leave your current tournament before joining another.")
        set_name(session, username)
        choose_avatar(session, avatar)
        cancel_queue(session.token)
        entrant = enter_tournament(tournament, session)
        host = tournament.entrants.get(tournament.host)
        if via == 'link' and host:
            credit_invite(host.profile, entrant.profile)
        return tournament_view(tournament, session)

    @app.post('/api/tournaments/{tournament_id}/join')
    async def join_tournament(tournament_id: str, body: Join, request: Request):
        return seat_in_tournament(find_tournament(tournament_id), session_for(request), body.username, body.avatar, body.via)

    @app.post('/api/tournaments/{tournament_id}/invite')
    async def invite_to_tournament(tournament_id: str, body: InvitePlayer, request: Request):
        """The host asks someone online to join, as the host of a table can."""
        session = session_for(request)
        tournament = find_tournament(tournament_id)
        tournament_host(tournament, session)
        if tournament.status != 'open' or len(tournament.entrants) >= MAX_ENTRANTS:
            raise HTTPException(409, 'This tournament is not taking players.')
        return send_invitation(session, body.player_id, 'tournament', tournament.id)

    @app.post('/api/tournaments/{tournament_id}/leave')
    async def leave_tournament(tournament_id: str, request: Request):
        session = session_for(request)
        tournament = find_tournament(tournament_id)
        entrant = tournament.by_token(session.token)
        if entrant is not None:
            if tournament.status == 'open':
                if entrant.id == tournament.host:
                    # the host leaving the lobby closes it, as a host leaving closes a table:
                    # nothing of it is kept, and everyone who had joined is free again
                    tournament.status = 'cancelled'
                    store.tournaments.pop(tournament.id, None)
                    for other in tournament.entrants.values():
                        joined = store.sessions.get(other.token)
                        if joined and joined.tournament_id == tournament.id:
                            joined.tournament_id = None
                    prune_invites()
                else:
                    tournament.remove(entrant.id)
            elif tournament.status == 'live':
                # the match being played is given up first, then every one still to come
                match = next((match for match in tournament.live() if entrant.id in match.players), None)
                room = store.rooms.get(match.room_id) if match else None
                if room is not None and session.token in room.seats and not room.departed[room.seats.index(session.token)]:
                    await leave_table(room, session)
                tournament.withdraw(entrant.id)
                await advance_tournament(tournament)
        if session.tournament_id == tournament.id:
            session.tournament_id = None
        return {'left': True}

    def tournament_host(tournament, session):
        entrant = tournament.by_token(session.token)
        if entrant is None or entrant.id != tournament.host:
            raise HTTPException(403, "Only the host can do that.")
        return entrant

    @app.post('/api/tournaments/{tournament_id}/remove')
    async def remove_tournament_entrant(tournament_id: str, body: TournamentEntrant, request: Request):
        """The host takes a player out of the lobby before the start."""
        session = session_for(request)
        tournament = find_tournament(tournament_id)
        host = tournament_host(tournament, session)
        entrant = tournament.entrants.get(body.entrant)
        if tournament.status != 'open' or entrant is None or entrant.id == host.id:
            raise HTTPException(409, "That entrant cannot be removed.")
        tournament.remove(entrant.id)
        removed = store.sessions.get(entrant.token)
        if removed and removed.tournament_id == tournament.id:
            removed.tournament_id = None
        return tournament_view(tournament, session)

    @app.post('/api/tournaments/{tournament_id}/start')
    async def start_tournament(tournament_id: str, request: Request):
        session = session_for(request)
        tournament = find_tournament(tournament_id)
        tournament_host(tournament, session)
        if not tournament.can_start:
            raise HTTPException(409, "A tournament needs at least two players.")
        for entrant in tournament.entrants.values():
            # seeded on the MMR each player has now, not when they joined
            player = store.sessions.get(entrant.token)
            if player is not None:
                entrant.rating = store.progression.mmr(progression_profile(player))
                entrant.name = player.username
        tournament.start(ai_avatar=BOT_AVATAR)
        await advance_tournament(tournament)
        return tournament_view(tournament, session)

    @app.post('/api/tournaments/{tournament_id}/matches/{match_id}/award')
    async def award_tournament_match(tournament_id: str, match_id: str, body: TournamentAward, request: Request):
        """The host settles a match that cannot finish by itself (someone stuck or gone)."""
        session = session_for(request)
        tournament = find_tournament(tournament_id)
        tournament_host(tournament, session)
        match = tournament.matches.get(match_id)
        if tournament.status != 'live' or match is None or match.status == 'done' or None in match.players:
            raise HTTPException(409, "That match cannot be awarded.")
        room = store.rooms.get(match.room_id) if match.room_id else None
        if room is not None and room.status != 'closed':
            async with room.lock:
                room.forfeited = room.tournament['slots'].index(1 - body.winner)
                room.void_offer = None
                room.status = 'closed'
                room.version += 1
                if room.bot_task:
                    room.bot_task.cancel()
                if room.history_store:
                    room.history_store.save(room, abandoned=True)
                await broadcast(room)
        tournament.report(match.id, body.winner, note='awarded')
        await advance_tournament(tournament)
        return tournament_view(tournament, session)

    def absent_from_tournament(room, seat):
        """Someone who never came back to their match is out of the tournament, so the
        opponents they were still to meet are not each kept waiting for them in turn."""
        tournament = store.tournaments.get(room.tournament['id'])
        match = tournament.matches.get(room.tournament['match']) if tournament else None
        if match is not None:
            tournament.withdraw(match.players[room.tournament['slots'][seat]])

    def match_outcome(room):
        """How a tournament table ended, as (winning place, score, points, note); None while it plays on."""
        if room is None:
            return 0, None, None, 'forfeit'  # the table is gone: the upper place goes through
        if room.series_complete:
            winner = None if room.champion is None else room.tournament['slots'][room.champion]
            return winner, by_place(room, room.wins if room.series_mode == 'wins' else room.points), by_place(room, room.points), None
        if room.status == 'closed':
            seat = room.forfeited if room.forfeited is not None else next((seat for seat, gone in enumerate(room.departed) if gone), 0)
            score = by_place(room, room.wins if room.series_mode == 'wins' else room.points) if room.history else None
            return room.tournament['slots'][1 - seat], score, by_place(room, room.points) if room.history else None, 'forfeit'
        return None

    async def vacate(session):
        """Stand a player up from wherever they are sitting, ready for their match."""
        cancel_queue(session.token)
        old = store.rooms.get(session.room_id)
        if old is not None and at_table(session):
            await leave_table(old, session)

    async def start_match(tournament, match):
        first, second = (tournament.entrants[player] for player in match.players)
        for entrant in (first, second):
            # someone whose session has gone cannot be seated: they are out of the tournament
            if not entrant.ai and entrant.token not in store.sessions:
                tournament.withdraw(entrant.id)
        if match.status != 'pending':
            return
        settings = tournament.settings
        common = dict(house_rules=settings['house_rules'], house_version=settings['house_version'],
                      series_mode=settings['series_mode'], score_preview=settings['score_preview'],
                      show_odds=settings['show_odds'], must_decide=tournament.format != 'round_robin')
        name = f'{tournament.name}: {tournament.label(match)}'
        rules, best_of, order = parse_rules(dict(settings['rules'])), settings['best_of'], settings['first']
        bot = lambda entrant: {'id': 'bot:golfbot', 'kind': 'bot', 'display_name': entrant.name}
        if first.ai and second.ai:
            # two AIs: Golfbot plays both hands at a table of its own, which anyone can watch
            room = Room(secrets.token_urlsafe(9), name, rules, best_of, order, True, [f'ai:{secrets.token_hex(6)}', None],
                        [first.name, second.name], history_store=None, ai_match=True, **common)
            room.participants, slots = [bot(first), bot(second)], [0, 1]
            room.avatars = [first.avatar or BOT_AVATAR, second.avatar or BOT_AVATAR]
        elif first.ai or second.ai:
            # a player against an AI: a solo table, with the player in its first seat
            human, ai = (second, first) if first.ai else (first, second)
            slots = [1, 0] if first.ai else [0, 1]
            if first.ai:
                order = {'host': 'guest', 'guest': 'host'}.get(order, order)
            session = store.sessions[human.token]
            await vacate(session)
            human.name = session.username
            room = Room(secrets.token_urlsafe(9), name, rules, best_of, order, True, [session.token, None],
                        [session.username, ai.name], history_store=store.history, **common)
            room.participants = [profile_for(session), bot(ai)]
            room.avatars = [session.avatar, ai.avatar or BOT_AVATAR]
            session.room_id = room.id
        else:
            sessions = [store.sessions[entrant.token] for entrant in (first, second)]
            for session in sessions:
                await vacate(session)
            ranked = tournament.ranked
            room = Room(secrets.token_urlsafe(9), name, rules, best_of, order, False, [session.token for session in sessions],
                        [session.username for session in sessions], history_store=store.history,
                        participants=[profile_for(session) for session in sessions],
                        avatars=[session.avatar for session in sessions], rated=ranked,
                        progression=store.progression if ranked else None,
                        progression_players=[progression_profile(session) for session in sessions] if ranked else [], **common)
            slots = [0, 1]
            for entrant, session in zip((first, second), sessions):
                entrant.name = session.username
                session.room_id = room.id
        room.tournament = {'id': tournament.id, 'match': match.id, 'slots': slots,
                           'name': tournament.name, 'label': tournament.label(match)}
        store.rooms[room.id] = room
        room.start_round()
        room.version += 1
        match.status, match.room_id, match.started_at = 'live', room.id, time.time()
        room.demo = getattr(tournament, 'demo', False)
        if room.ai_match:
            room.bot_task = asyncio.create_task(ai_match_loop(room))

    async def advance_tournament(tournament):
        """Read finished tables into the bracket, then seat everyone who can play next."""
        for _ in range(64):  # a result can free players for another match straight away
            for match in tournament.live():
                room = store.rooms.get(match.room_id)
                outcome = match_outcome(room)
                if outcome is not None:
                    winner, score, points, note = outcome
                    tournament.report(match.id, winner, score, points, note)
                else:
                    await nudge_match(room)
            ready = tournament.ready() if tournament.status == 'live' else []
            if not ready:
                break
            for match in ready:
                await start_match(tournament, match)
        if tournament.status == 'finished' and not getattr(tournament, 'saved', False) and not getattr(tournament, 'demo', False):
            tournament.saved = True
            try:
                store.history.save_tournament(tournament.view())
            except Exception:
                log.exception("Could not save tournament %s", tournament.id)

    async def nudge_match(room):
        """Keep a tournament table moving: wake its AIs, and deal the next game if nobody asks for it."""
        if room.ai_match:
            if room.bot_task is None or room.bot_task.done():
                room.bot_task = asyncio.create_task(ai_match_loop(room))
        elif (room.status == 'round_over' and room.history
              and time.time() - room.history[-1].get('ended_at', time.time()) >= TOURNAMENT_NEXT_GAME):
            async with room.lock:
                if room.status == 'round_over':
                    room.start_round()
                    room.version += 1
                    await broadcast(room)
                    kick_bot(room)

    async def advance_tournaments():
        for key, tournament in list(store.tournaments.items()):
            if tournament.status == 'live':
                try:
                    await advance_tournament(tournament)
                except Exception:
                    log.exception("Could not advance tournament %s", tournament.id)
            elif time.time() - tournament.touched > 12 * 3600:
                del store.tournaments[key]  # an old lobby, or a result nobody has looked at in a while

    async def ai_match_loop(room):
        """A tournament match between two AIs: Golfbot plays both seats, a move at a time,
        and deals each next game itself after a short pause on the result."""
        rng = random.Random()
        try:
            while True:
                # (a demo match plays at a watchable pace)
                await asyncio.sleep(2.2 if room.demo else AI_MATCH_PACE)
                async with room.lock:
                    if room.id not in store.rooms or room.status not in ("playing", "round_over"):
                        return
                    game = room.game
                    if room.status == "round_over":
                        if time.time() - room.history[-1].get('ended_at', 0) >= AI_MATCH_BREAK:
                            room.start_round()
                            room.version += 1
                            await broadcast(room)
                        continue
                    if game.phase == "setup":
                        # the first seat turns two cards up; the engine answers for the second
                        hidden = [index for index, slot in enumerate(game.players[0]) if not slot.visible]
                        for index in rng.sample(hidden, 2 - game.visible_count(0)):
                            game.opening_reveal(0, index)
                        room.track_scores()
                        room.version += 1
                        await broadcast(room)
                        continue
                    if game.phase == "over":
                        continue
                    version = room.version
                    position = public_position(game)
                    position._root_actions = set(legal_actions(game))
                try:
                    # (a demo match: the quick debug bot's legal moves, not Golfbot's search)
                    if room.demo:
                        allowed = list(position._root_actions)
                        moves = [action for action in allowed if action[0] != "bonus"] or allowed
                        action = fallback_action(allowed) if rng.random() < 0.55 else (rng.choice(moves) if moves else None)
                    else:
                        action = await bot_workers.choose(position)
                except Exception:
                    log.exception("AI decision failed at table %s; using a legal fallback", room.id)
                    action = None
                async with room.lock:
                    if room.id not in store.rooms or room.status != "playing":
                        continue
                    if room.game is not game or room.version != version:
                        continue
                    allowed = legal_actions(game)
                    if action not in allowed:
                        action = fallback_action(allowed)
                    if action is None:
                        log.error("No legal AI move at table %s in phase %s", room.id, game.phase)
                        return
                    play_action(game, action)
                    room.track_scores()
                    room.record_result()
                    room.version += 1
                    room.touched = time.time()
                    await broadcast(room)
        except Exception:
            log.exception("The AI match stopped unexpectedly at table %s", room.id)
        finally:
            if room.bot_task is asyncio.current_task():
                room.bot_task = None

    @app.websocket("/ws/{room_id}")
    async def websocket(ws: WebSocket, room_id: str):
        origin = ws.headers.get("origin")
        if origin and urlparse(origin).netloc != ws.headers.get("host"):
            await ws.close(code=4403)
            return
        token = ws.cookies.get(COOKIE)
        room = store.rooms.get(room_id)
        if (token in store.sessions and room is not None and token not in room.seats
                and store.sessions[token].watching == room_id):
            await watch_socket(ws, room, token)
            return
        if token not in store.sessions or room is None or token not in room.seats:
            await ws.close(code=4403)
            return
        await ws.accept()
        room.clients.setdefault(token, set()).add(ws)
        seat = room.seats.index(token)
        if seat < len(room.disconnected):
            room.disconnected[seat] = None
        try:
            kick_bot(room)
            await broadcast(room)
            while True:
                message = await ws.receive_text()
                # the page says when it goes into (or out of) the background
                if message == "hidden":
                    room.away.add(ws)
                    if not room.seat_present(seat):
                        room.drop_turn_time(seat)  # they switched away mid-turn: not timed
                elif message == "visible":
                    room.away.discard(ws)
                if token not in room.seats:
                    await ws.close(code=4403)
                    return
                store.session(token)
                room.touched = time.time()
                # The heartbeat doubles as a watchdog: if Golfbot's task ever
                # died mid-turn, the next ping wakes it instead of a page reload.
                kick_bot(room)
                await ws.send_json(snapshot(room, token))
        except WebSocketDisconnect:
            pass
        finally:
            room.away.discard(ws)
            room.clients.get(token, set()).discard(ws)
            if not room.clients.get(token) and token in room.seats:
                seat = room.seats.index(token)
                if seat < len(room.disconnected):
                    room.disconnected[seat] = time.time()
                room.drop_turn_time(seat)  # a turn they walked away from is not timed
                room.save_practice()
                if room.practice and room.bot_task:
                    room.bot_task.cancel()
            await broadcast(room)

    app.mount("/static", VersionedStatic(directory=ROOT / "web"), name="static")

    def page_response(filename, request, boot=False):
        base = request.scope.get("root_path", "").rstrip("/") + "/"
        html = (ROOT / "web" / filename).read_text(encoding="utf-8").replace("__GOLF_BASE__", base)
        cookies = Response()  # collects the session cookie, if this page opens one
        if debug_mode():
            # a debug build (launch.py --debug): DEBUG in the tab title and a bug
            # on the icon, so it is never mistaken for the real site
            html = re.sub(r"<title>(.*?)</title>", r"<title>DEBUG · \1</title>", html, count=1)
            html = html.replace('"static/assets/icon.png"', '"static/assets/icon-debug.png"')
            html = html.replace("<html", '<html data-debug', 1)
        if boot:
            # What the app needs for its first page, in the page itself: no round
            # trips before anything can be drawn (a blank screen on a refresh).
            data = {"session": open_session(request, cookies), "rules": rules_data(),
                    "matchOptions": match_options_data(), "avatars": avatars_data()}
            # the Ranked pill is drawn with the first page instead of popping
            # in once the first presence poll answers
            data["queue"] = boot_queue(request.state.golf_session)
            script = '<script id="boot-data" type="application/json">' + json.dumps(data).replace("</", "<\\/") + "</script>"
            html = html.replace("</head>", f"    {script}\n  </head>", 1)
        # Version every script and stylesheet the page loads, so a release never mixes old and new files.
        for asset in sorted(set(re.findall(r'"static/([\w./-]+\.(?:js|css))"', html))):
            version = sha256((ROOT / "web" / asset).read_bytes()).hexdigest()[:16]
            html = html.replace(f'"static/{asset}"', f'"static/{asset}?v={version}"')
        response = HTMLResponse(html, headers={"Cache-Control": "no-store"})
        response.raw_headers.extend(item for item in cookies.raw_headers if item[0] == b"set-cookie")
        return response

    @app.get('/privacy')
    async def privacy(request: Request):
        return page_response('privacy.html', request)

    @app.get("/")
    @app.get("/history")
    @app.get("/stats")
    @app.get("/leaderboard")
    @app.get("/spectate")
    # the home screen's tabs (Play is "/")
    @app.get("/flags")
    @app.get("/you")
    @app.get("/watch")
    @app.get("/aces")
    @app.get("/aces/{view}")
    @app.get("/player/{player_id}")
    @app.get("/puzzle")
    @app.get("/tournament/{tournament_id}")
    @app.get("/patch-notes")
    @app.get("/notifications")
    @app.get("/account")
    @app.get("/lobby/{room_id}")
    async def index(request: Request):
        # A cached script from an earlier release can leave new buttons inert.
        # Content versions also work when files change without restarting Uvicorn.
        return page_response('index.html', request, boot=True)

    # Serve the same store at the public subpath and at localhost's existing URLs.
    # Only the outer app runs the lifespan; mounted app lifespans are not invoked.
    host = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    host.state.store = store
    host.state.advance_tournaments = advance_tournaments  # the once-a-second pass, for tests

    @host.api_route('/Golfgame', methods=['GET', 'POST', 'DELETE', 'PATCH', 'PUT', 'OPTIONS', 'HEAD'])
    @host.api_route('/Golfgame/{rest:path}', methods=['GET', 'POST', 'DELETE', 'PATCH', 'PUT', 'OPTIONS', 'HEAD'])
    @host.api_route('/golfgame', methods=['GET', 'POST', 'DELETE', 'PATCH', 'PUT', 'OPTIONS', 'HEAD'])
    @host.api_route('/golfgame/{rest:path}', methods=['GET', 'POST', 'DELETE', 'PATCH', 'PUT', 'OPTIONS', 'HEAD'])
    async def legacy_game_url(request: Request, rest: str = ''):
        response = RedirectResponse(str(request.url.replace(path='/golf/' + rest)), status_code=308)
        # Legacy cookies otherwise never reach the new path. Move them on the redirect.
        for key, age in ((COOKIE, 365 * 86400), (ACCOUNT_COOKIE, LOGIN_DAYS * 86400)):
            if request.cookies.get(key):
                response.set_cookie(key, request.cookies[key], path='/golf/', httponly=True,
                                    secure=request.url.scheme == 'https', samesite='lax', max_age=age)
        return response

    @host.get('/golf')
    async def canonical_game_url(request: Request):
        return RedirectResponse(str(request.url.replace(path='/golf/')), status_code=308)

    host.mount('/golf', app)
    host.mount("/", app)
    return host


app = create_app(Store(os.environ.get("GOLFBOT_HISTORY_DB", ROOT / "data" / "matches.sqlite3")))
