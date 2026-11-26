"use strict";
// Shared UI primitives: escaping, sticker icons, sticker text.

/**
 * When something happened (unix seconds): within the last 24 hours, how long
 * ago ("5 mins ago"); before that, the date.
 */
function dateLabel(at, options) {
  const ago = Math.max(1, Math.floor(Date.now() / 1000 - at));
  if (ago <= 86400) {
    const [n, unit] = ago < 60 ? [ago, "second"] : ago < 3600 ? [Math.floor(ago / 60), "min"] : [Math.floor(ago / 3600), "hour"];
    return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  }
  return new Date(at * 1000).toLocaleDateString(undefined, options);
}

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
/**
 * The first real page is on screen: show the backdrop. Until then the document
 * paints nothing a browser counts as content, so on a reload it keeps showing
 * the previous page and switches straight to the new one, with no blank frame.
 */
function booted() {
  document.documentElement.classList.remove("booting");
}
/* ---------- the stickers' rough paper edge ----------
   Every sticker's edge wanders a little, like torn paper, by the same amount on screen
   whatever its size: GRAIN, in screen pixels. Icons are roughened here, as they are
   drawn, for the size they are drawn at (once per icon and size: kept). Sticker text
   uses roughened cuts of its font, one for each step of a ladder of sizes, and each
   piece of sticker text is given the cut made for its size (see roughCuts below). The
   font cuts are made by tools/design/roughen.py with the same noise and the same GRAIN,
   so letters and icons match. */
const GRAIN = { amplitude: 0.5, wavelength: 1.3, step: 0.42 };
function grainHash(ix, iy, seed) {
  let n = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2147483647)) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) & 0xffff) / 0xffff;
}
function grainNoise(x, y, seed) {
  const ix = Math.floor(x),
    iy = Math.floor(y);
  const sx = x - ix,
    sy = y - iy;
  const fx = sx * sx * (3 - 2 * sx),
    fy = sy * sy * (3 - 2 * sy);
  const a = grainHash(ix, iy, seed),
    b = grainHash(ix + 1, iy, seed),
    c = grainHash(ix, iy + 1, seed),
    d = grainHash(ix + 1, iy + 1, seed);
  const top = a + (b - a) * fx,
    bottom = c + (d - c) * fx;
  return (top + (bottom - top) * fy) * 2 - 1;
}
/** An SVG path (absolute M L H V C Z, as the icons are) roughened at `perPx` units to a screen pixel. */
function roughPath(d, perPx) {
  const amplitude = GRAIN.amplitude * perPx,
    wavelength = GRAIN.wavelength * perPx,
    step = GRAIN.step * perPx;
  const tokens = d.match(/[MLHVCZ]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?/gi) || [];
  const contours = [];
  let i = 0,
    command = "",
    x = 0,
    y = 0,
    dense = null;
  const num = () => parseFloat(tokens[i++]);
  const close = () => {
    if (dense && dense.length > 1) contours.push(dense);
    dense = null;
  };
  while (i < tokens.length) {
    if (/[A-Za-z]/.test(tokens[i])) {
      command = tokens[i++];
      if (command === "Z" || command === "z") {
        close();
        continue;
      }
    }
    if (command === "M") {
      close();
      x = num();
      y = num();
      dense = [[x, y]];
      command = "L";
    } else if (command === "L") {
      x = num();
      y = num();
      dense.push([x, y]);
    } else if (command === "H") {
      x = num();
      dense.push([x, y]);
    } else if (command === "V") {
      y = num();
      dense.push([x, y]);
    } else if (command === "C") {
      const [x1, y1, x2, y2, x3, y3] = [num(), num(), num(), num(), num(), num()];
      for (let k = 1; k <= 24; k++) {
        const t = k / 24,
          u = 1 - t;
        dense.push([u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3]);
      }
      x = x3;
      y = y3;
    } else return d; // (a command this does not know: the path is drawn smooth)
  }
  close();
  const r = (v) => Math.round(v * 10) / 10;
  return contours
    .map((points) => {
      // walked at an even step, each point pushed by two noise fields (x and y)
      const even = [points[0]];
      let carry = 0;
      points.push(points[0]);
      for (let k = 1; k < points.length; k++) {
        const [ax, ay] = points[k - 1],
          [bx, by] = points[k];
        const length = Math.hypot(bx - ax, by - ay);
        if (!length) continue;
        let travelled = step - carry;
        for (; travelled <= length; travelled += step) even.push([ax + ((bx - ax) * travelled) / length, ay + ((by - ay) * travelled) / length]);
        carry = length - (travelled - step);
      }
      if (even.length < 3) return "";
      let out = "",
        px = 0,
        py = 0;
      even.forEach(([ex, ey], k) => {
        const u = ex / wavelength,
          v = ey / wavelength;
        const nx = r(ex + (grainNoise(u, v, 11) * 0.72 + grainNoise(u * 2.1, v * 2.1, 13) * 0.28) * amplitude);
        const ny = r(ey + (grainNoise(u, v, 17) * 0.72 + grainNoise(u * 2.1, v * 2.1, 19) * 0.28) * amplitude);
        out += k ? ` ${r(nx - px)} ${r(ny - py)}` : `M${nx} ${ny}l`;
        px = nx;
        py = ny;
      });
      return out + "z";
    })
    .join("");
}
/* Sticker text: every piece is marked (data-cut) with the rough cut of its typeface
   made for the size nearest its own on screen, as it is added to the page (before it
   is first drawn) and again when the screen changes size. */
const ROUGH_CUTS = [14, 20, 28, 40, 56, 80]; // (as tools/design/roughen.py cuts them)
const ROUGH_TEXT = ".stk, .field > .label, .rules-box > .label, .emote-bar-name, .boxed > .box-label, .emote-box > .box-label, .corner b";
function roughCut(el) {
  const style = getComputedStyle(el);
  // its typeface (noted the first time: once marked, the rough cut is what it reports)
  // (by the first typeface named: the others are fallbacks)
  const face = (el.dataset.face ||= /Seurat/.test(style.fontFamily.split(",")[0]) ? "seurat" : "round");
  const size = parseFloat(style.fontSize) * (parseFloat(style.getPropertyValue("--grain-scale")) || 1);
  if (!size) return;
  // the nearest step, by ratio (a 34px title is nearer 40 than 28)
  const cut = ROUGH_CUTS.reduce((best, step) => (Math.abs(Math.log(step / size)) < Math.abs(Math.log(best / size)) ? step : best));
  const value = `${face}-${cut}`;
  if (el.dataset.cut !== value) el.dataset.cut = value;
}
function roughCuts(scope = document) {
  if (scope.matches?.(ROUGH_TEXT)) roughCut(scope);
  scope.querySelectorAll?.(ROUGH_TEXT).forEach(roughCut);
}
if (typeof MutationObserver === "function" && document.body) {
  // (also when a page is patched in place, which takes away the marks it did not draw)
  new MutationObserver((changes) => {
    for (const change of changes) {
      if (change.type === "attributes") {
        if (!change.target.dataset.cut && change.target.matches(ROUGH_TEXT)) roughCut(change.target);
      } else for (const node of change.addedNodes) if (node.nodeType === 1) roughCuts(node);
    }
  }).observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["data-cut"] });
  let resized = 0;
  addEventListener("resize", () => {
    clearTimeout(resized);
    resized = setTimeout(() => roughCuts(), 150);
  });
}
const roughPaths = new Map(); // "name@size" -> its layers, roughened
/** An icon's layers, roughened for drawing at `size` (the size rounded to the half pixel: near enough). */
function roughLayers(name, data, size) {
  const at = Math.round(size * 2) / 2;
  const key = `${name}@${at}`;
  let layers = roughPaths.get(key);
  if (!layers) {
    const perPx = 100 / at;
    layers = (data.l || [[0, data.d]]).map(([cut, d]) => [cut, roughPath(d, perPx)]);
    roughPaths.set(key, layers);
  }
  return layers;
}
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
  // (a sticker has the rough edge, for its size; a plain glyph does not)
  const layers = opts.flat ? data.l || [[0, data.d]] : roughLayers(name, data, size * (opts.grainScale || 1));
  return `<svg class="${classes.join(" ")}" viewBox="${(x - pad).toFixed(1)} ${(y - pad).toFixed(1)} ${(w + pad * 2).toFixed(1)} ${(h + pad * 2).toFixed(1)}" style="${style}" aria-hidden="true">${layers.map(([cut, d]) => (cut ? `<path class="cut" d="${d}"/>` : `<path d="${d}" stroke-width="${width}"/>`)).join("")}</svg>`;
}

