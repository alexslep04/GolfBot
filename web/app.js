"use strict";
// App shell: session, networking, menus, match setup, lobbies and the long
// read-only pages. The table itself lives in board.js.

const basePath = new URL(document.baseURI).pathname.replace(/\/$/, "");
const appPath = (path = "/") => `${basePath}${path}`;
const currentPath = () => location.pathname.slice(basePath.length) || "/";
const root = document.getElementById("app");
const sheetRoot = document.getElementById("sheet");
let catalog = [],
  avatars = [],
  matchOptions = null,
  session = null,
  state = null,
  socket = null,
  heartbeat = null,
  retry = null,
  busy = false,
  page = "home",
  tableEpoch = 0,
  toastTimer;
// Pages that can be read without leaving (or redrawing over) an open table.
const SIDE_PAGES = ["history", "stats", "account", "patches", "notifications", "rules", "leaderboard", "cards", "spectate", "passplay", "tournament"];

const starter = {
  host: "Host first",
  guest: "Guest first",
  alternate: "Alternate each game",
  random: "Random each game",
  winner: "Previous winner first",
  loser: "Previous loser first",
};
const RULE_SHORT = {
  royal_pairs: "J-J/Q-Q",
  angel_numbers: "Angels",
  king_queen: "K-Q Colors",
  holdem: "Hold 'em",
  v10: "V10",
  tricky_straights: "Straights",
  ripped_five: "Ripped 5",
  roman_fives: "V2",
  beggars: "Beggars",
  four_kind: "4 of a Kind",
  poisoned_card: "Poison",
  suited_rows: "Suited rows",
  all_in_color: "All in",
};
const POPULAR_RULES = [
  "royal_pairs",
  "angel_numbers",
  "king_queen",
  "v10",
  "ripped_five",
  "poisoned_card",
];
const NEW_RULES = ["angel_numbers"];

/* ---------- emotes ---------- */
const emoteNames = {
  unamused: "Unamused",
  shocked: "Shocked",
  laughing: "Laughing",
  cackling: "Cackling",
  nervous: "Nervous",
  thanks: "Thanks!",
  oops: "Oops!",
  wow: "Wow!",
  save: "What a save!",
  ofc: "Ofc!",
  luck: "Good luck!",
  tempo: "Not my tempo.",
  ranked: "Join Ranked!",
};
// these are said in words, as a speech bubble, rather than shown as a face
const TEXT_EMOTES = ["luck", "thanks", "oops", "wow", "save", "ofc", "tempo", "ranked"];
const FACE_EMOTES = Object.keys(emoteNames).filter((id) => !TEXT_EMOTES.includes(id));
// Which emotes are on a player's emote bar, and in what order, is theirs to
// choose (Settings > Emotes): any of each kind, or none. Any emote can still
// be received.
const EMOTE_KINDS = { faces: ["emoteFaces", FACE_EMOTES], words: ["emoteWords", TEXT_EMOTES] };
/** The emotes on this player's bar, in order: `kind` is "faces" or "words". */
function emoteBar(kind) {
  const [pref, all] = EMOTE_KINDS[kind];
  return String(prefs[pref] ?? "")
    .split(",")
    .filter((id, i, list) => all.includes(id) && list.indexOf(id) === i);
}
let activeEmotes = {},
  emoteSeen = {},
  emoteTimers = {},
  emoteTable = "",
  emoteRound = null;
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
async function sendEmote(id) {
  if (!state?.game) return;
  const roomId = state.id;
  try {
    const next = await api(`/api/lobbies/${roomId}/emote`, "POST", {
      emote: id,
    });
    if (state?.id === roomId) accept(next);
  } catch (error) {
    toast(error.message);
  }
}

/* ---------- small helpers ---------- */
const matchLength = (match) =>
  match.best_of === null
    ? "Play until you leave"
    : match.best_of === 1
      ? "Single game"
      : match.series_mode === "points"
        ? `${match.best_of} games · total pts`
        : `Best of ${match.best_of}`;
const houseBadge = (match) =>
  match.house_rules
    ? `<span class="pill c-p1">${glyph("house.fill", 14)} House rules</span>`
    : "";
/** A lobby's rules chip: House rules, or how many rules are on; a tap opens the rules sheet. */
const rulesChip = (match) => {
  const count = catalog.filter((rule) => match.rules?.[rule.key]).length;
  return `<button type="button" class="pill c-p1 rules-chip" data-lobby-rules aria-label="Show the rules">${glyph(match.house_rules ? "house.fill" : "list.bullet.clipboard.fill", 14)}${match.house_rules ? "House rules" : `${count} ${count === 1 ? "rule" : "rules"}`}</button>`;
};
// the lobby whose rules the chip shows (the join page's, or the waiting room's own)
let chipMatch = null;
/** A lobby's rules, made like the table's rules sheet: the rules that will be in play. */
function lobbyRulesSheet(match) {
  const enabled = catalog.filter((rule) => match.rules?.[rule.key]);
  return `<section class="sheet rules-sheet c-p1" role="dialog" aria-modal="true" aria-label="Rules in play">
    <div class="sheet-head"><h2>${e(match.name)}</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    <h3>${enabled.length} rule${enabled.length === 1 ? "" : "s"} in play${match.house_rules ? " · House rules" : ""}</h3>
    <div>${enabled.map((rule) => ruleHelpCard(rule)).join("") || "<p>Base scoring only — no optional rules.</p>"}</div>
  </section>`;
}
/** Opens the lobby's rules sheet; `kept` redraws it as it was after a table update. */
function openLobbyRules(kept = null) {
  openSheet(lobbyRulesSheet(chipMatch));
  sheetRoot.dataset.lobbyRules = "";
  const sheet = sheetRoot.querySelector(".sheet");
  if (!kept) return;
  const { scroll, examples } = kept;
  // just as it was, without sliding in again
  sheet?.classList.add("settled");
  for (const id of examples) {
    const example = document.getElementById(id);
    if (!example) continue;
    example.hidden = false;
    const eye = sheetRoot.querySelector(`[aria-controls="${id}"]`);
    eye?.setAttribute("aria-expanded", "true");
    eye?.classList.add("c-p3");
  }
  if (sheet) sheet.scrollTop = scroll;
}
const avatarIcon = (id) =>
  (avatars.find((avatar) => avatar.id === id) || avatars[0] || {}).icon ||
  "dog.fill";
const avatarBadge = (id, color = "c-fw") =>
  `<span class="avatar-badge ${color}">${icon(avatarIcon(id), 24, { idle: false })}</span>`;
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
/**
 * True once this device has a display name and an avatar of its own (set on
 * the Profile page, or chosen before a game): pregame screens then skip
 * asking for them again.
 */
function profileChosen() {
  try {
    return !!(localStorage.getItem("golf-name") && localStorage.getItem("golf-avatar"));
  } catch {
    return false;
  }
}
function saveAvatar(id) {
  try {
    localStorage.setItem("golf-avatar", id);
  } catch {}
  session.avatar = id;
}
function toast(text) {
  const el = document.getElementById("toast");
  el.innerHTML = `<span class="toast-text">${e(text)}</span><button type="button" class="toast-close" data-toast-close aria-label="Dismiss">${icon("xmark.circle.fill", 20, { idle: false })}</button>`;
  el.hidden = true;
  el.classList.remove("leaving");
  el.style.removeProperty("translate");
  el.style.removeProperty("opacity");
  void el.offsetWidth;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissToast, 4200);
}
/**
 * Info cards leave by sliding down off the bottom of the screen (or, swiped,
 * the way they were thrown).
 */
function dismissToast(translate = "0px calc(100% + 4rem)") {
  const el = document.getElementById("toast");
  clearTimeout(toastTimer);
  if (el.hidden) return;
  el.classList.add("leaving");
  el.style.translate = translate;
  el.style.opacity = "0";
  toastTimer = setTimeout(() => {
    el.hidden = true;
    el.classList.remove("leaving");
  }, 320);
}
// A toast can be swiped away, sideways or down; a short drag springs back.
(() => {
  const el = document.getElementById("toast");
  if (!el?.addEventListener) return;
  let start = null;
  const dismiss = dismissToast;
  el.addEventListener("click", (event) => {
    if (event.target.closest?.("[data-toast-close]")) dismiss();
  });
  const offset = (event) => {
    const dx = event.clientX - start.x,
      dy = event.clientY - start.y;
    // it follows the finger sideways and downwards, and only a little upwards
    return [dx, dy < 0 ? dy / 4 : dy];
  };
  el.addEventListener("pointerdown", (event) => {
    if (event.target.closest?.("[data-toast-close]")) return; // a tap on the ✕, not a swipe
    start = { x: event.clientX, y: event.clientY };
    el.setPointerCapture(event.pointerId);
    el.classList.add("dragging");
    clearTimeout(toastTimer);
  });
  el.addEventListener("pointermove", (event) => {
    if (!start) return;
    const [dx, dy] = offset(event);
    el.style.translate = `${dx}px ${dy}px`;
    el.style.opacity = String(Math.max(0.3, 1 - Math.hypot(dx, dy) / 260));
  });
  const release = (event) => {
    if (!start) return;
    const [dx, dy] = offset(event);
    start = null;
    el.classList.remove("dragging");
    if (Math.abs(dx) > 60 || dy > 40) {
      // off it goes, the way it was thrown
      const far = Math.max(innerWidth, 600);
      dismiss(Math.abs(dx) > dy ? `${Math.sign(dx) * far}px ${dy}px` : `${dx}px calc(100% + 4rem)`);
    } else {
      el.style.removeProperty("translate");
      el.style.removeProperty("opacity");
      toastTimer = setTimeout(dismissToast, 2500);
    }
  };
  el.addEventListener("pointerup", release);
  el.addEventListener("pointercancel", release);
})();
async function api(url, method = "GET", body) {
  const response = await fetch(appPath(url), {
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
// A debug build (launch.py --debug) keeps "DEBUG" at the front of every
// title the pages set, as the server already put it on the first one.
if (document.documentElement.dataset?.debug !== undefined) {
  const title = Object.getOwnPropertyDescriptor(Document.prototype, "title");
  Object.defineProperty(document, "title", {
    configurable: true,
    get: () => title.get.call(document),
    set: (text) => title.set.call(document, String(text).startsWith("DEBUG") ? text : `DEBUG · ${text}`),
  });
}
let shownFirstPage = false;
/**
 * Bring `from` in line with `to` while keeping every node that already matches,
 * so what has not changed is never redrawn: its animations, focus, scroll and
 * any text being typed stay as they are.
 */
function morph(from, to) {
  if (from.nodeType !== to.nodeType || from.nodeName !== to.nodeName) return from.replaceWith(to);
  if (from.nodeType !== 1) {
    if (from.nodeValue !== to.nodeValue) from.nodeValue = to.nodeValue;
    return;
  }
  if (from.isEqualNode(to)) return;
  for (const { name } of [...from.attributes]) if (!to.hasAttribute(name)) from.removeAttribute(name);
  for (const { name, value } of [...to.attributes]) if (from.getAttribute(name) !== value) from.setAttribute(name, value);
  morphChildren(from, to);
  if (["INPUT", "TEXTAREA", "SELECT"].includes(from.tagName) && document.activeElement !== from && from.value !== to.value)
    from.value = to.value;
}
function morphChildren(from, to) {
  const before = [...from.childNodes],
    after = [...to.childNodes];
  after.forEach((node, i) => (i < before.length ? morph(before[i], node) : from.appendChild(node)));
  before.slice(after.length).forEach((node) => node.remove());
}
function show(name, html) {
  // the same screen drawn again (a setting changed, a table update) is
  // patched in place; a new screen replaces the page and slides in
  const same = page === name && shownFirstPage && root.firstElementChild && !root.querySelector("[data-board]");
  const template = same && document.createElement("template");
  page = name;
  document.documentElement.classList.remove("in-game");
  // (a class rather than :has() in the CSS: that had the whole screen restyled whenever anything on it changed)
  document.documentElement.classList.toggle("home-tabbed", name === "home");
  closeSheet();
  if (template?.content) {
    template.innerHTML = html;
    // a page that arrived without its slide-in keeps it off
    if (root.firstElementChild.classList.contains("instant")) template.content.firstElementChild?.classList.add("instant");
    morphChildren(root, template.content);
    renderQueueBanner();
    return;
  }
  root.innerHTML = html;
  // a load or refresh lands on its page without the slide-in (it read as a flicker)
  const first = !shownFirstPage;
  if (first) {
    shownFirstPage = true;
    root.firstElementChild?.classList.add("instant");
  }
  window.scrollTo(0, 0);
  renderQueueBanner();
  if (first) booted();
}
function openSheet(html, player = "") {
  rememberRulesScroll();
  // `player` marks a rules sheet, which is kept in step with the table
  sheetRoot.dataset.player = String(player);
  sheetRoot.innerHTML = html;
  sheetRoot.hidden = false;
  // its stickers hold still until it has risen into place (see .sheet.entering)
  const sheet = sheetRoot.querySelector(".sheet");
  if (sheet) {
    sheet.classList.add("entering");
    setTimeout(() => sheet.classList.remove("entering"), 500);
  }
}
function closeSheet() {
  rememberRulesScroll();
  sheetRoot.hidden = true;
  sheetRoot.innerHTML = "";
  sheetRoot.dataset.player = "";
  delete sheetRoot.dataset.lobbyRules;
}
// A rules sheet opens again where it was left, for each player at this table.
const rulesScroll = new Map();
const rulesScrollKey = (player) => `${state?.id}|${player}`;
function rememberRulesScroll() {
  const player = sheetRoot.dataset.player;
  if (sheetRoot.hidden || player === undefined || player === "") return;
  const sheet = sheetRoot.querySelector?.(".rules-sheet");
  if (sheet) rulesScroll.set(rulesScrollKey(player), sheet.scrollTop);
}
function topbar() {
  return `<header class="topbar"><button type="button" class="icon-btn" data-settings aria-label="Settings">${icon("gear", 44)}${padTag("start", "under")}</button><div class="queue-slot"></div>${logoHtml()}</header>`;
}
/**
 * Every page but the home menu: Back where the home menu has Settings, the Golf
 * logo across from it, and the page's title on its own line underneath (with
 * anything that sits beside the title, like Refresh, in `extra`).
 */
function pageHead(backAttrs, title = "", extra = "", sub = "") {
  const bar = `<header class="topbar">${backSticker(backAttrs)}<div class="queue-slot"></div>${logoHtml()}</header>`;
  // the page's name on an arch, as a home tab's is (with a line under it, if it has one);
  // anything else at the head of the page (Refresh, Leave) sits to the right of it
  return `${bar}${title ? titleWith(tabTitle(title, sub, `page:${title}`), extra) : extra ? `<div class="page-extra">${extra}</div>` : ""}`;
}
function subHeader(title, back = session?.room_id ? "resume" : "home", sub = "") {
  return pageHead(`data-nav="${back}"`, title, "", sub);
}
function field(label, body, iconName, extra = "") {
  return `<label class="field ${extra}"><span class="label">${e(label)}</span>${iconName ? tilted(iconName, 24) : ""}${body}</label>`;
}
/** A field whose value reads like the design's text; the native picker sits invisibly on top. */
function selectField(label, attrs, options, iconName, extra = "") {
  const chosen = options.find((option) => option[2]) || options[0];
  return field(
    label,
    `<span class="value">${e(chosen[1])}</span><select class="cover" ${attrs}>${options.map(([value, text, selected]) => `<option value="${e(value)}" ${selected ? "selected" : ""}>${e(text)}</option>`).join("")}</select>`,
    iconName,
    extra,
  );
}
/** A field with an info sticker on the top edge of its border, opposite its
 * label; tapping it shows or hides the explanation underneath. */
const openInfo = new Set();
function infoField(key, fieldHtml, text) {
  const open = openInfo.has(key);
  const button = `<button type="button" class="field-info" data-info="${key}" aria-label="About this setting" aria-expanded="${open}">${icon("info.circle.fill", 20, { idle: false })}</button>`;
  return `<div class="stack">${fieldHtml.replace(/<\/label>$/, `${button}</label>`)}<div class="info-hint${open ? " open" : ""}" id="info-${key}"><p class="hint">${e(text)}</p></div></div>`;
}
/** Back: the stacked sticker (icon over its label), like Close, Quit and Refresh. */
function backSticker(attrs) {
  return `<button type="button" class="close-btn c-fw back-btn" ${attrs} aria-label="Back">${icon("arrowshape.backward.fill", 40)}<span>${padTag("b")}Back</span></button>`;
}
/** An empty list's message, centered in the room the page has left for it, one sentence a line. */
function emptyNote(...lines) {
  return `<div class="empty-fill"><p class="hint">${lines.map(e).join("<br>")}</p></div>`;
}
function refreshButton(target) {
  return `<button type="button" class="close-btn c-fw watch-refresh" data-nav="${target}" aria-label="Refresh">${icon("arrow.clockwise", 30)}<span>${padTag("x")}Refresh</span></button>`;
}

/* ---------- presence, invitations, quickplay queue ---------- */
let presenceState = {
    available_lobbies: 0,
    spectatable_games: 0,
    players: [],
    invitations: [],
    invited: [],
    queue_size: 0,
  },
  presenceBusy = false,
  queueSizeSeen, // the queue's size at the last presence update (none before the first)
  socialMode = null,
  socialSignature = "";
const dismissedInvites = new Set();
let hiddenQueueOffer = null,
  queueEntering = false;

function closeSocial() {
  const dialog = document.getElementById("social-dialog");
  if (dialog.open) dialog.close();
  socialMode = null;
  socialSignature = "";
}
function queueLabel() {
  const queue = presenceState.queue;
  if (queue?.status === "waiting") return "In queue… tap to leave";
  if (queue?.status === "offer") return "Match found!";
  return ""; // how many are waiting shows as the count on the button's corner
}
/** The count on a home button's corner (hidden at zero). */
function setCount(id, count, label) {
  const badge = document.getElementById(id);
  if (!badge) return;
  badge.hidden = !count;
  badge.textContent = count;
  badge.setAttribute("aria-label", label);
}
function renderHomeLive() {
  const sub = document.getElementById("queue-sub");
  if (sub) {
    sub.textContent = queueLabel();
    sub.hidden = !sub.textContent;
  }
  const waiting = presenceState.queue_size || 0;
  // (on Play Ranked itself, on Start a Game while it is closed, and on the Play tab's icon)
  for (const id of ["queue-count", "queue-count-start", "queue-count-tab"]) setCount(id, waiting, `${waiting} ${waiting === 1 ? "player" : "players"} in queue`);
  const open = presenceState.available_lobbies || 0;
  setCount("lobby-count", open, `${open} open ${open === 1 ? "table" : "tables"}`);
  // the same count on Spectate: games in play you could watch
  const watchable = presenceState.spectatable_games || 0;
  setCount("spectate-count", watchable, `${watchable} ${watchable === 1 ? "game" : "games"} to watch`);
  renderStartLabel();
}
function renderQueueBanner() {
  const banner = document.getElementById("queue-banner");
  const queue = presenceState.queue;
  const onBoard = page === "room" && !!state?.game;
  const offering = queue?.status === "offer";
  // at the table the waiting pill only drops in when its sparkle is tapped (an offer always shows)
  const peeking = performance.now() < queuePeekUntil;
  const visible = !!queue && ["waiting", "offer"].includes(queue.status) && (!onBoard || offering || peeking);
  banner.classList.toggle("peek", visible && onBoard && !offering);
  const html = visible ? queuePillHtml(queue) : "";
  const ghost = visible ? queuePillHtml(queue, true) : "";
  banner.classList.toggle("offering", visible && offering);
  // Each page's top bar keeps an invisible copy, which holds the pill's room
  // between its buttons; the one real pill sits over it.
  root.querySelectorAll(".queue-slot").forEach((holder) => {
    if (holder.dataset.html !== ghost) {
      holder.dataset.html = ghost;
      holder.innerHTML = ghost;
    }
  });
  // (a peek that has already slid away is simply taken down)
  if (!visible) hideQueuePill(banner, onBoard || !!banner.classList.contains?.("peek-out"));
  else {
    const pill = banner.firstElementChild;
    const before = !banner.hidden && pill ? { w: pill.offsetWidth, h: pill.offsetHeight, open: pill.classList.contains("open") } : null;
    if (banner.dataset.html !== html) {
      banner.dataset.html = html;
      // patched in place: only what changed is redrawn, nothing plays again
      const template = document.createElement("template");
      template.innerHTML = html;
      if (pill && template.content) morphChildren(banner, template.content);
      else banner.innerHTML = html;
    }
    placeQueuePill(banner);
    const now = banner.firstElementChild;
    if (before && now && before.open !== now.classList.contains("open")) growQueuePill(now, before);
  }
  renderHomeLive();
  if (page === "room" && state?.game && board.el?.isConnected) renderChrome();
}
/*
 * The Quickplay pill is one element for the whole site, so moving between
 * pages never redraws it: it glides from its spot in the old page's top bar to
 * the new one's (or the top center, on a page without one).
 */
let queuePillAt = null; // where the pill rests, in page coordinates; null while hidden
/** An element's place in the page, as laid out (a page's slide-in transform aside). */
function layoutBox(el) {
  let left = 0,
    top = 0;
  for (let node = el; node; node = node.offsetParent) {
    left += node.offsetLeft;
    top += node.offsetTop;
  }
  return { left, top, width: el.offsetWidth, height: el.offsetHeight };
}
function placeQueuePill(banner, animate = true) {
  const wasHidden = banner.hidden;
  banner.hidden = false;
  const slot = root.querySelector(".queue-slot");
  const width = banner.offsetWidth,
    height = banner.offsetHeight;
  let to;
  const open = banner.classList.contains("offering");
  if (slot && open && !(page === "room" && state?.game)) {
    // opened out with an offer, hanging from the top of its spot: a pill at the
    // side of the screen grows out from that side, one near the middle from the center
    const box = layoutBox(slot);
    const screen = document.documentElement.clientWidth;
    const middle = box.left + box.width / 2;
    const left =
      middle < screen * 0.3 ? box.left + (box.width - slot.firstElementChild?.offsetWidth || 0) / 2
      : middle > screen * 0.7 ? box.left + box.width / 2 + (slot.firstElementChild?.offsetWidth || 0) / 2 - width
      : (screen - width) / 2;
    to = { left: Math.max(8, Math.min(screen - width - 8, left)), top: box.top };
  } else if (slot && !open) {
    const box = layoutBox(slot);
    to = { left: box.left + (box.width - width) / 2, top: box.top + (box.height - height) / 2 };
  } else
    to = {
      left: (document.documentElement.clientWidth - width) / 2,
      top: Math.max(8, parseFloat(getComputedStyle(banner).getPropertyValue("--safe-top")) || 0),
    };
  // start from wherever it shows on screen now, mid-glide included
  const now = banner.getBoundingClientRect();
  const from = queuePillAt && !wasHidden ? { left: now.left, top: now.top } : null;
  queuePillAt = to;
  pinQueuePill(banner);
  // where it will rest on screen: pinned, its place is already in screen terms;
  // otherwise its page place less the scroll (comparing like with like, so a
  // pill pinned at the top while scrolled is not taken to have moved)
  const pinned = banner.classList.contains?.("pinned");
  const rest = {
    left: parseFloat(banner.style.left) - (pinned ? 0 : scrollX),
    top: parseFloat(banner.style.top) - (pinned ? 0 : scrollY),
  };
  if (!animate || reducedMotion.matches) return;
  // the first page after a load is simply there, pill included
  const instant = root.firstElementChild?.classList.contains("instant") && wasHidden && !shownQueuePill;
  shownQueuePill = true;
  if (instant) return;
  if (!from) {
    banner.getAnimations().forEach((animation) => animation.cancel());
    banner.animate(
      [{ transform: "scale(0.6)", opacity: 0 }, { transform: "none", opacity: 1 }],
      { duration: 400, easing: "cubic-bezier(0.34, 1.5, 0.64, 1)" },
    );
    return;
  }
  const dx = from.left - rest.left,
    dy = from.top - rest.top;
  if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
  banner.getAnimations().forEach((animation) => animation.cancel());
  banner.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }],
    { duration: 450, easing: "cubic-bezier(0.3, 0.7, 0.25, 1)" },
  );
}
let shownQueuePill = false;
/*
 * At the table, tapping the Quickplay sparkle drops the pill down from the top
 * for five seconds; it can be swiped away sooner.
 */
let queuePeekUntil = 0,
  queuePeekTimer = 0;
const QUEUE_PEEK_MS = 5000;
function peekQueuePill() {
  const banner = document.getElementById("queue-banner");
  const already = performance.now() < queuePeekUntil && !banner.hidden;
  queuePeekUntil = performance.now() + QUEUE_PEEK_MS;
  clearTimeout(queuePeekTimer);
  queuePeekTimer = setTimeout(endQueuePeek, QUEUE_PEEK_MS);
  if (already) return;
  banner.classList.remove("peek-out");
  renderQueueBanner();
  if (banner.hidden || reducedMotion.matches) return;
  banner.getAnimations().forEach((animation) => animation.cancel());
  banner.animate(
    [{ transform: "translateY(calc(-100% - 2rem))" }, { transform: "none" }],
    { duration: 420, easing: "cubic-bezier(0.3, 0.8, 0.25, 1.1)" },
  );
}
/** The peek ends: the pill rises back off the top (or leaves the way it was swiped). */
function endQueuePeek(away = "translateY(calc(-100% - 2rem))") {
  clearTimeout(queuePeekTimer);
  queuePeekUntil = 0;
  const banner = document.getElementById("queue-banner");
  if (!banner.classList.contains("peek") || banner.hidden) return renderQueueBanner();
  const finish = () => {
    banner.classList.add("peek-out");
    banner.style.translate = "";
    renderQueueBanner();
    banner.classList.remove("peek-out");
  };
  if (reducedMotion.matches) return finish();
  banner.getAnimations().forEach((animation) => animation.cancel());
  // `away` adds to wherever a swipe has already dragged it (its `translate`)
  banner
    .animate([{ transform: "none" }, { transform: away, opacity: 0 }], {
      duration: 280,
      easing: "cubic-bezier(0.4, 0, 0.9, 0.6)",
      fill: "forwards",
    })
    .finished.then(finish, finish);
}
// Swiping the dropped-down pill (at the table only) sends it away early.
(() => {
  let drag = null;
  document.addEventListener("pointerdown", (event) => {
    const banner = document.getElementById("queue-banner");
    if (!banner?.classList.contains("peek") || !banner.contains(event.target)) return;
    drag = { x: event.clientX, y: event.clientY, id: event.pointerId, moved: false };
  });
  document.addEventListener("pointermove", (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const banner = document.getElementById("queue-banner");
    const dx = event.clientX - drag.x,
      dy = Math.min(0, event.clientY - drag.y) + Math.max(0, event.clientY - drag.y) / 4;
    if (!drag.moved && Math.hypot(dx, dy) < 8) return;
    drag.moved = true;
    drag.dx = dx;
    drag.dy = dy;
    banner.style.translate = `${dx}px ${dy}px`;
  });
  const release = (event) => {
    if (!drag || event.pointerId !== drag.id) return;
    const { moved, dx = 0, dy = 0 } = drag;
    drag = null;
    if (!moved) return;
    // a drag is not also a tap on the pill's buttons
    document.addEventListener("click", (click) => click.stopPropagation(), { capture: true, once: true });
    const banner = document.getElementById("queue-banner");
    if (Math.abs(dx) > 60 || dy < -24) {
      const away = Math.abs(dx) > 60 ? `translateX(${Math.sign(dx) * innerWidth}px)` : "translateY(calc(-100% - 4rem))";
      endQueuePeek(away);
    } else {
      banner.animate([{ translate: banner.style.translate }, { translate: "0 0" }], { duration: 300, easing: "cubic-bezier(0.34, 1.4, 0.64, 1)" });
      banner.style.translate = "";
    }
  };
  document.addEventListener("pointerup", release);
  document.addEventListener("pointercancel", release);
})();
/**
 * The pill rests at its spot in the page; once the page scrolls that spot out of
 * view it floats at the top of the screen instead, and settles back on the way up.
 */
