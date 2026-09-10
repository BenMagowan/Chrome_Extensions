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
 * it shares the page's DOM, so it drives the same `runPatches` engine directly.
 * `runPatches` is defined by injected.js, which the manifest lists BEFORE this file
 * in the same content_scripts entry, so the two share one scope and it's in scope
 * here. (The popup keeps using its own MAIN-world executeScript path, unchanged.)
 *
 * The event dispatch is identical to the popup's: script-made events are
 * `isTrusted:false` in every world, and the MAIN-world path is known to work, so
 * the game doesn't gate on isTrusted — the same key presses land from here.
 */

(async () => {
  const TAG = "[Patches auto-solve]";
  const isTop = window.top === window;

  // Read the shared setting the popup writes (mirrored into chrome.storage.local).
  let cfg;
  try {
    cfg = await chrome.storage.local.get(["autosolve", "targetMs"]);
  } catch {
    return; // no storage access — nothing we can do
  }
  // Auto-solve is ON by default: only an explicit opt-out (the popup wrote `false`)
  // turns it off. This also means it works on the very first game load, before the
  // popup has ever been opened to mirror a value into storage.
  if (cfg.autosolve === false) {
    // Log once (top frame only) so "why didn't it solve?" has an answer in the
    // page console: the user turned it off.
    if (isTop) console.log(TAG, "off — turned off in the extension popup");
    return;
  }

  // Same default as the popup (DEFAULT_TARGET_S): 5s until the user sets one.
  const targetMs = typeof cfg.targetMs === "number" ? cfg.targetMs : 5000;
  if (isTop) console.log(TAG, "on; target", targetMs + "ms");

  // The board renders asynchronously, and on some games only once the player
  // presses Start — which doesn't always load a new page (Mini Sudoku's doesn't),
  // so this script gets no second run to catch it. So keep polling until a board
  // turns up, however long the start screen sits there, rather than giving up
  // after a few tries. A frame that never holds a board just goes on making one
  // cheap DOM query every 800 ms.
  const INTERVAL_MS = 800;

  // While solving, leave a marker on this frame's <html> so the popup, if it's
  // opened mid-solve, shows "Solving" (then the result) instead of offering a
  // second solve. DOM attributes are shared across worlds, so the popup's
  // executeScript can read it. Keep in step with readAutoSolve() in popup.js.
  const marker = document.documentElement.dataset;

  for (;;) {
    let res = null;
    try {
      res = await runPatches("detect"); // from injected.js (same content-script scope)
    } catch {
      /* transient (frame mid-render) — retry */
    }

    if (res && res.solvable) {
      if (res.solved) {
        console.log(TAG, "board already solved — nothing to do");
        return;
      }
      console.log(TAG, `solving ${res.rows}×${res.cols} board (target ${targetMs}ms)`);
      const startedAt = Date.now();
      marker.autosolveStart = String(startedAt);
      marker.autosolve = "solving";
      let r = null;
      try {
        r = await runPatches("solve", { targetMs });
        console.log(TAG, r && r.ok ? `done — ${r.placed} patches placed` : "solve did not complete", r);
      } catch (e) {
        console.log(TAG, "solve threw", e);
      }
      // Result first, then state, so the popup never sees "solved" without one.
      marker.autosolveResult = JSON.stringify({ ...r, ms: Date.now() - startedAt });
      marker.autosolve = r && r.ok ? (r.alreadySolved ? "done" : "solved") : "failed";
      return;
    }

    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
})();
