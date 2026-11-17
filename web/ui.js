"use strict";
// Shared UI primitives: escaping, sticker icons, sticker text.

const e = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );

// Every sticker drifts on its own slightly different loop so nothing moves in
// unison. The loop is derived from what the sticker is (its seed, and how many
// of that seed came before it in this render) and runs against one shared
// clock, so drawing the same sticker again continues its drift instead of
// restarting it somewhere else.
const idleEpoch = performance.now();
let idleSeen = null;
function idleStyle(seed = "") {
  if (!idleSeen) {
    idleSeen = new Map();
    queueMicrotask(() => (idleSeen = null)); // counts start over with each render
  }
  const nth = idleSeen.get(seed) || 0;
  idleSeen.set(seed, nth + 1);
  // a small seeded generator (string hash into mulberry32)
  let state = 2166136261;
  for (const char of `${seed}#${nth}`) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  const r = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const age = (performance.now() - idleEpoch) / 1000;
  return `--ix:${(0.07 + r() * 0.1).toFixed(3)}rem;--iy:${(0.1 + r() * 0.13).toFixed(3)}rem;--ir:${(1.4 + r() * 2.2).toFixed(2)}deg;--idle-d:${(3 + r() * 2.8).toFixed(2)}s;--idle-delay:-${(r() * 6 + age).toFixed(2)}s`;
}

/**
 * An SF Symbol drawn as a sticker: fill, contrasting outline, hard shadow.
 * `size` is the Figma font size in design px. The outline is 4px on large
 * stickers and 3px on small ones, matching the Figma strokes.
 * Colors come from the --fill / --stroke custom properties of the context.
 */
function icon(name, size = 24, opts = {}) {
  const data = ICONS[name];
  if (!data) return "";
  const scale = size / 100;
  const stroke = opts.sw ?? (size >= 40 ? 4 : 3);
  const pad = stroke / scale + 1;
  const [x, y, w, h] = data.b;
  const rem = (units) => ((units * scale) / 10).toFixed(3);
  const classes = ["ico"];
  if (opts.idle !== false) classes.push("idle");
  if (opts.flat) classes.push("flat");
  if (opts.ink) classes.push("ink");
  if (opts.cls) classes.push(opts.cls);
  const width = ((stroke * 2) / scale).toFixed(1);
  const style = `width:${rem(w + pad * 2)}rem;height:${rem(h + pad * 2)}rem;margin:-${rem(pad)}rem -${rem(opts.tight ? pad : 1)}rem;${opts.idle !== false ? idleStyle(opts.key ?? `${name}@${size}`) + ";" : ""}${opts.style || ""}`;
  return `<svg class="${classes.join(" ")}" viewBox="${(x - pad).toFixed(1)} ${(y - pad).toFixed(1)} ${(w + pad * 2).toFixed(1)} ${(h + pad * 2).toFixed(1)}" style="${style}" aria-hidden="true">${(data.l || [[0, data.d]]).map(([cut, d]) => (cut ? `<path class="cut" d="${d}"/>` : `<path d="${d}" stroke-width="${width}"/>`)).join("")}</svg>`;
}

/** A plain single-colour glyph (chevrons, close marks) in the current text colour. */
function glyph(name, size = 20) {
  return icon(name, size, { idle: false, flat: true, ink: true, sw: 0, tight: true });
}

/**
 * An SF Symbol drawn like a letter: sized in ems and filled with the text
 * colour, so it matches whatever type it sits beside. With a label it is read
 * out; without one it is decoration.
 */
function textSymbol(name, cls, label = "") {
  const data = ICONS[name];
  const [x, y, w, h] = data.b;
  const paths = (data.l || [[0, data.d]])
    .map(([cut, d]) => (cut ? "" : `<path d="${d}"/>`))
    .join("");
  const access = label
    ? `role="img" aria-label="${e(label)}"`
    : `aria-hidden="true"`;
  return `<svg class="text-symbol ${cls}" viewBox="${x} ${y} ${w} ${h}" ${access} style="aspect-ratio:${w}/${h}">${paths}</svg>`;
}
/** The star that marks your own name. */
const youStar = () => textSymbol("star.fill", "you-star", "you");

/**
 * Light always comes from the top-left, so every sticker's shadow falls down
 * and to the right on screen. A sticker that is rotated or mirrored gets its
 * shadow offset counter-transformed to keep it pointing that way.
 */
function shadowVars(degrees = 0, mirrored = false) {
  const angle = (degrees * Math.PI) / 180,
    reach = 0.3;
  const x = reach * (Math.cos(angle) + Math.sin(angle));
  const y = reach * (Math.cos(angle) - Math.sin(angle));
  return `--shx:${(mirrored ? -x : x).toFixed(3)}rem;--shy:${y.toFixed(3)}rem;`;
}

