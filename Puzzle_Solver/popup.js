/*
 * Popup logic for Puzzle Solver.
 *
 * The popup works out which game the active tab is showing (gameForUrl in games.js)
 * and drives that game's engine, games/<id>/injected.js, the way each single-game
 * solver's popup did: it INJECTS the engine on demand with
 * chrome.scripting.executeScript into every frame of the tab, so there's no
 * "reload the page after installing" gotcha, it works even if the game iframe
 * loaded before the popup opened, and allFrames reaches the board's frame.
 * Auto-solve on page load is a different job, done by content.js with no popup.
 *
 * UI: the popup is a small state machine. STATES below is the only place that
 * decides what any state looks like; setState() writes data-state on <body> and
 * the stylesheets react to it. The game in the tab goes on <html data-game>, which
 * the stylesheets use for that game's colours and board preview.
 */

const statusEl = document.getElementById("status-text");
const actionBtn = document.getElementById("action");
const actionLabel = document.getElementById("action-label");
const hintLink = document.getElementById("hint-link");
const hintText = document.getElementById("hint-text");
const siteLink = document.getElementById("site-link");
const brandIcon = document.getElementById("brand-icon");
const boardEl = document.getElementById("board");
const stripEl = document.getElementById("strip");
const listEl = document.getElementById("list");
const menuBtn = document.getElementById("menu-btn");
const menuEl = document.getElementById("menu");
const rowsEl = document.getElementById("settings-rows");

let pollTimer = null;

/** The game in the active tab, or null off a game page. Set once in init(). */
let game = null;
/** That game's board preview (see previews.js), or null. */
let preview = null;

const POLL_MS = 800;
// A board that is merely still rendering shouldn't flash "No board found" the
// instant the popup opens, so the opening state is held briefly before we
// conclude there's nothing there.
const GRACE_MS = 1600;

/** A message that differs per game: `<id>_<key>` in messages.json. */
const gt = (key, ...subs) => t(`${game ? game.id : "zip"}_${key}`, ...subs);

/**
 * Every UI state, in one table. `status`/`label`/`hint` may be functions of the
 * payload. `act` is what a click does: null means the button is inert.
 */
const STATES = {
  checking: { status: () => t("stChecking"), label: () => t("lblChecking"), hint: "hintAny", act: null },
  // Not on a game page: the board and button give way to the list of games.
  list: { status: () => t("stList"), label: () => t("lblChecking"), hint: "hintAny", act: null },
  // On a game page, but no board turned up.
  idle: { status: () => t("stIdle"), label: () => gt("lblOpen"), hint: "hintAny", act: "open" },
  ready: { status: (d) => t("stReady", d.rows, d.cols), label: () => t("lblSolve"), hint: "hintAny", act: "solve" },
  // Mini Sudoku: the board is behind its start screen until the round starts.
  waiting: { status: () => t("stWaiting"), label: () => t("lblWaiting"), hint: "hintAny", act: null },
  // Patches: a board is there but already covered, so there's nothing to place.
  stuck: { status: () => t("stStuck"), label: () => t("lblNothing"), hint: "hintAny", act: null },
  solving: { status: () => gt("stSolving"), label: () => t("lblSolving"), hint: "hintAny", act: null },
  solved: {
    // The elapsed time is appended here too so the live region reads it aloud.
    // Queens also says how many wrong crowns it cleared, when there were any.
    status: (d) => {
      const base = d.cleared ? gt("stSolvedCleared", d.placed, d.cleared) : gt("stSolved", d.placed);
      return d.ms != null ? `${base} · ${fmtSeconds(d.ms)}` : base;
    },
    label: () => t("lblSolved"),
    hint: "hintSolved",
    act: null,
  },
  // The board was already finished when we looked — distinct from `solved`, which
  // means we did it. Nothing to claim credit for, so no entrance flourish either.
  done: { status: (d) => t("stDone", d.rows, d.cols), label: () => t("lblAlready"), hint: "hintSolved", act: null },
  error: { status: (d) => d.message, label: () => t("lblTryAgain"), hint: "hintAny", act: "solve" },
};

