# Queens Auto-Solver (Chrome Extension, Manifest V3)

Automatically parses and solves the **LinkedIn Queens** game at
<https://www.linkedin.com/games/queens/>. Open the game, start a round, click the
extension's **Solve puzzle** button, and it places the queens for you — timing how
long the solve takes. **Auto-solve is on by default** (toggle it off in the settings
menu): with it on, the puzzle solves the moment the board is on screen, no popup or
click needed (a content script handles that — it waits through the "Start" splash
and solves once you start the round). A **Solve time** box (whole seconds, 1–999,
default **5**) with a companion 1–60 slider sets how long the whole solve should
take, and the engine paces its clicks to land just over it (a 5 s target finishes
~5.5 s).

> A `?skipStartScreen=true` on the game URL skips the splash for a fully hands-free
> auto-solve, but only while **signed in** — a signed-out / private-window session
> redirects it to `/games/` — so the **Open Queens game** button uses the plain URL.

> This README is written to give future maintainers (human or AI) the exact,
> **verified** facts about the page so the extension can be updated confidently.
> Every selector and behavior below was confirmed against the live DOM, not guessed.

---

## Repo structure

```
Queens_Solver/
├── manifest.json   # MV3 config: action popup + content script + scripting/storage/host permissions
├── injected.js     # The engine (parse → solve → place) as one self-contained func; loaded by BOTH popup and content script
├── content.js      # Content script: auto-solves on game-page load, with no popup opened
├── popup.html      # Popup markup (loads injected.js then popup.js)
├── popup.js        # Popup logic: inject engine on demand, poll, enable Solve, auto-solve, timer, settings menu
├── styles.css      # Popup styling: state-driven, light/dark aware
├── images/         # Toolbar/action icons (16/32/48/128 px)
└── README.md       # This file
```

### What each file does

