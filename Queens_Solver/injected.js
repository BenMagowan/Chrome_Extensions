/*
 * injected.js — the whole board engine as ONE self-contained function.
 *
 * This function is NOT run as a content script. The popup injects it on demand
 * into every frame of the LinkedIn games tab via
 *   chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runQueens, args:[mode] })
 *
 * Why this design (fixes the earlier bugs):
 *  - No reliance on a pre-injected content script. Content scripts only inject on
 *    page/iframe load, so if the tab was already open when the extension was
 *    installed — or the game iframe loaded before document_idle — the script was
 *    simply absent, and the board was only detected after a forced reload (e.g.
 *    toggling the DevTools device toolbar). Injecting on demand removes that
 *    timing dependency entirely: fresh code runs in the live DOM every time.
 *  - world:'MAIN' makes the synthetic events identical to a real in-page script,
 *    which is exactly the sequence verified to work on the live game.
 *
 * IMPORTANT: because executeScript serializes this via Function.prototype.toString,
 * it MUST be fully self-contained — every helper is nested, and it references
 * nothing from the popup's scope. Only the `mode` argument is passed in.
 *
 * @param {'detect'|'solve'} mode
 * @param {{targetMs?:number, preview?:boolean}} [opts] `targetMs` paces 'solve': aim
 *        the whole solve at this total time (see the click-delay maths in the solve
 *        branch); omit for the default cadence. `preview:false` makes 'detect' skip
 *        building the popup's solution preview (`cells` comes back null).
 * @returns {{solvable:boolean,N:number,solved:boolean}} for 'detect',
 *          {{ok:boolean, placed?:number, alreadySolved?:boolean, error?:string,
 *            busy?:boolean, board?:boolean}} for 'solve' — `busy` when another solve
 *          already holds this board, `board` from the frame that has the board
 */
