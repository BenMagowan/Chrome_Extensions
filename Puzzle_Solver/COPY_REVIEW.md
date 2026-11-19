# Puzzle Solver — UX Copy Review

Full copy audit of `Puzzle_Solver/` on branch `copy/puzzle-solver-gemini` (v2.0.0 shipping on the Zip Solver listing). Covers `_locales/*/messages.json` (`en`, `de`, `es`, `fr`, `pt_BR`, `pt_PT`), `README.md`, hard-coded strings in extension source files, and a check of store listings in `../STORE_LISTINGS.md` and `../store_listings/`.

---

## 1. Extension UI & Manifest Copy (`_locales/en/messages.json`)

All 43 changed English keys below have matching native updates (or were already idiomatically aligned) in `de`, `es`, `fr`, `pt_BR`, and `pt_PT`. Chrome limits verified across all 6 locales: `extName` is 67/75 chars; `extDescription` is 117–124/132 chars. All JSON files parse cleanly with identical key sets and placeholders.

| Key | Before | After | Reason |
| --- | --- | --- | --- |
| `extName` | `Puzzle Solver - Zip, Queens, Tango, Sudoku, Patches & Sumbreak` | `Puzzle Solver - Zip, Queens, Tango, Mini Sudoku, Patches & Sumbreak` | Uses the official game name ("Mini Sudoku") while staying within the 75-char limit (67 chars) and keeping "Puzzle Solver" and "Zip" upfront. |
| `extDescription` | `Solves the daily LinkedIn Zip, Queens, Tango, Mini Sudoku, Patches and Sumbreak puzzles in one click, or on its own as they load.` | `Solves LinkedIn's daily Zip, Queens, Tango, Mini Sudoku, Patches, and Sumbreak puzzles automatically or in one click.` | Shorter (117 vs. 129 chars) and replaces awkward "on its own as they load" with plain "automatically". |
| `checkingGames` | `Checking today's games…` | `Checking games…` | Shorter so the Solve all progress button fits comfortably in the 300px popup. |
| `lblChecking` | `Looking for puzzle…` | `Checking…` | Cuts awkward article-less phrasing ("Finding/Looking for puzzle…") to a crisp, accurate button label. |
| `stReady` | `Board detected · $1×$2` | `Board ready · $1×$2` | Friendlier, less robotic than "detected". |
| `lblSolving` | `Solving` | `Solving…` | Matches in-progress convention across all other solving labels. |
| `lblNothing` | `Nothing to solve` | `Can't solve` | Accurately reflects the `stuck` state (no solution found) instead of sounding already solved. |
| `stStuck` | `Board found, but no solution exists` | `No solution found. Try reloading.` | Shorter, avoids implying the puzzle itself is impossible, and gives a clear next step. |
| `stWaiting` | `Board found · start the round to solve it` | `Start the game to solve it` | Drops filler ("Board found") and replaces "round" with "game" to match LinkedIn's Start game button. |
| `lblWaiting` | `Waiting for the round` | `Waiting to start` | Shorter and drops "round" jargon. |
| `errNoFinish` | `The solve didn't finish.` | `Couldn't finish. Try again.` | Plain English and tells the user what to do next. |
| `errNoFrame` | `No board frame responded.` | `Board didn't respond. Try reloading.` | Removes developer jargon ("frame") and adds a recovery action. |
| `errBusy` | `A solve is already running on this board.` | `Already solving this board.` | Shorter, more direct active phrasing. |
| `errNoBoard` | `Board not found or still loading.` | `No board found. Wait or reload.` | Shorter and gives clear next steps. |
| `errNoSolution` | `No solution exists for this board.` | `No solution found. Try reloading.` | Consistent with `stStuck` and gives a recovery action. |
| `errUnsolved` | `The board still isn't solved. Try again.` | `Board isn't solved yet. Try again.` | Shorter and less abrupt. |
| `errColours` | `Read $1 colours on a $2×$3 board.` | `Misread $2×$3 board ($1 colors). Try again.` | Explains that it's a read error (not a random fact), aligns with US English, and adds a next step. |
| `errCluesGuesses` | `Couldn't tell clues from guesses on this board.` | `Couldn't read the board clues. Try reloading.` | Plain English and tells the user to reload. |
| `errNoPad` | `Number pad not found. Start the round first.` | `Number pad not found. Start the game first.` | Matches "Start the game" in `stWaiting`. |
| `errDigit` | `A digit didn't register. Try again.` | `A number didn't register. Try again.` | Consistent with "Number pad" and `sudoku_stSolving`/`sudoku_stSolved`. |
| `errFocus` | `Could not focus the gameboard.` | `Click the board and try again.` | Removes "focus" jargon and gives the exact user action needed. |
| `errCursor` | `Cursor navigation failed.` | `Couldn't reach a cell. Try again.` | Replaces technical jargon with plain English and a recovery action. |
| `errClearPatches` | `Couldn't clear the patches already on the board.` | `Couldn't clear patches. Undo and try again.` | Shorter and matches `errClearPath` with an actionable next step (Patches has an Undo control). |
| `errPatchDraw` | `Patch $1 of $2 wouldn't draw. Try again.` | `Couldn't draw patch $1 of $2. Try again.` | Clearer active voice, same length. |
| `errNoTiling` | `No rectangle tiling found for this board.` | `No solution found. Try reloading.` | Replaces math jargon ("rectangle tiling") with plain English and a recovery step. |
| `errPathTime` | `Couldn't find a path in time. The board may have been misread.` | `Timed out finding a path. Reload and try again.` | 15 chars shorter and directly tells the user how to recover. |
| `errNoPath` | `No path exists for this board.` | `No path found. Try reloading.` | Shorter and actionable. |
| `errClearPath` | `Couldn't clear the path already drawn. Undo it and try again.` | `Couldn't clear the path. Undo and try again.` | Cuts redundant words ("already drawn", "it") for tighter popup fit. |
| `errInternalStep` | `Internal: non-adjacent path step.` | `Something went wrong. Try again.` | Hides internal debug jargon from users and gives a clear next step. |
| `errPathStopped` | `The path stopped after $1 of $2 cells. Try again.` | `Path stopped at $1 of $2 cells. Try again.` | Shorter and cleaner phrasing. |
| `errSolveTime` | `Couldn't find a solution in time.` | `Timed out solving. Try again.` | Shorter and adds a recovery action. |
| `errBoardChanged` | `The board changed unexpectedly. Try again.` | `Board changed mid-solve. Try again.` | Shorter and clarifies when the change happened. |
| `zip_lblOpen` | `Open Zip game` | `Open Zip` | Drops redundant "game"; matches `openGame` (`Open $1`). |
| `zip_stSolving` | `Drawing the path…` | `Drawing path…` | Drops "the" to match `Placing crowns…`, `Placing symbols…`, etc. |
| `queens_lblOpen` | `Open Queens game` | `Open Queens` | Drops redundant "game". |
| `tango_lblOpen` | `Open Tango game` | `Open Tango` | Drops redundant "game". |
| `sudoku_lblOpen` | `Open Mini Sudoku game` | `Open Mini Sudoku` | Drops redundant "game". |
| `sudoku_stSolving` | `Placing digits…` | `Placing numbers…` | Plain English; consistent with "Number pad" and `errDigit`. |
| `sudoku_stSolved` | `Solved · $1 digits placed` | `Solved · $1 numbers placed` | Consistent with `sudoku_stSolving` and `errDigit`. |
| `patches_lblOpen` | `Open Patches game` | `Open Patches` | Drops redundant "game". |
| `patches_stSolving` | `Placing patches…` | `Drawing patches…` | Matches how Patches works and `errPatchDraw` ("draw patch"). |
| `patches_stSolved` | `Solved · $1 patches placed` | `Solved · $1 patches drawn` | Consistent with `patches_stSolving` and `errPatchDraw`. |
| `sumbreak_lblOpen` | `Open Sumbreak game` | `Open Sumbreak` | Drops redundant "game". |

