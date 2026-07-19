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
 * @returns {{solvable:boolean,N:number,solved:boolean}} for 'detect',
 *          {{ok:boolean, placed?:number, alreadySolved?:boolean, error?:string}} for 'solve'
 */
async function runQueens(mode) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- region id for a cell ---
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
  // that drops the colour entirely), but its background colour does not. Without
  // this fallback a part-filled board could yield more distinct "regions" than
  // there are rows, which read downstream as "no board" — the board was found, we
  // just couldn't colour it.
  function regionOf(el, idx) {
    const label = el.getAttribute("aria-label") || "";
    const cm = /of colou?r ([^,]+?)(?:,|$)/i.exec(label);
    if (cm) return cm[1].trim(); // e.g. "Lavender", "Peach Orange"
    const m = /cell-color-(\d+)/.exec(el.className || "");
    if (m) return "c" + m[1];
    const bg = getComputedStyle(el).backgroundColor;
    if (bg && bg !== "transparent" && !/rgba\(0, 0, 0, 0\)/.test(bg)) return "bg:" + bg;
    return "idx-" + idx; // last resort: unique per cell (board will read as invalid)
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
    const regions = new Set();
    const cells = els.map((el) => {
      const idx = parseInt(el.getAttribute("data-cell-idx"), 10);
      const region = regionOf(el, idx);
      regions.add(region);
      return { row: Math.floor(idx / N), col: idx % N, region, el };
    });
    return { N, cells, regionCount: regions.size };
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

  // Cycle a cell (empty->cross->queen->empty) to the target state; state updates
  // asynchronously, so re-verify after each click. Max 3 clicks reaches any state.
  async function clickUntil(el, target) {
    for (let i = 0; i < 3; i++) {
      if (cellState(el) === target) return;
      fireOneClick(el);
      await sleep(200);
    }
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
        error: `Read ${board.regionCount} colours on a ${board.N}×${board.N} board.`,
      };
    }
    return { ok: false, error: "Board not found or still loading." };
  }
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
  let cleared = 0;
  for (const c of board.cells) {
    // Solution cells are left alone here — the placement pass below cycles them to
    // "queen" from whatever they are now, so clearing them first only costs clicks.
    if (solutionKeys.has(c.row + "," + c.col)) continue;
    // Starter puzzles ship with pre-placed queens locked; clicking those does
    // nothing, so skip rather than burn three clicks and 600ms finding that out.
    if (locked(c.el)) continue;
    if (cellState(c.el) !== "empty") {
      await clickUntil(c.el, "empty");
      cleared++;
      await sleep(200);
    }
  }
  // Place a queen in each solution cell.
  const byKey = new Map();
  for (const c of board.cells) byKey.set(c.row + "," + c.col, c.el);
  for (const { row, col } of solution) {
    const el = byKey.get(row + "," + col);
    if (!el) continue;
    await clickUntil(el, "queen");
    await sleep(200); // human-like spacing; avoids dropped rapid events
  }
  return { ok: true, placed: solution.length, cleared };
}
