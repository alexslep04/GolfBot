"use strict";
/* ---------- tournaments ----------
   A tournament has one page of its own (/tournament/<id>): the lobby while
   players gather, then the live dashboard with the bracket, the standings and
   every match in play. Each match-up is an ordinary 1v1 table, so playing and
   watching one works exactly as it does anywhere else. The page asks the server
   for the tournament every couple of seconds while it is open.
   (Loaded before app.js, whose helpers these functions use when they run.) */
const TOURNAMENT_FORMATS = {
  single: ["Single elimination", "Lose once and you're eliminated."],
  double: ["Double elimination", "Lose twice and you're eliminated."],
  round_robin: ["Round robin", "Everyone plays everyone once."],
};
const TOURNAMENT_POLL = 2000;
let tournament = null; // the tournament on screen, as the server last described it
let tournamentTimer = null;
let tournamentDrawn = ""; // what is on screen, so an unchanged poll redraws nothing
let tournamentArmed = ""; // a button that asks "Sure?" before it acts, once tapped
let tournamentLinked = null; // the tournament this page was opened at by its address (an invite link)
let tournamentEntered = null; // the match table this player was last taken to
let tournamentEntering = false;
let tournamentBack = "spectate"; // where the dashboard's Back goes: the list it was opened from

/** Host a Tournament's fields: the format first (Match Style sits right under it), then the rest. */
function tournamentFormatField() {
  const [, formatHint] = TOURNAMENT_FORMATS[draft.format] || TOURNAMENT_FORMATS.single;
  return `<div class="stack">${selectField("Format", `data-draft="format" aria-label="Tournament format"`, Object.entries(TOURNAMENT_FORMATS).map(([key, [label]]) => [key, label, draft.format === key]), "trophy.fill")}<p class="hint">${e(formatHint)}</p></div>`;
}
function tournamentSetupFields() {
  const robin = draft.format === "round_robin";
  const fillHint =
    draft.fill === "ai"
      ? robin
        ? "With an odd number of players, a CPU opponent joins so nobody sits out."
        : "Empty places in the bracket go to CPU opponents, who can advance and win."
      : robin
        ? "With an odd number of players, one player sits out each round."
        : "Empty places in the bracket are byes: whoever meets one goes straight through.";
  return `<div class="row">${selectField("Seeding", `data-draft="seeding" aria-label="Seeding"`, [["random", "Random", draft.seeding === "random"], ["mmr", "By MMR", draft.seeding === "mmr"]], null, "grow")}${selectField("Empty Places", `data-draft="fill" aria-label="Empty places"`, [["byes", "Byes", draft.fill === "byes"], ["ai", "CPU opponents", draft.fill === "ai"]], null, "grow")}</div>
    <p class="hint">${e(fillHint)}</p>
    ${infoField("ranked", selectField("Ranked", `data-draft="ranked" aria-label="Ranked"`, [["off", "Off", draft.ranked !== "on"], ["on", "On", draft.ranked === "on"]], "sparkles"), draft.ranked === "on" ? "Matches between players count toward MMR, and are played on House rules. Matches against a CPU never count." : "Matches don't affect anyone's MMR.")}`;
}
function tournamentSettings() {
  return {
    name: (draft.tournamentName || "").trim() || "Golf Tournament",
    format: draft.format,
    seeding: draft.seeding,
    fill: draft.fill,
    ranked: draft.ranked === "on",
  };
}

/* ---------- lists: Spectate, Play with Friends, and Match history ---------- */
/** One row per tournament, each opening its page. */
function tournamentRows(list) {
  return list
    .map((item) => {
      const players = `${item.entrants} player${item.entrants === 1 ? "" : "s"}`;
      const detail =
        item.status === "open"
          ? `Hosted by ${e(item.host)} · ${players} so far · waiting to start`
          : item.status === "live"
            ? `${players} · ${item.live} match${item.live === 1 ? "" : "es"} in play`
            : `${players} · ${item.finished_at ? e(dateLabel(item.finished_at)) : "Finished"}${item.champion ? ` · ${e(item.champion)} won` : ""}`;
      return `<button type="button" class="list-item ${item.status === "finished" ? "c-fw" : "c-p4"}" data-tournament-open="${e(item.id)}"><span class="avatar-badge ${item.status === "finished" ? "c-fw" : "c-p4"}">${icon("trophy.fill", 24, { idle: false })}</span><div class="grow"><strong>${item.mine ? youStar() : ""}${e(item.name)}</strong><small>${e(item.format_name)}${item.ranked ? " · Ranked" : ""} · ${detail}</small></div>${glyph("chevron.right", 20)}</button>`;
    })
    .join("");
}
async function loadTournaments() {
  try {
    return await api("/api/tournaments");
  } catch {
    return []; // a server from before tournaments, or a hiccup: the page still draws
  }
}
/** Finished tournaments, for Match history. */
async function loadTournamentHistory() {
  try {
    return await api("/api/tournament-history");
  } catch {
    return [];
  }
}
/** Called with every presence poll: when this player's match is ready, take them to it (once). */
async function followTournament() {
  const mine = presenceState?.tournament;
  if (!mine?.room_id || mine.room_id === tournamentEntered || state?.id === mine.room_id) return;
  await enterTournamentMatch(mine.room_id);
}
async function enterTournamentMatch(roomId) {
  if (tournamentEntering) return;
  tournamentEntering = true;
  try {
    const next = await api(`/api/lobbies/${roomId}/state`);
    tournamentEntered = roomId;
    stopTournament();
    stopWatching();
    closeSheet();
    tableEpoch++;
    enterRoom(next);
    toast(`${next.tournament?.name || "Tournament"} · ${next.tournament?.label || "your match"}`);
  } catch {
    // not seated there (any more): the bracket will say what happened
  } finally {
    tournamentEntering = false;
  }
}

