/*
 * Popup logic for the Tango Solver.
 *
 * Instead of talking to a pre-injected content script (fragile — see injected.js),
 * the popup INJECTS the engine on demand with chrome.scripting.executeScript into
 * every frame of the active tab. This means:
 *   - No "reload the page after installing" gotcha.
 *   - Works even if the game iframe loaded before the popup opened.
 *   - The board frame is reached automatically via allFrames.
 * Auto-solve on page load is a different job, done by content.js with no popup.
 *
 * `runTango` is defined in injected.js (loaded before this file) and is passed by
 * reference to executeScript, which serializes it into the page's MAIN world.
 *
 * UI: the popup is a small state machine. STATES below is the only place that
 * decides what any state looks like; setState() writes data-state on <body> and
 * styles.css reacts to it. The JS never touches styles.
 */

const statusEl = document.getElementById("status-text");
const actionBtn = document.getElementById("action");
const actionLabel = document.getElementById("action-label");
const hintEl = document.getElementById("hint");
const brandIcon = document.getElementById("brand-icon");
const boardEl = document.getElementById("board");
const menuBtn = document.getElementById("menu-btn");
const menuEl = document.getElementById("menu");
const autoToggle = document.getElementById("autosolve-toggle");
const targetInput = document.getElementById("target-time");
const targetRange = document.getElementById("target-range");
const timerValueEl = document.getElementById("timer-value");

let pollTimer = null;

// URL of the LinkedIn Tango game, opened when no board is detected.
const GAME_URL = "https://www.linkedin.com/games/tango/";

const POLL_MS = 800;
// A board that is merely still rendering shouldn't flash "No board found" the
// instant the popup opens, so the opening state is held briefly before we
// conclude there's nothing there.
const GRACE_MS = 1600;

/**
 * Every UI state, in one table. `status`/`hint` may be functions of the payload.
 * `act` is what a click does: null means the button is inert.
 */
const STATES = {
  checking: {
    status: "Looking for a board…",
    label: "Looking for puzzle…",
    // The hint is the only prose on screen now that the board has taken the
    // status line's place, so it says what's happening rather than jumping
    // ahead to advice we may be about to make redundant.
    hint: "Checking this tab for the Tango game…",
    act: null,
  },
  idle: {
    status: "No board found",
    label: "Open Tango game",
    hint: "Open settings to toggle auto-solve or set a target time.",
    act: "open",
  },
  ready: {
    status: (d) => `Board detected · ${d.N}×${d.N}`,
    label: "Solve puzzle",
    hint: "Open settings to set a target time.",
    act: "solve",
  },
  solving: {
    status: "Placing symbols…",
    label: "Solving",
    hint: "Open settings to set a target time.",
    act: null,
  },
  solved: {
    // The elapsed time is appended here too (not just on the visible chip) so the
    // live region reads it aloud.
    status: (d) => {
      const base = `Solved · ${d.placed} symbols placed`;
      return d.ms != null ? `${base} · ${fmtTime(d.ms)}` : base;
    },
    label: "Solved",
    hint: "Check out the other puzzle solvers in the menu.",
    act: null,
  },
  // The board was already finished when we looked — distinct from `solved`, which
  // means we did it. Nothing to claim credit for, so no entrance flourish either.
  done: {
    status: (d) => `Already solved · ${d.N}×${d.N}`,
    label: "Nothing to solve",
    hint: "This board is solved. Check out the other puzzle solvers in the menu.",
    act: null,
  },
  error: {
    status: (d) => d.message,
    label: "Try again",
    hint: "The board may still be loading, or the page has changed.",
    act: "solve",
  },
};

let state = "checking";
const openedAt = Date.now();

const resolve = (v, d) => (typeof v === "function" ? v(d) : v);

