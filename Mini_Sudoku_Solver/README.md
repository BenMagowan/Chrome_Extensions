# Mini Sudoku Auto-Solver (Chrome Extension, Manifest V3)

Automatically parses and solves the **LinkedIn Mini Sudoku** game at
<https://www.linkedin.com/games/mini-sudoku/>. Open the game, start a round, click the
extension's **Solve puzzle** button, and it fills the grid for you.

> This README is written to give future maintainers (human or AI) the exact,
> **verified** facts about the page so the extension can be updated confidently.
> Every selector and behavior below was confirmed against the live DOM, not guessed.

---

## Repo structure

```
Mini_Sudoku_Solver/
├── manifest.json   # MV3 config: action popup + scripting/host permissions
├── injected.js     # The engine (parse → solve → fill) as one self-contained func
├── popup.html      # Popup markup (loads injected.js then popup.js)
├── popup.js        # Popup logic: inject engine on demand, poll, enable Solve
├── styles.css      # Popup styling (light/dark aware)
├── images/         # Toolbar/action icons (16/32/48/128 px)
└── README.md       # This file
```

### What each file does

| File | Responsibility |
| --- | --- |
| **manifest.json** | Declares an MV3 extension with a `default_popup`. **No content script** — the engine is injected on demand. Permissions: `scripting` (to inject) + `host_permissions` for `*://*.linkedin.com/*`. |
| **injected.js** | The engine, exported as a single self-contained function `runSudoku(mode)`. `mode:'detect'` returns whether a solvable board is present; `mode:'solve'` parses → solves (backtracking CSP) → fills the grid via the verified DOM event sequence. It references nothing outside itself so `chrome.scripting.executeScript` can serialize it into the page's MAIN world. |
| **popup.html / popup.js** | The UI. `popup.js` calls `chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runSudoku, args:['detect'\|'solve'] })`. On open it polls `detect` every 800 ms and enables **Solve** only once a board is found. Clicking runs `solve`. |
| **styles.css** | Minimal popup styling, adapts to light/dark. |
| **images/** | PNG icons referenced by `manifest.json`. All four sizes must exist or Chrome refuses to load the extension. |

### Why on-demand injection

The engine is injected on demand rather than as a pre-injected content script.
Content scripts inject only when a page/iframe **loads**, so the engine would be
missing whenever the tab was already open at install time, or the game iframe
rendered after `document_idle`. On-demand injection removes that timing dependency:
the popup injects fresh code into the live DOM (all frames) every time, so detection
and solving are immune to when the game loaded. (Same design as `Queens_Solver` and
`Tango_Solver`.)

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
4. Click the extension icon. The **Solve puzzle** button enables once the board is
   detected. Click it — the grid fills and the game registers a win.

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

If the click sequence ever stops working, re-inspect which events the widget listens for
(open DevTools on the iframe, add capturing listeners) and update `fireOneClick()` in
`injected.js`.
