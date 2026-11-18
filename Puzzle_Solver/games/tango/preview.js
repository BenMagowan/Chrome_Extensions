/*
 * Board preview for Tango, from Tango_Solver/popup.js, drawn to look like
 * LinkedIn's finished board. It draws into `boardEl` and returns the two calls
 * popup.js makes. Styles: the `[data-game="tango"]` blocks in games.css
 * (from the single-game solver) and looks.css (the LinkedIn look).
 */
registerPreview("tango", (boardEl) => {
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgEl(name, attrs) {
    const el = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    return el;
  }

  /**
   * Sun and moon, drawn rather than fetched: the popup can't reuse the game's own
   * sprites, and inline SVG takes its colour from the stylesheet so both symbols
   * theme with the rest of the popup.
   */
  // Both pieces are the same disc, so the Sun and the Moon read as the same size.
  const SYMBOL_R = 9;
  // How much of that disc survives the bite, measured across the crescent's waist.
  const MOON_WAIST = 8;
  // The bite comes out of the top left, as it does in the game.
  const MOON_ANGLE = 225;

  /**
   * Crescent = disc1 minus disc2, both radius R, disc2's centre shifted `waist` to
   * the right of disc1's. The two arcs below trace exactly that boundary — around
   * disc1's far edge, then back along disc2's near edge — so it's one simple closed
   * path rather than an overlap needing a fill rule to resolve. The offset IS the
   * crescent's thickness at its waist: small is a sliver, approaching 2R is a disc.
   */
  function moonPath(cx, cy, R, waist) {
    const h = Math.sqrt(R * R - (waist / 2) ** 2); // half the chord where the discs cross
    const xMid = cx + waist / 2; // the discs cross on this vertical line
    const top = `${xMid} ${cy - h}`;
    const bottom = `${xMid} ${cy + h}`;
    // Flags matter and are easy to get backwards — each arc has two candidate
    // centres and two directions, and picking wrong silently traces the *other*
    // disc. Down the left: disc1's major arc (large-arc 1), anticlockwise on screen
    // (sweep 0). Back up: disc2's minor arc (0) bulging left, clockwise (1).
    return `M${top}A${R} ${R} 0 1 0 ${bottom}A${R} ${R} 0 0 1 ${top}Z`;
  }

  function symbolSvg(symbol) {
    const svg = svgEl("svg", { viewBox: "0 0 24 24", "aria-hidden": "true" });
    if (symbol === "Moon") {
      svg.appendChild(
        svgEl("path", {
          d: moonPath(12, 12, SYMBOL_R, MOON_WAIST),
          transform: `rotate(${MOON_ANGLE} 12 12)`,
        })
      );
      return svg;
    }
    svg.appendChild(svgEl("circle", { cx: 12, cy: 12, r: SYMBOL_R }));
    return svg;
  }

  // Every Tango board is 6×6, so the empty grid can be drawn at the real size and
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
   * Draw the detect snapshot — the grid with the SOLUTION's symbols on it (see
   * snapshot in injected.js). Replaces the "Board detected · N×N" line: the grid
   * says the same thing and shows the answer besides.
   */
  /** The = and × markers, each centred on the line between its two cells. */
  function edgeMarks(edges, N) {
    const frag = document.createDocumentFragment();
    for (const e of edges || []) {
      const [r1, c1] = [Math.floor(e.a / N), e.a % N];
      const [r2, c2] = [Math.floor(e.b / N), e.b % N];
      const mark = document.createElement("span");
      mark.className = "board__edge";
      mark.textContent = e.eq ? "=" : "×";
      mark.style.left = `${((c1 + c2 + 1) / 2 / N) * 100}%`;
      mark.style.top = `${((r1 + r2 + 1) / 2 / N) * 100}%`;
      frag.appendChild(mark);
    }
    return frag;
  }

  function renderBoard(cells, N, edges) {
    if (!Array.isArray(cells) || !cells.length) return;

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
      if (c.locked) cell.classList.add("board__cell--locked");
      if (c.symbol === "Sun" || c.symbol === "Moon") {
        cell.classList.add(`board__cell--${c.symbol.toLowerCase()}`);
        cell.appendChild(symbolSvg(c.symbol));
      }
      frag.appendChild(cell);
    }
    frag.appendChild(edgeMarks(edges, N));
    boardEl.replaceChildren(frag);

    // A real board is worth describing, unlike the placeholder it replaces.
    boardEl.removeAttribute("aria-hidden");
    boardEl.setAttribute("aria-label", t("solutionPreview", N, N));
  }

  return {
    renderPlaceholder,
    renderBoard: (b) => renderBoard(b.cells, b.N, b.edges),
  };
});
