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
const SIDE_PAGES = ["history", "stats", "account", "patches", "rules", "leaderboard"];

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
  devils_row: "666",
  gamblers_row: "777",
  angels_row: "999",
  king_queen: "K-Q Colors",
  holdem: "Hold 'em",
  v10: "V10",
  tricky_straights: "Straights",
  ripped_five: "Ripped 5",
  roman_fives: "Roman 5s",
  beggars: "Beggars",
  four_kind: "4 of a Kind",
  poisoned_card: "Poison",
  suited_rows: "Suited rows",
  all_in_color: "All in",
  crazy_eights: "Crazy 8s",
};
const POPULAR_RULES = [
  "royal_pairs",
  "gamblers_row",
  "devils_row",
  "king_queen",
  "v10",
  "ripped_five",
  "poisoned_card",
];
const NEW_RULES = ["crazy_eights"];

/* ---------- emotes ---------- */
const emoteNames = {
  unamused: "Unamused",
  shocked: "Shocked",
  laughing: "Laughing",
  nervous: "Nervous",
  thanks: "Thanks!",
  oops: "Oops!",
  wow: "Wow!",
  save: "What a save!",
};
// these are said in words, as a speech bubble, rather than shown as a face
const TEXT_EMOTES = ["thanks", "oops", "wow", "save"];
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
    if (session.room_id === roomId) accept(next);
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
function saveAvatar(id) {
  try {
    localStorage.setItem("golf-avatar", id);
  } catch {}
  session.avatar = id;
}
function toast(text) {
  const el = document.getElementById("toast");
  el.innerHTML = `<span class="toast-text">${e(text)}</span><button type="button" class="toast-close" data-toast-close aria-label="Dismiss">${icon("xmark.circle.fill", 20)}</button>`;
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
}
function closeSheet() {
  rememberRulesScroll();
  sheetRoot.hidden = true;
  sheetRoot.innerHTML = "";
  sheetRoot.dataset.player = "";
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
function subHeader(title, back = session?.room_id ? "resume" : "home") {
  return `<header class="topbar"><button type="button" class="btn round c-fw nav-float" style="width:5.2rem;height:5.2rem" data-nav="${back}" aria-label="Back">${glyph("chevron.left", 20)}${padTag("b", "under")}</button><h1 class="page-title" style="margin-left:1.2rem">${e(title)}</h1><div class="queue-slot end"></div></header>`;
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
function backButton(target = "home") {
  return `<button type="button" class="btn round c-fw nav-float" data-nav="${target}" aria-label="Back">${glyph("chevron.left", 20)}${padTag("b", "under")}</button>`;
}

/* ---------- presence, invitations, quickplay queue ---------- */
let presenceState = {
    available_lobbies: 0,
    players: [],
    invitations: [],
    invited: [],
    queue_size: 0,
  },
  presenceBusy = false,
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
  const waiting = presenceState.queue_size || 0;
  return `${waiting} player${waiting === 1 ? "" : "s"} in Queue`;
}
function renderHomeLive() {
  const sub = document.getElementById("queue-sub");
  if (sub) sub.textContent = queueLabel();
  const badge = document.getElementById("lobby-count");
  if (badge) {
    badge.hidden = !presenceState.available_lobbies;
    badge.textContent = presenceState.available_lobbies;
    badge.setAttribute(
      "aria-label",
      `${presenceState.available_lobbies} open ${presenceState.available_lobbies === 1 ? "table" : "tables"}`,
    );
  }
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
  const leave = `<button type="button" class="act side-act queue-leave" data-queue-leave aria-label="Leave the Quickplay queue"><span class="act-ico">${icon("rectangle.portrait.and.arrow.right", 24, { sw: 3.4 })}</span><span class="side-label">Leave</span></button>`;
  if (offer && !compact) {
    const style = `${e(matchLength(queue.lobby || { best_of: 5, series_mode: "points" }))}${queue.lobby?.house_rules ? " · House rules" : ""}`;
    // Decline takes Leave's place (and keeps you in the queue); Accept hangs below the pill
    const decline = `<button type="button" class="act side-act queue-leave queue-decline" data-queue-reply="decline" aria-label="Decline this match and keep looking"><span class="act-ico">${icon("xmark.circle.fill", 24, { sw: 3.4 })}</span><span class="side-label">Decline</span></button>`;
    // a sparkle either side of the words, the second one mirrored
    const sparkle = (mirror) => icon("sparkles", 24, { idle: false, sw: 3.4, cls: mirror ? "mirrored" : "" });
    const accept = queue.accepted
      ? `<button type="button" class="btn c-p3 queue-accept" disabled>${sparkle(false)}<span>Waiting for ${e(queue.opponent)}…</span>${sparkle(true)}</button>`
      : `<button type="button" class="btn c-p3 queue-accept" data-queue-reply="accept">${sparkle(false)}<span>${padTag("y")}Accept</span>${sparkle(true)}</button>`;
    return `<div class="queue-pill offer open" role="dialog" aria-label="Classic match found"><div class="queue-offer-row"><span class="queue-text"><b>Match found!</b><small>vs ${e(queue.opponent)}<br>${style}</small></span>${decline}</div>${accept}</div>`;
  }
  const status = offer ? "Match found!" : "In queue";
  return `<div class="queue-pill${offer ? " offer" : ""}"><span class="queue-info" role="status" aria-label="Quickplay: ${status}"><span class="queue-text"><b>Quickplay</b><small>${status}</small></span></span>${leave}</div>`;
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
 * With "Join Quickplay on open" on, opening the site's home page puts the
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
  if (socialMode === "players" && state?.status !== "waiting") closeSocial();
  const invitation = session.room_id
    ? null
    : presenceState.invitations.find((item) => !dismissedInvites.has(item.id));
  if (socialMode !== "players") socialMode = invitation ? "invitation" : null;
  if (!socialMode) {
    if (dialog.open) closeSocial();
    return;
  }
  const signature = JSON.stringify([
    socialMode,
    socialMode === "players"
      ? [presenceState.players, presenceState.invited]
      : invitation,
  ]);
  if (signature === socialSignature) return;
  socialSignature = signature;
  dialog.innerHTML =
    socialMode === "players"
      ? `<h2>Invite a player</h2><p class="hint">Players online right now who aren't at a table.</p><div class="list" style="margin-top:1.2rem">${presenceState.players.map((player) => `<div class="list-item c-p1">${avatarBadge(player.avatar, "c-p1")}<div class="grow"><strong>${e(player.display_name)}</strong><small>${player.unique_name ? "@" + e(player.unique_name) : "Guest"}</small></div><button type="button" class="btn small c-p1" data-invite-player="${e(player.id)}" ${presenceState.invited.includes(player.id) ? "disabled" : ""}>${presenceState.invited.includes(player.id) ? "Invited" : "Invite"}</button></div>`).join("") || `<p>No one else is online right now. Share the invite link instead.</p>`}</div><div class="dialog-actions"><button type="button" class="btn c-fw" data-social-close>${padTag("b")}Close</button></div>`
      : `<h2>${tilted("figure.2", 30)} You're invited</h2><p><strong>${e(invitation.host)}</strong> invited you to <strong>${e(invitation.lobby.name)}</strong>.</p><div class="meta" style="margin:1rem 0"><span class="pill c-p1">${e(matchLength(invitation.lobby))}</span>${houseBadge(invitation.lobby)}</div><details><summary>More info</summary><p>First player: ${e(starter[invitation.lobby.first])}</p><p>${e(rulesSummary(invitation.lobby.rules))}</p></details><div class="dialog-actions"><button type="button" class="btn c-p1" data-invite-reply="accept" data-invitation="${e(invitation.id)}">${padTag("y")}Accept</button><button type="button" class="btn c-p2" data-invite-reply="decline" data-invitation="${e(invitation.id)}">${padTag("x")}Decline</button></div>`;
  if (!dialog.open) dialog.showModal();
}
async function pollPresence() {
  if (!session || presenceBusy) return;
  presenceBusy = true;
  try {
    presenceState = await api("/api/presence", "POST", {
      username: name(),
      avatar: session.avatar,
    });
    // a display name changed on another device follows you here
    if (session.account && presenceState.username && presenceState.username !== session.username)
      saveName(presenceState.username);
    renderQueueBanner();
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
document.getElementById("social-dialog").addEventListener("cancel", (event) => {
  if (socialMode === "queue") {
    event.preventDefault();
    hiddenQueueOffer = presenceState.queue.id;
    closeSocial();
    return;
  }
  if (socialMode === "invitation") {
    event.preventDefault();
    document.querySelector("[data-invite-reply='decline']")?.click();
  } else closeSocial();
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
function home() {
  leaveAfterSignIn = null;
  clearEmotes();
  emoteTable = "";
  document.title = "Golf";
  state = null;
  closeSocket();
  history.replaceState({}, "", appPath());
  const twin = (name, size = 33) =>
    [tilted(name, size), tilted(name, size, { mirror: true })];
  const friends = twin("figure.2"),
    quick = twin("sparkles"),
    practice = twin("dumbbell.fill");
  show(
    "home",
    `<div class="page home">${topbar()}<div class="stack">
    ${session.room_id ? `<button type="button" class="btn c-fw" data-nav="resume">${tilted("play.fill", 30)} <span>${padTag("select")}Resume your table</span></button>` : ""}
    ${patchChip()}
    <button type="button" class="btn c-p1" data-nav="friends">${friends[0]}<span>${padTag("y")}Play with Friends</span>${friends[1]}<span id="lobby-count" class="badge" hidden></span></button>
    <button type="button" class="btn c-p3" data-queue-toggle>${quick[0]}<span>${padTag("x")}Quickplay<span class="sub" id="queue-sub"></span></span>${quick[1]}</button>
    <button type="button" class="btn c-p2" data-nav="solo">${practice[0]}<span>${padTag("lb")}Practice</span>${practice[1]}</button>
    <div class="row split">
      <button type="button" class="btn tile c-p4 grow" data-nav="leaderboard">${tilted("medal", 33)}<span>${padTag("rb")}Leaderboard</span></button>
      <button type="button" class="btn tile c-fw grow" data-nav="rules">${tilted("list.bullet.clipboard.fill", 33, { tilt: 6 })}<span>Rules</span></button>
    </div>
    ${document.documentElement.dataset?.debug !== undefined ? `<button type="button" class="btn c-p2" data-debug-bots>${tilted("figure.2", 33)}<span>Debug: 8-bot table</span></button>` : ""}
  </div><p class="credit">Designed by <a href="https://spencersteadman.com" target="_blank" rel="noopener">Spencer${textSymbol("arrow.up.right", "out-arrow")}</a> &amp; <a href="https://sleptsov.dev" target="_blank" rel="noopener">Alex${textSymbol("arrow.up.right", "out-arrow")}</a></p></div>`,
  );
  renderQueueBanner();
  pollPresence();
}
/** On/off and choice rows for the settings kept on this device. */
function prefsHtml() {
  const row = (key, symbol, label, value, on, lit = on) =>
    `<button type="button" class="btn c-fw pref" role="switch" aria-checked="${on}" data-pref="${key}">${tilted(symbol, 26)}<span class="grow">${label}</span><b class="pref-value${lit ? " on" : ""}">${value}</b></button>`;
  const onOff = (on) => (on ? "On" : "Off");
  const theme = THEMES.find(([key]) => key === prefs.theme) || THEMES[0];
  const rows = [
    row("theme", "paintpalette.fill", "Theme", theme[1], theme !== THEMES[0], true),
    row("autoQueue", "sparkles", "Join Quickplay on open", onOff(prefs.autoQueue), prefs.autoQueue),
    row("confirm", "checkmark.circle.fill", "Confirm moves", onOff(prefs.confirm), prefs.confirm),
    row("turnAlerts", "bell.fill", "Turn notifications", onOff(prefs.turnAlerts), prefs.turnAlerts),
    // stored as hideTips (so existing choices carry over), shown the positive way round
    row("hideTips", "text.bubble.fill", "Show tooltips", onOff(!prefs.hideTips), !prefs.hideTips),
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
/* ---------- turn notifications ----------
   With them on, the server pushes a "your turn" notification (which also buzzes
   phones that allow it) whenever your turn comes while Golf is in the background. */
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
function pushKeyBytes(key) {
  const raw = atob(key.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(key.length / 4) * 4, "="));
  return Uint8Array.from(raw, (char) => char.charCodeAt(0));
}
/** Subscribe this browser to turn notifications (asking permission first, when `ask`). */
async function subscribeTurnAlerts(ask) {
  if (!pushSupported()) throw new Error("This browser can't show notifications. On iPhone, add Golf to your Home Screen first.");
  const permission = ask ? await Notification.requestPermission() : Notification.permission;
  if (permission !== "granted") throw new Error("Notifications are blocked for Golf. Allow them in your browser's settings.");
  const registration = await navigator.serviceWorker.register(appPath("/sw.js"));
  await navigator.serviceWorker.ready;
  const { key } = await api("/api/push/key");
  const subscription =
    (await registration.pushManager.getSubscription()) ||
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: pushKeyBytes(key) }));
  await api("/api/push/subscribe", "POST", { subscription: subscription.toJSON() });
}
/**
 * On a phone, your turn also shows a short notification while Golf is open, so
 * the phone buzzes with its own alert (the only buzz some phones allow a web
 * page). Away from Golf, the server's push does the same.
 */
async function buzzTurnNotification() {
  if (!prefs.turnAlerts || !touchDevice || !pushSupported() || Notification.permission !== "granted") return;
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
async function toggleTurnAlerts() {
  const on = !prefs.turnAlerts;
  try {
    if (on) await subscribeTurnAlerts(true);
    else {
      await api("/api/push/unsubscribe", "POST");
      const registration = await navigator.serviceWorker?.getRegistration(appPath("/sw.js"));
      await (await registration?.pushManager.getSubscription())?.unsubscribe();
    }
    setPref("turnAlerts", on);
    if (on) toast("You'll get a notification when it's your turn.");
  } catch (error) {
    setPref("turnAlerts", false);
    toast(error.message);
  }
  const holder = sheetRoot.querySelector("[data-prefs]");
  if (holder) holder.outerHTML = prefsHtml().replace(/^<h3>.*?<\/h3>/, "");
}
function togglePref(key) {
  if (key === "turnAlerts") return toggleTurnAlerts();
  if (key === "padDrag") setPref(key, prefs.padDrag === "toggle" ? "hold" : "toggle");
  else if (key === "theme") {
    const at = THEMES.findIndex(([name]) => name === prefs.theme);
    setPref(key, THEMES[(at + 1) % THEMES.length][0]);
  } else setPref(key, !prefs[key]);
  if (key === "confirm" && !prefs.confirm) cancelStaged();
  const holder = sheetRoot.querySelector("[data-prefs]");
  if (holder) holder.outerHTML = prefsHtml().replace(/^<h3>.*?<\/h3>/, "");
  const help = sheetRoot.querySelector("[data-pad-help]");
  if (help) help.outerHTML = padHelpHtml();
  if (state?.game && page === "room") renderBoard();
}
function settingsSheet() {
  const account = session.account;
  openSheet(`<section class="sheet c-fw" role="dialog" aria-modal="true" aria-label="Settings">
    <div class="sheet-head"><h2>Settings</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    <div class="menu-list">
      ${session.room_id && page !== "room" ? `<button type="button" class="btn c-p1" data-nav="resume">${tilted("play.fill", 26)} Resume your table</button>` : ""}
      <button type="button" class="btn c-p1" data-nav="account">${tilted("person.crop.circle.fill", 26)} ${account ? e(account.unique_name ? "@" + account.unique_name : "Choose unique name") : "Sign in with Google"}</button>
      <button type="button" class="btn c-p3" data-nav="history">${tilted("clock.arrow.circlepath", 26)} Match history</button>
      <button type="button" class="btn c-p2" data-nav="leaderboard">${tilted("medal", 26)} Leaderboard</button>
      ${voidOfferButton()}
      <button type="button" class="btn c-p4" data-nav="patches">${tilted("newspaper.fill", 26)} Patch notes</button>
      <a class="btn c-fw" href="privacy">${tilted("lock.fill", 26)} Privacy</a>
    </div>
    ${prefsHtml()}
    ${padHelpHtml()}
    <p class="hint dark sheet-note">This website has been programmed by Claude Fable 5.2. Front-end design was handmade in <a href="https://www.figma.com/design/OtrBljPuG5YggsJYThYGpq/Golf?node-id=114-91&amp;t=EDkY7LXjEWflPbP6-0" target="_blank" rel="noopener">Figma${textSymbol("arrow.up.right", "out-arrow")}</a> by Spencer.</p>
  </section>`);
}
function voidOfferButton() {
  if (!state?.rated) return "";
  const disabled = state.status !== "playing" || state.void_offer || state.void_offered?.[state.viewer];
  return `<button type="button" class="btn c-p4" data-void-offer ${disabled ? "disabled" : ""}>Void game &amp; end series early</button>`;
}
function gameMenuSheet() {
  const link = `${location.origin}${appPath(`/lobby/${state.id}`)}`;
  openSheet(`<section class="sheet c-fw" role="dialog" aria-modal="true" aria-label="Table menu">
    <div class="sheet-head"><h2>${e(state.name)}</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    <p class="hint dark" style="margin-bottom:1.2rem">Game ${state.round} · ${e(matchLength(state))}</p>
    <div class="menu-list">
      <button type="button" class="btn c-p1" data-rules-for="me">${tilted("checklist", 26)} Rules &amp; scores</button>
      ${state.solo ? "" : `<button type="button" class="btn c-p3" data-copy="${e(link)}">${tilted("link", 26)} Copy invite link</button>`}
      <button type="button" class="btn c-p3" data-nav="history">${tilted("clock.arrow.circlepath", 26)} Match history</button>
      <button type="button" class="btn c-p4" data-nav="rules">${tilted("list.bullet.clipboard.fill", 26)} How to play</button>
      ${voidOfferButton()}
      <button type="button" class="btn c-p2" data-leave>${tilted("rectangle.portrait.and.arrow.right", 26)} Leave table</button>
    </div>
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
  preset: "house",
  rules: {},
  first: "random",
  rulesOpen: false,
};
const ENTRY_STYLE = {
  host: { color: "c-p1", glyph: "figure.2" }, // Play with Friends
  solo: { color: "c-p2", glyph: "dumbbell.fill" }, // Practice
};
function entryButton(attribute, label) {
  const { color, glyph: symbol } = ENTRY_STYLE[draft.mode];
  return `<button type="button" class="btn ${color} grow" ${attribute}>${tilted(symbol, 33)}<span>${padTag("y")}${label}</span>${tilted(symbol, 33, { mirror: true })}</button>`;
}
function startSetup(mode, saved = null) {
  Object.assign(draft, {
    mode,
    saved: saved?.saved ? saved : null,
    // Practice has no table or match settings, so it starts on the avatar step
    step: mode === "solo" ? 1 : 0,
    style: "wins",
    length: 3,
    preset: "house",
    rules: { ...matchOptions.house_rules },
    first: "random",
    rulesOpen: false,
    gameType: "1v1",
  });
  setupPage();
}
function styleHint() {
  if (draft.style === "wins")
    return `The first player to win ${Math.floor(draft.length / 2) + 1} games, is the overall winner.`;
  if (draft.style === "points")
    return `After ${draft.length} games, the player with the lowest sum of game scores is the overall winner.`;
  if (draft.style === "continuous")
    return "Play as many games as you like. The series is decided when everyone leaves.";
  return "One game. The lowest score wins.";
}
function setupPage() {
  document.title = draft.mode === "solo" ? "Practice · Golf" : "Host · Golf";
  if (draft.step === 0) {
    const fixed = ["wins", "points"].includes(draft.style);
    show(
      "setup",
      `<div class="page centered">${topbar()}<div class="stack wide">
      ${field("Your Display Name", `<input id="username" maxlength="32" value="${e(session.username)}" autocomplete="nickname" aria-label="Your display name">`, "character.cursor.ibeam")}
      ${
        draft.mode === "host"
          ? `<div class="row">${field("Table Name", `<input data-draft="lobbyName" maxlength="48" value="${e(draft.lobbyName)}" aria-label="Table name">`, null, "grow")}${selectField("Players", `data-draft="gameType" aria-label="Game type"`, [["1v1", "1v1", draft.gameType === "1v1"], ["many", "3–30", draft.gameType === "many"]], null, "hug")}</div>`
          : ""
      }
      <div class="stack"><div class="row">
        ${selectField("Match Style", `data-draft="style" aria-label="Match style"`, [["single", "Single game", draft.style === "single"], ["wins", "Best of", draft.style === "wins"], ["points", "Total pts", draft.style === "points"], ["continuous", "Play until you leave", draft.style === "continuous"]], "pointer.arrow.rays", fixed ? "hug" : "")}
        ${fixed ? selectField("Length", `data-draft="length" aria-label="Match length"`, [3, 5, 9].map((n) => [n, `${n} games`, draft.length === n]), null, "grow") : ""}
      </div><p class="hint">${e(styleHint())}</p></div>
      ${
        draft.mode === "host"
          ? `<div class="stack">${selectField("Score Preview", `data-draft="scorePreview" aria-label="Score preview"`, [["on", "Before Confirm", draft.scorePreview === "on"], ["off", "None", draft.scorePreview === "off"]], "eye.fill")}<p class="hint">${draft.scorePreview === "on" ? "Players see the score a swap or discard would leave them with before they confirm it." : "Scores change only once a move is confirmed."}</p></div>`
          : ""
      }
    </div><div class="row">${backButton("friends")}${entryButton("data-setup-next", "Continue")}</div></div>`,
    );
    return;
  }
  const practice = draft.mode === "solo";
  const back = practice
    ? backButton()
    : `<button type="button" class="btn round c-fw nav-float" data-setup-back aria-label="Back">${glyph("chevron.left", 20)}${padTag("b", "under")}</button>`;
  const rules = draft.saved
    ? `<p class="hint dark">Your Practice game in progress continues with the rules it started with${draft.saved.house_rules ? " (House rules)" : ""}.</p>`
    : `<div class="stack" data-rules-picker>${rulesPicker()}</div>`;
  const go = draft.saved ? "Continue" : `<span style="white-space:nowrap">Let<span style="letter-spacing:-0.55em">’</span>s Play!</span>`;
  show(
    "setup",
    `<div class="page">${topbar()}<div class="stack wide">${avatarPicker()}${rules}</div><div class="row">${back}${entryButton("data-setup-go", go)}</div></div>`,
  );
  centerAvatar(false);
}
/** `seat` is where you will sit (0 = player 1): the chosen avatar wears that player's color. */
/** `taken`: avatars already worn at the table you are joining (only shared ones may repeat). */
function avatarPicker(seat = 0, taken = []) {
  const options = avatars.filter((avatar) => avatar.selectable && (avatar.shared || !taken.includes(avatar.id)));
  if (options.length && !options.some((avatar) => avatar.id === session.avatar)) saveAvatar(options[0].id);
  // Each sticker's shadow is its own flat copy, so turning the wheel only ever
  // moves layers around and never has to redraw a textured sticker.
  const sticker = (avatar) => {
    const art = icon(avatar.icon, 44);
    return `<span class="avatar-shade">${art.replace('class="ico', 'class="ico flat')}</span>${art}`;
  };
  return `<div class="avatar-pick ${`c-s${seat % 8}`}"><span class="pointer">${icon("chevron.down", 30, { idle: false, style: "--fill:var(--fw3);--stroke:var(--fw)", sw: 4 })}</span><div class="avatar-strip" role="radiogroup" aria-label="Avatar"><div class="avatar-track" role="presentation" style="--stops:${options.length - 1}"><div class="avatar-stage" role="presentation">${options.map((avatar) => `<button type="button" class="avatar" role="radio" aria-checked="${avatar.id === session.avatar}" aria-label="${e(avatar.name)}" data-avatar="${e(avatar.id)}">${sticker(avatar)}</button>`).join("")}</div><div class="avatar-stops" aria-hidden="true">${options.map(() => "<i></i>").join("")}</div></div></div><p class="avatar-name">Select Your Avatar</p></div>`;
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
  saveAvatar(id);
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
      ${selectField("Who goes first", `data-draft="first" aria-label="Who goes first?" ${locked ? "disabled" : ""}`, Object.entries(starter).map(([key, label]) => [key, (draft.mode === "solo" && { host: "You first", guest: "Golfbot first" }[key]) || label, (locked ? "random" : draft.first) === key]), null, `compact${locked ? " locked" : ""}`)}
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
async function submitSetup() {
  const epoch = tableEpoch;
  const house = draft.preset === "house";
  if (draft.mode === "solo") {
    const next = await api("/api/solo", "POST", {
      practice: true,
      best_of: null,
      username: session.username,
      avatar: session.avatar,
      house_rules: house,
      first: house ? "random" : draft.first,
      rules: Object.fromEntries(catalog.map((rule) => [rule.key, !!draft.rules[rule.key]])),
    });
    if (epoch === tableEpoch) enterRoom(next);
    return;
  }
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
    house_rules: house,
    first: house ? "random" : draft.first,
    rules: Object.fromEntries(
      catalog.map((rule) => [rule.key, !!draft.rules[rule.key]]),
    ),
  };
  if (!(await abandonExisting())) return;
  const next = await api("/api/lobbies", "POST", requested);
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
      ? `Leaving counts as a loss and costs you ${leaving.forfeit_elo_loss} Elo.`
      : leaving.rated
        ? "This ends the series early. Completed games and their Elo changes are kept."
        : "Your game and streak will be saved to your account so you can resume later.";
  // Leave is always the small stacked sticker on the left; the wide button beside
  // it is Sign in (a guest leaving Practice) or Keep playing
  const leaveSticker = `<button type="button" class="close-btn c-p2" data-leave-choice="leave">${icon("rectangle.portrait.and.arrow.right", 30)}<span>${padTag("x")}Leave</span></button>`;
  const actions = guestPractice
    ? `<div class="dialog-actions signin-actions">${leaveSticker}<button type="button" class="btn c-p3 grow" data-leave-choice="signin">${tilted("person.crop.circle.fill", 26)}<span>${padTag("y")}Sign in</span></button></div>`
    : `<div class="dialog-actions signin-actions">${leaveSticker}<button type="button" class="btn c-fw grow" data-leave-choice="stay">${padTag("b")}Keep playing</button></div>`;
  // the sign-in version is dismissed (to keep playing) by an x in its top right corner
  const dismiss = guestPractice ? `<button type="button" class="dialog-x" data-leave-choice="stay" aria-label="Keep playing">${icon("xmark.circle.fill", 26)}</button>` : "";
  dialog.innerHTML = `${dismiss}<h2 id="leave-title">${title}</h2><p id="leave-description">${description}</p>${actions}`;
  closeSheet();
  const response = new Promise(resolve => { pendingLeaveResolve = resolve; });
  dialog.showModal();
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
  toast("Your practice game and streak are saved.");
  return true;
}
async function abandonExisting({confirmed = false} = {}) {
  const roomId = session.room_id,
    epoch = tableEpoch;
  if (roomId) {
    const leaving = state?.id === roomId ? state : await api(`/api/lobbies/${roomId}/state`);
    if (!confirmed && ((leaving.rated && ["playing", "round_over"].includes(leaving.status)) || leaving.practice)) {
      const choice = await leavePrompt(leaving);
      if (choice === "signin") {
        leaveAfterSignIn = roomId;
        accountPage();
        return false;
      }
      if (choice !== "leave") return false;
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
  const lobbies = await api("/api/lobbies");
  const twin = [tilted("house.fill", 34), tilted("house.fill", 34, { mirror: true })];
  show(
    "friends",
    `<div class="page">${topbar()}<div class="stack wide"><div class="stack">
    <div class="row" style="align-items:center"><h1 class="page-title">Open tables</h1><button type="button" class="btn small c-fw" data-nav="friends">${glyph("arrow.clockwise", 18)} ${padTag("x")}Refresh</button></div>
    <div class="list">${
      lobbies
        .map((lobby) => {
          const open = lobby.status === "waiting" && lobby.players < lobby.capacity;
          return `<button type="button" class="list-item ${open ? "c-p1" : "c-fw"}" data-lobby="${e(lobby.id)}">${avatarBadge(lobby.avatars?.[0], open ? "c-p1" : "c-fw")}<div class="grow"><strong>${e(lobby.name)}</strong><small>${e(lobby.names[0])} · ${lobby.players}/${lobby.capacity} players · ${e(matchLength(lobby))}${open ? "" : " · " + e(lobby.status.replace("_", " "))}</small></div>${glyph("chevron.right", 20)}</button>`;
        })
        .join("") ||
      `<p class="hint">No open tables yet. Host one and invite a friend!</p>`
    }</div></div></div>
    <div class="row">${backButton()}<button type="button" class="btn c-p1 grow" data-nav="host">${twin[0]}<span>${padTag("y")}Host a Table</span>${twin[1]}</button></div></div>`,
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
  const full = info.players >= info.capacity || info.status !== "waiting";
  const twin = [tilted("figure.2", 33), tilted("figure.2", 33, { mirror: true })];
  show(
    "public",
    `<div class="page">${topbar()}<div class="stack wide">
    <div class="stack"><h1 class="page-title">${e(info.name)}</h1><div class="meta"><span class="pill">Hosted by ${e(info.names[0])}</span><span class="pill">${e(matchLength(info))}</span><span class="pill">${info.players}/${info.capacity} players</span>${houseBadge(info)}</div><p class="hint">${e(rulesSummary(info.rules))}</p></div>
    ${avatarPicker(info.players, (info.avatars || []).slice(0, info.players))}
    ${field("Your Display Name", `<input id="username" maxlength="32" value="${e(session.username)}" autocomplete="nickname" aria-label="Your display name">`, "character.cursor.ibeam")}
    ${full ? `<p class="hint dark">This table is full or already playing.</p>` : ""}
    </div><div class="row">${backButton("friends")}<button type="button" class="btn c-p1 grow" data-join="${e(id)}" ${full ? "disabled" : ""}>${twin[0]}<span>${padTag("y")}Join Table</span>${twin[1]}</button></div></div>`,
  );
  centerAvatar(false);
}
function waitingRoom() {
  const many = state.game_type === "many";
  const url = `${location.origin}${appPath(`/lobby/${state.id}`)}`;
  const seatColor = (seat) => `c-s${seat % 8}`;
  show(
    "room",
    `<div class="page">${topbar()}<div class="stack wide">
    <div class="stack"><h1 class="page-title">${e(state.name)}</h1><div class="meta"><span class="pill">${e(matchLength(state))}</span><span class="pill">${state.players}/${state.capacity} players</span><span class="pill">${e(starter[state.first])}</span>${houseBadge(state)}</div></div>
    <div class="share">${field("Invite Link", `<input readonly aria-label="Lobby invite link" value="${e(url)}">`, "link")}<button type="button" class="btn c-p1" style="flex:none;min-height:5.6rem;font-size:1.8rem;padding:0 1.6rem" data-copy="${e(url)}">Copy</button></div>
    <div class="list">${state.names.map((seatName, seat) => `<div class="list-item ${seatColor(seat)}">${!many && seat === 1 && state.players < 2 ? `<span class="avatar-badge ${seatColor(seat)}">${icon("person.fill", 24, { idle: false })}</span>` : avatarBadge(state.avatars?.[seat], seatColor(seat))}<div class="grow"><strong>${seat === state.viewer ? youStar() : ""}${e(seatName)}</strong><small>${seat === 0 ? "Host" : "Player " + (seat + 1)} · ${state.connected[seat] ? "connected" : !many && seat === 1 ? "seat open" : "offline"}</small></div></div>`).join("")}</div>
    <p class="hint">${e(rulesSummary(state.rules))}</p>
    <p class="hint dark">${many ? "The host starts once at least three players have joined." : "The game starts automatically when a friend joins."}</p>
    </div><div class="stack">${state.viewer === 0 ? `<button type="button" class="btn c-p3" data-invite-open>${tilted("person.fill.badge.plus", 32)}<span>${padTag("x")}Invite a Player</span></button>` : ""}<div class="row"><button type="button" class="btn round c-p2" data-leave aria-label="Leave table">${glyph("xmark", 20)}</button>${many && state.viewer === 0 ? `<button type="button" class="btn c-p1 grow" data-action="start" ${state.players < 3 ? "disabled" : ""}>${tilted("play.fill", 32)}<span>${padTag("y")}Start Game</span></button>` : `<div class="btn c-fw grow" style="font-size:1.8rem" role="status">Waiting for players…</div>`}</div></div></div>`,
  );
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
      if (session.room_id === id) connectRoom(id);
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
  session.room_id = next.id;
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
  sheetRoot.innerHTML = rulesSheet(Number(player));
  const sheet = sheetRoot.querySelector(".sheet");
  if (!sheet) return;
  sheet.classList.add("settled");
  sheet.scrollTop = scroll;
}
function openRulesSheet(player) {
  openSheet(rulesSheet(player), player);
  const sheet = sheetRoot.querySelector?.(".rules-sheet");
  const at = rulesScroll.get(rulesScrollKey(player));
  if (sheet && at) sheet.scrollTop = at;
}
/** One player's points in each finished game of the series, and their sum. */
function seriesTally(player) {
  if (state.best_of === 1) return "";
  const games = state.history || [];
  const total = games.reduce((sum, game) => sum + game.scores[player], 0);
  // the series so far: wins always, and the points total when that decides it
  const wins = games.filter((game) => game.winner === player).length;
  const points = state.series_mode === "points";
  return `<h3>This series</h3><div class="tally plain" data-series-tally>${
    games.map((game) => `<div><span>Game ${game.round}</span><b>${game.scores[player]} pts</b></div>`).join("") ||
    "<div><span>No games finished yet</span></div>"
  }<div class="total"><span>Wins</span><b>${wins} ${wins === 1 ? "win" : "wins"}</b></div>${
    points ? `<div class="total more"><span>Total</span><b>${total} pts</b></div>` : ""
  }</div>`;
}
/** A player's record, shown over the table (tap a name tag, theirs or yours). */
async function playerStatsSheet(player) {
  const id = state.player_ids?.[player];
  const mine = state.player_ids?.[state.viewer];
  const color = colorFor(player);
  openSheet(`<section class="sheet ${color}" role="dialog" aria-modal="true" aria-label="Player stats">
    <div class="sheet-head"><h2>${e(state.names[player])}</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    ${seriesTally(player)}
    <div data-player-stats style="margin-top:1.2rem"><div class="loading">Loading stats…</div></div>
    <div class="row" style="margin-top:1.2rem">${id ? `<button type="button" class="btn small ${color} grow" data-stats-player="${e(id)}">Full stats</button>` : ""}<button type="button" class="btn small ${color} grow" data-nav="stats">${tilted("medal", 22)} Leaderboard</button></div>
  </section>`);
  const holder = sheetRoot.querySelector("[data-player-stats]");
  let body;
  try {
    if (!id) throw new Error("No saved games for this player yet.");
    const query = new URLSearchParams({ player: id });
    if (mine && mine !== id) query.set("opponent", mine);
    const result = await api("/api/stats?" + query);
    if (result.player?.profile.id !== id) throw new Error("No saved games for this player yet.");
    body =
      statsTable([result.player], "overall", "Official stats · overall", color) +
      (result.comparison
        ? statsTable([result.player, result.comparison], "head_to_head", "Head to head with you", color)
        : "");
  } catch (error) {
    body = `<p class="empty">${e(error.message)}</p>`;
  }
  if (holder.isConnected) holder.innerHTML = `<div class="stack">${body}</div>`;
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

/* ---------- account ---------- */
let googleScript = null;
let initializedGoogleNonce = null;
async function renderGoogleSignIn() {
  const container = document.getElementById("google-signin-button");
  if (!container || page !== "account") return;
  if (session.account || !session.google_client_id || (session.room_id && !canSignInDuringPractice())) return;
  try {
    if (!window.google?.accounts?.id) {
      googleScript ??= new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://accounts.google.com/gsi/client";
        script.async = true;
        script.onload = resolve;
        script.onerror = () =>
          reject(
            new Error(
              "Google sign-in could not load. You can keep playing as a guest.",
            ),
          );
        document.head.appendChild(script);
      });
      await googleScript;
    }
    if (
      session.account ||
      (session.room_id && !canSignInDuringPractice()) ||
      page !== "account" ||
      !container.isConnected
    )
      return;
    if (initializedGoogleNonce !== session.google_nonce)
      google.accounts.id.initialize({
        client_id: session.google_client_id,
        nonce: session.google_nonce,
        callback: async ({ credential }) => {
          try {
            const keep = { username: session.username, avatar: session.avatar };
            const epoch = tableEpoch, roomId = session.room_id;
            const next = await api("/api/auth/google", "POST", {
              credential,
              csrf_token: session.csrf_token,
            });
            const currentRoom = session.room_id;
            session = {...next, ...keep};
            if (next.account?.display_name) saveName(next.account.display_name);
            if (epoch !== tableEpoch || currentRoom !== roomId || page !== "account") {
              session.room_id = currentRoom;
              return;
            }
            if (!session.account.unique_name) accountPage();
            else if (!(await finishPracticeSignIn())) {
              home();
              toast("Signed in as @" + session.account.unique_name);
            }
          } catch (error) {
            toast(error.message);
          }
        },
      });
    initializedGoogleNonce = session.google_nonce;
    container.textContent = "";
    google.accounts.id.renderButton(container, {
      theme: "outline",
      size: "large",
      text: "signin_with",
      shape: "pill",
    });
  } catch (error) {
    googleScript = null;
    if (page === "account" && container.isConnected)
      container.textContent = error.message;
  }
}
function accountPage() {
  document.title = "Your account · Golf";
  history.replaceState({}, "", appPath("/account"));
  const account = session.account;
  show(
    "account",
    `<div class="page scroll">${subHeader(account ? "Your account" : "Sign in")}<div class="panel c-p1">${
      account
        ? account.unique_name
          ? `<h2>@${e(account.unique_name)}</h2><p>Your games are grouped under this unique name on the Leaderboard. Your display name at the table can change each game.</p>`
          : `<h2>Choose your unique name</h2><p>This identifies you on the Leaderboard across all your display names. Pick once; your display name can change whenever you play.</p><form id="account-name-form" class="stack" style="margin-top:2rem">${field("Unique Name", `<input name="unique_name" aria-label="Unique name" minlength="3" maxlength="24" pattern="[a-zA-Z0-9_]{3,24}" autocomplete="username" required>`, "character.cursor.ibeam")}<p class="hint" style="color:var(--p1)">3–24 letters, numbers or underscores. Names are lowercase and unique.</p><button type="submit" class="btn c-p1">Save unique name</button></form>`
        : `<p>Sign in to keep your stats under one unique name across devices. Your display name can change each game.</p>${session.room_id && !canSignInDuringPractice() ? `<p>Leave your current table before signing in.</p>` : session.google_client_id ? `<div id="google-signin-button" aria-live="polite">Loading Google sign-in…</div>` : `<p>Google sign-in is not available on this server yet. You can keep playing as a guest.</p>`}`
    }${account ? `<button type="button" class="btn small c-p2" style="margin-top:1.6rem" data-signout>Sign out</button>` : ""}<p style="margin-top:1.2rem;opacity:.7">Guests are grouped by display name. Signing in does not claim earlier guest results.</p></div>${account ? displayNameForm() : ""}</div>`,
  );
  renderGoogleSignIn();
}
/** Signed in: change the name other players see at the table. */
function displayNameForm() {
  const unique = session.account.unique_name;
  return `<form id="display-name-form" class="panel c-p3 stack">
    <h2>Display name</h2>
    <p>The name other players see at the table. Change it whenever you like${unique ? `; your games stay under @${e(unique)}` : ""}.</p>
    ${field("Display Name", `<input id="account-display-name" name="display_name" maxlength="32" value="${e(session.username)}" autocomplete="nickname" aria-label="Display name" required>`, "character.cursor.ibeam")}
    ${session.room_id ? `<p class="hint dark">The table you're at keeps the name you joined with; the new one shows from your next table.</p>` : ""}
    <button type="submit" class="btn c-p3">Save display name</button>
  </form>`;
}

/* ---------- match history ---------- */
let historyEntries = [],
  historyOffset = null,
  historyRequest = 0;
async function historyPage(more = false) {
  const request = ++historyRequest;
  document.title = "Match history · Golf";
  history.replaceState({}, "", appPath("/history"));
  if (!more) {
    historyEntries = [];
    show(
      "history",
      `<div class="page scroll">${subHeader("Match history")}<div class="loading">Loading match history…</div></div>`,
    );
  }
  try {
    const result = await api(
      "/api/history?offset=" + (more ? historyOffset : 0),
    );
    if (page !== "history" || request !== historyRequest) return;
    historyEntries.push(...result.matches);
    historyOffset = result.next_offset;
    const scroll = window.scrollY;
    show(
      "history",
      `<div class="page scroll">${subHeader("Match history")}<p class="hint dark">Everyone's completed games, newest first. ${session.room_id ? "Your table is still open — head back any time." : ""}</p><div class="stack wide">${
        historyEntries
          .map((saved) => {
            const match = {
              ...saved,
              names: saved.names.map((name, seat) =>
                saved.solo && seat === 1 ? "Golfbot" : name,
              ),
            };
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
            const ended =
              match.last_game_ended_at ||
              Math.max(...match.rounds.map((game) => game.ended_at || 0)) ||
              match.updated_at;
            return `<article class="panel c-fw"><h2>${e(match.lobby_name)}</h2><div class="meta"><span class="pill">${e(new Date(ended * 1000).toLocaleDateString())}</span>${match.solo ? `<span class="pill">Vs Golfbot</span>` : ""}<span class="pill">${e(matchLength(match))}</span><span class="pill">${e(status)}</span><span class="pill">${e(match.patch || "Earlier patches")}</span></div><p style="margin-top:1rem">${tilted("trophy.fill", 22, { style: "--fill:var(--p3);--stroke:var(--paper)" })} Overall winner: ${e(winner)}</p><div class="table-wrap"><table><thead><tr><th scope="col">Game</th>${match.names.map((name, p) => `<th scope="col">${match.viewer === p ? youStar() : ""}${e(name)}</th>`).join("")}<th scope="col">Winner</th></tr></thead><tbody>${match.rounds.map((game) => `<tr><th scope="row">${game.round}</th>${game.scores.map((score) => `<td>${score}</td>`).join("")}<td>${game.winner === null ? "Draw" : e(match.names[game.winner])}</td></tr>`).join("")}</tbody><tfoot><tr><th scope="row">Total pts</th>${match.points.map((score) => `<td>${score}</td>`).join("")}<td></td></tr><tr><th scope="row">Game wins</th>${match.wins.map((wins) => `<td>${wins}</td>`).join("")}<td></td></tr></tfoot></table></div></article>`;
          })
          .join("") ||
        `<p class="hint">No completed games yet. Finish a game against a player or Golfbot to see it here.</p>`
      }${historyOffset !== null ? `<button type="button" class="btn small c-fw" data-history-more>Load older matches</button>` : ""}</div></div>`,
    );
    if (more) window.scrollTo(0, scroll);
  } catch (error) {
    if (page === "history" && request === historyRequest)
      show(
        "history",
        `<div class="page scroll">${subHeader("Match history")}<p class="empty">${e(error.message)}</p><button type="button" class="btn small c-fw" data-nav="history">Try again</button></div>`,
      );
  }
}

/* ---------- leaderboard (player stats) ---------- */
let statsSelection = {
    player: "",
    opponent: "",
    enabled: [],
    disabled: [],
    house_rules: true,
    patch: "",
  },
  statsRequest = 0,
  statsFiltersOpen = false;
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
/* ---------- leaderboard & player stats ---------- */
// Filters work like the rule picker before a game: House (official stats) or
// any rules, and with House off each rule can be required or excluded.
const statsRuleState = (key) =>
  statsSelection.house_rules
    ? matchOptions.house_rules[key]
      ? "on"
      : "any"
    : statsSelection.enabled.includes(key)
      ? "on"
      : statsSelection.disabled.includes(key)
        ? "off"
        : "any";
function statsQuery(withPlayers = true) {
  const query = new URLSearchParams();
  if (!statsSelection.house_rules) query.set("house_rules", "false");
  else {
    statsSelection.enabled = [];
    statsSelection.disabled = [];
  }
  if (statsSelection.patch) query.set("patch", statsSelection.patch);
  if (withPlayers && statsSelection.player) {
    query.set("player", statsSelection.player);
    if (statsSelection.opponent) query.set("opponent", statsSelection.opponent);
  }
  for (const key of statsSelection.enabled) query.append("enabled", key);
  for (const key of statsSelection.disabled) query.append("disabled", key);
  return query;
}
function statsFilterSummary() {
  const names = (keys) =>
    catalog
      .filter((rule) => keys.includes(rule.key))
      .map((rule) => RULE_SHORT[rule.key] || rule.name)
      .join(", ");
  const { enabled, disabled, house_rules, patch } = statsSelection;
  const parts = [];
  if (house_rules) parts.push("Official stats: games played with the saved House rules.");
  else if (!enabled.length && !disabled.length) parts.push("Every saved game, whatever rules were on.");
  else {
    if (enabled.length) parts.push(`With ${names(enabled)}.`);
    if (disabled.length) parts.push(`Without ${names(disabled)}.`);
  }
  if (patch) parts.push(patch === "legacy" ? "Earlier patches only." : `Patch ${patch} only.`);
  return parts.join(" ");
}
function statsFiltersHtml(patches) {
  const { enabled, disabled, house_rules, patch } = statsSelection;
  const custom = enabled.length + disabled.length;
  const preset = house_rules ? "house" : custom ? "custom" : "any";
  const presets = [
    ["house", "House", "house.fill"],
    ["any", "Any rules", "infinity"],
  ];
  const open = statsFiltersOpen;
  const title = house_rules
    ? "House rules"
    : custom
      ? `${custom} rule filter${custom === 1 ? "" : "s"}`
      : "Any rules";
  const words = { on: "required", off: "excluded", any: "either way" };
  const row = (rule) => {
    const value = statsRuleState(rule.key);
    return `<button type="button" class="rule-row filter-row ${value}" data-stats-rule="${e(rule.key)}" aria-label="${e(rule.name)}: ${words[value]}" title="${e(rule.description)}" ${house_rules ? "disabled" : ""}>${tilted(value === "on" ? "checkmark.circle.fill" : value === "off" ? "xmark.circle.fill" : "circle.fill", 24, { idle: false, sw: 2.5, cls: value === "any" ? "bare" : "" })}<span>${e(rule.name)}</span></button>`;
  };
  const patchField = selectField(
    "Patch",
    `data-stats-patch aria-label="Patch"`,
    [["", "All time", !patch], ...patches.map((name) => [name, name === "legacy" ? "Earlier patches" : name, patch === name])],
    null,
    "compact",
  );
  return `<div class="rules-box ${open ? "open" : ""}"><span class="label">Filters</span>
    <button type="button" class="rules-head" data-stats-filters-toggle aria-expanded="${open}"><span>${tilted("checklist", 24)} ${title}</span><span class="chev">${glyph("chevron.right", 20)}</span></button>
    <div class="collapse ${open ? "open" : ""}" data-rules-open><div ${open ? "" : "inert"}><div class="rules-body">
      <div class="chips" style="justify-content:space-around">${presets.map(([key, label, symbol]) => `<button type="button" class="rule-row" style="flex-direction:column;gap:1.4rem;color:var(--fw-text)" data-stats-preset="${key}" aria-pressed="${preset === key}">${tilted(symbol, 52, { tilt: key === "house" ? 6 : -6, style: preset === key ? "--fill:var(--p1b);--stroke:var(--p1)" : "" })}<span>${label}${key === "house" ? " Rules" : ""}</span></button>`).join("")}</div>
      <div class="rule-group"><h4>Rules</h4>${catalog.map(row).join("")}</div>
      <p class="hint dark">${house_rules ? "House rules count only games played with the saved preset. Choose Any rules to pick your own." : "Tap a rule to require it. Tap again to leave out games that used it."}</p>
      ${patchField}
    </div></div></div></div>
    <div class="collapse ${open ? "" : "open"}" data-rules-closed><div ${open ? "inert" : ""}><div class="rules-closed"><div class="chips">${presets.map(([key, label, symbol]) => `<button type="button" class="chip" data-stats-preset="${key}" aria-pressed="${preset === key}">${tilted(symbol, 24)}<span>${label}</span></button>`).join("")}</div><p class="hint">${e(statsFilterSummary())}</p></div></div></div>`;
}
/** Open or close the filter box in place so the height change can animate. */
function toggleStatsFilters() {
  statsFiltersOpen = !statsFiltersOpen;
  const holder = root.querySelector("[data-stats-filters]");
  const box = holder?.querySelector(".rules-box");
  if (!box) return;
  box.classList.toggle("open", statsFiltersOpen);
  box.querySelector("[data-stats-filters-toggle]").setAttribute("aria-expanded", statsFiltersOpen);
  for (const [name, open] of [
    ["[data-rules-open]", statsFiltersOpen],
    ["[data-rules-closed]", !statsFiltersOpen],
  ]) {
    const part = holder.querySelector(name);
    part.classList.toggle("open", open);
    part.firstElementChild.toggleAttribute("inert", !open);
  }
  if (statsFiltersOpen) {
    box.querySelectorAll(".rule-row").forEach((row, i) => row.style.setProperty("--i", i));
    box.classList.add("opening");
    setTimeout(() => box.classList.remove("opening"), 900);
  }
}
/** The ranking: everyone with a matching game, best game win rate first. */
function leaderboardHtml(result) {
  const rows = result.leaderboard.filter((row) => row.rounds > 0);
  if (!rows.length) return `<p class="empty">No games match these filters yet.</p>`;
  return `<p class="hint dark">Ranked by game win rate. Tap a player for their full record.</p><div class="list">${rows
    .map((row, i) => {
      const games = `${row.rounds} game${row.rounds === 1 ? "" : "s"}`;
      return `<button type="button" class="list-item board-row ${i === 0 ? "c-p3" : "c-fw"}" data-stats-player="${e(row.profile.id)}" aria-label="${i + 1}. ${e(row.profile.label)}, ${statPercent(row.round_win_rate)} win rate, ${games}">
        <span class="rank">${i === 0 ? tilted("trophy.fill", 30, { key: "rank:first" }) : stickerText(String(i + 1), { key: `rank:${i}` })}</span>
        <div class="grow"><strong>${e(row.profile.label)}</strong><small>${row.round_wins}–${row.round_losses}–${row.round_draws} · ${games}</small></div>
        <b class="rate">${statPercent(row.round_win_rate)}</b>${glyph("chevron.right", 16)}
      </button>`;
    })
    .join("")}</div>`;
}
/** One player's record: the headline numbers, then the full tables. */
function playerStatsHtml(result) {
  const entry = result.player,
    stats = entry.overall;
  const place = result.leaderboard.filter((row) => row.rounds > 0).findIndex((row) => row.profile.id === entry.profile.id);
  const others = result.players.filter((player) => player.id !== entry.profile.id);
  const tile = (value, label) => `<div><b>${value}</b><span>${label}</span></div>`;
  return `<section class="panel c-p3 stat-hero">
      <div class="stat-rate">${stickerText(stats.round_win_rate === null ? "—" : String(Math.round(stats.round_win_rate * 100)), { split: true, key: "stat-rate" })}${stats.round_win_rate === null ? "" : stickerText("%", { cls: "pts", key: "stat-pct" })}</div>
      <p>game win rate${place >= 0 ? ` · ranked #${place + 1}` : ""}</p>
      <div class="stat-tiles">${tile(`${stats.round_wins}–${stats.round_losses}–${stats.round_draws}`, "W–L–D")}${tile(statNumber(stats.rounds), "games")}${tile(statNumber(stats.average_points), "avg points")}</div>
    </section>
    ${selectField("Compare With", `data-stats-opponent aria-label="Compare with"`, [["", "Nobody: overall only", !statsSelection.opponent], ...others.map((player) => [player.id, player.label, player.id === statsSelection.opponent])], "person.2.fill")}
    ${statsTable([entry, result.comparison].filter(Boolean), "overall", statsSelection.house_rules ? "Official stats · overall" : "Overall · against all opponents", "c-p3")}
    ${result.comparison ? statsTable([entry, result.comparison], "head_to_head", "Head to head", "c-p1") : ""}
    <details class="panel c-fw"><summary>How stats are counted</summary><p style="font-size:1.4rem">A game is one deal. A series is a full match. House rules includes games started with a saved, locked preset; earlier unmarked games remain available with House rules off. Turns counts completed turns by all players. In many-player games, an overall game win means the unique lowest score at the table; tied lowest scores are draws. Average opponent points uses the mean of all other players. Head-to-head game results compare just the two selected players, and many-player head-to-head series compare their total points. Fixed series allow drawn totals; patch and rule filters require every game of a completed series to match. Rules in play counts enabled optional rules, whether activated or not. Continuous series are decided after everyone leaves: game wins first, then lower total points. An exact tie has no series winner. Game win rate includes draws in the denominator; series win rate uses completed matches only. Matching games from unfinished series still count toward game stats. With rule filters, a completed series counts only when every game matches. Negative point advantage means fewer points than the opponent. Activation percentage counts games where that player triggered the rule, divided by all games with activation records. Win rate counts wins among those activated games, including draws in the denominator. Each rule counts once per game, even if it triggers multiple times. Rules affecting the opponent are credited to the player who triggered them. Older games without activation records are excluded from this tracker.</p></details>`;
}
function ruleActivationsHtml(entry, scope) {
  const stats = entry[scope];
  if (!Array.isArray(stats.rule_activations))
    return `<p>Restart the game server to load rule activation stats.</p>`;
  return `<div><h3>${e(entry.profile.label)}</h3>${entry.profile.unique_name ? `<p>Display names: ${entry.profile.display_names.map(e).join(", ")}</p>` : ""}<p>Rule activations · ${stats.known_activation_games} recorded games</p><div class="table-wrap"><table><thead><tr><th>Rule</th><th>Games activated</th><th>Win rate</th></tr></thead><tbody>${stats.rule_activations.map((rule) => `<tr><th>${e(rule.name)}</th><td>${statPercent(rule.rate)} <small>(${rule.games})</small></td><td>${statPercent(rule.win_rate)}</td></tr>`).join("")}</tbody></table></div>${stats.unknown_activation_games ? `<p>${stats.unknown_activation_games} games have no activation records and are excluded.</p>` : ""}</div>`;
}
function statsTable(entries, scope, title, color) {
  const metrics = [
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
    ["Average turns per game", (s) => statNumber(s.average_turns ?? null)],
    [
      "Average modifiers in play per game",
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
  return `<section class="panel ${color}"><h2>${title}</h2>${entries.every((entry) => entry[scope].rounds === 0) ? `<p>No games match this selection.</p>` : ""}<div class="table-wrap"><table><thead><tr><th scope="col">Statistic</th>${entries.map((entry) => `<th scope="col">${e(entry.profile.label)}</th>`).join("")}</tr></thead><tbody>${metrics.map(([label, value]) => `<tr><th scope="row">${label}</th>${entries.map((entry) => `<td>${value(entry[scope])}</td>`).join("")}</tr>`).join("")}</tbody></table></div><details><summary>View rule activation</summary><div class="stack wide">${entries.map((entry) => ruleActivationsHtml(entry, scope)).join("")}</div></details>${entries.some((entry) => entry[scope].known_turn_games < entry[scope].rounds) ? `<p>Average turns excludes older games without turn records.</p>` : ""}${entries.some((entry) => entry[scope].ambiguous_matches) ? `<p>Games where a selected guest name identifies multiple seats are excluded because those guests cannot be distinguished.</p>` : ""}</section>`;
}
async function statsPage(fromUrl = false) {
  if (fromUrl) {
    const query = new URLSearchParams(location.search);
    statsSelection = {
      initialized: true,
      player: query.get("player") || (session.account ? "account:" + session.account.id : "player:" + session.username),
      opponent: query.has("opponent") ? query.get("opponent") : "bot:golfbot",
      enabled: query.getAll("enabled"),
      disabled: query.getAll("disabled"),
      house_rules: query.get("house_rules") !== "false",
      patch: query.has("patch") ? query.get("patch") : (session.patch || matchOptions.patch),
    };
  }
  // the Advanced tab opens on your own record against Golfbot, this patch
  if (!statsSelection.initialized) {
    statsSelection.player ||= session.account ? "account:" + session.account.id : "player:" + session.username;
    statsSelection.opponent ||= "bot:golfbot";
    statsSelection.patch ||= (session.patch || matchOptions.patch);
    statsSelection.initialized = true;
  }
  const request = ++statsRequest;
  // the ranking, or (once a player is picked) that player's own page
  const view = statsSelection.player ? "player:" + statsSelection.player : "board";
  const same = page === "stats" && root.querySelector("[data-stats-view]")?.dataset.statsView === view;
  const query = statsQuery();
  document.title = "Leaderboard · Golf";
  history.replaceState({}, "", appPath("/stats") + (query.toString() ? "?" + query : ""));
  const draw = (title, body) => leaderShell("stats", title, "advanced", body, "Loading player stats…");
  if (!same) draw(statsSelection.player ? "Player stats" : "Leaderboard", null);
  try {
    const result = await api("/api/stats?" + query);
    if (page !== "stats" || request !== statsRequest) return;
    statsSelection.opponent = result.comparison?.profile.id || "";
    if (!result.players.length)
      return draw(
        "Leaderboard",
        `<p class="hint">No saved games yet. Finish a game against a player or Golfbot to see player statistics here.</p>`,
      );
    const filters = statsFiltersHtml(result.patches);
    const content = statsSelection.player ? playerStatsHtml(result) : leaderboardHtml(result);
    const holder = root.querySelector("[data-stats-view]");
    if (same && holder) {
      // a filter changed: redraw in place, keeping the scroll position
      holder.querySelector("[data-stats-filters]").innerHTML = filters;
      holder.querySelector("#stats-content").innerHTML = content;
      return;
    }
    draw(
      statsSelection.player ? result.player.profile.label : "Leaderboard",
      `<div class="leader-body" data-stats-view="${e(view)}">
        <div data-stats-filters>${filters}</div>
        <div id="stats-content" class="stack wide">${content}</div>
      </div>`,
    );
  } catch (error) {
    if (page === "stats" && request === statsRequest)
      draw(
        "Leaderboard",
        `<p class="empty">${e(error.message)}</p><button type="button" class="btn small c-fw" data-stats-reset-all>Clear selection and retry</button>`,
      );
  }
}


const RULE_EXAMPLES = {
  royal_pairs: [["Queen pair earns one bonus swap", ["QH",null,null,"QS",null,null]], ["Jack pair earns one bonus swap", ["JH",null,null,"JS",null,null]]],
  devils_row: [["Three 6s lock this row", ["6H","6S","6D",null,null,null]]],
  gamblers_row: [["Earn final score divided by 7, even if this row later breaks", ["7H","7S","7D",null,null,null]]],
  angels_row: [["Earn opponent's final score times 9 during play", ["9H","9S","9D",null,null,null]]],
  king_queen: [["Same-color King-Queen column: 5 points", ["KH",null,null,"QD",null,null]], ["Different-color column: 15 points", ["KH",null,null,"QS",null,null]]],
  holdem: [["Five-card flush: -5 points", ["AH","3H","6H","8H","JH",null]], ["Five-card straight: -5 points", ["3H","4S","5D","6C","7H",null]], ["Full house: -5 points", ["3H","3S","3D","8C","8H",null]], ["Four of a kind: -5 points", ["4H","4S","4D","4C","AH",null]]],
  v10: [["10, J, Q in a V: final score divided by 5", ["10H",null,"JS",null,"QD",null]], ["Inverted V also counts", [null,"10H",null,"JS",null,"QD"]]],
  tricky_straights: [["Ascending 3-4-5: +5 to opponent", ["3H","4S","5D",null,null,null]], ["Descending 5-4-3: -3 from your score", ["5H","4S","3D",null,null,null]]],
  ripped_five: [
    ["The 5 of diamonds and another 5 anywhere in the hand cancel", ["5D",null,"5S",null,null,null]],
    ["Already in a column pair, the 5 of diamonds still rips one more 5", ["5D",null,"5S","5H",null,null]],
  ],
  roman_fives: [["8 + 4 + (-2) = 10 base points: final score divided by 2", ["8H",null,"2S",null,"4D",null]], ["Inverted V: 5 + 4 + A = 10", [null,"4S",null,"5D",null,"AH"]]],
  beggars: [["Your 10 is the unique highest visible value. Guess the chosen hidden card's rank before it flips", ["10H",null,null,null,null,null], ["3H",null,null,null,null,null], "Opponent: a correct guess trades your 10 for their lowest visible card after the reveal"]],
  four_kind: [["Four visible 4s may be arranged into two columns", ["4H","4S",null,"4D","4C",null]]],
  poisoned_card: [["First player to reveal all six during play: +1 before divisions", ["AH","3S","5D","7C","9H","KC"]]],
  crazy_eights: [["Three 8s in a row: final score divided by 8", ["8H","8S","8D",null,null,null]]],
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
  return `<div class="rule-card${on ? "" : " off"}"><span class="rule-ico">${icon(RULE_ICON[rule.key] || "star.fill",30,{idle:false})}</span><div class="rule-help-copy"><strong>${e(rule.name)}${active ? ` <span class="pill rule-state active">active</span>` : near ? ` <span class="pill rule-state near">one move away</span>` : ""}</strong><p>${e(rule.description)}</p>${variantsHtml(rule.key)}${editable ? `<button type="button" class="btn small ${on ? "c-p2" : "c-p1"}" style="margin-top:.6rem" data-live-rule="${e(rule.key)}" data-enable="${!on}">${on ? "Turn off" : "Turn on"}</button>` : ""}<div class="rule-example" id="example-${e(token)}"${expanded ? "" : " hidden"}>${examples}</div></div><button type="button" class="rule-eye${expanded ? " c-p3" : ""}" data-rule-example="${e(token)}"${inMatch ? ` data-rule-player="${player}" data-rule-key="${e(rule.key)}"` : ""} aria-expanded="${expanded}" aria-controls="example-${e(token)}" aria-label="Show examples for ${e(rule.name)}">${icon("eye.fill",18,{idle:false})}</button></div>`;
}

let voidTimer;
function renderVoidOffer() {
  clearTimeout(voidTimer);
  let dialog = document.getElementById("void-dialog");
  if (!dialog) {
    dialog = document.createElement("dialog");
    dialog.id = "void-dialog";
    dialog.className = "social-dialog";
    dialog.setAttribute("aria-label", "Void game offer");
    dialog.addEventListener("cancel", event => event.preventDefault());
    document.body.append(dialog);
  }
  const offer = state?.void_offer;
  if (!offer) { if (dialog.open) dialog.close(); delete dialog.dataset.offer; return; }
  const own = offer.by === state.viewer;
  const expiry = typeof offer.expires_at === "number" ? offer.expires_at * 1000 : Date.parse(offer.expires_at);
  const seconds = Math.max(0, Math.min(30, Math.ceil((expiry - Date.now()) / 1000)));
  const signature = `${state.id}|${offer.by}|${offer.expires_at}`;
  if (dialog.dataset.offer !== signature) {
    dialog.dataset.offer = signature;
    dialog.innerHTML = `<h2>Void game &amp; end series early?</h2><p>${own ? "Waiting for your opponent." : `${e(state.names[offer.by])} wants to void this game and end the series early.`}</p><p><strong>NO ELO CHANGE.</strong> This game will not count. Completed rounds are preserved.</p><p>Play is paused. Offer expires in <b data-void-seconds></b>s.</p>${own ? "" : `<div class="dialog-actions"><button type="button" class="btn c-p3" data-void-reply="accept">${padTag("y")}Accept</button><button type="button" class="btn c-p2" data-void-reply="decline">${padTag("x")}Decline</button></div>`}`;
  }
  dialog.querySelector("[data-void-seconds]").textContent = Number.isFinite(seconds) ? seconds : 30;
  if (!dialog.open) dialog.showModal();
  voidTimer = setTimeout(renderVoidOffer, 1000);
}

function leaderboardTabs(selected) {
  return `<div class="leader-tabs" role="group" aria-label="Leaderboard views">${[["records","Records"],["solo","Solo"],["pvp","PVP"],["advanced","Advanced stats"]].map(([key,label]) => `<button type="button" class="btn small ${selected === key ? "c-p3" : "c-fw"}" data-leader-tab="${key}" aria-pressed="${selected === key}">${label}</button>`).join("")}</div>`;
}
/**
 * Solo (Practice streaks) and PVP (Elo): the leader's card up top, then every
 * player in a green row, styled like the Advanced stats ranking.
 */
function leaderboardBody(tab, result) {
  const solo = tab === "solo",
    rows = result[tab] || [];
  const mine = session.account ? "account:" + session.account.id : null;
  const intro = `<p class="hint dark">${solo ? "Ranked by best Practice streak against Golfbot" : "Ranked by Elo from rated games"} · Patch ${e(result.patch)}${rows.some((row) => row.id?.startsWith("account:")) ? ". Tap a player for their full record." : ""}</p>`;
  if (!rows.length)
    return `${intro}<section class="panel c-fw leader-empty">${tilted(solo ? "flame.fill" : "trophy.fill", 52, { key: "leader-empty" })}<p>No ${solo ? "Practice streaks" : "rated results"} yet.</p><p class="hint dark">${solo ? "Win games in a row against Golfbot to get on the board." : "Finish a rated game to get on the board."}</p></section>`;
  const value = (row) => (solo ? row.best_streak : row.elo);
  const record = (row) => `${statNumber(row.wins)}–${statNumber(row.draws)}–${statNumber(row.losses)}`;
  const rate = (row) => (row.win_rate === null || row.win_rate === undefined ? "—" : statPercent(row.win_rate));
  const who = (row) => `${row.id === mine ? youStar() : ""}${e(row.label)}`;
  const leader = rows[0];
  const tile = (text, label) => `<div><b>${text}</b><span>${label}</span></div>`;
  const hero = `<section class="panel c-p3 stat-hero leader-hero">
      <span class="leader-trophy">${tilted("trophy.fill", 48, { key: "leader-trophy" })}</span>
      <div class="stat-rate${solo ? " streak-rate" : ""}">${solo ? icon("flame.fill", 44, { key: "leader-flame" }) : ""}${stickerText(String(value(leader)), { split: true, key: "leader-value" })}${solo ? "" : stickerText("Elo", { cls: "pts", key: "leader-elo" })}</div>
      <p><strong>${who(leader)}</strong> ${solo ? "· best streak" : "is on top"}</p>
      <div class="stat-tiles">${tile(record(leader), "W–D–L")}${tile(rate(leader), "win rate")}${tile(statNumber(leader.wins + leader.draws + leader.losses), "games")}</div>
    </section>`;
  const list = rows
    .map((row, i) => {
      const opens = row.id?.startsWith("account:");
      const tag = opens ? "button" : "div";
      const attrs = opens ? ` type="button" data-stats-player="${e(row.id)}"` : "";
      return `<${tag}${attrs} class="list-item board-row ${i === 0 ? "c-p3" : "c-fw"}${row.id === mine ? " mine" : ""}" style="--i:${i}" aria-label="${i + 1}. ${e(row.label)}, ${solo ? `best streak ${value(row)}` : `${value(row)} Elo`}, ${record(row)}, ${rate(row)} win rate">
        <span class="rank">${i === 0 ? tilted("trophy.fill", 30, { key: "lb-first" }) : stickerText(String(i + 1), { key: `lb-rank:${i}` })}</span>
        <div class="grow"><strong>${who(row)}</strong><small>${record(row)} · ${rate(row)} win rate</small></div>
        <b class="rate">${solo ? `<small class="streak-now">${statNumber(row.current_streak ?? 0)} currently</small>${icon("flame.fill", 22, { idle: false })}<span class="streak-num">${statNumber(value(row))}</span>` : `${statNumber(value(row))}<small>Elo</small>`}</b>${opens ? glyph("chevron.right", 16) : ""}
      </${tag}>`;
    })
    .join("");
  return `${intro}${hero}<div class="list leader-list">${list}</div>`;
}
/** Records: the all-time bests, one card each. */
function recordsBody(records = {}) {
  const mine = session.account ? "account:" + session.account.id : null;
  const who = (record) => `${record.id && record.id === mine ? youStar() : ""}${e(record.label)}`;
  const when = (at) => (at ? new Date(at * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "");
  const games = (n) => `${statNumber(n)} game${n === 1 ? "" : "s"}`;
  const card = (key, color, symbol, title, record, value, unit, detail, empty, note = "") =>
    `<section class="panel ${color} record-card" style="--i:${key}"><span class="record-ico">${tilted(symbol, 40, { key: `record:${key}` })}</span><h3>${title}</h3>${
      record
        ? `<div class="record-value">${stickerText(String(value), { split: true, key: `record-v:${key}` })}${unit ? stickerText(unit, { cls: "pts", key: `record-u:${key}` }) : ""}</div><p>${detail}</p>`
        : `<p class="hint dark">${empty}</p>`
    }${note ? `<p class="record-note">${note}</p>` : ""}</section>`;
  const { highest_elo: elo, comeback, most_modifier: most, least_modifier: least, comeback_modifier: clutch, pvp_streak: streak, games_today: today, modifiers_in_game: stacked } = records;
  return `<p class="hint dark">All-time bests from every saved game.</p><div class="records">${[
    card(0, "c-p3", "crown.fill", "Highest Elo", elo, elo?.elo, "Elo", elo && `<strong>${who(elo)}</strong>${elo.at ? ` · ${when(elo.at)}` : ""}`, "No rated games yet."),
    card(1, "c-s4", "flame.fill", "Best PvP win streak", streak, streak?.streak, streak?.streak === 1 ? "win" : "wins", streak && `<strong>${who(streak)}</strong> won ${streak.streak} 1v1 game${streak.streak === 1 ? "" : "s"} in a row against other players${streak.at ? ` · ${when(streak.at)}` : ""}`, "No 1v1 games won against another player yet."),
    card(2, "c-p2", "arrow.up.right", "Biggest comeback", comeback, comeback?.points, "pts", comeback && `<strong>${who(comeback)}</strong> was ${comeback.points} pts behind${comeback.opponents?.length ? ` ${e(comeback.opponents.length === 1 ? comeback.opponents[0] : `${comeback.opponents.length} players`)}` : ""} and won${comeback.scores ? ` ${e(comeback.scores.join("–"))}` : ""}${comeback.at ? ` · ${when(comeback.at)}` : ""}`, "No comebacks yet. The winner has to have been behind at some point."),
    card(3, "c-s7", "clock.arrow.circlepath", "Most games today", today, today?.games, today?.games === 1 ? "game" : "games", today && `<strong>${who(today)}</strong> has finished the most games since midnight`, "No games finished today yet."),
    card(4, "c-p1", "star.fill", "Most common modifier", most, most && statPercent(most.rate), "", most && `<strong>${e(most.name)}</strong> came into play in ${statNumber(most.active)} of ${games(most.games)} it was on`, "No games with modifiers yet.", records.always_in_play?.length ? `Leaves out ${e(records.always_in_play.join(", "))}, which is in play every game it's on.` : ""),
    card(5, "c-p4", "wand.and.stars", "Least common modifier", least, least && statPercent(least.rate), "", least && `<strong>${e(least.name)}</strong> came into play in ${statNumber(least.active)} of ${games(least.games)} it was on`, "Not enough games with modifiers yet."),
    card(6, "c-s5", "bolt.fill", "Comeback modifier", clutch, clutch?.wins, clutch?.wins === 1 ? "win" : "wins", clutch && `<strong>${e(clutch.name)}</strong> was in play for the winner in the most comeback wins`, "No comeback wins with a modifier yet."),
    card(7, "c-s6", "sparkles", "Most modifiers in a game", stacked, stacked?.count, "", stacked && `<strong>${who(stacked)}</strong> had ${stacked.count} in play in one game: ${e(stacked.rules.join(", "))}${stacked.at ? ` · ${when(stacked.at)}` : ""}`, "No games with modifiers yet."),
  ].join("")}</div>`;
}
/**
 * The leaderboard views (Solo, PVP, Records, Advanced stats) share one page: its header
 * and tabs are drawn once and stay put, and only the part below them changes.
 * `body` null means "still loading": the first time that shows `loading`; once
 * the page is up, what is there stays (dimmed) until the new view arrives.
 */
function leaderShell(name, title, tab, body, loading = "Loading…") {
  const shell = ["leaderboard", "stats"].includes(page) && root.querySelector("[data-leader-shell]");
  if (!shell) {
    show(
      name,
      `<div class="page scroll" data-leader-shell>${subHeader(title)}${leaderboardTabs(tab)}<div class="leader-body" data-leader-body>${body ?? `<div class="loading">${e(loading)}</div>`}</div></div>`,
    );
    return;
  }
  page = name;
  closeSheet();
  const heading = shell.querySelector(".page-title");
  if (heading && heading.textContent !== title) heading.textContent = title;
  shell.querySelectorAll("[data-leader-tab]").forEach((button) => {
    const on = button.dataset.leaderTab === tab;
    button.classList.toggle("c-p3", on);
    button.classList.toggle("c-fw", !on);
    button.setAttribute("aria-pressed", String(on));
  });
  const holder = shell.querySelector("[data-leader-body]");
  holder.classList.toggle("stale", body === null);
  if (body !== null) {
    // only the rows that changed are redrawn
    const template = document.createElement("template");
    if (!template.content) return void (holder.innerHTML = body);
    template.innerHTML = body;
    morphChildren(holder, template.content);
  }
}
let leaderboardRequest = 0,
  leaderboardCache = null;
async function leaderboardPage(tab = "pvp") {
  const request = ++leaderboardRequest;
  document.title = "Leaderboard - Golf";
  history.replaceState({}, "", appPath("/leaderboard"));
  const draw = (body) => leaderShell("leaderboard", "Leaderboard", tab, body, "Loading leaderboard…");
  // the last board shows straight away; it is only redrawn if the fetch changed it
  const body = (result) => (tab === "records" ? recordsBody(result.records) : leaderboardBody(tab, result));
  draw(leaderboardCache ? body(leaderboardCache) : null);
  try {
    const result = await api("/api/leaderboards");
    if (page !== "leaderboard" || request !== leaderboardRequest) return;
    const changed = JSON.stringify(result) !== JSON.stringify(leaderboardCache);
    leaderboardCache = result;
    if (changed) draw(body(result));
  } catch (error) {
    if (page === "leaderboard" && request === leaderboardRequest && !leaderboardCache)
      draw(`<p class="empty">${e(error.message)}</p>`);
  }
}

/* ---------- patch notes & rules ---------- */
async function patchesPage() {
  markPatchSeen();
  document.title = "Patch notes · Golf";
  history.replaceState({}, "", appPath("/patch-notes"));
  show(
    "patches",
    `<div class="page scroll">${subHeader("Patch notes")}<div class="loading">Loading patch notes…</div></div>`,
  );
  try {
    const notes = await api("/api/patch-notes");
    if (page !== "patches") return;
    show(
      "patches",
      `<div class="page scroll">${subHeader("Patch notes")}<div class="stack wide">${notes.patches
        .map((patch) => {
          const list = (title, items) =>
            items.length
              ? `<h3 style="margin-top:1.2rem">${title}</h3>${items.map((note) => `<p>• ${e(note)}</p>`).join("")}`
              : "";
          return `<article class="panel ${patch.version === notes.current ? "c-p4" : "c-fw"}"><span class="pill">${patch.version === notes.current ? "Latest update" : "Previous update"}</span><h2 style="margin-top:.8rem">Patch ${e(patch.version)}</h2>${list(patch.labels?.revisions || "Rule revisions", patch.rules.revisions)}${list(patch.labels?.additions || "Rule additions", patch.rules.additions)}${list(patch.labels?.changes || "Play and interface", patch.changes)}</article>`;
        })
        .join("")}</div></div>`,
    );
  } catch (error) {
    if (page === "patches")
      show(
        "patches",
        `<div class="page scroll">${subHeader("Patch notes")}<p class="empty">${e(error.message)}</p></div>`,
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
  if (target !== "account") leaveAfterSignIn = null;
  if (target === "home") return home();
  if (target === "history") return historyPage();
  if (target === "leaderboard") return leaderboardPage();
  if (target === "stats") return statsPage();
  if (target === "patches") return patchesPage();
  if (target === "account") return accountPage();
  if (target === "rules") return rulesPage();
  if (target === "friends") return friendsPage();
  if (target === "resume") {
    closeSheet();
    page = "room";
    return resume();
  }
  if (target === "solo") {
    // Practice goes straight to the avatar and rules step; a saved game keeps its own rules
    const saved = await api("/api/practice");
    startSetup("solo", saved);
    return;
  }
  if (target === "host") {
    if (document.getElementById("username")) saveName(name());
    return startSetup(target);
  }
}
document.addEventListener("click", async (event) => {
  // tapping the dimmed area behind a sheet closes it
  if (event.target === sheetRoot) return closeSheet();
  // and tapping the dimmed table around the results sets them aside to look
  // at the table (the Results button brings them back)
  if (event.target.classList?.contains("summary-scrim") && !board.summaryHidden) {
    board.summaryHidden = true;
    return renderSummary();
  }
  const button = event.target.closest("button, a[data-nav]");
  if (!button || button.disabled) return;
  if (button.matches("a[data-nav]")) event.preventDefault();
  const data = button.dataset;
  try {
    if (data.leaveChoice) return resolveLeavePrompt(data.leaveChoice);
    if (button.classList.contains("slot")) {
      // pointer taps are handled by the board; this is keyboard activation.
      // (A tap on the haptic switch also clicks with no detail: not a key press.)
      if (event.detail === 0 && event.target === button)
        tapSlot(JSON.parse(data.ref), button);
      return;
    }
    if (data.leaderTab) return data.leaderTab === "advanced" ? statsPage() : leaderboardPage(data.leaderTab);
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
    if ("confirm" in data) return await confirmStaged();
    if ("undo" in data) return cancelStaged();
    if (data.pref) return togglePref(data.pref);
    if ("settings" in data) return settingsSheet();
    if ("gameMenu" in data) return gameMenuSheet();
    if ("sheetPlayer" in data) return openRulesSheet(Number(data.sheetPlayer));
    if (data.statsFor)
      return await playerStatsSheet(data.statsFor === "me" ? state.viewer : board.view.opp);
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
    if (data.invitePlayer || data.inviteReply) {
      button.disabled = true;
      try {
        if (data.invitePlayer) {
          await api(`/api/lobbies/${state.id}/invite`, "POST", {
            player_id: data.invitePlayer,
          });
          await pollPresence();
        } else {
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
          if (data.inviteReply === "accept") enterRoom(next);
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
      return home();
    }
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
    if ("statsFiltersToggle" in data) return toggleStatsFilters();
    if (data.statsPlayer) {
      statsSelection.player = data.statsPlayer;
      statsSelection.opponent = "";
      return await statsPage();
    }
    if (data.statsPreset) {
      statsSelection.house_rules = data.statsPreset === "house";
      statsSelection.enabled = [];
      statsSelection.disabled = [];
      return await statsPage();
    }
    if (data.statsRule) {
      // each tap moves a rule on: either way → required → excluded → either way
      const key = data.statsRule;
      const value = statsRuleState(key);
      statsSelection.enabled = statsSelection.enabled.filter((item) => item !== key);
      statsSelection.disabled = statsSelection.disabled.filter((item) => item !== key);
      if (value === "any") statsSelection.enabled.push(key);
      else if (value === "on") statsSelection.disabled.push(key);
      return await statsPage();
    }
    if ("statsResetAll" in data) {
      statsSelection = { player: "", opponent: "", enabled: [], disabled: [], house_rules: true, patch: "" };
      return await statsPage();
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
      });
      if (epoch === tableEpoch) enterRoom(next);
      return;
    }
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
root.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (event.target.id === "display-name-form") {
    const input = event.target.querySelector("#account-display-name");
    const value = input.value.trim();
    if (!value) return toast("Your display name can't be empty.");
    if (value === session.username) return toast("That's already your display name.");
    saveName(value);
    input.value = value;
    if (session.account) {
      // saved to the account, so every device you sign in on uses it
      try {
        const next = await api("/api/name", "POST", { username: value, avatar: session.avatar });
        saveName(next.username);
      } catch (error) {
        return toast(error.message);
      }
    } else pollPresence(); // the server learns the new name with the next presence update
    return toast(`You'll show as ${session.username}.`);
  }
  if (event.target.id === "account-name-form") {
    try {
      const keep = { username: session.username, avatar: session.avatar };
      const epoch = tableEpoch, roomId = session.room_id;
      const next = await api("/api/account/name", "POST", {
        unique_name: new FormData(event.target).get("unique_name"),
        csrf_token: session.csrf_token,
      });
      const currentRoom = session.room_id;
      session = {...next, ...keep};
      if (epoch !== tableEpoch || currentRoom !== roomId || page !== "account") {
        session.room_id = currentRoom;
        return;
      }
      if (!(await finishPracticeSignIn())) accountPage();
    } catch (error) {
      toast(error.message);
    }
    return;
  }
});
root.addEventListener("change", async (event) => {
  const target = event.target;
  if (target.matches("select.cover"))
    target.previousElementSibling.textContent =
      target.selectedOptions[0]?.textContent || "";
  if (target.dataset.draft) {
    const key = target.dataset.draft;
    draft[key] = key === "length" ? Number(target.value) : target.value;
    if (key === "style" || key === "length" || key === "scorePreview") {
      saveName(name());
      setupPage();
    }
    if (key === "gameType") refreshRulesPicker();
    return;
  }
  if (target.hasAttribute("data-stats-patch") || target.hasAttribute("data-stats-opponent")) {
    if (target.hasAttribute("data-stats-patch")) statsSelection.patch = target.value;
    else statsSelection.opponent = target.value;
    await statsPage();
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
function route() {
  const path = currentPath();
  if (path === "/patch-notes") return patchesPage();
  if (path === "/account") return accountPage();
  if (path === "/leaderboard") return leaderboardPage();
  if (path === "/stats") return statsPage(true);
  if (path === "/history") return historyPage();
  const id = path.match(/^\/lobby\/([^/]+)$/)?.[1];
  if (id) return publicLobby(id);
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
  const faces = ['700 16px "FOT-Seurat Pro"', '700 16px "SF Pro Rounded"'].map((face) => document.fonts.load(face).catch(() => {}));
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
    if (prefs.turnAlerts) subscribeTurnAlerts(false).catch(() => setPref("turnAlerts", false));
    const firstPoll = pollPresence();
    // while in the queue the server is asked far more often, so a match shows at once
    let lastPoll = performance.now();
    setInterval(() => {
      const queued = ["waiting", "offer"].includes(presenceState.queue?.status);
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
