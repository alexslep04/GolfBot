"use strict";
const root = document.getElementById("app");
const connection = document.getElementById("connection");
let catalog = [],
  session = null,
  state = null,
  selected = [],
  socket = null,
  heartbeat = null,
  retry = null,
  busy = false,
  page = "home",
  toastTimer;
const suit = { S: "♠", H: "♥", D: "♦", C: "♣" };
const emoteNames = {
  unamused: "Unamused",
  shocked: "Shocked",
  laughing: "Laughing",
  nervous: "Nervous",
};
let activeEmotes = {},
  emoteSeen = {},
  emoteTimers = {},
  emoteTable = "",
  emoteRound = null,
  controlsMode = "actions";
let opponentEmotesMuted = false;
try {
  opponentEmotesMuted = localStorage.getItem("golf-mute-emotes") === "true";
} catch {}
function clearEmotes() {
  Object.values(emoteTimers).forEach(clearTimeout);
  activeEmotes = {};
  emoteSeen = {};
  emoteTimers = {};
}
function syncEmotes(next) {
  if (emoteTable !== next.id || emoteRound !== next.round) {
    clearEmotes();
    emoteTable = next.id;
    emoteRound = next.round;
    controlsMode = "actions";
  }
  for (const item of next.emotes || []) {
    if (!emoteNames[item.id] || item.sequence <= (emoteSeen[item.player] || 0))
      continue;
    emoteSeen[item.player] = item.sequence;
    clearTimeout(emoteTimers[item.player]);
    if (opponentEmotesMuted && item.player !== next.viewer) {
      delete activeEmotes[item.player];
      continue;
    }
    const remaining = Math.max(0, Math.min(4000, item.remaining_ms));
    activeEmotes[item.player] = { ...item, ends: Date.now() + remaining };
    emoteTimers[item.player] = setTimeout(() => {
      if (activeEmotes[item.player]?.sequence !== item.sequence) return;
      delete activeEmotes[item.player];
      document
        .querySelectorAll(`[data-emote-player='${item.player}']`)
        .forEach((element) => element.remove());
    }, remaining);
  }
}
function playerEmote(player) {
  if (opponentEmotesMuted && player !== state.viewer) return "";
  const item = activeEmotes[player];
  if (!item || item.ends <= Date.now()) return "";
  const age = Math.max(0, 4000 - (item.ends - Date.now()));
  return `<div class='player-emote' data-emote-player='${player}' role='status' style='animation-delay:-${age}ms'><img src='/static/emotes/${item.id}.png' alt='${e(state.names[player])}: ${emoteNames[item.id]} emote'><span>${e(state.names[player])}</span></div>`;
}
function quickEmotes() {
  return `<div class='emote-buttons' aria-label='Quick emotes'>${Object.entries(
    emoteNames,
  )
    .map(
      ([id, label]) =>
        `<button type='button' class='emote-button' data-emote='${id}' title='${label}' aria-label='Send ${label.toLowerCase()} emote' ${state.status === "closed" ? "disabled" : ""}><img src='/static/emotes/${id}.png' alt=''></button>`,
    )
    .join("")}</div>`;
}
async function sendEmote(id) {
  if (!state?.game) return;
  try {
    accept(await api(`/api/lobbies/${state.id}/emote`, "POST", { emote: id }));
  } catch (error) {
    toast(error.message);
  }
}
const starter = {
  host: "Host first",
  guest: "Guest first",
  alternate: "Alternate each round",
  random: "Random each round",
  winner: "Previous winner first",
  loser: "Previous loser first",
};
const e = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let historyEntries = [],
  historyOffset = null,
  historyRequest = 0;
