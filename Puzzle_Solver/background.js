/*
 * Background worker. Two jobs:
 *
 *  1. Point new and departing users at LinkedIn Ranked: opens it on first install
 *     (never on updates, so Zip Solver users moving onto this extension aren't sent
 *     anywhere) and sets it as the page shown after uninstall.
 *
 *  2. Run "Solve all" from the popup, in the tab the popup was opened on. Changing
 *     that tab's page doesn't take focus, so the popup stays open and shows the
 *     run's progress (a new tab would close it), and the tab stays in front (a
 *     background tab's timers are throttled to about once a second, which would
 *     crawl through the engines' paced clicks). The run:
 *       - first loads LinkedIn's games page, where hub.js reports which games are
 *         solved today already, here or on another device, and drops those;
 *       - then walks the tab through the rest, each with ?skipStartScreen=true
 *         (LinkedIn's own switch past its start screen). content.js on each page
 *         asks whether it's part of the run, solves, and reports back; this moves
 *         the tab on to the next game.
 *     The run is kept in storage (RUN_KEY), not in memory: an MV3 worker is stopped
 *     after ~30 s idle, and everything here is driven by events (messages, the tab
 *     closing), never by a timer of its own. Progress shows on the toolbar badge,
 *     "…" on the games page, then "2/4".
 *
 * None of this needs a permission beyond the ones the solvers always had.
 */
importScripts("games.js", "site.js");

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.runtime.setUninstallURL(siteUrl("uninstall"));
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({ url: siteUrl("install") });
  }
});

/* ---------------------------------------------------------------- solve all */

// A run that has made no progress for this long is over: its tab left the game
// (a sign-in redirect, say), the extension was reloaded under it, or the browser
// quit mid-run. Before a game starts solving it gets STALL_MS; once solving, its
// Solve time on top.
const STALL_MS = 60000;

async function getRun() {
  const got = await chrome.storage.local.get(RUN_KEY);
  return got[RUN_KEY] || null;
}

async function setRun(run) {
  if (run) await chrome.storage.local.set({ [RUN_KEY]: { ...run, stepAt: Date.now() } });
  else await chrome.storage.local.remove(RUN_KEY);
  showBadge(run);
}

function showBadge(run) {
  const text = !run ? "" : run.phase === "hub" ? "…" : `${run.index + 1}/${run.queue.length}`;
  chrome.action.setBadgeText({ text });
  if (run) chrome.action.setBadgeBackgroundColor({ color: "#0a66c2" });
}

/** The current game's Solve time, for the stall allowance once it's solving. */
async function targetMsFor(id) {
  try {
    const got = await chrome.storage.local.get([SETTINGS_KEY, "autosolve", "targetMs"]);
    const legacy = "autosolve" in got || "targetMs" in got ? got : null;
    return settingsFor(id, got[SETTINGS_KEY], legacy).targetMs;
  } catch {
    return DEFAULT_SETTINGS.targetMs;
  }
}

/** The stored run if it's still alive; a dead one is cleared and null returned. */
async function liveRun() {
  const run = await getRun();
  if (!run) return null;
  let alive = true;
  try {
    await chrome.tabs.get(run.tabId);
  } catch {
    alive = false; // the tab is gone
  }
  if (alive) {
    const allowance = STALL_MS + (run.started ? await targetMsFor(run.queue[run.index]) : 0);
    if (Date.now() - (run.stepAt || 0) > allowance) alive = false;
  }
  if (!alive) {
    await setRun(null);
    return null;
  }
  return run;
}

/** The game the run is on, if `sender` is the run's tab. */
const isCurrent = (run, sender, id) =>
  !!run && run.phase === "games" && !!sender.tab && sender.tab.id === run.tabId && run.queue[run.index] === id;

/**
 * Start a run over `ids` (the popup sends the games not solved today) in `tabId`,
 * the tab the popup was opened on, or a new tab when there isn't one.
 */
async function startRun(ids, tabId) {
  const existing = await liveRun();
  if (existing) return existing;
  const queue = ids.filter((id) => GAME_BY_ID[id]);
  if (!queue.length) return null;
  const makeBlankTab = async () => (await chrome.tabs.create({ url: "about:blank", active: true })).id;
  if (tabId == null) {
    // Open the tab blank and store the run before loading the games page, so
    // nothing in it can report before the run exists.
    tabId = await makeBlankTab();
  }
  let run = { tabId, phase: "hub", queue, index: 0, started: false, solved: [] };
  await setRun(run);
  try {
    await chrome.tabs.update(tabId, { url: HUB_URL });
  } catch {
    // A privileged tab (chrome://, the web store) can't be navigated: fall back
    // to a fresh tab so Solve all still works from there.
    try {
      run = { ...run, tabId: await makeBlankTab() };
      await setRun(run);
      await chrome.tabs.update(run.tabId, { url: HUB_URL });
    } catch {
      await setRun(null);
      return null;
    }
  }
  return run;
}