let state = "checking";
const openedAt = Date.now();

const resolve = (v, d) => (typeof v === "function" ? v(d) : v);

/** The single way the UI changes. */
function setState(next, data = {}) {
  const spec = STATES[next];
  state = next;
  document.body.dataset.state = next;
  statusEl.textContent = resolve(spec.status, data);
  actionLabel.textContent = resolve(spec.label, data);
  hintText.textContent = t(spec.hint);
  hintLink.href = siteUrl(next, null, game);
  actionBtn.disabled = spec.act === null;
  actionBtn.setAttribute("aria-busy", String(next === "solving"));
}

/** Rows and columns of a detect or solve result: Patches and Sumbreak report both. */
const dims = (r) => ({ rows: r.rows ?? r.N, cols: r.cols ?? r.N });

/* ---------------------------------------------------------------- icons */

/**
 * The extension's own icon, resolved through chrome.runtime.getURL so it works
 * however the popup document is served. Sizes are tried largest first and we step
 * down on error, so a missing file degrades instead of leaving a broken image.
 */
const ICON_SIZES = [128, 48, 32, 16];
const asset = (path) =>
  typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL ? chrome.runtime.getURL(path) : path;

function loadBrandIcon(i = 0) {
  if (i >= ICON_SIZES.length) {
    brandIcon.hidden = true;
    return;
  }
  brandIcon.onerror = () => loadBrandIcon(i + 1);
  brandIcon.src = asset(`images/icon-${ICON_SIZES[i]}.png`);
}

function gameIcon(g) {
  const img = document.createElement("img");
  img.className = "game-icon";
  img.src = asset(`images/games/${g.id}.png`);
  img.alt = "";
  img.width = 24;
  img.height = 24;
  return img;
}

/* ------------------------------------------------------------- NEW badges */

// Two kinds of NEW badge, both remembered in localStorage (synchronous, so the
// write lands before a new tab takes focus and the popup closes). If storage is
// blocked the badges simply stay on.
//  - The puzzle site's, until either site link has been opened from the popup once.
//  - A new game's (isNew in GAMES), until the popup has been opened on that game or
//    has opened it.
const SITE_SEEN_KEY = "siteSeen";
const seenKey = (g) => `seen:${g.id}`;

function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}

const isNewToUser = (g) => !!g.isNew && stored(seenKey(g)) !== "1";

function markGameSeen(g) {
  if (!g.isNew) return;
  store(seenKey(g), "1");
  for (const b of document.querySelectorAll(`[data-new-game="${g.id}"]`)) b.hidden = true;
}

function newBadge(g) {
  const badge = document.createElement("span");
  badge.className = "badge";
  badge.dataset.newGame = g.id;
  badge.textContent = t("badgeNew");
  return badge;
}

const siteBadges = document.querySelectorAll("[data-site-badge]");

function markSiteSeen() {
  store(SITE_SEEN_KEY, "1");
  for (const badge of siteBadges) badge.hidden = true;
}

if (stored(SITE_SEEN_KEY) !== "1") for (const badge of siteBadges) badge.hidden = false;

for (const link of [hintLink, siteLink]) {
  link.addEventListener("click", markSiteSeen);
  // A middle-click opens the site in a background tab too.
  link.addEventListener("auxclick", (e) => {
    if (e.button === 1) markSiteSeen();
  });
}

/* ------------------------------------------------------- strip and game list */

function openGame(g) {
  markGameSeen(g);
  chrome.tabs.create({ url: gameUrl(g) });
  window.close();
}

/** The row of games under the header, on a game page. The tab's game is marked. */
function buildStrip() {
  const frag = document.createDocumentFragment();
  for (const g of GAMES) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "strip__game";
    btn.style.setProperty("--game", g.accent);
    btn.dataset.game = g.id;
    const label = document.createElement("span");
    label.className = "strip__name";
    label.textContent = g.short || g.name;
    btn.append(gameIcon(g), label);
    if (g === game) {
      btn.setAttribute("aria-current", "page");
    } else {
      btn.title = t("openGame", g.name);
      btn.addEventListener("click", () => openGame(g));
    }
    if (isNewToUser(g) && g !== game) {
      const dot = document.createElement("span");
      dot.className = "strip__new";
      dot.dataset.newGame = g.id;
      dot.setAttribute("aria-label", t("badgeNew"));
      btn.appendChild(dot);
    }
    frag.appendChild(btn);
  }
  stripEl.replaceChildren(frag);
}

