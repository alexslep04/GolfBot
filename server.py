"""Single-process, server-authoritative Golf lobbies served by FastAPI/Uvicorn."""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass, field
from pathlib import Path
import os
import re
import secrets
import time
from urllib.parse import urlparse
from typing import Literal

from fastapi import FastAPI, HTTPException, Query, Request, Response, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, ConfigDict, Field, StrictInt

from game import GolfGame, Rules, RULE_OPTIONS
from rule_help import load_rule_help
from match_history import MatchHistory
from scoring import active_rule_effects, visible_effect_total

ROOT = Path(__file__).parent
COOKIE = "golf_session"
START_POLICIES = ("host", "guest", "alternate", "random", "winner", "loser")
EMOTE_SECONDS = 4
EMOTE_COOLDOWN = 0.8


class Emote(BaseModel):
    model_config = ConfigDict(extra="forbid")
    emote: Literal["unamused", "shocked", "laughing", "nervous"]


class Settings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    username: str = Field(default="Player", min_length=1, max_length=32)
    name: str = Field(default="Friendly Golf", min_length=1, max_length=48)
    best_of: StrictInt = Field(default=3, ge=1, le=9)
    first: Literal["host", "guest", "alternate", "random", "winner", "loser"] = "alternate"
    rules: dict[str, bool] = Field(default_factory=dict)


class Join(BaseModel):
    username: str = Field(min_length=1, max_length=32)


class Move(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["flip", "draw", "swap", "discard", "end_turn", "guess", "arrange", "set_rule", "ready", "start", "next_round", "rematch"]
    version: StrictInt = Field(ge=0)
    index: StrictInt | None = Field(default=None, ge=0, le=5)
    refs: list[list] = Field(default_factory=list, max_length=2)
    rank: StrictInt | None = Field(default=None, ge=1, le=13)
    columns: list[StrictInt] | None = Field(default=None, min_length=2, max_length=2)
    rule: str | None = None
    enabled: bool | None = None


@dataclass
class Session:
    token: str
    username: str = "Player"
    room_id: str | None = None
    touched: float = field(default_factory=time.time)


@dataclass
class Room:
    id: str
    name: str
    rules: Rules
    best_of: int
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
    last_emote: dict = field(default_factory=dict)

    @property
    def target(self):
        return self.best_of // 2 + 1

    def start_round(self):
        round_index = len(self.history)
        first = (0 if self.first == "host" else 1 if self.first == "guest" else
                 secrets.randbelow(2) if self.first == "random" else
                 self.last_winner if self.first == "winner" and self.last_winner is not None else
                 1 - self.last_winner if self.first == "loser" and self.last_winner is not None else
                 round_index % 2)
        self.game = GolfGame(rules=self.rules, multiplayer=not self.solo, first_player=first)
        self.status = "playing"
        self.ready = [False, self.solo]
        self.round_recorded = False
        self.emotes.clear()

    def record_result(self):
        if self.game is None or self.game.phase != "over" or self.round_recorded:
            return
        scores = [self.game.score(p) for p in (0, 1)]
        winner = None if scores[0] == scores[1] else 0 if scores[0] < scores[1] else 1
        self.history.append({"round": len(self.history) + 1, "scores": scores, "winner": winner})
        self.last_winner = winner
        self.round_recorded = True
        self.ready = [False, self.solo]
        if winner is not None:
            self.wins[winner] += 1
        if max(self.wins) >= self.target:
            self.champion = self.wins.index(max(self.wins))
            self.status = "finished"
        else:
            self.status = "round_over"
        if self.history_store:
            self.history_store.save(self)


class Store:
    def __init__(self, history_path=":memory:"):
        self.sessions = {}
        self.rooms = {}
        self.history = MatchHistory(history_path)

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
    if set(values) - set(Rules.__dataclass_fields__):
        raise HTTPException(422, "Unknown rule selection.")
    return Rules(**values)


def card_view(card):
    return {"rank": card.rank, "label": card.label, "suit": card.suit, "points": card.base_points}


def public_room(room):
    return {"id": room.id, "name": room.name, "names": room.names, "status": room.status,
            "best_of": room.best_of, "first": room.first, "rules": asdict(room.rules),
            "players": sum(seat is not None for seat in room.seats), "solo": room.solo}


def message(room, viewer):
    game = room.game
    if room.status == "closed":
        return "The other player left. Return to the menu to find a new table."
    if game is None:
        return "Waiting for a second player." if room.seats[1] is None else "Mark ready; the host can then start."
    if game.phase == "over":
        result = room.history[-1]
        return "Round drawn." if result["winner"] is None else f"{room.names[result['winner']]} wins this round."
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
        "set_rules": room.solo and game.phase == "setup",
    }
    last_move = game.last_move
    if last_move.startswith("You "):
        last_move = room.names[0] + last_move[3:]
    elif last_move.startswith("Opponent "):
        last_move = room.names[1] + last_move[8:]
    state["game"] = {
        "phase": game.phase, "current": game.current, "decision_player": game.decision_player,
        "first_player": game.first_player, "final_turn": game.is_final_turn, "ending": game.finisher is not None,
        "players": [[{"visible": slot.visible, "locked": slot.visible and slot.card in game.locked_cards,
                      "card": card_view(slot.card) if slot.visible else None} for slot in layout] for layout in game.players],
        "draw_count": len(game.draw_pile), "discard": card_view(game.discard_pile[-1]),
        "held": card_view(game.held_card) if game.held_card else None,
        "scores": [game.score(p, game.phase != "over") for p in (0, 1)],
        "effect_totals": [game.score(p) if game.phase == "over" else visible_effect_total(game.players[p], game.rules, game.gambler_earned[p], game.players[1 - p], game.finisher == p) for p in (0, 1)],
        "effects": [active_rule_effects(game.players[p], game.rules, game.gambler_earned[p], game.locked_cards, game.players[1 - p], game.finisher == p) for p in (0, 1)],
        "legal": legal, "last_move": last_move,
        "guess_target": game.guess_pending["target"] if game.phase == "guess" else None,
        "table_refs": game.table_refs() if legal["bonus"] else [],
    }
    return state