---

## 2. Localization Alignment & Fixes (`de`, `es`, `fr`, `pt_BR`, `pt_PT`)

| Locale | Changes Made | Reason |
| --- | --- | --- |
| `de` | Updated all matching keys (`extName`, `extDescription`, `checkingGames`, `lblChecking` → `Wird geprüft…`, status/error messages, `sudoku_stSolving`/`stSolved` → `Zahlen`); shortened `Lade die Seite neu.` → `Lade neu.` and `Versuch es noch einmal.` → `Versuch es erneut.` on edited errors; tightened `errColours`, `errCursor`, `errNoBoard`, `errClearPatches`. | Matches English updates while keeping German strings tight for the 300px popup (`errColours` down from 67 to 52 chars; `errClearPatches` shorter than original). |
| `es` | Updated all matching keys; polished `extDescription` (`LinkedIn: Zip, … automáticamente o con un clic.`); updated `lblChecking` → `Comprobando…`; shortened `Recarga la página.` → `Recarga.` on edited errors and tightened `errCursor` (`No se alcanzó una celda.`). | Idiomatic Spanish (`con un clic` instead of `en un clic`), full parity with English, and tighter error widths. (Note: `errDigit`, `sudoku_stSolving`, `sudoku_stSolved`, `patches_stSolving`/`stSolved`, and `*_lblOpen` were already using `número(s)`, `dibujando`, and `Abrir <Game>`.) |
| `fr` | Updated all matching keys; added French colon spacing in `extDescription` (`LinkedIn : Zip, …`); updated `lblChecking` → `Recherche…`; shortened `Rechargez la page.` → `Rechargez.` and tightened `errBusy` (`Grille déjà en cours de résolution.`). | Natural French punctuation, full parity with English, and tighter error widths. (Note: `chiffre(s)` is retained consistently across `errDigit`, `sudoku_stSolving`, and `sudoku_stSolved` as the idiomatic French Sudoku term; `stWaiting`/`errNoPad` already use `Lancez la partie`.) |
| `pt_BR` | Updated all matching keys; polished `extDescription` (`LinkedIn: Zip, … automaticamente ou com um clique.`); updated `lblChecking` → `Verificando…`; tightened `stStuck`/`errNoSolution`/`errNoTiling` (`Sem solução. Recarregue a página.`), `errNoFrame`/`errCluesGuesses`/`errNoPath` (`Recarregue.`), `errUnsolved`, and `errCursor` (`Célula inacessível. Tente novamente.`); aligned `*_lblOpen` to `Abrir <Game>`. | Natural Brazilian Portuguese (`com um clique` instead of `em um clique`), tighter popup fit, and button labels consistent with `openGame` (`Abrir $1`). |
| `pt_PT` | Updated all matching keys with European Portuguese phrasing (`A verificar…`, `A resolver…`, `num clique`, `registado/a`, `Algo correu mal`); unified leftover Brazilianisms that clashed with the edited strings (`Definições`, `Puzzles ilimitados`, `Resolver puzzle`, `Controlo deslizante`, `Pré-visualização`, `A procurar tabuleiro…`, `A colocar coroas/símbolos…`, `A juntar peças…`, `Abra um jogo para o resolver`). | Removes jarring PT-BR/PT-PT mixing in `pt_PT` so the entire locale reads naturally in European Portuguese, while staying equal or shorter in visible popup slots. |

