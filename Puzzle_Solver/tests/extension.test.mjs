// End-to-end: the real unpacked extension in headless Chromium, on a mock Sumbreak
// page served at the real game URL (so the manifest's content script matches).
// Checks what a user would see without ever opening the popup:
//   1. Auto-solve, on by default, solves the board after the page loads.
//   2. Turning Sumbreak's Auto-solve off leaves the board alone.
//   3. Turning another game's off doesn't affect Sumbreak (settings are per game).
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
} finally {
  await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
