/*
 * Popup logic for the Queens Auto-Solver.
 *
 * Instead of talking to a pre-injected content script (fragile — see injected.js),
 * the popup INJECTS the engine on demand with chrome.scripting.executeScript into
 * every frame of the active tab. This means:
 *   - No "reload the page after installing" gotcha.
 *   - Works even if the game iframe loaded before the popup opened.
 *   - The board frame is reached automatically via allFrames.
 *
 * `runQueens` is defined in injected.js (loaded before this file) and is passed by
 * reference to executeScript, which serializes it into the page's MAIN world.
 *
 * UI: the popup is a small state machine. STATES below is the only place that
 * decides what any state looks like; setState() writes data-state on <body> and
 * styles.css does the rest. Nothing here touches styles directly.
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

// URL of the LinkedIn Queens game, opened when no board is detected.
const QUEENS_URL = "https://www.linkedin.com/games/queens/";

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
    hint: "Open a round of Queens to get started.",
    act: null,
  },
  idle: {
    status: "No board found",
    label: "Open Queens game",
    hint: "The solver wakes up once a round is on screen.",
    act: "open",
  },
  ready: {
    status: (d) => `Board detected · ${d.N}×${d.N}`,
    label: "Solve puzzle",
    hint: "One crown per row, column and colour.",
    act: "solve",
  },
  solving: {
    status: "Placing crowns…",
    label: "Solving",
    hint: "Watch the board — this takes a few seconds.",
    act: null,
  },
  solved: {
    // Mention the clean-up only when there was one, so a solve from an empty board
    // doesn't advertise a step that didn't happen.
    status: (d) =>
      d.cleared
        ? `Solved · ${d.placed} crowns placed, ${d.cleared} cleared`
        : `Solved · ${d.placed} crowns placed`,
    label: "Solved",
    hint: "Enjoy the win — then try the next one unaided.",
    act: null,
  },
  // The board was already finished when we looked — distinct from `solved`, which
  // means we did it. Nothing to claim credit for, so no crown flourish either.
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

/**
 * Fallback region colours, used only if the page didn't give us usable swatches
 * (see swatchOf in injected.js). Hues are evenly spaced so adjacent regions stay
 * distinguishable whatever N is, rather than being a fixed list that runs out.
 */
function fallbackColor(regionIndex, regionCount) {
  const hue = Math.round((360 / Math.max(regionCount, 1)) * regionIndex);
  return `hsl(${hue} 62% 78%)`;
}

const QUEEN_PATH =
  "M4.4 16.6 3.6 9.1l4.6 3.2L12 6.2l3.8 6.1 4.6-3.2-.8 7.5z M4.2 18.3h15.6v3.1H4.2z";

function queenSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", QUEEN_PATH);
  svg.appendChild(p);
  return svg;
}

/**
 * Draw the detect snapshot. Replaces the "Board detected · N×N" line — the grid
 * itself communicates size, regions and progress far better than the sentence.
 */
function renderBoard(cells, N) {
  if (!Array.isArray(cells) || !cells.length) return;

  // Only trust the page's own colours if they actually distinguish the regions;
  // a board whose swatches all resolve the same (or missing) would otherwise
  // render as one flat block. Falling back keeps the preview readable.
  const regions = [...new Set(cells.map((c) => c.region))];
  const distinct = new Set(cells.map((c) => c.color).filter(Boolean));
  const usePageColors = distinct.size >= regions.length && regions.length > 1;

  boardEl.style.setProperty("--n", N);

  // Sort into row-major order: the DOM order is whatever the page had, but CSS
  // grid places children sequentially, so the preview must be explicitly ordered.
  const ordered = [...cells].sort((a, b) => a.row - b.row || a.col - b.col);

  const frag = document.createDocumentFragment();
  for (const c of ordered) {
    const cell = document.createElement("div");
    cell.className = "board__cell";
    if (c.state === "queen") cell.classList.add("board__cell--queen");
    if (c.state === "cross") cell.classList.add("board__cell--cross");
    cell.style.background = usePageColors
      ? c.color
      : fallbackColor(regions.indexOf(c.region), regions.length);
    if (c.state === "queen") cell.appendChild(queenSvg());
    frag.appendChild(cell);
  }
  boardEl.replaceChildren(frag);

  const queens = cells.filter((c) => c.state === "queen").length;
  boardEl.setAttribute(
    "aria-label",
    `Board preview, ${N} by ${N}, ${queens} of ${N} crowns placed.`
  );
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

/** Run runQueens(mode) in every frame; return the array of non-null results. */
async function runInFrames(mode) {
  const tabId = await getActiveTabId();
  if (tabId == null) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: runQueens, // from injected.js
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
  } else if (state === "checking" && Date.now() - openedAt < GRACE_MS) {
    // Still within the grace window: the game may simply not have rendered yet.
  } else {
    setState("idle");
  }
}

actionBtn.addEventListener("click", async () => {
  const act = STATES[state].act;

  if (act === "open") {
    chrome.tabs.create({ url: QUEENS_URL });
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
      cleared: ok.cleared,
      N: ok.N,
    });
    // Re-read the board so the preview shows the finished position rather than
    // the pre-solve one. Drawn after setState so the newly inserted crowns are
    // created under [data-state="solved"] and play their entrance animation.
    const after = (await runInFrames("detect")).find((r) => r.solvable);
    if (after) renderBoard(after.cells, after.N);
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
