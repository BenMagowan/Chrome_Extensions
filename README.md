# Chrome_Extensions

A collection of Manifest V3 Chrome extensions that automatically solve the
[LinkedIn Games](https://www.linkedin.com/games/). Each game lives in its own
folder and loads as a standalone unpacked extension.

## Extensions

| Folder | Game | Status |
| --- | --- | --- |
| [Queens_Solver](Queens_Solver/) | [Queens](https://www.linkedin.com/games/queens/) — one crown per row, column, and colour region | ✅ Working |
| [Tango_Solver](Tango_Solver/) | [Tango](https://www.linkedin.com/games/tango/) — fill the grid with Suns and Moons | ✅ Working |
| [Mini_Sudoku_Solver](Mini_Sudoku_Solver/) | [Mini Sudoku](https://www.linkedin.com/games/mini-sudoku/) — one of each digit per row, column, and region | ✅ Working |
| [Patches_Solver](Patches_Solver/) | [Patches](https://www.linkedin.com/games/patches/) — tile the grid with the clued patches | ✅ Working |
| [Zip_Solver](Zip_Solver/) | [Zip](https://www.linkedin.com/games/zip/) — draw one path through every cell, hitting the numbers in order | ✅ Working |

## Shared design

All solvers follow the same architecture (see each folder's `README.md` for the
game-specific details and verified DOM selectors):

- **On-demand injection** — the popup injects a self-contained engine into the page
  with `chrome.scripting.executeScript` (`allFrames`, MAIN world) each time, rather
  than relying on a pre-injected content script. This avoids the "reload after
  install" gotcha, works regardless of when the game iframe loaded, and is exempt
  from the page CSP that blocks in-page `eval`.
- **Grid-agnostic parsing** — the board is read off `[data-cell-idx]` and stable
  `aria-label`s, so the same code works for both the guest and signed-in DOMs (whose
  container ids and CSS classes differ / are hashed).
- **Synthetic input, per game** — each solver drives the board with the input the game
  actually accepts, verified live: Queens/Tango/Mini Sudoku use a `pointerdown → mousedown
  → pointerup → mouseup → click` sequence; Zip and Patches use synthetic **keyboard**
  events (Patches' drag responds only to trusted events, so the keyboard path is used).
- **Popup UX** — polls to auto-enable **Solve** once a board is detected; otherwise
  the button opens the relevant game.
- **Shared popup design** — all five popups use one stylesheet and one state machine
  (`checking → idle | ready → solving → solved | error`, plus `stuck` in Patches for a
  board with no valid tiling, and `done` in Queens for an already-finished board).
  `styles.css` is byte-identical between solvers apart from a palette block at the top:
  `--accent` is sampled from that extension's own `images/icon-128.png` and is spent on
  the one button that solves, while `--brand` stays LinkedIn blue everywhere, since these
  are one family and each member is told apart by its icon and accent. `setState()` writes
  `data-state` on `<body>` and the CSS reacts to it; the JS never touches styles. Each
  header shows the extension's own icon (via `chrome.runtime.getURL`, 128 → 48 → 32 → 16)
  and a cog menu linking the other four solvers.
  Queens additionally draws a live board preview in place of its status line.

## Install (any solver)

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the solver's folder (e.g. `Tango_Solver/`).
3. Open the matching LinkedIn game, start a round, click the extension icon, then
   **Solve**.

> For educational use. Solving the puzzle for you removes the challenge — enjoy the
> games unaided too.
