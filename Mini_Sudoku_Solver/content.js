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
 * it shares the page's DOM, so it drives the same `runSudoku` engine directly.
 * `runSudoku` is defined by injected.js, which the manifest lists BEFORE this file
 * in the same content_scripts entry, so the two share one scope and it's in scope
 * here. (The popup keeps using its own MAIN-world executeScript path, unchanged.)
 *
 * The event dispatch is identical to the popup's: script-made events are
 * `isTrusted:false` in every world, and the MAIN-world path is known to work, so
 * the game doesn't gate on isTrusted — the same clicks land from here.
 */

(async () => {
  const TAG = "[Mini Sudoku auto-solve]";
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

  // The board renders asynchronously in the iframe, so poll for it. Only the frame
  // that actually holds the grid keeps going; other frames (the top page, unrelated
  // iframes) never see a grid and bail quietly, so just the game frame logs.
  const TRIES = 30;
  const INTERVAL_MS = 800;
  let sawGrid = false;

  for (let i = 0; i < TRIES; i++) {
    let res = null;
    try {
      res = await runSudoku("detect"); // from injected.js (same content-script scope)
    } catch {
      /* transient (frame mid-render) — retry */
    }
    if (res && res.N > 0) sawGrid = true;

    if (res && res.solvable) {
      if (res.solved) {
        console.log(TAG, "board already solved — nothing to do");
        return;
      }
      console.log(TAG, `solving ${res.N}×${res.N} board (target ${targetMs}ms)`);
      try {
        const r = await runSudoku("solve", { targetMs });
        console.log(TAG, r && r.ok ? `done — ${r.placed} digits placed` : "solve did not complete", r);
      } catch (e) {
        console.log(TAG, "solve threw", e);
      }
      return;
    }

    // Not the game frame — give up quietly after a couple of seconds so only the
    // frame with the board is noisy.
    if (!sawGrid && i >= 3) return;
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }

  if (sawGrid) {
    console.log(TAG, "a grid was there but never became solvable within the wait window");
  }
})();
