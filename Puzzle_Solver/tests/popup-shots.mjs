// Screenshots of the popup, for review. Renders the real popup.html in headless
// Chromium with a stubbed chrome.* API: the active tab's URL picks the game, and the
// engines' detect results are canned boards below (shaped like each engine's real
// output), so no LinkedIn page is involved. English strings come from _locales/en.
//
//   node Puzzle_Solver/tests/popup-shots.mjs [outDir]
//
// Playwright is the Website project's copy (../Website/node_modules).
import { chromium } from "../../../Website/node_modules/playwright/index.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const out = path.resolve(process.argv[2] || path.join(ext, "..", "docs", "puzzle-solver"));
fs.mkdirSync(out, { recursive: true });
const messages = JSON.parse(fs.readFileSync(path.join(ext, "_locales/en/messages.json"), "utf8"));

/* ------------------------------------------------------------ canned boards */

const N6 = [...Array(36).keys()];
const rc = (i, n) => ({ row: Math.floor(i / n), col: i % n });

// Zip: a serpentine path with six numbered stops and two walls.
const zipPath = [];
for (let r = 0; r < 6; r++) for (let k = 0; k < 6; k++) zipPath.push(r * 6 + (r % 2 ? 5 - k : k));
const stops = { 0: 1, 8: 2, 15: 3, 21: 4, 27: 5, 35: 6 };
const zip = {
  solvable: true, solved: false, N: 6, path: zipPath,
  cells: N6.map((i) => {
    const idx = zipPath[i];
    return { ...rc(idx, 6), number: stops[i] || 0, walls: idx === 13 ? { down: true } : idx === 20 ? { right: true } : {} };
  }).sort((a, b) => a.row - b.row || a.col - b.col),
};

// Queens: the 7×7 board from LinkedIn's finished-board screenshot in the PR.
const qRegions = ["POBBGGG", "POBBGWW", "POBBBWR", "POBBBRR", "POOYYYY", "POOYYYY", "PPPPPYY"];
const qCrowns = [[0, 4], [1, 6], [2, 2], [3, 5], [4, 1], [5, 3], [6, 0]];
const qColors = { P: "#b9a3e3", O: "#f7cb9b", B: "#a3bffa", G: "#bedea7", W: "#dfdfdf", R: "#ee8a6f", Y: "#e6f28f" };
const queens = {
  solvable: true, solved: false, N: 7,
  cells: [...Array(49).keys()].map((i) => {
    const { row, col } = rc(i, 7);
    const region = qRegions[row][col];
    const queen = qCrowns.some(([r, c]) => r === row && c === col);
    return { row, col, region, color: qColors[region], state: queen ? "queen" : "" };
  }),
};

// Tango: the finished board from the same screenshots, with its = markers and
// four locked cells.
const tRows = ["MMSSMS", "MMSSMS", "SSMMSM", "MSMMSS", "SMSSMM", "SSMMSM"];
const tEq = [[0, 1], [0, 6], [1, 7], [6, 7], [14, 15], [14, 20], [15, 21], [20, 21]];
const tango = {
  solvable: true, solved: false, N: 6,
  cells: N6.map((i) => {
    const { row, col } = rc(i, 6);
    return { row, col, symbol: tRows[row][col] === "S" ? "Sun" : "Moon", locked: [28, 29, 34, 35].includes(i) };
  }),
  edges: tEq.map(([a, b]) => ({ a, b, eq: true })),
};

// Mini Sudoku: the finished board from the same screenshots. "g" marks a clue.
const sRows = ["623154", "514362", "356421", "142635", "465213", "231546"];
const sGiven = ["......", "gg....", "gggg..", "..gggg", "....gg", "......"];
const sudoku = {
  solvable: true, solved: false, playable: true, N: 6,
  cells: N6.map((i) => {
    const { row, col } = rc(i, 6);
    return {
      row, col, value: Number(sRows[row][col]), given: sGiven[row][col] === "g",
      walls: { right: col === 2, left: col === 3, bottom: row === 1 || row === 3, top: row === 2 || row === 4 },
    };
  }),
};

