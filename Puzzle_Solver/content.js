/*
 * content.js — auto-solve driver, shared by all six games.
 *
 * This is what makes "Auto-solve" run WITHOUT the popup being opened. A content
 * script rather than a background worker, which was unreliable: an MV3 worker
 * sleeps, and whether tabs.onUpdated actually woke it failed silently.
 *
 * The browser GUARANTEES to run this on a matching page (and, with all_frames, in
 * the board's iframe), every load. It runs in the ISOLATED world, so it can read
 * chrome.storage for the settings, and it shares the page's DOM, so it drives the
 * game's engine directly. Each game has its own content_scripts entry in the
 * manifest, listing games.js, that game's engine (games/<id>/injected.js) and then
 * this file, so the one engine defined in this scope is the page's game. (The popup
 * keeps its own MAIN-world executeScript path.)
 *
 * The event dispatch is identical to the popup's: script-made events are
 * `isTrusted:false` in every world, and the MAIN-world path is known to work, so
 * the games don't gate on isTrusted.
 */

(async () => {
  // The game whose engine the manifest loaded alongside this file.
  const game = GAMES.find((g) => typeof globalThis[g.runner] === "function");
  if (!game) return;
  const run = globalThis[game.runner];
  const TAG = `[${game.name} auto-solve]`;
  const isTop = window.top === window;

  // This game's settings as the popup last mirrored them, or null without storage
  // access. Read again just before solving, not only here: the poll below can wait
  // a long time for a board (a start screen can sit there indefinitely) and the
  // user may change them in the popup meanwhile. `autosolve` / `targetMs` are what
  // the Zip Solver stored before this extension took over its listing.
  const readSettings = async () => {
    try {
      const got = await chrome.storage.local.get([SETTINGS_KEY, "autosolve", "targetMs"]);
      const legacy = "autosolve" in got || "targetMs" in got ? got : null;
      return settingsFor(game.id, got[SETTINGS_KEY], legacy);
    } catch {
      return null;
    }
  };

  let cfg = await readSettings();
  if (!cfg) return; // no storage access — nothing we can do
  if (!cfg.autosolve) {
    // Log once (top frame only) so "why didn't it solve?" has an answer in the
    // page console: the user turned it off.
    if (isTop) console.log(TAG, "off — turned off in the extension popup");
    return;
  }
  if (isTop) console.log(TAG, "on; target", cfg.targetMs + "ms");

  // The board renders asynchronously, and on some games only once the player
  // presses Start — which doesn't always load a new page (Mini Sudoku's doesn't),
  // so this script gets no second run to catch it. So keep polling until a board
  // turns up, however long the start screen sits there. A frame that never holds a
  // board just goes on making one cheap DOM query every 800 ms.
  const INTERVAL_MS = 800;
  let saidWaiting = false;

  // There's no marker to write here: the engine's solve mode claims the board
  // itself and marks it for the popup (exclusive() in each injected.js), so a popup
  // solve and this one can never both run on the board.

  for (;;) {
    let res = null;
    try {
      // No preview: this only needs to know whether there's a board to solve.
      res = await run("detect", { preview: false });
    } catch {
      /* transient (frame mid-render) — retry */
    }

    // Mini Sudoku shows its board behind a start screen; `playable` is false until
    // the round starts. The other engines don't report it.
    if (res && res.solvable && !res.solved && res.playable === false) {
      if (!saidWaiting) console.log(TAG, "board is behind the start screen — waiting for the round to start");
      saidWaiting = true;
    } else if (res && res.solvable) {
      if (res.solved) {
        console.log(TAG, "board already solved — nothing to do");
        return;
      }
      // The setting as it is now, not as it was at page load.
      cfg = await readSettings();
      if (!cfg) return; // lost storage access (the extension was reloaded, say)
      if (!cfg.autosolve) {
        console.log(TAG, "off — turned off in the extension popup while waiting");
        return;
      }
      console.log(TAG, `solving (target ${cfg.targetMs}ms)`);
      let r = null;
      try {
        r = await run("solve", { targetMs: cfg.targetMs });
        if (r && r.busy) console.log(TAG, "another solve is already running on this board — leaving it be");
        else console.log(TAG, r && r.ok ? "done" : "solve did not complete", r);
      } catch (e) {
        console.log(TAG, "solve threw", e);
      }
      return;
    }

    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
})();
