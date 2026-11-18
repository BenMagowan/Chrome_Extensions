/*
 * Board preview for Queens, from Queens_Solver/popup.js, drawn to look like
 * LinkedIn's finished board. It draws into `boardEl` and returns the two calls
 * popup.js makes. Styles: the `[data-game="queens"]` blocks in games.css
 * (from the single-game solver) and looks.css (the LinkedIn look).
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

  // A gold crown like LinkedIn's: three points tipped with jewels, a body that
  // dips between them, and a band across the bottom. Each part has a class so
  // looks.css can shade it.
  const SVG_NS = "http://www.w3.org/2000/svg";
  const CROWN_PARTS = [
    ["path", { class: "crown__body", d: "M4.6 17.2 3.2 8.9l4.9 4.2L12 6.6l3.9 6.5 4.9-4.2-1.4 8.3Z" }],
    ["path", { class: "crown__shine", d: "M6.1 15.6 5.4 11.6l2.8 2.4" }],
    ["rect", { class: "crown__band", x: 4.4, y: 17.4, width: 15.2, height: 3, rx: 1.2 }],
    ["circle", { class: "crown__jewel", cx: 3.2, cy: 8.1, r: 1.55 }],
    ["circle", { class: "crown__jewel", cx: 12, cy: 5.4, r: 1.7 }],
    ["circle", { class: "crown__jewel", cx: 20.8, cy: 8.1, r: 1.55 }],
  ];

  function queenSvg() {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "crown");
    for (const [tag, attrs] of CROWN_PARTS) {
      const el = document.createElementNS(SVG_NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      svg.appendChild(el);
    }
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
      // As LinkedIn shows a finished board: every other cell crossed out, and a
      // thick line wherever two regions meet.
      else {
        const x = document.createElement("span");
        x.className = "board__x";
        x.textContent = "×";
        cell.appendChild(x);
      }
      const regionAt = (r, col) => {
        const n = ordered[r * N + col];
        return n && n.row === r && n.col === col ? n.region : null;
      };
      if (c.col < N - 1 && regionAt(c.row, c.col + 1) !== c.region) cell.classList.add("board__cell--wall-right");
      if (c.row < N - 1 && regionAt(c.row + 1, c.col) !== c.region) cell.classList.add("board__cell--wall-bottom");
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