/** The single way the UI changes. */
function setState(next, data = {}) {
  const spec = STATES[next];
  state = next;
  document.body.dataset.state = next;
  statusEl.textContent = resolve(spec.status, data);
  actionLabel.textContent = spec.label;
  hintEl.textContent = resolve(spec.hint, data);
  actionBtn.disabled = spec.act === null;
  actionBtn.setAttribute("aria-busy", String(next === "solving"));
}

/* -------------------------------------------------------------- board preview */

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/**
 * Sun and moon, drawn rather than fetched: the popup can't reuse the game's own
 * sprites, and inline SVG takes its colour from the stylesheet so both symbols
 * theme with the rest of the popup.
 */
// Both pieces are the same disc, so the Sun and the Moon read as the same size.
const SYMBOL_R = 9;
// How much of that disc survives the bite, measured across the crescent's waist.
const MOON_WAIST = 8;
// The bite comes out of the top left, as it does in the game.
const MOON_ANGLE = 225;

/**
 * Crescent = disc1 minus disc2, both radius R, disc2's centre shifted `waist` to
 * the right of disc1's. The two arcs below trace exactly that boundary — around
 * disc1's far edge, then back along disc2's near edge — so it's one simple closed
 * path rather than an overlap needing a fill rule to resolve. The offset IS the
 * crescent's thickness at its waist: small is a sliver, approaching 2R is a disc.
 */
function moonPath(cx, cy, R, waist) {
  const h = Math.sqrt(R * R - (waist / 2) ** 2); // half the chord where the discs cross
  const xMid = cx + waist / 2; // the discs cross on this vertical line
  const top = `${xMid} ${cy - h}`;
  const bottom = `${xMid} ${cy + h}`;
  // Flags matter and are easy to get backwards — each arc has two candidate
  // centres and two directions, and picking wrong silently traces the *other*
  // disc. Down the left: disc1's major arc (large-arc 1), anticlockwise on screen
  // (sweep 0). Back up: disc2's minor arc (0) bulging left, clockwise (1).
  return `M${top}A${R} ${R} 0 1 0 ${bottom}A${R} ${R} 0 0 1 ${top}Z`;
}

