"use strict";
// Controller support (Gamepad API).
//
// A controller drives the same elements a finger does. A cursor glides between
// everything on screen that can be pressed; on the table it rides the cards,
// so picking a card up and placing it works exactly like tap-then-tap.
//
//   D-pad / left stick  move the cursor        right stick  scroll
//   bottom button (A)   press / pick up / place / confirm
//   right button  (B)   back, close, undo
// Quick actions at the table, one button each, always the same:
//   X discard · Y draw · LB flip the card · RB swap · LT next opponent
//   (End Turn has no button of its own: move to it and press A)
//   RT carry a card (hold, or press to toggle): it moves freely with the
//   stick or D-pad and snaps near places it can go
//   View rules & scores · Menu table menu
// (In the menus LB/RB step through avatars and options.)
//
// With the confirm step on (the default, for every input method), a move is
// staged first and the Confirm button beside the discard pile takes the
// cursor; A plays it.

const PAD = {
  connected: false,
  active: false, // the controller is the input method in use right now
  focus: null,
  key: "", // describes the focused control, to find it again after a re-render
  rect: null,
  scope: null,
  page: "",
  memory: new WeakMap(), // layer → the control last focused in it
  buttons: {},
  repeat: {},
  family: "xbox",
  held: false,
  frame: 0,
  placed: "",
  back: null, // where the cursor was before it jumped to Confirm
};
const PAD_BUTTONS = { a: 0, b: 1, x: 2, y: 3, lb: 4, rb: 5, lt: 6, rt: 7, select: 8, start: 9 };
const PAD_DIRECTIONS = { up: [12, 1, -1], down: [13, 1, 1], left: [14, 0, -1], right: [15, 0, 1] };
const PAD_GLYPHS = {
  xbox: { a: "A", b: "B", x: "X", y: "Y", lb: "LB", rb: "RB", lt: "LT", rt: "RT", select: "View", start: "Menu" },
  playstation: { a: "✕", b: "○", x: "□", y: "△", lb: "L1", rb: "R1", lt: "L2", rt: "R2", select: "Create", start: "Options" },
  // Nintendo pads report by position too, so the bottom button is their "B"
  nintendo: { a: "B", b: "A", x: "Y", y: "X", lb: "L", rb: "R", lt: "ZL", rt: "ZR", select: "−", start: "+" },
};
// The SF Symbol for each button, drawn as the controller in hand labels it.
const PAD_SYMBOLS = {
  xbox: {
    a: "a.circle.fill",
    b: "b.circle.fill",
    x: "x.circle.fill",
    y: "y.circle.fill",
    lb: "lb.rectangle.roundedbottom.fill",
    rb: "rb.rectangle.roundedbottom.fill",
    lt: "lt.rectangle.roundedtop.fill",
    rt: "rt.rectangle.roundedtop.fill",
    select: "rectangle.fill.on.rectangle.fill.circle",
    start: "line.3.horizontal.circle.fill",
  },
  playstation: {
    a: "xmark.circle.fill",
    b: "circle.circle.fill",
    x: "square.circle.fill",
    y: "triangle.circle.fill",
    lb: "l1.rectangle.roundedbottom.fill",
    rb: "r1.rectangle.roundedbottom.fill",
    lt: "l2.rectangle.roundedtop.fill",
    rt: "r2.rectangle.roundedtop.fill",
    select: "capsule.portrait.fill",
    start: "line.3.horizontal.circle.fill",
  },
  nintendo: {
    a: "b.circle.fill",
    b: "a.circle.fill",
    x: "y.circle.fill",
    y: "x.circle.fill",
    lb: "l.rectangle.roundedbottom.fill",
    rb: "r.rectangle.roundedbottom.fill",
    lt: "zl.rectangle.roundedtop.fill",
    rt: "zr.rectangle.roundedtop.fill",
    select: "minus.circle.fill",
    start: "plus.circle.fill",
  },
};
const PAD_SHARED = { dpad: ["dpad.fill", "D-pad"], rstick: ["r.joystick.fill", "Right stick"] };
const PAD_FOCUSABLE = "button, a[href], input:not([type=hidden]), select, summary";
const PAD_FIRST_REPEAT = 360,
  PAD_REPEAT = 130;

