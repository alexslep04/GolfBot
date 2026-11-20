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
// Colors go by seat, so every screen shows the same player in the same color:
// player 1 blue, 2 red, 3 yellow, 4 purple, 5 orange, 6 dark blue, 7 lavender,
// 8 dark green (then round again at bigger tables).
const SEAT_COLORS = ["c-s0", "c-s1", "c-s2", "c-s3", "c-s4", "c-s5", "c-s6", "c-s7"];
const OPPONENT_COLORS = ["c-p1", ...SEAT_COLORS]; // every class a tag may be wearing
const RULE_ICON = {
  royal_pairs: "crown.fill",
  angel_numbers: "sparkles",
  king_queen: "paintpalette.fill",
  holdem: "hand.raised.fill",
  v10: "v.circle",
  tricky_straights: "stairs",
  ripped_five: "scissors",
  roman_fives: "building.columns.fill",
  beggars: "questionmark.circle.fill",
  four_kind: "square.grid.2x2.fill",
  poisoned_card: "flag.pattern.checkered",
  suited_rows: "rectangle.split.1x2.fill",
  all_in_color: "circle.lefthalf.filled",
};
// Rules with more than one way to trigger get a sticker per variant, drawn from
// one visual family so they read as siblings: [symbol, what it means].
const RULE_VARIANTS = {
  angel_numbers: [
    ["flame.fill", "666: opponents ×6"],
    ["dice.fill", "777: your score ÷7"],
    ["8.circle.fill", "888: opponents ×8"],
    ["star.fill", "999: your score ÷9"],
  ],
  royal_pairs: [
    ["j.circle.fill", "Jack pair"],
    ["q.circle.fill", "Queen pair"],
  ],
  king_queen: [
    ["equal.circle.fill", "Same color: 5 pts"],
    ["notequal.circle.fill", "Different colors: 15 pts"],
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
  [/^V2 /, "roman_fives"],
  [/Angel \d{3}/, "angel_numbers"],
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
const DOUBLE_TAP_MS = 400; // from one tap's lift to the next one's press
const TAP_SLOP = 30; // px a quick tap may slide and still count as a tap…
const TAP_SLOP_MS = 280; // …if it was over this soon

const board = {
  el: null,
  key: "",
  view: null,
  slots: new Map(),
  selected: [],
  drag: null,
  hover: null,
  lastTap: null,
  primed: new Map(), // cards already turning while the server is asked to flip them
  guessHeld: null, // the card just flipped, held up while an opponent guesses at it
  queuedFlip: null, // a flip asked for while another move was still on its way
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
function neighbor(direction) {
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
    board.viewedOpponent = neighbor(direction);
    renderBoard();
  }
  spinCycle(direction);
}
/** Turn the table to one player's board: a slide when they sit next door. */
function goToOpponent(player) {
  if (!canCycle() || player === opponentSeat()) return;
  if (neighbor(1) === player) return cycleOpponent(1);
  if (neighbor(-1) === player) return cycleOpponent(-1);
  board.viewedOpponent = player;
  renderBoard();
  spinCycle(1);
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
    to = neighbor(direction);
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
/** `x` is how far the side being left has traveled: 0 is at rest, a full width is gone. */
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
  void slide.top.offsetWidth; // the tags take their color before they may fade again
  slide.top.classList.remove("sliding");
  for (const name of ["--slide", "--slide-opacity", "--slide-blur"]) slide.top.style.removeProperty(name);
  slide.shell.remove();
}
function colorFor(player) {
  return SEAT_COLORS[player % SEAT_COLORS.length];
}

/* ---------- the cycle button's name ---------- */
// radii of the two arcs the name is set on under the arrows (the second, outer
// one only when the name is too long for the first)
const CYCLE_ARCS = [40, 54];
const CYCLE_SWEEP = (135 / 180) * Math.PI; // the most of the circle a line may take
/**
 * Set a name round the bottom of the cycle button: on one arc if it fits in
 * 135° of it, otherwise broken onto a second arc further out (at a space if
 * one fits, else mid-word with a dash); whatever still does not fit ends in "…".
 */
function layoutCycleName(holder, name) {
  const [first, second] = holder.querySelectorAll("textPath");
  if (!first) return;
  const fits = (path, text, radius) => {
    path.textContent = text;
    const measure = path.parentNode.getComputedTextLength?.();
    return measure === undefined || measure <= radius * CYCLE_SWEEP;
  };
  const chars = [...name];
  if (fits(first, name, CYCLE_ARCS[0])) return void (second.textContent = "");
  // the longest start that fits: at a space, or with a dash
  let cut = chars.length - 1;
  while (cut > 1 && !fits(first, chars.slice(0, cut).join("") + "-", CYCLE_ARCS[0])) cut--;
  const space = chars.slice(0, cut + 1).lastIndexOf(" ");
  if (space > 0 && fits(first, chars.slice(0, space).join(""), CYCLE_ARCS[0])) {
    first.textContent = chars.slice(0, space).join("");
    cut = space + 1;
  } else first.textContent = chars.slice(0, cut).join("") + "-";
  let rest = chars.slice(cut);
  if (!fits(second, rest.join(""), CYCLE_ARCS[1])) {
    while (rest.length > 1 && !fits(second, rest.join("").trimEnd() + "…", CYCLE_ARCS[1])) rest = rest.slice(0, -1);
    second.textContent = rest.join("").trimEnd() + "…";
  }
}
/**
 * Each letter as its own sticker, the leftmost on top: SVG paints later
 * letters over earlier ones, so they are laid out where the whole line put
 * them and then drawn right to left.
 */
function stackCycleName(holder) {
  holder.querySelectorAll("text.glyph").forEach((glyph) => glyph.remove());
  holder.querySelectorAll("textPath").forEach((path, line) => {
    const text = path.parentNode,
      chars = [...path.textContent];
    if (!chars.length || !text.getSubStringLength || !text.getComputedTextLength) return;
    const arc = holder.querySelector(`#cycle-arc-${line}`);
    const start = arc.getTotalLength() / 2 - text.getComputedTextLength() / 2;
    let offset = start,
      index = 0;
    const placed = chars.map((char) => {
      const at = offset;
      offset += text.getSubStringLength(index, char.length);
      index += char.length;
      return [char, at];
    });
    text.style.visibility = "hidden";
    for (const [char, at] of placed.reverse()) {
      const glyph = document.createElementNS("http://www.w3.org/2000/svg", "text");
      glyph.setAttribute("class", "glyph");
      const on = document.createElementNS("http://www.w3.org/2000/svg", "textPath");
      on.setAttribute("href", `#cycle-arc-${line}`);
      on.setAttribute("startOffset", at.toFixed(2));
      on.textContent = char;
      glyph.appendChild(on);
      text.parentNode.appendChild(glyph);
    }
  });
}

/* ---------- card markup ---------- */
/** `rippedFive`: whether the 5 of diamonds wears its torn skin (only with the rule in play at the table). */
function faceHtml(card, rippedFive = !!state?.rules?.ripped_five) {
  if (!card)
    return `<span class="face front"></span><span class="face back"></span>`;
  const red = card.suit === "H" || card.suit === "D";
  const corner = `<span class="corner"><b>${e(card.label)}</b>${icon(SUIT_ICON[card.suit], 16, { idle: false, flat: true, sw: 2.4 })}</span>`;
  // the 5 of diamonds is the ripped 5: torn across the middle (and only when that rule is on)
  const ripped = rippedFive && card.suit === "D" && card.rank === 5 ? " ripped" : "";
  // (its two halves are drawn apart, so they can tear open as it turns over)
  const halves = ripped ? `<span class="rip-half top"></span><span class="rip-half bottom"></span>` : "";
  return `<span class="face front${red ? " red" : ""} suit-${card.suit}${ripped}">${halves}${corner}${corner}</span><span class="face back"></span>`;
}
function slotHtml(ref, tilt, extra = "") {
  return `<button type="button" class="slot ${extra}" data-ref='${e(JSON.stringify(ref))}' style="--rot:${tilt}deg"><span class="shadow"></span><span class="card"><span class="card-flip">${faceHtml(null)}</span></span><span class="move-label"></span></button>`;
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
        <button type="button" class="tag tag-score" data-score-for="opp" data-stats-for="opp"><span class="tag-in"></span><span class="watch-badge" data-watch-badge hidden></span><span class="turn-label" data-turn-label aria-hidden="true">Up next</span></button>
        <span class="tag-avatar" data-avatar-for="opp" aria-hidden="true"></span>
        <div class="turn-slot" data-turn-slot></div>
        <div class="side-row">
          <div class="streak" data-streak data-practice-streak role="img" hidden></div>
          <div class="cycle-wrap"><button type="button" class="cycle" data-cycle-next hidden><span class="cycle-ico"></span><span class="cycle-name"></span></button><div class="cycle-emotes" data-emote-others></div></div>
        </div>
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
          <button type="button" class="tag tag-score c-p1" data-score-for="me" data-stats-for="me"><span class="tag-in"></span><span class="watch-badge" data-watch-badge hidden></span><span class="turn-label" data-turn-label aria-hidden="true">Your turn</span></button>
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
  // inside the table, "player 1 blue" (--p1) becomes your own seat's color
  board.el.dataset.seat = String(me % SEAT_COLORS.length);
  board.signatures = {};
  board.view = null;
  board.selected = [];
  board.drag = null;
  board.pendingDrop = null;
  board.primed = new Map();
  board.guessHeld = null;
  board.guessSeen = undefined;
  board.queuedFlip = null;
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
          : `${owner} ${faceUp ? cardName(entry.card) : "face-down card"}, row ${Math.floor(ref[1] / 3) + 1}, column ${(ref[1] % 3) + 1}`,
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
  drainFlip();
  settlePrimed();
  reportGuess();
}
/** An info card for each Beggars guess someone else makes: the rank they called, and what the card was. */
function reportGuess() {
  const guess = state.game.last_guess;
  const key = guess ? `${state.id}|${state.round}|${guess.count}` : "";
  const seen = board.guessSeen;
  board.guessSeen = key;
  // arriving at a table, a guess made before you got here is old news
  if (seen === undefined || !guess || key === seen || guess.player === state.viewer) return;
  const named = (rank) => {
    const name = { 1: "Ace", 11: "Jack", 12: "Queen", 13: "King" }[rank] || String(rank);
    return `${[1, 8].includes(rank) ? "an" : "a"} ${name}`;
  };
  const who = state.names[guess.player];
  const whose = guess.owner === state.viewer ? "your card" : `${state.names[guess.owner]}'s card`;
  toast(
    guess.rank === null
      ? `Beggars: ${who} passed on guessing ${whose}.`
      : guess.correct
        ? `Beggars: ${who} guessed ${named(guess.rank)} for ${whose}, and got it right!`
        : `Beggars: ${who} guessed ${named(guess.rank)} for ${whose}. It was ${named(guess.card)}.`,
  );
}
/** Lay down a card held up for a Beggars guess if the guess ends without turning it (the table moved on, say). */
function settlePrimed() {
  const ref = board.guessHeld;
  if (!ref || busy || state.game.phase === "guess") return;
  board.guessHeld = null;
  unprime(ref); // nothing to do once it has turned over
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
  // A card that began turning when it was double-tapped finishes from there.
  const primedFace = {};
  for (const key of changedKeys) {
    if (!board.primed.has(key)) continue;
    primedFace[key] = motionFor(board.primed.get(key)).values.face?.value;
    board.primed.delete(key);
  }
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
    } else if (before[key].key === "X" && after[key].key !== "X") {
      if (primedFace[key] !== undefined) flipSlot(slot, true, 0, primedFace[key]);
      else flipSlot(slot, true, reveal++ * 70);
    }
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

/**
 * A score that changes rolls like an odometer: each place whose digit changed
 * scrolls its new digit in (from below when the score rises, from above when
 * it falls) while the old one scrolls out the other way, both blurring and
 * fading as they move. The ones turn first and each place after a beat later.
 */
function rollScore(score, oldDigits, oldBox) {
  const digits = score?.querySelector(".digits");
  if (!digits?.animate || !oldDigits || !oldBox?.width || reducedMotion.matches) return;
  const before = oldDigits.textContent,
    after = digits.textContent;
  const up = (parseInt(after, 10) || 0) > (parseInt(before, 10) || 0) ? 1 : -1;
  // the old number, laid exactly where it stood, shows only the digits leaving
  const ghost = oldDigits.cloneNode(true);
  const at = score.getBoundingClientRect();
  ghost.classList.add("roll-out");
  ghost.setAttribute("aria-hidden", "true");
  ghost.style.cssText = `left:${oldBox.left - at.left}px;top:${oldBox.top - at.top}px;width:${oldBox.width}px`;
  score.appendChild(ghost);
  const olds = [...ghost.children],
    news = [...digits.children];
  // the new digit pushes the old one out of the way: both travel together, a
  // whole digit's height, on the same curve
  // (held only before they start: kept after the end, the last frame's filter
  // would replace the digit's sticker texture for good)
  const timing = (place) => ({ duration: 380, delay: place * 60, easing: "cubic-bezier(0.3, 0.75, 0.3, 1.08)", fill: "backwards" });
  const places = Math.max(olds.length, news.length);
  let last = null;
  for (let place = 0; place < places; place++) {
    const gone = olds[olds.length - 1 - place],
      come = news[news.length - 1 - place];
    if (gone && come && gone.textContent === come.textContent) {
      gone.style.visibility = "hidden";
      continue;
    }
    if (come)
      come.animate(
        [
          { translate: `0 ${up * 0.9}em`, filter: "blur(0.3rem)", opacity: 0 },
          { translate: `0 ${up * 0.3}em`, filter: "blur(0.1rem)", opacity: 1, offset: 0.45 },
          { translate: "0 0", filter: "blur(0)", opacity: 1 },
        ],
        timing(place),
      );
    if (gone)
      last = gone.animate(
        [
          { translate: "0 0", filter: "blur(0)", opacity: 1 },
          { translate: `0 ${-up * 0.6}em`, filter: "blur(0.2rem)", opacity: 0.6, offset: 0.45 },
          { translate: `0 ${-up * 0.9}em`, filter: "blur(0.3rem)", opacity: 0 },
        ],
        { ...timing(place), fill: "both" },
      );
  }
  if (last) last.finished.then(() => ghost.remove(), () => ghost.remove());
  else ghost.remove();
}

/** A chance of winning as a spectator reads it: whole percents, never a flat 0 or 100 while it could still go either way. */
function oddsText(value) {
  if (value === null || value === undefined) return null;
  if (value > 0 && value < 1) return "<1%";
  if (value > 99 && value < 100) return ">99%";
  return `${Math.round(value)}%`;
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
 * maths can sit in the right-hand column: "Poisoned Card: +1" and "V2 /2"
 * become "Poisoned Card" | "+1" and "V2" | "/2".
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
  else if (rule === "angel_numbers") add(rule, Number(effect.match(/Angel (\d)/)[1]) - 6);
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
function ruleStickers(player, effects = state.game.effects[player]) {
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
  for (const effect of effects || []) pairs.push(...effectStickers(effect));
  return groupStickers(pairs);
}
function activeRules(player) {
  if (state.game.rule_previews) return Object.keys(state.game.rule_previews[player] || {});
  return [...new Set(ruleStickers(player).map((sticker) => sticker.rule))];
}
/** The plain points of a hand's face-up cards, before any pairing or rule. */
function faceValue(player) {
  return state.game.players[player].reduce((sum, slot) => sum + (slot.visible ? slot.card.points : 0), 0);
}
const signed = (points) => `${points > 0 ? "+" : ""}${points}`;
/** True while the table is waiting on this player (including opening flips). */
/** The seat on show at the bottom is yours, unless you are only watching. */
const isYou = (p) => !state.spectator && !state.local && p === state.viewer;
function myTurn() {
  const g = state.game;
  if (!g || state.spectator || state.status !== "playing" || g.phase === "over") return false;
  return g.phase === "setup"
    ? g.legal.flip.length > 0
    : g.decision_player === state.viewer;
}
/**
 * Whose turn it is. Under Beggars Will be Choosers, flipping a card can hand
 * one decision (the guess at that card, then any trade it wins) to another
 * player, but the turn stays with the player who flipped it.
 */
function turnPlayer() {
  const g = state.game;
  return ["guess", "guess_trade"].includes(g.phase) ? g.current : g.decision_player;
}
/** True while it is this player's turn, even while an opponent guesses at their card. */
function ownTurn() {
  const g = state.game;
  if (state.spectator) return false;
  if (["guess", "guess_trade"].includes(g?.phase)) return state.status === "playing" && g.current === state.viewer;
  return myTurn();
}
/** True while the table is waiting on this opponent (opening flips are everyone's at once). */
function theirTurn(player) {
  const g = state.game;
  return state.status === "playing" && !["setup", "over"].includes(g.phase) && turnPlayer() === player;
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
  holder.setAttribute("aria-label", saved ? `Solo streak: ${count}. Best: ${saved.best}. Draws in a row: ${saved.draws}.` : `Win streak against Golfbot: ${count}`);
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
let lastTurnBuzz = "";
function renderTags() {
  renderStreak();
  const g = state.game;
  const turn = ownTurn();
  // a buzz (and a controller rumble) once for each turn that comes to you,
  // including the first one of a game or the one waiting when the table opens,
  // and once when an opponent's flip asks you for a Beggars guess
  const guessing = !turn && myTurn();
  const turnKey = turn || guessing ? `${state.id}|${state.round}|${g.turns}|${g.phase === "setup"}|${guessing}` : "";
  if (turnKey && turnKey !== lastTurnBuzz) {
    haptic("turn");
    // with turn notifications on, a phone also gets a short notification, which buzzes
    if (typeof buzzTurnNotification === "function" && document.visibilityState === "visible") buzzTurnNotification();
  }
  lastTurnBuzz = turnKey;
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
    // spectators watching from this player's seat: a small eye and count on the tag's corner
    const watchBadge = scoreTag.querySelector("[data-watch-badge]");
    const watchers = state.watchers_by_seat?.[player] || 0;
    watchBadge.hidden = !watchers;
    patch(`watch-${side}`, watchBadge, String(watchers), () =>
      watchers ? `${icon("eye.fill", 12, { idle: false })}${stickerText(String(watchers), { idle: false })}` : "",
    );
    watchBadge.setAttribute("aria-label", `${watchers} watching`);
    for (const tag of [scoreTag, rulesTag]) {
      tag.classList.remove(...OPPONENT_COLORS);
      tag.classList.add(color);
      // your own tags carry the "your turn" label and a gentle pulse
      tag.classList.toggle("my-turn", side === "me" && turn);
    }
    // the band of a score tag says whose turn it is (in white), and who plays
    // after it (darker, like the frame); the wording only changes as the label
    // comes in, never while it fades out
    // (a spectator's bottom seat is someone else's too)
    const theirs = (side === "opp" || state.spectator) && theirTurn(player);
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
    // While a move waits for Confirm, the tag already shows the score it would leave.
    const preview = board.staged?.preview;
    const shown = preview && g.phase !== "over" ? preview.effect_totals[player] : score;
    const offline = !state.connected[player] && !state.solo;
    scoreTag.classList.toggle("offline", offline);
    const oldDigits = scoreTag.querySelector(".score .digits");
    const oldBox = oldDigits?.getBoundingClientRect?.();
    // spectators see each player's chance of winning this game, tucked into the top of their points
    const chance = state.spectator && prefs.showOdds ? oddsText(state.odds?.[player]) : null;
    const changed = patch(
      `score-${side}`,
      scoreTag.firstElementChild,
      `${player}|${label}|${shown}|${state.spectator}`,
      () =>
        `<span class="who">${e(label)}</span>${state.spectator ? `<span class="odds" data-odds hidden></span>` : ""}<span class="score">${scoreDigits(shown, side)}</span>`,
    );
    if (changed) delete board.signatures[`odds-${side}`];
    const oddsTag = scoreTag.querySelector("[data-odds]");
    if (oddsTag) {
      oddsTag.hidden = chance === null;
      patch(`odds-${side}`, oddsTag, `${player}|${chance}`, () =>
        chance === null ? "" : stickerText(chance, { split: true, key: `odds:${side}` }),
      );
    }
    if (changed && board.signatures[`seen-${side}`] === player)
      rollScore(scoreTag.querySelector(".score"), oldDigits, oldBox);
    board.signatures[`seen-${side}`] = player;
    scoreTag.setAttribute(
      "aria-label",
      `${state.names[player]}: ${shown} points${chance === null ? "" : `, ${chance} chance to win`}${shown !== score ? " once this move is confirmed" : ""}${offline ? ", offline" : ""}${side === "me" && turn ? ", your turn" : ""}${theirs ? ", their turn" : ""}${next ? ", up next" : ""}${side === "opp" ? ". Open their stats." : ". Open your stats."}`,
    );
    // The bar under the score: how many modifiers this hand has in play, and
    // what they (and its matched columns) add to or take off the face value of
    // its cards. While a move waits for Confirm, it reads as it would once the
    // move is played, new score first.
    const after = !!preview && (side === "me" || preview.effect_totals[player] !== score);
    const total = after ? preview.effect_totals[player] : score;
    const count = after ? preview.modifier_counts[player] : enabled;
    const delta = total - (after ? preview.face_values[player] : faceValue(player));
    // previewing, what the move newly sets off (going out and taking the
    // Poisoned Card, say) comes first, so it is never one of those cut off
    let stickers = ruleStickers(player, after ? preview.effects[player] : undefined);
    if (after) {
      const now = new Set(ruleStickers(player).map((sticker) => sticker.rule));
      const rank = (sticker) => (now.has(sticker.rule) ? 2 : sticker.rule === "poisoned_card" ? 0 : 1);
      stickers = stickers.map((sticker, i) => [rank(sticker), i, sticker]).sort((a, b) => a[0] - b[0] || a[1] - b[1]).map(([, , sticker]) => sticker);
    }
    const modifiers = `${count} Modifier${count === 1 ? "" : "s"}`;
    rulesTag.classList.toggle("previewing", after);
    patch(
      `rules-txt-${side}`,
      rulesTag.querySelector(".txt"),
      `${count}|${delta}|${after ? total : ""}`,
      after
        ? `<b class="new-score">New score: ${total}pts</b><br>${modifiers} (${signed(delta)}pts)`
        : `${modifiers} in<br>play (${signed(delta)}pts)`,
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
      `${state.names[player]}: ${after ? `new score ${total} points. ` : ""}${count} modifiers in play, ${signed(delta)} points against the cards' face value. Open details.`,
    );
  }
  // the cycle button wears the color of the opponent it turns to
  const cycle = board.el.querySelector("[data-cycle-next]");
  const others = otherPlayers();
  // a spectator's turns the whole table, so it shows even at a 1v1
  const cycles = state.spectator ? state.names.length > 1 : others.length > 1;
  cycle.hidden = !cycles;
  board.signatures.cycleShown = cycles;
  if (cycles) {
    const next = state.spectator
      ? (state.viewer + 1) % state.names.length
      : others[(others.indexOf(board.view.opp) + 1) % others.length];
    cycle.classList.remove(...OPPONENT_COLORS);
    cycle.classList.add(colorFor(next));
    patch("cycle", cycle.querySelector(".cycle-ico"), "static", () =>
      icon("arrow.trianglehead.2.clockwise.rotate.90", 44),
    );
    // the name of the player it turns to, curving round under the arrows
    const nameHolder = cycle.querySelector(".cycle-name");
    if (patch("cycle-name", nameHolder, state.names[next], () =>
      `<svg viewBox="0 0 120 120" aria-hidden="true">${CYCLE_ARCS.map((r, i) => `<path id="cycle-arc-${i}" d="M${60 - r} 60A${r} ${r} 0 0 0 ${60 + r} 60" fill="none"/>`).join("")}<text><textPath href="#cycle-arc-0" startOffset="50%" text-anchor="middle"></textPath></text><text><textPath href="#cycle-arc-1" startOffset="50%" text-anchor="middle"></textPath></text></svg>`,
    ))
    {
      layoutCycleName(nameHolder, state.names[next]);
      stackCycleName(nameHolder);
    }
    cycle.setAttribute(
      "aria-label",
      state.spectator ? `Watch from ${state.names[next]}'s seat.` : `Show ${state.names[next]}'s cards. Swipe to browse opponents.`,
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
    return [state.game.final_turn && ownTurn() ? "Final turn" : null, "me"];
  return [text, side];
}
function promptFor() {
  const g = state.game,
    me = state.viewer;
  if (state.status === "closed") return [state.spectator ? "Table closed · waiting for their next game…" : "Table closed", "me"];
  if (state.status !== "playing") return [null, "me"];
  const final = g.final_turn ? "Final turn · " : "";
  if (state.spectator) {
    if (g.phase === "setup") return ["Opening flips…", "opp"];
    const p = turnPlayer();
    return [`${final}${state.names[p]}'s turn`, p === me ? "me" : "opp"];
  }
  if (g.phase === "setup")
    return g.legal.flip.length
      ? [`Double-tap ${2 - g.players[me].filter((s) => s.visible).length === 1 ? "one more card" : "two cards"} to flip`, "me"]
      : ["Waiting for opening flips…", "opp"];
  // an opponent guessing at a card just flipped: still that player's turn
  if (["guess", "guess_trade"].includes(g.phase) && g.decision_player !== me) {
    const guesser = state.names[g.decision_player];
    const whose = g.current === me ? "your" : `${state.names[g.current]}'s`;
    return [
      final + (g.phase === "guess" ? `${guesser} is guessing ${whose} card…` : `${guesser} guessed right! Trading cards…`),
      g.current === me ? "me" : "opp",
    ];
  }
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
      center = slot.offsetLeft + slot.offsetWidth / 2;
    const x = clamp(center, width / 2 + 6, box.width - width / 2 - 6);
    callout.style.setProperty("--callout-x", `${x}px`);
    callout.style.setProperty("--tip-x", `${clamp(center - x + width / 2, 20, width - 20)}px`);
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
    // "Bob's turn" pointing down at the cycle button can be tapped to go to Bob
    const away = side === "opp" && theirTurn(player) && player !== state.viewer && player !== board.view.opp && canCycle();
    if (away) callout.dataset.goto = String(player);
    else delete callout.dataset.goto;
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
        ? `<button type="button" class="icon-btn queue" ${queue.status === "offer" ? "data-queue-view" : "data-queue-peek"} aria-label="Show the Ranked queue">${icon("sparkles", 22)}</button>`
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
  bar.classList.toggle("my-turn", ownTurn()); // it pulses along with your tags
  renderSummary();
  renderEmotes(); // after the results, whose tiles the reactions sit on
  renderModal();
}

function renderEmotes() {
  const layer = board.el.querySelector("[data-emote-layer]");
  // spectators cheer on behalf of the player they watch, each in their own row ("spectator:<slot>");
  // a phone has room for one bubble a side, the newest
  let spectators = Object.keys(activeEmotes).filter((key) => key.startsWith("spectator:"));
  if (window.matchMedia?.("(max-width: 699px)").matches) {
    const newest = {};
    for (const key of spectators) {
      const side = Number(activeEmotes[key].seat) === state.viewer ? "left" : "right";
      if (!newest[side] || activeEmotes[key].sequence > activeEmotes[newest[side]].sequence) newest[side] = key;
    }
    spectators = Object.values(newest);
  }
  const signature = state.names
    .map((_, p) => activeEmotes[p]?.sequence || 0)
    .join() + `|${spectators.map((key) => `${key}=${activeEmotes[key].sequence}`).join()}`;
  // you and the opponent showing react beside your own cards; anyone else
  // speaks up from the cycle button that leads to them
  const players = state.names.map((_, p) => p);
  const showing = (p) => p === state.viewer || p === board.view.opp;
  // on the results everyone has a tile, and reacts from above it instead
  const tiles = [...(board.el.querySelectorAll?.("[data-tile-emote]") ?? [])];
  const results = tiles.length > 0;
  // spectators' bubbles slide in from the edges, over the results too
  patch("emotes", layer, signature + board.view.opp + results + state.viewer, () =>
    (results ? "" : players.filter(showing).map((p) => playerEmote(p)).join("")) + spectators.map(spectatorEmote).join(""),
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
  const closed = state.status === "closed" ? "disabled" : "";
  const faces = Object.entries(emoteNames)
    .filter(([id]) => !TEXT_EMOTES.includes(id))
    .map(
      ([id, label]) =>
        `<button type="button" data-emote="${id}" aria-label="Send ${label.toLowerCase()} emote" ${closed}><img src="${appPath(`/static/emotes/${id}.png`)}" alt=""></button>`,
    )
    .join("");
  // the sayings in two rows that scroll sideways together
  const word = (id) =>
    `<button type="button" class="emote-word" data-emote="${id}" aria-label="Say ${e(emoteNames[id])}" ${closed}>${e(emoteNames[id])}</button>`;
  const half = Math.ceil(TEXT_EMOTES.length / 2);
  const words = [TEXT_EMOTES.slice(0, half), TEXT_EMOTES.slice(half)]
    .map((row) => `<div class="emote-words-row">${row.map(word).join("")}</div>`)
    .join("");
  return `<div class="emote-row">${faces}<button type="button" data-emote-mute aria-pressed="${opponentEmotesMuted}" aria-label="${opponentEmotesMuted ? "Unmute opponent emotes" : "Mute opponent emotes"}">${icon(opponentEmotesMuted ? "bell.slash.fill" : "bell.fill", 28, { idle: false })}</button></div><div class="emote-words">${words}</div>`;
}
// the text emotes' fade at the edge goes once they are scrolled to the end
document.addEventListener?.(
  "scroll",
  (event) => {
    const row = event.target;
    if (row.classList?.contains("emote-words"))
      row.classList.toggle("at-end", row.scrollLeft + row.clientWidth >= row.scrollWidth - 2);
  },
  true,
);
/** A face emote is its sticker; a text emote is a speech bubble saying it. */
function emoteArt(item, player) {
  const who = String(player).startsWith("spectator") ? "Spectator" : state.names[player];
  if (TEXT_EMOTES.includes(item.id))
    return `<span class="emote-say" aria-label="${e(who)}: ${e(emoteNames[item.id])}">${e(emoteNames[item.id])}</span>`;
  return `<img src="${appPath(`/static/emotes/${item.id}.png`)}" alt="${e(who)}: ${emoteNames[item.id]} emote">`;
}
/**
 * A spectator's emote, on behalf of the player they watch: a speech bubble in
 * that player's color, sliding in from the left for the hand at the bottom of
 * this screen and from the right for anyone across the table.
 */
/** Where the board's edges are on screen: wide screens set spectator bubbles beside it. */
function measureBoardEdges() {
  const box = board.el?.getBoundingClientRect?.();
  if (!box) return;
  document.documentElement.style.setProperty("--board-l", `${Math.round(box.left)}px`);
  document.documentElement.style.setProperty("--board-r", `${Math.round(box.right)}px`);
}
window.addEventListener?.("resize", measureBoardEdges);
function spectatorEmote(key) {
  measureBoardEdges();
  const item = activeEmotes[key];
  if (!item || item.ends <= Date.now() || (opponentEmotesMuted && !state.spectator)) return "";
  const seat = Number(item.seat);
  if (!Number.isInteger(seat) || seat >= state.names.length) return "";
  const age = Math.max(0, 4000 - (item.ends - Date.now()));
  const side = seat === state.viewer ? "from-left" : "from-right";
  const art = TEXT_EMOTES.includes(item.id)
    ? `<b class="spectator-say">${e(emoteNames[item.id])}</b>`
    : `<img src="${appPath(`/static/emotes/${item.id}.png`)}" alt="${emoteNames[item.id]} emote">`;
  // wide screens give each spectator their own row, and name them beside their emote
  const row = (Number(item.slot) || 0) % 6;
  const name = item.name ? `<span class="spectator-name">${e(item.name)}</span>` : "";
  return `<div class="spectator-emote ${side} ${colorFor(seat)}" data-emote-player="${e(key)}" role="status" aria-label="${e(item.name || "A spectator")}, watching ${e(state.names[seat])}: ${e(emoteNames[item.id])}" style="animation-delay:-${age}ms;--slot:${row}">${art}${name}</div>`;
}
function playerEmote(player, onTile = false) {
  if (opponentEmotesMuted && player !== state.viewer) return "";
  const item = activeEmotes[player];
  if (!item || item.ends <= Date.now()) return "";
  const age = Math.max(0, 4000 - (item.ends - Date.now()));
  const where =
    player === state.viewer ? "me" : player === board.view.opp ? "them" : "other";
  const image = emoteArt(item, player);
  if (onTile)
    return `<div class="player-emote tile" data-emote-player="${player}" role="status" style="animation-delay:-${age}ms">${image}</div>`;
  // a white tooltip with the player's avatar and name in their own color, pointing back at the cycle button
  if (where === "other")
    return `<div class="player-emote other ${colorFor(player)}" data-emote-player="${player}" role="status" style="animation-delay:-${age}ms"><span class="emote-who">${icon(avatarIcon(state.avatars?.[player]), 26, { idle: false })}<b>${e(state.names[player])}</b></span>${image}</div>`;
  return `<div class="player-emote ${where}" data-emote-player="${player}" role="status" style="animation-delay:-${age}ms">${image}</div>`;
}

/**
 * The post-game graph: every player's showing score after each turn, ending
 * on the final reveal. Lines wear the seat colors (outlined in the seat's
 * dark tone so the yellow still reads) and are named at their right-hand end.
 */
const CHART = { w: 300, h: 160, left: 24, right: 84, top: 12, bottom: 22 };
/**
 * What the graph can show. Once a series has two or more games, a cycle button
 * steps through: this game turn by turn, each game's points, and the running
 * total through the series.
 */
const CHART_VIEWS = {
  game: "Points through the game",
  games: "Points per game",
  series: "Points through the series",
};
function chartViews() {
  // a game ended before anyone moved has no turns to plot
  const views = (state.timeline || []).length >= 2 ? ["game"] : [];
  if ((state.history || []).length >= 2) views.push("games", "series");
  return views;
}
function chartView() {
  const views = chartViews();
  return views.includes(board.chartView) ? board.chartView : views[0] || "game";
}
/** The chosen view's points: {scores, label} in order, and the labels under the axis. */
function chartPoints() {
  const view = chartView();
  const games = state.history || [];
  if (view === "games") {
    const points = games.map((game, i) => ({ scores: game.scores, label: `Game ${i + 1}` }));
    return { points, axis: ["Game 1", "", `Game ${games.length}`] };
  }
  if (view === "series") {
    const totals = state.names.map(() => 0);
    const points = [{ scores: [...totals], label: "Start" }];
    games.forEach((game, i) => {
      game.scores.forEach((score, p) => (totals[p] += score));
      points.push({ scores: [...totals], label: `After game ${i + 1}` });
    });
    return { points, axis: ["Start", "", `Game ${games.length}`] };
  }
  const timeline = state.timeline || [];
  const points = timeline.map((point, i) => ({
    scores: point.scores,
    label: point.final ? "Reveal" : i === 0 ? "Start" : `Turn ${point.turn}`,
  }));
  const turns = timeline.filter((point) => !point.final).at(-1)?.turn ?? 0;
  return { points, axis: ["Start", `${turns} turn${turns === 1 ? "" : "s"}`, "Reveal"] };
}
function evalScale() {
  const { points } = chartPoints();
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
/** Which lines get color and a name: everyone at a small table, else you and the winner. */
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
    const name = isYou(p) ? "You" : state.names[p];
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
  // muted lines first, then the colored ones, with your own drawn last (on top)
  const order = state.names
    .map((_, p) => p)
    .sort((a, b) => featured.includes(a) - featured.includes(b) || (a === state.viewer) - (b === state.viewer));
  const lines = order
    .map((p) => {
      if (!featured.includes(p)) return `<path class="line muted" d="${path(p)}"/>`;
      const seat = p % 8;
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
  // so its text centers the same in every browser (Safari places SVG text its own way)
  const arrows = labels
    .map(({ p, at }) => {
      const point = y(points.at(-1).scores[p]);
      const mid = Math.min(Math.max(point, at - 4), at + 4);
      return `<polygon class="tag-arrow" style="--tip:var(--s${p % 8})" points="${(endX + 4.5).toFixed(1)},${point.toFixed(1)} ${(endX + 11).toFixed(1)},${(mid - 4).toFixed(1)} ${(endX + 11).toFixed(1)},${(mid + 4).toFixed(1)}"/>`;
    })
    .join("");
  const tags = labels
    .map(
      ({ p, at }) =>
        `<span class="end-tag" style="--tip:var(--s${p % 8});--on:var(--s${p % 8}on);left:${(((endX + 10) / w) * 100).toFixed(2)}%;top:${((at / h) * 100).toFixed(2)}%">${e(short(p))} <b>${points.at(-1).scores[p]}</b></span>`,
    )
    .join("");
  const [first, middle, last] = chartPoints().axis;
  const axis = `<text class="axis" x="${left}" y="${h - 6}" text-anchor="start">${first}</text><text class="axis" x="${(left + w - right) / 2}" y="${h - 6}">${middle}</text><text class="axis" x="${w - right}" y="${h - 6}" text-anchor="end">${last}</text>`;
  const summary = featured
    .map((p) => `${isYou(p) ? "You" : state.names[p]}: ${points.map((point) => point.scores[p]).join(", ")}`)
    .join("; ");
  const views = chartViews();
  const view = chartView();
  const next = views[(views.indexOf(view) + 1) % views.length];
  const cycle =
    views.length > 1
      ? `<button type="button" class="chart-cycle" data-chart-cycle aria-label="Show ${CHART_VIEWS[next].toLowerCase()}">${glyph("arrow.left.arrow.right", 14)}</button>`
      : "";
  return `<figure class="eval-chart" data-eval-chart><figcaption><span class="chart-title">${cycle}${CHART_VIEWS[view]}</span> <small>lower is better</small></figcaption><div class="eval-plot"><svg viewBox="0 0 ${w} ${h}" role="img" aria-label="${CHART_VIEWS[view]}. ${e(summary)}">${grid}${axis}${lines}<line class="cross" x1="0" x2="0" y1="${top}" y2="${h - bottom}"/>${arrows}<rect class="hit" x="${left}" y="${top}" width="${w - left - right}" height="${h - top - bottom}"/></svg>${tags}<div class="eval-tip" hidden></div></div></figure>`;
}
const RESULTS_DELAY = 750; // ms between a game's last move and its results
/** The big result word: sticker letters that celebrate, or droop. */
function resultTitle(mood, sentence, sub, word = { win: "You Win!", lose: "You Lose", draw: "Draw" }[mood]) {
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
  const label = points[i].label;
  const rows = evalFeatured()
    .map((p) => ({ p, v: points[i].scores[p] }))
    .sort((a, b) => a.v - b.v)
    .map(({ p, v }) => `<div><i style="background:var(--s${p % 8})"></i><span>${isYou(p) ? "You" : e(state.names[p])}</span><b>${v}</b></div>`)
    .join("");
  tip.innerHTML = `<strong>${label}</strong>${rows}`;
  tip.hidden = false;
  // beside the crosshair, on whichever side has room, so it never covers the title,
  // and always kept inside the graph: the results panel would clip anything past it
  const px = (x(i) / CHART.w) * box.width;
  const left = px < box.width / 2;
  const width = tip.offsetWidth;
  const wanted = left ? px + 8 : px - 8 - width;
  tip.style.left = `${Math.max(0, Math.min(wanted, box.width - width))}px`;
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
    board.summaryEmotes = false; // the next results open with the emotes tucked away
    board.sawPlay = state.status === "playing";
    patch("summary", holder, "", "");
    return;
  }
  // A game that ends while you watch leaves its last move on the table for a
  // moment before the results come up (arriving at a finished game, they show at once).
  const holdKey = `${state.id}|${state.history.length}`;
  if (board.summaryHold?.key !== holdKey)
    board.summaryHold = { key: holdKey, until: board.sawPlay && state.status !== "closed" ? performance.now() + RESULTS_DELAY : 0 };
  const wait = board.summaryHold.until - performance.now();
  if (wait > 0) {
    patch("summary", holder, "", "");
    clearTimeout(board.summaryTimer);
    board.summaryTimer = setTimeout(() => {
      if (board.el?.isConnected && board.summaryHold?.key === holdKey) renderSummary();
    }, wait + 10);
    return;
  }
  settleLifted();
  // a spectator has no seat: every result is told by name
  const viewer = state.spectator || state.local ? -1 : state.viewer;
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
    board.summaryEmotes,
    state.history.length,
    (state.timeline || []).length,
    chartView(),
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
    // one tile per player: this game's points, the series so far, and whether
    // they're ready; lowest points (the best) on the left, ties by seat
    const tiles = state.names
      .map((name, p) => [name, p])
      .sort(([, a], [, b]) => (result ? result.scores[a] - result.scores[b] : 0) || a - b)
      .map(([name, p]) => {
        const ready = !!state.ready[p];
        const crown = finished ? state.champion === p : result?.winner === p;
        const status = between
          ? `<span class="ready-state${ready ? " on" : ""}">${icon(ready ? "checkmark.circle.fill" : "hourglass", 18, { idle: false })}${ready ? "Ready" : "Not ready"}</span>`
          : "";
        return `<div class="ready-tile ${colorFor(p)}${crown ? " won" : ""}"><span class="tile-emote" data-tile-emote="${p}"></span><span class="who"><span class="name">${p === viewer ? youStar() : ""}${e(name)}</span>${crown ? icon(finished ? "trophy.fill" : "crown.fill", 20, { key: `crown:${p}` }) : ""}</span><b>${result ? result.scores[p] : "–"} pts</b>${series ? `<small>${state.series_mode === "points" ? `${state.points[p]} total` : `${state.wins[p]} ${state.wins[p] === 1 ? "win" : "wins"}`}</small>` : ""}${status}</div>`;
      })
      .join("");
    // Quit and View board: sticker icons with their labels underneath, either
    // side of the main move
    const sticker = (attrs, color, symbol, label, extra = "", size = 30) =>
      `<button type="button" class="close-btn ${color}" ${attrs}>${icon(symbol, size)}<span>${extra}${label}</span></button>`;
    const quit = sticker("data-leave", "c-fw", "rectangle.portrait.and.arrow.right", "Quit");
    const look = sticker('data-summary-toggle aria-label="View the board"', "c-fw", "eye.fill", "View");
    // the main move is a full button, filling the room between Quit and View
    const wide = (attrs, symbol, label, extra = "") =>
      `<button type="button" class="btn c-p1 summary-main" ${attrs}>${tilted(symbol, 30)}<span>${extra}${label}</span></button>`;
    const main = state.spectator
      ? wide("disabled", "eye.fill", "Watching…")
      : state.local
      ? between
        ? wide('data-action="next_round"', "checkmark.circle.fill", "Next game", padTag("y"))
        : wide('data-action="rematch"', "arrow.clockwise", "Play again", padTag("y"))
      : between
      ? state.ready[viewer]
        ? wide("disabled", "hourglass", "Waiting…")
        : wide('data-action="next_round"', "checkmark.circle.fill", "Ready", padTag("y"))
      : viewer === 0
        ? wide('data-action="rematch"', "arrow.clockwise", "Play again", padTag("y"))
        : wide('disabled title="The host can start a rematch."', "hourglass", "Host's call");
    const action = `<div class="summary-actions">${quit}${main}${look}</div>`;
    // spectators get the result told plainly: who won is the line under it
    const heading = state.spectator || state.local
      ? resultTitle("draw", title, title, verdict === null || verdict === undefined ? "Draw" : finished ? "Series Over" : "Game Over")
      : resultTitle(mood, title, sub);
    const lag = ((performance.now() - board.resultShown.at) / 1000).toFixed(2);
    // the verdict and the graph float over the table; the green panel holds the rest
    return `<div class="summary-scrim" style="--t:-${lag}s"></div><section class="summary floating" role="dialog" aria-label="Results" style="--t:-${lag}s">${heading}${evalChart()}<div class="panel c-fw summary-panel"><div class="ready-tiles">${tiles}</div><div class="stack">${action}</div></div>${summaryEmotesHtml()}</section>`;
  });
}

/**
 * The quick emotes under the results: a little green tab peeking out from the
 * bottom of the ready-up card, which drops the emotes down when tapped.
 */
function summaryEmotesHtml() {
  const open = !!board.summaryEmotes;
  // the tab never changes size, only its chevron turns; the emotes drop down
  // below it, on their own, into room kept for them so nothing else moves
  return `<div class="summary-emote-anchor"><div class="summary-emote-drawer c-fw"><button type="button" class="emote-tab" data-summary-emotes aria-expanded="${open}" aria-label="${open ? "Hide" : "Show"} quick emotes">${icon("text.bubble.fill", 22, { idle: false })}${glyph(open ? "chevron.up" : "chevron.down", 14)}</button></div><div class="emote-pop summary-emotes${open ? "" : " tucked"}" role="group" aria-label="Quick emotes" ${open ? "" : "inert"}>${emoteButtons()}</div></div>`;
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
        `<div class="modal-shade"><section class="modal panel c-p4" role="dialog" aria-modal="true" aria-label="Beggars rank guess"><button type="button" class="dialog-x" data-guess="pass" aria-label="Pass on the guess">${icon("xmark.circle.fill", 26)}</button><h2>Beggars Will be Choosers</h2><p>Guess the hidden card in row ${Math.floor(target / 3) + 1}, column ${(target % 3) + 1}.</p><div class="ranks">${Array.from({ length: 13 }, (_, i) => {
          const label = { 1: "A", 11: "J", 12: "Q", 13: "K" }[i + 1] || String(i + 1);
          return `<button type="button" class="rank-sticker" data-guess="${i + 1}" aria-label="Guess ${label}">${stickerText(label, { key: `rank:${i}` })}</button>`;
        }).join("")}</div></section></div>`,
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
/**
 * Flips play at once: there is no confirm step for turning a card over. Only
 * the server knows the card, so it has to be asked, but the card starts to
 * turn right away and the answer finishes the turn. A flip asked for while
 * another move is still on its way is kept, and sent as soon as that one lands.
 */
function flipMove(ref) {
  haptic("flip");
  primeFlip(ref);
  if (busy) {
    const waiting = board.queuedFlip;
    if (waiting && !same(waiting, ref)) unprime(waiting); // only the latest one waits
    board.queuedFlip = ref;
    return Promise.resolve(false);
  }
  return sendFlip(ref);
}
async function sendFlip(ref) {
  // the card keeps turning, on toward edge-on, while the server is asked what
  // it is: the answer then carries it the rest of the way without a stop
  const turning = board.primed.get(refKey(ref));
  if (turning && !reducedMotion.matches) motionFor(turning).to({ face: 92 });
  // someone else acting at the same moment (opening flips are everyone's at
  // once) only changes the table's version: the flip is sent again
  const opts = { stillLegal: () => canFlip(ref) };
  const ok = await (ref[0] === "draw" ? move("draw", {}, opts) : move("flip", { index: ref[1] }, opts));
  // under Beggars an opponent may guess at the card before it turns: it waits
  // there, lifted, and finishes turning over once the guess is in
  const g = state?.game;
  if (ok && ref[0] === state.viewer && g?.phase === "guess" && g.guess_target === ref[1]) {
    board.guessHeld = ref;
    const held = board.primed.get(refKey(ref));
    if (held) motionFor(held).to({ face: 140 }); // tipped back, its back showing, while they guess
  } else unprime(ref);
  return ok;
}
function primeFlip(ref) {
  const slot = slotFor(ref);
  if (!slot || slot.classList.contains("empty")) return;
  const motion = motionFor(slot);
  if (ref[0] === "draw" || reducedMotion.matches) return void motion.kick({ scale: 2.2 });
  if (slot.classList.contains("is-face") || board.primed.has(refKey(ref))) return;
  board.primed.set(refKey(ref), slot);
  // up off the table and starting to turn, the back still showing
  motion.to({ face: 140, lift: 1, scale: 1.1, rx: 0, ry: 0 });
  motion.kick({ scale: 2.2 });
}
/** Lay a card that was turning back down (the flip was called off, or refused). */
function unprime(ref) {
  const slot = board.primed.get(refKey(ref));
  if (!slot) return;
  board.primed.delete(refKey(ref));
  if (slot.isConnected && !slot.classList.contains("is-face"))
    motionFor(slot).to({ face: 180, lift: 0, scale: 1 });
}
/** Send the flip that was waiting on another move, once that move has landed. */
function drainFlip() {
  const ref = board.queuedFlip;
  if (!ref || busy) return;
  board.queuedFlip = null;
  if (canFlip(ref)) sendFlip(ref);
  else unprime(ref);
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
/**
 * Where a card rests in its slot: on the table, or (selected) lifted a little
 * toward you. The lift runs through the same springs as hover, drag and flip,
 * so moving between them eases instead of snapping to the stylesheet's pose.
 */
function restPose(slot) {
  if (!slot.classList.contains("selected")) return { scale: 1, lift: 0, y: 0 };
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
  return { scale: 1.07, lift: 0.8, y: -0.6 * rem };
}
function paintSelection() {
  if (!board.el) return;
  // nothing can be picked up when it is not your turn, so nothing stays outlined;
  // a card picked from an opponent's hand stays picked while you cycle to another
  // opponent, so a bonus swap can trade cards between two opponents
  const onTable = (ref) => slotFor(ref) || (Number.isInteger(ref[0]) && !!state.game?.players?.[ref[0]]?.[ref[1]]);
  board.selected = myTurn() ? board.selected.filter(onTable) : [];
  const pinned = pinnedCard();
  if (pinned && !board.staged && !board.carry && !board.drag?.active) board.selected = [pinned];
  board.slots.forEach((slot) => {
    const ref = JSON.parse(slot.dataset.ref);
    const was = slot.classList.contains("selected");
    const now = hasRef(board.selected, ref);
    slot.classList.toggle("selected", now);
    // a card in hand (dragged, carried, previewing a move) has its own pose
    // (written at once, so the stylesheet's pose never shows for a frame)
    if (was !== now && !slot.matches(".dragging, .returning"))
      motionFor(slot).to(restPose(slot)).write();
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
/** Ask what the score tags would read once a staged swap or discard is played. */
async function previewScore(item) {
  if (!["swap", "discard"].includes(item.action) || state.score_preview === false) return;
  try {
    const result = await api(`/api/lobbies/${state.id}/preview`, "POST", {
      action: item.action,
      version: item.version,
      ...item.extra,
    });
    if (board.staged !== item || result.version !== state.version) return;
    item.preview = result;
    renderTags();
  } catch {} // (a server from before previews: the bar keeps what it showed)
}
function stageMove(staged) {
  const shown = board.staged?.preview;
  if (board.staged) cancelStaged(false);
  if (shown) renderTags();
  // Confirm and Undo are there at once: the preview plays out beside them
  const item = (board.staged = { ...staged, version: state.version, ready: true, movers: [], preview: null });
  const plan = previewPlan(item).filter(([slot, to]) => slot && to && slot !== to);
  board.selected = item.from && !plan.length ? [item.from] : [];
  board.lastTap = null;
  paintSelection();
  previewScore(item);
  if (!plan.length) return;
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
}
function cancelStaged(paint = true) {
  const staged = board.staged;
  if (!staged) return;
  board.staged = null;
  for (const slot of staged.movers) if (slot.isConnected) releaseDrag(slot);
  board.selected = [];
  if (!paint) return;
  paintSelection();
  if (staged.preview) renderTags(); // the bar goes back to the table as it is
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
      // the free position jumps to the center too, so leaving takes real travel
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
    motionFor(board.hover).to({ rx: 0, ry: 0, scale: restPose(board.hover).scale });
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
  // a press whose lift was never reported must not swallow the next one
  if (board.drag && event.isPrimary && event.pointerId !== board.drag.pointer)
    onBoardPointerUp({ type: "pointercancel", pointerId: board.drag.pointer });
  if (!slot || board.drag || event.button > 0 || slot.classList.contains("empty"))
    return;
  const ref = JSON.parse(slot.dataset.ref);
  // The second press of a double-tap: the card starts to turn as the finger
  // comes down. Where a press on this card could not be the start of a drag
  // (opening flips, the go-fish pile) the flip is played then and there;
  // otherwise it is played as the finger lifts, unless it turned into a drag.
  const second = secondTap(ref);
  const flipped = second && !movesFrom(ref).length;
  if (second) {
    board.lastTap = null;
    board.selected = [];
    paintSelection();
    if (flipped) flipMove(ref);
    else primeFlip(ref);
  }
  board.drag = {
    slot,
    ref,
    second,
    flipped,
    began: performance.now(),
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
  if (!second) motionFor(slot).to({ scale: 0.95, rx: 0, ry: 0 });
}
function beginDrag(drag) {
  drag.active = true;
  if (drag.second) unprime(drag.ref); // it was the start of a drag after all
  board.selected = [];
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
  const center = poseOf(drag.slot);
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
    const distance = Math.hypot(center.x - cx, center.y - cy);
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
    if (drag.flipped || Math.hypot(dx, dy) < DRAG_START) return;
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
  motion.to({ x: 0, lean: 0, rx: 0, ry: 0, ...restPose(slot) });
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
  const lifted = event.type === "pointerup";
  const tapped = () => {
    if (drag.flipped) return; // already played, as the finger came down
    if (!drag.second) {
      motionFor(drag.slot).to({ scale: restPose(drag.slot).scale });
      if (lifted) tapSlot(drag.ref, drag.slot);
    } else if (lifted && canFlip(drag.ref)) flipMove(drag.ref);
    else unprime(drag.ref);
  };
  if (!drag.active) return tapped();
  clearTargets();
  const traveled = Math.hypot(drag.x - drag.startX, drag.y - drag.startY);
  const drawing =
    drag.ref[0] === "draw" && state.game.legal.draw && traveled > 44;
  if (!lifted || busy || (!drag.hot && !drawing)) {
    releaseDrag(drag.slot);
    paintSelection();
    // a quick tap that slid a little under the finger is still a tap
    if (lifted && !drag.hot && !drawing && traveled < TAP_SLOP && performance.now() - drag.began < TAP_SLOP_MS)
      tapped();
    else board.lastTap = null;
    return;
  }
  board.lastTap = null;
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

/**
 * True when a tap on this card, now, is the second of a double-tap that
 * should flip it. Nothing about the table having changed in between matters,
 * only that the card can still be flipped.
 */
function secondTap(ref) {
  const last = board.lastTap;
  return !!last && same(last.ref, ref) && performance.now() - last.time <= DOUBLE_TAP_MS && canFlip(ref);
}
/** A tap selects; tapping a highlighted destination plays the move; a double-tap flips. */
function tapSlot(ref, slot) {
  if (!state?.game || state.void_offer || state.status !== "playing") return;
  if (ref[0] === "under") return;
  // (touch and mouse catch the second tap as it is pressed; this is the same
  // rule for the keyboard and the controller)
  if (secondTap(ref)) {
    board.lastTap = null;
    board.selected = [];
    paintSelection();
    flipMove(ref);
    return;
  }
  board.lastTap = { ref, time: performance.now() };
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
    // starting out, or pulled back past where it began: the other neighbor comes in
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
    } else if (event.target.closest?.("[data-cycle-next]")) {
      if (state?.spectator) {
        watchNextSeat();
        spinCycle(1);
      } else cycleOpponent(1);
    }
    else {
      const tip = event.target.closest?.(".callout[data-goto]");
      if (tip) goToOpponent(Number(tip.dataset.goto));
    }
  },
  true,
);
/* ---------- trackpad: a sideways scroll turns the table too ---------- */
// The opponent's side follows the scroll like a finger dragging it, and goes
// over once it is carried far enough. One continuous scroll turns the table
// once and no more: whatever is left of it (the rest of the swipe, then the
// momentum a trackpad keeps sending for a second or more) is ignored, and the
// next turn of the table waits for a scroll that starts after this one stops.
const WHEEL_QUIET = 120; // ms without a scroll event: the scroll is over
const wheelSwipe = { slide: null, x: 0, y: 0, spent: false, stamp: -Infinity, timer: 0 };
function onBoardWheel(event) {
  // pinch-zooming, and the panels over the table that scroll, are left alone
  if (event.ctrlKey || !canCycle() || event.target.closest?.(".summary, .modal-shade, .emote-pop")) return;
  // Every event of a scroll is claimed, from the very first (often a nudge of
  // nothing, or slightly up or down): one that is let go hands the whole swipe
  // to the browser, which keeps it for its own back and forward gesture.
  event.preventDefault();
  // The gap is read off the events' own times, so a busy moment that delivers
  // them late can't split one scroll in two.
  if (event.timeStamp - wheelSwipe.stamp > WHEEL_QUIET) endWheel();
  wheelSwipe.stamp = event.timeStamp;
  clearTimeout(wheelSwipe.timer);
  wheelSwipe.timer = setTimeout(endWheel, WHEEL_QUIET);
  if (wheelSwipe.spent || tableSwipe?.slide) return;
  const unit = event.deltaMode === 1 ? 16 : 1;
  wheelSwipe.x -= event.deltaX * unit; // scrolling right moves what is under the pointer to the left
  wheelSwipe.y += Math.abs(event.deltaY) * unit;
  if (wheelSwipe.slide && board.slide !== wheelSwipe.slide) wheelSwipe.slide = null; // something else moved the table on
  let slide = wheelSwipe.slide;
  // a scroll that has barely begun, or is mostly up and down, moves nothing yet
  if (!slide && (Math.abs(wheelSwipe.x) < 6 || Math.abs(wheelSwipe.x) <= wheelSwipe.y)) return;
  const direction = wheelSwipe.x < 0 ? 1 : -1;
  if (!slide || slide.direction !== direction) {
    if (slide) endSlide(slide);
    slide = wheelSwipe.slide = beginSlide(direction);
    if (!slide) {
      // reduced motion: nothing follows the scroll, a firm one just changes opponent
      if (Math.abs(wheelSwipe.x) > 60) {
        wheelSwipe.spent = true;
        cycleOpponent(direction);
      }
      return;
    }
  }
  setSlide(slide, wheelSwipe.x);
  if (Math.abs(slide.x) < slide.width * 0.35) return;
  Object.assign(wheelSwipe, { slide: null, spent: true });
  settleSlide(slide, true);
  spinCycle(direction);
}
/** The scroll has stopped: one that was only part-way over either counts, or goes back. */
function endWheel() {
  clearTimeout(wheelSwipe.timer);
  const slide = wheelSwipe.slide;
  Object.assign(wheelSwipe, { slide: null, x: 0, y: 0, spent: false });
  if (!slide || board.slide !== slide) return;
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
  const visible = faceValue(player),
    total = g.effect_totals[player];
  const enabled = catalog.filter((rule) => state.rules[rule.key]);
  const editable = g.legal.set_rules;
  // your rules one swap away from coming into play follow the ones in play
  const near = player === state.viewer ? g.near_rules || [] : [];
  const rank = (key) => (active.includes(key) ? 2 : near.includes(key) ? 1 : 0);
  const ordered = [...(editable ? catalog : enabled)].sort((a,b) =>
    rank(b.key) - rank(a.key) ||
    Number(!!matchOptions.house_rules[b.key]) - Number(!!matchOptions.house_rules[a.key]));
  const others = state.names.map((_, p) => p).filter((p) => p !== player);
  return `<section class="sheet rules-sheet ${color}" role="dialog" aria-modal="true" aria-label="Rules in play">
    <div class="sheet-head"><h2>${isYou(player) ? youStar() : ""}${e(state.names[player])}</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
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
