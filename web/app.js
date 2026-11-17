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
const NEW_RULES = ["poisoned_card"];

/* ---------- emotes ---------- */
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
  el.textContent = text;
  el.hidden = true;
  void el.offsetWidth;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4200);
}
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
function show(name, html) {
  page = name;
  document.documentElement.classList.remove("in-game");
  closeSheet();
  root.innerHTML = html;
  window.scrollTo(0, 0);
}
function openSheet(html, player = "") {
  // `player` marks a rules sheet, which is kept in step with the table
  sheetRoot.dataset.player = String(player);
  sheetRoot.innerHTML = html;
  sheetRoot.hidden = false;
}
function closeSheet() {
  sheetRoot.hidden = true;
  sheetRoot.innerHTML = "";
}
function topbar() {
  return `<header class="topbar"><button type="button" class="icon-btn" data-settings aria-label="Settings">${icon("gear", 44)}</button>${logoHtml()}</header>`;
}
function subHeader(title, back = session?.room_id ? "resume" : "home") {
  return `<header class="topbar"><button type="button" class="btn round c-fw" style="width:5.2rem;height:5.2rem" data-nav="${back}" aria-label="Back">${glyph("chevron.left", 20)}</button><h1 class="page-title" style="margin-left:1.2rem">${e(title)}</h1></header>`;
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
  return `<button type="button" class="btn round c-fw" data-nav="${target}" aria-label="Back">${glyph("chevron.left", 20)}</button>`;
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
  const visible =
    queue && ["waiting", "offer"].includes(queue.status) && page !== "home";
  banner.hidden = !visible;
  if (visible)
    banner.innerHTML = `<span>${queue.status === "offer" ? (queue.accepted ? "Waiting for opponent" : "Match found!") : "In the Quickplay queue"}</span>${queue.status === "offer" ? `<button type="button" class="btn small" data-queue-view>View</button>` : ""}<button type="button" class="btn small" data-queue-leave>Leave</button>`;
  renderHomeLive();
  if (page === "room" && state?.game && board.el?.isConnected) renderChrome();
}
async function joinQueue() {
  saveName(name());
  presenceState.queue = await api("/api/queue/join", "POST", {
    username: session.username,
    avatar: session.avatar,
  });
  hiddenQueueOffer = null;
  toast("You're in the Quickplay queue. Practice while you wait!");
  renderQueueBanner();
  renderSocial();
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
  const offer = presenceState.queue;
  if (offer?.status === "offer" && hiddenQueueOffer !== offer.id) {
    socialMode = "queue";
    const signature = JSON.stringify(offer);
    if (signature !== socialSignature) {
      socialSignature = signature;
      dialog.innerHTML = `<h2>${tilted("sparkles", 30)} Classic match</h2><p>Your opponent: <strong>${e(offer.opponent)}</strong></p><div class="meta" style="margin:1rem 0"><span class="pill c-p1">5 games · total pts</span>${houseBadge(offer.lobby)}</div><p class="hint">Both players must accept within 60 seconds. An unfinished practice game won't count.</p><details><summary>Rules in play</summary><p>${e(rulesSummary(offer.lobby.rules))}</p></details><div class="dialog-actions"><button type="button" class="btn c-p3" data-queue-reply="accept" ${offer.accepted ? "disabled" : ""}>${offer.accepted ? "Waiting…" : "Accept"}</button><button type="button" class="btn c-p2" data-queue-reply="decline">Decline</button>${offer.accepted ? `<button type="button" class="btn c-fw" data-queue-hide>Keep playing</button>` : ""}</div>`;
    }
    if (!dialog.open) dialog.showModal();
    return;
  }
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
      ? `<h2>Invite a player</h2><p class="hint">Players online right now who aren't at a table.</p><div class="list" style="margin-top:1.2rem">${presenceState.players.map((player) => `<div class="list-item c-p1">${avatarBadge(player.avatar, "c-p1")}<div class="grow"><strong>${e(player.display_name)}</strong><small>${player.unique_name ? "@" + e(player.unique_name) : "Guest"}</small></div><button type="button" class="btn small c-p1" data-invite-player="${e(player.id)}" ${presenceState.invited.includes(player.id) ? "disabled" : ""}>${presenceState.invited.includes(player.id) ? "Invited" : "Invite"}</button></div>`).join("") || `<p>No one else is online right now. Share the invite link instead.</p>`}</div><div class="dialog-actions"><button type="button" class="btn c-fw" data-social-close>Close</button></div>`
      : `<h2>${tilted("figure.2", 30)} You're invited</h2><p><strong>${e(invitation.host)}</strong> invited you to <strong>${e(invitation.lobby.name)}</strong>.</p><div class="meta" style="margin:1rem 0"><span class="pill c-p1">${e(matchLength(invitation.lobby))}</span>${houseBadge(invitation.lobby)}</div><details><summary>More info</summary><p>First player: ${e(starter[invitation.lobby.first])}</p><p>${e(rulesSummary(invitation.lobby.rules))}</p></details><div class="dialog-actions"><button type="button" class="btn c-p1" data-invite-reply="accept" data-invitation="${e(invitation.id)}">Accept</button><button type="button" class="btn c-p2" data-invite-reply="decline" data-invitation="${e(invitation.id)}">Decline</button></div>`;
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
    medal = twin("medal");
  show(
    "home",
    `<div class="page">${topbar()}<div class="stack">
    ${session.room_id ? `<button type="button" class="btn c-fw" data-nav="resume">${tilted("play.fill", 30)} Resume your table</button>` : ""}
    <button type="button" class="btn c-p1" data-nav="friends">${friends[0]}<span>Play with Friends</span>${friends[1]}<span id="lobby-count" class="badge" hidden></span></button>
    <button type="button" class="btn c-p3" data-queue-toggle>${quick[0]}<span>Quickplay<span class="sub" id="queue-sub"></span></span>${quick[1]}</button>
    <button type="button" class="btn c-p2" data-nav="leaderboard">${medal[0]}<span>Leaderboard</span>${medal[1]}</button>
    <div class="row split">
      <button type="button" class="btn tile c-fw grow" data-nav="solo">${tilted("dumbbell.fill", 33)}<span>Practice</span></button>
      <button type="button" class="btn tile c-p4 grow" data-nav="rules">${tilted("list.bullet.clipboard.fill", 33, { tilt: 6 })}<span>Rules</span></button>
    </div>
    <p class="credit">handcrafted by spencer &amp; alex</p>
  </div></div>`,
  );
  renderQueueBanner();
  pollPresence();
}
function settingsSheet() {
  const account = session.account;
  openSheet(`<section class="sheet c-fw" role="dialog" aria-modal="true" aria-label="Settings">
    <div class="sheet-head"><h2>Settings</h2><button type="button" class="close-btn" data-sheet-close aria-label="Close">${icon("xmark.circle.fill", 36, { idle: false })}</button></div>
    <div class="menu-list">
      ${session.room_id && page !== "room" ? `<button type="button" class="btn c-p1" data-nav="resume">${tilted("play.fill", 26)} Resume your table</button>` : ""}
      <button type="button" class="btn c-p1" data-nav="account">${tilted("person.crop.circle.fill", 26)} ${account ? e(account.unique_name ? "@" + account.unique_name : "Choose unique name") : "Sign in with Google"}</button>
      <button type="button" class="btn c-p3" data-nav="history">${tilted("clock.arrow.circlepath", 26)} Match history</button>
      <button type="button" class="btn c-p2" data-nav="leaderboard">${tilted("medal", 26)} Leaderboard</button>
      ${voidOfferButton()}
      <button type="button" class="btn c-p4" data-nav="patches">${tilted("newspaper.fill", 26)} Patch notes</button>
      <a class="btn c-fw" href="privacy">${tilted("lock.fill", 26)} Privacy</a>
    </div>
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
    <div class="sheet-head"><h2>${e(state.name)}</h2><button type="button" class="close-btn" data-sheet-close aria-label="Close">${icon("xmark.circle.fill", 36, { idle: false })}</button></div>
    <p class="hint dark" style="margin-bottom:1.2rem">Game ${state.round} · ${e(matchLength(state))}</p>
    <div class="menu-list">
      <button type="button" class="btn c-p1" data-rules-for="me">${tilted("checklist", 26)} Rules &amp; scores</button>
      ${state.solo ? "" : `<button type="button" class="btn c-p3" data-copy="${e(link)}">${tilted("link", 26)} Copy invite link</button>`}
      <button type="button" class="btn c-p3" data-nav="history">${tilted("clock.arrow.circlepath", 26)} Match history</button>
      <button type="button" class="btn c-p4" data-nav="rules">${tilted("list.bullet.clipboard.fill", 26)} How to play</button>
      ${voidOfferButton()}
      <button type="button" class="btn c-p2" data-leave>${tilted("rectangle.portrait.and.arrow.right", 26)} Leave table</button>
    </div>
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
  preset: "house",
  rules: {},
  first: "random",
  rulesOpen: false,
};
const ENTRY_STYLE = {
  host: { color: "c-p1", glyph: "figure.2" }, // Play with Friends
};
function entryButton(attribute, label) {
  const { color, glyph: symbol } = ENTRY_STYLE[draft.mode];
  return `<button type="button" class="btn ${color} grow" ${attribute}>${tilted(symbol, 33)}<span>${label}</span>${tilted(symbol, 33, { mirror: true })}</button>`;
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
      `<div class="page">${topbar()}<div class="stack wide">
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
    </div><div class="row">${backButton("friends")}${entryButton("data-setup-next", "Continue")}</div></div>`,
    );
    return;
  }
  show(
    "setup",
    `<div class="page">${topbar()}<div class="stack wide">${avatarPicker()}<div class="stack" data-rules-picker>${rulesPicker()}</div></div><div class="row"><button type="button" class="btn round c-fw" data-setup-back aria-label="Back">${glyph("chevron.left", 20)}</button>${entryButton("data-setup-go", `<span style="white-space:nowrap">Let<span style="letter-spacing:-0.55em">’</span>s Play!</span>`)}</div></div>`,
  );
  centerAvatar(false);
}
function avatarPicker() {
  const options = avatars.filter((avatar) => avatar.selectable);
  return `<div class="avatar-pick"><span class="pointer">${icon("chevron.down", 30, { idle: false, style: "--fill:var(--fw);--stroke:var(--fw)", sw: 1.5 })}</span><div class="avatar-strip" role="radiogroup" aria-label="Avatar">${options.map((avatar) => `<button type="button" class="avatar" role="radio" aria-checked="${avatar.id === session.avatar}" aria-label="${e(avatar.name)}" data-avatar="${e(avatar.id)}">${icon(avatar.icon, 44)}</button>`).join("")}</div><p class="avatar-name">Select Your Avatar</p></div>`;
}
/**
 * Lay the avatars out on the rim of a big wheel: the one under the pointer is
 * upright and largest; the rest fall away along the arc, turning, shrinking
 * and softening toward the edges.
 */
function layoutWheel(strip = root.querySelector(".avatar-strip")) {
  const items = strip ? [...strip.querySelectorAll(".avatar")] : [];
  if (!items.length) return;
  const middle = strip.scrollLeft + strip.clientWidth / 2;
  const pitch =
    items.length > 1 ? items[1].offsetLeft - items[0].offsetLeft : items[0].offsetWidth;
  const radius = pitch * 5.2;
  for (const item of items) {
    const offset = item.offsetLeft + item.offsetWidth / 2 - middle;
    const steps = Math.abs(offset / pitch);
    const angle = clamp(offset / radius, -1.2, 1.2);
    const x = radius * Math.sin(angle) - offset;
    const y = radius * (1 - Math.cos(angle));
    const scale =
      (1 + Math.max(0, 1 - steps) * 0.35) * (1 - Math.min(0.35, steps * 0.08));
    const blur = Math.max(0, steps - 1.2) * 1.4;
    item.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px) rotate(${angle.toFixed(3)}rad) scale(${scale.toFixed(3)})`;
    item.style.filter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : "";
    item.style.opacity = clamp(1 - (steps - 1.7) * 0.45, 0.25, 1).toFixed(2);
    item.style.zIndex = String(50 - Math.round(steps * 10));
    // keep each sticker's shadow falling down-right as it turns on the wheel
    const reach = 0.3;
    item.style.setProperty("--shx", `${(reach * (Math.cos(angle) + Math.sin(angle))).toFixed(3)}rem`);
    item.style.setProperty("--shy", `${(reach * (Math.cos(angle) - Math.sin(angle))).toFixed(3)}rem`);
  }
}
function centerAvatar(smooth = true) {
  const strip = root.querySelector(".avatar-strip");
  const chosen = strip?.querySelector("[aria-checked='true']");
  if (!chosen) return;
  strip.scrollTo({
    left: chosen.offsetLeft - strip.clientWidth / 2 + chosen.offsetWidth / 2,
    behavior: smooth ? "smooth" : "instant",
  });
  layoutWheel(strip);
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
      const middle = strip.scrollLeft + strip.clientWidth / 2;
      let best = null,
        distance = Infinity;
      strip.querySelectorAll(".avatar").forEach((button) => {
        const d = Math.abs(button.offsetLeft + button.offsetWidth / 2 - middle);
        if (d < distance) [best, distance] = [button, d];
      });
      if (best && best.getAttribute("aria-checked") !== "true")
        pickAvatar(best.dataset.avatar, false);
    }, 90);
  },
  true,
);
function rulesPicker() {
  const count = catalog.filter((rule) => draft.rules[rule.key]).length;
  const locked = draft.gameType === "many" || draft.preset === "house";
  const presets = [
    ["random", "Random", "dice.fill"],
    ["house", "House", "house.fill"],
    ["vanilla", "Vanilla", "checkmark.seal.text.page.fill"],
  ];
  const row = (rule) =>
    `<button type="button" class="rule-row" role="checkbox" aria-checked="${!!draft.rules[rule.key]}" data-draft-rule="${e(rule.key)}" title="${e(rule.description)}">${tilted(draft.rules[rule.key] ? "checkmark.circle.fill" : "circle.fill", 24, { idle: false, sw: 2.5 })}<span>${e(rule.name)}${NEW_RULES.includes(rule.key) ? ` <span class="new-tag">NEW</span>` : ""}</span></button>`;
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
      ${selectField("Who goes first", `data-draft="first" aria-label="Who goes first?" ${locked ? "disabled" : ""}`, Object.entries(starter).map(([key, label]) => [key, label, (locked ? "random" : draft.first) === key]), null, `compact${locked ? " locked" : ""}`)}
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
    document.body.append(dialog);
  }
  const guestPractice = leaving.practice && !session.account;
  const title = guestPractice ? "Sign in to keep your streak" : "Leave table?";
  const description = guestPractice
    ? "Sign in before leaving to save your practice game and streak. If you leave without signing in, an unfinished game's current streak will reset."
    : leaving.rated && leaving.status === "playing"
      ? `Leaving counts as a loss and costs you ${leaving.forfeit_elo_loss} Elo.`
      : leaving.rated
        ? "This ends the series early. Completed games and their Elo changes are kept."
        : "Your game and streak will be saved to your account so you can resume later.";
  dialog.innerHTML = `<h2 id="leave-title">${title}</h2><p id="leave-description">${description}</p><div class="dialog-actions">${guestPractice ? `<button type="button" class="btn c-p3" data-leave-choice="signin">Sign in</button>` : ""}<button type="button" class="btn ${guestPractice ? "c-p2" : "c-p3"}" data-leave-choice="leave">${guestPractice ? "No, leave" : "Leave table"}</button><button type="button" class="btn c-fw" data-leave-choice="stay">Keep playing</button></div>`;
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
    <div class="row" style="align-items:center"><h1 class="page-title">Open tables</h1><button type="button" class="btn small c-fw" data-nav="friends">${glyph("arrow.clockwise", 18)} Refresh</button></div>
    <div class="list">${
      lobbies
        .map((lobby) => {
          const open = lobby.status === "waiting" && lobby.players < lobby.capacity;
          return `<button type="button" class="list-item ${open ? "c-p1" : "c-fw"}" data-lobby="${e(lobby.id)}">${avatarBadge(lobby.avatars?.[0], open ? "c-p1" : "c-fw")}<div class="grow"><strong>${e(lobby.name)}</strong><small>${e(lobby.names[0])} · ${lobby.players}/${lobby.capacity} players · ${e(matchLength(lobby))}${open ? "" : " · " + e(lobby.status.replace("_", " "))}</small></div>${glyph("chevron.right", 20)}</button>`;
        })
        .join("") ||
      `<p class="hint">No open tables yet. Host one and invite a friend!</p>`
    }</div></div></div>
    <div class="row">${backButton()}<button type="button" class="btn c-p1 grow" data-nav="host">${twin[0]}<span>Host a Table</span>${twin[1]}</button></div></div>`,
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
    ${avatarPicker()}
    ${field("Your Display Name", `<input id="username" maxlength="32" value="${e(session.username)}" autocomplete="nickname" aria-label="Your display name">`, "character.cursor.ibeam")}
    ${full ? `<p class="hint dark">This table is full or already playing.</p>` : ""}
    </div><div class="row">${backButton("friends")}<button type="button" class="btn c-p1 grow" data-join="${e(id)}" ${full ? "disabled" : ""}>${twin[0]}<span>Join Table</span>${twin[1]}</button></div></div>`,
  );
  centerAvatar(false);
}
function waitingRoom() {
  const many = state.game_type === "many";
  const url = `${location.origin}${appPath(`/lobby/${state.id}`)}`;
  const seatColor = (seat) => ["c-p1", "c-p2", "c-p3", "c-p4"][seat % 4];
  show(
    "room",
    `<div class="page">${topbar()}<div class="stack wide">
    <div class="stack"><h1 class="page-title">${e(state.name)}</h1><div class="meta"><span class="pill">${e(matchLength(state))}</span><span class="pill">${state.players}/${state.capacity} players</span><span class="pill">${e(starter[state.first])}</span>${houseBadge(state)}</div></div>
    <div class="share">${field("Invite Link", `<input readonly aria-label="Lobby invite link" value="${e(url)}">`, "link")}<button type="button" class="btn c-p1" style="flex:none;min-height:5.6rem;font-size:1.8rem;padding:0 1.6rem" data-copy="${e(url)}">Copy</button></div>
    <div class="list">${state.names.map((seatName, seat) => `<div class="list-item ${seatColor(seat)}">${!many && seat === 1 && state.players < 2 ? `<span class="avatar-badge ${seatColor(seat)}">${icon("person.fill", 24, { idle: false })}</span>` : avatarBadge(state.avatars?.[seat], seatColor(seat))}<div class="grow"><strong>${e(seatName)}${seat === state.viewer ? " (you)" : ""}</strong><small>${seat === 0 ? "Host" : "Player " + (seat + 1)} · ${state.connected[seat] ? "connected" : !many && seat === 1 ? "seat open" : "offline"}</small></div></div>`).join("")}</div>
    <p class="hint">${e(rulesSummary(state.rules))}</p>
    <p class="hint dark">${many ? "The host starts once at least three players have joined." : "The game starts automatically when a friend joins."}</p>
    </div><div class="stack">${state.viewer === 0 ? `<button type="button" class="btn c-p3" data-invite-open>${tilted("person.fill.badge.plus", 32)}<span>Invite a Player</span></button>` : ""}<div class="row"><button type="button" class="btn round c-p2" data-leave aria-label="Leave table">${glyph("xmark", 20)}</button>${many && state.viewer === 0 ? `<button type="button" class="btn c-p1 grow" data-action="start" ${state.players < 3 ? "disabled" : ""}>${tilted("play.fill", 32)}<span>Start Game</span></button>` : `<div class="btn c-fw grow" style="font-size:1.8rem" role="status">Waiting for players…</div>`}</div></div></div>`,
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
    if (opened && page === "room") toast("Reconnecting to the table…");
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
  renderVoidOffer();
  session.room_id = next.id;
  if (SIDE_PAGES.includes(page)) return;
  page = "room";
  if (changed) board.selected = [];
  renderRoom();
}
function enterRoom(next) {
  page = "room";
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
  // keep an open rules sheet in step with the table
  const player = sheetRoot.dataset.player;
  if (!sheetRoot.hidden && player !== undefined && player !== "")
    sheetRoot.innerHTML = rulesSheet(Number(player));
}
function openRulesSheet(player) {
  openSheet(rulesSheet(player), player);
}
/** Send one table action. Resolves true when the server accepted it. */
async function move(action, extra = {}) {
  if (busy || !state || state.void_offer) return false;
  const roomId = state.id;
  let ok = false;
  busy = true;
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
    toast(error.message);
    if (error.status === 409 && state) {
      try {
        accept(await api(`/api/lobbies/${state.id}/state`));
      } catch {}
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
    }${account ? `<button type="button" class="btn small c-p2" style="margin-top:1.6rem" data-signout>Sign out</button>` : ""}<p style="margin-top:1.2rem;opacity:.7">Guests are grouped by display name. Signing in does not claim earlier guest results.</p></div></div>`,
  );
  renderGoogleSignIn();
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
            return `<article class="panel c-fw"><h2>${e(match.lobby_name)}</h2><div class="meta"><span class="pill">${e(new Date(ended * 1000).toLocaleDateString())}</span>${match.solo ? `<span class="pill">Vs Golfbot</span>` : ""}<span class="pill">${e(matchLength(match))}</span><span class="pill">${e(status)}</span><span class="pill">${e(match.patch || "Earlier patches")}</span></div><p style="margin-top:1rem">${tilted("trophy.fill", 22, { style: "--fill:var(--p3);--stroke:var(--paper)" })} Overall winner: ${e(winner)}</p><div class="table-wrap"><table><thead><tr><th scope="col">Game</th>${match.names.map((name, p) => `<th scope="col">${e(name)}${match.viewer === p ? " (you)" : ""}</th>`).join("")}<th scope="col">Winner</th></tr></thead><tbody>${match.rounds.map((game) => `<tr><th scope="row">${game.round}</th>${game.scores.map((score) => `<td>${score}</td>`).join("")}<td>${game.winner === null ? "Draw" : e(match.names[game.winner])}</td></tr>`).join("")}</tbody><tfoot><tr><th scope="row">Total pts</th>${match.points.map((score) => `<td>${score}</td>`).join("")}<td></td></tr><tr><th scope="row">Game wins</th>${match.wins.map((wins) => `<td>${wins}</td>`).join("")}<td></td></tr></tfoot></table></div></article>`;
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
  statsRequest = 0;
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
function readStatsForm() {
  const form = document.getElementById("stats-form");
  if (!form) return;
  const data = new FormData(form);
  statsSelection = {
    player: data.get("player") || "",
    opponent: data.get("opponent") || "",
    enabled: [],
    disabled: [],
    initialized: true,
    house_rules: data.has("house_rules"),
    patch: data.get("patch") || "",
  };
  if (statsSelection.player === statsSelection.opponent)
    statsSelection.opponent = "";
  for (const rule of catalog) {
    if (statsSelection.house_rules) break;
    const value = data.get("filter-" + rule.key);
    if (value === "on") statsSelection.enabled.push(rule.key);
    if (value === "off") statsSelection.disabled.push(rule.key);
  }
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
  if (!statsSelection.initialized) {
    statsSelection.player ||= session.account ? "account:" + session.account.id : "player:" + session.username;
    statsSelection.opponent ||= "bot:golfbot";
    statsSelection.patch ||= (session.patch || matchOptions.patch);
    statsSelection.initialized = true;
  }
  const request = ++statsRequest;
  const focused = document.activeElement?.id;
  const rulesOpen = document.getElementById("stats-rules")?.open;
  const wasStats = page === "stats";
  const scroll = window.scrollY;
  document.title = "Leaderboard · Golf";
  const query = new URLSearchParams();
  if (!statsSelection.house_rules) query.set("house_rules", "false");
  else {
    statsSelection.enabled = [];
    statsSelection.disabled = [];
  }
  query.set("patch", statsSelection.patch || "");
  if (statsSelection.player) query.set("player", statsSelection.player);
  query.set("opponent", statsSelection.opponent || "");
  for (const key of statsSelection.enabled) query.append("enabled", key);
  for (const key of statsSelection.disabled) query.append("disabled", key);
  history.replaceState(
    {},
    "",
    appPath("/stats") + (query.toString() ? "?" + query : ""),
  );
  const head = subHeader("Leaderboard") + leaderboardTabs("advanced");
  if (!wasStats)
    show(
      "stats",
      `<div class="page scroll">${head}<div class="loading">Loading player stats…</div></div>`,
    );
  try {
    const result = await api("/api/stats?" + query);
    if (page !== "stats" || request !== statsRequest) return;
    statsSelection.player = result.player?.profile.id || "";
    statsSelection.opponent = result.comparison?.profile.id || "";
    if (!result.players.length) {
      show(
        "stats",
        `<div class="page scroll">${head}<p class="hint">No saved games yet. Finish a game against a player or Golfbot to see player statistics here.</p></div>`,
      );
      return;
    }
    const options = (selected, exclude = "") =>
      result.players
        .filter((player) => player.id !== exclude)
        .map(
          (player) =>
            `<option value="${e(player.id)}" ${player.id === selected ? "selected" : ""}>${e(player.label)}</option>`,
        )
        .join("");
    const active =
      statsSelection.enabled.length + statsSelection.disabled.length;
    show(
      "stats",
      `<div class="page scroll">${head}<p class="hint dark">Pick a player to see their record, or compare two head to head. ${session.room_id ? "Your table is still open." : ""}</p>
      <form id="stats-form" class="panel c-p2"><div class="form-grid">
        ${field("Player", `<select aria-label="Player" id="stats-player" name="player" data-stats-select>${options(statsSelection.player)}</select>`, null, "compact")}
        ${field("Compare With", `<select aria-label="Compare with" id="stats-opponent" name="opponent" data-stats-select><option value="">Overall only</option>${options(statsSelection.opponent, statsSelection.player)}</select>`, null, "compact")}
        ${field("Patch", `<select id="stats-patch" name="patch" aria-label="Patch" data-stats-select><option value="">All time</option>${result.patches.map((patch) => `<option value="${e(patch)}" ${statsSelection.patch === patch ? "selected" : ""}>${e(patch === "legacy" ? "Earlier patches" : patch)}</option>`).join("")}</select>`, null, "compact")}
      </div>
      <label class="check" style="margin-top:1.4rem"><input type="checkbox" aria-label="House rules" name="house_rules" data-stats-house ${statsSelection.house_rules ? "checked" : ""}><span>House rules only <small style="display:block;opacity:.7;font-size:1.3rem">Official stats · saved house-rule games</small></span></label>
      <details id="stats-rules" style="margin-top:1rem" ${(rulesOpen ?? active > 0) ? "open" : ""}><summary>Rule filters · ${statsSelection.house_rules ? "House rules" : active ? active + " selected" : "any rules"}</summary><fieldset ${statsSelection.house_rules ? "disabled" : ""}><p>Any allows either setting. On requires the rule; Off excludes it.</p><div class="row" style="margin:1rem 0"><button type="button" class="btn small" data-stats-all="on">All on</button><button type="button" class="btn small" data-stats-all="off">All off</button></div><div class="form-grid">${catalog.map((rule) => field(rule.name, `<select name="filter-${e(rule.key)}" aria-label="${e(rule.name)} filter"><option value="any">Any</option><option value="on" ${(statsSelection.house_rules ? matchOptions.house_rules[rule.key] : statsSelection.enabled.includes(rule.key)) ? "selected" : ""}>On</option><option value="off" ${(statsSelection.house_rules ? !matchOptions.house_rules[rule.key] : statsSelection.disabled.includes(rule.key)) ? "selected" : ""}>Off</option></select>`, null, "compact")).join("")}</div></fieldset></details>
      <div class="row" style="margin-top:1.4rem"><button class="btn small grow" type="submit">Apply filters</button><button class="btn small" type="button" data-stats-reset ${statsSelection.house_rules ? "disabled" : ""}>Reset rules</button></div></form>
      <div id="stats-content" class="stack wide">${statsTable([result.player, result.comparison].filter(Boolean), "overall", statsSelection.house_rules ? "Official stats · overall" : "Overall · against all opponents", "c-p3")}${result.comparison ? statsTable([result.player, result.comparison], "head_to_head", "Head to head", "c-p1") : `<p class="hint">Choose a comparison player above for head-to-head results.</p>`}<details class="panel c-fw"><summary>How stats are counted</summary><p style="font-size:1.4rem">A game is one deal. A series is a full match. House rules includes games started with a saved, locked preset; earlier unmarked games remain available with House rules off. Turns counts completed turns by all players. In many-player games, an overall game win means the unique lowest score at the table; tied lowest scores are draws. Average opponent points uses the mean of all other players. Head-to-head game results compare just the two selected players, and many-player head-to-head series compare their total points. Fixed series allow drawn totals; patch and rule filters require every game of a completed series to match. Modifiers in play counts the scoring modifiers affecting that player's hand, including separate variants of a rule. The average excludes older games without modifier records. Continuous series are decided after everyone leaves: game wins first, then lower total points. An exact tie has no series winner. Game win rate includes draws in the denominator; series win rate uses completed matches only. Matching games from unfinished series still count toward game stats. With rule filters, a completed series counts only when every game matches. Negative point advantage means fewer points than the opponent. Activation percentage counts games where that player triggered the rule, divided by all games with activation records. Win rate counts wins among those activated games, including draws in the denominator. Each rule counts once per game, even if it triggers multiple times. Rules affecting the opponent are credited to the player who triggered them. Older games without activation records are excluded from this tracker.</p></details></div></div>`,
    );
    if (wasStats) window.scrollTo(0, scroll);
    if (focused) document.getElementById(focused)?.focus();
  } catch (error) {
    if (page === "stats" && request === statsRequest)
      show(
        "stats",
        `<div class="page scroll">${head}<p class="empty">${e(error.message)}</p><button type="button" class="btn small c-fw" data-stats-reset-all>Clear selection and retry</button></div>`,
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
  ripped_five: [["Diamond 5 and opposite-row 5 cancel; no column pair required", ["5D",null,null,null,"5S",null]]],
  roman_fives: [["8 + 4 + (-2) = 10 base points: final score divided by 2", ["8H",null,"2S",null,"4D",null]], ["Inverted V: 5 + 4 + A = 10", [null,"4S",null,"5D",null,"AH"]]],
  beggars: [["Your 10 is the unique highest visible value. Guess the chosen hidden card's rank before it flips", ["10H",null,null,null,null,null], ["3H",null,null,null,null,null], "Opponent: a correct guess trades your 10 for their lowest visible card after the reveal"]],
  four_kind: [["Four visible 4s may be arranged into two columns", ["4H","4S",null,"4D","4C",null]]],
  poisoned_card: [["First player to reveal all six during play: +2 before divisions", ["AH","3S","5D","7C","9H","KC"]]],
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
  return `<div class="rule-card${on ? "" : " off"}"><div class="rule-icon-controls"><span class="rule-ico">${icon(RULE_ICON[rule.key] || "star.fill",30,{idle:false})}</span><button type="button" class="rule-eye${expanded ? " c-p3" : ""}" data-rule-example="${e(token)}"${inMatch ? ` data-rule-player="${player}" data-rule-key="${e(rule.key)}"` : ""} aria-expanded="${expanded}" aria-controls="example-${e(token)}" aria-label="Show examples for ${e(rule.name)}">${icon("eye.fill",24,{idle:false})}</button></div><div class="rule-help-copy"><strong>${e(rule.name)}${active ? ` <span class="pill">active</span>` : ""}</strong><p>${e(rule.description)}</p>${variantsHtml(rule.key)}${editable ? `<button type="button" class="btn small ${on ? "c-p2" : "c-p1"}" style="margin-top:.6rem" data-live-rule="${e(rule.key)}" data-enable="${!on}">${on ? "Turn off" : "Turn on"}</button>` : ""}<div class="rule-example" id="example-${e(token)}"${expanded ? "" : " hidden"}>${examples}</div></div></div>`;
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
    dialog.innerHTML = `<h2>Void game &amp; end series early?</h2><p>${own ? "Waiting for your opponent." : `${e(state.names[offer.by])} wants to void this game and end the series early.`}</p><p><strong>NO ELO CHANGE.</strong> This game will not count. Completed rounds are preserved.</p><p>Play is paused. Offer expires in <b data-void-seconds></b>s.</p>${own ? "" : `<div class="dialog-actions"><button type="button" class="btn c-p3" data-void-reply="accept">Accept</button><button type="button" class="btn c-p2" data-void-reply="decline">Decline</button></div>`}`;
  }
  dialog.querySelector("[data-void-seconds]").textContent = Number.isFinite(seconds) ? seconds : 30;
  if (!dialog.open) dialog.showModal();
  voidTimer = setTimeout(renderVoidOffer, 1000);
}

