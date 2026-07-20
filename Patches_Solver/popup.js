/*
 * Popup logic for the Patches Solver.
 *
 * Instead of talking to a pre-injected content script (fragile — see injected.js),
 * the popup INJECTS the engine on demand with chrome.scripting.executeScript into
 * every frame of the active tab. This means:
 *   - No "reload the page after installing" gotcha.
 *   - Works even if the game iframe loaded before the popup opened.
 *   - The board frame is reached automatically via allFrames.
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
    hint: "Checking this tab for a round of Patches…",
    act: null,
  },
  idle: {
    status: "No board found",
    label: "Open Patches game",
    hint: "The solver wakes up once a round is on screen.",
    act: "open",
  },
  ready: {
    // Patches boards aren't always square, so both dimensions are reported.
    status: (d) => `Board detected · ${d.rows}×${d.cols}`,
    label: "Solve puzzle",
    hint: "Tile the grid with the clued patches.",
    act: "solve",
  },
  solving: {
    status: "Placing patches…",
    label: "Solving",
    hint: "Watch the board — this takes a few seconds.",
    act: null,
  },
  solved: {
    status: (d) => `Solved · ${d.placed} patches placed`,
    label: "Solved",
    hint: "Enjoy the win — then try the next one unaided.",
    act: null,
  },
  // The board was already tiled when we looked — distinct from `solved`, which
  // means we did it. Nothing to claim credit for, so no entrance flourish either.
  done: {
    status: (d) => `Already solved · ${d.rows}×${d.cols}`,
    label: "Nothing to solve",
    hint: "This board is complete. Nice one.",
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

/** Lay out the grid itself, sized to the board. */
function buildGrid(rows, cols) {
  boardEl.style.setProperty("--rows", rows);
  boardEl.style.setProperty("--cols", cols);
  const frag = document.createDocumentFragment();
  const cellEls = [];
  for (let i = 0; i < rows * cols; i++) {
    const cell = document.createElement("div");
    cell.className = "board__cell";
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

/** Run runPatches(mode) in every frame; return the array of non-null results. */
async function runInFrames(mode) {
  const tabId = await getActiveTabId();
  if (tabId == null) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: runPatches, // from injected.js
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
    renderBoard(board.cells, board.rows, board.cols);
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
    setState(ok.alreadySolved ? "done" : "solved", {
      placed: ok.placed,
      rows: ok.rows,
      cols: ok.cols,
    });
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
// Draw the empty grid before the first paint so the popup opens as a board
// rather than snapping into one a moment later.
renderPlaceholder();
setState("checking");
refresh();
pollTimer = setInterval(refresh, POLL_MS);
