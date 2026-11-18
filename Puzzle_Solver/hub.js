/*
 * hub.js — runs on LinkedIn's games page (linkedin.com/games/), after games.js.
 *
 * Reads, for each of the six games, today's puzzle number ("Zip #611") and whether
 * it's already solved, records both (markSolvedToday / storePuzzleNumber in
 * games.js), and sends them to the background worker. Solve all opens this page
 * first, so it skips games solved already, here or on another device; the worker
 * ignores the report when this tab isn't a run's. Any visit to the page records
 * them, so the popup's grid stays right without a run.
 *
 * The page says "solved" only in pictures: a solved game's card shows its art with
 * LinkedIn's green check drawn in, a different image file from the unsolved one.
 * SOLVED_ART lists those files, read off the page on 2026-11-18 (tests/fixtures/
 * games-hub.html). A card showing any other file counts as not solved, so if
 * LinkedIn changes its art, Solve all just opens those games and finds out there.
 *
 * Signed out, the page has a different layout (tests/fixtures/games-hub-guest.html)
 * and no puzzle numbers, and it never shows a guest's progress: the art stays the
 * same after solving (checked live, 2026-11-18). So there every game reads as not
 * solved, Solve all opens each one, and content.js finds any that are finished.
 */

(() => {
  // Last part of the art's static.licdn.com URL, per game, when solved.
  const SOLVED_ART = {
    zip: ["eqd2zdxfo3m1jz92pxg5aly47"],
    queens: ["3sx08j1k9m3va9i54lpe95qk"],
    tango: ["2oxx40wcs46yupkec5o1g30bc"],
    sudoku: ["lct9sxbzegx83macfk88xxmq"],
    patches: ["9uhtb3xk2tpib1ny6kmd2zesg"],
    sumbreak: ["31a4wdvaa0dxthv0i501fgg5f"],
  };

  const INTERVAL_MS = 500;
  // The list renders after the page loads. A page that never shows it (signed out,
  // a changed layout) is reported empty, so a run goes on to open every game.
  const GIVE_UP_MS = 15000;

  const send = (msg) => {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch {
      /* extension reloaded under the page */
    }
  };

  // Whether the page is the signed-in layout, as read().
  let signedIn = false;

  /** Each of our games' card on the page, or null for the ones not found. */
  function read() {
    const found = [];
    signedIn = false;
    for (const a of document.querySelectorAll('a[href*="/games/"]')) {
      const g = gameForUrl(a.href);
      if (!g || found.some((f) => f.id === g.id)) continue;
      // Signed in, the art is img.ps-game-entrypoint-card__bg-img ("Zip graphic");
      // signed out, img.game-entrypoint-card__bg-img ("Zip"). Both end the same.
      const img = a.querySelector('img[class*="entrypoint-card__bg-img"]') || a.querySelector("img[alt]");
      if (!img) continue;
      const art = (img.getAttribute("src") || "").split(/[?#]/)[0].split("/").pop();
      const num = /#\s*(\d+)/.exec(a.textContent || "");
      found.push({ id: g.id, solved: SOLVED_ART[g.id].includes(art), number: num ? Number(num[1]) : null });
      // The signed-in layout's cards carry ps-game-entrypoint-card; the guest's don't.
      if (a.classList.contains("ps-game-entrypoint-card")) signedIn = true;
    }
    return found;
  }

  const startedAt = Date.now();
  const timer = setInterval(async () => {
    const cards = read();
    const gaveUp = Date.now() - startedAt > GIVE_UP_MS;
    // Wait for all six, or as many as there are once time's up.
    if (cards.length < GAMES.length && !(gaveUp && cards.length)) {
      if (gaveUp) {
        clearInterval(timer);
        send({ type: "solveAll:hub", solved: [], signedIn: false });
      }
      return;
    }
    clearInterval(timer);
    for (const c of cards) {
      if (c.solved) await markSolvedToday(c.id);
      if (c.number) await storePuzzleNumber(c.id, c.number);
    }
    send({ type: "solveAll:hub", solved: cards.filter((c) => c.solved).map((c) => c.id), signedIn });
  }, INTERVAL_MS);
})();
