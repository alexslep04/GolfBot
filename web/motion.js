"use strict";
// Card motion: one spring simulation drives every card's drag, tilt, lift and
// flip through CSS custom properties, so interrupted gestures blend naturally.

const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");

// property → [CSS variable, unit, rest value, stiffness, damping, settle epsilon]
const MOTION_SPEC = {
  x: ["--dx", "px", 0, 520, 34, 0.15],
  y: ["--dy", "px", 0, 520, 34, 0.15],
  lean: ["--lean", "deg", 0, 190, 13, 0.05],
  scale: ["--scale", "", 1, 420, 20, 0.002],
  lift: ["--lift", "", 0, 300, 30, 0.01],
  rx: ["--rx", "deg", 0, 260, 20, 0.05],
  ry: ["--ry", "deg", 0, 260, 20, 0.05],
  face: ["--face", "deg", null, 150, 13.5, 0.4],
};
const motions = new Map();
let motionFrame = 0,
  motionClock = 0;

class CardMotion {
  constructor(slot) {
    this.slot = slot;
    this.card = slot.querySelector(".card");
    this.values = {};
    this.onRest = null;
  }
  spring(key) {
    if (!this.values[key]) {
      const rest =
        MOTION_SPEC[key][2] ??
        (this.slot.classList.contains("is-face") ? 0 : 180);
      this.values[key] = { value: rest, target: rest, velocity: 0 };
    }
    return this.values[key];
  }
  /** Spring toward new targets. */
  to(targets) {
    for (const [key, target] of Object.entries(targets))
      this.spring(key).target = target;
    return this.wake();
  }
  /** Set values immediately (no animation toward them). */
  jump(values) {
    for (const [key, value] of Object.entries(values)) {
      const spring = this.spring(key);
      spring.value = value;
      spring.velocity = 0;
    }
    this.write();
    return this.wake();
  }
  /** Add an impulse — the "juice" pop when a card is grabbed, flipped or lands. */
  kick(impulses) {
    if (reducedMotion.matches) return this;
    for (const [key, velocity] of Object.entries(impulses))
      this.spring(key).velocity += velocity;
    return this.wake();
  }
  wake() {
    motions.set(this.slot, this);
    if (!motionFrame) {
      motionClock = performance.now();
      motionFrame = requestAnimationFrame(stepMotions);
    }
    return this;
  }
  step(dt) {
    let active = false;
    for (const [key, spring] of Object.entries(this.values)) {
      const [, , , stiffness, damping, epsilon] = MOTION_SPEC[key];
      if (reducedMotion.matches) {
        spring.value = spring.target;
        spring.velocity = 0;
      } else {
        const force =
          -stiffness * (spring.value - spring.target) -
          damping * spring.velocity;
        spring.velocity += force * dt;
        spring.value += spring.velocity * dt;
      }
      if (
        Math.abs(spring.value - spring.target) > epsilon ||
        Math.abs(spring.velocity) > epsilon * 8
      )
        active = true;
      else {
        spring.value = spring.target;
        spring.velocity = 0;
      }
    }
    return active;
  }
  write() {
    // Variables live on the slot so the card and its shadow move as one.
    const style = this.slot.style;
    for (const [key, spring] of Object.entries(this.values)) {
      const [name, unit] = MOTION_SPEC[key];
      style.setProperty(name, spring.value.toFixed(3) + unit);
    }
    // A faint white sheen slides across the card as it tilts or leans.
    const now = (key) => this.values[key]?.value || 0;
    const tilt = Math.abs(now("rx")) + Math.abs(now("ry")) + Math.abs(now("lean"));
    if (tilt > 0.05) {
      style.setProperty("--sheen", Math.min(0.32, tilt / 60).toFixed(3));
      style.setProperty(
        "--sheen-x",
        Math.max(-1, Math.min(1, (now("ry") + now("lean")) / 16)).toFixed(3),
      );
    } else {
      style.removeProperty("--sheen");
      style.removeProperty("--sheen-x");
    }
  }
  /** Drop finished springs so the stylesheet's resting values apply again. */
  settle() {
    for (const [key, spring] of Object.entries(this.values)) {
      const [name, , rest] = MOTION_SPEC[key];
      const resting =
        rest ?? (this.slot.classList.contains("is-face") ? 0 : 180);
      if (spring.target === resting) {
        this.slot.style.removeProperty(name);
        delete this.values[key];
      }
    }
    const done = this.onRest;
    this.onRest = null;
    if (done) done();
  }
  /** Forget everything immediately (used when a slot is re-rendered). */
  reset() {
    for (const key of Object.keys(this.values))
      this.slot.style.removeProperty(MOTION_SPEC[key][0]);
    this.slot.style.removeProperty("--sheen");
    this.slot.style.removeProperty("--sheen-x");
    this.values = {};
    this.onRest = null;
    motions.delete(this.slot);
  }
}