/** Icon with the static tilt the design gives button glyphs (−6° / mirrored). */
function tilted(name, size, opts = {}) {
  const tilt = opts.tilt ?? -6;
  const style = shadowVars(opts.mirror ? -tilt : tilt, opts.mirror) + (opts.style || "");
  return `<span class="tilt${opts.mirror ? " mirror" : ""}" style="--tilt:${tilt}deg">${icon(name, size, { ...opts, style })}</span>`;
}

/** Sticker text; each character can drift on its own when `split` is set. */
function stickerText(text, opts = {}) {
  const chars = opts.split ? [...String(text)] : [String(text)];
  // seeded by position, so a number that changes keeps each digit's drift
  const seed = opts.key ?? `text:${opts.cls || ""}:${opts.split ? "" : text}`;
  return chars
    .map(
      (char, i) =>
        `<span class="stk${opts.idle === false ? "" : " idle"}${opts.cls ? " " + opts.cls : ""}" style="${opts.idle === false ? "" : idleStyle(`${seed}:${i}`)}">${e(char)}</span>`,
    )
    .join("");
}

/* ---------- preferences (kept on this device) ---------- */
const prefs = {
  confirm: true, // moves wait for the Confirm button beside the discard pile
  padDrag: "hold", // controller: hold the trigger to carry a card, or "toggle"
  haptics: true,
  hideTips: false,
};
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem("golf-prefs") || "{}"));
} catch {}
function applyPrefs() {
  const html = document.documentElement.classList;
  html.toggle("no-haptics", !prefs.haptics);
  html.toggle("no-tips", prefs.hideTips);
}
function setPref(key, value) {
  prefs[key] = value;
  try {
    localStorage.setItem("golf-prefs", JSON.stringify(prefs));
  } catch {}
  applyPrefs();
}
applyPrefs();

/* ---------- taps ---------- */
// A click only counts when the press began and ended on the same control
// without travelling. A drag that passes over a button, or a press that slides
// off one, must never activate it (the haptic switches would otherwise toggle
// when a finger is dragged across them).
let lastPress = null;
const pressControl = (target) => target.closest?.("button, a, summary, label") || null;
document.addEventListener(
  "pointerdown",
  (event) => {
    lastPress = {
      id: event.pointerId,
      control: pressControl(event.target),
      x: event.clientX,
      y: event.clientY,
      moved: false,
      ended: 0,
    };
  },
  true,
);
document.addEventListener(
  "pointermove",
  (event) => {
    const press = lastPress;
    if (!press || press.ended || event.pointerId !== press.id) return;
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) > 12) press.moved = true;
  },
  true,
);
for (const type of ["pointerup", "pointercancel"])
  document.addEventListener(
    type,
    (event) => {
      const press = lastPress;
      if (!press || event.pointerId !== press.id) return;
      press.ended = performance.now();
      if (type === "pointercancel") press.moved = true; // it turned into a scroll
    },
    true,
  );
document.addEventListener(
  "click",
  (event) => {
    const press = lastPress;
    // keyboard and scripted clicks have no press behind them
    if (!press || !event.isTrusted) return;
    if (press.ended && performance.now() - press.ended > 700) return;
    if (press.moved || pressControl(event.target) !== press.control) {
      event.stopImmediatePropagation();
      event.preventDefault();
    }
  },
  true,
);

/* ---------- haptics ---------- */
// Android has the Vibration API. iOS does not, but toggling a native switch
// (<input type="checkbox" switch>) makes the system play a tick, and since
// iOS 26.5 only when a finger toggles it directly. So on iOS every button
// carries an invisible native switch over itself: the tap lands on the switch,
// the system ticks, and the click bubbles up to the button as usual.
const HAPTIC_PATTERNS = {
  tap: 8,
  grab: 12,
  snap: 6,
  drop: 14,
  flip: 10,
  turn: [18, 70, 18],
};
const touchDevice = matchMedia("(pointer: coarse)").matches;
const canVibrate = typeof navigator.vibrate === "function";
const switchHaptics =
  !canVibrate &&
  touchDevice &&
  (() => {
    const probe = document.createElement("input");
    probe.type = "checkbox";
    return "switch" in probe;
  })();
const hapticsAvailable = (canVibrate && touchDevice) || switchHaptics;
let hapticProbe = null;
/** Play a short tick for something that happened (a card picked up, a drop, your turn). */
function haptic(kind = "tap") {
  if (!prefs.haptics || !hapticsAvailable) return;
  if (canVibrate) {
    try {
      navigator.vibrate(HAPTIC_PATTERNS[kind] || HAPTIC_PATTERNS.tap);
    } catch {}
    return;
  }
  // iOS: taps are played by the switch under the finger. For everything else,
  // toggling a hidden switch from script still ticks on iOS before 26.5.
  if (kind === "tap") return;
  probeTick();
}
function probeTick() {
  if (!hapticProbe) {
    hapticProbe = document.createElement("label");
    hapticProbe.className = "haptic-probe";
    hapticProbe.setAttribute("aria-hidden", "true");
    hapticProbe.innerHTML = `<input type="checkbox" switch tabindex="-1">`;
    document.body.appendChild(hapticProbe);
  }
  hapticProbe.click();
}
/** A run of quick ticks, one per card, for the deal. */
function hapticFlurry(count, gap, delay = 0) {
  if (!prefs.haptics || !hapticsAvailable) return;
  setTimeout(() => {
    if (canVibrate) {
      const pattern = [];
      for (let i = 0; i < count; i++) pattern.push(7, Math.max(1, gap - 7));
      try {
        navigator.vibrate(pattern);
      } catch {}
    } else for (let i = 0; i < count; i++) setTimeout(() => haptic("snap"), i * gap);
  }, delay);
}
/**
 * Whether a swipe starting on this element should be able to scroll. A native
 * switch claims any touch that starts on it, so a button with one can't start a
 * scroll: buttons in anything that scrolls right now go without.
 */