---

## 3. Documentation (`README.md`)

| Section | Before | After | Reason |
| --- | --- | --- | --- |
| Intro & feature overview | Two dense paragraphs describing the extension, popup views, settings, and Solve all. | Tight intro sentence plus four scannable bullet points (**On a game page**, **Per-game settings**, **Off a game page**, **Solve all**), preserving "(always enabled)" on Solve all. | Much faster to scan while keeping every factual detail (v2.0.0 on Zip Solver listing, 1–999 s default 5, 2×3 grid, `Zip #611`, green check, strip check, always-enabled Solve all). |
| **Solved today and Solve all** | Long wrapped bullets with run-on sentences and nested parentheticals. | Tighter phrasing and bolded step titles (**Check the games page**, **Solve the remaining games**); clarified "redirects that URL back to the games page". | Easier to follow without dropping any technical facts (midnight Pacific `America/Los_Angeles`, `NUMBER_DAY`, `solved:<id>`, fixture paths, 15 s / 45 s / 60 s timeouts, `?skipStartScreen=true`, retry behavior, five languages, badge states, Stop behavior, permissions, incognito isolation). |
| **Settings — Upgrading from Zip Solver** | `Moving from the Zip Solver: … Their old autosolve / targetMs keys are read as Zip's settings until Zip's entry is first written…` | `Upgrading from Zip Solver: … Legacy autosolve and targetMs keys apply to Zip until Zip's entry is first written…` | Clearer heading and tighter phrasing while keeping exact migration behavior (`first written`). |