def parse_ref(ref):
    if len(ref) != 2:
        raise HTTPException(422, "Invalid card selection.")
    owner, index = ref
    if type(owner) is int and owner in (0, 1) and type(index) is int and index in range(6):
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
        if seat != 0 or room.status != "waiting" or room.seats[1] is None or not room.ready[1]:
            raise HTTPException(409, "The host can start when the guest is ready.")
        room.start_round()
    elif move.action == "next_round":
        if room.status != "round_over":
            raise HTTPException(409, "The next round is not available yet.")
        room.ready[seat] = True
        if all(room.ready):
            room.start_round()
    elif move.action == "rematch":
        if seat != 0 or room.status not in ("finished", "round_over"):
            raise HTTPException(409, "Only the host can start a rematch after a round.")
        room.wins, room.history, room.champion, room.last_winner = [0, 0], [], None, None
        room.match_id, room.started_at = secrets.token_urlsafe(12), time.time()
        room.game, room.round_recorded = None, False
        room.ready, room.status = [False, room.solo], "waiting"
        if room.solo:
            room.start_round()
    else:
        if game is None or room.status != "playing":
            raise HTTPException(409, "This table is not playing a round.")
        if move.action == "flip" and game.phase == "setup":
            game.opening_reveal(seat, move.index)
        elif move.action == "set_rule":
            if not room.solo or seat != 0 or game.phase != "setup" or move.enabled is None:
                raise HTTPException(403, "Lobby rules stay fixed during a match.")
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


