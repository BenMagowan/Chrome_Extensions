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
 * @returns {{solvable:boolean,N:number}} for 'detect',
 *          {{ok:boolean, placed?:number, error?:string}} for 'solve'
 */
async function runQueens(mode) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- region id for a cell ---
  // The color region is read PRIMARILY from the aria-label ("... of color
  // Lavender, ...") because that text is identical across BOTH known DOMs:
  //   - guest:     #queens-grid + .queens-cell-with-border + cell-color-N classes
  //   - signed-in: [data-testid="interactive-grid"] with fully hashed classes and
  //                NO cell-color-N (color lives only in the aria-label)
  // The cell-color-N class is a fallback for older/guest markup.
  function regionOf(el, idx) {
    const label = el.getAttribute("aria-label") || "";
    const cm = /of color ([^,]+?),/i.exec(label);
    if (cm) return cm[1].trim(); // e.g. "Lavender", "Peach Orange"
    const m = /cell-color-(\d+)/.exec(el.className || "");
    if (m) return "c" + m[1];
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

  if (mode === "detect") return { solvable: valid, N: board ? board.N : 0 };

  // mode === 'solve'
  if (!valid) return { ok: false, error: "Board not found or still loading." };
  const solution = solve(board);
  if (!solution) return { ok: false, error: "No solution exists for this board." };

  // Reset stray queens not in our solution (the header "Clear" opens a confirm
  // modal, so we avoid it). Crosses are harmless annotations and are left as-is.
  const solutionKeys = new Set(solution.map((s) => s.row + "," + s.col));
  for (const c of board.cells) {
    if (solutionKeys.has(c.row + "," + c.col)) continue;
    if (cellState(c.el) === "queen") {
      await clickUntil(c.el, "empty");
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
  return { ok: true, placed: solution.length };
}
