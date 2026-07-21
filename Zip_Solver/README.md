# Zip Auto-Solver (Chrome Extension, Manifest V3)

Automatically parses and solves the **LinkedIn Zip** game at
<https://www.linkedin.com/games/zip/>. Open the game, start a round, click the
extension's **Solve puzzle** button, and it draws the completed path for you.

> This README is written to give future maintainers (human or AI) the exact,
> **verified** facts about the page so the extension can be updated confidently.
> The guest DOM below was confirmed against the live game (Zip No. 486, a 7×7 board
> with walls) — parse, solve, and fill were run end-to-end and the puzzle was solved.

---

## Repo structure

```
Zip_Solver/
├── manifest.json   # MV3 config: action popup + scripting/host permissions
├── injected.js     # The engine (parse → solve → draw) as one self-contained func
├── popup.html      # Popup markup (loads injected.js then popup.js)
├── popup.js        # Popup logic: inject engine on demand, poll, enable Solve
├── styles.css      # Popup styling (light/dark aware)
└── README.md       # This file
```

> There is no `images/` folder yet, so `manifest.json` omits the `icons` key and
> Chrome uses a default toolbar icon. Add icons + an `icons` block later to match the
> other solvers.

### What each file does

| File | Responsibility |
| --- | --- |
| **manifest.json** | Declares an MV3 extension with a `default_popup`. **No content script** — the engine is injected on demand. Permissions: `scripting` (to inject) + `host_permissions` for `*://*.linkedin.com/*`. |
| **injected.js** | The engine, exported as a single self-contained function `runZip(mode)`. `mode:'detect'` returns whether a solvable board is present; `mode:'solve'` parses → solves (Hamiltonian-path search) → draws the path via the verified input sequence. It references nothing outside itself so `chrome.scripting.executeScript` can serialize it into the page's MAIN world. |
| **popup.html / popup.js** | The UI. `popup.js` calls `chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runZip, args:['detect'\|'solve'] })`. On open it polls `detect` every 800 ms and enables **Solve** only once a board is found. Clicking runs `solve`. |
| **styles.css** | Minimal popup styling, adapts to light/dark. |

### Why on-demand injection

The engine is injected on demand rather than as a pre-injected content script, so it is
immune to when the game iframe loaded and needs no "reload after install". The board
frame's CSP (`script-src … 'strict-dynamic'`, no `'unsafe-eval'`) blocks in-page `eval`,
but `chrome.scripting.executeScript` in the MAIN world is exempt. (Same design as
`Queens_Solver`, `Tango_Solver`, and `Mini_Sudoku_Solver`.)

---

## The game (single Hamiltonian path)

Draw **one continuous path** that fills every cell exactly once, passing through the
numbered dots in ascending order (1 → 2 → … → K). The path starts on **1** and ends on
the highest number **K**. **Walls** between adjacent cells block movement across them.

## Verified page facts (ground truth)

Confirmed live against the guest board (Zip No. 486). If LinkedIn ships a redesign and
the extension stops working, re-verify these first.

- **The board is inside a same-origin iframe** at
  `www.linkedin.com/games/view/zip/desktop`. ⇒ Injection uses `allFrames: true`.
- **Grid container:** `div.trail-grid.grid-game-board.gil__grid` with
  `style="--rows:N; --cols:N"`. Signed-in uses `[data-testid="interactive-grid"]
  [data-trail-grid]` inside `[data-testid="zip-game-container"]`.
- **Cells:** `div.trail-cell[data-cell-idx="0…N²-1"]` (row-major → `row = idx/N | 0`,
  `col = idx % N`). Grid size `N = round(sqrt(cellCount))` — **not hardcoded** (guest
  No. 486 was 7×7; the provided signed-in sample was 6×6).
- **Numbers:** the `.trail-cell-content` text holds the dot's number. Signed-in also
  exposes it as `aria-label="Number N"` on the cell plus `[data-cell-content]` text —
  the parser reads both.
