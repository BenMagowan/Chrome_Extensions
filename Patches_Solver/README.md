# Patches Auto-Solver (Chrome Extension, Manifest V3)

Automatically parses and solves LinkedIn **Patches** puzzles at
<https://www.linkedin.com/games/patches/>. Open the game, start a round, click the
extension's **Solve puzzle** button, and it draws the patches for you — timing how long
the solve takes. **Auto-solve is on by default** (toggle it off in the settings menu):
with it on, the puzzle solves the moment the board is on screen, no popup or click
needed (a content script handles that). A **Solve time** box (whole seconds, 1–999,
default **5**) with a companion 1–60 slider sets how long the whole solve should take,
and the engine paces its key presses to land just over it (a 5 s target finishes
~5.5 s).

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
| **manifest.json** | Declares an MV3 extension with a `default_popup` **and** a `content_scripts` entry (`injected.js` + `content.js`, `all_frames`) on the Patches game URLs. Permissions: `scripting` (the popup injects on demand) + `storage` (shared settings) + `host_permissions` for `*://*.linkedin.com/*`. |
| **injected.js** | The engine, a single self-contained function `runPatches(mode, opts)`. `mode:'detect'` reports whether a board is present and solvable (plus a preview snapshot); `mode:'solve'` parses → solves (rectangle exact-cover) → draws each patch with the verified keyboard sequence. `opts.targetMs` (optional) paces the solve — see **Target time** below. Self-contained so `chrome.scripting.executeScript` can serialize it into the page's MAIN world; the same file is loaded by the popup (`<script>`) and as a content script, so the engine never forks. A trailing `self.runPatches = runPatches` publishes it to the (isolated-world) global for `content.js`; the line isn't part of the function, so the popup's `executeScript({func: runPatches})` never carries it. |
| **popup.html / popup.js** | The UI. `popup.js` calls `chrome.scripting.executeScript({ target:{tabId, allFrames:true}, world:'MAIN', func: runPatches, args:['detect'\|'solve', opts] })`. Each poll first checks the active tab's URL against `linkedin.com/games/patches`; off the game page it drops straight to `idle` (**Open Patches game**) instead of flashing "Looking for puzzle…". (A tab's `url` is only readable for origins we hold host permission for, so a blank url is itself a "not the game" signal.) On the game page it polls `detect` every 800 ms and enables **Solve** once a solvable board is found — or shows `stuck` for a board that's there but can't be tiled. Clicking runs `solve` via the shared `runSolve()`. |
| **content.js** | The content script that makes **Auto-solve** work *without the popup being opened*. The browser guarantees to run it on a matching page (and, with `all_frames`, in an iframe if the board is in one) on every load — no service worker to wake. It runs in the **isolated world**, so it reads `chrome.storage` for the setting, and shares the page DOM, so it drives the same `runPatches` (defined by `injected.js`, listed before it in the same entry) directly — including the focus and synthetic `KeyboardEvent`s, which the page's listeners see just as they do from the MAIN world. If `autosolve` is on it polls `detect` until the board is solvable, then runs `solve` with the stored `targetMs`; frames without a board bail quietly so only the game frame logs. Tagged `[Patches auto-solve]` console lines (in the **page** console, F12) trace the flow. |
| **Auto-solve** | A toggle (`role="menuitemcheckbox"`) in the settings menu, **on by default** (an explicit stored `false` is what `content.js` checks, so the default holds until you turn it off). When on, **`content.js` is the one that auto-solves** — on every game-page load, popup open or not. The popup deliberately does **not** also auto-solve when it merely *detects* a board on open: that would run a second solve concurrently with the content script (the "opening the popup makes it go twice as fast" bug fixed in Queens). The one popup-side auto-solve is the toggle itself: enabling it while a board is already `ready` solves once, there and then. If the popup is opened while `content.js` is solving, it mirrors that solve instead of offering a second one: `content.js` leaves a `data-autosolve` marker (with its start time and, once done, its result) on the board frame's `<html>`, and the popup reads it to show **Solving** — timer counting from the auto-solve's start — then **Solved** with its time. With Auto-solve on, the popup also keeps polling a `ready` board, so it catches a solve that starts after it opened. `content.js` itself polls until a board turns up however long that takes, rather than giving up after a few tries. |
| **Settings storage** | Both settings persist in the popup's **synchronous `localStorage`** (keys `autosolve`, `targetMs`): `chrome.storage.local.set` is async, and a popup closed right after a change can be torn down before that write flushes. The content script can't read the popup's `localStorage` (different origin), so the popup **also mirrors** to `chrome.storage.local` (same keys) — best-effort on each change, and re-asserted from `localStorage` every time the popup opens, so a lost mirror write self-heals. The `storage` permission is for that content-script-facing mirror. |
| **Target time** | How long the whole solve should take, set in the settings menu and stored as `targetMs`; both the popup and the content script pass it to `runPatches` as `opts.targetMs`. **Two synced controls for one value**: a `type="text"` + `inputmode="numeric"` box for exact whole-seconds entry (**1–999** — filtered to ≤3 digits, clamped on commit `0`→`1` / blank→last good, stepped with ↑/↓) and a **slider** for the common **1–60** range that pins at 60 when the box holds a larger value. Drawing a patch is Arrow presses to its top-left corner, `Enter` (anchor), Arrow presses to its bottom-right, `Enter` (commit), with one sleep per press. `goto()` steps vertically then horizontally, so the whole route's press count is known up front from where the cursor sits once the board is clear. Getting there takes a variable while (entering grid mode, erasing a part-drawn board), so the engine budgets the drawing with whatever is *left* of (`targetMs` + 500 ms): `delay = (targetMs + 500 − elapsed) / presses`, floor **50 ms**, used for every press. The **+500 ms buffer** makes the real solve land just *over* the target, never under. Omitting `targetMs` keeps the verified cadence (70 ms per Arrow, 120 / 150 ms after the anchor / commit `Enter`). |
| **Completion timer** | A chip below the button that counts up live (`performance.now()`, 100 ms tick) while `runSolve()` draws the patches, then freezes at the total on `solved`. Shown only in the `solving`/`solved` states. It's `aria-hidden` (a chip ticking every 100 ms would spam the a11y tree); the final figure is instead folded into the visually-hidden `solved` status line, which is a live region, so screen readers hear it once. Not shown for `done` — no solve of ours ran. |
| **Board preview** | Once a board is detected the popup draws it tiled into the **solution's** patches (one golden-angle hue each) with the clues on top. The board is rounded + `overflow: hidden`, so `buildGrid` tags the four corner cells (`--tl/--tr/--bl/--br`, from rows and cols separately since boards needn't be square) and CSS rounds them to match — otherwise the corner cells' patch colours are clipped into a dark notch. |
| **styles.css** | Popup styling, adapts to light/dark. Every per-state visual hangs off `body[data-state="…"]`. |
| **images/** | PNG icons referenced by `manifest.json` (all four sizes must exist). |

### Why on-demand injection for the popup

The popup's engine is injected on demand rather than as a pre-injected content script,
so it is immune to when the game loaded and needs no "reload after install". (Same
design as `Queens_Solver` — see its README.)

The auto-solve content script (`content.js`) is a *different* job and doesn't hit
that problem: auto-solve is meant to fire **on load**, which is exactly when a
content script runs, and it polls for the board rather than assuming it's there. So
the two mechanisms are complementary — on-demand injection for the click-to-solve
popup, a content script for solve-on-load — not a contradiction.

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
4. With **Auto-solve** on (the default) the patches draw themselves once the board is on
   screen. Otherwise click the extension icon; **Solve puzzle** enables once a board is
   detected — click it to draw the patches.

---

## Verification status

- **Parser:** verified live on the guest board (reads all clues and grid size), including
  No. 122's `ANY` and unnumbered clues.
- **Solver:** verified against the signed-in rectangle sample and the live No. 122 guest
  board — tiling independently checked for full single coverage, per-clue shape/area
  compliance, and one clue per patch.
- **Keyboard fill:** verified live — the real `fill()` code drew rectangles via synthetic
  `KeyboardEvent`s, each region auto-coloured by its clue.
- **Auto-solve and Solve-time pacing:** ported from Queens V1.6; **not yet verified live
  on Patches.** `goto()` re-reads the cursor every step and each `Enter` is only pressed
  once the cursor is confirmed on its corner, so a too-short target should show up as
  extra presses or "Cursor navigation failed." rather than a wrong rectangle — if it
  does, raise `MIN_PRESS_MS` in `injected.js` towards the verified 70 ms.
- **End-to-end win:** re-verify periodically against the live daily, as with the other
  solvers, in case LinkedIn changes the board markup.
