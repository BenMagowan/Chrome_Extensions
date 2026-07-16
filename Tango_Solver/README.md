# Tango Auto-Solver (Chrome Extension, Manifest V3)

Automatically parses and solves the **LinkedIn Tango** game at
<https://www.linkedin.com/games/tango/>. Open the game, start a round, click the
extension's **Solve puzzle** button, and it fills the grid for you.

> Written to give future maintainers (human or AI) the exact, **verified** facts about
> the page. Every selector and behaviour below was confirmed against the live guest
> board and a captured signed-in DOM — not guessed. Sibling extension: `../Queens_Solver`
> (same architecture; read its README for the shared injection/click design).

---

## The game (constraint satisfaction)

An N×N grid (currently 6×6). Every cell is a **Sun** or a **Moon**. Rules:

1. Each **row** has an equal number of Suns and Moons (N/2 each).
2. Each **column** has an equal number of Suns and Moons.
3. **No 3 identical** symbols consecutively in any row or column.
4. Cells joined by **`=`** must be the **same**; cells joined by **`×`** must be **opposite**.
5. Some cells are pre-filled **locked** clues. Each puzzle has one unique solution.

---

## Repo structure

```
Tango_Solver/
├── manifest.json   # MV3 config: action popup + scripting/host permissions
├── injected.js     # The engine (parse → solve → place) as one self-contained func
├── popup.html      # Popup markup (loads injected.js then popup.js)
├── popup.js        # Popup logic: inject engine on demand, poll, enable Solve
├── styles.css      # Popup styling (light/dark aware)
└── README.md       # This file
```

