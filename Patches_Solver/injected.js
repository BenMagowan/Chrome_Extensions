/*
 * injected.js — the whole Patches engine as ONE self-contained function.
 *
 * Not a content script. The popup injects it on demand into every frame of the
 * LinkedIn games tab via
 *   chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runPatches, args:[mode] })
 * (See Queens_Solver for why on-demand MAIN-world injection is used instead of a
 *  pre-injected content script.)
 *
 * MUST stay fully self-contained — executeScript serializes it with
 * Function.prototype.toString, so every helper is nested and nothing outside is
 * referenced except the `mode` argument.
 *
 * PATCHES RULES: partition the grid into regions ("patches"), one per numbered/shaped
 * clue, tiling every cell. Each clue states its patch's area (a number) and a shape:
 *   - SQUARE (h == w), HORIZONTAL_RECT (wide, w > h), VERTICAL_RECT (tall, h > w),
 *   - or "freeform" (UNKNOWN) — any connected polyomino.
 *
 * SCOPE (rectangle-only build): this solver handles puzzles where EVERY clue is a
 * rectangle (SQUARE / HORIZONTAL_RECT / VERTICAL_RECT) with a given area — i.e. a
 * Shikaku-with-shapes tiling. Freeform (UNKNOWN) clues are NOT solved; on such a board
 * `detect` reports not-solvable and `solve` returns an explanatory error. (See README.)
 *
 * FILL MECHANISM (verified live on the guest board): the drag the game advertises only
 * responds to TRUSTED events, which an extension cannot produce — but the keyboard path
 * works with synthetic events:
 *   - focus the gameboard + press Enter  → enters grid mode (a cursor cell gains focus)
 *   - Arrow keys                          → move the cursor one cell
 *   - Enter on a corner, move, Enter again → fills the bounding-box rectangle between the
 *                                            two presses, auto-coloured by the clue inside
 * So the solver computes each patch's rectangle and draws it corner→corner with keys.
 *
 * @param {'detect'|'solve'} mode
 * @returns {{solvable:boolean,N:number}} for 'detect',
 *          {{ok:boolean, placed?:number, error?:string}} for 'solve'
 */
