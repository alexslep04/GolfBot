"use strict";
// The game table. Card elements persist between server updates, so every
// change — yours, an opponent's, or the bot's — animates from where the card
// was to where it goes. Cards are moved by dragging; double-tap flips.

const SUIT_ICON = {
  S: "suit.spade.fill",
  H: "suit.heart.fill",
  D: "suit.diamond.fill",
  C: "suit.club.fill",
};
const SUIT_NAME = { S: "spades", H: "hearts", D: "diamonds", C: "clubs" };
const OPPONENT_COLORS = ["c-p2", "c-p3", "c-p4"];
const RULE_ICON = {
  royal_pairs: "crown.fill",
  devils_row: "flame.fill",
  gamblers_row: "dice.fill",
  angels_row: "sparkles",
  king_queen: "paintpalette.fill",
  holdem: "hand.raised.fill",
  v10: "v.circle",
  tricky_straights: "stairs",
  ripped_five: "scissors",
  roman_fives: "building.columns.fill",
  beggars: "questionmark.circle.fill",
  four_kind: "square.grid.2x2.fill",
  poisoned_card: "flag.pattern.checkered",
  suited_rows: "rectangle.split.3x1.fill",
  all_in_color: "circle.lefthalf.filled",
};
// Rules with more than one way to trigger get a sticker per variant, drawn from
// one visual family so they read as siblings: [symbol, what it means].
const RULE_VARIANTS = {
  royal_pairs: [
    ["j.circle.fill", "Jack pair"],
    ["q.circle.fill", "Queen pair"],
  ],
  king_queen: [
    ["equal.circle.fill", "Same colour: 5 pts"],
    ["notequal.circle.fill", "Different colours: 15 pts"],
  ],
  holdem: [
    ["heart.circle.fill", "Flush"],
    ["arrow.right.circle.fill", "Straight"],
    ["house.circle.fill", "Full house"],
    ["4.circle.fill", "Four of a kind"],
  ],
  tricky_straights: [
    ["arrow.up.right.circle.fill", "Ascending: adds to opponents"],
    ["arrow.down.right.circle.fill", "Descending: subtracts from you"],
  ],
  suited_rows: [
    ["suit.diamond.fill", "Red row: adds to opponents"],
    ["suit.club.fill", "Black row: subtracts from you"],
  ],
  all_in_color: [
    ["suit.heart.fill", "All red: opponents ×2"],
    ["suit.spade.fill", "All black: your score ÷2"],
  ],
};
// The server describes active effects as text; this maps each back to its rule.
const EFFECT_RULE = [
  [/Ripped 5/, "ripped_five"],
  [/V10/, "v10"],
  [/Roman/, "roman_fives"],
  [/Gamblers/, "gamblers_row"],
  [/Angels/, "angels_row"],
  [/Devils/, "devils_row"],
  [/Hold/, "holdem"],
  [/traight row/, "tricky_straights"],
  [/uited row/, "suited_rows"],
  [/All in/, "all_in_color"],
  [/Poisoned/, "poisoned_card"],
  [/King-Queen/, "king_queen"],
];
const HAND_TILT = [
  [-0.6, 0.6, -0.4, -0.8, -0.4, 0.5],
  [-0.4, 0.6, -0.4, -0.8, -0.4, 0.5],
];
const DRAG_START = 7; // px of travel before a press becomes a drag
const DOUBLE_TAP_MS = 400;

const board = {
  el: null,
  key: "",
  view: null,
  slots: new Map(),
  selected: [],
  drag: null,
  hover: null,
  lastTap: null,
  pendingDrop: null,
  emotesOpen: false,
  summaryHidden: false,
  signatures: {},
  viewedOpponent: null,
  viewedTurn: "",
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const hasRef = (list, ref) => list.some((item) => same(item, ref));
const refKey = (ref) => `${ref[0]}:${ref[1] ?? ""}`;
const cardKey = (card) => (card ? card.label + card.suit : "X");
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));

/* ---------- which opponent is shown ---------- */
function opponentSeat() {
  const g = state.game,
    order = g.turn_order;
  const turn = `${state.id}:${state.round}:${g.turns}:${g.current}`;
  if (
    turn !== board.viewedTurn ||
    board.viewedOpponent === state.viewer ||
    !order.includes(board.viewedOpponent)
  ) {
    board.viewedTurn = turn;
    board.viewedOpponent =
      g.current === state.viewer
        ? order[(order.indexOf(g.current) + 1) % order.length]
        : g.current;
  }
  return board.viewedOpponent;
}
function otherPlayers() {
  return state.game.turn_order.filter((p) => p !== state.viewer);
}
function cycleOpponent(direction) {
  if (!state?.game || state.names.length < 3) return;
  const others = otherPlayers();
  const current = opponentSeat();
  board.viewedOpponent =
    others[
      (others.indexOf(current) + direction + others.length) % others.length
    ];
  renderBoard();
}
function colorFor(player) {
  if (player === state.viewer) return "c-p1";
  const seats = state.names.map((_, p) => p).filter((p) => p !== state.viewer);
  return OPPONENT_COLORS[seats.indexOf(player) % OPPONENT_COLORS.length];
}

/* ---------- card markup ---------- */
function faceHtml(card) {
  if (!card)
    return `<span class="face front"></span><span class="face back"></span>`;
  const red = card.suit === "H" || card.suit === "D";
  const corner = `<span class="corner"><b>${e(card.label)}</b>${icon(SUIT_ICON[card.suit], 16, { idle: false, flat: true, sw: 2.4 })}</span>`;
  return `<span class="face front${red ? " red" : ""}">${corner}${corner}</span><span class="face back"></span>`;
}
function slotHtml(ref, tilt, extra = "") {
  return `<button type="button" class="slot ${extra}" data-ref='${e(JSON.stringify(ref))}' style="--rot:${tilt}deg"><span class="shadow"></span><span class="card"><span class="card-flip">${faceHtml(null)}</span><span class="lock">${icon("lock.fill", 28, { idle: false })}</span></span><span class="move-label"></span></button>`;
}
function cardName(card) {
  return `${{ A: "Ace", J: "Jack", Q: "Queen", K: "King" }[card.label] || card.label} of ${SUIT_NAME[card.suit]}`;
}