---

## 4. Code & Store Listings Audit

- **Hard-coded English in `popup.html`, `popup.js`, `hub.js`, `content.js`, `games.js`, `games/*`, `site.js`, `previews.js`:** Audited every file. All visible popup UI text in `popup.js` and `games/*/preview.js` already routes through `t()`/`gt()`, and every static fallback string in `popup.html` matches `en/messages.json` (brand header `Puzzle Solver` / `LinkedIn Games`, `s` unit in `popup.js`, and proper game names in `games.js` are intentional).
- **Store listings (`../STORE_LISTINGS.md`, `../store_listings/*.md`):** Checked both locations. They contain only the five v1 single-game solver listings (Queens, Tango, Zip, Patches, Mini Sudoku) and no Puzzle Solver / Zip Solver v2 listing, so they were left untouched.

---

## 5. Issues Noticed But Not Changed

| Location | Issue Noticed | Why Not Changed |
| --- | --- | --- |
| `games/*/injected.js` & `i18n.js` (`ENGINE_ERRORS`) | Raw English error strings inside each engine still use older wording (e.g., `"Board not found or still loading."`, `"Cursor navigation failed."`, `"Internal: non-adjacent path step."`). | Every single engine error string is matched by exact regex in `i18n.js` (`ENGINE_ERRORS`) and mapped to `messages.json` before display (verified programmatically: 100% coverage), and `tests/sumbreak.test.mjs` asserts on the raw engine error string. Changing them would be a logic change with no user-facing benefit. |
| `_locales/pt_PT/messages.json` (`localeTag`) | `localeTag` is set to `"pt-BR"` instead of `"pt-PT"`. | `localeTag` is a BCP-47 identifier passed to `toLocaleString()` and `<html lang>` (logic/configuration rather than prose copy), and both `pt-BR` and `pt-PT` format decimal seconds identically (`5,0s`). Worth fixing in a follow-up code/locale-script change (`scripts/build_locales.py`). |
| `_locales/*/messages.json` (unused legacy keys) | Six keys (`menuAria`, `autoSolve`, `solveTime`, `solveTimeAria`, `solveTimeSliderAria`, `moreSolvers`) and `open` are not referenced by `Puzzle_Solver` (leftover from shared single-game solver templates). | Hard rule: do not add, rename, or remove message keys. |
| `content.js` console logs | Console logs (`[Sumbreak auto-solve] off — turned off in the extension popup`, etc.) are developer debug strings in English. | Not user-facing UI copy, and `tests/extension.test.mjs` asserts on exact console log prefixes (`[Sumbreak auto-solve] off`, `[<Game> auto-solve] on`). |
| `scripts/build_locales.py` | Comments in `i18n.js` and `README.md` note that `_locales/*/messages.json` are generated by `../scripts/build_locales.py`. | Outside `Puzzle_Solver/` scope; if `build_locales.py` is run later, the updated copy from `Puzzle_Solver/_locales/*/messages.json` should be synced back into it so edits aren't overwritten. |
| `README.md` (`Layout` tree & British spelling in untouched sections) | `games/looks.css` is present in `games/` but omitted from the ASCII layout tree; lower sections still use UK spellings (`colours`, `serialised`, `memoised`). | Minor non-blocking items in untouched developer notes; left alone to avoid unnecessary churn. |

## Adjusted after review (Claude)

- `errColours` (en): changed "colors" back to "colours" to keep British spelling consistent with the rest of the extension and the site.