const padCursor = document.createElement("div");
padCursor.id = "pad-cursor";
padCursor.setAttribute("aria-hidden", "true");

const padGlyph = (key) => PAD_SHARED[key]?.[1] || PAD_GLYPHS[PAD.family][key] || key;
const padSymbol = (key) => PAD_SHARED[key]?.[0] || PAD_SYMBOLS[PAD.family][key];
function padFamily(id) {
  const name = id.toLowerCase();
  if (/054c|dualsense|dualshock|playstation|ps[345]/.test(name)) return "playstation";
  if (/057e|nintendo|switch|joy-con/.test(name)) return "nintendo";
  return "xbox";
}
/**
 * A quick action: the controller button that presses this control, shown as a
 * just left of the button's words while a controller is connected; on a button
 * that is only an icon ("under") it hangs off the bottom of the icon.
 */
function padTag(key, place = "") {
  return `<kbd class="pad-key pad-tag${place ? " " + place : ""}" data-key="${key}" aria-hidden="true"></kbd>`;
}
/** Draw every button badge (quick actions, the table's actions, help) for the controller in use. */
function padLabelKeys() {
  document.querySelectorAll(".pad-key[data-key]").forEach((badge) => {
    const key = badge.dataset.key;
    const drawn = `${PAD.family}:${key}`;
    if (badge.dataset.drawn === drawn) return;
    badge.dataset.drawn = drawn;
    badge.innerHTML = icon(padSymbol(key), 30, { idle: false, sw: 3, cls: "pad-ico" });
    badge.title = padGlyph(key);
  });
}
/** The control a quick-action button presses on this layer, if there is one. */
function padShortcut(scope, key) {
  for (const tag of scope.querySelectorAll(`.pad-tag[data-key="${key}"]`)) {
    const control = tag.closest(PAD_FOCUSABLE);
    if (padUsable(control)) return control;
  }
  return null;
}

/* ---------- what can be focused ---------- */
/** The box drawn around a control: a field's whole pill, not just its input. */
function padBox(el) {
  return el.closest("label.field") || el;
}
/** What a control looks like on screen: a card's own outline, not its slot's. */
function padRect(el) {
  const card = el.matches(".slot") && !el.classList.contains("dragging") && el.querySelector(".card");
  return (card || padBox(el)).getBoundingClientRect();
}
/** Centre, size and tilt of the cursor for a control, so it hugs the real shape. */
function padShape(el) {
  if (el.matches(".slot")) {
    const card = el.querySelector(".card");
    const pose = poseOf(el);
    let width = card.offsetWidth * pose.scale,
      height = card.offsetHeight * pose.scale;
    // a card lying on its side gets a sideways box rather than a spun one
    let angle = ((pose.angle % 180) + 180) % 180;
    if (angle > 135) angle -= 180;
    else if (angle > 45) {
      angle -= 90;
      [width, height] = [height, width];
    }
    return { x: pose.x, y: pose.y, width, height, angle };
  }
  const rect = padBox(el).getBoundingClientRect();
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    width: rect.width,
    height: rect.height,
    angle: 0,
  };
}
function padUsable(el) {
  if (!el || !el.isConnected || el.disabled) return false;
  if (el.closest("[inert], [hidden]") || el.matches(".haptic-switch")) return false;
  if (
    el.matches(".slot") &&
    (el.classList.contains("empty") || el.dataset.ref.startsWith('["under"'))
  )
    return false;
  const rect = padBox(el).getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return false;
  return getComputedStyle(el).visibility !== "hidden";
}
/** The top-most layer; the cursor stays inside it. */
function padScope() {
  // invitations, the leave prompt and void offers are all <dialog>s
  const dialog = document.querySelector("dialog[open]");
  if (dialog) return dialog;
  return (
    document.querySelector(".modal-shade") ||
    (sheetRoot.hidden ? null : sheetRoot) ||
    document.querySelector(".emote-pop:not(.summary-emotes)") || // the results' emote row is part of the results
    document.querySelector(".summary") ||
    document.body
  );
}
function padCandidates(scope) {
  const list = [...scope.querySelectorAll(PAD_FOCUSABLE)].filter(padUsable);
  // a drawn card lies on top of the go-fish pile, so the pile is out of reach
  return list.some((el) => el.matches(".slot.held"))
    ? list.filter((el) => !el.matches(".slot") || !el.dataset.ref.startsWith('["draw"'))
    : list;
}
function padKey(el) {
  return [
    el.tagName,
    JSON.stringify(el.dataset),
    el.id,
    el.name || "",
    el.getAttribute("href") || "",
    el.getAttribute("aria-label") || "",
  ].join("|");
}
const padOnTable = () =>
  page === "room" && !!state?.game && !!board.el?.isConnected;
