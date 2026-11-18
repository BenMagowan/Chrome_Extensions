/*
 * Board preview for Patches, from Patches_Solver/popup.js, drawn to look like
 * LinkedIn's finished board. It draws into `boardEl` and returns the two calls
 * popup.js makes. Styles: the `[data-game="patches"]` blocks in games.css
 * (from the single-game solver) and looks.css (the LinkedIn look).
 */
registerPreview("patches", (boardEl) => {
  // Patches boards vary in size and aren't always square. The empty grid just uses
  // a common shape; renderBoard resizes to the real one the moment we know it.
  const DEFAULT_ROWS = 7;
  const DEFAULT_COLS = 7;

  /**
   * The class that rounds a cell's outer corner to match the board's radius, or ""
   * for a non-corner cell. The board is rounded + `overflow: hidden`, so without
   * this the four square corner cells' patch colours are clipped into a dark notch.
   * Takes rows and cols separately since Patches boards needn't be square.
   */
  function cornerClass(row, col, rows, cols) {
    const top = row === 0;
    const bottom = row === rows - 1;
    const left = col === 0;
    const right = col === cols - 1;
    if (top && left) return "board__cell--tl";
    if (top && right) return "board__cell--tr";
    if (bottom && left) return "board__cell--bl";
    if (bottom && right) return "board__cell--br";
    return "";
  }

  /** Lay out the grid itself, sized to the board. */
  function buildGrid(rows, cols) {
    boardEl.style.setProperty("--rows", rows);
    boardEl.style.setProperty("--cols", cols);
    const frag = document.createDocumentFragment();
    const cellEls = [];
    for (let i = 0; i < rows * cols; i++) {
      const cell = document.createElement("div");
      cell.className = "board__cell";
      const corner = cornerClass(Math.floor(i / cols), i % cols, rows, cols);
      if (corner) cell.classList.add(corner);
      // Placed explicitly, so the patch blocks laid over them don't push them along.
      cell.style.gridArea = `${Math.floor(i / cols) + 1} / ${(i % cols) + 1}`;
      cellEls.push(cell);
      frag.appendChild(cell);
    }
    return { frag, cellEls };
  }

  /**
   * The empty grid shown until a board is found — it says "no board yet" in the
   * shape of the thing we're waiting for, which the old "No board found" line
   * couldn't. Purely decorative: the status line is still there for screen
   * readers, so this would only be noise in the a11y tree.
   */
  function renderPlaceholder() {
    const { frag } = buildGrid(DEFAULT_ROWS, DEFAULT_COLS);
    boardEl.replaceChildren(frag);
    boardEl.setAttribute("aria-hidden", "true");
  }

  /**
   * Draw the detect snapshot — the grid tiled into the SOLUTION's patches with the
   * clues on top (see snapshot in injected.js). Replaces the "Board detected"
   * line: the grid says the same thing and shows the answer besides.
   *
   * Cells with no patch (`patch === -1`) keep the bare surface. That happens on a
   * board we found but couldn't tile, where a bare grid carrying just the clues is
   * the honest picture — better than inventing a tiling to have something to show.
   */
  // LinkedIn's patch colours, in the order a finished board tends to use them:
  // [fill, border].
  const PATCH_COLOURS = [
    ["#dc5c4e", "#c9302a"],
    ["#c8a85a", "#b8902f"],
    ["#6db57c", "#4a9e5a"],
    ["#9277f7", "#7a55ef"],
    ["#6fbbf7", "#4aa3f6"],
    ["#e59059", "#d9742f"],
    ["#e57fb3", "#d65b98"],
    ["#5cc3b8", "#34a99c"],
  ];

  /** Each patch's bounding rows and columns, from the cells that carry its index. */
  function patchBoxes(cells) {
    const boxes = new Map();
    for (const c of cells) {
      if (!(c.patch >= 0)) continue;
      const b = boxes.get(c.patch) || { r0: c.row, r1: c.row, c0: c.col, c1: c.col };
      b.r0 = Math.min(b.r0, c.row);
      b.r1 = Math.max(b.r1, c.row);
      b.c0 = Math.min(b.c0, c.col);
      b.c1 = Math.max(b.c1, c.col);
      boxes.set(c.patch, b);
    }
    return boxes;
  }

  function renderBoard(cells, rows, cols) {
    if (!Array.isArray(cells) || !cells.length) return;

    const { frag, cellEls } = buildGrid(rows, cols);
    // The patches as LinkedIn draws a finished board: one rounded block each, laid
    // over the grid. Ordered top-left first so neighbouring patches differ.
    const boxes = [...patchBoxes(cells).entries()].sort(
      ([, a], [, b]) => a.r0 - b.r0 || a.c0 - b.c0
    );
    boxes.forEach(([, b], i) => {
      const block = document.createElement("div");
      block.className = "board__block";
      const [fill, line] = PATCH_COLOURS[i % PATCH_COLOURS.length];
      block.style.setProperty("--fill", fill);
      block.style.setProperty("--line", line);
      block.style.gridArea = `${b.r0 + 1} / ${b.c0 + 1} / ${b.r1 + 2} / ${b.c1 + 2}`;
      frag.appendChild(block);
    });
    for (const c of cells) {
      const cell = cellEls[c.row * cols + c.col];
      // A cell with no patch yet keeps its clue; inside a block, the block says it.
      if (c.patch >= 0 || !c.clue) continue;
      // The clue markers ride on top of their patch, as they do in the game. An
      // unnumbered clue still gets its disc — it's a clue, it just isn't sized.
      const dot = document.createElement("span");
      dot.className = "board__clue";
      if (c.clue.area != null) dot.textContent = String(c.clue.area);
      cell.appendChild(dot);
    }
    boardEl.replaceChildren(frag);

    // A real board is worth describing, unlike the placeholder it replaces.
    boardEl.removeAttribute("aria-hidden");
    boardEl.setAttribute("aria-label", t("solutionPreview", rows, cols));
  }

  return {
    renderPlaceholder,
    renderBoard: (b) => renderBoard(b.cells, b.rows, b.cols),
  };
});