// Patches: the tiling from the same screenshots.
const pMap = ["AAAAAA", "BBCCCF", "BBCCCF", "BBDDDF", "BBEEEF", "BBEEEF"];
const patches = {
  solvable: true, solved: false, rows: 6, cols: 6,
  cells: N6.map((i) => {
    const { row, col } = rc(i, 6);
    return { row, col, patch: pMap[row].charCodeAt(col) - 65, clue: null };
  }),
};

// Sumbreak: the guest board from tests/fixtures/sumbreak-guest.html.
const sumVals = [1, 1, 64, 4, 2, 32, 4, 4, 16];
const sumbreak = {
  solvable: true, solved: false, rows: 3, cols: 3,
  cells: sumVals.map((value, idx) => ({ idx, value })),
  moves: [[0, 1], [1, 4], [4, 7], [3, 6], [6, 7], [7, 8], [8, 5], [5, 2]],
};

const BOARDS = { runZip: zip, runQueens: queens, runTango: tango, runSudoku: sudoku, runPatches: patches, runSumbreak: sumbreak };

/* ------------------------------------------------------------------ the stub */

function stub({ url, boards, messages, store }) {
  const msg = (key, subs = []) => {
    const m = messages[key];
    if (!m) return "";
    return m.message.replace(/\$(\d)/g, (_, n) => subs[Number(n) - 1] ?? "");
  };
  window.chrome = {
    i18n: { getMessage: (k, subs) => msg(k, subs) },
    runtime: { getURL: (p) => p },
    storage: { local: { set() {}, get: async () => ({}) } },
    tabs: { query: async () => [{ id: 1, url }], create() {} },
    scripting: {
      executeScript: async ({ func, args }) => {
        const board = boards[func.name];
        if (!board) return [{ result: null }]; // readAutoSolve
        return [{ result: args[0] === "detect" ? board : { ok: true, placed: 36, merges: 8 } }];
      },
    },
  };
  window.close = () => {};
  for (const [k, v] of Object.entries(store || {})) localStorage.setItem(k, v);
}

/* ---------------------------------------------------------------- the shots */

const browser = await chromium.launch();
const page0 = path.join(ext, "popup.html");

async function shot(name, { url, store, act, scheme = "light", boards = BOARDS }) {
  const ctx = await browser.newContext({ viewport: { width: 300, height: 600 }, deviceScaleFactor: 2, colorScheme: scheme });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.addInitScript(stub, { url, boards, messages, store });
  await page.goto("file://" + page0);
  await page.waitForTimeout(400);
  if (act) await act(page);
  await page.waitForTimeout(1200); // let entrance animations settle
  const h = await page.evaluate(() => {
    const menu = document.getElementById("menu");
    const menuBottom = menu.hidden ? 0 : menu.getBoundingClientRect().bottom + 12;
    return Math.ceil(Math.max(document.body.scrollHeight, menuBottom));
  });
  await page.setViewportSize({ width: 300, height: h });
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  if (errors.length) console.log(name, "page errors:", errors);
  await ctx.close();
  console.log("wrote", name);
}

const li = "https://www.linkedin.com/games/";
await shot("zip", { url: li + "zip/" });
// A board the player had already finished: "Already solved", still with the path.
await shot("zip-already-solved", { url: li + "zip/", boards: { ...BOARDS, runZip: { ...zip, solved: true } } });
await shot("zip-settings", { url: li + "zip/", act: (p) => p.click("#menu-btn") });
await shot("queens", { url: li + "queens/" });
await shot("tango", { url: li + "tango/" });
await shot("mini-sudoku", { url: li + "mini-sudoku/" });
await shot("patches", { url: li + "patches/" });
await shot("sumbreak", { url: li + "sumbreak/" });
await shot("other-page", { url: "https://www.linkedin.com/feed/" });
await shot("other-page-settings", { url: "https://www.linkedin.com/feed/", act: (p) => p.click("#menu-btn") });
await shot("zip-dark", { url: li + "zip/", scheme: "dark" });
await shot("other-page-dark", { url: "https://www.linkedin.com/feed/", scheme: "dark" });
// An existing Zip Solver user: their old settings (auto-solve off, 12s) become Zip's.
await shot("migrated-zip-settings", {
  url: li + "zip/",
  store: { autosolve: "0", targetMs: "12000", siteSeen: "1" },
  act: (p) => p.click("#menu-btn"),
});
await browser.close();