/* ---------- mounting ---------- */
function mountBoard() {
  const me = state.viewer;
  const hand = (player, tilts) =>
    tilts.map((tilt, i) => slotHtml([player, i], tilt)).join("");
  root.innerHTML = `<div class="board" data-board>
    <section class="b-top">
      <div class="b-main">
        <button type="button" class="tag tag-rules" data-rules-for="opp"><span class="tag-in"><span class="txt"></span><span class="icons"></span></span></button>
        <div class="hand" data-hand="opp">${hand("opp", HAND_TILT[1])}</div>
      </div>
      <div class="b-side">
        <div class="tag tag-score" data-score-for="opp"><span class="tag-in"></span></div>
        <div class="practice-streak" data-practice-streak hidden></div><button type="button" class="cycle" data-cycle-next hidden></button>
      </div>
    </section>
    <section class="b-mid">
      <div class="pile">
        <div class="pile-label" data-draw-label></div>
        <div class="pile-area">
          ${slotHtml(["under", null], 97, "under")}
          ${slotHtml(["draw", null], 84)}
          ${slotHtml(["held", null], 88, "is-face held")}
        </div>
      </div>
      <div class="pile">
        <div class="pile-label">discards</div>
        <div class="pile-area">${slotHtml(["discard", null], 90.6, "is-face")}</div>
      </div>
    </section>
    <div class="bottom-wrap">
      <section class="b-bottom">
        <div class="b-side">
          <div class="board-extra"></div>
          <div class="board-btns">
            <button type="button" class="icon-btn" data-game-menu aria-label="Table menu">${icon("gear", 44)}</button>
            <button type="button" class="icon-btn" data-emotes aria-label="Quick emotes">${icon("text.bubble.fill", 44)}</button>
          </div>
          <div class="tag tag-score c-p1" data-score-for="me"><span class="tag-in"></span></div>
        </div>
        <div class="b-main">
          <div class="hand" data-hand="me">${hand(me, HAND_TILT[0])}</div>
          <button type="button" class="tag tag-rules c-p1" data-rules-for="me"><span class="tag-in"><span class="txt"></span><span class="icons"></span></span></button>
        </div>
      </section>
      <div class="actionbar" data-actionbar></div>
    </div>
    <div class="callout" hidden></div>
    <div class="layer" data-emote-pop></div>
    <div class="layer" data-emote-layer></div>
    <div class="layer" data-summary></div>
    <div class="layer" data-modal></div>
  </div>`;
  board.el = root.querySelector("[data-board]");
  board.signatures = {};
  board.view = null;
  board.selected = [];
  board.drag = null;
  board.pendingDrop = null;
  board.emotesOpen = false;
  board.summaryHidden = false;
  board.el.addEventListener("pointerdown", onBoardPointerDown);
  board.el.addEventListener("pointermove", onBoardPointerMove);
  board.el.addEventListener("pointerup", onBoardPointerUp);
  board.el.addEventListener("pointercancel", onBoardPointerCancel);
  board.el.addEventListener("pointerleave", () => setHover(null));
  board.el.addEventListener("contextmenu", (event) => {
    if (event.target.closest(".slot")) event.preventDefault();
  });
}
function indexSlots(opponent) {
  board.slots.clear();
  board.el.querySelectorAll(".slot").forEach((slot) => {
    let ref = JSON.parse(slot.dataset.ref);
    if (slot.closest("[data-hand='opp']")) {
      ref = [opponent, ref[1]];
      slot.dataset.ref = JSON.stringify(ref);
    }
    board.slots.set(refKey(ref), slot);
  });
}
const slotFor = (ref) => board.slots.get(refKey(ref));

/** Replace an element's contents only when what it shows has changed. */
function patch(key, element, signature, html) {
  if (board.signatures[key] === signature) return false;
  board.signatures[key] = signature;
  element.innerHTML = typeof html === "function" ? html() : html;
  return true;
}

/* ---------- view model ---------- */
function boardView() {
  const g = state.game,
    me = state.viewer,
    opp = opponentSeat();
  const hand = (player) =>
    g.players[player].map((slot) => ({
      key: slot.visible ? cardKey(slot.card) : "X",
      card: slot.card,
      locked: slot.locked,
    }));
  const table = {};
  for (const player of [me, opp])
    hand(player).forEach((slot, i) => (table[`${player}:${i}`] = slot));
  table["discard:"] = { key: g.discard ? cardKey(g.discard) : "", card: g.discard };
  table["held:"] = { key: g.held ? cardKey(g.held) : "", card: g.held };
  table["draw:"] = { key: g.draw_count > 0 ? "X" : "", card: null };
  table["under:"] = { key: g.draw_count > 1 ? "X" : "", card: null };
  return { id: state.id, round: state.round, me, opp, table, phase: g.phase };
}
function applySlot(slot, entry, ref) {
  const key = entry.key;
  if (slot.dataset.key !== key) {
    slot.dataset.key = key;
    slot.querySelector(".card-flip").innerHTML = faceHtml(entry.card);
  }
  const faceUp = key !== "" && key !== "X";
  slot.classList.toggle("is-face", faceUp);
  slot.classList.toggle("empty", key === "");
  slot.classList.toggle("locked", !!entry.locked);
  if (ref[0] === "under") {
    slot.setAttribute("aria-hidden", "true");
    slot.tabIndex = -1;
    return;
  }
  const owner =
    ref[0] === state.viewer
      ? "Your"
      : typeof ref[0] === "number"
        ? `${state.names[ref[0]]}'s`
        : "";
  slot.setAttribute(
    "aria-label",
    ref[0] === "draw"
      ? "Go-fish pile"
      : ref[0] === "discard"
        ? `Discard pile, ${entry.card ? cardName(entry.card) : "empty"}`
        : ref[0] === "held"
          ? `Drawn card, ${entry.card ? cardName(entry.card) : "none"}`
          : `${owner} ${faceUp ? cardName(entry.card) : "face-down card"}${entry.locked ? ", locked" : ""}, row ${Math.floor(ref[1] / 3) + 1}, column ${(ref[1] % 3) + 1}`,
  );
}

/* ---------- rendering ---------- */
function renderBoard() {
  if (!state?.game) return;
  const key = `${state.id}:${state.viewer}`;
  if (!board.el || !board.el.isConnected || board.key !== key) {
    board.key = key;
    mountBoard();
  }
  document.documentElement.classList.add("in-game");
  const view = boardView();
  syncCards(board.view, view);
  board.view = view;
  renderTags();
  renderChrome();
  paintSelection();
}