function pinQueuePill(banner = document.getElementById("queue-banner")) {
  if (!queuePillAt) return;
  const edge = Math.max(8, parseFloat(getComputedStyle(banner).getPropertyValue("--safe-top")) || 0);
  const pinned = scrollY + edge > queuePillAt.top;
  banner.classList.toggle("pinned", pinned);
  banner.style.left = `${queuePillAt.left - (pinned ? scrollX : 0)}px`;
  banner.style.top = `${pinned ? edge : queuePillAt.top}px`;
}
window.addEventListener("scroll", () => pinQueuePill(), { passive: true });
/** The pill opening into an offer (or closing again) grows smoothly from its old size. */
function growQueuePill(pill, from) {
  if (reducedMotion.matches || !pill.animate) return;
  const to = { w: pill.offsetWidth, h: pill.offsetHeight };
  if (Math.abs(to.w - from.w) < 1 && Math.abs(to.h - from.h) < 1) return;
  pill.getAnimations().forEach((animation) => animation.cancel());
  pill.style.overflow = "hidden";
  const grow = pill.animate(
    [
      { width: `${from.w}px`, height: `${from.h}px` },
      { width: `${to.w}px`, height: `${to.h}px` },
    ],
    { duration: 420, easing: "cubic-bezier(0.3, 0.8, 0.25, 1.05)" },
  );
  const done = () => (pill.style.overflow = "");
  grow.finished.then(done, done);
  // what is new inside fades in as the room opens up
  const accept = pill.querySelector(":scope > .queue-accept");
  for (const child of pill.children)
    if (child !== accept)
      child.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 260, delay: 120, easing: "ease-out", fill: "backwards" });
  // and once it is open, Accept slides down out from under it
  accept?.animate(
    [
      { opacity: 0, transform: "translateY(-1.6rem) scale(0.92)" },
      { opacity: 1, transform: "none" },
    ],
    { duration: 380, delay: 400, easing: "cubic-bezier(0.34, 1.4, 0.64, 1)", fill: "backwards" },
  );
}
function hideQueuePill(banner, instantly) {
  queuePillAt = null;
  if (banner.hidden) return;
  const done = () => {
    if (queuePillAt) return; // shown again meanwhile
    banner.hidden = true;
    banner.innerHTML = "";
    banner.dataset.html = "";
  };
  banner.getAnimations().forEach((animation) => animation.cancel());
  if (instantly || reducedMotion.matches) return done();
  banner
    .animate([{ opacity: 1 }, { transform: "scale(0.6)", opacity: 0 }], { duration: 180, easing: "ease-in" })
    .finished.then(done, done);
}
window.addEventListener("resize", () => {
  const banner = document.getElementById("queue-banner");
  if (queuePillAt) placeQueuePill(banner, false);
});
/** The Quickplay pill: its status (tap to see an offer) and a Leave sticker. */
/**
 * The Quickplay pill. Waiting, it says so beside a Leave sticker. With a match
 * found it opens out into the offer: who and the full match style beside Leave,
 * then a Decline sticker and Accept (declining keeps you in the queue). Both
 * states share one root element, so the pill can grow from one into the other.
 * `compact` is the top bar's invisible copy, which only keeps the closed pill's room.
 */
function queuePillHtml(queue, compact = false) {
  const offer = queue.status === "offer";
  const leave = `<button type="button" class="act side-act queue-leave" data-queue-leave aria-label="Leave the Ranked queue"><span class="act-ico">${icon("rectangle.portrait.and.arrow.right", 24, { sw: 3.4 })}</span><span class="side-label">Leave</span></button>`;
  if (offer && !compact) {
    const style = `${e(matchLength(queue.lobby || { best_of: 5, series_mode: "points" }))}${queue.lobby?.house_rules ? " · House rules" : ""}`;
    // Decline takes Leave's place (and keeps you in the queue); Accept hangs below the pill
    const decline = `<button type="button" class="act side-act queue-leave queue-decline" data-queue-reply="decline" aria-label="Decline this match and keep looking"><span class="act-ico">${icon("xmark.circle.fill", 24, { sw: 3.4 })}</span><span class="side-label">Decline</span></button>`;
    // a sparkle either side of the words, the second one mirrored
    const sparkle = (mirror) => icon("sparkles", 24, { idle: false, sw: 3.4, cls: mirror ? "mirrored" : "" });
    const accept = queue.accepted
      ? `<button type="button" class="btn c-p3 queue-accept" disabled>${sparkle(false)}<span>Waiting for ${e(queue.opponent)}…</span>${sparkle(true)}</button>`
      : `<button type="button" class="btn c-p3 queue-accept" data-queue-reply="accept">${sparkle(false)}<span>${padTag("y")}Accept</span>${sparkle(true)}</button>`;
    return `<div class="queue-pill offer open" role="dialog" aria-label="Classic match found"><div class="queue-offer-row"><span class="queue-text"><b>Match found!</b><small>vs <span class="queue-who">${e(queue.opponent)}</span><br>${style}</small></span>${decline}</div>${accept}</div>`;
  }
  const status = offer ? "Match found!" : "In queue";
  return `<div class="queue-pill${offer ? " offer" : ""}"><span class="queue-info" role="status" aria-label="Ranked: ${status}"><span class="queue-text"><b>Ranked</b><small>${status}</small></span></span>${leave}</div>`;
}
async function joinQueue() {
  saveName(name());
  presenceState.queue = await api("/api/queue/join", "POST", {
    username: session.username,
    avatar: session.avatar,
  });
  hiddenQueueOffer = null;
  renderQueueBanner();
  renderSocial();
}
/**
 * With "Join Ranked on open" on, opening the site's home page puts the
 * player straight in the queue — unless they already are in it, or have a
 * table of their own to get back to.
 */
async function autoJoinQueue() {
  if (!prefs.autoQueue || page !== "home" || session.room_id) return;
  if (["waiting", "offer", "matched"].includes(presenceState.queue?.status)) return;
  try {
    await joinQueue();
  } catch {}
}
async function enterQueueMatch() {
  if (queueEntering) return;
  queueEntering = true;
  try {
    const next = await api("/api/queue/enter", "POST");
    tableEpoch++;
    presenceState.queue = { status: "off" };
    closeSocial();
    renderQueueBanner();
    enterRoom(next);
    toast("Classic match · 5 games, lowest total score.");
  } finally {
    queueEntering = false;
  }
}
function rulesSummary(rules) {
  const names = catalog
    .filter((rule) => rules[rule.key])
    .map((rule) => RULE_SHORT[rule.key] || rule.name);
  return names.length ? names.join(", ") : "Base scoring only";
}
function renderSocial() {
  const dialog = document.getElementById("social-dialog");
  // a match offer opens out of the Quickplay pill (see queuePillHtml), not here
  if (socialMode === "queue") closeSocial();
  if (socialMode === "players" && state?.status !== "waiting" && !hostedLobby()) closeSocial();
  // (shown away from a table, and to someone playing Golfbot, who can leave that for it)
  const playingBot = state?.id === session.room_id && state.solo && !state.tournament;
  const invitation = session.room_id && !playingBot
    ? null
    : presenceState.invitations.find((item) => !dismissedInvites.has(item.id));
  // an invitation drops in as its own pill (see renderInvitePill), not here
  renderInvitePill(invitation);
  if (socialMode !== "players") socialMode = null;
  if (!socialMode) {
    if (dialog.open) closeSocial();
    return;
  }
  const signature = JSON.stringify([socialMode, presenceState.players, presenceState.invited]);
  if (signature === socialSignature) return;
  socialSignature = signature;
  dialog.innerHTML =
    socialMode === "players"
      ? `<button type="button" class="dialog-x" data-social-close aria-label="Close">${icon("xmark.circle.fill", 26)}</button><h2>Invite a player</h2><p class="hint">Players online right now who aren't at a table with someone or in a tournament.</p><div class="list invite-list">${presenceState.players.map((player) => {
          const invited = presenceState.invited.includes(player.id);
          // the player's card, and beside it the invite sticker over its label
          return `<div class="invite-row"><div class="list-item c-p1 grow">${avatarBadge(player.avatar, "c-p1")}<div class="grow"><strong>${e(player.display_name)}</strong><small>${player.unique_name ? "@" + e(player.unique_name) : "Guest"}${player.solo ? " · playing Golfbot" : ""}</small></div></div><button type="button" class="close-btn c-p1" data-invite-player="${e(player.id)}" aria-label="${invited ? "Invited" : "Invite"} ${e(player.display_name)}" ${invited ? "disabled" : ""}>${icon(invited ? "checkmark.circle.fill" : "person.fill.badge.plus", 30)}<span>${invited ? "Invited" : "Invite"}</span></button></div>`;
        }).join("") || `<p>No one else is online right now. Share the invite link instead.</p>`}</div>`
      : "";
  // (the invite list's x sits out on the dialog's corner)
  dialog.classList.toggle("invite-dialog", socialMode === "players");
  if (!dialog.open) dialog.showModal();
}
/**
 * A table invitation, made like the Ranked "Match found!" pill but blue: who
 * invited you to which table and its match style beside a Decline sticker, and
 * Accept hanging below. It drops in from the top, and leaves the same way.
 */
let shownInvite = null;
function renderInvitePill(invitation) {
  const banner = document.getElementById("invite-banner");
  if (!banner) return;
  const id = invitation?.id ?? null;
  if (id === shownInvite) return;
  const wasShowing = shownInvite !== null;
  shownInvite = id;
  const motion = !reducedMotion.matches && banner.animate;
  if (!invitation) {
    if (!wasShowing || !motion) {
      banner.hidden = true;
      banner.innerHTML = "";
      return;
    }
    banner.getAnimations().forEach((animation) => animation.cancel());
    banner
      .animate([{ transform: "none" }, { transform: "translateY(calc(-100% - 2rem))", opacity: 0 }], { duration: 260, easing: "cubic-bezier(0.4, 0, 0.9, 0.6)", fill: "forwards" })
      .finished.then(() => {
        if (shownInvite !== null) return; // another invitation came meanwhile
        banner.hidden = true;
        banner.innerHTML = "";
        banner.getAnimations().forEach((animation) => animation.cancel());
      }, () => {});
    return;
  }
  // (to a table, or to a tournament still gathering players)
  const cup = invitation.tournament;
  const lobby = cup || invitation.lobby || {};
  const style = `${cup ? `${e(cup.format_name)} · ` : ""}${e(matchLength(lobby))}${cup?.ranked ? " · Ranked" : lobby.house_rules ? " · House rules" : ""}`;
  const sparkle = (mirror) => icon("sparkles", 24, { idle: false, sw: 3.4, cls: mirror ? "mirrored" : "" });
  const decline = `<button type="button" class="act side-act queue-leave queue-decline" data-invite-reply="decline" data-invitation="${e(invitation.id)}" aria-label="Decline the invitation"><span class="act-ico">${icon("xmark.circle.fill", 24, { sw: 3.4 })}</span><span class="side-label">Decline</span></button>`;
  const accept = `<button type="button" class="btn c-p1 queue-accept" data-invite-reply="accept" data-invitation="${e(invitation.id)}">${sparkle(false)}<span>${padTag("y")}Accept</span>${sparkle(true)}</button>`;
  banner.innerHTML = `<div class="queue-pill offer open invite-pill" role="dialog" aria-label="${cup ? "Tournament" : "Table"} invitation"><div class="queue-offer-row"><span class="queue-text"><b>${cup ? "Tournament" : "Table"} invite!</b><small>${e(invitation.host)} · ${e(lobby.name || (cup ? "Tournament" : "Table"))}<br>${style}</small></span>${decline}</div>${accept}</div>`;
  banner.hidden = false;
  if (!motion) return;
  banner.getAnimations().forEach((animation) => animation.cancel());
  banner.animate([{ transform: "translateY(calc(-100% - 2rem))" }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(0.3, 0.8, 0.25, 1.1)" });
}
async function pollPresence() {
  if (!session || presenceBusy) return;
  presenceBusy = true;
  try {
    const queued = queueSizeSeen;
    presenceState = await api("/api/presence", "POST", {
      username: name(),
      avatar: session.avatar,
      // a page in front shows its own note, so the server need not push one
      visible: document.visibilityState === "visible",
    });
    queueSizeSeen = presenceState.queue_size;
    if (queued !== undefined && queueSizeSeen > queued) queueJoinedToast();
    // a display name changed on another device follows you here
    if (session.account && presenceState.username && presenceState.username !== session.username)
      saveName(presenceState.username);
    renderQueueBanner();
    // a tournament match that is ready takes its players to their table
    await followTournament();
    if (presenceState.queue?.notice) toast(presenceState.queue.notice);
    if (
      presenceState.queue?.status === "matched" &&
      presenceState.queue.room_id !== session.room_id
    )
      await enterQueueMatch();
    if (
      presenceState.queue?.status === "offer" &&
      state &&
      !state.solo &&
      session.room_id === state.id &&
      state.status !== "closed"
    )
      presenceState.queue = { status: "off" };
    renderSocial();
  } catch {
  } finally {
    presenceBusy = false;
  }
}
/** Ranked queue notifications, with Golf open: a toast when someone joins the
 * queue, unless you are in it yourself or playing someone. */
function queueJoinedToast() {
  if (!alertsWanted(prefs).queue || document.visibilityState !== "visible") return;
  if (presenceState.queue?.status !== "off") return;
  if (page === "room" && state && !state.solo && state.status !== "closed") return;
  toast("Someone joined the Ranked queue. Tap Ranked to play them.");
}
document.getElementById("social-dialog").addEventListener("cancel", (event) => {
  if (socialMode === "queue") {
    event.preventDefault();
    hiddenQueueOffer = presenceState.queue.id;
    closeSocial();
    return;
  }
  closeSocial();
});

/* ---------- home ---------- */
/* ---------- "what's new" ----------
   The patch this device last played on is remembered; when the game has been
   updated since, a small chip above Play with Friends points to the notes. */
function seenPatch() {
  try {
    const seen = localStorage.getItem("golf-played-patch");
    if (seen) return seen;
    // a device that played before this chip existed: its last patch was an older one
    const returning = ["golf-name", "golf-avatar", "golf-prefs"].some((key) => localStorage.getItem(key));
    return returning ? "earlier" : null;
  } catch {
    return null;
  }
}
function markPatchSeen() {
  try {
    if (session?.patch) localStorage.setItem("golf-played-patch", session.patch);
  } catch {}
  // a signed-in player is not shown the same notes again on their other devices
  if (session?.patch && session.account && prefs.patchSeen !== session.patch) setPref("patchSeen", session.patch);
}
/** One patch's notes, as the Patch notes page and the new-patch popup both list them. */
function patchNotesHtml(patch) {
  const list = (title, items) =>
    items?.length ? `<h3 style="margin-top:1.2rem">${title}</h3>${items.map((note) => `<p>• ${e(note)}</p>`).join("")}` : "";
  // (a patch may sort its changes under headings of its own)
  const sections = (patch.sections || []).map((section) => list(e(section.title), section.notes)).join("");
  return `${list(patch.labels?.revisions || "Rule revisions", patch.rules?.revisions)}${list(patch.labels?.additions || "Rule additions", patch.rules?.additions)}${sections}${list(patch.labels?.changes || "Play and interface", patch.changes)}`;
}
/* The first time someone opens Golf on a new patch, its notes pop up over the
   home screen, with an x on the corner and "Start golfing!" at the foot. A
   first visit has nothing to catch up on, so it sees none. */
let patchPopupDone = false;
async function patchPopup() {
  const current = session?.patch;
  const seen = seenPatch();
  if (patchPopupDone || !current || !seen || seen === current || prefs.patchSeen === current) return;
  patchPopupDone = true;
  let patch;
  try {
    patch = (await api("/api/patch-notes")).patches.find((item) => item.version === current);
  } catch {}
  if (!patch || page !== "home") {
    patchPopupDone = false; // not shown: try again the next time the home screen is up
    return;
  }
  let dialog = document.getElementById("patch-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "patch-dialog";
    dialog.className = "social-dialog leave-dialog patch-dialog";
    dialog.setAttribute("aria-labelledby", "patch-dialog-title");
    dialog.addEventListener("close", () => {
      markPatchSeen();
      document.querySelector(".patch-chip")?.remove();
    });
    // a tap outside the card closes it too
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
    document.body.append(dialog);
  }
  dialog.innerHTML = `<button type="button" class="dialog-x" data-patch-close aria-label="Close">${icon("xmark.circle.fill", 26)}</button><span class="pill">New update</span><h2 id="patch-dialog-title">Patch ${e(current)}</h2><div class="patch-notes">${patchNotesHtml(patch)}</div><div class="dialog-actions"><button type="button" class="btn c-p3 grow" data-patch-close>${tilted("figure.golf", 28)}<span>Start golfing!</span></button></div>`;
  if (!dialog.open) dialog.showModal();
}
function closePatchPopup() {
  document.getElementById("patch-dialog")?.close();
}
function patchChip() {
  const seen = seenPatch();
  // a first visit has nothing to compare with: it starts from this patch
  if (!seen) {
    markPatchSeen();
    return "";
  }
  if (!session?.patch || seen === session.patch) return "";
  return `<button type="button" class="chip patch-chip c-p4" data-nav="patches">${icon("newspaper.fill", 20, { idle: false })}<span>Updated to ${e(session.patch.replace(/\.0$/, ""))}: see what's new</span>${glyph("chevron.right", 12)}</button>`;
}
/** Back to the home screen (on `tab`; Play unless told), leaving any table or game being watched. */
function home(tab = "play") {
  leaveAfterSignIn = null;
  stopWatching();
  setDebugTool(null);
  clearEmotes();
  emoteTable = "";
  state = null;
  closeSocket();
  homePage(tab);
}
/** One setting's row: its name, and its value in a pill that lights up when on. */
const prefRow = (key, symbol, label, value, on, lit = on, disabled = false) =>
  `<button type="button" class="btn c-fw pref" role="switch" aria-checked="${on}" data-pref="${key}"${disabled ? " disabled" : ""}>${tilted(symbol, 26)}<span class="grow">${label}</span><b class="pref-value${lit ? " on" : ""}">${value}</b></button>`;
const onOff = (on) => (on ? "On" : "Off");
/** On/off and choice rows for the settings kept on this device. */
function prefsHtml() {
  const row = prefRow;
  const theme = THEMES.find(([key]) => key === prefs.theme) || THEMES[0];
  const rows = [
    // (not a switch: it opens the themes' own sheet)
    `<button type="button" class="btn c-fw pref" data-theme-settings>${tilted("paintpalette.fill", 26)}<span class="grow">Theme</span><b class="pref-value on">${e(theme[1])}</b></button>`,
    row("contrastCards", "suit.diamond.fill", "High contrast cards", onOff(prefs.contrastCards), !!prefs.contrastCards),
    row("autoQueue", "sparkles", "Join Ranked on open", onOff(prefs.autoQueue), prefs.autoQueue),
    row("confirm", "checkmark.circle.fill", "Confirm moves", onOff(prefs.confirm), prefs.confirm),
    // stored as hideTips (so existing choices carry over), shown the positive way round
    row("hideTips", "text.bubble.fill", "Show tooltips", onOff(!prefs.hideTips), !prefs.hideTips),
    row("showOdds", "dice.fill", "Show win chances", onOff(prefs.showOdds), prefs.showOdds),
    // (the stickers stop drifting, and screens change without sliding)
    row("reduceMotion", "tortoise.fill", "Reduce motion", onOff(prefs.reduceMotion), !!prefs.reduceMotion),
  ];
  if (hapticsAvailable)
    rows.push(row("haptics", "hand.tap.fill", "Haptics", onOff(prefs.haptics), prefs.haptics));
  // controller settings show on anything that is not a bare touchscreen
  if (PAD.connected || !touchDevice)
    rows.push(
      row("padDrag", "gamecontroller.fill", "Controller: trigger drag", prefs.padDrag === "toggle" ? "Toggle" : "Hold", prefs.padDrag === "toggle", true),
    );
  return `<h3>Preferences</h3><div class="menu-list" data-prefs>${rows.join("")}</div>`;
}
/* ---------- turn and Ranked queue notifications ----------
   The Notifications page has one switch for them all and one for each kind;
   a kind is sent only while both its switch and the main one are on.
   With turn notifications on, the server pushes a "your turn" notification
   (which also buzzes phones that allow it) whenever your turn comes while Golf
   is in the background. With Ranked queue notifications on, it pushes one when
   someone joins the Ranked queue while you are away (at most every ten
   minutes), and an open page shows a toast instead. Both share this browser's
   one push subscription, which tells the server which of the two it wants. */
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
function pushKeyBytes(key) {
  const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "="));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
/** Subscribe this browser to notifications (asking permission first, when `ask`). */
async function subscribeAlerts(ask, wanted = alertsWanted(prefs)) {
  if (!pushSupported()) throw new Error("This browser can't show notifications. On iPhone, add Golf to your Home Screen first.");
  const permission = ask ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") throw new Error("Notifications are blocked for Golf. Allow them in your browser's settings.");
  const registration = await navigator.serviceWorker.register(appPath("/sw.js"));
  await navigator.serviceWorker.ready;
  const { key } = await api("/api/push/key");
  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(key) }));
  await api("/api/push/subscribe", "POST", { subscription: subscription.toJSON(), turn: !!wanted.turn, queue: !!wanted.queue });
}
/**
 * On a phone, your turn also shows a short notification while Golf is open, so
 * the phone buzzes with its own alert (the only buzz some phones allow a web
 * page). Away from Golf, the server's push does the same.
 */
