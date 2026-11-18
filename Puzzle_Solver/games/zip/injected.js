/*
 * injected.js — the whole Zip engine as ONE self-contained function.
 *
 * The popup injects it on demand into every frame of the LinkedIn games tab via
 *   chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runZip, args:[mode, opts] })
 * (See Queens_Solver for why on-demand MAIN-world injection is used for the popup
 *  instead of a pre-injected content script: no reload-after-install gotcha, immune
 *  to when the game iframe loaded, and exempt from the page CSP that blocks in-page
 *  eval.) The same file is ALSO loaded as a content script, ahead of content.js,
 *  which drives auto-solve on page load — so the engine never forks.
 *
 * MUST stay fully self-contained — executeScript serializes it with
 * Function.prototype.toString, so every helper is nested and nothing outside is
 * referenced except the `mode` / `opts` arguments.
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
 * @param {{targetMs?:number, preview?:boolean}} [opts] `targetMs` paces 'solve': aim
 *        the whole solve at this total time (see the step-delay maths in the solve
 *        branch); omit for the default cadence. `preview:false` makes 'detect' skip
 *        the wall scan and path search that only the popup's preview needs (`cells`
 *        and `path` come back null).
 * @returns {{solvable:boolean,N:number,solved:boolean,cells:object[]|null,path:number[]|null}}
 *          for 'detect',
 *          {{ok:boolean, placed?:number, alreadySolved?:boolean, error?:string,
 *            busy?:boolean, board?:boolean}} for 'solve' — `busy` when another solve
 *          already holds this board, `board` from the frame that has the board
 */
