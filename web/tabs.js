"use strict";
/* ---------- the home screen: five tabs along the bottom ----------
   Flags (achievements), You (your look, emotes and records), Play (the Daily
   Puzzle, friends, recent matches and Start a Game), Watch (games to spectate)
   and Aces (records and leaderboards). It is one page: the top bar and the tab
   bar stay put while the tab between them slides across, the way you went. */
const HOME_TABS = [
  { key: "flags", label: "Flags", symbol: "flag.2.crossed.fill", color: "c-p4", path: "/flags", title: "Flags" },
  { key: "you", label: "You", symbol: "person.crop.circle", color: "c-p1", path: "/you", title: "You" },
  { key: "play", label: "Play", symbol: "figure.golf", color: "c-p3", path: "/", title: "Golf" },
  { key: "watch", label: "Watch", symbol: "binoculars.fill", color: "c-s4", path: "/watch", title: "Watch" },
  { key: "aces", label: "Aces", symbol: "medal", color: "c-p2", path: "/aces", title: "Aces" },
];
const ACES_VIEWS = [
  { key: "records", label: "Records", symbol: "crown.fill" },
  { key: "solo", label: "Solo", symbol: "dumbbell.fill" },
  { key: "pvp", label: "PvP", symbol: "figure.2" },
];
// the tab bar's icons fan out from the middle one
/** A tab icon's tilt: upright on the tab you are on, leaning out more the further away (left back, right forward). */
const tabTilt = (i, at) => (i - at) * 6;
let homeTab = "play",
  acesView = "records",
  startOpen = false; // Play's Start a Game list is open
const tabIndex = (key) => HOME_TABS.findIndex((tab) => tab.key === key);
/* The pages that lie side by side, tapped and swiped between, with the bar at the foot of
   the screen: the home screen's tabs, or Match history's lists. Both are the very same
   pages, pager and bar (all below); `deck` says which set is up, and is the name of the
   page it is on ("home" or "history"). */
let deck = "home";
const onDeck = () => page === deck;
const deckTab = () => (deck === "history" ? historyTab : homeTab);
const tabPath = (tab) => (tab === "aces" && acesView !== "records" ? `/aces/${acesView}` : HOME_TABS[tabIndex(tab)].path);
/** What each tab last loaded, so going back to one shows it at once (and only redraws what changed). */
const homeData = { puzzle: null, friends: null, matches: null, matchesNext: null, games: null, cups: null, boards: null, myStats: null };

/** A tab's big title: blue sticker letters, with a line under it. */
function tabTitle(text, sub = "", key = text, cls = "") {
  // (a long title, like a table's own name, is set smaller so its arch still fits the screen)
  const size = text.length > 15 ? ` style="font-size:${Math.max(1.8, 34 / (text.length * 0.6)).toFixed(2)}rem"` : "";
  return `<header class="tab-head"><h1 class="tab-title${cls ? ` ${cls}` : ""}"${size} aria-label="${e(text)}">${arcText(text, `tab-title:${key}`)}</h1>${sub ? `<p class="tab-sub">${sub}</p>` : ""}</header>`;
}
/** A title with something to press beside it (Refresh, Leave): the title stays centered, the action sits to its right. */
function titleWith(title, action) {
  return action ? `<div class="head-row">${title}<div class="head-action">${action}</div></div>` : title;
}
/** A section's heading within a page: the same arched sticker letters, a size down. */
function sectionTitle(text, sub = "", key = text, cls = "") {
  return `<h2 class="tab-title section${cls ? ` ${cls}` : ""}" aria-label="${e(text)}">${arcText(text, `section:${key}`)}</h2>`;
}
/** A box with its name written on its top edge (like a field's label). */
function boxed(color, label, body, extra = "", attrs = "") {
  return `<section class="boxed ${color} ${extra}"${attrs}><span class="box-label">${label}</span>${body}</section>`;
}
/**
 * The rules a game was played with, as an icon: a house for House rules, the
 * Vanilla seal with no rules on, and a wrench for any other mix.
 */
function rulesIcon(match) {
  if (match.house_rules) return ["house.fill", "House rules"];
  return Object.values(match.rules || {}).some(Boolean) ? ["wrench.adjustable.fill", "Custom rules"] : ["checkmark.seal.text.page.fill", "Vanilla"];
}
/** "just now", "5m ago", "3h ago", "2d ago" */
function agoShort(at) {
  if (!at) return "";
  const s = Math.max(0, Date.now() / 1000 - at);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* ---------- the page and its tab bar ---------- */
/**
 * Open the home screen on `tab`. Already on it, a different tab slides in from
 * the side it sits on; the bar and the top stay where they are.
 */
function homePage(tab = homeTab) {
  if (tabIndex(tab) < 0) tab = "play";
  const shell = page === "home" && deck === "home" && root.querySelector("[data-home]");
  const from = shell ? homeTab : null;
  deck = "home";
  homeTab = tab;
  // (coming back from a game or another page, Start a Game is closed again)
  if (tab !== "play" || !shell) startOpen = false;
  document.title = HOME_TABS[tabIndex(tab)].title === "Golf" ? "Golf" : `${HOME_TABS[tabIndex(tab)].title} · Golf`;
  history.replaceState({}, "", appPath(tabPath(tab)));
  if (!shell) {
    show(
      "home",
      `<div class="page home tabbed" data-home data-tab="${tab}">${topbar()}<div class="tab-stage" data-tab-stage><section class="tab-pane entering" data-pane="${tab}" data-key="${pageKey({ tab, view: acesView })}">${paneHtml(tab)}</section></div><div class="start-scrim" data-start-close hidden></div><div class="home-dock" data-home-dock>${dockHtml(tab)}</div></div>`,
    );
    afterPane(tab);
    placeTabArrows();
    renderQueueBanner();
    pollPresence();
    patchPopup();
    prefetchTabs();
    loadTab(tab);
    warmPanes();
    return;
  }
  if (from !== tab) {
    // The bar goes first, on its own: it is laid out and set flowing before the
    // new page is so much as built, and the page follows once that is on screen.
    updateDock(tab);
    shell.dataset.tab = tab;
    queueSlide();
  }
  loadTab(tab, true);
}
/* ---------- keeping the bar's frames free ----------
   Building a page, or drawing fresh data into one, is the heavy work here. None of
   it shares a frame with the bar setting off, and data that lands while the bar or
   the pages are still moving waits until they are at rest. */
let homeBusyUntil = 0;
const homeBusyFor = (ms) => (homeBusyUntil = Math.max(homeBusyUntil, performance.now() + ms));
// (a finger on the glass, and the page still coasting after it, count as busy too)
let touchDownAt = 0,
  lastScrollAt = -1e9;
const fingerDown = () => touchDownAt > 0 && performance.now() - touchDownAt < 15000;
const homeBusy = () => performance.now() < homeBusyUntil || !!pager.cur || !!slideQueued || revealing > 0 || fingerDown() || performance.now() - lastScrollAt < 140;
const quietWork = new Map(); // what is waiting, in the order asked: {key: work}
let quietTimer = 0,
  quietCalm = 0;
/** Run `work` once the home screen is at rest (now, if it is). A later call with the same key replaces an earlier one. */
function whenHomeQuiet(key, work) {
  if (!homeBusy() && !quietWork.size) return void work();
  quietWork.set(key, work);
  if (!quietTimer) quietTimer = setTimeout(runQuietWork, 60);
}
/* What was put off is done a piece at a time, a couple of frames apart, never all in one go
   (together it made one long stall just as the next swipe was starting), and only once things
   have been still for a moment; anything moving again puts the rest off once more. */
function runQuietWork() {
  quietTimer = 0;
  if (!quietWork.size) return void (quietCalm = 0);
  if (onDeck()) {
    if (homeBusy()) {
      quietCalm = 0;
      return void (quietTimer = setTimeout(runQuietWork, 60));
    }
    if (++quietCalm < 2) return void (quietTimer = setTimeout(runQuietWork, 50));
  }
  const [key, work] = quietWork.entries().next().value;
  quietWork.delete(key);
  work();
  if (quietWork.size) quietTimer = setTimeout(runQuietWork, onDeck() ? 34 : 0);
  else quietCalm = 0;
}
/* ---------- a phone saving its battery ----------
   An iPhone in Low Power Mode (and some others when saving power) draws only about 30
   frames a second, and gives the page less time to work in each. Every sticker's drift
   is worked out by the page each frame, and many cards popping in at once with a page
   fading in is more than fits in a frame then: the animations stutter. So the frame rate
   is measured now and then, while nothing is happening, and while it is low the home
   screen keeps to its main motions (pages fading in, the tab bar) and sets the rest aside:
   the drift, and the cards' pop-ins. */
function measureFrameRate() {
  if (typeof requestAnimationFrame !== "function" || document.visibilityState !== "visible") return;
  if (homeBusy()) return void setTimeout(measureFrameRate, 1000);
  const gaps = [];
  let last = 0;
  const step = (now) => {
    if (last) gaps.push(now - last);
    last = now;
    if (gaps.length < 24) return void requestAnimationFrame(step);
    // (the middle gap, so a frame held up by something else does not count)
    gaps.sort((a, b) => a - b);
    // (a reading taken while the page was being scrolled or touched does not count)
    if (homeBusy() || performance.now() - lastScrollAt < 1500) return;
    const slow = gaps[gaps.length >> 1] > 24;
    // and it changes only when two readings in a row agree, so it never flips back and forth
    // (each flip stops or starts every sticker's drift, which Safari shows as a flicker)
    if (slow !== measureFrameRate.last) return void (measureFrameRate.last = slow);
    document.documentElement.classList.toggle("low-fps", slow);
  };
  requestAnimationFrame(step);
}
setTimeout(measureFrameRate, 1500);
setTimeout(measureFrameRate, 3000);
setInterval(measureFrameRate, 20000);
document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && setTimeout(measureFrameRate, 600));

/* ---------- pages kept ready ----------
   Each page of the home screen is built once and kept: one not showing is parked
   in the stage, laid out but unseen, so bringing it in costs no building. A page
   taken from the park may be out of date; it is drawn again from what is known
   once everything has come to rest. */
// (one page a tab: Aces' views are changed inside its page, under the strip that stays)
const pageKey = (p) => p.tab;
const LIVE_PANE = ".tab-pane:not(.leaving):not(.neighbor):not(.parked):not(.staged)";
/** Put a page away: unseen and out of the layout's way, but kept. */
function parkPane(el) {
  if (!el?.isConnected) return;
  // (one of each page is kept)
  if ([...el.parentNode.children].some((other) => other !== el && other.dataset.key === el.dataset.key)) return void el.remove();
  el.getAnimations?.().forEach((animation) => animation.cancel());
  clearPane(el);
  el.className = "tab-pane parked";
  el.setAttribute("aria-hidden", "true");
}
/** The page `p` as an element in the stage: the parked one, or built now. `cls` is the state it starts in. */
function takePane(stage, p, cls = "") {
  const key = pageKey(p);
  let el = [...stage.children].find((pane) => pane.dataset.key === key && pane.matches(".parked, .staged:not(.neighbor)"));
  // (it was drawn while put by: what it shows may be behind by whatever has changed on this device since)
  if (el) {
    el.stale = true;
    el.getAnimations?.().forEach((animation) => animation.cancel());
    clearPane(el);
    // (an Aces page put by on another of its views is drawn again on the one showing)
    if (p.tab === "aces" && el.querySelector?.("[data-aces]")?.dataset.aces !== p.view) el.innerHTML = homePageHtml(p);
  } else {
    el = document.createElement("section");
    el.dataset.pane = p.tab;
    el.dataset.key = key;
    el.innerHTML = homePageHtml(p);
    stage.append(el);
  }
  // (it comes in flat, its stickers still, and only takes up their drift once all is at rest)
  el.className = `tab-pane flat${cls ? ` ${cls}` : ""}`;
  el.removeAttribute("aria-hidden");
  whenHomeQuiet("unflat", () => stage.querySelectorAll(".tab-pane.flat:not(.staged):not(.neighbor)").forEach((pane) => pane.classList.remove("flat")));
  if (!restaging) whenHomeQuiet("stage", restage);
  // the avatar wheel, already turned to your avatar
  const strip = el.querySelector(".avatar-strip");
  if (strip) {
    const index = [...strip.querySelectorAll(".avatar")].findIndex((item) => item.getAttribute("aria-checked") === "true");
    strip.scrollLeft = Math.max(0, index) * wheelPitch(strip);
    paintWheel(strip, strip.scrollLeft);
  }
  return el;
}
/* ---------- pages kept in waiting ----------
   The pages before and after the one showing, and every other tab's page, are kept
   drawn just off the screen's edges, so that a swipe or a press finds them there
   already: nothing is built, laid out or painted as the page starts to change. */
let restaging = false;
const stageWidth = (stage) => stage.getBoundingClientRect().width + 32;
/** Put a page in waiting on that side of the one showing (-1 before it, 1 after), at the top of the screen. */
function stagePane(el, direction) {
  const was = el.classList.contains("staged");
  el.getAnimations?.().forEach((animation) => animation.cancel());
  el.className = "tab-pane flat staged";
  el.dataset.side = direction;
  el.setAttribute("aria-hidden", "true");
  el.style.opacity = "";
  // (past the edge of the screen, not just of the page: on a wide window the page is a
  // column in the middle, and a page in waiting one column over would be in plain sight)
  el.style.translate = `${(direction * (Math.max(stageWidth(el.parentNode), window.innerWidth) + 32)).toFixed(1)}px ${window.scrollY}px`;
  if (!el.readyAt || !was) el.readyAt = performance.now(); // (when it was last put in waiting: it is drawn a frame or two after)
}
/**
 * See that the right pages are in waiting, and no others: the pages either side of
 * the one showing, for a swipe (or a tap on a neighboring tab).
 */
function restage() {
  if (!onDeck() || homeBusy()) return;
  const stage = root.querySelector("[data-tab-stage]");
  if (!stage?.getBoundingClientRect || !stage.querySelector(LIVE_PANE)) return;
  const pages = homePages(),
    at = homePageAt();
  // {key: which side of the page showing it lies on}
  const wanted = new Map();
  // (only the two either side: a page pressed further off is drawn when it is pressed,
  // and fades in once it is ready. Every page kept drawn costs the phone memory.)
  pages.forEach((p, i) => {
    if (Math.abs(i - at) === 1) wanted.set(pageKey(p), [Math.sign(i - at), p]);
  });
  restaging = true;
  try {
    for (const pane of stage.querySelectorAll(".tab-pane.staged")) if (!wanted.has(pane.dataset.key)) parkPane(pane);
    for (const [key, [direction, p]] of wanted) {
      const waiting = [...stage.children].find((pane) => pane.dataset.key === key && pane.classList.contains("staged"));
      stagePane(waiting || takePane(stage, p), direction);
    }
  } finally {
    restaging = false;
  }
}
const waitAtMost = (ms, promise) => Promise.race([promise, new Promise((done) => setTimeout(done, ms))]);
/** Whether what a tab shows has been fetched at least once. */
const tabLoaded = (tab) =>
  deck === "history" ? historyLoaded(tab) : ({ play: !!homeData.puzzle && !!homeData.matches, watch: !!homeData.games, aces: !!homeData.boards, you: !!homeData.boards })[tab] ?? true;
/** Fetch what a page shows (its tab's, or its list's). */
const deckLoad = (tab) => (deck === "history" ? loadHistoryList(tab) : loadTab(tab, true));
const framesFrom = (count) => new Promise((done) => {
  const step = () => (count-- > 0 ? requestAnimationFrame(step) : done());
  step();
});
let revealing = 0; // pages on their way in by revealPage (the home screen counts as busy meanwhile)
/**
 * A tab (or one of Aces' views) pressed. Its page fades in, in
 * place, the things on it animating in with it, and the page it replaces is
 * simply gone. It fades in from a soft blur only once it is ready: the old page
 * stays up until then. That means:
 *  - what it shows has been loaded (fetched now if it never has been);
 *  - its pictures are decoded;
 *  - the browser has had the page drawn, in waiting, for a couple of frames;
 *  - and the work of putting it in place (bringing it over the stage, turning the
 *    avatar wheel) is done in a frame of its own, before the fade's first frame.
 */
