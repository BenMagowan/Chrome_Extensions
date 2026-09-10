/*
 * Popup logic for the Patches Solver.
 *
 * Instead of talking to a pre-injected content script (fragile — see injected.js),
 * the popup INJECTS the engine on demand with chrome.scripting.executeScript into
 * every frame of the active tab. This means:
 *   - No "reload the page after installing" gotcha.
 *   - Works even if the game iframe loaded before the popup opened.
 *   - The board frame is reached automatically via allFrames.
 * Auto-solve on page load is a different job, done by content.js with no popup.
 *
 * `runPatches` is defined in injected.js (loaded before this file) and is passed by
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

// URL of the LinkedIn Patches game, opened when no board is detected.
const GAME_URL = "https://www.linkedin.com/games/patches/";

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
    hint: "Checking this tab for the Patches game…",
    act: null,
  },
  idle: {
    status: "No board found",
    label: "Open Patches game",
    hint: "Open settings to toggle auto-solve or set a target time.",
    act: "open",
  },
  ready: {
    // Patches boards aren't always square, so both dimensions are reported.
    status: (d) => `Board detected · ${d.rows}×${d.cols}`,
    label: "Solve puzzle",
    hint: "Open settings to set a target time.",
    act: "solve",
  },
  solving: {
    status: "Placing patches…",
    label: "Solving",
    hint: "Open settings to set a target time.",
    act: null,
  },
  solved: {
    // The elapsed time is appended here too (not just on the visible chip) so the
    // live region reads it aloud.
    status: (d) => {
      const base = `Solved · ${d.placed} patches placed`;
      return d.ms != null ? `${base} · ${fmtTime(d.ms)}` : base;
    },
    label: "Solved",
    hint: "Check out the other puzzle solvers in the menu.",
    act: null,
  },
  // The board was already tiled when we looked — distinct from `solved`, which
  // means we did it. Nothing to claim credit for, so no entrance flourish either.
  done: {
    status: (d) => `Already solved · ${d.rows}×${d.cols}`,
    label: "Nothing to solve",
    hint: "This board is solved. Check out the other puzzle solvers in the menu.",
    act: null,
  },
  // Patches only: detect can find a real board that has no valid tiling. That
  // is emphatically not "no board found", so it gets its own state rather than
  // being flattened into idle — the user should know the board WAS seen.
  stuck: {
    status: "Board found, but no solution exists",
    label: "Nothing to solve",
    hint: "This layout can't be tiled with the patches given.",
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

// Patches boards vary in size and aren't always square. The empty grid just uses
// a common shape; renderBoard resizes to the real one the moment we know it.
const DEFAULT_ROWS = 7;
const DEFAULT_COLS = 7;

/**
 * A patch's fill. Stepping the hue by the golden angle rather than dividing the
 * wheel evenly: clues come out roughly in reading order, so patches that sit
 * next to each other tend to have consecutive indices — and an even division
 * hands consecutive indices neighbouring hues, which is exactly when two
 * touching patches blur into one. A ~137° step puts them across the wheel from
 * each other instead, for any number of patches.
 *
 * Only the hue is set here; saturation and lightness live in the stylesheet, so
 * the same patch reads as a pastel in light mode and a deep tone in dark.
 */
const GOLDEN_ANGLE = 137.508;

function patchHue(patchIndex) {
  return Math.round((patchIndex * GOLDEN_ANGLE) % 360);
}

/**
 * The class that rounds a cell's outer corner to match the board's radius, or ""
 * for a non-corner cell. The board is rounded + `overflow: hidden`, so without
 * this the four square corner cells' patch colours are clipped into a dark notch.
 * Takes rows and cols separately since Patches boards needn't be square.
 */
function cornerClass(row, col, rows, cols) {
  const top = row === 0;
  const bottom = row === rows - 1;
  const left = col === 0;
  const right = col === cols - 1;
  if (top && left) return "board__cell--tl";
  if (top && right) return "board__cell--tr";
  if (bottom && left) return "board__cell--bl";
  if (bottom && right) return "board__cell--br";
  return "";
}

/** Lay out the grid itself, sized to the board. */
function buildGrid(rows, cols) {
  boardEl.style.setProperty("--rows", rows);
  boardEl.style.setProperty("--cols", cols);
  const frag = document.createDocumentFragment();
  const cellEls = [];
  for (let i = 0; i < rows * cols; i++) {
    const cell = document.createElement("div");
    cell.className = "board__cell";
    const corner = cornerClass(Math.floor(i / cols), i % cols, rows, cols);
    if (corner) cell.classList.add(corner);
    cellEls.push(cell);
    frag.appendChild(cell);
  }
  return { frag, cellEls };
}

