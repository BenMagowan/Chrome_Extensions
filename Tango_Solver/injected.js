/*
 * injected.js — the whole Tango engine as ONE self-contained function.
 *
 * Not a content script. The popup injects it on demand into every frame of the
 * LinkedIn games tab via
 *   chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runTango, args:[mode] })
 * (See Queens_Solver for why on-demand MAIN-world injection is used instead of a
 *  pre-injected content script: no reload-after-install gotcha, immune to when the
 *  game iframe loaded, and exempt from the page CSP that blocks in-page eval.)
 *
 * MUST stay fully self-contained — executeScript serializes it with
 * Function.prototype.toString, so every helper is nested and nothing outside is
 * referenced except the `mode` argument.
 *
 * TANGO RULES (constraint satisfaction):
 *   - Each cell is a Sun or a Moon.
 *   - Each row and each column has an equal number of Suns and Moons (N/2 each).
 *   - No 3 identical symbols consecutively in any row or column.
 *   - Cells joined by "=" must match; joined by "×" must be opposite.
 *   - Some cells are pre-filled (locked) clues. The solution is unique.
 *
 * @param {'detect'|'solve'} mode
 * @returns {{solvable:boolean,N:number,solved:boolean,cells:object[]|null}} for 'detect',
 *          {{ok:boolean, placed?:number, alreadySolved?:boolean, error?:string}} for 'solve'
 */