function leaderboardTabs(selected) {
  return `<div class="leader-tabs" role="group" aria-label="Leaderboard views">${[["solo","Solo"],["pvp","PVP"],["advanced","Advanced stats"]].map(([key,label]) => `<button type="button" class="btn small ${selected === key ? "c-p3" : "c-fw"}" data-leader-tab="${key}" aria-pressed="${selected === key}">${label}</button>`).join("")}</div>`;
}
let leaderboardRequest = 0;
async function leaderboardPage(tab = "pvp") {
  const request = ++leaderboardRequest;
  document.title = "Leaderboard - Golf";
  history.replaceState({}, "", appPath("/leaderboard"));
  const head = subHeader("Leaderboard") + leaderboardTabs(tab);
  show("leaderboard", `<div class="page scroll">${head}<div class="loading">Loading leaderboard...</div></div>`);
  try {
    const result = await api("/api/leaderboards");
    if (page !== "leaderboard" || request !== leaderboardRequest) return;
    const solo = tab === "solo", rows = result[tab] || [];
    show("leaderboard", `<div class="page scroll">${head}<section class="panel c-p2 leaderboard-panel"><h2>${solo ? "Practice streaks" : "PVP ratings"}</h2><p class="hint">Patch ${e(result.patch)}</p><div class="table-wrap"><table><thead><tr><th scope="col">Rank</th><th scope="col">Player</th>${solo ? "<th>Best streak</th>" : "<th>Elo</th>"}<th>W-D-L</th><th>Win rate</th></tr></thead><tbody>${rows.map((row,index) => `<tr><td>${index + 1}</td><th scope="row">${e(row.label)}</th>${solo ? `<td>${statNumber(row.best_streak)}</td>` : `<td>${statNumber(row.elo)}</td>`}<td class="leader-record">${statNumber(row.wins)}-${statNumber(row.draws)}-${statNumber(row.losses)}</td><td>${statPercent(row.win_rate)}</td></tr>`).join("")}</tbody></table></div>${rows.length ? "" : `<p>No ${solo ? "Practice streaks" : "rated results"} yet.</p>`}</section></div>`);
  } catch (error) {
    if (page === "leaderboard" && request === leaderboardRequest) show("leaderboard", `<div class="page scroll">${head}<p class="empty">${e(error.message)}</p></div>`);
  }
}

