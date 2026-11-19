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
/**
 * The first real page is on screen: show the backdrop. Until then the document
 * paints nothing a browser counts as content, so on a reload it keeps showing
 * the previous page and switches straight to the new one, with no blank frame.
 */
function booted() {
  document.documentElement.classList.remove("booting");
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
  autoQueue: true, // join the Quickplay queue as soon as the site opens
  turnAlerts: false, // a notification (and a buzz) when it's your turn while Golf is in the background
  theme: "golf", // the look of the whole game: see THEMES
};
// Each theme is a set of colour tokens in style.css, under :root[data-theme].
// "golf" is the original sticker look and needs no attribute.
const THEMES = [
  ["golf", "Original", "#c4efab"],
  ["poker", "Poker", "#0d3525"],
  ["night", "Night Golf", "#0f2018"],
];
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem("golf-prefs") || "{}"));
} catch {}
function applyPrefs() {
  const html = document.documentElement.classList;
  html.toggle("no-haptics", !prefs.haptics);
  html.toggle("no-tips", prefs.hideTips);
  const theme = THEMES.find(([key]) => key === prefs.theme) || THEMES[0];
  if (theme === THEMES[0]) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme[0];
  // the browser's own chrome (status bar, overscroll) takes the table's colour
  document.querySelector("meta[name='theme-color']")?.setAttribute("content", theme[2]);
}
function setPref(key, value) {
  prefs[key] = value;
  try {
    localStorage.setItem("golf-prefs", JSON.stringify(prefs));
  } catch {}
  applyPrefs();
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
document.addEventListener("pointerdown", () => document.documentElement.classList.remove("keyboard"), true);

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
  win: [14, 50, 14, 50, 30],
  lose: [40],
  tie: [16, 90, 16],
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
// It appears as one piece: hidden until the display font is in (the club is
// drawn inline, so it is ready as soon as the page is).
let logoReady = false;
(() => {
  const font = document.fonts?.load
    ? document.fonts.load('700 64px "FOT-Seurat Pro"', "Gof")
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
// inline so its colours follow the theme: --club-fill and --club-stroke.
const LOGO_CLUB = `<svg class="club-art" aria-hidden="true" viewBox="0 0 39 138" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><g filter="url(#filter0_d_23_528)"><g transform="rotate(180 17.7 67.4)"><use xlink:href="#stroke0_23_528" style="fill:var(--club-fill)"/><use xlink:href="#stroke1_23_528" style="fill:var(--club-fill)"/><mask id="stroke2_23_528" maskUnits="userSpaceOnUse" x="-42.4819" y="-5.69227" width="123.484" height="144.356" fill="black"><rect fill="white" x="-42.4819" y="-5.69227" width="123.484" height="144.356"/><use xlink:href="#stroke0_23_528"/><use xlink:href="#stroke1_23_528"/></mask><path d="M28.3508 37.8123L28.3498 40.8123L24.8295 40.811L24.8306 37.811L24.8317 34.811L28.3519 34.8123L28.3508 37.8123ZM28.3403 35.3123L28.3392 38.3123L24.8308 38.311L24.8319 35.311L24.8329 32.311L28.3414 32.3123L28.3403 35.3123ZM28.1867 21.7952L34.1802 21.5163L34.1802 21.5163L28.1867 21.7952ZM16.9509 6.42459L19.0116 0.789573L16.9509 6.42459ZM6.14623 14.7618L11.95 13.2397L11.95 13.2397L6.14623 14.7618ZM24.3918 28.9841L30.328 28.1114L30.328 28.1114L24.3918 28.9841ZM24.8319 35.311L30.8319 35.3132L30.8319 35.3141L24.8319 35.311ZM23.8124 88.795L23.8102 94.795L17.679 94.7928L17.8138 88.663L23.8124 88.795ZM28.3888 88.7966L34.3888 88.8049L34.3805 94.7987L28.3866 94.7966L28.3888 88.7966ZM20.0042 23.799L17.6921 29.3356V29.3356L20.0042 23.799ZM24.8122 90.8114L24.8143 84.8114L24.8143 84.8114L24.8122 90.8114ZM27.3886 90.8123L27.3865 96.8123L27.3865 96.8123L27.3886 90.8123ZM24.7982 128.811L24.8004 122.811L24.8004 122.811L24.7982 128.811ZM27.3747 128.812L27.3725 134.812L27.3725 134.812L27.3747 128.812ZM29.3879 92.8131L35.3879 92.8153L35.3879 92.8153L29.3879 92.8131ZM29.3754 126.813L35.3754 126.815L35.3754 126.815L29.3754 126.813ZM22.799 126.81L16.799 126.808L16.799 126.808L22.799 126.81ZM22.8115 92.8107L16.8115 92.8085L16.8115 92.8085L22.8115 92.8107ZM28.3403 35.3123L34.3403 35.2838L34.3403 35.2871L28.3403 35.3123ZM28.3508 37.8123L34.3508 37.7871L34.3508 37.7885L28.3508 37.8123ZM24.8306 37.811L30.8306 37.8141L30.8306 37.8545L30.83 37.895L24.8306 37.811ZM24.8312 36.561L30.8312 36.5641L30.8312 36.5641L24.8312 36.561ZM28.1867 21.7952L22.1932 22.074C22.1197 20.4942 21.3206 18.2813 19.7424 16.1311C18.1608 13.9762 16.3062 12.5775 14.8902 12.0596L16.9509 6.42459L19.0116 0.789573C23.243 2.33701 26.8635 5.55243 29.4165 9.03087C31.9729 12.514 33.9679 16.9538 34.1802 21.5163L28.1867 21.7952ZM16.9509 6.42459L14.8902 12.0596C14.6779 11.982 13.9066 11.9037 12.8664 12.7791C12.4007 13.171 12.1331 13.5703 12.0268 13.8055C11.9132 14.0569 12.1018 13.8188 11.95 13.2397L6.14623 14.7618L0.342516 16.284C-1.06998 10.8983 2.15366 6.11059 5.13982 3.59761C8.37511 0.874971 13.5763 -1.19811 19.0116 0.789573L16.9509 6.42459ZM24.3918 28.9841L30.328 28.1114C30.6076 30.0136 30.8329 32.4388 30.8319 35.3132L24.8319 35.311L18.8319 35.3089C18.8327 33.064 18.6567 31.2248 18.4556 29.8568L24.3918 28.9841ZM23.8124 88.795L23.8145 82.795L28.391 82.7966L28.3888 88.7966L28.3866 94.7966L23.8102 94.795L23.8124 88.795ZM20.0042 23.799L17.6921 29.3356C15.1751 28.2845 11.6329 26.6981 8.53777 24.889C7.00094 23.9907 5.39133 22.9326 4.03211 21.7453C2.84849 20.7114 1.02365 18.8811 0.342517 16.284L6.14623 14.7618L11.95 13.2397C11.6847 12.2282 11.1928 12.0668 11.9265 12.7077C12.4846 13.1952 13.3767 13.8178 14.5932 14.5289C17.0048 15.9384 19.9757 17.285 22.3162 18.2623L20.0042 23.799ZM24.8122 90.8114L24.8143 84.8114L27.3908 84.8123L27.3886 90.8123L27.3865 96.8123L24.81 96.8114L24.8122 90.8114ZM24.7982 128.811L24.8004 122.811L27.3768 122.812L27.3747 128.812L27.3725 134.812L24.7961 134.811L24.7982 128.811ZM29.3879 92.8131L35.3879 92.8153L35.3754 126.815L29.3754 126.813L23.3754 126.81L23.3879 92.8109L29.3879 92.8131ZM22.799 126.81L16.799 126.808L16.8115 92.8085L22.8115 92.8107L28.8115 92.8129L28.799 126.812L22.799 126.81ZM28.3403 35.3123L22.3404 35.3408C22.3077 28.4516 22.2583 23.4729 22.1932 22.074L28.1867 21.7952L34.1802 21.5163C34.2602 23.2346 34.3083 28.5479 34.3403 35.2838L28.3403 35.3123ZM28.3888 88.7966C22.3888 88.7883 22.3888 88.7882 22.3888 88.7879C22.3888 88.7877 22.3888 88.7874 22.3888 88.7869C22.3888 88.786 22.3888 88.7846 22.3888 88.7828C22.3888 88.779 22.3888 88.7735 22.3888 88.7661C22.3889 88.7513 22.3889 88.7292 22.3889 88.6999C22.389 88.6413 22.3891 88.5539 22.3893 88.439C22.3896 88.2094 22.39 87.8697 22.3905 87.4303C22.3915 86.5513 22.3928 85.2728 22.3942 83.6752C22.3969 80.48 22.3997 76.0087 22.4 70.9043C22.4006 60.6933 22.3911 47.9571 22.3509 37.8362L28.3508 37.8123L34.3508 37.7885C34.3911 47.9346 34.4006 60.6905 34.4 70.9049C34.3997 76.0132 34.3969 80.4879 34.3942 83.6855C34.3928 85.2843 34.3915 86.564 34.3905 87.444C34.39 87.884 34.3895 88.2241 34.3893 88.4543C34.3891 88.5694 34.389 88.657 34.3889 88.7158C34.3889 88.7453 34.3888 88.7675 34.3888 88.7824C34.3888 88.7899 34.3888 88.7955 34.3888 88.7992C34.3888 88.8011 34.3888 88.8025 34.3888 88.8035C34.3888 88.8039 34.3888 88.8043 34.3888 88.8045C34.3888 88.8048 34.3888 88.8049 28.3888 88.7966ZM24.8306 37.811L30.83 37.895C30.7396 44.3559 30.4846 57.1239 30.2526 68.2552C30.1366 73.8255 30.0262 78.9932 29.9448 82.7683C29.9041 84.6558 29.8706 86.1953 29.8473 87.263C29.8357 87.7968 29.8266 88.2127 29.8204 88.4952C29.8173 88.6364 29.8149 88.7443 29.8134 88.8169C29.8126 88.8532 29.812 88.8807 29.8115 88.8991C29.8113 88.9083 29.8112 88.9152 29.8111 88.9199C29.811 88.9222 29.811 88.9239 29.811 88.9251C29.811 88.9257 29.811 88.9261 29.8109 88.9264C29.8109 88.9267 29.8109 88.9269 23.8124 88.795C17.8138 88.663 17.8138 88.6629 17.8138 88.6626C17.8138 88.6623 17.8139 88.6619 17.8139 88.6613C17.8139 88.6602 17.8139 88.6585 17.814 88.6562C17.8141 88.6516 17.8142 88.6447 17.8144 88.6355C17.8148 88.6172 17.8154 88.5898 17.8162 88.5536C17.8178 88.4812 17.8202 88.3735 17.8233 88.2324C17.8295 87.9503 17.8385 87.5348 17.8502 87.0014C17.8734 85.9346 17.9069 84.3961 17.9475 82.5096C18.0289 78.7365 18.1393 73.5718 18.2552 68.0052C18.4874 56.8628 18.7415 44.1388 18.8312 37.7271L24.8306 37.811ZM28.3508 37.8123L22.3509 37.8375L22.3456 36.5875L28.3456 36.5623L34.3455 36.5371L34.3508 37.7871L28.3508 37.8123ZM28.3456 36.5623L22.3456 36.5875L22.3404 35.3375L28.3403 35.3123L34.3403 35.2871L34.3455 36.5371L28.3456 36.5623ZM24.8319 35.311L30.8319 35.3141L30.8312 36.5641L24.8312 36.561L18.8312 36.558L18.8319 35.308L24.8319 35.311ZM24.8312 36.561L30.8312 36.5641L30.8306 37.8141L24.8306 37.811L18.8306 37.808L18.8312 36.558L24.8312 36.561ZM27.3747 128.812L27.3768 122.812C25.1677 122.811 23.3762 124.601 23.3754 126.81L29.3754 126.813L35.3754 126.815C35.3737 131.233 31.7907 134.813 27.3725 134.812L27.3747 128.812ZM27.3886 90.8123L27.3908 84.8123C31.8091 84.8139 35.3895 88.397 35.3879 92.8153L29.3879 92.8131L23.3879 92.8109C23.3871 95.02 25.1773 96.8115 27.3865 96.8123L27.3886 90.8123ZM24.8122 90.8114L24.8101 96.8114C27.0191 96.8122 28.8107 95.022 28.8115 92.8129L22.8115 92.8107L16.8115 92.8085C16.8131 88.3902 20.3961 84.8098 24.8143 84.8114L24.8122 90.8114ZM24.7982 128.811L24.7961 134.811C20.3778 134.809 16.7973 131.226 16.799 126.808L22.799 126.81L28.799 126.812C28.7998 124.603 27.0095 122.812 24.8004 122.811L24.7982 128.811ZM24.3918 28.9841L18.4556 29.8568C18.463 29.9074 18.4861 29.8961 18.4025 29.8011C18.3005 29.685 18.0746 29.4953 17.6921 29.3356L20.0042 23.799L22.3162 18.2623C25.9672 19.7869 29.5905 23.0955 30.328 28.1114L24.3918 28.9841Z" style="fill:var(--club-stroke)" mask="url(#stroke2_23_528)"/></g></g><defs><filter id="filter0_d_23_528" x="0" y="0" width="38.3879" height="137.812" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"><feFlood flood-opacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/><feOffset dx="3" dy="3"/><feComposite in2="hardAlpha" operator="out"/><feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0"/><feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_23_528"/><feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_23_528" result="shape"/></filter><path id="stroke0_23_528" d="M28.1867 21.7952C27.9009 15.6528 22.5984 8.48988 16.9509 6.42459C11.3033 4.3593 5.00597 10.4141 6.14623 14.7618C6.97792 17.933 15.1466 21.7705 20.0042 23.799C22.2537 24.7383 24.0372 26.5722 24.3918 28.9841C24.6322 30.6192 24.8328 32.7514 24.8319 35.311L24.8312 36.561L24.8306 37.811C24.6505 50.6836 23.8124 88.795 23.8124 88.795L28.3888 88.7966C28.3888 88.7966 28.4314 58.0794 28.3508 37.8123L28.3456 36.5623L28.3403 35.3123C28.308 28.4998 28.2593 23.3537 28.1867 21.7952Z"/><path id="stroke1_23_528" d="M27.3886 90.8123L24.8122 90.8114C23.7076 90.811 22.8119 91.7061 22.8115 92.8107L22.799 126.81C22.7985 127.915 23.6937 128.811 24.7982 128.811L27.3747 128.812C28.4792 128.812 29.375 127.917 29.3754 126.813L29.3879 92.8131C29.3883 91.7085 28.4932 90.8127 27.3886 90.8123Z"/></defs></svg>`;
function logoHtml() {
  const letter = (char, width, fill, stroke, tilt) =>
    `<span class="lg" style="width:${width / 10}rem"><span class="stk idle" style="--fill:${fill};--stroke:${stroke};transform:rotate(${tilt}deg);${shadowVars(tilt)}${idleStyle(`logo:${char}`)}">${char}</span></span>`;
  return `<a class="logo${logoReady ? "" : " pending"}" href="." data-nav="home" aria-label="Golf home">${letter("G", 62.797, "var(--p1b)", "var(--p1)", -4)}${letter("o", 45, "var(--p3b)", "var(--p3)", 0)}<span class="lg club"><span class="club-box idle" style="${idleStyle("logo:club")}">${LOGO_CLUB}</span></span>${letter("f", 42.571, "var(--fw3)", "var(--fw)", 8)}</a>`;
}
