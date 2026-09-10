# Tango Auto-Solver (Chrome Extension, Manifest V3)

Automatically parses and solves the **LinkedIn Tango** game at
<https://www.linkedin.com/games/tango/>. Open the game, start a round, click the
extension's **Solve puzzle** button, and it fills the grid for you — timing how long
the solve takes. **Auto-solve is on by default** (toggle it off in the settings
menu): with it on, the puzzle solves the moment the board is on screen, no popup or
click needed (a content script handles that). A **Solve time** box (whole seconds,
1–999, default **5**) with a companion 1–60 slider sets how long the whole solve
should take, and the engine paces its clicks to land just over it (a 5 s target
finishes ~5.5 s).

> Written to give future maintainers (human or AI) the exact, **verified** facts about
> the page. Every selector and behaviour below was confirmed against the live guest
> board and a captured signed-in DOM — not guessed. Sibling extension: `../Queens_Solver`
> (same architecture; read its README for the shared injection/click/auto-solve design).

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
├── manifest.json   # MV3 config: action popup + content script + scripting/storage/host permissions
├── injected.js     # The engine (parse → solve → place) as one self-contained func; loaded by BOTH popup and content script
├── content.js      # Content script: auto-solves on game-page load, with no popup opened
├── popup.html      # Popup markup (loads injected.js then popup.js)
├── popup.js        # Popup logic: inject engine on demand, poll, enable Solve, auto-solve, timer, settings menu
├── styles.css      # Popup styling (light/dark aware)
├── images/         # Toolbar/action icons (16/32/48/128 px)
└── README.md       # This file
```

| File | Responsibility |
| --- | --- |
| **manifest.json** | MV3 with a `default_popup` **and** a `content_scripts` entry (`injected.js` + `content.js`, `all_frames`) on the Tango game URLs. Permissions: `scripting` (the popup injects on demand) + `storage` (shared settings) + `host_permissions` for `*://*.linkedin.com/*`. |
| **injected.js** | The engine as a single self-contained `runTango(mode, opts)`. `mode:'detect'` reports whether a solvable Tango board is present (plus a preview snapshot); `mode:'solve'` parses → solves (backtracking CSP) → fills cells via the verified click sequence. `opts.targetMs` (optional) paces the solve — see **Target time** below. References nothing outside itself so `chrome.scripting.executeScript` can serialize it into the page's MAIN world; the same file is loaded by the popup (`<script>`) and as a content script, so the engine never forks. A trailing `self.runTango = runTango` publishes it to the (isolated-world) global for `content.js`; the line isn't part of the function, so the popup's `executeScript({func: runTango})` never carries it. |
| **popup.html / popup.js** | UI. `popup.js` calls `executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runTango, args:['detect'\|'solve', opts] })`. Each poll first checks the active tab's URL against `linkedin.com/games/tango`; off the game page it drops straight to `idle` (**Open Tango game**) instead of flashing "Looking for puzzle…". (A tab's `url` is only readable for origins we hold host permission for, so a blank url is itself a "not the game" signal.) On the game page it polls `detect` every 800 ms; with a board present the button reads **"Solve puzzle"** and runs `solve` via the shared `runSolve()`. |
| **content.js** | The content script that makes **Auto-solve** work *without the popup being opened*. The browser guarantees to run it on a matching page (and, with `all_frames`, in the board's iframe) on every load — no service worker to wake. It runs in the **isolated world**, so it reads `chrome.storage` for the setting, and shares the page DOM, so it drives the same `runTango` (defined by `injected.js`, listed before it in the same entry) directly. If `autosolve` is on it polls `detect` until the board (which renders async in the iframe) is solvable, then runs `solve` with the stored `targetMs`; non-board frames bail quietly so only the game frame logs. Tagged `[Tango auto-solve]` console lines (in the **page** console, F12) trace the flow. |
| **Auto-solve** | A toggle (`role="menuitemcheckbox"`) in the settings menu, **on by default** (an explicit stored `false` is what `content.js` checks, so the default holds until you turn it off). When on, **`content.js` is the one that auto-solves** — on every game-page load, popup open or not. The popup deliberately does **not** also auto-solve when it merely *detects* a board on open: that would run a second solve concurrently with the content script (the "opening the popup makes it go twice as fast" bug fixed in Queens). The one popup-side auto-solve is the toggle itself: enabling it while a board is already `ready` solves once, there and then. If the popup is opened while `content.js` is solving, it mirrors that solve instead of offering a second one: `content.js` leaves a `data-autosolve` marker (with its start time and, once done, its result) on the board frame's `<html>`, and the popup reads it to show **Solving** — timer counting from the auto-solve's start — then **Solved** with its time. With Auto-solve on, the popup also keeps polling a `ready` board, so it catches a solve that starts after it opened. `content.js` itself polls until a board turns up however long that takes, rather than giving up after a few tries. |
| **Settings storage** | Both settings persist in the popup's **synchronous `localStorage`** (keys `autosolve`, `targetMs`): `chrome.storage.local.set` is async, and a popup closed right after a change can be torn down before that write flushes. The content script can't read the popup's `localStorage` (different origin), so the popup **also mirrors** to `chrome.storage.local` (same keys) — best-effort on each change, and re-asserted from `localStorage` every time the popup opens, so a lost mirror write self-heals. The `storage` permission is for that content-script-facing mirror. |
| **Target time** | How long the whole solve should take, set in the settings menu and stored as `targetMs`; both the popup and the content script pass it to `runTango` as `opts.targetMs`. **Two synced controls for one value**: a `type="text"` + `inputmode="numeric"` box for exact whole-seconds entry (**1–999** — filtered to ≤3 digits, clamped on commit `0`→`1` / blank→last good, stepped with ↑/↓) and a **slider** for the common **1–60** range that pins at 60 when the box holds a larger value. The engine counts the clicks each non-locked cell needs to walk the Empty→Sun→Moon cycle to its target, and `clickUntil` sleeps once per click, so it sets `delay = (targetMs + 500) / totalClicks`. The **+500 ms buffer** makes the real solve land just *over* the target, never under. The floor is **50 ms**, which only bites for a very short target. Omitting `targetMs` keeps the default 200 ms cadence. |
| **Completion timer** | A chip below the button that counts up live (`performance.now()`, 100 ms tick) while `runSolve()` places symbols, then freezes at the total on `solved`. Shown only in the `solving`/`solved` states. It's `aria-hidden` (a chip ticking every 100 ms would spam the a11y tree); the final figure is instead folded into the visually-hidden `solved` status line, which is a live region, so screen readers hear it once. Not shown for `done` — no solve of ours ran. |
| **Board preview** | Once a board is detected the popup draws the grid with the **solution's** Suns and Moons on it (locked clues tinted). The board is rounded + `overflow: hidden`, so `renderBoard`/`renderPlaceholder` tag the four corner cells (`--tl/--tr/--bl/--br`, any N) and CSS rounds them to match — otherwise the square corner cells are clipped. |
| **styles.css** | Popup styling, adapts to light/dark. Every per-state visual hangs off `body[data-state="…"]`. |

### Why on-demand injection for the popup (not a content script)

Same rationale as `Queens_Solver`: content scripts inject only when a page/iframe
*loads*, so the engine was missing whenever the tab predated the install or the game
iframe rendered late. Injecting fresh on every popup action removes that timing
dependency and is exempt from the page CSP that blocks in-page `eval`.

The auto-solve content script (`content.js`) is a *different* job and doesn't hit
that problem: auto-solve is meant to fire **on load**, which is exactly when a
content script runs, and it polls for the async iframe board rather than assuming
it's there. So the two mechanisms are complementary — on-demand injection for the
click-to-solve popup, a content script for solve-on-load — not a contradiction.

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

For each **non-locked** cell, `clickUntil(el, targetSymbol, delay)` reads the current
`svg[aria-label]` and clicks (cycling Empty→Sun→Moon→Empty) until it matches the target,
re-verifying after each click. `delay` is 200 ms by default, or paced to the
**Solve time** setting (see **Target time** above); `clickUntil` sleeps after the
landing click too, so there is no separate between-cell wait. Locked clues are skipped.
Because every cell is driven to its solution symbol, placement is idempotent from any
partial state — no separate "clear" step is needed.

---

## Install / run

1. `chrome://extensions` → enable **Developer mode**.
2. **Load unpacked** → select the `Tango_Solver/` folder.
3. Open <https://www.linkedin.com/games/tango/> and **Start game**.
4. With **Auto-solve** on (the default) the grid fills by itself once the board is on
   screen. Otherwise click the extension icon; **Solve puzzle** enables once the board
   is detected. Click it — the grid fills and the game registers a win.

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
