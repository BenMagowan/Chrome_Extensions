/*
 * The six games, in the order the popup lists them. The only place a game is
 * named: popup.js, content.js and the background worker read this table, and each
 * game's engine (games/<id>/injected.js) and board preview (games/<id>/preview.js)
 * are looked up by `id`.
 *
 * Loaded by the popup (script tag), the background worker (importScripts) and every
 * content script, so it must not touch the DOM or chrome.* at load time.
 *
 *   runner  the engine's function name, defined by games/<id>/injected.js
 *   path    the LinkedIn URL segment: /games/<path>/ and /games/view/<path>/
 *   site    the game's page on the puzzle site, and `ref` for its analytics.
 *           null: the site has no version of it yet, so links go to the home page.
 *   accent  the game's colour in the game strip and settings menu (its full set of
 *           tokens is in games/games.css)
 *   isNew   shows a NEW badge beside the game until it's been opened from the popup
 */
const GAMES = [
  { id: "zip", name: "Zip", runner: "runZip", path: "zip", site: "trail", ref: "zip", accent: "#ff6d29" },
  { id: "queens", name: "Queens", runner: "runQueens", path: "queens", site: "crowns", ref: "queens", accent: "#e0a500" },
  { id: "tango", name: "Tango", runner: "runTango", path: "tango", site: "binairo", ref: "tango", accent: "#4c8de7" },
  { id: "sudoku", name: "Mini Sudoku", short: "Sudoku", runner: "runSudoku", path: "mini-sudoku", site: "sudoku", ref: "mini-sudoku", accent: "#338041" },
  { id: "patches", name: "Patches", runner: "runPatches", path: "patches", site: "shikaku", ref: "patches", accent: "#49a2fe" },
  { id: "sumbreak", name: "Sumbreak", runner: "runSumbreak", path: "sumbreak", site: null, ref: "sumbreak", accent: "#9b5cff", isNew: true },
];

const GAME_BY_ID = Object.fromEntries(GAMES.map((g) => [g.id, g]));

/** The game a URL is the page of, or null. Subdomain optional; guest and signed-in. */
function gameForUrl(url) {
  if (typeof url !== "string") return null;
  for (const g of GAMES) {
    const re = new RegExp(`^https?://([a-z0-9-]+\\.)*linkedin\\.com/games/(view/)?${g.path}(?:[/?#]|$)`, "i");
    if (re.test(url)) return g;
  }
  return null;
}

/** The LinkedIn page for a game. */
const gameUrl = (g) => `https://www.linkedin.com/games/${g.path}/`;

/* ------------------------------------------------------------------ settings */

// Each game has its own Auto-solve and Solve time. They live in one object under
// SETTINGS_KEY, { zip: { autosolve, targetMs }, … }, in the popup's localStorage
// and mirrored to chrome.storage.local for content.js (see popup.js for why both).
const SETTINGS_KEY = "settings";
const DEFAULT_SETTINGS = { autosolve: true, targetMs: 5000 };

/**
 * One game's settings from a stored object, falling back to the defaults. `legacy`
 * is what the Zip Solver stored before this extension replaced it on the same
 * listing: its single `autosolve` / `targetMs` pair, which now belongs to Zip only.
 */
function settingsFor(id, stored, legacy) {
  const own = stored && stored[id];
  const base = own || (id === "zip" && legacy) || {};
  return {
    autosolve: typeof base.autosolve === "boolean" ? base.autosolve : DEFAULT_SETTINGS.autosolve,
    targetMs: typeof base.targetMs === "number" && base.targetMs > 0 ? base.targetMs : DEFAULT_SETTINGS.targetMs,
  };
}