async function runPatches(mode) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- parse the board into {rows, cols, clues, rectanglePuzzle, boardEl} ---
  // Grid-agnostic: keys off [data-cell-idx]; rows/cols come from the "Row R, column C"
  // aria text (stable in both guest and signed-in DOMs).
  function parseBoard() {
    // Patches signature so a Zip board (which also uses [data-trail-grid]) never
    // mis-parses as Patches.
    const boardEl = document.querySelector(
      '[data-testid="patches-game-board"], [aria-label="Gameboard"]'
    );
    const isPatches =
      !!document.querySelector(
        '[data-testid="patches-game-container"], [data-testid="patches-game-board"]'
      ) || !!document.querySelector('[data-shape^="PatchesShapeConstraint"]');
    if (!isPatches || !boardEl) return null;

    const all = Array.from(document.querySelectorAll("[data-cell-idx]"));
    if (all.length < 9) return null; // not rendered yet
    // Keep the largest set of cells sharing one parent (the real grid).
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

    // rows/cols from the aria "Row R, column C" text.
    let rows = 0,
      cols = 0;
    for (const el of els) {
      const m = /Row\s+(\d+),\s*column\s+(\d+)/i.exec(el.getAttribute("aria-label") || "");
      if (m) {
        rows = Math.max(rows, parseInt(m[1], 10));
        cols = Math.max(cols, parseInt(m[2], 10));
      }
    }
    if (rows < 2 || cols < 2 || rows * cols !== els.length) return null;

    // Clues: any cell carrying a [data-shape] marker (or an "…clue…" aria-label).
    const clues = [];
    for (const el of els) {
      const idx = parseInt(el.getAttribute("data-cell-idx"), 10);
      const shapeEl = el.querySelector("[data-shape]");
      const aria = el.getAttribute("aria-label") || "";
      if (!shapeEl && !/clue/i.test(aria)) continue;
      const rawShape = shapeEl ? shapeEl.getAttribute("data-shape") || "" : "";
      let shape = /SQUARE/.test(rawShape)
        ? "SQUARE"
        : /HORIZONTAL_RECT/.test(rawShape)
        ? "HORIZONTAL_RECT"
        : /VERTICAL_RECT/.test(rawShape)
        ? "VERTICAL_RECT"
        : /square/i.test(aria)
        ? "SQUARE"
        : /wide rectangle/i.test(aria)
        ? "HORIZONTAL_RECT"
        : /tall rectangle/i.test(aria)
        ? "VERTICAL_RECT"
        : "UNKNOWN";
      const numEl = el.querySelector('[data-testid^="patches-clue-number"]');
      let area = numEl ? parseInt(numEl.textContent.trim(), 10) : NaN;
      if (!Number.isInteger(area)) {
        const am = /(\d+)\s*cells?/i.exec(aria);
        area = am ? parseInt(am[1], 10) : NaN;
      }
      clues.push({ idx, shape, area: Number.isInteger(area) ? area : null });
    }
    if (clues.length < 2) return null;

    // Rectangle puzzle iff every clue is a rectangle shape with a known area.
    const rectanglePuzzle = clues.every(
      (c) => c.area >= 1 && (c.shape === "SQUARE" || c.shape === "HORIZONTAL_RECT" || c.shape === "VERTICAL_RECT")
    );

    return { rows, cols, clues, rectanglePuzzle, boardEl };
  }

  // --- rectangle exact-cover solver (Shikaku with shape constraints) ---
  // Returns an array (one per clue) of {tl, br, cells}, or null if unsolvable.
  function solve(board) {
    const { rows, cols, clues } = board;
    const total = rows * cols;
    let sum = 0;
    for (const c of clues) sum += c.area;
    if (sum !== total) return null; // patches must tile the whole grid

    const clueAt = new Array(total).fill(-1);
    clues.forEach((c, i) => (clueAt[c.idx] = i));

    function factorPairs(A, shape) {
      const out = [];
      for (let h = 1; h <= A; h++) {
        if (A % h) continue;
        const w = A / h;
        if (shape === "SQUARE" && h === w) out.push([h, w]);
        else if (shape === "HORIZONTAL_RECT" && w > h) out.push([h, w]);
        else if (shape === "VERTICAL_RECT" && h > w) out.push([h, w]);
      }
      return out;
    }

    // candidate rectangles per clue: right size/shape, covering the clue, no other clue
    const candidates = clues.map((cl, ci) => {
      const r = Math.floor(cl.idx / cols),
        c = cl.idx % cols;
      const list = [];
      for (const [h, w] of factorPairs(cl.area, cl.shape)) {
        if (h > rows || w > cols) continue;
        for (let r0 = Math.max(0, r - h + 1); r0 <= Math.min(rows - h, r); r0++) {
          for (let c0 = Math.max(0, c - w + 1); c0 <= Math.min(cols - w, c); c0++) {
            const cells = [];
            let ok = true;
            for (let rr = r0; rr < r0 + h && ok; rr++)
              for (let cc = c0; cc < c0 + w; cc++) {
                const id = rr * cols + cc;
                if (clueAt[id] !== -1 && clueAt[id] !== ci) {
                  ok = false;
                  break;
                }
                cells.push(id);
              }
            if (ok)
              list.push({
                tl: r0 * cols + c0,
                br: (r0 + h - 1) * cols + (c0 + w - 1),
                cells,
              });
          }
        }
      }
      return list;
    });
    if (candidates.some((l) => l.length === 0)) return null;

    // exact cover: pick one candidate per clue, non-overlapping, covering every cell.
    // Fewest-candidates-first ordering prunes hard.
    const order = clues.map((_, i) => i).sort((a, b) => candidates[a].length - candidates[b].length);
    const occupied = new Array(total).fill(false);
    const chosen = new Array(clues.length).fill(null);
    function bt(k) {
      if (k === order.length) return occupied.every(Boolean);
      const ci = order[k];
      for (const cand of candidates[ci]) {
        if (cand.cells.some((id) => occupied[id])) continue;
        cand.cells.forEach((id) => (occupied[id] = true));
        chosen[ci] = cand;
        if (bt(k + 1)) return true;
        cand.cells.forEach((id) => (occupied[id] = false));
        chosen[ci] = null;
      }
      return false;
    }
    if (!bt(0)) return null;
    return chosen;
  }

  // --- keyboard fill ---
  function cursorIdx() {
    const a = document.activeElement;
    return a && a.getAttribute && a.hasAttribute("data-cell-idx")
      ? parseInt(a.getAttribute("data-cell-idx"), 10)
      : null;
  }
  function pressKeyOn(el, key, kc) {
    for (const type of ["keydown", "keyup"])
      el.dispatchEvent(
        new KeyboardEvent(type, {
          key, code: key, keyCode: kc, which: kc,
          bubbles: true, cancelable: true, composed: true, view: window,
        })
      );
  }
  async function fill(board, solution) {
    const boardEl = board.boardEl;
    const { rows, cols } = board;
    const press = (key, kc) => {
      const a = document.activeElement;
      const el = a && a.hasAttribute && a.hasAttribute("data-cell-idx") ? a : boardEl;
      pressKeyOn(el, key, kc);
    };
    // enter grid mode (a cursor cell gains focus)
    async function ensureGrid() {
      for (let t = 0; t < 4; t++) {
        if (cursorIdx() != null) return true;
        boardEl.focus();
        pressKeyOn(boardEl, "Enter", 13);
        await sleep(150);
      }
      return cursorIdx() != null;
    }
    // move the cursor to a target cell by reading its current position each step
    async function goto(target) {
      for (let g = 0; g < rows + cols + 4; g++) {
        const f = cursorIdx();
        if (f === target) return true;
        if (f == null) return false;
        const fr = Math.floor(f / cols), fc = f % cols;
        const tr = Math.floor(target / cols), tc = target % cols;
        if (fr < tr) press("ArrowDown", 40);
        else if (fr > tr) press("ArrowUp", 38);
        else if (fc < tc) press("ArrowRight", 39);
        else if (fc > tc) press("ArrowLeft", 37);
        await sleep(70);
      }
      return cursorIdx() === target;
    }

    if (!(await ensureGrid())) return { ok: false, error: "Could not focus the gameboard." };
    let placed = 0;
    for (const rect of solution) {
      if (!(await goto(rect.tl))) return { ok: false, error: "Cursor navigation failed." };
      press("Enter", 13); // anchor
      await sleep(120);
      if (!(await goto(rect.br))) return { ok: false, error: "Cursor navigation failed." };
      press("Enter", 13); // commit — fills the bounding-box rectangle
      await sleep(150);
      placed++;
    }
    return { ok: true, placed };
  }

  // --- dispatch ---
  const board = parseBoard();
  if (mode === "detect") {
    if (!board) return { solvable: false, present: false, N: 0 };
    if (!board.rectanglePuzzle)
      return { solvable: false, present: true, unsupported: true, N: board.cols };
    return { solvable: !!solve(board), present: true, N: board.cols };
  }

  // mode === 'solve'
  if (!board) return { ok: false, error: "Board not found or still loading." };
  if (!board.rectanglePuzzle)
    return { ok: false, error: "Freeform Patches puzzles aren't supported (rectangle puzzles only)." };
  const solution = solve(board);
  if (!solution) return { ok: false, error: "No rectangle tiling found for this board." };
  return await fill(board, solution);
}