async function buzzTurnNotification() {
  if (!alertsWanted(prefs).turn || !touchDevice || !pushSupported() || Notification.permission !== "granted") return;
  try {
    const registration = await navigator.serviceWorker.getRegistration(appPath("/sw.js"));
    if (!registration) return;
    await registration.showNotification("Your turn in Golf", {
      body: state?.name ? `${state.name}: it's your move.` : "It's your move.",
      tag: "golf-turn",
      renotify: true,
      vibrate: [90, 70, 90],
      icon: appPath("/static/assets/icon.png"),
      data: { url: location.href },
    });
    // it has done its job once it buzzed: don't leave it lying in the tray
    setTimeout(async () => {
      for (const note of await registration.getNotifications({ tag: "golf-turn" })) note.close();
    }, 4000);
  } catch {}
}
/** Which notifications these switches send: a kind only while the main switch is on too. */
const alertsWanted = (choice) => ({ turn: !!(choice.alerts && choice.turnAlerts), queue: !!(choice.alerts && choice.queueAlerts) });
/** Flip one notification switch; the subscription goes once nothing is wanted. */
async function toggleAlerts(key) {
  const next = { alerts: prefs.alerts, turnAlerts: prefs.turnAlerts, queueAlerts: prefs.queueAlerts };
  next[key] = !next[key];
  // turning everything on with both kinds off means both
  if (key === "alerts" && next.alerts && !next.turnAlerts && !next.queueAlerts) next.turnAlerts = next.queueAlerts = true;
  const wanted = alertsWanted(next);
  try {
    if (wanted.turn || wanted.queue) await subscribeAlerts(!!next[key], wanted);
    else {
      await api("/api/push/unsubscribe", "POST");
      const registration = await navigator.serviceWorker?.getRegistration(appPath("/sw.js"));
      await (await registration?.pushManager.getSubscription())?.unsubscribe();
    }
    for (const name of ["alerts", "turnAlerts", "queueAlerts"]) setPref(name, next[name]);
    if (key === "alerts" && next.alerts) toast("Notifications are on.");
  } catch (error) {
    setPref("alerts", false);
    toast(error.message);
  }
  const holder = document.querySelector("[data-alerts]");
  if (holder) holder.outerHTML = alertsHtml();
}
function alertsHtml() {
  const off = !prefs.alerts;
  return `<div class="menu-list" data-alerts>
    ${prefRow("alerts", "bell.fill", "Notifications", onOff(prefs.alerts), !!prefs.alerts)}
    ${prefRow("turnAlerts", "hand.tap.fill", "Your turn", onOff(prefs.turnAlerts), !!prefs.turnAlerts && !off, undefined, off)}
    ${prefRow("queueAlerts", "sparkles", "Someone joins Ranked", onOff(prefs.queueAlerts), !!prefs.queueAlerts && !off, undefined, off)}
  </div>`;
}
/** Golf opened from the Home Screen (as a web app) rather than in a browser tab. */
const homeScreenApp = () => navigator.standalone === true || matchMedia("(display-mode: standalone)").matches;
function notificationsPage() {
  document.title = "Notifications · Golf";
  history.replaceState({}, "", appPath("/notifications"));
  const step = (n, text, image, alt) =>
    `<li class="guide-step"><p><b>${n}.</b> ${text}</p><img class="guide-shot" src="static/assets/${image}" alt="${alt}" loading="lazy" width="540"></li>`;
  const guide = homeScreenApp()
    ? `<section class="panel c-fw"><h2>${tilted("checkmark.circle.fill", 26)} On your Home Screen</h2><p>Golf is open from your Home Screen, so its notifications can reach you.</p></section>`
    : `<section class="panel c-p3"><h2>${tilted("house.fill", 26)} On iPhone</h2>
      <p>An iPhone only lets Golf send notifications once Golf is on your Home Screen. It takes a moment:</p>
      <ol class="guide">
        ${step(1, "In Safari, tap the <b>•••</b> button beside the address bar, then <b>Share</b>.", "home-screen-1.png", "Safari's menu, with Share near the top")}
        ${step(2, "Tap <b>Add to Home Screen</b>. If you don't see it, tap <b>View More</b> first.", "home-screen-2.png", "The share sheet, with Add to Home Screen at the bottom of its list")}
        ${step(3, "Leave <b>Open as Web App</b> on and tap <b>Add</b>. Then open Golf from your Home Screen and turn notifications on here.", "home-screen-3.png", "Add to Home Screen, with Open as Web App switched on and the Add button")}
      </ol></section>`;
  show(
    "notifications",
    `<div class="page scroll">${subHeader("Notifications")}<div class="stack wide">
      ${alertsHtml()}
      ${guide}
    </div></div>`,
  );
}
function togglePref(key) {
  if (key === "alerts" || key === "turnAlerts" || key === "queueAlerts") return toggleAlerts(key);
  if (key === "padDrag") setPref(key, prefs.padDrag === "toggle" ? "hold" : "toggle");
  else setPref(key, !prefs[key]);
  if (key === "confirm" && !prefs.confirm) cancelStaged();
  const holder = sheetRoot.querySelector("[data-prefs]");
  if (holder) holder.outerHTML = prefsHtml().replace(/^<h3>.*?<\/h3>/, "");
  const help = sheetRoot.querySelector("[data-pad-help]");
  if (help) help.outerHTML = padHelpHtml();
  if (state?.game && page === "room") renderBoard();
}
function settingsSheet() {
  openSheet(`<section class="sheet c-fw" role="dialog" aria-modal="true" aria-label="Settings">
    <div class="sheet-head"><h2>Settings</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    <div class="menu-list">
      ${session.room_id && page !== "room" ? `<button type="button" class="btn c-p1" data-nav="resume">${tilted("play.fill", 26)} Resume your table</button>` : ""}
      <button type="button" class="btn c-p1" data-nav="rules">${tilted("list.bullet.clipboard.fill", 26)} Rules</button>
      <button type="button" class="btn c-p3" data-nav="history">${tilted("clock.arrow.circlepath", 26)} Match history</button>
      <button type="button" class="btn c-p2" data-nav="notifications">${tilted("bell.fill", 26)} Notifications</button>
      ${voidOfferButton()}
      <button type="button" class="btn c-p4" data-nav="patches">${tilted("newspaper.fill", 26)} Patch notes</button>
      <a class="btn c-fw" href="privacy">${tilted("lock.fill", 26)} Privacy</a>
    </div>
    ${prefsHtml()}
    ${padHelpHtml()}
    <p class="hint dark sheet-note">This website has been programmed by Claude Fable 5.2. Front-end design was handmade in <a href="https://www.figma.com/design/OtrBljPuG5YggsJYThYGpq/Golf?node-id=114-91&amp;t=EDkY7LXjEWflPbP6-0" target="_blank" rel="noopener">Figma${textSymbol("arrow.up.right", "out-arrow")}</a> by Spencer.</p>
  </section>`);
}
/* ---------- Settings > Theme: every theme, drawn in its own colors ----------
   Each theme's row carries that theme's color tokens (read from the
   stylesheet), so the row and the small preview in it show the theme as it
   looks: the table, a card, and the first four players' colors. */
const themeTokenCache = {};
/** A theme's color tokens as inline CSS: whatever wears them is drawn in that theme. */
function themeTokens(key) {
  if (key in themeTokenCache) return themeTokenCache[key];
  const tokens = new Map();
  try {
    for (const sheet of document.styleSheets || [])
      for (const rule of sheet.cssRules || []) {
        const selector = rule.selectorText || "";
        // the tokens every theme starts from, then the ones this theme changes
        const base = selector === ":root";
        const themed = /^:root(\[data-theme="[\w-]+"\]|:is\([^)]*\))$/.test(selector) && selector.includes(`[data-theme="${key}"]`);
        if (!base && !themed) continue;
        for (const name of rule.style) if (name.startsWith("--")) tokens.set(name, rule.style.getPropertyValue(name).trim());
      }
  } catch {} // (a stylesheet that can't be read: the rows keep the theme in use)
  tokens.delete("--u"); // the page's own scale
  return (themeTokenCache[key] = [...tokens].map(([name, value]) => `${name}:${value}`).join(";"));
}
function themeListHtml() {
  const chosen = (THEMES.find(([key]) => key === prefs.theme) || THEMES[0])[0];
  return `<div class="theme-list" role="radiogroup" aria-label="Theme" data-themes>${THEMES.map(
    ([key, name]) =>
      `<button type="button" class="theme-choice" role="radio" aria-checked="${key === chosen}" data-theme-pick="${key}" style="${e(themeTokens(key))}"><span class="theme-preview" aria-hidden="true"><span class="tp-card"></span>${[1, 2, 3, 4].map((p) => `<i style="background:var(--p${p})"></i>`).join("")}</span><span class="grow">${e(name)}</span>${key === chosen ? icon("checkmark.circle.fill", 30, { idle: false }) : ""}</button>`,
  ).join("")}</div>`;
}
function themeSheet() {
  openSheet(`<section class="sheet c-fw" role="dialog" aria-modal="true" aria-label="Theme">
    <div class="sheet-head"><h2>Theme</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    ${themeListHtml()}
  </section>`);
}
function pickTheme(key) {
  if (!THEMES.some(([name]) => name === key)) return;
  setPref("theme", key);
  const holder = sheetRoot.querySelector?.("[data-themes]");
  if (holder) holder.outerHTML = themeListHtml();
  if (state?.game && page === "room") renderBoard();
}
/* ---------- Settings > Emotes: which emotes are on the bar ----------
   Each kind (faces, sayings) has its bar and the emotes left off it. A tap on
   one left off adds it to the end of the bar. On the bar, a tap chooses an
   emote: its x then takes it off, and a tap on another trades their places.
   An emote can also be dragged: along the bar, onto it or off it. Every emote
   slides to wherever a change leaves it. */
let emotePick = null; // [kind, id] of the emote chosen on the bar
/**
 * The emote editor (on the You tab): one Emote Bar box and one Unequipped box,
 * each a row of faces over a row of sayings.
 */
function emoteEditHtml() {
  const item = (kind, id, on) => {
    const picked = on && emotePick?.[0] === kind && emotePick[1] === id;
    const name = emoteNames[id];
    const label = on ? `${name}${picked ? ", chosen" : ""}` : `Add ${name} to your bar`;
    return `<span class="emote-item" data-emote-item="${kind}:${id}"><button type="button" class="emote-choice${kind === "words" ? " emote-word" : ""}" data-emote-pick="${kind}:${id}" ${on ? `aria-pressed="${picked}"` : ""} aria-label="${e(label)}">${kind === "words" ? e(name) : `<img src="${appPath(`/static/emotes/${id}.png`)}" alt="" draggable="false">`}</button>${picked ? `<button type="button" class="emote-remove" data-emote-drop="${kind}:${id}" aria-label="Take ${e(name)} off your bar">${icon("xmark.circle.fill", 26, { idle: false })}</button>` : ""}</span>`;
  };
  const spareOf = (kind) => EMOTE_KINDS[kind][1].filter((id) => !emoteBar(kind).includes(id));
  const row = (kind, onBar, none) => {
    const ids = onBar ? emoteBar(kind) : spareOf(kind);
    return `<div class="emote-choices${onBar ? " bar" : ""} ${kind}" data-kind="${kind}" role="group" aria-label="${kind === "faces" ? "Face" : "Text"} emotes ${onBar ? "on your bar" : "not on your bar"}"><span class="emote-none">${none}</span>${ids.map((id) => item(kind, id, onBar)).join("")}</div>`;
  };
  const unequipped = spareOf("faces").length + spareOf("words").length;
  return `<div data-emote-edit class="emote-compact">
    <section class="emote-box on"><span class="box-label">Emote Bar</span>${row("faces", true, "No faces on your bar")}${row("words", true, "No sayings on your bar")}</section>
    <section class="emote-box off${unequipped ? "" : " empty"}"><span class="box-label">Unequipped Emotes</span>${row("faces", false, "")}${row("words", false, "")}${unequipped ? "" : `<p class="emote-all">Every emote is on your bar.</p>`}</section>
    <p class="hint dark emote-tip">Tap to add or swap, hold and drag to reorder.</p>
  </div>`;
}
/** Change the editor; every emote but the one `held` slides from where it was to where it is now. */
/** Where the emote editor is: the page (the You tab). */
const emoteScope = () => root;
function slideEmotes(change, held = null) {
  const items = () => [...(emoteScope().querySelectorAll?.("[data-emote-item]") || [])];
  const was = new Map(items().map((el) => [el.dataset.emoteItem, el.getBoundingClientRect()]));
  change();
  for (const el of items()) {
    const from = was.get(el.dataset.emoteItem);
    if (!from || el === held || !el.animate) continue;
    // (one still sliding starts again from where it has got to, measured against where it will rest)
    for (const running of el.getAnimations?.() || []) running.cancel();
    el.style.zIndex = "";
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left,
      dy = from.top - to.top;
    if ((!dx && !dy) || reducedMotion.matches) continue;
    el.style.zIndex = 2; // over the ones it passes
    el.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], { duration: 420, easing: "cubic-bezier(0.3, 0.75, 0.3, 1.12)" }).onfinish = () => (el.style.zIndex = "");
  }
}
/** Draw the editor again as the saved bars have it. */
function redrawEmoteEdit() {
  slideEmotes(() => {
    const holder = emoteScope().querySelector?.("[data-emote-edit]");
    if (holder) holder.outerHTML = emoteEditHtml();
  });
}
function saveEmoteBar(kind, bar) {
  emotePick = null;
  setPref(EMOTE_KINDS[kind][0], bar.join(","));
  if (state?.game && page === "room") renderBoard(); // the bar at the table follows
}
/** A tap on an emote in Settings > Emotes. */
function pickEmote(kind, id) {
  const bar = emoteBar(kind);
  const first = emotePick?.[0] === kind ? emotePick[1] : null;
  if (!bar.includes(id)) saveEmoteBar(kind, [...bar, id]); // one left off joins the end
  else if (first && first !== id) {
    // two on the bar take each other's place
    const a = bar.indexOf(first),
      b = bar.indexOf(id);
    [bar[a], bar[b]] = [bar[b], bar[a]];
    saveEmoteBar(kind, bar);
  } else emotePick = first === id ? null : [kind, id];
  redrawEmoteEdit();
}
/** The x on a chosen emote: it comes off the bar. */
function dropEmote(kind, id) {
  saveEmoteBar(kind, emoteBar(kind).filter((other) => other !== id));
  redrawEmoteEdit();
}
/* Dragging in Settings > Emotes. A mouse carries an emote once it has moved a
   little; a finger holds it for a moment first, so a swipe that starts on an
   emote still scrolls the sheet. Carried, the emote is put down in the page
   wherever it is over (the others slide out of its way), and the bar is saved
   as it stands when the emote is let go. */
let emoteDrag = null;
let emoteDragEnded = 0; // when a carried emote was last let go: the click that follows is no tap
const emoteBoxes = (kind) => {
  const edit = emoteScope().querySelector?.("[data-emote-edit]");
  return [edit?.querySelector(`.emote-choices.bar[data-kind="${kind}"]`), edit?.querySelector(`.emote-choices:not(.bar)[data-kind="${kind}"]`)];
};
function liftEmote(drag) {
  const box = drag.el.getBoundingClientRect();
  drag.active = true;
  drag.grab = { x: drag.x - box.left, y: drag.y - box.top }; // where on the emote it is held
  drag.el.classList.add("dragging");
  haptic("snap");
}
/** Put the carried emote down in the page where the pointer is: true if that moved it. */
function placeEmote(drag, x, y) {
  const [bar, spare] = emoteBoxes(drag.kind);
  if (!bar || !spare) return false;
  const over = (box) => {
    const r = box.getBoundingClientRect();
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };
  // (on the You tab the rows share a box each: anywhere in the box puts it in that kind's row)
  const zone = (row) => row.closest(".emote-box") || row;
  const box = over(zone(spare)) ? spare : over(zone(bar)) ? bar : drag.el.parentElement;
  const idOf = (el) => el.dataset.emoteItem.split(":")[1];
  const others = [...box.querySelectorAll("[data-emote-item]")].filter((el) => el !== drag.el);
  let before;
  if (box === spare) {
    // off the bar, emotes keep their usual order
    const all = EMOTE_KINDS[drag.kind][1];
    before = others.find((el) => all.indexOf(idOf(el)) > all.indexOf(drag.id));
  } else
    // on the bar: ahead of the first emote the pointer comes before, reading the rows in order
    before = others.find((el) => {
      const r = el.getBoundingClientRect();
      return y < r.top || (y <= r.bottom && x < r.left + r.width / 2);
    });
  before ||= null;
  if (drag.el.parentElement === box && drag.el.nextElementSibling === before) return false;
  slideEmotes(() => box.insertBefore(drag.el, before), drag.el);
  return true;
}
function emoteDragEnd(event) {
  const drag = emoteDrag;
  if (!drag || (event && event.pointerId !== drag.pointer)) return;
  clearTimeout(drag.timer);
  emoteDrag = null;
  if (!drag.active) return; // a tap, or a swipe: nothing was carried
  drag.el.classList.remove("dragging");
  if (!drag.moved) return; // picked up and put straight back: the click that follows is a tap
  emoteDragEnded = performance.now();
  const [bar] = emoteBoxes(drag.kind);
  const order = bar ? [...bar.querySelectorAll("[data-emote-item]")].map((el) => el.dataset.emoteItem.split(":")[1]) : [];
  if (bar && event?.type !== "pointercancel" && order.join() !== emoteBar(drag.kind).join()) saveEmoteBar(drag.kind, order);
  redrawEmoteEdit(); // it settles from where it was let go (called off, everything goes back)
}
document.addEventListener("pointerdown", (event) => {
  const el = event.target.closest?.("[data-emote-item]");
  if (!el || emoteDrag || event.button > 0 || event.target.closest(".emote-remove") || !el.closest("[data-emote-edit]")) return;
  const [kind, id] = el.dataset.emoteItem.split(":");
  const drag = (emoteDrag = { kind, id, el, pointer: event.pointerId, x: event.clientX, y: event.clientY, active: false, moved: false, quiet: 0 });
  if (event.pointerType === "touch") drag.timer = setTimeout(() => emoteDrag === drag && liftEmote(drag), 220);
});
document.addEventListener("pointermove", (event) => {
  const drag = emoteDrag;
  if (!drag || event.pointerId !== drag.pointer) return;
  const far = Math.hypot(event.clientX - drag.x, event.clientY - drag.y);
  if (!drag.active) {
    if (event.pointerType === "touch") {
      if (far > 8) emoteDragEnd(); // a swipe: the sheet's to scroll
      return;
    }
    if (far < 5) return;
    liftEmote(drag);
  }
  drag.moved = true;
  // (a beat between moves, so emotes still sliding aside are not measured mid-slide)
  const now = performance.now();
  if (now >= drag.quiet && placeEmote(drag, event.clientX, event.clientY)) drag.quiet = now + 140;
  // it stays under the pointer, wherever in the page it has been put
  drag.el.style.translate = "";
  const home = drag.el.getBoundingClientRect();
  drag.el.style.translate = `${event.clientX - drag.grab.x - home.left}px ${event.clientY - drag.grab.y - home.top}px`;
});
document.addEventListener("pointerup", emoteDragEnd);
document.addEventListener("pointercancel", emoteDragEnd);
// while an emote is carried, the finger moves it and not the sheet
document.addEventListener("touchmove", (event) => emoteDrag?.active && event.preventDefault(), { passive: false });
// (holding one must not open the browser's own menu for an image, or start its own drag)
for (const type of ["contextmenu", "dragstart"])
  document.addEventListener(type, (event) => event.target.closest?.("[data-emote-edit]") && event.preventDefault());
function voidOfferButton() {
  if (!state?.rated) return "";
  const disabled = state.status !== "playing" || state.void_offer || state.void_offered?.[state.viewer];
  return `<button type="button" class="btn c-p4" data-void-offer ${disabled ? "disabled" : ""}>${tilted("eject.fill", 26)} Void game &amp; end series early</button>`;
}
/* ---------- debug: change a Practice game by hand ----------
   Debug servers only. The tools change the table on the server, which then
   never records that game's result. */
const DEBUG = document.documentElement.dataset?.debug !== undefined;
let debugTool = null; // "flip" (god mode) or "edit" (suit and value), while one is on
const DEBUG_TOOLS = {
  flip: ["God mode", "Tap a card to flip it"],
  edit: ["Change a card", "Tap a card to pick its suit and value"],
};
function debugMenuHtml() {
  if (!DEBUG || !(state?.practice || state?.local || state?.debug_table) || state.spectator) return "";
  return `<p class="hint dark debug-label">Debug</p>
      <button type="button" class="btn c-p2" data-debug-end>${tilted("flag.pattern.checkered", 26)} End game: flip all cards</button>
      <button type="button" class="btn c-p1" data-debug-tool="flip">${tilted("sparkles", 26)} God mode: flip any card</button>
      <button type="button" class="btn c-p4" data-debug-tool="edit">${tilted("pencil", 26)} Change a card's suit and value</button>`;
}
async function debugEdit(body) {
  accept(await api(`/api/debug/practice/${state.id}`, "POST", body));
}
function setDebugTool(tool) {
  debugTool = tool;
  document.querySelector(".debug-bar")?.remove();
  if (!tool) return;
  document.body.insertAdjacentHTML(
    "beforeend",
    // made like the Quickplay queue pill: what's on, and a sticker to stop
    `<div class="debug-bar queue-pill"><span class="queue-info" role="status"><span class="queue-text"><b>${e(DEBUG_TOOLS[tool][0])}</b><small>${e(DEBUG_TOOLS[tool][1])}</small></span></span><button type="button" class="act side-act queue-leave" data-debug-done aria-label="Done"><span class="act-ico">${icon("checkmark.circle.fill", 24, { sw: 3.4 })}</span><span class="side-label">Done</span></button></div>`,
  );
}
/** The suit and value picker, made like the Beggars guess: suits, then rank stickers. */
function debugCardPicker(ref) {
  const card = state.game.players[ref[0]]?.[ref[1]]?.card;
  let suit = card?.suit || "S";
  const shade = document.createElement("div");
  shade.className = "modal-shade debug-shade";
  const draw = () => {
    shade.innerHTML = `<section class="modal panel c-p4" role="dialog" aria-modal="true" aria-label="Change a card"><button type="button" class="dialog-x" data-debug-pick="close" aria-label="Cancel">${icon("xmark.circle.fill", 26)}</button><h2>Change this card</h2><p>${card ? `Now ${e(card.label)} of ${SUIT_NAME[card.suit]}. ` : "Face down. "}Pick a suit, then a value.</p><div class="debug-suits">${["S", "H", "D", "C"]
      .map((key) => `<button type="button" class="debug-suit${key === suit ? " on" : ""}${"HD".includes(key) ? " red" : ""}" data-debug-suit="${key}" aria-pressed="${key === suit}" aria-label="${SUIT_NAME[key]}">${icon(SUIT_ICON[key], 34, { idle: false })}</button>`)
      .join("")}</div><div class="ranks">${Array.from({ length: 13 }, (_, i) => {
      const label = { 1: "A", 11: "J", 12: "Q", 13: "K" }[i + 1] || String(i + 1);
      return `<button type="button" class="rank-sticker" data-debug-rank="${i + 1}" aria-label="${label}">${stickerText(label, { key: `rank:${i}` })}</button>`;
    }).join("")}</div></section>`;
  };
  draw();
  shade.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (event.target === shade || button?.dataset.debugPick === "close") return shade.remove();
    if (button?.dataset.debugSuit) {
      suit = button.dataset.debugSuit;
      return draw();
    }
    if (button?.dataset.debugRank) {
      shade.remove();
      try {
        await debugEdit({ op: "set", ref, rank: Number(button.dataset.debugRank), suit });
      } catch (error) {
        toast(error.message);
      }
    }
  });
  document.body.append(shade);
}
// While a tool is on, a press on a hand's card is the tool's, not the game's.
document.addEventListener(
  "pointerdown",
  (event) => {
    if (!debugTool || page !== "room" || !state?.game) return;
    const slot = event.target.closest?.("[data-board] .slot");
    if (!slot) return;
    const ref = JSON.parse(slot.dataset.ref);
    if (!Number.isInteger(ref[0])) return; // the piles stay as they are
    event.preventDefault();
    event.stopPropagation();
    if (debugTool === "flip") debugEdit({ op: "flip", ref }).catch((error) => toast(error.message));
    else debugCardPicker(ref);
  },
  true,
);
/**
 * A spectator's cycle button turns the whole table: the next player's hand
 * comes to the bottom, and the one that was there goes up top.
 */
function watchNextSeat() {
  if (!state?.spectator) return;
  const previous = state.viewer;
  watchSeat = (previous + 1) % state.names.length;
  state.viewer = watchSeat;
  board.viewedOpponent = previous;
  if (socket?.readyState === WebSocket.OPEN) socket.send(`seat:${watchSeat}`);
  renderRoom();
}
function gameMenuSheet() {
  const link = `${location.origin}${appPath(`/lobby/${state.id}`)}`;
  openSheet(`<section class="sheet c-fw" role="dialog" aria-modal="true" aria-label="Table menu">
    <div class="sheet-head"><h2>${e(state.name)}</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    <p class="hint dark" style="margin-bottom:1.2rem">${state.spectator ? "Spectating · " : ""}Game ${state.round} · ${e(matchLength(state))}${state.watchers ? ` · ${state.watchers} watching` : ""}</p>
    ${state.spectator ? `<div class="menu-list">
      <button type="button" class="btn c-p1" data-rules-for="me">${tilted("checklist", 26)} Rules &amp; scores</button>
      <button type="button" class="btn c-p4" data-nav="rules">${tilted("list.bullet.clipboard.fill", 26)} How to play</button>
      <button type="button" class="btn c-p2" data-leave>${tilted("eye.fill", 26)} Stop watching</button>
    </div>` : `<div class="menu-list">
      <button type="button" class="btn c-p1" data-rules-for="me">${tilted("checklist", 26)} Rules &amp; scores</button>
      ${state.solo ? "" : `<button type="button" class="btn c-p3" data-copy="${e(link)}">${tilted("link", 26)} Copy invite link</button>`}
      <button type="button" class="btn c-p3" data-nav="history">${tilted("clock.arrow.circlepath", 26)} Match history</button>
      <button type="button" class="btn c-p4" data-nav="rules">${tilted("list.bullet.clipboard.fill", 26)} How to play</button>
      ${voidOfferButton()}
      ${debugMenuHtml()}
      ${state.puzzle ? `<button type="button" class="btn c-p1" data-puzzle-retry>${tilted("arrow.clockwise", 26)} Restart the puzzle</button>` : ""}
      <button type="button" class="btn c-p2" data-leave>${tilted("rectangle.portrait.and.arrow.right", 26)} Leave table</button>
    </div>`}
    ${prefsHtml()}
    ${padHelpHtml()}
  </section>`);
}