function syncCards(prev, view) {
  const fresh = !prev || prev.id !== view.id || prev.round !== view.round;
  const opponentChanged = fresh || prev.opp !== view.opp;
  if (opponentChanged) indexSlots(view.opp);
  const before = prev ? prev.table : {};
  const after = view.table;
  const changedKeys = Object.keys(after).filter(
    (key) => !before[key] || before[key].key !== after[key].key,
  );
  if (!fresh && !opponentChanged && !changedKeys.length) {
    for (const [key, entry] of Object.entries(after))
      applySlot(board.slots.get(key), entry, JSON.parse(board.slots.get(key).dataset.ref));
    return;
  }
  cancelFlights();
  // A card the player just dropped starts its flight from where it was released.
  const drop = board.pendingDrop;
  board.pendingDrop = null;
  const dropPose = drop ? drop.pose : null;
  if (drop) {
    const slot = board.slots.get(drop.key);
    if (slot) {
      motionFor(slot).reset();
      slot.classList.remove("dragging", "returning");
    }
  }
  const pose = (key) =>
    drop && drop.key === key ? dropPose : poseOf(board.slots.get(key));
  const poses = {};
  for (const key of Object.keys(after)) poses[key] = pose(key);
  for (const [key, entry] of Object.entries(after)) {
    const slot = board.slots.get(key);
    if (changedKeys.includes(key)) motionFor(slot).reset();
    applySlot(slot, entry, JSON.parse(slot.dataset.ref));
  }
  if (fresh) {
    if (view.phase === "setup") dealIn(view);
    return;
  }
  if (opponentChanged) {
    board.el
      .querySelectorAll("[data-hand='opp'] .slot")
      .forEach((slot, i) => setTimeout(() => popSlot(slot, 0.7), i * 28));
    return;
  }
  const fly = (fromKey, toKey, card, faceFrom, delay = 0) =>
    flyCard({
      html: faceHtml(card),
      from: poses[fromKey],
      to: board.slots.get(toKey),
      faceFrom,
      faceTo: !!card && after[toKey].key !== "X",
      delay,
    });
  const handKeys = changedKeys.filter((key) => /^\d+:/.test(key));
  const handled = new Set();
  const held = before["held:"],
    discard = before["discard:"];
  const discardChanged = discard.key !== after["discard:"].key;
  if (!held.key && after["held:"].key) {
    // drew from the go-fish pile
    fly("draw:", "held:", after["held:"].card, false);
  } else if (held.key && !after["held:"].key) {
    const target = handKeys.find((key) => after[key].key === held.key);
    if (target) {
      // the drawn card went into the hand; the card it replaced is discarded
      fly("held:", target, after[target].card, true);
      handled.add(target);
      if (discardChanged)
        fly(target, "discard:", after["discard:"].card, before[target].key !== "X", 60);
    } else if (discardChanged) fly("held:", "discard:", after["discard:"].card, true);
  } else if (discardChanged && discard.key) {
    const target = handKeys.find((key) => after[key].key === discard.key);
    if (target) {
      // swapped a hand card with the top discard
      fly("discard:", target, after[target].card, true);
      fly(target, "discard:", after["discard:"].card, before[target].key !== "X", 60);
      handled.add(target);
    } else popSlot(board.slots.get("discard:"));
  }
  const rest = handKeys.filter((key) => !handled.has(key));
  let reveal = 0;
  for (const key of rest) {
    if (handled.has(key)) continue;
    const slot = board.slots.get(key);
    const partner = rest.find(
      (other) =>
        other !== key &&
        !handled.has(other) &&
        after[key].key !== "X" &&
        after[other].key !== "X" &&
        after[key].key === before[other].key &&
        after[other].key === before[key].key,
    );
    if (partner) {
      // two face-up cards traded places (bonus swap, Beggars trade, 4 of a Kind)
      fly(partner, key, after[key].card, true);
      fly(key, partner, after[partner].card, true);
      handled.add(key).add(partner);
    } else if (before[key].key === "X" && after[key].key !== "X")
      flipSlot(slot, true, reveal++ * 70);
    else if (after[key].key === "X") flipSlot(slot, false, reveal++ * 70);
    else popSlot(slot);
  }
}

/** New game: the hands are dealt out of the go-fish pile. */
function dealIn(view) {
  const from = poseOf(board.slots.get("draw:"));
  let order = 0;
  for (const player of [view.opp, view.me])
    for (let i = 0; i < 6; i++) {
      const key = `${player}:${i}`;
      const entry = view.table[key];
      flyCard({
        html: faceHtml(entry.card),
        from,
        to: board.slots.get(key),
        faceFrom: false,
        faceTo: entry.key !== "X",
        delay: order++ * 45,
      });
    }
}

function scoreDigits(value) {
  const text = String(value);
  return `<span class="digits${text.length > 2 ? " long" : ""}">${stickerText(text, { split: true })}</span>${stickerText("pts", { cls: "pts" })}`;
}
/**
 * The stickers a hand has earned: one per rule (or rule variant) that is
 * affecting that player right now. Rules that are merely enabled show nothing.
 */