async function revealPage(stage, p) {
  const key = pageKey(p);
  // With motion reduced (or nothing to animate with) the page is simply swapped in.
  if (reducedMotion.matches || !stage.animate || typeof requestAnimationFrame !== "function") {
    const old = stage.querySelector(LIVE_PANE);
    const next = takePane(stage, p);
    next.classList.remove("flat");
    if (old && old !== next) parkPane(old);
    window.scrollTo(0, 0);
    afterPane(p.tab);
    return void freshenPane(next);
  }
  homeMoving();
  homeBusyFor(420);
  const still = () => onDeck() && stage.isConnected && pageKey(homePages()[homePageAt()]) === key;
  const waiting = () => [...stage.children].find((pane) => pane.dataset.key === key && pane.classList.contains("staged"));
  revealing++;
  try {
    // the page itself, in waiting
    let next = waiting();
    if (!next) {
      restaging = true;
      try {
        next = takePane(stage, p);
      } finally {
        restaging = false;
      }
      stagePane(next, 1);
    }
    // Loaded: the page waits for what it shows (the old page stays up meanwhile, and a
    // fetch that hangs is given up on after a couple of seconds), and is drawn with it.
    if (!tabLoaded(p.tab)) {
      await waitAtMost(2500, deckLoad(p.tab));
      if (!still()) return;
      next = waiting() || next;
      if (next.isConnected) {
        next.innerHTML = homePageHtml(p);
        next.readyAt = performance.now();
      }
    }
    // its pictures decoded, so none pops in after the fade
    await waitAtMost(500, Promise.all([...next.querySelectorAll("img")].map((picture) => picture.decode?.().catch(() => {}))));
    // drawn: a few frames since it was last put in waiting or redrawn
    if (performance.now() - (next.readyAt || 0) < 150) await framesFrom(3);
    if (!still() || !next.isConnected || !next.classList.contains("staged")) return;
    /* Into place, all but unseen, and into the layout, while the old page is still what
       is seen. Everything that makes the browser lay a page out or draw it again happens
       here, before the fade: the new page takes its place in the layout now (not when the
       fade ends), and the old one is lifted out of it to lie over the top, unmoved. So the
       fade itself changes nothing but the page's opacity. (Safari draws a page afresh when
       its place in the layout or its layer changes, and that showed as a flicker at both
       ends of the fade.) */
    const scrolled = window.scrollY;
    for (const pane of stage.querySelectorAll(`${LIVE_PANE}, .tab-pane.leaving`)) {
      pane.getAnimations?.().forEach((animation) => animation.cancel());
      pane.className = "tab-pane flat leaving overlay";
      pane.setAttribute("aria-hidden", "true");
    }
    // ("revealing": while it fades in, only a screen's height of it is drawn, on a layer
    // made ready now. Safari cannot blur and fade a layer as tall as a whole page in
    // time, and showed the page only once the fade was over.)
    next.className = `tab-pane flat revealing${safariEngine ? " plain" : ""}`;
    next.removeAttribute("aria-hidden");
    next.style.translate = "";
    next.style.transition = "none";
    next.style.opacity = "0.01"; // (not 0: a layer that cannot be seen at all need not be drawn)
    if (!safariEngine) next.style.filter = "blur(6px)";
    next.stale = true;
    afterPane(p.tab);
    // The screen goes to the top now too (the new page opens at its top), not as the
    // fade begins: that frame is kept for the fade alone. The old page is held where it
    // was seen, whatever the screen did.
    window.scrollTo(0, 0);
    const pulled = window.scrollY - scrolled;
    if (pulled) for (const pane of stage.querySelectorAll(".tab-pane.leaving")) pane.style.translate = `0 ${pulled}px`;
    // the browser is given time to have it drawn there
    await framesFrom(3);
    if (!next.isConnected || !next.matches(LIVE_PANE)) return;
    // The old page goes and the new one fades in, by a CSS transition from where it was
    // left (the most dependable way to fade in Safari, and every iPhone browser, which is
    // Safari underneath). Elsewhere it also comes out of a soft blur; not in Safari, where
    // a blur being animated takes the whole animation off the GPU, and a phone could not
    // keep up with it.
    for (const pane of stage.querySelectorAll(".tab-pane.leaving")) pane.style.opacity = "0";
    enterPane(next);
    next.style.transition = safariEngine ? "opacity 0.26s ease-out" : "opacity 0.26s ease-out, filter 0.26s ease-out";
    next.style.opacity = "1";
    if (!safariEngine) next.style.filter = "blur(0px)";
    let done = false;
    const shown = () => {
      if (done) return;
      done = true;
      next.style.transition = next.style.opacity = next.style.filter = "";
      next.classList.remove("revealing", "plain");
    };
    next.addEventListener("transitionend", (event) => event.target === next && event.propertyName === "opacity" && shown());
    setTimeout(shown, 500); // (in case the transition never ends: one cut short, say)
    freshenPane(next);
    whenHomeQuiet("park", () => stage.querySelectorAll(".tab-pane.leaving").forEach(parkPane));
    whenHomeQuiet("unflat", () => stage.querySelectorAll(".tab-pane.flat:not(.staged):not(.neighbor):not(.leaving)").forEach((pane) => pane.classList.remove("flat")));
    whenHomeQuiet("stage", restage);
  } finally {
    revealing--;
  }
}
/** What is on a page opened by a press animates in, as on a page newly built (from the start, if it has before). */
function enterPane(el) {
  el.classList.add("entering");
  settleWatch(el);
  for (const animation of el.getAnimations?.({ subtree: true }) || []) {
    if (!animation.animationName || animation.animationName === "idle") continue;
    animation.currentTime = 0;
    animation.play();
  }
}
/** A page that came from the park is drawn afresh, once all is still. */
function freshenPane(el) {
  if (!el?.stale) return;
  whenHomeQuiet(`fresh:${el.dataset.pane}`, () => {
    if (!el.stale || !el.isConnected || !el.matches(LIVE_PANE)) return;
    el.stale = false;
    redrawPane(el.dataset.pane);
  });
}
/** One by one, in quiet moments, the pages not yet built are built and parked. */
function warmPanes() {
  const next = () => {
    if (!onDeck()) return;
    const stage = root.querySelector("[data-tab-stage]");
    if (!stage) return;
    if (homeBusy()) return void setTimeout(next, 250);
    const have = new Set([...stage.children].map((pane) => pane.dataset.key));
    // (the pages nearest the one showing first: they are the likeliest to be opened next)
    const pages = homePages(),
      at = homePageAt();
    const p = pages
      .map((item, i) => [Math.abs(i - at), item])
      .sort((a, b) => a[0] - b[0])
      .map(([, item]) => item)
      .find((item) => !have.has(pageKey(item)));
    if (!p) return void whenHomeQuiet("stage", restage);
    parkPane(takePane(stage, p, "parked"));
    setTimeout(next, 120);
  };
  setTimeout(next, 350);
  // the emote pictures (on the You page) are fetched and decoded ahead, so they are there the moment it opens
  if (!warmPanes.decoded) {
    warmPanes.decoded = true;
    for (const id of typeof FACE_EMOTES === "undefined" ? [] : FACE_EMOTES) {
      const picture = new Image();
      picture.src = appPath(`/static/emotes/${id}.png`);
      picture.decode?.().catch(() => {});
      (warmPanes.pictures ||= []).push(picture); // (kept, so the decoded pictures are not thrown away)
    }
  }
}
/** A parked page whose data has just changed is drawn again where it lies, so it opens already up to date. */
function refreshParked(tabs) {
  whenHomeQuiet(`parked:${tabs.join()}`, () => {
    const stage = root.querySelector("[data-tab-stage]");
    for (const pane of stage?.querySelectorAll(".tab-pane.parked, .tab-pane.staged:not(.neighbor)") || []) {
      if (!tabs.includes(pane.dataset.pane)) continue;
      const [tab, view] = pane.dataset.key.split(":");
      pane.innerHTML = homePageHtml({ tab, view });
      pane.stale = false;
      pane.readyAt = performance.now();
    }
  });
}
/* While pages are on the move the stickers on them hold still and the dock's blur
   is put by, so each page travels as one flat picture (see .home-moving in the CSS). */
function homeMoving() {
  const top = document.documentElement;
  if (top.classList.contains("home-moving")) return;
  top.classList.add("home-moving");
  setTimeout(() => whenHomeQuiet("moving", () => top.classList.remove("home-moving")), 0);
}
/** After the frame now being made is on screen. */
const afterPaint = (work) => requestAnimationFrame(() => setTimeout(work, 0));
let slideQueued = 0;
/** Bring in the page for the tab showing, once the bar has set off. (Taps in quick succession make one slide, to the last.) */
function queueSlide() {
  const slide = () => {
    slideQueued = 0;
    if (!onDeck()) return;
    const pane = root.querySelector(`[data-tab-stage] ${LIVE_PANE}`);
    if (pane?.dataset.pane !== deckTab()) slideToTab(pane?.dataset.pane || deckTab(), deckTab());
  };
  if (reducedMotion.matches || !root.animate || typeof requestAnimationFrame !== "function") return slide();
  if (!slideQueued) slideQueued = afterPaint(slide) || 1;
}
function paneHtml(tab) {
  if (tab === "flags") return flagsPaneHtml();
  if (tab === "you") return youPaneHtml();
  if (tab === "watch") return watchPaneHtml();
  if (tab === "aces") return acesPaneHtml();
  return playPaneHtml();
}
/** Things a freshly drawn tab needs once it is in the page. */
function afterPane(tab) {
  if (tab === "you") {
    centerAvatar(false);
  }
  mountGoogleSignIn(); // (over any Sign in button on it)
  if (tab === "flags" || tab === "you") loadMyFlags();
  if (tab === "you") loadMyNumbers();
  if (tab === "play") watchMatchesEnd();
}
function slideToTab(from, to) {
  resetPager(); // (a sideways drag still settling is put down first)
  const stage = root.querySelector("[data-tab-stage]");
  // anything still leaving from a quick run of taps goes at once
  stage.querySelectorAll(".tab-pane.leaving").forEach(parkPane);
  revealPage(stage, { tab: to, view: acesView });
}
function dockHtml(tab) {
  return `<div class="dock-extra" data-dock-extra="${dockExtraKind(tab)}">${dockExtraHtml(tab)}</div>${tabBarHtml(tab)}`;
}
const dockExtraKind = (tab) => (tab === "play" ? "start" : "");
function dockExtraHtml(tab) {
  if (tab === "play") return startGameHtml();
  return "";
}
/* ---------- the navigation bar ----------
   One bar, drawn and moved the same way wherever it is used: the home screen's tab
   bar, and the bar at the foot of Match history. An icon for each item (the one
   showing a little bigger, with its name under it), and one pair of arrows that stand
   either side of it and travel with it when it changes.
   `items`: [{key, label, symbol, color}]; `kind`: what its buttons are called in the
   page's data (data-<kind>-tab on each item, data-<kind>-step on the arrows). */
function navBarHtml(items, at, { kind, label, noun = "tab", badges = () => "" }) {
  const arrow = (direction) => {
    const off = direction < 0 ? at === 0 : at === items.length - 1; // (nothing that way)
    return `<button type="button" class="tab-arrow ${direction < 0 ? "prev" : "next"} ${items[at].color}${off ? " off" : ""}" data-${kind}-step="${direction}" aria-label="${direction < 0 ? "Previous" : "Next"} ${noun}"${off ? " disabled" : ""}>${icon(direction < 0 ? "chevron.left" : "chevron.right", 20, { idle: false, sw: 4 })}</button>`;
  };
  return `<nav class="tab-bar c-fw" data-nav-bar="${kind}" aria-label="${e(label)}">${items.map((item, i) => {
    const on = i === at;
    return `<button type="button" class="tab-btn ${item.color}${on ? " on" : ""}" data-${kind}-tab="${item.key}" aria-current="${on ? "page" : "false"}"><span class="tab-ico">${tilted(item.symbol, 34, { key: `${kind}:${item.key}`, tilt: tabTilt(i, at), sw: 3.6 })}</span><span class="tab-label">${item.label}</span>${badges(item)}</button>`;
  }).join("")}${arrow(-1)}${arrow(1)}</nav>`;
}
/** The home screen's tab bar. */
function tabBarHtml(tab) {
  return navBarHtml(HOME_TABS, tabIndex(tab), {
    kind: "home",
    label: "Golf",
    badges: (item) => (item.key === "watch" ? `<span id="spectate-count" class="badge" hidden></span>` : item.key === "play" ? `<span id="friend-requests" class="badge left" hidden></span><span id="queue-count-tab" class="badge" hidden></span>` : ""),
  });
}
/** Stand a bar's arrows either side of the icon of the item showing (where its layout has it). */
function placeNavArrows(bar) {
  const ico = bar?.querySelector(".tab-btn.on .tab-ico");
  if (!ico) return;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
  const button = ico.closest?.(".tab-btn");
  if (!button) return;
  const x = button.offsetLeft + ico.offsetLeft + ico.offsetWidth / 2,
    y = button.offsetTop + ico.offsetTop + ico.offsetHeight / 2;
  // (clear of the icon at the size it is shown, a fifth bigger than it is laid out)
  const reach = ico.offsetWidth * 0.6 + 1.9 * rem;
  for (const [side, direction] of [["prev", -1], ["next", 1]]) {
    const arrow = bar.querySelector(`.tab-arrow.${side}`);
    arrow.style.left = `${(x + direction * reach).toFixed(1)}px`;
    arrow.style.top = `${y.toFixed(1)}px`;
  }
}
/** Every bar on the page, arrows placed. */
function placeTabArrows() {
  root.querySelectorAll?.(".tab-bar").forEach?.(placeNavArrows);
}
window.addEventListener("resize", () => {
  placeTabArrows();
  if (onDeck()) whenHomeQuiet("stage", restage); // (the pages in waiting move out with the screen's edge)
});
/**
 * A bar takes up its new arrangement (item `at` of `items` showing), and everything
 * flows to it from where it was: the icons slide along as the item showing takes its
 * extra room, and the arrows travel across to stand beside it. (It can be changed
 * again mid-flow: everything sets off from wherever it had got to.) `moving()`: told
 * how long the flow takes, for a page that holds still meanwhile.
 */
