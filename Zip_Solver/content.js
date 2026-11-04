/*
 * content.js — auto-solve driver.
 *
 * This is what makes "Auto-solve" run WITHOUT the popup being opened. Same design
 * as Queens_Solver/content.js, which replaced a background service worker there
 * because it was unreliable: an MV3 worker sleeps, and whether tabs.onUpdated
 * actually woke it (and handed it the URL) failed silently — the symptom being
 * "auto-solve only works once you click the popup".
 *
 * A content script has none of that fragility: the browser GUARANTEES to run it on
 * a matching page (and, with all_frames, in the board's iframe), every load. It
 * runs in the ISOLATED world, so it can read chrome.storage for the setting — and
 * it shares the page's DOM, so it drives the same `runZip` engine directly.
 * `runZip` is defined by injected.js, which the manifest lists BEFORE this file
 * in the same content_scripts entry, so the two share one scope and it's in scope
 * here. (The popup keeps using its own MAIN-world executeScript path, unchanged.)
 *
 * The event dispatch is identical to the popup's: script-made events are
 * `isTrusted:false` in every world, and the MAIN-world path is known to work, so
 * the game doesn't gate on isTrusted — the same key presses land from here.
 */

(async () => {
  const TAG = "[Zip auto-solve]";
  const isTop = window.top === window;

  // The shared settings the popup writes (mirrored into chrome.storage.local), or
  // null without storage access. Read again just before solving, not only here:
  // the poll below can wait a long time for a board — a start screen can sit there
  // indefinitely — and the user may change them in the popup meanwhile.
  const readSettings = async () => {
    try {
      return await chrome.storage.local.get(["autosolve", "targetMs"]);
    } catch {
      return null;
    }
  };
  // Auto-solve is ON by default: only an explicit opt-out (the popup wrote `false`)
  // turns it off. This also means it works on the very first game load, before the
  // popup has ever been opened to mirror a value into storage.
  const isOn = (cfg) => cfg.autosolve !== false;
  // Same default as the popup (DEFAULT_TARGET_S): 5s until the user sets one.
  const targetOf = (cfg) => (typeof cfg.targetMs === "number" ? cfg.targetMs : 5000);

  let cfg = await readSettings();
  if (!cfg) return; // no storage access — nothing we can do
  if (!isOn(cfg)) {
    // Log once (top frame only) so "why didn't it solve?" has an answer in the
    // page console: the user turned it off.
    if (isTop) console.log(TAG, "off — turned off in the extension popup");
    return;
  }
  if (isTop) console.log(TAG, "on; target", targetOf(cfg) + "ms");

  // The board renders asynchronously, and on some games only once the player
  // presses Start — which doesn't always load a new page (Mini Sudoku's doesn't),
  // so this script gets no second run to catch it. So keep polling until a board
  // turns up, however long the start screen sits there, rather than giving up
  // after a few tries. A frame that never holds a board just goes on making one
  // cheap DOM query every 800 ms.
  const INTERVAL_MS = 800;

  // There's no marker to write here: the engine's solve mode claims the board
  // itself and marks it for the popup (exclusive() in injected.js), so a popup
  // solve and this one can never both run on the board.

  for (;;) {
    let res = null;
    try {
      // from injected.js (same content-script scope). No preview: this only needs
      // to know whether there's a board to solve, not what the answer looks like.
      res = await runZip("detect", { preview: false });
    } catch {
      /* transient (frame mid-render) — retry */
    }

    if (res && res.solvable) {
      if (res.solved) {
        console.log(TAG, "board already solved — nothing to do");
        return;
      }
      // The setting as it is now, not as it was at page load: it may have been
      // turned off (or the time changed) in the popup while we waited.
      cfg = await readSettings();
      if (!cfg) return; // lost storage access (the extension was reloaded, say)
      if (!isOn(cfg)) {
        console.log(TAG, "off — turned off in the extension popup while waiting");
        return;
      }
      const targetMs = targetOf(cfg);
      console.log(TAG, `solving ${res.N}×${res.N} board (target ${targetMs}ms)`);
      let r = null;
      try {
        r = await runZip("solve", { targetMs });
        if (r && r.busy) console.log(TAG, "another solve is already running on this board — leaving it be");
        else console.log(TAG, r && r.ok ? `done — ${r.placed}-cell path drawn` : "solve did not complete", r);
      } catch (e) {
        console.log(TAG, "solve threw", e);
      }
      return;
    }

    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
})();