/** An avatar reached from elsewhere means "the wheel": land on the chosen one. */
function padWheel(el) {
  if (!el?.matches(".avatar")) return el;
  return el.parentNode.querySelector("[aria-checked='true']") || el;
}
function padDefault(scope, list = padCandidates(scope)) {
  if (scope === document.body && padOnTable()) {
    const mine = list.filter(
      (el) => el.matches(".slot") && el.closest("[data-hand='me']"),
    );
    const first = mine.find((el) => el.classList.contains("can-act")) || mine[0];
    if (first) return first;
  }
  return padWheel(
    list.find(
      (el) =>
        !el.closest(".topbar, .sheet-head") &&
        !el.matches("[aria-label='Back'], [data-setup-back]"),
    ) ||
      list[0] ||
      null,
  );
}
/** Find the focused control again after the page was redrawn under it. */
function padRecover(scope) {
  const list = padCandidates(scope);
  const same = list.find((el) => padKey(el) === PAD.key);
  if (same) return same;
  if (PAD.page === page && PAD.rect && list.length) {
    const cx = PAD.rect.left + PAD.rect.width / 2,
      cy = PAD.rect.top + PAD.rect.height / 2;
    const distance = (el) => {
      const rect = padRect(el);
      return Math.hypot(rect.left + rect.width / 2 - cx, rect.top + rect.height / 2 - cy);
    };
    return padWheel(list.reduce((a, b) => (distance(b) < distance(a) ? b : a)));
  }
  return padDefault(scope, list);
}