/** Off a game page: every game, each opening its page on LinkedIn. */
function buildList() {
  const frag = document.createDocumentFragment();
  for (const g of GAMES) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "list__game";
    const name = document.createElement("span");
    name.className = "list__name";
    name.textContent = g.name;
    if (isNewToUser(g)) name.appendChild(newBadge(g));
    const open = document.createElement("span");
    open.className = "list__open";
    open.textContent = t("open");
    btn.append(gameIcon(g), name, open);
    btn.addEventListener("click", () => openGame(g));
    li.appendChild(btn);
    frag.appendChild(li);
  }
  listEl.replaceChildren(frag);
}

/* ---------------------------------------------------------------- settings */

// Each game has its own Auto-solve (on by default) and Solve time in whole seconds.
//
// Storage is deliberately split:
//  - The popup's own copy lives in synchronous localStorage, so a change is durable
//    the instant it's made. chrome.storage.local.set is ASYNC, and a popup that
//    closes right after a toggle can be torn down before that write flushes.
//  - content.js can't read the popup's localStorage (different origin), so we ALSO
//    mirror to chrome.storage.local for it (best-effort), and reconcile that mirror
//    from localStorage every time the popup opens in case a write was ever lost.
// This extension took over the Zip Solver's store listing, so an existing user's
// popup localStorage still holds Zip's old `autosolve` / `targetMs`. settingsFor()
// reads those as Zip's settings until Zip's own entry is written.
const TARGET_MIN_S = 1;
const TARGET_MAX_S = 999; // the box accepts up to three digits
const clampSecs = (s) => Math.min(TARGET_MAX_S, Math.max(TARGET_MIN_S, s));

/** Every game's settings, by id. */
const settings = {};

function loadSettings() {
  let saved = null;
  let legacy = null;
  try {
    saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null");
    const oldAuto = localStorage.getItem("autosolve");
    const oldMs = parseInt(localStorage.getItem("targetMs"), 10);
    if (oldAuto !== null || Number.isFinite(oldMs)) {
      legacy = {};
      if (oldAuto !== null) legacy.autosolve = oldAuto === "1";
      if (Number.isFinite(oldMs)) legacy.targetMs = oldMs;
    }
  } catch {
    /* localStorage blocked or unreadable — the defaults apply */
  }
  for (const g of GAMES) {
    const s = settingsFor(g.id, saved, legacy);
    s.targetMs = clampSecs(Math.round(s.targetMs / 1000)) * 1000;
    settings[g.id] = s;
  }
  // Re-assert the content script's mirror from the reliable copy on every open.
  mirrorToContentScript();
}

function mirrorToContentScript() {
  try {
    chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  } catch {
    /* mirror unavailable — the popup's own localStorage copy still holds */
  }
}

function saveSettings() {
  store(SETTINGS_KEY, JSON.stringify(settings));
  mirrorToContentScript();
}