/* ---------- host match setup ---------- */
const draft = {
  mode: "host",
  step: 0,
  style: "wins",
  length: 3,
  lobbyName: "Friendly Golf",
  gameType: "1v1",
  scorePreview: "on",
  showOdds: "on",
  preset: "house",
  rules: {},
  first: "random",
  rulesOpen: false,
  // Host a Tournament
  tournamentName: "Golf Tournament",
  format: "single",
  seeding: "random",
  fill: "byes",
  ranked: "off",
};
const ENTRY_STYLE = {
  tournament: { color: "c-p4", glyph: "trophy.fill" }, // Host a Tournament
  passplay: { color: "c-s7 c-passplay", glyph: "person.2.fill" }, // Pass & play (green; light green on Original)
  host: { color: "c-p1", glyph: "figure.2" }, // Play with Friends
  solo: { color: "c-p2", glyph: "dumbbell.fill" }, // Practice
};
function entryButton(attribute, label) {
  const { color, glyph: symbol } = ENTRY_STYLE[draft.mode];
  return `<button type="button" class="btn ${color} grow" ${attribute}>${tilted(symbol, 33)}<span>${padTag("y")}${label}</span></button>`;
}
function startSetup(mode) {
  Object.assign(draft, {
    mode,
    step: 0,
    style: "wins",
    length: 3,
    preset: "house",
    rules: { ...matchOptions.house_rules },
    first: "random",
    rulesOpen: false,
    gameType: "1v1",
  });
  // every match-up of a tournament is one game unless the host says otherwise
  if (mode === "tournament") draft.length = 1;
  setupPage();
}
function styleHint() {
  if (["wins", "points"].includes(draft.style) && draft.length === 1) return "One game. The lowest score wins.";
  if (draft.style === "wins")
    return `The first player to win ${Math.floor(draft.length / 2) + 1} games, is the overall winner.`;
  if (draft.style === "points")
    return `After ${draft.length} games, the player with the lowest sum of game scores is the overall winner.`;
  if (draft.style === "continuous")
    return "Play as many games as you like. The series is decided when everyone leaves.";
  return "One game. The lowest score wins.";
}
function setupPage() {
  document.title = "Host · Golf";
  const cup = draft.mode === "tournament";
  const heading = cup ? "Host a Tournament" : "Host a Table";
  // a Ranked tournament is always on House rules, so it has no rules to pick
  const ranked = cup && draft.ranked === "on";
  if (draft.step === 0) {
    const fixed = ["wins", "points"].includes(draft.style);
    // a tournament has no "Single game" style: one game is a length (and its tables never run on)
    const styles = cup
      ? [["wins", "Best of", draft.style === "wins"], ["points", "Total pts", draft.style === "points"]]
      : [["single", "Single game", draft.style === "single"], ["wins", "Best of", draft.style === "wins"], ["points", "Total pts", draft.style === "points"], ["continuous", "Play until you leave", draft.style === "continuous"]];
    const lengths = (cup ? [1, 3, 5, 9] : [3, 5, 9]).map((n) => [n, `${n} game${n === 1 ? "" : "s"}`, draft.length === n]);
    show(
      "setup",
      `<div class="page${cup ? " scroll" : ""}">${subHeader(heading, "friends")}<div class="stack wide">
      ${profileChosen() ? "" : field("Your Display Name", `<input id="username" maxlength="32" value="${e(session.username)}" autocomplete="nickname" aria-label="Your display name">`, "character.cursor.ibeam")}
      ${cup ? `${field("Tournament Name", `<input data-draft="tournamentName" maxlength="48" value="${e(draft.tournamentName)}" aria-label="Tournament name">`)}${tournamentFormatField()}` : ""}
      ${
        draft.mode === "host"
          ? `<div class="row">${field("Table Name", `<input data-draft="lobbyName" maxlength="48" value="${e(draft.lobbyName)}" aria-label="Table name">`, null, "grow")}${selectField("Players", `data-draft="gameType" aria-label="Game type"`, [["solo", "Solo", draft.gameType === "solo"], ["1v1", "1v1", draft.gameType === "1v1"], ["many", "3–32", draft.gameType === "many"]], null, "hug")}</div>${draft.gameType === "solo" ? `<p class="hint">Just you against Golfbot, with the match and rules you choose here.</p>` : ""}`
          : ""
      }
      <div class="stack"><div class="row">
        ${selectField("Match Style", `data-draft="style" aria-label="Match style"`, styles, "pointer.arrow.rays", fixed ? "hug" : "")}
        ${fixed ? selectField("Length", `data-draft="length" aria-label="Match length"`, lengths, null, "grow") : ""}
      </div><p class="hint">${e(cup ? `Every match-up: ${styleHint().replace(/^./, (letter) => letter.toLowerCase())}` : styleHint())}</p></div>
      ${cup ? tournamentSetupFields() : ""}
      ${
        (draft.mode === "host" && draft.gameType !== "solo") || cup
          ? `${infoField("preview", selectField("Score Preview", `data-draft="scorePreview" aria-label="Score preview"`, [["on", "Before Confirm", draft.scorePreview === "on"], ["off", "None", draft.scorePreview === "off"]], "eye.fill"), draft.scorePreview === "on" ? "Players see the score a swap or discard would leave them with before they confirm it." : "Scores change only once a move is confirmed.")}
            ${infoField("odds", selectField("Spectator Odds", `data-draft="showOdds" aria-label="Spectator odds"`, [["on", "Shown", draft.showOdds === "on"], ["off", "Hidden", draft.showOdds === "off"]], "dice.fill"), draft.showOdds === "on" ? "Spectators see each player's chance of winning." : "Spectators see no win chances.")}`
          : ""
      }
    </div><div class="row">${ranked && profileChosen() ? entryButton("data-setup-go", "Create Tournament") : entryButton("data-setup-next", "Continue")}</div></div>`,
    );
    return;
  }
  const rules = ranked ? `<p class="hint">A Ranked tournament is played on House rules.</p>` : `<div class="stack" data-rules-picker>${rulesPicker()}</div>`;
  const go = cup ? "Create Tournament" : `<span style="white-space:nowrap">Let<span style="letter-spacing:-0.55em">’</span>s Play!</span>`;
  show(
    "setup",
    `<div class="page">${pageHead("data-setup-back", heading)}<div class="stack wide">${profileChosen() ? "" : avatarPicker()}${rules}</div><div class="row">${entryButton("data-setup-go", go)}</div></div>`,
  );
  centerAvatar(false);
}
/** `seat` is where you will sit (0 = player 1): the chosen avatar wears that player's color. */
function avatarPicker(seat = 0, chosen = null) {
  const options = avatars.filter((avatar) => avatar.selectable);
  if (!chosen && options.length && !options.some((avatar) => avatar.id === session.avatar)) saveAvatar(options[0].id);
  const selected = chosen || session.avatar;
  // Each sticker's shadow is its own flat copy, so turning the wheel only ever
  // moves layers around and never has to redraw a textured sticker.
  const sticker = (avatar) => {
    const art = icon(avatar.icon, 44);
    return `<span class="avatar-shade">${art.replace('class="ico', 'class="ico flat')}</span>${art}`;
  };
  return `<div class="avatar-pick ${`c-s${seat % 8}`}"><span class="pointer">${icon("chevron.down", 30, { idle: false, style: "--fill:var(--fw3);--stroke:var(--fw)", sw: 4 })}</span><div class="avatar-strip" role="radiogroup" aria-label="Avatar"><div class="avatar-track" role="presentation" style="--stops:${options.length - 1}"><div class="avatar-stage" role="presentation">${options.map((avatar) => `<button type="button" class="avatar" role="radio" aria-checked="${avatar.id === selected}" aria-label="${e(avatar.name)}" data-avatar="${e(avatar.id)}">${sticker(avatar)}</button>`).join("")}</div><div class="avatar-stops" aria-hidden="true">${options.map(() => "<i></i>").join("")}</div></div></div><p class="avatar-name">Select Your Avatar</p></div>`;
}
/**
 * The avatar wheel. The strip is a plain horizontal scroller (so touch, wheel
 * and snapping stay native), but the avatars themselves sit on a stage that
 * does not scroll: each frame they are placed on the rim of a big wheel from
 * the scroll position alone. The one under the pointer is upright and largest;
 * the rest fall away along the arc, turning, shrinking and softening.
 */
const wheel = { strip: null, shown: 0, frame: 0, clock: 0, pitch: 0 };
const wheelPitch = (strip) =>
  strip.querySelector(".avatar-stops i")?.offsetWidth || 1;
function paintWheel(strip, position) {
  const items = strip.querySelectorAll(".avatar");
  const pitch = wheel.pitch || (wheel.pitch = wheelPitch(strip));
  const turn = 5.2; // wheel radius, in avatar spacings
  // the avatar nearest the pointer takes your color as soon as it is the
  // closest one, well before the wheel comes to rest on it
  const near = Math.round(position / pitch);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.wheelNear !== (i === near))
      item.classList.toggle("near", (item.wheelNear = i === near));
    const away = i - position / pitch;
    const steps = Math.abs(away);
    const angle = clamp(away / turn, -1.2, 1.2);
    const x = pitch * turn * Math.sin(angle);
    const y = pitch * turn * (1 - Math.cos(angle));
    const scale =
      (1 + Math.max(0, 1 - steps) * 0.35) * (1 - Math.min(0.35, steps * 0.08));
    const blur = Math.max(0, steps - 1.2) * 1.4;
    const style = item.style;
    style.transform = `translate(${x.toFixed(2)}px, ${y.toFixed(2)}px) rotate(${angle.toFixed(4)}rad) scale(${scale.toFixed(4)})`;
    style.opacity =
      steps > turn * 1.2 ? "0" : clamp(1 - (steps - 1.7) * 0.45, 0.25, 1).toFixed(3);
    const soft = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "";
    if (item.wheelSoft !== soft) style.filter = item.wheelSoft = soft;
    const layer = String(50 - Math.round(steps * 10));
    if (item.wheelLayer !== layer) style.zIndex = item.wheelLayer = layer;
    // the shadow keeps falling down-right on screen as its sticker turns
    const reach = 0.3;
    item.firstElementChild.style.transform = `translate(${(reach * (Math.cos(angle) + Math.sin(angle))).toFixed(3)}rem, ${(reach * (Math.cos(angle) - Math.sin(angle))).toFixed(3)}rem)`;
  }
}
/** Ease the drawn wheel toward the scroll position, so uneven input stays fluid. */
function stepWheel(now) {
  wheel.frame = 0;
  const strip = wheel.strip;
  if (!strip?.isConnected) return;
  const elapsed = clamp(now - wheel.clock, 4, 50);
  wheel.clock = now;
  const target = strip.scrollLeft;
  const gap = target - wheel.shown;
  wheel.shown =
    Math.abs(gap) < 0.25 ? target : wheel.shown + gap * (1 - Math.exp(-elapsed / 28));
  // a tick as each avatar passes under the pointer
  const notch = Math.round(wheel.shown / (wheel.pitch || wheelPitch(strip)));
  if (notch !== wheel.notch) {
    if (wheel.notch !== undefined) haptic("snap");
    wheel.notch = notch;
  }
  paintWheel(strip, wheel.shown);
  if (wheel.shown !== target) wheel.frame = requestAnimationFrame(stepWheel);
}
function layoutWheel(strip = root.querySelector(".avatar-strip"), instant = false) {
  if (!strip) return;
  if (wheel.strip !== strip) {
    wheel.strip = strip;
    wheel.pitch = 0;
    wheel.notch = undefined;
    instant = true;
  }
  if (instant)
    // the page may have been patched under the wheel, so nothing it set is assumed
    strip.querySelectorAll(".avatar").forEach((item) => (item.wheelNear = item.wheelSoft = item.wheelLayer = undefined));
  if (instant || reducedMotion.matches) {
    wheel.shown = strip.scrollLeft;
    paintWheel(strip, wheel.shown);
  } else if (!wheel.frame) {
    wheel.clock = performance.now() - 8;
    wheel.frame = requestAnimationFrame(stepWheel);
  }
}
function centerAvatar(smooth = true) {
  const strip = root.querySelector(".avatar-strip");
  const chosen = strip?.querySelector("[aria-checked='true']");
  if (!chosen) return;
  if (wheel.strip !== strip || !smooth) wheel.pitch = 0;
  const index = [...strip.querySelectorAll(".avatar")].indexOf(chosen);
  strip.scrollTo({
    left: index * wheelPitch(strip),
    behavior: smooth ? "smooth" : "instant",
  });
  layoutWheel(strip, !smooth);
}
function pickAvatar(id, scroll = true) {
  // a pass & play player's pick is theirs, not this device's own avatar
  if (page === "passplay" && passStep > 0) passPlayers[passStep - 1].avatar = id;
  else saveAvatar(id);
  // (the Profile page and the You tab save it as it is picked)
  if (document.getElementById("account-display-name")) saveProfile();
  root.querySelectorAll(".avatar").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.avatar === id));
  });
  if (scroll) centerAvatar();
}
let avatarScroll;
root.addEventListener(
  "scroll",
  (event) => {
    const strip = event.target;
    if (!strip.classList?.contains("avatar-strip")) return;
    layoutWheel(strip);
    clearTimeout(avatarScroll);
    // whichever avatar rests under the pointer arrow becomes the selection
    avatarScroll = setTimeout(() => {
      if (!strip.isConnected) return;
      const items = strip.querySelectorAll(".avatar");
      const best =
        items[clamp(Math.round(strip.scrollLeft / wheelPitch(strip)), 0, items.length - 1)];
      if (best && best.getAttribute("aria-checked") !== "true")
        pickAvatar(best.dataset.avatar, false);
    }, 90);
  },
  true,
);
// A vertical scroll over the wheel turns it, one avatar a step: up goes left,
// down goes right (a sideways scroll already moves it natively).
let wheelSpin = 0,
  wheelSpinAt = 0;
root.addEventListener(
  "wheel",
  (event) => {
    const strip = event.target.closest?.(".avatar-strip");
    if (!strip || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
    event.preventDefault();
    const now = performance.now();
    if (now - wheelSpinAt > 250) wheelSpin = 0; // a new gesture starts fresh
    wheelSpinAt = now;
    wheelSpin += event.deltaMode === 1 ? event.deltaY * 40 : event.deltaY;
    if (Math.abs(wheelSpin) < 40) return;
    const step = Math.sign(wheelSpin);
    wheelSpin = 0;
    const items = strip.querySelectorAll(".avatar");
    const pitch = wheelPitch(strip);
    const at = clamp(Math.round(strip.scrollLeft / pitch) + step, 0, items.length - 1);
    strip.scrollTo({ left: at * pitch, behavior: reducedMotion.matches ? "instant" : "smooth" });
  },
  { passive: false },
);
// The stage never scrolls, so tabbing to an avatar has to turn the wheel to it.
root.addEventListener("focusin", (event) => {
  const button = event.target;
  if (
    button.matches?.(".avatar:focus-visible") &&
    button.getAttribute("aria-checked") !== "true"
  )
    pickAvatar(button.dataset.avatar);
});
function rulesPicker() {
  const count = catalog.filter((rule) => draft.rules[rule.key]).length;
  const locked = draft.gameType === "many" || draft.preset === "house";
  const presets = [
    ["random", "Random", "dice.fill"],
    ["house", "House", "house.fill"],
    ["vanilla", "Vanilla", "checkmark.seal.text.page.fill"],
  ];
  const row = (rule) =>
    `<button type="button" class="rule-row" role="checkbox" aria-checked="${!!draft.rules[rule.key]}" data-draft-rule="${e(rule.key)}" title="${e(rule.description)}">${tilted(draft.rules[rule.key] ? "checkmark.circle.fill" : "circle.fill", 24, { idle: false, sw: 2.5, cls: draft.rules[rule.key] ? "" : "bare" })}<span>${e(rule.name)}${NEW_RULES.includes(rule.key) ? ` <span class="new-tag">NEW</span>` : ""}</span></button>`;
  const group = (title, rules) =>
    rules.length
      ? `<div class="rule-group"><h4>${title}</h4>${rules.map(row).join("")}</div>`
      : "";
  const on = catalog.filter((rule) => draft.rules[rule.key]);
  const off = catalog.filter((rule) => !draft.rules[rule.key]);
  const closed = !draft.rulesOpen;
  return `<div class="rules-box ${draft.rulesOpen ? "open" : ""}"><span class="label">Rules in Play</span>
    <button type="button" class="rules-head" data-rules-toggle aria-expanded="${draft.rulesOpen}"><span>${tilted("checklist", 24)} ${count} rule${count === 1 ? "" : "s"} in play</span><span class="chev">${glyph("chevron.right", 20)}</span></button>
    <div class="collapse ${draft.rulesOpen ? "open" : ""}" data-rules-open><div ${closed ? "inert" : ""}><div class="rules-body">
      <div class="chips" style="justify-content:space-around">${presets.map(([key, label, symbol]) => `<button type="button" class="rule-row" style="flex-direction:column;gap:1.4rem;color:var(--fw-text)" data-preset="${key}" aria-pressed="${draft.preset === key}">${tilted(symbol, 52, { tilt: key === "house" ? 6 : -6, style: draft.preset === key ? "--fill:var(--p1b);--stroke:var(--p1)" : "" })}<span>${label}${key === "house" ? " Rules" : ""}</span></button>`).join("")}</div>
      ${group("In-Play", on)}${group("Popular", off.filter((rule) => POPULAR_RULES.includes(rule.key)))}${group("Others", off.filter((rule) => !POPULAR_RULES.includes(rule.key)))}
      ${selectField("Who goes first", `data-draft="first" aria-label="Who goes first?" ${locked ? "disabled" : ""}`, Object.entries(starter).filter(([key]) => draft.mode !== "tournament" || !["host", "guest"].includes(key)).map(([key, label]) => [key, ((draft.mode === "solo" || draft.gameType === "solo") && { host: "You first", guest: "Golfbot first" }[key]) || label, (locked ? "random" : draft.first) === key]), null, `compact${locked ? " locked" : ""}`)}
      ${locked ? `<p class="hint dark">${draft.gameType === "many" ? "Turn order is shuffled each game at big tables." : "House rules always pick a random first player."}</p>` : ""}
    </div></div></div></div>
    <div class="collapse ${closed ? "open" : ""}" data-rules-closed><div ${closed ? "" : "inert"}><div class="rules-closed"><div class="chips">${presets.map(([key, label, symbol]) => `<button type="button" class="chip" data-preset="${key}" aria-pressed="${draft.preset === key}">${tilted(symbol, 24)}<span>${label}</span></button>`).join("")}</div><p class="hint">${e(rulesSummary(draft.rules))}</p></div></div></div>`;
}
/** Open or close the dropdown in place so the height change can animate. */
function toggleRulesPicker() {
  draft.rulesOpen = !draft.rulesOpen;
  const holder = root.querySelector("[data-rules-picker]");
  const box = holder.querySelector(".rules-box");
  box.classList.toggle("open", draft.rulesOpen);
  box.querySelector("[data-rules-toggle]").setAttribute("aria-expanded", draft.rulesOpen);
  for (const [name, open] of [
    ["[data-rules-open]", draft.rulesOpen],
    ["[data-rules-closed]", !draft.rulesOpen],
  ]) {
    const part = holder.querySelector(name);
    part.classList.toggle("open", open);
    part.firstElementChild.toggleAttribute("inert", !open);
  }
  if (draft.rulesOpen) {
    // the rule rows cascade in as the list unfolds
    box.querySelectorAll(".rule-row").forEach((row, i) => row.style.setProperty("--i", i));
    box.classList.add("opening");
    setTimeout(() => box.classList.remove("opening"), 900);
  }
}
function refreshRulesPicker() {
  const holder = root.querySelector("[data-rules-picker]");
  if (holder) holder.innerHTML = rulesPicker();
}
function applyPreset(preset) {
  draft.preset = preset;
  if (preset === "house") draft.rules = { ...matchOptions.house_rules };
  else if (preset === "vanilla")
    // the classic game: base scoring plus the J-J / Q-Q bonus swap
    draft.rules = Object.fromEntries(
      catalog.map((rule) => [rule.key, rule.key === "royal_pairs"]),
    );
  else {
    draft.rules = Object.fromEntries(
      catalog.map((rule) => [rule.key, Math.random() < 0.45]),
    );
    if (!Object.values(draft.rules).some(Boolean))
      draft.rules[catalog[Math.floor(Math.random() * catalog.length)].key] = true;
  }
  refreshRulesPicker();
}
/**
 * Play solo has no lobby: it picks up the saved game if there is one, or else
 * starts a House rules game against Golfbot straight away.
 */
async function playSolo() {
  const epoch = tableEpoch;
  if (document.getElementById("username")) saveName(name());
  const next = await api("/api/solo", "POST", {
    practice: true,
    best_of: null,
    username: session.username,
    avatar: session.avatar,
    house_rules: true,
  });
  if (epoch === tableEpoch) enterRoom(next);
}
/* ---------- spectate ----------
   Any game in play can be watched, from its first seat, with no moves. A
   spectator can send emotes (every one shows as "Spectator"). When the table
   closes, the spectator follows its players to the next game they start. */
let watching = null, // the table being watched
  watchSeat = 0, // whose seat the spectator sees the table from (their hand at the bottom)
  followTimer = 0;
async function watchGame(id) {
  const next = await api(`/api/spectate/${id}`, "POST", {});
  enterWatch(next);
}
function enterWatch(next) {
  clearTimeout(followTimer);
  if (watching !== next.id) watchSeat = 0;
  watching = next.id;
  page = "room";
  history.replaceState({}, "", appPath("/spectate"));
  board.selected = [];
  state = null;
  accept(next);
  connectRoom(next.id);
}
/** Keep watching: the same table while it's open, else the players' next game. */
async function followWatched() {
  clearTimeout(followTimer);
  const id = watching;
  if (!id) return;
  try {
    const next = await api("/api/spectate-follow", "POST", {});
    if (watching !== id) return;
    if (next.id !== id) {
      toast(`Following ${next.names.filter((_, p) => p !== 1 || !next.solo).join(" & ")} to their next game`);
      return enterWatch(next);
    }
    accept(next);
    if (next.status !== "closed" && socket?.readyState !== WebSocket.OPEN) connectRoom(id);
    if (next.status === "closed") followTimer = setTimeout(followWatched, 4000);
  } catch {
    // nobody has sat down again yet: look again shortly
    if (watching === id) followTimer = setTimeout(followWatched, 4000);
  }
}
function stopWatching() {
  clearTimeout(followTimer);
  if (!watching) return;
  watching = null;
  closeSocket();
  state = null;
  api("/api/spectate-stop", "POST", {}).catch(() => {});
}
/* ---------- pass & play (from Settings) ----------
   Everyone takes turns on this one device: the table always shows whoever is
   up, with a "pass it on" card between turns. Nothing is saved or rated. */
// the table being set up: one entry a player, and which screen is showing
// (0 picks the player count and rules; 1..n are each player's profile)
let passPlayers = null,
  passStep = 0;
function passPlayPage(step = passStep) {
  page = "passplay";
  document.title = "Pass & Play · Golf";
  closeSheet();
  if (!passPlayers) {
    passPlayers = [
      { name: session.username || "Player 1", avatar: session.avatar },
      { name: "Player 2", avatar: null },
    ];
    Object.assign(draft, { mode: "passplay", preset: "house", rules: { ...matchOptions.house_rules }, first: "random", rulesOpen: false });
  }
  draft.mode = "passplay";
  draft.gameType = passPlayers.length > 2 ? "many" : "1v1";
  passStep = Math.max(0, Math.min(step, passPlayers.length));
  if (passStep === 0) {
    show(
      "passplay",
      `<div class="page scroll">${subHeader("Pass & Play", "friends")}<div class="stack wide">
      ${selectField("Players", `data-pass-count aria-label="Number of players"`, [2, 3, 4, 5, 6, 7, 8].map((n) => [n, `${n} players`, n === passPlayers.length]), "person.2.fill")}
      <div class="stack" data-rules-picker>${rulesPicker()}</div>
      <div class="row">${entryButton("data-pass-next", "Choose players")}</div>
      <p class="hint dark">Take turns on this device: the table shows whoever is up. These games aren't saved and don't count toward stats, streaks or MMR.</p>
      </div></div>`,
    );
    return;
  }
  // one screen a player: their display name and avatar, in their seat's color
  const p = passStep - 1;
  const player = passPlayers[p];
  const last = passStep === passPlayers.length;
  // a player who hasn't picked starts on an avatar nobody else at the table has
  if (!player.avatar) {
    const taken = new Set(passPlayers.map((other) => other.avatar));
    player.avatar = (avatars.find((avatar) => avatar.selectable && !taken.has(avatar.id)) || avatars[0]).id;
  }
  show(
    "passplay",
    `<div class="page">${pageHead("data-pass-back")}<div class="stack wide">
    ${tabTitle(`Player ${p + 1} of ${passPlayers.length}`, "", "pass-step", `seat ${SEAT_COLORS[p % SEAT_COLORS.length]}`)}
    ${avatarPicker(p, player.avatar)}
    ${field("Display Name", `<input data-pass-name="${p}" maxlength="32" value="${e(player.name)}" autocomplete="off" aria-label="Player ${p + 1} display name">`, "character.cursor.ibeam", SEAT_COLORS[p % SEAT_COLORS.length])}
    </div><div class="row">${last ? entryButton("data-pass-start", "Start") : entryButton("data-pass-next", "Next player")}</div></div>`,
  );
  centerAvatar(false);
}
async function startPassPlay() {
  const names = passPlayers.map((player, p) => player.name.trim() || `Player ${p + 1}`);
  const house = draft.preset === "house";
  if (!(await abandonExisting())) return;
  const epoch = tableEpoch;
  const next = await api("/api/pass-play", "POST", {
    names,
    avatars: passPlayers.map((player) => player.avatar),
    house_rules: house,
    first: house ? "random" : draft.first,
    rules: Object.fromEntries(catalog.map((rule) => [rule.key, !!draft.rules[rule.key]])),
  });
  if (epoch === tableEpoch) enterRoom(next);
}
/** "Pass to …": hands the device to the player who is up, in their color. */
let passTimer = 0,
  passShown = null, // {table, seat}: whose hand is at the bottom of this device right now
  passPending = null; // the seat the device is about to be handed to
/**
 * When the turn moves on, the table keeps showing the player who just moved for
 * a beat, so their move is seen landing; then the board turns to the next
 * player and the "pass it on" card comes up together.
 */
function holdForPass(next) {
  if (next.status !== "playing" || !next.game) {
    passShown = passPending = null;
    clearTimeout(passTimer);
    document.querySelector(".pass-wait")?.remove();
    return;
  }
  const shown = passShown?.table === next.id ? passShown.seat : null;
  if (shown === next.viewer) return;
  if (shown === null) {
    // the first deal: straight to the first player's hand, then the card after the beat
    passShown = { table: next.id, seat: next.viewer };
    return passScreen(next.viewer);
  }
  const seat = next.viewer;
  next.viewer = shown; // still the last player's view, until the hand-over
  if (passPending !== seat) passScreen(seat);
}
function passScreen(seat) {
  document.querySelector(".pass-shade")?.remove();
  clearTimeout(passTimer);
  passPending = seat;
  // an invisible cover takes taps meanwhile, so nobody plays the next turn early
  const table = state?.id;
  document.body.insertAdjacentHTML("beforeend", `<div class="pass-shade pass-wait" aria-hidden="true"></div>`);
  passTimer = setTimeout(() => {
    document.querySelector(".pass-wait")?.remove();
    passPending = null;
    if (state?.id !== table || !state.local || state.status !== "playing") return;
    passShown = { table, seat };
    if (state.viewer !== seat) {
      state.viewer = seat;
      renderRoom();
    }
    showPassCard(seat);
  }, 750);
}
function showPassCard(seat) {
  document.querySelector(".pass-shade")?.remove();
  const name = state.names[seat];
  const color = SEAT_COLORS[seat % SEAT_COLORS.length];
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="modal-shade pass-shade" data-pass-ready><section class="modal panel ${color} pass-card" role="dialog" aria-modal="true" aria-label="Pass to ${e(name)}"><span class="pass-avatar">${icon(avatarIcon(state.avatars?.[seat]), 64)}</span><h2>Pass to ${e(name)}</h2><p>${state.game.phase === "setup" ? "Flip two of your cards to start." : "It's your turn."}</p><button type="button" class="btn ${color}" data-pass-ready>${padTag("y")}I'm ${e(name)}</button></section></div>`,
  );
}
async function submitSetup() {
  const epoch = tableEpoch;
  const cup = draft.mode === "tournament";
  const house = draft.preset === "house" || (cup && draft.ranked === "on");
  const requested = {
    username: session.username,
    avatar: session.avatar,
    name: draft.lobbyName.trim() || "Friendly Golf",
    best_of:
      draft.style === "continuous"
        ? null
        : draft.style === "single"
          ? 1
          : draft.length,
    series_mode: draft.style === "points" ? "points" : "wins",
    game_type: draft.gameType,
    score_preview: draft.scorePreview !== "off",
    show_odds: draft.showOdds !== "off",
    house_rules: house,
    first: house ? "random" : draft.first,
    rules: Object.fromEntries(
      catalog.map((rule) => [rule.key, !!draft.rules[rule.key]]),
    ),
  };
  if (!(await abandonExisting())) return;
  if (cup) {
    const view = await api("/api/tournaments", "POST", { ...requested, game_type: "1v1", ...tournamentSettings() });
    if (epoch !== tableEpoch) return;
    tournament = view;
    return tournamentPage(view.id);
  }
  // Solo: a table of your own against Golfbot (not the Play Solo streak run)
  const next =
    draft.gameType === "solo"
      ? await api("/api/solo", "POST", { ...requested, game_type: "1v1", practice: false })
      : await api("/api/lobbies", "POST", requested);
  if (epoch !== tableEpoch) return;
  enterRoom(next);
}

