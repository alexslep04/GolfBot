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
// Colours go by seat, so every screen shows the same player in the same colour:
// player 1 blue, 2 red, 3 yellow, 4 purple (then round again at bigger tables).
const SEAT_COLORS = ["c-s0", "c-s1", "c-s2", "c-s3"];
const OPPONENT_COLORS = ["c-p1", ...SEAT_COLORS]; // every class a tag may be wearing
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
  staged: null, // a move waiting for the Confirm button
  carry: null, // a card being carried with the controller trigger
  emotesOpen: false,
  summaryHidden: false,
  signatures: {},
  viewedOpponent: null,
  viewedTurn: "",
  slide: null, // the opponent's side of the table sliding over to the next one
  quiet: false, // the opponent changes without the cards popping
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
const canCycle = () => !!state?.game && state.names.length > 2 && !!board.el?.isConnected;
/** The opponent one step round the table from the one showing. */
function neighbour(direction) {
  const others = otherPlayers();
  return others[(others.indexOf(opponentSeat()) + direction + others.length) % others.length];
}
function showOpponent(player) {
  board.viewedOpponent = player;
  board.quiet = true;
  renderBoard();
  board.quiet = false;
}
function cycleOpponent(direction) {
  if (!canCycle()) return;
  const slide = beginSlide(direction);
  if (slide) settleSlide(slide, true);
  else {
    board.viewedOpponent = neighbour(direction);
    renderBoard();
  }
  spinCycle(direction);
}
/** The cycle arrows turn once round, the way the table went. */
function spinCycle(direction) {
  const arrows = board.el.querySelector("[data-cycle-next] .cycle-ico");
  if (!arrows?.animate || reducedMotion.matches) return;
  arrows.animate([{ transform: "rotate(0deg)" }, { transform: `rotate(${direction * 360}deg)` }], {
    duration: 620,
    easing: "cubic-bezier(0.3, 1.25, 0.5, 1)",
  });
}

/* ---------- sliding between opponents ---------- */
// The opponent's whole side of the table (tags, hand, avatar) moves as one
// page. A copy of the side being left slides out while the real one, already
// showing the next opponent, slides in beside it; under a finger the pair
// follows the swipe and only changes over if it is carried far enough.
const SLIDE_BLUR = 4; // px of blur on a side that has gone all the way
function beginSlide(direction) {
  if (!canCycle() || reducedMotion.matches) return null;
  if (board.slide) endSlide(board.slide);
  const top = board.el.querySelector(".b-top");
  if (!top?.cloneNode) return null;
  const from = opponentSeat(),
    to = neighbour(direction);
  const shell = document.createElement("div");
  shell.className = "board board-ghost";
  shell.dataset.seat = board.el.dataset.seat;
  shell.inert = true;
  shell.setAttribute("aria-hidden", "true");
  const copy = top.cloneNode(true);
  // the copy shows the side at rest: nothing mid-flight, pressed or popping
  copy.querySelectorAll(".incoming, .dragging, .returning, .hot, .target, .bump").forEach((node) =>
    node.classList.remove("incoming", "dragging", "returning", "hot", "target", "bump"),
  );
  copy.querySelectorAll(".slot").forEach((slot) => {
    for (const [name] of Object.values(MOTION_SPEC)) slot.style.removeProperty(name);
  });
  shell.append(copy);
  const slide = { direction, from, to, top, shell, copy, el: board.el, width: board.el.offsetWidth, x: 0, frame: 0, commit: false };
  board.slide = slide;
  board.el.before(shell); // under the table, so the cycle button stays on top of both sides
  top.classList.add("sliding");
  setSlide(slide, 0);
  showOpponent(to);
  return slide;
}
/** `x` is how far the side being left has travelled: 0 is at rest, a full width is gone. */
function setSlide(slide, x) {
  const { direction, width } = slide;
  slide.x = direction > 0 ? clamp(x, -width, 0) : clamp(x, 0, width);
  slide.copy.style.translate = `${slide.x}px 0`;
  slide.top.style.setProperty("--slide", `${slide.x + direction * width}px`);
  // each side fades and softens with its distance from rest, so neither is cut off at the table's edge
  const gone = Math.abs(slide.x) / width;
  const fade = (away) => [(1 - away ** 2).toFixed(3), `blur(${(away * SLIDE_BLUR).toFixed(2)}px)`];
  [slide.copy.style.opacity, slide.copy.style.filter] = fade(gone);
  const [opacity, blur] = fade(1 - gone);
  slide.top.style.setProperty("--slide-opacity", opacity);
  slide.top.style.setProperty("--slide-blur", blur);
}
/** Carry the slide the rest of the way over, or back to where it started. */
function settleSlide(slide, commit) {
  slide.commit = commit;
  const from = slide.x,
    to = commit ? -slide.direction * slide.width : 0;
  const duration = 170 + 250 * (Math.abs(to - from) / slide.width);
  const start = performance.now();
  const step = (now) => {
    if (board.slide !== slide) return;
    const t = slide.top.isConnected ? clamp((now - start) / duration, 0, 1) : 1;
    setSlide(slide, from + (to - from) * (1 - (1 - t) ** 3));
    if (t < 1) slide.frame = requestAnimationFrame(step);
    else endSlide(slide);
  };
  slide.frame = requestAnimationFrame(step);
}
/**
 * The cycle button sits under the opponent's score tag, which is taller for a
 * long name: when a redraw moves the button, it glides to its new place.
 */