function stepMotions(now) {
  const elapsed = Math.min(0.05, (now - motionClock) / 1000);
  motionClock = now;
  const steps = Math.max(1, Math.round(elapsed / 0.004));
  for (const motion of [...motions.values()]) {
    if (!motion.slot.isConnected) {
      motions.delete(motion.slot);
      continue;
    }
    let active = false;
    for (let i = 0; i < steps; i++) active = motion.step(elapsed / steps);
    motion.write();
    if (!active) {
      motions.delete(motion.slot);
      motion.settle();
    }
  }
  motionFrame = motions.size ? requestAnimationFrame(stepMotions) : 0;
}

const slotMotions = new WeakMap();
function motionFor(slot) {
  let motion = slotMotions.get(slot);
  if (!motion || motion.card !== slot.querySelector(".card")) {
    motion = new CardMotion(slot);
    slotMotions.set(slot, motion);
  }
  return motion;
}

/** Where a card currently is on screen: centre, rotation and scale. */
function poseOf(slot) {
  const card = slot.querySelector(".card");
  const rect = card.getBoundingClientRect();
  const style = getComputedStyle(card);
  const number = (name) => parseFloat(style.getPropertyValue(name)) || 0;
  return {
    x: rect.left + rect.width / 2,
    y: rect.top + rect.height / 2,
    angle: number("--rot") + number("--lean"),
    scale: parseFloat(style.getPropertyValue("--scale")) || 1,
  };
}

/** Balatro-style flip: the card pops off the table, spins over, and settles. */
function flipSlot(slot, faceUp, delay = 0) {
  const motion = motionFor(slot);
  const from = faceUp ? 180 : 0;
  motion.jump({ face: from });
  slot.classList.toggle("is-face", faceUp);
  const run = () => {
    if (!slot.isConnected) return;
    motion.to({ face: faceUp ? 0 : 180, lift: 1, scale: 1.1 });
    motion.kick({ scale: 2.2, lean: (Math.random() - 0.5) * 120 });
    setTimeout(() => motion.to({ lift: 0, scale: 1 }), 230);
  };
  if (delay) setTimeout(run, delay);
  else run();
}

/** A little squash-and-settle, for cards that land or change in place. */
function popSlot(slot, strength = 1) {
  motionFor(slot).kick({
    scale: 2.6 * strength,
    lean: (Math.random() - 0.5) * 90 * strength,
  });
}

/**
 * Fly a card from a pose to a slot. The destination's real card stays hidden
 * until the flyer lands, so the table always ends up showing the true state.
 */
function flyCard({ html, from, to, faceFrom, faceTo, delay = 0, onLand }) {
  const card = to.querySelector(".card");
  const rect = to.getBoundingClientRect();
  const target = poseOf(to);
  const width = to.offsetWidth,
    height = to.offsetHeight;
  to.classList.add("incoming");
  const land = () => {
    to.classList.remove("incoming");
    if (onLand) onLand();
  };
  if (reducedMotion.matches || !rect.width) {
    land();
    return null;
  }
  const flyer = document.createElement("div");
  flyer.className = "flyer";
  flyer.style.cssText = `left:${target.x - width / 2}px;top:${target.y - height / 2}px;width:${width}px;height:${height}px`;
  flyer.innerHTML = `<span class="shadow"></span><div class="card"><div class="card-flip">${html}</div></div>`;
  document.body.appendChild(flyer);
  const dx = from.x - target.x,
    dy = from.y - target.y;
  const distance = Math.hypot(dx, dy);
  const duration = Math.min(560, 300 + distance * 0.55);
  const start = `translate(${dx}px, ${dy}px) rotate(${from.angle}deg) scale(${from.scale || 1})`;
  const middle = `translate(${dx * 0.42}px, ${dy * 0.42 - Math.min(26, distance * 0.08)}px) rotate(${(from.angle + target.angle) / 2 + (dx > 0 ? -5 : 5)}deg) scale(1.14)`;
  const end = `translate(0px, 0px) rotate(${target.angle}deg) scale(1)`;
  const timing = {
    duration,
    delay,
    easing: "cubic-bezier(0.3, 0.7, 0.25, 1)",
    fill: "both",
  };
  flyer.animate(
    [
      { transform: start },
      { transform: middle, offset: 0.45 },
      { transform: end },
    ],
    timing,
  );
  const flip = flyer.querySelector(".card-flip");
  const a = faceFrom ? 0 : 180,
    b = faceTo ? 0 : 180;
  const spin = flip.animate(
    [{ transform: `rotateY(${a}deg)` }, { transform: `rotateY(${b}deg)` }],
    { ...timing, easing: "cubic-bezier(0.45, 0, 0.3, 1)" },
  );
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    flyer.remove();
    land();
    if (card.isConnected) popSlot(to, 0.8);
  };
  spin.finished.then(finish, finish);
  flyer.cancelFlight = finish;
  return flyer;
}

function cancelFlights() {
  document
    .querySelectorAll(".flyer")
    .forEach((flyer) => flyer.cancelFlight && flyer.cancelFlight());
}