function flowNavBar(bar, items, at, moving = () => {}) {
  if (!bar) return;
  const buttons = [...bar.querySelectorAll(".tab-btn")],
    arrows = [...bar.querySelectorAll(".tab-arrow")];
  // each icon leans by how far it is from the item now on (turning there smoothly: see .tab-ico .tilt)
  buttons.forEach((button, i) => {
    const tilt = tabTilt(i, at);
    const holder = button.querySelector(".tab-ico .tilt"),
      sticker = holder?.querySelector(".ico");
    if (!holder || holder.style.getPropertyValue("--tilt") === `${tilt}deg`) return;
    holder.style.setProperty("--tilt", `${tilt}deg`);
    // (its shadow still falls down and to the right)
    const [, x, y] = shadowVars(tilt).match(/--shx:([^;]+);--shy:([^;]+);/) || [];
    if (sticker && x) {
      sticker.style.setProperty("--shx", x);
      sticker.style.setProperty("--shy", y);
    }
  });
  const animated = !reducedMotion.matches && !!bar.animate;
  // where something is seen to be just now, within the bar
  const seen = (el) => {
    const box = bar.getBoundingClientRect(),
      r = el.getBoundingClientRect();
    return [r.left + r.width / 2 - box.left - bar.clientLeft, r.top + r.height / 2 - box.top - bar.clientTop];
  };
  const icons = buttons.map((button) => button.querySelector(".tab-ico"));
  const iconsWere = icons.map((ico) => seen(ico)[0]),
    arrowsWere = arrows.map(seen);
  // (the colors each arrow is drawn in just now, to fade from)
  const inkWas = arrows.map((arrow) => {
    const path = animated && arrow.querySelector(".ico:not(.ghost) path");
    const style = path && getComputedStyle(path);
    return style ? [style.fill, style.stroke] : null;
  });
  const colors = [...new Set(items.map((item) => item.color))];
  const colorWas = arrows.map((arrow) => colors.find((color) => arrow.classList.contains(color)));
  buttons.forEach((button, i) => {
    button.classList.toggle("on", i === at);
    button.setAttribute("aria-current", i === at ? "page" : "false");
  });
  arrows.forEach((arrow) => {
    const off = arrow.classList.contains("prev") ? at === 0 : at === items.length - 1;
    arrow.classList.remove(...colors);
    arrow.classList.add(items[at].color);
    arrow.classList.toggle("off", off);
    arrow.disabled = off;
  });
  placeNavArrows(bar);
  if (!animated) return;
  moving(660);
  const flow = { duration: 640, easing: "cubic-bezier(0.4, 0, 0.1, 1)" };
  // (the arrows go ahead: they are across well before the icons have settled)
  const dart = { duration: 340, easing: "cubic-bezier(0.22, 1, 0.36, 1)" };
  // (On `transform`, which every browser runs off the main thread; the separate `translate`
  // property is not handed to the GPU everywhere, and stuttered there while a page was drawn.)
  const glide = (el, dx, dy = 0, timing = flow, base = "") => {
    el.flow?.cancel();
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) el.flow = el.animate([{ transform: `${base} translate(${dx}px, ${dy}px)` }, { transform: `${base} translate(0px, 0px)` }], timing);
  };
  // (every measurement is taken before anything is set moving, so the bar is laid out once)
  const shifts = buttons.map((button, i) => iconsWere[i] - (button.offsetLeft + icons[i].offsetLeft + icons[i].offsetWidth / 2));
  // each item moves as one piece: its icon, its name and any count on it
  buttons.forEach((button, i) => glide(button, shifts[i]));
  arrows.forEach((arrow, i) => glide(arrow, arrowsWere[i][0] - parseFloat(arrow.style.left), arrowsWere[i][1] - parseFloat(arrow.style.top), dart, "translate(-50%, -50%)"));
  // An arrow changes color by cross-fading: a copy in the old colors lies over it and fades
  // away. (Only its opacity moves, which the GPU does on its own, so the change stays even
  // while the page is busy; a color eased by the page itself stepped.)
  arrows.forEach((arrow, i) => {
    arrow.querySelectorAll(".ico.ghost").forEach((ghost) => ghost.remove());
    const drawn = arrow.querySelector(".ico");
    if (!drawn || !inkWas[i] || colorWas[i] === items[at].color) return;
    const ghost = drawn.cloneNode(true);
    ghost.classList.add("ghost");
    ghost.style.setProperty("--fill", inkWas[i][0]);
    ghost.style.setProperty("--stroke", inkWas[i][1]);
    drawn.after(ghost);
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 420, easing: "ease-in-out", fill: "forwards" }).onfinish = () => ghost.remove();
  });
}
/** The home screen's tab bar flows to `tab` (and the home screen holds still meanwhile). */
function flowTabBar(tab) {
  flowNavBar(root.querySelector('[data-nav-bar="home"]'), HOME_TABS, tabIndex(tab), (ms) => {
    homeBusyFor(ms);
    homeMoving();
  });
}
/** The bar after a tab change: it flows to the new tab, and the strip above it (Start a Game, Aces' views) swaps. */
function updateDock(tab) {
  const dock = root.querySelector("[data-home-dock]");
  if (!dock) return;
  flowTabBar(tab);
  const extra = dock.querySelector("[data-dock-extra]");
  const kind = dockExtraKind(tab);
  setStartOpen(false, true);
  if (extra.dataset.dockExtra === kind) return;
  const moving = !reducedMotion.matches && !!extra.animate;
  /* The strip's contents move, not the strip: the blur band under it (its ::after) fades
     in and out with them by its own opacity. (A blur inside something being faded has
     nothing behind it to blur until the fade ends, so it popped in afterwards.) */
  const parts = () => [...extra.children];
  // the strip for the tab now showing (whichever that is by the time the old one has gone)
  const arrive = () => {
    extra.leaving = false;
    const now = dockExtraKind(homeTab);
    extra.dataset.dockExtra = now;
    extra.innerHTML = dockExtraHtml(homeTab);
    renderHomeLive();
    if (moving && now) {
      for (const part of parts()) part.animate([{ translate: "0 1rem", opacity: 0 }, { translate: "0 0", opacity: 1 }], { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      // the blur: from nothing, as the strip rises
      extra.classList.add("blur-off");
      void extra.offsetWidth;
      extra.classList.remove("blur-off");
    }
  };
  if (extra.leaving) return; // one is already on its way out: what follows it is decided then
  // the old strip sinks away first, then the new one rises
  if (moving && extra.dataset.dockExtra && extra.firstElementChild) {
    extra.leaving = true;
    extra.dataset.dockExtra = "leaving";
    extra.classList.add("blur-off");
    const outs = parts().map((part) => part.animate([{ translate: "0 0", opacity: 1 }, { translate: "0 0.8rem", opacity: 0 }], { duration: 170, easing: "ease-in", fill: "forwards" }));
    const out = outs[0];
    out.onfinish = out.oncancel = () => {
      outs.forEach((animation) => animation.cancel?.());
      if (extra.leaving) arrive();
    };
  } else arrive();
}
function stepTab(direction) {
  const next = HOME_TABS[tabIndex(homeTab) + direction];
  if (next) homePage(next.key);
}
/**
 * A sideways swipe or scroll: the next tab that way (Aces' views are not among them:
 * those are picked on its strip).
 */
function homeStep(direction) {
  stepTab(direction);
}
/** Draw a tab's pane again from what has loaded (only the parts that changed are touched). */
function redrawPane(tab) {
  if (!onDeck() || deckTab() !== tab) return;
  const pane = root.querySelector(`[data-tab-stage] ${LIVE_PANE}[data-pane="${tab}"]`);
  if (!pane) return;
  const template = document.createElement("template");
  template.innerHTML = homePageHtml({ tab, view: acesView });
  // (Watch is patched card by card, so what changed can animate)
  if (tab === "watch" && template.content && patchWatch(pane, template.content)) return;
  if (template.content) morphChildren(pane, template.content);
  else pane.innerHTML = homePageHtml({ tab, view: acesView });
  if (tab === "you") {
    // (patching the page clears where the avatar wheel had put each avatar)
    layoutWheel(root.querySelector(".avatar-strip"), true);
    paintDeckPick(); // (and what was picked up in Your Deck)
  }
  mountGoogleSignIn();
  if (tab === "play") watchMatchesEnd();
}
const tabData = {}; // what each tab last fetched, as text (to tell when nothing changed)
/**
 * Fetch what a tab shows, then draw it in once the screen is at rest. `lazy`
 * (a tab just switched to, already drawn from what is known) skips the drawing
 * when nothing came back different.
 */
const TAB_FRESH = { play: 15000, watch: 4000, aces: 30000 }; // how long each tab's data counts as current, in ms
const tabFetchedAt = {};
const tabLoading = {}; // {kind: the fetch under way}
function loadTab(tab, lazy = false) {
  const kind = tab === "you" ? "aces" : tab;
  // (a visit while that tab's data is already being fetched waits on the same fetch)
  if (lazy && tabLoading[kind]) return tabLoading[kind];
  const run = fetchTab(tab, lazy).finally(() => tabLoading[kind] === run && delete tabLoading[kind]);
  return (tabLoading[kind] = run);
}
async function fetchTab(tab, lazy = false) {
  const kind = tab === "you" ? "aces" : tab;
  // (a tab only being visited, not refreshed, makes do with what was fetched a moment ago)
  if (lazy && tabFetchedAt[kind] && performance.now() - tabFetchedAt[kind] < (TAB_FRESH[kind] || 0)) return;
  if (kind in TAB_FRESH) tabFetchedAt[kind] = performance.now();
  try {
    let got;
    if (tab === "play") {
      const [puzzle, friends, matches] = await Promise.all([
        // (as many scores as the card has already been scrolled through, so a refresh keeps them)
        api(`/api/puzzle?limit=${Math.max(PUZZLE_ROWS, homeData.puzzle?.board?.length || 0)}`),
        api("/api/friends"),
        api("/api/history?mine=true&limit=3"),
      ]);
      // (more of your matches may have been loaded since, further down the card: they are
      // kept as long as the newest are still the same ones)
      const same = (a, b) => a.id === b.id && a.updated_at === b.updated_at;
      const kept = homeData.matches && homeData.matches.length > matches.matches.length && matches.matches.every((match, i) => same(match, homeData.matches[i]));
      got = { puzzle, friends, matches: kept ? homeData.matches : matches.matches, matchesNext: kept ? homeData.matchesNext : matches.next_offset };
    } else if (tab === "watch") {
      const [games, cups] = await Promise.all([api("/api/spectate"), loadTournaments()]);
      got = { games, cups };
    } else if (tab === "aces" || tab === "you") {
      got = { boards: await api("/api/leaderboards") };
      leaderboardCache = got.boards;
    } else return;
    const key = tab === "you" ? "aces" : tab;
    const text = JSON.stringify(got);
    const same = tabData[key] === text;
    tabData[key] = text;
    const friendsBefore = friendKeys();
    Object.assign(homeData, got);
    if (tab === "play") renderFriendBadge();
    // (who your friends are marks names on the boards too: they are drawn again when it changes)
    if (tab === "play" && friendKeys() !== friendsBefore) {
      refreshParked(["aces", "you"]);
      whenHomeQuiet("draw:friends", () => ["aces", "you"].includes(homeTab) && redrawPane(homeTab));
    }
    // (the leaderboards feed both Aces and You: whichever is showing is the one drawn)
    const shows = key === "aces" ? ["aces", "you"] : [key];
    if (!same) refreshParked(shows);
    if (lazy && same) return;
    whenHomeQuiet(`draw:${key}`, () => shows.includes(homeTab) && redrawPane(homeTab));
  } catch (error) {
    if (page === "home" && homeTab === tab) toast(error.message);
  }
}
/** Your friends' player ids, as one string (to tell when they change). */
const friendKeys = () => (homeData.friends?.friends || []).map((friend) => friend.id).sort().join();
/** Soon after the home screen opens, the other tabs' data is fetched too, so each is drawn whole the first time it is opened. */
function prefetchTabs() {
  setTimeout(() => {
    for (const tab of ["play", "watch", "aces"])
      if (page === "home" && homeTab !== tab && !(tab === "aces" && homeTab === "you") && !tabData[tab]) loadTab(tab, true);
  }, 0);
}
/** Incoming friend requests, on the Play tab's corner. */
function renderFriendBadge() {
  const count = homeData.friends?.incoming?.length || 0;
  setCount("friend-requests", count, `${count} friend ${count === 1 ? "request" : "requests"}`);
}

/* While Play or Watch is in front, what it shows keeps itself current: your
   friends come and go, and games start and end. */
let tabRefreshAt = 0;
setInterval(() => {
  if (page !== "home" || document.visibilityState !== "visible" || startOpen) return;
  // (Watch looks again every five seconds; its cards are patched, the scores animating as they change)
  const every = homeTab === "watch" ? 5000 : homeTab === "play" ? 20000 : 0;
  if (!every || performance.now() - tabRefreshAt < every) return;
  tabRefreshAt = performance.now();
  if (homeTab === "watch") loadTab("watch");
  else api("/api/friends").then((friends) => {
    homeData.friends = friends;
    renderFriendBadge();
    whenHomeQuiet("draw:play", () => redrawPane("play"));
  }).catch(() => {});
}, 1000);

/* ---------- scrolling sideways between tabs ----------
   The home screen's pages lie side by side: Flags, You, Play, Watch, then
   Aces (whichever of its views is showing). A finger dragged sideways (or two fingers on a
   trackpad) carries the page with it, the next one coming in alongside; each
   fades and blurs the further it is from the middle. Half way across, the
   page coming in becomes the one showing (the bar follows); let go and it
   springs to rest. It can be caught again at any moment, mid-spring included.
   One gesture turns one page at most; past the first and last it only gives. */
// (Aces is one page among them: the view showing. Its other views are reached only from
// the strip at its top, or by tapping Aces on the tab bar again, never by a swipe.)
// (on Match history: its lists, PvP, Tournaments and Solo)
const homePages = () =>
  deck === "history" ? LIST_TABS.map((item) => ({ tab: item.key })) : HOME_TABS.map((tab) => (tab.key === "aces" ? { tab: "aces", view: acesView } : { tab: tab.key }));
const homePageAt = () => homePages().findIndex((p) => p.tab === deckTab());
/** A page of the home screen (or of Match history), drawn as it would be (an Aces view other than the one showing, too). */
function homePageHtml(p) {
  if (deck === "history") return historyPaneHtml(p.tab);
  if (p.tab !== "aces") return paneHtml(p.tab);
  const was = acesView;
  acesView = p.view;
  try {
    return paneHtml("aces");
  } finally {
    acesView = was;
  }
}
/* The pages in play: the one showing (cur) and the ones either side, each {el, page, y}.
   x is how far the one showing sits from rest, in px; v its speed while it springs back. */
const pager = { stage: null, cur: null, prev: null, next: null, width: 0, x: 0, v: 0, raf: 0, last: 0, moved: 0 };
const pagerLive = () => !!pager.stage?.isConnected && !!pager.cur?.el.isConnected;
const clearPane = (el) => (el.style.translate = el.style.opacity = "");
/** Put everything down: only the page showing is left, at rest. */
function resetPager() {
  cancelAnimationFrame(pager.raf);
  pager.raf = 0;
  for (const side of ["prev", "next"]) {
    const item = pager[side],
      direction = side === "next" ? 1 : -1;
    // (a page still beside the one showing stays in waiting where it is)
    const beside = item && onDeck() && item.el.isConnected && homePages()[homePageAt() + direction];
    if (beside && pageKey(beside) === item.el.dataset.key) stagePane(item.el, direction);
    else parkPane(item?.el);
    pager[side] = null;
  }
  pager.stage?.querySelectorAll?.(".tab-pane.neighbor").forEach(parkPane);
  if (pager.cur) whenHomeQuiet("stage", restage);
  if (pager.cur) clearPane(pager.cur.el);
  pager.stage = pager.cur = null;
  pager.x = pager.v = 0;
}
/** Take hold of the pages (wherever they are, a spring in flight included). False when there is nothing to hold. */
function beginPager() {
  if (!onDeck()) return false;
  const stage = root.querySelector("[data-tab-stage]");
  if (!stage) return false;
  if (pager.stage !== stage || !pagerLive()) {
    resetPager();
    stage.querySelectorAll(".tab-pane.leaving, .tab-pane.neighbor").forEach(parkPane);
    const el = stage.querySelector(LIVE_PANE);
    if (!el) return false;
    el.getAnimations?.().forEach((animation) => animation.cancel());
    homeMoving();
    pager.stage = stage;
    pager.cur = { el, page: homePages()[homePageAt()], y: 0 };
  }
  cancelAnimationFrame(pager.raf);
  pager.raf = 0;
  // (the next page starts a little past this one's edge)
  pager.width = stage.getBoundingClientRect().width + 32;
  pager.moved = 0;
  return true;
}
/** The page on that side of the one showing, made when it is first pulled toward (if this gesture may reach it). */
function ensureNeighbor(direction) {
  const side = direction > 0 ? "next" : "prev";
  if (pager[side]) return pager[side];
  const p = homePages()[homePageAt() + direction];
  if (!p || Math.abs(pager.moved + direction) > 1) return null;
  // (it lies over the stage, a screen's height of it, until it is the page showing: the
  // page being left keeps the layout to itself)
  const el = takePane(pager.stage, p, "neighbor staged");
  el.setAttribute("aria-hidden", "true");
  el.style.opacity = "0";
  // it comes in as it will lie once it is the page showing: at its top, under the top bar,
  // however far down this page is scrolled
  return (pager[side] = { el, page: p, y: window.scrollY });
}
/** Draw the pages where they are: each fades with its distance from the middle. */
function renderPager() {
  const place = (item, offset) => {
    if (!item) return;
    const far = Math.min(1, Math.abs(offset) / pager.width);
    const style = item.el.style;
    style.translate = `${offset.toFixed(1)}px ${item.y}px`;
    style.opacity = (1 - far ** 1.5).toFixed(3);
  };
  place(pager.cur, pager.x);
  place(pager.prev, pager.x - pager.width);
  place(pager.next, pager.x + pager.width);
}
/** The page on that side is now the one showing: the bar, the address and its data follow. */
function rebasePager(direction) {
  const side = direction > 0 ? "next" : "prev",
    other = direction > 0 ? "prev" : "next";
  const incoming = pager[side],
    old = pager.cur;
  parkPane(pager[other]?.el);
  pager[other] = old;
  pager.cur = incoming;
  pager[side] = null;
  pager.x += direction * pager.width;
  pager.moved += direction;
  old.el.classList.add("neighbor");
  old.el.setAttribute("aria-hidden", "true");
  incoming.el.classList.remove("neighbor", "staged");
  incoming.el.removeAttribute("aria-hidden");
  // it was drawn where it lies with the screen at its own scroll (the top, for a page
  // coming in): the screen scrolls there, and every page is moved to match, so nothing jumps.
  // The top bar alone would: it glides in from where it was instead.
  if (incoming.y) {
    const before = window.scrollY;
    window.scrollTo({ top: before - incoming.y, behavior: "instant" });
    const shift = before - window.scrollY;
    for (const item of [pager.cur, pager.prev, pager.next]) if (item) item.y -= shift;
    const bar = root.querySelector(".page.home > .topbar");
    if (shift && bar?.animate && !reducedMotion.matches)
      bar.animate([{ translate: `0 ${-shift}px` }, { translate: "0 0" }], { duration: 520, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  }
  adoptHomePage(incoming.page);
}
/**
 * Move the pages by `delta` px. Where there is no page to go to it only gives
 * a little; `firm` (a trackpad's momentum) stops dead at the one page a gesture
 * may turn. Returns "limit" or "end" when it met one of those.
 */
function dragPager(delta, firm = false) {
  let x = pager.x + delta,
    met = "";
  const direction = x < 0 ? 1 : -1; // the side being pulled in
  if (x && !ensureNeighbor(direction)) {
    met = homePages()[homePageAt() + direction] ? "limit" : "end";
    if (firm && met === "limit") x = 0;
    else {
      const from = direction > 0 ? Math.min(pager.x, 0) : Math.max(pager.x, 0);
      x = clamp(from + (x - from) * 0.3, -56, 56);
    }
  }
  pager.x = x;
  if (x < -pager.width / 2 && pager.next) rebasePager(1);
  else if (x > pager.width / 2 && pager.prev) rebasePager(-1);
  renderPager();
  return met;
}
/** Let go, moving at `speed` px/ms: on to the next page if it was flicked or dragged far enough, then spring to rest. */
function releasePager(speed = 0) {
  if (!pagerLive()) return resetPager();
  if (pager.moved === 0) {
    const far = pager.width * 0.3;
    if (pager.next && (pager.x < -far || (speed < -0.25 && pager.x < -6))) rebasePager(1);
    else if (pager.prev && (pager.x > far || (speed > 0.25 && pager.x > 6))) rebasePager(-1);
  }
  // It comes to rest on a critically damped spring: no bounce, only a soft landing.
  // (Let go at speed, it eases in rather than shooting past: a hair of overshoot at most.)
  const pull = 12; // the spring's natural frequency, per second
  const most = pull * Math.abs(pager.x) + 400;
  pager.v = clamp(speed * 1000, -most, most);
  if (reducedMotion.matches) return finishPager();
  pager.last = performance.now();
  cancelAnimationFrame(pager.raf);
  const step = (now) => {
    pager.raf = 0;
    if (!pagerLive()) return resetPager();
    const dt = Math.min(0.032, Math.max(0.001, (now - pager.last) / 1000));
    pager.last = now;
    pager.v += (-pull * pull * pager.x - 2 * pull * pager.v) * dt;
    pager.x += pager.v * dt;
    if (Math.abs(pager.x) < 1 && Math.abs(pager.v) < 20) return finishPager();
    renderPager();
    pager.raf = requestAnimationFrame(step);
  };
  pager.raf = requestAnimationFrame(step);
}
/** At rest: the pages either side are put away. */
function finishPager() {
  resetPager();
}
/** The page carried in is now the one showing: the bar, the address and its data follow. */
function adoptHomePage(p) {
  if (deck === "history") return adoptHistoryList(p);
  if (p.tab === "aces") acesView = p.view;
  homeTab = p.tab;
  startOpen = false;
  // The bar follows in the next frame, not this one: the frame in which the pages change
  // places already has their own work in it, and the two together made it a long one.
  const follow = () => {
    if (page !== "home") return;
    const holder = root.querySelector("[data-home]");
    if (holder) holder.dataset.tab = homeTab;
    if (root.querySelector(".tab-btn.on")?.dataset.homeTab !== homeTab) updateDock(homeTab);
    if (homeTab === "aces") markAcesView(acesView);
    if (homeTab === "watch") root.querySelectorAll('[data-pane="watch"]').forEach(settleWatch);
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(follow);
  else follow();
  haptic("snap");
  if (p.tab === "you") {
    // the avatar wheel answers to this page's strip now
    layoutWheel(root.querySelector(".tab-pane:not(.neighbor):not(.parked):not(.staged) .avatar-strip"), true);
  }
  freshenPane(pager.cur?.el);
  // the rest is not seen: it waits until the pages have come to rest (wherever that is by then)
  whenHomeQuiet("adopt", () => {
    if (page !== "home") return;
    document.title = HOME_TABS[tabIndex(homeTab)].title === "Golf" ? "Golf" : `${HOME_TABS[tabIndex(homeTab)].title} · Golf`;
    history.replaceState({}, "", appPath(tabPath(homeTab)));
    mountGoogleSignIn();
    if (homeTab === "play") watchMatchesEnd();
    loadTab(homeTab, true);
  });
}
/** Whether a sideways gesture starting on `target` is not the pages' to take (`how`: "wheel", "touch" or "mouse"). */
const pagerBlocked = (target, how) =>
  !onDeck() || (deck === "home" && startOpen) || !sheetRoot.hidden || !root.querySelector("[data-home]") || !!document.querySelector("dialog[open]") ||
  // anything that scrolls sideways itself keeps the gesture (a table only when it is too wide
  // for its card); so does text being edited, and an emote a mouse could be picking up (a
  // finger holds an emote first, so its swipes are free)
  scrollsSideways(target.closest?.(".table-wrap")) ||
  !!target.closest?.(how === "wheel" ? ".avatar-strip" : how === "mouse" ? ".avatar-strip, input:not(.haptic-switch), [data-emote-item]" : ".avatar-strip, input:not(.haptic-switch)");
const scrollsSideways = (el) => !!el && el.scrollWidth > el.clientWidth + 1;
/** How fast the last stretch of a gesture went, in px/ms, from its [time, position] samples. */
function sampleSpeed(samples, now) {
  const recent = samples.filter(([at]) => now - at < 120);
  if (recent.length < 2) return 0;
  const [t0, x0] = recent[0],
    [t1, x1] = recent.at(-1);
  return t1 > t0 ? (x1 - x0) / (t1 - t0) : 0;
}
// a finger, anywhere on the home screen (the background and the bar included): it decides
// in its first few pixels whether it is scrolling the page or turning it
let touchPage = null;
document.addEventListener(
  "touchstart",
  (event) => {
    touchPage = null;
    if (onDeck()) {
      // (A finger on the glass counts as busy, so work put off waits for it. The stickers
      // are not stopped for it: stopping every sticker's drift and starting it again made
      // Safari draw them afresh, and they flickered as the page was scrolled. They are
      // stopped only for the pages moving sideways, once a swipe has begun.)
      touchDownAt = performance.now();
    }
    if (event.touches.length !== 1 || pagerBlocked(event.target, "touch")) return;
    const touch = event.touches[0];
    touchPage = { x: touch.clientX, y: touch.clientY, on: false, samples: [] };
  },
  { passive: true },
);
document.addEventListener(
  "touchmove",
  (event) => {
    const gesture = touchPage;
    if (!gesture) return;
    const touch = event.touches[0];
    if (!gesture.on) {
      const dx = touch.clientX - gesture.x,
        dy = touch.clientY - gesture.y;
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      // (an emote held long enough to be picked up is being carried: that is not a swipe)
      if (Math.abs(dx) < Math.abs(dy) * 1.2 || emoteDrag?.active || !beginPager()) return void (touchPage = null);
      gesture.on = true;
      gesture.x = touch.clientX; // (it moves from here, with no jump)
    }
    // (The page stays put while it turns without being told to: the home screen's
    // touch-action lets the browser scroll it up and down only. So this listener can be
    // passive, and the browser never has to wait on it before scrolling.)
    dragPager(touch.clientX - gesture.x);
    gesture.x = touch.clientX;
    gesture.samples.push([performance.now(), touch.clientX]);
    if (gesture.samples.length > 12) gesture.samples.shift();
  },
  { passive: true },
);
for (const type of ["touchend", "touchcancel"])
  document.addEventListener(type, (event) => {
    const gesture = touchPage;
    touchPage = null;
    if (!event.touches?.length) touchDownAt = 0;
    if (gesture?.on) releasePager(event.type === "touchcancel" ? 0 : sampleSpeed(gesture.samples, performance.now()));
  });
window.addEventListener("scroll", () => (lastScrollAt = performance.now()), { passive: true });
document.addEventListener("visibilitychange", () => (touchDownAt = 0));
/* A mouse drags the pages the same way: press anywhere on the home screen (the
   background too) and pull sideways. The click that would follow a drag is dropped. */
let mousePage = null,
  mousePageEnded = 0;
function endMousePage() {
  const gesture = mousePage;
  mousePage = null;
  if (!gesture?.on) return;
  document.documentElement.classList.remove("paging");
  mousePageEnded = performance.now();
  releasePager(sampleSpeed(gesture.samples, performance.now()));
}
document.addEventListener("pointerdown", (event) => {
  mousePage = null;
  if (event.pointerType !== "mouse" || event.button !== 0 || pagerBlocked(event.target, "mouse")) return;
  mousePage = { x: event.clientX, y: event.clientY, on: false, samples: [] };
});
document.addEventListener("pointermove", (event) => {
  const gesture = mousePage;
  if (!gesture || event.pointerType !== "mouse") return;
  if (!(event.buttons & 1)) return endMousePage(); // let go somewhere it could not be seen
  if (!gesture.on) {
    const dx = event.clientX - gesture.x,
      dy = event.clientY - gesture.y;
    if (Math.abs(dx) < 6) return;
    if (Math.abs(dx) < Math.abs(dy) * 1.2 || !beginPager()) return void (mousePage = null);
    gesture.on = true;
    gesture.x = event.clientX;
    document.documentElement.classList.add("paging"); // (no text is selected along the way)
    getSelection?.()?.removeAllRanges();
  }
  dragPager(event.clientX - gesture.x);
  gesture.x = event.clientX;
  gesture.samples.push([performance.now(), event.clientX]);
  if (gesture.samples.length > 12) gesture.samples.shift();
});
for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, (event) => event.pointerType === "mouse" && endMousePage());
document.addEventListener("dragstart", (event) => mousePage && event.preventDefault());
document.addEventListener(
  "click",
  (event) => {
    if (performance.now() - mousePageEnded > 300) return;
    event.stopPropagation();
    event.preventDefault();
  },
  true,
);
/* Two fingers on a trackpad (or a tilted wheel): the page follows the fingers, and
   once they lift (the scrolling starts to fade: that is the trackpad's momentum) it
   is let go at that speed and springs to its page. What is left of the momentum is
   let run out; a new push is told from it by its strength (momentum only ever
   fades), and takes hold at once. */
const wheelPage = { on: false, arrived: false, at: 0, size: 0, sign: 0, fading: 0, top: 0, rising: 0, faint: 0, count: 0, travel: 0, samples: [], timer: 0 };
function releaseWheelPage() {
  const w = wheelPage;
  // (one click of a wheel is a whole push by itself)
  const speed = w.count === 1 && Math.abs(w.travel) >= 40 ? Math.sign(w.travel) : sampleSpeed(w.samples, w.at);
  w.arrived = true;
  releasePager(speed);
}
document.addEventListener(
  "wheel",
  (event) => {
    if (event.ctrlKey) return; // a pinch
    const w = wheelPage,
      now = performance.now();
    const live = w.on && now - w.at < 90; // the gesture, or its momentum, is still coming in
    const sideways = Math.abs(event.deltaX) > Math.abs(event.deltaY);
    if (!sideways) {
      // up and down scroll the tab as usual
      if (live && !w.arrived) releaseWheelPage();
      return;
    }
    if (!live && pagerBlocked(event.target, "wheel")) return;
    // the page never scrolls sideways itself; this also keeps the browser from going Back
    event.preventDefault();
    if (!live) w.size = 0;
    const delta = event.deltaX * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? pager.width || 400 : 1);
    const size = Math.abs(delta);
    // a push: far stronger than what came before, or the other way, or growing twice running
    const rising = size > w.size && size >= 3 ? w.rising + 1 : 0;
    const pushed = size > w.size * 1.4 + 4 || (Math.sign(delta) !== w.sign && size > 4) || rising >= 2;
    if (!live || (w.arrived && pushed)) {
      if (!beginPager()) return void (w.on = false);
      Object.assign(w, { on: true, arrived: false, fading: 0, rising: 0, faint: 0, count: 0, travel: 0, samples: [] });
    } else w.rising = rising;
    if (size < w.size) {
      if (!w.fading) w.top = w.size;
      w.fading++;
    } else w.fading = 0;
    w.faint = size <= 2 ? w.faint + 1 : 0;
    w.at = now;
    w.size = size;
    w.sign = Math.sign(delta);
    clearTimeout(w.timer);
    w.timer = setTimeout(() => {
      // the scrolling stopped: it settles where it is going
      w.on = false;
      if (!w.arrived) releaseWheelPage();
    }, 100);
    if (w.arrived) return;
    w.count++;
    w.travel -= delta;
    w.samples.push([now, w.travel]);
    if (w.samples.length > 12) w.samples.shift();
    const met = dragPager(-delta, true);
    // the fingers have lifted (it is fading steadily), or it has all but stopped, or it is at a page it cannot pass
    const coasting = (w.fading >= 3 && size <= w.top * 0.85) || w.fading >= 5;
    if (met === "limit" || (met === "end" && w.fading >= 2) || coasting || w.faint >= 3) releaseWheelPage();
  },
  { passive: false },
);

/* a page in waiting (off the screen's edge) is not to be tabbed into */
document.addEventListener("focusin", (event) => event.target.closest?.(".tab-pane.staged:not(.neighbor)") && event.target.blur?.());
/* a page on its way in or out is not there to be clicked */
document.addEventListener(
  "click",
  (event) => {
    if (!event.target.closest?.(".tab-pane.leaving, .tab-pane.neighbor, .tab-pane.staged")) return;
    event.stopPropagation();
    event.preventDefault();
  },
  true,
);

/* ---------- clicks ---------- */
/** The home screen's own buttons. Returns true when it handled the click. */
async function homeClick(button, data, event) {
  if (data.homeStep) {
    stepTab(Number(data.homeStep));
    return true;
  }
  if (data.homeTab) {
    if (data.homeTab !== homeTab) homePage(data.homeTab);
    // Aces tapped again: on to its next view (Records, Solo, PvP, and round again)
    else if (homeTab === "aces") setAcesView(ACES_VIEWS[(ACES_VIEWS.findIndex((view) => view.key === acesView) + 1) % ACES_VIEWS.length].key);
    // You likewise: Profile, Your Deck, and back
    else if (homeTab === "you") setYouView(YOU_VIEWS[(YOU_VIEWS.findIndex((view) => view.key === youView) + 1) % YOU_VIEWS.length].key);
    else {
      // the tab already showing: back to its top (and Watch looks for games again)
      window.scrollTo({ top: 0, behavior: reducedMotion.matches ? "instant" : "smooth" });
      if (homeTab === "watch") await refreshWatch();
    }
    return true;
  }
  if (data.acesView) {
    setAcesView(data.acesView);
    return true;
  }
  if (data.youView) {
    setYouView(data.youView);
    return true;
  }
  if ("deckPick" in data) {
    deckTap(button);
    return true;
  }
  if ("startToggle" in data) {
    setStartOpen(!startOpen);
    return true;
  }
  if ("startClose" in data) {
    setStartOpen(false);
    return true;
  }
  if ("puzzleRetry" in data) {
    closeSheet(); // (it is also in the table's menu)
    await move("retry");
    return true;
  }
  if ("puzzleStart" in data) {
    await startPuzzle();
    return true;
  }
  if ("puzzleBoard" in data) {
    await puzzleBoardSheet();
    return true;
  }
  if (data.matchOpen) {
    matchSheet(homeData.matches?.[Number(data.matchOpen)]);
    return true;
  }
  if ("profileBack" in data) {
    // (back to the tournament it was opened from, or to the home tab)
    if (profileBack?.tournament) tournamentPage(profileBack.tournament);
    else if (profileBack === "history") historyPage();
    else if (profileBack === "resume") navigate("resume");
    else home(profileBack);
    return true;
  }
  if ("profileFriend" in data) {
    await profileFriend(button, data.profileFriend);
    return true;
  }
  if ("friendsSheet" in data) {
    friendsSheet();
    return true;
  }
  if (data.friendAccept) {
    await friendAction(`/api/friends/${encodeURIComponent(data.friendAccept)}/accept`, "POST");
    return true;
  }
  if (data.friendRemove) {
    await friendAction(`/api/friends/${encodeURIComponent(data.friendRemove)}`, "DELETE");
    return true;
  }
  if (data.homeRefresh) {
    if (data.homeRefresh === "watch") await refreshWatch();
    else await loadTab(data.homeRefresh);
    return true;
  }
  if ("myStats" in data) {
    await loadMyStats();
    return true;
  }
  if ("hideMyStats" in data) {
    homeData.myStats = null;
    redrawPane("you");
    return true;
  }

  return false;
}

/* ---------- Play ---------- */
function playPaneHtml() {
  const credit = `<p class="credit">Designed by <a href="https://spencersteadman.com" target="_blank" rel="noopener">Spencer${textSymbol("arrow.up.right", "out-arrow")}</a> &amp; <a href="https://sleptsov.dev" target="_blank" rel="noopener">Alex${textSymbol("arrow.up.right", "out-arrow")}</a></p>`;
  return `<div class="tab-body play-body">${patchChip()}${puzzleHtml()}${friendsHtml()}${matchesHtml()}${credit}</div>`;
}
/**
 * The Best Margins rows (or, with none yet, a line saying so). `ranked` puts each
 * player's place before them (tied margins share one, as "Best today · #2" counts);
 * `from` draws only the rows from there on (the rest are already in the list).
 */
function puzzleRowsHtml(info, size = 19, { ranked = false, from = 0 } = {}) {
  if (!info.board.length) return `<p class="pb-empty">No scores yet.<br>Be the first!</p>`;
  const places = info.board.map((row, i, all) => all.findIndex((other) => other.score === row.score) + 1);
  return info.board
    .map((row, i) => {
      if (i < from) return "";
      // first place in gold, the rest in the card's color: avatar and score alike;
      // each row opens that player's profile
      const tag = row.id ? "button" : "div";
      const attrs = row.id ? ` type="button" data-stats-player="${e(row.id)}" aria-label="${ranked ? `${places[i]}. ` : ""}${e(row.name)}'s profile"` : "";
      return `<${tag}${attrs} class="pb-row${i === 0 ? " first" : ""}${ranked ? " ranked" : ""}" style="--i:${Math.min(i, 6)}">${ranked ? `<span class="pb-rank">${places[i]}</span>` : ""}<span class="pb-ava">${icon(avatarIcon(row.avatar), size, { idle: false })}</span><span class="pb-name">${row.mine ? youStar() : row.friend ? friendMark() : ""}${e(row.name)}${row.mmr != null ? `<small class="pb-mmr">${statNumber(row.mmr)}${row.provisional ? "?" : ""}</small>` : ""}</span><span class="pb-score">${stickerText(puzzleMargin(row.score), { key: `pb:${i}` })}${ranked ? stickerText("pts", { cls: "pts", key: `pb-pts:${i}` }) : ""}</span></${tag}>`;
    })
    .join("");
}
/* More of the day's scores are fetched as the list is scrolled toward its end. */
const PUZZLE_ROWS = 8,
  PUZZLE_MOST = 50; // (as many as the server keeps on the day's board)
let puzzleRowsLoading = false;
const puzzleMoreToCome = (info) => info.board.length > 0 && info.board.length < Math.min(info.players, PUZZLE_MOST);
async function morePuzzleScores(list) {
  const info = homeData.puzzle;
  if (puzzleRowsLoading || !info || !puzzleMoreToCome(info)) return;
  puzzleRowsLoading = true;
  try {
    const next = await api(`/api/puzzle?limit=${Math.min(PUZZLE_MOST, info.board.length + PUZZLE_ROWS)}`);
    if (homeData.puzzle !== info) return;
    if (next.board.length <= info.board.length) {
      // (nothing more after all: the loading line goes)
      info.players = info.board.length;
      list.querySelector(".pb-loading")?.remove();
      return;
    }
    const had = info.board.length;
    info.board = next.board;
    info.players = next.players;
    if (!list.isConnected) return;
    // (only the new rows are added, above the loading line: the list keeps its place,
    // and the line stays put until there are no more to come)
    const rows = list.querySelector(".pb-list") || list;
    const loading = rows.querySelector(".pb-loading");
    (loading || rows).insertAdjacentHTML(loading ? "beforebegin" : "beforeend", puzzleRowsHtml({ board: next.board }, 19, { from: had }));
    if (!puzzleMoreToCome(info)) loading?.remove();
  } catch {
    // (tried again the next time the end comes into view)
  } finally {
    puzzleRowsLoading = false;
  }
}
document.addEventListener(
  "scroll",
  (event) => {
    const list = event.target;
    if (list?.dataset?.pbList === undefined) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 40) morePuzzleScores(list);
  },
  true,
);
/** Today's puzzle: the starting hand, the best margins so far, and the button to play it. */
function puzzleHtml() {
  const info = homeData.puzzle;
  if (!info) return `<section class="home-section puzzle-section">${tabTitle("Daily Puzzle", "", "puzzle")}<div class="loading">Dealing today's puzzle…</div></section>`;
  const hand = exampleHand(info.hand.map((slot) => (slot.card ? slot.card.label + slot.card.suit : null)));
  // every score fetched so far, a set gap apart, in a list that scrolls inside the card
  // (more are fetched as its end comes into view: see morePuzzleScores)
  const board = boxed("c-p1", "Best Margins", `<div class="pb-scroll" data-pb-list><div class="pb-list${info.board.length ? "" : " empty"}">${puzzleRowsHtml(info)}${puzzleMoreToCome(info) ? `<p class="pb-empty pb-loading">Loading…</p>` : ""}</div></div>`, "puzzle-board");
  // how you have done today sits under the title, as a tab's subtitle does
  const mine = info.best == null ? "" : `Your best: ${puzzleMargin(info.best)}${info.rank ? ` · #${info.rank}` : ""} · can you do better?`;
  // (before your first finish, what the puzzle asks of you)
  const tagline = `In ${info.moves ?? 5} moves, get the biggest margin vs PuzzleBot`;
  return `<section class="home-section puzzle-section">${tabTitle(`Daily Puzzle #${info.number}`, e(mine || tagline), "puzzle")}<div class="puzzle-row"><div class="puzzle-hand">${hand}</div>${board}</div>
    <button type="button" class="btn c-p1 solve-btn" data-puzzle-start>${tilted("puzzlepiece.fill", 30)}<span>Solve Puzzle</span>${tilted("puzzlepiece.fill", 30, { mirror: true })}</button></section>`;
}
async function startPuzzle() {
  const epoch = tableEpoch;
  if (session.room_id && !(await abandonExisting())) return;
  const next = await api("/api/puzzle", "POST", {});
  if (epoch === tableEpoch) enterRoom(next);
}
/** Every best score today (the panel only has room for four). */
async function puzzleBoardSheet() {
  const info = await api("/api/puzzle?limit=50");
  openSheet(`<section class="sheet c-p1" role="dialog" aria-modal="true" aria-label="Best margins">
    <div class="sheet-head"><h2>Puzzle #${info.number}</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    <p class="hint dark">Today's biggest margins: PuzzleBot's points minus yours, so higher is better. Everyone plays the same deal; it changes at midnight.</p>
    <div class="list leader-list">${info.board.map((row, i) => `<div class="list-item board-row ${i === 0 ? "c-p3" : "c-fw"}${row.mine ? " mine" : ""}" style="--i:${i}"><span class="rank">${i === 0 ? tilted("trophy.fill", 30, { key: "pz-first" }) : stickerText(String(i + 1), { key: `pz-rank:${i}` })}</span><span class="pb-ava">${icon(avatarIcon(row.avatar), 26, { idle: false })}</span><div class="grow"><strong>${row.mine ? youStar() : row.friend ? friendMark() : ""}${e(row.name)}</strong><small>${row.attempts} ${row.attempts === 1 ? "attempt" : "attempts"}</small></div><b class="rate">${puzzleMargin(row.score)}</b></div>`).join("") || `<p class="hint dark">No margins yet today.</p>`}</div>
  </section>`);
}
/** Your friends and what they are up to, busiest first. */
function friendsHtml() {
  const info = homeData.friends;
  const add = `<button type="button" class="friends-add" data-friends-sheet>${icon("person.fill.badge.plus", 22, { idle: false })}<span>${info?.incoming?.length ? `Friend requests (${info.incoming.length})` : "Add a friend"}</span></button>`;
  if (!info) return boxed("c-fw", "Friends", `<div class="loading">Loading friends…</div>`, "friends-box");
  if (!info.signed_in)
    return boxed("c-fw", "Friends", `<p class="friends-empty">Sign in to add friends and see when they're playing.</p>${signInButton("small c-p1", `${tilted("person.crop.circle.fill", 22)}Sign in`)}`, "friends-box");
  const rows = info.friends.map((friend, i) => {
    const status = friendStatus(friend);
    // (a game, or the Daily Puzzle: either one watched the same way)
    const playing = friend.status === "in_game" || friend.status === "puzzle";
    const watch = playing && friend.room_id ? `<button type="button" class="friend-watch" data-watch="${e(friend.room_id)}" aria-label="Watch ${e(friend.display_name)}">${tilted("binoculars.fill", 28, { key: `fw:${i}` })}</button>` : "";
    // (in a game: the points they have showing, as stickers, in place of the words)
    const points = playing && friend.points != null
      ? `<span class="friend-pts" aria-label="${e(`${status}: ${friend.points} points`)}">${stickerText(String(friend.points), { split: true, idle: false, key: `fp:${i}` })}${stickerText("pts", { cls: "pts", idle: false, key: `fpp:${i}` })}</span>`
      : `<span class="friend-status">${status}</span>`;
    return `<div class="friend-row ${friend.status}" style="--i:${i}"><span class="friend-ava">${tilted(avatarIcon(friend.avatar), 34, { key: `fa:${friend.unique_name}` })}</span><button type="button" class="friend-name" data-stats-player="${e(friend.id)}" aria-label="${e(friend.display_name)}'s profile"><b>${e(friend.display_name)}</b>${friend.mmr != null ? `<small>${statNumber(friend.mmr)}</small>` : ""}</button>${points}${watch}</div>`;
  }).join("");
  return boxed("c-fw", "Friends", `${rows || `<p class="friends-empty">No friends yet. Add someone by their @name.</p>`}${add}`, "friends-box");
}
function friendStatus(friend) {
  if (friend.status === "in_game") return friend.solo ? "Playing Golfbot" : "In-game";
  if (friend.status === "puzzle") return "Solving the puzzle";
  if (friend.status === "online") return "Online";
  return friend.last_seen ? `Active ${agoShort(friend.last_seen)}` : "Offline";
}
function friendsSheet() {
  const info = homeData.friends || { friends: [], incoming: [], outgoing: [] };
  // each person's card, and beside it, outside the card, what can be done: each an icon
  // over its word (as inviting a player does); "Asked" on the card while it waits
  const row = (friend, actions, i, note = "") => `<div class="invite-row friend-req-row" style="--i:${i}"><div class="list-item c-fw friend-req grow">${avatarBadge(friend.avatar)}<div class="grow"><strong>${e(friend.display_name)}</strong><small>@${e(friend.unique_name)}</small></div>${note}</div>${actions}</div>`;
  const act = (attr, who, color, symbol, label, aria) => `<button type="button" class="close-btn ${color}" ${attr}="${e(who.unique_name)}" aria-label="${e(aria)}">${icon(symbol, 30)}<span>${label}</span></button>`;
  const incoming = info.incoming.map((friend, i) => row(friend, act("data-friend-accept", friend, "c-p1", "checkmark.circle.fill", "Accept", `Accept ${friend.display_name}`) + act("data-friend-remove", friend, "c-p2", "xmark.circle.fill", "Decline", `Decline ${friend.display_name}`), i)).join("");
  const outgoing = info.outgoing.map((friend, i) => row(friend, act("data-friend-remove", friend, "c-p2", "xmark.circle.fill", "Cancel", `Cancel the request to ${friend.display_name}`), i, `<span class="hint dark">Asked</span>`)).join("");
  const friends = info.friends.map((friend, i) => row(friend, act("data-friend-remove", friend, "c-p2", "trash.fill", "Remove", `Remove ${friend.display_name}`), i)).join("");
  openSheet(`<section class="sheet c-fw friends-sheet" role="dialog" aria-modal="true" aria-label="Friends">
    <div class="sheet-head"><h2>Friends</h2><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    <form id="friend-add-form" class="stack friend-add-form">${field("Add by @name", `<input id="friend-name" name="unique_name" maxlength="25" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="@name" aria-label="Their unique name" required>`, "person.fill.badge.plus")}<button type="submit" class="btn c-p1">${tilted("plus.circle.fill", 26)}<span>Send friend request</span></button></form>
    ${incoming ? `<h3 class="sheet-sub">Asking to be your friend</h3><div class="list">${incoming}</div>` : ""}
    ${outgoing ? `<h3 class="sheet-sub">Waiting on them</h3><div class="list">${outgoing}</div>` : ""}
    ${friends ? `<h3 class="sheet-sub">Your friends</h3><div class="list">${friends}</div>` : ""}
  </section>`);
}
async function refreshFriends() {
  homeData.friends = await api("/api/friends");
  renderFriendBadge();
  redrawPane("play");
  if (sheetRoot.querySelector?.(".friends-sheet")) friendsSheet();
}
async function friendAction(url, method) {
  await api(url, method, method === "POST" ? {} : undefined);
  await refreshFriends();
}
document.addEventListener("submit", async (event) => {
  if (event.target.id !== "friend-add-form") return;
  event.preventDefault();
  const input = document.getElementById("friend-name");
  const name = input.value.trim().replace(/^@/, "");
  if (!name) return;
  try {
    const result = await api("/api/friends", "POST", { unique_name: name });
    toast(result.outcome === "accepted" ? `You and @${result.unique_name} are now friends!` : result.outcome === "friends" ? `You're already friends with @${result.unique_name}.` : `Friend request sent to @${result.unique_name}.`);
    input.value = "";
    await refreshFriends();
  } catch (error) {
    toast(error.message);
  }
});
/** Your last few matches: what kind of game, who played (the winner in yellow) with their MMR, and how long ago. */
function matchesHtml() {
  const matches = homeData.matches;
  if (!matches) return boxed("c-fw", "Match History", `<div class="loading">Loading…</div>`, "history-box");
  const rows = matches.map((match, i) => {
    const names = match.names.map((name, seat) => (match.solo && seat === 1 ? "Golfbot" : name));
    // the rules it was played with: House, Vanilla or custom
    const [kind, rulesName] = rulesIcon(match);
    // who won the series (or, with none decided, who has the fewest points)
    const points = match.points || [];
    const low = Math.min(...points);
    const winner = match.winner ?? (points.filter((p) => p === low).length === 1 ? points.indexOf(low) : null);
    // a Ranked series moved each player's MMR: by how much, beside what it is now
    const moved = [...match.rounds].reverse().find((game) => Array.isArray(game.mmr))?.mmr;
    const players = names.map((name, seat) => {
      // the avatar they played with (yours, as it is now, where an older match saved none);
      // the winner has a trophy in its place
      const avatar = match.avatars?.[seat] || (match.solo && seat === 1 ? "golfbot" : match.viewer === seat ? session.avatar : null);
      const face = seat === winner ? icon("trophy.fill", 20, { idle: false }) : avatar ? icon(avatarIcon(avatar), 20, { idle: false }) : icon("person.fill", 18, { idle: false });
      return `<span class="mh-player${seat === winner ? " won" : ""}"><span class="mh-ava">${face}</span>${nameMark(match.participants?.[seat]?.id, match.viewer === seat)}<b>${e(name)}</b>${mmrChange(moved?.[seat]?.delta)}</span>`;
    }).join("");
    // when its last game ended, on the right
    const ended = match.last_game_ended_at || Math.max(0, ...match.rounds.map((game) => game.ended_at || 0)) || match.updated_at;
    return `${i ? `<hr class="mh-rule">` : ""}<button type="button" class="mh-row" style="--i:${Math.min(i, 3)}" data-match-open="${i}" aria-label="Match details"><span class="mh-kind c-p1" role="img" aria-label="${rulesName}" title="${rulesName}">${tilted(kind, 21, { key: `mh:${i}` })}</span><div class="mh-players">${players}</div><time class="mh-when" datetime="${new Date(ended * 1000).toISOString()}">${e(agoShort(ended))}</time></button>`;
  }).join("");
  // (with more of them saved, the next few are fetched as the end of the card comes into view)
  const more = homeData.matchesNext != null ? `<div class="mh-more" data-mh-more><span class="loading">Loading more…</span></div>` : "";
  return boxed("c-fw", "Match History", (rows || `<p class="friends-empty">Finish a game and it shows up here.</p>`) + more, "history-box");
}
/** How far a series moved someone's MMR: "+12 MMR" in green, "−9 MMR" in red (nothing where it did not). */
function mmrChange(delta) {
  if (typeof delta !== "number" || !delta) return "";
  return `<span class="mh-delta ${delta > 0 ? "up" : "down"}" aria-label="${delta > 0 ? "gained" : "lost"} ${Math.abs(delta)} MMR">${delta > 0 ? "+" : "−"}${Math.abs(delta)} MMR</span>`;
}
/* More of your matches load as the end of the card scrolls into view. */
const MATCH_BATCH = 6;
let matchesLoading = false;
const matchesEnd =
  typeof IntersectionObserver === "function"
    ? new IntersectionObserver((entries) => entries.some((entry) => entry.isIntersecting) && loadMoreMatches(), { rootMargin: "240px 0px" })
    : null;
/** Watch for the end of the Match History card (the one on the page showing) coming into view. */
function watchMatchesEnd() {
  if (!matchesEnd) return;
  matchesEnd.disconnect();
  const end = root.querySelector(`${LIVE_PANE} [data-mh-more]`);
  if (end) matchesEnd.observe(end);
}
async function loadMoreMatches() {
  const offset = homeData.matchesNext;
  if (matchesLoading || offset == null || page !== "home" || homeTab !== "play") return;
  matchesLoading = true;
  try {
    const next = await api(`/api/history?mine=true&limit=${MATCH_BATCH}&offset=${offset}`);
    if (homeData.matchesNext !== offset) return; // (the list was fetched afresh meanwhile)
    const have = new Set(homeData.matches.map((match) => match.id));
    homeData.matches = [...homeData.matches, ...next.matches.filter((match) => !have.has(match.id))];
    homeData.matchesNext = next.next_offset;
    whenHomeQuiet("draw:play", () => redrawPane("play"));
  } catch {
    // (it is tried again the next time the end of the card comes into view)
  } finally {
    matchesLoading = false;
  }
}
/** Start a Game: the button above the tab bar, and the ways to play that open from it. */
/** One of your matches in full: what its card on the Match history page says, as the sheet itself. */
function matchSheet(match) {
  if (!match) return;
  openSheet(`<section class="sheet c-fw match-sheet" role="dialog" aria-modal="true" aria-label="Match details">
    <div class="sheet-head"><div class="match-head"><h2>${e(match.lobby_name)}</h2>${matchMetaHtml(match)}</div><button type="button" class="close-btn" data-sheet-close>${icon("xmark.circle.fill", 44)}<span>${padTag("b")}Close</span></button></div>
    ${matchArticleHtml(match, true)}
    <button type="button" class="btn small c-fw" data-nav="history">${tilted("clock.arrow.circlepath", 22)}All match history</button>
  </section>`);
}
function startGameHtml() {
  const twin = (name, size = 30) => [tilted(name, size), tilted(name, size, { mirror: true })];
  const mode = (attrs, color, symbol, title, sub, extra = "") => {
    const [a, b] = twin(symbol);
    return `<button type="button" class="btn ${color} start-mode" ${attrs}>${a}<span>${title}<span class="sub"${sub.startsWith("id=") ? ` ${sub}` : ""}>${sub.startsWith("id=") ? "" : sub}</span></span>${b}${extra}</button>`;
  };
  const queued = ["waiting", "offer"].includes(presenceState.queue?.status);
  return `<div class="start-game${startOpen ? " open" : ""}" data-start-game>
    <div class="start-modes" id="start-modes" ${startOpen ? "" : "hidden"}>
      ${session.room_id ? mode('data-nav="resume"', "c-fw", "play.fill", "Resume your table", "Pick up where you left off") : ""}
      ${mode('data-nav="friends"', "c-p1", "figure.2", "Play with Friends", "Host or join a table", `<span id="lobby-count" class="badge" hidden></span>`)}
      ${mode("data-queue-toggle", "c-p3", "sparkles", "Play Ranked", 'id="queue-sub"', `<span id="queue-count" class="badge" hidden></span>`)}
      ${mode('data-nav="solo"', "c-p2", "dumbbell.fill", "Play Solo", "Test your skills vs Golfbot")}
      ${mode('data-nav="rules"', "c-p4", "brain.fill", "Learn Rules", "See how every rule plays")}
      ${mode('data-nav="passplay"', "c-s7 c-passplay", "person.2.fill", "Pass &amp; Play", "Share one device")}
      ${document.documentElement.dataset?.debug !== undefined ? mode("data-debug-bots", "c-fw", "ladybug.fill", "Debug Table", "You and seven bots") : ""}
    </div>
    <button type="button" class="btn start-btn c-p3${startOpen ? " dimmed" : ""}" data-start-toggle aria-expanded="${startOpen}" aria-controls="start-modes">${startOpen ? `<span>Close</span>` : `${twin("figure.golf")[0]}<span>Start a Game${queued ? `<span class="sub">${e(queueLabel())}</span>` : ""}</span>${twin("figure.golf")[1]}${startCorner()}`}</button>
  </div>`;
}
/** Start a Game says when you are in the Ranked queue (a match found shows on the pill up top). */
// how many are waiting in the Ranked queue, on Start a Game's corner (and on the Play tab's icon)
const QUEUE_BADGE = `<span id="queue-count-start" class="badge" hidden></span>`;
// Start a Game's corner: a play mark when you have a table to go back to (Resume is
// in the list it opens), beside the Ranked queue's count
const startCorner = () =>
  `<span class="start-corner">${session.room_id ? `<span class="resume-badge c-fw" role="img" aria-label="You have a table to resume">${tilted("play.fill", 30, { key: "resume-badge" })}</span>` : ""}${QUEUE_BADGE}</span>`;
function renderStartLabel() {
  const button = root.querySelector(".start-btn");
  if (!button || startOpen) return;
  const label = ["waiting", "offer"].includes(presenceState.queue?.status) ? queueLabel() : "";
  const sub = button.querySelector(".sub");
  if ((sub?.textContent || "") === label) return;
  const twin = [tilted("figure.golf", 30), tilted("figure.golf", 30, { mirror: true })];
  button.innerHTML = `${twin[0]}<span>Start a Game${label ? `<span class="sub">${e(label)}</span>` : ""}</span>${twin[1]}${startCorner()}`;
  // (the badge just redrawn gets its count back)
  const waiting = presenceState.queue_size || 0;
  setCount("queue-count-start", waiting, `${waiting} ${waiting === 1 ? "player" : "players"} in queue`);
}
/** Open or close the Start a Game list: the ways to play rise up one after another. */
function setStartOpen(open, quietly = false) {
  if (startOpen === open && !quietly) return;
  const was = startOpen;
  startOpen = open;
  const holder = root.querySelector("[data-start-game]");
  const scrim = root.querySelector(".start-scrim");
  if (scrim) {
    scrim.hidden = !open;
    if (open && !reducedMotion.matches && scrim.animate) scrim.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
  }
  if (!holder || was === open) return;
  const template = document.createElement("template");
  template.innerHTML = startGameHtml();
  holder.replaceWith(template.content.firstElementChild);
  renderHomeLive();
  const modes = root.querySelectorAll(".start-mode");
  const button = root.querySelector(".start-btn");
  if (reducedMotion.matches || !button?.animate) return;
  button.animate([{ scale: "0.94" }, { scale: "1.03" }, { scale: "1" }], { duration: 320, easing: "ease-out" });
  if (open)
    [...modes].reverse().forEach((el, i) =>
      el.animate([{ translate: "0 2.4rem", scale: "0.86", opacity: 0 }, { translate: "0 0", scale: "1", opacity: 1 }], { duration: 420, delay: i * 45, easing: "cubic-bezier(0.22, 1.35, 0.36, 1)", fill: "backwards" }),
    );
  if (open) haptic("snap");
}

/* ---------- Watch ---------- */
function watchPaneHtml() {
  const games = homeData.games;
  if (!games) return `<div class="tab-body">${tabTitle("PvP Games", "Watch golfers battle it out live!", "watch-pvp")}<div class="loading">Finding games…</div></div>`;
  // (a tournament's matches are followed from its card, not listed with the other games)
  const others = games.filter((game) => !game.mine && !game.tournament);
  const pvp = others.filter((game) => !game.solo);
  const solo = others.filter((game) => game.solo);
  const cups = (homeData.cups || []).filter((cup) => cup.status === "live").map((cup, i) => cupCardHtml(cup, i)).join("");
  const cards = (list) => list.map((game, i) => watchCardHtml(game, i)).join("");
  const empty = (text) => `<p class="watch-empty">${text}</p>`;
  const pvpTitle = tabTitle("PvP Games", "Watch golfers battle it out live!", "watch-pvp");
  return `<div class="tab-body watch-body">
    ${cups ? `${tabTitle("Tournaments", "Golf tournaments being played right now!", "watch-cups")}<div class="watch-cards cup-cards">${cups}</div>` : ""}
    ${pvpTitle}
    <div class="watch-cards">${cards(pvp) || empty("No games between players right now.")}</div>
    ${tabTitle("Solo Games", "Play until they leave against Golfbot!", "watch-solo")}
    <div class="watch-cards">${cards(solo) || empty("Nobody is playing Golfbot right now.")}</div>
  </div>`;
}
/** Look for games again; the Refresh arrow turns once round to show it. */
async function refreshWatch() {
  const arrow = root.querySelector(".tab-pane:not(.neighbor):not(.parked):not(.staged) .watch-refresh .ico");
  if (arrow?.animate && !reducedMotion.matches)
    arrow.animate([{ transform: "rotate(0deg)" }, { transform: "rotate(360deg)" }], { duration: 700, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  tabRefreshAt = performance.now(); // (the next look by itself waits its full turn from now)
  await loadTab("watch");
}
/** A tournament on Watch: its format and size, when it began, its matches in play and who is watching. */
const CUP_FORMATS = { single: "Single Elim", double: "Double Elim", round_robin: "Round Robin" };
function cupCardHtml(cup, i) {
  const label = `${CUP_FORMATS[cup.format] || e(cup.format_name || "")} · ${cup.entrants}-players`;
  const [kind, rulesName] = rulesIcon(cup.settings || {});
  const live = `${cup.live} match${cup.live === 1 ? "" : "es"} in play`;
  const watching = cup.watchers ? `${cup.watchers} spectating now` : "Tap to follow!";
  return `<button type="button" class="watch-card cup-card boxed c-s4" data-tournament-open="${e(cup.id)}" style="--i:${i}" aria-label="${e(cup.name)}: ${live}"><span class="box-label">${label}</span><span class="box-label right">${e(agoShort(cup.started_at || cup.created_at))}</span><div class="cup-main"><span class="cup-trophy">${tilted("trophy.fill", 40, { key: `cup:${cup.id}`, sw: 4 })}</span><div class="cup-text"><b class="cup-name">${e(cup.name)}</b><span class="cup-live">${tilted("figure.golf", 24, { key: `cupg:${i}` })}<span>${live}</span></span></div></div><div class="wc-foot">${tilted("binoculars.fill", 24, { key: `cupb:${i}` })}<span>${watching}</span><span class="wc-kind" role="img" aria-label="${rulesName}" title="${rulesName}">${tilted(kind, 24, { key: `cupk:${i}` })}</span></div></button>`;
}
function watchCardHtml(game, i) {
  const series = game.best_of == null ? "" : game.series_mode === "points" ? "Total pts" : "Best of";
  const label = `Game ${game.round}${game.best_of != null ? ` of ${game.best_of}` : ""}${series ? ` · ${series}` : ""}${game.tournament ? ` · ${e(game.tournament.name)}` : ""}`;
  const total = (p) => (game.points?.[p] ?? 0) + (game.scores?.[p] ?? 0);
  // a finished series: the winner (if there is one) has the trophy, everyone else is greyed
  const finished = !!game.finished,
    champion = finished ? game.champion : null;
  const standing = (p) => (!finished ? "live" : champion == null ? "drew" : p === champion ? "won" : "lost");
  // (best placed first: most wins, then fewest points; a series by points, fewest points)
  const byPoints = game.best_of != null && game.series_mode === "points";
  const order = game.names.map((_, p) => p).sort((a, b) => (byPoints ? 0 : (game.wins?.[b] ?? 0) - (game.wins?.[a] ?? 0)) || total(a) - total(b) || a - b);
  const players = order.map((p) => {
    const name = game.names[p];
    const color = SEAT_COLORS[p % SEAT_COLORS.length];
    const avatar = game.avatars?.[p];
    const mmr = game.mmr?.[p];
    const big = (value, unit, k) => `<span class="wc-score" data-k="${k}" data-v="${value}">${stickerText(String(value), { split: true, key: `wc:${game.id}:${p}:${k}` })}${stickerText(unit, { cls: "pts", key: `wcu:${game.id}:${p}:${k}` })}</span>`;
    const scores = game.best_of == null ? `<span class="wc-pair">${big(game.wins?.[p] ?? 0, "wins", "w")}${big(total(p), "pts", "p")}</span>` : game.series_mode === "points" ? big(total(p), "pts", "p") : big(game.wins?.[p] ?? 0, "wins", "w");
    const state = standing(p);
    const face = state === "won" ? `<span class="wc-trophy">${icon("trophy.fill", 20, { idle: false })}</span>` : avatar ? icon(avatarIcon(avatar), 20, { idle: false }) : "";
    // (what the patch on a refresh compares: its scores and how it stands)
    const sig = `${game.wins?.[p] ?? 0}/${total(p)}/${state}`;
    return `<div class="wc-player ${color} ${state}" data-seat="${p}" data-sig="${sig}"><span class="wc-who">${face}<span><b>${game.friends?.[p] ? friendMark() : ""}${e(name)}</b>${mmr != null ? `<small>${statNumber(mmr)}MMR</small>` : ""}</span></span>${scores}</div>`;
  }).join("");
  const [kind, rulesName] = rulesIcon(game);
  const watching = finished ? (champion == null ? "A draw!" : `${e(game.names[champion])} won!`) : game.watchers ? `${game.watchers} spectating now` : "Tap to spectate!";
  return `<button type="button" class="watch-card boxed c-s4${finished ? " finished" : ""}" data-watch="${e(game.id)}" style="--i:${i}" aria-label="Watch ${e(game.names.join(" vs "))}"><span class="box-label">${label}</span><span class="box-label right">${finished ? "Final" : e(agoShort(game.started_at))}</span><div class="wc-players n${Math.min(game.names.length, 5)}">${players}</div><div class="wc-foot">${tilted(finished ? "trophy.fill" : "binoculars.fill", 24, { key: `wcb:${i}` })}<span>${watching}</span><span class="wc-kind" role="img" aria-label="${rulesName}" title="${rulesName}">${tilted(kind, 24, { key: `wck:${i}` })}</span></div></button>`;
}

/* ---------- Watch, patched in place ----------
   A refresh of Watch changes only what changed: each card is matched to the game it
   shows. A score that moved pops; a series that finished turns its winner's avatar into
   a trophy and greys everyone else; a game that has gone (a finished one, a minute
   later) fades out and folds away; a new one pops in. */
const watchMoving = () => !reducedMotion.matches && !!Element.prototype.animate;
function patchWatch(pane, fresh) {
  const was = pane.querySelector(".watch-body"),
    now = fresh.querySelector(".watch-body");
  if (!was || !now) return false;
  // the page around the cards must be the same (titles, which sections, empty notes)
  const frame = (body) => [...body.children].map((el) => (el.matches(".watch-cards") ? `cards:${[...el.children].some((c) => c.matches(".watch-empty"))}` : el.matches(".list") ? "list" : `${el.className}:${el.textContent.trim()}`)).join("|");
  if (frame(was) !== frame(now)) return false;
  [...was.children].forEach((el, i) => {
    const next = now.children[i];
    if (el.matches(".list")) morphChildren(el, next);
    else if (el.matches(".watch-cards")) {
      if ([...next.children].some((c) => c.matches(".watch-empty"))) morphChildren(el, next);
      else patchWatchCards(el, next);
    }
  });
  return true;
}
/** Whatever a Watch card was doing when its page was left is finished: a card that was
 * fading away is gone, and nothing is left held part-way (a page put away mid-fade had
 * its animations stop where they were, which left blank spaces among the cards). */
function settleWatch(scope) {
  for (const card of scope.querySelectorAll(".watch-card.wc-going")) card.remove();
  for (const el of scope.querySelectorAll(".watch-card, .watch-card *"))
    for (const animation of el.getAnimations?.() || []) if (!animation.animationName) animation.finish?.();
}
function patchWatchCards(list, fresh) {
  // (only a page in view animates: one being put away just takes the new state)
  const moving = watchMoving() && !!list.closest(LIVE_PANE);
  settleWatch(list);
  // (a game's card by its table, a tournament's by the tournament)
  const id = (card) => card.dataset.watch || card.dataset.tournamentOpen;
  const old = new Map([...list.querySelectorAll(":scope > .watch-card:not(.wc-going)")].map((card) => [id(card), card]));
  // The cards already showing keep their places: the order is the server's (friends' games,
  // then the busiest) only as the tab is first drawn, and a refresh never shuffles them. A
  // new game takes the place the server gives it among them.
  const incoming = [...fresh.children];
  const added = [];
  for (const [i, card] of incoming.entries()) {
    const kept = old.get(id(card));
    if (kept) {
      old.delete(id(card));
      patchWatchCard(kept, card, moving);
    } else {
      // (at the place the server gives it, counted among the cards showing)
      const showing = [...list.querySelectorAll(":scope > .watch-card:not(.wc-going)")];
      list.insertBefore(card, showing[i] || null);
      added.push(card);
    }
  }
  // a new one pops in: animated once it is on the page (an element still in the template
  // belongs to a document whose clock never runs, and its animation never moved on)
  if (moving) for (const card of added) card.animate([{ opacity: 0, scale: "0.92" }, { opacity: 1, scale: "1" }], { duration: 420, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
  // gone: it fades out, then folds away
  for (const card of old.values()) {
    if (!moving) {
      card.remove();
      continue;
    }
    card.classList.add("wc-going");
    const fade = card.animate([{ opacity: 1, scale: "1" }, { opacity: 0, scale: "0.94" }], { duration: 420, easing: "ease-in", fill: "forwards" });
    fade.onfinish = () => {
      if (!card.isConnected) return;
      const fold = card.animate([{ height: `${card.offsetHeight}px` }, { height: "0px", marginTop: "-1.6rem" }], { duration: 300, easing: "ease-in-out", fill: "forwards" });
      fold.onfinish = () => card.remove();
    };
    // (gone in any case, should its animations not finish: the page put away part-way)
    setTimeout(() => card.remove(), 900);
  }
}
function patchWatchCard(card, fresh, moving) {
  const players = card.querySelectorAll(".wc-player"),
    next = fresh.querySelectorAll(".wc-player");
  if (players.length !== next.length) return void card.replaceWith(fresh);
  const ending = fresh.classList.contains("finished") && !card.classList.contains("finished");
  card.className = fresh.className;
  card.setAttribute("aria-label", fresh.getAttribute("aria-label"));
  // the labels on its edge, and its foot, if they changed
  const swap = (selector, i = 0) => {
    const a = card.querySelectorAll(selector)[i],
      b = fresh.querySelectorAll(selector)[i];
    if (a && b && a.textContent !== b.textContent) a.replaceWith(b);
  };
  swap(".box-label", 0);
  swap(".box-label", 1);
  swap(".wc-foot");
  swap(".cup-live");
  // each player by their seat, wherever they now stand; where each stood before, to slide from
  const holder = card.querySelector(".wc-players");
  const bySeat = new Map([...players].map((player) => [player.dataset.seat, player]));
  if ([...next].some((nu) => !bySeat.has(nu.dataset.seat))) return void card.replaceWith(fresh);
  const before = new Map([...players].map((player) => [player.dataset.seat, player.getBoundingClientRect()]));
  const placed = [...next].map((nu) => {
    const player = bySeat.get(nu.dataset.seat);
    if (player.dataset.sig === nu.dataset.sig) return player;
    const was = player.className;
    const values = Object.fromEntries([...player.querySelectorAll(".wc-score")].map((score) => [score.dataset.k, score.dataset.v]));
    player.replaceWith(nu);
    if (!moving) return nu;
    // a score that moved pops
    for (const score of nu.querySelectorAll(".wc-score"))
      if (values[score.dataset.k] !== undefined && values[score.dataset.k] !== score.dataset.v)
        score.animate([{ scale: "1" }, { scale: "1.3" }, { scale: "1" }], { duration: 520, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
    // the winner's trophy drops in; everyone else greys
    if (nu.classList.contains("won") && !was.includes("won"))
      nu.querySelector(".wc-trophy")?.animate([{ scale: "0", rotate: "-40deg" }, { scale: "1.25", rotate: "8deg", offset: 0.6 }, { scale: "1", rotate: "0deg" }], { duration: 700, delay: 200, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "backwards" });
    if (nu.classList.contains("lost") && !was.includes("lost"))
      nu.animate([{ filter: "grayscale(0)", opacity: 1 }, { filter: "grayscale(1)", opacity: 0.5 }], { duration: 700, easing: "ease-out" });
    return nu;
  });
  // into their new order; anyone who moved slides there from where they were
  if (holder && placed.some((player, i) => holder.children[i] !== player)) {
    placed.forEach((player) => holder.appendChild(player));
    if (moving)
      for (const player of placed) {
        const was = before.get(player.dataset.seat),
          now = player.getBoundingClientRect();
        const dx = was.left - now.left,
          dy = was.top - now.top;
        if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)
          player.animate([{ translate: `${dx}px ${dy}px` }, { translate: "0 0" }], { duration: 560, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      }
  }
  // the whole card gives a little hop as its series ends
  if (ending && moving) card.animate([{ scale: "1" }, { scale: "1.035" }, { scale: "1" }], { duration: 520, easing: "cubic-bezier(0.34, 1.56, 0.64, 1)" });
}

/* ---------- Aces ---------- */
function acesTabsHtml() {
  // (one arrow for the strip, over the view showing: it slides across when the view changes)
  const at = Math.max(0, ACES_VIEWS.findIndex((view) => view.key === acesView));
  return `<nav class="aces-tabs top-tabs c-fw" aria-label="Aces" style="--at:${at}"><span class="aces-pointer c-p2" aria-hidden="true">${icon("chevron.up", 15, { idle: false, sw: 4.2 })}</span>${ACES_VIEWS.map((view, i) => `<button type="button" class="aces-tab${view.key === acesView ? " on c-p2" : ""}" data-aces-view="${view.key}" aria-pressed="${view.key === acesView}">${tilted(view.symbol, 26, { key: `aces:${view.key}`, tilt: [-6, 0, 6][i] })}<span>${view.label}</span></button>`).join("")}</nav>`;
}
function acesPaneHtml() {
  const boards = homeData.boards;
  const head = {
    records: tabTitle("All Time Records", "Check out what the Aces have achieved!", "aces-records"),
    solo: tabTitle("Solo Streaks", "The longest win streaks against Golfbot", "aces-solo"),
    pvp: tabTitle("PvP Rankings", "Ranked by MMR from Ranked series", "aces-pvp"),
  }[acesView];
  // (the strip of views at the top of each, under the logo: it moves with its page)
  if (!boards) return `<div class="tab-body aces-body" data-aces="${acesView}">${acesTabsHtml()}${head}<div class="loading">Loading…</div></div>`;
  const body = acesView === "records" ? recordsBody(boards.records, boards.personal) : leaderboardBody(acesView, boards);
  return `<div class="tab-body aces-body" data-aces="${acesView}">${acesTabsHtml()}${head}<div class="leader-body">${body}</div></div>`;
}
/** Aces is showing `view`: its button on the strip lights up. */
function markAcesView(view) {
  acesView = view;
  // the arrow slides across to the view now showing (from wherever it had got to)
  const strip = root.querySelector(`[data-tab-stage] ${LIVE_PANE}[data-pane="aces"] .aces-tabs`),
    pointer = strip?.querySelector(".aces-pointer");
  if (pointer) {
    const was = pointer.getBoundingClientRect().left;
    strip.style.setProperty("--at", Math.max(0, ACES_VIEWS.findIndex((item) => item.key === view)));
    const dx = was - pointer.getBoundingClientRect().left;
    pointer.slide?.cancel();
    if (Math.abs(dx) > 0.5 && pointer.animate && !reducedMotion.matches)
      pointer.slide = pointer.animate([{ translate: `${dx}px 0` }, { translate: "0 0" }], { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  }
  root.querySelectorAll(`[data-tab-stage] ${LIVE_PANE}[data-pane="aces"] [data-aces-view]`).forEach((button) => {
    const on = button.dataset.acesView === view;
    button.classList.toggle("on", on);
    button.classList.toggle("c-p2", on);
    button.setAttribute("aria-pressed", String(on));
  });
}
/** Show Aces' `view`: the strip stays where it is, its arrow sliding across, and what is
 *  under it changes in place, the new view coming in from the side it lies on. */
function setAcesView(view) {
  if (view === acesView) return;
  const direction = Math.sign(ACES_VIEWS.findIndex((item) => item.key === view) - ACES_VIEWS.findIndex((item) => item.key === acesView));
  markAcesView(view);
  history.replaceState({}, "", appPath(tabPath("aces")));
  resetPager();
  const body = root.querySelector(`[data-tab-stage] ${LIVE_PANE}[data-pane="aces"] .aces-body`);
  if (!homeData.boards) loadTab("aces");
  if (!body) return;
  const template = document.createElement("template");
  template.innerHTML = acesPaneHtml();
  const fresh = template.content?.firstElementChild;
  if (!fresh) return;
  body.dataset.aces = view;
  // (everything but the strip goes, and the new view's parts take its place)
  [...body.children].forEach((el) => !el.matches(".aces-tabs") && el.remove());
  const parts = [...fresh.children].filter((el) => !el.matches(".aces-tabs"));
  body.append(...parts);
  window.scrollTo({ top: 0, behavior: "instant" });
  if (!reducedMotion.matches && body.animate)
    parts.forEach((el) => el.animate([{ translate: `${direction * 2.4}rem 0`, opacity: 0 }, { translate: "0 0", opacity: 1 }], { duration: 360, easing: "cubic-bezier(0.22, 1, 0.36, 1)" }));
  whenHomeQuiet("stage", restage);
}

/* ---------- You ---------- */
// the You tab's two views, picked on the strip at its top
const YOU_VIEWS = [
  { key: "profile", label: "Profile", symbol: "person.crop.circle.fill" },
  { key: "deck", label: "Your Deck", symbol: "rectangle.stack.fill" },
];
let youView = "profile";
function youTabsHtml() {
  const at = Math.max(0, YOU_VIEWS.findIndex((view) => view.key === youView));
  return `<nav class="aces-tabs top-tabs you-tabs c-fw" aria-label="You" style="--at:${at}"><span class="aces-pointer c-p1" aria-hidden="true">${icon("chevron.up", 15, { idle: false, sw: 4.2 })}</span>${YOU_VIEWS.map((view, i) => `<button type="button" class="aces-tab${view.key === youView ? " on c-p1" : ""}" data-you-view="${view.key}" aria-pressed="${view.key === youView}">${tilted(view.symbol, 26, { key: `you:${view.key}`, tilt: [-6, 6][i] })}<span>${view.label}</span></button>`).join("")}</nav>`;
}
function youPaneHtml() {
  return `<div class="tab-body you-body">${youTabsHtml()}<div class="you-view" data-you-shown="${youView}">${youView === "deck" ? deckHtml() : youProfileHtml()}</div></div>`;
}
/** Show the You tab's `view`: the arrow slides across to it, and the view below it is drawn in. */
function setYouView(view) {
  if (view === youView) return;
  youView = view;
  const strip = root.querySelector(`${LIVE_PANE}[data-pane="you"] .you-tabs`),
    pointer = strip?.querySelector(".aces-pointer");
  if (pointer) {
    const was = pointer.getBoundingClientRect().left;
    strip.style.setProperty("--at", Math.max(0, YOU_VIEWS.findIndex((item) => item.key === view)));
    const dx = was - pointer.getBoundingClientRect().left;
    pointer.slide?.cancel();
    if (Math.abs(dx) > 0.5 && pointer.animate && !reducedMotion.matches)
      pointer.slide = pointer.animate([{ translate: `${dx}px 0` }, { translate: "0 0" }], { duration: 420, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
  }
  strip?.querySelectorAll("[data-you-view]").forEach((button) => {
    const on = button.dataset.youView === view;
    button.classList.toggle("on", on);
    button.classList.toggle("c-p1", on);
    button.setAttribute("aria-pressed", String(on));
  });
  const shown = root.querySelector(`${LIVE_PANE}[data-pane="you"] [data-you-shown]`);
  if (!shown) return;
  shown.dataset.youShown = view;
  deckPick = null;
  shown.innerHTML = view === "deck" ? deckHtml() : youProfileHtml();
  if (view === "profile") afterPane("you");
  shown.animate?.([{ opacity: 0, translate: "0 0.8rem" }, { opacity: 1, translate: "0 0" }], { duration: 300, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
}

/* Your Deck: every card in its suit, as you see it at the table, 5 to a row; under
   each suit, a dashed box of the designs for it you have collected. Tap one and it
   swaps with the design that card wears now (the ordinary face too, once replaced). */
const DECK_SUITS = ["S", "H", "D", "C"];
const DECK_LABELS = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
function deckCardHtml(label, suit, skin, { button = false, key, swappable = button } = {}) {
  const card = { label, suit };
  const face = `<span class="card"><span class="card-flip">${faceHtml(card, false, skin || false)}</span></span>`;
  const name = `${cardName(card)}${skin ? `, ${skin.name}` : ""}`;
  // (a card that can swap with its other designs, or they with it: where it lies, the deck or the box)
  const slot = button ? "box" : "deck";
  const drag = swappable ? ` data-deck-card="${label + suit}" data-deck-slot="${slot}"` : "";
  // (picked up, or one the card picked up can swap with: drawn so, whenever the page is drawn)
  const [pickCard, pickSlot] = deckPickedAs();
  const mark = !swappable || !pickCard ? "" : key === deckPick ? " selected" : pickCard === label + suit && pickSlot !== slot ? " target" : "";
  // (a card that can be swapped is picked up with a tap, as at the table)
  return button
    ? `<button type="button" class="example-card deck-card is-face${mark}" data-deck-pick data-deck-equip="${label + suit}:${skin ? skin.id : ""}" data-deck-key="${key}"${drag} aria-label="${e(skin ? skin.name : "Classic")} ${e(cardName(card))}, collected">${face}${skin ? `<span class="deck-name">${e(skin.name)}</span>` : `<span class="deck-name">Classic</span>`}</button>`
    : swappable
      ? `<button type="button" class="example-card deck-card is-face${mark}" data-deck-pick data-deck-key="${key}"${drag} aria-label="${e(name)}, in your deck">${face}</button>`
      : `<span class="example-card deck-card is-face" role="img" data-deck-key="${key}" aria-label="${e(name)}">${face}</span>`;
}
function deckHtml() {
  const suits = DECK_SUITS.map((suit, i) => {
    const plural = SUIT_NAME[suit][0].toUpperCase() + SUIT_NAME[suit].slice(1);
    const cards = DECK_LABELS.map((label) => {
      const skin = equippedSkin(label + suit);
      const others = CARD_SKINS.some((one) => one.card === label + suit && flagUnlocked("card", one.id));
      return deckCardHtml(label, suit, skin, { key: skin ? skin.id : `classic:${label}${suit}`, swappable: others });
    }).join("");
    // (what waits in the box: every design of this suit not being worn, and the ordinary
    // face of each card wearing one)
    const spare = DECK_LABELS.flatMap((label) => {
      const worn = equippedSkin(label + suit);
      const free = CARD_SKINS.filter((skin) => skin.card === label + suit && skin !== worn && flagUnlocked("card", skin.id)).map((skin) => deckCardHtml(label, suit, skin, { button: true, key: skin.id }));
      return worn ? [deckCardHtml(label, suit, null, { button: true, key: `classic:${label}${suit}` }), ...free] : free;
    });
    return `<section class="deck-suit suit-${suit}">
      <h2 class="deck-suit-head">${tilted(SUIT_ICON[suit], 26, { key: `deck:${suit}`, tilt: [-6, 4, -4, 6][i] })}<span>${e(plural)}</span></h2>
      <div class="deck-grid">${cards}</div>
      <section class="emote-box off deck-box"><span class="box-label">Collected ${e(plural)}</span>${spare.length ? `<div class="deck-grid">${spare.join("")}</div>` : `<p class="emote-all">No custom ${e(plural.toLowerCase())} collected yet.</p>`}</section>
    </section>`;
  }).join("");
  return `${tabTitle("Your Deck", "Tap a card, then the card to swap it with", "you-deck")}${suits}`;
}
/** Wear a collected design: it swaps places with the one on that card, each sliding to where it goes. */
function swapDeckCard(choice) {
  const [card, id] = choice.split(":");
  const shown = root.querySelector(`${LIVE_PANE}[data-pane="you"] [data-you-shown="deck"]`);
  if (!shown) return;
  // (where each card is drawn: one being carried, where it has been carried to)
  const center = (el) => {
    const r = (el.querySelector(".card") || el).getBoundingClientRect();
    return [r.left + r.width / 2, r.top + r.height / 2];
  };
  const was = new Map([...shown.querySelectorAll("[data-deck-key]")].map((el) => [el.dataset.deckKey, center(el)]));
  equipSkin(card, id || null);
  deckPick = null;
  shown.innerHTML = deckHtml();
  haptic("snap");
  if (reducedMotion.matches) return;
  for (const el of shown.querySelectorAll("[data-deck-key]")) {
    const from = was.get(el.dataset.deckKey);
    if (!from || !el.animate) continue;
    const now = center(el);
    const dx = from[0] - now[0],
      dy = from[1] - now[1];
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5)
      el.animate([{ translate: `${dx}px ${dy}px`, scale: "1.08", zIndex: 2 }, { translate: "0 0", scale: "1", zIndex: 2 }], { duration: 520, easing: "cubic-bezier(0.34, 1.3, 0.64, 1)" });
  }
}
/* Tapping in Your Deck, as at the table: a card tapped is picked up (it lifts, in a
   dashed outline), the cards it can swap with show "Swap", and tapping one of those
   swaps the two. Tapping it again, or tapping anywhere else, puts it back down; a
   scroll does not, so the box of designs can be scrolled to with the card still held.
   What is picked up is kept by its key, not by its element: the page can be drawn
   again meanwhile (its data loading, a sideways swipe) and it is picked up again there. */
let deckPick = null; // the data-deck-key of the card picked up
/** [card, "deck" or "box"] of the card picked up, from its key (a design's id, or "classic:AS"). */
function deckPickedAs() {
  if (!deckPick) return [null, null];
  if (deckPick.startsWith("classic:")) {
    const card = deckPick.slice(8);
    return [card, equippedSkin(card) ? "box" : "deck"];
  }
  const skin = cardSkin(deckPick);
  return skin ? [skin.card, equippedSkin(skin.card) === skin ? "deck" : "box"] : [null, null];
}
const deckScope = () => root.querySelector(`${LIVE_PANE}[data-pane="you"] [data-you-shown="deck"]`);
/** Whether `a` and `b` can swap: the same card, one in the deck and one in the box. */
const deckPartners = (a, b) => !!a && !!b && a.dataset.deckCard === b.dataset.deckCard && a.dataset.deckSlot !== b.dataset.deckSlot;
/** Show what is picked up as it stands: lifted and outlined, its partners marked "Swap". */
function paintDeckPick() {
  const scope = deckScope();
  if (!scope) return;
  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 10;
  const picked = deckPick ? scope.querySelector(`[data-deck-key="${deckPick}"]`) : null;
  if (deckPick && !picked) deckPick = null; // (it is not there any more: swapped in elsewhere)
  for (const el of scope.querySelectorAll("[data-deck-pick]")) {
    const on = el === picked;
    if (on !== el.classList.contains("selected")) motionFor(el).to(on ? { scale: 1.07, lift: 0.8, y: -0.6 * rem } : { scale: 1, lift: 0, y: 0 });
    el.classList.toggle("selected", on);
    el.classList.toggle("target", !on && deckPartners(picked, el));
  }
}
function deckTap(el) {
  const scope = deckScope();
  if (!scope?.contains(el)) return;
  const picked = deckPick ? scope.querySelector(`[data-deck-key="${deckPick}"]`) : null;
  if (picked === el) {
    deckPick = null;
    return paintDeckPick();
  }
  if (deckPartners(picked, el)) {
    // (the design is whichever of the two lay in the box)
    const design = el.dataset.deckSlot === "box" ? el : picked;
    deckPick = null;
    return swapDeckCard(design.dataset.deckEquip);
  }
  deckPick = el.dataset.deckKey;
  paintDeckPick();
  haptic("tap");
}
// a tap anywhere but a card in the deck puts the picked-up one down (a scroll is no tap)
// (iPhone haptics click a hidden switch from script for each tick, the tap that picked the
// card up included: those clicks are no tap of the player's)
document.addEventListener("click", (event) => {
  if (!event.isTrusted || event.target.closest?.(".haptic-probe")) return;
  if (deckPick && !event.target.closest?.("[data-deck-pick]")) {
    deckPick = null;
    paintDeckPick();
  }
});
function youProfileHtml() {
  const unique = session.account?.unique_name;
  const account = session.account
    ? unique
      ? `<button type="button" class="btn small c-p1 you-signin" data-account-sheet>${tilted("person.crop.circle.fill", 22)}<span>@${e(unique)}<span class="sub">Your account</span></span></button>`
      : `<button type="button" class="btn small c-p1 you-signin" data-unique-name>${tilted("person.crop.circle.fill", 22)}<span>Choose your unique name<span class="sub">Your games are kept under it</span></span></button>`
    : signInButton("small c-p1 you-signin", `${tilted("person.crop.circle.fill", 22)}<span>Sign in<span class="sub">Keep your stats and add friends</span></span>`);
  return `
    <form id="display-name-form" class="stack profile-form you-profile">
      ${avatarPicker()}
      ${field("Your Display Name", `<input id="account-display-name" name="display_name" data-max-chars="12" value="${e(session.username)}" autocomplete="nickname" aria-label="Display name" required>`, "character.cursor.ibeam", "c-p1")}
      <p class="hint profile-status" data-profile-status aria-live="polite"></p>
    </form>
    ${account}
    ${emoteEditHtml()}
    ${homeData.myProfile ? `<div data-my-numbers>${profileNumbersHtml(homeData.myProfile)}</div>` : `<div data-my-numbers></div>`}
    ${tabTitle("Personal Records", "", "you-records")}
    ${personalRecordsHtml(homeData.boards?.personal)}
    ${myStatsHtml()}`;
}
/** Your own best at each record, as cards like the Records tab's. */
/** A player's own bests as [color, symbol, title, [value, unit, when, note]], leaving out those they have none of. */
function personalRecordItems(P) {
  const plural = (n, one, many = one + "s") => (n === 1 ? one : many);
  const [played, playedUnit] = timeParts(P.most_time?.seconds);
  return [
    // (Golfbot's: its record against everyone it has played)
    ["c-p3", "person.2.fill", "Wins vs people", P.vs_people && [statNumber(P.vs_people.wins), plural(P.vs_people.wins, "win"), null, `${statNumber(P.vs_people.draws)} ${plural(P.vs_people.draws, "draw")} · ${statNumber(P.vs_people.losses)} ${plural(P.vs_people.losses, "loss", "losses")} · ${statNumber(P.vs_people.games)} games`]],
    ["c-p3", "crown.fill", "Highest MMR", P.highest_mmr && [P.highest_mmr.mmr, "MMR", P.highest_mmr.at]],
    ["c-s4", "flame.fill", P.vs_people ? "Best win streak vs people" : "Best PvP win streak", P.pvp_streak && [P.pvp_streak.streak, plural(P.pvp_streak.streak, "win"), P.pvp_streak.at]],
    ["c-p2", "arrow.up.right", "Biggest Comeback", P.comeback && [P.comeback.points, "points", P.comeback.at]],
    ["c-s7", "clock.arrow.circlepath", "Most Games Today", P.games_today && [P.games_today.games, plural(P.games_today.games, "game")]],
    ["c-s5", "bird.fill", "Lowest score", P.lowest && [P.lowest.points, "pts", P.lowest.at]],
    ["c-p1", "tortoise.fill", "Highest score", P.bogey && [P.bogey.points, "pts", P.bogey.at]],
    ["c-s6", "sparkles", "Most rules on one hand", P.modifiers_in_game && [P.modifiers_in_game.count, plural(P.modifiers_in_game.count, "rule"), P.modifiers_in_game.at]],
    ["c-s7", "clock.arrow.circlepath", P.vs_people ? "Longest game" : "Longest 1v1 game", P.longest_pvp && [P.longest_pvp.turns, plural(P.longest_pvp.turns, "turn"), P.longest_pvp.at]],
    ["c-p4", "star.fill", "Favorite rule", P.most_modifier && [statNumber(P.most_modifier.activations), plural(P.most_modifier.activations, "time"), null, P.most_modifier.name]],
    ["c-p2", "text.bubble.fill", "Emotes sent", P.yapper && [statNumber(P.yapper.emotes), plural(P.yapper.emotes, "emote")]],
    ["c-s4", "person.3.fill", "Biggest party", P.party && [P.party.count, "signed in", P.party.at]],
    ["c-s2", "hourglass", "Time played", P.most_time && [played, playedUnit]],
  ].filter((item) => item[3]);
}
/**
 * A player's own bests as record cards. `mine` (the viewer's own bests, on someone
 * else's profile) puts the viewer's best under each card they have one for.
 * They are laid out as the Flags tab's cards are.
 */
function personalRecordsHtml(P, mine = null, empty = "Play a few games and your best moments show up here.") {
  if (!P) return `<div class="loading">Loading your records…</div>`;
  const when = (at) => (at ? dateLabel(at, { month: "short", day: "numeric", year: "numeric" }) : "");
  const items = personalRecordItems(P);
  if (!items.length) return `<p class="hint dark you-empty">${empty}</p>`;
  const yours = new Map(mine ? personalRecordItems(mine).map((item) => [item[2], item[3]]) : []);
  const best = (title, i) => {
    const own = yours.get(title);
    return own ? `<div class="record-pr"><span class="record-pr-value">${stickerText(String(own[0]), { split: true, key: `prm:${i}` })}${stickerText(own[1], { cls: "pts", key: `prmu:${i}` })}</span><span class="record-pr-text">Your best</span></div>` : "";
  };
  // A best that is the all-time record (this player holds it on Aces) says so at its foot.
  const records = (typeof leaderboardCache !== "undefined" && leaderboardCache?.records) || homeData.boards?.records || {};
  const RECORD_OF = { "Highest MMR": "highest_mmr", "Best PvP win streak": "pvp_streak", "Best win streak vs people": "pvp_streak", "Longest game": "longest_pvp", "Biggest Comeback": "comeback", "Most Games Today": "games_today", "Lowest score": "lowest", "Highest score": "bogey", "Most rules on one hand": "modifiers_in_game", "Longest 1v1 game": "longest_pvp", "Emotes sent": "yapper", "Biggest party": "party", "Time played": "most_time" };
  const holds = (title) => {
    const record = records[RECORD_OF[title]];
    return !!(P.id && record && (record.id === P.id || record.ids?.includes(P.id)));
  };
  const allTime = (i) => `<p class="record-alltime">${icon("trophy.fill", 20, { idle: false })}<span>All time record!</span></p>`;
  const slots = items.map(([color, symbol, title, [value, unit, at, note]], i) => `<div class="record-slot ${color}" style="--i:${i}"><section class="panel ${color} record-card"><span class="record-ico">${tilted(symbol, 40, { key: `pr:${i}` })}</span><h3>${title}</h3><div class="record-value">${stickerText(String(value), { split: true, key: `prv:${i}` })}${stickerText(unit, { cls: "pts", key: `pru:${i}` })}</div>${note ? `<p>${e(note)}</p>` : ""}${at ? `<p>${when(at)}</p>` : ""}${holds(title) ? allTime(i) : ""}</section>${best(title, i)}</div>`);
  // two columns of cards that each keep to their own height, as the Flags tab's do
  return hugColumns(slots);
}
/** Your full stats (what Advanced stats had): opened on request, as it takes a moment to work out. */
/** The button that puts a stats table away again, as Show my stats is drawn. */
const hideStatsButton = (attrs) => `<button type="button" class="btn small c-fw" ${attrs}>${tilted("chevron.up", 22)}Hide stats</button>`;
function myStatsHtml() {
  const stats = homeData.myStats;
  const body = !stats
    ? `<button type="button" class="btn small c-fw" data-my-stats>${tilted("chart.bar.fill", 22)}Show my stats</button>`
    : stats.error
      ? `<p class="hint dark">${e(stats.error)}</p>`
      : `${statsTable([stats.player], "overall", "Every game you've played", "c-fw")}${hideStatsButton("data-hide-my-stats")}`;
  return `${tabTitle("Your Stats", "Win rates, points and the rules you trigger", "you-stats")}<div class="stack wide you-stats">${body}</div>`;
}
async function loadMyStats() {
  const query = new URLSearchParams({ player: myPlayerId(), opponent: "", house_rules: "false" });
  try {
    const result = await api("/api/stats?" + query);
    homeData.myStats = result.player ? result : { error: "No saved games yet. Finish a game to see your stats." };
  } catch (error) {
    homeData.myStats = { error: error.message };
  }
  redrawPane("you");
}

/* ---------- Flags ---------- */
/* Achievements to earn. The server works out who has earned which (flags.py),
   from the games they have played; each unlocks a text emote or a theme. */
const FLAGS = [
  { name: "Wait for my cue...", reward: "word", word: "rushing", detail: "Finish a PvP game where your only moves are flips of your own cards. No swaps. No Go Fish draws." },
  { name: "Here we go...", reward: "word", word: "dragging", detail: "Finish a PvP game where you draw 5 Go Fish cards in a row and discard them all. No swaps. No flips of your own cards." },
  { name: "Let's go gambling!", reward: "theme", theme: "poker", detail: "Activate Angel Numbers' 777s in a game." },
  { name: "Adult swim", reward: "theme", theme: "pool", detail: "Play 50 solo games in a row against Golfbot." },
  { name: "Black out!", reward: "theme", theme: "focus", detail: "Activate Suited Rows and All in Black in the same hand 10 times." },
  { name: "Just one more game", reward: "theme", theme: "night", detail: "Finish a game between 11pm and 6am." },
  { name: "Cupid's porcelain throne", reward: "face", emote: "giveheart", detail: "Finish 10 games with a heart flush in your final hand." },
  { name: "Tear it up!", reward: "card", skin: "ripped-5d", detail: "Activate the Ripped 5 rule in 3 games." },
  { name: "5 Fantastic 4s", reward: "face", emote: "pogcat", detail: "Finish 5 games with Fantastic 4 active in your final hand." },
  { name: "Washed?", reward: "face", emote: "poop", detail: "Lose 100 PvP games." },
  { name: "Take 5!", reward: "face", emote: "crocscreech", detail: "Finish a game with 5 rules in play in your final hand." },
  { name: "No longer a casual", reward: "word", word: "ranked", detail: "Play 3 Ranked matches." },
  { name: "Good Sport", reward: "word", word: "gg", detail: "Play 5 minutes of Golf." },
  { name: "Under Pressure", reward: "word", word: "isit", detail: "Win 3 games with at least 1 spectator watching." },
  // (a secret: how it is earned stays hidden until it is)
  { name: "Chat disabled for 3s.", reward: "word", word: "save", secret: true, detail: "Send the same emote 3 times in a row within 2 seconds while a game is being played." },
];
/** The flags you have earned, and what they have unlocked (myFlags, in ui.js), as the server has them. */
async function loadMyFlags() {
  const before = new Set(myFlags.earned || []);
  try {
    myFlags = await api("/api/flags");
  } catch {
    return;
  }
  // (a flag earned since this device last heard: announced. On a device that has never
  // heard, what is already earned is only taken in, not announced all at once.)
  if (flagsHeard) for (const name of myFlags.earned || []) if (!before.has(name)) announceFlag(name);
  flagsHeard = true;
  try {
    localStorage.setItem("golf-flags", JSON.stringify(myFlags));
  } catch {}
  applyPrefs(); // (a theme earned, or no longer: shown as it should be)
  if (page === "home" && homeTab === "flags") redrawPane("flags");
}
/*
 * A flag just earned drops in from the top, like the Ranked "Match found!" pill but
 * purple and with the strokes the other way round: the pill in the primary outline,
 * its button in the quieter one. What the flag is on the left (its reward's kind under
 * its name), the reward itself on the right, and Dismiss below. Several earned at
 * once come one after another.
 */
let flagNews = [];
function announceFlag(name) {
  if (!FLAGS.some((flag) => flag.name === name) || flagNews.includes(name)) return;
  flagNews.push(name);
  if (flagNews.length === 1) showFlagNews();
}
function showFlagNews() {
  const banner = document.getElementById("flag-banner");
  const flag = FLAGS.find((one) => one.name === flagNews[0]);
  if (!banner) return;
  if (!flag) {
    banner.hidden = true;
    banner.innerHTML = "";
    return;
  }
  const sparkle = (mirror) => icon("sparkles", 24, { idle: false, sw: 3.4, cls: mirror ? "mirrored" : "" });
  banner.innerHTML = `<div class="queue-pill offer open flag-pill" role="dialog" aria-label="Flag complete: ${e(flag.name)}"><div class="queue-offer-row"><span class="queue-text"><b>Flag Complete!</b><small><span class="queue-who">${e(flag.name)}</span><br>${FLAG_REWARDS[flag.reward]}</small></span><span class="flag-pill-art">${flagArtHtml(flag, true)}</span></div><button type="button" class="btn c-p4 queue-accept" data-flag-dismiss>${sparkle(false)}<span>${padTag("y")}Dismiss</span>${sparkle(true)}</button></div>`;
  banner.hidden = false;
  haptic("win");
  if (reducedMotion.matches || !banner.animate) return;
  banner.getAnimations().forEach((animation) => animation.cancel());
  banner.animate([{ transform: "translateY(calc(-100% - 2rem))" }, { transform: "none" }], { duration: 420, easing: "cubic-bezier(0.3, 0.8, 0.25, 1.1)" });
}
function dismissFlagNews() {
  const banner = document.getElementById("flag-banner");
  const next = () => {
    flagNews.shift();
    showFlagNews();
  };
  if (!banner || banner.hidden || reducedMotion.matches || !banner.animate) return next();
  banner.getAnimations().forEach((animation) => animation.cancel());
  banner
    .animate([{ transform: "none" }, { transform: "translateY(calc(-100% - 2rem))", opacity: 0 }], { duration: 260, easing: "cubic-bezier(0.4, 0, 0.9, 0.6)", fill: "forwards" })
    .finished.then(() => {
      banner.getAnimations().forEach((animation) => animation.cancel());
      next();
    }, next);
}
const FLAG_REWARDS = { theme: "Theme", word: "Text Emote", face: "Face Emote", card: "Individual Card Skin" };
/**
 * Cards in two columns, each only as tall as what is on it. They start out alternating
 * between the columns, so they read across; once drawn, balanceColumns moves a few if the
 * columns would end far apart (each column keeping its cards in order).
 */
function hugColumns(cards) {
  const at = (card, i) => card.replace(/^<(\w+) /, `<$1 data-at="${i}" `);
  return `<div class="flag-grid" data-balance>${[0, 1].map((side) => `<div class="flag-col">${cards.map(at).filter((_, i) => i % 2 === side).join("")}</div>`).join("")}</div>`;
}
/**
 * Lay a two-column grid's cards out so the columns never end far apart, from the cards'
 * real heights: they alternate as long as the columns end within half a card of each
 * other, and otherwise the fewest cards move across to bring them that close.
 */
function balanceColumns(grid) {
  const cols = [...grid.children];
  if (cols.length !== 2) return;
  const cards = cols.flatMap((col) => [...col.children]).sort((a, b) => a.dataset.at - b.dataset.at);
  if (cards.length < 3 || cards.length > 16 || cards.some((card) => card.dataset.at === undefined)) return;
  const gap = parseFloat(getComputedStyle(cols[0]).rowGap) || 0;
  const tall = cards.map((card) => card.getBoundingClientRect().height + gap);
  // (a little uneven is fine: within half a typical card of each other, the split
  // nearest alternating wins; only beyond that do the cards move to even it out)
  const typical = [...tall].sort((a, b) => a - b)[tall.length >> 1];
  const slack = typical / 2;
  let best = null;
  for (let mask = 0; mask < 1 << cards.length; mask++) {
    if (mask & 1) continue; // (the first card always starts the left column)
    const sums = [0, 0];
    let off = 0;
    cards.forEach((_, i) => {
      const side = (mask >> i) & 1;
      sums[side] += tall[i];
      off += side !== i % 2;
    });
    const gap = Math.abs(sums[0] - sums[1]);
    const score = [Math.max(gap, slack), off];
    if (!best || score[0] < best.score[0] - 1 || (Math.abs(score[0] - best.score[0]) <= 1 && score[1] < best.score[1])) best = { mask, score };
  }
  cards.forEach((card, i) => cols[(best.mask >> i) & 1].append(card));
}
// (each grid laid out once it is drawn, and again as the fonts that size it arrive)
const balanceAll = () => document.querySelectorAll?.("[data-balance]").forEach((grid) => grid.isConnected && grid.offsetParent && balanceColumns(grid));
if (typeof MutationObserver === "function")
  new MutationObserver((changes) => {
    if (changes.some((change) => [...change.addedNodes].some((node) => node.querySelector?.("[data-balance]") || node.matches?.("[data-balance]"))))
      requestAnimationFrame(balanceAll);
  }).observe(document.documentElement, { childList: true, subtree: true });
document.fonts?.ready?.then?.(balanceAll);
/**
 * What a flag unlocks, as its card shows it: out of focus under a lock until it is earned
 * (`open`), then the reward itself (the Golf logo in the theme's colors, the face, the
 * saying, the card in its design).
 */
function flagArtHtml({ reward: kind, theme, emote, word, skin, name }, open) {
  // (each lock drifts a little, on its own beat)
  const lock = (key) => icon("lock.fill", 18, { key: `flag-lock:${key}` });
  // (the logo as the top bar draws it, but still and not a link, to stand for a theme)
  const logo = logoHtml().replace(/^<a class="logo[^"]*" href="\." data-nav="home" aria-label="Golf home">/, `<span class="logo" aria-hidden="true">`).replace(/<\/a>$/, "</span>").replaceAll(' idle"', '"');
  const design = cardSkin(skin);
  const rank = (label) => ({ A: 1, J: 11, Q: 12, K: 13 })[label] || Number(label);
  return {
    // (the Golf logo in the colors of the theme it unlocks)
    theme: () => `<span class="flag-art f-theme${open ? " open" : ""}">${logo.replace('<span class="logo"', `<span data-theme-art="${e(theme)}" class="logo"`)}${open ? "" : lock(name)}</span>`,
    // (the saying itself, once it is yours)
    word: () => `<span class="flag-art f-word${open ? " open" : ""}">${open ? e(emoteNames[word] || "") : lock(name)}</span>`,
    face: () => `<span class="flag-art f-face${open ? " open" : ""}"><img src="${appPath(`/static/emotes/${emote || "cackling"}.png`)}" alt="">${open ? "" : lock(name)}</span>`,
    // (the back of a card, under the lock: what it unlocks is kept face down until then;
    // then the card face up in its design)
    card: () => `<span class="flag-art f-card${open ? " open" : ""}"><span class="example-card" aria-hidden="true"><span class="card"><span class="card-flip">${open && design ? faceHtml({ label: design.label, suit: design.suit, rank: rank(design.label) }, false, design) : faceHtml(null)}</span></span></span>${open ? "" : lock(name)}</span>`,
  }[kind]?.() ?? "";
}
/**
 * The flags as cards, for the Flags tab and a player's profile. A flag not yet
 * earned is green with an hourglass; one earned (named in `earned`) has a seal and
 * is `earnedColor` (purple, unless told otherwise). `rewards` false leaves out what
 * each unlocks; `only` shows just the earned ones. `progress` ({name: percent}, your
 * own) puts how far along you are beside each one not yet earned.
 */
function flagCardsHtml({ rewards = true, earned = new Set(), only = false, earnedColor = "c-p4", progress = null } = {}) {
  const color = "c-fw";
  const art = flagArtHtml;
  // each flag is a card exactly as a record's is (only green): its badge on the corner,
  // its name, what it unlocks where a record's number would be, how to earn it, and a note
  // (with your progress known, the nearest to done come first: earned ones, then by percent)
  const pct = (flag) => (earned.has(flag.name) ? 100 : progress?.[flag.name] || 0);
  const shown = FLAGS.filter((flag) => !only || earned.has(flag.name));
  if (progress) shown.sort((a, b) => pct(b) - pct(a));
  const cards = shown.map(
    (flag, i) =>
      `<div class="record-slot ${earned.has(flag.name) ? earnedColor : color}" style="--i:${i}"><section class="panel ${earned.has(flag.name) ? `${earnedColor} earned` : color} record-card flag-card"><span class="record-ico" role="img" aria-label="${earned.has(flag.name) ? "Earned" : "Not earned yet"}">${tilted(earned.has(flag.name) ? "checkmark.seal.fill" : "hourglass", 40, { key: `flag:${i}` })}${!earned.has(flag.name) && progress ? `<span class="flag-pct">${stickerText(`${progress[flag.name] || 0}%`, { key: `flag-pct:${i}` })}</span>` : ""}</span><h3>${e(flag.name)}</h3>${rewards ? art(flag, earned.has(flag.name)) : ""}<p${flag.secret && !earned.has(flag.name) ? ' class="flag-secret"' : ""}>${flag.secret && !earned.has(flag.name) ? "???" : e(flag.detail)}</p>${rewards ? `<p class="record-note">${FLAG_REWARDS[flag.reward]}</p>` : ""}</section></div>`,
  );
  // two columns, each card only as tall as what is on it, laid out so the columns never
  // end far apart (see balanceColumns)
  return hugColumns(cards);
}
function flagsPaneHtml() {
  return `<div class="tab-body flags-body">${tabTitle("Your Flags", "Complete flags to unlock new items... and bragging rights!", "flags")}${flagCardsHtml({ earned: new Set(myFlags.earned), progress: myFlags.progress || {} })}<p class="hint dark flags-note">A flag that names a rule only counts games with that rule active.</p></div>`;
}

/* ---------- another player's profile ----------
   Who they are, their numbers, how they compare with you, their own bests (with
   yours under each), and their flags. A page of its own when opened from the home
   screen (a leaderboard row, a record); at the table, the same thing in a sheet,
   in that player's seat color. */
/**
 * The profile's contents. `profile` is /api/profile's answer, `stats` /api/stats'
 * (the player, and the viewer to compare with), `accent` the color class for the
 * avatar and the friend button, `tone` the one for the plain boxes (the surface it
 * lies on: green on the page, the player's color in their sheet), `heading` how its
 * section titles are drawn.
 */
/** Who a profile can be compared with: you, your friends, and the players on the PvP board. */
function compareChoices(skip) {
  const me = myPlayerId();
  const seen = new Set([skip]);
  const out = [];
  const add = (id, label, avatar) => {
    if (!id || seen.has(id) || !label) return;
    seen.add(id);
    out.push({ id, label, avatar });
  };
  add(me, "You", session.avatar);
  for (const friend of homeData.friends?.friends || []) add(friend.id, friend.unique_name ? `@${friend.unique_name}` : friend.display_name, friend.avatar);
  for (const row of leaderboardCache?.pvp || []) add(row.id, row.label, row.avatar);
  return out;
}
/** Your own four numbers for the You tab (as your profile shows them to others). */
async function loadMyNumbers() {
  try {
    homeData.myProfile = await api(`/api/profile?player=${encodeURIComponent(myPlayerId())}`);
  } catch {
    return;
  }
  const holder = root.querySelector?.(".tab-pane:not(.parked):not(.staged) [data-my-numbers]") || root.querySelector?.("[data-my-numbers]");
  if (holder) holder.innerHTML = profileNumbersHtml(homeData.myProfile);
}
/** A player's four numbers, a row each as the leaderboards draw a player: their MMR, their
 *  solo and PvP streaks (best, and the run on now) and their time played. On a profile,
 *  and on the You tab for your own. */
function profileNumbersHtml(profile) {
  const row = (color, symbol, label, value, unit) =>
    `<div class="list-item board-row ${color}"><span class="rank">${tilted(symbol, 30, { key: `profile:${label}` })}</span><div class="grow"><strong>${label}</strong></div><b class="rate">${value}<small>${unit}</small></b></div>`;
  const streakRow = (color, label, best, now) =>
    `<div class="list-item board-row ${color} streak-row"><span class="rank">${tilted("flame.fill", 30, { key: `profile:${label}` })}</span><div class="grow"><strong>${label}</strong></div><b class="rate">${statNumber(best)}<small>best</small></b><b class="rate streak-now">${statNumber(now)}<small>now</small></b></div>`;
  const mmr = profile.mmr == null ? null : `${statNumber(profile.mmr)}${profile.provisional ? "?" : ""}`;
  const [played, playedUnit] = timeParts(profile.seconds_played || 0);
  return `<div class="list leader-list profile-rows">${row("c-p3", "crown.fill", "Current MMR", mmr ?? "—", mmr ? "MMR" : "")}${streakRow("c-s4", "Solo Win Streak", profile.solo_streak || 0, profile.current_solo_streak || 0)}${streakRow("c-p2", "PvP Win Streak", profile.pvp_streak || 0, profile.current_pvp_streak || 0)}${row("c-p4", "hourglass", "Time Played", statNumber(played), playedUnit)}</div>`;
}
function profileHtml(profile, stats, { accent = "c-p1", tone = "c-fw", heading = tabTitle, extra = "", opponent = null } = {}) {
  const entry = stats?.player,
    you = stats?.comparison;
  const name = profile.label || entry?.profile.label || "Player";
  // (section titles are in the player's own color: their seat's at the table, blue on their page)
  const tint = `seat ${accent}`;
  const bot = String(profile.id).startsWith("bot:");
  const puzzleBot = profile.id === "bot:puzzlebot";
  const avatar = profile.avatar || (puzzleBot ? "puzzlebot" : bot ? "golfbot" : null);
  const mmr = profile.mmr == null ? null : `${statNumber(profile.mmr)}${profile.provisional ? "?" : ""}`;
  const where = { in_game: "in a game", puzzle: "solving the puzzle", online: "online now" }[profile.status] || (profile.last_seen ? `active ${agoShort(profile.last_seen)}` : "");
  const sub = [profile.unique_name ? `@${e(profile.unique_name)}` : "", where].filter(Boolean).join(" · ");
  const twin = (symbol) => [tilted(symbol, 24), tilted(symbol, 24, { mirror: true })];
  const friend = {
    none: `<button type="button" class="btn small ${accent} profile-friend" data-profile-friend="${e(profile.unique_name || "")}">${twin("person.fill.badge.plus")[0]}<span>Add friend</span>${twin("person.fill.badge.plus")[1]}</button>`,
    incoming: `<button type="button" class="btn small ${accent} profile-friend" data-profile-friend="${e(profile.unique_name || "")}">${twin("person.fill.badge.plus")[0]}<span>Accept friend request</span>${twin("person.fill.badge.plus")[1]}</button>`,
    outgoing: `<button type="button" class="btn small ${accent} profile-friend" disabled>${twin("hourglass")[0]}<span>Friend request sent</span>${twin("hourglass")[1]}</button>`,
    friend: `<button type="button" class="btn small ${accent} profile-friend" disabled>${twin("person.2.fill")[0]}<span>Friends</span>${twin("person.2.fill")[1]}</button>`,
  }[profile.friend] || "";
  const head = `<header class="profile-head ${accent}"><span class="profile-ava">${avatar ? icon(avatarIcon(avatar), 76, { key: "profile-ava", sw: 6.5 }) : icon("person.fill", 64, { key: "profile-ava", sw: 6.5 })}</span><h1 class="profile-name">${profile.self ? youStar() : profile.friend === "friend" ? friendMark() : ""}${e(name)}${mmr ? `<small>${mmr}</small>` : ""}</h1>${sub ? `<p class="profile-sub">${sub}</p>` : ""}</header>${friend}`;
  // their numbers: a row each, as the leaderboards draw a player
  const row = (color, symbol, label, value, unit) =>
    `<div class="list-item board-row ${color}"><span class="rank">${tilted(symbol, 30, { key: `profile:${label}` })}</span><div class="grow"><strong>${label}</strong></div><b class="rate">${value}<small>${unit}</small></b></div>`;
  // a streak: the most ever in a row, and beside it, smaller, the run they are on now
  const streakRow = (color, label, best, now) =>
    `<div class="list-item board-row ${color} streak-row"><span class="rank">${tilted("flame.fill", 30, { key: `profile:${label}` })}</span><div class="grow"><strong>${label}</strong></div><b class="rate">${statNumber(best)}<small>best</small></b><b class="rate streak-now">${statNumber(now)}<small>now</small></b></div>`;
  const [played, playedUnit] = timeParts(profile.seconds_played || 0);
  const wins = (n) => (n === 1 ? "win" : "wins");
  // (Golfbot's numbers are from its games against people)
  const vs = profile.personal?.vs_people;
  const botTime = timeParts(profile.personal?.most_time?.seconds || 0);
  const tries = (n) => (n === 1 ? "try" : "tries");
  const puzzle = profile.puzzle || { attempts: 0, players: 0, today: 0 };
  // (PuzzleBot's record is the Daily Puzzle's: how often it has been taken on)
  if (puzzleBot)
    return `<div class="profile-body">${head}${extra}<div class="list leader-list profile-rows">${row("c-p1", "puzzlepiece.fill", "Puzzle Attempts", statNumber(puzzle.attempts), tries(puzzle.attempts))}${row("c-p3", "calendar", "Attempts Today", statNumber(puzzle.today), tries(puzzle.today))}${row("c-p2", "person.2.fill", "Players Faced", statNumber(puzzle.players), puzzle.players === 1 ? "player" : "players")}</div></div>`;
  const rows = bot
    ? vs
      ? `<div class="list leader-list profile-rows">${row("c-p3", "person.2.fill", "Record vs People", `${statNumber(vs.wins)}–${statNumber(vs.draws)}–${statNumber(vs.losses)}`, "")}${row("c-s4", "trophy.fill", "Win Rate", statPercent(vs.games ? vs.wins / vs.games : 0), "")}${row("c-p2", "flame.fill", "Best Win Streak", statNumber(profile.personal?.pvp_streak?.streak || 0), wins(profile.personal?.pvp_streak?.streak || 0))}${row("c-p4", "hourglass", "Time Played", botTime[0], botTime[1])}</div>`
      : ""
    : profileNumbersHtml(profile);
  // side by side with you
  const rating = (side) => {
    const shown = side?.ratings?.series;
    return shown ? `${statNumber(shown.rating)}${shown.provisional ? "?" : ""} <small>±${statNumber(shown.rd)}</small>` : "—";
  };
  const of = (side, read) => (side?.overall ? read(side.overall) : "—");
  // (every number the You tab's own stats have, side by side)
  const game = (side) => {
    const shown = side?.ratings?.game;
    return shown ? `${statNumber(shown.rating)}${shown.provisional ? "?" : ""} <small>±${statNumber(shown.rd)}</small>` : "—";
  };
  const share = (wins, games, rate) => (games ? `${statPercent(rate)} <small>(${statNumber(wins)}/${statNumber(games)})</small>` : "—");
  const lines = [
    ["MMR", rating],
    ["Game rating", game],
    ["Games played", (side) => of(side, (o) => statNumber(o.rounds))],
    ["Game record W–L–D", (side) => of(side, (o) => `${statNumber(o.round_wins)}–${statNumber(o.round_losses)}–${statNumber(o.round_draws)}`)],
    ["Win %", (side) => of(side, (o) => statPercent(o.round_win_rate))],
    ["Series W–L–D", (side) => of(side, (o) => `${statNumber(o.match_wins ?? 0)}–${statNumber(o.match_losses ?? 0)}–${statNumber(o.match_draws || 0)}`)],
    ["Series win %", (side) => of(side, (o) => (o.match_win_rate == null ? "—" : statPercent(o.match_win_rate)))],
    ["Avg points per game", (side) => of(side, (o) => statNumber(o.average_points ?? null))],
    ["Avg opponent points", (side) => of(side, (o) => statNumber(o.average_opponent_points ?? null))],
    ["Avg point advantage", (side) => of(side, (o) => (o.average_advantage == null ? "—" : o.average_advantage.toFixed(2)))],
    ["Went first", (side) => of(side, (o) => share(o.first_games, o.known_first_games, o.first_rate))],
    ["Win % going first", (side) => of(side, (o) => share(o.first_wins, o.first_games, o.first_win_rate))],
    ["Win % not first", (side) => of(side, (o) => share(o.later_wins, o.later_games, o.later_win_rate))],
    ["Avg turns per game", (side) => of(side, (o) => statNumber(o.average_turns ?? null))],
    ["Avg time per move", (side) => of(side, (o) => statSeconds(o.average_move_seconds ?? null))],
    ["Avg rules in play", (side) => of(side, (o) => statNumber(o.average_rules_in_play ?? null))],
    ["Total points", (side) => of(side, (o) => statNumber(o.total_points ?? null))],
    ["Best / worst game", (side) => of(side, (o) => (o.best_round == null ? "—" : `${statNumber(o.best_round)} / ${statNumber(o.worst_round)}`))],
  ];
  const who = (side, fallback) => (side?.profile.unique_name ? `@${e(side.profile.unique_name)}` : e(side?.profile.label || fallback));
  // (them by their username where they have one; the other side picked from a list: you first)
  const handle = profile.unique_name ? `@${e(profile.unique_name)}` : e(name);
  const choices = compareChoices(profile.id);
  const other = choices.find((choice) => choice.id === (opponent || myPlayerId())) || choices[0] || { id: myPlayerId(), label: "You", avatar: session.avatar };
  // (the second column is the chosen player's, if the stats came back for them)
  const theirs = !you || !you.profile?.id || you.profile.id === other.id || other.id === myPlayerId() ? you : null;
  // (on every other player's page, even before or without their stats: then their column
  // reads "—" until there is something to show)
  const compare =
    profile.self
      ? ""
      : `${heading("Compare Players", "", "profile-compare", tint)}<div class="profile-versus">${boxed(tone, handle, `<span class="profile-pick">${avatar ? icon(avatarIcon(avatar), 22, { idle: false }) : icon("person.fill", 20, { idle: false })}<b>${handle}</b></span>`)}${boxed(tone, "Other Player", `<span class="profile-pick">${icon(avatarIcon(other.avatar), 22, { idle: false })}<b>${e(other.label)}</b>${glyph("chevron.down", 14)}</span><select class="cover" data-profile-opponent aria-label="Compare with">${choices.map((choice) => `<option value="${e(choice.id)}" ${choice.id === other.id ? "selected" : ""}>${e(choice.label)}</option>`).join("")}</select>`)}</div><section class="panel ${tone} profile-compare"><div class="table-wrap"><table class="match-table"><thead><tr><th scope="col">Stat</th><th scope="col">${handle}</th><th scope="col">${other.id === myPlayerId() ? who(you, "You") : e(other.label)}</th></tr></thead><tbody>${lines.map(([label, read]) => `<tr><th scope="row">${label}</th><td>${read(entry)}</td><td>${read(theirs)}</td></tr>`).join("")}</tbody></table></div></section>`;
  // (headed "Their Records", "Their Flags": yours, at the table, "Your")
  const whose = profile.self ? "Your" : "Their";
  const records = `${heading(`${whose} Records`, "", "profile-records", tint)}${personalRecordsHtml(profile.personal || {}, profile.mine, `${e(name)} has no records yet.`)}`;
  // another player's flags: only the ones they have completed, in their own color
  const earned = new Set(profile.flags || []);
  const flags = bot
    ? ""
    : `${heading(`${whose} Flags`, "", "profile-flags", tint)}${earned.size ? flagCardsHtml({ rewards: false, earned, only: true, earnedColor: accent }) : `<p class="hint dark you-empty">${e(name)} hasn't completed any flags yet.</p>`}`;
  // (`extra`: at the table, what is being played, above their numbers)
  return `<div class="profile-body">${head}${extra}${rows}${compare}${records}${flags}</div>`;
}
/** Fetch a player's profile and how they compare with the viewer. */
async function fetchProfile(id, opponent = null) {
  const me = opponent || myPlayerId();
  const query = new URLSearchParams({ player: id, opponent: id === me ? "" : me, house_rules: "false" });
  // (the all-time records too, if not already loaded, to mark the ones this player holds)
  const [profile, stats] = await Promise.all([
    api(`/api/profile?player=${encodeURIComponent(id)}`),
    api("/api/stats?" + query).catch(() => null),
    leaderboardCache ? null : api("/api/leaderboards").then((boards) => (leaderboardCache = boards)).catch(() => null),
  ]);
  return { profile, stats };
}
let profileBack = "home"; // where the profile page's Back leads
/** Another player's profile, as a page of its own (your own is the You tab). */
async function profilePage(id) {
  if (!id || id === myPlayerId()) return home("you");
  profileBack = page === "home" ? homeTab : page === "history" ? "history" : page === "tournament" && tournament?.id ? { tournament: tournament.id } : page === "room" ? "resume" : "play";
  document.title = "Player · Golf";
  history.replaceState({}, "", appPath(`/player/${encodeURIComponent(id)}`));
  show("profile", `<div class="page scroll profile-page">${pageHead("data-profile-back")}<div data-profile-holder><div class="loading">Loading…</div></div></div>`);
  let body;
  try {
    const { profile, stats } = await fetchProfile(id);
    if (page !== "profile") return;
    body = profileHtml(profile, stats);
    profileShown = { profile, stats, opts: {} };
    document.title = `${profile.label || stats?.player?.profile.label || "Player"} · Golf`;
  } catch (error) {
    body = `<p class="empty">${e(error.message)}</p>`;
  }
  const holder = root.querySelector("[data-profile-holder]");
  if (holder) holder.innerHTML = body;
}
/* Comparing a profile with someone else: their stats side by side instead of yours. */
let profileShown = null; // {profile, opts}: the profile page or sheet showing, to draw again
async function compareProfileWith(select) {
  const holder = select.closest("[data-profile-holder], [data-profile-sheet]");
  const shown = holder && profileShown;
  if (!shown) return;
  const opponent = select.value;
  try {
    const { stats } = await fetchProfile(shown.profile.id, opponent);
    if (!holder.isConnected) return;
    shown.opts = { ...shown.opts, opponent };
    shown.stats = stats;
    holder.innerHTML = profileHtml(shown.profile, stats, shown.opts);
  } catch (error) {
    toast(error.message);
  }
}
document.addEventListener("change", (event) => {
  const select = event.target.closest?.("[data-profile-opponent]");
  if (select) compareProfileWith(select);
});
/** A friend request sent (or one of theirs accepted) from a profile. */
async function profileFriend(button, uniqueName) {
  if (!uniqueName) return;
  button.disabled = true;
  try {
    const result = await api("/api/friends", "POST", { unique_name: uniqueName });
    const label = button.querySelector("span:not(.tilt)");
    if (label) label.textContent = result.outcome === "requested" ? "Friend request sent" : "Friends";
    toast(result.outcome === "requested" ? "Friend request sent." : "You're friends now!");
  } catch (error) {
    button.disabled = false;
    toast(error.message);
  }
}