def create_app(store=None):
    store = store or Store()
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
            store.history.close()
    app = FastAPI(title="GolfBot", docs_url=None, redoc_url=None, lifespan=lifespan)
    app.state.store = store

    @app.middleware("http")
    async def same_origin(request, call_next):
        origin = request.headers.get("origin")
        if request.method in ("POST", "DELETE", "PATCH") and origin and urlparse(origin).netloc != request.headers.get("host"):
            return Response("Cross-origin changes are not allowed.", status_code=403)
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "same-origin"
        if request.url.path.startswith("/api"):
            response.headers["Cache-Control"] = "no-store"
        return response

    def session_for(request):
        return store.session(request.cookies.get(COOKIE))

    def find_room(room_id):
        room = store.rooms.get(room_id)
        if room is None:
            raise HTTPException(404, "That lobby is no longer available.")
        return room

    async def broadcast(room):
        for token, sockets in list(room.clients.items()):
            for ws in list(sockets):
                try:
                    await asyncio.wait_for(ws.send_json(snapshot(room, token)), timeout=3)
                except Exception:
                    sockets.discard(ws)

    def kick_bot(room):
        if room.solo and room.game and room.status == "playing" and room.game.phase != "setup" and room.game.decision_player == 1 and (room.bot_task is None or room.bot_task.done()):
            room.bot_task = asyncio.create_task(bot_loop(room))

    async def bot_loop(room):
        try:
            for _ in range(120):
                await asyncio.sleep(0.45)
                async with room.lock:
                    game = room.game
                    if room.id not in store.rooms or room.status != "playing" or game.phase == "setup" or game.decision_player != 1:
                        return
                    game._opponent_step()
                    room.record_result()
                    room.version += 1
                    await broadcast(room)
        finally:
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
        response.set_cookie(COOKIE, token, httponly=True, samesite="lax", secure=request.url.scheme == "https", max_age=365 * 86400)
        return {"username": session.username, "room_id": session.room_id if session.room_id in store.rooms else None}

    @app.get("/api/rules")
    async def rules_catalog():
        descriptions = load_rule_help()
        return [{"key": key, "name": name, "title": descriptions[key][0], "description": descriptions[key][1]} for key, name in RULE_OPTIONS]

    @app.get("/api/history")
    async def match_history(request: Request, offset: int = Query(default=0, ge=0)):
        matches = store.history.for_browser(session_for(request).token, limit=51, offset=offset)
        return {"matches": matches[:50], "next_offset": offset + 50 if len(matches) > 50 else None}

    @app.get("/api/lobbies")
    async def lobbies():
        store.cleanup()
        return [public_room(room) for room in store.rooms.values() if not room.solo and room.status != "closed"]

    def leave_old(session):
        old = store.rooms.get(session.room_id)
        if old and session.token in old.seats:
            raise HTTPException(409, "Leave your current table before creating or joining another.")

    @app.post("/api/lobbies")
    async def host(settings: Settings, request: Request):
        session = session_for(request)
        leave_old(session)
        store.cleanup()
        if len(store.rooms) >= 200:
            raise HTTPException(503, "The server has too many tables. Try again later.")
        if settings.best_of % 2 == 0:
            raise HTTPException(422, "Best of must be an odd number.")
        session.username = clean_name(settings.username)
        room = Room(secrets.token_urlsafe(9), clean_name(settings.name), parse_rules(settings.rules), settings.best_of, settings.first, False, [session.token, None], [session.username, "Waiting..."], history_store=store.history)
        store.rooms[room.id] = room
        session.room_id = room.id
        return snapshot(room, session.token)

    @app.post("/api/solo")
    async def solo(settings: Settings, request: Request):
        session = session_for(request)
        leave_old(session)
        store.cleanup()
        if len(store.rooms) >= 200:
            raise HTTPException(503, "The server has too many tables.")
        session.username = clean_name(settings.username)
        room = Room(secrets.token_urlsafe(9), "Solo table", parse_rules(settings.rules), 1, "host", True, [session.token, None], [session.username, "GolfBot"], history_store=store.history)
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
        async with room.lock:
            if session.token in room.seats:
                return snapshot(room, session.token)
            leave_old(session)
            if room.solo or room.status != "waiting" or room.seats[1] is not None:
                raise HTTPException(409, "This lobby is full or already playing.")
            session.username = clean_name(body.username)
            room.seats[1], room.names[1] = session.token, session.username
            session.room_id = room.id
            room.version += 1
            room.touched = time.time()
            await broadcast(room)
            return snapshot(room, session.token)

    @app.get("/api/lobbies/{room_id}/state")
    async def state(room_id: str, request: Request):
        session = session_for(request)
        return snapshot(find_room(room_id), session.token)

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
            if time.monotonic() - room.last_emote.get(player, float('-inf')) < EMOTE_COOLDOWN:
                raise HTTPException(429, "Wait a moment before sending another emote.")
            room.last_emote[player] = time.monotonic()
            room.emote_sequence += 1
            room.emotes[player] = {"id": body.emote, "player": player, "sequence": room.emote_sequence,
                                   "expires_at": time.time() + EMOTE_SECONDS}
            # Cosmetic events must not invalidate a simultaneous card action.
            await broadcast(room)
            return snapshot(room, session.token)

    @app.post("/api/lobbies/{room_id}/leave")
    async def leave(room_id: str, request: Request):
        session = session_for(request)
        room = find_room(room_id)
        async with room.lock:
            if session.token not in room.seats:
                raise HTTPException(403, "You are not at this table.")
            seat = room.seats.index(session.token)
            session.room_id = None
            if room.status == "waiting" and seat == 1:
                room.seats[1], room.names[1], room.ready[1] = None, "Waiting...", False
            else:
                room.status = "closed"
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

    @app.get("/")
    @app.get("/history")
    @app.get("/lobby/{room_id}")
    async def index():
        return FileResponse(ROOT / "web" / "index.html")

    return app


app = create_app(Store(os.environ.get("GOLFBOT_HISTORY_DB", ROOT / "data" / "matches.sqlite3")))
