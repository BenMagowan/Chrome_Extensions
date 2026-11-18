# Puzzle Solver (Chrome Extension, Manifest V3)

One extension for all six LinkedIn games: **Zip, Queens, Tango, Mini Sudoku, Patches
and Sumbreak**. It replaces the five single-game solvers and ships on the Zip Solver's
store listing, as version 2.0.0.

Open a game and the popup shows that game's board with the solution, and a **Solve
puzzle** button. **Auto-solve** is on by default for every game: the board solves as
soon as it's on screen, with no popup needed. Each game has its own Auto-solve switch
and **Solve time** (whole seconds, 1–999, default 5) in the settings menu (the cog).
Off a game page, the popup shows the six games as a 2×3 grid in the style of
LinkedIn's games page: each card has the game's art on its tint, today's puzzle
number ("Zip #611") and whether it's **Solved today**, with LinkedIn's green check.
On a game page, the game strip carries the same check. Under the grid, **Solve all**
(always available) opens LinkedIn's games page, sees which games are still
unsolved there, and solves them in one go.

## Solved today and Solve all

- **Today** is the puzzle day: LinkedIn releases new puzzles at midnight Pacific
  time, so the day is the date in Los Angeles (`puzzleDay()` in `games.js`). Puzzle
  numbers are the ones last read off LinkedIn's games page today (`hub.js`), or
  else count on from the `number` each game had on `NUMBER_DAY`.
- **Solved today** is recorded as `solved:<id>` = the day, in `chrome.storage.local`,
  whenever a board is seen finished: by `content.js` after it solves, or when it
  finds a board already solved (with Auto-solve off it keeps watching, so a puzzle
  solved by hand counts too), and by the popup's solved states. It only knows what
  this browser has seen: a puzzle finished on another device shows as solved once
  its page is opened here and shows the finished board (Solve all opens every
  unsolved game, so it picks these up too).
- **Solve all** is run by `background.js`, in the tab the popup was opened on.
  Changing that tab's page doesn't take focus, so the popup stays open and follows
  the run (a new tab would close it), and the tab stays in front (a background
  tab's timers are throttled). The run:
  1. Loads LinkedIn's games page (`linkedin.com/games/`). `hub.js` reads each
     game's card there, records today's puzzle number and which are solved, and
     reports; the worker drops the solved ones. The page shows "solved" only as a
     green check drawn into the game's art, so `hub.js` knows the solved art's
     files (as captured on 2026-11-18, `tests/fixtures/games-hub.html`); any
     other art counts as not solved, so if LinkedIn changes it the run just opens
     that game too. Signed out (in an incognito window, say) the page has another
     layout (`tests/fixtures/games-hub-guest.html`) with no numbers and no sign of
     a guest's progress, so every game is opened; one already finished is found
     on its own page. A page that never shows the list is reported empty after 15 s.
  2. Walks the tab through the rest. Signed in, each opens with
     `?skipStartScreen=true`, LinkedIn's own switch past the start screen. Signed
     out, LinkedIn redirects that URL to the games page unless it's followed from
     the game itself, so the plain URL is opened and the page presses its
     **Start game** link (which is that URL). A game sent back to the games page
     anyway is retried once by its plain URL, then skipped. `content.js` asks the worker whether its
     tab is the run's, then solves even with that game's Auto-solve off and
     reports back; the worker moves on. Start screens are passed by pressing
     **Start game** (a link, pressed only if it leads to the same game) or Mini
     Sudoku's **Solve now** (a button), matched by label in the extension's five
     languages. A page whose board never appears
     gives up after 45 s.

  A run that makes no progress for 60 s (plus the game's Solve time once it's
  solving) is cleared, so a tab that leaves the game, an extension reload or a
  browser quit never leaves one stuck. The run lives in storage (`solveAllRun`),
  progress shows on the toolbar badge ("…" on the games page, then "2/4"), and
  closing the tab, a browser restart, or **Stop** in the popup ends it. Stop ends
  the queue; a game already mid-solve finishes. No new permissions: the games page
  is already covered by the solvers' `linkedin.com/games/*` access.
- **Incognito** keeps its own solved days (`incognito:solved:<id>`): its windows
  share this extension's storage but not LinkedIn's sign-in, so a guest there
  hasn't solved what the signed-in account has. The popup picks them by its window
  (`chrome.windows.getCurrent`), content scripts by `inIncognitoContext`, and the
  worker clears them when the last incognito window closes.
- Opening the games page yourself records the same things, so the grid's checks
  and numbers stay right without a run.

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

**Moving from the Zip Solver:** this extension takes over the Zip Solver's listing, so
existing Zip users keep their extension ID, `localStorage` and `chrome.storage`. Their
old `autosolve` / `targetMs` keys are read as **Zip's** settings until Zip's entry is
first written (`settingsFor()` in `games.js`). Every other game starts at the defaults.

## Sumbreak

Rules (from the game's how-to-play, `tests/fixtures/sumbreak-how-to-play.png`): merge
two orthogonally adjacent tiles with the same number into their sum, until one number
remains. The engine:

- reads the board from `data-numo-*` attributes and the tiles' `aria-label`s;
- finds a full merge order by memoised search;
- makes each merge by tap-tap, falling back to a pointer drag;
- re-reads the board after every merge and re-plans from what's actually there.

**Not yet checked on the live game:** the two board captures don't show how the game
takes a merge, so the engine tries both tap-tap and drag and remembers which one
worked. Run it once on the real page before publishing.

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

1. Run Solve all once signed in. Signed out it's verified live (2026-11-18): all
   six games, Sumbreak included, solved in about 45 s.
2. Replace the placeholder toolbar icon (`images/icon-*.png`, made from four game icons).
3. Package without the tests:
   `cd Puzzle_Solver && zip -r ../Puzzle_Solver.zip . -x 'tests/*' README.md`
4. Upload to the **Zip Solver** listing as an update. Keep the permissions as they are,
   so Zip users get it without having to re-approve.