/** One settings row: icon, name, Solve time box, Auto-solve switch. */
function settingsRow(g) {
  const s = settings[g.id];
  const row = document.createElement("div");
  row.className = "settings__row";
  row.style.setProperty("--game", g.accent);
  if (g === game) row.classList.add("settings__row--here");
  row.dataset.off = String(!s.autosolve);

  const name = document.createElement("span");
  name.className = "settings__name";
  name.id = `name-${g.id}`;
  name.textContent = g.name;
  if (g === game) {
    const here = document.createElement("span");
    here.className = "settings__here";
    here.textContent = t("thisPage");
    name.appendChild(here);
  } else if (isNewToUser(g)) {
    name.appendChild(newBadge(g));
  }

  // The time box: whole seconds, 1–999. Filtered to digits as it's typed and
  // saved on every keystroke (so closing the popup mid-edit keeps it), clamped and
  // normalised on commit, stepped with ↑/↓.
  const time = document.createElement("span");
  time.className = "settings__time";
  const input = document.createElement("input");
  input.type = "text";
  input.inputMode = "numeric";
  input.autocomplete = "off";
  input.maxLength = 3;
  input.className = "settings__input";
  input.value = String(Math.round(s.targetMs / 1000));
  input.setAttribute("aria-label", t("solveTimeFor", g.name));
  const unit = document.createElement("span");
  unit.className = "settings__unit";
  unit.textContent = "s";
  unit.setAttribute("aria-hidden", "true");
  time.append(input, unit);

  const secsShown = () => {
    const v = parseInt(input.value, 10);
    return Number.isFinite(v) ? v : Math.round(s.targetMs / 1000);
  };
  const setSecs = (secs) => {
    s.targetMs = secs * 1000;
    input.value = String(secs);
    saveSettings();
  };
  input.addEventListener("input", () => {
    const digits = input.value.replace(/\D/g, "").slice(0, 3);
    if (digits !== input.value) input.value = digits;
    s.targetMs = clampSecs(secsShown()) * 1000;
    saveSettings();
  });
  const commit = () => setSecs(clampSecs(secsShown()));
  input.addEventListener("change", commit);
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp" || e.key === "ArrowDown") {
      e.preventDefault();
      setSecs(clampSecs(secsShown() + (e.key === "ArrowUp" ? 1 : -1)));
    } else if (e.key === "Enter") {
      e.preventDefault();
      input.blur();
    }
  });
  // Scrolling over the box nudges it too, without scrolling the popup.
  input.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      setSecs(clampSecs(secsShown() + (e.deltaY < 0 ? 1 : -1)));
    },
    { passive: false }
  );

  const sw = document.createElement("button");
  sw.type = "button";
  sw.className = "switch";
  sw.setAttribute("role", "switch");
  sw.setAttribute("aria-checked", String(s.autosolve));
  sw.setAttribute("aria-label", t("autoSolveFor", g.name));
  sw.innerHTML = '<span class="switch__knob"></span>';
  sw.addEventListener("click", () => {
    s.autosolve = !s.autosolve;
    sw.setAttribute("aria-checked", String(s.autosolve));
    row.dataset.off = String(!s.autosolve);
    saveSettings();
    // If this game's board is already sitting in `ready`, honour the new setting
    // at once rather than waiting for a detect that may never come (polling has
    // stopped once a board is found).
    if (g === game && s.autosolve && state === "ready") runSolve();
  });

  row.append(gameIcon(g), name, time, sw);
  return row;
}

/** The tab's game first, then the rest in their usual order. */
function buildSettings() {
  const order = game ? [game, ...GAMES.filter((g) => g !== game)] : GAMES;
  rowsEl.replaceChildren(...order.map(settingsRow));
}

/* ------------------------------------------------------------ settings menu */

function openMenu() {
  if (!menuEl.hidden) return;
  menuEl.hidden = false;
  menuBtn.setAttribute("aria-expanded", "true");
  // Focus the dialog itself, not its first box: a text box focused this way shows
  // its focus ring even after a mouse click, which reads as "Zip is being edited".
  // Tab goes on into the rows from here.
  menuEl.focus();
  // Capture phase, so a click anywhere outside closes the menu.
  document.addEventListener("pointerdown", onOutsidePointer, true);
}

function closeMenu({ refocus = false } = {}) {
  if (menuEl.hidden) return;
  menuEl.hidden = true;
  menuBtn.setAttribute("aria-expanded", "false");
  document.removeEventListener("pointerdown", onOutsidePointer, true);
  // Only pull focus back when the user dismissed it deliberately (Escape / the
  // cog); doing it on an outside click would steal focus from whatever they hit.
  if (refocus) menuBtn.focus();
}

function onOutsidePointer(e) {
  if (!menuEl.contains(e.target) && !menuBtn.contains(e.target)) closeMenu();
}