/** A plain single-color glyph (chevrons, close marks) in the current text color. */
function glyph(name, size = 20) {
  return icon(name, size, { idle: false, flat: true, ink: true, sw: 0, tight: true });
}

/**
 * An SF Symbol drawn like a letter: sized in ems and filled with the text
 * color, so it matches whatever type it sits beside. With a label it is read
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
/** The two figures that mark a friend's name, set like the star. */
const friendMark = () => textSymbol("figure.2", "you-star friend-mark", "friend");
/** Whether a player id (as boards and tables give them) is one of your friends. */
function isFriendId(id) {
  return !!id && typeof homeData === "object" && !!homeData.friends?.friends?.some((friend) => friend.id === id);
}
/** What goes before a player's name: the star if it is you, the two figures if a friend. */
function nameMark(id, self = false) {
  return self ? youStar() : isFriendId(id) ? friendMark() : "";
}

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
        `<span class="stk${opts.idle === false ? "" : " idle"}${opts.cls ? " " + opts.cls : ""}" data-t="${e(char)}" style="${opts.idle === false ? "" : idleStyle(`${seed}:${i}`)}">${e(char)}</span>`,
    )
    .join("");
}

/**
 * Sticker letters set on a gentle arch, like a banner: the middle rides high,
 * and the letters toward each end drop and lean outward. Read out as one word
 * (the letters themselves are hidden from screen readers).
 */
function arcText(text, key = text) {
  const chars = [...String(text)];
  // every title sits on the same big circle, so a long one bends more than a short one;
  // each letter is placed by how far (roughly) it is from the middle
  const radius = 30; // in em
  const step = 0.58; // a letter's rough width, in em
  return `<span class="arc" aria-hidden="true">${chars
    .map((char, i) => {
      const x = (i - (chars.length - 1) / 2) * step;
      const style = `transform:translateY(${((x * x) / (2 * radius)).toFixed(3)}em) rotate(${((x / radius) * 57.2958).toFixed(2)}deg)`;
      return char === " "
        ? `<span class="arc-ch space"> </span>`
        : `<span class="arc-ch" style="${style}">${stickerText(char, { key: `${key}:${i}` })}</span>`;
    })
    .join("")}</span>`;
}

/* ---------- preferences (kept on this device, and on a signed-in account) ---------- */
const prefs = {
  confirm: true, // moves wait for the Confirm button beside the discard pile
  padDrag: "hold", // controller: hold the trigger to carry a card, or "toggle"
  haptics: true,
  hideTips: false,
  autoQueue: false, // join the Ranked queue as soon as the site opens (off unless chosen)
  alerts: false, // notifications at all (the Notifications page's main switch)
  turnAlerts: true, // with it: a notification (and a buzz) when it's your turn while Golf is in the background
  queueAlerts: true, // with it: a notification when someone joins the Ranked queue
  theme: "golf", // the look of the whole game: see THEMES
  contrastCards: false, // four-color suits: orange diamonds and blue clubs
  reduceMotion: false, // no idle drift on the stickers, and screens change without sliding or springing
  showOdds: true, // spectating: each player's chance of winning under their points
  patchSeen: "", // the newest patch whose notes this player has been shown
  // the emotes on this player's bar, in order; any of each kind (Settings > Emotes)
  // Every emote there is today starts on the bar. An emote added to the game
  // later is NOT added here: it starts off the bar, for new players and old.
  emoteFaces: "unamused,shocked,laughing,cackling,nervous",
  emoteWords: "luck,thanks,oops,wow,save,ofc,tempo,ranked",
};
// Each theme is a set of color tokens in style.css, under :root[data-theme].
// "golf" is the original sticker look and needs no attribute.
const THEMES = [
  ["golf", "Original", "#c4efab"],
  ["poker", "Poker", "#021b14"], // the dark room around the table
  ["night", "Night Golf", "#0f2018"],
  ["pool", "Pool", "#a8ecea"], // a bright day at the pool
  ["focus", "Focus", "#000000", "debug"], // one dark gray on black; fewer icons
  // a theme marked "debug" is offered only on a debug server (and a saved
  // choice of one falls back to Original anywhere else)
].filter((theme) => theme[3] !== "debug" || document.documentElement.dataset?.debug !== undefined);
// What a flag holds back until it is earned (the flags are FLAGS in tabs.js; who
// has earned which, the server's flags.py). What this device last heard it has
// unlocked is kept, so a theme earned shows from the first page on.
const FLAG_LOCKED = { word: ["rushing", "dragging"], theme: ["poker", "pool"] };
let myFlags = { earned: [], emotes: [], themes: [] };
try {
  myFlags = { ...myFlags, ...JSON.parse(localStorage.getItem("golf-flags") || "{}") };
} catch {}
/** Whether an emote ("word") or theme is yours to use: none holds it back, or you have earned the flag that does. */
const flagUnlocked = (kind, id) => !FLAG_LOCKED[kind].includes(id) || (kind === "word" ? myFlags.emotes : myFlags.themes).includes(id);
/**
 * Every setting is saved together, so a saved emote bar may be one that was
 * never chosen. For a short while the bar started with only five sayings: one
 * saved exactly like that goes back to the default (all of them).
 */
