"""Single-process, server-authoritative Golf lobbies served by FastAPI/Uvicorn."""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass, field
from hashlib import sha256
from pathlib import Path
import os
import json
import logging
import re
import secrets
import time
from urllib.parse import urlparse
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StrictInt, field_validator

from game import GolfGame, Rules, RULE_OPTIONS
from rule_help import load_rule_help
from match_history import MatchHistory
from player_stats import build_stats
from scoring import active_rule_effects, visible_effect_total
from bot import fallback_action, legal_actions, play_action, public_position
from bot_workers import BotWorkers
from accounts import Accounts, ACCOUNT_COOKIE, LOGIN_DAYS, participant, verify_google_token
from match_settings import HOUSE_VERSION, house_rules
from patches import PATCH_VERSION, PATCH_NOTES

ROOT = Path(__file__).parent
COOKIE = "golf_session"
START_POLICIES = ("host", "guest", "alternate", "random", "winner", "loser")
EMOTE_SECONDS = 4
log = logging.getLogger(__name__)


class Emote(BaseModel):
    model_config = ConfigDict(extra="forbid")
    emote: Literal["unamused", "shocked", "laughing", "nervous"]


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

    @field_validator("best_of")
    @classmethod
    def odd_match_length(cls, value):
        if value is not None and value % 2 == 0:
            raise ValueError("Best of must be an odd number.")
        return value


class SoloSettings(Settings):
    best_of: StrictInt | None = Field(default=1, ge=1, le=9)
    first: Literal["host", "guest", "alternate", "random", "winner", "loser"] = "host"


class Join(BaseModel):
    username: str = Field(min_length=1, max_length=32)


class InvitePlayer(BaseModel):
    player_id: str = Field(min_length=1, max_length=32)


class InviteReply(BaseModel):
    accept: bool
    username: str = Field(default="Player", min_length=1, max_length=32)