function glideCycle(wrap, wasAt) {
  if (wasAt === undefined || !wrap.animate || reducedMotion.matches) return;
  wrap.getAnimations().forEach((animation) => animation.cancel());
  const moved = wasAt - wrap.getBoundingClientRect().top;
  if (Math.abs(moved) < 0.5) return;
  wrap.animate([{ translate: `0 ${moved}px` }, { translate: "0 0" }], {
    duration: 450,
    easing: "cubic-bezier(0.34, 1.4, 0.64, 1)",
  });
}
function endSlide(slide) {
  cancelAnimationFrame(slide.frame);
  if (board.slide === slide) board.slide = null;
  // a swipe that was let go early goes back to the opponent it started on
  if (!slide.commit && slide.top.isConnected && state?.game && board.viewedOpponent === slide.to)
    showOpponent(slide.from);
  void slide.top.offsetWidth; // the tags take their colour before they may fade again
  slide.top.classList.remove("sliding");
  for (const name of ["--slide", "--slide-opacity", "--slide-blur"]) slide.top.style.removeProperty(name);
  slide.shell.remove();
}
function colorFor(player) {
  return SEAT_COLORS[player % SEAT_COLORS.length];
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
// controller button shown on each action while a controller is in use
const PAD_ACTION_KEY = { flip: "lb", swap: "rb", draw: "y", discard: "x" }; // End Turn has none
const padActionKey = (action) =>
  PAD_ACTION_KEY[action] ? `<kbd class="pad-key" data-key="${PAD_ACTION_KEY[action]}"></kbd>` : "";
// The five table actions: a bar under your panels on desktop, and on phones
// the same buttons split to the left and right of the piles.
const ACTIONS = [
  ["flip", "Flip", "rectangle.portrait.rotate"],
  ["swap", "Swap", "rectangle.2.swap"],
  ["draw", "Draw", "figure.fishing"],
  ["discard", "Discard", "trash.fill"],
  ["end_turn", "End Turn", "flag.pattern.checkered"],
];
function sideAction(action) {
  const [, label, symbol] = ACTIONS.find(([key]) => key === action);
  return `<button type="button" class="act side-act bar-act" data-action="${action}"><span class="act-ico">${icon(symbol, 24, { sw: 3.4 })}</span><span class="side-label">${padActionKey(action)}${label}</span></button>`;
}
function mountBoard() {
  const me = state.viewer;
  const hand = (player, tilts) =>
    tilts.map((tilt, i) => slotHtml([player, i], tilt)).join("");
  booted(); // a refresh at the table lands here first
  root.innerHTML = `<div class="board" data-board>
    <section class="b-top">
      <div class="b-main">
        <button type="button" class="tag tag-rules" data-rules-for="opp"><span class="tag-in"><span class="txt"></span><span class="icons"></span></span></button>
        <div class="hand" data-hand="opp">${hand("opp", HAND_TILT[1])}</div>
      </div>
      <div class="b-side">
        <button type="button" class="tag tag-score" data-score-for="opp" data-stats-for="opp"><span class="tag-in"></span><span class="turn-label" data-turn-label aria-hidden="true">Up next</span></button>
        <span class="tag-avatar" data-avatar-for="opp" aria-hidden="true"></span>
        <div class="turn-slot" data-turn-slot></div>
        <div class="streak" data-streak data-practice-streak role="img" hidden></div>
        <div class="cycle-wrap"><button type="button" class="cycle" data-cycle-next hidden><span class="cycle-ico"></span></button><div class="cycle-emotes" data-emote-others></div></div>
      </div>
    </section>
    <section class="b-mid">
      <div class="pile">
        <div class="pile-label" data-draw-label></div>
        <div class="pile-area">
          ${slotHtml(["under", null], 97, "under")}
          ${slotHtml(["draw", null], 84)}
          ${slotHtml(["held", null], 88, "is-face held")}
          <div class="pile-side left" data-side-actions>
            <button type="button" class="act side-act" data-undo hidden><span class="act-ico">${icon("delete.left.fill", 30, { sw: 4 })}</span><span class="side-label"><kbd class="pad-key" data-key="b"></kbd>Undo</span></button>
            ${sideAction("flip")}${sideAction("draw")}
          </div>
        </div>
      </div>
      <div class="pile">
        <div class="pile-label">discards</div>
        <div class="pile-area">${slotHtml(["discard", null], 90.6, "is-face")}
          <div class="pile-side" data-side-actions>
            <button type="button" class="act side-act" data-confirm hidden><span class="act-ico">${icon("checkmark.circle.fill", 30, { sw: 4 })}</span><span class="side-label"><kbd class="pad-key" data-key="a"></kbd>Confirm</span></button>
            ${sideAction("swap")}${sideAction("discard")}${sideAction("end_turn")}
          </div>
        </div>
      </div>
    </section>
    <div class="bottom-wrap">
      <section class="b-bottom">
        <div class="b-side">
          <div class="board-extra"></div>
          <div class="board-btns">
            <button type="button" class="icon-btn" data-game-menu aria-label="Table menu">${icon("gear", 44)}${padTag("start", "under")}</button>
            <button type="button" class="icon-btn" data-emotes aria-label="Quick emotes">${icon("text.bubble.fill", 44)}</button>
          </div>
          <span class="tag-avatar" data-avatar-for="me" aria-hidden="true"></span>
          <div class="tag tag-score c-p1" data-score-for="me"><span class="tag-in"></span><span class="turn-label" data-turn-label aria-hidden="true">Your turn</span></div>
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
  if (board.slide) cancelAnimationFrame(board.slide.frame);
  board.slide = null;
  board.el = root.querySelector("[data-board]");
  // inside the table, "player 1 blue" (--p1) becomes your own seat's colour
  board.el.dataset.seat = String(me % SEAT_COLORS.length);
  board.signatures = {};
  board.view = null;
  board.selected = [];
  board.drag = null;
  board.pendingDrop = null;
  board.staged = null;
  board.carry = null;
  board.emotesOpen = false;
  board.summaryHidden = false;
  board.el.addEventListener("pointerdown", onBoardPointerDown);
  board.el.addEventListener("pointermove", onBoardPointerMove);
  board.el.addEventListener("pointerup", onBoardPointerUp);
  board.el.addEventListener("pointercancel", onBoardPointerCancel);
  board.el.addEventListener("pointerleave", () => setHover(null));
  board.el.addEventListener("wheel", onBoardWheel, { passive: false });
  const summary = board.el.querySelector("[data-summary]");
  summary.addEventListener("pointermove", evalHover);
  summary.addEventListener("pointerdown", evalHover);
  summary.addEventListener("pointerout", (event) => {
    const figure = event.target.closest?.("[data-eval-chart]");
    if (figure && !figure.contains(event.relatedTarget))
      evalHover({ type: "pointerleave", target: figure });
  });
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
  // anything half-done belongs to the table as it was; a new state drops it
  const stale = (pending) =>
    pending && (pending.version !== state.version || state.status !== "playing");
  if (stale(board.staged)) cancelStaged(false);
  if (stale(board.carry)) cancelCarry(false);
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
    // sliding over to them is the animation; otherwise the new hand pops in
    if (!board.quiet)
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
  const keys = [view.opp, view.me].flatMap((player) => [0, 1, 2, 3, 4, 5].map((i) => `${player}:${i}`));
  // Hide the hands now, but aim the cards a frame later: the table is still being
  // drawn (panels, the desktop action bar), and measuring now would land every
  // card short of where its slot ends up, then snap it into place.
  keys.forEach((key) => board.slots.get(key)?.classList.add("incoming"));
  requestAnimationFrame(() => {
    const pile = board.slots.get("draw:");
    if (!pile?.isConnected) return; // the table was redrawn first; it shows the cards itself
    const from = poseOf(pile);
    keys.forEach((key, order) => {
      const entry = view.table[key];
      flyCard({
        html: faceHtml(entry.card),
        from,
        to: board.slots.get(key),
        faceFrom: false,
        faceTo: entry.key !== "X",
        delay: order * 45,
      });
    });
  });
  // a tick as each card lands
  hapticFlurry(keys.length, 45, 380);
}

function scoreDigits(value, side) {
  const text = String(value);
  return `<span class="digits${text.length > 2 ? " long" : ""}">${stickerText(text, { split: true, key: `score:${side}` })}</span>${stickerText("pts", { cls: "pts", key: `pts:${side}` })}`;
}
/**
 * The stickers a hand has earned: one per rule (or rule variant) that is
 * affecting that player right now. Rules that are merely enabled show nothing.
 */
/**
 * An effect line split into the rule and what it does to the score, so the
 * maths can sit in the right-hand column: "Poisoned Card: +2" and "Roman 5s /2"
 * become "Poisoned Card" | "+2" and "Roman 5s" | "/2".
 */
function effectParts(effect) {
  const colon = effect.indexOf(": ");
  const divide = effect.match(/^(.*\S) (\/\d+)$/);
  const [name, op] =
    colon > 0 ? [effect.slice(0, colon), effect.slice(colon + 2)] : divide ? [divide[1], divide[2]] : [effect, ""];
  return `<span class="effect-name">${e(name)}</span>${op ? `<b class="effect-op">${e(op)}</b>` : ""}`;
}
/** The rules (and their variants) one effect line, as the server words it, stands for. */
function effectStickers(effect) {
  const found = [];
  const add = (rule, variant) => found.push({ rule, variant });
  const rule = EFFECT_RULE.find(([pattern]) => pattern.test(effect))?.[1];
  if (!rule) return found;
  if (rule === "king_queen") add(rule, /: 5 \(/.test(effect) ? 0 : 1);
  else if (rule === "holdem")
    ["flush", "straight", "full house", "four kind"].forEach(
      (hand, variant) => effect.includes(hand) && add(rule, variant),
    );
  else if (rule === "tricky_straights")
    add(rule, /Incoming|opponent/.test(effect) ? 0 : 1);
  else if (rule === "suited_rows") add(rule, /Incoming|opponents/.test(effect) ? 0 : 1);
  else if (rule === "all_in_color") add(rule, /red/.test(effect) ? 0 : 1);
  else add(rule);
  return found;
}
/** Gather rule/variant pairs into one sticker per rule, variants riding along. */
function groupStickers(pairs) {
  const groups = new Map();
  for (const { rule, variant } of pairs) {
    if (!groups.has(rule))
      groups.set(rule, { rule, icon: RULE_ICON[rule] || "star.fill", subs: [] });
    const sub = variant === undefined ? null : RULE_VARIANTS[rule][variant][0];
    if (sub && !groups.get(rule).subs.includes(sub)) groups.get(rule).subs.push(sub);
  }
  return [...groups.values()];
}
/**
 * A rule's sticker. When a variant of the rule is what triggered, the variant's
 * sticker sits small on the bottom-right corner of the main one.
 */
function ruleStickerHtml(sticker, size, opts = {}) {
  // On the table the pair drifts as one piece: the idle motion lives on the
  // wrapper, so the variant moves exactly as if stuck to the main sticker.
  const drifting = opts.tilt !== undefined;
  const main = drifting
    ? tilted(sticker.icon, size, { tilt: opts.tilt, idle: false })
    : icon(sticker.icon, size, { idle: false });
  const subs = sticker.subs
    .map(
      (name, i) =>
        `<span class="rule-sub" style="--n:${i}">${icon(name, Math.round(size * 0.5), { idle: false, sw: 2.4 })}</span>`,
    )
    .join("");
  return drifting
    ? `<span class="rule-stk idle" style="${idleStyle(`rule:${sticker.rule}`)}">${main}${subs}</span>`
    : `<span class="rule-stk">${main}${subs}</span>`;
}
/**
 * The stickers a hand has earned: one per rule that is affecting that player
 * right now. Rules that are merely enabled show nothing.
 */
function ruleStickers(player) {
  const g = state.game,
    pairs = [];
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
        pairs.push({ rule: "royal_pairs", variant: top.card.rank === 11 ? 0 : 1 });
    }
  for (const effect of g.effects[player] || []) pairs.push(...effectStickers(effect));
  return groupStickers(pairs);
}
function activeRules(player) {
  if (state.game.rule_previews) return Object.keys(state.game.rule_previews[player] || {});
  return [...new Set(ruleStickers(player).map((sticker) => sticker.rule))];
}
/**
 * What the rules in play have done to a hand: its score as it stands, against
 * the plain points of its cards (with only matching columns cancelled).
 */
function ruleDelta(player) {
  const g = state.game;
  return g.effect_totals[player] - (g.base_scores ?? g.scores)[player];
}
/** True while the table is waiting on this player (including opening flips). */
function myTurn() {
  const g = state.game;
  if (!g || state.status !== "playing" || g.phase === "over") return false;
  return g.phase === "setup"
    ? g.legal.flip.length > 0
    : g.decision_player === state.viewer;
}
/** True while the table is waiting on this opponent (opening flips are everyone's at once). */
function theirTurn(player) {
  const g = state.game;
  return state.status === "playing" && !["setup", "over"].includes(g.phase) && g.decision_player === player;
}
/**
 * At tables of three or more, the player whose turn comes after the one in
 * progress (null at smaller tables, and when the round ends with this turn).
 */
function nextUp() {
  const g = state.game;
  if (state.names.length < 3 || state.status !== "playing") return null;
  if (g.next_up !== undefined) return g.next_up;
  // A server started before it reported this: the next seat in turn order.
  // Once someone has gone out, only the server knows who still has a final turn.
  if (g.ending || ["setup", "over"].includes(g.phase)) return null;
  const order = g.turn_order;
  return order[(order.indexOf(g.current) + 1) % order.length];
}
/**
 * Solo only: your win streak against Golfbot, a flame over a sticker number
 * like the points counter. Faded at zero; lit and glowing brighter as it grows.
 */
function renderStreak() {
  const holder = board.el.querySelector("[data-practice-streak]");
  // Practice's saved streak (1.2.0) when there is one, else this browser's run against Golfbot
  const saved = state.practice && state.streak && typeof state.streak === "object" ? state.streak : null;
  const count = saved ? (saved.current ?? 0) : state.solo && typeof state.streak === "number" ? state.streak : null;
  holder.hidden = count === null;
  if (count === null) return;
  // a draw puts a saved streak on notice: it fades until the next win
  holder.classList.toggle("hot", count > 0 && saved?.draws !== 1);
  holder.style.setProperty("--heat", Math.min(count, 10));
  holder.setAttribute("aria-label", saved ? `Practice streak: ${count}. Best: ${saved.best}. Draws in a row: ${saved.draws}.` : `Win streak against Golfbot: ${count}`);
  holder.title = saved ? `Best streak: ${saved.best}` : "";
  const before = board.signatures.streak;
  const changed = patch(
    "streak",
    holder,
    `${count}`,
    () =>
      `<span class="flame">${icon("flame.fill", 40, { key: "streak-flame" })}</span><span class="score"><span class="digits streak-count${String(count).length > 2 ? " long" : ""}" data-count="${count}">${stickerText(String(count), { split: true, key: "streak" })}</span></span>`,
  );
  // a new win pops the number, like the points counter
  if (changed && before !== undefined && count > Number(before)) holder.querySelector(".score").classList.add("bump");
}
function renderTags() {
  renderStreak();
  const g = state.game;
  const turn = myTurn();
  if (turn && board.signatures.turn === false) haptic("turn");
  board.signatures.turn = turn;
  const upNext = nextUp();
  // where the cycle button is now, if it is showing (it may be about to move)
  const cycleWrap = board.el.querySelector(".cycle-wrap");
  const cycleAt = board.signatures.cycleShown ? cycleWrap.getBoundingClientRect?.().top : undefined;
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
      tag.classList.remove(...OPPONENT_COLORS);
      tag.classList.add(color);
      // your own tags carry the "your turn" label and a gentle pulse
      tag.classList.toggle("my-turn", side === "me" && turn);
    }
    // the band of a score tag says whose turn it is (in white), and who plays
    // after it (darker, like the frame); the wording only changes as the label
    // comes in, never while it fades out
    const theirs = side === "opp" && theirTurn(player);
    const next = player === upNext && !theirs && !(side === "me" && turn);
    scoreTag.classList.toggle("their-turn", theirs);
    scoreTag.classList.toggle("up-next", next);
    if (next || theirs || (side === "me" && turn))
      scoreTag.querySelector("[data-turn-label]").textContent = next ? "Up next" : theirs ? "Their turn" : "Your turn";
    // the player's avatar, a big sticker tucked behind their score tag
    const avatarTag = board.el.querySelector(`[data-avatar-for='${side}']`);
    const avatarId = state.avatars?.[player];
    avatarTag.classList.remove(...OPPONENT_COLORS);
    avatarTag.classList.add(color);
    patch(`avatar-${side}`, avatarTag, `${avatarId}`, () =>
      icon(avatarIcon(avatarId), 54, { key: `avatar:${side}` }),
    );
    const score = g.phase === "over" ? g.scores[player] : g.effect_totals[player];
    const offline = !state.connected[player] && !state.solo;
    scoreTag.classList.toggle("offline", offline);
    const changed = patch(
      `score-${side}`,
      scoreTag.firstElementChild,
      `${player}|${label}|${score}`,
      () =>
        `<span class="who">${e(label)}</span><span class="score">${scoreDigits(score, side)}</span>`,
    );
    if (changed && board.signatures[`seen-${side}`] === player) {
      const element = scoreTag.querySelector(".score");
      element.classList.add("bump");
    }
    board.signatures[`seen-${side}`] = player;
    scoreTag.setAttribute(
      "aria-label",
      `${state.names[player]}: ${score} points${offline ? ", offline" : ""}${side === "me" && turn ? ", your turn" : ""}${theirs ? ", their turn" : ""}${next ? ", up next" : ""}${side === "opp" ? ". Open their stats." : ""}`,
    );
    const delta = ruleDelta(player);
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
      `${color}|${stickers.map((sticker) => `${sticker.icon}:${sticker.subs.join("+")}`).join()}`,
      () =>
        stickers
          .slice(0, 3)
          .map((sticker, i) => ruleStickerHtml(sticker, 36, { tilt: [-13, -4, 16][i] }))
          .join(""),
    );
    rulesTag.setAttribute(
      "aria-label",
      `${state.names[player]}: ${enabled} modifiers in play, ${delta} points from rules. Open details.`,
    );
  }
  // the cycle button wears the colour of the opponent it turns to
  const cycle = board.el.querySelector("[data-cycle-next]");
  const others = otherPlayers();
  cycle.hidden = others.length < 2;
  board.signatures.cycleShown = others.length > 1;
  if (others.length > 1) {
    const next = others[(others.indexOf(board.view.opp) + 1) % others.length];
    cycle.classList.remove(...OPPONENT_COLORS);
    cycle.classList.add(colorFor(next));
    patch("cycle", cycle.querySelector(".cycle-ico"), "static", () =>
      icon("arrow.trianglehead.2.clockwise.rotate.90", 44),
    );
    cycle.setAttribute(
      "aria-label",
      `Show ${state.names[next]}'s cards. Swipe to browse opponents.`,
    );
  }
  board.el.querySelector("[data-draw-label]").textContent =
    `go-fish pile (${g.draw_count})`;
  glideCycle(cycleWrap, cycleAt);
}