/* ---------- patch notes & rules ---------- */
async function patchesPage() {
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
          return `<article class="panel ${patch.version === notes.current ? "c-p4" : "c-fw"}"><span class="pill">${patch.version === notes.current ? "Latest update" : "Previous update"}</span><h2 style="margin-top:.8rem">Patch ${e(patch.version)}</h2>${list("Rule revisions", patch.rules.revisions)}${list("Rule additions", patch.rules.additions)}${list("Play and interface", patch.changes)}</article>`;
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
    if (document.getElementById("username")) saveName(name());
    return enterRoom(await api("/api/solo", "POST", {house_rules:true, first:"random", best_of:null, practice:true, username:session.username, avatar:session.avatar}));
  }
  if (target === "host") {
    if (document.getElementById("username")) saveName(name());
    return startSetup(target);
  }
}
document.addEventListener("click", async (event) => {
  // tapping the dimmed area behind a sheet closes it
  if (event.target === sheetRoot) return closeSheet();
  const button = event.target.closest("button, a[data-nav]");
  if (!button || button.disabled) return;
  if (button.matches("a[data-nav]")) event.preventDefault();
  const data = button.dataset;
  try {
    if (data.leaveChoice) return resolveLeavePrompt(data.leaveChoice);
    if (button.classList.contains("slot")) {
      // pointer taps are handled by the board; this is keyboard activation
      if (event.detail === 0) tapSlot(JSON.parse(data.ref), button);
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
    if ("settings" in data) return settingsSheet();
    if ("gameMenu" in data) return gameMenuSheet();
    if ("sheetPlayer" in data) return openRulesSheet(Number(data.sheetPlayer));
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
    if ("queueView" in data) {
      hiddenQueueOffer = null;
      socialSignature = "";
      return renderSocial();
    }
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
    if (
      "statsAll" in data ||
      "statsReset" in data ||
      "statsResetAll" in data
    ) {
      readStatsForm();
      statsSelection.enabled = [];
      statsSelection.disabled = [];
      if (data.statsAll) {
        const keys = catalog.map((rule) => rule.key);
        if (data.statsAll === "on") statsSelection.enabled = keys;
        else statsSelection.disabled = keys;
      }
      if ("statsResetAll" in data) {
        statsSelection.player = "";
        statsSelection.opponent = "";
        statsSelection.patch = "";
      }
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
      if (button.closest("[data-actionbar]")) await barAction(data.action);
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
  if (event.target.id === "stats-form") {
    readStatsForm();
    await statsPage();
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
    if (key === "style" || key === "length") {
      saveName(name());
      setupPage();
    }
    if (key === "gameType") refreshRulesPicker();
    return;
  }
  if (
    target.hasAttribute("data-stats-house") ||
    target.hasAttribute("data-stats-select")
  ) {
    readStatsForm();
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
  if (
    event.key === "Enter" &&
    page === "room" &&
    !["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(event.target.tagName) &&
    state?.game?.legal.end_turn
  ) {
    event.preventDefault();
    move("end_turn");
  }
});
window.addEventListener("resize", () => layoutWheel());
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
(async () => {
  try {
    let avatarInfo;
    [session, catalog, matchOptions, avatarInfo] = await Promise.all([
      api("/api/session"),
      api("/api/rules"),
      api("/api/match-options"),
      api("/api/avatars"),
    ]);
    avatars = avatarInfo.avatars;
    try {
      session.username = localStorage.getItem("golf-name") || session.username;
      const saved = localStorage.getItem("golf-avatar");
      if (avatars.some((avatar) => avatar.id === saved && avatar.selectable))
        session.avatar = saved;
    } catch {}
    pollPresence();
    setInterval(pollPresence, 5000);
    try {
      await route();
    } catch (error) {
      home();
      toast(error.message);
    }
  } catch (error) {
    root.innerHTML = `<div class="empty">${e(error.message)}<p>Refresh to reconnect to your server.</p></div>`;
  }
})();
