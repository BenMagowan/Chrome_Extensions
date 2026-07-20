/*
 * injected.js — the whole Zip engine as ONE self-contained function.
 *
 * Not a content script. The popup injects it on demand into every frame of the
 * LinkedIn games tab via
 *   chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runZip, args:[mode] })
 * (See Queens_Solver for why on-demand MAIN-world injection is used instead of a
 *  pre-injected content script: no reload-after-install gotcha, immune to when the
 *  game iframe loaded, and exempt from the page CSP that blocks in-page eval.)
 *
 * MUST stay fully self-contained — executeScript serializes it with
 * Function.prototype.toString, so every helper is nested and nothing outside is
 * referenced except the `mode` argument.
 *
 * ZIP RULES (single Hamiltonian path):
 *   - Draw ONE continuous path that fills every cell exactly once.
 *   - The path must pass through the numbered dots in ascending order (1 → 2 → … → K),
 *     so it starts on 1 and ends on the highest number K.
 *   - Walls between adjacent cells block movement across them.
 *
 * FILL MECHANISM (verified live on the guest board): the game auto-fills the "1" cell
 * as the path head. Each Arrow key (dispatched at document level) extends the path one
 * cell in that direction if the move is legal (adjacent, unvisited, no wall). So the
 * solver computes the full path, resets any existing drawing via Undo, then replays the
 * path as a sequence of Arrow keydowns. (Plain clicks do NOT draw the path — verified.)
 *
 * @param {'detect'|'solve'} mode
 * @returns {{solvable:boolean,N:number,solved:boolean,cells:object[]|null,path:number[]|null}}
 *          for 'detect',
 *          {{ok:boolean, placed?:number, alreadySolved?:boolean, error?:string}} for 'solve'
 */
