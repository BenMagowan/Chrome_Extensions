# Mini Sudoku Auto-Solver (Chrome Extension, Manifest V3)

Automatically parses and solves the **LinkedIn Mini Sudoku** game at
<https://www.linkedin.com/games/mini-sudoku/>. Open the game, start a round, click the
extension's **Solve puzzle** button, and it fills the grid for you — timing how long
the solve takes. **Auto-solve is on by default** (toggle it off in the settings menu):
with it on, the puzzle solves the moment the board is on screen, no popup or click
needed (a content script handles that). A **Solve time** box (whole seconds, 1–999,
default **5**) with a companion 1–60 slider sets how long the whole solve should take,
and the engine paces its clicks to land just over it (a 5 s target finishes ~5.5 s).

> This README is written to give future maintainers (human or AI) the exact,
> **verified** facts about the page so the extension can be updated confidently.
> Every selector and behavior below was confirmed against the live DOM, not guessed.

---

## Repo structure

```
Mini_Sudoku_Solver/
├── manifest.json   # MV3 config: action popup + content script + scripting/storage/host permissions
├── injected.js     # The engine (parse → solve → fill) as one self-contained func; loaded by BOTH popup and content script
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
| **manifest.json** | Declares an MV3 extension with a `default_popup` **and** a `content_scripts` entry (`injected.js` + `content.js`, `all_frames`) on the Mini Sudoku game URLs. Permissions: `scripting` (the popup injects on demand) + `storage` (shared settings) + `host_permissions` for `*://*.linkedin.com/*`. |
| **injected.js** | The engine, exported as a single self-contained function `runSudoku(mode, opts)`. `mode:'detect'` returns whether a solvable board is present (plus a preview snapshot); `mode:'solve'` parses → solves (backtracking CSP) → fills the grid via the verified DOM event sequence. `opts.targetMs` (optional) paces the solve — see **Target time** below. It references nothing outside itself so `chrome.scripting.executeScript` can serialize it into the page's MAIN world; the same file is loaded by the popup (`<script>`) and as a content script, so the engine never forks. A trailing `self.runSudoku = runSudoku` publishes it to the (isolated-world) global for `content.js`; the line isn't part of the function, so the popup's `executeScript({func: runSudoku})` never carries it. |
| **popup.html / popup.js** | The UI. `popup.js` calls `chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runSudoku, args:['detect'\|'solve', opts] })`. Each poll first checks the active tab's URL against `linkedin.com/games/mini-sudoku`; off the game page it drops straight to `idle` (**Open Mini Sudoku game**) instead of flashing "Looking for puzzle…". (A tab's `url` is only readable for origins we hold host permission for, so a blank url is itself a "not the game" signal.) On the game page it polls `detect` every 800 ms and enables **Solve** only once a board is found. Clicking runs `solve` via the shared `runSolve()`. |
| **content.js** | The content script that makes **Auto-solve** work *without the popup being opened*. The browser guarantees to run it on a matching page (and, with `all_frames`, in the board's iframe) on every load — no service worker to wake. It runs in the **isolated world**, so it reads `chrome.storage` for the setting, and shares the page DOM, so it drives the same `runSudoku` (defined by `injected.js`, listed before it in the same entry) directly. If `autosolve` is on it polls `detect` until the board (which renders async in the iframe) is solvable, then runs `solve` with the stored `targetMs`; non-board frames bail quietly so only the game frame logs. Tagged `[Mini Sudoku auto-solve]` console lines (in the **page** console, F12) trace the flow. |
| **Auto-solve** | A toggle (`role="menuitemcheckbox"`) in the settings menu, **on by default** (an explicit stored `false` is what `content.js` checks, so the default holds until you turn it off). When on, **`content.js` is the one that auto-solves** — on every game-page load, popup open or not. The popup deliberately does **not** also auto-solve when it merely *detects* a board on open: that would run a second solve concurrently with the content script (the "opening the popup makes it go twice as fast" bug fixed in Queens). The one popup-side auto-solve is the toggle itself: enabling it while a board is already `ready` solves once, there and then. If the popup is opened while `content.js` is solving, it mirrors that solve instead of offering a second one: `content.js` leaves a `data-autosolve` marker (with its start time and, once done, its result) on the board frame's `<html>`, and the popup reads it to show **Solving** — timer counting from the auto-solve's start — then **Solved** with its time. With Auto-solve on, the popup also keeps polling a `ready` board, so it catches a solve that starts after it opened. `content.js` itself polls until a board turns up however long that takes — and here also until it's `playable` (see **Start screen** below) — rather than giving up after a few tries. |
| **Settings storage** | Both settings persist in the popup's **synchronous `localStorage`** (keys `autosolve`, `targetMs`): `chrome.storage.local.set` is async, and a popup closed right after a change can be torn down before that write flushes. The content script can't read the popup's `localStorage` (different origin), so the popup **also mirrors** to `chrome.storage.local` (same keys) — best-effort on each change, and re-asserted from `localStorage` every time the popup opens, so a lost mirror write self-heals. The `storage` permission is for that content-script-facing mirror. |
| **Target time** | How long the whole solve should take, set in the settings menu and stored as `targetMs`; both the popup and the content script pass it to `runSudoku` as `opts.targetMs`. **Two synced controls for one value**: a `type="text"` + `inputmode="numeric"` box for exact whole-seconds entry (**1–999** — filtered to ≤3 digits, clamped on commit `0`→`1` / blank→last good, stepped with ↑/↓) and a **slider** for the common **1–60** range that pins at 60 when the box holds a larger value. Each cell that needs a digit costs **two** clicks (select the cell, then its number button), each followed by one sleep, so the engine sets `delay = (targetMs + 500) / (cellsToFill × 2)`. The **+500 ms buffer** makes the real solve land just *over* the target, never under. The floor is **50 ms**, which only bites for a very short target. Omitting `targetMs` keeps the verified 140 ms cadence. |
| **Completion timer** | A chip below the button that counts up live (`performance.now()`, 100 ms tick) while `runSolve()` places digits, then freezes at the total on `solved`. Shown only in the `solving`/`solved` states. It's `aria-hidden` (a chip ticking every 100 ms would spam the a11y tree); the final figure is instead folded into the visually-hidden `solved` status line, which is a live region, so screen readers hear it once. Not shown for `done` — no solve of ours ran. |
| **Board preview** | Once a board is detected the popup draws the grid with the **solution's** digits and the region walls (clues tinted). The board is rounded + `overflow: hidden`, so `renderBoard`/`renderPlaceholder` tag the four corner cells (`--tl/--tr/--bl/--br`, any N) and CSS rounds them to match — otherwise the square corner cells are clipped. |
| **styles.css** | Popup styling, adapts to light/dark. Every per-state visual hangs off `body[data-state="…"]`. |
| **images/** | PNG icons referenced by `manifest.json`. All four sizes must exist or Chrome refuses to load the extension. |

### Why on-demand injection for the popup

The popup's engine is injected on demand rather than as a pre-injected content script.
Content scripts inject only when a page/iframe **loads**, so the engine would be
missing whenever the tab was already open at install time, or the game iframe
rendered after `document_idle`. On-demand injection removes that timing dependency:
the popup injects fresh code into the live DOM (all frames) every time, so detection
and solving are immune to when the game loaded. (Same design as `Queens_Solver` and
`Tango_Solver`.)

The auto-solve content script (`content.js`) is a *different* job and doesn't hit
that problem: auto-solve is meant to fire **on load**, which is exactly when a
content script runs, and it polls for the async iframe board rather than assuming
it's there. So the two mechanisms are complementary — on-demand injection for the
click-to-solve popup, a content script for solve-on-load — not a contradiction.

---

## The game (constraint satisfaction)

6×6 grid, digits 1–6, each appearing exactly once in every **row**, **column**, and
**region**. Regions are the 6 wall-bounded areas (this puzzle: 2×3 boxes, but the code
derives them from walls so it also handles irregular/jigsaw layouts). Some cells are
**prefilled** clues; the solution is unique.

## Verified page facts (ground truth)

Confirmed against the live guest board and the provided signed-in DOM — they **match**
(one code path). If LinkedIn ships a redesign and the extension stops working, re-verify
these first.

- **Same iframe/framework as Queens/Tango:** board at
  `www.linkedin.com/games/view/mini-sudoku/desktop`. ⇒ Injection uses `allFrames: true`,
  MAIN world, and the exact `fireOneClick` sequence
  (`pointerdown → mousedown → pointerup → mouseup → click`).
- **No hashed/signed-in variant:** guest and signed-in both use semantic `sudoku-*`
  classes and no `data-testid`.
- **Grid:** `div.sudoku-grid` (`style="--rows:6;--cols:6"`), inside
  `section.sudoku-board[data-sudoku-grid]`.
- **Cells:** `div.sudoku-cell[data-cell-idx="0…35"]`; value = `.sudoku-cell-content`
  text (empty string when blank); locked clue = class `sudoku-cell-prefilled`.
- **Regions:** membership from wall classes `sudoku-cell-wall-{top,right,bottom,left}`.
  Two orthogonally adjacent cells are in the same region iff no wall separates them.
  Flood-fill → 6 regions of 6 cells.
- **Input pad:** `button[data-number="1"…"6"]`, plus `[data-number="erase"]` and
  `[data-number="undo"]`; extra controls `[data-control-btn="hint"|"notes"]`.
- **Start screen (verified live, guest):** the grid, clues and walls are already in
  the DOM behind the "Solve now" start screen (36 cells, 14 clues), but the number pad
  isn't — zero `[data-number]` buttons until the round starts — and pressing
  **Solve now** doesn't change the URL, so no content script re-runs. `detect`
  therefore reports `playable` (number pad present), and `content.js` waits for it
  rather than firing a solve that can only fail with "Number pad not found".
- **Fill mechanism (differs from Queens/Tango's click-cycle):** click a cell → it gains
  `sudoku-cell-active`; then click `[data-number="V"]` → the cell shows V. Selecting a
  filled editable cell + a new number **overwrites**. Prefilled cells are not editable →
  the solver skips them.
- **Auto error-check:** wrong entries get class `sudoku-cell-exceptions` (irrelevant —
  the solver places only correct values).

---

## The solver

Backtracking constraint-satisfaction solver in `injected.js` (`solve()`). Regions are
derived from the wall classes by flood-fill, so it handles irregular layouts, not just
2×3 boxes. It seeds **only** the prefilled clues, then fills every other cell with the
first digit `1..N` not already used in that cell's **row**, **column**, or **region**,
backtracking on dead ends. Returns the full grid (`value[idx]`) or `null` if unsolvable.

Seeding from clues alone is deliberate: digits the *player* entered are guesses, not
facts. Seeding those too (as an earlier version did) meant a single wrong guess made the
puzzle look unsolvable, and a wrong-but-consistent guess got baked into the answer and
then skipped at fill time — leaving the mistake on the finished board. Treating every
player-entered cell as empty means all of them, mistakes included, get overwritten.

---

## Install / run

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `Mini_Sudoku_Solver/` folder.
3. Open <https://www.linkedin.com/games/mini-sudoku/> and **Start game**.
4. With **Auto-solve** on (the default) the grid fills by itself once the board is on
   screen. Otherwise click the extension icon; the **Solve puzzle** button enables once
   the board is detected. Click it — the grid fills and the game registers a win.

---

## Handling DOM drift (edge cases)

The code is written to degrade gracefully if LinkedIn changes the markup:

- **Grid lookup is id/class-agnostic:** `parseBoard()` collects all `[data-cell-idx]`
  elements and keeps the largest group sharing one parent, and derives `N` from the cell
  count — nothing is hardcoded to 6×6.
- **Sudoku signature:** parsing requires a `sudoku-*` marker (cell class, `.sudoku-grid`,
  or `[data-sudoku-grid]`), so a Queens or Tango board — which also uses
  `[data-cell-idx]` — never mis-parses as Sudoku.
- **Board not ready:** `detect` only reports solvable for a complete N×N grid with N
  regions, and the popup keeps polling, so the button enables itself the moment the game
  finishes rendering.
- **Idempotent fill:** cells already holding the correct digit are skipped, and each
  placement is re-read and retried once, so solving works from any partial state.
- **Fast targets:** the number-pad click writes into whichever cell the game thinks is
  selected. If a very short **Solve time** ever leaves digits in the wrong cells, the
  selection is lagging the click delay — raise `MIN_CLICK_MS` in `injected.js` back
  towards the verified 140 ms.

If the click sequence ever stops working, re-inspect which events the widget listens for
(open DevTools on the iframe, add capturing listeners) and update `fireOneClick()` in
`injected.js`.