/**
 * The empty grid shown until a board is found — it says "no board yet" in the
 * shape of the thing we're waiting for, which the old "No board found" line
 * couldn't. Purely decorative: the status line is still there for screen
 * readers, so this would only be noise in the a11y tree.
 */
function renderPlaceholder() {
  const { frag } = buildGrid(DEFAULT_ROWS, DEFAULT_COLS);
  boardEl.replaceChildren(frag);
  boardEl.setAttribute("aria-hidden", "true");
}

/**
 * Draw the detect snapshot — the grid tiled into the SOLUTION's patches with the
 * clues on top (see snapshot in injected.js). Replaces the "Board detected"
 * line: the grid says the same thing and shows the answer besides.
 *
 * Cells with no patch (`patch === -1`) keep the bare surface. That happens on a
 * board we found but couldn't tile, where a bare grid carrying just the clues is
 * the honest picture — better than inventing a tiling to have something to show.
 */
function renderBoard(cells, rows, cols) {
  if (!Array.isArray(cells) || !cells.length) return;

  const { frag, cellEls } = buildGrid(rows, cols);
  for (const c of cells) {
    const cell = cellEls[c.row * cols + c.col];
    if (c.patch >= 0) {
      cell.classList.add("board__cell--patch");
      cell.style.setProperty("--hue", patchHue(c.patch));
    }
    if (!c.clue) continue;
    // The clue markers ride on top of their patch, as they do in the game. An
    // unnumbered clue still gets its disc — it's a clue, it just isn't sized.
    const dot = document.createElement("span");
    dot.className = "board__clue";
    if (c.clue.area != null) dot.textContent = String(c.clue.area);
    cell.appendChild(dot);
  }
  boardEl.replaceChildren(frag);

  // A real board is worth describing, unlike the placeholder it replaces.
  boardEl.removeAttribute("aria-hidden");
  boardEl.setAttribute("aria-label", `Solution preview, ${rows} by ${cols}.`);
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

// How long the last solve took: counts up live while patches are drawn, frozen
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

// The Patches game page (guest and signed-in both live here). Subdomain optional
// so both `www.linkedin.com` and a bare `linkedin.com` match.
const GAME_URL_RE = /^https?:\/\/([a-z0-9-]+\.)*linkedin\.com\/games\/(view\/)?patches/i;

// A tab's `url` is only populated for origins we hold host permission for, so a
// blank url already means "not LinkedIn" — and on the game page it's the patches
// URL. Either way, a non-match means there's no puzzle to look for here.
function isGameUrl(url) {
  return typeof url === "string" && GAME_URL_RE.test(url);
}

/** Run runPatches(mode, opts) in every frame; return the array of non-null results. */
async function runInFrames(mode, opts) {
  const tabId = await getActiveTabId();
  if (tabId == null) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: runPatches, // from injected.js
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

/** Detect a board; move to `ready` only when one is present & solvable. */
async function refresh() {
  if (USER_OWNED.has(state)) return;

  // If we're not on the Patches game page, there is no board to find — go straight
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
    // Draw before switching state: the board element is revealed by the state
    // change, so filling it first avoids a frame of empty grid.
    renderBoard(board.cells, board.rows, board.cols);
    // NB: no auto-solve on detect here. When Auto-solve is on, the content script
    // (content.js) is already solving on page load; having the popup ALSO fire on
    // open would run a second solve concurrently. Auto-solve while the popup is
    // open is instead handled by the toggle handler (enabling it on a `ready`
    // board solves once).
    setState(board.solved ? "done" : "ready", { rows: board.rows, cols: board.cols });
    stopPolling(); // found it — stop re-checking
    return;
  }

  // A board is on screen but no tiling was found — don't claim there's no board.
  const present = results.find((r) => r.present);
  if (present) {
    // Still worth drawing: the clues on a bare grid show what we were looking at
    // when we gave up, which reads far better than an empty placeholder.
    renderBoard(present.cells, present.rows, present.cols);
    setState("stuck");
    stopPolling();
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
  // key presses to land near it), so the completion timer settles around that figure.
  const results = await runInFrames("solve", { targetMs });
  stopTimer();

  const ok = results.find((r) => r.ok);
  if (ok) {
    // The engine reports alreadySolved if the board was completed between our last
    // poll and this click — don't take the credit for it, and don't quote a time
    // for a solve we didn't run.
    setState(ok.alreadySolved ? "done" : "solved", {
      placed: ok.placed,
      rows: ok.rows,
      cols: ok.cols,
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
