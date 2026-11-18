/*
 * Board preview for Sumbreak: the tiles as they are now, in the game's own colour
 * for each value, with the next merge outlined. Its styles are the `[data-game="sumbreak"]` block in
 * popup.css.
 *
 * `b` is runSumbreak's detect result: { rows, cols, cells: [{ idx, value }],
 * moves: [[from, to], …] }, where value 0 is an empty cell.
 */
registerPreview("sumbreak", (boardEl) => {
  const DEFAULT_ROWS = 3;
  const DEFAULT_COLS = 3;

  // Fill and ink per value, as the game draws them (read from the board samples in
  // tests/fixtures; 8 isn't in them, so it's the step between its neighbours).
  // Past 128, a hue keeps stepping round so equal tiles still match.
  const PALETTE = {
    1: ["#98A4FF", "#2C3689"],
    2: ["#67C3FF", "#004D7F"],
    4: ["#36DBFF", "#005D71"],
    8: ["#4CE8C0", "#00604A"],
    16: ["#A3F19A", "#127207"],
    32: ["#DAE471", "#5F6600"],
    64: ["#F5D45F", "#6E5C00"],
    128: ["#FFB561", "#7C4200"],
  };
  const colours = (value) => {
    if (PALETTE[value]) return PALETTE[value];
    const hue = (Math.round(Math.log2(Math.max(1, value))) * 40) % 360;
    return [`hsl(${hue} 90% 75%)`, `hsl(${hue} 80% 22%)`];
  };

  function grid(rows, cols) {
    boardEl.style.setProperty("--rows", rows);
    boardEl.style.setProperty("--cols", cols);
    const frag = document.createDocumentFragment();
    const cellEls = [];
    for (let i = 0; i < rows * cols; i++) {
      const cell = document.createElement("div");
      cell.className = "board__cell";
      cellEls.push(cell);
      frag.appendChild(cell);
    }
    return { frag, cellEls };
  }

  function renderPlaceholder() {
    const { frag } = grid(DEFAULT_ROWS, DEFAULT_COLS);
    boardEl.replaceChildren(frag);
    boardEl.setAttribute("aria-hidden", "true");
  }

  function renderBoard(b) {
    if (!b || !Array.isArray(b.cells) || !b.cells.length) return;
    const rows = b.rows;
    const cols = b.cols;
    const { frag, cellEls } = grid(rows, cols);
    const next = Array.isArray(b.moves) && b.moves.length ? b.moves[0] : null;
    for (const c of b.cells) {
      const el = cellEls[c.idx];
      if (!el || !c.value) continue;
      const tile = document.createElement("span");
      tile.className = "board__tile";
      const [fill, ink] = colours(c.value);
      tile.style.setProperty("--fill", fill);
      tile.style.setProperty("--ink", ink);
      tile.textContent = String(c.value);
      if (next && (c.idx === next[0] || c.idx === next[1])) tile.classList.add("board__tile--next");
      el.appendChild(tile);
    }
    boardEl.replaceChildren(frag);
    boardEl.removeAttribute("aria-hidden");
    boardEl.setAttribute("aria-label", t("solutionPreview", rows, cols));
  }

  return { renderPlaceholder, renderBoard };
});
