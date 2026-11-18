// End-to-end: the real unpacked extension in headless Chromium, on a mock Sumbreak
// page served at the real game URL (so the manifest's content script matches).
// Checks what a user would see without ever opening the popup:
//   1. Auto-solve, on by default, solves the board after the page loads.
//   2. Turning Sumbreak's Auto-solve off leaves the board alone.
//   3. Turning another game's off doesn't affect Sumbreak (settings are per game).
//   6. Solve all reads LinkedIn's games page (a captured copy) for what's solved,
//      walks the given tab through the rest, solving even with Auto-solve off,
//      records each as solved today, and clears its run and badge when done.
//
//   node Puzzle_Solver/tests/extension.test.mjs
//
// The mock (tests/mock/sumbreak-mock.html) follows the official rules and the DOM of
// the board samples in tests/fixtures. It is not LinkedIn's code, so this proves the
// extension's wiring and the solver, not how the live game handles input.
import { chromium } from "../../../Website/node_modules/playwright/index.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = path.resolve(here, "..");
const mock = fs.readFileSync(path.join(here, "mock", "sumbreak-mock.html"), "utf8");
// LinkedIn's games page as captured, every game solved. The tests un-solve some by
// swapping a card's art for an unknown file, as an unsolved card's would be.
const hub = fs.readFileSync(path.join(here, "fixtures", "games-hub.html"), "utf8");
const hubGuest = fs.readFileSync(path.join(here, "fixtures", "games-hub-guest.html"), "utf8");
let hubUnsolved = [];
let signedOut = false;
const SOLVED_ART = { zip: "eqd2zdxfo3m1jz92pxg5aly47", sumbreak: "31a4wdvaa0dxthv0i501fgg5f" };
const shots = path.join(here, "screenshots");
fs.mkdirSync(shots, { recursive: true });

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "puzzle-solver-"));
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium", // the full browser in new headless mode: it runs extensions
  headless: true,
  viewport: { width: 520, height: 620 },
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

let failed = 0;
const check = (ok, name, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
  if (!ok) failed++;
};