async function runZip(mode, opts) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // When this call started: the solve branch paces against the time left of it.
  const startedAt = performance.now();

  // Optional pacing. When a target total time is supplied the solve branch spreads
  // its Arrow presses to land near it; null keeps the default, verified-safe cadence.
  const targetMs =
    opts && typeof opts.targetMs === "number" && opts.targetMs > 0
      ? opts.targetMs
      : null;

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
  // Two builds render walls differently, so detection is layered:
  //
  //  1. Guest build marks walls with semantic classes
  //     `trail-cell-wall--{right,left,down,up}` (and corner joins `--down-left` /
  //     `--down-right`, which are decorative and must be ignored — hence the
  //     end-anchored single-direction match).
  //
  //  2. Signed-in build ships CSS-module *hashed* class names (e.g. `_9e5e2e24`),
  //     so the semantic regex matches nothing. But in BOTH builds a wall is drawn
  //     the same way visually: a cell-spanning overlay whose `::after` (or the
  //     element itself) carries a thick border on exactly the wall's side
  //     (border-bottom → down, border-right → right, etc.). Reading that rendered
  //     border is class-name-agnostic, so it survives future re-hashing.
  //
  // A wall is drawn on the owning cell(s); horizontal walls appear on both
  // neighbours, vertical ones on the top cell, so `connected()` checks both sides.
  function wallDirs(el) {
    // Strategy 1: semantic class names (guest build).
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
    if (dirs.size) return dirs;

    // Strategy 2: rendered wall bar (hashed build, and any future renaming).
    const win = el.ownerDocument.defaultView || window;
    const cr = el.getBoundingClientRect();
    if (!cr.width || !cr.height) return dirs;
    // A real wall is much thicker than the hairline grid lines (~1px). 10% of the
    // cell clears those with margin while staying below any wall thickness.
    const THICK = Math.max(4, Math.min(cr.width, cr.height) * 0.1);
    // Record the thick side of one computed style — but only when EXACTLY one side
    // is thick. A wall bar borders a single edge; an all-round outline (focus ring,
    // selected-cell highlight) borders 3–4 and must not be read as walls.
    const consider = (s) => {
      if (!s) return;
      const bw = (v) => parseFloat(v) || 0;
      const hit = [];
      if (bw(s.borderTopWidth) >= THICK) hit.push("up");
      if (bw(s.borderBottomWidth) >= THICK) hit.push("down");
      if (bw(s.borderLeftWidth) >= THICK) hit.push("left");
      if (bw(s.borderRightWidth) >= THICK) hit.push("right");
      if (hit.length === 1) dirs.add(hit[0]);
    };
    for (const e of el.querySelectorAll("*")) {
      // Only overlays that (roughly) span the cell can be wall bars; this skips the
      // smaller centred number/path-segment nodes that could carry their own borders.
      const rr = e.getBoundingClientRect();
      if (rr.width < cr.width * 0.6 || rr.height < cr.height * 0.6) continue;
      consider(win.getComputedStyle(e));
      consider(win.getComputedStyle(e, "::before"));
      consider(win.getComputedStyle(e, "::after"));
    }
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
  // signed-in (hashed classes) DOMs. `withWalls` false skips the wall scan — by far
  // the costliest part, a computed-style read per descendant per cell — for callers
  // that only need to know whether a board is there and how much of it is drawn
  // (`walls` is then null).
  function parseBoard(withWalls = true) {
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
    const walls = withWalls ? new Array(N * N) : null;
    const elByIdx = new Array(N * N);
    for (const el of els) {
      const idx = parseInt(el.getAttribute("data-cell-idx"), 10);
      if (idx < 0 || idx >= N * N) return null;
      number[idx] = cellNumber(el);
      if (walls) walls[idx] = wallDirs(el);
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
  // Returns the path (cell indices, start first), null when there is none, or
  // GAVE_UP when the search ran out of time.
  //
  // The search runs synchronously on the page's main thread, so it is budgeted. A
  // misread board — a wall seen where there is none or missed, a misread number —
  // can leave nothing to find, and exhausting that tree could freeze the tab for
  // minutes. Real puzzles are made to be solved by hand and finish in milliseconds,
  // so running out of budget means the board was misread, and the caller says so
  // instead of hanging.
  const SEARCH_BUDGET_MS = 1500;
  const GAVE_UP = "gave-up";
  function solve(board) {
    const { N, number, start, maxNum, endIdx } = board;
    const total = N * N;

    // Parity: the grid is a chessboard and every step changes colour, so a path
    // through all `total` cells only fits between ends of the right colours —
    // different ones for an even count, both the majority colour (that of cell 0)
    // for an odd one. Walls only remove steps, so this holds on every board.
    const colour = (i) => (Math.floor(i / N) + (i % N)) % 2;
    if (
      total % 2 === 0
        ? colour(start) === colour(endIdx)
        : colour(start) !== 0 || colour(endIdx) !== 0
    ) {
      return null;
    }

    const adj = Array.from({ length: total }, (_, i) => neighbours(board, i));
    const visited = new Array(total).fill(false);
    const path = [];
    const deadline = performance.now() + SEARCH_BUDGET_MS;
    let nodes = 0;
    let gaveUp = false;

    // Prune: from the current head, every unvisited cell must still be reachable
    // through unvisited cells (otherwise a cell would be stranded). And none but the
    // end may be a dead end: a cell has to be entered and then left, so one with
    // fewer than two ways in (unvisited neighbours, plus the head if it's next to
    // it) can only come last — which only the end cell may.
    const seen = new Array(total).fill(0);
    let stamp = 0;
    function feasible(cur, count) {
      const remaining = total - count;
      if (remaining === 0) return true;
      stamp++;
      const stack = [];
      for (const nb of adj[cur]) {
        if (!visited[nb]) {
          seen[nb] = stamp;
          stack.push(nb);
        }
      }
      let reached = stack.length;
      while (stack.length) {
        const x = stack.pop();
        let ways = 0;
        for (const nb of adj[x]) {
          if (nb === cur) {
            ways++;
            continue;
          }
          if (visited[nb]) continue;
          ways++;
          if (seen[nb] !== stamp) {
            seen[nb] = stamp;
            stack.push(nb);
            reached++;
          }
        }
        if (ways < 2 && x !== endIdx && remaining > 1) return false;
      }
      return reached === remaining;
    }

    // Unvisited neighbours of a cell: the ways on from it.
    const exits = (x) => {
      let n = 0;
      for (const y of adj[x]) if (!visited[y]) n++;
      return n;
    };

    function dfs(cur, count, nextNum) {
      if (count === total) return number[cur] === maxNum;
      if ((++nodes & 1023) === 0 && performance.now() > deadline) gaveUp = true;
      if (gaveUp || !feasible(cur, count)) return false;
      const moves = [];
      for (const nb of adj[cur]) {
        if (visited[nb]) continue;
        // The highest number ends the path, so it can only be the last cell.
        if (nb === endIdx && count + 1 < total) continue;
        // Numbers must be reached in order.
        if (number[nb] !== 0 && number[nb] !== nextNum) continue;
        moves.push(nb);
      }
      // Try the most hemmed-in cell first (Warnsdorff's rule): it's the one most
      // likely to be stranded if left for later, so this finds the path far sooner.
      if (moves.length > 1) moves.sort((a, b) => exits(a) - exits(b));
      for (const nb of moves) {
        const nn = number[nb] !== 0 ? nextNum + 1 : nextNum;
        visited[nb] = true;
        path.push(nb);
        if (dfs(nb, count + 1, nn)) return true;
        visited[nb] = false;
        path.pop();
        if (gaveUp) return false;
      }
      return false;
    }

    visited[start] = true;
    path.push(start);
    if (dfs(start, 1, 2)) return path.slice();
    return gaveUp ? GAVE_UP : null;
  }

  // --- the solve, remembered per board ---
  // detect (on every popup poll that reaches it, and for the preview) and then solve
  // would otherwise each re-run the search on the same board. The answer is kept on
  // this world's global, keyed by everything the search reads, so any change to the
  // board misses it. One entry is enough: only the board on screen matters. Keeping
  // GAVE_UP too means a misread board costs one budget, not one per poll.
  const CACHE_KEY = Symbol.for("zipSolver.lastSolve");
  function solveCached(board) {
    const sig =
      board.N + "|" + board.number.join(",") + "|" +
      board.walls.map((w) => [...w].sort().join("")).join(",");
    const hit = globalThis[CACHE_KEY];
    if (hit && hit.sig === sig) return hit.result;
    const result = solve(board);
    globalThis[CACHE_KEY] = { sig, result };
    return result;
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

  // How long a step gets to show before it counts as dropped. Far above a normal
  // render, because the cost of guessing wrong is lopsided: an Arrow press isn't
  // idempotent, so repeating one that did land (just slowly) extends the path a
  // cell too far, while waiting a little longer on one that really was dropped only
  // costs time.
  const SETTLE_MS = 600;
  // How long the finished board gets to show the win before we call it unsolved.
  const CONFIRM_MS = 1500;

  /** Resolve true as soon as cond() holds, or false once `ms` has passed without. */
  async function waitFor(cond, ms) {
    const until = performance.now() + ms;
    while (!cond()) {
      if (performance.now() >= until) return false;
      await sleep(25);
    }
    return true;
  }

  // --- did the solve actually work? ---
  // Every step landing still isn't the puzzle being won, so judge the result by the
  // game's own win condition on the live board, with a moment for a slow render to
  // catch up. true = solved; false = still unsolved when the wait ran out; null = the
  // board is no longer on the page (the game swapping in a results screen, or the
  // player navigating away), so there's nothing left to check — neither is a missed
  // step, so the caller doesn't report it as one.
  async function confirmSolved(b) {
    const until = performance.now() + CONFIRM_MS;
    for (;;) {
      // isSolved reads the cells live, so the parsed board is good — unless the game
      // re-rendered the grid, when the old cells no longer say anything.
      if (!b.elByIdx.every((el) => el.isConnected)) b = parseBoard(false);
      if (!b) return null;
      if (isSolved(b)) return true;
      if (performance.now() >= until) return false;
      await sleep(25);
    }
  }

  // --- one solve per board, visible to the popup ---
  // Every solve path ends up here — content.js's auto-solve, and the popup's Solve
  // in the page's MAIN world — so this is where the board is claimed. The claim is a
  // marker on this frame's <html>: DOM attributes are shared across worlds, and the
  // check and the claim run with no await between them, so two solves racing for one
  // board can't both get in. The popup reads the same marker (readAutoSolve in
  // popup.js) to show a solve in progress — whoever started it — and then its result.
  async function exclusive(run) {
    const marker = document.documentElement.dataset;
    if (marker.autosolve === "solving") {
      return { ok: false, busy: true, board: true, error: "A solve is already running on this board." };
    }
    const claimedAt = Date.now();
    marker.autosolveStart = String(claimedAt);
    delete marker.autosolveResult;
    marker.autosolve = "solving";
    let r;
    try {
      r = await run();
    } catch (e) {
      r = { ok: false, error: "Solve failed: " + ((e && e.message) || e) };
    }
    // `board` tells the popup this frame held the board, so its error is the one to show.
    r = { ...r, board: true };
    // Result first, then state, so the popup never sees a finished state without one.
    marker.autosolveResult = JSON.stringify({ ...r, ms: Date.now() - claimedAt });
    marker.autosolve = r.ok ? (r.alreadySolved ? "done" : "solved") : "failed";
    return r;
  }

  // --- dispatch ---
  // content.js only asks whether there's a board to solve, so it skips the preview —
  // and with it the wall scan and the path search that building one costs.
  const preview = !(mode === "detect" && opts && opts.preview === false);
  const board = parseBoard(preview);

  if (mode === "detect") {
    if (!board) return { solvable: false, N: 0, solved: false, cells: null, path: null };
    // A finished board is its own answer — the player's path is already on screen,
    // so don't overlay a solved route that may differ from the one they drew.
    const done = isSolved(board);
    if (!preview) return { solvable: true, N: board.N, solved: done, cells: null, path: null };
    const path = done ? null : solveCached(board);
    return {
      solvable: true,
      N: board.N,
      solved: done,
      cells: snapshot(board),
      path: Array.isArray(path) ? path : null,
    };
  }

  // mode === 'solve'
  if (!board) return { ok: false, error: "Board not found or still loading." };
  return exclusive(async () => {
    // Already finished (e.g. completed between the popup's last poll and the click) —
    // report it instead of undoing a won board just to redraw the same route.
    if (isSolved(board)) {
      return { ok: true, placed: board.N * board.N, alreadySolved: true, N: board.N };
    }
    const path = solveCached(board);
    if (path === GAVE_UP) {
      return { ok: false, error: "Couldn't find a path in time. The board may have been misread." };
    }
    if (!path) return { ok: false, error: "No path exists for this board." };

    // Reset any existing drawing back to just the start cell via the Undo control, so
    // the Arrow replay starts from a known head. (The game auto-fills the "1" cell.)
    // Each Undo gets up to SETTLE_MS to show: a fixed 60 ms beat read a slow render
    // as "no progress" and abandoned the reset with most of the old path still drawn.
    const undoBtn = Array.from(document.querySelectorAll("button")).find(
      (b) => /^\s*Undo\s*$/i.test(b.textContent || "")
    );
    if (undoBtn) {
      for (let i = 0; i < board.N * board.N + 2; i++) {
        const before = filledCount(board);
        if (before <= 1) break;
        fireOneClick(undoBtn);
        if (!(await waitFor(() => filledCount(board) < before, SETTLE_MS))) break; // stuck
      }
    }
    // Ensure the start cell is the current head. Clicking it does both jobs: it
    // starts the path when nothing is drawn, and it rewinds a drawn path back to that
    // one cell. The rewind matters wherever the Undo button above wasn't found — it is
    // matched by its English text, and LinkedIn translates it ("Annuler" in French).
    const startEl = board.elByIdx[board.start];
    if (!isFilled(startEl) || filledCount(board) > 1) {
      fireOneClick(startEl);
      await waitFor(() => isFilled(startEl) && filledCount(board) <= 1, SETTLE_MS);
    }
    // Every Arrow extends from the head, so replaying over a path that didn't clear
    // would draw from the wrong cell. Say so instead.
    if (filledCount(board) > 1) {
      return { ok: false, error: "Couldn't clear the path already drawn. Undo it and try again." };
    }

    // Work out how fast to step. Each Arrow press extends the path one cell and is
    // followed by one sleep, so the replay takes (steps × delay). Unlike Queens/Tango,
    // getting here takes a variable while — an Undo reset of a half-drawn board can
    // be dozens of presses — so the replay is budgeted with whatever is LEFT of
    // (target + BUFFER) after the parse, solve and reset, not the whole of it.
    //
    // The buffer means the real time lands comfortably OVER the target rather than
    // under — e.g. a 5s target finishes ~5.5s. The floor stops a very short target
    // pressing faster than the game reliably registers.
    const DEFAULT_STEP_MS = 90;
    const MIN_STEP_MS = 50;
    const BUFFER_MS = 500;
    const steps = path.length - 1;
    const stepDelay = targetMs
      ? Math.max(
          MIN_STEP_MS,
          Math.round((targetMs + BUFFER_MS - (performance.now() - startedAt)) / steps)
        )
      : DEFAULT_STEP_MS;

    // Replay the path as Arrow presses, one cell per step, confirming each.
    let placed = 1; // the start is already drawn
    for (let i = 1; i < path.length; i++) {
      const dir = dirBetween(board, path[i - 1], path[i]);
      if (!dir) return { ok: false, error: "Internal: non-adjacent path step." };
      const target = board.elByIdx[path[i]];
      const before = filledCount(board);
      pressArrow(dir);
      await sleep(stepDelay);
      // A step that hasn't shown yet gets up to SETTLE_MS before it counts as dropped:
      // pressing again on a render that merely lagged would draw a second cell.
      let landed = await waitFor(() => isFilled(target), SETTLE_MS);
      // Dropped for real. Press again only if nothing moved at all — the head is then
      // still path[i-1]. If anything else changed, a second press would set off from
      // a cell we don't know.
      if (!landed && filledCount(board) === before) {
        pressArrow(dir);
        await sleep(stepDelay);
        landed = await waitFor(() => isFilled(target), SETTLE_MS);
      }
      if (!landed) {
        return {
          ok: false,
          error: `The path stopped after ${placed} of ${path.length} cells. Try again.`,
          placed,
        };
      }
      placed++;
    }
    // Only the board can say it's won: report success on its word, not ours.
    if (placed !== board.N * board.N || (await confirmSolved(board)) === false) {
      return { ok: false, error: "The board still isn't solved. Try again.", placed };
    }
    return { ok: true, placed, N: board.N };
  });
}

// Expose the engine on the (isolated-world) global so the auto-solve content
// script — content.js, listed after this file in the same content_scripts entry —
// can call it whatever scope Chrome gives each file. This runs only when the file
// is loaded as a script (content script or the popup's <script>); it is NOT part
// of runZip, so the popup's executeScript({func: runZip}) never carries it.
if (typeof self !== "undefined") self.runZip = runZip;