function unchosenEmotes(saved) {
  if (saved.emoteWords === "luck,thanks,oops,wow,save") delete saved.emoteWords;
  return saved;
}
try {
  const saved = unchosenEmotes(JSON.parse(localStorage.getItem("golf-prefs") || "{}"));
  // "Join Ranked on open" used to be on by default, and every setting is saved
  // together, so a saved "on" from then was never chosen: only one turned on
  // since (marked autoQueueChosen) counts. A saved "off" was always a choice.
  if (saved.autoQueue && !saved.autoQueueChosen) delete saved.autoQueue;
  // Before the main notifications switch, each kind had only its own. One
  // that was on keeps notifications on, with each kind as it was; with none
  // on, both kinds start out on under the (off) main switch.
  if (!("alerts" in saved)) {
    saved.alerts = !!(saved.turnAlerts || saved.queueAlerts);
    if (saved.alerts) {
      saved.turnAlerts = !!saved.turnAlerts;
      saved.queueAlerts = !!saved.queueAlerts;
    } else {
      delete saved.turnAlerts;
      delete saved.queueAlerts;
    }
  }
  Object.assign(prefs, saved);
} catch {}
function applyPrefs() {
  const html = document.documentElement.classList;
  html.toggle("no-haptics", !prefs.haptics);
  html.toggle("no-tips", prefs.hideTips);
  html.toggle("contrast-cards", !!prefs.contrastCards);
  html.toggle("reduce-motion", !!prefs.reduceMotion);
  // (a theme its flag holds back, not yet earned here: Original)
  const theme = THEMES.find(([key]) => key === prefs.theme && flagUnlocked("theme", key)) || THEMES[0];
  if (theme === THEMES[0]) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme[0];
  // the browser's own chrome (status bar, overscroll) takes the table's color
  document.querySelector("meta[name='theme-color']")?.setAttribute("content", theme[2]);
}
// Settings that belong to this device alone (notifications need its own
// permission), so they are never saved to or taken from an account.
const DEVICE_PREFS = ["alerts", "turnAlerts", "queueAlerts"];
let onPrefsSaved = null; // app.js: save the change to a signed-in account too
function storePrefs() {
  try {
    localStorage.setItem("golf-prefs", JSON.stringify(prefs));
  } catch {}
  applyPrefs();
}
function setPref(key, value) {
  prefs[key] = value;
  if (key === "autoQueue") prefs.autoQueueChosen = true;
  storePrefs();
  if (!DEVICE_PREFS.includes(key)) onPrefsSaved?.();
}
/** The settings an account keeps: everything but this device's own. */
function accountPrefs() {
  return Object.fromEntries(Object.entries(prefs).filter(([key]) => !DEVICE_PREFS.includes(key)));
}
/** Take the settings saved on the account (only ones this version knows). */
function adoptPrefs(saved) {
  saved = unchosenEmotes({ ...saved });
  for (const [key, value] of Object.entries(saved || {}))
    if ((key in prefs || key === "autoQueueChosen") && !DEVICE_PREFS.includes(key) && typeof value !== "object") prefs[key] = value;
  if (prefs.autoQueue && !prefs.autoQueueChosen) prefs.autoQueue = false;
  storePrefs();
}
applyPrefs();

/* ---------- keyboard or touch ---------- */
// Focus rings (style.css) show only while the keyboard is the way in: a key
// press turns them on, any tap or click turns them off again.
document.addEventListener(
  "keydown",
  (event) => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey) document.documentElement.classList.add("keyboard");
  },
  true,
);
// (only when it is there: removing a class that is not there still rewrites the page's
// own class, which has the whole page's style worked out again on every touch)
document.addEventListener("pointerdown", () => {
  if (document.documentElement.classList.contains("keyboard")) document.documentElement.classList.remove("keyboard");
}, true);

/* ---------- taps ---------- */
// A click only counts when the press began and ended on the same control
// without traveling. A drag that passes over a button, or a press that slides
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
  win: [14, 50, 14, 50, 30],
  lose: [40],
  tie: [16, 90, 16],
};
const touchDevice = matchMedia("(pointer: coarse)").matches;
// Safari's engine: Safari itself, and any browser on an iPhone or iPad (they all are Safari underneath)
const safariEngine = (() => {
  const agent = typeof navigator === "object" ? navigator.userAgent || "" : "";
  return /AppleWebKit/.test(agent) && (!/Chrome|Chromium|Edg\//.test(agent) || /iPhone|iPad|iPod/.test(agent));
})();
if (safariEngine && touchDevice) document.documentElement.classList.add("safari-touch");
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
  if (!prefs.haptics) return;
  // a connected controller gets its own rumble for the same moment (gamepad.js)
  if (typeof padHaptic === "function") padHaptic(kind);
  if (!hapticsAvailable) return;
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
  if (!prefs.haptics) return;
  if (typeof padDealRumble === "function") padDealRumble(count, gap, delay);
  if (!hapticsAvailable) return;
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
    const style = getComputedStyle(el);
    const scrolls = (overflow) => overflow === "auto" || overflow === "scroll";
    if (scrolls(style.overflowY) && el.scrollHeight > el.clientHeight + 1) return true;
    // sideways scrollers too (the text emotes), which a switch would equally block
    if (scrolls(style.overflowX) && el.scrollWidth > el.clientWidth + 1) return true;
    // (something pinned to the screen that does not scroll itself, like the home screen's
    // dock, is left out of the page's scrolling: checked after its own, as a sheet is both)
    if (style.position === "fixed") return false;
    if (el.classList.contains("board")) return false; // the table never scrolls
  }
  // Anything on a page: the page scrolls, or will on a shorter screen or once more of it
  // has loaded (whether it does just now is no guide: a switch left on a button stops a
  // drag that starts on it from scrolling the page).
  return !!element.closest(".page") || document.documentElement.scrollHeight > innerHeight + 1;
}
/**
 * Lay the invisible switch over every button that can take it, and take it off
 * buttons that now sit in something scrollable (they tick from a click instead).
 */