async function runQueens(mode, opts) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Optional pacing. When a target total time is supplied the solve branch spreads
  // its clicks to land near it; null keeps the default, verified-safe cadence.
  const targetMs =
    opts && typeof opts.targetMs === "number" && opts.targetMs > 0
      ? opts.targetMs
      : null;

  // --- region ids for the whole board ---
  // Three independent sources, tried in order, because no single one survives every
  // DOM *and* every fill state:
  //   1. aria-label ("... of color Lavender, ...") — same wording in both known DOMs
  //      (guest #queens-grid, and signed-in [data-testid="interactive-grid"]), and it
  //      is the only source that gives a human-readable name. The colour phrase may
  //      end the label rather than be followed by a comma, hence the `(?:,|$)`.
  //   2. the cell-color-N class, present in the guest/older markup.
  //   3. the rendered background colour.
  // (3) is the important one: a cell's *label text* changes as it is filled in
  // ("Empty cell of color X" -> "Queen of color X" -> and, in some markup, a form
  // that drops the colour entirely), but its background colour does not.
  //
  // The source is picked once for the WHOLE board, never per cell. Each source names
  // a region differently ("Lavender", "c3", "bg:rgb(…)"), so letting one filled cell
  // fall back on its own split its region in two — a part-filled board then read as
  // having more regions than rows, i.e. as "no board". Only a source that covers
  // every cell is used, and one that yields exactly N regions is preferred.
  const REGION_SOURCES = [
    (el) => {
      const cm = /of colou?r ([^,]+?)(?:,|$)/i.exec(el.getAttribute("aria-label") || "");
      return cm ? cm[1].trim() : null; // e.g. "Lavender", "Peach Orange"
    },
    (el) => {
      const m = /cell-color-(\d+)/.exec(el.className || "");
      return m ? "c" + m[1] : null;
    },
    (el) => {
      const bg = getComputedStyle(el).backgroundColor;
      return bg && bg !== "transparent" && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(bg) ? "bg:" + bg : null;
    },
  ];
  function regionKeys(els, N) {
    let complete = null;
    for (const source of REGION_SOURCES) {
      const keys = els.map(source);
      if (keys.some((k) => k == null)) continue; // misses a cell — can't be used alone
      if (new Set(keys).size === N) return keys;
      if (!complete) complete = keys; // covers the board but miscounts: keep as a fallback
    }
    // Nothing covers every cell: unique per cell, so the board reads as invalid.
    return complete || els.map((el, i) => "idx-" + i);
  }

  // --- parse the board into {N, cells:[{row,col,region,el}], regionCount} ---
  // Grid-agnostic: we key off [data-cell-idx], which is present and stable in both
  // the guest and signed-in DOMs, rather than any id/class that changes between them.
  function parseBoard() {
    const all = Array.from(document.querySelectorAll("[data-cell-idx]"));
    if (all.length < 16) return null; // not rendered yet
    // If more than one grid-like cluster exists, keep the largest set that shares
    // a single parent (the real board). Handles stray/example grids defensively.
    const byParent = new Map();
    for (const el of all) {
      const p = el.parentElement;
      if (!p) continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(el);
    }
    let els = all;
    let best = 0;
    for (const [, arr] of byParent) {
      if (arr.length > best) {
        best = arr.length;
        els = arr;
      }
    }
    const N = Math.round(Math.sqrt(els.length));
    if (N * N !== els.length) return null; // not square -> still loading
    const keys = regionKeys(els, N);
    const cells = els.map((el, i) => {
      const idx = parseInt(el.getAttribute("data-cell-idx"), 10);
      return { row: Math.floor(idx / N), col: idx % N, region: keys[i], el };
    });
    return { N, cells, regionCount: new Set(keys).size };
  }

  // --- CSP backtracking solver: one queen per row/column/region, none touching ---
  function solve(board) {
    const { N, cells } = board;
    const regionAt = Array.from({ length: N }, () => new Array(N).fill(null));
    for (const c of cells) regionAt[c.row][c.col] = c.region;
    const colUsed = new Array(N).fill(false);
    const regionUsed = new Set();
    const placed = new Array(N).fill(-1);
    function canPlace(row, col) {
      if (colUsed[col]) return false;
      if (regionUsed.has(regionAt[row][col])) return false;
      if (row > 0) {
        const p = placed[row - 1];
        if (p !== -1 && Math.abs(p - col) <= 1) return false; // diagonal/adjacent touch
      }
      return true;
    }
    function bt(row) {
      if (row === N) return true;
      for (let col = 0; col < N; col++) {
        if (!canPlace(row, col)) continue;
        const r = regionAt[row][col];
        placed[row] = col;
        colUsed[col] = true;
        regionUsed.add(r);
        if (bt(row + 1)) return true;
        placed[row] = -1;
        colUsed[col] = false;
        regionUsed.delete(r);
      }
      return false;
    }
    if (!bt(0)) return null;
    return placed.map((col, row) => ({ row, col }));
  }

  // --- the click sequence the game actually accepts (verified live) ---
  function fireOneClick(el) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy, screenX: cx, screenY: cy,
      button: 0, isPrimary: true, pointerId: 1, pointerType: "mouse",
    };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
  }
  const cellState = (el) => {
    const l = el.getAttribute("aria-label") || "";
    return l.startsWith("Queen") ? "queen" : l.startsWith("Cross") ? "cross" : "empty";
  };

  // --- is the board ALREADY finished? ---
  // Tests the game's win condition against the queens currently on the board,
  // rather than comparing to solve()'s output: that keeps this honest even if the
  // puzzle admits more than one solution, and it still answers correctly when the
  // solver itself can't find one. Crosses are annotations and are ignored.
  function isSolved(board) {
    const queens = board.cells.filter((c) => cellState(c.el) === "queen");
    if (queens.length !== board.N) return false;
    const rows = new Set();
    const cols = new Set();
    const regions = new Set();
    for (const q of queens) {
      rows.add(q.row);
      cols.add(q.col);
      regions.add(q.region);
    }
    // One queen per row, column and colour region.
    if (rows.size !== board.N || cols.size !== board.N || regions.size !== board.N) {
      return false;
    }
    // ...and no two touching, including diagonally.
    for (let i = 0; i < queens.length; i++) {
      for (let j = i + 1; j < queens.length; j++) {
        const a = queens[i];
        const b = queens[j];
        if (Math.abs(a.row - b.row) <= 1 && Math.abs(a.col - b.col) <= 1) return false;
      }
    }
    return true;
  }

  // --- the cell's rendered swatch colour, for the popup's board preview ---
  // Read off the live computed style rather than mapping the aria-label's colour
  // NAME to a hex value: the names are LinkedIn's own ("Lavender", "Soft Blue")
  // and a hardcoded map would silently drift the moment they retune the palette,
  // whereas the rendered pixel is by definition what the player sees. The walk
  // upward covers markup where the fill sits on a wrapper rather than the cell.
  function swatchOf(el) {
    let node = el;
    for (let i = 0; i < 3 && node; i++) {
      const bg = getComputedStyle(node).backgroundColor;
      if (bg && bg !== "transparent" && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(bg)) return bg;
      node = node.parentElement;
    }
    return null; // popup falls back to a palette keyed by region id
  }

  // A serialisable picture of the board for the popup to draw. Deliberately
  // plain data — executeScript has to structured-clone this back, so no elements.
  //
  // The crowns shown are the SOLUTION's, not the player's current attempt: the
  // preview is there to show what the solver will do, so a half-finished board
  // (or one full of wrong guesses and crosses) would be the wrong thing to draw.
  // `queenKeys` null means we couldn't solve it — fall back to the live board.
  function snapshot(board, queenKeys) {
    return board.cells.map((c) => ({
      row: c.row,
      col: c.col,
      region: c.region,
      color: swatchOf(c.el),
      state: queenKeys
        ? queenKeys.has(c.row + "," + c.col)
          ? "queen"
          : "empty"
        : cellState(c.el),
    }));
  }

  // How long a click gets to show before it counts as dropped. Far above a normal
  // render, because the cost of guessing wrong is lopsided: these clicks CYCLE a
  // state, so repeating one that did land (just slowly) walks the cell past its
  // target, while waiting a little longer on one that really was dropped only costs
  // time.
  const SETTLE_MS = 600;
  // How long the finished board gets to show the win before we call it unsolved.
  const CONFIRM_MS = 1500;

  /** Resolve true as soon as cond() holds, or false once `ms` has passed without. */
  async function waitFor(cond, ms) {
    const until = performance.now() + ms;
    while (!cond()) {
      if (performance.now() >= until) return false;
      await sleep(25);
    }
    return true;
  }

  // Cycle a cell (empty->cross->queen->empty) to the target state, one click at a
  // time. State updates asynchronously, so each click is given up to SETTLE_MS to
  // show before the next one is decided from a fresh read; deciding off a render
  // that merely lagged would click once too often. Two clicks reach any state; the
  // spare tries cover a click that really was dropped. Returns whether it got there.
  // `delay` is the pause after each click — the one lever the pacing turns, and it
  // sleeps after the click that lands the target too, so consecutive cells stay
  // spaced without a separate between-cell wait.
  async function clickUntil(el, target, delay) {
    for (let i = 0; i < 4; i++) {
      const from = cellState(el);
      if (from === target) return true;
      fireOneClick(el);
      await sleep(delay);
      await waitFor(() => cellState(el) !== from, SETTLE_MS);
    }
    return cellState(el) === target;
  }

  // --- did the solve actually work? ---
  // Every click landing still isn't the puzzle being won, so judge the result by the
  // game's own win condition on the live board, with a moment for a slow render to
  // catch up. true = solved; false = still unsolved when the wait ran out; null = the
  // board is no longer on the page (the game swapping in a results screen, or the
  // player navigating away), so there's nothing left to check — neither is a missed
  // click, so the caller doesn't report it as one.
  async function confirmSolved(b) {
    const until = performance.now() + CONFIRM_MS;
    for (;;) {
      // Regions don't change mid-solve and isSolved reads each cell's state live, so
      // the board parsed at the start is good — unless the game re-rendered the grid.
      if (!b.cells.every((c) => c.el.isConnected)) b = parseBoard();
      if (!b) return null;
      if (isSolved(b)) return true;
      if (performance.now() >= until) return false;
      await sleep(25);
    }
  }

  // --- one solve per board, visible to the popup ---
  // Every solve path ends up here — content.js's auto-solve, and the popup's Solve
  // in the page's MAIN world — so this is where the board is claimed. The claim is a
  // marker on this frame's <html>: DOM attributes are shared across worlds, and the
  // check and the claim run with no await between them, so two solves racing for one
  // board can't both get in. The popup reads the same marker (readAutoSolve in
  // popup.js) to show a solve in progress — whoever started it — and then its result.
  async function exclusive(run) {
    const marker = document.documentElement.dataset;
    if (marker.autosolve === "solving") {
      return { ok: false, busy: true, board: true, error: "A solve is already running on this board." };
    }
    const claimedAt = Date.now();
    marker.autosolveStart = String(claimedAt);
    delete marker.autosolveResult;
    marker.autosolve = "solving";
    let r;
    try {
      r = await run();
    } catch (e) {
      r = { ok: false, error: "Solve failed: " + ((e && e.message) || e) };
    }
    // `board` tells the popup this frame held the board, so its error is the one to show.
    r = { ...r, board: true };
    // Result first, then state, so the popup never sees a finished state without one.
    marker.autosolveResult = JSON.stringify({ ...r, ms: Date.now() - claimedAt });
    marker.autosolve = r.ok ? (r.alreadySolved ? "done" : "solved") : "failed";
    return r;
  }

  // --- dispatch ---
  const board = parseBoard();
  const valid =
    !!board &&
    board.N >= 4 &&
    board.cells.length === board.N * board.N &&
    board.regionCount === board.N;

  const keysOf = (placements) =>
    new Set(placements.map((p) => p.row + "," + p.col));

  if (mode === "detect") {
    if (!valid) return { solvable: false, N: board ? board.N : 0, solved: false, cells: null };
    // An already-finished board is its own answer; keep the player's queens so the
    // preview matches what's on screen rather than an equally valid alternative.
    const done = isSolved(board);
    // content.js only asks whether there's a board to solve, so it skips the
    // preview — and the solve and colour reads that building one costs.
    if (opts && opts.preview === false) {
      return { solvable: true, N: board.N, solved: done, cells: null };
    }
    const solution = done ? null : solve(board);
    return {
      solvable: true,
      N: board.N,
      solved: done,
      cells: snapshot(board, solution ? keysOf(solution) : null),
    };
  }

  // mode === 'solve'
  // Split the failure: "there is no grid here" (the usual case — this frame simply
  // isn't the game) reads very differently from "there is a grid but its colours
  // didn't add up", which means the markup moved and is worth reporting as such
  // instead of hiding behind a generic not-found.
  if (!valid) {
    if (board && board.N >= 4 && board.regionCount !== board.N) {
      return {
        ok: false,
        board: true,
        error: `Read ${board.regionCount} colours on a ${board.N}×${board.N} board.`,
      };
    }
    return { ok: false, error: "Board not found or still loading." };
  }
  // A cell that won't take its click leaves the board unsolvable from here, so stop
  // rather than click on and still call it solved.
  const MISSED = "A click didn't register. Try again.";
  return exclusive(async () => {
    // Already finished (e.g. solved between the popup's last poll and the click) —
    // report it instead of clicking a completed board back out of its win state.
    if (isSolved(board)) return { ok: true, placed: 0, alreadySolved: true, N: board.N };
    const solution = solve(board);
    if (!solution) return { ok: false, error: "No solution exists for this board." };

    // Wipe the board back to the solution before drawing it.
    //
    // Everything the player left behind that isn't part of the solution goes: wrong
    // queens obviously, but crosses too. A cross is only ever a note-to-self about a
    // cell the player had ruled out, and once the real answer is on the board those
    // notes are at best noise and at worst visibly contradict it (a cross sitting
    // where a crown belongs). Clearing them leaves the finished board looking like
    // the solution rather than the solution overlaid on an abandoned attempt.
    //
    // We do this cell-by-cell rather than via the header's "Clear" button because
    // that button opens a confirmation modal we'd then have to drive.
    const solutionKeys = keysOf(solution);
    const locked = (el) => el.getAttribute("aria-disabled") === "true";

    // Work out how fast to click. Each cell that has to change costs a known number
    // of clicks to walk the empty->cross->queen cycle to its target, and clickUntil
    // sleeps exactly once per click — so the click loop takes (total clicks × delay).
    //
    // We deliberately budget that loop at (target + BUFFER), not target: the rest of
    // the solve (parse, the final state settle) adds a little, and the buffer means
    // the real time lands comfortably OVER the target rather than under — e.g. a 1s
    // target finishes ~1.5s, a 10s target ~10.5s. The floor is low (was 120ms, which
    // pinned the quickest possible solve at ~2s for a normal board — 16 clicks); it's
    // only there to stop a very short target on a very large board clicking faster
    // than the game reliably registers.
    const DEFAULT_CLICK_MS = 200;
    const MIN_CLICK_MS = 50;
    const BUFFER_MS = 500;
    const STATE_NUM = { empty: 0, cross: 1, queen: 2 };
    const clicksBetween = (from, to) =>
      (((STATE_NUM[to] - STATE_NUM[from]) % 3) + 3) % 3;

    let totalClicks = 0;
    for (const c of board.cells) {
      if (locked(c.el)) continue; // locked cells don't move, so they cost nothing
      const target = solutionKeys.has(c.row + "," + c.col) ? "queen" : "empty";
      totalClicks += clicksBetween(cellState(c.el), target);
    }
    const clickDelay =
      targetMs && totalClicks > 0
        ? Math.max(MIN_CLICK_MS, Math.round((targetMs + BUFFER_MS) / totalClicks))
        : DEFAULT_CLICK_MS;

    let cleared = 0;
    for (const c of board.cells) {
      // Solution cells are left alone here — the placement pass below cycles them to
      // "queen" from whatever they are now, so clearing them first only costs clicks.
      if (solutionKeys.has(c.row + "," + c.col)) continue;
      // Starter puzzles ship with pre-placed queens locked; clicking those does
      // nothing, so skip rather than burn clicks finding that out.
      if (locked(c.el)) continue;
      if (cellState(c.el) !== "empty") {
        if (!(await clickUntil(c.el, "empty", clickDelay))) return { ok: false, error: MISSED, cleared };
        cleared++;
      }
    }
    // Place a queen in each solution cell. clickUntil already spaces the clicks (it
    // sleeps after the landing click too), so no extra between-cell wait is needed.
    const byKey = new Map();
    for (const c of board.cells) byKey.set(c.row + "," + c.col, c.el);
    let placed = 0;
    for (const { row, col } of solution) {
      const el = byKey.get(row + "," + col);
      if (!el || !(await clickUntil(el, "queen", clickDelay))) {
        return { ok: false, error: MISSED, placed, cleared };
      }
      placed++;
    }
    // Only the board can say it's won: report success on its word, not ours.
    if ((await confirmSolved(board)) === false) {
      return { ok: false, error: "The board still isn't solved. Try again.", placed, cleared };
    }
    return { ok: true, placed, cleared, N: board.N };
  });
}

// Expose the engine on the (isolated-world) global so the auto-solve content
// script — content.js, listed after this file in the same content_scripts entry —
// can call it whatever scope Chrome gives each file. This runs only when the file
// is loaded as a script (content script or the popup's <script>); it is NOT part
// of runQueens, so the popup's executeScript({func: runQueens}) never carries it.
if (typeof self !== "undefined") self.runQueens = runQueens;
