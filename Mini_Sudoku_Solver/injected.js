/*
 * injected.js — the whole Mini Sudoku engine as ONE self-contained function.
 *
 * Not a content script. The popup injects it on demand into every frame of the
 * LinkedIn games tab via
 *   chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runSudoku, args:[mode] })
 * (See Queens_Solver for why on-demand MAIN-world injection is used instead of a
 *  pre-injected content script: no reload-after-install gotcha, immune to when the
 *  game iframe loaded, and exempt from the page CSP that blocks in-page eval.)
 *
 * MUST stay fully self-contained — executeScript serializes it with
 * Function.prototype.toString, so every helper is nested and nothing outside is
 * referenced except the `mode` argument.
 *
 * MINI SUDOKU RULES (constraint satisfaction):
 *   - 6×6 grid, digits 1–6.
 *   - Each digit appears exactly once in every row, column, and region.
 *   - Regions are the 6 wall-bounded areas (derived from wall classes, so the code
 *     also handles irregular/jigsaw layouts, not just 2×3 boxes).
 *   - Some cells are pre-filled (locked) clues. The solution is unique.
 *
 * FILL MECHANISM (differs from Queens/Tango's click-cycle): select a cell (it gains
 * `sudoku-cell-active`), then click the number-pad button `[data-number="V"]` to
 * write V into it. Prefilled cells are not editable and are skipped.
 *
 * @param {'detect'|'solve'} mode
 * @returns {{solvable:boolean,N:number,solved:boolean,cells:object[]|null}} for 'detect',
 *          {{ok:boolean, placed?:number, alreadySolved?:boolean, error?:string}} for 'solve'
 */