/* ---------- moving the cursor ---------- */
function padSetFocus(el) {
  const old = PAD.focus;
  if (old === el) return;
  if (old?.isConnected && old.matches(".slot:not(.dragging)"))
    motionFor(old).to({ scale: 1, lift: 0 });
  const typing = document.activeElement;
  if (typing && typing !== document.body && typing !== el) typing.blur?.();
  PAD.focus = el;
  if (!el) return;
  PAD.key = padKey(el);
  PAD.page = page;
  PAD.memory.set(PAD.scope, el);
  const box = padBox(el);
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
  const radius = parseFloat(getComputedStyle(el.matches(".slot") ? el.querySelector(".face") || box : box).borderRadius) || 0;
  PAD.gap = rem * 0.5;
  padCursor.style.borderRadius = `${Math.min(radius, 400) + PAD.gap}px`;
  if (el.matches(".slot")) {
    if (!el.matches(".selected, .dragging")) motionFor(el).to({ scale: 1.06, lift: 0.5 });
  } else if (el.matches(".avatar")) {
    if (el.getAttribute("aria-checked") !== "true") pickAvatar(el.dataset.avatar);
  } else if (!el.closest(".board"))
    box.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
}
/** The nearest control in a direction, preferring ones that line up. */
function padNext(from, direction, list) {
  if (from.matches(".avatar") && (direction === "left" || direction === "right")) {
    const next =
      direction === "left" ? from.previousElementSibling : from.nextElementSibling;
    if (next?.matches(".avatar")) return next;
  }
  const a = padRect(from);
  const across = direction === "left" || direction === "right";
  const sign = direction === "right" || direction === "down" ? 1 : -1;
  let best = null,
    bestScore = Infinity;
  for (const el of list) {
    if (el === from || padBox(el) === padBox(from)) continue;
    // the wheel is one stop: up and down leave it rather than hop along its arc
    if (from.matches(".avatar") && el.matches(".avatar")) continue;
    const b = padRect(el);
    const centre = (r) => (across ? r.left + r.width / 2 : r.top + r.height / 2);
    if ((centre(b) - centre(a)) * sign < 4) continue;
    const [aNear, aFar, bNear, bFar] = across
      ? [a.left, a.right, b.left, b.right]
      : [a.top, a.bottom, b.top, b.bottom];
    const travel = Math.max(0, sign > 0 ? bNear - aFar : aNear - bFar);
    const [a0, a1, b0, b1] = across
      ? [a.top, a.bottom, b.top, b.bottom]
      : [a.left, a.right, b.left, b.right];
    const miss = Math.max(0, b0 - a1, a0 - b1); // 0 when the two line up
    const drift = Math.abs((a0 + a1) / 2 - (b0 + b1) / 2);
    const score = travel + miss * 3 + drift * 0.15 + (miss > 0 ? 30 : 0);
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }
  return from.matches(".avatar") ? best : padWheel(best);
}
function padMove(direction) {
  const scope = PAD.scope || padScope();
  if (!PAD.focus) return padSetFocus(padDefault(scope));
  // moving off the Confirm button calls the staged move off
  if (padOnTable() && board.staged) return padUnstage();
  // a carried card is steered freely instead (see padCarry)
  if (padOnTable() && board.carry) return;
  const next = padNext(PAD.focus, direction, padCandidates(scope));
  if (next) padSetFocus(next);
}
/** Steer the carried card with the stick or D-pad; it snaps near places it can go. */
function padCarry(x, y, seconds) {
  const strength = Math.hypot(x, y);
  if (strength < 0.18) return carryBy(0, 0);
  // past the dead zone the push scales the speed, so a light touch is precise
  const scale = Math.min(1, (strength - 0.18) / 0.82) / strength;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
  const speed = 48 * rem; // px per second at full tilt
  carryBy(x * scale * speed * seconds, y * scale * speed * seconds);
}
/** Let go of the carried card; the cursor lands on the place it was dropped. */
function padDrop() {
  const hot = board.carry?.hot;
  dropCarry();
  const landed = hot && slotFor(hot.ref);
  if (padUsable(landed)) padSetFocus(landed);
}
/** Drop the staged move and put the cursor back where it came from. */
function padUnstage() {
  const origin = board.staged?.from && slotFor(board.staged.from);
  cancelStaged();
  if (padUsable(origin)) PAD.back = origin;
}
/** RT: pick the focused card up, or let go of the one being carried. */
function padTrigger(pressed) {
  if (!padOnTable() || PAD.scope !== document.body) return;
  if (board.carry) {
    // hold: letting go drops it. toggle: the next press drops it.
    if (pressed === (prefs.padDrag === "toggle")) padDrop();
    return;
  }
  if (!pressed || board.staged) return;
  const el = PAD.focus;
  if (el?.matches(".slot")) grabCard(el);
}

/* ---------- buttons ---------- */
/**
 * RB: Swap, as the Swap button would with what's selected. With nothing that
 * can swap selected, the card under the cursor takes part: the drawn card goes
 * into it, or it trades with the discard pile.
 */
function padSwap() {
  if (actionAllowed("swap")) return barAction("swap");
  const el = PAD.focus;
  const ref = el?.matches(".slot") ? JSON.parse(el.dataset.ref) : null;
  if (!ref || ref[0] !== state.viewer) return el?.matches(".slot") ? popSlot(el, 0.3) : null;
  const before = board.selected;
  board.selected = before.length === 1 && !same(before[0], ref) ? [before[0], ref] : [ref];
  if (actionAllowed("swap")) {
    paintSelection();
    return barAction("swap");
  }
  board.selected = before;
  popSlot(el, 0.3);
}
function padCycleSelect(select, step) {
  const count = select.options.length;
  if (!count) return;
  select.selectedIndex = (select.selectedIndex + step + count) % count;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}
