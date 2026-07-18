# Patches Auto-Solver (Chrome Extension, Manifest V3)

Automatically parses and solves LinkedIn **Patches** puzzles at
<https://www.linkedin.com/games/patches/>. Open the game, start a round, click the
extension's **Solve puzzle** button, and it draws the patches for you.

Every Patches patch is a **rectangle** — a *Shikaku* tiling. A clue may constrain that
rectangle's shape (`SQUARE` / `HORIZONTAL_RECT` / `VERTICAL_RECT`) and its area (a
number), but **both constraints are optional**, so the exact-cover solver below treats
them as filters rather than requirements.

> This README is written to give future maintainers (human or AI) the exact,
> **verified** facts about the page so the extension can be updated confidently.
> The guest DOM, the input mechanism, and the fill were all confirmed against the live
> game (Patches No. 121, a 6×6 board; re-confirmed on No. 122, a 7×7 HARD board), not
> guessed.

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
cell. **Every patch is a rectangle.** A clue only *constrains* its patch, and each of its
two constraints is optional — quoting the in-game legend verbatim:

> Complete each shape to fill the grid — **Square** · **Tall rectangle** · **Wide
> rectangle** · **Any of the above**. If a shape has a number, it must be that size.

- **Shape:** `SQUARE` (h == w), `HORIZONTAL_RECT` (wide, w > h), `VERTICAL_RECT`
  (tall, h > w), or `UNKNOWN` → parsed as **`ANY`**.
- **Area:** the clue's number, or **`null`** when the clue displays no number at all
  (the patch may then be any size; its area is pinned only by the tiling).

### ⚠️ `UNKNOWN` does *not* mean freeform

`PatchesShapeConstraint_UNKNOWN` — labelled "**freeform clue**" in the aria text — is the
legend's "**Any of the above**". The patch is **still a rectangle**; it is merely
unconstrained in shape. There is no polyomino/freeform Patches variant.

This is worth stating loudly because an earlier build read `UNKNOWN` as
"freeform/non-rectangular", gated on a `rectanglePuzzle` flag, and **refused such boards
as unsupported**. Harder dailies lean on both optional constraints — No. 122 (HARD) was
10/12 clues `ANY` with two carrying no number — so that build rejected them outright.
Both are now solved normally; the flag and the unsupported path are gone.

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
  **A clue may legitimately carry no number** — its aria then just reads
  "Row 3, column 5, freeform clue" with no ", N cells" and no `patches-clue-number-*`
  child. Treat that as *unconstrained area*, never as a parse failure.
- **Difficulty** is a property of the **daily puzzle**, not of the session or account:
  the "Difficulty HARD" chip in the header is a static label (a `div` with
  `aria-haspopup="dialog"`), not a selector. A board that fails as a guest fails the
  same way signed in.
- **Filled cells (fill/verify signal):** an assigned cell's **aria-label** gains
  "…, in region with clue at row R, column C" — which also names the owning clue. A
  *clue* cell inside a drawn patch instead gains "…, in drawn region". Empty cells read
  just "Row r, column c".
- **⚠️ Those phrases contain the word "clue", so strip them before testing whether a
  cell *is* a clue.** A bare `/clue/i` test on the raw label promotes every drawn cell
  into a phantom unnumbered clue: on a part-drawn 7×7 the 10 real clues read as 15, no
  clue could be assigned a candidate rectangle, and the board surfaced to the user as
  "no board / no solution". This is why a wrongly part-drawn board used to look
  undetectable.
- **Erasing:** `Backspace` with the cursor on a drawn cell removes that cell's **entire
  patch** in one press (9 → 6 → 2 → 0 drawn cells in three presses). This is required
  before filling, because the game refuses to draw a rectangle across cells that already
  belong to a patch — you cannot paint over a wrong patch. The header **Undo** button
  (rendered once play starts) is *not* used: it unwinds history step-by-step, can't
  target a patch, and may not reach patches drawn before a resumed session.
- **⚠️ Dangling anchors.** "Anchor placed, awaiting commit" is a live mode that isn't
  readable from the DOM, and a refused draw leaves one behind. With an anchor live the
  next keypress commits a rectangle instead of doing what was asked — an erase pass
  entered this way *added* a drawn cell (8 → 9). `Escape` drops grid mode and the anchor
  with it, so the fill always re-enters grid mode via Escape first.
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

1. Arithmetic guard: with every clue numbered, require `sum(areas) == rows*cols`.
   Unnumbered clues contribute an unknown area of `>= 1`, so when any are present the
   check weakens to `sum(known) + count(unnumbered) <= rows*cols`.
2. For each clue enumerate candidate rectangles: every `h×w` allowed by its constraints —
   a `null` area admits **every** size (so this walks the dimension grid instead of
   factorising), and shape `ANY` filters nothing — placed so it covers the clue and
   **no other** clue.
3. Backtrack, choosing one non-overlapping rectangle per clue until every cell is covered
   exactly once. That full-coverage requirement is what pins down the unconstrained
   clues' sizes.

Selection is **MRV** (re-pick the clue with the fewest still-valid candidates at each
step, failing early when one hits zero). The old fixed fewest-first ordering is too weak
once a clue can be any size — an unconstrained clue on a 7×7 has ~48 candidates.

Returns each patch's top-left/bottom-right corners, which the keyboard fill draws
corner→corner. Verified: solves the live No. 122 guest board (7×7 HARD, 10 `ANY` clues,
2 unnumbered) in ~5 ms, and reproduces the exact tiling of the signed-in 5×5 sample.

---

## Install / run

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `Patches_Solver/` folder.
3. Open <https://www.linkedin.com/games/patches/> and **Start game**.
4. Click the extension icon. **Solve puzzle** enables once a board is detected; click it
   to draw the patches.

---

## Verification status

- **Parser:** verified live on the guest board (reads all clues and grid size), including
  No. 122's `ANY` and unnumbered clues.
- **Solver:** verified against the signed-in rectangle sample and the live No. 122 guest
  board — tiling independently checked for full single coverage, per-clue shape/area
  compliance, and one clue per patch.
- **Keyboard fill:** verified live — the real `fill()` code drew rectangles via synthetic
  `KeyboardEvent`s, each region auto-coloured by its clue.
- **End-to-end win:** re-verify periodically against the live daily, as with the other
  solvers, in case LinkedIn changes the board markup.
