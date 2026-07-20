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
 * PATCHES RULES: partition the grid into rectangular regions ("patches"), one per clue,
 * tiling every cell — i.e. a Shikaku tiling. EVERY patch is a rectangle; a clue merely
 * constrains it, and BOTH constraints are optional (per the in-game legend: "Complete
 * each shape to fill the grid — Square / Tall rectangle / Wide rectangle / Any of the
 * above. If a shape has a number, it must be that size."):
 *   - shape: SQUARE (h == w), HORIZONTAL_RECT (wide, w > h), VERTICAL_RECT (tall, h > w),
 *     or ANY — the game's `PatchesShapeConstraint_UNKNOWN`, labelled "freeform clue" in
 *     aria text and "Any of the above" in the legend. ANY is *not* a freeform polyomino:
 *     the patch is still a rectangle, just unconstrained in shape.
 *   - area: the clue's number, or null when the clue shows no number (any size).
 * Harder boards lean on both — No. 122 (HARD) was 10/12 clues ANY, two with no number —
 * so neither may be treated as a parse failure or an unsupported board. (See README.)
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
 * @returns {{solvable:boolean,present:boolean,rows:number,cols:number,solved:boolean,
 *            cells:object[]|null}} for 'detect',
 *          {{ok:boolean, placed?:number, alreadySolved?:boolean, error?:string}} for 'solve'
 */
async function runPatches(mode) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- parse the board into {rows, cols, clues, boardEl} ---
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
    // Both constraints are optional; absent means unconstrained, never unsupported:
    // an unrecognised shape falls back to "ANY", an unreadable number to null.
    //
    // The membership phrases are stripped BEFORE the "…clue…" test, and that is not a
    // nicety. Drawing a patch rewrites its cells' labels to "Row 1, column 1, in region
    // with clue at row 2, column 2" — which contains the word "clue", so a bare
    // /clue/i test promotes every filled cell into a phantom unnumbered clue. On a
    // part-drawn board that inflates the clue list (verified live: 10 real clues read
    // as 13), the arithmetic guard in solve() then rejects the board, and the whole
    // thing surfaces as "no board / no solution" — see README.
    const drawnPhrase = /,?\s*in region with clue at[^,]*,[^,]*/i;
    const drawnSelf = /,?\s*in drawn region/i;
    const clues = [];
    for (const el of els) {
      const idx = parseInt(el.getAttribute("data-cell-idx"), 10);
      const shapeEl = el.querySelector("[data-shape]");
      // `aria` describes the cell itself; membership in someone's patch is not part of
      // that, so it goes before any of the shape/area/clue reads below.
      const aria = (el.getAttribute("aria-label") || "")
        .replace(drawnPhrase, "")
        .replace(drawnSelf, "");
      if (!shapeEl && !/clue/i.test(aria)) continue;
      const rawShape = shapeEl ? shapeEl.getAttribute("data-shape") || "" : "";
      const shape = /SQUARE/.test(rawShape) || /square clue/i.test(aria)
        ? "SQUARE"
        : /HORIZONTAL_RECT/.test(rawShape) || /wide rectangle/i.test(aria)
        ? "HORIZONTAL_RECT"
        : /VERTICAL_RECT/.test(rawShape) || /tall rectangle/i.test(aria)
        ? "VERTICAL_RECT"
        : "ANY";
      const numEl = el.querySelector('[data-testid^="patches-clue-number"]');
      let area = numEl ? parseInt(numEl.textContent.trim(), 10) : NaN;
      if (!Number.isInteger(area)) {
        const am = /(\d+)\s*cells?/i.exec(aria);
        area = am ? parseInt(am[1], 10) : NaN;
      }
      clues.push({ idx, shape, area: Number.isInteger(area) ? area : null });
    }
    if (clues.length < 2) return null;

    return { rows, cols, clues, boardEl };
  }

  // --- rectangle exact-cover solver (Shikaku with optional shape/area constraints) ---
  // Returns an array (one per clue) of {tl, br, cells}, or null if unsolvable.
  function solve(board) {
    const { rows, cols, clues } = board;
    const total = rows * cols;

    // Cheap arithmetic guard. Clues with no number contribute an unknown area of >= 1,
    // so only an all-numbered board can be checked for an exact fit.
    let known = 0,
      unnumbered = 0;
    for (const c of clues) {
      if (c.area == null) unnumbered++;
      else known += c.area;
    }
    if (unnumbered === 0 ? known !== total : known + unnumbered > total) return null;

    const clueAt = new Array(total).fill(-1);
    clues.forEach((c, i) => (clueAt[c.idx] = i));

    // The h×w rectangles a clue permits. A null area allows every size, so this walks
    // the dimension grid rather than factorising, and shape 'ANY' filters nothing.
    function dimensions(area, shape) {
      const out = [];
      for (let h = 1; h <= rows; h++) {
        for (let w = 1; w <= cols; w++) {
          if (area != null && h * w !== area) continue;
          if (shape === "SQUARE" && h !== w) continue;
          if (shape === "HORIZONTAL_RECT" && w <= h) continue;
          if (shape === "VERTICAL_RECT" && h <= w) continue;
          out.push([h, w]);
        }
      }
      return out;
    }

    // candidate rectangles per clue: right size/shape, covering the clue, no other clue
    const candidates = clues.map((cl, ci) => {
      const r = Math.floor(cl.idx / cols),
        c = cl.idx % cols;
      const list = [];
      for (const [h, w] of dimensions(cl.area, cl.shape)) {
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

    // Exact cover: pick one candidate per clue, non-overlapping, covering every cell —
    // which is what pins down the unconstrained clues. A fixed fewest-first order is too
    // weak once a clue can be any size (~48 candidates on a 7×7), so pick the most
    // constrained clue afresh at each step and fail early when one runs out.
    const occupied = new Array(total).fill(false);
    const chosen = new Array(clues.length).fill(null);
    function bt(placed) {
      if (placed === clues.length) return occupied.every(Boolean);
      let bi = -1,
        bestFits = null;
      for (let i = 0; i < clues.length; i++) {
        if (chosen[i]) continue;
        const fits = candidates[i].filter((cand) => !cand.cells.some((id) => occupied[id]));
        if (fits.length === 0) return false;
        if (!bestFits || fits.length < bestFits.length) {
          bestFits = fits;
          bi = i;
        }
      }
      for (const cand of bestFits) {
        cand.cells.forEach((id) => (occupied[id] = true));
        chosen[bi] = cand;
        if (bt(placed + 1)) return true;
        cand.cells.forEach((id) => (occupied[id] = false));
        chosen[bi] = null;
      }
      return false;
    }
    if (!bt(0)) return null;
    return chosen;
  }

  // --- keyboard fill ---
  // A cell that belongs to a drawn patch says so in its aria-label: an ordinary cell
  // reads "…, in region with clue at row R, column C", and a *clue* cell inside a
  // patch reads "…, in drawn region". Either means "already drawn".
  const DRAWN = /in region with clue at|in drawn region/i;
  function drawnIdxs(board) {
    return Array.from(board.boardEl.querySelectorAll("[data-cell-idx]"))
      .filter((el) => DRAWN.test(el.getAttribute("aria-label") || ""))
      .map((el) => parseInt(el.getAttribute("data-cell-idx"), 10));
  }
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
    // Enter grid mode (a cursor cell gains focus) from a known-clean state.
    //
    // The Escape first is load-bearing. "Anchor placed, not yet committed" is a live
    // mode we can't read from the DOM, and it is easy to arrive in: the game refuses
    // to draw across cells that already belong to a patch, so a player whose draw was
    // rejected — or who simply pressed Enter and wandered off — leaves an anchor
    // dangling. With one live, our next keypress commits a rectangle instead of doing
    // what we asked, which is how an erase pass ends up *adding* a drawn cell
    // (observed: 8 drawn cells became 9). Escape drops grid mode and the anchor with
    // it; re-entering then gives a cursor with nothing pending.
    async function ensureGrid() {
      press("Escape", 27);
      await sleep(200);
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

    // Erase whatever is already on the board before drawing the solution.
    //
    // This is mandatory, not tidiness: the game will not draw a rectangle across cells
    // that already belong to a patch, so a single stray patch left in place blocks
    // every solution rectangle that overlaps it.
    //
    // The erase is **Backspace with the cursor on a drawn cell**, which removes that
    // cell's whole patch in one press (verified live: a 2×2 patch went from 4 drawn
    // cells to 0; a messier board went 9 -> 6 -> 2 -> 0 in three presses). So each pass
    // targets any still-drawn cell and clears its entire region — bounded by the clue
    // count, not the cell count.
    //
    // A header "Undo" button does exist (it renders once play starts), but it unwinds
    // move history step by step: the depth needed is unknown, it can't target a
    // specific patch, and on a resumed game the history may not reach back to the
    // patches already on the board. Backspace addresses a region directly, so it works
    // regardless of how the board got into its current state.
    let cleared = 0;
    for (let guard = 0; guard <= rows * cols; guard++) {
      const drawn = drawnIdxs(board);
      if (drawn.length === 0) break;
      if (!(await goto(drawn[0]))) return { ok: false, error: "Cursor navigation failed." };
      press("Backspace", 8);
      await sleep(180);
      // Stop rather than spin if a press stops removing anything — better to attempt
      // the fill and report honestly than to loop on an unerasable board.
      if (drawnIdxs(board).length >= drawn.length) break;
      cleared++;
    }

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
    return { ok: true, placed, cleared };
  }

  // --- is the board ALREADY finished? ---
  // Every cell belonging to some drawn patch is the win condition: the game only
  // draws rectangles, and refuses to draw one across cells that already belong to
  // a patch, so a fully covered board is a valid tiling.
  function isSolved(board) {
    return drawnIdxs(board).length === board.rows * board.cols;
  }

  /** Map cell index -> clue index, for the patches the PLAYER has already drawn. */
  // Read back out of the same aria text the erase pass keys off: an ordinary cell
  // in a patch names its owning clue's row/column, and a clue cell sitting inside
  // its own patch just says "in drawn region".
  function drawnPatchOf(board) {
    const { rows, cols, clues } = board;
    const clueIndexAt = new Map(clues.map((c, i) => [c.idx, i]));
    const patchOf = new Array(rows * cols).fill(-1);
    for (const el of board.boardEl.querySelectorAll("[data-cell-idx]")) {
      const idx = parseInt(el.getAttribute("data-cell-idx"), 10);
      const aria = el.getAttribute("aria-label") || "";
      const m = /in region with clue at row\s+(\d+),\s*column\s+(\d+)/i.exec(aria);
      if (m) {
        const owner = (parseInt(m[1], 10) - 1) * cols + (parseInt(m[2], 10) - 1);
        if (clueIndexAt.has(owner)) patchOf[idx] = clueIndexAt.get(owner);
      } else if (/in drawn region/i.test(aria) && clueIndexAt.has(idx)) {
        patchOf[idx] = clueIndexAt.get(idx);
      }
    }
    return patchOf;
  }

  /** Map cell index -> clue index, for a tiling solve() came up with. */
  function solutionPatchOf(board, solution) {
    const patchOf = new Array(board.rows * board.cols).fill(-1);
    solution.forEach((rect, i) => rect.cells.forEach((id) => (patchOf[id] = i)));
    return patchOf;
  }

  // A serialisable picture of the board for the popup to draw. Deliberately plain
  // data — executeScript has to structured-clone this back, so no elements.
  // `patchOf` may be all -1 (a board we couldn't tile), in which case the popup
  // draws the clues on a bare grid, which is the honest picture of that case.
  function snapshot(board, patchOf) {
    const { rows, cols, clues } = board;
    const clueAt = new Map(clues.map((c) => [c.idx, c]));
    const cells = [];
    for (let idx = 0; idx < rows * cols; idx++) {
      const cl = clueAt.get(idx);
      cells.push({
        row: Math.floor(idx / cols),
        col: idx % cols,
        patch: patchOf[idx],
        clue: cl ? { area: cl.area, shape: cl.shape } : null,
      });
    }
    return cells;
  }

  // --- dispatch ---
  const board = parseBoard();
  if (mode === "detect") {
    if (!board) {
      return { solvable: false, present: false, rows: 0, cols: 0, solved: false, cells: null };
    }
    // A finished board is its own answer, so show the player's own tiling rather
    // than an equally valid alternative we'd have gone and computed.
    const done = isSolved(board);
    const solution = done ? null : solve(board);
    const patchOf = done ? drawnPatchOf(board) : solution ? solutionPatchOf(board, solution) : [];
    const cells = snapshot(board, patchOf.length ? patchOf : new Array(board.rows * board.cols).fill(-1));
    return {
      // A solved board counts as solvable even though we skipped solving it —
      // otherwise the popup would read "no tiling exists" for a finished puzzle.
      solvable: done || !!solution,
      present: true,
      rows: board.rows,
      cols: board.cols,
      solved: done,
      cells,
    };
  }

  // mode === 'solve'
  if (!board) return { ok: false, error: "Board not found or still loading." };
  // Already finished (e.g. completed between the popup's last poll and the click) —
  // report it instead of erasing a won board just to redraw it.
  if (isSolved(board)) {
    return { ok: true, placed: board.clues.length, alreadySolved: true, rows: board.rows, cols: board.cols };
  }
  const solution = solve(board);
  if (!solution) return { ok: false, error: "No rectangle tiling found for this board." };
  const filled = await fill(board, solution);
  return filled.ok ? { ...filled, rows: board.rows, cols: board.cols } : filled;
}