class Move(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["flip", "draw", "swap", "discard", "end_turn", "guess", "arrange", "set_rule", "set_rules", "ready", "start", "next_round", "rematch"]
    version: StrictInt = Field(ge=0)
    index: StrictInt | None = Field(default=None, ge=0, le=5)
    refs: list[list] = Field(default_factory=list, max_length=2)
    rank: StrictInt | None = Field(default=None, ge=1, le=13)
    columns: list[StrictInt] | None = Field(default=None, min_length=2, max_length=2)
    rule: str | None = None
    enabled: bool | None = None
    rules: dict[str, bool] | None = None


class GoogleCredential(BaseModel):
    credential: str = Field(min_length=1, max_length=8192)
    csrf_token: str = Field(min_length=1, max_length=128)


class AccountName(BaseModel):
    unique_name: str = Field(min_length=3, max_length=24)
    csrf_token: str = Field(min_length=1, max_length=128)


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
    invite_times: list = field(default_factory=list)


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
    participants: list = field(default_factory=lambda: [None, None])
    house_rules: bool = False
    house_version: str | None = None
    departed: list = field(default_factory=lambda: [False, False])
    series_mode: str = "wins"
    game_type: str = "1v1"
    patch: str = PATCH_VERSION
    series_complete: bool = False

    @property
    def capacity(self):
        return 30 if self.game_type == "many" else 2

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
        for key, default in (('ready', False), ('wins', 0), ('participants', None), ('departed', False)):
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

    def start_round(self):
        self.resize_seats()
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
        self.round_recorded = False
        self.emotes.clear()

    def record_result(self):
        if self.game is None or self.game.phase != "over" or self.round_recorded:
            return
        scores = [self.game.score(p) for p in range(len(self.seats))]
        self.game._record_scoring_effects()
        leaders = [p for p, score in enumerate(scores) if score == min(scores)]
        winner = leaders[0] if len(leaders) == 1 else None
        self.history.append({"round": len(self.history) + 1, "scores": scores, "winner": winner,
                             "rules": asdict(self.game.rules),
                             "house_rules": self.house_rules, "house_version": self.house_version,
                             "patch": self.patch,
                             "turns": self.game.turns,
                             "ended_at": time.time(),
                             "activations": [sorted(keys) for keys in self.game.activated_rules],
                             "divisors": [self.game.score_divisor(p) for p in range(len(self.seats))]})
        self.last_winner = winner
        self.round_recorded = True
        self.ready = [False] * len(self.seats)
        if self.solo:
            self.ready[1] = True
        if winner is not None:
            self.wins[winner] += 1
        if self.series_mode == 'points' and self.best_of is not None and len(self.history) >= self.best_of:
            leaders = [p for p, points in enumerate(self.points) if points == min(self.points)]
            self.champion = leaders[0] if len(leaders) == 1 else None
            self.status = 'finished'
            self.series_complete = True
        elif self.target is not None and max(self.wins) >= self.target:
            self.champion = self.wins.index(max(self.wins))
            self.status = "finished"
            self.series_complete = True
        else:
            self.status = "round_over"
        if self.history_store:
            self.history_store.save(self)


class Store:
    def __init__(self, history_path=":memory:"):
        self.sessions = {}
        self.rooms = {}
        self.history = MatchHistory(history_path)
        self.accounts = Accounts(self.history)
        self.invitations = {}
        self.queue = {}
        self.queue_offers = {}
        self.queue_results = {}
        self.queue_notices = {}
        self.queue_switching = set()
        self.queue_lock = asyncio.Lock()

    def session(self, token):
        session = self.sessions.get(token)
        if session is None:
            raise HTTPException(401, "Open the home page to create a session.")
        session.touched = time.time()
        return session

    def cleanup(self):
        cutoff = time.time() - 12 * 3600
        for key, room in list(self.rooms.items()):
            if room.touched < cutoff and not any(room.clients.values()):
                if room.bot_task:
                    room.bot_task.cancel()
                room.departed = [True] * len(room.seats)
                room.finish_continuous()
                self.history.save(room, abandoned=True)
                del self.rooms[key]
        for token, session in list(self.sessions.items()):
            if session.touched < time.time() - 24 * 3600:
                del self.sessions[token]


def clean_name(value):
    value = value.strip()
    if not value or any(ord(char) < 32 for char in value):
        raise HTTPException(422, "Please enter a name without control characters.")
    return value


def parse_rules(values):
    values = dict(values)
    legacy = values.pop('queen_swap', False) or values.get('jack_swap', False)
    values.pop('jack_swap', None)
    if legacy:
        values.setdefault('royal_pairs', True)
    if set(values) - set(Rules.__dataclass_fields__):
        raise HTTPException(422, "Unknown rule selection.")
    return Rules(**values)


def card_view(card):
    return {"rank": card.rank, "label": card.label, "suit": card.suit, "points": card.base_points}


def public_room(room):
    return {"id": room.id, "name": room.name, "names": room.names, "status": room.status,
            "best_of": room.best_of, "first": room.first, "rules": asdict(room.rules),
            "players": sum(seat is not None for seat in room.seats), "solo": room.solo,
            "house_rules": room.house_rules, "house_version": room.house_version,
            "series_mode": room.series_mode, "game_type": room.game_type, "capacity": room.capacity,
            "patch": room.patch}


def message(room, viewer):
    game = room.game
    if room.status == "closed":
        return "The other player left. Return to the menu to find a new table."
    if game is None:
        return "The host starts with at least three players." if room.game_type == 'many' else "Waiting for a second player. The game starts when they join."
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
        "drawn": "Swap with a face-up card, Flip a hidden card, or Discard.",
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


def snapshot(room, token):
    if token not in room.seats:
        raise HTTPException(403, "You do not have a seat in this lobby.")
    viewer = room.seats.index(token)
    state = {**public_room(room), "viewer": viewer, "version": room.version,
             "emotes": public_emotes(room),
             "ready": room.ready, "wins": room.wins, "target": room.target,
             "history": room.history, "champion": room.champion,
             "points": room.points,
             "round": len(room.history) + (0 if room.round_recorded else 1),
             "connected": [bool(room.clients.get(seat)) if seat else room.solo and p == 1 for p, seat in enumerate(room.seats)],
             "message": message(room, viewer), "game": None}
    game = room.game
    if game is None:
        return state
    active = room.status == "playing" and game.decision_player == viewer
    opening = room.status == "playing" and game.phase == "setup" and game.visible_count(viewer) < 2
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
        "set_rules": room.solo and not room.house_rules and game.phase == "setup",
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
        "players": [[{"visible": slot.visible, "locked": slot.visible and slot.card in game.locked_cards,
                      "card": card_view(slot.card) if slot.visible else None} for slot in layout] for layout in game.players],
        "draw_count": len(game.draw_pile), "discard": card_view(game.discard_pile[-1]),
        "held": card_view(game.held_card) if game.held_card else None,
        "scores": [game.score(p, game.phase != "over") for p in range(game.player_count)],
        "effect_totals": [game.score(p) if game.phase == "over" else visible_effect_total(
            game.players[p], game.rules, game.gambler_earned[p], poisoned=game.finisher == p,
            opponent_layouts=[game.players[q] for q in game.opponents(p)],
            incoming_angels=sum(game.angel_earned[q] for q in game.opponents(p))) for p in range(game.player_count)],
        "effects": [active_rule_effects(game.players[p], game.rules, game.gambler_earned[p], game.locked_cards,
            poisoned=game.finisher == p, angel_earned=game.angel_earned[p],
            opponent_layouts=[game.players[q] for q in game.opponents(p)],
            incoming_angels=sum(game.angel_earned[q] for q in game.opponents(p))) for p in range(game.player_count)],
        "legal": legal, "last_move": last_move,
        "guess_target": game.guess_pending["target"] if game.phase == "guess" else None,
        "table_refs": game.table_refs() if legal["bonus"] else [],
    }
    return state


