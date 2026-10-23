"use strict";
const basePath = new URL(document.baseURI).pathname.replace(/\/$/, "");
const appPath = (path = "/") => `${basePath}${path}`;
const currentPath = () => location.pathname.slice(basePath.length) || "/";
const root = document.getElementById("app");
const connection = document.getElementById("connection");
let catalog = [],
  matchOptions = null,
  session = null,
  state = null,
  selected = [],
  socket = null,
  heartbeat = null,
  retry = null,
  busy = false,
  page = "home",
  tableEpoch = 0,
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
  return `<div class='player-emote' data-emote-player='${player}' role='status' style='animation-delay:-${age}ms'><img src='${appPath(`/static/emotes/${item.id}.png`)}' alt='${e(state.names[player])}: ${emoteNames[item.id]} emote'><span>${e(state.names[player])}</span></div>`;
}
function quickEmotes() {
  return `<div class='emote-buttons' aria-label='Quick emotes'>${Object.entries(
    emoteNames,
  )
    .map(
      ([id, label]) =>
        `<button type='button' class='emote-button' data-emote='${id}' title='${label}' aria-label='Send ${label.toLowerCase()} emote' ${state.status === "closed" ? "disabled" : ""}><img src='${appPath(`/static/emotes/${id}.png`)}' alt=''></button>`,
    )
    .join("")}</div>`;
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
const starter = {
  host: "Host first",
  guest: "Guest first",
  alternate: "Alternate each game",
  random: "Random each game",
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
const matchLength = (match) =>
  match.best_of === null
    ? "Continuous"
    : match.best_of === 1
      ? "Single game"
      : match.series_mode === "points"
        ? `${match.best_of} games, lowest total score`
        : `Best of ${match.best_of}`;
const houseBadge = (match) =>
  match.house_rules ? "<span class='house-badge'>🔒 House rules</span>" : "";
let presenceState = {
    available_lobbies: 0,
    players: [],
    invitations: [],
    invited: [],
  },
  presenceBusy = false,
  socialMode = null,
  socialSignature = "";
const dismissedInvites = new Set();

function lobbyIndicator() {
  const badge = document.getElementById("lobby-count");
  if (!badge) return;
  badge.hidden = !presenceState.available_lobbies;
  badge.textContent = presenceState.available_lobbies;
  badge.setAttribute(
    "aria-label",
    `${presenceState.available_lobbies} available ${presenceState.available_lobbies === 1 ? "lobby" : "lobbies"}`,
  );
}
function closeSocial() {
  document.getElementById("social-dialog").close();
  socialMode = null;
  socialSignature = "";
}
let hiddenQueueOffer = null,
  queueEntering = false;
function renderQueueBanner() {
  const banner = document.getElementById("queue-banner");
  const queue = presenceState.queue;
  banner.hidden = !queue || !["waiting", "offer"].includes(queue.status);
  if (banner.hidden) return;
  banner.innerHTML = `<span>${queue.status === "offer" ? (queue.accepted ? "Classic match accepted · waiting for opponent" : "Classic match found") : "In the 1v1 queue · you can play Golfbot while waiting"}</span><div>${queue.status === "offer" ? `<button class='button secondary' data-queue-view>View match</button>` : ""}<button class='button secondary' data-queue-leave>Leave queue</button></div>`;
}
async function joinQueue() {
  saveName(name());
  presenceState.queue = await api("/api/queue/join", "POST", {
    username: session.username,
  });
  hiddenQueueOffer = null;
  toast("You joined the 1v1 queue. You can play the AI while waiting.");
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
    toast("Classic golf match · 5 games, lowest total score.");
  } finally {
    queueEntering = false;
  }
}
document.addEventListener("click", async (event) => {
  const button = event.target.closest(
    "[data-queue-reply], [data-queue-leave], [data-queue-view], [data-queue-hide]",
  );
  if (!button || button.disabled) return;
  try {
    if (button.hasAttribute("data-queue-hide")) {
      hiddenQueueOffer = presenceState.queue.id;
      return closeSocial();
    }
    if (button.hasAttribute("data-queue-view")) {
      hiddenQueueOffer = null;
      socialSignature = "";
      return renderSocial();
    }
    button.disabled = true;
    if (button.hasAttribute("data-queue-leave")) {
      presenceState.queue = await api("/api/queue/leave", "POST");
    } else {
      presenceState.queue = await api(
        `/api/queue/offers/${presenceState.queue.id}/respond`,
        "POST",
        { accept: button.dataset.queueReply === "accept", username: name() },
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
});
function renderSocial() {
  const dialog = document.getElementById("social-dialog");
  const offer = presenceState.queue;
  if (offer?.status === "offer" && hiddenQueueOffer !== offer.id) {
    socialMode = "queue";
    const signature = JSON.stringify(offer);
    if (signature !== socialSignature) {
      socialSignature = signature;
      dialog.innerHTML = `<h2>Classic golf match</h2><p>Your opponent: <strong>${e(offer.opponent)}</strong></p><div class='waiting-meta'><span>5 games, lowest total score</span>${houseBadge(offer.lobby)}</div><p class='hint'>Both players must accept. Your unfinished solo game will not count in stats.</p><details class='invite-info'><summary>More info</summary><p>Random first player each game. Equal total points draw. This offer expires after 60 seconds.</p>${rulesHtml(offer.lobby.rules, false, "config", true)}</details><div class='button-row invite-actions'><button class='button gold' data-queue-reply='accept' ${offer.accepted ? "disabled" : ""}>${offer.accepted ? "Waiting for opponent…" : "Accept"}</button><button class='button secondary' data-queue-reply='decline'>Decline</button>${offer.accepted ? `<button class='button secondary' data-queue-hide>Keep playing</button>` : ""}</div>`;
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
      ? `<div class='page-heading'><h2>Invite a player</h2><button class='button secondary' data-social-close aria-label='Close player list'>Close</button></div><p class='hint'>Players active in the last 30 seconds who are not at a table.</p><div class='online-players'>${presenceState.players.map((player) => `<div class='online-player'><div><strong>${e(player.display_name)}</strong><small>${player.unique_name ? "@" + e(player.unique_name) : "Guest"}</small></div><button class='button' data-invite-player='${e(player.id)}' ${presenceState.invited.includes(player.id) ? "disabled" : ""}>${presenceState.invited.includes(player.id) ? "Invited" : "Invite"}</button></div>`).join("") || "<p class='empty'>No available players online right now.</p>"}</div>`
      : `<h2>You're invited</h2><p><strong>${e(invitation.host)}</strong> invited you to <strong>${e(invitation.lobby.name)}</strong>.</p><div class='waiting-meta'><span>${matchLength(invitation.lobby)}</span>${houseBadge(invitation.lobby)}</div><details class='invite-info'><summary>More info</summary><p>First player: ${e(starter[invitation.lobby.first])}</p>${rulesHtml(invitation.lobby.rules, false)}</details><div class='button-row invite-actions'><button class='button gold' data-invite-reply='accept' data-invitation='${e(invitation.id)}'>Accept</button><button class='button secondary' data-invite-reply='decline' data-invitation='${e(invitation.id)}'>Decline</button></div>`;
  if (!dialog.open) dialog.showModal();
}
async function pollPresence() {
  if (!session || presenceBusy) return;
  presenceBusy = true;
  try {
    presenceState = await api("/api/presence", "POST", { username: name() });
    lobbyIndicator();
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
document
  .getElementById("social-dialog")
  .addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled) return;
    if (button.matches("[data-queue-reply], [data-queue-hide]")) return;
    try {
      if (button.hasAttribute("data-social-close")) return closeSocial();
      button.disabled = true;
      if (button.dataset.invitePlayer) {
        await api(`/api/lobbies/${state.id}/invite`, "POST", {
          player_id: button.dataset.invitePlayer,
        });
        await pollPresence();
      } else if (button.dataset.inviteReply) {
        const next = await api(
          `/api/invitations/${button.dataset.invitation}/respond`,
          "POST",
          { accept: button.dataset.inviteReply === "accept", username: name() },
        );
        dismissedInvites.add(button.dataset.invitation);
        closeSocial();
        if (button.dataset.inviteReply === "accept") enterRoom(next);
        await pollPresence();
      }
    } catch (error) {
      toast(error.message);
      button.disabled = false;
      await pollPresence();
    }
  });
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
let historyEntries = [],
  historyOffset = null,
  historyRequest = 0;
let lastCardTap = null;
function markTab(active) {
  for (const tab of ["play", "history", "stats", "patches"])
    document
      .getElementById(`${tab}-tab`)
      .setAttribute("aria-current", tab === active ? "page" : "false");
}
let googleScript = null;
let initializedGoogleNonce = null;
function renderAccountControl() {
  const control = document.getElementById("account-control");
  if (!session) return;
  control.innerHTML = `<button class='button secondary' type='button' data-account>${session.account ? e(session.account.unique_name ? "@" + session.account.unique_name : "Choose unique name") : "Sign in with Google"}</button>`;
}
async function renderGoogleSignIn() {
  const container = document.getElementById("google-signin-button");
  if (!container || page !== "account") return;
  if (session.account || !session.google_client_id || session.room_id) return;
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
      session.room_id ||
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
            const displayName = session.username;
            session = await api("/api/auth/google", "POST", {
              credential,
              csrf_token: session.csrf_token,
            });
            session.username = displayName;
            renderAccountControl();
            if (!session.account.unique_name) accountPage();
            else {
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
      size: "medium",
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
  page = "account";
  markTab(null);
  document.title = "Your account · Golf";
  history.replaceState({}, "", appPath("/account"));
  const account = session.account;
  if (!socket) {
    connection.textContent = account ? "Signed in" : "Guest";
    connection.className = "connection";
  }
  root.innerHTML = `<section class='form-wrap'><div class='page-heading'><h1>${account ? "Your account" : "Sign in with Google"}</h1>${back()}</div><div class='panel'>${
    account
      ? account.unique_name
        ? `<h2>@${e(account.unique_name)}</h2><p>Your games are grouped under this unique name in Player stats. Your display name at the table can change each game.</p>`
        : `<h2>Choose your unique name</h2><p>This identifies you in Player stats across all your display names. Pick once; your display name can change whenever you play.</p><form id='account-name-form'><label class='field'><span>Unique name</span><input name='unique_name' aria-label='Unique name' minlength='3' maxlength='24' pattern='[a-zA-Z0-9_]{3,24}' autocomplete='username' required><small>3–24 letters, numbers or underscores. Names are lowercase and unique.</small></label><button type='submit' class='button gold'>Save unique name</button></form>`
      : `<p>Sign in to keep your stats under one unique name across devices. Your display name can change each game.</p>${session.room_id ? "<p class='hint'>Leave your current table before signing in.</p>" : session.google_client_id ? "<div id='google-signin-button' aria-live='polite'>Loading Google sign-in…</div>" : "<p class='hint'>Google sign-in is not available yet. You can keep playing as a guest.</p>"}`
  }${account ? `<div class='button-row'><button class='button secondary' type='button' data-signout>Sign out</button></div>` : ""}<p class='hint'>Guests are grouped by display name. Signing in does not claim earlier guest results.</p></div></section>`;
  renderGoogleSignIn();
}
document
  .getElementById("account-control")
  .addEventListener("click", (event) => {
    if (session && event.target.closest("[data-account]")) accountPage();
  });
async function historyPage(more = false) {
  const request = ++historyRequest;
  page = "history";
  markTab("history");
  document.title = "Match history · Golf";
  history.replaceState({}, "", appPath("/history"));
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
    root.innerHTML = `<section class='history-page'><div class='page-heading'><h1>Match history</h1><button class='button secondary' data-nav='history'>Refresh</button></div><p class='hint'>Everyone’s completed games, newest ending first. Fixed series use total points; Best of series use game wins.</p><p class='hint'>${session.room_id ? `Your table is still open. Use Play to return without leaving.` : `Match history is shared with everyone on this server.`}</p>${
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
          return `<article class='panel match-record'><div class='record-heading'><div><h2>${e(match.lobby_name)}</h2><p class='hint'>Last game ended ${e(new Date(ended * 1000).toLocaleString())} · ${match.solo ? "Vs Golfbot · " : ""}${matchLength(match)} · ${e(status)} · ${e(match.patch || "Earlier patches")}</p></div></div><p class='record-winner'>Overall winner: ${e(winner)}</p><div class='score-table-wrap'><table class='score-table'><thead><tr><th scope='col'>Game</th>${match.names.map((name, p) => `<th scope='col'>${e(name)}${match.viewer === p ? " · You" : ""}</th>`).join("")}<th scope='col'>Winner</th></tr></thead><tbody>${match.rounds.map((game) => `<tr><th scope='row'>${game.round}</th>${game.scores.map((score) => `<td>${score}</td>`).join("")}<td>${game.winner === null ? "Draw" : e(match.names[game.winner])}</td></tr>`).join("")}</tbody><tfoot><tr><th scope='row'>Total points</th>${match.points.map((score) => `<td>${score}</td>`).join("")}<td></td></tr><tr><th scope='row'>Game wins</th>${match.wins.map((wins) => `<td>${wins}</td>`).join("")}<td></td></tr></tfoot></table></div></article>`;
        })
        .join("") ||
      `<div class='empty'>No completed games yet. Finish a game against a player or Golfbot to record its score here.</div>`
    }${historyOffset !== null ? `<button class='button secondary' data-history-more>Load older matches</button>` : ""}</section>`;
  } catch (error) {
    if (page === "history" && request === historyRequest)
      root.innerHTML = `<div class='empty'>${e(error.message)}<p><button class='button secondary' data-nav='history'>Try again</button></p></div>`;
  }
}
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
    return `<p class='hint'>Restart the game server to load rule activation stats.</p>`;
  return `<div class='multiplier-stats'><h3>${e(entry.profile.label)}</h3>${entry.profile.unique_name ? `<p class='hint'>Display names: ${entry.profile.display_names.map(e).join(", ")}</p>` : ""}<p class='hint'>Rule activations · ${stats.known_activation_games} recorded games</p><div class='score-table-wrap'><table class='score-table rule-activation-table'><thead><tr><th>Rule</th><th>Games activated</th><th>Win rate</th></tr></thead><tbody>${stats.rule_activations.map((rule) => `<tr><th>${e(rule.name)}</th><td>${statPercent(rule.rate)} <small>(${rule.games})</small></td><td>${statPercent(rule.win_rate)}</td></tr>`).join("")}</tbody></table></div>${stats.unknown_activation_games ? `<p class='hint'>${stats.unknown_activation_games} games have no activation records and are excluded.</p>` : ""}</div>`;
}

function statsTable(entries, scope, title) {
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
  return `<section class='panel stats-results'><h2>${title}</h2>${entries.every((entry) => entry[scope].rounds === 0) ? `<p class='empty'>No games match this selection.</p>` : ""}<div class='score-table-wrap'><table class='score-table stats-table'><thead><tr><th scope='col'>Statistic</th>${entries.map((entry) => `<th scope='col'>${e(entry.profile.label)}</th>`).join("")}</tr></thead><tbody>${metrics.map(([label, value]) => `<tr><th scope='row'>${label}</th>${entries.map((entry) => `<td>${value(entry[scope])}</td>`).join("")}</tr>`).join("")}</tbody></table></div><details class='rule-activation-details'><summary>View rule activation</summary><div class='multiplier-columns'>${entries.map((entry) => ruleActivationsHtml(entry, scope)).join("")}</div></details>${entries.some((entry) => entry[scope].known_turn_games < entry[scope].rounds) ? `<p class='hint'>Average turns excludes older games without turn records.</p>` : ""}${entries.some((entry) => entry[scope].ambiguous_matches) ? `<p class='hint'>Games where a selected guest name identifies multiple seats are excluded because those guests cannot be distinguished.</p>` : ""}</section>`;
}

async function statsPage(fromUrl = false) {
  if (fromUrl) {
    const query = new URLSearchParams(location.search);
    statsSelection = {
      player: query.get("player") || "",
      opponent: query.get("opponent") || "",
      enabled: query.getAll("enabled"),
      disabled: query.getAll("disabled"),
      house_rules: query.get("house_rules") !== "false",
      patch: query.get("patch") || "",
    };
  }
  const request = ++statsRequest;
  const focused = document.activeElement?.id;
  const rulesOpen = document.getElementById("stats-rules")?.open;
  page = "stats";
  markTab("stats");
  document.title = "Player stats · Golf";
  const query = new URLSearchParams();
  if (!statsSelection.house_rules) query.set("house_rules", "false");
  else {
    statsSelection.enabled = [];
    statsSelection.disabled = [];
  }
  if (statsSelection.patch) query.set("patch", statsSelection.patch);
  if (statsSelection.player) query.set("player", statsSelection.player);
  if (statsSelection.opponent) query.set("opponent", statsSelection.opponent);
  for (const key of statsSelection.enabled) query.append("enabled", key);
  for (const key of statsSelection.disabled) query.append("disabled", key);
  history.replaceState(
    {},
    "",
    appPath("/stats") + (query.toString() ? "?" + query : ""),
  );
  const previous = document.getElementById("stats-content");
  if (previous)
    previous.innerHTML = `<div class='loading'>Updating player stats…</div>`;
  else root.innerHTML = `<div class='loading'>Loading player stats…</div>`;
  try {
    const result = await api("/api/stats?" + query);
    if (page !== "stats" || request !== statsRequest) return;
    if (!socket) {
      connection.textContent = "Saved results";
      connection.className = "connection";
    }
    statsSelection.player = result.player?.profile.id || "";
    statsSelection.opponent = result.comparison?.profile.id || "";
    if (!result.players.length) {
      root.innerHTML = `<section class='stats-page'><h1>Player stats</h1><div class='empty'>No saved games yet. Finish a game against a player or Golfbot to see player statistics here.</div></section>`;
      return;
    }
    const options = (selected, exclude = "") =>
      result.players
        .filter((player) => player.id !== exclude)
        .map(
          (player) =>
            `<option value='${e(player.id)}' ${player.id === selected ? "selected" : ""}>${e(player.label)}</option>`,
        )
        .join("");
    const active =
      statsSelection.enabled.length + statsSelection.disabled.length;
    root.innerHTML = `<section class='stats-page'><div class='page-heading'><h1>Player stats</h1><button type='button' class='button secondary' data-nav='stats'>Refresh</button></div><p class='hint'>Choose a unique name, guest display name, or Golfbot to compare. Signed-in players use @unique names across display-name changes; guests are grouped by display name. ${session.room_id ? "Your table is still open; use Play to return." : ""}</p><form id='stats-form' class='panel stats-filters'><div class='stats-selectors'><label class='field'><span>Player</span><select aria-label='Player' id='stats-player' name='player' data-stats-select>${options(statsSelection.player)}</select></label><label class='field'><span>Compare with</span><select aria-label='Compare with' id='stats-opponent' name='opponent' data-stats-select><option value=''>Overall only</option>${options(statsSelection.opponent, statsSelection.player)}</select></label><label class='field'><span>Patch</span><select id='stats-patch' name='patch' aria-label='Patch' data-stats-select><option value=''>All time</option>${result.patches.map((patch) => `<option value='${e(patch)}' ${statsSelection.patch === patch ? "selected" : ""}>${e(patch === "legacy" ? "Earlier patches" : patch)}</option>`).join("")}</select></label></div><label class='house-toggle stats-house'><input type='checkbox' aria-label='House rules' name='house_rules' data-stats-house ${statsSelection.house_rules ? "checked" : ""}><span>House rules ${statsSelection.house_rules ? "🔒" : ""}<small>Official stats · saved house-rule games only</small></span></label><details id='stats-rules' ${(rulesOpen ?? active > 0) ? "open" : ""}><summary>Rule filters · ${statsSelection.house_rules ? "🔒 House rules" : active ? active + " selected" : "overall / any rules"}</summary><fieldset ${statsSelection.house_rules ? "disabled" : ""}><p class='hint'>Any allows either setting. On requires the rule; Off excludes it. Set every rule to On or Off to match an exact combination.</p><div class='button-row'><button type='button' class='button secondary' data-stats-all='on'>All on</button><button type='button' class='button secondary' data-stats-all='off'>All off</button></div><div class='stats-rule-grid'>${catalog.map((rule) => `<label class='field'><span>${e(rule.name)}</span><select name='filter-${e(rule.key)}' aria-label='${e(rule.name)} filter'><option value='any'>Any</option><option value='on' ${(statsSelection.house_rules ? matchOptions.house_rules[rule.key] : statsSelection.enabled.includes(rule.key)) ? "selected" : ""}>On</option><option value='off' ${(statsSelection.house_rules ? !matchOptions.house_rules[rule.key] : statsSelection.disabled.includes(rule.key)) ? "selected" : ""}>Off</option></select></label>`).join("")}</div></fieldset></details><div class='button-row'><button class='button gold' type='submit'>Apply filters</button><button class='button secondary' type='button' data-stats-reset ${statsSelection.house_rules ? "disabled" : ""}>Reset rules</button></div></form><div id='stats-content'>${statsTable([result.player, result.comparison].filter(Boolean), "overall", statsSelection.house_rules ? "Official stats · overall" : "Overall · against all opponents")}${result.comparison ? statsTable([result.player, result.comparison], "head_to_head", "Head to head · against each other") : `<p class='hint'>Choose a comparison player above for head-to-head results.</p>`}<details class='stats-definitions'><summary>How stats are counted</summary><p class='hint'>A game is one deal. A series is a full match. House rules includes games started with a saved, locked preset; earlier unmarked games remain available with House rules off. Turns counts completed turns by all players. In many-player games, an overall game win means the unique lowest score at the table; tied lowest scores are draws. Average opponent points uses the mean of all other players. Head-to-head game results compare just the two selected players, and many-player head-to-head series compare their total points. Fixed series allow drawn totals; patch and rule filters require every game of a completed series to match. Rules in play counts enabled optional rules, whether activated or not. Continuous series are decided after everyone leaves: game wins first, then lower total points. An exact tie has no series winner. Game win rate includes draws in the denominator; series win rate uses completed matches only. Matching games from unfinished series still count toward game stats. With rule filters, a completed series counts only when every game matches. Negative point advantage means fewer points than the opponent. Activation percentage counts games where that player triggered the rule, divided by all games with activation records. Win rate counts wins among those activated games, including draws in the denominator. Each rule counts once per game, even if it triggers multiple times. Rules affecting the opponent are credited to the player who triggered them. Older games without activation records are excluded from this tracker.</p></details></div></section>`;
    if (focused) document.getElementById(focused)?.focus();
  } catch (error) {
    if (page === "stats" && request === statsRequest)
      root.innerHTML = `<section class='stats-page'><h1>Player stats</h1><div class='empty'>${e(error.message)}<p><button class='button secondary' data-stats-reset-all>Clear selection and retry</button></p></div></section>`;
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
  return `${editable ? `<label class='rule-select-all'><input type='checkbox' data-rules-all data-rule-type='${type}' ${catalog.every((rule) => values[rule.key]) ? "checked" : ""}><span>Select all rules</span></label>` : ""}<div class='rules-grid'>${rules.map((r) => `<div class='rule ${values[r.key] ? "active" : ""}'><label><input type='checkbox' name='rule-${e(r.key)}' data-rule='${e(r.key)}' data-rule-type='${type}' ${values[r.key] ? "checked" : ""} ${editable ? "" : "disabled"}><span>${e(r.name)}</span></label>${help(r)}</div>`).join("") || `<p class='hint'>Base scoring only. No optional rules.</p>`}</div>`;
}
function back(label = "Back to menu") {
  return `<button class='button secondary' data-nav='home'>${label}</button>`;
}
function home() {
  renderAccountControl();
  clearEmotes();
  emoteTable = "";
  page = "home";
  markTab("play");
  document.title = "Golf · Your table";
  state = null;
  closeSocket();
  history.replaceState({}, "", appPath());
  root.innerHTML = `<section class='hero'><div class='eyebrow'>The card game, at your table</div><h1>Pick your table.</h1><p>Six cards, a little memory, and a good time to finish.<br>Play together or take on the bot.</p></section><div class='menu'><button class='menu-card' data-nav='join'><span class='symbol'>♧</span><span class='arrow'>↗</span><strong>Join lobby <span id='lobby-count' class='lobby-count' hidden></span></strong><p>Find a table and meet your opponent.</p></button><button class='menu-card' data-nav='host'><span class='symbol'>♔</span><span class='arrow'>↗</span><strong>Host lobby</strong><p>Your name. Your rules. Your match.</p></button><button class='menu-card' data-nav='solo'><span class='symbol'>♠</span><span class='arrow'>↗</span><strong>Play solo</strong><p>The same Golf game, against Golfbot.</p></button><button class='menu-card' data-queue-join><span class='symbol'>⚑</span><span class='arrow'>↗</span><strong>Join 1v1 queue</strong><p>Classic Golf · House rules · 5 games, lowest total score.</p></button></div><div class='profile'><label class='field'><span>Your display name</span><input id='username' maxlength='32' value='${e(session.username)}' autocomplete='nickname'></label>${session.room_id ? `<button class='button secondary resume' data-nav='resume'>Resume your table</button>` : ""}</div>`;
  lobbyIndicator();
  renderQueueBanner();
  pollPresence();
  connection.textContent = "Ready to play";
  connection.className = "connection";
}
async function abandonExisting() {
  const roomId = session.room_id,
    epoch = tableEpoch;
  if (roomId) {
    await api(`/api/lobbies/${roomId}/leave`, "POST");
    if (epoch === tableEpoch && session.room_id === roomId)
      session.room_id = null;
  }
  if (epoch === tableEpoch) closeSocket();
}
function hostForm(solo = false) {
  saveName(name());
  page = solo ? "solo" : "host";
  root.innerHTML = `<div class='form-wrap'><div class='page-heading'><h1>${solo ? "Play against Golfbot" : "Host a lobby"}</h1>${back()}</div><form id='${solo ? "solo-form" : "host-form"}' class='panel'><div class='form-grid'><div><label class='field'><span>Your display name</span><input id='username' name='username' maxlength='32' required value='${e(session.username)}' autocomplete='nickname'></label>${solo ? "" : `<label class='field'><span>Lobby name</span><input name='name' maxlength='48' required value='Friendly Golf'></label><label class='field'><span>Game type</span><select name='game_type' aria-label='Game type' data-game-type><option value='1v1'>1v1</option><option value='many'>Many players</option></select></label>`}<label class='field'><span>Match length</span><select name='length' aria-label='Match length'><option value='wins:1' ${solo ? "selected" : ""}>Single game</option><optgroup label='Best of · game wins'>${[3, 5, 9].map((n) => `<option value='wins:${n}' ${!solo && n === 3 ? "selected" : ""}>Best of ${n} · first to ${Math.floor(n / 2) + 1} wins</option>`).join("")}</optgroup><optgroup label='Fixed series · total points'>${[3, 5, 9].map((n) => `<option value='points:${n}'>${n} games, lowest total score</option>`).join("")}</optgroup><option value='wins:continuous'>Continuous · play until you leave</option></select></label><label class='house-toggle'><input type='checkbox' aria-label='House rules' name='house_rules' data-house-toggle checked><span>House rules 🔒<small>Locked preset · random first player</small></span></label><label class='field'><span>Who goes first? <span data-first-lock>🔒</span></span><select name='first' aria-label='Who goes first?'>${Object.entries(
    solo ? { ...starter, host: "You first", guest: "Golfbot first" } : starter,
  )
    .map(
      ([key, label]) =>
        `<option value='${key}' ${key === "random" ? "selected" : ""}>${label}</option>`,
    )
    .join(
      "",
    )}</select></label><p class='hint' data-mode-info>1v1 starts when a guest joins. Fixed series play every game; equal total points draw. Continuous ends when someone leaves.</p></div><div><details class='creation-rules'><summary>Rules in play</summary><p class='hint'>Turn off House rules to customize. Hover over ? for details.</p><div id='creation-rules'></div></details></div></div><div class='button-row'><button class='button gold' type='submit'>${solo ? "Start solo match" : "Create lobby"}</button></div></form></div>`;
  updateHouseForm();
}
function updateHouseForm() {
  const locked = root.querySelector("[data-house-toggle]").checked;
  const first = root.querySelector('[name="first"]');
  root.querySelector(
    "[data-house-toggle]",
  ).nextElementSibling.firstChild.textContent = locked
    ? "House rules 🔒"
    : "House rules";
  const many = root.querySelector('[name="game_type"]')?.value === "many";
  if (locked || many) first.value = "random";
  first.disabled = locked || many;
  root.querySelector("[data-first-lock]").hidden = !(locked || many);
  root.querySelector("[data-mode-info]").textContent = many
    ? "3–30 players. The host starts the game. Turn order is randomized each game; opponent effects target everyone else."
    : "Fixed series play every game; lowest total wins, tied totals draw. Best of counts game wins. Continuous ends when someone leaves.";
  const container = document.getElementById("creation-rules");
  const values = locked
    ? matchOptions.house_rules
    : Object.fromEntries(
        catalog.map((rule) => [
          rule.key,
          container.querySelector(`[name="rule-${rule.key}"]`)?.checked ??
            matchOptions.house_rules[rule.key],
        ]),
      );
  container.innerHTML = rulesHtml(values, !locked);
  if (locked)
    container
      .querySelectorAll(".rule label span")
      .forEach((label) =>
        label.insertAdjacentHTML(
          "beforeend",
          " <span class='rule-lock' aria-label='Locked by house rules'>🔒</span>",
        ),
      );
}
async function joinList() {
  page = "join";
  saveName(name());
  const lobbies = await api("/api/lobbies");
  root.innerHTML = `<div class='form-wrap'><div class='page-heading'><h1>Join a lobby</h1><div class='button-row' style='margin:0'><button class='button secondary' data-nav='join'>Refresh</button>${back()}</div></div><label class='field'><span>Your display name</span><input id='username' maxlength='32' value='${e(session.username)}' autocomplete='nickname'></label><div class='lobby-list'>${lobbies.map((l) => `<div class='lobby-item'><div><strong>${e(l.name)}</strong><p>${e(l.names[0])} · ${l.players}/${l.capacity} players · ${matchLength(l)} · ${e(l.status.replace("_", " "))}</p></div><button class='button ${l.players === 1 && l.status === "waiting" ? "" : "secondary"}' data-lobby='${e(l.id)}'>View lobby</button></div>`).join("") || `<div class='empty'>No lobbies yet. Host a table and invite a friend.</div>`}</div></div>`;
}
async function publicLobby(id) {
  saveName(name());
  const info = await api(`/api/lobbies/${id}`);
  if (session.room_id === id) {
    await resume(id);
    return;
  }
  page = "public";
  history.replaceState({}, "", appPath(`/lobby/${id}`));
  root.innerHTML = `<div class='waiting'><div class='page-heading'><h1>${e(info.name)}</h1>${back()}</div><div class='panel'><div class='waiting-meta'><span>Hosted by ${e(info.names[0])}</span><span>${matchLength(info)}</span>${houseBadge(info)}<span>${e(starter[info.first])}</span></div><h3>Rules in play</h3>${rulesHtml(info.rules, false, "config", true)}<div class='button-row'><label class='field' style='margin:0;flex:1'><span>Your display name</span><input id='username' maxlength='32' value='${e(session.username)}' autocomplete='nickname'></label><button class='button gold' data-join='${e(id)}' ${info.players >= info.capacity || info.status !== "waiting" ? "disabled" : ""}>Join this lobby</button></div>${info.players >= info.capacity || info.status !== "waiting" ? `<p class='hint'>This table is full or already playing.</p>` : ""}</div></div>`;
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
    `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${appPath(`/ws/${id}`)}`,
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
  if (lastCardTap && lastCardTap.version !== next.version) lastCardTap = null;
  session.room_id = next.id;
  renderAccountControl();
  if (["history", "stats", "account", "patches"].includes(page)) return;
  page = "room";
  markTab("play");
  if (changed) selected = [];
  renderRoom();
}
function enterRoom(next) {
  page = "room";
  history.pushState({}, "", appPath(`/lobby/${next.id}`));
  selected = [];
  accept(next);
  connectRoom(next.id);
}
async function resume(id = session.room_id) {
  if (!id) return home();
  const epoch = tableEpoch;
  const next = await api(`/api/lobbies/${id}/state`);
  if (epoch === tableEpoch) enterRoom(next);
}
function shareHtml() {
  const url = `${location.origin}${appPath(`/lobby/${state.id}`)}`;
  return `<div class='share'><input readonly aria-label='Lobby invite link' value='${e(url)}'><button class='button secondary' data-copy='${e(url)}'>Copy link</button></div>`;
}
function waitingRoom() {
  const many = state.game_type === "many";
  root.innerHTML = `<div class='waiting'><div class='page-heading'><h1>${e(state.name)}</h1><button class='button secondary' data-leave>Leave lobby</button></div><div class='panel'><div class='eyebrow'>${many ? "Gather your table" : "Invite a friend"}</div>${shareHtml()}${state.viewer === 0 ? `<div class='button-row'><button class='button gold' data-invite-open>Invite player</button>${many ? `<button class='button gold' data-action='start' ${state.players < 3 ? "disabled" : ""}>Start game</button>` : ""}</div>` : ""}<div class='waiting-meta'><span>${matchLength(state)}</span>${houseBadge(state)}<span>${state.players}/${state.capacity} players</span><span>${e(starter[state.first])}</span></div><div class='players-row'>${state.names.map((n, i) => `<div class='seat'><span class='pill'>${i === 0 ? "Host" : "Player " + (i + 1)}</span><strong>${e(n)}</strong><span class='hint'>${state.connected[i] ? "Connected" : !many && i === 1 ? "Seat open" : "Offline"}${i === state.viewer ? " · You" : ""}</span></div>`).join("")}</div><details class='creation-rules'><summary>Rules in play</summary>${rulesHtml(state.rules, false, "config", true)}</details><p class='hint'>${many ? "The host starts when at least three players have joined." : "The game starts automatically when a guest joins."}</p></div></div>`;
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
  return `<section class='hand ${own ? "your-hand" : "opponent-hand"}'><div class='hand-heading'><span class='hand-name' title='${e(state.names[player])}'>${e(state.names[player])}${own ? " · You" : ""}</span><small class='hand-score'>${g.phase === "over" ? `Score: ${g.scores[player]}` : `Visible: ${g.scores[player]}, Active: ${g.effect_totals[player]}`}${!state.connected[player] && !state.solo ? " · offline" : ""}</small></div><div class='card-grid'>${g.players[
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
let viewedOpponent = null,
  viewedTurn = "";
function opponentSeat() {
  const g = state.game,
    order = g.turn_order;
  const turn = `${state.id}:${state.round}:${g.turns}:${g.current}`;
  if (
    turn !== viewedTurn ||
    viewedOpponent === state.viewer ||
    !order.includes(viewedOpponent)
  ) {
    viewedTurn = turn;
    viewedOpponent =
      g.current === state.viewer
        ? order[(order.indexOf(g.current) + 1) % order.length]
        : g.current;
  }
  return viewedOpponent;
}
function cycleOpponent(direction) {
  if (!state?.game || state.names.length < 3) return;
  const others = state.game.turn_order.filter((p) => p !== state.viewer);
  const current = opponentSeat();
  viewedOpponent =
    others[
      (others.indexOf(current) + direction + others.length) % others.length
    ];
  renderRoom();
}
function renderRoom() {
  if (!state) return;
  document.title = `${state.name} · Golf`;
  if (!state.game) return waitingRoom();
  const g = state.game,
    viewer = state.viewer,
    opponent = opponentSeat();
  const roundResult = state.history.at(-1),
    roundOver = ["round_over", "finished"].includes(state.status);
  const yourDecision =
    state.status === "playing" &&
    (g.phase === "setup"
      ? g.legal.flip.length > 0
      : g.decision_player === viewer);
  const finalMessage =
    state.status === "finished"
      ? state.champion === null
        ? "Series drawn."
        : `${state.names[state.champion]} wins the series.`
      : state.message;
  root.innerHTML = `<div class='board-heading'><div><h2>${e(state.name)}</h2><p class='hint'>Game ${state.round} · ${matchLength(state)} · ${g.final_turn ? "Final turns" : g.phase === "setup" ? "Opening reveal" : e(state.names[g.current]) + "’s turn"}</p></div><div class='match-score'>${state.names.map((name, p) => `<span>${e(name)}: ${state.series_mode === "points" ? state.points[p] + " pts" : state.wins[p] + " wins"}</span>`).join("")}</div><div class='button-row' style='margin:0'>${!state.solo ? `<button class='button secondary' data-copy='${e(location.origin + appPath("/lobby/" + state.id))}'>Invite link</button>` : ""}<button class='button secondary' data-leave>Menu</button></div></div>${state.status === "closed" ? `<div class='closed-banner'>${e(state.message)}</div>` : ""}<div class='table-layout'><div class='play-area ${yourDecision ? "your-decision" : ""}'><div class='opponent-view' aria-label='Opponent hands'>${state.names.length > 2 ? `<div class='opponent-nav'><button class='button secondary' data-cycle='-1' aria-label='Previous opponent'>‹</button><span>${e(state.names[opponent])} · ${g.current === opponent ? "playing now" : g.current === viewer && g.turn_order[(g.turn_order.indexOf(viewer) + 1) % g.turn_order.length] === opponent ? "up next" : "viewing"} · swipe to browse</span><button class='button secondary' data-cycle='1' aria-label='Next opponent'>›</button></div>` : ""}${handHtml(opponent)}</div><aside class='panel table-side' aria-label='The table'><div class='piles'><div><div class='pile-label'>Go-fish pile${g.held ? " · drawn" : ""}</div><div class='draw-stack ${g.held ? "has-draw" : ""}'>${g.held ? `<div class='card back stack-under' aria-hidden='true'><span class='monogram'>G</span></div>${cardHtml(g.held, true, ["held", null], "Your drawn " + g.held.label + suit[g.held.suit])}` : cardHtml(null, false, ["draw", null], "Select go-fish pile", g.legal.bonus && g.draw_count > 0)}</div><div class='pile-count'>${g.draw_count} cards below</div></div><div><div class='pile-label'>Discard</div>${cardHtml(g.discard, true, ["discard", null], "Top discard " + g.discard.label + suit[g.discard.suit], g.legal.bonus)}<div class='pile-count'>Top card</div></div></div></aside>${handHtml(viewer)}${turnControls()}${roundOver ? `<section class='round-summary'><strong>${e(finalMessage)}</strong><p class='hint'>${state.names.map((name, p) => `${e(name)}: ${roundResult.scores[p]}`).join(" · ")}</p><div class='button-row'>${state.status === "round_over" ? `<button class='button gold' data-action='next_round' ${state.ready[viewer] ? "disabled" : ""}>${state.ready[viewer] ? "Waiting for other players…" : "Ready for next game"}</button>` : viewer === 0 ? `<button class='button gold' data-action='rematch'>Play again</button>` : '<span class="hint">The host can start a rematch.</span>'}</div></section>` : ""}</div><aside class='sidebar'><section class='panel'><details class='creation-rules'><summary>Rules in play ${houseBadge(state)}</summary>${g.legal.set_rules ? '<p class="hint">Choose before your second opening flip.</p>' : ""}${rulesHtml(state.rules, g.legal.set_rules, "live", !g.legal.set_rules)}</details></section><section class='panel'><h3>Active effects</h3><div class='effects'>${[viewer, ...g.turn_order.filter((p) => p !== viewer)].map((p) => `<div class='effect-group'><strong>${e(state.names[p])}: ${g.phase === "over" ? "final" : "visible with effects"} ${g.effect_totals[p]}</strong>${(g.effects[p].length ? g.effects[p] : ["None"]).map((effect) => `<div>${e(effect)}</div>`).join("")}</div>`).join("")}</div><p class='hint'>Hidden cards are excluded before scoring.</p></section>${state.history.length ? `<section class='panel'><h3>Match history</h3><div class='history'>${state.history.map((game) => `<div>Game ${game.round}: ${game.scores.join(" · ")} · ${game.winner === null ? "Draw" : e(state.names[game.winner])}</div>`).join("")}</div></section>` : ""}${state.names.length > 2 ? `<section class='panel'><h3>Turn order · ${g.deck_count} decks</h3><ol class='turn-order'>${g.turn_order.map((p) => `<li class='${p === g.current ? "current-name" : ""}'>${e(state.names[p])}${p === g.current ? " · current" : ""}</li>`).join("")}</ol></section>` : ""}</aside></div><div class='table-emotes' aria-label='Player reactions'>${state.names.map((_, p) => playerEmote(p)).join("")}</div>${modalHtml()}`;
  renderQueueBanner();
}
async function move(action, extra = {}) {
  if (busy || !state) return;
  const roomId = state.id;
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
    if (session.room_id !== roomId) return;
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
    if (state && page === "room") renderRoom();
  }
}
root.addEventListener("click", async (event) => {
  const button = event.target.closest("button");
  if (!button || button.disabled) return;
  if (!button.dataset.ref) lastCardTap = null;
  try {
    if (button.hasAttribute("data-queue-join")) return await joinQueue();
    if (button.dataset.cycle)
      return cycleOpponent(Number(button.dataset.cycle));
    if (button.hasAttribute("data-invite-open")) {
      socialMode = "players";
      socialSignature = "";
      await pollPresence();
      renderSocial();
      return;
    }
    if (button.hasAttribute("data-signout")) {
      const displayName = session.username;
      session = await api("/api/auth/logout", "POST", {
        csrf_token: session.csrf_token,
      });
      session.username = displayName;
      renderAccountControl();
      home();
      return;
    }
    if (button.dataset.nav) {
      if (button.dataset.nav === "home") {
        home();
      } else if (button.dataset.nav === "history") await historyPage();
      else if (button.dataset.nav === "stats") await statsPage();
      else if (button.dataset.nav === "patches") await patchesPage();
      else if (button.dataset.nav === "host") hostForm();
      else if (button.dataset.nav === "join") await joinList();
      else if (button.dataset.nav === "resume") await resume();
      else if (button.dataset.nav === "solo") hostForm(true);
      return;
    }
    if (
      button.hasAttribute("data-stats-all") ||
      button.hasAttribute("data-stats-reset") ||
      button.hasAttribute("data-stats-reset-all")
    ) {
      readStatsForm();
      statsSelection.enabled = [];
      statsSelection.disabled = [];
      if (button.hasAttribute("data-stats-all")) {
        const keys = catalog.map((rule) => rule.key);
        if (button.dataset.statsAll === "on") statsSelection.enabled = keys;
        else statsSelection.disabled = keys;
      }
      if (button.hasAttribute("data-stats-reset-all")) {
        statsSelection.player = "";
        statsSelection.opponent = "";
        statsSelection.patch = "";
      }
      await statsPage();
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
      const epoch = tableEpoch;
      saveName(name());
      await abandonExisting();
      const next = await api(
        `/api/lobbies/${button.dataset.join}/join`,
        "POST",
        {
          username: session.username,
        },
      );
      if (epoch === tableEpoch) enterRoom(next);
      return;
    }
    if (button.hasAttribute("data-leave")) {
      const epoch = tableEpoch;
      await abandonExisting();
      if (epoch !== tableEpoch) return;
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
        for (const opponent of Object.keys(activeEmotes)) {
          if (Number(opponent) === state.viewer) continue;
          clearTimeout(emoteTimers[opponent]);
          delete activeEmotes[opponent];
        }
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
      const now = performance.now();
      const flipEligible =
        (ref[0] === "draw" && state.game.legal.draw) ||
        (ref[0] === state.viewer && state.game.legal.flip.includes(ref[1]));
      const elapsed = lastCardTap ? now - lastCardTap.time : Infinity;
      if (
        !busy &&
        event.detail > 0 &&
        flipEligible &&
        lastCardTap?.room === state.id &&
        lastCardTap.version === state.version &&
        same(lastCardTap.ref, ref) &&
        elapsed <= 400
      ) {
        lastCardTap = null;
        selected = [ref];
        await move("flip");
        return;
      }
      lastCardTap =
        event.detail > 0 && flipEligible
          ? { ref, time: now, version: state.version, room: state.id }
          : null;
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
  if (event.target.id === "account-name-form") {
    event.preventDefault();
    try {
      const displayName = session.username;
      session = await api("/api/account/name", "POST", {
        unique_name: new FormData(event.target).get("unique_name"),
        csrf_token: session.csrf_token,
      });
      session.username = displayName;
      renderAccountControl();
      accountPage();
    } catch (error) {
      toast(error.message);
    }
    return;
  }
  if (event.target.id === "stats-form") {
    event.preventDefault();
    readStatsForm();
    await statsPage();
    return;
  }
  if (!["host-form", "solo-form"].includes(event.target.id)) return;
  event.preventDefault();
  const form = event.target;
  const solo = form.id === "solo-form";
  const epoch = tableEpoch;
  const data = new FormData(form);
  const rules = {};
  for (const rule of catalog)
    rules[rule.key] = data.has("house_rules")
      ? matchOptions.house_rules[rule.key]
      : data.has("rule-" + rule.key);
  try {
    saveName(String(data.get("username")).trim());
    await abandonExisting();
    const requested = {
      username: session.username,
      ...(solo ? {} : { name: data.get("name") }),
      best_of:
        data.get("length").split(":")[1] === "continuous"
          ? null
          : Number(data.get("length").split(":")[1]),
      series_mode: data.get("length").split(":")[0],
      game_type: data.get("game_type") || "1v1",
      house_rules: data.has("house_rules"),
      first: data.has("house_rules") ? "random" : data.get("first"),
      rules,
    };
    const next = await api(
      solo ? "/api/solo" : "/api/lobbies",
      "POST",
      requested,
    );
    if (epoch !== tableEpoch) return;
    if (
      solo &&
      (next.best_of !== requested.best_of || next.first !== requested.first)
    ) {
      await api(`/api/lobbies/${next.id}/leave`, "POST");
      throw new Error(
        "The server is running an older version. Restart Golf and try again to use your selected match settings.",
      );
    }
    enterRoom(next);
  } catch (error) {
    toast(error.message);
  }
});
root.addEventListener("change", async (event) => {
  if (
    event.target.hasAttribute("data-house-toggle") ||
    event.target.hasAttribute("data-game-type")
  ) {
    updateHouseForm();
    return;
  }
  if (event.target.hasAttribute("data-stats-house")) {
    readStatsForm();
    await statsPage();
    return;
  }
  if (event.target.hasAttribute("data-stats-select")) {
    readStatsForm();
    await statsPage();
    return;
  }
  if (event.target.id === "username") {
    saveName(event.target.value.trim() || "Player");
    pollPresence();
  }
  if (event.target.hasAttribute("data-rules-all")) {
    const enabled = event.target.checked;
    if (event.target.dataset.ruleType === "live") {
      if (busy) return renderRoom();
      await move("set_rules", {
        rules: Object.fromEntries(catalog.map((rule) => [rule.key, enabled])),
      });
    } else {
      root.querySelectorAll("input[data-rule]").forEach((input) => {
        input.checked = enabled;
        input.closest(".rule").classList.toggle("active", enabled);
      });
    }
    return;
  }
  if (event.target.dataset.ruleType === "live")
    await move("set_rule", {
      rule: event.target.dataset.rule,
      enabled: event.target.checked,
    });
  else if (event.target.dataset.rule) {
    const master = root.querySelector("[data-rules-all]");
    if (master)
      master.checked = [...root.querySelectorAll("input[data-rule]")].every(
        (input) => input.checked,
      );
  }
});
document.addEventListener("keydown", (event) => {
  if (
    event.key === "Enter" &&
    !["history", "stats", "account", "patches"].includes(page) &&
    !["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName) &&
    state?.game?.legal.end_turn
  ) {
    event.preventDefault();
    move("end_turn");
  }
});
window.addEventListener("popstate", () => {
  if (currentPath() === "/patch-notes") {
    patchesPage();
    return;
  }
  if (currentPath() === "/account") {
    accountPage();
    return;
  }
  if (currentPath() === "/stats") {
    statsPage(true);
    return;
  }
  if (currentPath() === "/history") {
    historyPage();
    return;
  }
  const id = currentPath().match(/^\/lobby\/([^/]+)$/)?.[1];
  if (id) publicLobby(id).catch((error) => toast(error.message));
  else home();
});
(async () => {
  try {
    [session, catalog, matchOptions] = await Promise.all([
      api("/api/session"),
      api("/api/rules"),
      api("/api/match-options"),
    ]);
    try {
      session.username = localStorage.getItem("golf-name") || session.username;
    } catch {}
    renderAccountControl();
    pollPresence();
    setInterval(pollPresence, 5000);
    const id = currentPath().match(/^\/lobby\/([^/]+)$/)?.[1];
    if (currentPath() === "/patch-notes") await patchesPage();
    else if (currentPath() === "/account") accountPage();
    else if (currentPath() === "/stats") await statsPage(true);
    else if (currentPath() === "/history") await historyPage();
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
document.getElementById("stats-tab").addEventListener("click", () => {
  if (session) statsPage();
});
document.getElementById("play-tab").addEventListener("click", () => {
  if (session) {
    markTab("play");
    if (session.room_id) resume().catch((error) => toast(error.message));
    else home();
  }
});

document.getElementById("patches-tab").addEventListener("click", () => {
  if (session) patchesPage();
});
async function patchesPage() {
  page = "patches";
  markTab("patches");
  document.title = "Patch notes · Golf";
  history.replaceState({}, "", appPath("/patch-notes"));
  root.innerHTML = "<div class='loading'>Loading patch notes…</div>";
  try {
    const notes = await api("/api/patch-notes");
    if (page !== "patches") return;
    root.innerHTML = `<section class='patch-page'><div class='page-heading'><h1>Patch notes</h1>${back()}</div>${notes.patches.map((patch) => `<article class='panel patch-note'><div class='eyebrow'>${patch.version === notes.current ? "Latest update" : "Previous update"}</div><h2>Patch ${e(patch.version)}</h2><h3>Rules</h3>${["revisions", "additions"].map((section) => `<h4>${section === "revisions" ? "Revisions" : "Additions"}</h4><ul>${patch.rules[section].map((note) => `<li>${e(note)}</li>`).join("")}</ul>`).join("")}<h3>Play and interface</h3><ul>${patch.changes.map((note) => `<li>${e(note)}</li>`).join("")}</ul></article>`).join("")}</section>`;
  } catch (error) {
    if (page === "patches")
      root.innerHTML = `<p class='empty'>${e(error.message)}</p>`;
  }
}
let swipeStart = null;
root.addEventListener("pointerdown", (event) => {
  if (event.target.closest(".opponent-view") && event.pointerType !== "mouse")
    swipeStart = { x: event.clientX, y: event.clientY };
});
root.addEventListener("pointerup", (event) => {
  if (!swipeStart) return;
  const dx = event.clientX - swipeStart.x,
    dy = event.clientY - swipeStart.y;
  swipeStart = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) {
    lastCardTap = null;
    cycleOpponent(dx < 0 ? 1 : -1);
  }
});
root.addEventListener("pointercancel", () => {
  swipeStart = null;
});