/* ---------- the tournament page ---------- */
function stopTournament() {
  clearTimeout(tournamentTimer);
  tournamentTimer = null;
}
async function tournamentPage(id) {
  if (tournament?.id !== id) roundAt = 0;
  stopTournament();
  stopWatching();
  closeSocket();
  state = null;
  page = "tournament";
  tournamentDrawn = "";
  tournamentArmed = "";
  history.replaceState({}, "", appPath(`/tournament/${id}`));
  document.title = "Tournament · Golf";
  if (tournament?.id !== id) {
    tournament = null;
    show("tournament", `<div class="page">${pageHead(`data-nav="friends"`, "Tournament")}<div class="loading">Loading the tournament…</div></div>`);
  }
  await refreshTournament(id);
}
async function refreshTournament(id) {
  stopTournament();
  let view;
  try {
    view = await api(`/api/tournaments/${id}`);
  } catch (error) {
    if (page === "tournament") {
      tournament = null;
      toast(error.message);
      friendsPage();
    }
    return;
  }
  if (page !== "tournament") return;
  tournament = view;
  renderTournament();
  // this player's match is on: go and play it (once; they can come back to look at the bracket)
  if (view.you.room_id && view.you.room_id !== tournamentEntered) return enterTournamentMatch(view.you.room_id);
  // (a finished tournament never changes again)
  // (a finished tournament never changes again, but for the emotes its players send at
  // the end: those keep coming while it is still up; a saved one has none)
  if (view.status !== "finished" || Array.isArray(view.emotes)) tournamentTimer = setTimeout(() => refreshTournament(id), TOURNAMENT_POLL);
}
/** The tournament this player is hosting and still gathering players for (they can invite to it). */
function hostedLobby() {
  return page === "tournament" && tournament?.status === "open" && tournament.you?.host ? tournament : null;
}
function entrantOf(view, id) {
  return view.entrants.find((entrant) => entrant.id === id) || null;
}
/** A button that asks "Sure?" on the first tap and acts on the second. */
function armedButton(key, attrs, cls, symbol, label, sure) {
  const armed = tournamentArmed === key;
  return `<button type="button" class="${cls}${armed ? " armed" : ""}" ${attrs} data-arm="${e(key)}">${icon(symbol, 26)}<span>${armed ? sure : label}</span></button>`;
}
function tournamentPills(view) {
  const settings = view.settings;
  return `<div class="meta"><span class="pill">${e(view.format_name)}</span><span class="pill">${view.seeding === "mmr" ? "Seeded by MMR" : "Random seeds"}</span><span class="pill">${e(matchLength(settings))}</span>${view.ranked ? `<span class="pill c-p3">${glyph("sparkles", 14)} Ranked</span>` : ""}<span class="pill">${view.fill === "ai" ? "CPU fills empty places" : "Byes for empty places"}</span>${rulesChip({ ...settings, name: view.name })}</div>`;
}
function tournamentLobby(view) {
  const url = `${location.origin}${appPath(`/tournament/${view.id}`)}`;
  const me = view.you.entrant;
  const list = view.entrants
    .map((entrant, seat) => {
      const color = `c-s${seat % 8}`;
      const remove = view.you.host && entrant.id !== me ? `<button type="button" class="close-btn c-fw small-x" data-tournament-remove="${e(entrant.id)}" aria-label="Remove ${e(entrant.name)}">${icon("xmark.circle.fill", 26)}</button>` : "";
      return `<div class="list-item ${color}">${avatarBadge(entrant.avatar, color)}<div class="grow"><strong>${entrant.id === me ? youStar() : ""}${e(entrant.name)}</strong><small>${entrant.id === view.host ? "Host" : entrant.ai ? "CPU opponent" : "Player"}${entrant.ai ? "" : ` · ${statNumber(entrant.rating)} MMR`}</small></div>${remove}</div>`;
    })
    .join("");
  const count = view.entrants.length;
  const hint = view.can_start
    ? view.fill === "ai"
      ? "The host starts when everyone is in. CPU opponents fill any places left over."
      : "The host starts when everyone is in."
    : "A tournament needs at least two players.";
  // the host's buttons are a table host's: Invite a Player, then Start
  const actions = view.you.host
    ? `<button type="button" class="btn c-p3" data-invite-open ${count >= view.capacity ? "disabled" : ""}>${tilted("person.fill.badge.plus", 32)}<span>${padTag("x")}Invite a Player</span></button>
       <div class="row"><button type="button" class="btn c-p4 grow" data-tournament-start ${view.can_start ? "" : "disabled"}>${tilted("trophy.fill", 32)}<span>${padTag("y")}Start Tournament</span></button></div>`
    : me
      ? `<div class="row"><div class="btn c-fw grow" style="font-size:1.8rem" role="status">Waiting for the host…</div>${armedButton("leave", "data-tournament-leave", "close-btn c-p2", "rectangle.portrait.and.arrow.right", "Leave", "Sure?")}</div>`
      : `<div class="row"><button type="button" class="btn c-p4 grow" data-tournament-join ${count >= view.capacity ? "disabled" : ""}>${tilted("trophy.fill", 32)}<span>${padTag("y")}Join Tournament</span></button></div>`;
  // the host going Back closes the tournament, as leaving a table you host closes it
  return `<div class="page">${pageHead(view.you.host ? "data-tournament-leave" : `data-nav="friends"`)}<div class="stack wide">
    <div class="stack">${tabTitle(view.name, "", "tournament")}${tournamentPills(view)}</div>
    ${me ? `<div class="share">${field("Invite Link", `<input readonly aria-label="Tournament invite link" value="${e(url)}">`, "link")}<button type="button" class="close-btn c-fw share-copy" data-copy="${e(url)}" aria-label="Copy the invite link">${icon("doc.on.doc.fill", 30)}<span>Copy</span></button></div>` : ""}
    ${!me && !profileChosen() ? `${avatarPicker(count)}${field("Your Display Name", `<input id="username" maxlength="32" value="${e(session.username)}" autocomplete="nickname" aria-label="Your display name">`, "character.cursor.ibeam")}` : ""}
    <div class="list">${list}</div>
    <p class="hint dark">${count} of up to ${view.capacity} players. ${hint}</p>
    </div><div class="stack">${actions}</div></div>`;
}
/** What a place in a match reads as: an entrant, a bye, or still to be decided. */
function matchPlayers(view, match) {
  const points = view.settings.series_mode === "points";
  return match.players.map((id, place) => {
    const entrant = entrantOf(view, id);
    const done = match.status === "done";
    const score = match.status === "live" ? (points ? match.live?.points?.[place] : match.live?.wins?.[place]) : match.score?.[place];
    return {
      entrant,
      name: id === "bye" ? "Bye" : entrant ? entrant.name : "To be decided",
      won: done && match.winner === place,
      lost: done && match.winner !== null && match.winner !== place,
      score: score ?? "",
      mine: !!entrant && entrant.id === view.you.entrant,
    };
  });
}
function matchAction(view, match, wide = false) {
  if (match.status !== "live" || !match.room_id) return "";
  const cls = wide ? "btn small" : "btn small";
  return match.id === view.you.match
    ? `<button type="button" class="${cls} c-p1" data-tournament-play="${e(match.room_id)}">${glyph("play.fill", 14)} Play</button>`
    : `<button type="button" class="${cls} c-s4" data-watch="${e(match.room_id)}">${glyph("eye.fill", 14)} Watch${match.live?.watchers ? ` · ${match.live.watchers}` : ""}</button>`;
}
/** A player's color in a tournament: one of the eight seat colors, dealt out at random (the
 * same deal every time for that tournament, so it never changes as you look), without
 * repeats until all eight are used, then again from a fresh shuffle. */
