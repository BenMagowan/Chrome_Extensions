/*
 * Popup logic for the Tango Solver.
 *
 * Instead of talking to a pre-injected content script (fragile — see injected.js),
 * the popup INJECTS the engine on demand with chrome.scripting.executeScript into
 * every frame of the active tab. This means:
 *   - No "reload the page after installing" gotcha.
 *   - Works even if the game iframe loaded before the popup opened.
 *   - The board frame is reached automatically via allFrames.
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
    label: "Solve puzzle",
    hint: "Open a round of Tango to get started.",
    act: null,
  },
  idle: {
    status: "No board found",
    label: "Open Tango game",
    hint: "The solver wakes up once a round is on screen.",
    act: "open",
  },
  ready: {
    status: (d) => `Board detected · ${d.N}×${d.N}`,
    label: "Solve puzzle",
    hint: "Fill the grid with Suns and Moons.",
    act: "solve",
  },
  solving: {
    status: "Placing symbols…",
    label: "Solving",
    hint: "Watch the board — this takes a few seconds.",
    act: null,
  },
  solved: {
    status: (d) => `Solved · ${d.placed} symbols placed`,
    label: "Solved",
    hint: "Enjoy the win — then try the next one unaided.",
    act: null,
  },
  // The board was already finished when we looked — distinct from `solved`, which
  // means we did it. Nothing to claim credit for, so no entrance flourish either.
  done: {
    status: (d) => `Already solved · ${d.N}×${d.N}`,
    label: "Nothing to solve",
    hint: "This board is complete. Nice one.",
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
// The bite comes out of the upper right, as it does in the game.
const MOON_ANGLE = -45;

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
    if (c.locked) cell.classList.add("board__cell--locked");
    if (c.symbol === "Sun" || c.symbol === "Moon") {
      cell.classList.add(`board__cell--${c.symbol.toLowerCase()}`);
      cell.appendChild(symbolSvg(c.symbol));
    }
    frag.appendChild(cell);
  }
  boardEl.replaceChildren(frag);

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

const menuItems = () => Array.from(menuEl.querySelectorAll('[role="menuitem"]'));

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

// Every item is an external link; close so the popup isn't left with a stale menu.
menuEl.addEventListener("click", (e) => {
  if (e.target.closest('[role="menuitem"]')) closeMenu();
});

/* ------------------------------------------------------------------ solving */

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

/** Run runTango(mode) in every frame; return the array of non-null results. */
async function runInFrames(mode) {
  const tabId = await getActiveTabId();
  if (tabId == null) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: runTango, // from injected.js
      args: [mode],
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

  const results = await runInFrames("detect");
  const board = results.find((r) => r.solvable);

  if (board) {
    // Draw before switching state: the board element is revealed by the state
    // change, so filling it first avoids a frame of empty grid.
    renderBoard(board.cells, board.N);
    setState(board.solved ? "done" : "ready", { N: board.N });
    stopPolling(); // found it — stop re-checking
    return;
  }

  if (state === "checking" && Date.now() - openedAt < GRACE_MS) {
    // Still within the grace window: the game may simply not have rendered yet.
    return;
  }
  setState("idle");
}

actionBtn.addEventListener("click", async () => {
  const act = STATES[state].act;

  if (act === "open") {
    chrome.tabs.create({ url: GAME_URL });
    window.close();
    return;
  }
  if (act !== "solve") return;

  stopPolling();
  setState("solving");

  const results = await runInFrames("solve");
  const ok = results.find((r) => r.ok);

  if (ok) {
    // The engine reports alreadySolved if the board was completed between our last
    // poll and this click — don't take the credit for it.
    setState(ok.alreadySolved ? "done" : "solved", { placed: ok.placed, N: ok.N });
    return;
  }
  const err = results.find((r) => r.error);
  setState("error", {
    message: err ? err.error : "No board frame responded.",
  });
  // Deliberately no polling restart: the button stays live as "Try again", so a
  // retry is one click away and the error message survives long enough to read.
});

// Detect immediately, then keep polling so the button auto-enables the moment the
// game finishes loading — no need to close/reopen the popup.
loadBrandIcon();
setState("checking");
refresh();
pollTimer = setInterval(refresh, POLL_MS);