function markTab(historyActive) {
  document
    .getElementById("history-tab")
    .setAttribute("aria-current", historyActive ? "page" : "false");
  document
    .getElementById("play-tab")
    .setAttribute("aria-current", historyActive ? "false" : "page");
}
async function historyPage(more = false) {
  const request = ++historyRequest;
  page = "history";
  markTab(true);
  document.title = "Match history · GolfBot";
  history.replaceState({}, "", "/history");
  if (!more) {
    historyEntries = [];
    root.innerHTML = `<div class='loading'>Loading match history…</div>`;
  }
  try {
    const result = await api(
      "/api/history?offset=" + (more ? historyOffset : 0),
    );
    if (page !== "history" || request !== historyRequest) return;
    if (!socket) {
      connection.textContent = "Saved results";
      connection.className = "connection";
    }
    historyEntries.push(...result.matches);
    historyOffset = result.next_offset;
    root.innerHTML = `<section class='history-page'><div class='page-heading'><h1>Match history</h1><button class='button secondary' data-nav='history'>Refresh</button></div><p class='hint'>Your multiplayer games and best-of series. Points are summed per player; series winners are decided by round wins.</p><p class='hint'>${session.room_id ? `Your table is still open. Use Play to return without leaving.` : `History is saved for this browser on this site address.`}</p>${
      historyEntries
        .map((match) => {
          const winner =
            match.winner === null
              ? "No overall winner"
              : match.names[match.winner];
          const status =
            {
              finished: "Completed",
              in_progress: "In progress",
              abandoned: "Abandoned",
              interrupted: "Interrupted by server restart",
            }[match.status] || match.status;
          return `<article class='panel match-record'><div class='record-heading'><div><h2>${e(match.lobby_name)}</h2><p class='hint'>${e(new Date(match.started_at * 1000).toLocaleString())} · ${match.solo ? "Solo" : `Best of ${match.best_of}`} · ${e(status)}</p></div><span class='pill'>${match.wins[0]} : ${match.wins[1]} wins</span></div><p class='record-winner'>Overall winner: ${e(winner)}</p><div class='score-table-wrap'><table class='score-table'><thead><tr><th scope='col'>Game</th><th scope='col'>${e(match.names[0])}${match.viewer === 0 ? " · You" : ""}</th><th scope='col'>${e(match.names[1])}${match.viewer === 1 ? " · You" : ""}</th><th scope='col'>Winner</th></tr></thead><tbody>${match.rounds.map((round) => `<tr><th scope='row'>${round.round}</th><td>${round.scores[0]}</td><td>${round.scores[1]}</td><td>${round.winner === null ? "Draw" : e(match.names[round.winner])}</td></tr>`).join("")}</tbody><tfoot><tr><th scope='row'>Total points</th><td>${match.points[0]}</td><td>${match.points[1]}</td><td>Combined: ${match.points[0] + match.points[1]}</td></tr></tfoot></table></div></article>`;
        })
        .join("") ||
      `<div class='empty'>No multiplayer games yet. Finish a round in a lobby to record its score here.</div>`
    }${historyOffset !== null ? `<button class='button secondary' data-history-more>Load older matches</button>` : ""}</section>`;
  } catch (error) {
    if (page === "history" && request === historyRequest)
      root.innerHTML = `<div class='empty'>${e(error.message)}<p><button class='button secondary' data-nav='history'>Try again</button></p></div>`;
  }
}
function name() {
  return (
    document.getElementById("username")?.value.trim() ||
    session?.username ||
    "Player"
  );
}
function saveName(value) {
  try {
    localStorage.setItem("golf-name", value);
  } catch {}
  session.username = value;
}
function toast(text) {
  const el = document.getElementById("toast");
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4200);
}
async function api(url, method = "GET", body) {
  const response = await fetch(url, {
    method,
    credentials: "same-origin",
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  try {
    data = await response.json();
  } catch {
    data = { detail: "The server could not complete the request." };
  }
  if (!response.ok) {
    const msg =
      typeof data.detail === "string"
        ? data.detail
        : "Check the form fields and try again.";
    const error = new Error(msg);
    error.status = response.status;
    throw error;
  }
  return data;
}
function help(rule) {
  return `<span class='help' tabindex='0' aria-label='Explain ${e(rule.name)}'>?<span class='tip' role='tooltip'>${e(rule.description)}</span></span>`;
}
function rulesHtml(
  values = {},
  editable = false,
  type = "config",
  onlyActive = false,
) {
  const rules = onlyActive ? catalog.filter((r) => values[r.key]) : catalog;
  return `<div class='rules-grid'>${rules.map((r) => `<div class='rule ${values[r.key] ? "active" : ""}'><label><input type='checkbox' name='rule-${e(r.key)}' data-rule='${e(r.key)}' data-rule-type='${type}' ${values[r.key] ? "checked" : ""} ${editable ? "" : "disabled"}><span>${e(r.name)}</span></label>${help(r)}</div>`).join("") || `<p class='hint'>Base scoring only. No optional rules.</p>`}</div>`;
}
function back(label = "Back to menu") {
  return `<button class='button secondary' data-nav='home'>${label}</button>`;
}
function home() {
  clearEmotes();
  emoteTable = "";
  page = "home";
  markTab(false);
  document.title = "GolfBot · Your table";
  state = null;
  closeSocket();
  history.replaceState({}, "", "/");
  root.innerHTML = `<section class='hero'><div class='eyebrow'>The card game, at your table</div><h1>Pick your table.</h1><p>Six cards, a little memory, and a good time to finish.<br>Play together or take on the bot.</p></section><div class='menu'><button class='menu-card' data-nav='join'><span class='symbol'>♧</span><span class='arrow'>↗</span><strong>Join lobby</strong><p>Find a table and meet your opponent.</p></button><button class='menu-card' data-nav='host'><span class='symbol'>♔</span><span class='arrow'>↗</span><strong>Host lobby</strong><p>Your name. Your rules. Your match.</p></button><button class='menu-card' data-nav='solo'><span class='symbol'>♠</span><span class='arrow'>↗</span><strong>Play solo</strong><p>The same Golf game, against GolfBot.</p></button></div><div class='profile'><label class='field'><span>Your name</span><input id='username' maxlength='32' value='${e(session.username)}' autocomplete='nickname'></label>${session.room_id ? `<button class='button secondary resume' data-nav='resume'>Resume your table</button>` : ""}</div>`;
  connection.textContent = "Ready to play";
  connection.className = "connection";
}
async function abandonExisting() {
  if (session.room_id) {
    await api(`/api/lobbies/${session.room_id}/leave`, "POST");
    session.room_id = null;
  }
  closeSocket();
}
function hostForm() {
  saveName(name());
  page = "host";
  root.innerHTML = `<div class='form-wrap'><div class='page-heading'><h1>Host a lobby</h1>${back()}</div><form id='host-form' class='panel'><div class='form-grid'><div><label class='field'><span>Your username</span><input id='username' name='username' maxlength='32' required value='${e(session.username)}' autocomplete='nickname'></label><label class='field'><span>Lobby name</span><input name='name' maxlength='48' required value='Friendly Golf'></label><label class='field'><span>Match length</span><select name='best_of'>${[1, 3, 5, 7, 9].map((n) => `<option value='${n}' ${n === 3 ? "selected" : ""}>Best of ${n} · first to ${Math.floor(n / 2) + 1} wins</option>`).join("")}</select></label><label class='field'><span>Who goes first?</span><select name='first'>${Object.entries(
    starter,
  )
    .map(
      ([key, label]) =>
        `<option value='${key}' ${key === "alternate" ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select></label><p class='hint'>Alternate starts with the host. Drawn rounds are replayed; they do not count as wins.</p></div><div><h3>Rules in play</h3><p class='hint'>Both players use the same rules. Hover over ? for details.</p>${rulesHtml({}, true)}</div></div><div class='button-row'><button class='button gold' type='submit'>Create lobby</button></div></form></div>`;
}
async function joinList() {
  page = "join";
  saveName(name());
  const lobbies = await api("/api/lobbies");
  root.innerHTML = `<div class='form-wrap'><div class='page-heading'><h1>Join a lobby</h1><div class='button-row' style='margin:0'><button class='button secondary' data-nav='join'>Refresh</button>${back()}</div></div><label class='field'><span>Your username</span><input id='username' maxlength='32' value='${e(session.username)}' autocomplete='nickname'></label><div class='lobby-list'>${lobbies.map((l) => `<div class='lobby-item'><div><strong>${e(l.name)}</strong><p>${e(l.names[0])} · ${l.players}/2 players · best of ${l.best_of} · ${e(l.status.replace("_", " "))}</p></div><button class='button ${l.players === 1 && l.status === "waiting" ? "" : "secondary"}' data-lobby='${e(l.id)}'>View lobby</button></div>`).join("") || `<div class='empty'>No lobbies yet. Host a table and invite a friend.</div>`}</div></div>`;
}
async function publicLobby(id) {
  saveName(name());
  const info = await api(`/api/lobbies/${id}`);
  if (session.room_id === id) {
    await resume(id);
    return;
  }
  page = "public";
  history.replaceState({}, "", `/lobby/${id}`);
  root.innerHTML = `<div class='waiting'><div class='page-heading'><h1>${e(info.name)}</h1>${back()}</div><div class='panel'><div class='waiting-meta'><span>Hosted by ${e(info.names[0])}</span><span>Best of ${info.best_of}</span><span>${e(starter[info.first])}</span></div><h3>Rules in play</h3>${rulesHtml(info.rules, false, "config", true)}<div class='button-row'><label class='field' style='margin:0;flex:1'><span>Your username</span><input id='username' maxlength='32' value='${e(session.username)}' autocomplete='nickname'></label><button class='button gold' data-join='${e(id)}' ${info.players >= 2 || info.status !== "waiting" ? "disabled" : ""}>Join this lobby</button></div>${info.players >= 2 || info.status !== "waiting" ? `<p class='hint'>This table is full or already playing.</p>` : ""}</div></div>`;
}
function closeSocket() {
  clearInterval(heartbeat);
  clearTimeout(retry);
  const previous = socket;
  socket = null;
  if (previous) previous.close();
}
function connectRoom(id) {
  closeSocket();
  const ws = new WebSocket(
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/${id}`,
  );
  socket = ws;
  connection.textContent = "Connecting";
  connection.className = "connection";
  ws.onopen = () => {
    if (socket !== ws) return;
    connection.textContent = "Live table";
    connection.className = "connection live";
    heartbeat = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send("ping");
    }, 20000);
  };
  ws.onmessage = (event) => {
    if (socket === ws) accept(JSON.parse(event.data));
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    clearInterval(heartbeat);
    connection.textContent = "Reconnecting…";
    connection.className = "connection";
    retry = setTimeout(() => {
      if (session.room_id === id) connectRoom(id);
    }, 1800);
  };
}
function accept(next) {
  if (state && state.id === next.id && next.version < state.version) return;
  syncEmotes(next);
  const changed =
    state?.game?.phase !== next.game?.phase ||
    state?.game?.decision_player !== next.game?.decision_player;
  state = next;
  session.room_id = next.id;
  if (page === "history") return;
  page = "room";
  markTab(false);
  if (changed) selected = [];
  renderRoom();
}
function enterRoom(next) {
  page = "room";
  history.pushState({}, "", `/lobby/${next.id}`);
  selected = [];
  accept(next);
  connectRoom(next.id);
}
async function resume(id = session.room_id) {
  if (!id) return home();
  enterRoom(await api(`/api/lobbies/${id}/state`));
}
function shareHtml() {
  const url = `${location.origin}/lobby/${state.id}`;
  return `<div class='share'><input readonly aria-label='Lobby invite link' value='${e(url)}'><button class='button secondary' data-copy='${e(url)}'>Copy link</button></div>`;
}
function waitingRoom() {
  const viewer = state.viewer;
  root.innerHTML = `<div class='waiting'><div class='page-heading'><h1>${e(state.name)}</h1><button class='button secondary' data-leave>Leave lobby</button></div><div class='panel'><div class='eyebrow'>Invite a friend to the table</div>${shareHtml()}<div class='waiting-meta'><span>Best of ${state.best_of} · first to ${state.target}</span><span>${e(starter[state.first])}</span></div><div class='players-row'>${state.names.map((n, i) => `<div class='seat'><span class='pill'>${i === 0 ? "Host" : "Guest"}</span><strong>${e(n)}</strong><span class='hint'>${state.connected[i] ? "Connected" : i === 1 && state.players < 2 ? "Seat open" : "Offline"}${state.ready[i] ? " · Ready" : ""}${i === viewer ? " · You" : ""}</span></div>`).join("")}</div><h3>Rules in play</h3>${rulesHtml(state.rules, false, "config", true)}<p class='hint'>Waiting for a guest. The game starts automatically when they join.</p></div></div>`;
}
function selectedRef(ref) {
  return selected.some((r) => same(r, ref));
}
function hasRef(list, ref) {
  return list.some((r) => same(r, ref));
}
function cardHtml(card, visible, ref, label, eligible = false, locked = false) {
  const red = card && ["H", "D"].includes(card.suit);
  return `<button class='card ${visible ? "face" : "back"} ${red ? "red" : ""} ${selectedRef(ref) ? "selected" : ""} ${eligible ? "eligible" : ""} ${locked ? "locked" : ""}' data-ref='${e(JSON.stringify(ref))}' aria-label='${e(label)}'>${visible ? `<span class='rank'>${e(card.label)}</span><span class='suit'>${suit[card.suit]}</span><span class='corner'>${e(card.label)}${suit[card.suit]}</span>` : `<span class='monogram'>G</span>`}</button>`;
}
function handHtml(player) {
  const g = state.game;
  const own = player === state.viewer;
  const legal = g.legal;
  const trade = legal.trade.flat();
  return `<section class='hand ${own ? "your-hand" : "opponent-hand"}'><div class='hand-heading'><span>${e(state.names[player])}${own ? " · You" : ""}</span><small>${g.phase === "over" ? `Score: ${g.scores[player]}` : `Visible: ${g.scores[player]}, Active: ${g.effect_totals[player]}`}${!state.connected[player] && !state.solo ? " · offline" : ""}</small></div><div class='card-grid'>${g.players[
    player
  ]
    .map((slot, i) => {
      const ref = [player, i];
      const eligible =
        legal.bonus ||
        hasRef(trade, ref) ||
        (own && (legal.swap.includes(i) || legal.flip.includes(i)));
      const label = `${own ? "Your" : "Opponent"} ${slot.visible ? slot.card.label + suit[slot.card.suit] : "hidden card"}, row ${Math.floor(i / 3) + 1}, column ${(i % 3) + 1}`;
      return cardHtml(
        slot.card,
        slot.visible,
        ref,
        label,
        eligible,
        slot.locked,
      );
    })
    .join("")}</div></section>`;
}
function allowed(action) {
  if (!state?.game || busy || state.status !== "playing") return false;
  const l = state.game.legal;
  const own = selected.length === 1 && selected[0][0] === state.viewer;
  const index = own ? selected[0][1] : null;
  if (action === "flip")
    return selected.length === 1 && selected[0][0] === "draw"
      ? l.draw
      : own && l.flip.includes(index);
  if (action === "draw" || action === "discard" || action === "end_turn")
    return l[action];
  if (action === "swap") {
    if (l.bonus)
      return (
        selected.length === 2 &&
        selected.every((r) => hasRef(state.game.table_refs, r))
      );
    if (l.trade[0].length)
      return (
        selected.length === 2 &&
        ((hasRef(l.trade[0], selected[0]) && hasRef(l.trade[1], selected[1])) ||
          (hasRef(l.trade[0], selected[1]) && hasRef(l.trade[1], selected[0])))
      );
    return own && l.swap.includes(index);
  }
  return false;
}
function modalHtml() {
  const g = state.game;
  if (g.legal.guess) {
    const target = g.guess_target;
    return `<div class='modal-shade'><section class='modal' role='dialog' aria-modal='true' aria-label='Beggars rank guess'><h2>Beggars Will be Choosers</h2><p>Guess your opponent’s hidden card: row ${Math.floor(target / 3) + 1}, column ${(target % 3) + 1}.</p><div class='ranks'>${Array.from({ length: 13 }, (_, i) => `<button class='button' data-guess='${i + 1}'>${{ 1: "A", 11: "J", 12: "Q", 13: "K" }[i + 1] || i + 1}</button>`).join("")}</div><button class='button secondary' data-guess='pass'>Pass</button></section></div>`;
  }
  if (g.legal.keep_layout) {
    return `<div class='modal-shade'><section class='modal' role='dialog' aria-modal='true' aria-label='Arrange four of a kind'><h2>4 of a Kind</h2><p>Choose two columns for the four matching cards, or keep your layout. Hidden cards stay hidden.</p><div class='cols'>${[
      [0, 1],
      [0, 2],
      [1, 2],
    ]
      .map(
        (cols) =>
          `<button class='button' data-columns='${cols.join(",")}' ${g.legal.arrange.some((c) => same(c, cols)) ? "" : "disabled"}>Columns ${cols[0] + 1} + ${cols[1] + 1}</button>`,
      )
      .join(
        "",
      )}</div><button class='button secondary' data-columns='keep'>Keep layout</button></section></div>`;
  }
  return "";
}
function turnControls() {
  const g = state.game;
  const showingEmotes = controlsMode === "emotes";
  return `<section class='turn-controls' aria-label='Turn controls'><div class='controls-heading'><div class='turn-title'>${showingEmotes ? "Quick emotes" : e(state.message)}</div><div class='controls-tools'>${showingEmotes ? `<button type='button' class='controls-toggle' data-emote-mute aria-label='${opponentEmotesMuted ? "Unmute opponent emotes" : "Mute opponent emotes"}' aria-pressed='${opponentEmotesMuted}' title='${opponentEmotesMuted ? "Unmute opponent emotes" : "Mute opponent emotes"}'>${opponentEmotesMuted ? "🔕" : "🔔"}</button>` : ""}<button type='button' class='controls-toggle' data-controls-toggle aria-label='${showingEmotes ? "Show game actions" : "Show quick emotes"}' aria-pressed='${showingEmotes}' title='${showingEmotes ? "Game actions" : "Quick emotes"}'>${showingEmotes ? "↩" : "☺"}</button></div></div><div class='controls-content'>${
    showingEmotes
      ? quickEmotes()
      : `<div class='button-row'>${[
          ["flip", "Flip"],
          ["swap", "Swap"],
          ["draw", "Draw"],
          ["discard", "Discard"],
        ]
          .map(
            ([action, label]) =>
              `<button class='button' data-action='${action}' ${allowed(action) ? "" : "disabled"}>${label}</button>`,
          )
          .join("")}</div>`
  }</div><div class='small-actions'>${g.legal.end_turn ? `<button class='button secondary' data-action='end_turn'>End turn ↵</button>` : ""}</div><p class='hint' style='margin:12px 0 0'>${e(g.last_move)}</p></section>`;
}
function renderRoom() {
  if (!state) return;
  document.title = `${state.name} · GolfBot`;
  if (!state.game) {
    waitingRoom();
    return;
  }
  const g = state.game,
    viewer = state.viewer;
  const roundResult = state.history.at(-1);
  const roundOver = ["round_over", "finished"].includes(state.status);
  root.innerHTML = `<div class='board-heading'><div><h2>${e(state.name)}</h2><p class='hint' style='margin:6px 0 0'>Round ${state.round} · ${e(starter[state.first])} · ${g.final_turn ? "Final turn" : g.phase === "setup" ? "Opening reveal" : "Lowest score wins"}</p></div><div class='match-score'>${e(state.names[0])} ${state.wins[0]} : ${state.wins[1]} ${e(state.names[1])}</div><div class='button-row' style='margin:0'>${!state.solo ? `<button class='button secondary' data-copy='${e(location.origin + "/lobby/" + state.id)}'>Invite link</button>` : ""}<button class='button secondary' data-leave>Menu</button></div></div>${state.status === "closed" ? `<div class='closed-banner'>${e(state.message)}</div>` : ""}<div class='table-layout'><aside class='panel table-side'><h3>The table</h3><p>Select your card and Swap to take the discard. A draw stays visible until you decide.</p><div class='piles'><div><div class='pile-label'>Go-fish pile</div>${cardHtml(null, false, ["draw", null], "Select go-fish pile", g.legal.bonus && g.draw_count > 0)}<div class='pile-count'>${g.draw_count} cards</div></div><div><div class='pile-label'>Discard</div>${cardHtml(g.discard, true, ["discard", null], "Top discard " + g.discard.label + suit[g.discard.suit], g.legal.bonus)}<div class='pile-count'>Top card</div></div></div>${g.held ? `<div class='drawn'><span class='hint'>Drawn card</span><div class='card ${["H", "D"].includes(g.held.suit) ? "red" : ""}'><span class='rank'>${e(g.held.label)}</span><span class='suit'>${suit[g.held.suit]}</span></div></div>` : ""}<p class='hint'>Same-rank column pairs score zero. Suits matter only for selected rules.</p></aside><div class='hands'>${handHtml(1 - viewer)}${handHtml(viewer)}${turnControls()}${roundOver ? `<section class='round-summary'><strong>${state.status === "finished" ? e(state.names[state.champion]) + " wins the match." : e(state.message)}</strong><p class='hint'>${e(state.names[0])}: ${roundResult.scores[0]} · ${e(state.names[1])}: ${roundResult.scores[1]}</p><div class='button-row' style='margin-top:12px'>${state.status === "round_over" ? `<button class='button gold' data-action='next_round' ${state.ready[viewer] ? "disabled" : ""}>${state.ready[viewer] ? "Waiting for opponent…" : "Ready for next round"}</button>` : viewer === 0 ? `<button class='button gold' data-action='rematch'>Play again</button>` : `<span class='hint'>The host can start a rematch.</span>`}</div></section>` : ""}</div><aside class='sidebar'><section class='panel'><h3>Rules in play</h3>${g.legal.set_rules ? `<div class='solo-settings'>Choose before your second opening flip.</div>` : ""}${rulesHtml(state.rules, g.legal.set_rules, "live")}</section><section class='panel'><h3>Active effects</h3><div class='effects'>${[viewer, 1 - viewer].map((p) => `<div class='effect-group'><strong>${e(state.names[p])}: ${g.phase === "over" ? "final" : "visible with effects"} ${g.effect_totals[p]}</strong>${(g.effects[p].length ? g.effects[p] : ["None"]).map((effect) => `<div>${e(effect)}</div>`).join("")}</div>`).join("")}</div><p class='hint' style='margin:12px 0 0'>Hidden cards are excluded before scoring.</p></section>${!state.solo && state.history.length ? `<section class='panel'><h3>Match history</h3><div class='history'>${state.history.map((r) => `<div>Round ${r.round}: ${r.scores[0]}–${r.scores[1]} · ${r.winner === null ? "Draw" : e(state.names[r.winner])}</div>`).join("")}</div></section>` : ""}</aside></div><div class='table-emotes' aria-label='Player reactions'>${[0, 1].map(playerEmote).join("")}</div>${modalHtml()}`;
}
async function move(action, extra = {}) {
  if (busy || !state) return;
  busy = true;
  try {
    let actual = action;
    if (action === "flip" && selected[0]?.[0] === "draw") actual = "draw";
    const body = { action: actual, version: state.version, ...extra };
    if (
      ["flip", "swap"].includes(actual) &&
      selected.length === 1 &&
      selected[0][0] === state.viewer
    )
      body.index = selected[0][1];
    if (actual === "swap" && selected.length === 2) body.refs = selected;
    const next = await api(`/api/lobbies/${state.id}/action`, "POST", body);
    selected = [];
    accept(next);
    if (actual === "flip" && next.game?.legal.swap.length === 1) {
      selected = [[next.viewer, next.game.legal.swap[0]]];
      renderRoom();
    }
  } catch (error) {
    toast(error.message);
    if (error.status === 409 && state) {
      try {
        accept(await api(`/api/lobbies/${state.id}/state`));
      } catch {}
    }
  } finally {
    busy = false;
    if (state) renderRoom();
  }
}
root.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  try {
    if (button.dataset.nav) {
      if (button.dataset.nav === "home") {
        home();
      } else if (button.dataset.nav === "history") await historyPage();
      else if (button.dataset.nav === "host") hostForm();
      else if (button.dataset.nav === "join") await joinList();
      else if (button.dataset.nav === "resume") await resume();
      else if (button.dataset.nav === "solo") {
        saveName(name());
        await abandonExisting();
        enterRoom(
          await api("/api/solo", "POST", {
            username: session.username,
            rules: {},
          }),
        );
      }
      return;
    }
    if (button.hasAttribute("data-history-more")) {
      await historyPage(true);
      return;
    }
    if (button.dataset.lobby) {
      await publicLobby(button.dataset.lobby);
      return;
    }
    if (button.dataset.join) {
      saveName(name());
      await abandonExisting();
      enterRoom(
        await api(`/api/lobbies/${button.dataset.join}/join`, "POST", {
          username: session.username,
        }),
      );
      return;
    }
    if (button.hasAttribute("data-leave")) {
      await abandonExisting();
      state = null;
      home();
      return;
    }
    if (button.dataset.copy) {
      try {
        await navigator.clipboard.writeText(button.dataset.copy);
        toast("Invite link copied.");
      } catch {
        toast("Copy the lobby link from the address bar.");
      }
      return;
    }
    if (button.hasAttribute("data-emote-mute")) {
      opponentEmotesMuted = !opponentEmotesMuted;
      try {
        localStorage.setItem("golf-mute-emotes", String(opponentEmotesMuted));
      } catch {}
      if (opponentEmotesMuted) {
        const opponent = 1 - state.viewer;
        clearTimeout(emoteTimers[opponent]);
        delete activeEmotes[opponent];
      }
      renderRoom();
      return;
    }
    if (button.hasAttribute("data-controls-toggle")) {
      controlsMode = controlsMode === "actions" ? "emotes" : "actions";
      renderRoom();
      return;
    }
    if (button.dataset.emote) {
      await sendEmote(button.dataset.emote);
      return;
    }
    if (button.dataset.ref) {
      const ref = JSON.parse(button.dataset.ref);
      if (selectedRef(ref)) selected = selected.filter((r) => !same(r, ref));
      else if (state.game.legal.bonus || state.game.legal.trade[0].length)
        selected = [...selected, ref].slice(-2);
      else selected = [ref];
      renderRoom();
      return;
    }
    if (button.dataset.guess) {
      await move("guess", {
        rank:
          button.dataset.guess === "pass" ? null : Number(button.dataset.guess),
      });
      return;
    }
    if (button.dataset.columns) {
      await move("arrange", {
        columns:
          button.dataset.columns === "keep"
            ? null
            : button.dataset.columns.split(",").map(Number),
      });
      return;
    }
    if (button.dataset.action) await move(button.dataset.action);
  } catch (error) {
    toast(error.message);
  }
});
root.addEventListener("submit", async (event) => {
  if (event.target.id !== "host-form") return;
  event.preventDefault();
  const form = event.target;
  const data = new FormData(form);
  const rules = {};
  for (const rule of catalog) rules[rule.key] = data.has("rule-" + rule.key);
  try {
    saveName(String(data.get("username")).trim());
    await abandonExisting();
    enterRoom(
      await api("/api/lobbies", "POST", {
        username: session.username,
        name: data.get("name"),
        best_of: Number(data.get("best_of")),
        first: data.get("first"),
        rules,
      }),
    );
  } catch (error) {
    toast(error.message);
  }
});
root.addEventListener("change", (event) => {
  if (event.target.id === "username")
    saveName(event.target.value.trim() || "Player");
  if (event.target.dataset.ruleType === "live")
    move("set_rule", {
      rule: event.target.dataset.rule,
      enabled: event.target.checked,
    });
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    page !== "history" &&
    !["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName) &&
    state?.game?.legal.end_turn
  ) {
    event.preventDefault();
    move("end_turn");
  }
});
window.addEventListener("popstate", () => {
  if (location.pathname === "/history") {
    historyPage();
    return;
  }
  const id = location.pathname.match(/^\/lobby\/([^/]+)$/)?.[1];
  if (id) publicLobby(id).catch((error) => toast(error.message));
  else home();
});
(async () => {
  try {
    [session, catalog] = await Promise.all([
      api("/api/session"),
      api("/api/rules"),
    ]);
    try {
      session.username = localStorage.getItem("golf-name") || session.username;
    } catch {}
    const id = location.pathname.match(/^\/lobby\/([^/]+)$/)?.[1];
    if (location.pathname === "/history") await historyPage();
    else if (id) await publicLobby(id);
    else home();
  } catch (error) {
    root.innerHTML = `<div class='empty'>${e(error.message)}<p>Refresh to reconnect to your server.</p></div>`;
    connection.textContent = "Offline";
  }
})();
document.getElementById("history-tab").addEventListener("click", () => {
  if (session) historyPage();
});
document.getElementById("play-tab").addEventListener("click", () => {
  if (session) {
    markTab(false);
    if (session.room_id) resume().catch((error) => toast(error.message));
    else home();
  }
});