- **Walls — two detection strategies, since LinkedIn ships two builds:**
  1. **Guest (semantic):** a cell carries child classes
     `trail-cell-wall--{right,left,down,up}` for a blocked edge. Horizontal walls are
     marked on **both** neighbouring cells (`--right` on the left cell, `--left` on the
     right one); vertical walls are marked with `--down` on the top cell. The
     corner-join classes `trail-cell-wall--down-left` / `--down-right` are **decorative**
     and must be ignored (the parser only matches an end-anchored single direction).
  2. **Signed-in (hashed):** the signed-in layout ships CSS-module hashed class names
     (e.g. `_9e5e2e24`) that change per build, so they can't be matched by name. But in
     both builds a wall renders identically: a cell-spanning overlay whose `::after`
     carries a **thick one-sided border** (~12px on a ~66px cell) on exactly the wall's
     side (`border-bottom` → down, `border-right` → right, etc.). `wallDirs()` falls back
     to reading that rendered border via `getComputedStyle`, requiring **exactly one**
     thick side so a focus ring or selected-cell highlight (3–4 thick sides) isn't
     mistaken for a wall. This is class-name-agnostic and survives future re-hashing.

  `connected()` treats an edge as blocked if **either** side marks it.
- **Filled cells:** class `trail-cell--filled` (guest) or a `[data-testid="filled-cell"]`
  child (signed-in). Used to reset and to verify each drawn step.
- **Fill mechanism (verified):** the game **auto-fills the "1" cell** as the path head.
  **Plain clicks do not draw the path.** Pressing an **Arrow key** (dispatched at
  `document` level) extends the path one cell in that direction when the move is legal
  (adjacent, unvisited, no wall); state updates asynchronously. So the solver computes
  the full path, **resets** any existing drawing via the **Undo** control, then replays
  the path as a sequence of Arrow `keydown`s. (LinkedIn also supports clicking the
  furthest cell in a straight line to fill a whole segment, but per-cell Arrow presses
  are the most robust and are what this extension uses.)

---

## The solver

Depth-first Hamiltonian-path search in `injected.js` (`solve()`), starting at the "1"
cell:

1. Move only to an **unvisited, wall-free adjacent** cell.
2. When stepping onto a numbered cell, its number must equal the **next expected**
   number, otherwise prune (this enforces the 1→2→…→K ordering and prunes hard).
3. Succeed when **all** cells are visited **and** the final cell is the highest number.
4. **Reachability prune:** after each step, every still-unvisited cell must remain
   reachable from the head through unvisited cells, else backtrack (avoids stranding
   cells). This keeps a 7×7 board solving in a few milliseconds.

Returns the ordered list of cell indices, or `null` if no path exists.

---

## Install / run

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `Zip_Solver/` folder.
3. Open <https://www.linkedin.com/games/zip/> and **Start game**.
4. Click the extension icon. The **Solve puzzle** button enables once the board is
   detected. Click it — the path is drawn and the game registers a win.

---

## Handling DOM drift & known limits

- **Grid lookup is id/class-agnostic:** `parseBoard()` collects all `[data-cell-idx]`
  elements and keeps the largest group sharing one parent, and derives `N` from the
  cell count — nothing is hardcoded to a size.
- **Zip signature:** parsing requires a Zip marker (`.trail-cell` / `.trail-grid` /
  `[data-trail-grid]` / `[data-testid="zip-game-container"]`), so a Queens, Tango, or
  Sudoku board never mis-parses as Zip.
- **Walls in the signed-in (hashed-class) DOM are read from rendered CSS, not class
  names** — see the wall-detection strategies above. Verified against a live 6×6
  signed-in-shaped board (walls at the same cells as a captured signed-in DOM sample):
  the geometry-based detector reproduced the semantic ground truth exactly (0
  mismatches) and the resulting solve was a valid, wall-respecting Hamiltonian path. If
  a signed-in solve ever draws an illegal move again, first re-check the wall bar is
  still ~10%+ of the cell's shorter side (`THICK` in `wallDirs()`) — a redesign that
  changes wall thickness or renders it differently (e.g. an SVG line instead of a
  border) would need that heuristic updated.

If the input sequence ever stops working, re-inspect what the widget listens for (open
DevTools on the iframe, add capturing listeners) and update `pressArrow()` /
`fireOneClick()` in `injected.js`.