| File | Responsibility |
| --- | --- |
| **manifest.json** | Declares an MV3 extension with a `default_popup` **and** a `content_scripts` entry (`injected.js` + `content.js`) on the Queens game URLs. Permissions: `scripting` (the popup injects on demand) + `storage` (shared settings) + `host_permissions` for `*://*.linkedin.com/*`. |
| **injected.js** | The engine, exported as a single self-contained function `runQueens(mode, opts)`. `mode:'detect'` returns `{solvable, N, solved}` — whether a board is present, its size, and whether it is **already finished**; `mode:'solve'` parses → solves (backtracking CSP) → places queens via the verified DOM event sequence, and short-circuits with `{ok:true, placed:0, alreadySolved:true}` if the board is already won (so a completed board is never clicked back out of its win state). `opts.targetMs` (optional) paces the solve — see **Target time** below. It references nothing outside itself so `chrome.scripting.executeScript` can serialize it into the page's MAIN world; the same file is loaded by the popup (`<script>`) and as a content script, so the engine never forks. A trailing `self.runQueens = runQueens` publishes it to the (isolated-world) global so `content.js` can call it whatever scope Chrome gives each content-script file; the line isn't part of the function, so the popup's `executeScript({func: runQueens})` never carries it. |
| **popup.html / popup.js** | The UI. `popup.js` calls `chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runQueens, args:['detect'\|'solve'] })`. Each poll first checks the active tab's URL against `linkedin.com/games/queens`; off the game page it drops straight to `idle` (**Open Queens game**) instead of flashing "Looking for puzzle…", which only makes sense on the game itself. (A tab's `url` is only readable for origins we hold host permission for, so a blank url is itself a "not the game" signal.) On the game page it polls `detect` every 800 ms and enables **Solve** only once a board is found (so the user can let the game load; the solver only runs on click). Clicking runs `solve` via the shared `runSolve()`. The popup is a small state machine: `checking → idle \| ready \| done → solving → solved \| error`. `done` means the board was already finished when we looked, and is kept distinct from `solved` (we did it) so the popup never claims credit it hasn't earned. The `STATES` table is the only place a state's copy and behavior are defined; `setState()` writes `data-state` on `<body>` and the CSS reacts to it, so the JS never touches styles. |
| **content.js** | The content script that makes **Auto-solve** work *without the popup being opened*. The browser guarantees to run it on a matching page (and, with `all_frames`, in the board's iframe) on every load — no service-worker wake-up to depend on, which is why the old `background.js` worker was replaced (an MV3 worker sleeps, and whether `tabs.onUpdated` reliably woke it and handed over the URL was the flaky bit — the symptom being "auto-solve only works once you click the popup"). It runs in the **isolated world**, so it reads `chrome.storage` for the setting, and shares the page DOM, so it drives the same `runQueens` (defined by `injected.js`, listed before it in the same entry) directly. If `autosolve` is on it polls `detect` until the board (which renders async in the iframe) is solvable, then runs `solve` with the stored `targetMs`; non-board frames bail quietly so only the game frame logs. Tagged `[Queens auto-solve]` console lines (in the **page** console, F12) trace the flow. The dispatched events are `isTrusted:false` in every world — same as the MAIN-world path that's known to work — so the game accepts them here too. |
| **Auto-solve** | A toggle (`role="menuitemcheckbox"`) in the settings menu, **on by default** (turn it off there to opt out — an explicit `false` is what `content.js` checks, so the default holds until you do). When on, **`content.js` is the one that auto-solves** — on every game-page load, popup open or not. The popup deliberately does **not** also auto-solve when it merely *detects* a board on open: that used to run a second solve concurrently with the content script (the "opening the popup makes it go twice as fast" bug). The one popup-side auto-solve left is the toggle itself: enabling it while a board is already `ready` solves once, there and then. If the popup is opened while `content.js` is solving, it mirrors that solve instead of offering a second one: `content.js` leaves a `data-autosolve` marker (with its start time and, once done, its result) on the board frame's `<html>`, and the popup reads it to show **Solving** — timer counting from the auto-solve's start — then **Solved** with its time. With Auto-solve on, the popup also keeps polling a `ready` board, so it catches a solve that starts after it opened. `content.js` itself polls until a board turns up however long that takes, rather than giving up after a few tries. |
| **Settings storage** | Both settings persist in the popup's **synchronous `localStorage`** (keys `autosolve`, `targetMs`), which is the fix for them not sticking: `chrome.storage.local.set` is async, and a popup closed right after a change can be torn down before that write flushes. The content script can't read the popup's `localStorage` (different origin), so the popup **also mirrors** to `chrome.storage.local` (same keys) — best-effort on each change, and re-asserted from `localStorage` every time the popup opens, so a lost mirror write self-heals. The `storage` permission is for that content-script-facing mirror. |
| **Target time** | How long the whole solve should take, set in the settings menu and stored as `targetMs`; both the popup and the content script pass it to `runQueens` as `opts.targetMs`. **Two synced controls for one value**: a `type="text"` + `inputmode="numeric"` box for exact whole-seconds entry (**1–999** — filtered to ≤3 digits, clamped on commit `0`→`1` / `9999`→`999` / blank→last good, stepped with ↑/↓) and a **slider** for the common **1–60** range that pins at 60 when the box holds a larger value; `setTargetSecs` mirrors either onto the other. The engine knows each changed cell costs a fixed number of clicks to walk the empty→cross→queen cycle, and `clickUntil` sleeps once per click, so the click loop takes ≈ (clicks × delay); it inverts that to `delay = (targetMs + 500) / totalClicks`. The **+500 ms buffer** makes the real solve land comfortably *over* the target (a 1 s target ≈ 1.5 s, a 10 s target ≈ 10.5 s), never under. The floor is **50 ms** (was 120, which pinned the quickest solve on a normal 16-click board at ~2 s); it only bites for a very short target on a very large board. Because it's per-*click*, the solve lands near the target regardless of board size. Omitting `targetMs` keeps the default 200 ms cadence. |
| **Completion timer** | A chip below the button that counts up live (`performance.now()`, 100 ms tick) while `runSolve()` places crowns, then freezes at the total on `solved` (which settles near the **Target time** above). Shown only in the `solving`/`solved` states. It's `aria-hidden` (a chip ticking every 100 ms would spam the a11y tree); the final figure is instead folded into the visually-hidden `solved` status line, which is a live region, so screen readers hear it once. Not shown for `done` — no solve of ours ran, so there's no time to quote. |
| **styles.css** | Popup styling, light/dark aware. Palette is sampled from `images/icon-128.png` (`#0072b1` field, `#ffbb00` crown): blue carries the brand and the *open game* action, gold is reserved for the one action that places crowns. Green/red are semantic only. Every per-state visual hangs off `body[data-state="…"]`. |
| **Board preview** | Once a board is detected the popup draws it instead of printing "Board detected · N×N": a live mini-grid of the colour regions, the player's crosses, and any crowns placed, redrawn after a solve so you can see the result. `detect` returns a plain-data `cells` snapshot for this (`{row, col, region, color, state}`). Region colours are read from the page's **rendered** `backgroundColor`, not by mapping the aria-label's colour *names* to hex — the names are LinkedIn's and a hardcoded map would drift the moment they retune the palette. If the page yields too few distinct swatches to tell the regions apart, the popup falls back to evenly-spaced generated hues keyed by region id, so the preview is never a flat block. The status line is only *visually* replaced — it stays in the a11y tree as a live region, and the grid carries a descriptive `role="img"` label. The board is rounded + `overflow: hidden`, so `renderBoard`/`renderPlaceholder` tag the four corner cells (`--tl/--tr/--bl/--br`, any N) and CSS rounds them to match — otherwise the square corner cells' colours are clipped into a dark notch. |
| **Header & menu** | The header shows the extension's own icon (loaded via `chrome.runtime.getURL`, trying 128 → 48 → 32 → 16 and hiding the `<img>` if none resolve, so a missing file never leaves a broken image) plus a cog button on the right. The cog opens a dropdown anchored to it holding a **Settings** group (the **Auto-solve** toggle and the **Solve time** box) above a separator, then a **More solvers** group (the other four solvers on the Web Store) above another separator and **Buy me a coffee**, each link `target="_blank"` + `rel="noopener noreferrer"`. Activating a link closes the menu; changing a setting deliberately leaves it open so the switch/box/slider is seen to change. The Solve-time box and slider are plain `<input>`s, not menu roles — the box takes keyboard digits and its own <kbd>↑</kbd>/<kbd>↓</kbd> stepping and the slider its native keys, so the menu's <kbd>↑</kbd>/<kbd>↓</kbd> roving is skipped while either is focused. On hover the cog turns once — a single full 360° rotation over 0.5s, then it settles (360° lands where it started, so there's no jump); it holds a 45° tilt while the menu is open. its gear is built from 8 teeth rotated about (12,12) plus a concentric ring, so it is symmetric by construction — a hand-plotted path drifted ~1.5 units off-centre, which showed as a lopsided hole and a wobble when spinning. The menu closes on outside pointerdown (capture phase), <kbd>Esc</kbd>, <kbd>Tab</kbd> and item activation; <kbd>Esc</kbd>/toggle return focus to the cog, while outside-click deliberately does not steal it. <kbd>↑</kbd>/<kbd>↓</kbd> rove through the items and wrap. |
| **images/** | PNG icons referenced by `manifest.json`. All four sizes must exist or Chrome refuses to load the extension. |

### Why on-demand injection (the v1.1 fix)

v1.0 used a content script + message passing **for the popup's solve**. Content
scripts inject only when a page/iframe **loads**, so the engine was missing whenever
the tab was already open at install time, or the game iframe rendered after
`document_idle`. The board then appeared only after a forced reload — e.g. toggling
the DevTools **device toolbar**, which reloads the frame. v1.1 removes that timing
dependency for the **popup**: it injects fresh code into the live DOM (all frames)
every time it's clicked, so a user-triggered solve is immune to when the game loaded.

The auto-solve content script (`content.js`) is a *different* job and doesn't hit
that problem: auto-solve is meant to fire **on load**, which is exactly when a
content script runs, and it polls for the async iframe board rather than assuming
it's there. So the two mechanisms are complementary — on-demand injection for the
click-to-solve popup, a content script for solve-on-load — not a contradiction.

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