async function runTango(mode) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- read a cell's current symbol from its inner <svg aria-label> ---
  // "Sun" | "Moon" | "Empty" — identical text in guest and signed-in DOMs.
  function symbolOf(cellEl) {
    const svg = cellEl.querySelector("svg[aria-label]");
    const l = svg ? svg.getAttribute("aria-label") : "";
    if (l === "Sun" || l === "Moon") return l;
    return "Empty";
  }

  // --- parse the board into {N, cells:[{idx,row,col,locked,symbol,el}], edges} ---
  // Grid-agnostic: keys off [data-cell-idx], present and stable in both the guest
  // (div.lotka-cell) and signed-in (#tango-cell-N) DOMs, rather than ids/classes
  // that differ or are hashed between them.
  function parseBoard() {
    const all = Array.from(document.querySelectorAll("[data-cell-idx]"));
    if (all.length < 16) return null; // not rendered yet
    // Keep the largest set of cells sharing one parent (the real grid).
    const byParent = new Map();
    for (const el of all) {
      const p = el.parentElement;
      if (!p) continue;
      if (!byParent.has(p)) byParent.set(p, []);
      byParent.get(p).push(el);
    }
    let gridEl = all[0].parentElement;
    let els = all;
    let best = 0;
    for (const [p, arr] of byParent) {
      if (arr.length > best) {
        best = arr.length;
        els = arr;
        gridEl = p;
      }
    }
    const N = Math.round(Math.sqrt(els.length));
    if (N * N !== els.length || N % 2 !== 0) return null; // Tango grids are square & even

    const cells = els.map((el) => {
      const idx = parseInt(el.getAttribute("data-cell-idx"), 10);
      return {
        idx,
        row: Math.floor(idx / N),
        col: idx % N,
        locked: el.getAttribute("aria-disabled") === "true",
        symbol: symbolOf(el),
        el,
      };
    });

    // Tango signature: cells must carry Sun/Moon/Empty svgs (so a Queens board,
    // which also uses [data-cell-idx], never mis-parses as Tango).
    const looksTango = els.some((el) => {
      const svg = el.querySelector("svg[aria-label]");
      return svg && /^(Sun|Moon|Empty)$/.test(svg.getAttribute("aria-label") || "");
    });
    if (!looksTango) return null;

    // Edges: "=" (Equal) and "×" (Cross) markers, scoped to the grid so the
    // how-to-play legend's Cross icon is ignored. Direction from the wrapper class
    // (guest: lotka-cell-edge--right/--down) or geometry (signed-in: hashed classes).
    const edges = [];
    gridEl
      .querySelectorAll('svg[aria-label="Equal"], svg[aria-label="Cross"]')
      .forEach((svg) => {
        const cell = svg.closest("[data-cell-idx]");
        if (!cell) return;
        const idx = parseInt(cell.getAttribute("data-cell-idx"), 10);
        const wrapCls = (svg.parentElement.getAttribute("class") || "");
        let dir = /--right/.test(wrapCls) ? "right" : /--down/.test(wrapCls) ? "down" : null;
        if (!dir) {
          const cr = cell.getBoundingClientRect();
          const sr = svg.getBoundingClientRect();
          const toRight = Math.abs(sr.left + sr.width / 2 - cr.right);
          const toBottom = Math.abs(sr.top + sr.height / 2 - cr.bottom);
          dir = toRight < toBottom ? "right" : "down";
        }
        const b = dir === "right" ? idx + 1 : idx + N;
        edges.push({ a: idx, b, eq: svg.getAttribute("aria-label") === "Equal" });
      });

    return { N, cells, edges };
  }

  // --- CSP backtracking solver. Symbols: 0 = Sun, 1 = Moon. ---
  function solve(board) {
    const { N, cells, edges } = board;
    const HALF = N / 2;
    const SYM = { Sun: 0, Moon: 1 };

    const locked = {}; // idx -> 0/1
    for (const c of cells) if (c.locked && c.symbol !== "Empty") locked[c.idx] = SYM[c.symbol];

    // edges indexed by cell for O(1) neighbour lookup during search
    const edgeByCell = new Map();
    for (const e of edges) {
      if (!edgeByCell.has(e.a)) edgeByCell.set(e.a, []);
      if (!edgeByCell.has(e.b)) edgeByCell.set(e.b, []);
      edgeByCell.get(e.a).push(e);
      edgeByCell.get(e.b).push(e);
    }

    const g = new Array(N * N).fill(-1);
    const at = (r, c) => g[r * N + c];
    const rowCount = (r, v) => {
      let n = 0;
      for (let c = 0; c < N; c++) if (at(r, c) === v) n++;
      return n;
    };
    const colCount = (c, v) => {
      let n = 0;
      for (let r = 0; r < N; r++) if (at(r, c) === v) n++;
      return n;
    };

    function canPlace(r, c, v) {
      // no 3 identical consecutively (row & column) using the two cells before this
      if (c >= 2 && at(r, c - 1) === v && at(r, c - 2) === v) return false;
      if (r >= 2 && at(r - 1, c) === v && at(r - 2, c) === v) return false;
      // balance: never exceed N/2 of a symbol per row/column
      if (rowCount(r, v) + 1 > HALF) return false;
      if (colCount(c, v) + 1 > HALF) return false;
      // edge constraints against already-placed neighbours
      const idx = r * N + c;
      const es = edgeByCell.get(idx);
      if (es) {
        for (const e of es) {
          const other = e.a === idx ? e.b : e.a;
          if (g[other] === -1) continue;
          if (e.eq && g[other] !== v) return false;
          if (!e.eq && g[other] === v) return false;
        }
      }
      return true;
    }

    function backtrack(pos) {
      if (pos === N * N) return true;
      const r = Math.floor(pos / N);
      const c = pos % N;
      if (locked[pos] !== undefined) {
        const v = locked[pos];
        if (!canPlace(r, c, v)) return false;
        g[pos] = v;
        if (backtrack(pos + 1)) return true;
        g[pos] = -1;
        return false;
      }
      for (const v of [0, 1]) {
        if (!canPlace(r, c, v)) continue;
        g[pos] = v;
        if (backtrack(pos + 1)) return true;
        g[pos] = -1;
      }
      return false;
    }

    if (!backtrack(0)) return null;
    // map back to per-cell target symbols keyed by idx
    const target = {};
    for (const c of cells) target[c.idx] = g[c.idx] === 0 ? "Sun" : "Moon";
    return target;
  }

  // --- is the board ALREADY finished? ---
  // Tests the game's win condition against the symbols currently on the board,
  // rather than comparing to solve()'s output: that keeps the answer honest even
  // if a board somehow admits more than one solution, and it still works when the
  // solver itself can't crack it.
  function isSolved(board) {
    const { N, cells, edges } = board;
    const HALF = N / 2;
    const g = new Array(N * N).fill(null);
    for (const c of cells) {
      if (c.symbol === "Empty") return false; // an unfilled cell is never a win
      g[c.idx] = c.symbol;
    }
    const at = (r, c) => g[r * N + c];
    for (let i = 0; i < N; i++) {
      let rowSuns = 0;
      let colSuns = 0;
      for (let j = 0; j < N; j++) {
        if (at(i, j) === "Sun") rowSuns++;
        if (at(j, i) === "Sun") colSuns++;
        // No 3 identical consecutively, along the row and down the column.
        if (j >= 2 && at(i, j) === at(i, j - 1) && at(i, j) === at(i, j - 2)) return false;
        if (j >= 2 && at(j, i) === at(j - 1, i) && at(j, i) === at(j - 2, i)) return false;
      }
      if (rowSuns !== HALF || colSuns !== HALF) return false; // equal Suns and Moons
    }
    for (const e of edges) {
      const same = g[e.a] === g[e.b];
      if (e.eq !== same) return false; // "=" wants a match, "×" wants opposites
    }
    return true;
  }

  // A serialisable picture of the board for the popup to draw. Deliberately plain
  // data — executeScript has to structured-clone this back, so no elements.
  //
  // The symbols shown are the SOLUTION's, not the player's current attempt: the
  // preview exists to show what the solver will do, so a part-filled grid would be
  // the wrong thing to draw. `target` null means we couldn't solve it (or the board
  // is already finished) — fall back to what's on screen.
  function snapshot(board, target) {
    return board.cells.map((c) => ({
      row: c.row,
      col: c.col,
      locked: c.locked,
      symbol: target ? target[c.idx] : c.symbol,
    }));
  }

  // --- the click sequence the game accepts (same framework as Queens) ---
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
  // Cycle a cell (Empty -> Sun -> Moon -> Empty) to the target symbol; state updates
  // asynchronously, so re-verify after each click. Max 3 clicks reaches any state.
  async function clickUntil(el, targetSymbol) {
    for (let i = 0; i < 3; i++) {
      if (symbolOf(el) === targetSymbol) return;
      fireOneClick(el);
      await sleep(200);
    }
  }

  // --- dispatch ---
  const board = parseBoard();

  if (mode === "detect") {
    if (!board) return { solvable: false, N: 0, solved: false, cells: null };
    // An already-finished board is its own answer; keep the player's symbols so the
    // preview matches what's on screen.
    const done = isSolved(board);
    return {
      solvable: true,
      N: board.N,
      solved: done,
      cells: snapshot(board, done ? null : solve(board)),
    };
  }

  // mode === 'solve'
  if (!board) return { ok: false, error: "Board not found or still loading." };
  // Already finished (e.g. completed between the popup's last poll and the click) —
  // report it instead of clicking a won board back out of its win state.
  if (isSolved(board)) return { ok: true, placed: 0, alreadySolved: true, N: board.N };
  const solution = solve(board);
  if (!solution) return { ok: false, error: "No solution exists for this board." };

  // Drive every non-locked cell to its solution symbol. No separate reset needed —
  // clickUntil reaches the target from any current state, so this is idempotent.
  let placed = 0;
  for (const c of board.cells) {
    if (c.locked) continue;
    await clickUntil(c.el, solution[c.idx]);
    placed++;
    await sleep(200); // human-like spacing; avoids dropped rapid events
  }
  return { ok: true, placed, N: board.N };
}