const cupColors = new Map(); // tournament id -> {entrant id: color}
function entrantColor(entrant, fallback = 0) {
  const view = tournament;
  if (!view?.entrants || !entrant?.id) return SEAT_COLORS[fallback % SEAT_COLORS.length];
  let dealt = cupColors.get(view.id);
  if (!dealt || !(entrant.id in dealt)) {
    // (a little random number generator seeded from the tournament's id)
    let seed = [...String(view.id)].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261);
    const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const order = [...view.entrants].sort((a, b) => (a.seed ?? 999) - (b.seed ?? 999) || String(a.id).localeCompare(String(b.id)));
    dealt = {};
    let deck = [];
    for (const one of order) {
      if (!deck.length) {
        deck = [...SEAT_COLORS];
        for (let i = deck.length - 1; i > 0; i--) {
          const j = Math.floor(random() * (i + 1));
          [deck[i], deck[j]] = [deck[j], deck[i]];
        }
      }
      dealt[one.id] = deck.pop();
    }
    cupColors.set(view.id, dealt);
  }
  return dealt[entrant.id] || SEAT_COLORS[fallback % SEAT_COLORS.length];
}
/** An entrant's MMR, where it says something (a player's, or a demo player's; an AI's is a placeholder). */
function entrantMmr(entrant) {
  return entrant && entrant.rating != null && (!entrant.ai || entrant.rating !== 1000) ? `${statNumber(entrant.rating)}MMR` : "";
}
/** A match in the bracket: a card in the colors of where it has got to, its two players
 * (avatar, seed, name, MMR) with their score as stickers, the winner's avatar a trophy. */
function matchCard(view, match, roundName = "") {
  const known = match.players.every((id) => id && id !== "bye");
  const unit = view.settings.series_mode === "points" ? "pts" : "wins";
  // what the card says on its edge, and its color
  const watching = match.live?.watchers;
  const [color, label] =
    match.status === "live"
      ? ["c-s4", `${icon("binoculars.fill", 17, { idle: false, sw: 3, cls: "bk-label-ico" })} ${watching ? `${watching} spectating now` : `Live · game ${match.live?.game ?? 1}`}`]
      : match.status === "done"
        ? ["c-p1", { forfeit: "Forfeit", awarded: "Awarded", bye: "Bye" }[match.note] || (match.winner === null ? "Drawn" : "Match finished")]
        : known
          ? ["c-fw", "Starting Soon"]
          : ["c-fw", "Still Seeding"];
  const rows = matchPlayers(view, match)
    .map((player, place) => {
      // (each player keeps one color the whole tournament: their seed's)
      const seat = player.entrant ? entrantColor(player.entrant) : SEAT_COLORS[place % SEAT_COLORS.length];
      const face = player.won ? `<span class="bk-trophy">${icon("trophy.fill", 20, { idle: false })}</span>` : icon(player.entrant ? avatarIcon(player.entrant.avatar) : "person.fill", 20, { idle: false });
      const mmr = entrantMmr(player.entrant);
      const score = player.entrant ? Number(player.score) || 0 : 0;
      return `<div class="bk-player ${seat}${player.won ? " won" : ""}${player.lost ? " lost" : ""}${player.entrant ? "" : " tbd"}"${player.entrant ? ` data-entrant="${e(player.entrant.id)}"` : ""} data-place="${place}"><span class="bk-ava">${face}</span><span class="bk-who"><b>${player.entrant?.seed != null ? `<span class="bk-seed">${player.entrant.seed}</span> ` : ""}${player.mine ? youStar() : ""}${e(player.name)}${player.entrant?.ai && !mmr ? ` <span class="bk-ai">CPU</span>` : ""}</b>${mmr ? `<small>${mmr}</small>` : ""}</span><span class="wc-score bk-score">${stickerText(String(score), { split: true, idle: false })}${stickerText(unit, { cls: "pts", idle: false })}</span></div>`;
    })
    .join("");
  // a match being played opens: yours to play, anyone else's to watch
  const open = match.status === "live" && match.room_id ? (match.id === view.you.match ? ` data-tournament-play="${e(match.room_id)}"` : ` data-watch="${e(match.room_id)}"`) : "";
  const tag = open ? "button" : "div";
  return `<${tag}${open ? ` type="button"` : ""} class="bk-match boxed ${color} ${match.status}" data-match="${e(match.id)}"${open} aria-label="${e(match.label)}">${roundName ? `<span class="bk-round-name" aria-hidden="true">${e(roundName)}</span>` : ""}<span class="box-label">${label}</span>${rows}</${tag}>`;
}
function bracketHtml(view) {
  // a bracket's rounds as columns (the grand final, from its own bracket, a column after them all)
  const columns = (bracket, also = []) => {
    // a place where two byes "met" is only scaffolding: leave it out
    const matches = view.matches.filter((match) => (match.bracket === bracket || also.includes(match.bracket)) && !match.players.every((id) => id === "bye"));
    const column = (match) => (match.bracket === bracket ? match.round : 1000 + match.round);
    const rounds = [...new Set(matches.map(column))].sort((a, b) => a - b);
    return rounds
      .map((round) => {
        const list = matches.filter((match) => column(match) === round);
        // (the round's name over its topmost match)
        return `<div class="bracket-round" aria-label="${e(list[0].label)}">${list.map((match, i) => matchCard(view, match, i === 0 ? list[0].label : "")).join("")}</div>`;
      })
      .join("");
  };
  if (view.format === "single") return `<section class="bracket-section"><div class="bracket" role="group" aria-label="Bracket"><svg class="bk-arrows" aria-hidden="true"></svg>${columns("W")}</div></section>`;
  if (view.format === "double")
    // Both brackets in one scroller, one over the other, so they move as one: the winners'
    // (with the grand final at its end) on top, the losers' under it.
    return `<section class="bracket-section"><div class="bracket double" role="group" aria-label="Bracket"><svg class="bk-arrows" aria-hidden="true"></svg><h3 class="bk-row-title c-p1" aria-label="Winners bracket">${stickerText("Winners bracket", { split: true, key: "bk-title:W" })}</h3><div class="bk-row">${columns("W", ["F"])}</div><h3 class="bk-row-title c-p1" aria-label="Losers bracket">${stickerText("Losers bracket", { split: true, key: "bk-title:L" })}</h3><div class="bk-row">${columns("L")}</div></div></section>`;
  // A round robin: a column a round, side by side as a bracket's are (it scrolls the same
  // way, with the same round bar), but nobody moves on from a match, so no arrows.
  const rounds = [...new Set(view.matches.map((match) => match.round))].sort((a, b) => a - b);
  return `<section class="bracket-section"><div class="bracket robin" role="group" aria-label="Rounds">${rounds
    .map((round) => {
      const out = entrantOf(view, view.sitting_out?.[round]);
      const list = view.matches.filter((match) => match.round === round);
      return `<div class="bracket-round" aria-label="Round ${round}">${list.map((match, i) => matchCard(view, match, i === 0 ? `Round ${round}` : "")).join("")}${out ? `<p class="robin-out">${e(out.name)} sits out</p>` : ""}</div>`;
    })
    .join("")}</div></section>`;
}
/** Where an entrant stands now: the winner, playing, waiting for their next match, or out. */
function entrantStatus(view, entrant) {
  if (view.champion === entrant.id) return ["trophy.fill", "Winner", "c-p3"];
  if (entrant.withdrawn) return ["xmark", "Left", "c-p2"];
  if (entrant.out) return ["xmark", "Out", "c-p2"];
  const theirs = view.matches.filter((match) => match.players.includes(entrant.id) && match.note !== "bye");
  if (theirs.some((match) => match.status === "live")) return ["binoculars.fill", "Live", "c-s4"];
  if (view.status === "finished") return ["checkmark.seal.fill", "Done", "c-fw"];
  // (between matches, after a win or before their first: waiting for the next)
  return ["hourglass", "Waiting", "c-fw"];
}
/*
 * At the end of a tournament its players can emote, as at the end of a game: a tab under
 * the standings drops the quick emotes down, and what each sends shows beside their name
 * in the standings, as a spectator's emote shows by the table (and goes after 4 seconds).
 */