def parse_ref(ref):
    if len(ref) != 2:
        raise HTTPException(422, "Invalid card selection.")
    owner, index = ref
    if type(owner) is int and 0 <= owner < 30 and type(index) is int and index in range(6):
        return owner, index
    if owner in ("draw", "discard") and index is None:
        return owner, None
    raise HTTPException(422, "Invalid card selection.")


def apply_move(room, token, move):
    if move.version != room.version:
        raise HTTPException(409, "The table changed. Please try your action again.")
    if token not in room.seats:
        raise HTTPException(403, "You do not have a seat.")
    seat = room.seats.index(token)
    game = room.game
    if move.action == "ready":
        if room.status != "waiting" or seat != 1:
            raise HTTPException(409, "Only the guest can mark ready in a waiting lobby.")
        room.ready[seat] = True
    elif move.action == "start":
        enough = len(room.seats) >= 3 if room.game_type == 'many' else room.seats[1] is not None and room.ready[1]
        if seat != 0 or room.status != "waiting" or not enough:
            raise HTTPException(409, "The host can start when the guest is ready.")
        room.start_round()
    elif move.action == "next_round":
        if room.status != "round_over":
            raise HTTPException(409, "The next game is not available yet.")
        room.ready[seat] = True
        if all(room.ready):
            room.start_round()
    elif move.action == "rematch":
        if seat != 0 or room.status not in ("finished", "round_over"):
            raise HTTPException(409, "Only the host can start a rematch after a game.")
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
            if not room.solo or room.house_rules or seat != 0 or game.phase != "setup":
                raise HTTPException(403, "Lobby rules stay fixed during a match.")
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
    room.record_result()
    room.version += 1
    room.touched = time.time()


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
            yield
        finally:
            tasks = [room.bot_task for room in store.rooms.values() if room.bot_task and not room.bot_task.done()]
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            await bot_workers.close()
            store.history.close()
    app = FastAPI(title="Golf", docs_url=None, redoc_url=None, lifespan=lifespan)
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
        return session

    def session_view(session):
        return {"username": session.username, "room_id": session.room_id if session.room_id in store.rooms else None,
                "account": session.account, "google_client_id": google_client_id,
                "csrf_token": session.csrf_token, "google_nonce": session.google_nonce}

    def csrf(session, token):
        if not secrets.compare_digest(session.csrf_token, token):
            raise HTTPException(403, 'Refresh the page and try again.')

    def profile_for(session):
        try:
            return participant(session.account, session.username)
        except ValueError as error:
            raise HTTPException(409, str(error)) from error

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

        async def send(ws, sockets, state):
            try:
                await asyncio.wait_for(ws.send_json(state), timeout=3)
            except Exception:
                sockets.discard(ws)
        # A slow connection must not delay every other player at a large table.
        await asyncio.gather(*(send(*delivery) for delivery in deliveries))

    def kick_bot(room):
        if room.solo and room.game and room.status == "playing" and room.game.phase != "setup" and room.game.decision_player == 1 and (room.bot_task is None or room.bot_task.done()):
            room.bot_task = asyncio.create_task(bot_loop(room))

    async def bot_loop(room):
        try:
            while True:
                await asyncio.sleep(0.45)
                async with room.lock:
                    game = room.game
                    if room.id not in store.rooms or room.status != "playing" or game.phase == "setup" or game.decision_player != 1:
                        return
                    version = room.version
                    position = public_position(game)
                    position._root_actions = set(legal_actions(game))
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
                    room.record_result()
                    room.version += 1
                    await broadcast(room)
        finally:
            if room.bot_task is asyncio.current_task():
                room.bot_task = None

    @app.get("/health")
    async def health():
        return {"status": "ok"}

    @app.get("/api/session")
    async def get_session(request: Request, response: Response):
        store.cleanup()
        token = request.cookies.get(COOKIE)
        if token not in store.sessions:
            # Keep the anonymous history identity after a restart; never accept arbitrary keys.
            if not token or not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
                token = secrets.token_urlsafe(32)
            store.sessions[token] = Session(token)
        session = store.session(token)
        session.account = store.accounts.from_token(request.cookies.get(ACCOUNT_COOKIE))
        if session.nonce_expires <= time.time():
            session.google_nonce, session.nonce_expires = secrets.token_urlsafe(32), time.time() + 600
        response.set_cookie(COOKIE, token, path=request.scope.get("root_path", "") + "/",
                            httponly=True, samesite="lax", secure=request.url.scheme == "https", max_age=365 * 86400)
        return session_view(session)

    @app.post('/api/auth/google')
    async def google_signin(body: GoogleCredential, request: Request, response: Response):
        session = session_for(request)
        csrf(session, body.csrf_token)
        leave_old(session, 'changing sign-in')
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
        session.nonce_expires = 0
        store.accounts.logout(request.cookies.get(ACCOUNT_COOKIE))
        session.account, login_token = store.accounts.login(subject)
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
        except ValueError as error:
            raise HTTPException(422, str(error)) from error
        return session_view(session)

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

    @app.get("/api/rules")
    async def rules_catalog():
        descriptions = load_rule_help()
        return [{"key": key, "name": name, "title": descriptions[key][0], "description": descriptions[key][1]} for key, name in RULE_OPTIONS]

    @app.get('/api/match-options')
    async def match_options():
        return {'house_rules': house_rules(), 'house_version': HOUSE_VERSION, 'first': 'random', 'patch': PATCH_VERSION}

    @app.get('/api/patch-notes')
    async def patch_notes():
        return {'current': PATCH_VERSION, 'patches': PATCH_NOTES}

    @app.get("/api/history")
    async def match_history(request: Request, offset: int = Query(default=0, ge=0)):
        matches = store.history.for_browser(session_for(request).token, limit=51, offset=offset)
        return {"matches": matches[:50], "next_offset": offset + 50 if len(matches) > 50 else None}

    @app.get("/api/stats")
    async def player_stats(request: Request,
                           player: str | None = Query(default=None, max_length=64),
                           opponent: str | None = Query(default=None, max_length=64),
                           enabled: list[str] = Query(default=[]), disabled: list[str] = Query(default=[]),
                           house_rules: bool = Query(default=True),
                           patch: str | None = Query(default=None, max_length=32)):
        session_for(request)
        known = set(Rules.__dataclass_fields__)
        if (set(enabled) | set(disabled)) - known or set(enabled) & set(disabled):
            raise HTTPException(422, "Choose valid, non-conflicting rule filters.")
        if house_rules and (enabled or disabled):
            raise HTTPException(422, 'Turn off House rules to choose custom rule filters.')
        try:
            return await asyncio.to_thread(lambda: build_stats(store.history.stats_results(), player, opponent, enabled, disabled, house_rules, patch))
        except ValueError as error:
            raise HTTPException(422, str(error)) from error

    @app.get("/api/lobbies")
    async def lobbies():
        store.cleanup()
        return [public_room(room) for room in store.rooms.values() if not room.solo and room.status != "closed"]

    def at_table(session):
        room = store.rooms.get(session.room_id)
        return bool(room and session.token in room.seats and not room.departed[room.seats.index(session.token)])

    def queue_allowed(session):
        room = store.rooms.get(session.room_id)
        return not at_table(session) or bool(room and room.solo)

    def cancel_queue(token, notice=None):
        store.queue.pop(token, None)
        for key, offer in list(store.queue_offers.items()):
            if token in offer['seats']:
                del store.queue_offers[key]
                for other in offer['seats']:
                    store.queue.pop(other, None)
                    if other != token:
                        store.queue_notices[other] = notice or 'Your queue match was cancelled. You can join the queue again.'

    def prune_queue():
        now = time.time()
        for token in list(store.queue):
            player = store.sessions.get(token)
            if token not in store.queue_switching and (not player or player.online_until <= now or not queue_allowed(player)):
                cancel_queue(token)
        for offer in list(store.queue_offers.values()):
            if offer['expires'] <= now and not any(token in store.queue_switching for token in offer['seats']):
                for token in offer['seats']:
                    store.queue_notices[token] = 'The queue offer expired. Join again when you are ready.'
                cancel_queue(offer['seats'][0])
        offered = {token for offer in store.queue_offers.values() for token in offer['seats']}
        waiting = [token for token in store.queue if token not in offered]
        while len(waiting) >= 2:
            first = waiting.pop(0)
            one = store.sessions[first]
            second = next((token for token in waiting if not (
                one.account and store.sessions[token].account and one.account['id'] == store.sessions[token].account['id'])), None)
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

    @app.post('/api/queue/join')
    async def join_queue(body: Join, request: Request):
        session = session_for(request)
        async with store.queue_lock:
            if not queue_allowed(session):
                raise HTTPException(409, 'Leave your multiplayer table before joining the queue.')
            profile_for(session)
            session.username = clean_name(body.username)
            session.online_until = time.time() + 30
            if len(store.queue) >= 500 and session.token not in store.queue:
                raise HTTPException(503, 'The queue is full. Try again shortly.')
            store.queue.setdefault(session.token, time.time())
            store.queue_notices.pop(session.token, None)
            prune_queue()
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
                cancel_queue(session.token, 'Your opponent declined the queue match. Join the queue again to find another.')
                return {'status': 'off'}
            offer['accepted'].add(session.token)
            if len(offer['accepted']) == 2:
                if len(store.rooms) >= 200:
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
                                house_version=HOUSE_VERSION, series_mode='points')
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
            room = store.rooms.get(invitation['room'])
            target = store.sessions.get(invitation['target'])
            if (invitation['expires'] <= time.time() or not room or room.status != 'waiting'
                    or not room.has_open_seat or not target or at_table(target)):
                del store.invitations[key]

    def available_players(session):
        players = {}
        for other in store.sessions.values():
            if (other.token == session.token or other.online_until <= time.time() or at_table(other)
                    or session.account and other.account and session.account['id'] == other.account['id']):
                continue
            identity = ('account', other.account['id']) if other.account else ('guest', other.public_id)
            players[identity] = other
        return list(players.values())

    @app.post('/api/presence')
    async def presence(body: Join, request: Request):
        session = session_for(request)
        if not at_table(session):
            session.username = clean_name(body.username)
        session.online_until = time.time() + 30
        prune_invites()
        prune_queue()
        invitations = []
        for key, item in store.invitations.items():
            if item['target'] == session.token:
                room = store.rooms[item['room']]
                invitations.append({'id': key, 'lobby': public_room(room), 'host': room.names[0]})
        return {
            'available_lobbies': sum(not room.solo and room.has_open_seat
                                     and session.token not in room.seats for room in store.rooms.values()),
            'players': [{'id': other.public_id, 'display_name': other.username,
                         'unique_name': (other.account or {}).get('unique_name')}
                        for other in available_players(session)],
            'invitations': invitations,
            'invited': [store.sessions[item['target']].public_id for item in store.invitations.values()
                        if item['host'] == session.token and item['target'] in store.sessions],
            'queue': queue_view(session),
        }

    @app.post('/api/lobbies/{room_id}/invite')
    async def invite_player(room_id: str, body: InvitePlayer, request: Request):
        session = session_for(request)
        room = find_room(room_id)
        if room.solo or room.seats[0] != session.token or not room.has_open_seat:
            raise HTTPException(403, 'Only the host of an open lobby can invite players.')
        target = next((other for other in available_players(session) if other.public_id == body.player_id), None)
        if not target:
            raise HTTPException(409, 'That player is no longer available.')
        prune_invites()
        for invitation in store.invitations.values():
            if invitation['room'] == room.id and invitation['target'] == target.token:
                return {'sent': True}
        session.invite_times = [stamp for stamp in session.invite_times if stamp > time.time() - 60]
        if len(session.invite_times) >= 10:
            raise HTTPException(429, 'Please wait before sending more invitations.')
        session.invite_times.append(time.time())
        store.invitations[secrets.token_urlsafe(12)] = {
            'host': session.token, 'target': target.token, 'room': room.id, 'expires': time.time() + 90,
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
        result = await take_seat(find_room(invitation['room']), session, body.username)
        prune_invites()
        return result

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
        if len(store.rooms) >= 200:
            raise HTTPException(503, "The server has too many tables. Try again later.")
        session.username = clean_name(settings.username)
        cancel_queue(session.token)
        many = settings.game_type == 'many'
        room = Room(secrets.token_urlsafe(9), clean_name(settings.name), parse_rules(house_rules() if settings.house_rules else settings.rules), settings.best_of, 'random' if settings.house_rules or many else settings.first, False, [session.token] if many else [session.token, None], [session.username] if many else [session.username, "Waiting..."], history_store=store.history,
                    house_rules=settings.house_rules, house_version=HOUSE_VERSION if settings.house_rules else None,
                    series_mode=settings.series_mode, game_type=settings.game_type)
        room.resize_seats()
        room.participants[0] = profile_for(session)
        store.rooms[room.id] = room
        session.room_id = room.id
        return snapshot(room, session.token)

    @app.post("/api/solo")
    async def solo(settings: SoloSettings, request: Request):
        session = session_for(request)
        leave_old(session)
        store.cleanup()
        if len(store.rooms) >= 200:
            raise HTTPException(503, "The server has too many tables.")
        session.username = clean_name(settings.username)
        if settings.game_type != '1v1':
            raise HTTPException(422, 'Solo games use 1v1 mode.')
        room = Room(secrets.token_urlsafe(9), "Solo table", parse_rules(house_rules() if settings.house_rules else settings.rules), settings.best_of, 'random' if settings.house_rules else settings.first, True, [session.token, None], [session.username, "Golfbot"], history_store=store.history,
                    house_rules=settings.house_rules, house_version=HOUSE_VERSION if settings.house_rules else None,
                    series_mode=settings.series_mode)
        room.participants = [profile_for(session), {'id': 'bot:golfbot', 'kind': 'bot', 'display_name': 'Golfbot'}]
        room.start_round()
        store.rooms[room.id] = room
        session.room_id = room.id
        return snapshot(room, session.token)

    @app.get("/api/lobbies/{room_id}")
    async def lobby_info(room_id: str):
        return public_room(find_room(room_id))

    @app.post("/api/lobbies/{room_id}/join")
    async def join_lobby(room_id: str, body: Join, request: Request):
        session = session_for(request)
        room = find_room(room_id)
        return await take_seat(room, session, body.username)

    async def take_seat(room, session, username):
        async with room.lock:
            if session.token in room.seats:
                return snapshot(room, session.token)
            leave_old(session)
            if room.solo or not room.has_open_seat:
                raise HTTPException(409, "This lobby is full or already playing.")
            session.username = clean_name(username)
            profile = profile_for(session)
            if room.game_type == 'many':
                room.seats.append(session.token)
                room.names.append(session.username)
                room.resize_seats()
                seat = len(room.seats) - 1
            else:
                seat = 1
            room.seats[seat], room.names[seat] = session.token, session.username
            room.participants[seat] = profile
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
            kick_bot(room)
            return snapshot(room, session.token)

    @app.post("/api/lobbies/{room_id}/emote")
    async def send_emote(room_id: str, body: Emote, request: Request):
        session = session_for(request)
        room = find_room(room_id)
        async with room.lock:
            if session.token not in room.seats:
                raise HTTPException(403, "You do not have a seat in this lobby.")
            if room.game is None or room.status not in ("playing", "round_over", "finished"):
                raise HTTPException(409, "Emotes are available at the game table.")
            player = room.seats.index(session.token)
            room.emote_sequence += 1
            room.emotes[player] = {"id": body.emote, "player": player, "sequence": room.emote_sequence,
                                   "expires_at": time.time() + EMOTE_SECONDS}
            # Cosmetic events must not invalidate a simultaneous card action.
            await broadcast(room)
            return snapshot(room, session.token)

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
            if store.queue_results.get(session.token) == room.id:
                store.queue_results.pop(session.token, None)
            if room.status == "waiting" and seat != 0:
                if room.game_type == 'many':
                    for key in ('seats', 'names', 'ready', 'wins', 'participants', 'departed'):
                        getattr(room, key).pop(seat)
                else:
                    room.seats[1], room.names[1], room.ready[1] = None, "Waiting...", False
                    room.participants[1] = None
            else:
                room.status = "closed"
                room.departed[seat] = True
                if room.solo:
                    room.departed[1] = True
                room.finish_continuous()
                store.history.save(room, abandoned=True)
                if room.bot_task:
                    room.bot_task.cancel()
            room.version += 1
            await broadcast(room)
            return {"left": True}

    @app.websocket("/ws/{room_id}")
    async def websocket(ws: WebSocket, room_id: str):
        origin = ws.headers.get("origin")
        if origin and urlparse(origin).netloc != ws.headers.get("host"):
            await ws.close(code=4403)
            return
        token = ws.cookies.get(COOKIE)
        room = store.rooms.get(room_id)
        if token not in store.sessions or room is None or token not in room.seats:
            await ws.close(code=4403)
            return
        await ws.accept()
        room.clients.setdefault(token, set()).add(ws)
        try:
            kick_bot(room)
            await broadcast(room)
            while True:
                await ws.receive_text()
                if token not in room.seats:
                    await ws.close(code=4403)
                    return
                store.session(token)
                room.touched = time.time()
                await ws.send_json(snapshot(room, token))
        except WebSocketDisconnect:
            pass
        finally:
            room.clients.get(token, set()).discard(ws)
            await broadcast(room)

    app.mount("/static", StaticFiles(directory=ROOT / "web"), name="static")

    def page_response(filename, request):
        base = request.scope.get("root_path", "").rstrip("/") + "/"
        html = (ROOT / "web" / filename).read_text(encoding="utf-8").replace("__GOLF_BASE__", base)
        for asset in ("app.js", "style.css"):
            version = sha256((ROOT / "web" / asset).read_bytes()).hexdigest()[:16]
            html = html.replace(f'"static/{asset}"', f'"static/{asset}?v={version}"')
        return HTMLResponse(html, headers={"Cache-Control": "no-store"})

    @app.get('/privacy')
    async def privacy(request: Request):
        return page_response('privacy.html', request)

    @app.get("/")
    @app.get("/history")
    @app.get("/stats")
    @app.get("/patch-notes")
    @app.get("/account")
    @app.get("/lobby/{room_id}")
    async def index(request: Request):
        # A cached script from an earlier release can leave new buttons inert.
        # Content versions also work when files change without restarting Uvicorn.
        return page_response('index.html', request)

    # Serve the same store at the public subpath and at localhost's existing URLs.
    # Only the outer app runs the lifespan; mounted app lifespans are not invoked.
    host = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    host.state.store = store

    @host.get("/Golfgame")
    async def canonical_game_url(request: Request):
        return RedirectResponse(str(request.url.replace(path="/Golfgame/")), status_code=308)

    host.mount("/Golfgame", app)
    host.mount("/", app)
    return host


app = create_app(Store(os.environ.get("GOLFBOT_HISTORY_DB", ROOT / "data" / "matches.sqlite3")))