function promptText() {
  const [text, side] = promptFor();
  // with tooltips hidden, your own prompts go; whose turn it is stays
  if (prefs.hideTips && side === "me" && state.status === "playing")
    return [state.game.final_turn && myTurn() ? "Final turn" : null, "me"];
  return [text, side];
}
function promptFor() {
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
    callout.style.removeProperty("--tip-x");
    callout.style.top = `${card.top - box.top - callout.offsetHeight / 2 - 10}px`;
    return;
  }
  if (callout.dataset.anchor === "turn") {
    // in the gap kept for it between the opponent's avatar and the cycle
    // button, its arrow under the middle of that column even where the box is
    // held in from the table's edge. Measured from the layout, not the screen,
    // so it lands where things rest while the opponent's side is sliding in.
    const slot = board.el.querySelector("[data-turn-slot]");
    const width = callout.offsetWidth,
      centre = slot.offsetLeft + slot.offsetWidth / 2;
    const x = clamp(centre, width / 2 + 6, box.width - width / 2 - 6);
    callout.style.setProperty("--callout-x", `${x}px`);
    callout.style.setProperty("--tip-x", `${clamp(centre - x + width / 2, 20, width - 20)}px`);
    callout.style.top = `${slot.offsetTop + slot.offsetHeight / 2}px`;
    return;
  }
  callout.style.removeProperty("--callout-x");
  callout.style.removeProperty("--tip-x");
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
    // An opponent's turn is announced between their avatar and the cycle
    // button: pointing up at the player on show when the turn is theirs, and
    // down at the button that leads to whoever's it is when it is not.
    const anchor =
      g.phase === "setup" && g.legal.flip.length && !prefs.hideTips
        ? "card"
        : side === "opp" && theirTurn(player)
          ? "turn"
          : "";
    const arrow = side === "me" || (anchor === "turn" && player !== board.view.opp) ? "down" : "up";
    callout.className = `callout ${color} ${arrow}`;
    callout.dataset.side = side;
    callout.dataset.anchor = anchor;
    if (board.signatures.callout !== text + side) {
      board.signatures.callout = text + side;
      callout.textContent = text;
      callout.classList.add("pop");
    }
    placeCallout();
  }
  const extra = board.el.querySelector(".board-extra");
  const queue = presenceState.queue;
  patch(
    "extra",
    extra,
    `${queue?.status}`,
    () =>
      queue && ["waiting", "offer"].includes(queue.status)
        ? `<button type="button" class="icon-btn queue" data-queue-view aria-label="Quickplay queue">${icon("sparkles", 32)}</button>`
        : "",
  );
  const bar = board.el.querySelector("[data-actionbar]");
  const drawn = patch(
    "actionbar",
    bar,
    "static",
    ACTIONS
      .map(
        ([action, label, symbol]) =>
          `<button type="button" class="act" data-action="${action}"${action === "end_turn" ? ' title="Enter"' : ""}><span class="act-ico">${icon(symbol, 30, { sw: 4 })}${padActionKey(action)}</span><span class="act-label">${label}</span></button>`,
      )
      .join(""),
  );
  if (drawn && text) placeCallout(); // on desktop the bar's arrival moves the table up under the tooltip
  bar.querySelectorAll("[data-action]").forEach((button) => {
    button.disabled = !actionAllowed(button.dataset.action);
  });
  bar.classList.toggle("my-turn", myTurn()); // it pulses along with your tags
  renderSummary();
  renderEmotes(); // after the results, whose tiles the reactions sit on
  renderModal();
}