let cupEmotesOpen = false;
const cupEmoteSeen = new Map(); // an emote's sequence -> when it began, on this device's clock
function cupEmoteHtml(view, entrant, seat) {
  const item = (view.emotes || []).find((one) => one.entrant === entrant.id);
  if (!item) return "";
  if (!cupEmoteSeen.has(item.sequence)) cupEmoteSeen.set(item.sequence, Date.now() - (item.age || 0) * 1000);
  const age = Date.now() - cupEmoteSeen.get(item.sequence);
  if (age >= 4000) return "";
  const art = TEXT_EMOTES.includes(item.id)
    ? `<b class="spectator-say">${e(emoteNames[item.id])}</b>`
    : `<img src="${appPath(`/static/emotes/${item.id}.png`)}" alt="">`;
  return `<span class="spectator-emote from-left cup-emote ${seat}" role="status" aria-label="${e(entrant.name)}: ${e(emoteNames[item.id] || "")}" style="animation-delay:-${age}ms">${art}</span>`;
}
function cupEmotesHtml(view) {
  if (view.status !== "finished" || !Array.isArray(view.emotes) || !view.you?.entrant) return "";
  const face = (id) => `<button type="button" data-cup-emote="${id}" aria-label="Send ${e(emoteNames[id].toLowerCase())} emote"><img src="${appPath(`/static/emotes/${id}.png`)}" alt=""></button>`;
  const word = (id) => `<button type="button" class="emote-word" data-cup-emote="${id}" aria-label="Say ${e(emoteNames[id])}">${e(emoteNames[id])}</button>`;
  const said = emoteBar("words");
  const half = Math.ceil(said.length / 2);
  const words = [said.slice(0, half), said.slice(half)].filter((row) => row.length).map((row) => `<div class="emote-words-row">${row.map(word).join("")}</div>`).join("");
  const faces = emoteBar("faces");
  const buttons = `<div class="emote-row"><div class="emote-faces${faces.length <= 4 ? " at-end" : ""}">${faces.map(face).join("")}</div></div>${words ? `<div class="emote-words">${words}</div>` : ""}`;
  const open = cupEmotesOpen;
  return `<div class="summary-emote-anchor cup-emote-anchor"><div class="summary-emote-drawer c-fw"><button type="button" class="emote-tab" data-cup-emotes aria-expanded="${open}" aria-label="${open ? "Hide" : "Show"} quick emotes">${icon("text.bubble.fill", 22, { idle: false })}${glyph(open ? "chevron.up" : "chevron.down", 14)}</button></div><div class="emote-pop summary-emotes${open ? "" : " tucked"}" role="group" aria-label="Quick emotes" ${open ? "" : "inert"}>${buttons}</div></div>`;
}
function standingsHtml(view) {
  const robin = view.format === "round_robin";
  // Where each has placed so far: their place in the standings, those level on record
  // sharing it (1st, 2nd, =3rd...)
  const record = (row) => (view.champion === row.id ? "champion" : robin ? `${row.score}|${row.points}` : `${row.losses}|${row.wins}|${row.draws}`);
  const placed = new Map();
  view.standings.forEach((row, i) => {
    const prev = view.standings[i - 1];
    placed.set(row.id, prev && record(prev) === record(row) ? placed.get(prev.id) : i + 1);
  });
  const ordinal = (n) => `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
  // (listed by where each has placed, those level by seed; each with their seed beside it)
  const seedOf = (row) => entrantOf(view, row.id)?.seed ?? 999;
  const rows = [...view.standings]
    .sort((a, b) => (placed.get(a.id) || 0) - (placed.get(b.id) || 0) || seedOf(a) - seedOf(b))
    .map((row, rank) => {
      const entrant = entrantOf(view, row.id);
      if (!entrant) return "";
      const [symbol, status, color] = entrantStatus(view, entrant);
      const seat = entrantColor(entrant, rank);
      const mmr = entrantMmr(entrant);
      // (each player opens their profile; an AI in the bracket is Golfbot)
      const player = entrant.player_id || (entrant.ai ? "bot:golfbot" : null);
      const tag = player ? "button" : "span";
      return `<tr class="${entrant.id === view.you.entrant ? "mine" : ""}"><th scope="row">${entrant.seed ?? rank + 1}</th><td class="st-rank">${ordinal(placed.get(row.id) || rank + 1)}</td><td><span class="st-player-wrap"><${tag}${player ? ` type="button" data-stats-player="${e(player)}" aria-label="${e(entrant.name)}'s profile"` : ""} class="st-player ${seat}"><span class="bk-ava">${icon(avatarIcon(entrant.avatar), 20, { idle: false })}</span><span class="bk-who"><b>${entrant.id === view.you.entrant ? youStar() : ""}${e(entrant.name)}</b>${mmr ? `<small>${mmr}</small>` : entrant.ai ? `<small class="bk-ai">CPU</small>` : ""}</span></${tag}>${cupEmoteHtml(view, entrant, seat)}</span></td><td>${row.wins}-${row.losses}-${row.draws}</td><td><span class="st-status ${color}" title="${status}">${icon(symbol, 18, { idle: false })}<span class="st-status-text">${status}</span></span></td></tr>`;
    })
    .join("");
  return `<div class="boxed c-fw standings-card"><div class="table-wrap"><table class="standings"><thead><tr><th scope="col">Seed</th><th scope="col">Rank</th><th scope="col">Player</th><th scope="col">W-L-D</th><th scope="col">Status</th></tr></thead><tbody>${rows}</tbody></table></div></div>${cupEmotesHtml(view)}${robin ? `<p class="hint dark">Ranked by matches won (a draw counts half), then fewest card points.</p>` : ""}`;
}
function tournamentDashboard(view) {
  const me = entrantOf(view, view.you.entrant);
  const champion = entrantOf(view, view.champion);
  const live = view.matches.filter((match) => match.status === "live");
  const done = view.matches.filter((match) => match.status === "done" && match.note !== "bye").length;
  const total = view.matches.filter((match) => !match.players.includes("bye")).length;
  const banner =
    view.status === "finished"
      ? // (as the big buttons are drawn: the winner's name between two trophies, what they won under it)
        `<section class="btn c-p3 solve-btn cup-won" role="status"><span class="cup-won-trophy">${tilted("trophy.fill", 34, { key: "cup-won-l" })}</span><span>${champion ? `${champion.id === me?.id ? youStar() : ""}${e(champion.name)}` : "Nobody"}<span class="sub">${champion ? "Wins the Tournament!" : "No winner this time"}</span></span><span class="cup-won-trophy">${tilted("trophy.fill", 34, { key: "cup-won-r", mirror: true })}</span></section>`
      : "";
  const mine = !me
    ? ""
    : view.you.room_id
      ? `<section class="panel c-p1 tournament-you"><p><strong>Your match is on.</strong></p><button type="button" class="btn c-p1" data-tournament-play="${e(view.you.room_id)}">${tilted("play.fill", 28)}<span>${padTag("y")}Play your match</span></button></section>`
      : view.status === "live"
        ? `<p class="hint dark">${me.out ? "You're out of this one. Thanks for playing! You can still watch." : "Waiting for your next match. You'll be taken to it when it's ready."}</p>`
        : "";
  // the host can settle a match that cannot finish by itself
  const stuck = view.you.host && view.status === "live" && live.length
    ? `<details class="tournament-host"><summary>Host tools</summary><p class="hint dark">Give a match to one player if it can't finish (someone stuck or gone).</p>${live
        .map((match) => {
          const players = matchPlayers(view, match);
          return `<div class="row">${players.map((player, place) => armedButton(`award:${match.id}:${place}`, `data-tournament-award="${e(match.id)}:${place}"`, "btn small c-fw grow", "checkmark.circle.fill", `${e(player.name)} wins`, `Sure? ${e(player.name)} wins`)).join("")}</div>`;
        })
        .join("")}</details>`
    : "";
  const leave = me && !me.withdrawn && view.status === "live" && !me.out ? armedButton("leave", "data-tournament-leave", "close-btn c-p2", "rectangle.portrait.and.arrow.right", "Leave", "Sure?") : "";
  // (how far it has got goes under its name, as a page's line under its title)
  const progress = `${view.status === "finished" ? "Finished" : "In progress"} · ${done} of ${total} matches played · ${view.entrants.length} entrants`;
  return `<div class="page top scroll tournament-page">${pageHead(`data-nav="${tournamentBack}"`, view.name, leave, progress)}<div class="stack wide">
    ${tournamentPills(view)}
    ${banner}${mine}
    <section class="stack bracket-holder">${bracketHtml(view)}${roundTabs(view)}</section>
    <section class="stack">${sectionTitle("Standings")}${standingsHtml(view)}</section>
    ${stuck}
    </div></div>`;
}
/* ---------- the round selector ----------
   A bracket wider than the screen has a floating bar at its foot (as Match history
   does), a button for each round: one tap brings that round's column into view, and as
   the bracket is scrolled the bar follows the round in view. */
/** The main bracket's rounds, each with its name (Quarterfinal, Semifinal, Final...). */
function bracketRounds(view) {
  if (view.format === "round_robin")
    return [...new Set(view.matches.map((match) => match.round))].sort((a, b) => a - b).map((round) => ({ round, label: `Round ${round}` }));
  const main = view.matches.filter((match) => match.bracket === "W" && !match.players.every((id) => id === "bye"));
  const rounds = [...new Set(main.map((match) => match.round))].sort((a, b) => a - b).map((round) => ({ round, label: main.find((match) => match.round === round).label }));
  // (a double elimination's grand final is the winners bracket's last column)
  if (view.matches.some((match) => match.bracket === "F")) rounds.push({ round: rounds.length + 1, label: "Grand final" });
  return rounds;
}
/** A round's short name, for the bar: One, Two..., Quarters, Semis, Finals. */
const ROUND_WORDS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];
function roundShort(label) {
  const named = { Quarterfinal: "Quarters", Semifinal: "Semis", Final: "Finals", "Winners final": "Final", "Grand final": "Grand" }[label];
  if (named) return named;
  const number = /^Round (\d+)$/.exec(label)?.[1];
  return number ? ROUND_WORDS[number - 1] || number : label;
}
let roundAt = 0; // the round the bar shows (kept through the page's redraws as the tournament moves on)
function roundTabs(view) {
  const rounds = bracketRounds(view);
  if (rounds.length < 2) return "";
  const at = Math.min(roundAt, rounds.length - 1);
  // (it floats at the foot of the screen while the bracket is in view, and settles under it once scrolled past)
  return `<div class="round-dock"><nav class="aces-tabs boxed c-fw round-tabs" aria-label="Rounds" style="--at:${at};--n:${rounds.length}"><span class="aces-pointer c-p2" aria-hidden="true">${icon("chevron.down", 15, { idle: false, sw: 4.2 })}</span>${rounds
    .map(({ round, label }, i) => `<button type="button" class="aces-tab${i === at ? " on c-p2" : ""}" data-bracket-round="${i}" aria-pressed="${i === at}" aria-label="${e(label)}"><span class="round-num">${round}</span><span>${e(roundShort(label))}</span></button>`)
    .join("")}</nav></div>`;
}
/** The round now in view lights up on the bar, its arrow sliding over to it. */
function markRound(at) {
  roundAt = at;
  const strip = root.querySelector(".round-tabs");
  if (!strip || Number(strip.style.getPropertyValue("--at")) === at) return;
  const pointer = strip.querySelector(".aces-pointer");
  // (from wherever it is now, part-way through a slide or not: measured before that slide
  // is stopped, so a new one carries on from the same spot rather than jumping)
  const was = pointer.getBoundingClientRect().left;
  pointer.slide?.cancel();
  strip.style.setProperty("--at", at);
  const dx = was - pointer.getBoundingClientRect().left;
  if (Math.abs(dx) > 0.5 && pointer.animate && !reducedMotion.matches)
    pointer.slide = pointer.animate([{ translate: `${dx}px 0` }, { translate: "0 0" }], { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  strip.querySelectorAll("[data-bracket-round]").forEach((button, i) => {
    button.classList.toggle("on", i === at);
    button.classList.toggle("c-p2", i === at);
    button.setAttribute("aria-pressed", String(i === at));
  });
}
/* ---------- arrows: each winner on to their next match ----------
   From the winner's row of a finished match to their row in the match they play next,
   a curve in their color in a white edge, with rounded ends and a rounded head. */
/* ---------- the bracket changing, animated ----------
   Between two looks at a tournament: a match that starts or ends gives a hop, a score that
   moves pops, a winner's trophy drops in while the loser greys, a player arriving in their
   next match slides in, and the arrow carrying them there draws itself across. */
function bracketState() {
  const state = new Map();
  for (const card of root.querySelectorAll?.(".bk-match[data-match]") || [])
    state.set(card.dataset.match, {
      status: ["live", "done", "pending"].find((name) => card.classList.contains(name)),
      rows: [...card.querySelectorAll(".bk-player")].map((row) => ({ entrant: row.dataset.entrant || "", score: row.querySelector(".bk-score")?.textContent || "", won: row.classList.contains("won"), lost: row.classList.contains("lost") })),
    });
  const arrows = new Set([...(root.querySelectorAll?.(".bk-arrows g[data-from]") || [])].map((g) => g.dataset.from));
  return { state, arrows };
}
function animateBracket(before) {
  if (!before?.state.size || reducedMotion.matches || !Element.prototype.animate) return;
  const spring = "cubic-bezier(0.34, 1.56, 0.64, 1)";
  for (const card of root.querySelectorAll(".bk-match[data-match]")) {
    const was = before.state.get(card.dataset.match);
    if (!was) continue;
    const status = ["live", "done", "pending"].find((name) => card.classList.contains(name));
    if (status !== was.status) card.animate([{ scale: "1" }, { scale: "1.05" }, { scale: "1" }], { duration: 520, easing: spring });
    card.querySelectorAll(".bk-player").forEach((row, i) => {
      const old = was.rows[i];
      if (!old) return;
      // someone new in this place: they slide in
      if ((row.dataset.entrant || "") !== old.entrant) {
        row.animate([{ translate: "-1.4rem 0", opacity: 0 }, { translate: "0 0", opacity: 1 }], { duration: 480, delay: 350, easing: spring, fill: "backwards" });
        return;
      }
      const score = row.querySelector(".bk-score");
      if (score && score.textContent !== old.score) score.animate([{ scale: "1" }, { scale: "1.35" }, { scale: "1" }], { duration: 520, easing: spring });
      if (row.classList.contains("won") && !old.won)
        row.querySelector(".bk-trophy")?.animate([{ scale: "0", rotate: "-40deg" }, { scale: "1.25", rotate: "8deg", offset: 0.6 }, { scale: "1", rotate: "0deg" }], { duration: 700, delay: 150, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "backwards" });
      if (row.classList.contains("lost") && !old.lost) row.animate([{ filter: "grayscale(0)", opacity: 1 }, { filter: "grayscale(1)", opacity: 0.5 }], { duration: 700, easing: "ease-out" });
    });
  }
  // a new arrow draws itself from the winner to their next match, its head arriving last
  for (const g of root.querySelectorAll(".bk-arrows g[data-from]")) {
    if (before.arrows.has(g.dataset.from)) continue;
    const [edgeLine, edgeHead, inkLine, inkHead] = g.querySelectorAll("path");
    for (const line of [edgeLine, inkLine]) {
      const length = line?.getTotalLength?.();
      if (!length) continue;
      line.style.strokeDasharray = `${length}`;
      line.animate([{ strokeDashoffset: `${length}` }, { strokeDashoffset: "0" }], { duration: 600, delay: 200, easing: "ease-in-out", fill: "backwards" }).onfinish = () => (line.style.strokeDasharray = "");
    }
    for (const head of [edgeHead, inkHead]) head?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160, delay: 760, fill: "backwards" });
  }
}
/** The round bar only where the bracket is wider than the screen (it all shows otherwise). */
function fitRoundBar() {
  const bracket = root.querySelector?.(".bracket"),
    bar = root.querySelector?.(".round-dock");
  if (!bracket || !bar) return;
  bar.hidden = bracket.scrollWidth <= bracket.clientWidth + 1;
}
function drawBracketArrows(view = tournament) {
  if (!view?.matches) return;
  for (const bracket of root.querySelectorAll?.(".bracket:not(.robin)") || []) {
    const svg = bracket.querySelector(":scope > .bk-arrows");
    if (!svg || !bracket.getBoundingClientRect) continue;
    const box = bracket.getBoundingClientRect();
    const at = (el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left - box.left + bracket.scrollLeft, right: r.right - box.left + bracket.scrollLeft, mid: (r.top + r.bottom) / 2 - box.top + bracket.scrollTop };
    };
    const paths = [];
    for (const card of bracket.querySelectorAll(".bk-match[data-match]")) {
      const match = view.matches.find((m) => m.id === card.dataset.match);
      if (!match || match.status !== "done" || match.winner == null) continue;
      const id = match.players[match.winner];
      const next =
        view.matches.find((m) => m.bracket === match.bracket && m.round === match.round + 1 && m.players.includes(id)) ||
        // (out of the winners bracket's last round, on into the grand final; the losers
        // final's winner has no arrow up to it: it would run the height of the bracket)
        (match.bracket === "W" ? view.matches.find((m) => m.bracket === "F" && m.players.includes(id)) : null);
      const from = card.querySelector(`.bk-player[data-place="${match.winner}"]`);
      const target = next && bracket.querySelector(`.bk-match[data-match="${CSS.escape(next.id)}"]`);
      const to = target?.querySelector(`.bk-player[data-place="${next.players.indexOf(id)}"]`);
      if (!from || !to) continue;
      const a = at(card), b = at(target), y1 = at(from).mid, y2 = at(to).mid;
      // (it starts from under the middle of the winner's card, which hides it till its edge)
      const x1 = (a.left + a.right) / 2, x2 = b.left - 9;
      // straight lines: across, down (or up) half way between the cards, across again,
      // with the two corners rounded
      // (the turn a little before half way, so the last straight run is long enough that
      // the head stands clear of the corner)
      const span = x2 - a.right,
        dy = y2 - y1,
        r = Math.min(10, Math.abs(dy) / 2, span / 5),
        xm = a.right + span * 0.4,
        down = Math.sign(dy);
      const line = Math.abs(dy) < 1
        ? `M${x1} ${y1} H${x2}`
        : `M${x1} ${y1} H${xm - r} Q${xm} ${y1} ${xm} ${y1 + down * r} V${y2 - down * r} Q${xm} ${y2} ${xm + r} ${y2} H${x2}`;
      const head = `M${x2 - 6} ${y2 - 6} L${x2} ${y2} L${x2 - 6} ${y2 + 6}`;
      // (its color: the winner's, as their row has it)
      const seat = [...from.classList].find((name) => name.startsWith("c-s")) || "c-fw";
      const rough = (d) => roughStroke(svg, d);
      const [l, h] = [rough(line), rough(head)];
      paths.push(`<g class="${seat}" data-from="${e(match.id)}"><path class="edge" d="${l}"/><path class="edge" d="${h}"/><path class="ink" d="${l}"/><path class="ink" d="${h}"/></g>`);
    }
    svg.setAttribute("width", bracket.scrollWidth);
    svg.setAttribute("height", bracket.scrollHeight);
    svg.innerHTML = paths.join("");
  }
}
/**
 * An open line with the stickers' rough paper grain: walked every half pixel or so, each
 * point nudged by the same noise the icons are roughened with (GRAIN, in ui.js).
 */
function roughStroke(svg, d) {
  if (typeof grainNoise !== "function" || !svg?.ownerDocument?.createElementNS) return d;
  const probe = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path");
  probe.setAttribute("d", d);
  svg.appendChild(probe);
  let out = d;
  try {
    const length = probe.getTotalLength?.();
    if (length) {
      const step = GRAIN.step,
        steps = Math.max(2, Math.ceil(length / step));
      const points = [];
      for (let i = 0; i <= steps; i++) {
        const { x, y } = probe.getPointAtLength((length * i) / steps);
        // (the two ends stay put, so the line still meets its card and its head)
        const keep = i === 0 || i === steps;
        const u = x / GRAIN.wavelength,
          v = y / GRAIN.wavelength;
        const dx = keep ? 0 : (grainNoise(u, v, 11) * 0.72 + grainNoise(u * 2.1, v * 2.1, 13) * 0.28) * GRAIN.amplitude;
        const dy = keep ? 0 : (grainNoise(u, v, 17) * 0.72 + grainNoise(u * 2.1, v * 2.1, 19) * 0.28) * GRAIN.amplitude;
        points.push(`${(x + dx).toFixed(1)} ${(y + dy).toFixed(1)}`);
      }
      out = `M${points[0]} L${points.slice(1).join(" ")}`;
    }
  } catch {}
  probe.remove();
  return out;
}
if (typeof addEventListener === "function")
  addEventListener("resize", () => {
    if (page !== "tournament") return;
    drawBracketArrows();
    fitRoundBar();
  });
/** The bracket's columns: a round's lies under the first section's (the winners'). */
const roundColumns = () => [...(root.querySelector(".bracket")?.querySelectorAll(":scope > .bracket-round, :scope > .bk-row:first-of-type > .bracket-round") || [])];
function showRound(at) {
  const bracket = root.querySelector(".bracket"),
    column = roundColumns()[at];
  if (!bracket || !column) return;
  markRound(at);
  // The round picked stays picked, wherever the bracket can scroll to (the last rounds may
  // never reach the left edge): the bar follows the bracket again only once it is moved by hand.
  bracket.picked = true;
  bracket.scrollTo({ left: column.offsetLeft - parseFloat(getComputedStyle(bracket).paddingLeft || 0), behavior: reducedMotion.matches ? "auto" : "smooth" });
}
/** Which round is in view: the column nearest the bracket's left edge. */
function followRounds() {
  const bracket = root.querySelector(".bracket");
  if (!bracket || bracket.followed) return;
  bracket.followed = true;
  let queued = 0;
  // A mouse can drag the bracket sideways too, from anywhere on it, the cards included (a
  // finger and a trackpad scroll it themselves). A drag is not a click: the card under it
  // is not opened.
  let grab = null;
  bracket.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse" || event.button > 0) return;
    grab = { x: event.clientX, left: bracket.scrollLeft, moved: false, id: event.pointerId };
  });
  bracket.addEventListener("pointermove", (event) => {
    if (!grab || event.pointerId !== grab.id) return;
    const dx = event.clientX - grab.x;
    if (!grab.moved && Math.abs(dx) < 6) return;
    if (!grab.moved) {
      grab.moved = true;
      bracket.classList.add("grabbing");
      try {
        bracket.setPointerCapture(event.pointerId);
      } catch {}
    }
    bracket.scrollLeft = grab.left - dx;
  });
  const letGo = (event) => {
    if (!grab || event.pointerId !== grab.id) return;
    const moved = grab.moved;
    grab = null;
    bracket.classList.remove("grabbing");
    // (the click that follows a drag goes nowhere)
    if (moved) {
      const swallow = (click) => (click.stopPropagation(), click.preventDefault());
      bracket.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => bracket.removeEventListener("click", swallow, { capture: true }), 0);
    }
  };
  bracket.addEventListener("pointerup", letGo);
  bracket.addEventListener("pointercancel", letGo);
  // (a hand on the bracket: what it shows is up to the scrolling again)
  for (const type of ["pointerdown", "touchstart", "wheel"]) bracket.addEventListener(type, () => (bracket.picked = false), { passive: true });
  bracket.addEventListener("scrollend", follow);
  // (once a frame at most)
  bracket.addEventListener("scroll", () => {
    if (!queued) queued = requestAnimationFrame(() => ((queued = 0), follow()));
  }, { passive: true });
  function follow() {
    if (bracket.picked) return;
    const columns = roundColumns();
    if (!columns.length) return;
    const edge = bracket.scrollLeft + parseFloat(getComputedStyle(bracket).paddingLeft || 0);
    // (at the far end the last round, whose column may never reach the left edge)
    const end = bracket.scrollLeft + bracket.clientWidth >= bracket.scrollWidth - 4;
    let at = end ? columns.length - 1 : 0;
    if (!end) columns.forEach((column, i) => Math.abs(column.offsetLeft - edge) < Math.abs(columns[at].offsetLeft - edge) && (at = i));
    markRound(at);
  }
}
function renderTournament() {
  const view = tournament;
  if (!view || page !== "tournament") return;
  // (an emote's age changes on every poll; only a new emote, or one going, redraws)
  const signature = JSON.stringify([{ ...view, emotes: (view.emotes || []).map(({ entrant, id, sequence }) => [entrant, id, sequence]) }, tournamentArmed, cupEmotesOpen]);
  if (signature === tournamentDrawn) return;
  tournamentDrawn = signature;
  document.title = `${view.name} · Golf`;
  chipMatch = { ...view.settings, name: view.name };
  // what the host has open stays open through a redraw
  const tools = !!root.querySelector?.(".tournament-host")?.open;
  const scroll = root.querySelector?.(".bracket")?.scrollLeft || 0;
  // (what the bracket showed, to animate what has changed; nothing when it is another tournament)
  const before = page === "tournament" && root.dataset?.cup === view.id ? bracketState() : null;
  show("tournament", view.status === "open" ? tournamentLobby(view) : tournamentDashboard(view));
  const host = root.querySelector?.(".tournament-host");
  if (host && tools) host.open = true;
  const bracket = root.querySelector?.(".bracket");
  if (bracket && scroll) bracket.scrollLeft = scroll;
  drawBracketArrows(view);
  fitRoundBar();
  if (root.dataset) root.dataset.cup = view.id;
  animateBracket(before);
  if (bracket?.addEventListener) {
    followRounds();
    bracket.dispatchEvent?.(new Event("scrollend"));
  }
  // (someone about to join picks their avatar here: the wheel opens on the one they have)
  if (view.status === "open" && !view.you.entrant && !profileChosen()) centerAvatar(false);
}
/** Taps on anything tournament: returns true when it dealt with the tap. */
async function tournamentClick(button, data) {
  if ("tournamentOpen" in data) {
    // from a table that is over (a match just played, or one being watched): step away from it first
    if (state?.spectator) stopWatching();
    else if (state?.tournament && session.room_id === state.id && ["finished", "closed"].includes(state.status)) {
      // the match is decided: give the seat up, so nothing holds this player at a finished table
      const id = state.id;
      session.room_id = null;
      api(`/api/lobbies/${id}/leave`, "POST").catch(() => {});
    }
    // Back returns to the list this was opened from
    tournamentBack = ["history", "friends"].includes(page) ? page : "spectate";
    await tournamentPage(data.tournamentOpen);
    return true;
  }
  if ("leave" in data && state?.spectator && state.tournament) {
    // a spectator leaving a tournament match goes back to its bracket
    const id = state.tournament.id;
    stopWatching();
    await tournamentPage(id);
    return true;
  }
  if ("cupEmotes" in data) {
    cupEmotesOpen = !cupEmotesOpen;
    renderTournament();
    return true;
  }
  if (data.cupEmote && tournament) {
    try {
      tournament = await api(`/api/tournaments/${tournament.id}/emote`, "POST", { emote: data.cupEmote });
      haptic("tap");
      renderTournament();
      // (gone again after its 4 seconds)
      setTimeout(() => {
        tournamentDrawn = "";
        renderTournament();
      }, 4100);
    } catch (error) {
      toast(error.message);
    }
    return true;
  }
  if ("tournamentPlay" in data) {
    tournamentEntered = null;
    await enterTournamentMatch(data.tournamentPlay);
    return true;
  }
  const view = tournament;
  const mine = Object.keys(data).some((key) => key.startsWith("tournament"));
  if (!mine || !view) return mine;
  const post = async (path, body = {}) => {
    tournament = await api(`/api/tournaments/${view.id}${path}`, "POST", body);
    renderTournament();
  };
  // Leave and the host's awards ask "Sure?" first
  if ("arm" in data && tournamentArmed !== data.arm) {
    tournamentArmed = data.arm;
    renderTournament();
    setTimeout(() => {
      if (tournamentArmed === data.arm) {
        tournamentArmed = "";
        renderTournament();
      }
    }, 4000);
    return true;
  }
  tournamentArmed = "";
  button.disabled = true;
  try {
    if ("tournamentJoin" in data) {
      saveName(name());
      if (!(await abandonExisting())) return true;
      await post("/join", { username: session.username, avatar: session.avatar, ...(tournamentLinked === view.id ? { via: "link" } : {}) });
    } else if ("tournamentRemove" in data) await post("/remove", { entrant: data.tournamentRemove });
    else if ("tournamentStart" in data) await post("/start");
    else if ("tournamentAward" in data) {
      const [match, place] = data.tournamentAward.split(":");
      await post(`/matches/${match}/award`, { winner: Number(place) });
    } else if ("tournamentLeave" in data) {
      await api(`/api/tournaments/${view.id}/leave`, "POST", {});
      tournament = null;
      stopTournament();
      closeSocial();
      toast(view.you.host && view.status === "open" ? "Tournament closed." : "You left the tournament.");
      await friendsPage();
    }
  } finally {
    button.disabled = false;
  }
  return true;
}
