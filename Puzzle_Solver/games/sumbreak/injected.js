/*
 * injected.js — the whole Sumbreak engine as ONE self-contained function.
 *
 * Designed to be injected on demand into every frame of the LinkedIn games tab via
 *   chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runSumbreak, args:[mode, opts] })
 * and also loadable as a content script. MUST stay fully self-contained —
 * executeScript serializes it with Function.prototype.toString, so every helper is
 * nested inside runSumbreak and nothing outside is referenced except `mode` / `opts`.
 *
 * SUMBREAK RULES:
 *   - "Merge identical neighbors until one number remains."
 *   - Two orthogonally adjacent tiles with the SAME value merge into one tile
 *     holding their sum (2 * value), leaving the other cell empty.
 *   - Unknowns handled defensively:
 *       1. Which of the two cells keeps the merged tile (assumed target `to`, but
 *          the solver re-reads the live board and re-plans after every move, so any
 *          outcome on the actual DOM is handled seamlessly).
 *       2. Whether tiles separated by an empty cell count as neighbours (assumed NO:
 *          only orthogonally adjacent cells that both hold a tile can merge).
 *       3. Input mechanism: `aria-pressed` hints at tap-to-select (tap source, then
 *          tap target), while `data-numo-input-mode="pointer"` hints at pointer drag.
 *          Both are implemented in `doMerge`, remembering whichever succeeds first.
 *
 * DOM (class names are obfuscated and ignored):
 *   - Board: `[data-numo-rows][data-numo-columns][aria-label="Gameboard"]`
 *   - Cells: children `[data-numo-index]` (row-major). Occupied cells contain
 *     `button[data-numo-kind="number"]` with `aria-label="Number <V>, row <R>, column <C>"`
 *     and `aria-pressed`. Empty cells have no button (and `g[data-numo-empty-cell]`
 *     in the SVG scene). Values fall back to `g[data-numo-svg-cell="i"] text[data-numo-label]`.
 *   - Solved: exactly one tile left (button becomes `disabled`).
 *
 * @param {'detect'|'solve'} mode
 * @param {{targetMs?:number, preview?:boolean}} [opts] `targetMs` paces 'solve' across
 *        the solve; `preview:false` makes 'detect' skip the cell snapshot and search
 *        (`cells` and `moves` come back null).
 * @returns {{solvable:boolean, rows:number, cols:number, solved:boolean,
 *            cells:{idx:number, value:number}[]|null, moves:[number,number][]|null}}
 *          for 'detect',
 *          {{ok:boolean, merges?:number, alreadySolved?:boolean, error?:string,
 *            busy?:boolean, board?:boolean}} for 'solve'.
 */