function renderEmotes() {
  const layer = board.el.querySelector("[data-emote-layer]");
  const signature = state.names
    .map((_, p) => activeEmotes[p]?.sequence || 0)
    .join();
  // you and the opponent showing react beside your own cards; anyone else
  // speaks up from the cycle button that leads to them
  const players = state.names.map((_, p) => p);
  const showing = (p) => p === state.viewer || p === board.view.opp;
  // on the results everyone has a tile, and reacts from above it instead
  const tiles = [...(board.el.querySelectorAll?.("[data-tile-emote]") ?? [])];
  const results = tiles.length > 0;
  patch("emotes", layer, signature + board.view.opp + results, () =>
    results ? "" : players.filter(showing).map((p) => playerEmote(p)).join(""),
  );
  patch("emotes-others", board.el.querySelector("[data-emote-others]"), signature + board.view.opp + results, () =>
    results ? "" : players.filter((p) => !showing(p)).map((p) => playerEmote(p)).join(""),
  );
  for (const tile of tiles) {
    // (the tiles are redrawn with the results, so each remembers what it holds)
    const player = Number(tile.dataset.tileEmote);
    const shown = `${activeEmotes[player]?.sequence || 0}|${opponentEmotesMuted}`;
    if (tile.dataset.shown === shown) continue;
    tile.dataset.shown = shown;
    tile.innerHTML = playerEmote(player, true);
  }
  const pop = board.el.querySelector("[data-emote-pop]");
  patch(
    "emote-pop",
    pop,
    `${board.emotesOpen}|${opponentEmotesMuted}|${state.status}`,
    () =>
      board.emotesOpen ? `<div class="emote-pop" role="group" aria-label="Quick emotes">${emoteButtons()}</div>` : "",
  );
}
/** The quick emotes and the mute bell: in the chat bubble's pop-up, and under the results. */
function emoteButtons() {
  return `${Object.entries(emoteNames)
    .map(
      ([id, label]) =>
        `<button type="button" data-emote="${id}" aria-label="Send ${label.toLowerCase()} emote" ${state.status === "closed" ? "disabled" : ""}><img src="${appPath(`/static/emotes/${id}.png`)}" alt=""></button>`,
    )
    .join(
      "",
    )}<button type="button" data-emote-mute aria-pressed="${opponentEmotesMuted}" aria-label="${opponentEmotesMuted ? "Unmute opponent emotes" : "Mute opponent emotes"}">${icon(opponentEmotesMuted ? "bell.slash.fill" : "bell.fill", 28, { idle: false })}</button>`;
}
function playerEmote(player, onTile = false) {
  if (opponentEmotesMuted && player !== state.viewer) return "";
  const item = activeEmotes[player];
  if (!item || item.ends <= Date.now()) return "";
  const age = Math.max(0, 4000 - (item.ends - Date.now()));
  const where =
    player === state.viewer ? "me" : player === board.view.opp ? "them" : "other";
  const image = `<img src="${appPath(`/static/emotes/${item.id}.png`)}" alt="${e(state.names[player])}: ${emoteNames[item.id]} emote">`;
  if (onTile)
    return `<div class="player-emote tile" data-emote-player="${player}" role="status" style="animation-delay:-${age}ms">${image}</div>`;
  // a white tooltip with the player's avatar and name in their own colour, pointing back at the cycle button
  if (where === "other")
    return `<div class="player-emote other ${colorFor(player)}" data-emote-player="${player}" role="status" style="animation-delay:-${age}ms"><span class="emote-who">${icon(avatarIcon(state.avatars?.[player]), 26, { idle: false })}<b>${e(state.names[player])}</b></span>${image}</div>`;
  return `<div class="player-emote ${where}" data-emote-player="${player}" role="status" style="animation-delay:-${age}ms">${image}</div>`;
}

/**
 * The post-game graph: every player's showing score after each turn, ending
 * on the final reveal. Lines wear the seat colours (outlined in the seat's
 * dark tone so the yellow still reads) and are named at their right-hand end.
 */