menuBtn.addEventListener("click", () => {
  if (menuEl.hidden) openMenu();
  else closeMenu({ refocus: true });
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !menuEl.hidden) {
    e.preventDefault();
    closeMenu({ refocus: true });
  }
});

// Tabbing out of the last control closes the menu behind it.
menuEl.addEventListener("focusout", (e) => {
  if (e.relatedTarget && !menuEl.contains(e.relatedTarget) && e.relatedTarget !== menuBtn) closeMenu();
});

siteLink.addEventListener("click", () => closeMenu());

/* -------------------------------------------------------------------- timer */

// How long the last solve took. Not shown on screen: the figure goes only into the
// solved status line, which screen readers announce.
let timerStart = 0;
let elapsedMs = 0;

function startTimer() {
  timerStart = performance.now();
  elapsedMs = 0;
}

function stopTimer() {
  elapsedMs = performance.now() - timerStart;
}

/* ------------------------------------------------------------------ solving */

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function getActiveTabId() {
  const tab = await getActiveTab();
  return tab ? tab.id : null;
}

/** Run the game's engine (mode, opts) in every frame; return the non-null results. */
async function runInFrames(mode, opts) {
  const tabId = await getActiveTabId();
  const engine = game && globalThis[game.runner];
  if (tabId == null || typeof engine !== "function") return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: engine, // from games/<id>/injected.js
      args: [mode, opts || {}],
    });
    return results.map((r) => r && r.result).filter(Boolean);
  } catch (e) {
    // e.g. the frame can't be scripted — treat as "no board".
    return [];
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * States that are the result of the user pressing the button. Once we're in one,
 * the poller must not speak over it — an "error" in particular stays put until the
 * user retries.
 */
const USER_OWNED = new Set(["solving", "solved", "error"]);

/**
 * The solve marker (see exclusive() in each injected.js) from whichever frame
 * carries one, or null. Every solve writes it, whether content.js's auto-solve or
 * one a popup started, so a popup opened mid-solve can show it. The reader is
 * passed to executeScript, so it must be self-contained.
 */
async function readAutoSolve() {
  const tabId = await getActiveTabId();
  if (tabId == null) return null;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        const d = document.documentElement.dataset;
        if (!d.autosolve) return null;
        let result = null;
        try {
          result = JSON.parse(d.autosolveResult || "null");
        } catch {
          /* unreadable — treat as no result */
        }
        return { state: d.autosolve, startedAt: Number(d.autosolveStart) || Date.now(), result };
      },
    });
    return results.map((r) => r && r.result).find(Boolean) || null;
  } catch (e) {
    return null;
  }
}

/**
 * True while the `solving` on screen is a solve running in the page that this popup
 * isn't awaiting — content.js's auto-solve, or one started from an earlier popup
 * that was closed mid-solve. refresh() keeps polling through it to catch the finish.
 */
let watchingAuto = false;

/** Whether a solve this popup started now owns the UI (see USER_OWNED). */
const superseded = () => USER_OWNED.has(state) && !watchingAuto;

/** The solved-state payload from an engine's result. Sumbreak counts merges. */
const solvedData = (r) => ({ placed: r.placed ?? r.merges, cleared: r.cleared });

/**
 * Mirror a solve running in the page: `solving` while it runs, with the timer
 * counting from when it started, then its outcome. Returns true when the marker
 * decided the state.
 */
function showAutoSolve(auto, boardSolved, data) {
  if (auto && auto.state === "solving") {
    if (!watchingAuto) {
      watchingAuto = true;
      setState("solving", data);
      startTimer();
      timerStart -= Date.now() - auto.startedAt;
    }
    return true;
  }
  const wasWatching = watchingAuto;
  if (wasWatching) {
    watchingAuto = false;
    stopTimer();
  }
  if (!auto || !auto.result) return false;
  if (auto.state === "solved" && (wasWatching || boardSolved)) {
    elapsedMs = auto.result.ms;
    setState("solved", { ...data, ...solvedData(auto.result), ms: auto.result.ms });
    stopPolling();
    return true;
  }
  if (auto.state === "failed" && wasWatching) {
    setState("error", { message: tError(auto.result.error) || t("errNoFinish") });
    stopPolling();
    return true;
  }
  return false;
}

