# Zip Auto-Solver (Chrome Extension, Manifest V3)

Automatically parses and solves the **LinkedIn Zip** game at
<https://www.linkedin.com/games/zip/>. Open the game, start a round, click the
extension's **Solve puzzle** button, and it draws the completed path for you — timing
how long the solve takes. **Auto-solve is on by default** (toggle it off in the
settings menu): with it on, the puzzle solves the moment the board is on screen, no
popup or click needed (a content script handles that). A **Solve time** box (whole
seconds, 1–999, default **5**) with a companion 1–60 slider sets how long the whole
solve should take, and the engine paces its Arrow presses to land just over it (a 5 s
target finishes ~5.5 s).

> This README is written to give future maintainers (human or AI) the exact,
> **verified** facts about the page so the extension can be updated confidently.
> The guest DOM below was confirmed against the live game (Zip No. 486, a 7×7 board
> with walls) — parse, solve, and fill were run end-to-end and the puzzle was solved.

---

## Repo structure

```
Zip_Solver/
├── manifest.json   # MV3 config: action popup + content script + scripting/storage/host permissions
├── injected.js     # The engine (parse → solve → draw) as one self-contained func; loaded by BOTH popup and content script
├── content.js      # Content script: auto-solves on game-page load, with no popup opened
├── popup.html      # Popup markup (loads injected.js then popup.js)
├── popup.js        # Popup logic: inject engine on demand, poll, enable Solve, auto-solve, timer, settings menu
├── styles.css      # Popup styling (light/dark aware)
├── images/         # Toolbar/action icons (16/32/48/128 px)
└── README.md       # This file
```

### What each file does