async function runZip(mode) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // --- a cell's number (0 = blank) ---
  // Guest: `.trail-cell-content` text. Signed-in: aria-label "Number N" on the cell
  // plus a `[data-cell-content]` div. Read both so one code path covers both DOMs.
  function cellNumber(el) {
    const lab = el.getAttribute("aria-label") || "";
    const m = /Number\s+(\d+)/i.exec(lab);
    if (m) return parseInt(m[1], 10);
    const ce = el.querySelector(".trail-cell-content, [data-cell-content]");
    const t = ((ce ? ce.textContent : el.textContent) || "").trim();
    return /^\d+$/.test(t) ? parseInt(t, 10) : 0;
  }

  // --- the wall directions of a cell ---
  // Guest marks walls with semantic classes `trail-cell-wall--{right,left,down,up}`
  // (and corner joins `--down-left` / `--down-right`, which are decorative and must be
  // ignored — hence the end-anchored single-direction match). A wall is drawn on the
  // owning cell(s); horizontal walls appear on both neighbours, vertical ones on the
  // top cell, so `connected()` checks both sides.
  function wallDirs(el) {
    const dirs = new Set();
    const scan = (cls) => {
      if (typeof cls !== "string") return;
      for (const tok of cls.split(/\s+/)) {
        const m = /wall-{1,2}(right|left|down|up|top|bottom)$/i.exec(tok);
        if (m) {
          let d = m[1].toLowerCase();
          if (d === "top") d = "up";
          if (d === "bottom") d = "down";
          dirs.add(d);
        }
      }
    };
    scan(el.className);
    el.querySelectorAll("*").forEach((ch) => scan(ch.className));
    return dirs;
  }

  // --- is a cell currently drawn as part of the path? ---
  // Guest: class `trail-cell--filled`. Signed-in: a `[data-testid="filled-cell"]` child.
  function isFilled(el) {
    // Guest: class `trail-cell--filled`. Signed-in: a `[data-testid="filled-cell"]`
    // child. `--filled` catches the guest class (and any BEM `*--filled` variant).
    return (
      !!el.querySelector('[data-testid="filled-cell"]') ||
      /--filled/.test(el.className || "")
    );
  }

  // --- parse the board into {N, cells, number[], walls[], start, maxNum, endIdx} ---
  // Grid-agnostic: keys off [data-cell-idx], present in both guest (div.trail-cell) and
  // signed-in (hashed classes) DOMs.
  function parseBoard() {
    // Zip signature so a Queens/Tango/Sudoku board never mis-parses as Zip.
    const looksZip =
      !!document.querySelector(
        '[data-trail-grid], [data-testid="zip-game-container"], .trail-grid, .trail-cell'
      );
    if (!looksZip) return null;

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

    const number = new Array(N * N).fill(0);
    const walls = new Array(N * N);
    const elByIdx = new Array(N * N);
    for (const el of els) {
      const idx = parseInt(el.getAttribute("data-cell-idx"), 10);
      if (idx < 0 || idx >= N * N) return null;
      number[idx] = cellNumber(el);
      walls[idx] = wallDirs(el);
      elByIdx[idx] = el;
    }
    if (elByIdx.some((e) => !e)) return null; // gap in indices -> still loading

    // Validate the number clues: 1 must exist and 1..maxNum each appear exactly once.
    let start = -1,
      maxNum = 0,
      endIdx = -1;
    const seen = {};
    for (let i = 0; i < N * N; i++) {
      const v = number[i];
      if (v > 0) {
        seen[v] = (seen[v] || 0) + 1;
        if (v === 1) start = i;
        if (v > maxNum) {
          maxNum = v;
          endIdx = i;
        }
      }
    }
    if (start < 0 || maxNum < 2) return null;
    for (let v = 1; v <= maxNum; v++) if (seen[v] !== 1) return null;

    return { N, number, walls, elByIdx, start, maxNum, endIdx };
  }

  // --- can the path step directly between adjacent cells a and b? ---
  function connected(board, a, b) {
    const { N, walls } = board;
    if (b === a + 1) return !(walls[a].has("right") || walls[b].has("left"));
    if (b === a - 1) return !(walls[a].has("left") || walls[b].has("right"));
    if (b === a + N) return !(walls[a].has("down") || walls[b].has("up"));
    if (b === a - N) return !(walls[a].has("up") || walls[b].has("down"));
    return false; // not orthogonally adjacent
  }
  function neighbours(board, idx) {
    const { N } = board;
    const r = Math.floor(idx / N),
      c = idx % N,
      out = [];
    if (r > 0) out.push(idx - N);
    if (r < N - 1) out.push(idx + N);
    if (c > 0) out.push(idx - 1);
    if (c < N - 1) out.push(idx + 1);
    return out.filter((nb) => connected(board, idx, nb));
  }

  // --- Hamiltonian-path solver: fill every cell, hit the numbers in order, end on K ---
  function solve(board) {
    const { N, number, start, maxNum } = board;
    const total = N * N;
    const visited = new Array(total).fill(false);
    const path = [];

    // Prune: from the current head, every unvisited cell must still be reachable
    // through unvisited cells (otherwise a cell would be stranded).
    function allRemainingReachable(cur, count) {
      const remaining = total - count;
      if (remaining === 0) return true;
      const seen = new Set();
      const stack = [];
      for (const nb of neighbours(board, cur))
        if (!visited[nb]) {
          stack.push(nb);
          seen.add(nb);
        }
      while (stack.length) {
        const x = stack.pop();
        for (const nb of neighbours(board, x))
          if (!visited[nb] && !seen.has(nb)) {
            seen.add(nb);
            stack.push(nb);
          }
      }
      return seen.size === remaining;
    }

    function dfs(cur, count, nextNum) {
      if (count === total) return number[cur] === maxNum;
      if (!allRemainingReachable(cur, count)) return false;
      for (const nb of neighbours(board, cur)) {
        if (visited[nb]) continue;
        let nn = nextNum;
        if (number[nb] !== 0) {
          if (number[nb] !== nextNum) continue; // numbers must be reached in order
          nn = nextNum + 1;
        }
        visited[nb] = true;
        path.push(nb);
        if (dfs(nb, count + 1, nn)) return true;
        visited[nb] = false;
        path.pop();
      }
      return false;
    }

    visited[start] = true;
    path.push(start);
    if (!dfs(start, 1, 2)) return null;
    return path.slice();
  }

  // --- the click sequence the game accepts (same framework as Queens/Tango) ---
  // Used only to press the Undo control; the path itself is drawn with Arrow keys.
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

  // --- press an Arrow key at document level (verified target for path drawing) ---
  const ARROW = {
    right: { key: "ArrowRight", code: "ArrowRight", kc: 39 },
    left: { key: "ArrowLeft", code: "ArrowLeft", kc: 37 },
    down: { key: "ArrowDown", code: "ArrowDown", kc: 40 },
    up: { key: "ArrowUp", code: "ArrowUp", kc: 38 },
  };
  function pressArrow(dir) {
    const a = ARROW[dir];
    for (const type of ["keydown", "keyup"]) {
      const ev = new KeyboardEvent(type, {
        key: a.key, code: a.code, keyCode: a.kc, which: a.kc,
        bubbles: true, cancelable: true, composed: true, view: window,
      });
      document.dispatchEvent(ev);
    }
  }
  function dirBetween(board, a, b) {
    const { N } = board;
    if (b === a + 1) return "right";
    if (b === a - 1) return "left";
    if (b === a + N) return "down";
    if (b === a - N) return "up";
    return null;
  }
  const filledCount = (board) => board.elByIdx.filter(isFilled).length;

  // --- is the board ALREADY finished? ---
  // Every cell drawn is the win condition. We don't re-derive the path's order from
  // the DOM because the filled cells don't expose one — but we don't need to: the
  // game only accepts legal moves (adjacent, unvisited, no wall, numbers in
  // ascending order), so a board that is entirely filled was filled legally.
  function isSolved(board) {
    return filledCount(board) === board.N * board.N;
  }

  // A serialisable picture of the board for the popup to draw. Deliberately plain
  // data — executeScript has to structured-clone this back, so no elements or Sets.
  // The walls come along because they're the puzzle's constraints: a path drawn
  // without them looks arbitrary, since you can't see what it had to route around.
  function snapshot(board) {
    const { N, number, walls } = board;
    return number.map((n, idx) => ({
      row: Math.floor(idx / N),
      col: idx % N,
      number: n,
      walls: {
        up: walls[idx].has("up"),
        down: walls[idx].has("down"),
        left: walls[idx].has("left"),
        right: walls[idx].has("right"),
      },
    }));
  }

  // --- dispatch ---
  const board = parseBoard();

  if (mode === "detect") {
    if (!board) return { solvable: false, N: 0, solved: false, cells: null, path: null };
    // A finished board is its own answer — the player's path is already on screen,
    // so don't overlay a solved route that may differ from the one they drew.
    const done = isSolved(board);
    return {
      solvable: true,
      N: board.N,
      solved: done,
      cells: snapshot(board),
      path: done ? null : solve(board),
    };
  }

  // mode === 'solve'
  if (!board) return { ok: false, error: "Board not found or still loading." };
  // Already finished (e.g. completed between the popup's last poll and the click) —
  // report it instead of undoing a won board just to redraw the same route.
  if (isSolved(board)) {
    return { ok: true, placed: board.N * board.N, alreadySolved: true, N: board.N };
  }
  const path = solve(board);
  if (!path) return { ok: false, error: "No path exists for this board." };

  // Reset any existing drawing back to just the start cell via the Undo control, so
  // the Arrow replay starts from a known head. (The game auto-fills the "1" cell.)
  const undoBtn = Array.from(document.querySelectorAll("button")).find(
    (b) => /^\s*Undo\s*$/i.test(b.textContent || "")
  );
  if (undoBtn) {
    for (let i = 0; i < board.N * board.N + 2; i++) {
      if (filledCount(board) <= 1) break;
      const before = filledCount(board);
      fireOneClick(undoBtn);
      await sleep(60);
      if (filledCount(board) >= before) break; // no progress -> stop
    }
  }
  // Ensure the start cell is the current head.
  if (!isFilled(board.elByIdx[board.start])) {
    fireOneClick(board.elByIdx[board.start]);
    await sleep(120);
  }

  // Replay the path as Arrow presses, one cell per step, re-checking progress.
  let placed = 1; // the start is already drawn
  for (let i = 1; i < path.length; i++) {
    const dir = dirBetween(board, path[i - 1], path[i]);
    if (!dir) return { ok: false, error: "Internal: non-adjacent path step." };
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      const before = filledCount(board);
      pressArrow(dir);
      await sleep(90);
      ok = filledCount(board) > before || isFilled(board.elByIdx[path[i]]);
    }
    if (ok) placed++;
  }
  return { ok: true, placed, N: board.N };
}
