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

// Every sticker drifts on its own slightly different loop so nothing moves in unison.
function idleStyle() {
  const r = Math.random;
  return `--ix:${(0.07 + r() * 0.1).toFixed(3)}rem;--iy:${(0.1 + r() * 0.13).toFixed(3)}rem;--ir:${(1.4 + r() * 2.2).toFixed(2)}deg;--idle-d:${(3 + r() * 2.8).toFixed(2)}s;--idle-delay:-${(r() * 6).toFixed(2)}s`;
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
  const style = `width:${rem(w + pad * 2)}rem;height:${rem(h + pad * 2)}rem;margin:-${rem(pad)}rem -${rem(opts.tight ? pad : 1)}rem;${opts.idle !== false ? idleStyle() + ";" : ""}${opts.style || ""}`;
  return `<svg class="${classes.join(" ")}" viewBox="${(x - pad).toFixed(1)} ${(y - pad).toFixed(1)} ${(w + pad * 2).toFixed(1)} ${(h + pad * 2).toFixed(1)}" style="${style}" aria-hidden="true">${(data.l || [[0, data.d]]).map(([cut, d]) => (cut ? `<path class="cut" d="${d}"/>` : `<path d="${d}" stroke-width="${width}"/>`)).join("")}</svg>`;
}

/** A plain single-colour glyph (chevrons, close marks) in the current text colour. */
function glyph(name, size = 20) {
  return icon(name, size, { idle: false, flat: true, ink: true, sw: 0, tight: true });
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
  return chars
    .map(
      (char) =>
        `<span class="stk${opts.idle === false ? "" : " idle"}${opts.cls ? " " + opts.cls : ""}" style="${opts.idle === false ? "" : idleStyle()}">${e(char)}</span>`,
    )
    .join("");
}

// The wordmark is laid out on the exact Figma letter boxes (widths in design px,
// each overlapping the next by 10); the idle drift is applied on top of that.
function logoHtml() {
  const letter = (char, width, fill, stroke, tilt) =>
    `<span class="lg" style="width:${width / 10}rem"><span class="stk idle" style="--fill:${fill};--stroke:${stroke};transform:rotate(${tilt}deg);${shadowVars(tilt)}${idleStyle()}">${char}</span></span>`;
  return `<a class="logo" href="." data-nav="home" aria-label="Golf home">${letter("G", 62.797, "var(--p1b)", "var(--p1)", -4)}${letter("o", 45, "var(--p3b)", "var(--p3)", 0)}<span class="lg club"><span class="club-box idle" style="${idleStyle()}"><img src="static/assets/logo-club.svg" alt="l"></span></span>${letter("f", 42.571, "var(--fw3)", "var(--fw)", 8)}</a>`;
}