function padActivate(el) {
  if (el.matches(".slot")) return tapSlot(JSON.parse(el.dataset.ref), el);
  if (el.matches("select")) return padCycleSelect(el, 1);
  if (el.matches("input:not([type=checkbox]):not([type=radio])")) return el.focus();
  el.click();
}
function padBack() {
  const scope = PAD.scope;
  if (scope?.matches?.("dialog"))
    return (padShortcut(scope, "b") || scope.querySelector("[data-social-close], [data-queue-hide]") || { click() {} }).click();
  if (scope?.matches?.(".modal-shade")) return; // a choice the game is waiting on
  if (!sheetRoot.hidden) return closeSheet();
  if (padOnTable() && board.emotesOpen) {
    board.emotesOpen = false;
    return renderEmotes();
  }
  if (padOnTable()) {
    if (board.staged) return padUnstage();
    if (board.carry) return cancelCarry();
    if (board.selected.length) {
      board.selected = [];
      paintSelection();
    }
    return;
  }
  (padShortcut(scope || document.body, "b") || root.querySelector("[aria-label='Back'], [data-setup-back]"))?.click();
}
function padPress(name) {
  const el = PAD.focus;
  const table = padOnTable() && PAD.scope === document.body;
  const legal = table ? state.game.legal : {};
  const step = name === "lb" ? -1 : 1;
  // while a card is carried or a move is staged, only A, B and the trigger act
  const pending = table && (board.carry || board.staged);
  if (pending && !["a", "b", "rt"].includes(name)) return;
  // a staged move is still playing out: nothing to press yet
  if (table && board.staged && !board.staged.ready && name !== "b") return;
  // menus, dialogs and the results: a button wearing this one's sticker is pressed
  // (B keeps its own rules in padBack; a focused option still steps with LB/RB)
  if (!table && name !== "a" && name !== "b" && !(el?.matches("select") && (name === "lb" || name === "rb"))) {
    const shortcut = padShortcut(PAD.scope || padScope(), name);
    if (shortcut) {
      padSetFocus(shortcut);
      return padActivate(shortcut);
    }
  }
  switch (name) {
    case "a":
      if (table && board.carry) padDrop();
      else if (el) padActivate(el);
      break;
    case "rt":
      padTrigger(true);
      break;
    case "b":
      padBack();
      break;
    case "x":
      if (legal.discard && !busy)
        playMove("discard", {}, { from: ["held", null], to: ["discard", null], label: "discard" });
      break;
    case "y":
      if (legal.draw && !busy) move("draw");
      break;
    case "lt":
      if (table) cycleOpponent(1);
      break;
    case "lb":
    case "rb":
      if (table && name === "lb") {
        // flip the card under the cursor (or the go-fish pile)
        if (!el?.matches(".slot")) break;
        const ref = JSON.parse(el.dataset.ref);
        if (canFlip(ref) && !busy) {
          board.selected = [];
          paintSelection();
          flipMove(ref);
        } else popSlot(el, 0.3);
      } else if (table) {
        if (!busy) padSwap();
      } else if (el?.matches("select")) padCycleSelect(el, step);
      else {
        const chosen = root.querySelector(".avatar[aria-checked='true']");
        const next = step < 0 ? chosen?.previousElementSibling : chosen?.nextElementSibling;
        if (!next?.matches(".avatar")) break;
        pickAvatar(next.dataset.avatar);
        // a cursor resting on the wheel goes with the choice; anywhere else it stays put
        if (el?.matches(".avatar")) padSetFocus(next);
      }
      break;
    case "select":
      if (!padOnTable()) break;
      if (sheetRoot.hidden) openRulesSheet(state.viewer);
      else closeSheet();
      break;
    case "start":
      if (!sheetRoot.hidden) closeSheet();
      else document.querySelector("[data-game-menu], [data-settings]")?.click();
      break;
  }
}