| File | Responsibility |
| --- | --- |
| **manifest.json** | MV3 with a `default_popup`. **No content script** — the engine is injected on demand. Permissions: `scripting` + `host_permissions` for `*://*.linkedin.com/*`. No `icons` block (uses Chrome's default icon; add PNGs + an `icons` map later if desired). |
| **injected.js** | The engine as a single self-contained `runTango(mode)`. `mode:'detect'` reports whether a solvable Tango board is present; `mode:'solve'` parses → solves (backtracking CSP) → fills cells via the verified click sequence. References nothing outside itself so `chrome.scripting.executeScript` can serialize it into the page's MAIN world. |
| **popup.html / popup.js** | UI. `popup.js` calls `executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runTango, args:['detect'\|'solve'] })`. It polls `detect` every 800 ms; with a board present the button reads **"Solve puzzle"** and runs `solve`, otherwise it reads **"Open Tango game"** and opens the game. |
| **styles.css** | Minimal popup styling, adapts to light/dark. |

### Why on-demand injection (not a content script)

Same rationale as `Queens_Solver`: content scripts inject only when a page/iframe
*loads*, so the engine was missing whenever the tab predated the install or the game
iframe rendered late. Injecting fresh on every popup action removes that timing
dependency and is exempt from the page CSP that blocks in-page `eval`.

---

## Verified page facts (ground truth)

Confirmed against the live guest board and a captured signed-in DOM. If Tango stops
working after a LinkedIn redesign, re-verify these first.

- **Same iframe/framework as Queens:** the board lives in a same-origin iframe
  `www.linkedin.com/games/view/tango/desktop` ("LinkedIn Games Interactive Grid
  Component"). Injection uses `allFrames: true`; only the frame with the board returns
  a result.
- **⚠️ The DOM differs between guest and signed-in sessions** — parse only off what's
  common to both:

  | | Guest | Signed-in |
  | --- | --- | --- |
  | Grid | `div.lotka-grid.gil__grid` (`style="--rows:6;--cols:6"`) | `[data-testid="interactive-grid"]` (`style="--_2bceb9bc:6;…"`) |
  | Cell | `div.lotka-cell` `#lotka-cell-N` | `#tango-cell-N`, fully hashed classes |
  | Locked clue | `aria-disabled="true"` + class `lotka-cell--locked` | `aria-disabled="true"` |
  | Symbol | inner `svg[aria-label]` | inner `svg[aria-label]` (+ `data-testid="cell-zero\|cell-one"`) |
  | Edge marker | `svg[aria-label="Equal\|Cross"]`, wrapper `lotka-cell-edge--right\|--down` | same `aria-label`, hashed wrapper |

- **What is stable across BOTH (parse off these):**
  - **Cells:** every cell is a `[data-cell-idx]` element with `role="button"`
    (`data-cell-idx = 0 … N²-1`, row-major → `row = idx / N | 0`, `col = idx % N`).
    Grid = the element holding the largest cluster of these. N = `round(sqrt(cellCount))`, even.
  - **State/symbol:** the cell's inner `svg[aria-label]` is `"Sun"`, `"Moon"`, or `"Empty"`.
  - **Locked clue:** `aria-disabled === "true"`.
  - **Edges (`=` / `×`):** `svg[aria-label="Equal"|"Cross"]` **inside the grid** (scope
    it — a `Cross` icon also appears in the how-to-play legend). Direction: wrapper class
    `lotka-cell-edge--right|--down` if present, else **geometry** (the edge svg's centre
    is nearer the cell's right edge → `right`, nearer the bottom → `down`). An edge on
    cell `idx` with dir `right` constrains `idx ↔ idx+1`; `down` constrains `idx ↔ idx+N`.
  - **Tango signature:** cells carry `Sun`/`Moon`/`Empty` svgs, which distinguishes a
    Tango board from a Queens board (both use `[data-cell-idx]`).
- **Click cycle (verified live):** Empty → Sun (1 click) → Moon (2) → Empty (3).
- **Click mechanism:** identical to Queens — dispatch `pointerdown → mousedown →
  pointerup → mouseup → click` on the cell with real coordinates; `isTrusted:false` is
  accepted; state updates asynchronously (re-read `aria-label` after ~200 ms).

---

## The solver

`solve()` in `injected.js` — backtracking over cells in row-major order, each Sun(0) or
Moon(1). Pruning per candidate:

1. **No 3-in-a-row** — reject if the two preceding cells in the row or column already hold `v`.
2. **Balance** — reject if placing `v` would exceed N/2 of that symbol in the row or column.
3. **Edges** — reject if an `=`/`×` edge to an already-placed neighbour is violated.
4. **Locked** — locked cells are forced to their clue value.

Returns a per-cell target `{idx: "Sun"|"Moon"}` map, or null if unsolvable. Validated
live against puzzle #647: it produced the unique, fully-valid solution.

---

## Placement

For each **non-locked** cell, `clickUntil(el, targetSymbol)` reads the current
`svg[aria-label]` and clicks (cycling Empty→Sun→Moon→Empty) until it matches the target,
re-verifying after each ~200 ms click. Locked clues are skipped. Because every cell is
driven to its solution symbol, placement is idempotent from any partial state — no
separate "clear" step is needed.

---

## Install / run

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `Tango_Solver/` folder.
3. Open <https://www.linkedin.com/games/tango/> and **Start game**.
4. Click the extension icon; **Solve puzzle** enables once the board is detected. Click
   it — the grid fills and the game registers a win.

---

## Handling DOM drift (edge cases)

- **Grid lookup is id/class-agnostic:** collects all `[data-cell-idx]` and keeps the
  largest group sharing one parent — works for `div.lotka-grid` (guest) or
  `[data-testid="interactive-grid"]` (signed-in), and survives class-hash churn.
- **Edge direction:** wrapper class first, geometry fallback — robust to the signed-in
  DOM's hashed wrappers.
- **Board not ready / not Tango:** `detect` only reports solvable for a complete even
  N×N grid carrying Sun/Moon/Empty svgs, and the popup keeps polling, so the button
  enables itself once the game renders and never fires on a non-Tango board.
- **Partial progress:** `clickUntil` reaches the target from any current symbol, so a
  half-played board is corrected rather than corrupted.

If the click sequence ever stops working, re-inspect which events the widget listens for
(DevTools on the iframe, capturing listeners) and update `fireOneClick()` in `injected.js`.
