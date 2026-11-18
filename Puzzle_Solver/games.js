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
 *   number  the puzzle's number on NUMBER_DAY (as LinkedIn's games page shows it,
 *           "Zip #611"); one new puzzle a day from there
 *   shade   the colour behind the game's art on its card in the popup's grid, mixed
 *           into the card (popup.css);
 *           the accent when not given (Queens/Tango and Patches/Sumbreak trade);
 *           also the colour of its row in the settings menu
 */
const GAMES = [
  { id: "zip", name: "Zip", runner: "runZip", path: "zip", site: "trail", ref: "zip", accent: "#ff6d29", number: 611 },
  { id: "queens", name: "Queens", runner: "runQueens", path: "queens", site: "crowns", ref: "queens", accent: "#e0a500", number: 932, shade: "#4c8de7" },
  { id: "tango", name: "Tango", runner: "runTango", path: "tango", site: "binairo", ref: "tango", accent: "#4c8de7", number: 772, shade: "#e0a500" },
  { id: "sudoku", name: "Mini Sudoku", short: "Sudoku", runner: "runSudoku", path: "mini-sudoku", site: "sudoku", ref: "mini-sudoku", accent: "#338041", number: 464 },
  { id: "patches", name: "Patches", runner: "runPatches", path: "patches", site: "shikaku", ref: "patches", accent: "#49a2fe", number: 246, shade: "#9b5cff" },
  { id: "sumbreak", name: "Sumbreak", runner: "runSumbreak", path: "sumbreak", site: null, ref: "sumbreak", accent: "#9b5cff", number: 1, shade: "#49a2fe", isNew: true },
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

/** LinkedIn's games page, which shows which games are solved today. */
const HUB_URL = "https://www.linkedin.com/games/";

/**
 * The game's page for Solve all. Signed in, with ?skipStartScreen=true, LinkedIn's
 * own switch past the start screen. Signed out, LinkedIn redirects any game URL
 * carrying that switch to the games page, so there it's the plain URL.
 */
const solveAllUrl = (g, skipStart) => (skipStart ? `${gameUrl(g)}?skipStartScreen=true` : gameUrl(g));

/* --------------------------------------------------------------- puzzle days */

// LinkedIn releases every game's next puzzle at midnight Pacific time, so "today"
// is the date in Los Angeles, not the user's own: in London the day turns over at
// 8 am. Days are "YYYY-MM-DD" strings (en-CA formats dates that way).
const PUZZLE_TZ = "America/Los_Angeles";
const dayFormat = new Intl.DateTimeFormat("en-CA", { timeZone: PUZZLE_TZ, year: "numeric", month: "2-digit", day: "2-digit" });

/** Today's puzzle day, "YYYY-MM-DD". */
const puzzleDay = (now = new Date()) => dayFormat.format(now);

// The day the `number`s in GAMES were read off LinkedIn's games page.
const NUMBER_DAY = "2026-11-18";

/**
 * Today's puzzle number for a game, e.g. 611 for Zip on NUMBER_DAY. `seen` is a
 * number read off LinkedIn's games page today (storedNumbers), which wins; without
 * one it's counted on from NUMBER_DAY.
 */
function puzzleNumber(g, seen, now = new Date()) {
  if (seen) return seen;
  const days = Math.round((Date.parse(puzzleDay(now)) - Date.parse(NUMBER_DAY)) / 86400000);
  return g.number + days;
}

// Puzzle numbers read off the games page (hub.js), "number:zip": { day, n }.
const numberKey = (id) => `number:${id}`;

function storePuzzleNumber(id, n) {
  try {
    return chrome.storage.local.set({ [numberKey(id)]: { day: puzzleDay(), n } }).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/** Today's numbers read off the games page, by game id. */
async function storedNumbers() {
  try {
    const got = await chrome.storage.local.get(GAMES.map((g) => numberKey(g.id)));
    const today = puzzleDay();
    const out = {};
    for (const g of GAMES) {
      const v = got[numberKey(g.id)];
      if (v && v.day === today && Number.isFinite(v.n)) out[g.id] = v.n;
    }
    return out;
  } catch {
    return {};
  }
}

// Which day each game was last seen solved, one key per game ("solved:zip":
// "2026-11-18") in chrome.storage.local. One key each because content.js, hub.js
// and the popup all write them, and a shared object would lose one writer's update
// to another's read-modify-write.
//
// Incognito windows keep their own ("incognito:solved:zip"). They share this
// extension's storage with the normal ones, but not LinkedIn's sign-in: a signed-out
// guest in incognito hasn't solved what the signed-in account has. The background
// worker clears them when the last incognito window closes.
//
// inIncognito is true in a content script in an incognito tab; the popup sets it
// from its window on opening (setIncognito), since it may run outside one.
let inIncognito = !!(typeof chrome !== "undefined" && chrome.extension && chrome.extension.inIncognitoContext);
const setIncognito = (on) => (inIncognito = !!on);

const INCOGNITO_PREFIX = "incognito:";
const solvedKey = (id) => `${inIncognito ? INCOGNITO_PREFIX : ""}solved:${id}`;

/** Record that a game's puzzle is solved today. Best-effort. */
function markSolvedToday(id) {
  try {
    return chrome.storage.local.set({ [solvedKey(id)]: puzzleDay() }).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/** The ids of the games solved today, as a Set. */
async function solvedToday() {
  try {
    const got = await chrome.storage.local.get(GAMES.map((g) => solvedKey(g.id)));
    const today = puzzleDay();
    return new Set(GAMES.filter((g) => got[solvedKey(g.id)] === today).map((g) => g.id));
  } catch {
    return new Set();
  }
}

// "Solve all": the background worker's run, kept in storage because an MV3 worker
// is stopped after ~30 s idle. { tabId, phase: "hub" | "games", queue: [ids],
// index, started, solved: [ids], stepAt }.
const RUN_KEY = "solveAllRun";

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