/** Detect a board; move to `ready` only when one is present & solvable. */
async function refresh() {
  if (superseded()) return;
  const autoSolve = settings[game.id].autosolve;

  // Following a solve in the page, or holding a found board while Auto-solve is due
  // to start on it: only the marker can move things on from here, and reading it is
  // far cheaper than a detect.
  if (watchingAuto || (state === "ready" && autoSolve)) {
    const auto = await readAutoSolve();
    if (superseded()) return;
    if (watchingAuto ? auto && auto.state === "solving" : !auto) return;
  }

  const results = await runInFrames("detect");
  const board = results.find((r) => r.solvable);

  if (board) {
    const auto = await readAutoSolve();
    if (superseded()) return;
    // Draw before switching state: the board element is revealed by the state
    // change, so filling it first avoids a frame of empty grid.
    if (preview) preview.renderBoard(board);
    const d = dims(board);
    if (!board.solved && board.playable === false) {
      setState("waiting", d);
      return; // keep polling for the round to start
    }
    // No auto-solve on detect here: content.js is already solving on page load,
    // and a second solve from the popup would run concurrently.
    if (showAutoSolve(auto, board.solved, d)) return;
    setState(board.solved ? "done" : "ready", d);
    if (board.solved || !autoSolve || auto) stopPolling();
    return;
  }

  // Patches: a board that's present but has nothing left to place.
  const present = results.find((r) => r.present);
  if (present) {
    if (preview) preview.renderBoard(present);
    setState("stuck");
    stopPolling();
    return;
  }

  if (state === "checking" && Date.now() - openedAt < GRACE_MS) return;
  setState("idle");
}

/**
 * Solve the current board. Shared by the Solve button and the auto-solve switch,
 * so the timer and result handling live in one place.
 */
async function runSolve() {
  stopPolling();
  setState("solving");
  startTimer();

  const results = await runInFrames("solve", { targetMs: settings[game.id].targetMs });

  // Another solve already holds this board — usually content.js's auto-solve,
  // started between our last poll and the click. Follow it instead.
  if (results.some((r) => r.busy)) {
    const auto = await readAutoSolve();
    watchingAuto = true;
    if (auto) timerStart = performance.now() - (Date.now() - auto.startedAt);
    pollTimer = setInterval(refresh, POLL_MS);
    return;
  }
  stopTimer();

  const ok = results.find((r) => r.ok);
  if (ok) {
    // alreadySolved: the board was completed between our last poll and this click.
    setState(ok.alreadySolved ? "done" : "solved", {
      ...dims(ok),
      ...solvedData(ok),
      ms: ok.alreadySolved ? null : elapsedMs,
    });
    return;
  }
  // Prefer the frame that held the board: every other frame only ever says "Board
  // not found", which would bury the real reason.
  const err = results.find((r) => r.board && r.error) || results.find((r) => r.error);
  setState("error", { message: err ? tError(err.error) : t("errNoFrame") });
}

actionBtn.addEventListener("click", () => {
  const act = STATES[state].act;
  if (act === "open") {
    chrome.tabs.create({ url: gameUrl(game) });
    window.close();
    return;
  }
  if (act === "solve") runSolve();
});

/* --------------------------------------------------------------------- init */

async function init() {
  loadBrandIcon();
  loadSettings();
  siteLink.href = siteUrl("menu", null, game);

  const tab = await getActiveTab().catch(() => null);
  game = gameForUrl(tab && tab.url);
  document.documentElement.dataset.game = game ? game.id : "";
  siteLink.href = siteUrl("menu", null, game);
  buildSettings();

  if (!game) {
    buildList();
    setState("list");
    return;
  }

  markGameSeen(game);
  buildStrip();
  preview = makePreview(game.id, boardEl);
  // Draw the empty grid before the first paint so the popup opens as a board rather
  // than snapping into one a moment later.
  if (preview) preview.renderPlaceholder();
  setState("checking");
  refresh();
  pollTimer = setInterval(refresh, POLL_MS);
}

init();