/* ---------- reading the controller ---------- */
function padEnter() {
  if (PAD.active) return;
  PAD.active = true;
  PAD.scope = null; // re-pick the focus for whatever is on screen now
  document.documentElement.classList.add("pad");
  padLabelKeys();
}
function padLeave() {
  if (!PAD.active) return;
  PAD.active = false;
  document.documentElement.classList.remove("pad");
  if (PAD.focus?.isConnected && PAD.focus.matches(".slot:not(.dragging)"))
    motionFor(PAD.focus).to({ scale: 1, lift: 0 });
  if (typeof board !== "undefined" && board.el) cancelCarry();
  PAD.focus = null;
  PAD.back = null;
  PAD.placed = "";
  padCursor.classList.remove("on");
}
/* ---------- rumble ---------- */
// Each moment of play as pulses: [start ms, length ms, heavy motor, light motor].
// The heavy (low) motor reads as weight, a thud; the light (high) one as a click.
const PAD_RUMBLE = {
  tap: [[0, 22, 0, 0.22]], // a button: a dry click
  grab: [[0, 45, 0.12, 0.45]], // a card lifts off the felt
  snap: [[0, 16, 0, 0.32]], // the carried card notches onto a place it can go
  drop: [[0, 70, 0.5, 0.2]], // set down: a soft, heavy thud
  flip: [[0, 30, 0.08, 0.55], [65, 40, 0.3, 0.15]], // the flick, then the card slaps down
  turn: [[0, 90, 0.35, 0.45], [170, 90, 0.35, 0.45]], // your turn: two firm knocks
  win: [[0, 80, 0.2, 0.6], [140, 80, 0.3, 0.75], [280, 260, 0.55, 1]], // rising, then a long cheer
  lose: [[0, 420, 0.6, 0]], // one long, low slump
  tie: [[0, 90, 0.3, 0.3], [200, 90, 0.3, 0.3]],
};
/** The connected controllers that can rumble. */
function padMotors() {
  return [...(navigator.getGamepads?.() || [])].filter((pad) => pad?.connected && pad.vibrationActuator?.playEffect);
}
function padPulses(pulses, delay = 0) {
  const pads = padMotors();
  if (!pads.length) return;
  // one effect at a time: each pulse is its own short effect, started on time
  for (const [start, duration, strong, weak] of pulses)
    setTimeout(() => {
      for (const pad of pads)
        try {
          pad.vibrationActuator.playEffect("dual-rumble", { duration, strongMagnitude: strong, weakMagnitude: weak }).catch(() => {});
        } catch {}
    }, delay + start);
}
/**
 * Rumble a controller for a moment of play (called by haptic() in ui.js). Feel
 * for your own hands (tap, grab, snap, drop, flip) only comes while the
 * controller is what you're playing with; news (your turn, the result) comes
 * whenever one is connected.
 */