async function runSumbreak(mode, opts) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const startedAt = performance.now();

  const targetMs =
    opts && typeof opts.targetMs === "number" && opts.targetMs > 0
      ? opts.targetMs
      : null;

  // --- read a tile's numeric value from its button aria-label, falling back to SVG ---
  function readTileValue(boardEl, btn, idx) {
    const lab = btn.getAttribute("aria-label") || "";
    const m = /Number\s+(\d+)/i.exec(lab);
    if (m) return parseInt(m[1], 10);
    const svgText = boardEl.querySelector(
      `g[data-numo-svg-cell="${idx}"] text[data-numo-label]`
    );
    if (svgText) {
      const t = (svgText.textContent || "").trim();
      if (/^\d+$/.test(t)) return parseInt(t, 10);
    }
    const bt = (btn.textContent || "").trim();
    if (/^\d+$/.test(bt)) return parseInt(bt, 10);
    return 0;
  }

  // --- parse the live DOM board into {boardEl, rows, cols, total, grid, cellEls, btnByIdx, tileCount} ---
  function parseBoard() {
    const boardEl =
      document.querySelector(
        '[data-numo-rows][data-numo-columns][aria-label="Gameboard"]'
      ) || document.querySelector("[data-numo-rows][data-numo-columns]");
    if (!boardEl) return null;

    const rows = parseInt(boardEl.getAttribute("data-numo-rows"), 10);
    const cols = parseInt(boardEl.getAttribute("data-numo-columns"), 10);
    if (!Number.isFinite(rows) || !Number.isFinite(cols) || rows < 1 || cols < 1) {
      return null;
    }
    const total = rows * cols;
    const nodes = boardEl.querySelectorAll("[data-numo-index]");
    if (nodes.length !== total) return null;

    const cellEls = new Array(total).fill(null);
    const btnByIdx = new Array(total).fill(null);
    const grid = new Array(total).fill(0);
    let tileCount = 0;

    for (const el of nodes) {
      const idx = parseInt(el.getAttribute("data-numo-index"), 10);
      if (!Number.isFinite(idx) || idx < 0 || idx >= total || cellEls[idx]) {
        return null;
      }
      cellEls[idx] = el;
      const btn = el.querySelector('button[data-numo-kind="number"]');
      if (btn) {
        btnByIdx[idx] = btn;
        const val = readTileValue(boardEl, btn, idx);
        if (val <= 0) return null;
        grid[idx] = val;
        tileCount++;
      }
    }

    if (tileCount === 0) return null;
    return { boardEl, rows, cols, total, grid, cellEls, btnByIdx, tileCount };
  }

  function isSolved(board) {
    return board.tileCount === 1;
  }

  function snapshot(board) {
    return board.grid.map((value, idx) => ({ idx, value }));
  }

  // --- DFS solver with memoisation and sound pruning ---
  // Returns [[fromIdx, toIdx], ...], null if unsolvable, or GAVE_UP on budget expiry.
  const SEARCH_BUDGET_MS = 800;
  const MAX_VISITED = 200000;
  const GAVE_UP = "gave-up";

  function solveGrid(rows, cols, initialGrid) {
    const total = rows * cols;
    let tileCount = 0;
    let totalSum = 0;
    let allPow2 = true;
    const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;

    for (let i = 0; i < total; i++) {
      const v = initialGrid[i];
      if (v > 0) {
        tileCount++;
        totalSum += v;
        if (!isPow2(v)) allPow2 = false;
      }
    }
    if (tileCount === 1) return [];
    if (tileCount === 0) return null;
    // Sound invariant: if every tile is a power of 2, the single final tile must
    // equal totalSum and be a power of 2.
    if (allPow2 && !isPow2(totalSum)) return null;

    // Precompute orthogonal adjacency list.
    const adj = Array.from({ length: total }, (_, i) => {
      const r = Math.floor(i / cols);
      const c = i % cols;
      const nbs = [];
      if (r > 0) nbs.push(i - cols);
      if (r < rows - 1) nbs.push(i + cols);
      if (c > 0) nbs.push(i - 1);
      if (c < cols - 1) nbs.push(i + 1);
      return nbs;
    });

    const state = initialGrid.slice();
    const dead = new Set();
    const seen = new Int32Array(total);
    const deg = new Int32Array(total);
    const bfsStack = new Int32Array(total);
    let stamp = 0;

    const deadline = performance.now() + SEARCH_BUDGET_MS;
    let nodes = 0;
    let gaveUp = false;
    const path = [];

    function analyzeAndPrune(remTiles) {
      let first = -1;
      let minVal = Infinity;
      let minCount = 0;
      for (let i = 0; i < total; i++) {
        const v = state[i];
        if (v > 0) {
          if (first < 0) first = i;
          if (v < minVal) {
            minVal = v;
            minCount = 1;
          } else if (v === minVal) {
            minCount++;
          }
        }
      }
      // Tiles of the global minimum value can never be produced by merging smaller
      // tiles and can only merge with each other, so their count must be even.
      if (minCount % 2 !== 0) return null;

      stamp++;
      let sp = 0;
      bfsStack[sp++] = first;
      seen[first] = stamp;
      let reached = 0;
      let forcedMinCell = -1;
      let forcedMinNb = -1;

      while (sp > 0) {
        const u = bfsStack[--sp];
        reached++;
        const valU = state[u];
        const nbs = adj[u];
        let d = 0;
        let onlyNb = -1;
        let sameMinCount = 0;
        let sameMinNb = -1;

        for (let k = 0; k < nbs.length; k++) {
          const v = nbs[k];
          if (state[v] === 0) continue;
          d++;
          onlyNb = v;
          if (valU === minVal && state[v] === minVal) {
            sameMinCount++;
            sameMinNb = v;
          }
          if (seen[v] !== stamp) {
            seen[v] = stamp;
            bfsStack[sp++] = v;
          }
        }
        deg[u] = d;
        // Global-minimum tile with no equal neighbor can never merge.
        if (valU === minVal && sameMinCount === 0) return null;
        // Degree-1 tile strictly smaller than its only neighbor can never merge
        // (the neighbor can only grow or vanish).
        if (d === 1 && valU < state[onlyNb]) return null;
        if (valU === minVal && sameMinCount === 1 && forcedMinCell < 0) {
          forcedMinCell = u;
          forcedMinNb = sameMinNb;
        }
      }

      // Non-empty cells never become occupied once empty, so disconnected components
      // can never merge into one tile.
      if (reached !== remTiles) return null;
      return { forcedMinCell, forcedMinNb };
    }

    function hasDoubleNeighbor(cell, doubledVal, exclude) {
      const nbs = adj[cell];
      for (let k = 0; k < nbs.length; k++) {
        const nb = nbs[k];
        if (nb !== exclude && state[nb] === doubledVal) return 1;
      }
      return 0;
    }

    function dfs(remTiles) {
      if (remTiles === 1) return true;
      if ((++nodes & 1023) === 0 && performance.now() > deadline) {
        gaveUp = true;
        return false;
      }
      const key = state.join(",");
      if (dead.has(key)) return false;

      const info = analyzeAndPrune(remTiles);
      if (!info) {
        if (dead.size < MAX_VISITED) dead.add(key);
        return false;
      }

      const moves = [];
      if (info.forcedMinCell >= 0) {
        const u = info.forcedMinCell;
        const v = info.forcedMinNb;
        if (!(remTiles > 2 && deg[v] === 1)) moves.push([u, v]);
        if (!(remTiles > 2 && deg[u] === 1)) moves.push([v, u]);
        if (moves.length === 2 && deg[moves[1][0]] < deg[moves[0][0]]) {
          moves.reverse();
        }
      } else {
        for (let a = 0; a < total; a++) {
          const val = state[a];
          if (val === 0) continue;
          const nbs = adj[a];
          for (let k = 0; k < nbs.length; k++) {
            const b = nbs[k];
            if (state[b] !== val) continue;
            // Landing on a degree-1 cell while >2 tiles remain leaves it isolated.
            if (remTiles > 2 && deg[b] === 1) continue;
            moves.push([a, b]);
          }
        }
        moves.sort((m1, m2) => {
          const v1 = state[m1[0]];
          const v2 = state[m2[0]];
          if (v1 !== v2) return v1 - v2;
          const c1 = hasDoubleNeighbor(m1[1], v1 * 2, m1[0]);
          const c2 = hasDoubleNeighbor(m2[1], v2 * 2, m2[0]);
          if (c1 !== c2) return c2 - c1;
          return deg[m1[0]] - deg[m1[1]] - (deg[m2[0]] - deg[m2[1]]);
        });
      }

      for (let i = 0; i < moves.length; i++) {
        const a = moves[i][0];
        const b = moves[i][1];
        const orig = state[a];
        state[a] = 0;
        state[b] = orig * 2;
        path.push([a, b]);
        if (dfs(remTiles - 1)) return true;
        path.pop();
        state[a] = orig;
        state[b] = orig;
        if (gaveUp) return false;
      }

      if (dead.size < MAX_VISITED) dead.add(key);
      return false;
    }

    if (dfs(tileCount)) return path.slice();
    return gaveUp ? GAVE_UP : null;
  }

  // --- cached solve per board ---
  const CACHE_KEY = Symbol.for("sumbreakSolver.lastSolve");
  function solveCached(board) {
    const sig = board.rows + "x" + board.cols + "|" + board.grid.join(",");
    const hit = globalThis[CACHE_KEY];
    if (hit && hit.sig === sig) return hit.result;
    const result = solveGrid(board.rows, board.cols, board.grid);
    globalThis[CACHE_KEY] = { sig, result };
    return result;
  }

  // --- wait helpers ---
  async function waitFor(cond, ms) {
    const until = performance.now() + ms;
    while (!cond()) {
      if (performance.now() >= until) return false;
      await sleep(20);
    }
    return true;
  }

  const CONFIRM_MS = 1500;
  async function confirmSolved(b) {
    const until = performance.now() + CONFIRM_MS;
    for (;;) {
      const live = parseBoard();
      if (!live) return b ? null : false;
      b = live;
      if (isSolved(b)) return true;
      if (performance.now() >= until) return false;
      await sleep(25);
    }
  }

  // --- input helpers: full click sequence and pointer drag ---
  function fireOneClick(el) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: cx,
      clientY: cy,
      screenX: cx,
      screenY: cy,
      button: 0,
      isPrimary: true,
      pointerId: 1,
      pointerType: "mouse",
    };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
  }

  function clearSelection(board) {
    const pressed = board.boardEl.querySelectorAll(
      'button[data-numo-kind="number"][aria-pressed="true"]'
    );
    for (const btn of pressed) {
      fireOneClick(btn);
    }
  }

  const SETTLE_MS = 400;
  const TAP_PRESS_MS = 120;

  async function tryTapMerge(board, fromIdx, toIdx, beforeCount) {
    const fromBtn = board.btnByIdx[fromIdx];
    const toBtn = board.btnByIdx[toIdx];
    if (!fromBtn || !toBtn) return false;

    const liveBtn = (idx, cached) => {
      if (cached && cached.isConnected) return cached;
      const b = parseBoard();
      return b ? b.btnByIdx[idx] : null;
    };

    fireOneClick(fromBtn);
    const pressed = await waitFor(() => {
      const btn = liveBtn(fromIdx, fromBtn);
      return btn && btn.getAttribute("aria-pressed") === "true";
    }, TAP_PRESS_MS);
    if (!pressed) {
      clearSelection(parseBoard() || board);
      return false;
    }

    const targetBtn = liveBtn(toIdx, toBtn);
    if (!targetBtn) {
      clearSelection(parseBoard() || board);
      return false;
    }
    fireOneClick(targetBtn);
    const changed = await waitFor(() => {
      const next = parseBoard();
      return next && next.tileCount === beforeCount - 1;
    }, SETTLE_MS);
    if (!changed) {
      clearSelection(parseBoard() || board);
      return false;
    }
    return true;
  }

  async function tryDragMerge(board, fromIdx, toIdx, beforeCount) {
    clearSelection(board);
    const fromBtn = board.btnByIdx[fromIdx];
    const toBtn = board.btnByIdx[toIdx];
    if (!fromBtn || !toBtn) return false;

    let r1 = fromBtn.getBoundingClientRect();
    let r2 = toBtn.getBoundingClientRect();
    if (
      r1.top < 0 ||
      r1.bottom > window.innerHeight ||
      r2.top < 0 ||
      r2.bottom > window.innerHeight
    ) {
      board.boardEl.scrollIntoView({ block: "center", inline: "center" });
      r1 = fromBtn.getBoundingClientRect();
      r2 = toBtn.getBoundingClientRect();
    }

    const x1 = r1.left + r1.width / 2;
    const y1 = r1.top + r1.height / 2;
    const x2 = r2.left + r2.width / 2;
    const y2 = r2.top + r2.height / 2;

    const makeBase = (x, y, buttons) => ({
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: x,
      screenY: y,
      button: 0,
      buttons,
      pointerId: 1,
      isPrimary: true,
      pointerType: "mouse",
    });

    const at = (x, y, fallback) => document.elementFromPoint(x, y) || fallback;

    const downTarget = at(x1, y1, fromBtn);
    downTarget.dispatchEvent(
      new PointerEvent("pointerdown", makeBase(x1, y1, 1))
    );
    downTarget.dispatchEvent(new MouseEvent("mousedown", makeBase(x1, y1, 1)));

    const STEPS = 6;
    for (let s = 1; s <= STEPS; s++) {
      await sleep(5);
      const t = s / STEPS;
      const x = x1 + (x2 - x1) * t;
      const y = y1 + (y2 - y1) * t;
      const moveTarget = at(x, y, s === STEPS ? toBtn : fromBtn);
      moveTarget.dispatchEvent(
        new PointerEvent("pointermove", makeBase(x, y, 1))
      );
      moveTarget.dispatchEvent(new MouseEvent("mousemove", makeBase(x, y, 1)));
    }

    const upTarget = at(x2, y2, toBtn);
    upTarget.dispatchEvent(new PointerEvent("pointerup", makeBase(x2, y2, 0)));
    upTarget.dispatchEvent(new MouseEvent("mouseup", makeBase(x2, y2, 0)));

    return await waitFor(() => {
      const next = parseBoard();
      return next && next.tileCount === beforeCount - 1;
    }, SETTLE_MS);
  }

  let preferredMethod = "tap";
  async function doMerge(board, fromIdx, toIdx) {
    const beforeCount = board.tileCount;
    const order =
      preferredMethod === "tap" ? ["tap", "drag"] : ["drag", "tap"];
    for (const method of order) {
      const ok =
        method === "tap"
          ? await tryTapMerge(board, fromIdx, toIdx, beforeCount)
          : await tryDragMerge(board, fromIdx, toIdx, beforeCount);
      if (ok) {
        preferredMethod = method;
        return true;
      }
    }
    return false;
  }

  // --- exclusive board lock (shared with popup/content via documentElement.dataset) ---
  async function exclusive(run) {
    const marker = document.documentElement.dataset;
    if (marker.autosolve === "solving") {
      return {
        ok: false,
        busy: true,
        board: true,
        error: "A solve is already running on this board.",
      };
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
    r = { ...r, board: true };
    marker.autosolveResult = JSON.stringify({
      ...r,
      ms: Date.now() - claimedAt,
    });
    marker.autosolve = r.ok ? (r.alreadySolved ? "done" : "solved") : "failed";
    return r;
  }

  // --- dispatch ---
  const preview = !(mode === "detect" && opts && opts.preview === false);
  const board = parseBoard();

  if (mode === "detect") {
    if (!board) {
      return {
        solvable: false,
        rows: 0,
        cols: 0,
        solved: false,
        cells: null,
        moves: null,
      };
    }
    const done = isSolved(board);
    if (!preview) {
      return {
        solvable: true,
        rows: board.rows,
        cols: board.cols,
        solved: done,
        cells: null,
        moves: null,
      };
    }
    const moves = done ? null : solveCached(board);
    return {
      solvable: true,
      rows: board.rows,
      cols: board.cols,
      solved: done,
      cells: snapshot(board),
      moves: Array.isArray(moves) ? moves : null,
    };
  }

  // mode === 'solve'
  if (!board) return { ok: false, error: "Board not found or still loading." };
  return exclusive(async () => {
    if (isSolved(board)) {
      return {
        ok: true,
        merges: 0,
        alreadySolved: true,
        rows: board.rows,
        cols: board.cols,
      };
    }

    const totalMerges = board.tileCount - 1;
    let merges = 0;
    let current = board;

    while (!isSolved(current)) {
      const plan = solveCached(current);
      if (plan === GAVE_UP) {
        return {
          ok: false,
          merges,
          error: "Couldn't find a solution in time.",
        };
      }
      if (!plan || !plan.length) {
        return {
          ok: false,
          merges,
          error: "No solution exists for this board.",
        };
      }

      const [fromIdx, toIdx] = plan[0];
      const expectedCount = current.tileCount - 1;
      const merged = await doMerge(current, fromIdx, toIdx);
      if (!merged) {
        return {
          ok: false,
          merges,
          error: "A merge didn't register. Try again.",
        };
      }
      merges++;

      // Re-read the live board and verify the tile count dropped by 1 before re-planning.
      const next = parseBoard();
      if (!next || next.tileCount !== expectedCount) {
        return {
          ok: false,
          merges,
          error: "The board changed unexpectedly. Try again.",
        };
      }
      current = next;

      if (!isSolved(current)) {
        if (targetMs) {
          const targetElapsed = (targetMs * merges) / totalMerges;
          const remaining = targetElapsed - (performance.now() - startedAt);
          if (remaining > 5) await sleep(remaining);
        } else {
          await sleep(60);
        }
      }
    }

    if ((await confirmSolved(current)) === false) {
      return {
        ok: false,
        merges,
        error: "The board still isn't solved. Try again.",
      };
    }
    return { ok: true, merges, rows: current.rows, cols: current.cols };
  });
}

if (typeof self !== "undefined") self.runSumbreak = runSumbreak;
