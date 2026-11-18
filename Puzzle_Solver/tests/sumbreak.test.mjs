import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "/Users/benmagowan/Documents/Projects/Active/Linkedin-Games/Website/node_modules/playwright/index.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_DIR = __dirname;
const SUMBREAK_DIR = path.resolve(TESTS_DIR, "..", "games", "sumbreak");
const INJECTED_PATH = path.join(SUMBREAK_DIR, "injected.js");
const MOCK_PATH = path.join(TESTS_DIR, "mock", "sumbreak-mock.html");
const SCREENSHOTS_DIR = path.join(TESTS_DIR, "screenshots");

const injectedCode = fs.readFileSync(INJECTED_PATH, "utf8");
const mockHtml = fs.readFileSync(MOCK_PATH, "utf8");

fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

// Deterministic seeded PRNG (Mulberry32)
function makeRng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Generate a solvable Sumbreak board by starting with a single power of 2
// and repeatedly splitting an occupied tile (>= 2) into an empty orthogonal neighbor.
function generateSolvableBoard({ rows, cols, startPower, targetTiles, seed }) {
  const rng = makeRng(seed);
  const total = rows * cols;
  const grid = new Array(total).fill(0);
  const startIdx = Math.floor(rng() * total);
  grid[startIdx] = startPower;
  let count = 1;

  const neighbors = (i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const out = [];
    if (r > 0) out.push(i - cols);
    if (r < rows - 1) out.push(i + cols);
    if (c > 0) out.push(i - 1);
    if (c < cols - 1) out.push(i + 1);
    return out;
  };

  let guard = 0;
  while (count < targetTiles && guard++ < 500) {
    const candidates = [];
    for (let i = 0; i < total; i++) {
      if (grid[i] < 2) continue;
      const emptyNbs = neighbors(i).filter((nb) => grid[nb] === 0);
      if (emptyNbs.length > 0) candidates.push({ i, emptyNbs });
    }
    if (!candidates.length) break;
    // Prefer splitting larger tiles slightly more often so 4x4/5x5 fill cleanly.
    candidates.sort((a, b) => grid[b.i] - grid[a.i]);
    const poolSize = Math.max(1, Math.ceil(candidates.length * 0.6));
    const pick = candidates[Math.floor(rng() * poolSize)];
    const nb = pick.emptyNbs[Math.floor(rng() * pick.emptyNbs.length)];
    const half = grid[pick.i] / 2;
    grid[pick.i] = half;
    grid[nb] = half;
    count++;
  }

  return {
    rows,
    cols,
    values: grid,
    expectedMerges: count - 1,
    expectedFinal: startPower,
  };
}

async function openBoardPage(context, { rows, cols, values, input }) {
  const page = await context.newPage();
  const qs = new URLSearchParams({
    rows: String(rows),
    cols: String(cols),
    values: values.join(","),
    input,
  });
  await page.goto(`https://www.linkedin.com/games/sumbreak/?${qs.toString()}`, {
    waitUntil: "domcontentloaded",
  });
  await page.waitForSelector('[data-numo-rows][data-numo-columns][aria-label="Gameboard"]');
  await page.addScriptTag({ content: injectedCode });
  return page;
}

async function readFinalDomState(page) {
  return page.evaluate(() => {
    const btns = Array.from(
      document.querySelectorAll('button[data-numo-kind="number"]')
    );
    return {
      buttonCount: btns.length,
      disabled: btns.length === 1 ? btns[0].hasAttribute("disabled") : false,
      ariaLabel: btns.length === 1 ? btns[0].getAttribute("aria-label") : null,
      svgLabel:
        btns.length === 1
          ? document.querySelector("text[data-numo-label]")?.textContent?.trim()
          : null,
    };
  });
}

const results = [];

async function runCase(name, fn) {
  const t0 = performance.now();
  try {
    const detail = await fn();
    const ms = Math.round(performance.now() - t0);
    results.push({ name, ok: true, ms, detail: detail || "" });
    console.log(`PASS  ${name} (${ms}ms)${detail ? " — " + detail : ""}`);
  } catch (err) {
    const ms = Math.round(performance.now() - t0);
    results.push({ name, ok: false, ms, detail: err?.stack || String(err) });
    console.error(`FAIL  ${name} (${ms}ms)\n${err?.stack || err}`);
  }
}

const browser = await chromium.launch({ headless: true });