function ruleStickers(player) {
  const g = state.game,
    stickers = [];
  const add = (rule, variant) => {
    const glyph =
      variant === undefined
        ? RULE_ICON[rule] || "star.fill"
        : RULE_VARIANTS[rule][variant][0];
    if (!stickers.some((sticker) => sticker.icon === glyph))
      stickers.push({ icon: glyph, rule });
  };
  // A Jack or Queen pair earns a bonus swap; it has no score line of its own.
  if (state.rules.royal_pairs)
    for (let column = 0; column < 3; column++) {
      const top = g.players[player][column],
        bottom = g.players[player][column + 3];
      if (
        top.visible &&
        bottom.visible &&
        top.card.rank === bottom.card.rank &&
        [11, 12].includes(top.card.rank)
      )
        add("royal_pairs", top.card.rank === 11 ? 0 : 1);
    }
  for (const effect of g.effects[player] || []) {
    const rule = EFFECT_RULE.find(([pattern]) => pattern.test(effect))?.[1];
    if (!rule) continue;
    if (rule === "king_queen") add(rule, /: 5 \(/.test(effect) ? 0 : 1);
    else if (rule === "holdem")
      ["flush", "straight", "full house", "four kind"].forEach(
        (hand, variant) => effect.includes(hand) && add(rule, variant),
      );
    else if (rule === "tricky_straights")
      add(rule, /Incoming|opponent/.test(effect) ? 0 : 1);
    else if (rule === "suited_rows")
      add(rule, /Incoming|opponents/.test(effect) ? 0 : 1);
    else if (rule === "all_in_color") add(rule, /red/.test(effect) ? 0 : 1);
    else add(rule);
  }
  return stickers;
}
function activeRules(player) {
  if (state.game.rule_previews) return Object.keys(state.game.rule_previews[player] || {});
  return [...new Set(ruleStickers(player).map((sticker) => sticker.rule))];
}
function ruleDelta(player) {
  const g = state.game;
  return g.effect_totals[player] - g.scores[player];
}
function renderTags() {
  const g = state.game;
  for (const [side, player] of [
    ["me", state.viewer],
    ["opp", board.view.opp],
  ]) {
    const enabled = (g.modifier_counts || state.modifier_counts || [])[player] ?? 0;
    const label = state.names[player] + (state.rated ? ` (${state.ratings[player]})` : "");
    const color = colorFor(player);
    const scoreTag = board.el.querySelector(`[data-score-for='${side}']`);
    const rulesTag = board.el.querySelector(`[data-rules-for='${side}']`);
    for (const tag of [scoreTag, rulesTag]) {
      tag.classList.remove("c-p1", ...OPPONENT_COLORS);
      tag.classList.add(color);
    }
    const score = g.phase === "over" ? g.scores[player] : g.effect_totals[player];
    const offline = !state.connected[player] && !state.solo;
    scoreTag.classList.toggle("offline", offline);
    const changed = patch(
      `score-${side}`,
      scoreTag.firstElementChild,
      `${player}|${label}|${score}`,
      () =>
        `<span class="who">${e(label)}</span><span class="score">${scoreDigits(score)}</span>`,
    );
    if (changed && board.signatures[`seen-${side}`] === player) {
      const element = scoreTag.querySelector(".score");
      element.classList.add("bump");
    }
    board.signatures[`seen-${side}`] = player;
    scoreTag.setAttribute(
      "aria-label",
      `${state.names[player]}: ${score} points${offline ? ", offline" : ""}`,
    );
    const delta = g.phase === "over" ? 0 : ruleDelta(player);
    const stickers = ruleStickers(player);
    patch(
      `rules-txt-${side}`,
      rulesTag.querySelector(".txt"),
      `${enabled}|${delta}`,
      `${enabled} Modifier${enabled === 1 ? "" : "s"} in<br>play (${delta > 0 ? "+" : ""}${delta}pts)`,
    );
    patch(
      `rules-ico-${side}`,
      rulesTag.querySelector(".icons"),
      `${color}|${stickers.map((sticker) => sticker.icon).join()}`,
      () =>
        stickers
          .slice(0, 3)
          .map((sticker, i) =>
            tilted(sticker.icon, 36, { tilt: [-13, -4, 16][i] }),
          )
          .join(""),
    );
    rulesTag.setAttribute(
      "aria-label",
      `${state.names[player]}: ${enabled} modifiers in play, ${delta} points from rules. Open details.`,
    );
  }
  const flame = board.el.querySelector("[data-practice-streak]");
  flame.hidden = !state.practice;
  if (state.practice) {
    const streak = state.streak || {current:0,best:0,draws:0};
    flame.classList.toggle("streak-grey", !streak.current || streak.draws === 1);
    patch("practice-streak", flame, String(streak.current ?? 0), () => `${icon("flame.fill", 58, {idle:false})}<b class="streak-count">${streak.current ?? 0}</b>`);
    flame.setAttribute("aria-label", `Practice streak: ${streak.current}. Best: ${streak.best}. Consecutive draws: ${streak.draws}.`);
    flame.title = `Best streak: ${streak.best}`;
  }
  // cycle button shows the next opponent in line, in their color
  const cycle = board.el.querySelector("[data-cycle-next]");
  const others = otherPlayers();
  cycle.hidden = others.length < 2;
  if (others.length > 1) {
    const next = others[(others.indexOf(board.view.opp) + 1) % others.length];
    cycle.classList.remove(...OPPONENT_COLORS);
    cycle.classList.add(colorFor(next));
    patch(
      "cycle",
      cycle,
      `${next}|${state.names[next]}`,
      () =>
        `${icon("arrow.trianglehead.2.clockwise.rotate.90", 44)}<span>${e(state.names[next])}</span>`,
    );
    cycle.setAttribute(
      "aria-label",
      `Show ${state.names[next]}'s cards. Swipe to browse opponents.`,
    );
  }
  board.el.querySelector("[data-draw-label]").textContent =
    `go-fish pile (${g.draw_count})`;
}

function promptText() {
  const g = state.game,
    me = state.viewer;
  if (state.status === "closed") return ["Table closed", "me"];
  if (state.status !== "playing") return [null, "me"];
  const final = g.final_turn ? "Final turn · " : "";
  if (g.phase === "setup")
    return g.legal.flip.length
      ? [`Double-tap ${2 - g.players[me].filter((s) => s.visible).length === 1 ? "one more card" : "two cards"} to flip`, "me"]
      : ["Waiting for opening flips…", "opp"];
  if (g.decision_player !== me)
    return [`${final}${state.names[g.decision_player]}'s turn`, "opp"];
  return [
    final +
      ({
        choose: "Your turn",
        revealed: "Swap it, draw, or end turn",
        drawn: "Place your card or discard it",
        drawn_revealed: "Swap with the flipped card or discard",
        bonus: `Bonus swap! Drag any two cards together`,
        guess: "Guess the hidden card",
        guess_trade: "Correct! Trade the highlighted cards",
        arrange: "Arrange your four of a kind",
      }[g.phase] || "Your turn"),
    "me",
  ];
}
function placeCallout() {
  const callout = board.el?.querySelector(".callout");
  if (!callout || callout.hidden) return;
  const box = board.el.getBoundingClientRect();
  const top = board.el.querySelector(".b-top").getBoundingClientRect();
  const mid = board.el.querySelector(".b-mid").getBoundingClientRect();
  const bottom = board.el.querySelector(".b-bottom").getBoundingClientRect();
  const anchor =
    callout.dataset.anchor === "card" ? slotFor([state.viewer, 0]) : null;
  if (anchor) {
    // the opening hint points straight at the first card of your hand
    const card = anchor.getBoundingClientRect();
    const half = callout.offsetWidth / 2 + 6;
    const x = clamp(card.left + card.width / 2 - box.left, half, box.width - half);
    callout.style.setProperty("--callout-x", `${x}px`);
    callout.style.top = `${card.top - box.top - callout.offsetHeight / 2 - 10}px`;
    return;
  }
  callout.style.removeProperty("--callout-x");
  const y =
    callout.dataset.side === "opp"
      ? (top.bottom + mid.top) / 2
      : (mid.bottom + bottom.top) / 2;
  callout.style.top = `${y - box.top}px`;
}
function actionAllowed(action) {
  const g = state.game;
  if (!g || busy || state.void_offer || state.status !== "playing") return false;
  const legal = g.legal,
    picked = board.selected;
  const own = picked.length === 1 && picked[0][0] === state.viewer;
  const index = own ? picked[0][1] : null;
  if (action === "flip")
    return picked.length === 1 && picked[0][0] === "draw"
      ? legal.draw
      : own && legal.flip.includes(index);
  if (["draw", "discard", "end_turn"].includes(action)) return legal[action];
  if (action === "swap") {
    if (picked.length === 2)
      return movesFrom(picked[0]).some((move) => same(move.ref, picked[1]));
    return own && legal.swap.includes(index);
  }
  return false;
}
function renderChrome() {
  const g = state.game;
  const [text, side] = promptText();
  const callout = board.el.querySelector(".callout");
  callout.hidden = !text;
  if (text) {
    const player = side === "me" ? state.viewer : g.decision_player;
    const color = side === "me" ? "c-p1" : colorFor(player === state.viewer ? board.view.opp : player);
    callout.className = `callout ${color} ${side === "me" ? "down" : "up"}`;
    callout.dataset.side = side;
    callout.dataset.anchor =
      g.phase === "setup" && g.legal.flip.length ? "card" : "";
    if (board.signatures.callout !== text + side) {
      board.signatures.callout = text + side;
      callout.textContent = text;
      callout.classList.add("pop");
    }
    placeCallout();
  }
  // Mobile: only "End turn" needs a button — every other move is a gesture.
  const extra = board.el.querySelector(".board-extra");
  const queue = presenceState.queue;
  patch(
    "extra",
    extra,
    `${g.legal.end_turn}|${queue?.status}`,
    () =>
      `${queue && ["waiting", "offer"].includes(queue.status) ? `<button type="button" class="icon-btn queue" data-queue-view aria-label="Quickplay queue">${icon("sparkles", 32)}</button>` : ""}${g.legal.end_turn ? `<button type="button" class="btn small c-p1 end-turn" data-action="end_turn">End turn</button>` : ""}`,
  );
  const bar = board.el.querySelector("[data-actionbar]");
  const buttons = [
    ["flip", "Flip"],
    ["swap", "Swap"],
    ["draw", "Draw"],
    ["discard", "Discard"],
    ["end_turn", "End turn"],
  ];
  patch(
    "actionbar",
    bar,
    "static",
    buttons
      .map(
        ([action, label]) =>
          `<button type="button" class="btn" data-action="${action}">${label}${action === "end_turn" ? " <kbd>↵</kbd>" : ""}</button>`,
      )
      .join(""),
  );
  bar.querySelectorAll("[data-action]").forEach((button) => {
    button.disabled = !actionAllowed(button.dataset.action);
  });
  renderEmotes();
  renderSummary();
  renderModal();
}

function renderEmotes() {
  const layer = board.el.querySelector("[data-emote-layer]");
  const signature = state.names
    .map((_, p) => activeEmotes[p]?.sequence || 0)
    .join();
  patch("emotes", layer, signature + board.view.opp, () =>
    state.names.map((_, p) => playerEmote(p)).join(""),
  );
  const pop = board.el.querySelector("[data-emote-pop]");
  patch(
    "emote-pop",
    pop,
    `${board.emotesOpen}|${opponentEmotesMuted}|${state.status}`,
    () =>
      board.emotesOpen
        ? `<div class="emote-pop" role="group" aria-label="Quick emotes">${Object.entries(
            emoteNames,
          )
            .map(
              ([id, label]) =>
                `<button type="button" data-emote="${id}" aria-label="Send ${label.toLowerCase()} emote" ${state.status === "closed" ? "disabled" : ""}><img src="${appPath(`/static/emotes/${id}.png`)}" alt=""></button>`,
            )
            .join(
              "",
            )}<button type="button" data-emote-mute aria-pressed="${opponentEmotesMuted}" aria-label="${opponentEmotesMuted ? "Unmute opponent emotes" : "Mute opponent emotes"}">${icon(opponentEmotesMuted ? "bell.slash.fill" : "bell.fill", 28, { idle: false })}</button></div>`
        : "",
  );
}
function playerEmote(player) {
  if (opponentEmotesMuted && player !== state.viewer) return "";
  const item = activeEmotes[player];
  if (!item || item.ends <= Date.now()) return "";
  const age = Math.max(0, 4000 - (item.ends - Date.now()));
  const where =
    player === state.viewer ? "me" : player === board.view.opp ? "them" : "other";
  return `<div class="player-emote ${where}" data-emote-player="${player}" role="status" style="animation-delay:-${age}ms"><img src="${appPath(`/static/emotes/${item.id}.png`)}" alt="${e(state.names[player])}: ${emoteNames[item.id]} emote">${where === "other" ? `<span>${e(state.names[player])}</span>` : ""}</div>`;
}

function renderSummary() {
  const holder = board.el.querySelector("[data-summary]");
  const over = ["round_over", "finished", "closed"].includes(state.status);
  if (!over) {
    board.summaryHidden = false;
    patch("summary", holder, "", "");
    return;
  }
  const viewer = state.viewer;
  const result = state.history.at(-1);
  const finished = state.status === "finished";
  const closed = state.status === "closed";
  const title = closed
    ? "Table closed"
    : finished
      ? state.champion === null
        ? "Series drawn"
        : state.champion === viewer
          ? "You win the series!"
          : `${state.names[state.champion]} wins the series`
      : result.winner === null
        ? "Game drawn"
        : result.winner === viewer
          ? "You win this game!"
          : `${state.names[result.winner]} wins this game`;
  const signature = [
    state.status,
    state.round,
    state.ready.join(),
    board.summaryHidden,
    state.history.length,
  ].join("|");
  patch("summary", holder, signature, () => {
    if (board.summaryHidden)
      return `<div class="summary mini"><button type="button" class="btn small c-p1" data-summary-toggle>${glyph("chevron.up", 16)} Results</button></div>`;
    const rows =
      result && !closed
        ? state.names
            .map(
              (name, p) =>
                `<div class="${result.winner === p ? "win" : ""}"><span>${e(name)}${p === viewer ? " (you)" : ""}</span><b>${result.scores[p]} pts${state.names.length > 2 || state.best_of !== 1 ? ` · ${state.series_mode === "points" ? state.points[p] + " total" : state.wins[p] + (state.wins[p] === 1 ? " win" : " wins")}` : ""}</b></div>`,
            )
            .join("")
        : "";
    const action = closed
      ? `<button type="button" class="btn c-p1" data-leave>${tilted("house.fill", 28)} Back to menu</button>`
      : state.status === "round_over"
        ? `<button type="button" class="btn c-p1" data-action="next_round" ${state.ready[viewer] ? "disabled" : ""}>${state.ready[viewer] ? "Waiting for others…" : `${tilted("play.fill", 28)} Next game`}</button>`
        : viewer === 0
          ? `<div class="row"><button type="button" class="btn round c-fw" data-leave aria-label="Back to menu">${icon("house.fill", 24, { idle: false })}</button><button type="button" class="btn c-p1 grow" data-action="rematch">${tilted("arrow.clockwise", 28)} Play again</button></div>`
          : `<p class="hint dark">The host can start a rematch.</p><button type="button" class="btn c-fw" data-leave>Back to menu</button>`;
    return `<section class="summary panel ${closed ? "c-p2" : "c-fw"}" role="dialog" aria-label="Results"><h2>${e(title)}</h2>${closed ? `<p style="margin:1rem 0;text-align:center">${e(state.message)}</p>` : `<div class="scores">${rows}</div>`}<div class="stack">${action}${closed ? "" : `<button type="button" class="btn small c-fw" data-summary-toggle>${glyph("eye.fill", 20)} View table</button>`}</div></section>`;
  });
}

function renderModal() {
  const holder = board.el.querySelector("[data-modal]");
  const g = state.game;
  if (g.legal.guess) {
    const target = g.guess_target;
    patch(
      "modal",
      holder,
      `guess${target}`,
      () =>
        `<div class="modal-shade"><section class="modal panel c-p4" role="dialog" aria-modal="true" aria-label="Beggars rank guess"><h2>Beggars Will be Choosers</h2><p>Guess the hidden card in row ${Math.floor(target / 3) + 1}, column ${(target % 3) + 1}.</p><div class="ranks">${Array.from({ length: 13 }, (_, i) => `<button type="button" class="btn c-p4" data-guess="${i + 1}">${{ 1: "A", 11: "J", 12: "Q", 13: "K" }[i + 1] || i + 1}</button>`).join("")}</div><button type="button" class="btn small c-fw" data-guess="pass" style="width:100%">Pass</button></section></div>`,
    );
  } else if (g.legal.keep_layout) {
    patch(
      "modal",
      holder,
      `arrange${JSON.stringify(g.legal.arrange)}`,
      () =>
        `<div class="modal-shade"><section class="modal panel c-p4" role="dialog" aria-modal="true" aria-label="Arrange four of a kind"><h2>4 of a Kind</h2><p>Choose two columns for the four matching cards, or keep your layout. Hidden cards stay hidden.</p><div class="cols">${[
          [0, 1],
          [0, 2],
          [1, 2],
        ]
          .map(
            (cols) =>
              `<button type="button" class="btn c-p4" data-columns="${cols.join(",")}" ${g.legal.arrange.some((c) => same(c, cols)) ? "" : "disabled"}>Columns ${cols[0] + 1} + ${cols[1] + 1}</button>`,
          )
          .join(
            "",
          )}</div><button type="button" class="btn small c-fw" data-columns="keep" style="width:100%">Keep layout</button></section></div>`,
    );
  } else patch("modal", holder, "", "");
}

/* ---------- moves ---------- */
/** Every legal destination for a card, with the label shown while dragging. */
function movesFrom(source) {
  const g = state?.game;
  if (!g || state.void_offer || state.status !== "playing") return [];
  const legal = g.legal,
    me = state.viewer;
  const moves = [];
  const swap = (a, b, label) =>
    moves.push({ ref: b, label, action: "swap", extra: { refs: [a, b] } });
  if (legal.bonus) {
    if (source[0] !== "held" && hasRef(g.table_refs, source))
      for (const ref of g.table_refs)
        if (!same(ref, source)) swap(source, ref, "bonus swap");
    return moves;
  }
  if (legal.trade[0].length) {
    for (const [from, to] of [legal.trade, [legal.trade[1], legal.trade[0]]])
      if (hasRef(from, source)) for (const ref of to) swap(source, ref, "trade");
    return moves;
  }
  const place = (index, ref, label) =>
    moves.push({ ref, label, action: "swap", extra: { index } });
  if (source[0] === me && legal.swap.includes(source[1]))
    g.held
      ? place(source[1], ["held", null], "swap with go-fish")
      : place(source[1], ["discard", null], "swap with discard");
  if (source[0] === "held" && g.held) {
    if (legal.discard)
      moves.push({ ref: ["discard", null], label: "discard", action: "discard", extra: {} });
    for (const index of legal.swap) place(index, [me, index], "swap");
  }
  if (source[0] === "discard" && !g.held)
    for (const index of legal.swap) place(index, [me, index], "swap");
  return moves;
}
function canFlip(ref) {
  const legal = state?.game?.legal;
  if (!legal || state.void_offer || state.status !== "playing") return false;
  return (
    (ref[0] === "draw" && legal.draw) ||
    (ref[0] === state.viewer && legal.flip.includes(ref[1]))
  );
}
function flipMove(ref) {
  return ref[0] === "draw" ? move("draw") : move("flip", { index: ref[1] });
}

function clearTargets() {
  board.el
    ?.querySelectorAll(".slot.target")
    .forEach((slot) => slot.classList.remove("target", "hot"));
}
function showTargets(moves) {
  clearTargets();
  for (const item of moves) {
    const slot = slotFor(item.ref);
    if (!slot || slot.classList.contains("empty")) continue;
    slot.classList.add("target");
    slot.querySelector(".move-label").textContent = item.label;
  }
}
function paintSelection() {
  if (!board.el) return;
  board.selected = board.selected.filter((ref) => slotFor(ref));
  board.slots.forEach((slot) => {
    const ref = JSON.parse(slot.dataset.ref);
    slot.classList.toggle("selected", hasRef(board.selected, ref));
    slot.classList.toggle(
      "can-act",
      !slot.classList.contains("empty") &&
        (canFlip(ref) || movesFrom(ref).length > 0),
    );
  });
  if (!board.drag?.active)
    showTargets(board.selected.length === 1 ? movesFrom(board.selected[0]) : []);
  board.el.querySelectorAll("[data-actionbar] [data-action]").forEach((button) => {
    button.disabled = !actionAllowed(button.dataset.action);
  });
}

/** Desktop action bar: the same moves, driven by the current selection. */
function barAction(action) {
  const picked = board.selected;
  if (action === "flip") return picked.length ? flipMove(picked[0]) : null;
  if (action === "swap") {
    if (picked.length === 2) {
      const item = movesFrom(picked[0]).find((m) => same(m.ref, picked[1]));
      return item ? move(item.action, item.extra) : null;
    }
    return move("swap", { index: picked[0][1] });
  }
  return move(action);
}

/* ---------- pointer input ---------- */
function setHover(slot, event) {
  if (board.hover && board.hover !== slot && !board.hover.classList.contains("dragging"))
    motionFor(board.hover).to({ rx: 0, ry: 0, scale: 1 });
  board.hover = slot;
  if (!slot || !event || slot.classList.contains("empty")) return;
  const rect = slot.getBoundingClientRect();
  const px = (event.clientX - rect.left) / rect.width - 0.5;
  const py = (event.clientY - rect.top) / rect.height - 0.5;
  const targets = { ry: px * 20, rx: -py * 20 };
  if (!slot.classList.contains("selected"))
    targets.scale = slot.classList.contains("can-act") ? 1.06 : 1.02;
  motionFor(slot).to(targets);
}
function onBoardPointerDown(event) {
  const slot = event.target.closest(".slot");
  if (!slot || board.drag || event.button > 0 || slot.classList.contains("empty"))
    return;
  board.drag = {
    slot,
    ref: JSON.parse(slot.dataset.ref),
    pointer: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    time: performance.now(),
    velocity: 0,
    active: false,
    moves: [],
    hot: null,
  };
  try {
    slot.setPointerCapture(event.pointerId);
  } catch {}
  motionFor(slot).to({ scale: 0.95, rx: 0, ry: 0 });
}
function beginDrag(drag) {
  drag.active = true;
  board.selected = [];
  board.lastTap = null;
  paintSelection();
  drag.slot.classList.remove("returning");
  drag.slot.classList.add("dragging");
  drag.moves = movesFrom(drag.ref);
  showTargets(drag.moves);
  // the pickup "pop": overshoot the lifted size, then settle into the hand
  motionFor(drag.slot).to({ scale: 1.14, lift: 1 }).kick({ scale: 2.4 });
}
function hotTarget(drag) {
  const centre = poseOf(drag.slot);
  let best = null,
    bestDistance = Infinity;
  for (const item of drag.moves) {
    const slot = slotFor(item.ref);
    if (!slot || slot.classList.contains("empty")) continue;
    const rect = slot.getBoundingClientRect();
    const cx = rect.left + rect.width / 2,
      cy = rect.top + rect.height / 2;
    const inside =
      drag.x >= rect.left && drag.x <= rect.right && drag.y >= rect.top && drag.y <= rect.bottom;
    const distance = Math.hypot(centre.x - cx, centre.y - cy);
    const reach = Math.max(rect.width, rect.height) * 0.62;
    if ((inside || distance < reach) && distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  }
  return best;
}
function dragNote(drag, text) {
  let note = document.querySelector(".drag-note");
  if (!text) {
    note?.remove();
    return;
  }
  if (!note) {
    note = document.createElement("div");
    note.className = "drag-note";
    document.body.appendChild(note);
  }
  note.textContent = text;
  const rect = drag.slot.querySelector(".card").getBoundingClientRect();
  note.style.left = `${rect.left + rect.width / 2}px`;
  note.style.top = `${rect.top - 6}px`;
}
function onBoardPointerMove(event) {
  const drag = board.drag;
  if (!drag || event.pointerId !== drag.pointer) {
    if (event.pointerType === "mouse" && !drag)
      setHover(event.target.closest(".slot"), event);
    return;
  }
  const dx = event.clientX - drag.startX,
    dy = event.clientY - drag.startY;
  if (!drag.active) {
    if (Math.hypot(dx, dy) < DRAG_START) return;
    beginDrag(drag);
  }
  const now = performance.now();
  const elapsed = Math.max(1, now - drag.time);
  drag.velocity =
    drag.velocity * 0.6 + ((event.clientX - drag.x) / elapsed) * 1000 * 0.4;
  drag.x = event.clientX;
  drag.y = event.clientY;
  drag.time = now;
  // the card leans into its direction of travel, then swings back upright
  motionFor(drag.slot).to({
    x: dx,
    y: dy,
    lean: clamp(drag.velocity * 0.02, -20, 20),
  });
  clearTimeout(drag.settle);
  drag.settle = setTimeout(() => {
    if (board.drag === drag) motionFor(drag.slot).to({ lean: 0 });
  }, 70);
  const hot = hotTarget(drag);
  if (hot !== drag.hot) {
    if (drag.hot) slotFor(drag.hot.ref)?.classList.remove("hot");
    drag.hot = hot;
    if (hot) {
      slotFor(hot.ref).classList.add("hot");
      motionFor(drag.slot).kick({ scale: 1.2 });
    }
  }
  const drawing =
    drag.ref[0] === "draw" && state.game.legal.draw && Math.hypot(dx, dy) > 44;
  // name the move above the card being carried
  dragNote(drag, hot ? hot.label : drawing ? "release to draw" : null);
}
function releaseDrag(slot) {
  if (!slot) return;
  slot.classList.remove("dragging");
  slot.classList.add("returning");
  const motion = motionFor(slot);
  motion.to({ x: 0, y: 0, lean: 0, scale: 1, lift: 0, rx: 0, ry: 0 });
  motion.onRest = () => slot.classList.remove("returning");
}
async function onBoardPointerUp(event) {
  const drag = board.drag;
  if (!drag || event.pointerId !== drag.pointer) return;
  board.drag = null;
  clearTimeout(drag.settle);
  dragNote(drag, null);
  try {
    drag.slot.releasePointerCapture(event.pointerId);
  } catch {}
  if (!drag.active) {
    motionFor(drag.slot).to({ scale: 1 });
    if (event.type === "pointerup") tapSlot(drag.ref, drag.slot);
    return;
  }
  clearTargets();
  const travelled = Math.hypot(drag.x - drag.startX, drag.y - drag.startY);
  const drawing =
    drag.ref[0] === "draw" && state.game.legal.draw && travelled > 44;
  if (event.type !== "pointerup" || busy || (!drag.hot && !drawing)) {
    releaseDrag(drag.slot);
    paintSelection();
    return;
  }
  // Hold the card where it was dropped; the state update animates from there.
  motionFor(drag.slot).to({ lean: 0, scale: 1.04 });
  board.pendingDrop = { key: refKey(drag.ref), pose: poseOf(drag.slot) };
  const ok = drag.hot
    ? await move(drag.hot.action, drag.hot.extra)
    : await move("draw");
  if (board.pendingDrop?.key === refKey(drag.ref)) board.pendingDrop = null;
  if (!ok || drag.slot.classList.contains("dragging")) releaseDrag(drag.slot);
}
function onBoardPointerCancel(event) {
  onBoardPointerUp(event);
}

/** A tap selects; tapping a highlighted destination plays the move; a double-tap flips. */
function tapSlot(ref, slot) {
  if (!state?.game || state.void_offer || state.status !== "playing") return;
  if (ref[0] === "under") return;
  const now = performance.now();
  const last = board.lastTap;
  if (
    !busy &&
    canFlip(ref) &&
    last &&
    last.version === state.version &&
    same(last.ref, ref) &&
    now - last.time <= DOUBLE_TAP_MS
  ) {
    board.lastTap = null;
    board.selected = [];
    paintSelection();
    flipMove(ref);
    return;
  }
  board.lastTap = canFlip(ref) ? { ref, time: now, version: state.version } : null;
  if (board.selected.length === 1 && !same(board.selected[0], ref)) {
    const item = movesFrom(board.selected[0]).find((m) => same(m.ref, ref));
    if (item && !busy) {
      board.selected = [];
      paintSelection();
      move(item.action, item.extra);
      return;
    }
  }
  board.selected = hasRef(board.selected, ref) ? [] : [ref];
  popSlot(slot, 0.45);
  paintSelection();
}

/* ---------- swipe between opponents on the cycle button ---------- */
let cycleSwipe = null;
document.addEventListener("pointerdown", (event) => {
  const button = event.target.closest?.("[data-cycle-next]");
  cycleSwipe = button ? { x: event.clientX, y: event.clientY } : null;
});
document.addEventListener("pointerup", (event) => {
  if (!cycleSwipe) return;
  const dx = event.clientX - cycleSwipe.x,
    dy = event.clientY - cycleSwipe.y;
  cycleSwipe = null;
  // a swipe goes to the opponent in that direction; a plain tap just cycles
  if (Math.abs(dx) > 24 && Math.abs(dx) > Math.abs(dy)) cycleOpponent(dx < 0 ? 1 : -1);
  else if (Math.hypot(dx, dy) < 12) cycleOpponent(1);
});
window.addEventListener("resize", placeCallout);

/* ---------- rules sheet ---------- */
function variantsHtml(key) {
  const variants = RULE_VARIANTS[key];
  return variants
    ? `<div class="rule-variants">${variants.map(([glyph, label]) => `<span>${icon(glyph, 22, { idle: false })}${e(label)}</span>`).join("")}</div>`
    : "";
}
function rulesSheet(player) {
  const g = state.game;
  const color = colorFor(player);
  const active = activeRules(player);
  const effects = g.effects[player] || [];
  const visible = g.scores[player],
    total = g.effect_totals[player];
  const enabled = catalog.filter((rule) => state.rules[rule.key]);
  const editable = g.legal.set_rules;
  const ordered = [...(editable ? catalog : enabled)].sort((a,b) =>
    Number(active.includes(b.key)) - Number(active.includes(a.key)) ||
    Number(!!matchOptions.house_rules[b.key]) - Number(!!matchOptions.house_rules[a.key]));
  const others = state.names.map((_, p) => p).filter((p) => p !== player);
  return `<section class="sheet ${color}" role="dialog" aria-modal="true" aria-label="Rules in play">
    <div class="sheet-head"><h2>${e(state.names[player])}${player === state.viewer ? " (you)" : ""}</h2><button type="button" class="close-btn" data-sheet-close aria-label="Close">${icon("xmark.circle.fill", 36, { idle: false })}</button></div>
    <div class="tally">
      <div><span>Face-up cards</span><b>${visible} pts</b></div>
      ${effects.map((effect) => `<div><span>${e(effect)}</span></div>`).join("") || "<div><span>No rules are affecting this hand yet</span></div>"}
      <div class="total"><span>${g.phase === "over" ? "Final score" : "Active score"}</span><b>${total} pts</b></div>
    </div>
    <p class="hint dark" style="margin-top:.8rem">Face-down cards are not counted until the game ends.</p>
    ${state.names.length > 2 ? `<div class="meta" style="margin-top:1rem">${others.map((p) => `<button type="button" class="btn small ${colorFor(p)}" data-sheet-player="${p}">${e(state.names[p])}</button>`).join("")}</div>` : ""}
    <h3>${(g.modifier_counts || state.modifier_counts || [])[player] ?? 0} modifiers in play${state.house_rules ? " · House rules" : ""}</h3>
    ${editable ? `<p class="hint dark">You can change rules until your second opening flip.</p>` : ""}
    <div>${ordered.map((rule) => ruleHelpCard(rule, {player, on:!!state.rules[rule.key], editable})).join("") || "<p>Base scoring only — no optional rules.</p>"}</div>
    <h3>Match</h3>
    <div class="tally">
      <div><span>Game ${state.round} · ${e(matchLength(state))}</span></div>
      ${state.names.map((name, p) => `<div><span>${e(name)}</span><b>${state.series_mode === "points" ? state.points[p] + " pts" : state.wins[p] + (state.wins[p] === 1 ? " win" : " wins")}</b></div>`).join("")}
      ${state.history.map((game) => `<div><span>Game ${game.round}: ${game.winner === null ? "draw" : e(state.names[game.winner])}</span><b>${game.scores.join(" · ")}</b></div>`).join("")}
    </div>
    ${state.names.length > 2 ? `<h3>Turn order · ${g.deck_count} decks</h3><p>${g.turn_order.map((p) => (p === g.current ? `<u>${e(state.names[p])}</u>` : e(state.names[p]))).join(" → ")}</p>` : ""}
    <p class="hint dark" style="margin-top:1.2rem">${e(g.last_move)}</p>
  </section>`;
}