/** The games page has said which games are solved: drop those and start on the rest. */
async function fromHub(run, solvedIds, signedIn) {
  const queue = run.queue.filter((id) => !solvedIds.includes(id));
  if (!queue.length) {
    await setRun(null); // everything's done already; the tab stays on the games page
    return;
  }
  // skipStart: whether game URLs get ?skipStartScreen=true (signed in only, see
  // solveAllUrl). retried: whether the current game has been sent back here once.
  const next = { ...run, phase: "games", queue, index: 0, started: false, skipStart: !!signedIn, retried: false };
  await setRun(next);
  await openCurrent(next);
}

/** Load the run's current game in its tab. */
async function openCurrent(run) {
  try {
    await chrome.tabs.update(run.tabId, { url: solveAllUrl(GAME_BY_ID[run.queue[run.index]], run.skipStart && !run.retried) });
  } catch {
    await setRun(null); // the tab is gone
  }
}

/**
 * The games page reported while the run was on a game: LinkedIn sent the game's
 * URL back there (a signed-out visit with ?skipStartScreen=true does that). Try the
 * game once more by its plain URL (and keep skipStart off for the rest of the run),
 * then give up on it and move on.
 */
async function bouncedToHub(run) {
  if (run.started) return;
  if (run.skipStart && !run.retried) {
    const next = { ...run, skipStart: false, retried: true, started: false };
    await setRun(next);
    await openCurrent(next);
  } else {
    await advance(run, false);
  }
}

/** Move the run on to its next game, or finish it. */
async function advance(run, ok) {
  if (ok) run.solved.push(run.queue[run.index]);
  run.index += 1;
  run.started = false;
  run.retried = false;
  if (run.index >= run.queue.length) {
    await setRun(null);
    return;
  }
  await setRun(run);
  await openCurrent(run);
}

async function handle(msg, sender) {
  const run = await getRun();
  switch (msg.type) {
    case "solveAll:start":
      return startRun(Array.isArray(msg.ids) ? msg.ids : [], Number.isInteger(msg.tabId) ? msg.tabId : null);
    case "solveAll:stop":
      await setRun(null);
      return null;
    case "solveAll:status":
      return liveRun();
    case "solveAll:ask":
      return { active: isCurrent(run, sender, msg.game) };
    case "solveAll:hub":
      if (run && sender.tab && sender.tab.id === run.tabId) {
        if (run.phase === "hub") await fromHub(run, Array.isArray(msg.solved) ? msg.solved : [], msg.signedIn);
        else await bouncedToHub(run);
      }
      return null;
    case "solveAll:started":
      if (isCurrent(run, sender, msg.game)) await setRun({ ...run, started: true });
      return null;
    case "solveAll:done":
      if (isCurrent(run, sender, msg.game)) await advance(run, !!msg.ok);
      return null;
    case "solveAll:stuck":
      // The page's give-up timer. Ignored once a frame has started solving: a
      // slow solve (a long Solve time) isn't a stuck one.
      if (isCurrent(run, sender, msg.game) && !run.started) await advance(run, false);
      return null;
  }
  return null;
}

// Every handler reads the run, changes it and writes it back, so they take turns:
// a Stop arriving while a finished game is moving the tab on must not be undone
// by that move writing the run back.
let queue = Promise.resolve();
const inTurn = (job) => (queue = queue.then(job, job));

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("solveAll:")) return;
  inTurn(() => handle(msg, sender)).then(reply, () => reply(null));
  return true; // reply is async
});

// The run's tab closed: the run is over.
chrome.tabs.onRemoved.addListener((tabId) =>
  inTurn(async () => {
    const run = await getRun();
    if (run && run.tabId === tabId) await setRun(null);
  })
);

// A browser restart or an update ends any run: its tab's page no longer has a
// content script listening for it.
chrome.runtime.onStartup.addListener(() => inTurn(() => setRun(null)));
chrome.runtime.onInstalled.addListener(() => inTurn(() => setRun(null)));

/* ------------------------------------------------------- incognito records */

// Incognito's own solved days (see games.js) last only as long as incognito does:
// cleared when the last incognito window closes, and on startup in case the
// browser quit with one open.
async function clearIncognito() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(INCOGNITO_PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
}

chrome.windows.onRemoved.addListener(async () => {
  const windows = await chrome.windows.getAll();
  if (!windows.some((w) => w.incognito)) await clearIncognito();
});
chrome.runtime.onStartup.addListener(() => clearIncognito());

// A worker restarted mid-run still shows its progress, if the run is alive.
inTurn(() => liveRun().then(showBadge)).catch(() => {});