function symbolSvg(symbol) {
  const svg = svgEl("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
  if (symbol === "Moon") {
    svg.appendChild(
      svgEl("path", {
        d: moonPath(12, 12, SYMBOL_R, MOON_WAIST),
        transform: `rotate(${MOON_ANGLE} 12 12)`,
      })
    );
    return svg;
  }
  svg.appendChild(svgEl("circle", { cx: 12, cy: 12, r: SYMBOL_R }));
  return svg;
}

// Every Tango board is 6×6, so the empty grid can be drawn at the real size and
// the popup never resizes when an actual board turns up.
const DEFAULT_N = 6;

/**
 * The class that rounds a cell's outer corner to match the board's radius, or ""
 * for a non-corner cell. The board is rounded + `overflow: hidden`, so without
 * this the four square corner cells are clipped and read as "cut off". Works for
 * any N since it keys off row/col.
 */
function cornerClass(row, col, N) {
  const top = row === 0;
  const bottom = row === N - 1;
  const left = col === 0;
  const right = col === N - 1;
  if (top && left) return "board__cell--tl";
  if (top && right) return "board__cell--tr";
  if (bottom && left) return "board__cell--bl";
  if (bottom && right) return "board__cell--br";
  return "";
}

/**
 * The empty grid shown until a board is found — it says "no board yet" in the
 * shape of the thing we're waiting for, which the old "No board found" line
 * couldn't. Purely decorative: the status line is still there for screen
 * readers, so this would only be noise in the a11y tree.
 */
function renderPlaceholder() {
  boardEl.style.setProperty("--n", DEFAULT_N);
  const frag = document.createDocumentFragment();
  for (let i = 0; i < DEFAULT_N * DEFAULT_N; i++) {
    const cell = document.createElement("div");
    cell.className = "board__cell";
    const corner = cornerClass(Math.floor(i / DEFAULT_N), i % DEFAULT_N, DEFAULT_N);
    if (corner) cell.classList.add(corner);
    frag.appendChild(cell);
  }
  boardEl.replaceChildren(frag);
  boardEl.setAttribute("aria-hidden", "true");
}

/**
 * Draw the detect snapshot — the grid with the SOLUTION's symbols on it (see
 * snapshot in injected.js). Replaces the "Board detected · N×N" line: the grid
 * says the same thing and shows the answer besides.
 */
function renderBoard(cells, N) {
  if (!Array.isArray(cells) || !cells.length) return;

  boardEl.style.setProperty("--n", N);

  // Sort into row-major order: the DOM order is whatever the page had, but CSS
  // grid places children sequentially, so the preview must be explicitly ordered.
  const ordered = [...cells].sort((a, b) => a.row - b.row || a.col - b.col);

  const frag = document.createDocumentFragment();
  for (const c of ordered) {
    const cell = document.createElement("div");
    cell.className = "board__cell";
    const corner = cornerClass(c.row, c.col, N);
    if (corner) cell.classList.add(corner);
    if (c.locked) cell.classList.add("board__cell--locked");
    if (c.symbol === "Sun" || c.symbol === "Moon") {
      cell.classList.add(`board__cell--${c.symbol.toLowerCase()}`);
      cell.appendChild(symbolSvg(c.symbol));
    }
    frag.appendChild(cell);
  }
  boardEl.replaceChildren(frag);

  // A real board is worth describing, unlike the placeholder it replaces.
  boardEl.removeAttribute("aria-hidden");
  boardEl.setAttribute("aria-label", `Solution preview, ${N} by ${N}.`);
}

/* ---------------------------------------------------------------- brand icon */

/**
 * Show the extension's own icon, resolved through chrome.runtime.getURL so it
 * works regardless of how the popup document is served. Sizes are tried largest
 * first and we step down on error, so a missing file degrades instead of
 * leaving a broken image.
 */
const ICON_SIZES = [128, 48, 32, 16];

function loadBrandIcon(i = 0) {
  if (i >= ICON_SIZES.length) {
    brandIcon.hidden = true; // nothing loadable — drop it rather than show a broken img
    return;
  }
  const path = `images/icon-${ICON_SIZES[i]}.png`;
  brandIcon.onerror = () => loadBrandIcon(i + 1);
  brandIcon.src =
    typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL
      ? chrome.runtime.getURL(path)
      : path;
}

/* --------------------------------------------------------------- settings menu */

const menuItems = () =>
  Array.from(menuEl.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]'));

function openMenu(focusFirst = true) {
  if (!menuEl.hidden) return;
  menuEl.hidden = false;
  menuBtn.setAttribute("aria-expanded", "true");
  if (focusFirst) menuItems()[0]?.focus();
  // Listen on the capture phase so a click anywhere outside closes the menu.
  document.addEventListener("pointerdown", onOutsidePointer, true);
}

function closeMenu({ refocus = false } = {}) {
  if (menuEl.hidden) return;
  menuEl.hidden = true;
  menuBtn.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onOutsidePointer, true);
  // Only pull focus back when the user dismissed it deliberately (Escape /
  // toggle); doing it on outside-click would steal focus from whatever they hit.
  if (refocus) menuBtn.focus();
}

function onOutsidePointer(e) {
  if (!menuEl.contains(e.target) && !menuBtn.contains(e.target)) closeMenu();
}

/** Roving focus through the items, per the menu keyboard conventions. */
function focusItem(delta) {
  const items = menuItems();
  if (!items.length) return;
  const i = items.indexOf(document.activeElement);
  const next = i === -1 ? 0 : (i + delta + items.length) % items.length;
  items[next].focus();
}

menuBtn.addEventListener("click", () => {
  if (menuEl.hidden) openMenu();
  else closeMenu({ refocus: true });
});