/* ---------- play with friends: browse, join, wait ---------- */
let pendingLeaveResolve = null;
let leaveAfterSignIn = null;
function resolveLeavePrompt(choice) {
  document.getElementById("leave-dialog")?.close();
  const resolve = pendingLeaveResolve;
  pendingLeaveResolve = null;
  resolve?.(choice);
}
function leavePrompt(leaving) {
  if (pendingLeaveResolve) return Promise.resolve("stay");
  let dialog = document.getElementById("leave-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "leave-dialog";
    dialog.className = "social-dialog leave-dialog";
    dialog.setAttribute("aria-labelledby", "leave-title");
    dialog.setAttribute("aria-describedby", "leave-description");
    dialog.addEventListener("cancel", event => {
      event.preventDefault();
      resolveLeavePrompt("stay");
    });
    // a tap outside the card keeps playing too (the sign-in version has no Keep playing button)
    dialog.addEventListener("click", event => {
      if (event.target === dialog) resolveLeavePrompt("stay");
    });
    document.body.append(dialog);
  }
  const guestPractice = leaving.practice && !session.account;
  const title = guestPractice ? "Sign in to keep your streak" : "Leave table?";
  const description = guestPractice
    ? "Save your streak by signing in, otherwise it will be lost."
    : leaving.rated && leaving.status === "playing"
      ? `Leaving loses this game and the series, and costs you ${leaving.forfeit_mmr_loss} MMR.`
      : leaving.rated && leaving.status === "round_over"
        ? `Leaving loses the series and costs you ${leaving.forfeit_mmr_loss} MMR. Completed games are kept.`
        : leaving.tournament
          ? "Leaving gives this tournament match to your opponent."
          : leaving.rated
            ? "This ends the series early. Completed games and their ratings are kept."
            : "Your game and streak will be saved to your account so you can resume later.";
  // Leave is always the small stacked sticker on the left; the wide button beside
  // it is Sign in (a guest leaving Practice) or Keep playing
  // (blue leaving Practice, where your streak is kept or can be; red leaving a real table)
  const leaveSticker = `<button type="button" class="close-btn ${leaving.practice ? "c-p1" : "c-p2"}" data-leave-choice="leave">${icon("rectangle.portrait.and.arrow.right", 30)}<span>${padTag("x")}Leave</span></button>`;
  const actions = guestPractice
    ? `<div class="dialog-actions signin-actions">${leaveSticker}${signInButton("c-p3 grow", `${tilted("person.crop.circle.fill", 26)}<span>${padTag("y")}Sign in</span>`, `data-leave-choice="signin"`)}</div>`
    : `<div class="dialog-actions signin-actions">${leaveSticker}<button type="button" class="btn c-fw grow" data-leave-choice="stay">${padTag("b")}Keep playing</button></div>`;
  // the sign-in version is dismissed (to keep playing) by an x in its top right corner
  const dismiss = guestPractice ? `<button type="button" class="dialog-x" data-leave-choice="stay" aria-label="Keep playing">${icon("xmark.circle.fill", 26)}</button>` : "";
  dialog.innerHTML = `${dismiss}<h2 id="leave-title">${title}</h2><p id="leave-description">${description}</p>${actions}`;
  closeSheet();
  const response = new Promise(resolve => { pendingLeaveResolve = resolve; });
  dialog.showModal();
  if (guestPractice) {
    // signing in from here leaves the table once it is done (the game is saved to the account)
    leaveAfterSignIn = leaving.id;
    mountGoogleSignIn();
  }
  return response;
}
function canSignInDuringPractice() {
  return !!(session.room_id && state?.id === session.room_id && state.practice && !session.account);
}
async function finishPracticeSignIn() {
  if (!leaveAfterSignIn || !session.account?.unique_name) return false;
  const roomId = leaveAfterSignIn, epoch = tableEpoch;
  leaveAfterSignIn = null;
  if (session.room_id !== roomId || state?.id !== roomId) return true;
  await abandonExisting({confirmed:true});
  if (epoch !== tableEpoch || session.room_id !== null || state?.id !== roomId) return true;
  state = null;
  home();
  toast("Your solo game and streak are saved.");
  return true;
}
async function abandonExisting({confirmed = false} = {}) {
  const roomId = session.room_id,
    epoch = tableEpoch;
  if (roomId) {
    const leaving = state?.id === roomId ? state : await api(`/api/lobbies/${roomId}/state`);
    // a signed-in player's Practice game is saved to their account, so it just leaves;
    // a guest is offered sign-in first, and a rated table warns about the MMR cost
    const guestPractice = leaving.practice && !session.account;
    // a Ranked table (or a tournament match) always warns while its series is
    // undecided: leaving loses the series, and the game being played
    const ratedWarning = (leaving.rated || leaving.tournament) && ["playing", "round_over"].includes(leaving.status);
    if (!confirmed && (ratedWarning || guestPractice)) {
      const choice = await leavePrompt(leaving);
      if (choice === "signin") {
        // (our own button, not Google's over it: it says why, or asks Google to prompt)
        leaveAfterSignIn = roomId;
        signIn();
        return false;
      }
      if (choice === "signedin") return false; // Google signed them in: what follows leaves the table
      if (choice !== "leave") {
        leaveAfterSignIn = null;
        return false;
      }
      leaveAfterSignIn = null;
    }
    await api(`/api/lobbies/${roomId}/leave`, "POST");
    if (epoch === tableEpoch && session.room_id === roomId)
      session.room_id = null;
  }
  if (epoch === tableEpoch) closeSocket();
  return true;
}
async function friendsPage() {
  document.title = "Play with Friends · Golf";
  stopTournament();
  // (coming from a tournament or table that is gone: its address goes too)
  if (/\/(tournament|lobby)\//.test(location.pathname)) history.replaceState({}, "", appPath());
  const [lobbies, cups] = await Promise.all([api("/api/lobbies"), loadTournaments()]);
  // tournaments still gathering players sit above the tables
  const joinable = tournamentRows(cups.filter((cup) => cup.status === "open" || (cup.mine && cup.status === "live")));
  const twin = [tilted("house.fill", 34), tilted("house.fill", 34, { mirror: true })];
  show(
    "friends",
    `<div class="page">${pageHead(`data-nav="home"`, "Open Tables", refreshButton("friends"))}${
      lobbies.length || joinable
        ? `<div class="stack wide"><div class="stack"><div class="list">${joinable}${lobbies
        .map((lobby) => {
          const open = lobby.status === "waiting" && lobby.players < lobby.capacity;
          return `<button type="button" class="list-item ${open ? "c-p1" : "c-fw"}" data-lobby="${e(lobby.id)}">${avatarBadge(lobby.avatars?.[0], open ? "c-p1" : "c-fw")}<div class="grow"><strong>${e(lobby.name)}</strong><small>${e(lobby.names[0])} · ${lobby.players}/${lobby.capacity} players · ${e(matchLength(lobby))}${open ? "" : " · " + e(lobby.status.replace("_", " "))}</small></div>${glyph("chevron.right", 20)}</button>`;
        })
        .join("")}</div></div></div>`
        : emptyNote("No open tables yet.", "Host one and invite a friend!")
    }
    <div class="stack"><button type="button" class="btn c-p1" data-nav="host">${twin[0]}<span>${padTag("y")}Host a Table</span></button>
    <button type="button" class="btn c-p4" data-nav="tournament">${tilted("trophy.fill", 33)}<span>Host a Tournament</span></button>
    <button type="button" class="btn c-s7 c-passplay" data-nav="passplay">${tilted("person.2.fill", 33)}<span>Pass &amp; Play</span></button></div></div>`,
  );
}
async function publicLobby(id) {
  const info = await api(`/api/lobbies/${id}`);
  if (session.room_id === id) {
    await resume(id);
    return;
  }
  history.replaceState({}, "", appPath(`/lobby/${id}`));
  document.title = `${info.name} · Golf`;
  chipMatch = info;
  const full = info.players >= info.capacity || info.status !== "waiting";
  const twin = [tilted("figure.2", 33), tilted("figure.2", 33, { mirror: true })];
  show(
    "public",
    `<div class="page">${pageHead(`data-nav="friends"`)}<div class="stack wide">
    <div class="stack">${tabTitle(info.name, "", "table")}<div class="meta center"><span class="pill">Hosted by ${e(info.names[0])}</span><span class="pill">${e(matchLength(info))}</span><span class="pill">${info.players}/${info.capacity} players</span>${rulesChip(info)}</div></div>
    ${profileChosen() ? "" : `${avatarPicker(info.players)}
    ${field("Your Display Name", `<input id="username" maxlength="32" value="${e(session.username)}" autocomplete="nickname" aria-label="Your display name">`, "character.cursor.ibeam")}`}
    ${full ? `<p class="hint dark">This table is full or already playing.</p>` : ""}
    </div><div class="row"><button type="button" class="btn c-p1 grow" data-join="${e(id)}" ${full ? "disabled" : ""}>${twin[0]}<span>${padTag("y")}Join Table</span>${twin[1]}</button></div></div>`,
  );
  centerAvatar(false);
}
function waitingRoom() {
  const many = state.game_type === "many";
  const url = `${location.origin}${appPath(`/lobby/${state.id}`)}`;
  const seatColor = (seat) => `c-s${seat % 8}`;
  chipMatch = state;
  // a table update redraws the room, which closes sheets: the rules stay open
  const rulesOpen = !sheetRoot.hidden && "lobbyRules" in sheetRoot.dataset;
  const kept = rulesOpen && {
    scroll: sheetRoot.querySelector(".sheet")?.scrollTop || 0,
    examples: [...sheetRoot.querySelectorAll(".rule-example:not([hidden])")].map((node) => node.id),
  };
  show(
    "room",
    `<div class="page">${pageHead("data-leave")}<div class="stack wide">
    <div class="stack">${tabTitle(state.name, "", "table")}<div class="meta center"><span class="pill">${e(matchLength(state))}</span><span class="pill">${state.players}/${state.capacity} players</span><span class="pill">${e(starter[state.first])}</span>${rulesChip(state)}</div></div>
    <div class="share">${field("Invite Link", `<input readonly aria-label="Lobby invite link" value="${e(url)}">`, "link")}<button type="button" class="close-btn c-fw share-copy" data-copy="${e(url)}" aria-label="Copy the invite link">${icon("doc.on.doc.fill", 30)}<span>Copy</span></button></div>
    <div class="list">${state.names.map((seatName, seat) => `<div class="list-item ${seatColor(seat)}">${!many && seat === 1 && state.players < 2 ? `<span class="avatar-badge ${seatColor(seat)}">${icon("person.fill", 24, { idle: false })}</span>` : avatarBadge(state.avatars?.[seat], seatColor(seat))}<div class="grow"><strong>${seat === state.viewer ? youStar() : ""}${e(seatName)}</strong><small>${seat === 0 ? "Host" : "Player " + (seat + 1)} · ${state.connected[seat] ? "connected" : !many && seat === 1 ? "seat open" : "offline"}</small></div></div>`).join("")}</div>
    <p class="hint dark">${many ? "The host starts once at least three players have joined." : "The game starts automatically when a friend joins."}</p>
    </div><div class="stack">${state.viewer === 0 ? `<button type="button" class="btn c-p3" data-invite-open>${tilted("person.fill.badge.plus", 32)}<span>${padTag("x")}Invite a Player</span></button>` : ""}${!many ? "" /* a 2-player table starts by itself: the hint above says so */ : `<div class="row">${state.viewer === 0 ? `<button type="button" class="btn c-p1 grow" data-action="start" ${state.players < 3 ? "disabled" : ""}>${tilted("play.fill", 32)}<span>${padTag("y")}Start Game</span></button>` : `<div class="btn c-fw grow" style="font-size:1.8rem" role="status">Waiting for players…</div>`}</div>`}</div></div>`,
  );
  if (rulesOpen) openLobbyRules(kept);
}

/* ---------- live table connection ---------- */
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
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${appPath(`/ws/${id}`)}`,
  );
  socket = ws;
  let opened = false;
  ws.onopen = () => {
    if (socket !== ws) return;
    opened = true;
    // the server only sends a turn notification when no page of yours is in front
    ws.send(pageAway() ? "hidden" : "visible");
    // a spectator says whose seat they watch from (that player's name tag counts them)
    if (watching === id) ws.send(`seat:${watchSeat}`);
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
    // (dropped while in the background, it just reconnects on the way back)
    if (opened && page === "room" && document.visibilityState === "visible") toast("Reconnecting to the table…");
    retry = setTimeout(() => {
      if (watching === id) followWatched();
      else if (session.room_id === id) connectRoom(id);
    }, 1800);
  };
}
// Leaving the site and coming back: say so to the server, and if the connection
// was dropped meanwhile (phones close it in the background), reconnect at once.
// "Away" is a hidden tab or, on a desktop, a window behind another app.
const pageAway = () => document.visibilityState === "hidden" || !document.hasFocus();
function reportPresenceToTable() {
  if (socket?.readyState === WebSocket.OPEN) socket.send(pageAway() ? "hidden" : "visible");
  if (!pageAway() && session?.room_id && page === "room" && socket?.readyState !== WebSocket.OPEN && socket?.readyState !== WebSocket.CONNECTING) {
    clearTimeout(retry);
    connectRoom(session.room_id);
  }
}
document.addEventListener("visibilitychange", reportPresenceToTable);
window.addEventListener("focus", reportPresenceToTable);
window.addEventListener("blur", reportPresenceToTable);
function accept(next) {
  if (state && state.id === next.id && next.version < state.version) return;
  syncEmotes(next);
  const changed =
    state?.game?.phase !== next.game?.phase ||
    state?.game?.decision_player !== next.game?.decision_player;
  state = next;
  renderVoidOffer();
  // pass & play: when the turn moves to someone else, the device is handed over
  if (next.local) holdForPass(next);
  if (next.spectator) {
    // spectators see no hidden cards from any seat, so whose hand sits at the bottom is theirs to pick
    next.viewer = Math.min(watchSeat, next.names.length - 1);
    // the table being watched closed: look for the players' next one
    if (next.status === "closed") followWatched();
  } else session.room_id = next.id;
  if (SIDE_PAGES.includes(page)) return;
  page = "room";
  if (changed) board.selected = [];
  renderRoom();
}
function enterRoom(next) {
  page = "room";
  markPatchSeen(); // playing on this patch: its notes are no longer news
  history.pushState({}, "", appPath(`/lobby/${next.id}`));
  board.selected = [];
  accept(next);
  if (next.resume_notice) toast(next.resume_notice);
  connectRoom(next.id);
}
async function resume(id = session.room_id) {
  leaveAfterSignIn = null;
  if (!id) return home();
  const epoch = tableEpoch;
  const next = await api(`/api/lobbies/${id}/state`);
  if (epoch === tableEpoch) enterRoom(next);
}
function renderRoom() {
  if (!state) return;
  document.title = `${state.name} · Golf`;
  if (!state.game) return waitingRoom();
  closeSheetIfStale();
  renderBoard();
}
function closeSheetIfStale() {
  // keep an open rules sheet in step with the table: redrawn where it is, at
  // the scroll it was left at, rather than sliding in from the bottom again
  const player = sheetRoot.dataset.player;
  if (sheetRoot.hidden || player === undefined || player === "") return;
  const scroll = sheetRoot.querySelector(".sheet")?.scrollTop || 0;
  // where each rule (and section heading) was, so a rule turned on or off can
  // be seen gliding to its new section, and the others close up behind it
  const before = new Map(
    [...(sheetRoot.querySelectorAll?.("[data-flip]") || [])].map((node) => [node.dataset.flip, { top: node.getBoundingClientRect().top, on: node.dataset.on, gliding: node.classList.contains("gliding") }]),
  );
  sheetRoot.innerHTML = rulesSheet(Number(player));
  const sheet = sheetRoot.querySelector(".sheet");
  if (!sheet) return;
  sheet.classList.add("settled");
  sheet.scrollTop = scroll;
  glideRules(before);
}
// like a dragged card's shadow (.slot .shadow), offset down and a little right
// and softly blurred, but fainter: in the theme's shadow color at half strength.
// It reaches at most 1.2rem past the rule's right edge and 1.6rem below it,
// inside the sheet's 1.6rem padding, so the sheet's edge never cuts it off.
const ruleShadow = (node, lifted) => {
  const color = getComputedStyle(node).getPropertyValue("--shadow").trim() || "rgb(0 0 0 / 0.25)";
  return lifted
    ? `0.2rem 0.6rem 1rem color-mix(in srgb, ${color} 50%, transparent)`
    : "0rem 0rem 0rem transparent";
};
/** Each rule that moved starts where it was and glides to where it is now; the one
 * just turned on or off rides above the rest, on the sheet's own color. */
function glideRules(before) {
  if (!before.size || reducedMotion.matches) return;
  for (const node of sheetRoot.querySelectorAll("[data-flip]")) {
    const was = before.get(node.dataset.flip);
    if (!was || !node.animate) continue;
    const dy = was.top - node.getBoundingClientRect().top;
    if (Math.abs(dy) < 1) continue;
    // (the table's update can redraw the sheet again mid-glide: the rule keeps riding on top)
    const toggled = (node.dataset.on !== undefined && was.on !== node.dataset.on) || was.gliding;
    if (toggled) node.classList.add("gliding");
    // the rule turned on or off lifts off the sheet like a dragged card (the same
    // soft, offset shadow), glides, and settles back down as it lands
    const frames = toggled
      ? [
          { transform: `translateY(${dy}px)`, boxShadow: ruleShadow(node, false) },
          { offset: 0.22, boxShadow: ruleShadow(node, true) },
          { offset: 0.7, boxShadow: ruleShadow(node, true) },
          { transform: "none", boxShadow: ruleShadow(node, false) },
        ]
      : [{ transform: `translateY(${dy}px)` }, { transform: "none" }];
    node
      .animate(frames, {
        duration: toggled ? 520 : 380,
        easing: "cubic-bezier(0.3, 1.15, 0.5, 1)",
      })
      .finished.then(() => node.classList.remove("gliding"), () => {});
  }
}
function openRulesSheet(player) {
  openSheet(rulesSheet(player), player);
  const sheet = sheetRoot.querySelector?.(".rules-sheet");
  const at = rulesScroll.get(rulesScrollKey(player));
  if (sheet && at) sheet.scrollTop = at;
}
/** One player's points in each finished game of the series, and their sum. */
function seriesTally(player, everyone = false) {
  const games = state.history || [];
  const total = games.reduce((sum, game) => sum + game.scores[player], 0);
  // the series so far: wins always, and the points total when that decides it
  const wins = games.filter((game) => game.winner === player).length;
  const points = state.series_mode === "points";
  const single = state.best_of === 1;
  // what is being played: how it is decided, how long it runs, which game this is, and its rules
  const style = state.best_of === null ? "Play until you leave" : single ? "Single game" : points ? "Total points" : "Best of";
  const length = state.best_of === null ? "No set length" : single ? "" : points ? `${state.best_of} games` : `${state.best_of} games · first to ${Math.floor(state.best_of / 2) + 1}`;
  // which game this is, of how many (an open-ended table has no "of")
  const number = games.length + (state.status === "playing" ? 1 : 0) || 1;
  const heading = state.best_of === null ? `Game ${number}` : `Game ${Math.min(number, state.best_of)} of ${state.best_of}`;
  const on = Object.values(state.rules || {}).filter((value) => value === true).length;
  const rules = state.house_rules ? "House rules" : on ? `${on} ${on === 1 ? "rule" : "rules"} in play` : "Vanilla";
  const kind = state.puzzle ? `Daily Puzzle #${state.puzzle.number}` : state.tournament ? e(state.tournament.name || "Tournament") : state.rated ? "Ranked" : "";
  // (the rules chip is a button: it puts this sheet away and brings up that player's rules in play)
  const pills =
    [kind, style, length].filter(Boolean).map((text) => `<span class="pill">${text}</span>`).join("") +
    `<button type="button" class="pill pill-btn" data-rules-player="${player}">${rules}${glyph("chevron.right", 11)}</button>`;
  const tally = single
    ? ""
    : `<div class="tally plain" data-series-tally>${
        games.map((game) => `<div><span>Game ${game.round}</span><b>${game.scores[player]} pts</b></div>`).join("") ||
        "<div><span>No games finished yet</span></div>"
      }<div class="total"><span>Wins</span><b>${wins} ${wins === 1 ? "win" : "wins"}</b></div>${
        points ? `<div class="total more"><span>Total</span><b>${total} pts</b></div>` : ""
      }</div>`;
  // (`everyone`: your own sheet has every player at the table, set out as a saved match's card is)
  return `<div class="series-info"><h3>${heading}</h3><div class="meta">${pills}</div>${everyone ? tableSoFar() : tally}</div>`;
}
/** The games of this table so far for every player, as Match history draws a saved match: a column each, points by game, totals and wins. */
function tableSoFar() {
  const games = state.history || [];
  const match = {
    id: state.id,
    names: state.names,
    avatars: state.avatars || [],
    solo: !!state.solo,
    viewer: state.spectator ? null : state.viewer,
    winner: state.champion ?? null,
    rounds: games,
    points: state.names.map((_, p) => games.reduce((sum, game) => sum + game.scores[p], 0)),
    wins: state.names.map((_, p) => games.filter((game) => game.winner === p).length),
  };
  const card = matchArticleHtml(match, true);
  // (no winner to name while it is still being played)
  return match.winner === null ? card.replace(/<p class="match-winner">[^]*?<\/p>/, "") : card;
}
/** A player's record, shown over the table (tap a name tag, theirs or yours). */
function playerStatsSheet(player) {
  const id = state.player_ids?.[player];
  const color = colorFor(player);
  // (the sheet is in the player's own seat color, as their rules sheet is)
  openSheet(`<section class="sheet ${color} profile-sheet" role="dialog" aria-modal="true" aria-label="Player profile">
    <div class="sheet-head"><h2>${e(state.names[player])}</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    <div data-profile-sheet="${e(id || "")}">${id ? `<div class="loading">Loading…</div>` : seriesTally(player)}</div>
  </section>`);
  if (!id) return;
  fetchProfile(id)
    .then(({ profile, stats }) => {
      const holder = [...(sheetRoot.querySelectorAll?.("[data-profile-sheet]") || [])].find((el) => el.dataset.profileSheet === id);
      if (!holder) return;
      // (the name at the table is the one they are playing under)
      profile.label = profile.label || state.names[player];
      profile.avatar = profile.avatar || state.avatars?.[player] || null;
      holder.innerHTML = profileHtml(profile, stats, { accent: color, tone: color, heading: sectionTitle, extra: seriesTally(player, player === state.viewer && !state.spectator) });
      sheetRoot.querySelector(".profile-sheet .sheet-head h2")?.replaceChildren();
    })
    .catch((error) => {
      const holder = sheetRoot.querySelector?.("[data-profile-sheet]");
      if (holder) holder.innerHTML = `${seriesTally(player)}<p class="hint dark">${e(error.message)}</p>`;
    });
}
/**
 * Anyone's record, opened from Aces (or a name tag's View stats): their card
 * (MMR, streak, records held), then their numbers, and how you've done against them.
 */
async function playerSheet(id) {
  const me = myPlayerId();
  openSheet(`<section class="sheet c-p3 player-sheet" role="dialog" aria-modal="true" aria-label="Player stats">
    <div class="sheet-head"><h2 data-player-sheet-name>Player</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    <div class="player-card" data-player-card="${e(id)}"><div class="loading">Loading…</div></div>
    <div class="stack wide" data-player-stats="${e(id)}"><div class="loading">Loading stats…</div></div>
  </section>`);
  loadPlayerCard(id);
  const query = new URLSearchParams({ player: id, opponent: id === me ? "" : me, house_rules: "false" });
  let html;
  try {
    const result = await api("/api/stats?" + query);
    const title = sheetRoot.querySelector("[data-player-sheet-name]");
    if (title && result.player) title.textContent = result.player.profile.label;
    const versus = result.comparison?.head_to_head?.rounds ? statsTable([result.player, result.comparison], "head_to_head", "Head to head with you", "c-fw") : "";
    html = result.player
      ? `${versus}${statsTable([result.player], "overall", "Every game", "c-fw")}`
      : `<p class="hint dark">No saved games yet.</p>`;
  } catch (error) {
    html = `<p class="hint dark">${e(error.message)}</p>`;
  }
  const holder = [...(sheetRoot.querySelectorAll?.("[data-player-stats]") || [])].find((el) => el.dataset.playerStats === id);
  if (holder) holder.innerHTML = html;
}
/**
 * The popup's MMR and best 1v1 streak, drawn as rows of the PVP leaderboard,
 * and the records this player holds, drawn as the Records tab's cards.
 */
async function loadPlayerCard(id) {
  let card;
  try {
    card = await api(`/api/player-card?player=${encodeURIComponent(id)}`);
  } catch {
    card = null;
  }
  const holder = [...document.querySelectorAll("[data-player-card]")].find((el) => el.dataset.playerCard === id);
  if (!holder) return;
  if (!card) return void (holder.innerHTML = `<p class="hint dark">Stats aren't available right now.</p>`);
  const row = (color, symbol, label, value) =>
    `<div class="list-item board-row ${color}"><span class="rank">${tilted(symbol, 30, { key: `card:${label}` })}</span><div class="grow"><strong>${label}</strong></div><b class="rate">${value}</b></div>`;
  const mmr = card.mmr == null ? "—" : `${statNumber(card.mmr)}${card.provisional ? "?" : ""}<small>MMR</small>`;
  const streak = `${icon("flame.fill", 22, { idle: false })}<span class="streak-num">${statNumber(card.pvp_streak)}</span>`;
  // (the server sends only the records linked to this player: theirs, or a game they played in)
  const held = heldRecordCards(card.records);
  const [played, unit] = timeParts(card.seconds_played || 0);
  const time = `${statNumber(played)}<small>${unit}</small>`;
  // Golfbot has no rating, streak or clock of its own: only its records
  const rows = id.startsWith("bot:") ? "" : `<div class="list leader-list">${row("c-p3", "crown.fill", "MMR", mmr)}${row("c-s4", "flame.fill", "Best PvP win streak", streak)}${row("c-s2", "hourglass", "Time played", time)}</div>`;
  holder.innerHTML = `${rows}${
    held.length
      ? `<h3 class="player-card-head">Records held</h3>${hugColumns(held)}`
      : `<p class="hint dark">No records held yet.</p>`
  }`;
}
/**
 * Send one table action. Resolves true when the server accepted it.
 * The server refuses an action aimed at a table that has since changed. With
 * opts.stillLegal, such a refusal is not the end of it: the table is read
 * again and, while that check still passes, the action is sent once more.
 */