try {
  await context.route("https://www.linkedin.com/games/**", (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: mock })
  );
  // Registered last, so it wins for the games page itself.
  await context.route(/^https:\/\/www\.linkedin\.com\/games\/(\?.*)?$/, (route) => {
    let body = signedOut ? hubGuest : hub;
    for (const id of hubUnsolved) body = body.replace(SOLVED_ART[id], "unsolved-art-" + id);
    route.fulfill({ status: 200, contentType: "text/html", body });
  });
  // The worker opens the site's welcome page on install; nothing to test there.
  context.on("page", (p) => {
    if (p.url().includes("puzzle-site")) p.close().catch(() => {});
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  const setSettings = (settings) => worker.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);

  const tiles = (page) => page.locator('button[data-numo-kind="number"]').count();

  async function load(input) {
    const page = await context.newPage();
    const logs = [];
    page.on("console", (m) => logs.push(m.text()));
    await page.goto(`https://www.linkedin.com/games/sumbreak/?input=${input}`);
    await page.waitForSelector('[aria-label="Gameboard"]');
    return { page, logs };
  }

  async function solvedWithin(page, ms) {
    try {
      await page.waitForFunction(
        () => document.querySelectorAll('button[data-numo-kind="number"]').length === 1,
        null,
        { timeout: ms }
      );
      return true;
    } catch {
      return false;
    }
  }

  // 1. Default settings: auto-solve on, 5 s target.
  for (const input of ["tap", "drag"]) {
    const { page, logs } = await load(input);
    if (input === "tap") await page.screenshot({ path: path.join(shots, "extension-before.png") });
    const ok = await solvedWithin(page, 20000);
    const last = await page.locator('button[data-numo-kind="number"]').first().getAttribute("aria-label").catch(() => null);
    check(ok && /Number 128\b/.test(last || ""), `auto-solve on load (${input} input)`, last || "");
    if (input === "tap") await page.screenshot({ path: path.join(shots, "extension-after.png") });
    if (!ok) console.log(logs.filter((l) => l.includes("Sumbreak")).join("\n"));
    await page.close();
  }

  // 2. Sumbreak's own switch off: the board is left as it is.
  await setSettings({ sumbreak: { autosolve: false, targetMs: 1000 } });
  {
    const { page, logs } = await load("tap");
    const before = await tiles(page);
    const changed = await solvedWithin(page, 4000);
    check(!changed && before === 9, "auto-solve off leaves the board alone", `${await tiles(page)} tiles`);
    check(logs.some((l) => l.includes("[Sumbreak auto-solve] off")), "says why in the console");
    await page.close();
  }

  // 3. Another game off, Sumbreak on at 1 s: Sumbreak still solves, and fast.
  await setSettings({ zip: { autosolve: false, targetMs: 5000 }, sumbreak: { autosolve: true, targetMs: 1000 } });
  {
    const { page } = await load("tap");
    const t0 = Date.now();
    const ok = await solvedWithin(page, 10000);
    check(ok, "per-game settings: Zip off doesn't stop Sumbreak", `${Date.now() - t0} ms`);
    await page.close();
  }

  // 4. The other five games: each page loads its own engine with the shared
  //    content.js. The mock isn't their board, so all this proves is the wiring:
  //    content.js found the right engine and read that game's setting.
  await setSettings({});
  for (const [p, name] of [["zip", "Zip"], ["queens", "Queens"], ["tango", "Tango"], ["mini-sudoku", "Mini Sudoku"], ["patches", "Patches"]]) {
    const page = await context.newPage();
    const logs = [];
    page.on("console", (m) => logs.push(m.text()));
    await page.goto(`https://www.linkedin.com/games/${p}/`);
    await page.waitForTimeout(1500);
    check(logs.some((l) => l.startsWith(`[${name} auto-solve] on`)), `${name} page runs its own engine`);
    await page.close();
  }

  // 5. The popup inside the real extension, opened as a tab: the active tab is the
  //    popup itself, not a game, so it should show the game list without errors.
  {
    const id = new URL(worker.url()).host;
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(`chrome-extension://${id}/popup.html`);
    await page.waitForTimeout(800);
    const state = await page.evaluate(() => document.body.dataset.state);
    const rows = await page.locator(".list__game").count();
    check(state === "list" && rows === 6 && !errors.length, "popup loads in the extension", `state=${state}, ${rows} games${errors.length ? ", errors: " + errors.join("; ") : ""}`);
    await page.close();
  }

  // 6. Solve all, started from the popup the way its button does, with Sumbreak's
  //    Auto-solve off. The games page says Zip is solved and Sumbreak isn't, so the
  //    run skips Zip, records it, then moves its tab on to Sumbreak and solves it.
  await setSettings({ sumbreak: { autosolve: false, targetMs: 1000 } });
  await worker.evaluate(() => chrome.storage.local.remove(["solved:sumbreak", "solved:zip", "number:zip"]));
  hubUnsolved = ["sumbreak"];
  {
    const id = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    // The tab Solve all runs in, the way the popup passes its active tab. Opened on a
    // games URL so the extension can see its address (it has no "tabs" permission).
    const runTab = await context.newPage();
    await runTab.goto("https://www.linkedin.com/games/zip/?probe=1");
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => (t.url || "").includes("probe=1")).id);
    await popup.evaluate((tabId) => chrome.runtime.sendMessage({ type: "solveAll:start", ids: ["zip", "sumbreak"], tabId }), tabId);
    const badges = new Set();
    let got = {};
    const t0 = Date.now();
    while (Date.now() - t0 < 40000) {
      badges.add(await worker.evaluate(() => chrome.action.getBadgeText({})));
      got = await worker.evaluate(() => chrome.storage.local.get(["solveAllRun", "solved:sumbreak", "solved:zip", "number:zip"]));
      if (!got.solveAllRun && got["solved:sumbreak"]) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const today = await worker.evaluate(() => puzzleDay());
    const solvedBoard = (await runTab.locator('button[data-numo-kind="number"]').count()) === 1;
    const after = await worker.evaluate(() => chrome.action.getBadgeText({}));
    check(got["solved:zip"] === today && got["number:zip"] && got["number:zip"].n === 611, "the games page records Zip solved, and its number", JSON.stringify(got["number:zip"]));
    check(/sumbreak/.test(runTab.url()) && /skipStartScreen=true/.test(runTab.url()), "Solve all runs in the given tab, skipping the start screen", runTab.url());
    check(badges.has("1/1") && !badges.has("1/2"), "Solve all skips what the games page says is solved", [...badges].join(" "));
    check(got["solved:sumbreak"] === today && solvedBoard, "Solve all solves with Auto-solve off and records today", `${Date.now() - t0} ms`);
    check(after === "", "Solve all clears its run and badge when done");
    // The popup's grid now shows Sumbreak solved. Close the run's tab first, so the
    // popup's own tab is the active one and it shows the grid, not Sumbreak's board.
    await runTab.close();
    await popup.bringToFront();
    await popup.reload();
    await popup.waitForTimeout(500);
    const status = await popup.locator('.list__game[data-game="sumbreak"] .card__status').textContent();
    check(status === "Solved today", "the game grid shows it", status);
    await popup.close();
  }

  // 6b. Signed out (as in an incognito window), the games page has another layout.
  //     It's still read at once, every game as not solved, so the run sets off on
  //     all six rather than waiting out the page's 15 s give-up.
  signedOut = true;
  await worker.evaluate(() => chrome.storage.local.remove("solveAllRun"));
  {
    const runTab = await context.newPage();
    await runTab.goto("https://www.linkedin.com/games/zip/?probe=2");
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find((t) => (t.url || "").includes("probe=2")).id);
    await worker.evaluate((tabId) => startRun(GAMES.map((g) => g.id), tabId), tabId);
    const t0 = Date.now();
    let run = null;
    while (Date.now() - t0 < 8000) {
      run = (await worker.evaluate(() => chrome.storage.local.get("solveAllRun"))).solveAllRun;
      if (run && run.phase === "games") break;
      await new Promise((r) => setTimeout(r, 200));
    }
    check(run && run.phase === "games" && run.queue.length === 6, "the signed-out games page is read too", run ? `${run.queue.length} games in ${Date.now() - t0} ms` : "no run");
    await worker.evaluate(() => chrome.storage.local.remove("solveAllRun"));
    await runTab.close();
  }
  signedOut = false;

  // 7. A run whose tab is gone (the browser quit mid-run, say) is cleared, not
  //    shown as still going.
  {
    await worker.evaluate(() =>
      chrome.storage.local.set({ solveAllRun: { tabId: 999999, queue: ["zip"], index: 0, started: false, solved: [], stepAt: Date.now() } })
    );
    const id = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const status = await popup.evaluate(() => chrome.runtime.sendMessage({ type: "solveAll:status" }));
    const left = await worker.evaluate(() => chrome.storage.local.get("solveAllRun"));
    check(status === null && !left.solveAllRun, "a run whose tab is gone is cleared");
    await popup.close();
  }
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