const CHART = { w: 300, h: 160, left: 24, right: 84, top: 12, bottom: 22 };
function evalScale() {
  const points = state.timeline || [];
  const all = points.flatMap((point) => point.scores);
  let lo = Math.min(0, ...all),
    hi = Math.max(...all);
  if (hi - lo < 6) hi = lo + 6;
  const { w, h, left, right, top, bottom } = CHART;
  return {
    points,
    lo,
    hi,
    x: (i) => left + (points.length > 1 ? i / (points.length - 1) : 0.5) * (w - left - right),
    y: (v) => top + (1 - (v - lo) / (hi - lo)) * (h - top - bottom),
  };
}
/** Which lines get colour and a name: everyone at a small table, else you and the winner. */
function evalFeatured() {
  const count = state.names.length;
  if (count <= 4) return state.names.map((_, p) => p);
  const winner = state.history.at(-1)?.winner;
  return [...new Set([state.viewer, winner].filter((p) => p !== null && p !== undefined))];
}
function evalChart() {
  const { points, lo, hi, x, y } = evalScale();
  if (points.length < 2) return "";
  const { w, h, left, right, top, bottom } = CHART;
  const featured = evalFeatured();
  const short = (p) => {
    const name = p === state.viewer ? "You" : state.names[p];
    return name.length > 7 ? `${name.slice(0, 6)}…` : name;
  };
  // top, bottom and zero first; the middle one only where it has room
  const ticks = [];
  for (const v of [hi, lo, ...(lo < 0 ? [0] : []), Math.round((hi + lo) / 2)])
    if (ticks.every((kept) => Math.abs(y(kept) - y(v)) >= 14)) ticks.push(v);
  const grid = ticks
    .map(
      (v) =>
        `<line class="grid${v === 0 ? " zero" : ""}" x1="${left}" x2="${w - right}" y1="${y(v)}" y2="${y(v)}"/><text class="tick" x="${left - 6}" y="${y(v)}">${v}</text>`,
    )
    .join("");
  const path = (p) => points.map((point, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(point.scores[p]).toFixed(1)}`).join("");
  // muted lines first, then the coloured ones, with your own drawn last (on top)
  const order = state.names
    .map((_, p) => p)
    .sort((a, b) => featured.includes(a) - featured.includes(b) || (a === state.viewer) - (b === state.viewer));
  const lines = order
    .map((p) => {
      if (!featured.includes(p)) return `<path class="line muted" d="${path(p)}"/>`;
      const seat = p % 4;
      const end = points.at(-1).scores[p];
      return `<g class="series" style="--line:var(--s${seat});--case:var(--s${seat}t)"><path class="case" d="${path(p)}"/><path class="line" d="${path(p)}"/><circle class="end" cx="${x(points.length - 1)}" cy="${y(end)}" r="4"/></g>`;
    })
    .join("");
  // a tooltip-style tag at each line's end, nudged apart so they never overlap;
  // the arrow keeps pointing at its own line however far the tag moved
  const gap = 19;
  const labels = featured
    .map((p) => ({ p, at: y(points.at(-1).scores[p]) }))
    .sort((a, b) => a.at - b.at);
  for (let i = 1; i < labels.length; i++) labels[i].at = Math.max(labels[i].at, labels[i - 1].at + gap);
  const overflow = labels.length ? labels.at(-1).at - (h - bottom) : 0;
  if (overflow > 0) for (const label of labels) label.at -= overflow;
  for (let i = labels.length - 2; i >= 0; i--) labels[i].at = Math.min(labels[i].at, labels[i + 1].at - gap);
  const endX = x(points.length - 1);
  // the arrow is drawn in the graph; the tag itself is plain HTML laid over it,
  // so its text centres the same in every browser (Safari places SVG text its own way)
  const arrows = labels
    .map(({ p, at }) => {
      const point = y(points.at(-1).scores[p]);
      const mid = Math.min(Math.max(point, at - 4), at + 4);
      return `<polygon class="tag-arrow" style="--tip:var(--s${p % 4})" points="${(endX + 4.5).toFixed(1)},${point.toFixed(1)} ${(endX + 11).toFixed(1)},${(mid - 4).toFixed(1)} ${(endX + 11).toFixed(1)},${(mid + 4).toFixed(1)}"/>`;
    })
    .join("");
  const tags = labels
    .map(
      ({ p, at }) =>
        `<span class="end-tag" style="--tip:var(--s${p % 4});--on:var(--s${p % 4}on);left:${(((endX + 10) / w) * 100).toFixed(2)}%;top:${((at / h) * 100).toFixed(2)}%">${e(short(p))} <b>${points.at(-1).scores[p]}</b></span>`,
    )
    .join("");
  const turns = points.filter((point) => !point.final).at(-1).turn;
  const axis = `<text class="axis" x="${left}" y="${h - 6}" text-anchor="start">Start</text><text class="axis" x="${(left + w - right) / 2}" y="${h - 6}">${turns} turn${turns === 1 ? "" : "s"}</text><text class="axis" x="${w - right}" y="${h - 6}" text-anchor="end">Reveal</text>`;
  const summary = featured
    .map((p) => `${p === state.viewer ? "You" : state.names[p]}: ${points.map((point) => point.scores[p]).join(", ")}`)
    .join("; ");
  return `<figure class="eval-chart" data-eval-chart><figcaption>Points through the game <small>lower is better</small></figcaption><div class="eval-plot"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="Score after each turn. ${e(summary)}">${grid}${axis}${lines}<line class="cross" x1="0" x2="0" y1="${top}" y2="${h - bottom}"/>${arrows}<rect class="hit" x="${left}" y="${top}" width="${w - left - right}" height="${h - top - bottom}"/></svg>${tags}<div class="eval-tip" hidden></div></div></figure>`;
}
/** The big result word: sticker letters that celebrate, or droop. */
function resultTitle(mood, sentence, sub) {
  const word = { win: "You Win!", lose: "You Lose", draw: "Draw" }[mood];
  // letters keep their place in the animation when the card redraws (someone readies up)
  const key = `${state.id}|${state.round}|${state.status}`;
  if (board.resultShown?.key !== key) {
    board.resultShown = { key, at: performance.now() };
    haptic({ win: "win", lose: "lose", draw: "tie" }[mood]);
  }
  const elapsed = ((performance.now() - board.resultShown.at) / 1000).toFixed(2);
  const letters = [...word]
    .map((char, i) => {
      const sag = (i % 2 ? -1 : 1) * (3 + ((i * 7) % 5));
      return char === " "
        ? `<span class="gap"></span>`
        : `<span class="stk" style="--i:${i};--sag:${sag}deg;${idleStyle(`result:${i}`)}">${e(char)}</span>`;
    })
    .join("");
  return `<h2 class="result-title ${mood}" style="--t:-${elapsed}s" aria-label="${e(sentence)}"><span class="word" aria-hidden="true">${letters}</span>${sub ? `<small aria-hidden="true">${e(sub)}</small>` : ""}</h2>`;
}
/** Hovering (or dragging a finger along) the graph reads out that turn. */
function evalHover(event) {
  const figure = event.target.closest?.("[data-eval-chart]");
  if (!figure) return;
  const svg = figure.querySelector("svg"),
    tip = figure.querySelector(".eval-tip"),
    cross = figure.querySelector(".cross");
  if (event.type === "pointerleave" || event.type === "pointercancel") {
    tip.hidden = true;
    cross.classList.remove("on");
    return;
  }
  const { points, x } = evalScale();
  const box = svg.getBoundingClientRect();
  const unit = (event.clientX - box.left) * (CHART.w / box.width);
  let i = 0;
  for (let k = 1; k < points.length; k++) if (Math.abs(x(k) - unit) < Math.abs(x(i) - unit)) i = k;
  cross.setAttribute("x1", x(i));
  cross.setAttribute("x2", x(i));
  cross.classList.add("on");
  const label = points[i].final ? "Reveal" : i === 0 ? "Start" : `Turn ${points[i].turn}`;
  const rows = evalFeatured()
    .map((p) => ({ p, v: points[i].scores[p] }))
    .sort((a, b) => a.v - b.v)
    .map(({ p, v }) => `<div><i style="background:var(--s${p % 4})"></i><span>${p === state.viewer ? "You" : e(state.names[p])}</span><b>${v}</b></div>`)
    .join("");
  tip.innerHTML = `<strong>${label}</strong>${rows}`;
  tip.hidden = false;
  // beside the crosshair, on whichever side has room, so it never covers the title
  const px = (x(i) / CHART.w) * box.width;
  const left = px < box.width / 2;
  tip.style.left = `${left ? px + 8 : px - 8 - tip.offsetWidth}px`;
}

/**
 * The game is over: any card still lifted off the table (a staged swap, a drag,
 * a card carried with the controller) is set back down in its place, so none is
 * left hovering over the results.
 */
function settleLifted() {
  if (board.staged) board.staged = null;
  if (board.carry) cancelCarry();
  for (const slot of board.el.querySelectorAll(".slot.dragging, .slot.returning")) {
    slot.classList.remove("dragging", "returning");
    motionFor(slot).to({ x: 0, y: 0, lean: 0, scale: 1, lift: 0, rx: 0, ry: 0 });
  }
}
function renderSummary() {
  const holder = board.el.querySelector("[data-summary]");
  const over = ["round_over", "finished", "closed"].includes(state.status);
  if (!over) {
    board.summaryHidden = false;
    patch("summary", holder, "", "");
    return;
  }
  settleLifted();
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
    (state.timeline || []).length,
    opponentEmotesMuted,
  ].join("|");
  patch("summary", holder, signature, () => {
    if (board.summaryHidden)
      return `<div class="summary mini"><button type="button" class="btn small c-p1" data-summary-toggle>${glyph("chevron.up", 16)} Results</button></div>`;
    if (closed)
      return `<section class="summary panel c-p2" role="dialog" aria-label="Results"><h2>${e(title)}</h2><p style="margin:1rem 0;text-align:center">${e(state.message)}</p><div class="stack"><button type="button" class="btn c-p1" data-leave>${tilted("house.fill", 28)} Back to menu</button></div></section>`;
    const between = state.status === "round_over";
    const series = state.names.length > 2 || state.best_of !== 1;
    const verdict = finished ? state.champion : result.winner;
    const mood = verdict === null || verdict === undefined ? "draw" : verdict === viewer ? "win" : "lose";
    const sub =
      mood === "lose" ? title : mood === "win" ? (finished ? "The series is yours" : "Lowest score this game") : finished ? "The series is tied" : "Nobody takes this game";
    // one tile per player: this game's points, the series so far, and whether they're ready
    const tiles = state.names
      .map((name, p) => {
        const ready = !!state.ready[p];
        const crown = finished ? state.champion === p : result?.winner === p;
        const status = between
          ? `<span class="ready-state${ready ? " on" : ""}">${icon(ready ? "checkmark.circle.fill" : "hourglass", 18, { idle: false })}${ready ? "Ready" : "Not ready"}</span>`
          : "";
        return `<div class="ready-tile ${colorFor(p)}${crown ? " won" : ""}"><span class="tile-emote" data-tile-emote="${p}"></span><span class="who"><span class="name">${p === viewer ? youStar() : ""}${e(name)}</span>${crown ? icon(finished ? "trophy.fill" : "crown.fill", 20, { key: `crown:${p}` }) : ""}</span><b>${result ? result.scores[p] : "–"} pts</b>${series ? `<small>${state.series_mode === "points" ? `${state.points[p]} total` : `${state.wins[p]} ${state.wins[p] === 1 ? "win" : "wins"}`}</small>` : ""}${status}</div>`;
      })
      .join("");
    // Quit is a plain sticker icon with its label underneath, left of the main button
    const quit = `<button type="button" class="close-btn c-fw" data-leave>${icon("rectangle.portrait.and.arrow.right", 30)}<span>Quit</span></button>`;
    const action = between
      ? `<div class="row">${quit}<button type="button" class="btn c-p1 grow" data-action="next_round" ${state.ready[viewer] ? "disabled" : ""}>${tilted("checkmark.circle.fill", 26)} <span>${padTag("y")}${state.ready[viewer] ? "Waiting…" : "Ready"}</span></button></div>`
      : viewer === 0
        ? `<div class="row">${quit}<button type="button" class="btn c-p1 grow" data-action="rematch">${tilted("arrow.clockwise", 26)} <span>${padTag("y")}Play again</span></button></div>`
        : `<div class="row">${quit}<p class="btn c-p1 grow btn-note">The host can start a rematch.</p></div>`;
    const heading = resultTitle(mood, title, sub);
    const lag = ((performance.now() - board.resultShown.at) / 1000).toFixed(2);
    // the verdict and the graph float over the table; the green panel holds the rest
    return `<div class="summary-scrim" style="--t:-${lag}s"></div><section class="summary floating" role="dialog" aria-label="Results" style="--t:-${lag}s">${heading}${evalChart()}<div class="panel c-fw summary-panel"><div class="ready-tiles">${tiles}</div><div class="stack">${action}<button type="button" class="btn small c-fw" data-summary-toggle>${glyph("eye.fill", 20)} View table</button></div></div><div class="emote-pop summary-emotes" role="group" aria-label="Quick emotes">${emoteButtons()}</div></section>`;
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
/** Flips play at once: there is no confirm step for turning a card over. */
function flipMove(ref) {
  haptic("flip");
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
/**
 * After a flip, the card just turned over is the only one in play: it has to
 * be swapped, or left where it is. It stays selected until that is settled.
 */
function pinnedCard() {
  const g = state?.game;
  if (!g || !myTurn() || !["revealed", "drawn_revealed"].includes(g.phase)) return null;
  return g.legal.swap.length === 1 ? [state.viewer, g.legal.swap[0]] : null;
}
function paintSelection() {
  if (!board.el) return;
  // nothing can be picked up when it is not your turn, so nothing stays outlined
  board.selected = myTurn() ? board.selected.filter((ref) => slotFor(ref)) : [];
  const pinned = pinnedCard();
  if (pinned && !board.staged && !board.carry && !board.drag?.active) board.selected = [pinned];
  board.slots.forEach((slot) => {
    const ref = JSON.parse(slot.dataset.ref);
    slot.classList.toggle("selected", hasRef(board.selected, ref));
    slot.classList.toggle(
      "can-act",
      !slot.classList.contains("empty") &&
        (canFlip(ref) || movesFrom(ref).length > 0),
    );
  });
  const staged = board.staged,
    carry = board.carry;
  if (staged)
    showTargets([]); // the preview itself shows the move
  else if (carry) {
    showTargets(carry.moves);
    if (carry.hot) slotFor(carry.hot.ref)?.classList.add("hot");
  } else if (!board.drag?.active)
    showTargets(board.selected.length === 1 ? movesFrom(board.selected[0]) : []);
  board.el
    .querySelectorAll("[data-actionbar] [data-action], [data-side-actions] [data-action]")
    .forEach((button) => {
      button.disabled = !actionAllowed(button.dataset.action);
    });
  // Beside the piles: Undo and Confirm while a move is staged; otherwise
  // whichever table actions can be used right now (phones).
  const confirm = board.el.querySelector("[data-confirm]");
  confirm.hidden = !staged?.ready;
  if (staged) confirm.setAttribute("aria-label", `Confirm: ${staged.label}`);
  board.el.querySelector("[data-undo]").hidden = !staged?.ready;
  board.el.querySelectorAll("[data-side-actions] [data-action]").forEach((button) => {
    button.hidden = !!staged || button.disabled;
  });
}

/* ---------- confirm step, and trigger-drag for controllers ---------- */
const wantsConfirm = () => prefs.confirm;
/** Play a move now, or (with the confirm step on) stage it for the Confirm button. */
function playMove(action, extra = {}, info = {}) {
  if (!wantsConfirm()) return move(action, extra);
  if (!busy) stageMove({ action, extra, ...info });
  return Promise.resolve(false);
}
/**
 * Where each card ends up if this move is played: [card's slot, slot it lands on].
 * Flips and draws reveal a card nobody has seen yet, so they have no preview.
 */
function previewPlan(item) {
  const { action, extra } = item;
  const discard = slotFor(["discard", null]);
  if (action === "discard") return [[slotFor(["held", null]), discard]];
  if (action !== "swap") return [];
  if (extra.refs) {
    // two table cards trade places (bonus swap, Beggars trade)
    const [a, b] = extra.refs.map(slotFor);
    return [
      [a, b],
      [b, a],
    ];
  }
  // the drawn card (or the top discard) goes into the hand; the card it
  // replaces goes onto the discard pile
  const hand = slotFor([state.viewer, extra.index]);
  const incoming = state.game.held ? slotFor(["held", null]) : discard;
  return [
    [incoming, hand],
    [hand, discard],
  ];
}
function stageMove(staged) {
  if (board.staged) cancelStaged(false);
  const item = (board.staged = { ...staged, version: state.version, ready: false, movers: [] });
  const plan = previewPlan(item).filter(([slot, to]) => slot && to && slot !== to);
  board.selected = item.from && !plan.length ? [item.from] : [];
  board.lastTap = null;
  paintSelection();
  // Confirm and Undo show up once the move has played out in front of you
  const ready = () => {
    if (board.staged !== item || item.ready) return;
    item.ready = true;
    paintSelection();
  };
  if (!plan.length) return item.from ? setTimeout(ready, 240) : ready();
  // Preview: every card involved travels to where the move will leave it, and
  // turns to lie the way its new place does. Undo sends them all back.
  const offset = (slot, key) => motionFor(slot).values[key]?.value || 0;
  const rest = new Map(); // where each slot sits when nothing is moving it
  for (const slot of new Set(plan.flat())) {
    const pose = poseOf(slot);
    rest.set(slot, {
      x: pose.x - offset(slot, "x"),
      y: pose.y - offset(slot, "y"),
      angle: pose.angle - offset(slot, "lean"),
    });
  }
  for (const [slot, to] of plan) {
    if (slot.classList.contains("empty")) continue;
    const from = rest.get(slot),
      goal = rest.get(to);
    item.movers.push(slot);
    slot.classList.remove("returning");
    slot.classList.add("dragging");
    motionFor(slot).to({
      x: goal.x - from.x,
      y: goal.y - from.y,
      lean: goal.angle - from.angle,
      scale: 1.04,
      lift: 0.8,
      rx: 0,
      ry: 0,
    });
  }
  haptic("snap");
  setTimeout(ready, 420);
}
function cancelStaged(paint = true) {
  const staged = board.staged;
  if (!staged) return;
  board.staged = null;
  for (const slot of staged.movers) if (slot.isConnected) releaseDrag(slot);
  board.selected = [];
  if (paint) paintSelection();
}
async function confirmStaged() {
  const staged = board.staged;
  if (!staged || !staged.ready || busy) return false;
  board.staged = null;
  board.selected = [];
  paintSelection();
  haptic("drop");
  // the cards stay where the preview left them; the new state settles from there
  const ok = await move(staged.action, staged.extra);
  for (const slot of staged.movers) {
    if (!slot.isConnected) continue;
    if (ok) slot.classList.remove("dragging");
    else releaseDrag(slot);
  }
  if (ok)
    for (const slot of staged.movers)
      if (slot.isConnected && Object.keys(motionFor(slot).values).length) releaseDrag(slot);
  return ok;
}
/** Play a move for a card that is being held away from its slot. */
async function dropCard(slot, ref, item) {
  // Hold the card where it was dropped; the state update animates from there.
  motionFor(slot).to({ lean: 0, scale: 1.04 });
  board.pendingDrop = { key: refKey(ref), pose: poseOf(slot) };
  const ok = await move(item.action, item.extra);
  if (board.pendingDrop?.key === refKey(ref)) board.pendingDrop = null;
  if (!ok || slot.classList.contains("dragging")) releaseDrag(slot);
  return ok;
}
/** Pick a card up with the controller: it then rides along with the cursor. */
function grabCard(slot) {
  if (busy || board.carry || board.staged || board.drag) return false;
  const ref = JSON.parse(slot.dataset.ref);
  const moves = movesFrom(ref).filter((item) => {
    const target = slotFor(item.ref);
    return target && !target.classList.contains("empty");
  });
  if (!moves.length) {
    popSlot(slot, 0.3);
    return false;
  }
  board.selected = [];
  board.lastTap = null;
  paintSelection();
  board.carry = { slot, ref, moves, hot: null, home: poseOf(slot), x: 0, y: 0, version: state.version };
  slot.classList.remove("returning");
  slot.classList.add("dragging");
  showTargets(moves);
  motionFor(slot).to({ scale: 1.14, lift: 1 }).kick({ scale: 2.4 });
  haptic("grab");
  return true;
}
/**
 * Move the carried card freely by a step (in px). Near a place it can go, it
 * snaps onto it; pushing on past the edge of that pull lets it go again.
 */
function carryBy(dx, dy) {
  const carry = board.carry;
  if (!carry) return;
  const bounds = board.el.getBoundingClientRect();
  carry.x = clamp(carry.x + dx, bounds.left - carry.home.x, bounds.right - carry.home.x);
  carry.y = clamp(carry.y + dy, bounds.top - carry.home.y, bounds.bottom - carry.home.y);
  const at = { x: carry.home.x + carry.x, y: carry.home.y + carry.y };
  const well = (item) => {
    const rect = slotFor(item.ref).getBoundingClientRect();
    const x = rect.left + rect.width / 2,
      y = rect.top + rect.height / 2;
    return { x, y, pull: Math.max(rect.width, rect.height) * 0.5, away: Math.hypot(at.x - x, at.y - y) };
  };
  let hot = carry.hot;
  // already snapped: it takes a firm push (a wider radius) to pull free
  if (hot && well(hot).away > well(hot).pull * 1.3) hot = null;
  if (!hot) {
    let nearest = Infinity;
    for (const item of carry.moves) {
      const spot = well(item);
      if (spot.away < spot.pull && spot.away < nearest) [hot, nearest] = [item, spot.away];
    }
    if (hot) {
      // the free position jumps to the centre too, so leaving takes real travel
      const spot = well(hot);
      carry.x = spot.x - carry.home.x;
      carry.y = spot.y - carry.home.y;
    }
  }
  const motion = motionFor(carry.slot);
  if (hot !== carry.hot) {
    if (carry.hot) slotFor(carry.hot.ref)?.classList.remove("hot");
    carry.hot = hot;
    if (hot) {
      slotFor(hot.ref).classList.add("hot");
      motion.kick({ scale: 1.2 });
      haptic("snap");
    }
  }
  const shown = hot ? well(hot) : at;
  // lean into the direction of travel, as a dragged card does
  motion.to({
    x: shown.x - carry.home.x,
    y: shown.y - carry.home.y,
    lean: hot ? 0 : clamp(dx * 1.6, -18, 18),
  });
}
/** Let go: play the move under the card, or put the card back. */
function dropCarry() {
  const carry = board.carry;
  if (!carry) return;
  board.carry = null;
  clearTargets();
  const item = carry.hot;
  if (!item || busy) {
    releaseDrag(carry.slot);
    paintSelection();
    return;
  }
  if (wantsConfirm())
    return stageMove({ ...item, to: item.ref, from: carry.ref });
  haptic("drop");
  paintSelection();
  return dropCard(carry.slot, carry.ref, item);
}
function cancelCarry(paint = true) {
  const carry = board.carry;
  if (!carry) return;
  board.carry = null;
  if (carry.slot.isConnected) releaseDrag(carry.slot);
  if (paint) paintSelection();
}

/** Desktop action bar: the same moves, driven by the current selection. */
function barAction(action) {
  const picked = board.selected;
  if (action === "flip") return picked.length ? flipMove(picked[0]) : null;
  if (action === "swap") {
    if (picked.length === 2) {
      const item = movesFrom(picked[0]).find((m) => same(m.ref, picked[1]));
      return item
        ? playMove(item.action, item.extra, { from: picked[0], to: picked[1], label: item.label })
        : null;
    }
    return playMove("swap", { index: picked[0][1] }, { from: picked[0], label: "swap" });
  }
  if (action === "discard")
    return playMove("discard", {}, { from: ["held", null], to: ["discard", null], label: "discard" });
  return move(action);
}

/* ---------- pointer input ---------- */
function setHover(slot, event) {
  if (board.hover && board.hover !== slot && !board.hover.classList.contains("dragging"))
    motionFor(board.hover).to({ rx: 0, ry: 0, scale: 1 });
  board.hover = slot;
  // a card being dragged or previewing a staged move is away from its slot:
  // measuring the pointer against the slot would spin it right over
  if (!slot || !event || slot.classList.contains("empty") || slot.classList.contains("dragging"))
    return;
  const rect = slot.getBoundingClientRect();
  const px = clamp((event.clientX - rect.left) / rect.width - 0.5, -0.5, 0.5);
  const py = clamp((event.clientY - rect.top) / rect.height - 0.5, -0.5, 0.5);
  const targets = { ry: px * 20, rx: -py * 20 };
  if (!slot.classList.contains("selected"))
    targets.scale = slot.classList.contains("can-act") ? 1.06 : 1.02;
  motionFor(slot).to(targets);
}
function onBoardPointerDown(event) {
  let slot = event.target.closest(".slot");
  // with a card drawn, the go-fish pile can't be drawn from again: a press on
  // the pile's visible edge means the drawn card sitting on top of it
  if (slot?.dataset.ref === '["draw",null]' && state.game?.held)
    slot = slotFor(["held", null]) || slot;
  // touching anything but Confirm calls a staged move off
  if (board.staged && !event.target.closest("[data-confirm]")) {
    const moved = board.staged.movers.includes(slot);
    cancelStaged();
    if (moved || event.target.closest("[data-undo]")) return; // the cards just go back
  }
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
  haptic("grab");
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
    if (swipeFromCard(drag, dx, dy)) return;
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
      haptic("snap");
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
  if (wantsConfirm() && drag.hot) {
    // the cards play the move out, then wait for Confirm (a draw just happens)
    stageMove({ ...drag.hot, to: drag.hot.ref, from: drag.ref });
    return;
  }
  // Hold the card where it was dropped; the state update animates from there.
  haptic("drop");
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
  if (!myTurn()) return popSlot(slot, 0.3); // not your turn: a nudge, no selection
  const pinned = pinnedCard();
  if (pinned) {
    // the flipped card keeps the selection: other cards can only receive it
    const item = same(ref, pinned) ? null : movesFrom(pinned).find((m) => same(m.ref, ref));
    if (item && !busy) {
      board.selected = [];
      paintSelection();
      playMove(item.action, item.extra, { from: pinned, to: ref, label: item.label });
      return;
    }
    popSlot(slot, same(ref, pinned) ? 0.45 : 0.3);
    board.selected = [pinned];
    paintSelection();
    return;
  }
  if (board.selected.length === 1 && !same(board.selected[0], ref)) {
    const item = movesFrom(board.selected[0]).find((m) => same(m.ref, ref));
    if (item && !busy) {
      const from = board.selected[0];
      board.selected = [];
      paintSelection();
      playMove(item.action, item.extra, { from, to: ref, label: item.label });
      return;
    }
  }
  board.selected = hasRef(board.selected, ref) ? [] : [ref];
  popSlot(slot, 0.45);
  paintSelection();
}

/* ---------- swipe between opponents ---------- */
// A sideways swipe anywhere on the opponent's side of the table (or on the
// cycle button) drags that side along with it; a tap on the button cycles.
let tableSwipe = null,
  swipeEnded = 0;
function trackSwipe(event) {
  tableSwipe = {
    pointer: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    dx: 0,
    at: event.clientX,
    time: performance.now(),
    velocity: 0,
    slide: null,
    plain: false, // reduced motion: nothing follows the finger, the swipe just changes opponent
  };
}
/** A card that has nowhere to go can't be dragged off, so a sideways pull on an opponent's swipes instead. */
function swipeFromCard(drag, dx, dy) {
  if (!canCycle() || Math.abs(dx) <= Math.abs(dy)) return false;
  if (!drag.slot.closest("[data-hand='opp']") || movesFrom(drag.ref).length) return false;
  board.drag = null;
  try {
    drag.slot.releasePointerCapture(drag.pointer);
  } catch {}
  motionFor(drag.slot).to({ scale: 1 });
  trackSwipe({ pointerId: drag.pointer, clientX: drag.startX, clientY: drag.startY });
  return true;
}
document.addEventListener("pointerdown", (event) => {
  if (tableSwipe?.slide || tableSwipe?.plain) {
    if (!event.isPrimary) return; // a second finger, while the first is still swiping
    endSwipe({ type: "pointercancel", pointerId: tableSwipe.pointer }); // its lift was never reported
  }
  const zone = event.target.closest?.(".board:not(.board-ghost) .b-top");
  tableSwipe = null;
  if (zone && !event.target.closest(".slot") && !(event.button > 0) && canCycle()) trackSwipe(event);
});
document.addEventListener("pointermove", (event) => {
  const swipe = tableSwipe;
  if (!swipe || event.pointerId !== swipe.pointer) return;
  // a mouse let go outside the window never said so
  if (event.pointerType === "mouse" && !event.buttons)
    return endSwipe({ type: "pointercancel", pointerId: event.pointerId });
  const dx = event.clientX - swipe.x,
    dy = event.clientY - swipe.y;
  swipe.dx = dx;
  if (swipe.plain) return;
  if (!swipe.slide) {
    if (Math.hypot(dx, dy) < DRAG_START) return;
    if (Math.abs(dx) <= Math.abs(dy) || !canCycle()) return void (tableSwipe = null);
    // the table takes the pointer: what was pressed is about to be redrawn
    try {
      board.el.setPointerCapture(event.pointerId);
    } catch {}
  } else if (board.slide !== swipe.slide) return void (tableSwipe = null); // something else moved the table on
  const direction = dx < 0 ? 1 : -1;
  if (!swipe.slide || (swipe.slide.direction !== direction && Math.abs(dx) > DRAG_START)) {
    // starting out, or pulled back past where it began: the other neighbour comes in
    if (swipe.slide) endSlide(swipe.slide);
    swipe.slide = beginSlide(direction);
    if (!swipe.slide) return void (swipe.plain = true);
  }
  const now = performance.now();
  swipe.velocity = swipe.velocity * 0.6 + ((event.clientX - swipe.at) / Math.max(1, now - swipe.time)) * 0.4;
  swipe.at = event.clientX;
  swipe.time = now;
  setSlide(swipe.slide, dx);
});
function endSwipe(event) {
  const swipe = tableSwipe;
  if (!swipe || event.pointerId !== swipe.pointer) return;
  tableSwipe = null;
  const slide = swipe.slide;
  if (!slide && !swipe.plain) return;
  swipeEnded = performance.now(); // the press was a swipe, not a tap on whatever it started on
  try {
    board.el.releasePointerCapture(event.pointerId);
  } catch {}
  const lifted = event.type === "pointerup";
  if (swipe.plain) {
    if (lifted && Math.abs(swipe.dx) > 24) cycleOpponent(swipe.dx < 0 ? 1 : -1);
    return;
  }
  if (board.slide !== slide) return;
  // it goes over when carried far enough across, or flicked that way (px per
  // ms; a finger that stopped before lifting has no flick left)
  const flick = performance.now() - swipe.time < 120 ? swipe.velocity * -slide.direction : 0;
  const far = Math.abs(slide.x) > slide.width * 0.3;
  const commit = lifted && (flick > 0.35 || (far && flick > -0.2));
  settleSlide(slide, commit);
  if (commit) spinCycle(slide.direction);
}
document.addEventListener("pointerup", endSwipe);
document.addEventListener("pointercancel", endSwipe);
document.addEventListener(
  "click",
  (event) => {
    if (performance.now() - swipeEnded < 200) {
      // the click that ends a swipe opens nothing
      swipeEnded = 0;
      event.stopPropagation();
      event.preventDefault();
    } else if (event.target.closest?.("[data-cycle-next]")) cycleOpponent(1);
  },
  true,
);
/* ---------- trackpad: a sideways scroll turns the table too ---------- */
// The opponent's side follows the scroll like a finger dragging it, and goes
// over once it is carried far enough. A trackpad then keeps sending the
// scroll's momentum for a second or more: that is ignored, but a fresh swipe
// made while it is still dying away is not.
const wheelSwipe = { slide: null, x: 0, y: 0, spent: 0, peak: 0, falling: false, trough: 0, timer: 0 };
function onBoardWheel(event) {
  // pinch-zooming, and the panels over the table that scroll, are left alone
  if (event.ctrlKey || !canCycle() || event.target.closest?.(".summary, .modal-shade, .emote-pop")) return;
  // Every event of a scroll is claimed, from the very first (often a nudge of
  // nothing, or slightly up or down): one that is let go hands the whole swipe
  // to the browser, which keeps it for its own back and forward gesture.
  event.preventDefault();
  clearTimeout(wheelSwipe.timer);
  wheelSwipe.timer = setTimeout(endWheel, 140); // the scroll has stopped
  if (tableSwipe?.slide) return;
  const unit = event.deltaMode === 1 ? 16 : 1;
  const dx = -event.deltaX * unit; // scrolling right moves what is under the pointer to the left
  const size = Math.abs(dx);
  if (wheelSwipe.spent) {
    // What follows a swipe that has gone over is its own tail: the finger
    // slowing, then momentum, which only ever fades and never turns round.
    // Once that has clearly passed its peak, a scroll that picks up again (or
    // goes the other way) is a new swipe.
    let fresh = Math.sign(dx) === -wheelSwipe.spent && size > 6;
    if (!wheelSwipe.falling) {
      wheelSwipe.peak = Math.max(wheelSwipe.peak, size);
      if (size <= wheelSwipe.peak / 2) Object.assign(wheelSwipe, { falling: true, trough: size });
    } else {
      wheelSwipe.trough = Math.min(wheelSwipe.trough, size);
      fresh ||= size > wheelSwipe.trough * 1.5 + 6;
    }
    if (!fresh) return;
    Object.assign(wheelSwipe, { slide: null, x: 0, y: 0, spent: 0 });
  }
  wheelSwipe.x += dx;
  wheelSwipe.y += Math.abs(event.deltaY) * unit;
  if (wheelSwipe.slide && board.slide !== wheelSwipe.slide) wheelSwipe.slide = null; // something else moved the table on
  let slide = wheelSwipe.slide;
  // a scroll that has barely begun, or is mostly up and down, moves nothing yet
  if (!slide && (Math.abs(wheelSwipe.x) < 6 || Math.abs(wheelSwipe.x) <= wheelSwipe.y)) return;
  const direction = wheelSwipe.x < 0 ? 1 : -1;
  const spend = () => Object.assign(wheelSwipe, { slide: null, spent: Math.sign(dx) || -direction, peak: size, falling: false });
  if (!slide || slide.direction !== direction) {
    if (slide) endSlide(slide);
    slide = wheelSwipe.slide = beginSlide(direction);
    if (!slide) {
      // reduced motion: nothing follows the scroll, a firm one just changes opponent
      if (Math.abs(wheelSwipe.x) > 60) {
        spend();
        cycleOpponent(direction);
      }
      return;
    }
  }
  setSlide(slide, wheelSwipe.x);
  if (Math.abs(slide.x) < slide.width * 0.35) return;
  spend();
  settleSlide(slide, true);
  spinCycle(direction);
}
function endWheel() {
  const slide = wheelSwipe.slide;
  Object.assign(wheelSwipe, { slide: null, x: 0, y: 0, spent: 0 });
  if (!slide || board.slide !== slide) return;
  // a short scroll that stopped: far enough to count, or back it goes
  const commit = Math.abs(slide.x) > slide.width * 0.15;
  settleSlide(slide, commit);
  if (commit) spinCycle(slide.direction);
}
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
  const visible = (g.base_scores ?? g.scores)[player],
    total = g.effect_totals[player];
  const enabled = catalog.filter((rule) => state.rules[rule.key]);
  const editable = g.legal.set_rules;
  const ordered = [...(editable ? catalog : enabled)].sort((a,b) =>
    Number(active.includes(b.key)) - Number(active.includes(a.key)) ||
    Number(!!matchOptions.house_rules[b.key]) - Number(!!matchOptions.house_rules[a.key]));
  const others = state.names.map((_, p) => p).filter((p) => p !== player);
  return `<section class="sheet ${color}" role="dialog" aria-modal="true" aria-label="Rules in play">
    <div class="sheet-head"><h2>${player === state.viewer ? youStar() : ""}${e(state.names[player])}</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    <div class="tally">
      <div><span>Face-up cards</span><b>${visible} pts</b></div>
      ${effects.map((effect) => `<div class="effect"><span class="effect-ico">${groupStickers(effectStickers(effect)).map((sticker) => ruleStickerHtml(sticker, 24)).join("")}</span>${effectParts(effect)}</div>`).join("") || "<div><span>No rules are affecting this hand yet</span></div>"}
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