function padHaptic(kind) {
  if (!PAD.connected) return;
  const news = kind === "turn" || kind === "win" || kind === "lose" || kind === "tie";
  if (!news && !PAD.active) return;
  padPulses(PAD_RUMBLE[kind] || PAD_RUMBLE.tap);
}
/** The deal: a light tick as each card lands, building, then the deck settles. */
function padDealRumble(count, gap, delay = 0) {
  if (!PAD.connected) return;
  const pulses = [];
  for (let i = 0; i < count; i++) pulses.push([i * gap, 18, 0.05 + (0.25 * i) / count, 0.3 + (0.3 * i) / count]);
  pulses.push([count * gap + 60, 110, 0.45, 0.25]);
  padPulses(pulses, delay);
}
/** Keep the cursor on a live control and draw it there. */
function padTrack(gamepads) {
  const scope = padScope();
  const table = padOnTable();
  if (table && scope !== document.body) cancelCarry(); // a sheet or dialog opened
  const confirm =
    table && board.staged?.ready && scope === document.body
      ? board.el.querySelector("[data-confirm]")
      : null;
  if (scope !== PAD.scope) {
    PAD.scope = scope;
    const remembered = PAD.memory.get(scope);
    padSetFocus(padUsable(remembered) ? remembered : padRecover(scope));
  }
  if (confirm) {
    // a staged move puts the cursor on Confirm, so the main button plays it
    if (PAD.focus !== confirm) {
      if (!PAD.back) PAD.back = PAD.focus;
      padSetFocus(confirm);
    }
  } else if (PAD.back) {
    const back = PAD.back;
    PAD.back = null;
    if (padUsable(back)) padSetFocus(back);
  }
  if (!padUsable(PAD.focus)) padSetFocus(padRecover(scope));
  // a card you just drew is already "in hand": move to a card and press to place it
  const held = table && !!state.game.held;
  if (!held) PAD.held = false;
  else if (!PAD.held && scope === document.body && !busy) {
    PAD.held = true;
    const ref = ["held", null];
    if (!board.selected.length && !board.carry && !board.staged && movesFrom(ref).length) {
      board.selected = [ref];
      paintSelection();
    }
  }
  if (document.querySelector(".pad-key[data-key]:empty")) padLabelKeys();
  const el = PAD.focus;
  if (!el) {
    padCursor.classList.remove("on");
    PAD.placed = "";
    return;
  }
  // a <dialog> sits in the top layer, so the cursor has to live inside it
  const host = scope.matches?.("dialog") ? scope : document.body;
  if (padCursor.parentNode !== host) host.appendChild(padCursor);
  PAD.rect = padRect(el);
  const gap = PAD.gap || 5;
  const shape = padShape(el);
  const w = shape.width + gap * 2,
    h = shape.height + gap * 2;
  const placed = [shape.x - w / 2, shape.y - h / 2, w, h, shape.angle]
    .map((value) => value.toFixed(1))
    .join();
  if (placed === PAD.placed) return;
  const [x, y, width, height, angle] = placed.split(",");
  // appear in place; glide only between controls
  padCursor.classList.toggle("jump", !PAD.placed);
  PAD.placed = placed;
  padCursor.style.transform = `translate(${x}px, ${y}px) rotate(${angle}deg)`;
  padCursor.style.width = `${width}px`;
  padCursor.style.height = `${height}px`;
  padCursor.classList.add("on");
}
function padPoll(now) {
  const gamepads = [...(navigator.getGamepads?.() || [])].filter((pad) => pad?.connected);
  if (!gamepads.length) {
    PAD.frame = 0;
    padConnected(false);
    return padLeave();
  }
  PAD.frame = requestAnimationFrame(padPoll);
  if (document.hidden) return;
  const held = (index) =>
    gamepads.some((pad) => pad.buttons[index]?.pressed || pad.buttons[index]?.value > 0.5);
  const axis = (index) =>
    gamepads.reduce((most, pad) => (Math.abs(pad.axes[index] || 0) > Math.abs(most) ? pad.axes[index] : most), 0);
  const presses = [],
    moves = [];
  let triggerReleased = false;
  for (const [name, index] of Object.entries(PAD_BUTTONS)) {
    const down = held(index);
    if (down && !PAD.buttons[name]) presses.push(name);
    if (!down && PAD.buttons[name] && name === "rt") triggerReleased = true;
    PAD.buttons[name] = down;
  }
  if (triggerReleased && PAD.active) padTrigger(false);
  for (const [name, [button, stick, sign]] of Object.entries(PAD_DIRECTIONS)) {
    const down = held(button) || axis(stick) * sign > 0.6;
    if (!down) PAD.repeat[name] = 0;
    else if (!PAD.repeat[name]) {
      PAD.repeat[name] = now + PAD_FIRST_REPEAT;
      moves.push(name);
    } else if (now >= PAD.repeat[name]) {
      PAD.repeat[name] = now + PAD_REPEAT;
      moves.push(name);
    }
  }
  if (presses.length || moves.length) {
    const user = gamepads.find((pad) => pad.buttons.some((button) => button.pressed)) || gamepads[0];
    const family = padFamily(user.id);
    if (family !== PAD.family) {
      PAD.family = family;
      padLabelKeys();
    }
    if (!PAD.active) {
      // the first press only wakes the cursor, so nothing is pressed by surprise
      padEnter();
      padTrack(gamepads);
      return;
    }
    PAD.scope = PAD.scope || padScope();
    moves.forEach(padMove);
    presses.forEach(padPress);
  }
  if (!PAD.active) return;
  const seconds = Math.min(0.05, (now - (PAD.clock || now)) / 1000);
  PAD.clock = now;
  if (padOnTable() && board.carry && PAD.scope === document.body) {
    const pad = (index) => (held(index) ? 1 : 0);
    padCarry(
      clamp(axis(0) + pad(15) - pad(14), -1, 1),
      clamp(axis(1) + pad(13) - pad(12), -1, 1),
      seconds,
    );
  }
  const scroll = axis(3);
  if (Math.abs(scroll) > 0.2) {
    const scroller =
      PAD.scope === sheetRoot
        ? sheetRoot.querySelector(".sheet")
        : PAD.scope?.matches?.("dialog")
          ? PAD.scope
          : padOnTable()
            ? document.querySelector(".summary")
            : document.scrollingElement;
    scroller?.scrollBy(0, scroll * 18);
  }
  padTrack(gamepads);
}
/** Quick-action stickers and floating Back buttons show while any controller is connected. */
function padConnected(on) {
  PAD.connected = on;
  document.documentElement.classList.toggle("pad-on", on);
  if (on) padLabelKeys();
  padWakeLock();
}
/**
 * While a controller is connected, keep the screen on (where the browser
 * allows it): a player on a couch may not touch the screen for a long time.
 * The browser drops the lock whenever the page is hidden, so it is taken
 * again each time the page comes back.
 */
