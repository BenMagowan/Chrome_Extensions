/*
 * Board preview for Zip, moved here verbatim from
 * Zip_Solver/popup.js. It draws into `boardEl` and returns the two calls popup.js makes.
 * Its styles are the `[data-game="zip"]` block in styles.css.
 */
registerPreview("zip", (boardEl) => {
  // Zip boards are 6×6, so the empty grid can be drawn at the real size and the
  // popup never resizes when an actual board turns up.
  const DEFAULT_N = 6;

  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  /**
   * The class that rounds a cell's outer corner to match the board's radius, or ""
   * for a non-corner cell. The board is rounded + `overflow: hidden`, so without
   * this the four square corner cells are clipped and their hairlines cut off at
   * the curve. Works for any N since it keys off row/col.
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

  /** Lay out the grid itself. Cells only — the walls and path go in the overlay. */
  function buildGrid(N) {
    boardEl.style.setProperty("--n", N);
    const frag = document.createDocumentFragment();
    const cellEls = [];
    for (let i = 0; i < N * N; i++) {
      const cell = document.createElement("div");
      cell.className = "board__cell";
      const corner = cornerClass(Math.floor(i / N), i % N, N);
      if (corner) cell.classList.add(corner);
      cellEls.push(cell);
      frag.appendChild(cell);
    }
    return { frag, cellEls };
  }

  /**
   * Walls and path, drawn as one SVG laid over the grid.
   *
   * The viewBox is N×N, so one unit is one cell and the centre of cell (r,c) is
   * just (c+0.5, r+0.5). That only holds because the grid has no gap between
   * cells: with gaps the cells stop being a uniform N division of the box and
   * every point drifts by a growing fraction of a cell. The hairlines between
   * cells are drawn by the cells themselves instead (see styles.css).
   */
  function overlaySvg(cells, path, N) {
    const svg = svgEl("svg", {
      class: "board__overlay",
      viewBox: `0 0 ${N} ${N}`,
      "aria-hidden": "true",
    });

    // Walls sit on the boundary BETWEEN two cells, and both of them may report the
    // same one, so key each boundary and draw it once. Walls on the outer border
    // are skipped — that edge is already the frame of the board.
    const edges = new Set();
    for (const c of cells) {
      if (!c.walls) continue;
      if (c.walls.right && c.col < N - 1) edges.add(`v:${c.row}:${c.col}`);
      if (c.walls.left && c.col > 0) edges.add(`v:${c.row}:${c.col - 1}`);
      if (c.walls.down && c.row < N - 1) edges.add(`h:${c.row}:${c.col}`);
      if (c.walls.up && c.row > 0) edges.add(`h:${c.row - 1}:${c.col}`);
    }
    for (const key of edges) {
      const [kind, r, c] = key.split(":");
      const row = Number(r);
      const col = Number(c);
      // "v" is the vertical boundary on the right of (row,col); "h" the one below it.
      const line =
        kind === "v"
          ? { x1: col + 1, y1: row, x2: col + 1, y2: row + 1 }
          : { x1: col, y1: row + 1, x2: col + 1, y2: row + 1 };
      svg.appendChild(svgEl("line", { ...line, class: "board__wall" }));
    }

    if (Array.isArray(path) && path.length > 1) {
      const points = path
        .map((idx) => `${(idx % N) + 0.5},${Math.floor(idx / N) + 0.5}`)
        .join(" ");
      svg.appendChild(svgEl("polyline", { points, class: "board__path" }));
    }
    return svg;
  }

  /**
   * The empty grid shown until a board is found — it says "no board yet" in the
   * shape of the thing we're waiting for, which the old "No board found" line
   * couldn't. Purely decorative: the status line is still there for screen
   * readers, so this would only be noise in the a11y tree.
   */
  function renderPlaceholder() {
    const { frag } = buildGrid(DEFAULT_N);
    boardEl.replaceChildren(frag);
    boardEl.setAttribute("aria-hidden", "true");
  }

  /**
   * Draw the detect snapshot — the numbered cells with the SOLUTION path routed
   * through them (see snapshot in injected.js). Replaces the "Board detected ·
   * N×N" line: the grid says the same thing and shows the answer besides.
   */
  function renderBoard(cells, path, N) {
    if (!Array.isArray(cells) || !cells.length) return;

    const { frag, cellEls } = buildGrid(N);
    for (const c of cells) {
      if (!c.number) continue;
      // The numbered dots ride on top of the path, as they do in the game.
      const dot = document.createElement("span");
      dot.className = "board__num";
      dot.textContent = String(c.number);
      cellEls[c.row * N + c.col].appendChild(dot);
    }
    frag.appendChild(overlaySvg(cells, path, N));
    boardEl.replaceChildren(frag);

    // Dash the path to its own length so it can be drawn on rather than appearing
    // all at once. Needs to be in the document — getTotalLength measures layout.
    const line = boardEl.querySelector(".board__path");
    if (line) line.style.setProperty("--len", line.getTotalLength());

    // A real board is worth describing, unlike the placeholder it replaces.
    boardEl.removeAttribute("aria-hidden");
    boardEl.setAttribute("aria-label", t("solutionPreview", N, N));
  }

  return {
    renderPlaceholder,
    renderBoard: (b) => renderBoard(b.cells, b.path, b.N),
  };
});
