# Queens Auto-Solver (Chrome Extension, Manifest V3)

Automatically parses and solves the **LinkedIn Queens** game at
<https://www.linkedin.com/games/queens/>. Open the game, start a round, click the
extension's **Solve puzzle** button, and it places the queens for you.

> This README is written to give future maintainers (human or AI) the exact,
> **verified** facts about the page so the extension can be updated confidently.
> Every selector and behavior below was confirmed against the live DOM, not guessed.

---

## Repo structure

```
Queens_Solver/
├── manifest.json   # MV3 config: action popup + scripting/host permissions
├── injected.js     # The engine (parse → solve → place) as one self-contained func
├── popup.html      # Popup markup (loads injected.js then popup.js)
├── popup.js        # Popup logic: inject engine on demand, poll, enable Solve, settings menu
├── styles.css      # Popup styling: state-driven, light/dark aware
├── images/         # Toolbar/action icons (16/32/48/128 px)
└── README.md       # This file
```

### What each file does

| File | Responsibility |
| --- | --- |
| **manifest.json** | Declares an MV3 extension with a `default_popup`. **No content script** — the engine is injected on demand. Permissions: `scripting` (to inject) + `host_permissions` for `*://*.linkedin.com/*` (so injection/polling works without a fresh reload). |
| **injected.js** | The engine, exported as a single self-contained function `runQueens(mode)`. `mode:'detect'` returns `{solvable, N, solved}` — whether a board is present, its size, and whether it is **already finished**; `mode:'solve'` parses → solves (backtracking CSP) → places queens via the verified DOM event sequence, and short-circuits with `{ok:true, placed:0, alreadySolved:true}` if the board is already won (so a completed board is never clicked back out of its win state). It references nothing outside itself so `chrome.scripting.executeScript` can serialize it into the page's MAIN world. |
| **popup.html / popup.js** | The UI. `popup.js` calls `chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runQueens, args:['detect'\|'solve'] })`. On open it polls `detect` every 800 ms and enables **Solve** only once a board is found (so the user can let the game load; the solver only runs on click). Clicking runs `solve`. The popup is a small state machine: `checking → idle \| ready \| done → solving → solved \| error`. `done` means the board was already finished when we looked, and is kept distinct from `solved` (we did it) so the popup never claims credit it hasn't earned. The `STATES` table is the only place a state's copy and behavior are defined; `setState()` writes `data-state` on `<body>` and the CSS reacts to it, so the JS never touches styles. |
| **styles.css** | Popup styling, light/dark aware. Palette is sampled from `images/icon-128.png` (`#0072b1` field, `#ffbb00` crown): blue carries the brand and the *open game* action, gold is reserved for the one action that places crowns. Green/red are semantic only. Every per-state visual hangs off `body[data-state="…"]`. |
| **Board preview** | Once a board is detected the popup draws it instead of printing "Board detected · N×N": a live mini-grid of the colour regions, the player's crosses, and any crowns placed, redrawn after a solve so you can see the result. `detect` returns a plain-data `cells` snapshot for this (`{row, col, region, color, state}`). Region colours are read from the page's **rendered** `backgroundColor`, not by mapping the aria-label's colour *names* to hex — the names are LinkedIn's and a hardcoded map would drift the moment they retune the palette. If the page yields too few distinct swatches to tell the regions apart, the popup falls back to evenly-spaced generated hues keyed by region id, so the preview is never a flat block. The status line is only *visually* replaced — it stays in the a11y tree as a live region, and the grid carries a descriptive `role="img"` label. |
| **Header & menu** | The header shows the extension's own icon (loaded via `chrome.runtime.getURL`, trying 128 → 48 → 32 → 16 and hiding the `<img>` if none resolve, so a missing file never leaves a broken image) plus a cog button on the right. The cog opens a dropdown anchored to it holding a **More solvers** group (the other four solvers on the Web Store) above a separator and **Buy me a coffee**, each link `target="_blank"` + `rel="noopener noreferrer"`. On hover the cog turns once — a single full 360° rotation over 0.5s, then it settles (360° lands where it started, so there's no jump); it holds a 45° tilt while the menu is open. its gear is built from 8 teeth rotated about (12,12) plus a concentric ring, so it is symmetric by construction — a hand-plotted path drifted ~1.5 units off-centre, which showed as a lopsided hole and a wobble when spinning. The menu closes on outside pointerdown (capture phase), <kbd>Esc</kbd>, <kbd>Tab</kbd> and item activation; <kbd>Esc</kbd>/toggle return focus to the cog, while outside-click deliberately does not steal it. <kbd>↑</kbd>/<kbd>↓</kbd> rove through the items and wrap. |
| **images/** | PNG icons referenced by `manifest.json`. All four sizes must exist or Chrome refuses to load the extension. |

### Why on-demand injection (the v1.1 fix)

v1.0 used a content script + message passing. Content scripts inject only when a
page/iframe **loads**, so the engine was missing whenever the tab was already open
at install time, or the game iframe rendered after `document_idle`. The board then
appeared only after a forced reload — e.g. toggling the DevTools **device toolbar**,
which reloads the frame. v1.1 removes that timing dependency: the popup injects fresh
code into the live DOM (all frames) every time, so detection and solving are immune to
when the game loaded.

---

## Verified page facts (ground truth)

These were confirmed by inspecting the live page. If LinkedIn ships a redesign and
the extension stops working, re-verify these first.

- **The board is inside a same-origin iframe.**
  - Outer page: `www.linkedin.com/games/queens/`
  - Iframe: `<iframe class="game-launch-page__iframe w-full" src="https://www.linkedin.com/games/view/queens/desktop">`
  - ⇒ Injection uses `allFrames: true`; only the frame that actually has the board
    returns one, so the popup just picks that frame's result.
- **⚠️ The DOM differs between guest and signed-in sessions.** The parser must not
  depend on ids/classes that only exist in one. Two confirmed variants:

  | | Guest | Signed-in |
  | --- | --- | --- |
  | Grid container | `div#queens-grid.queens-grid-no-gap` | `[data-testid="interactive-grid"]` inside `<section id="queens-game-board">` |
  | Cell classes | `.queens-cell-with-border` + `cell-color-N` | fully **hashed** (e.g. `_41b25ea7`); **no `cell-color-N`** |
  | Cell id | `data-cell-idx` ✓ | `data-cell-idx` (+ `data-testid="cell-N"`) ✓ |
  | `aria-label` | ✓ (see below) | **identical** ✓ |

- **What is stable across BOTH (parse off these):**
  - **Cells:** every cell is a `[data-cell-idx]` element with `role="button"`
    (`data-cell-idx = 0 … N²-1`, row-major → `row = idx / N | 0`, `col = idx % N`).
  - **`aria-label`** encodes state **and region color**, e.g.
    `"Empty cell of color Lavender, row 1, column 1"`,
    `"Cross of color Soft Blue, row 5, column 5"`,
    `"Queen of color Pastel Green, row 2, column 8"`.
    → **Region id = the color name parsed from `aria-label`** (primary). The
    `cell-color-N` class is only a fallback for the guest DOM.
- **Grid size:** `N = round(sqrt(cellCount))` — never hardcode. Regions = N colors.
- **Partially-solved starter puzzles** (first couple of games when signed in) come
  with some queens pre-placed and locked (`aria-disabled="true"`). The solver runs
  from scratch; since the puzzle is uniquely solvable, its solution already contains
  those queens, and placement skips any cell that is already a Queen — so locked
  queens are left untouched and only the missing ones are filled.
- **Placed marks:** the inner markup differs by DOM (guest: `span.cell-input--queen`
  › `svg.queens-icon-svg`; signed-in: hashed spans + `svg[data-testid="queen-svg"]`),
  so **don't rely on it** — read state from the `aria-label` prefix instead:
  `Empty` / `Cross` / `Queen` (identical in both).
- **Click cycle:** one click = Cross, two = Queen, three = back to Empty.
- **Click mechanism (important):** the widget is **not** React (no `__reactFiber`
  keys) and **ignores pointer-only synthetic events**. The sequence that actually
  registers, dispatched on the cell, is:

  ```
  pointerdown → mousedown → pointerup → mouseup → click
  ```

  using this frame's event constructors with real `clientX/clientY`, `button:0`,
  `pointerId:1`, `pointerType:"mouse"` (`buttons:1` on down, `0` on up/click). The
  **MouseEvents are essential** — pointer events alone do nothing. `isTrusted:false`
  is accepted. **State updates asynchronously**, so re-read `aria-label` after a
  short delay rather than synchronously.

---

## The solver

Backtracking constraint-satisfaction solver in `injected.js` (`solve()`), placing
exactly one queen per row (which enforces the row rule and prunes hard). For each
candidate cell it checks:

1. **Column** not already used.
2. **Region** (color) not already used.
3. **Adjacency** — not touching any placed queen, including diagonally. With one
   queen per row/column, only the previous row can conflict, so it checks
   `|col − prevRowCol| ≤ 1`.

Returns an array of `{row, col}` or `null` if unsolvable.

---

## Install / run

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `Queens_Solver/` folder.
3. Open <https://www.linkedin.com/games/queens/> and **Start game**.
4. Click the extension icon. The **Solve puzzle** button enables once the board is
   detected. Click it — queens are placed and the game registers a win.

---

## Handling DOM drift (edge cases)

The code is written to degrade gracefully if LinkedIn changes the markup:

- **Grid lookup is id/class-agnostic:** `parseBoard()` collects all
  `[data-cell-idx]` elements and keeps the largest group sharing one parent, so it
  works whether the container is `#queens-grid` (guest) or `[data-testid=
  "interactive-grid"]` (signed-in), and survives class-hash churn.
- **Region id source:** primarily the color name in `aria-label` (present in both
  DOMs); falls back to a `cell-color-N` class, then to the cell's rendered
  background color. That last fallback matters because a cell's *label text*
  changes as it is filled (`Empty cell of color X` → `Queen of color X`) while its
  background does not — so a part-filled board can't read as more regions than
  there are rows, which used to surface as a bogus "board not found".
- **Board not ready:** `detect` only reports solvable for a complete N×N grid with N
  regions, and the popup keeps polling, so the button enables itself the moment the
  game finishes rendering.
- **Stray marks:** the header **Clear** button opens a confirmation modal (verified
  live), so the extension deliberately avoids it. Instead it resets cell-by-cell:
  every mark not part of the solution — wrong Queens *and* Crosses — is cycled back
  to empty before the solution is placed, so a half-finished wrong attempt doesn't
  end up layered underneath the answer. Locked starter queens (`aria-disabled`)
  are skipped, since clicking them does nothing and they're in the solution anyway.
- **Dropped rapid events:** ~200 ms delay between cells plus per-cell re-verification.

If the click sequence ever stops working, re-inspect which events the widget
listens for (open DevTools on the iframe, add capturing listeners) and update
`fireOneClick()` in `injected.js`.