async function move(action, extra = {}, opts = {}) {
  if (busy || !state || state.void_offer) return false;
  const roomId = state.id;
  let ok = false;
  busy = true;
  try {
    for (let attempt = 0; !ok; attempt++) {
      try {
        const next = await api(`/api/lobbies/${roomId}/action`, "POST", {
          action,
          version: state.version,
          ...extra,
        });
        if (session.room_id !== roomId) return false;
        ok = true;
        board.selected = [];
        accept(next);
        // after a flip the only card that can move is the one just revealed
        if (action === "flip" && next.game?.legal.swap.length === 1)
          board.selected = [[next.viewer, next.game.legal.swap[0]]];
      } catch (error) {
        let again = false;
        if (error.status === 409 && state) {
          try {
            accept(await api(`/api/lobbies/${state.id}/state`));
            again = attempt < 2 && session.room_id === roomId && !!opts.stillLegal?.();
          } catch {}
        }
        if (again) continue;
        toast(error.message);
        break;
      }
    }
  } finally {
    busy = false;
    if (state && page === "room") renderRoom();
  }
  return ok;
}

/* ---------- debug: card gallery ---------- */
/**
 * Every card in one big grid, for checking card designs (debug servers only).
 * Drag a card about and it springs back to its place; double-click, or
 * double-tap, turns it over either way with the table's own flip.
 */
function cardGallery() {
  document.title = "Card gallery · Golf";
  const labels = { 1: "A", 11: "J", 12: "Q", 13: "K" };
  // each card exactly as a hand card on the table: its size, and the hand's
  // own slight tilts (in the same order, six to a hand)
  const cards = ["S", "H", "D", "C"].flatMap((suit, row) =>
    Array.from({ length: 13 }, (_, i) => {
      const card = { rank: i + 1, label: labels[i + 1] || String(i + 1), suit };
      const tilt = HAND_TILT[0][(row * 13 + i) % 6];
      return `<button type="button" class="slot gallery-slot is-face" style="--rot:${tilt}deg" aria-label="${e(cardName(card))}"><span class="shadow"></span><span class="card"><span class="card-flip">${faceHtml(card, true)}</span></span></button>`;
    }),
  );
  show(
    "cards",
    `<div class="page scroll">${subHeader("Card Gallery", undefined, "Drag cards around. Double-click (or double-tap) a card to turn it over.")}<div class="card-gallery">${cards.join("")}</div></div>`,
  );
}
const gallery = { drag: null, lastTap: null, top: 1 };
root.addEventListener("pointerdown", (event) => {
  const slot = event.target.closest?.(".gallery-slot");
  if (!slot || event.button > 0) return;
  event.preventDefault();
  const motion = motionFor(slot);
  gallery.drag = {
    slot,
    motion,
    pointer: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    fromX: motion.values.x?.value || 0,
    fromY: motion.values.y?.value || 0,
    moved: false,
  };
  slot.style.zIndex = String(++gallery.top); // the card in hand comes to the front
  try {
    slot.setPointerCapture(event.pointerId);
  } catch {}
  motion.to({ lift: 1, scale: 1.08 });
});
root.addEventListener("pointermove", (event) => {
  const drag = gallery.drag;
  if (!drag || event.pointerId !== drag.pointer) return;
  const dx = event.clientX - drag.startX,
    dy = event.clientY - drag.startY;
  if (!drag.moved && Math.hypot(dx, dy) < 6) return;
  drag.moved = true;
  drag.motion.to({ x: drag.fromX + dx, y: drag.fromY + dy, lean: Math.max(-12, Math.min(12, event.movementX * 0.8)) });
});
function endGalleryDrag(event) {
  const drag = gallery.drag;
  if (!drag || event.pointerId !== drag.pointer) return;
  gallery.drag = null;
  drag.motion.to({ x: 0, y: 0, lift: 0, scale: 1, lean: 0 }); // let go: back to its place
  if (drag.moved || event.type === "pointercancel") return;
  // a second tap on the same card, soon after the first: turn it over
  const now = performance.now();
  const last = gallery.lastTap;
  if (last && last.slot === drag.slot && now - last.at < 350) {
    gallery.lastTap = null;
    haptic("flip");
    flipSlot(drag.slot, !drag.slot.classList.contains("is-face"));
  } else gallery.lastTap = { slot: drag.slot, at: now };
}
root.addEventListener("pointerup", endGalleryDrag);
root.addEventListener("pointercancel", endGalleryDrag);

/* ---------- account ---------- */
let googleScript = null;
let initializedGoogleNonce = null;
/**
 * A Sign in button: ours to look at, Google's to press. Google's own button is
 * laid invisibly over it (mountGoogleSignIn), so a tap goes straight to Google's
 * sign-in. Until that has loaded (or where it cannot), ours answers instead (signIn).
 */
function signInButton(cls, inner, attrs = "data-signin") {
  return `<span class="signin-wrap ${cls}"><button type="button" class="btn ${cls}" ${attrs}>${inner}</button><span class="google-cover" data-google-cover aria-hidden="true"></span></span>`;
}
/** Whether signing in is possible just now (false with a reason toasted when `say`). */
function canSignIn(say = false) {
  const why = session.account
    ? ""
    : !session.google_client_id
      ? "Google sign-in is not available on this server yet. You can keep playing as a guest."
      : session.room_id && !canSignInDuringPractice()
        ? "Leave your current table before signing in."
        : null;
  if (why && say) toast(why);
  return why === null;
}
/** Lay Google's button over every Sign in button on the screen. */
async function mountGoogleSignIn() {
  const covers = () => [...document.querySelectorAll("[data-google-cover]")];
  if (!covers().length || !canSignIn()) return false;
  try {
    if (!window.google?.accounts?.id) {
      googleScript ??= new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error("Google sign-in could not load. You can keep playing as a guest."));
        document.head.appendChild(script);
      });
      await googleScript;
    }
    if (!canSignIn()) return false;
    if (initializedGoogleNonce !== session.google_nonce) google.accounts.id.initialize({ client_id: session.google_client_id, nonce: session.google_nonce, callback: googleSignedIn });
    initializedGoogleNonce = session.google_nonce;
    for (const cover of covers()) {
      const host = cover.parentElement;
      if (cover.dataset.mounted === session.google_nonce || !host.offsetWidth) continue;
      cover.dataset.mounted = session.google_nonce;
      cover.textContent = "";
      // Google draws its button 44px high and up to 400px wide; it is stretched to
      // cover the whole of ours, so a tap anywhere on ours is a tap on Google's
      const width = clamp(Math.round(host.offsetWidth), 200, 400);
      cover.style.width = `${width}px`;
      cover.style.setProperty("--gx", (host.offsetWidth / width).toFixed(3));
      cover.style.setProperty("--gy", (host.offsetHeight / 44).toFixed(3));
      google.accounts.id.renderButton(cover, { theme: "outline", size: "large", text: "signin_with", shape: "pill", width });
    }
    return true;
  } catch (error) {
    googleScript = null;
    return false;
  }
}
/** Our own Sign in button was pressed (Google's was not over it): say why not, or ask Google to prompt. */
async function signIn() {
  if (!canSignIn(true)) return;
  if ((await mountGoogleSignIn()) && window.google?.accounts?.id) google.accounts.id.prompt();
  else toast("Google sign-in could not load. You can keep playing as a guest.");
}
/** Google has signed the player in: the session becomes their account's. */
async function googleSignedIn({ credential }) {
  try {
    const keep = { username: session.username, avatar: session.avatar };
    const epoch = tableEpoch,
      roomId = session.room_id;
    const next = await api("/api/auth/google", "POST", { credential, csrf_token: session.csrf_token });
    const currentRoom = session.room_id;
    session = { ...next, ...keep };
    if (next.account?.display_name) saveName(next.account.display_name);
    syncPrefs();
    if (pendingLeaveResolve) resolveLeavePrompt("signedin"); // (the "sign in to keep your streak" card)
    if (epoch !== tableEpoch || currentRoom !== roomId) {
      session.room_id = currentRoom;
      return;
    }
    // a new account picks its unique name before anything else
    if (!session.account.unique_name) uniqueNameSheet();
    else if (!(await finishPracticeSignIn())) signedIn();
  } catch (error) {
    toast(error.message);
  }
}
/** Signed in, with a unique name: say so, and show what is on screen as theirs. */
function signedIn() {
  toast("Signed in as @" + session.account.unique_name);
  if (page === "home") {
    redrawPane(homeTab);
    loadTab(homeTab);
  }
}
/** A new account chooses the unique name its games are kept under. */
function uniqueNameSheet() {
  openSheet(`<section class="sheet c-p1" role="dialog" aria-modal="true" aria-label="Choose your unique name">
    <div class="sheet-head"><h2>Choose your unique name</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    <p>This identifies you in Aces across all your display names. Pick once; your display name can change whenever you play.</p>
    <form id="account-name-form" class="stack" style="margin-top:2rem">${field("Unique Name", `<input name="unique_name" aria-label="Unique name" minlength="3" maxlength="24" pattern="[a-zA-Z0-9_]{3,24}" autocomplete="username" autocapitalize="none" spellcheck="false" required>`, "character.cursor.ibeam")}<p class="hint" style="color:var(--p1)">3–24 letters, numbers or underscores. Names are lowercase and unique.</p><button type="submit" class="btn c-p1">Save unique name</button></form>
  </section>`);
}
/** Signed in: who as, and the way out. */
function accountSheet() {
  const account = session.account;
  if (!account) return;
  openSheet(`<section class="sheet c-p1" role="dialog" aria-modal="true" aria-label="Your account">
    <div class="sheet-head"><h2>${account.unique_name ? `@${e(account.unique_name)}` : "Your account"}</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    <p>Your games are kept under this unique name in Aces, on every device you sign in on. Your display name at the table can change whenever you like.</p>
    <div class="menu-list" style="margin-top:1.6rem"><button type="button" class="btn c-p2" data-signout>${tilted("rectangle.portrait.and.arrow.right", 26)} Sign out</button></div>
  </section>`);
}
document.addEventListener("submit", async (event) => {
  if (event.target.id !== "account-name-form") return;
  event.preventDefault();
  try {
    const keep = { username: session.username, avatar: session.avatar };
    const epoch = tableEpoch,
      roomId = session.room_id;
    const next = await api("/api/account/name", "POST", { unique_name: new FormData(event.target).get("unique_name"), csrf_token: session.csrf_token });
    const currentRoom = session.room_id;
    session = { ...next, ...keep };
    closeSheet();
    if (epoch !== tableEpoch || currentRoom !== roomId) {
      session.room_id = currentRoom;
      return;
    }
    if (!(await finishPracticeSignIn())) signedIn();
  } catch (error) {
    toast(error.message);
  }
});
/** One plain line of the names used before, most recent first; nothing when there are none. */
const previousNamesHtml = (names) =>
  names.length ? `<p class="hint dark">Previously: ${names.map(e).join(", ")}</p>` : "";
/** Under the display name: the names this account has gone by before. */
async function loadPreviousNames() {
  const holder = () => root.querySelector("[data-previous-names]");
  if (!session.account || !holder()) return;
  try {
    const { names } = await api("/api/account/display-names");
    const target = holder();
    if (!target) return;
    target.innerHTML = previousNamesHtml(names);
  } catch {
    // the list is a nicety: the form works without it
  }
}

/** One saved match: its games and who won each, as Match history lists it. */
/** A player in a saved match by name, their avatar before it in their seat's color (and the star, if it is you). */
const matchPlayer = (match, seat) => `<span class="mt-player c-s${seat % 8}">${matchAvatar(match, seat)}${nameMark(match.participants?.[seat]?.id, match.viewer === seat)}${e(match.names[seat])}</span>`;
/** Points written the table's way, on one line: the number as a sticker with a small "pts" after it, in that seat's color. */
const ptsInline = (score, key, seat = 0) =>
  `<span class="pts-inline c-s${seat % 8}" aria-label="${e(String(score))} points">${stickerText(String(score), { idle: false, key })}${stickerText("pts", { cls: "pts", idle: false, key: `${key}:pts` })}</span>`;
/** A player's avatar in a saved match (yours, as it is now, where an older match saved none), in their seat's color. */
function matchAvatar(match, seat) {
  const avatar = match.avatars?.[seat] || (match.solo && seat === 1 ? "golfbot" : match.viewer === seat ? session.avatar : null);
  return `<span class="mt-ava">${avatar ? icon(avatarIcon(avatar), 17, { idle: false }) : icon("person.fill", 15, { idle: false })}</span>`;
}
/** A saved match's chips: when it ended, what kind it was, how long, how it ended, and its patch. */
function matchMetaHtml(saved) {
  const match = {
    ...saved,
    names: saved.names.map((name, seat) => (saved.solo && seat === 1 ? "Golfbot" : name)),
  };
  const status =
    {
      finished: "Completed",
      in_progress: "In progress",
      abandoned: "Abandoned",
      interrupted: "Interrupted by server restart",
    }[match.status] || match.status;
  const ended = match.last_game_ended_at || Math.max(...match.rounds.map((game) => game.ended_at || 0)) || match.updated_at;
  return `<div class="meta"><span class="pill">${e(dateLabel(ended))}</span>${match.solo ? `<span class="pill">Vs Golfbot</span>` : ""}<span class="pill">${e(matchLength(match))}</span><span class="pill">${e(status)}</span><span class="pill">${e(match.patch || "Earlier patches")}</span></div>`;
}
function matchArticleHtml(saved, bare = false) {
  const match = {
    ...saved,
    names: saved.names.map((name, seat) => (saved.solo && seat === 1 ? "Golfbot" : name)),
  };
  const winner = match.winner === null ? "No overall winner" : match.names[match.winner];
  const status =
    {
      finished: "Completed",
      in_progress: "In progress",
      abandoned: "Abandoned",
      interrupted: "Interrupted by server restart",
    }[match.status] || match.status;
  const ended = match.last_game_ended_at || Math.max(...match.rounds.map((game) => game.ended_at || 0)) || match.updated_at;
  // (`bare`: only the result and the table, for a sheet that is the card itself, its name and chips at its head)
  return `${bare ? "" : `<article class="panel c-fw"><h2>${e(match.lobby_name)}</h2>`}${bare ? "" : matchMetaHtml(saved)}<p class="match-winner">${tilted("trophy.fill", 22, { style: "--fill:var(--p3);--stroke:var(--paper)" })}<span>Overall winner:</span>${match.winner === null ? e(winner) : matchPlayer(match, match.winner)}</p><div class="table-wrap"><table class="match-table"><thead><tr><th scope="col">Game</th>${match.names.map((name, p) => `<th scope="col"><span class="mt-player c-s${p % 8}">${matchAvatar(match, p)}${match.viewer === p ? youStar() : ""}${e(name)}</span></th>`).join("")}<th scope="col">Winner</th></tr></thead><tbody>${match.rounds.map((game) => `<tr><th scope="row">${game.round}</th>${game.scores.map((score, p) => `<td>${ptsInline(score, `mh:${match.id}:${game.round}:${p}`, p)}</td>`).join("")}<td>${game.winner === null ? "Draw" : matchPlayer(match, game.winner)}</td></tr>`).join("")}</tbody><tfoot><tr><th scope="row">Total</th>${match.points.map((score, p) => `<td>${ptsInline(score, `mh:${match.id}:total:${p}`, p)}</td>`).join("")}<td></td></tr><tr><th scope="row">Wins</th>${match.wins.map((wins) => `<td>${wins}</td>`).join("")}<td></td></tr></tfoot></table></div>${bare ? "" : "</article>"}`;
}
/* ---------- match history ----------
   Split three ways: tables between players, games against Golfbot, and tournaments. */
const LIST_TABS = [
  ["pvp", "PvP", "figure.2"],
  ["solo", "Solo", "dumbbell.fill"],
  ["tournament", "Tournaments", "trophy.fill"],
];
let historyTab = "pvp";
/** The floating selector at the foot of the Match history page: PvP, Solo or Tournaments, as Aces picks its view. */
function listTabs(selected) {
  const at = Math.max(0, LIST_TABS.findIndex(([key]) => key === selected));
  return `<div class="home-dock list-dock"><nav class="aces-tabs boxed c-fw" aria-label="Show" style="--at:${at}"><span class="aces-pointer c-p2" aria-hidden="true">${icon("chevron.down", 15, { idle: false, sw: 4.2 })}</span>${LIST_TABS.map(([key, label, symbol], i) => `<button type="button" class="aces-tab${selected === key ? " on c-p2" : ""}" data-list-tab="${key}" aria-pressed="${selected === key}">${tilted(symbol, 26, { key: `list:${key}`, tilt: [-6, 0, 6][i] })}<span>${label}</span></button>`).join("")}</nav></div>`;
}
/** The Match history page's head: the way back, and its name on an arch like a home tab's. */
const historyHead = (sub = "") => `${pageHead(`data-nav="${session?.room_id ? "resume" : "home"}"`)}${tabTitle("Match History", sub, "history")}`;
/* A list picked on the selector comes in from the side it lies on, as an Aces view does,
   and its cards follow one after another. (Opened afresh, it only fades up.) */
let historyEnter = 0; // -1 or 1: the side the list now loading comes in from
function enterHistoryList() {
  const dir = historyEnter;
  historyEnter = 0;
  const list = root.querySelector(".history-page .stack");
  if (!list?.animate || reducedMotion.matches) return;
  list.animate([{ translate: `${dir * 18}% 0`, opacity: 0 }, { translate: "0 0", opacity: 1 }], { duration: 380, easing: "cubic-bezier(0.22, 1.2, 0.36, 1)" });
  [...list.querySelectorAll(":scope > article, :scope > .list > *")].slice(0, 8).forEach((card, i) =>
    card.animate([{ translate: "0 1.6rem", scale: "0.96", opacity: 0 }, { translate: "0 0", scale: "1", opacity: 1 }], { duration: 450, delay: 60 + i * 55, easing: "cubic-bezier(0.22, 1.2, 0.36, 1)", fill: "backwards" }),
  );
}
let historyEntries = [],
  historyCups = [], // finished tournaments (the Tournaments list)
  historyOffset = null,
  historyRequest = 0;
async function historyPage(more = false) {
  const request = ++historyRequest;
  document.title = "Match history · Golf";
  history.replaceState({}, "", appPath("/history"));
  const tab = historyTab;
  const tabs = listTabs(tab);
  if (!more) {
    historyEntries = [];
    show(
      "history",
      `<div class="page scroll history-page">${historyHead()}${tabs}<div class="loading">Loading match history…</div></div>`,
    );
  }
  try {
    // (the Tournaments list opens with the finished tournaments themselves, then their matches)
    const [result, cups] = await Promise.all([
      api(`/api/history?kind=${tab}&offset=${more ? historyOffset : 0}`),
      tab === "tournament" && !more ? loadTournamentHistory() : null,
    ]);
    if (page !== "history" || request !== historyRequest) return;
    if (cups) historyCups = cups;
    const finished = tab === "tournament" ? tournamentRows(historyCups) : "";
    const intro = { pvp: "Completed games between players, newest first.", solo: "Completed games against Golfbot, newest first.", tournament: "Finished tournaments, newest first. Tap one for its bracket." }[tab];
    const none = { pvp: "No games between players yet.", solo: "No games against Golfbot yet. Finish one to see it here.", tournament: finished ? "" : "No tournament has finished yet." }[tab];
    historyEntries.push(...result.matches);
    historyOffset = result.next_offset;
    const scroll = window.scrollY;
    show(
      "history",
      `<div class="page scroll history-page">${historyHead(intro)}${tabs}${session.room_id ? `<p class="hint dark">Your table is still open — head back any time.</p>` : ""}<div class="stack wide">${finished ? `<div class="list">${finished}</div>${historyEntries.length ? sectionTitle("Tournament Matches") : ""}` : ""}${
        historyEntries
          .map((match) => matchArticleHtml(match))
          .join("") ||
        (none ? `<p class="hint">${none}</p>` : "")
      }${historyOffset !== null ? `<button type="button" class="btn small c-fw" data-history-more>Load older matches</button>` : ""}</div></div>`,
    );
    if (more) window.scrollTo(0, scroll);
    else enterHistoryList();
  } catch (error) {
    if (page === "history" && request === historyRequest)
      show(
        "history",
        `<div class="page scroll history-page">${historyHead()}${tabs}<p class="empty">${e(error.message)}</p><button type="button" class="btn small c-fw" data-nav="history">Try again</button></div>`,
      );
  }
}

/* ---------- leaderboard (player stats) ---------- */
const statNumber = (value) =>
  value === null
    ? "—"
    : new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(
        value,
      );
const statPercent = (value) =>
  value === null
    ? "—"
    : new Intl.NumberFormat(undefined, {
        style: "percent",
        maximumFractionDigits: 1,
      }).format(value);
/** A length of time for the stats tables: "8.4 s", or "1 min 12 s" past a minute. */
const statSeconds = (value) =>
  value === null
    ? "—"
    : value < 60
      ? `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value)} s`
      : `${Math.floor(value / 60)} min ${Math.round(value % 60)} s`;
/* ---------- leaderboard & player stats ---------- */
// Filters work like the rule picker before a game: House (official stats) or
// any rules, and with House off each rule can be required or excluded.
const myPlayerId = () =>
  session.player_id || (session.account ? "account:" + session.account.id : "player:" + session.username);
