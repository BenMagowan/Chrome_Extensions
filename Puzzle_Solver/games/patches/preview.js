/*
 * Board preview for Patches, moved here verbatim from
 * Patches_Solver/popup.js. It draws into `boardEl` and returns the two calls popup.js makes.
 * Its styles are the `[data-game="patches"]` block in styles.css.
 */
registerPreview("patches", (boardEl) => {
  // Patches boards vary in size and aren't always square. The empty grid just uses
  // a common shape; renderBoard resizes to the real one the moment we know it.
  const DEFAULT_ROWS = 7;
  const DEFAULT_COLS = 7;

  /**
   * A patch's fill. Stepping the hue by the golden angle rather than dividing the
   * wheel evenly: clues come out roughly in reading order, so patches that sit
   * next to each other tend to have consecutive indices — and an even division
   * hands consecutive indices neighbouring hues, which is exactly when two
   * touching patches blur into one. A ~137° step puts them across the wheel from
   * each other instead, for any number of patches.
   *
   * Only the hue is set here; saturation and lightness live in the stylesheet, so
   * the same patch reads as a pastel in light mode and a deep tone in dark.
   */
  const GOLDEN_ANGLE = 137.508;

  function patchHue(patchIndex) {
    return Math.round((patchIndex * GOLDEN_ANGLE) % 360);
  }

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
  function renderBoard(cells, rows, cols) {
    if (!Array.isArray(cells) || !cells.length) return;

    const { frag, cellEls } = buildGrid(rows, cols);
    for (const c of cells) {
      const cell = cellEls[c.row * cols + c.col];
      if (c.patch >= 0) {
        cell.classList.add("board__cell--patch");
        cell.style.setProperty("--hue", patchHue(c.patch));
      }
      if (!c.clue) continue;
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
