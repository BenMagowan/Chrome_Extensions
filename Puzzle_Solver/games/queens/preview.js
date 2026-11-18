/*
 * Board preview for Queens, moved here verbatim from
 * Queens_Solver/popup.js. It draws into `boardEl` and returns the two calls popup.js makes.
 * Its styles are the `[data-game="queens"]` block in styles.css.
 */
registerPreview("queens", (boardEl) => {
  /**
   * Fallback region colours, used only if the page didn't give us usable swatches
   * (see swatchOf in injected.js). Hues are evenly spaced so adjacent regions stay
   * distinguishable whatever N is, rather than being a fixed list that runs out.
   */
  function fallbackColor(regionIndex, regionCount) {
    const hue = Math.round((360 / Math.max(regionCount, 1)) * regionIndex);
    return `hsl(${hue} 62% 78%)`;
  }

  const QUEEN_PATH =
    "M4.4 16.6 3.6 9.1l4.6 3.2L12 6.2l3.8 6.1 4.6-3.2-.8 7.5z M4.2 18.3h15.6v3.1H4.2z";

  function queenSvg() {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", QUEEN_PATH);
    svg.appendChild(p);
    return svg;
  }

  // Queens boards vary in size, so the empty grid just uses the most common one.
  // It's a placeholder, and renderBoard resizes to the real N the moment we know it.
  const DEFAULT_N = 8;

  /**
   * The class that rounds a cell's outer corner to match the board's radius, or ""
   * for a non-corner cell. The board is rounded + `overflow: hidden`, so without
   * this the four square corner cells are clipped and their colour reads as "cut
   * off" (a dark notch). Works for any N since it keys off row/col.
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
   * The empty grid shown until a board is found — it says "no board yet" in the
   * shape of the thing we're waiting for, which the old "No board found" line
   * couldn't. Purely decorative: the status line is still there for screen
   * readers, so this would only be noise in the a11y tree.
   */
  function renderPlaceholder() {
    boardEl.style.setProperty("--n", DEFAULT_N);
    const frag = document.createDocumentFragment();
    for (let i = 0; i < DEFAULT_N * DEFAULT_N; i++) {
      const cell = document.createElement("div");
      cell.className = "board__cell";
      const corner = cornerClass(Math.floor(i / DEFAULT_N), i % DEFAULT_N, DEFAULT_N);
      if (corner) cell.classList.add(corner);
      frag.appendChild(cell);
    }
    boardEl.replaceChildren(frag);
    boardEl.setAttribute("aria-hidden", "true");
  }

  /**
   * Draw the detect snapshot — the board's regions with the SOLUTION's crowns on
   * it (see snapshot in injected.js). Replaces the "Board detected · N×N" line:
   * the grid says the same thing and shows the answer besides.
   */
  function renderBoard(cells, N) {
    if (!Array.isArray(cells) || !cells.length) return;

    // Only trust the page's own colours if they actually distinguish the regions;
    // a board whose swatches all resolve the same (or missing) would otherwise
    // render as one flat block. Falling back keeps the preview readable.
    const regions = [...new Set(cells.map((c) => c.region))];
    const distinct = new Set(cells.map((c) => c.color).filter(Boolean));
    const usePageColors = distinct.size >= regions.length && regions.length > 1;

    boardEl.style.setProperty("--n", N);

    // Sort into row-major order: the DOM order is whatever the page had, but CSS
    // grid places children sequentially, so the preview must be explicitly ordered.
    const ordered = [...cells].sort((a, b) => a.row - b.row || a.col - b.col);

    const frag = document.createDocumentFragment();
    for (const c of ordered) {
      const cell = document.createElement("div");
      cell.className = "board__cell";
      const corner = cornerClass(c.row, c.col, N);
      if (corner) cell.classList.add(corner);
      if (c.state === "queen") cell.classList.add("board__cell--queen");
      if (c.state === "cross") cell.classList.add("board__cell--cross");
      cell.style.background = usePageColors
        ? c.color
        : fallbackColor(regions.indexOf(c.region), regions.length);
      if (c.state === "queen") cell.appendChild(queenSvg());
      frag.appendChild(cell);
    }
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
