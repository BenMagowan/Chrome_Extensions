# Puzzle Solver (Chrome Extension, Manifest V3)

One Chrome extension for all six LinkedIn daily games: **Zip, Queens, Tango, Mini Sudoku, Patches, and Sumbreak**. It replaces the five single-game solvers and ships on the Zip Solver store listing as v2.0.0.

- **On a game page:** Open the popup to preview the solved board and click **Solve puzzle**. **Auto-solve** is on by default for every game, so boards solve automatically as soon as they appear, without opening the popup.
- **Per-game settings:** Click the cog icon to toggle **Auto-solve** or set the **Solve time** (1–999 seconds, default 5) for each game independently.
- **Off a game page:** The popup shows all six games in a 2×3 grid with each game's icon, today's puzzle number (`Zip #611`), and a green check when it's **Solved today**. (The game strip on a game page shows the same check.)
- **Solve all:** Click **Solve all** below the grid (always enabled) to open LinkedIn's games page, check which games are still unsolved, and solve them one by one.

## Solved today and Solve all

- **Today** follows LinkedIn's puzzle day, which resets at midnight Pacific time (`puzzleDay()` in `games.js`, using `America/Los_Angeles`). Puzzle numbers come from the latest visit to LinkedIn's games page (`hub.js`), or count forward from each game's `number` on `NUMBER_DAY`.
- **Solved today** is saved as `solved:<id>` = the puzzle day in `chrome.storage.local` whenever a finished board is seen: after `content.js` solves it, when it detects an already-solved board (even with Auto-solve off, so manual solves count too), or when the popup enters a solved state. It only tracks what this browser has seen; puzzles finished on another device appear as solved once opened here (Solve all checks every unsolved game, so it picks those up too).
- **Solve all** runs in `background.js`, reusing the tab the popup was opened on. Navigating that tab keeps focus in place so the popup stays open to show progress (opening a new tab would close it), and keeps the tab in the foreground so timers aren't throttled. A run works in two steps:
  1. **Check the games page (`linkedin.com/games/`).** `hub.js` reads each game card, records today's puzzle numbers and solved games, and reports back so the worker can skip already-solved games. LinkedIn marks solved cards only by swapping the artwork for a version with a green check, so `hub.js` matches those known filenames (captured 2026-11-18 in `tests/fixtures/games-hub.html`). Any unknown artwork counts as unsolved, so if LinkedIn updates the images, Solve all simply opens that game to check. When signed out (such as in incognito), LinkedIn uses a guest layout (`tests/fixtures/games-hub-guest.html`) with no puzzle numbers or completion state, so every game is opened and checked on its own page. If the game list never loads, `hub.js` reports empty after 15 s.
  2. **Solve the remaining games.** When signed in, each game opens with `?skipStartScreen=true` to bypass LinkedIn's start screen. When signed out, LinkedIn redirects that URL back to the games page unless followed from the game itself, so Solve all opens the plain URL and clicks **Start game**. If a game still redirects back to the games page, it retries once with the plain URL, then skips it. On each page, `content.js` checks with the worker whether its tab belongs to the run, solves even if Auto-solve is off, and reports back so the worker advances. Start screens are dismissed by clicking **Start game** (only when the link stays on the same game) or Mini Sudoku's **Solve now**, matched across the extension's five languages. If a board never appears, the run moves on after 45 s.

  If a run makes no progress for 60 s (plus the game's Solve time once solving begins), it clears automatically so leaving the tab, reloading the extension, or quitting the browser never leaves it stuck. Run state lives in storage (`solveAllRun`), progress shows on the toolbar badge (`…` on the games page, then `2/4`), and closing the tab, restarting the browser, or clicking **Stop** ends the run. Clicking **Stop** clears the remaining queue; a game already mid-solve finishes. No new permissions are needed because the games page is already covered by `linkedin.com/games/*`.
- **Incognito** stores its own solved days (`incognito:solved:<id>`). Incognito windows share extension storage but not LinkedIn sign-in, so a guest session shouldn't inherit the signed-in account's progress. The popup checks its window (`chrome.windows.getCurrent`), content scripts check `inIncognitoContext`, and the worker clears incognito records when the last incognito window closes.
- Visiting LinkedIn's games page manually updates the same checks and puzzle numbers, even without running Solve all.

## Layout

```
Puzzle_Solver/
├── manifest.json        # one content_scripts entry per game; same permissions as the old solvers
├── games.js             # the six games: names, URLs, engines, colours, puzzle numbers; settings, puzzle-day and solved helpers
├── content.js           # auto-solve on page load, solved-today tracking and Solve all, for whichever game's engine the manifest loaded
├── hub.js               # on LinkedIn's games page: which games are solved today, and their numbers
├── background.js        # runs Solve all; opens the site's welcome page on first install; sets the uninstall page
├── site.js              # links to the puzzle site
├── popup.html/.js       # the popup: game strip, board, Solve, game grid, Solve all, settings
├── previews.js          # registry for the per-game board previews
├── base.css             # the popup styles shared with the single-game solvers
├── popup.css            # LinkedIn's palette, strip, game grid, Solve all, settings, and Sumbreak's board
├── i18n.js, _locales/   # generated by scripts/build_locales.py
├── games/
│   ├── games.css        # each game's colours and board preview, scoped to <html data-game="…">
│   └── <id>/
│       ├── injected.js  # the engine: runZip, runQueens, runTango, runSudoku, runPatches, runSumbreak
│       └── preview.js   # draws that game's board in the popup
├── images/              # toolbar icons; games/ holds the per-game icons
└── tests/               # see Tests below
```

The engines for the original five games, their board previews and their preview styles
are copied verbatim from the single-game solvers. Each solver's README still documents
its game's DOM and input. Each engine is still one self-contained function, serialised
into the page by `chrome.scripting.executeScript` for the popup and loaded as a content
script for auto-solve.

## How the pieces find each other

- **Manifest:** each game's content-script entry loads `games.js`, then that game's
  `games/<id>/injected.js`, then `content.js`. `content.js` finds which engine is
  defined in its scope, so one file drives every game.
- **Popup:** `gameForUrl()` maps the active tab to a game. `<html data-game>` is set to
  that game's id, and `games.css` / `popup.css` scope each game's colours and board styles
  to it. The popup calls the game's engine by name and its preview by id.
- **Game-specific popup text:** this is in `messages.json` under `<id>_` keys
  (`zip_stSolved`, `sumbreak_stSolving`, …).

## Settings

Settings are stored per game in one object, `{ zip: { autosolve, targetMs }, … }`, under
the key `settings`. The popup writes it to `localStorage` (synchronous, so a change
survives the popup closing at once) and mirrors it to `chrome.storage.local` for
`content.js`.

**Upgrading from Zip Solver:** Because this extension updates the Zip Solver store listing, existing users keep their extension ID, `localStorage`, and `chrome.storage`. Legacy `autosolve` and `targetMs` keys apply to **Zip** until Zip's entry is first written (`settingsFor()` in `games.js`). The other five games start with the defaults.

## Sumbreak

Rules (from the game's how-to-play, `tests/fixtures/sumbreak-how-to-play.png`): merge
two orthogonally adjacent tiles with the same number into their sum, until one number
remains. The engine:

- reads the board from `data-numo-*` attributes and the tiles' `aria-label`s;
- finds a full merge order by memoised search;
- makes each merge by tap-tap, falling back to a pointer drag;
- re-reads the board after every merge and re-plans from what's actually there.

**Checked on the live game** (2026-11-18): Solve all solved it, signed in and signed
out. The board captures don't show how the game takes a merge, so the engine still
tries both tap-tap and drag and remembers which one worked.

## Tests

From the repo root (Playwright comes from `../Website/node_modules`):

| Command | What it checks |
| --- | --- |
| `node Puzzle_Solver/tests/extension.test.mjs` | Loads the unpacked extension in headless Chromium, serves the mock Sumbreak page at the real game URL, and checks that auto-solve solves it (tap and drag), stays off when switched off, and keeps settings per game; and that Solve all solves with Auto-solve off, moves its tab on, records the day, and clears its badge. |
| `node Puzzle_Solver/tests/sumbreak.test.mjs` | The Sumbreak engine on the mock: the guest board, generated 3×3 to 5×5 boards, solved, unsolvable and missing boards, the busy lock, and running after `Function.prototype.toString`. |
| `node Puzzle_Solver/tests/popup-shots.mjs [dir]` | Screenshots of the popup with a stubbed `chrome.*`, sample boards, and some games solved today, including a Solve all run in progress (written to `docs/puzzle-solver/`). |

The mock (`tests/mock/sumbreak-mock.html`) follows the official rules and the DOM of the
board captures in `tests/fixtures`. It isn't LinkedIn's code.

## Before publishing

Solve all is verified live (2026-11-18), signed in and signed out: all six games,
Sumbreak included, solved (about 45 s signed out).

1. Replace the placeholder toolbar icon (`images/icon-*.png`, made from four game icons).
2. Package without the tests:
   `cd Puzzle_Solver && zip -r ../Puzzle_Solver.zip . -x 'tests/*' README.md`
3. Upload to the **Zip Solver** listing as an update. Keep the permissions as they are,
   so Zip users get it without having to re-approve.