try {
  const context = await browser.newContext({
    viewport: { width: 520, height: 520 },
  });

  await context.route("https://www.linkedin.com/games/sumbreak/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: mockHtml,
    });
  });

  const GUEST_VALUES = [1, 1, 64, 4, 2, 32, 4, 4, 16];

  // 1. Guest board under tap (with before/after screenshots & detect checks)
  await runCase("guest board (tap)", async () => {
    const page = await openBoardPage(context, {
      rows: 3,
      cols: 3,
      values: GUEST_VALUES,
      input: "tap",
    });
    try {
      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, "sumbreak-before.png"),
      });

      const noPreview = await page.evaluate(() =>
        window.runSumbreak("detect", { preview: false })
      );
      assert.equal(noPreview.solvable, true);
      assert.equal(noPreview.rows, 3);
      assert.equal(noPreview.cols, 3);
      assert.equal(noPreview.solved, false);
      assert.equal(noPreview.cells, null);
      assert.equal(noPreview.moves, null);

      const detected = await page.evaluate(() => window.runSumbreak("detect"));
      assert.equal(detected.solvable, true);
      assert.equal(detected.rows, 3);
      assert.equal(detected.cols, 3);
      assert.equal(detected.solved, false);
      assert.equal(detected.cells.length, 9);
      assert.ok(Array.isArray(detected.moves) && detected.moves.length === 8);

      const solved = await page.evaluate(() =>
        window.runSumbreak("solve", { targetMs: 500 })
      );
      assert.equal(solved.ok, true);
      assert.equal(solved.merges, 8);
      assert.equal(solved.board, true);

      const dom = await readFinalDomState(page);
      assert.equal(dom.buttonCount, 1);
      assert.equal(dom.disabled, true);
      assert.equal(dom.svgLabel, "128");

      await page.screenshot({
        path: path.join(SCREENSHOTS_DIR, "sumbreak-after.png"),
      });

      return `merges=${solved.merges}, final=${dom.svgLabel}`;
    } finally {
      await page.close();
    }
  });

  // 2. Guest board under drag (proves tap->drag fallback works)
  await runCase("guest board (drag fallback)", async () => {
    const page = await openBoardPage(context, {
      rows: 3,
      cols: 3,
      values: GUEST_VALUES,
      input: "drag",
    });
    try {
      const detected = await page.evaluate(() => window.runSumbreak("detect"));
      assert.equal(detected.solvable, true);
      assert.equal(detected.solved, false);
      assert.equal(detected.moves.length, 8);

      const solved = await page.evaluate(() =>
        window.runSumbreak("solve", { targetMs: 500 })
      );
      assert.equal(solved.ok, true);
      assert.equal(solved.merges, 8);
      assert.equal(solved.board, true);

      const dom = await readFinalDomState(page);
      assert.equal(dom.buttonCount, 1);
      assert.equal(dom.disabled, true);
      assert.equal(dom.svgLabel, "128");

      return `merges=${solved.merges}, final=${dom.svgLabel}`;
    } finally {
      await page.close();
    }
  });

  // 3. Generated solvable boards (3x3, 4x4, 5x5)
  const generatedSpecs = [
    {
      label: "generated 3x3 full (tap, seed=101)",
      rows: 3,
      cols: 3,
      startPower: 256,
      targetTiles: 9,
      seed: 101,
      input: "tap",
    },
    {
      label: "generated 4x4 full (drag, seed=202)",
      rows: 4,
      cols: 4,
      startPower: 2048,
      targetTiles: 16,
      seed: 202,
      input: "drag",
    },
    {
      label: "generated 4x4 sparse (tap, seed=303)",
      rows: 4,
      cols: 4,
      startPower: 1024,
      targetTiles: 13,
      seed: 303,
      input: "tap",
    },
    {
      label: "generated 5x5 full (drag, seed=404)",
      rows: 5,
      cols: 5,
      startPower: 4096,
      targetTiles: 25,
      seed: 404,
      input: "drag",
    },
  ];

  for (const spec of generatedSpecs) {
    const gen = generateSolvableBoard(spec);
    await runCase(spec.label, async () => {
      const page = await openBoardPage(context, {
        rows: gen.rows,
        cols: gen.cols,
        values: gen.values,
        input: spec.input,
      });
      try {
        const tDetect = performance.now();
        const detected = await page.evaluate(() => window.runSumbreak("detect"));
        const detectMs = Math.round(performance.now() - tDetect);
        assert.equal(detected.solvable, true);
        assert.equal(detected.rows, gen.rows);
        assert.equal(detected.cols, gen.cols);
        assert.equal(detected.solved, false);
        assert.ok(
          Array.isArray(detected.moves) &&
            detected.moves.length === gen.expectedMerges,
          `expected ${gen.expectedMerges} moves, got ${detected.moves?.length}`
        );

        const solved = await page.evaluate(() =>
          window.runSumbreak("solve", { targetMs: 500 })
        );
        assert.equal(solved.ok, true, solved.error || "solve failed");
        assert.equal(solved.merges, gen.expectedMerges);

        const dom = await readFinalDomState(page);
        assert.equal(dom.buttonCount, 1);
        assert.equal(dom.disabled, true);
        assert.equal(dom.svgLabel, String(gen.expectedFinal));

        return `detect=${detectMs}ms, merges=${solved.merges}, final=${dom.svgLabel}`;
      } finally {
        await page.close();
      }
    });
  }

  // 4. Already-solved board
  await runCase("already-solved board", async () => {
    const page = await openBoardPage(context, {
      rows: 3,
      cols: 3,
      values: [0, 0, 128, 0, 0, 0, 0, 0, 0],
      input: "tap",
    });
    try {
      const detected = await page.evaluate(() => window.runSumbreak("detect"));
      assert.equal(detected.solvable, true);
      assert.equal(detected.solved, true);
      assert.equal(detected.moves, null);

      const solved = await page.evaluate(() =>
        window.runSumbreak("solve", { targetMs: 500 })
      );
      assert.equal(solved.ok, true);
      assert.equal(solved.alreadySolved, true);
      assert.equal(solved.merges, 0);

      return "alreadySolved=true";
    } finally {
      await page.close();
    }
  });

  // 5. Unsolvable boards (must return ok:false without hanging)
  await runCase("unsolvable board (non-power-of-two sum)", async () => {
    const page = await openBoardPage(context, {
      rows: 3,
      cols: 3,
      values: [1, 2, 4, 8, 16, 32, 64, 128, 256],
      input: "tap",
    });
    try {
      const detected = await page.evaluate(() => window.runSumbreak("detect"));
      assert.equal(detected.solvable, true);
      assert.equal(detected.solved, false);
      assert.equal(detected.moves, null);

      const solved = await page.evaluate(() =>
        window.runSumbreak("solve", { targetMs: 500 })
      );
      assert.equal(solved.ok, false);
      assert.ok(typeof solved.error === "string" && solved.error.length > 0);
      return `error="${solved.error}"`;
    } finally {
      await page.close();
    }
  });

  await runCase("unsolvable board (power-of-two sum, trapped)", async () => {
    const page = await openBoardPage(context, {
      rows: 3,
      cols: 3,
      values: [1, 4, 1, 2, 8, 16, 32, 64, 0],
      input: "tap",
    });
    try {
      const detected = await page.evaluate(() => window.runSumbreak("detect"));
      assert.equal(detected.solvable, true);
      assert.equal(detected.solved, false);
      assert.equal(detected.moves, null);

      const solved = await page.evaluate(() =>
        window.runSumbreak("solve", { targetMs: 500 })
      );
      assert.equal(solved.ok, false);
      assert.ok(typeof solved.error === "string" && solved.error.length > 0);
      return `error="${solved.error}"`;
    } finally {
      await page.close();
    }
  });
  // 6. Missing board
  await runCase("no board present", async () => {
    const page = await context.newPage();
    try {
      await page.setContent("<!doctype html><html><body><div>No game</div></body></html>");
      await page.addScriptTag({ content: injectedCode });

      const detected = await page.evaluate(() => window.runSumbreak("detect"));
      assert.equal(detected.solvable, false);
      assert.equal(detected.rows, 0);
      assert.equal(detected.cols, 0);
      assert.equal(detected.cells, null);
      assert.equal(detected.moves, null);

      const solved = await page.evaluate(() =>
        window.runSumbreak("solve", { targetMs: 500 })
      );
      assert.equal(solved.ok, false);
      assert.ok(solved.error);
      return "solvable=false, ok=false";
    } finally {
      await page.close();
    }
  });

  // 7. Exclusive lock (busy)
  await runCase("exclusive lock reports busy", async () => {
    const page = await openBoardPage(context, {
      rows: 3,
      cols: 3,
      values: GUEST_VALUES,
      input: "tap",
    });
    try {
      const res = await page.evaluate(async () => {
        document.documentElement.dataset.autosolve = "solving";
        return await window.runSumbreak("solve", { targetMs: 500 });
      });
      assert.equal(res.ok, false);
      assert.equal(res.busy, true);
      assert.equal(res.board, true);
      return "busy=true";
    } finally {
      await page.close();
    }
  });

  // 8. Function.prototype.toString self-containment (chrome.scripting.executeScript pattern)
  await runCase("Function.prototype.toString self-contained execution", async () => {
    const page = await context.newPage();
    const qs = new URLSearchParams({
      rows: "3",
      cols: "3",
      values: GUEST_VALUES.join(","),
      input: "drag",
    });
    try {
      await page.goto(`https://www.linkedin.com/games/sumbreak/?${qs.toString()}`, {
        waitUntil: "domcontentloaded",
      });
      await page.waitForSelector('[data-numo-rows][data-numo-columns][aria-label="Gameboard"]');
      const fnSource = await (async () => {
        const tmp = new Function(`${injectedCode}; return runSumbreak.toString();`);
        return tmp();
      })();
      const res = await page.evaluate(async (src) => {
        const fn = new Function(`return (${src})`)();
        return await fn("solve", { targetMs: 500 });
      }, fnSource);
      assert.equal(res.ok, true);
      assert.equal(res.merges, 8);
      return `merges=${res.merges}`;
    } finally {
      await page.close();
    }
  });
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\nSummary: ${passed}/${results.length} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