| File | Responsibility |
| --- | --- |
| **manifest.json** | Declares an MV3 extension with a `default_popup` **and** a `content_scripts` entry (`injected.js` + `content.js`, `all_frames`) on the Zip game URLs. Permissions: `scripting` (the popup injects on demand) + `storage` (shared settings) + `host_permissions` for `*://*.linkedin.com/*`. |
| **injected.js** | The engine, exported as a single self-contained function `runZip(mode, opts)`. `mode:'detect'` returns whether a solvable board is present (plus a preview snapshot and the solution path); `mode:'solve'` parses → solves (Hamiltonian-path search) → draws the path via the verified input sequence. `opts.targetMs` (optional) paces the solve — see **Target time** below. It references nothing outside itself so `chrome.scripting.executeScript` can serialize it into the page's MAIN world; the same file is loaded by the popup (`<script>`) and as a content script, so the engine never forks. A trailing `self.runZip = runZip` publishes it to the (isolated-world) global for `content.js`; the line isn't part of the function, so the popup's `executeScript({func: runZip})` never carries it. |
| **popup.html / popup.js** | The UI. `popup.js` calls `chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runZip, args:['detect'\|'solve', opts] })`. Each poll first checks the active tab's URL against `linkedin.com/games/zip`; off the game page it drops straight to `idle` (**Open Zip game**) instead of flashing "Looking for puzzle…". (A tab's `url` is only readable for origins we hold host permission for, so a blank url is itself a "not the game" signal.) On the game page it polls `detect` every 800 ms and enables **Solve** only once a board is found. Clicking runs `solve` via the shared `runSolve()`. |
| **content.js** | The content script that makes **Auto-solve** work *without the popup being opened*. The browser guarantees to run it on a matching page (and, with `all_frames`, in the board's iframe) on every load — no service worker to wake. It runs in the **isolated world**, so it reads `chrome.storage` for the setting, and shares the page DOM, so it drives the same `runZip` (defined by `injected.js`, listed before it in the same entry) directly — including the document-level Arrow `keydown`s, which the page's listeners see just as they do from the MAIN world. If `autosolve` is on it polls `detect` until the board (which renders async in the iframe) is solvable, then runs `solve` with the stored `targetMs`; non-board frames bail quietly so only the game frame logs. Tagged `[Zip auto-solve]` console lines (in the **page** console, F12) trace the flow. |
| **Auto-solve** | A toggle (`role="menuitemcheckbox"`) in the settings menu, **on by default** (an explicit stored `false` is what `content.js` checks, so the default holds until you turn it off). When on, **`content.js` is the one that auto-solves** — on every game-page load, popup open or not. The popup deliberately does **not** also auto-solve when it merely *detects* a board on open: that would run a second solve concurrently with the content script (the "opening the popup makes it go twice as fast" bug fixed in Queens). The one popup-side auto-solve is the toggle itself: enabling it while a board is already `ready` solves once, there and then. If the popup is opened while `content.js` is solving, it mirrors that solve instead of offering a second one: `content.js` leaves a `data-autosolve` marker (with its start time and, once done, its result) on the board frame's `<html>`, and the popup reads it to show **Solving** — timer counting from the auto-solve's start — then **Solved** with its time. With Auto-solve on, the popup also keeps polling a `ready` board, so it catches a solve that starts after it opened. `content.js` itself polls until a board turns up however long that takes, rather than giving up after a few tries. |
| **Settings storage** | Both settings persist in the popup's **synchronous `localStorage`** (keys `autosolve`, `targetMs`): `chrome.storage.local.set` is async, and a popup closed right after a change can be torn down before that write flushes. The content script can't read the popup's `localStorage` (different origin), so the popup **also mirrors** to `chrome.storage.local` (same keys) — best-effort on each change, and re-asserted from `localStorage` every time the popup opens, so a lost mirror write self-heals. The `storage` permission is for that content-script-facing mirror. |
| **Target time** | How long the whole solve should take, set in the settings menu and stored as `targetMs`; both the popup and the content script pass it to `runZip` as `opts.targetMs`. **Two synced controls for one value**: a `type="text"` + `inputmode="numeric"` box for exact whole-seconds entry (**1–999** — filtered to ≤3 digits, clamped on commit `0`→`1` / blank→last good, stepped with ↑/↓) and a **slider** for the common **1–60** range that pins at 60 when the box holds a larger value. The path is replayed one Arrow press per cell with one sleep per press, so the replay takes ≈ (steps × delay). Unlike Queens/Tango, getting to the replay can take a variable while (an **Undo** reset of a half-drawn board), so the engine budgets the replay with whatever is *left* of (`targetMs` + 500 ms) after the parse, solve and reset: `delay = (targetMs + 500 − elapsed) / steps`. The **+500 ms buffer** makes the real solve land just *over* the target, never under. The floor is **50 ms**, which only bites for a very short target. Omitting `targetMs` keeps the verified 90 ms cadence. |
| **Completion timer** | A chip below the button that counts up live (`performance.now()`, 100 ms tick) while `runSolve()` draws the path, then freezes at the total on `solved`. Shown only in the `solving`/`solved` states. It's `aria-hidden` (a chip ticking every 100 ms would spam the a11y tree); the final figure is instead folded into the visually-hidden `solved` status line, which is a live region, so screen readers hear it once. Not shown for `done` — no solve of ours ran. |
| **Board preview** | Once a board is detected the popup draws the numbered cells with the **solution** path and the walls overlaid. The board is rounded + `overflow: hidden`, so `buildGrid` tags the four corner cells (`--tl/--tr/--bl/--br`, any N) and CSS rounds them to match — otherwise the square corner cells' hairlines are cut off at the curve. |
| **styles.css** | Popup styling, adapts to light/dark. Every per-state visual hangs off `body[data-state="…"]`. |

### Why on-demand injection for the popup

The popup's engine is injected on demand rather than as a pre-injected content script,
so it is immune to when the game iframe loaded and needs no "reload after install". The
board frame's CSP (`script-src … 'strict-dynamic'`, no `'unsafe-eval'`) blocks in-page
`eval`, but `chrome.scripting.executeScript` in the MAIN world is exempt. (Same design
as `Queens_Solver`, `Tango_Solver`, and `Mini_Sudoku_Solver`.)

The auto-solve content script (`content.js`) is a *different* job and doesn't hit
that problem: auto-solve is meant to fire **on load**, which is exactly when a
content script runs, and it polls for the async iframe board rather than assuming
it's there. So the two mechanisms are complementary — on-demand injection for the
click-to-solve popup, a content script for solve-on-load — not a contradiction.

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
4. With **Auto-solve** on (the default) the path draws itself once the board is on
   screen. Otherwise click the extension icon; the **Solve puzzle** button enables once
   the board is detected. Click it — the path is drawn and the game registers a win.

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
- **Fast targets:** each step re-checks that the cell filled and re-presses once if it
  didn't. If a very short **Solve time** ever draws a wrong route, the render is lagging
  the step delay (so the retry lands as a second move) — raise `MIN_STEP_MS` in
  `injected.js` back towards the verified 90 ms.

If the input sequence ever stops working, re-inspect what the widget listens for (open
DevTools on the iframe, add capturing listeners) and update `pressArrow()` /
`fireOneClick()` in `injected.js`.