function hapticOverlay(scope = document) {
  // not the avatars: a native switch would take the sideways swipe for itself
  // (nor the emotes in Settings > Emotes, which are held and dragged)
  scope.querySelectorAll("button[type=button]:not(.avatar):not(.emote-choice)").forEach((button) => {
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
// It appears as one piece: hidden until the display font is in (the club is
// drawn inline, so it is ready as soon as the page is).
let logoReady = false;
(() => {
  const font = document.fonts?.load
    ? document.fonts.load('700 64px "Golf Rough Seurat 56"', "Gof")
    : Promise.resolve();
  const giveUp = new Promise((done) => setTimeout(done, 4000));
  Promise.race([Promise.allSettled([font]), giveUp]).then(() => {
    logoReady = true;
    document
      .querySelectorAll(".logo.pending")
      .forEach((logo) => logo.classList.remove("pending"));
  });
})();
// The club that stands in for the logo's "l" (golf_club.svg from the design,
// turned head-down; its shadow still falls to the lower right),
// inline so its colors follow the theme: --club-fill and --club-stroke. Under
// the design's own outline sits a wider one (the stroke-width 20 copies), so the
// club's sticker edge is as thick as the letters' beside it.
const LOGO_CLUB = `<svg class="club-art" aria-hidden="true" viewBox="0 0 39 138" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g filter="url(#filter0_d_23_528)"><g transform="rotate(180 17.7 67.4)"><use xlink:href="#stroke0_23_528" style="fill:var(--club-stroke);stroke:var(--club-stroke);stroke-width:20;stroke-linejoin:round"/><use xlink:href="#stroke1_23_528" style="fill:var(--club-stroke);stroke:var(--club-stroke);stroke-width:20;stroke-linejoin:round"/><use xlink:href="#stroke0_23_528" style="fill:var(--club-fill)"/><use xlink:href="#stroke1_23_528" style="fill:var(--club-fill)"/><mask id="stroke2_23_528" maskUnits="userSpaceOnUse" x="-42.4819" y="-5.69227" width="123.484" height="144.356" fill="black"><rect fill="white" x="-42.4819" y="-5.69227" width="123.484" height="144.356"/><use xlink:href="#stroke0_23_528"/><use xlink:href="#stroke1_23_528"/></mask><path d="M28.29 37.41l.3 .93 .07 .87 .16 .67 .09 .9-.46 .18-1.15 .04-1.11 .05-.61 .13-.79 .03-.07-.89-.01-1.03-.07-.8 .15-.41 .13-.31 .06-.48-.36-.98-.09-1.02 .04-.88 .96-.06 .74 .07 .79 .06 .79 .09 .65-.14-.25 .67-.27 .68 .01 .7zM28.33 34.89l-.29 .68-.1 .68 .18 .74 .29 .77-.55 .27-.52 .07-.61-.07-.64-.12-.97 .14-.26-.13 .14-.41-.23-.77-.21-1.05-.07-.96 .22-.86 .12-.54-.06-.31-.04-.81 .81-.31 .8 .07 .54 .03 .37-.25 .55 .03 .23 .82 .37 .81 .17 .69zM27.82 21.63l.77-.23 .93-.25 .69-.05 .58 .16 .85 .17 .78-.04 .73-.01 .53 .63 .12 .08-.54-.62-.71-.13-.75 .11-.86-.16-.65-.16-.6-.02-.94 .25zM17.26 6.04l.09-.42 .17-.19 .28-.39 .26-.85 .02-1.11 .15-.65 .32-.48 .43-.51 .1-.14-.46 .57-.34 .47-.19 .59-.01 1.05-.21 .94-.31 .45-.18 .22zM5.84 14.73l.69-.12 1-.11 1.06-.18 .51-.08 .47-.23 .52-.18 .41-.06 .52-.34 .12-.09-.57 .4-.4 .07-.5 .15-.5 .25-.45 .09-.98 .17-1.04 .12zM24.17 29.09l.66-.23 .77-.34 .74-.08 .87-.25 .85-.25 .86 .09 .85 .3 .81 .3 .13 .01-.79-.24-.84-.31-.86-.17-.86 .22-.86 .28-.78 .08-.74 .28zM24.51 35.09l.99 0 .76 .02 .72-.06 .69 .04 .65-.19 .81-.06 1.08 .21 .8-.01 .12-.01-.75 .04-1.05-.19-.89-.03-.64 .23-.69-.03-.71 .06-.74-.02zM23.91 88.81l-.2 1.03-.03 .75 .03 .78 .32 .88 .29 .58 .08 .65-.17 .66 .09 .55-.26 .35-.68-.23-.9-.04-.81 .07-.87-.02-1.09 .09-.85 .02-.25 .01-.43 .34-.25-.39-.15-.83 .2-.76-.08-.7-.23-.7-.35-.87 .13-.74 .32-.71-.01-.67 .43-.28 .59-.35 .8 .02 .97 .41 .87 .43 .69 .12 .62 .02 .66-.36zM28.09 88.75l.93-.21 1.04-.1 .54 .17 .41 .18 .56 .03 .55 .23 .83 .19 .97 .14 .46 .17 .17 .45 .13 .55-.1 .66-.18 .48-.13 .41-.11 .7-.1 1.1-.02 1.17-.37 .1-.31-.24-.53 0-.64 .02-.55-.16-.69-.01-.84 .14-.95 .27-.63-.1-.35-1.07-.2-1.12-.01-.78 0-.42 .04-.35 .03-.58 .07-.89zM20.29 23.84l-.29 .68-.43 .54-.4 .66-.34 .78-.3 .63-.54 .56-.14 .87 .03 .68 .02 .07-.05-.59 .08-.9 .5-.59 .34-.6 .34-.78 .37-.68 .45-.56zM24.92 91.1l0-.72 .04-.79 .2-.8-.1-.71-.22-.68-.11-.65-.17-.68-.16-.76 .03-.14 .08 .77 .22 .68 .08 .66 .21 .67 .15 .71-.18 .78-.08 .81zM27.16 90.93l.02 .68-.02 .45 .01 .56 .15 .86 .21 .98 .08 .89-.22 .65-.19 .27-.03 .05 .17-.24 .25-.58-.02-.86-.23-.98-.14-.9-.04-.61 .02-.44zM24.73 128.99l-.01-.74-.05-.71 .26-.97 .21-.79 .09-.76-.24-.86-.27-.25-.2-.46-.04-.13 .21 .55 .24 .2 .27 .77-.03 .82-.19 .73-.27 .99-.02 .75zM27.16 128.77l.16 .62 .03 .71 .23 .65 .35 .63-.01 .72-.18 .77-.13 .65-.04 .83 0 .15 .03-.85 .11-.66 .18-.74 .07-.75-.31-.64-.28-.63-.03-.72zM29.03 92.72l.71 .15 .72-.17 .76 .05 .81 .04 .93 .01 .62-.3 .59-.21 .56 .1 .16 0-.63-.09-.57 .14-.61 .32-.87 .05-.85-.05-.75-.06-.74 .15zM29.22 126.76l.75 .27 .72 .06 .49-.13 .52-.05 .73 .21 .72-.05 .76-.07 .77-.1 .14-.01-.76 .09-.78 .08-.71 .06-.75-.17-.56-.03-.47 .17-.66-.05zM22.77 127l-.96 .12-.89 .02-.59-.11-.51-.31-.61-.16-.59-.09-.62 .18-.66 .13-.13 .04 .66-.14 .64-.19 .58 .05 .63 .13 .51 .31 .58 .16 .79-.01zM22.93 92.85l-1.13-.3-.84-.09-.43 .3-.58 .08-.67 .04-.51 .24-.59 .03-.64-.06-.12-.05 .64 .11 .6-.02 .52-.21 .64-.08 .63-.04 .42-.29 .73-.01zM28.33 34.89l.83-.05 1.07 .21 .8-.03 .54 .09 .45 .36 .43-.18 .75-.03 .95 .3 .17 .01-.94-.24-.83-.1-.44 .26-.46-.31-.5-.17-.75 .05-1.04-.18zM28.29 37.41l.94 .11 .96 .42 .67-.03 .64-.01 .66 .09 .65-.25 .59-.16 .55 .14 .11-.04-.56-.06-.58 .05-.62 .32-.68-.07-.66-.03-.61 .08-.94-.37zM24.86 37.91l.94-.14 .72 .01 .59-.05 .38-.27 .76-.05 .94 .1 .96 .43 .69-.02 .21-.01-.63 .1-.91-.33-.94-.21-.9 .01-.44 .2-.52 .11-.66-.04zM24.84 36.92l.84 .18 .73-.11 .51-.45 .41-.24 .59-.19 .88 .25 1.18 .51 .67 .24 .09 .01-.58-.18-1.14-.49-.97-.35-.62 .17-.44 .21-.47 .43-.7 .21zM27.82 21.63l-.62 .13-.53 .13-.44 .23-.65 .1-.71 .07-.54 .15-.77 .01-1.01-.07-.48-.39-.09-.82-.06-.79-.15-.67-.24-.63-.38-.7-.58-.58-.45-.4-.24-.44-.28-.33-.47-.44-.42-.87-.37-.96-.32-.41-.53-.08-.69-.43-.47-.79-.6-.44-.83-.29-.14-.1 .04-.36 .35-.81 .43-1.03 .36-.98 .14-.87 .56-.48 .5-.68 .13-.76 .14-.28 .17-.24 .33-.49 .17-1 .02-1 .22-.56 .35-.46 .48-.61 .53 .09 .42 .15 .31-.09 .49-.12 .58 .35 .53 .79 .59 .76 .67 .4 .64 .21 .83 .14 1.04 .45 .49 .59 .23 .44 .43 .32 .45 .52 .55 .66 .38 .58 .52 .65 .36 .43 .4 .37 .53 .66 .48 .62 .4 .52 .27 .75 .2 .62 .12 .51 .25 .58-.01 .62 .13 .56 .34 .77 .61 .97 .3 .94 .07 .67 .05 .48 .07 .41 .26 .8 .25 .78 .28 1.02-.08 .98-.66-.44-.61-.43-.76 .18-.82-.12-.78-.15-.5-.13-.88 .2-.87 .22zM17.26 6.04l-.24 .82-.6 .56-.38 .58-.19 .96-.4 .97-.44 1.01-.24 .66 .02 .26-.33-.08-.71-.1-.79 .19-.68 .47-.52 .77-.16 .6-.32-.49-.61 .46-.41 .12-.48 .12-.51 .25-.42 .11-.85 .15-1.09 .14-.84 .11-.47 .14-.34 .12-.43 .21-.85 .36-1.09 .4-.89 .06-.56 .07-.48 .43-.47 .36-.15-.72 .04-.79 .04-1.1-.18-.88 .12-1.02 .19-.69-.02-.48 .26-.54 .15-.64 .03-.64 .34-.75 .41-.72 .3-.56 .52-.42 .58-.41 .38-.54 .02-.45 0-.56 .27-.26 .6-.49 .83-.65 1.02-.57 .77-.39 .53-.17 .45-.44 .54-.26 .86-.37 .68-.21 .48-.06 .69-.23 .5-.32 .27-.32 .45-.42 .89-.07 1.14 .1 .78 .11 .67-.01 .73-.05 .32 .2 .78 .21 .98 .44 .4 .52-.48 .61-.35 .46-.22 .56-.02 1-.17 .99-.33 .5-.17 .24zM24.17 29.09l.66-.23 .77-.34 .74-.08 .87-.25 .85-.25 .86 .09 .85 .3 .81 .3 .43 .16 .09 .59 .05 .83-.11 .72-.34 .42-.22 .32-.01 .58 .29 .7 .21 .6 .39 .6-.02 .89-.68 .03-.94-.11-1.02-.16-.67 .23-.68 .03-.7 .03-.73 0-.88 0-.94 .02-.77 .02-.5-.04-.37 .03-.54 .21-.63-.09-.65-.01-.61 .19-.72 .09 .06-.52-.11-1.01-.51-.65-.3-.68 .04-.62-.16-.71 .03-.74 .24-.81 .17-.07 .7-.07 1.22-.07 .95-.1 .66-.1 .44-.2 .57 .01 .62-.05zM23.91 88.81l.02-.68-.04-.54-.03-.41-.02-.91-.06-1.25-.2-1.02 .12-.57 0-.35 .01-.39 .87 .09 .86 .05 .71 .02 .75-.08 .91-.11 .65 0-.31 .76-.25 .95 .1 .78 .31 .78 .16 .49 .03 .67-.09 .67-.28 .5-.03 .7 .02 .85-.08 .88-.02 .63-.05 .34 0 .41 0 .74 .18 1.12 .36 1.07-.35 .29-.71-.26-.69-.37-.7-.18-.78 .05-.6 .21-.33 .24-.09-.57 .04-.61 .12-.68-.25-.59-.32-.7-.17-.92 0-.68zM20.29 23.84l-.29 .68-.43 .54-.4 .66-.34 .78-.3 .63-.54 .56-.14 .87 .03 .68-.18 .14-.96-.1-.98-.56-.97-.88-.64-.27-.33-.04-.2-.14-.41-.45-.51-.36-.66-.14-.65-.09-.8-.05-.89-.23-.7-.41-.43-.7-.44-.57-.59-.29-.62-.22-.49-.42-.61-.21-.34-.47-.59-.58-.35-.45-.66-.54-.76-.18-.55-.38-.51-.52-.31-.59-.33-.84-.32-.76-.29-.44-.29-.31 .14-.48 .49-.41 .44-.33 .72 0 .94-.17 1.12-.46 .64-.29 .39-.15 .33-.14 .61-.13 .93-.09 1.12-.18 .62-.1 .44-.19 .52-.21 .43-.08 .48-.24 .5-.52-.2-.38 .3 0 .46 .1 .47 .28 .77 .5 .93 .88 .81 .6 .57 .32 .7 .2 .72 .06 .49-.05 .53 .48 .69 .67 .5 .73 .62 .38 .34-.1 .69-.11 .77 .21 .68 .07-.14 .91-.24 .75-.28 .68-.41 .71-.55 .69-.36 .77-.11 .66 .2 .4zM24.92 91.1l0-.72 .04-.79 .2-.8-.1-.71-.22-.68-.11-.65-.17-.68-.16-.76 .34-.42 .57 .05 .77 0 .72 .2 .25 .58 .16 .37 .04 .55 .09 .83-.1 .73-.05 .67-.04 .6 .01 .79 0 .76 .02 .66-.02 .44 .03 .6 .15 .88 .22 .99 .04 .86-.24 .6-.18 .26-.44 .36-.7 .16-.71 0-.85 .39 .1-.83 .27-1.01 .09-.78 .29-.36 .24-.36-.05-.56-.19-.87-.24-.83zM24.73 128.99l-.01-.74-.05-.71 .26-.97 .21-.79 .09-.76-.24-.86-.27-.25-.2-.46 .15-.54 .65-.21 .86 .03 1.04-.01 .19 .43-.01 .61-.07 .55-.25 .55-.1 .88-.08 .9 .13 .66 .04 .77 .11 .78 .15 .63 .03 .71 .27 .64 .32 .63-.05 .74-.18 .76-.12 .65-.03 .85-.5 .13-.89-.05-.82 .13-.31-.01-.13-.47-.05-.62 .25-.75-.15-.5-.13-.68-.26-.76-.04-.57 .07-.69zM29.03 92.72l.71 .15 .72-.17 .76 .05 .81 .04 .93 .01 .62-.3 .59-.21 .56 .1 .56 .23-.11 .84-.2 1.15-.03 .92 .2 .73 .32 .61-.05 .59-.17 .55 .14 .76-.14 .39 .03 .7 .22 1.14 .03 .77-.01 .68 .14 .77 .03 .83-.04 .58-.16 .14-.01 .62-.04 .75-.17 .81-.02 .95 .08 .68 .27 .47 .18 .66-.05 .72-.35 .92-.19 .96-.02 .69-.03 .46-.28 .5-.02 .57 .15 .55 .2 .53 .1 .75-.05 .79-.24 .74-.11 .67-.01 .78 .19 .93-.16 .81-.09 .65 .07 .5-.19 .54 .11 .83 .48 1.1 .26 .98-.09 .61-.33 .43-.54 .19-.78 .11-.75 .06-.73 .03-.71-.22-.5 .09-.5 .11-.76-.08-.72-.3-.84-.27-1.01 .15-.52 .08-.37 .15-.38 .17-.77-.19-.88-.06-.94 .12-.16-.6 .35-1.09-.02-.68-.17-.28-.13-.14-.11-.58 .2-.9 .55-1.14 .03-.68-.26-.56-.42-.57-.09-.63 .21-.8 .33-.89 .02-.95-.11-.66-.15-.44 .12-.58-.14-.82-.38-.98-.05-.67 .2-.7 .39-.71 .07-.62-.01-.64-.07-.72-.18-.97-.02-.77 .06-.74 .03-.59 .12-.78-.07-.63-.28-.44-.19-.7-.12-.75 .24-.59-.07-.69-.04-.6-.1-.63-.01-.66 0-.51 .06-.46 .11-.49 .23-.86 .18-1.13 .31-.65 0-.59-.11-.56 .12-.72 .7 0 .7 .08 .5-.21 .66-.03 .51-.09 .22-.61 .53-.19 .79 .26zM22.77 127l-.96 .12-.89 .02-.59-.11-.51-.31-.61-.16-.59-.09-.62 .18-.66 .13-.43-.26 .06-.86 .09-.85 .09-.59-.25-.28 .05-.54-.05-.83-.24-.88-.02-.84 .26-.77 .19-.68 .15-.72 .05-.66 .01-.66 .07-.58-.18-.71-.48-.91-.19-.62 .05-.68 .02-.86 .14-.72 .05-.67 .06-.62 .28-.6 .09-.75 .1-.86-.12-.66-.1-.67-.3-.68-.12-.87-.04-.62 .12-.49 .25-.88 .03-.71-.25-.56-.34-.47 0-.6 .21-.68 .21-.8-.01-.65 .07-.62 .31-.55-.12-.77-.13-.68 .15-.57 0-.62-.03-.74-.23-.73 .24-.98 .51-.05 .63 .02 .59-.05 .52-.24 .67-.02 .56-.11 .44-.29 .91 .14 1.15 .32 1.11 .38 .72 .08 .65-.01 .48-.24 .7 .07 .33-.36 .28-.55 .72 .12 .33 .61 .17 1.03 .39 .93-.02 .67-.24 .42-.13 .57-.11 .46 .08 .58 .22 .57-.05 .68 .06 .85 .19 .98-.21 1.09 .02 .77 .2 .66 .48 .82-.16 .66-.51 .62-.01 .92 .08 .66 .11 .47-.16 .49 .09 .71 .08 .78 .03 .66-.01 .68-.05 .76-.15 .65-.07 .81 .04 .62 .07 .47 .2 .72 .15 .76-.15 .58 .23 .79-.12 .86-.41 .84-.26 .66 .04 .4 .28 .31 .04 .65 .02 .88 .01 1 .1 .77-.11 .6-.22 .51-.08 .58 .03 .66 .04 .7-.94 .2-.7 .13-.45 .09-.29 .21-.65-.01-.8-.22-.98 .11-.7 .08zM28.33 34.89l-.65 .2-.68-.04-.72 .07-.76 0-.98 0-.84 .03-.67 .01-.37-.05-.23-.25 .2-.56 .05-.48 .03-.46-.13-.75-.07-.8-.11-.73 .22-.8-.01-.8-.17-.87 .06-.74 .07-.56 .1-.43-.11-.71 0-.9-.06-1.05-.48-.74-.01-.59 .05-.44 .32-.11 .99 .11 .85 0 .55-.13 .66-.09 .7-.08 .46-.22 .51-.15 .59-.12 .74-.23 .92-.23 .77-.12 .52 .16 .85 .16 .79 .03 .75-.12 .55 .59 .57 .42-.04 .41 .06 .49 .18 .66-.07 .52-.05 .8-.02 .83-.18 .79 .29 .69 .27 .67 .03 .57-.29 .59-.25 .63-.02 .71 .23 .5 .21 .48 .1 .54 .16 1.17 .11 1.14-.14 .76-.51 .3-.94-.28-.79-.03-.43 .22-.45-.34-.52-.13-.78 .05-1.06-.2zM28.09 88.75l-.69 .17-.46-.15-.32-.13-.55-.03-.82 .23-.88 .04-.77-.05-.69 .39-.34-.18-.16-1.11-.24-.95-.15-.66 .21-.61 .32-.79 .22-.85 .12-.68-.11-.68-.17-.67-.08-.71-.24-.55-.16-.6 .18-.67 .35-.48 .28-.51 .03-.84-.2-.99-.13-.91 .15-.59-.06-.57-.03-.59 .05-.63-.19-.67-.06-.66 .13-.71-.31-.61-.24-.75 .04-.9 .08-.67 .11-.72-.04-.78 .02-.85 .02-.98 .1-.85-.19-.71 .15-.7 .15-.68-.05-.34-.1-.67-.04-.79 .09-.54-.07-.47-.07-.53 .12-.8 .18-.97 .09-.93-.34-.84 .04-.56-.05-.52-.15-.41 .39-.8 .24-.69-.18-.5-.14-.68-.14-.69-.07-.82-.09-1.02-.05-.95 .05-.73 .36-.44 .21-.44 .01-.62 .01-.71-.14-.98-.17-.9-.02-.75-.14-.52-.09-.54 .26-.8 .1-.67 .05-.66 .11-.9 .11-.35 .47 .08 .64 .09 .81 .12 .95-.14 .75 0 .6-.03 .38-.26 .71-.08 .94 .07 .97 .42 .71 .03 .63-.04 .66 .09 .66-.18 .6-.24 .54 .17 .42-.02-.06 .72-.04 .74-.11 .72-.21 .84 .08 .72 .59 .79 .34 .75 .07 .66-.04 .39-.17 .48-.09 .67-.32 1.04-.27 1.22-.13 .8 .17 .41 .4 .44 .17 .61 .02 .79-.18 .83 .01 .77-.03 .79-.3 .9-.03 .74 .09 .5-.16 .36 .02 .4-.03 .69-.05 1.01 .03 .58-.01 .54-.09 .71-.01 .63 .12 .75 .22 .85 .42 .83 .05 .74-.11 .8 .14 .62-.02 .63-.39 .46-.48 .45-.08 .64 .2 .95 .21 1.34 .08 .79 .16 .63 .16 .76 .02 .76-.26 .45-.31 .18-.19 .56 .26 .86 .63 .9 .18 .7-.2 .52-.25 .61-.11 .52 .02 .78-.03 .96-.12 1.06 0 .84 .04 .69 .16 .77 .12 .55 .24 .34 .01 .4-.08 .71-.16 .83-.23 .82 .01 .76 .08 .92-.12 1.06-.13 .64-.86-.09-.94-.14-.64-.26-.52-.09-.52-.07-.37-.29-.91 .06zM24.86 37.91l.94-.14 .73 .01 .59-.03 .38-.25 .77-.04 .95 .1 .95 .41 .7-.03 .46 .1 .23 .51-.03 .62-.09 .58-.38 .67-.01 .94-.14 1.19-.42 1.02 .12 .55 .31 .44 .18 .52 .03 .68-.04 .61-.06 .73-.02 .79-.32 .93-.42 .71-.05 .92 .01 .72 .04 .56-.24 .57 .01 .64 .19 .69-.15 .69 .09 .74 .23 .78 .03 .79-.11 .64-.16 .6 .08 .53 .06 .81 .09 .92 .08 .84 .13 .44 .22 .25-.01 .6 .02 .73 .03 .79 0 .71-.04 .69-.18 .59-.15 .5 .02 .87 .15 1.11 .12 1.15-.12 .48-.19 .35-.07 .52-.03 .78 .06 .79 .03 .65-.06 .68-.19 .73-.12 .85-.03 .54 .15 .82 .14 .89 .33 .95-.25 .42-.41 .26 .11 .66-.12 .93-.16 1.06 .19 1.05-.04 .41-.16 .24-.4 .39 .07 .93 .05 1.04 .02 .87 .12 .56 .26 .4 .15 .42-.32 .55-1.03 .1-.9 .21-.6 .02-.42-.16-.33-.13-.67 .05-.84 .21-.87-.07-.73 .06-.66 .36-.62 0-.68-.13-.87-.42-.97-.41-.8-.03-.6 .34-.47 .09 .16-.63 .05-.57 .04-.53 .07-.87 .04-.84-.08-.7 0-.84 .09-.79 .06-.68 .11-.65-.16-.49-.16-.52 .01-.91 .09-1.11 .07-1.05 .03-.65 .04-.37 .04-.37-.11-.77-.1-.8-.1-.8 .03-.8 .21-.72 .22-.69-.03-.54-.03-.76-.03-.68 .11-.5-.08-.66 .03-.58 .03-.63 .1-.86 .1-.85 .19-.85-.14-.74-.32-.73-.22-.66-.19-.8 .22-.74 .34-.61-.06-.71 .03-.48 0-.57 .1-.51-.11-.7-.11-.76-.08-.7 .11-.74 .08-.74-.19-.74 .41-.69 .36-.69-.28-.62-.24-.63-.27-.61-.01-.81 .26-.87 .29-.86 .08-.64-.24-.68-.21-.62 .13-.69 .13-.74 .02-.75-.18-.7 .05-.54 .16-.55 .19-.6 .08-.7 .02-.7-.05-.69-.03-.83-.05-.84 .76-.11 .75-.02 .83 .04 .79 .07 .68-.08 .49 .1 .58 .07zM28.29 37.41l-.78 .05-.38 .26-.58 .06-.71-.01-.94 .14-.84-.08-.67-.11-.48-.08-.43-.25-.2-.63 .48-.1 .54 .31 .75 .01 .85-.03 .82 .17 .73-.14 .49-.45 .42-.24 .6-.19 .91 .28 1.17 .51 .64 .21 .64-.18 .73-.35 .63-.3 .68-.05 .79 .23 .36 .16-.12 .69-.47 .42-.55-.15-.59 .19-.65 .23-.67-.1-.63 .03-.69 .01-.96-.42zM27.94 36.1l-.59 .2-.42 .24-.5 .45-.73 .13-.82-.17-.86 .03-.73-.02-.55-.31-.43-.43 .12-.75 .24-.37 .38 .06 .67-.01 .84-.04 .99 .01 .75 0 .72-.07 .68 .04 .65-.2 .84-.04 1.07 .2 .79-.03 .53 .1 .45 .35 .43-.19 .77-.01 .94 .3 .52 .14-.08 .44-.51 .3-.8-.25-.66 .09-.64 .3-.73 .36-.63 .15-.68-.24-1.18-.52zM24.51 35.09l.99 0 .76 .02 .72-.06 .69 .04 .65-.19 .81-.06 1.08 .21 .8-.01 .31 .57-.18 1.14-.51 .36-.67-.25-1.19-.52-.87-.23-.58 .2-.41 .24-.52 .45-.73 .1-.84-.18-.85 .04-.72-.04-.55-.31-.84-.17-.73-.01-.62-.12-.87-.09-.74-.02-.06-.11 .31-.44 .55-.21 .65-.11 .64-.14 .62 .13 .62-.09 .43-.16 .38 .05 .68 0zM24.84 36.92l.84 .18 .73-.11 .51-.45 .41-.24 .59-.19 .88 .25 1.18 .51 .67 .24 .19 .25 .19 .42-.21 .14-.69 .01-.96-.43-.94-.09-.75 .06-.38 .26-.59 .05-.73-.01-.94 .14-.83-.1-.66-.1-.48-.09-.59 .03-.73 .02-.87-.08-.74 .03-.74 .06-.58-.3-.11-.87 .44-.32 .76 .04 .85 .09 .61 .11 .76 .01 .82 .19 .55 .31 .73 .02zM27.16 128.77l-.1-.8-.04-.75-.13-.67 .11-.94 .1-.83 .26-.54 .03-.56 .03-.61-.33-.33-1.11 .07-.91 .25-.32 .52-.19 .38-.31 .16-.21 .31-.24 .67-.5 1.1 .09 .66 .93-.11 .88 .03 .78 .22 .41-.17 .36-.15 .5-.08 .99-.16 .87 .24 .71 .32 .76 .08 .51-.09 .5-.11 .7 .22 .74-.02 .74-.06 .78-.11 .55 .04 .03 .65-.33 .52-.17 .64-.03 .75-.19 .66-.22 .57-.14 .64-.33 .61-.35 .56-.71 .53-.81 .66-.48 .29-.48 .26-.73 .16-.76 .12-.77 .09-.48 .28-.59-.3 .03-.85 .09-.68 .18-.72 .1-.77-.24-.65-.33-.62-.05-.71zM27.16 90.93l0-.76-.01-.8 .04-.56 .06-.71 .09-.72-.1-.85-.05-.47-.16-.42 .17-.3 .82-.07 .78-.12 .61 0 .59 .21 .78 .35 1.13 .56 .93 .47 .44 .26 0 .39 .35 .75 .43 .93 .38 .45 .5 .32 .4 .54 .15 .76 .05 .64-.24 .35-.41 .26-.64-.09-.56 .14-.61 .32-.88 .05-.84-.05-.76-.06-.73 .15-.72-.08-.7-.26-.79-.25-.49 .24-.22 .6-.55 .05-.63 .06-.52 .19-.7-.09-.65 .07-.03 .72 .32 .56 .26 .45 .12 .38 .24 .44 .58 .31 .56 .34 .65 .12 .54-.32 .17-.25 .24-.51 .05-.81-.23-.98-.15-.92-.07-.68 .03-.44zM24.92 91.1l.12 .7 .25 .89 .15 .79 .02 .52-.35 .29-.19 .48-.14 .83-.26 1.08 .17 .42 .85-.45 .72-.25 .63-.3 .74 .01 .62-.35 .28-.77-.11-.94-.03-1.01-.27-.63-.73-.15-.3 .52-.32 .4-.69-.07-.49 .23-.63 .03-.71-.08-1.1-.36-1.15-.33-.94-.16-.45 .27-.54 .13-.68 .02-.52 .23-.59 .05-.62 0-.5-.4-.35-.69-.24-.71 .02-.72 .54-.55 .56-.6 .18-.69 .27-.72 .26-.84 .49-.64 .56-.33 .82-.39 .58-.31 .8-.35 .66-.04 .61-.23 .53-.52 .66 .18 .36 .44-.02 .79 .27 .68 .07 .66 .19 .66 .19 .72-.14 .75-.12 .83zM24.73 128.99l-.15 .83-.06 .63 .13 .6 .24 .78 .13 .62 .07 .54-.27 .77 .15 .55-.24 .42-.85 .19-.57-.19-.81-.06-.86 .07-.78-.38-.82-.47-.59-.52-.52-.55-.3-.2-.3-.52-.23-.61-.07-.53-.16-.54-.3-.7-.35-.79-.27-.81-.07-.74 .34-.56 .66-.14 .63-.19 .59 .05 .63 .13 .5 .31 .58 .16 .8-.01 1.04-.1 .5-.14 .74-.08 .97-.1 .8 .24 .62-.02 .29-.21 .46-.09 .75-.13 .84-.26-.15-.69-.28-.71-.14-.57-.19-.45-.7-.37-.94-.36-.8-.22-.54-.03-.43 .35 .2 .63 .23 .19 .29 .66 .03 .88-.19 .68-.26 .99-.08 .78zM24.17 29.09l-.48 .07-.67-.01-.46 .09-.52 .19-.79 .07-1.09 .1-1.13 .06-.33 .06-.22-.09-.49-.24-.13-.36 .01-.84 .32-.74 .48-.55 .29-.7 .33-.76 .47-.61 .37-.53 .21-.77-.18-.45 .04-.58 .33-.78 .54-.7 .44-.71 .29-.68 .24-.72 .18-.91 .67-.05 .85 .32 .65 .21 .57 .44 .61 .52 .55 .62 .29 .64 .29 .56 .36 .47 .48 .3 .42 .54 .4 .76 .47 .71 .49 .65 .22 .53 .19 .52 .2 .79 .6 1.01 .41 .93-.5 .13-.84-.34-.84-.28-.86-.01-.86 .28-.85 .21-.72 .1-.8 .37z" style="fill:var(--club-stroke)" mask="url(#stroke2_23_528)"/></g></g><defs><filter id="filter0_d_23_528" x="-12" y="-12" width="66" height="166" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/><feOffset dx="3" dy="3"/><feComposite in2="hardAlpha" operator="out"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_23_528"/><feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_23_528" result="shape"/></filter><path id="stroke0_23_528" d="M27.82 21.63l-.01-.83 .16-.96 .01-.71-.04-.62-.21-.42-.52-.47-.42-.62-.19-.84 .02-.84-.04-.71-.3-.56-.5-.53-.44-.54-.27-.55-.38-.31-.63-.21-.62-.44-.55-.79-.52-.74-.51-.5-.67-.3-.33-.19-.34-.29-.42-.37-.53-.21-.68-.77-.63-.59-.71-.49-.5-.3-.95-.17-.95-.06-.6-.2-.86 .26-.91 .35-.44 .05-.66 .26-.66 .3-.48 .32-.71 .41-.88 .63-.59 .48-.33 .33-.47 .44-.39 .42-.46 .22-.57 .59-.02 .84 .26 1.26 .26 .65-.22 .49-.58 .64 .16 .5 .34 .53 .2 .46 .4 .56 .69 .59 .61 .56 .34 .33 .62 .27 .69 .4 .49 .27 .43 .29 .73 .29 .69 .27 .87 .29 .86 .46 .78 .38 .69 .44 .5 .47 .32 .53 .7 .26 .86 .22 .6 .34 .64 .31 .83 .38 .52-.03 .47 .14 .78 .43 .68 .51 .41 .49 .57 .43 .63 .46 .1 .7-.29 .67 .23 .79 .2 .72 .17 .78 .25 .7 .09 .66-.24 .43 .16 .85 .11 .62 .1 .28-.25 .69-.06 .93 .08 .98 .33 1.04 .04 .57-.15 .35-.17 .32 0 .76 .08 .93-.27 1.33 .06 .63 .34 .29 .28 .52-.13 .66-.4 .75-.24 .65 .11 .8 .22 .74 .16 .46-.05 .62-.12 .75-.04 .94-.06 .69 .17 .63 .35 .75-.06 .78-.23 .64-.08 .32-.17 .68-.14 .71-.21 .69 .13 .88 .01 .78-.1 .75 .04 .48 .05 .79 .05 .99-.04 1.13-.01 .63 .05 .37 .23 .32-.08 .76-.19 .95-.14 .77 .04 .71 .19 .71 .23 .73-.12 .67-.29 .85-.07 1.02 .01 .66 .15 .58 .12 .77 0 .49-.32 .62-.45 .91 .06 .54 .33 .4 .23 .45 .25 .59 .07 .93 .06 1.02-.11 .91-.26 .5-.33 .28-.3 .63-.06 .83-.05 .92-.23 .63 .16 .64 .37 .6-.18 .34 .03 .8 .12 1.07 .05 1.27 0 .6 .02 .48 .02 .53 .27 .51 .88 .02 .84-.24 .62-.02 .31 .12 .45 .17 .63-.1 .2-.6 .28-.51 .07-.68-.03-.65-.17-.49-.32-.81-.06-.79 .27-.96 .44-.83 .11-.74-.03-.69 .12-.78-.04-.69-.36-.65-.46-.7-.11-.66 .37-.49 .33-.42 .34-.62 .08-.85-.18-.89 .07-.7-.09-.55-.39-.47-.06-.66 .05-.86-.13-.92 .07-1.1 .03-.69 .01-.38 .16-.38-.02-.64-.25-.67 .06-.92 .1-.72 .31-.58 .29-.71-.08-.71-.38-.78-.05-.76-.08-.77-.16-.96 .08-.83 .02-.8-.01-.53-.2-.35-.06-.58 .12-.8 .3-.8 .06-.75 .03-.57 .25-.56 .08-.68-.03-.78-.11-.77-.09-.61-.11-.72-.2-.82-.33-1.01 .02-.72 .26-.59 .24-.39 .02-.67-.04-.74-.06-.39 .1-.65 .31-.76 .01-.75 0-.81-.06-.94-.17-.67-.07-.82-.27-.97-.28-.73-.13-.74 .17-.67 .28-.68 .17-.64-.17-.69-.37-.81-.24-.82 .16-.5 .33-.24 .39-.26 .07-.87-.14-1.29 .07-.96-.14-.51-.43-.28-.22-.48 .01-.81 .03-.97 .11-.7-.01-.76-.06-.89z"/><path id="stroke1_23_528" d="M27.16 90.93l-.28-.05-.77-.06-.72 .12-.72 .26-.79 .34-.37 .49-.28 .29-.31 .38 .15 .91 .15 .64 .14 .53-.11 .67-.33 1.04-.33 1.11-.09 .55-.04 .54-.06 .55-.01 .76 .11 .53 .13 .49 .09 .67-.01 .74 .02 .69 .05 .57 .1 .57 .02 .55-.25 .67 .22 .75-.01 .73-.35 .67 .3 .96 .14 .93-.15 .59-.09 .63-.15 .54 .04 .69-.25 .59 .19 .99 .32 1.09-.21 .38 .05 .51 .09 .59 .24 .96 .02 .86-.02 .82-.24 .37 .16 .56 .2 .6 .12 .78-.3 1-.35 1.01-.26 .78 .27 .41 .24 .36 .03 .53-.03 .92-.14 1.07-.14 1.01 .37 .34 .48 .18 1.02 .26 .52 .26 .53 .16 .77-.36 .82-.22 .71-.2 .45-.16 .62-.49 .38-.71-.11-.82-.01-.81 0-.73 .09-.75-.11-.74 .03-.74 .01-.69-.06-.7 .08-.72 .1-.53-.1-.4 .06-.49 .22-.76 .29-.91 .14-.81-.15-.64-.24-.53-.38-.63-.06-.72 .09-.81 .12-.74 .05-.73 .03-.75 .08-.59 0-.64 .02-.68-.04-.91 .05-.61 .03-.33-.21-.46-.05-.78 .14-.89 .4-.71 .02-.72-.26-.72-.34-.54 .03-.78 .13-.92-.07-1.01 .11-.77 .03-.67-.13-.53 .03-.65 .16-.61 .14-.63 .19-.62-.18-.77-.45-.85-.16-.78 0-.72-.35-.63-.5-.18-.68-.34z"/></defs></svg>`;
function logoHtml() {
  const letter = (char, width, fill, stroke, tilt) =>
    `<span class="lg" style="width:${width / 10}rem"><span class="stk idle" data-t="${char}" style="--fill:${fill};--stroke:${stroke};transform:rotate(${tilt}deg);${shadowVars(tilt)}${idleStyle(`logo:${char}`)}">${char}</span></span>`;
  return `<a class="logo${logoReady ? "" : " pending"}" href="." data-nav="home" aria-label="Golf home">${letter("G", 62.797, "var(--p1b)", "var(--p1)", -4)}${letter("o", 45, "var(--p3b)", "var(--p3)", 0)}<span class="lg club"><span class="club-box idle" style="${idleStyle("logo:club")}">${LOGO_CLUB}</span></span>${letter("f", 42.571, "var(--fw3)", "var(--fw)", 8)}</a>`;
}

/** A Daily Puzzle margin (Golfbot's points minus yours) with its sign: +5, 0, -3. */
const puzzleMargin = (n) => (n > 0 ? `+${n}` : String(n));