// Open with the keyboard straight onto an item, matching native menu behaviour.
menuBtn.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    openMenu(false);
    const items = menuItems();
    (e.key === "ArrowDown" ? items[0] : items[items.length - 1])?.focus();
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !menuEl.hidden) {
    e.preventDefault();
    closeMenu({ refocus: true });
    return;
  }
  if (menuEl.hidden) return;
  // The Solve-time controls own their own arrow keys (the box steps with ↑/↓, the
  // slider moves), so don't rove the menu out from under them while focused.
  if (
    (e.target === targetInput || e.target === targetRange) &&
    (e.key === "ArrowUp" || e.key === "ArrowDown")
  ) {
    return;
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    focusItem(1);
  } else if (e.key === "ArrowUp") {
    e.preventDefault();
    focusItem(-1);
  } else if (e.key === "Tab") {
    closeMenu(); // let focus move on naturally
  }
});

// Activating a link navigates away, so close the menu behind it. The auto-solve
// toggle is deliberately excluded: flipping it should leave the menu open so the
// switch is seen to move, and it has its own handler below.
menuEl.addEventListener("click", (e) => {
  if (e.target.closest('a[role="menuitem"]')) closeMenu();
});

/* ---------------------------------------------------------------- settings */

// Two settings: Auto-solve (on by default — the opt-out lives in this menu) and
// the target Solve time in whole seconds.
//
// Storage is deliberately split:
//  - The popup's own copy lives in synchronous localStorage, so a change is durable
//    the instant it's made. chrome.storage.local.set is ASYNC, and a popup that
//    closes right after a toggle can be torn down before that write flushes.
//  - The auto-solve content script can't read the popup's localStorage (different
//    origin), so we ALSO mirror to chrome.storage.local for it (best-effort), and
//    reconcile that mirror from localStorage every time the popup opens in case a
//    mirror write was ever lost.
// Keep TARGET_KEY / AUTOSOLVE_KEY in step with content.js (it reads the mirror).
const AUTOSOLVE_KEY = "autosolve";
const TARGET_KEY = "targetMs";
const TARGET_MIN_S = 1;
const TARGET_MAX_S = 999; // the text box accepts up to three digits
const SLIDER_MAX_S = 60; // the slider covers the common range; it pins here for larger values
const DEFAULT_TARGET_S = 5; // default solve time when nothing is stored yet

let autoSolve = true; // on by default — the opt-out lives in the settings menu
let targetMs = DEFAULT_TARGET_S * 1000;

// Clamp for the text box (full 1–999 range) and for the slider (its own 1–60).
const clampSecs = (s) => Math.min(TARGET_MAX_S, Math.max(TARGET_MIN_S, s));
const sliderSecs = (s) => Math.min(SLIDER_MAX_S, Math.max(TARGET_MIN_S, s));

/** Push the in-memory settings onto both controls, keeping them in sync. */
function reflectSettings() {
  autoToggle.setAttribute("aria-checked", String(autoSolve));
  const secs = Math.round(targetMs / 1000);
  targetInput.value = String(secs);
  targetRange.value = String(sliderSecs(secs)); // slider pins at 60 for larger values
}

/** Mirror the current settings to chrome.storage.local for the content script. */
function mirrorToContentScript() {
  try {
    chrome.storage.local.set({ [AUTOSOLVE_KEY]: autoSolve, [TARGET_KEY]: targetMs });
  } catch {
    /* mirror unavailable — the popup's own localStorage copy still holds */
  }
}

/** Persist to the reliable popup store, then mirror for the content script. */
function saveSettings() {
  try {
    localStorage.setItem(AUTOSOLVE_KEY, autoSolve ? "1" : "0");
    localStorage.setItem(TARGET_KEY, String(targetMs));
  } catch {
    /* localStorage blocked — settings still apply for this popup session */
  }
  mirrorToContentScript();
}