function inScroller(element) {
  for (let el = element.parentElement; el && el !== document.body; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowY;
    if ((overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight + 1) return true;
    if (el.classList.contains("board")) return false; // the table never scrolls
  }
  return document.documentElement.scrollHeight > innerHeight + 1;
}
/**
 * Lay the invisible switch over every button that can take it, and take it off
 * buttons that now sit in something scrollable (they tick from a click instead).
 */
function hapticOverlay(scope = document) {
  // not the avatars: a native switch would take the sideways swipe for itself
  scope.querySelectorAll("button[type=button]:not(.avatar)").forEach((button) => {
    const existing = button.lastElementChild?.classList.contains("haptic-switch") ? button.lastElementChild : null;
    if (inScroller(button)) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.className = "haptic-switch";
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    // clip-path rounds the hit area too, so corners outside the button stay dead
    input.style.clipPath = `inset(0 round ${getComputedStyle(button).borderRadius || "0px"})`;
    button.appendChild(input);
  });
}
function hapticsInstall(force = false) {
  if (canVibrate && !force) {
    document.addEventListener(
      "click",
      (event) => {
        if (event.target.closest?.("button, a.btn, summary")) haptic("tap");
      },
      true,
    );
    return;
  }
  if (!switchHaptics && !force) return;
  let queued = 0;
  const sweep = () => {
    queued = 0;
    hapticOverlay();
  };
  // sweep on the next frame, and again once things settle: a page animating in
  // can briefly overflow the screen, which would leave its buttons without a switch
  let settle = 0;
  const soon = () => {
    if (!queued) queued = requestAnimationFrame(sweep);
    clearTimeout(settle);
    settle = setTimeout(() => requestAnimationFrame(sweep), 500);
  };
  new MutationObserver(soon).observe(document.body, { childList: true, subtree: true });
  // a page can start or stop scrolling without new elements: a resize, a section opening
  addEventListener("resize", soon);
  document.addEventListener("toggle", soon, true);
  // buttons left without a switch (they sit in something scrollable) tick on
  // click instead, through the hidden switch toggled from script
  document.addEventListener(
    "click",
    (event) => {
      const control = event.target.closest?.("button, a.btn, summary");
      if (control && !control.querySelector(":scope > .haptic-switch") && !event.target.classList?.contains("haptic-switch"))
        if (prefs.haptics) probeTick();
    },
    true,
  );
  hapticOverlay();
}
if (touchDevice) hapticsInstall();

// The wordmark is laid out on the exact Figma letter boxes (widths in design px,
// each overlapping the next by 10); the idle drift is applied on top of that.
// It appears as one piece: hidden until the club artwork and the display font are in.
let logoReady = false;
(() => {
  const club = new Image();
  club.src = "static/assets/logo-club.svg";
  const drawn = club.decode
    ? club.decode()
    : new Promise((done) => (club.onload = club.onerror = done));
  const font = document.fonts?.load
    ? document.fonts.load('700 64px "FOT-Seurat Pro"', "Gof")
    : Promise.resolve();
  const giveUp = new Promise((done) => setTimeout(done, 4000));
  Promise.race([Promise.allSettled([drawn, font]), giveUp]).then(() => {
    logoReady = true;
    document
      .querySelectorAll(".logo.pending")
      .forEach((logo) => logo.classList.remove("pending"));
  });
})();
function logoHtml() {
  const letter = (char, width, fill, stroke, tilt) =>
    `<span class="lg" style="width:${width / 10}rem"><span class="stk idle" style="--fill:${fill};--stroke:${stroke};transform:rotate(${tilt}deg);${shadowVars(tilt)}${idleStyle(`logo:${char}`)}">${char}</span></span>`;
  return `<a class="logo${logoReady ? "" : " pending"}" href="." data-nav="home" aria-label="Golf home">${letter("G", 62.797, "var(--p1b)", "var(--p1)", -4)}${letter("o", 45, "var(--p3b)", "var(--p3)", 0)}<span class="lg club"><span class="club-box idle" style="${idleStyle("logo:club")}"><img src="static/assets/logo-club.svg" alt="l"></span></span>${letter("f", 42.571, "var(--fw3)", "var(--fw)", 8)}</a>`;
}