async function padWakeLock() {
  const want = PAD.connected && document.visibilityState === "visible";
  if (!want) {
    const lock = PAD.wakeLock;
    PAD.wakeLock = null;
    lock?.release().catch(() => {});
    return;
  }
  if (PAD.wakeLock || !navigator.wakeLock?.request) return;
  try {
    PAD.wakeLock = await navigator.wakeLock.request("screen");
    PAD.wakeLock.addEventListener("release", () => (PAD.wakeLock = null));
    if (!PAD.connected) padWakeLock(); // unplugged while the request was pending
  } catch {} // refused (low battery, no permission): the screen sleeps as usual
}
document.addEventListener("visibilitychange", padWakeLock);
function padStart() {
  padConnected(true);
  if (!PAD.frame) PAD.frame = requestAnimationFrame(padPoll);
}
window.addEventListener("gamepadconnected", (event) => {
  PAD.family = padFamily(event.gamepad.id);
  padStart();
  if (typeof toast === "function") toast("Controller connected.");
});
window.addEventListener("gamepaddisconnected", () => {
  if (![...(navigator.getGamepads?.() || [])].some((pad) => pad?.connected)) {
    padConnected(false);
    padLeave();
  }
});
// Touching the screen or moving the mouse hands control back.
document.addEventListener("pointerdown", padLeave, true);
document.addEventListener(
  "pointermove",
  (event) => {
    if (event.pointerType === "mouse" && Math.abs(event.movementX) + Math.abs(event.movementY) > 2)
      padLeave();
  },
  true,
);

/** The controls list shown in the settings and table menus while a controller is connected. */
function padHelpHtml() {
  if (!PAD.connected) return "";
  // drawn as SF Symbols by padLabelKeys; the name stays for screen readers
  const key = (name) => `<kbd class="pad-key" data-key="${name}" aria-label="${e(padGlyph(name))}"></kbd>`;
  const rows = padOnTable()
    ? [
        [key("dpad"), "Move between cards"],
        [key("a"), prefs.confirm ? "Pick up, place, and confirm" : "Pick up a card, then place it"],
        [key("b"), "Undo / put the card down / close"],
        [key("rt"), prefs.padDrag === "toggle" ? "Grab a card and steer it; press again to drop" : "Hold and steer a card; let go to drop it"],
        [key("y"), "Draw"],
        [key("rb"), "Swap the card under the cursor"],
        [key("x"), "Discard"],
        [key("lb"), "Flip the card or the go-fish pile"],
        [key("lt"), "Next opponent"],
        [key("select"), "Rules & scores"],
      ]
    : [
        [key("dpad"), "Move"],
        [key("a"), "Select"],
        [key("b"), "Back"],
        [key("lb") + key("rb"), "Change avatar or option"],
        [key("rstick"), "Scroll"],
        [key("x") + key("y"), "Quick actions: the buttons wearing a sticker"],
        [key("start"), "Settings"],
      ];
  const html = `<div data-pad-help><h3>Controller</h3><div class="pad-help">${rows.map(([keys, text]) => `<span class="keys">${keys}</span><span>${e(text)}</span>`).join("")}</div></div>`;
  queueMicrotask(padLabelKeys); // once the sheet is on the page
  return html;
}