function loadSettings() {
  // localStorage is the popup's authoritative store (only the popup writes settings,
  // and it always writes here), so reading it is enough — no async round-trip.
  try {
    // Absent key → keep the default (on); an explicit "0" means the user opted out.
    const storedAuto = localStorage.getItem(AUTOSOLVE_KEY);
    if (storedAuto !== null) autoSolve = storedAuto === "1";
    const ms = parseInt(localStorage.getItem(TARGET_KEY), 10);
    if (Number.isFinite(ms)) targetMs = clampSecs(Math.round(ms / 1000)) * 1000;
  } catch {
    /* localStorage blocked — fall back to the defaults already in place */
  }
  reflectSettings();
  // Re-assert the content script's mirror from the reliable copy on every open.
  mirrorToContentScript();
}

autoToggle.addEventListener("click", () => {
  autoSolve = !autoSolve;
  reflectSettings();
  saveSettings();
  // If a solvable board is already sitting in `ready`, honour the new setting at
  // once rather than waiting for the next detect that may never come (polling has
  // stopped once a board is found).
  if (autoSolve && state === "ready") runSolve();
});

// The seconds the field currently shows, or the last good value if it's mid-edit
// (blank / not yet a number).
function fieldSecs() {
  const s = parseInt(targetInput.value, 10);
  return Number.isFinite(s) ? s : Math.round(targetMs / 1000);
}

// Store a seconds value and mirror it onto BOTH controls, then persist. Used
// wherever the displayed value should be rewritten (slider, ↑/↓, commit) — the
// live text-box `input` handler below is the one exception, so it doesn't fight
// the caret while the user is mid-type.
function setTargetSecs(secs) {
  targetMs = secs * 1000;
  targetInput.value = String(secs);
  targetRange.value = String(sliderSecs(secs));
  saveSettings();
}

// The slider only spans 1–60, so its value is always in range; it drives the box.
targetRange.addEventListener("input", () => {
  setTargetSecs(sliderSecs(parseInt(targetRange.value, 10) || TARGET_MIN_S));
});

// Typing: keep the box to at most three digits and persist as the user types (so a
// value is saved even if they close the popup without blurring), syncing the
// slider — but leave the field text alone so the caret isn't disturbed. The text
// isn't clamped mid-type (so "9"→"99"→"999" is allowed); commit normalises it.
targetInput.addEventListener("input", () => {
  const digits = targetInput.value.replace(/\D/g, "").slice(0, 3);
  if (digits !== targetInput.value) targetInput.value = digits;
  const secs = clampSecs(fieldSecs());
  targetMs = secs * 1000;
  targetRange.value = String(sliderSecs(secs));
  saveSettings();
});

// Commit: clamp into range and normalise what's shown (e.g. "0"→"1", "9999"→"999",
// blank→last good).
const commitTarget = () => setTargetSecs(clampSecs(fieldSecs()));
targetInput.addEventListener("change", commitTarget);
targetInput.addEventListener("blur", commitTarget);

// Native-feeling ↑/↓ stepping and Enter-to-commit inside the box.
targetInput.addEventListener("keydown", (e) => {
  if (e.key === "ArrowUp" || e.key === "ArrowDown") {
    e.preventDefault();
    setTargetSecs(clampSecs(fieldSecs() + (e.key === "ArrowUp" ? 1 : -1)));
  } else if (e.key === "Enter") {
    e.preventDefault();
    targetInput.blur();
  }
});

/* -------------------------------------------------------------------- timer */

// How long the last solve took: counts up live while symbols are placed, frozen
// at the total once the board is complete. `elapsedMs` is read back by runSolve
// to hand the final figure to the solved state.
let timerStart = 0;
let timerTick = null;
let elapsedMs = 0;

function fmtTime(ms) {
  return (Math.max(0, ms) / 1000).toFixed(1) + "s";
}

function startTimer() {
  timerStart = performance.now();
  elapsedMs = 0;
  timerValueEl.textContent = fmtTime(0);
  timerTick = setInterval(() => {
    elapsedMs = performance.now() - timerStart;
    timerValueEl.textContent = fmtTime(elapsedMs);
  }, 100);
}

