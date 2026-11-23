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
        ? "With an odd number of players, an AI opponent joins so nobody sits out."
        : "Empty places in the bracket go to AI opponents, who can advance and win."
      : robin
        ? "With an odd number of players, one player sits out each round."
        : "Empty places in the bracket are byes: whoever meets one goes straight through.";
  return `<div class="row">${selectField("Seeding", `data-draft="seeding" aria-label="Seeding"`, [["random", "Random", draft.seeding === "random"], ["mmr", "By MMR", draft.seeding === "mmr"]], null, "grow")}${selectField("Empty Places", `data-draft="fill" aria-label="Empty places"`, [["byes", "Byes", draft.fill === "byes"], ["ai", "AI opponents", draft.fill === "ai"]], null, "grow")}</div>
    <p class="hint">${e(fillHint)}</p>
    ${infoField("ranked", selectField("Ranked", `data-draft="ranked" aria-label="Ranked"`, [["off", "Off", draft.ranked !== "on"], ["on", "On", draft.ranked === "on"]], "sparkles"), draft.ranked === "on" ? "Matches between players count toward MMR, and are played on House rules. Matches against an AI never count." : "Matches don't affect anyone's MMR.")}`;
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
            : `${players} · ${item.finished_at ? e(new Date(item.finished_at * 1000).toLocaleDateString()) : "Finished"}${item.champion ? ` · ${e(item.champion)} won` : ""}`;
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
  if (view.status !== "finished") tournamentTimer = setTimeout(() => refreshTournament(id), TOURNAMENT_POLL);
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
  return `<div class="meta"><span class="pill">${e(view.format_name)}</span><span class="pill">${view.seeding === "mmr" ? "Seeded by MMR" : "Random seeds"}</span><span class="pill">${e(matchLength(settings))}</span>${view.ranked ? `<span class="pill c-p3">${glyph("sparkles", 14)} Ranked</span>` : ""}<span class="pill">${view.fill === "ai" ? "AI fills empty places" : "Byes for empty places"}</span>${rulesChip({ ...settings, name: view.name })}</div>`;
}
function tournamentLobby(view) {
  const url = `${location.origin}${appPath(`/tournament/${view.id}`)}`;
  const me = view.you.entrant;
  const list = view.entrants
    .map((entrant, seat) => {
      const color = `c-s${seat % 8}`;
      const remove = view.you.host && entrant.id !== me ? `<button type="button" class="close-btn c-fw small-x" data-tournament-remove="${e(entrant.id)}" aria-label="Remove ${e(entrant.name)}">${icon("xmark.circle.fill", 26)}</button>` : "";
      return `<div class="list-item ${color}">${avatarBadge(entrant.avatar, color)}<div class="grow"><strong>${entrant.id === me ? youStar() : ""}${e(entrant.name)}</strong><small>${entrant.id === view.host ? "Host" : entrant.ai ? "AI opponent" : "Player"}${entrant.ai ? "" : ` · ${statNumber(entrant.rating)} MMR`}</small></div>${remove}</div>`;
    })
    .join("");
  const count = view.entrants.length;
  const hint = view.can_start
    ? view.fill === "ai"
      ? "The host starts when everyone is in. AI opponents fill any places left over."
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
    <div class="stack"><h1 class="page-title">${e(view.name)}</h1>${tournamentPills(view)}</div>
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
function matchCard(view, match, titled = false) {
  const rows = matchPlayers(view, match)
    .map(
      (player) =>
        `<div class="bracket-player${player.won ? " won" : ""}${player.lost ? " lost" : ""}${player.entrant ? "" : " tbd"}${player.mine ? " mine" : ""}"><span class="seed">${player.entrant?.seed ?? ""}</span><span class="who">${player.mine ? youStar() : ""}${e(player.name)}${player.entrant?.ai ? `<small>AI</small>` : ""}</span><b>${player.won ? glyph("checkmark", 12) : ""}${e(String(player.score))}</b></div>`,
    )
    .join("");
  const note = match.status === "live" ? `<span class="live">Live · game ${match.live?.game ?? 1}</span>` : { forfeit: "Forfeit", awarded: "Awarded", bye: "Bye" }[match.note] || (match.status === "done" && match.winner === null ? "Drawn" : "");
  return `<div class="bracket-match ${match.status} ${match.status === "live" ? "c-p1" : "c-fw"}">${titled || note ? `<div class="bracket-meta"><span>${titled ? e(match.label) : ""}</span><span>${note}</span></div>` : ""}${rows}${matchAction(view, match)}</div>`;
}
function bracketHtml(view) {
  const section = (bracket, title) => {
    // a place where two byes "met" is only scaffolding: leave it out
    const matches = view.matches.filter((match) => match.bracket === bracket && !match.players.every((id) => id === "bye"));
    if (!matches.length) return "";
    const rounds = [...new Set(matches.map((match) => match.round))].sort((a, b) => a - b);
    return `<section class="bracket-section">${title ? `<h3>${title}</h3>` : ""}<div class="bracket" role="group" aria-label="${title || "Bracket"}">${rounds
      .map((round) => {
        const list = matches.filter((match) => match.round === round);
        return `<div class="bracket-round"><h4>${e(list[0].label)}</h4>${list.map((match) => matchCard(view, match)).join("")}</div>`;
      })
      .join("")}</div></section>`;
  };
  if (view.format !== "round_robin") return section("W", view.format === "double" ? "Winners bracket" : "") + section("L", "Losers bracket") + section("F", "Grand final");
  const rounds = [...new Set(view.matches.map((match) => match.round))].sort((a, b) => a - b);
  return rounds
    .map((round) => {
      const out = entrantOf(view, view.sitting_out?.[round]);
      return `<section class="bracket-section"><h3>Round ${round}${out ? `<small> · ${e(out.name)} sits out</small>` : ""}</h3><div class="bracket robin">${view.matches
        .filter((match) => match.round === round)
        .map((match) => matchCard(view, match))
        .join("")}</div></section>`;
    })
    .join("");
}
function standingsHtml(view) {
  const robin = view.format === "round_robin";
  const rows = view.standings
    .map((row, rank) => {
      const entrant = entrantOf(view, row.id);
      if (!entrant) return "";
      const status = view.champion === row.id ? "Champion" : entrant.withdrawn ? "Left" : entrant.out ? "Out" : view.status === "finished" ? "" : "In";
      return `<tr class="${entrant.id === view.you.entrant ? "mine" : ""}"><th scope="row">${rank + 1}</th><td>${entrant.id === view.you.entrant ? youStar() : ""}${e(entrant.name)}${entrant.ai ? ` <small>AI</small>` : ""}</td><td>${robin ? `${row.wins}–${row.draws}–${row.losses}` : `${row.wins}–${row.losses}`}</td><td>${robin ? statNumber(row.points) : status}</td></tr>`;
    })
    .join("");
  return `<div class="table-wrap"><table><thead><tr><th scope="col">#</th><th scope="col">Player</th><th scope="col">${robin ? "W–D–L" : "W–L"}</th><th scope="col">${robin ? "Card pts" : "Status"}</th></tr></thead><tbody>${rows}</tbody></table></div>${robin ? `<p class="hint dark">Ranked by matches won (a draw counts half), then fewest card points.</p>` : ""}`;
}
function tournamentDashboard(view) {
  const me = entrantOf(view, view.you.entrant);
  const champion = entrantOf(view, view.champion);
  const live = view.matches.filter((match) => match.status === "live");
  const done = view.matches.filter((match) => match.status === "done" && match.note !== "bye").length;
  const total = view.matches.filter((match) => !match.players.includes("bye")).length;
  const banner =
    view.status === "finished"
      ? `<section class="panel c-p3 stat-hero tournament-hero"><span class="leader-trophy">${tilted("trophy.fill", 48, { key: "tournament-trophy" })}</span><p><strong>${champion ? `${champion.id === me?.id ? youStar() : ""}${e(champion.name)}` : "Nobody"}</strong> ${champion ? "wins the tournament!" : "won this one."}</p></section>`
      : "";
  const mine = !me
    ? ""
    : view.you.room_id
      ? `<section class="panel c-p1 tournament-you"><p><strong>Your match is on.</strong></p><button type="button" class="btn c-p1" data-tournament-play="${e(view.you.room_id)}">${tilted("play.fill", 28)}<span>${padTag("y")}Play your match</span></button></section>`
      : view.status === "live"
        ? `<p class="hint dark">${me.out ? "You're out of this one. Thanks for playing! You can still watch." : "Waiting for your next match. You'll be taken to it when it's ready."}</p>`
        : "";
  const ongoing = live.length
    ? `<section class="stack"><h2 class="section-title">Matches in play</h2><div class="list">${live
        .map((match) => {
          const [first, second] = matchPlayers(view, match);
          const now = match.live?.scores ? ` · this game ${match.live.scores[0]} to ${match.live.scores[1]}` : "";
          return `<div class="list-item c-s4"><div class="grow"><strong>${first.mine ? youStar() : ""}${e(first.name)} <span class="versus">${e(String(first.score))} – ${e(String(second.score))}</span> ${second.mine ? youStar() : ""}${e(second.name)}</strong><small>${e(match.label)} · game ${match.live?.game ?? 1}${now}</small></div>${matchAction(view, match)}</div>`;
        })
        .join("")}</div></section>`
    : view.status === "live"
      ? `<p class="hint dark">The next matches are being set up.</p>`
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
  return `<div class="page top scroll tournament-page">${pageHead(`data-nav="${tournamentBack}"`, view.name, leave)}<div class="stack wide">
    ${tournamentPills(view)}
    <p class="hint dark">${view.status === "finished" ? "Finished" : "In progress"} · ${done} of ${total} matches played · ${view.entrants.length} entrants</p>
    ${banner}${mine}${ongoing}
    <section class="stack"><h2 class="section-title">${view.format === "round_robin" ? "Rounds" : "Bracket"}</h2>${bracketHtml(view)}</section>
    <section class="stack"><h2 class="section-title">Standings</h2>${standingsHtml(view)}</section>
    ${stuck}
    </div></div>`;
}
function renderTournament() {
  const view = tournament;
  if (!view || page !== "tournament") return;
  const signature = JSON.stringify([view, tournamentArmed]);
  if (signature === tournamentDrawn) return;
  tournamentDrawn = signature;
  document.title = `${view.name} · Golf`;
  chipMatch = { ...view.settings, name: view.name };
  // what the host has open stays open through a redraw
  const tools = !!root.querySelector?.(".tournament-host")?.open;
  const scroll = root.querySelector?.(".bracket")?.scrollLeft || 0;
  show("tournament", view.status === "open" ? tournamentLobby(view) : tournamentDashboard(view));
  const host = root.querySelector?.(".tournament-host");
  if (host && tools) host.open = true;
  const bracket = root.querySelector?.(".bracket");
  if (bracket && scroll) bracket.scrollLeft = scroll;
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
