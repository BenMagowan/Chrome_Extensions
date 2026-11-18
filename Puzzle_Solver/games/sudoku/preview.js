/*
 * Board preview for Mini Sudoku, moved here verbatim from
 * Mini_Sudoku_Solver/popup.js. It draws into `boardEl` and returns the two calls popup.js makes.
 * Its styles are the `[data-game="sudoku"]` block in styles.css.
 */
registerPreview("sudoku", (boardEl) => {
  // Every Mini Sudoku is 6×6, so the empty grid can be drawn at the real size and
  // the popup never resizes when an actual board turns up.
  const DEFAULT_N = 6;

  /**
   * The class that rounds a cell's outer corner to match the board's radius, or ""
   * for a non-corner cell. The board is rounded + `overflow: hidden`, so without
   * this the four square corner cells are clipped and read as "cut off". Works for
   * any N since it keys off row/col.
   */
  function cornerClass(row, col, N) {
    const top = row === 0;
    const bottom = row === N - 1;
    const left = col === 0;
    const right = col === N - 1;
    if (top && left) return "board__cell--tl";
    if (top && right) return "board__cell--tr";
    if (bottom && left) return "board__cell--bl";
    if (bottom && right) return "board__cell--br";
    return "";
  }

  /**
   * Tag each cell in `cellEls` (row-major, N×N) with wall classes on exactly one
   * side of each interior boundary — right or bottom, whichever cell comes first
   * in reading order. A real Sudoku board reports walls per-cell, and a boundary
   * is often flagged by BOTH cells that share it (the left one's right wall and
   * the right one's left wall); drawing a border for each would sandwich the
   * hairline grid line between two wall borders. `sharesRegion(r1,c1,r2,c2)` is
   * the single source of truth for whether two adjacent cells are walled apart —
   * callers fold whatever wall data they have into one answer per boundary.
   */
  function markWalls(cellEls, N, sharesRegion) {
    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const cell = cellEls[r * N + c];
        if (c < N - 1 && !sharesRegion(r, c, r, c + 1)) {
          cell.classList.add("board__cell--wall-right");
        }
        if (r < N - 1 && !sharesRegion(r, c, r + 1, c)) {
          cell.classList.add("board__cell--wall-bottom");
        }
      }
    }
  }

  /**
   * The empty grid shown until a board is found — it says "no board yet" in the
   * shape of the thing we're waiting for, which the old "No board found" line
   * couldn't. Purely decorative: the status line is still there for screen
   * readers, so this would only be noise in the a11y tree. The real puzzle's
   * region layout isn't known yet, so this guesses at the ordinary 2×3 boxes —
   * right most of the time, and still just a placeholder when it isn't.
   */
  function renderPlaceholder() {
    boardEl.style.setProperty("--n", DEFAULT_N);
    const frag = document.createDocumentFragment();
    const cellEls = [];
    for (let i = 0; i < DEFAULT_N * DEFAULT_N; i++) {
      const cell = document.createElement("div");
      cell.className = "board__cell";
      const corner = cornerClass(Math.floor(i / DEFAULT_N), i % DEFAULT_N, DEFAULT_N);
      if (corner) cell.classList.add(corner);
      cellEls.push(cell);
      frag.appendChild(cell);
    }
    const box = (r, c) => Math.floor(r / 2) * 2 + Math.floor(c / 3);
    markWalls(cellEls, DEFAULT_N, (r1, c1, r2, c2) => box(r1, c1) === box(r2, c2));
    boardEl.replaceChildren(frag);
    boardEl.setAttribute("aria-hidden", "true");
  }

  /**
   * Draw the detect snapshot — the grid with the SOLUTION's digits on it (see
   * snapshot in injected.js). Replaces the "Board detected · N×N" line: the grid
   * says the same thing and shows the answer besides.
   */
  function renderBoard(cells, N) {
    if (!Array.isArray(cells) || !cells.length) return;

    boardEl.style.setProperty("--n", N);

    // Sort into row-major order: the DOM order is whatever the page had, but CSS
    // grid places children sequentially, so the preview must be explicitly ordered.
    const ordered = [...cells].sort((a, b) => a.row - b.row || a.col - b.col);
    const atRowCol = new Map(ordered.map((c) => [`${c.row},${c.col}`, c]));

    const frag = document.createDocumentFragment();
    const cellEls = [];
    for (const c of ordered) {
      const cell = document.createElement("div");
      cell.className = "board__cell";
      const corner = cornerClass(c.row, c.col, N);
      if (corner) cell.classList.add(corner);
      // The puzzle's own clues, so you can tell them from the solver's digits.
      if (c.given) cell.classList.add("board__cell--given");
      if (c.value) cell.textContent = String(c.value);
      cellEls.push(cell);
      frag.appendChild(cell);
    }
    // Two cells are walled apart if EITHER reports a wall on their shared side —
    // the live DOM doesn't always mark both.
    const sharesRegion = (r1, c1, r2, c2) => {
      const a = atRowCol.get(`${r1},${c1}`).walls;
      const b = atRowCol.get(`${r2},${c2}`).walls;
      const wallBetween =
        (r1 === r2 ? a.right || b.left : a.bottom || b.top);
      return !wallBetween;
    };
    markWalls(cellEls, N, sharesRegion);
    boardEl.replaceChildren(frag);

    // A real board is worth describing, unlike the placeholder it replaces.
    boardEl.removeAttribute("aria-hidden");
    boardEl.setAttribute("aria-label", t("solutionPreview", N, N));
  }

  return {
    renderPlaceholder,
    renderBoard: (b) => renderBoard(b.cells, b.N),
  };
});