function stopTimer() {
  if (timerTick) {
    clearInterval(timerTick);
    timerTick = null;
  }
  elapsedMs = performance.now() - timerStart;
  timerValueEl.textContent = fmtTime(elapsedMs);
}

/* ------------------------------------------------------------------ solving */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function getActiveTabId() {
  const tab = await getActiveTab();
  return tab ? tab.id : null;
}

// The Tango game page (guest and signed-in both live here). Subdomain optional
// so both `www.linkedin.com` and a bare `linkedin.com` match.
const GAME_URL_RE = /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\/games\/(view\/)?tango/i;

// A tab's `url` is only populated for origins we hold host permission for, so a
// blank url already means "not LinkedIn" — and on the game page it's the tango
// URL. Either way, a non-match means there's no puzzle to look for here.
function isGameUrl(url) {
  return typeof url === "string" && GAME_URL_RE.test(url);
}

/** Run runTango(mode, opts) in every frame; return the array of non-null results. */
async function runInFrames(mode, opts) {
  const tabId = await getActiveTabId();
  if (tabId == null) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: runTango, // from injected.js
      args: [mode, opts || {}],
    });
    return results.map((r) => r && r.result).filter(Boolean);
  } catch (e) {
    // e.g. not a linkedin tab, or the frame can't be scripted — treat as "no board".
    return [];
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * States that are the result of the user pressing the button. Once we're in one,
 * the poller must not speak over it — an "error" in particular stays put until
 * the user retries, since the board is usually still detectable and a poll would
 * otherwise wipe the message back to "ready" a moment after they'd read it.
 */
const USER_OWNED = new Set(["solving", "solved", "error"]);

/**
 * content.js's auto-solve marker (see there) from whichever frame carries one —
 * only the frame it solved in does — or null. The reader is passed to
 * executeScript, so it must be self-contained.
 */
async function readAutoSolve() {
  const tabId = await getActiveTabId();
  if (tabId == null) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const d = document.documentElement.dataset;
        if (!d.autosolve) return null;
        let result = null;
        try {
          result = JSON.parse(d.autosolveResult || "null");
        } catch {
          /* unreadable — treat as no result */
        }
        return { state: d.autosolve, startedAt: Number(d.autosolveStart) || Date.now(), result };
      },
    });
    return results.map((r) => r && r.result).find(Boolean) || null;
  } catch (e) {
    return null;
  }
}

/**
 * True while the `solving` on screen is content.js's auto-solve rather than one
 * this popup started. That solve isn't ours to await, so refresh() keeps polling
 * through it to catch the finish from content.js's marker.
 */
let watchingAuto = false;

/**
 * Whether a solve this popup started now owns the UI (see USER_OWNED). Checked
 * again after refresh()'s awaits, since Solve can be pressed while a poll is in
 * flight — the poller keeps running on a `ready` board when Auto-solve is on.
 */
const superseded = () => USER_OWNED.has(state) && !watchingAuto;

/**
 * Mirror content.js's auto-solve in the popup: `solving` while it runs, with the
 * timer counting from when it started, then `solved` with its result and time.
 * Returns true when the auto-solve decided the state. A "solved" marker only
 * counts if we watched it land or the board really is solved; otherwise it was
 * left by an earlier board in the same page.
 */
function showAutoSolve(auto, boardSolved, data) {
  if (auto && auto.state === "solving") {
    if (!watchingAuto) {
      watchingAuto = true;
      setState("solving", data);
      startTimer();
      timerStart -= Date.now() - auto.startedAt; // count from content.js's start
    }
    return true; // keep polling to catch the finish
  }
  const wasWatching = watchingAuto;
  if (wasWatching) {
    watchingAuto = false;
    stopTimer();
  }
  if (auto && auto.state === "solved" && auto.result && (wasWatching || boardSolved)) {
    // Quote content.js's own figure, which covers its whole solve.
    elapsedMs = auto.result.ms;
    timerValueEl.textContent = fmtTime(elapsedMs);
    setState("solved", { ...data, ...auto.result });
    stopPolling();
    return true;
  }
  return false;
}