async function runSudoku(mode) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- read a cell's current digit (0 = empty) from `.sudoku-cell-content` ---
  function valueOf(cellEl) {
    const c = cellEl.querySelector(".sudoku-cell-content");
    const t = (c ? c.textContent : "").trim();
    const n = parseInt(t, 10);
    return Number.isInteger(n) ? n : 0;
  }

  // --- which walls a cell has (region boundaries) ---
  function wallsOf(cellEl) {
    const cls = cellEl.className || "";
    const w = new Set();
    if (/sudoku-cell-wall-top/.test(cls)) w.add("top");
    if (/sudoku-cell-wall-right/.test(cls)) w.add("right");
    if (/sudoku-cell-wall-bottom/.test(cls)) w.add("bottom");
    if (/sudoku-cell-wall-left/.test(cls)) w.add("left");
    return w;
  }

  // --- parse the board into {N, cells:[{idx,row,col,value,prefilled,walls,el}], region[]} ---
  // Grid-agnostic: keys off [data-cell-idx], present in both guest and signed-in DOMs.
  function parseBoard() {
    const all = Array.from(document.querySelectorAll("[data-cell-idx]"));
    if (all.length < 16) return null; // not rendered yet
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
    const N = Math.round(Math.sqrt(els.length));
    if (N * N !== els.length) return null; // not square -> still loading

    // Sudoku signature: a `.sudoku-cell` / `.sudoku-grid` / `[data-sudoku-grid]` must
    // be present, so a Queens/Tango board (which also uses [data-cell-idx]) never
    // mis-parses as Sudoku.
    const looksSudoku =
      els.some((el) => /sudoku-cell/.test(el.className || "")) ||
      !!document.querySelector(".sudoku-grid, [data-sudoku-grid]");
    if (!looksSudoku) return null;

    const cells = new Array(N * N);
    for (const el of els) {
      const idx = parseInt(el.getAttribute("data-cell-idx"), 10);
      cells[idx] = {
        idx,
        row: Math.floor(idx / N),
        col: idx % N,
        value: valueOf(el),
        prefilled: /sudoku-cell-prefilled/.test(el.className || ""),
        walls: wallsOf(el),
        el,
      };
    }
    if (cells.some((c) => !c)) return null; // gap in indices -> still loading

    // Derive regions by flood-fill over non-walled adjacencies. Two orthogonally
    // adjacent cells are in the same region iff no wall separates them.
    const region = new Array(N * N).fill(-1);
    let regionCount = 0;
    for (let start = 0; start < N * N; start++) {
      if (region[start] !== -1) continue;
      const id = regionCount++;
      const stack = [start];
      region[start] = id;
      while (stack.length) {
        const cur = stack.pop();
        const c = cells[cur];
        const neighbours = [];
        if (!c.walls.has("top") && c.row > 0) neighbours.push(cur - N);
        if (!c.walls.has("bottom") && c.row < N - 1) neighbours.push(cur + N);
        if (!c.walls.has("left") && c.col > 0) neighbours.push(cur - 1);
        if (!c.walls.has("right") && c.col < N - 1) neighbours.push(cur + 1);
        for (const nb of neighbours) {
          if (region[nb] === -1) {
            region[nb] = id;
            stack.push(nb);
          }
        }
      }
    }

    return { N, cells, region, regionCount };
  }

  // --- backtracking solver: Latin square (row/col 1..N) + each region 1..N once ---
  function solve(board) {
    const { N, cells, region } = board;
    const value = new Array(N * N).fill(0);
    const rowUsed = Array.from({ length: N }, () => new Array(N + 1).fill(false));
    const colUsed = Array.from({ length: N }, () => new Array(N + 1).fill(false));
    const regUsed = Array.from({ length: N }, () => new Array(N + 1).fill(false));

    // Seed ONLY the puzzle's own prefilled clues.
    //
    // Deliberately *not* every digit currently on the board: anything the player
    // typed is a guess, and treating a wrong guess as an immovable clue poisons the
    // search. A single misplaced digit makes the real puzzle look unsolvable
    // ("No solution exists for this board"), and a wrong guess that happens to stay
    // consistent gets baked into the answer — the cell is then skipped at fill time
    // (its "target" is the mistake itself) and the error survives on the finished
    // board. Solving from the clues alone means every player-entered cell is treated
    // as empty and gets overwritten below, mistakes included.
    for (const c of cells) {
      if (!c.prefilled) continue;
      if (c.value >= 1 && c.value <= N) {
        value[c.idx] = c.value;
        rowUsed[c.row][c.value] = true;
        colUsed[c.col][c.value] = true;
        regUsed[region[c.idx]][c.value] = true;
      }
    }

    // order of empty cells to fill
    const empties = [];
    for (const c of cells) if (value[c.idx] === 0) empties.push(c);

    function bt(i) {
      if (i === empties.length) return true;
      const c = empties[i];
      const reg = region[c.idx];
      for (let v = 1; v <= N; v++) {
        if (rowUsed[c.row][v] || colUsed[c.col][v] || regUsed[reg][v]) continue;
        value[c.idx] = v;
        rowUsed[c.row][v] = colUsed[c.col][v] = regUsed[reg][v] = true;
        if (bt(i + 1)) return true;
        value[c.idx] = 0;
        rowUsed[c.row][v] = colUsed[c.col][v] = regUsed[reg][v] = false;
      }
      return false;
    }

    if (!bt(0)) return null;
    return value; // value[idx] = final digit
  }

  // --- is the board ALREADY finished? ---
  // Tests the game's win condition against the digits currently on the board,
  // rather than comparing to solve()'s output: that keeps the answer honest even
  // if a board somehow admits more than one solution, and it still works when the
  // solver itself can't crack it.
  function isSolved(board) {
    const { N, cells, region } = board;
    const rows = Array.from({ length: N }, () => new Set());
    const cols = Array.from({ length: N }, () => new Set());
    const regs = Array.from({ length: N }, () => new Set());
    for (const c of cells) {
      if (c.value < 1 || c.value > N) return false; // blank cell — never a win
      rows[c.row].add(c.value);
      cols[c.col].add(c.value);
      regs[region[c.idx]].add(c.value);
    }
    // Every digit exactly once per row, column and region. N cells and N distinct
    // values in each line is enough — no digit can repeat without one going missing.
    const full = (s) => s.size === N;
    return rows.every(full) && cols.every(full) && regs.every(full);
  }

  // A serialisable picture of the board for the popup to draw. Deliberately plain
  // data — executeScript has to structured-clone this back, so no elements or Sets.
  //
  // The digits shown are the SOLUTION's, not the player's current attempt: the
  // preview exists to show what the solver will do, so a part-filled grid (or one
  // with a wrong guess in it) would be the wrong thing to draw. `solution` null
  // means we couldn't or shouldn't solve it — fall back to what's on screen.
  // The walls come along so the popup can draw the region borders; without them a
  // jigsaw layout would render as a featureless 6×6 grid.
  function snapshot(board, solution) {
    return board.cells.map((c) => ({
      row: c.row,
      col: c.col,
      value: solution ? solution[c.idx] : c.value,
      given: c.prefilled,
      walls: {
        top: c.walls.has("top"),
        right: c.walls.has("right"),
        bottom: c.walls.has("bottom"),
        left: c.walls.has("left"),
      },
    }));
  }

  // --- the click sequence the game accepts (same framework as Queens/Tango) ---
  function fireOneClick(el) {
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: cx, clientY: cy, screenX: cx, screenY: cy,
      button: 0, isPrimary: true, pointerId: 1, pointerType: "mouse",
    };
    el.dispatchEvent(new PointerEvent("pointerdown", { ...base, buttons: 1 }));
    el.dispatchEvent(new MouseEvent("mousedown", { ...base, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
    el.dispatchEvent(new MouseEvent("click", { ...base, buttons: 0 }));
  }

  // --- dispatch ---
  const board = parseBoard();
  const valid =
    !!board &&
    board.N >= 4 &&
    board.cells.length === board.N * board.N &&
    board.regionCount === board.N;

  // Every Mini Sudoku ships with clues. Without them we can't tell a given from a
  // guess, which both modes below depend on — see the bail-out in 'solve'.
  const hasClues = !!board && board.cells.some((c) => c.prefilled);

  if (mode === "detect") {
    if (!valid) return { solvable: false, N: board ? board.N : 0, solved: false, cells: null };
    // A finished board is its own answer, and a board whose clues we can't identify
    // would only yield a "solution" built on the player's guesses. Either way, show
    // what's actually on screen rather than something invented.
    const done = isSolved(board);
    const solution = done || !hasClues ? null : solve(board);
    return { solvable: true, N: board.N, solved: done, cells: snapshot(board, solution) };
  }

  // mode === 'solve'
  if (!valid) return { ok: false, error: "Board not found or still loading." };
  // Already finished (e.g. completed between the popup's last poll and the click) —
  // report it instead of clicking at a won board.
  if (isSolved(board)) return { ok: true, placed: 0, alreadySolved: true, N: board.N };
  // Every Mini Sudoku ships with clues, so finding none means `sudoku-cell-prefilled`
  // has stopped identifying them. Bail out loudly: solving on from here would treat
  // the real clues as editable, produce a grid that contradicts them, and then fail
  // to write it (clue cells aren't editable), leaving the board mangled.
  if (!hasClues) {
    return { ok: false, error: "Couldn't tell clues from guesses on this board." };
  }
  const solution = solve(board);
  if (!solution) return { ok: false, error: "No solution exists for this board." };

  // Cache the number pad buttons `[data-number="1..N"]`.
  const numberBtn = {};
  for (let v = 1; v <= board.N; v++) {
    numberBtn[v] = document.querySelector(`[data-number="${v}"]`);
  }
  if (Object.values(numberBtn).some((b) => !b)) {
    return { ok: false, error: "Number pad not found." };
  }

  // Fill each non-prefilled cell whose current value ≠ target: select the cell,
  // then click its target number button. Re-read and retry once if it didn't take.
  // Skip cells already correct → idempotent from any partial state.
  let placed = 0;
  for (const c of board.cells) {
    if (c.prefilled) continue;
    const target = solution[c.idx];
    if (valueOf(c.el) === target) continue;
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      fireOneClick(c.el); // select the cell
      await sleep(140);
      fireOneClick(numberBtn[target]); // write the digit
      await sleep(140);
      ok = valueOf(c.el) === target;
    }
    if (ok) placed++;
  }
  return { ok: true, placed, N: board.N };
}
