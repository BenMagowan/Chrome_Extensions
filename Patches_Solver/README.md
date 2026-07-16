# Patches Auto-Solver (Chrome Extension, Manifest V3)

Automatically parses and solves LinkedIn **Patches** puzzles at
<https://www.linkedin.com/games/patches/>. Open the game, start a round, click the
extension's **Solve puzzle** button, and it draws the patches for you.

Every Patches clue is a rectangle (`SQUARE` / `HORIZONTAL_RECT` / `VERTICAL_RECT`) with a
given area — a *Shikaku-with-shapes* tiling — so the rectangle exact-cover solver below
covers the full game.

> This README is written to give future maintainers (human or AI) the exact,
> **verified** facts about the page so the extension can be updated confidently.
> The guest DOM, the input mechanism, and the fill were all confirmed against the live
> game (Patches No. 121, a 6×6 board), not guessed.

---

## Repo structure

```
Patches_Solver/
├── manifest.json   # MV3 config: action popup + scripting/host permissions
├── injected.js     # The engine (parse → solve → draw) as one self-contained func
├── popup.html      # Popup markup (loads injected.js then popup.js)
├── popup.js        # Popup logic: inject engine on demand, poll, enable Solve
├── styles.css      # Popup styling (light/dark aware)
├── images/         # Toolbar/action icons (16/32/48/128 px)
└── README.md       # This file
```

### What each file does

| File | Responsibility |
| --- | --- |
| **manifest.json** | Declares an MV3 extension with a `default_popup`. **No content script** — the engine is injected on demand. Permissions: `scripting` + `host_permissions` for `*://*.linkedin.com/*`. |
| **injected.js** | The engine, a single self-contained function `runPatches(mode)`. `mode:'detect'` reports whether a solvable board is present; `mode:'solve'` parses → solves (rectangle exact-cover) → draws each patch with the verified keyboard sequence. Self-contained so `chrome.scripting.executeScript` can serialize it into the page's MAIN world. |
| **popup.html / popup.js** | The UI. `popup.js` calls `chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runPatches, args:['detect'\|'solve'] })`, polls `detect` every 800 ms, and enables **Solve** once a solvable board is found. |
| **styles.css** | Minimal popup styling, adapts to light/dark. |
| **images/** | PNG icons referenced by `manifest.json` (all four sizes must exist). |

---

## The game

Partition the grid into rectangular regions ("patches"), **one per clue**, tiling every
cell. Each clue states its patch's **area** (a number) and a **shape**:

- `SQUARE` (h == w), `HORIZONTAL_RECT` (wide, w > h), `VERTICAL_RECT` (tall, h > w).

Every clue observed live is one of these three rectangle shapes — Patches never actually
issues a freeform/polyomino clue — so the rectangle exact-cover solver handles the full
game. The parser still tags an `UNKNOWN` shape defensively (`rectanglePuzzle` in
`parseBoard()`) so a future rule change would report as unsupported instead of drawing a
wrong solution, but this path is not expected to trigger in practice.

## Verified page facts (ground truth)

Confirmed live against the guest board (Patches No. 121). Re-verify these first if a
redesign breaks the extension.

- **Framework:** the same `interactive-grid` / `data-trail-grid` component as Zip, inside
  `[data-testid="patches-game-container"]`. The board group is
  `[data-testid="patches-game-board"]` (`role="group"`, `aria-label="Gameboard"`,
  `tabindex="0"`). (The guest board renders in the top document; signed-in may use an
  iframe — injection uses `allFrames: true` either way.)
- **Cells:** `[data-cell-idx="0…rows*cols-1"]`, row-major. Grid size comes from the
  `"Row R, column C"` aria text (max R = rows, max C = cols) — **not hardcoded** (guest
  was 6×6, the signed-in sample 5×5).
- **Clues:** a clue cell contains a `[data-shape="PatchesShapeConstraint_…"]`
  (`SQUARE` / `HORIZONTAL_RECT` / `VERTICAL_RECT` / `UNKNOWN`) and, when sized, a
  `[data-testid="patches-clue-number-<idx>"]` with the area (also in the aria as
  "… clue, N cells"). These attributes are stable across guest and signed-in DOMs.
- **Filled cells (fill/verify signal):** an assigned cell's **aria-label** gains
  "…, in region with clue at row R, column C" — which also names the owning clue. Empty
  cells read just "Row r, column c".
- **⚠️ Fill mechanism — keyboard, not drag.** The click-and-drag the game advertises
  responds **only to trusted events**; every synthetic pointer/mouse drag (including an
  exact replay of a real drag's event stream) was ignored — and an extension can only emit
  synthetic events. The **keyboard** path *does* accept synthetic events (verified live):
  - focus `[data-testid="patches-game-board"]` + `Enter` → **grid mode** (a cursor cell
    gains DOM focus; read `document.activeElement`'s `data-cell-idx` to track it),
  - **Arrow keys** move the cursor one cell,
  - `Enter` on a corner = **anchor**, move the cursor, `Enter` again = **commit** → fills
    the **bounding-box rectangle** between the two presses, auto-coloured by whichever clue
    the rectangle encloses (the anchor need not be the clue itself).
  - `Escape` exits grid mode (avoid it mid-fill).

---

## The solver

Rectangle exact-cover (`solve()` in `injected.js`):

1. Require `sum(clue areas) == rows*cols` (patches must tile the grid).
2. For each clue enumerate candidate rectangles: every `h×w` with `h*w == area` matching
   the shape (`SQUARE` h==w, `HORIZONTAL_RECT` w>h, `VERTICAL_RECT` h>w), placed so it
   covers the clue and **no other** clue.
3. Backtrack (fewest-candidates-first) choosing one non-overlapping rectangle per clue
   until every cell is covered exactly once.

Returns each patch's top-left/bottom-right corners, which the keyboard fill draws
corner→corner. Verified: reproduces the exact tiling of the signed-in 5×5 sample in ~1 ms.

---

## Install / run

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `Patches_Solver/` folder.
3. Open <https://www.linkedin.com/games/patches/> and **Start game**.
4. Click the extension icon. **Solve puzzle** enables once a board is detected; click it
   to draw the patches.

---

## Verification status

- **Parser:** verified live on the guest board (reads all clues and grid size).
- **Solver:** verified offline against the signed-in rectangle sample (exact tiling).
- **Keyboard fill:** verified live — the real `fill()` code drew rectangles via synthetic
  `KeyboardEvent`s, each region auto-coloured by its clue.
- **End-to-end win:** re-verify periodically against the live daily, as with the other
  solvers, in case LinkedIn changes the board markup.