/** Detect a board; move to `ready` only when one is present & solvable. */
async function refresh() {
  if (superseded()) return;

  // If we're not on the Tango game page, there is no board to find — go straight
  // to "open the game" instead of flashing "Looking for puzzle…" on an unrelated
  // tab, which is a claim that only makes sense on the game itself.
  const tab = await getActiveTab();
  if (!tab || !isGameUrl(tab.url)) {
    setState("idle");
    return;
  }

  const results = await runInFrames("detect");
  const board = results.find((r) => r.solvable);

  if (board) {
    const auto = await readAutoSolve();
    if (superseded()) return; // Solve was pressed while we were looking
    // Draw before switching state: the board element is revealed by the state
    // change, so filling it first avoids a frame of empty grid.
    renderBoard(board.cells, board.N);
    // NB: no auto-solve on detect here. When Auto-solve is on, the content script
    // (content.js) is already solving on page load; having the popup ALSO fire on
    // open would run a second solve concurrently. Auto-solve while the popup is
    // open is instead handled by the toggle handler (enabling it on a `ready`
    // board solves once). What the popup does do is mirror content.js's solve.
    if (showAutoSolve(auto, board.solved, { N: board.N })) return;
    setState(board.solved ? "done" : "ready", { N: board.N });
    // Found it — stop re-checking. Except with Auto-solve on and no marker yet:
    // content.js is still due to start on this board (its poll just hasn't come
    // round), so keep watching for it rather than parking on "Solve puzzle".
    if (board.solved || !autoSolve || auto) stopPolling();
    return;
  }

  if (state === "checking" && Date.now() - openedAt < GRACE_MS) {
    // Still within the grace window: the game may simply not have rendered yet.
    return;
  }
  setState("idle");
}

/**
 * Solve the current board. Shared by the Solve button and the auto-solve toggle,
 * so the timer and result handling live in one place. Assumes a board is present
 * (both callers only reach here after a successful detect).
 */
async function runSolve() {
  stopPolling();
  setState("solving");
  startTimer();

  // Pace the solve to the target time set in the menu (the engine spreads its
  // clicks to land near it), so the completion timer settles around that figure.
  const results = await runInFrames("solve", { targetMs });
  stopTimer();

  const ok = results.find((r) => r.ok);
  if (ok) {
    // The engine reports alreadySolved if the board was completed between our last
    // poll and this click — don't take the credit for it, and don't quote a time
    // for a solve we didn't run.
    setState(ok.alreadySolved ? "done" : "solved", {
      placed: ok.placed,
      N: ok.N,
      ms: ok.alreadySolved ? null : elapsedMs,
    });
    return;
  }
  const err = results.find((r) => r.error);
  setState("error", {
    message: err ? err.error : "No board frame responded.",
  });
  // Deliberately no polling restart: the button stays live as "Try again", so a
  // retry is one click away and the error message survives long enough to read.
}

actionBtn.addEventListener("click", () => {
  const act = STATES[state].act;

  if (act === "open") {
    chrome.tabs.create({ url: GAME_URL });
    window.close();
    return;
  }
  if (act !== "solve") return;

  runSolve();
});

// Detect immediately, then keep polling so the button auto-enables the moment the
// game finishes loading — no need to close/reopen the popup.
function init() {
  loadBrandIcon();
  // Draw the empty grid before the first paint so the popup opens as a board
  // rather than snapping into one a moment later.
  renderPlaceholder();
  setState("checking");
  // Load settings (synchronous — see loadSettings) before the first detect.
  loadSettings();
  refresh();
  pollTimer = setInterval(refresh, POLL_MS);
}

init();
