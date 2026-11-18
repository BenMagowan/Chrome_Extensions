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
 *
 * Two more jobs, whatever the Auto-solve setting:
 *  - Record "solved today" (markSolvedToday in games.js) whenever this page's board
 *    is solved, by us or by hand, so the popup's game grid can show it.
 *  - Take part in "Solve all": the background worker walks one tab through the
 *    unsolved games. Each page asks it whether this tab is that run's (a content
 *    script can't know its own tab id); if so it solves even with Auto-solve off,
 *    presses Mini Sudoku's start button, and reports the outcome back.
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

  // Solve all: is this tab the run's tab, on the game the run is at? Asked once per
  // page load; the background answers from its stored run.
  const tell = (msg) => {
    try {
      return chrome.runtime.sendMessage({ ...msg, game: game.id }).catch(() => null);
    } catch {
      return Promise.resolve(null);
    }
  };
  const inRun = !!((await tell({ type: "solveAll:ask" })) || {}).active;

  let cfg = await readSettings();
  if (!cfg) return; // no storage access — nothing we can do
  // With Auto-solve off (and no Solve all run) this script only watches for the
  // board to be finished by hand, so it can record the day.
  let watchOnly = !inRun && !cfg.autosolve;
  // Log once (top frame only) so "why didn't it solve?" has an answer in the page
  // console: the user turned it off.
  if (isTop) {
    if (inRun) console.log(TAG, "solving as part of Solve all");
    else if (watchOnly) console.log(TAG, "off — turned off in the extension popup");
    else console.log(TAG, "on; target", cfg.targetMs + "ms");
  }

  // The board renders asynchronously, and on some games only once the player
  // presses Start — which doesn't always load a new page (Mini Sudoku's doesn't),
  // so this script gets no second run to catch it. So keep polling until a board
  // turns up, however long the start screen sits there. A frame that never holds a
  // board just goes on making one cheap DOM query every 800 ms.
  const INTERVAL_MS = 800;
  // Watching a board the player is solving by hand needs no such hurry.
  const WATCH_MS = 2000;
  // In a Solve all run, the top frame gives up on a page whose board never turns up
  // (signed out, say) so the run can move on. A frame that finds the board tells
  // the background first, which then ignores the give-up.
  const GIVE_UP_MS = 45000;
  if (inRun && isTop) setTimeout(() => tell({ type: "solveAll:stuck" }), GIVE_UP_MS);

  let saidWaiting = false;
  let pressedStart = 0;

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
      // Solve all presses Start itself, at most every few seconds.
      if (inRun && Date.now() - pressedStart > 3000 && pressStart()) pressedStart = Date.now();
    } else if (res && res.solvable) {
      if (res.solved) {
        console.log(TAG, "board already solved — nothing to do");
        await markSolvedToday(game.id);
        if (inRun) tell({ type: "solveAll:done", ok: true });
        return;
      }
      if (watchOnly) {
        // Not ours to solve: look again in a while, in case it's been finished.
        await new Promise((r) => setTimeout(r, WATCH_MS));
        continue;
      }
      // The setting as it is now, not as it was at page load.
      cfg = await readSettings();
      if (!cfg) return; // lost storage access (the extension was reloaded, say)
      if (!cfg.autosolve && !inRun) {
        console.log(TAG, "off — turned off in the extension popup while waiting");
        watchOnly = true; // watch for a solve by hand instead
        continue;
      }
      if (inRun) tell({ type: "solveAll:started" });
      console.log(TAG, `solving (target ${cfg.targetMs}ms)`);
      let r = null;
      try {
        r = await run("solve", { targetMs: cfg.targetMs });
        if (r && r.busy) console.log(TAG, "another solve is already running on this board — leaving it be");
        else console.log(TAG, r && r.ok ? "done" : "solve did not complete", r);
      } catch (e) {
        console.log(TAG, "solve threw", e);
      }
      if (r && r.ok) await markSolvedToday(game.id);
      // A busy board is someone else's solve: whoever runs it reports nothing to the
      // run, so look again once it's had time to finish.
      if (r && r.busy) {
        await new Promise((res2) => setTimeout(res2, WATCH_MS));
        continue;
      }
      if (inRun) tell({ type: "solveAll:done", ok: !!(r && r.ok) });
      return;
    }

    // No board yet. In a Solve all run, a start screen may be what's hiding it:
    // ?skipStartScreen=true usually gets past it, and if not, press its button.
    if (inRun && Date.now() - pressedStart > 3000 && pressStart()) pressedStart = Date.now();

    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
})();

/**
 * Press a start screen's button, for Solve all only: "Start game" (a link that
 * reloads the game past its start screen, which a signed-out visit can't reach
 * directly: LinkedIn redirects that URL to the games page unless it's followed from
 * the game), or Mini Sudoku's "Solve now". The labels are LinkedIn's and are translated, so they're matched in
 * the languages this extension speaks. Only these whole labels, and only in this
 * frame: a bare "Play" or "Start" could be one of LinkedIn's own links and take the
 * run's tab off the game. Returns whether it pressed one.
 */
const START_LABEL = new RegExp(
  "^(" +
    [
      "start game", "solve now",
      "iniciar juego", "empezar juego", "comenzar juego", "resolver ahora",
      "iniciar jogo", "começar jogo", "resolver agora",
      "commencer la partie", "démarrer la partie", "lancer la partie", "jouer maintenant", "résoudre maintenant",
      "spiel starten", "jetzt lösen",
    ].join("|") +
    ")$",
  "i"
);

function pressStart() {
  // "Start game" is a link (to this game with ?skipStartScreen=true); "Solve now" is
  // a button. A link counts only if it leads to this same game, so a matching label
  // elsewhere on the page can't take the run's tab away.
  const here = location.pathname.replace(/\/+$/, "");
  for (const b of document.querySelectorAll("button, a[href], [role=button]")) {
    if (b.disabled || b.closest("[data-number]") || !b.offsetParent) continue;
    if (!START_LABEL.test((b.textContent || "").trim().replace(/\s+/g, " "))) continue;
    if (b.tagName === "A") {
      let to;
      try {
        to = new URL(b.getAttribute("href"), location.href);
      } catch {
        continue;
      }
      if (to.origin !== location.origin || to.pathname.replace(/\/+$/, "") !== here) continue;
    }
    b.click();
    return true;
  }
  return false;
}
