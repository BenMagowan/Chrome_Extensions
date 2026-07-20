/*
 * Popup logic for the Zip Solver.
 *
 * Instead of talking to a pre-injected content script (fragile — see injected.js),
 * the popup INJECTS the engine on demand with chrome.scripting.executeScript into
 * every frame of the active tab. This means:
 *   - No "reload the page after installing" gotcha.
 *   - Works even if the game iframe loaded before the popup opened.
 *   - The board frame is reached automatically via allFrames.
 *
 * `runZip` is defined in injected.js (loaded before this file) and is passed by
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

// URL of the LinkedIn Zip game, opened when no board is detected.
const GAME_URL = "https://www.linkedin.com/games/zip/";

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
    hint: "Checking this tab for a round of Zip…",
    act: null,
  },
  idle: {
    status: "No board found",
    label: "Open Zip game",
    hint: "The solver wakes up once a round is on screen.",
    act: "open",
  },
  ready: {
    status: (d) => `Board detected · ${d.N}×${d.N}`,
    label: "Solve puzzle",
    hint: "One path through every cell, hitting the numbers in order.",
    act: "solve",
  },
  solving: {
    status: "Drawing the path…",
    label: "Solving",
    hint: "Watch the board — this takes a few seconds.",
    act: null,
  },
  solved: {
    status: (d) => `Solved · ${d.placed}-cell path drawn`,
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

// Zip boards are 6×6, so the empty grid can be drawn at the real size and the
// popup never resizes when an actual board turns up.
const DEFAULT_N = 6;

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(name, attrs) {
  const el = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/** Lay out the grid itself. Cells only — the walls and path go in the overlay. */
function buildGrid(N) {
  boardEl.style.setProperty("--n", N);
  const frag = document.createDocumentFragment();
  const cellEls = [];
  for (let i = 0; i < N * N; i++) {
    const cell = document.createElement("div");
    cell.className = "board__cell";
    cellEls.push(cell);
    frag.appendChild(cell);
  }
  return { frag, cellEls };
}

/**
 * Walls and path, drawn as one SVG laid over the grid.
 *
 * The viewBox is N×N, so one unit is one cell and the centre of cell (r,c) is
 * just (c+0.5, r+0.5). That only holds because the grid has no gap between
 * cells: with gaps the cells stop being a uniform N division of the box and
 * every point drifts by a growing fraction of a cell. The hairlines between
 * cells are drawn by the cells themselves instead (see styles.css).
 */
function overlaySvg(cells, path, N) {
  const svg = svgEl("svg", {
    class: "board__overlay",
    viewBox: `0 0 ${N} ${N}`,
    "aria-hidden": "true",
  });

  // Walls sit on the boundary BETWEEN two cells, and both of them may report the
  // same one, so key each boundary and draw it once. Walls on the outer border
  // are skipped — that edge is already the frame of the board.
  const edges = new Set();
  for (const c of cells) {
    if (!c.walls) continue;
    if (c.walls.right && c.col < N - 1) edges.add(`v:${c.row}:${c.col}`);
    if (c.walls.left && c.col > 0) edges.add(`v:${c.row}:${c.col - 1}`);
    if (c.walls.down && c.row < N - 1) edges.add(`h:${c.row}:${c.col}`);
    if (c.walls.up && c.row > 0) edges.add(`h:${c.row - 1}:${c.col}`);
  }
  for (const key of edges) {
    const [kind, r, c] = key.split(":");
    const row = Number(r);
    const col = Number(c);
    // "v" is the vertical boundary on the right of (row,col); "h" the one below it.
    const line =
      kind === "v"
        ? { x1: col + 1, y1: row, x2: col + 1, y2: row + 1 }
        : { x1: col, y1: row + 1, x2: col + 1, y2: row + 1 };
    svg.appendChild(svgEl("line", { ...line, class: "board__wall" }));
  }

  if (Array.isArray(path) && path.length > 1) {
    const points = path
      .map((idx) => `${(idx % N) + 0.5},${Math.floor(idx / N) + 0.5}`)
      .join(" ");
    svg.appendChild(svgEl("polyline", { points, class: "board__path" }));
  }
  return svg;
}

/**
 * The empty grid shown until a board is found — it says "no board yet" in the
 * shape of the thing we're waiting for, which the old "No board found" line
 * couldn't. Purely decorative: the status line is still there for screen
 * readers, so this would only be noise in the a11y tree.
 */
function renderPlaceholder() {
  const { frag } = buildGrid(DEFAULT_N);
  boardEl.replaceChildren(frag);
  boardEl.setAttribute("aria-hidden", "true");
}

/**
 * Draw the detect snapshot — the numbered cells with the SOLUTION path routed
 * through them (see snapshot in injected.js). Replaces the "Board detected ·
 * N×N" line: the grid says the same thing and shows the answer besides.
 */
function renderBoard(cells, path, N) {
  if (!Array.isArray(cells) || !cells.length) return;

  const { frag, cellEls } = buildGrid(N);
  for (const c of cells) {
    if (!c.number) continue;
    // The numbered dots ride on top of the path, as they do in the game.
    const dot = document.createElement("span");
    dot.className = "board__num";
    dot.textContent = String(c.number);
    cellEls[c.row * N + c.col].appendChild(dot);
  }
  frag.appendChild(overlaySvg(cells, path, N));
  boardEl.replaceChildren(frag);

  // Dash the path to its own length so it can be drawn on rather than appearing
  // all at once. Needs to be in the document — getTotalLength measures layout.
  const line = boardEl.querySelector(".board__path");
  if (line) line.style.setProperty("--len", line.getTotalLength());

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

/** Run runZip(mode) in every frame; return the array of non-null results. */
async function runInFrames(mode) {
  const tabId = await getActiveTabId();
  if (tabId == null) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: runZip, // from injected.js
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
    renderBoard(board.cells, board.path, board.N);
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
// Draw the empty grid before the first paint so the popup opens as a board
// rather than snapping into one a moment later.
renderPlaceholder();
setState("checking");
refresh();
pollTimer = setInterval(refresh, POLL_MS);