/** The ranking: everyone with a matching game, best game win rate first. Guests share one row. */
/** The record cards a player holds (given only theirs), as the Records tab draws them. */
function heldRecordCards(records) {
  return recordCards(records || {})
    .filter(({ record }) => record)
    .map(({ html }) => html);
}
function ruleActivationsHtml(entry, scope, named = true) {
  const stats = entry[scope];
  if (!Array.isArray(stats.rule_activations))
    return `<p>Restart the game server to load rule activation stats.</p>`;
  // (`named`: with more than one player on the card, each table says whose it is)
  return `<div>${named ? `<h3>${e(entry.profile.label)}</h3>` : ""}${named && entry.profile.unique_name ? `<p>Display names: ${entry.profile.display_names.map(e).join(", ")}</p>` : ""}${named ? `<p>${stats.known_activation_games} games</p>` : ""}<div class="table-wrap"><table><thead><tr><th>Rule</th><th>Games activated</th><th>Win rate</th></tr></thead><tbody>${stats.rule_activations.map((rule) => `<tr><th>${e(rule.name)}</th><td>${statPercent(rule.rate)} <small>(${rule.games})</small></td><td>${statPercent(rule.win_rate)}</td></tr>${(rule.subrules || []).map((part) => `<tr class="sub-rule"><th>${textSymbol("arrow.turn.down.right", "sub-rule-arrow")}${e(part.name)}</th><td>${statPercent(part.rate)} <small>(${part.games})</small></td><td>${statPercent(part.win_rate)}</td></tr>`).join("")}`).join("")}</tbody></table></div></div>`;
}
function statsTable(entries, scope, title, color) {
  const rating = (entry, kind) => {
    const shown = entry.ratings?.[kind];
    return shown ? `${statNumber(shown.rating)}${shown.provisional ? "?" : ""} <small>±${statNumber(shown.rd)} · ${shown.wins}–${shown.losses}–${shown.draws}</small>` : "—";
  };
  const first = (wins, games, rate) => (games ? `${statPercent(rate)} <small>(${statNumber(wins)} of ${statNumber(games)})</small>` : "—");
  const metrics = [
    // the two Ranked ratings belong to the player, not to the games selected below
    ...(scope === "overall" && entries.some((entry) => entry.ratings)
      ? [
          ["MMR (series rating) · W–L–D", (s, entry) => rating(entry, "series")],
          ["Game rating · W–L–D", (s, entry) => rating(entry, "game")],
        ]
      : []),
    ["Games played", (s) => statNumber(s.rounds)],
    [
      "Game record (W–L–D)",
      (s) => `${s.round_wins}–${s.round_losses}–${s.round_draws}`,
    ],
    ["Game win rate", (s) => statPercent(s.round_win_rate)],
    [
      "Series record (W–L–D) · win rate",
      (s) =>
        `${s.match_wins}–${s.match_losses}–${s.match_draws || 0} · ${statPercent(s.match_win_rate)}`,
    ],
    ["Average points per game", (s) => statNumber(s.average_points)],
    ["Average opponent points", (s) => statNumber(s.average_opponent_points)],
    ["Went first", (s) => first(s.first_games, s.known_first_games, s.first_rate)],
    ["Win rate going first", (s) => first(s.first_wins, s.first_games, s.first_win_rate)],
    ["Win rate not going first", (s) => first(s.later_wins, s.later_games, s.later_win_rate)],
    ["Average turns per game", (s) => statNumber(s.average_turns ?? null)],
    ["Average time spent on move", (s) => statSeconds(s.average_move_seconds ?? null)],
    [
      "Average rules in play per game",
      (s) => statNumber(s.average_rules_in_play ?? null),
    ],
    [
      "Average point advantage",
      (s) =>
        s.average_advantage === null ? "—" : s.average_advantage.toFixed(2),
    ],
    ["Total points", (s) => statNumber(s.total_points)],
    [
      "Best / worst game",
      (s) => `${statNumber(s.best_round)} / ${statNumber(s.worst_round)}`,
    ],
  ];
  return `<section class="panel ${color}"><h2>${title}</h2>${entries.every((entry) => entry[scope].rounds === 0) ? `<p>No games match this selection.</p>` : ""}<div class="table-wrap"><table><thead><tr><th scope="col">Statistic</th>${entries.map((entry) => `<th scope="col">${entries.length > 1 ? e(entry.profile.label) : "Value"}</th>`).join("")}</tr></thead><tbody>${metrics.map(([label, value]) => `<tr><th scope="row">${label}</th>${entries.map((entry) => `<td>${value(entry[scope], entry)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>${entries.some((entry) => entry[scope].known_turn_games < entry[scope].rounds) ? `<p>Average turns excludes older games without turn records.</p>` : ""}${entries.some((entry) => entry[scope].ambiguous_matches) ? `<p>Games where the selected player holds more than one seat are excluded because those seats cannot be told apart.</p>` : ""}</section><section class="panel ${color} rule-activations"><h2>Rule Activations${entries.length === 1 && Array.isArray(entries[0][scope].rule_activations) ? ` · ${entries[0][scope].known_activation_games} games` : ""}</h2><div class="stack wide">${entries.map((entry) => ruleActivationsHtml(entry, scope, entries.length > 1)).join("")}</div></section>`;
}
const RULE_EXAMPLES = {
  royal_pairs: [["Queen pair earns one bonus swap", ["QH",null,null,"QS",null,null]], ["Jack pair earns one bonus swap", ["JH",null,null,"JS",null,null]]],
  angel_numbers: [
    ["666: every opponent's final score times 6", ["6H","6S","6D",null,null,null]],
    ["777: your final score divided by 7", ["7H","7S","7D",null,null,null]],
    ["888: every opponent's final score times 8", ["8H","8S","8D",null,null,null]],
    ["999: your final score divided by 9", ["9H","9S","9D",null,null,null]],
  ],
  king_queen: [["Same-color King-Queen column: 5 points", ["KH",null,null,"QD",null,null]], ["Different-color column: 15 points", ["KH",null,null,"QS",null,null]]],
  holdem: [["Five-card flush: -5 points", ["AH","3H","6H","8H","JH",null]], ["Five-card straight: -5 points", ["3H","4S","5D","6C","7H",null]], ["Full house: -5 points", ["3H","3S","3D","8C","8H",null]], ["Four of a kind: -5 points", ["4H","4S","4D","4C","AH",null]]],
  v10: [["10, J, Q in a V: final score divided by 5", ["10H",null,"JS",null,"QD",null]], ["Inverted V also counts", [null,"10H",null,"JS",null,"QD"]]],
  tricky_straights: [["Ascending 3-4-5: +5 to opponent", ["3H","4S","5D",null,null,null]], ["Descending 5-4-3: -3 from your score", ["5H","4S","3D",null,null,null]]],
  ripped_five: [
    ["The 5 of diamonds and a 5 in the opposite row cancel", ["5D",null,null,null,null,"5S"]],
    ["Already in a column pair, the 5 of diamonds still rips one more 5 in the opposite row", ["5D",null,null,"5H",null,"5S"]],
  ],
  roman_fives: [["8 + 4 + (-2) = 10 base points: final score divided by 2", ["8H",null,"2S",null,"4D",null]], ["Inverted V: 5 + 4 + A = 10", [null,"4S",null,"5D",null,"AH"]]],
  beggars: [["Your 10 is the unique highest visible value. Guess the chosen hidden card's rank before it flips", ["10H",null,null,null,null,null], ["3H",null,null,null,null,null], "Opponent: a correct guess trades your 10 for their lowest visible card after the reveal"]],
  four_kind: [["Four visible 4s may be arranged into two columns", ["4H","4S",null,"4D","4C",null]]],
  poisoned_card: [["First player to reveal all six during play: +1 before divisions", ["AH","3S","5D","7C","9H","KC"]]],
  suited_rows: [["Red row: middle 4 adds +4 to every opponent", ["AH","4H","8H",null,null,null]], ["Black row: middle 4 subtracts 4 from you", ["AS","4S","8S",null,null,null]]],
  all_in_color: [["All six red: every opponent's final score times 2", ["AH","3D","5H","7D","9H","KD"]], ["All six black: your final score divided by 2", ["AS","3C","5S","7C","9S","KC"]]],
};
function exampleHand(cards) {
  return `<div class="example-hand" role="img" aria-label="${e(cards.map(value => value || "face down").join(", "))}">${cards.map(value => {
    const card = value ? {suit:value.slice(-1), label:value.slice(0,-1)} : null;
    return `<span class="example-card${card ? " is-face" : ""}" aria-hidden="true"><span class="card"><span class="card-flip">${faceHtml(card)}</span></span></span>`;
  }).join("")}</div>`;
}
const matchRuleExampleOpen = new Set();
let matchRuleExampleRoom = null;
function matchExampleKey(player, rule) {
  if (matchRuleExampleRoom !== state.id) {
    matchRuleExampleOpen.clear();
    matchRuleExampleRoom = state.id;
  }
  return `${player}:${rule}`;
}
function ruleHelpCard(rule, {player = null, on = true, editable = false} = {}) {
  const inMatch = player !== null;
  const preview = inMatch ? state.game.rule_previews?.[player]?.[rule.key] : null;
  const active = inMatch && activeRules(player).includes(rule.key);
  // (only for your own hand, and only while the host allows score previews)
  const near = !active && inMatch && player === state.viewer && (state.game.near_rules || []).includes(rule.key);
  const token = inMatch ? `match-${player}-${rule.key}` : rule.key;
  const expanded = inMatch && matchRuleExampleOpen.has(matchExampleKey(player, rule.key));
  let examples;
  if (preview) {
    const participating = new Set(preview.indices);
    const cards = state.game.players[player].map((slot,index) =>
      participating.has(index) && slot.visible && slot.card ? slot.card.label + slot.card.suit : null);
    const caption = player === state.viewer ? "Your current cards" : `${state.names[player]}'s current cards`;
    examples = `<p class="example-caption">${e(caption)}</p>${exampleHand(cards)}${preview.note ? `<p class="example-caption">${e(preview.note)}</p>` : ""}`;
  } else {
    examples = (RULE_EXAMPLES[rule.key] || []).map(([caption,cards,other,otherCaption]) => `<p class="example-caption">${e(caption)}</p>${exampleHand(cards)}${other ? `<p class="example-caption">${e(otherCaption)}</p>${exampleHand(other)}` : ""}`).join("");
  }
  return `<div class="rule-card${on ? "" : " off"}"${inMatch ? ` data-flip="rule:${e(rule.key)}" data-on="${on}"` : ""}><span class="rule-ico">${icon(RULE_ICON[rule.key] || "star.fill",30,{idle:false})}</span><div class="rule-help-copy"><strong>${e(rule.name)}${active ? ` <span class="pill rule-state active">active</span>` : near ? ` <span class="pill rule-state near">one move away</span>` : ""}</strong><p>${e(rule.description)}</p>${variantsHtml(rule.key)}<div class="rule-example" id="example-${e(token)}"${expanded ? "" : " hidden"}>${examples}</div></div><div class="rule-side">${editable ? `<button type="button" class="rule-check" role="checkbox" aria-checked="${on}" data-live-rule="${e(rule.key)}" data-enable="${!on}" aria-label="${e(rule.name)}">${icon(on ? "checkmark.circle.fill" : "circle.fill", 24, { idle: false, sw: 2.5, cls: on ? "" : "bare" })}</button>` : ""}<button type="button" class="rule-eye${expanded ? " c-p3" : ""}" data-rule-example="${e(token)}"${inMatch ? ` data-rule-player="${player}" data-rule-key="${e(rule.key)}"` : ""} aria-expanded="${expanded}" aria-controls="example-${e(token)}" aria-label="Show examples for ${e(rule.name)}">${icon("eye.fill",18,{idle:false})}</button></div></div>`;
}

let voidTimer;
function renderVoidOffer() {
  clearTimeout(voidTimer);
  let dialog = document.getElementById("void-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "void-dialog";
    // laid out like the Leave dialog: a stacked sticker on the left, the wide choice beside it
    dialog.className = "social-dialog leave-dialog";
    dialog.setAttribute("aria-label", "Void game offer");
    dialog.addEventListener("cancel", event => event.preventDefault());
    document.body.append(dialog);
  }
  const offer = state?.void_offer;
  if (!offer) { if (dialog.open) dialog.close(); delete dialog.dataset.offer; return; }
  const own = offer.by === state.viewer && !state.spectator;
  const expiry = typeof offer.expires_at === "number" ? offer.expires_at * 1000 : Date.parse(offer.expires_at);
  const seconds = Math.max(0, Math.min(30, Math.ceil((expiry - Date.now()) / 1000)));
  const signature = `${state.id}|${offer.by}|${offer.expires_at}`;
  if (dialog.dataset.offer !== signature) {
    dialog.dataset.offer = signature;
    dialog.innerHTML = `<h2>Void game &amp; end series early?</h2><p>${own ? "Waiting for your opponent." : `${e(state.names[offer.by])} wants to void this game and end the series early.`}</p><p><strong>NO RATING CHANGE.</strong> This game will not count. Completed rounds are preserved.</p><p>Play is paused. Offer expires in <b data-void-seconds></b>s.</p>${own || state.spectator ? "" : `<div class="dialog-actions signin-actions"><button type="button" class="close-btn c-p2" data-void-reply="decline">${icon("xmark.circle.fill", 30)}<span>${padTag("x")}Decline</span></button><button type="button" class="btn c-p3 grow" data-void-reply="accept">${tilted("eject.fill", 26)}<span>${padTag("y")}Accept</span></button></div>`}`;
  }
  dialog.querySelector("[data-void-seconds]").textContent = Number.isFinite(seconds) ? seconds : 30;
  if (!dialog.open) dialog.showModal();
  voidTimer = setTimeout(renderVoidOffer, 1000);
}

/* A signed-in player's settings follow their account: a device takes the
   account's when it has any, and otherwise gives it this device's. Every later
   change is saved to both. */
let prefsTimer;
function pushPrefs() {
  if (!session?.account) return;
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(() => {
    const preferences = accountPrefs();
    api("/api/account/preferences", "POST", { preferences })
      .then(() => {
        if (session) session.preferences = preferences;
      })
      .catch(() => {}); // still saved on this device
  }, 400);
}
function syncPrefs() {
  if (!session?.account) return;
  if (session.preferences) adoptPrefs(session.preferences);
  else pushPrefs();
}
onPrefsSaved = pushPrefs;

/**
 * Solo (Practice streaks) and PVP (MMR): the leader's card up top, then every
 * player in a green row, styled like the Advanced stats ranking.
 */
function leaderboardBody(tab, result) {
  const solo = tab === "solo",
    rows = result[tab] || [];
  const mine = session.account ? "account:" + session.account.id : null;
  // what the board is ranked by: under the board, as on the Records tab
  const intro = `<p class="hint dark leader-foot">${solo ? "Ranked by best solo streak against Golfbot · All time" : `Ranked by MMR, the rating from Ranked series${rows.some((row) => row.provisional) ? " (? = still settling)" : ""}`}${rows.some((row) => row.id?.startsWith("account:")) ? ". Tap a player for their full record." : ""}</p>`;
  if (!rows.length)
    return `<section class="panel c-fw leader-empty">${tilted(solo ? "flame.fill" : "trophy.fill", 52, { key: "leader-empty" })}<p>No ${solo ? "solo streaks" : "rated results"} yet.</p><p class="hint dark">${solo ? "Win games in a row against Golfbot to get on the board." : "Finish a Ranked series to get on the board."}</p></section>${intro}`;
  const value = (row) => (solo ? row.best_streak : row.mmr);
  const record = (row) => `${statNumber(row.wins)}–${statNumber(row.draws)}–${statNumber(row.losses)}`;
  // PVP: W–D–L counts series; the games inside them are counted apart
  const gameRecord = (row) => (row.games ? `${statNumber(row.games.wins)}–${statNumber(row.games.draws)}–${statNumber(row.games.losses)}` : "—");
  const settling = (row) => (!solo && row.provisional ? "?" : "");
  const rate = (row) => (row.win_rate === null || row.win_rate === undefined ? "—" : statPercent(row.win_rate));
  const who = (row) => `${nameMark(row.id, row.id === mine)}${e(row.label)}`;
  const leader = rows[0];
  const tile = (text, label) => `<div><b>${text}</b><span>${label}</span></div>`;
  const hero = `<section class="panel c-p3 stat-hero leader-hero">
      <span class="leader-trophy">${tilted("trophy.fill", 48, { key: "leader-trophy" })}</span>
      <div class="stat-rate${solo ? " streak-rate" : ""}">${solo ? icon("flame.fill", 44, { key: "leader-flame" }) : ""}${stickerText(String(value(leader)), { split: true, key: "leader-value" })}${solo ? "" : stickerText("MMR", { cls: "pts", key: "leader-elo" })}</div>
      <p><strong>${who(leader)}</strong> ${solo ? "· best streak" : "is on top"}</p>
      <div class="stat-tiles">${tile(record(leader), solo ? "W–D–L" : "series W–D–L")}${tile(rate(leader), "win rate")}${solo ? tile(statNumber(leader.wins + leader.draws + leader.losses), "games") : tile(gameRecord(leader), "games W–D–L")}</div>
    </section>`;
  const list = rows
    .map((row, i) => {
      // (a signed-in player's row opens their profile; so does a debug server's demo player's)
      const opens = row.id?.startsWith("account:") || row.id?.startsWith("demo:");
      const tag = opens ? "button" : "div";
      const attrs = opens ? ` type="button" data-stats-player="${e(row.id)}"` : "";
      return `<${tag}${attrs} class="list-item board-row ${i === 0 ? "c-p3" : "c-fw"}${row.id === mine ? " mine" : ""}" style="--i:${i}" aria-label="${i + 1}. ${e(row.label)}, ${solo ? `best streak ${value(row)}` : `${value(row)} MMR`}, ${solo ? "" : "series "}${record(row)}, ${rate(row)} win rate${solo ? "" : `, games ${gameRecord(row)}`}">
        <span class="rank">${i === 0 ? tilted("trophy.fill", 30, { key: "lb-first" }) : stickerText(String(i + 1), { key: `lb-rank:${i}` })}</span>
        <div class="grow"><strong>${who(row)}</strong><small>${solo ? "" : "Series "}${record(row)} · ${rate(row)} win rate${solo ? "" : ` · Games ${gameRecord(row)}`}</small></div>
        <b class="rate">${solo ? `<small class="streak-now">currently ${statNumber(row.current_streak ?? 0)}</small>${icon("flame.fill", 22, { idle: false })}<span class="streak-num">${statNumber(value(row))}</span>` : `${statNumber(value(row))}${settling(row)}<small>MMR</small>`}</b>${opens ? glyph("chevron.right", 16) : ""}
      </${tag}>`;
    })
    .join("");
  return `${hero}<div class="list leader-list">${list}</div>${intro}`;
}
/** Time in games, as a number and its unit: hours once there's an hour of it, else minutes. */
function timeParts(seconds) {
  if (seconds == null) return [0, "hrs"];
  if (seconds >= 3600) {
    const hours = Math.round((seconds / 3600) * 10) / 10;
    return [hours, hours === 1 ? "hr" : "hrs"];
  }
  const minutes = Math.round(seconds / 60);
  return [minutes, minutes === 1 ? "min" : "mins"];
}
const timeLabel = (seconds) => timeParts(seconds).join(" ");
/** Records: the all-time bests, one card each. */
function recordsBody(records = {}, personal = {}) {
  // (two columns of cards that each keep to their own height, as the Flags tab's do)
  return hugColumns(recordCards(records, personal).map(({ html }) => html));
}
/**
 * Every record's card, with the record it shows (null while nobody holds it). Under
 * each record that a player can hold, the viewer's own best (their PR), when they have one.
 */
function recordCards(records = {}, personal = {}) {
  const mine = session.account ? "account:" + session.account.id : null;
  const who = (record) => `${nameMark(record.id, !!record.id && record.id === mine)}${e(record.label)}`;
  const when = (at) => (at ? dateLabel(at, { month: "short", day: "numeric", year: "numeric" }) : "");
  const games = (n) => `${statNumber(n)} game${n === 1 ? "" : "s"}`;
  // the viewer's own best: a small box under the record's card, or a note that the
  // record is theirs (one reached first holds it, so an equal best only ties it)
  const pr = (key, record, mineBest, value, unit, text) => (recordValue) => {
    if (!mineBest) return "";
    if (record && personal.id && (record.id === personal.id || record.ids?.includes(personal.id)))
      return `<div class="record-pr held"><span class="record-pr-text">${youStar()}You hold this record</span></div>`;
    const tied = record && String(value) === String(recordValue);
    return `<div class="record-pr"><span class="record-pr-value">${stickerText(String(value), { split: true, key: `record-pr:${key}` })}${unit ? stickerText(unit, { cls: "pts", key: `record-pu:${key}` }) : ""}</span><span class="record-pr-text">${tied ? "Ties the record" : text}</span></div>`;
  };
  const card = (key, color, symbol, title, record, value, unit, detail, empty, note = "", mine = () => "") =>
    `<div class="record-slot ${color}" style="--i:${key}"><section class="panel ${color} record-card"><span class="record-ico">${tilted(symbol, 40, { key: `record:${key}` })}</span><h3>${title}</h3>${
      record
        ? `<div class="record-value">${stickerText(String(value), { split: true, key: `record-v:${key}` })}${unit ? stickerText(unit, { cls: "pts", key: `record-u:${key}` }) : ""}</div><p>${detail}</p>`
        : `<p class="hint dark">${empty}</p>`
    }${note ? `<p class="record-note">${note}</p>` : ""}</section>${mine(value)}</div>`;
  const days = (at) => Math.max(0, Math.floor((Date.now() / 1000 - at) / 86400));
  const { ai_vs_players: ai, luck, gospel, spectacle, recruit, upset } = records;
  // lowest total wins, so whoever has fewer points is ahead
  const aiLead = ai ? ai.player_points - ai.bot_points : 0;
  const { highest_mmr: elo, comeback, most_modifier: most, least_modifier: least, comeback_modifier: clutch, pvp_streak: streak, games_today: today, modifiers_in_game: stacked, most_time: hours, yapper, longest_pvp: marathon, bogey, lowest, party } = records;
  const [played, playedUnit] = timeParts(hours?.seconds);
  const P = personal;
  const plural = (n, one, many = one + "s") => (n === 1 ? one : many);
  const [myPlayed, myPlayedUnit] = timeParts(P.most_time?.seconds);
  const cards = [
    card(0, "c-p3", "crown.fill", "Highest MMR", elo, elo?.mmr, "MMR", elo && `<strong>${who(elo)}</strong>${elo.at ? ` · ${when(elo.at)}` : ""}`, "No Ranked series finished yet. MMR started with patch 1.4.0.", "", pr(0, elo, P.highest_mmr, P.highest_mmr?.mmr, "MMR", "Your highest")),
    card(1, "c-s4", "flame.fill", "Best PvP win streak", streak, streak?.streak, streak?.streak === 1 ? "win" : "wins", streak && `<strong>${who(streak)}</strong> won ${streak.streak} 1v1 game${streak.streak === 1 ? "" : "s"} in a row against other players${streak.at ? ` · ${when(streak.at)}` : ""}`, "No 1v1 games won against another player yet.", "", pr(1, streak, P.pvp_streak, P.pvp_streak?.streak, plural(P.pvp_streak?.streak, "win"), "Your best streak")),
    card(2, "c-p2", "arrow.up.right", "Biggest comeback", comeback, comeback?.points, "pts", comeback && `<strong>${who(comeback)}</strong> was ${comeback.points} pts behind${comeback.opponents?.length ? ` ${e(comeback.opponents.length === 1 ? comeback.opponents[0] : `${comeback.opponents.length} players`)}` : ""} and won${comeback.scores ? ` ${e(comeback.scores.join("–"))}` : ""}${comeback.at ? ` · ${when(comeback.at)}` : ""}`, "No comebacks yet. The winner has to have been behind at some point.", "", pr(2, comeback, P.comeback, P.comeback?.points, "pts", "Your biggest")),
    card(3, "c-s7", "clock.arrow.circlepath", "Most games today", today, today?.games, today?.games === 1 ? "game" : "games", today && `<strong>${who(today)}</strong> has finished the most games since midnight`, "No games finished today yet.", "", pr(3, today, P.games_today, P.games_today?.games, plural(P.games_today?.games, "game"), "Yours today")),
    card(4, "c-p1", "star.fill", "Most common rule", most, most && statNumber(most.activations), most?.activations === 1 ? "time" : "times", most && `<strong>${e(most.name)}</strong> has come into play ${statNumber(most.activations)} time${most.activations === 1 ? "" : "s"}, the most of any rule`, "No rules have come into play yet.", `Leaves out ${e((records.always_in_play || []).join(" and "))}, which comes into play every game it's on.`, pr(4, null, P.most_modifier, P.most_modifier && statNumber(P.most_modifier.activations), plural(P.most_modifier?.activations, "time"), `Yours: <strong>${e(P.most_modifier?.name || "")}</strong>`)),
    card(5, "c-p4", "wand.and.stars", "Least common rule", least, least && statPercent(least.rate), "", least && `<strong>${e(least.name)}</strong> came into play in ${statNumber(least.active)} of ${games(least.games)} it was on`, "Not enough games with rules yet."),
    card(6, "c-s5", "bolt.fill", "Comeback rule", clutch, clutch?.wins, clutch?.wins === 1 ? "win" : "wins", clutch && `<strong>${e(clutch.name)}</strong> was in play for the winner in the most comeback wins`, "No comeback wins with a rule yet.", records.always_in_play?.length ? `Leaves out ${e(records.always_in_play.join(" and "))}.` : ""),
    card(7, "c-s6", "sparkles", "Most rules in play on one hand", stacked, stacked?.count, stacked?.count === 1 ? "rule" : "rules", stacked && `<strong>${who(stacked)}</strong> had ${stacked.count} in play in one game: ${e(stacked.rules.join(", "))}${stacked.at ? ` · ${when(stacked.at)}` : ""}`, "No games with rules in play yet.", "", pr(7, stacked, P.modifiers_in_game, P.modifiers_in_game?.count, plural(P.modifiers_in_game?.count, "rule"), "Your most")),
    card(8, "c-p2", "text.bubble.fill", "Biggest yapper", yapper, yapper && statNumber(yapper.emotes), yapper?.emotes === 1 ? "emote" : "emotes", yapper && `<strong>${who(yapper)}</strong> has sent the most emotes at the table`, "No emotes counted yet. Counting started with this update.", "", pr(8, yapper, P.yapper, P.yapper && statNumber(P.yapper.emotes), plural(P.yapper?.emotes, "emote"), "Yours")),
    card(9, "c-s7", "clock.arrow.circlepath", "Longest 1v1 game", marathon, marathon && statNumber(marathon.turns), marathon?.turns === 1 ? "turn" : "turns", marathon && `<strong>${e((marathon.players || []).join(" vs "))}</strong>${marathon.scores ? ` finished ${e(marathon.scores.join(" to "))}` : ""} after ${statNumber(marathon.turns)} turns${marathon.at ? ` · ${when(marathon.at)}` : ""}`, "No 1v1 games between players yet.", "", pr(9, marathon, P.longest_pvp, P.longest_pvp && statNumber(P.longest_pvp.turns), plural(P.longest_pvp?.turns, "turn"), "Your longest")),
    card(10, "c-p1", "tortoise.fill", "Bogey monster", bogey, bogey?.points, "pts", bogey && `<strong>${who(bogey)}</strong> finished a game on ${bogey.points} pts, the most ever${bogey.scores ? ` (scores: ${e(bogey.scores.join(", "))})` : ""}${bogey.at ? ` · ${when(bogey.at)}` : ""}`, "No games finished yet.", "", pr(10, bogey, P.bogey, P.bogey?.points, "pts", "Your highest")),
    card(11, "c-s5", "bird.fill", "Lowest score", lowest, lowest?.points, "pts", lowest && `<strong>${who(lowest)}</strong> finished a game on ${lowest.points} pts, the fewest ever${lowest.scores ? ` (scores: ${e(lowest.scores.join(", "))})` : ""}${lowest.at ? ` · ${when(lowest.at)}` : ""}`, "No games finished yet.", "", pr(11, lowest, P.lowest, P.lowest?.points, "pts", "Your lowest")),
    card(12, "c-s4", "person.3.fill", "It's a party", party, party?.count, "signed in", party && `<strong>${e((party.players || []).join(", "))}</strong> all played in one game${party.seats > party.count ? ` of ${party.seats}` : ""}${party.at ? ` · ${when(party.at)}` : ""}`, "No game with two signed-in players yet.", "", pr(12, party, P.party, P.party?.count, "signed in", "Your biggest")),
  ];
  cards.push(card(13, "c-s2", "hourglass", "Most hours played", hours, played, playedUnit, hours && `<strong>${who(hours)}</strong> has spent ${e(timeLabel(hours.seconds))} in games`, "No games played yet.", "", pr(13, hours, P.most_time, myPlayed, myPlayedUnit, "Yours")));
  cards.push(
    card(14, "c-s6", "cpu.fill", "CPU vs. all players", ai, ai && statNumber(Math.abs(aiLead)), "pts", ai && `<strong>${who(ai)}</strong> ${aiLead > 0 ? "is ahead of" : aiLead < 0 ? "is behind" : "is level with"} everyone put together: ${statNumber(ai.bot_points)} pts to the players' ${statNumber(ai.player_points)} over ${games(ai.games)} of solo play (lowest wins)`, "No solo games against Golfbot yet."),
    card(15, "c-p1", "dice.fill", "Luck of the draw", luck, luck && statPercent(luck.rate), "", luck && `<strong>${who(luck)}</strong> gets to go first ${statPercent(luck.rate)} of the time (${statNumber(luck.first)} of ${games(luck.games)})… because of course they do!`, "Nobody has played 20 games with a random first turn yet. Counting started with patch 1.4.0."),
    card(16, "c-s7", "link", "Spreading the gospel", gospel, gospel?.count, gospel?.count === 1 ? "player" : "players", gospel && `<strong>${who(gospel)}</strong> has brought the most people to the table through invite links`, "Nobody has joined through an invite link yet. Counting started with patch 1.4.0."),
    card(17, "c-p4", "binoculars.fill", "Quite the spectacle", spectacle, spectacle?.count, spectacle?.count === 1 ? "spectator" : "spectators", spectacle && `<strong>${e((spectacle.players || []).join(" vs "))}</strong>${spectacle.scores ? ` finished ${e(spectacle.scores.join(" to "))}` : ""} in front of the biggest crowd${spectacle.at ? ` · ${when(spectacle.at)}` : ""}`, "No game has had a spectator yet. Counting started with patch 1.4.0."),
    card(18, "c-s5", "leaf.fill", "Newest recruit", recruit, recruit && (recruit.at ? (days(recruit.at) === 0 ? "Today" : days(recruit.at)) : "New"), recruit?.at && days(recruit.at) > 0 ? (days(recruit.at) === 1 ? "day ago" : "days ago") : "", recruit && `<strong>${who(recruit)}</strong> is the newest Golf account${recruit.at ? ` · joined ${when(recruit.at)}` : ""}`, "No accounts yet."),
    card(19, "c-p2", "arrow.up.right.circle.fill", "David vs. Goliath", upset, upset && statNumber(upset.gap), "pts apart", upset && `<strong>${who(upset)}</strong> (${statNumber(upset.ratings[0])}) won a series against ${e(upset.opponent)} (${statNumber(upset.ratings[1])})${upset.points ? `, ${e([upset.points[upset.winner], upset.points[1 - upset.winner]].join(" to "))}` : ""}: the biggest upset by rating${upset.at ? ` · ${when(upset.at)}` : ""}`, "No rated series has gone to the lower-rated player yet."),
  );
  const held = [elo, streak, comeback, today, most, least, clutch, stacked, yapper, marathon, bogey, lowest, party, hours, ai, luck, gospel, spectacle, recruit, upset];
  return cards.map((html, i) => ({ html, record: held[i] }));
}
/** The last leaderboards fetched (Aces and You draw from it). */
let leaderboardCache = null;

/* ---------- patch notes & rules ---------- */
async function patchesPage() {
  markPatchSeen();
  document.title = "Patch notes · Golf";
  history.replaceState({}, "", appPath("/patch-notes"));
  show(
    "patches",
    `<div class="page scroll">${subHeader("Patch Notes")}<div class="loading">Loading patch notes…</div></div>`,
  );
  try {
    const notes = await api("/api/patch-notes");
    if (page !== "patches") return;
    show(
      "patches",
      `<div class="page scroll">${subHeader("Patch Notes")}<div class="stack wide">${notes.patches
        .map(
          (patch) =>
            `<article class="panel ${patch.version === notes.current ? "c-p4" : "c-fw"}"><span class="pill">${patch.version === notes.current ? "Latest update" : "Previous update"}</span><h2 style="margin-top:.8rem">Patch ${e(patch.version)}</h2>${patchNotesHtml(patch)}</article>`,
        )
        .join("")}</div></div>`,
    );
  } catch (error) {
    if (page === "patches")
      show(
        "patches",
        `<div class="page scroll">${subHeader("Patch Notes")}<p class="empty">${e(error.message)}</p></div>`,
      );
  }
}
function rulesPage() {
  document.title = "Rules · Golf";
  const body = (text) => `<p>${text}</p>`;
  show(
    "rules",
    `<div class="page scroll">${subHeader("Rules")}<div class="stack wide">
    <section class="panel c-p1"><h2>${tilted("flag.pattern.checkered", 26)} The goal</h2>${body("Everyone gets six face-down cards in two rows of three. Flip, draw and swap to build the <b>lowest</b> score. When a player has all six cards face up, everyone else gets one final turn.")}</section>
    <section class="panel c-p3"><h2>${tilted("hand.tap.fill", 26)} Your turn</h2>${body("<b>Double-tap</b> a face-down card to flip it, or the go-fish pile to draw.")}${body("<b>Drag</b> any card to move it. While you drag, every legal move lights up: swap with the discards, swap with your go-fish card, or discard.")}${body("After flipping a card you can swap it away, go fish, or end your turn.")}</section>
    <section class="panel c-p2"><h2>${tilted("number", 26)} Card points</h2><div class="table-wrap"><table><tbody><tr><th>Ace</th><td>1</td></tr><tr><th>2</th><td>−2</td></tr><tr><th>3–10</th><td>Face value</td></tr><tr><th>Jack, Queen</th><td>10</td></tr><tr><th>King</th><td>0</td></tr><tr><th>Matching column</th><td>0 for both</td></tr></tbody></table></div></section>
    ${[true, false].map(house => `<section class="panel ${house ? "c-p4" : "c-fw"}"><h2>${house ? "House rules" : "Optional rules"}</h2>${catalog.filter(rule => !!matchOptions.house_rules[rule.key] === house).map(rule => ruleHelpCard(rule)).join("")}</section>`).join("")}
    </div></div>`,
  );
}

/* ---------- events ---------- */
async function navigate(target) {
  leaveAfterSignIn = null;
  if (target === "home") return home();
  if (target === "history") return historyPage();
  // (Leaderboard and Spectate live on the home screen now, as Aces and Watch;
  // Advanced stats was split between You and each player's card)
  if (target === "leaderboard") return home("aces");
  if (target === "stats") return home("you");
  if (["flags", "you", "play", "watch", "aces"].includes(target)) return home(target);
  if (target === "patches") return patchesPage();
  if (target === "notifications") return notificationsPage();
  if (target === "account") return home("you"); // (the old Profile page: it is the You tab now)
  if (target === "rules") return rulesPage();
  if (target === "cards") return cardGallery();
  if (target === "friends") return friendsPage();
  if (target === "spectate") return home("watch");
  if (target === "passplay") return passPlayPage(0);
  if (target === "resume") {
    closeSheet();
    page = "room";
    return resume();
  }
  if (target === "solo") return playSolo();
  if (target === "host" || target === "tournament") {
    if (document.getElementById("username")) saveName(name());
    return startSetup(target);
  }
}
document.addEventListener("click", async (event) => {
  // tapping the dimmed area behind a sheet closes it
  if (event.target === sheetRoot) return closeSheet();
  // and tapping the dimmed table around the results sets them aside to look
  // at the table (the Results button brings them back)
  // (the results float over the table, so that is any tap that misses their
  // panel, graph, emotes and buttons, not only one on the scrim itself)
  const onTable =
    event.target.classList?.contains("summary-scrim") ||
    (event.target.closest?.(".summary.floating") &&
      !event.target.closest(".summary-panel, .eval-chart, .summary-emote-anchor, button"));
  if (onTable && !board.summaryHidden) {
    board.summaryHidden = true;
    return renderSummary();
  }
  const button = event.target.closest("button, a[data-nav]");
  if (!button || button.disabled) return;
  if (button.matches("a[data-nav]")) event.preventDefault();
  const data = button.dataset;
  try {
    if (data.leaveChoice) return resolveLeavePrompt(data.leaveChoice);
    if (await tournamentClick(button, data)) return;
    if (await homeClick(button, data, event)) return;
    if (button.classList.contains("slot")) {
      // pointer taps are handled by the board; this is keyboard activation.
      // (A tap on the haptic switch also clicks with no detail: not a key press.)
      if (event.detail === 0 && event.target === button)
        tapSlot(JSON.parse(data.ref), button);
      return;
    }
    if (data.bracketRound !== undefined) return showRound(Number(data.bracketRound));
    if (data.listTab) {
      // Match history: PVP, Solo or Tournaments
      // (the arrow over the selector slides across to the list now showing)
      const before = root.querySelector(".list-dock .aces-pointer")?.getBoundingClientRect().left;
      const order = LIST_TABS.map(([key]) => key);
      historyEnter = Math.sign(order.indexOf(data.listTab) - order.indexOf(historyTab));
      historyTab = data.listTab;
      const loading = historyPage();
      const pointer = root.querySelector(".list-dock .aces-pointer");
      if (pointer && before != null && pointer.animate && !reducedMotion.matches) {
        const dx = before - pointer.getBoundingClientRect().left;
        if (Math.abs(dx) > 0.5) pointer.animate([{ translate: `${dx}px 0` }, { translate: "0 0" }], { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      }
      return loading;
    }
    if (data.info) {
      event.preventDefault();
      const open = !openInfo.delete(data.info);
      if (open) openInfo.add(data.info);
      document.getElementById(`info-${data.info}`).classList.toggle("open", open);
      button.setAttribute("aria-expanded", open);
      return;
    }
    if (data.ruleExample) {
      const example = document.getElementById(`example-${data.ruleExample}`);
      example.hidden = !example.hidden;
      if (data.rulePlayer !== undefined) {
        const key = matchExampleKey(Number(data.rulePlayer), data.ruleKey);
        if (example.hidden) matchRuleExampleOpen.delete(key);
        else matchRuleExampleOpen.add(key);
      }
      button.setAttribute("aria-expanded", String(!example.hidden));
      button.classList.toggle("c-p3", !example.hidden);
      return;
    }
    if ("voidOffer" in data || "voidReply" in data) {
      const id = state.id;
      button.disabled = true;
      try {
        const next = await api(`/api/lobbies/${id}/${"voidOffer" in data ? "void-offer" : "void-reply"}`, "POST", "voidReply" in data ? {accept:data.voidReply === "accept"} : {});
        closeSheet();
        if (session.room_id === id) accept(next);
      } finally { button.disabled = false; }
      return;
    }
    if ("sheetClose" in data) return closeSheet();
    if ("lobbyRules" in data) return chipMatch && openLobbyRules();
    if ("confirm" in data) return await confirmStaged();
    if ("undo" in data) return cancelStaged();
    if (data.pref) return togglePref(data.pref);
    if ("settings" in data) return settingsSheet();
    if ("signin" in data) return signIn();
    if ("accountSheet" in data) return accountSheet();
    if ("uniqueName" in data) return uniqueNameSheet();
    if ("themeSettings" in data) return themeSheet();
    if (data.themePick) return pickTheme(data.themePick);
    if (data.emotePick || data.emoteDrop) {
      if (performance.now() - emoteDragEnded < 400) return; // the end of a drag, not a tap
      return data.emotePick ? pickEmote(...data.emotePick.split(":")) : dropEmote(...data.emoteDrop.split(":"));
    }
    if ("gameMenu" in data) return gameMenuSheet();
    if ("sheetPlayer" in data) return openRulesSheet(Number(data.sheetPlayer));
    if (data.statsFor)
      return await playerStatsSheet(data.statsFor === "me" ? state.viewer : board.view.opp);
    if (data.rulesPlayer != null) {
      closeSheet();
      return openRulesSheet(Number(data.rulesPlayer));
    }
    if (data.rulesFor)
      return openRulesSheet(
        data.rulesFor === "me" ? state.viewer : board.view.opp,
      );
    if (data.liveRule) {
      await move("set_rule", {
        rule: data.liveRule,
        enabled: data.enable === "true",
      });
      return;
    }
    if ("summaryEmotes" in data) {
      board.summaryEmotes = !board.summaryEmotes;
      return renderSummary();
    }
    if ("chartCycle" in data) {
      const views = chartViews();
      board.chartView = views[(views.indexOf(chartView()) + 1) % views.length];
      return renderSummary();
    }
    if ("summaryToggle" in data) {
      board.summaryHidden = !board.summaryHidden;
      return renderSummary();
    }
    if ("emotes" in data) {
      board.emotesOpen = !board.emotesOpen;
      return renderEmotes();
    }
    if ("emoteMute" in data) {
      opponentEmotesMuted = !opponentEmotesMuted;
      try {
        localStorage.setItem("golf-mute-emotes", String(opponentEmotesMuted));
      } catch {}
      if (opponentEmotesMuted)
        for (const opponent of Object.keys(activeEmotes)) {
          if (Number(opponent) === state.viewer) continue;
          clearTimeout(emoteTimers[opponent]);
          delete activeEmotes[opponent];
        }
      return renderEmotes();
    }
    if (data.emote) {
      board.emotesOpen = false;
      renderEmotes();
      return await sendEmote(data.emote);
    }
    if ("queueToggle" in data) {
      if (presenceState.queue?.status === "waiting") {
        presenceState.queue = await api("/api/queue/leave", "POST");
        return renderQueueBanner();
      }
      if (presenceState.queue?.status === "offer") {
        hiddenQueueOffer = null;
        socialSignature = "";
        return renderSocial();
      }
      return await joinQueue();
    }
    if ("queueHide" in data) {
      hiddenQueueOffer = presenceState.queue.id;
      return closeSocial();
    }
    if ("queuePeek" in data) return peekQueuePill();
    if ("queueView" in data) return renderQueueBanner(); // the offer is in the pill
    if ("queueLeave" in data || data.queueReply) {
      button.disabled = true;
      try {
        if ("queueLeave" in data)
          presenceState.queue = await api("/api/queue/leave", "POST");
        else {
          presenceState.queue = await api(
            `/api/queue/offers/${presenceState.queue.id}/respond`,
            "POST",
            {
              accept: data.queueReply === "accept",
              username: name(),
              avatar: session.avatar,
            },
          );
          if (presenceState.queue.status === "matched") await enterQueueMatch();
        }
        socialSignature = "";
        renderQueueBanner();
        renderSocial();
      } catch (error) {
        toast(error.message);
        button.disabled = false;
        await pollPresence();
      }
      return;
    }
    if ("socialClose" in data) return closeSocial();
    if ("patchClose" in data) return closePatchPopup();
    if (data.invitePlayer || data.inviteReply) {
      button.disabled = true;
      try {
        if (data.invitePlayer) {
          const cup = hostedLobby();
          await api(cup ? `/api/tournaments/${cup.id}/invite` : `/api/lobbies/${state.id}/invite`, "POST", {
            player_id: data.invitePlayer,
          });
          await pollPresence();
        } else {
          const invited = presenceState.invitations.find((item) => item.id === data.invitation);
          const epoch = tableEpoch;
          // accepting from a game against Golfbot leaves that table first (and may ask, as leaving it does)
          if (data.inviteReply === "accept" && session.room_id && !(await abandonExisting())) {
            button.disabled = false;
            return;
          }
          const next = await api(
            `/api/invitations/${data.invitation}/respond`,
            "POST",
            {
              accept: data.inviteReply === "accept",
              username: name(),
              avatar: session.avatar,
            },
          );
          dismissedInvites.add(data.invitation);
          closeSocial();
          if (data.inviteReply === "accept" && epoch === tableEpoch) {
            if (invited?.tournament) {
              // into the tournament's lobby, to wait for the start with everyone else
              tournament = next;
              tournamentBack = "friends";
              await tournamentPage(next.id);
            } else enterRoom(next);
          }
          await pollPresence();
        }
      } catch (error) {
        toast(error.message);
        button.disabled = false;
        await pollPresence();
      }
      return;
    }
    if ("inviteOpen" in data) {
      socialMode = "players";
      socialSignature = "";
      await pollPresence();
      return renderSocial();
    }
    if ("signout" in data) {
      const keep = { username: session.username, avatar: session.avatar };
      session = await api("/api/auth/logout", "POST", {
        csrf_token: session.csrf_token,
      });
      Object.assign(session, keep);
      closeSheet();
      if (page !== "home") return home();
      redrawPane(homeTab);
      loadTab(homeTab);
      return;
    }
    if ("debugEnd" in data) {
      closeSheet();
      setDebugTool(null);
      return debugEdit({ op: "end" });
    }
    if (data.debugTool) {
      closeSheet();
      return setDebugTool(data.debugTool);
    }
    if ("debugDone" in data) return setDebugTool(null);
    if ("debugBots" in data) {
      if (!(await abandonExisting())) return;
      saveName(name());
      return enterRoom(await api("/api/debug/bot-table", "POST", {}));
    }
    if (data.avatar) return pickAvatar(data.avatar);
    if (data.preset) return applyPreset(data.preset);
    if (data.draftRule) {
      draft.rules[data.draftRule] = !draft.rules[data.draftRule];
      draft.preset = "custom";
      return refreshRulesPicker();
    }
    if ("rulesToggle" in data) return toggleRulesPicker();
    if ("setupNext" in data) {
      saveName(name());
      draft.step = 1;
      return setupPage();
    }
    if ("setupBack" in data) {
      draft.step = 0;
      return setupPage();
    }
    if ("setupGo" in data) {
      button.disabled = true;
      try {
        await submitSetup();
      } finally {
        button.disabled = false;
      }
      return;
    }
    if (data.nav) return await navigate(data.nav);
    if (data.statsPlayer) {
      // (at a table, the profile comes up in a sheet; from the home screen it is a page)
      closeSheet();
      return page === "room" ? playerSheet(data.statsPlayer) : profilePage(data.statsPlayer);
    }
    if ("historyMore" in data) return await historyPage(true);
    if (data.lobby) return await publicLobby(data.lobby);
    if (data.join) {
      const epoch = tableEpoch;
      saveName(name());
      if (!(await abandonExisting())) return;
      const next = await api(`/api/lobbies/${data.join}/join`, "POST", {
        username: session.username,
        avatar: session.avatar,
        // opened from the table's invite link (it counts for the host's record)
        ...(linkedLobby === data.join ? { via: "link" } : {}),
      });
      if (epoch === tableEpoch) enterRoom(next);
      return;
    }
    if ("leave" in data && state?.spectator) return home("watch");
    if ("watch" in data) return watchGame(data.watch);
    if ("passStart" in data) return startPassPlay();
    if ("passNext" in data) return passPlayPage(passStep + 1);
    if ("passBack" in data) return passPlayPage(passStep - 1);
    if ("passReady" in data) return document.querySelector(".pass-shade")?.remove();
    if ("leave" in data) {
      const epoch = tableEpoch;
      if (!(await abandonExisting())) return;
      if (epoch !== tableEpoch) return;
      state = null;
      return home();
    }
    if (data.copy) {
      try {
        await navigator.clipboard.writeText(data.copy);
        toast("Invite link copied.");
      } catch {
        toast("Copy the lobby link from the address bar.");
      }
      return;
    }
    if (data.guess) {
      await move("guess", {
        rank: data.guess === "pass" ? null : Number(data.guess),
      });
      return;
    }
    if (data.columns) {
      await move("arrange", {
        columns:
          data.columns === "keep" ? null : data.columns.split(",").map(Number),
      });
      return;
    }
    if (data.action) {
      if (button.closest("[data-actionbar], [data-side-actions]")) await barAction(data.action);
      else await move(data.action);
    }
  } catch (error) {
    toast(error.message);
  }
});
document.addEventListener("pointerdown", (event) => {
  // tapping anywhere else dismisses the emote tray
  if (
    board.emotesOpen &&
    !event.target.closest?.(".emote-pop, [data-emotes]")
  ) {
    board.emotesOpen = false;
    if (state?.game && board.el?.isConnected) renderEmotes();
  }
});
/**
 * The Profile page saves itself: the avatar as the wheel settles on one, the
 * name a moment after typing stops (and again when the field is left).
 */
let profileTimer = 0;
async function saveProfile() {
  clearTimeout(profileTimer);
  const input = document.getElementById("account-display-name");
  if (!input) return;
  const value = input.value.trim();
  if (!value) return; // an empty name is never saved; the last one stays
  const before = { username: localStorage.getItem("golf-name"), avatar: localStorage.getItem("golf-avatar") };
  saveName(value);
  saveAvatar(session.avatar);
  if (before.username === value && before.avatar === session.avatar) return;
  if (session.account) {
    // saved to the account, so every device you sign in on uses it
    try {
      const next = await api("/api/name", "POST", { username: value, avatar: session.avatar });
      saveName(next.username);
    } catch (error) {
      return toast(error.message);
    }
  } else pollPresence(); // the server learns the new name with the next presence update
  if (before.username !== value) loadPreviousNames(); // the name just replaced joins the list
  const status = root.querySelector("[data-profile-status]");
  if (status) {
    status.textContent = "Saved";
    status.classList.remove("show");
    void status.offsetWidth;
    status.classList.add("show");
  }
}
root.addEventListener("input", (event) => {
  if (event.target.id !== "account-display-name") return;
  clearTimeout(profileTimer);
  profileTimer = setTimeout(saveProfile, 700);
});
root.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.id === "display-name-form") return saveProfile();
});
// pass & play setup: one handler each for the whole page (the page's elements are
// reused from screen to screen, so a listener per screen would pile up)
root.addEventListener("input", (event) => {
  const index = event.target.dataset?.passName;
  if (index !== undefined && passPlayers?.[Number(index)]) passPlayers[Number(index)].name = event.target.value;
});
root.addEventListener("change", async (event) => {
  const target = event.target;
  if (target.id === "account-display-name") return saveProfile();
  if (target.matches("select.cover"))
    target.previousElementSibling.textContent =
      target.selectedOptions[0]?.textContent || "";
  if (target.matches("[data-pass-count]")) {
    const n = Number(target.value);
    passPlayers = Array.from({ length: n }, (_, p) => passPlayers[p] ?? { name: `Player ${p + 1}`, avatar: null });
    return passPlayPage(0);
  }
  if (target.dataset.draft) {
    const key = target.dataset.draft;
    draft[key] = key === "length" ? Number(target.value) : target.value;
    if (["style", "length", "scorePreview", "showOdds", "gameType", "format", "seeding", "fill", "ranked"].includes(key) && draft.step === 0) {
      saveName(name());
      setupPage();
    }
    if (key === "gameType") refreshRulesPicker();
    return;
  }
  if (target.id === "username") {
    saveName(target.value.trim() || "Player");
    pollPresence();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !sheetRoot.hidden) return closeSheet();
  if (page === "room" && board.staged && sheetRoot.hidden) {
    // a staged move: Enter plays it; Escape, Delete or Backspace undo it
    if (
      ["Escape", "Delete", "Backspace"].includes(event.key) &&
      !["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)
    ) {
      event.preventDefault();
      // the key would otherwise light up a focus ring on the card just played
      document.activeElement?.blur?.();
      return cancelStaged();
    }
    // While the Confirm button is showing, Enter presses it, even with focus
    // still on the card just played (only typing, or Undo itself, keeps Enter).
    if (
      event.key === "Enter" &&
      !event.repeat &&
      board.staged.ready &&
      !["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName) &&
      !event.target.closest?.("[data-undo], dialog, .emote-pop")
    ) {
      event.preventDefault();
      document.activeElement?.blur?.();
      return confirmStaged();
    }
  }
  // Enter ends the turn once it can end (after flipping a card, say), even with
  // focus still on the card just tapped; other buttons keep Enter for themselves
  if (
    event.key === "Enter" &&
    !event.repeat &&
    page === "room" &&
    sheetRoot.hidden &&
    (!["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(event.target.tagName) || event.target.matches?.(".slot")) &&
    state?.game?.legal.end_turn
  ) {
    event.preventDefault();
    document.activeElement?.blur?.();
    move("end_turn");
  }
});
window.addEventListener("resize", () => centerAvatar(false));
/** The table this page was opened at by its address (an invite link), if any. */
let linkedLobby = null;
function route() {
  const path = currentPath();
  if (path.startsWith("/player/")) return profilePage(decodeURIComponent(path.slice("/player/".length)));
  if (path === "/patch-notes") return patchesPage();
  if (path === "/notifications") return notificationsPage();
  if (path === "/account") return home("you");
  if (path === "/leaderboard") return home("aces");
  if (path === "/stats") return home("you");
  if (path === "/history") return historyPage();
  if (path === "/spectate" || path === "/watch") return home("watch");
  if (path === "/flags" || path === "/you") return home(path.slice(1));
  const aces = path.match(/^\/aces(?:\/(records|solo|pvp))?$/);
  if (aces) {
    acesView = aces[1] || "records";
    return home("aces");
  }
  if (path === "/puzzle") return home("play");
  const id = path.match(/^\/lobby\/([^/]+)$/)?.[1];
  if (id) {
    linkedLobby = id; // arrived by its address: an invite link
    return publicLobby(id);
  }
  const cup = path.match(/^\/tournament\/([^/]+)$/)?.[1];
  if (cup) {
    tournamentLinked = cup;
    return tournamentPage(cup);
  }
  return home();
}
window.addEventListener("popstate", () => {
  Promise.resolve(route()).catch((error) => {
    toast(error.message);
    home();
  });
});
/**
 * The faces the first page is set in. Waiting for them means the page arrives
 * in its real type instead of flashing a fallback face first; a font that is
 * slow or missing never holds the page up for more than a moment.
 */
function fontsReady() {
  if (!document.fonts?.load) return Promise.resolve();
  // (and the stickers' rough cuts of both, so no sticker is first drawn smooth)
  const faces = ['700 16px "FOT-Seurat Pro"', '700 16px "SF Pro Rounded"', ...[14, 20, 28, 40, 56].map((cut) => `700 16px "Golf Rough Round ${cut}"`), '700 16px "Golf Rough Seurat 14"', '700 16px "Golf Rough Seurat 56"'].map((face) => document.fonts.load(face).catch(() => {}));
  return Promise.race([Promise.all(faces), new Promise((done) => setTimeout(done, 1500))]);
}
function bootData() {
  try {
    return JSON.parse(document.getElementById("boot-data")?.textContent || "{}");
  } catch {
    return {};
  }
}
(async () => {
  // a slow start shows the backdrop with the loading line (style.css: .loading.boot)
  setTimeout(booted, 800);
  try {
    let avatarInfo;
    // The server puts what the first page needs in the page itself (boot-data),
    // so it can be drawn straight away; anything missing is fetched as before.
    const boot = bootData();
    [session, catalog, matchOptions, avatarInfo] = await Promise.all([
      boot.session || api("/api/session"),
      boot.rules || api("/api/rules"),
      boot.matchOptions || api("/api/match-options"),
      boot.avatars || api("/api/avatars"),
      fontsReady(),
    ]);
    avatars = avatarInfo.avatars;
    if (boot.queue) presenceState.queue = boot.queue;
    try {
      // signed in, the account's saved display name wins; otherwise this device's
      if (session.account?.display_name) saveName(session.account.display_name);
      else session.username = localStorage.getItem("golf-name") || session.username;
      const saved = localStorage.getItem("golf-avatar");
      if (avatars.some((avatar) => avatar.id === saved && avatar.selectable))
        session.avatar = saved;
    } catch {}
    syncPrefs();
    if (alertsWanted(prefs).turn || alertsWanted(prefs).queue) subscribeAlerts(false).catch(() => setPref("alerts", false));
    const firstPoll = pollPresence();
    // while in the queue the server is asked far more often, so a match shows at once
    let lastPoll = performance.now();
    setInterval(() => {
      // (and in a tournament, so the next match takes its players without a wait)
      const queued = ["waiting", "offer"].includes(presenceState.queue?.status) || !!presenceState.tournament;
      if (performance.now() - lastPoll < (queued ? 1500 : 5000) - 50) return;
      lastPoll = performance.now();
      pollPresence();
    }, 500);
    try {
      await route();
    } catch (error) {
      home();
      toast(error.message);
    }
    await firstPoll;
    autoJoinQueue();
  } catch (error) {
    booted();
    root.innerHTML = `<div class="empty">${e(error.message)}<p>Refresh to reconnect to your server.</p></div>`;
  }
})();
