/*
 * Popup logic for the Tango Auto-Solver.
 *
 * Instead of a pre-injected content script, the popup INJECTS the engine on demand
 * with chrome.scripting.executeScript into every frame of the active tab (see
 * injected.js for the rationale). runTango is defined in injected.js (loaded first)
 * and passed by reference to executeScript, which serializes it into the MAIN world.
 */

const statusEl = document.getElementById("status");
const solveBtn = document.getElementById("solve");
let pollTimer = null;

// URL of the LinkedIn Tango game, opened when no board is detected.
const TANGO_URL = "https://www.linkedin.com/games/tango/";

// Tracks what the button currently does: "solve" when a board is present,
// "open" when none is detected (clicking opens the game).
let mode = "open";

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ? tab.id : null;
}

/** Run runTango(mode) in every frame; return the array of non-null results. */
async function runInFrames(mode) {
  const tabId = await getActiveTabId();
  if (tabId == null) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: "MAIN",
      func: runTango, // from injected.js
      args: [mode],
    });
    return results.map((r) => r && r.result).filter(Boolean);
  } catch (e) {
    // e.g. not a linkedin tab, or the frame can't be scripted — treat as "no board".
    return [];
  }
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/** Detect a board; enable the Solve button only when one is present & solvable. */
async function refresh() {
  const results = await runInFrames("detect");
  const board = results.find((r) => r.solvable);
  if (board) {
    mode = "solve";
    solveBtn.disabled = false;
    solveBtn.textContent = "Solve puzzle";
    statusEl.textContent = `Board detected (${board.N}×${board.N}). Ready to solve.`;
    stopPolling(); // found it — stop re-checking
  } else {
    mode = "open";
    solveBtn.disabled = false;
    solveBtn.textContent = "Open Tango game";
    statusEl.textContent = "No board detected. Open the Tango game to get started.";
  }
}

solveBtn.addEventListener("click", async () => {
  if (mode === "open") {
    // No board is present — open the Tango game in a new tab.
    chrome.tabs.create({ url: TANGO_URL });
    window.close();
    return;
  }
  solveBtn.disabled = true;
  stopPolling();
  statusEl.textContent = "Solving…";
  const results = await runInFrames("solve");
  const ok = results.find((r) => r.ok);
  if (ok) {
    statusEl.textContent = `Done — filled ${ok.placed} cells. ☀️🌙`;
  } else {
    const err = results.find((r) => r.error);
    statusEl.textContent = "Error: " + (err ? err.error : "no board frame responded.");
    solveBtn.disabled = false;
    pollTimer = setInterval(refresh, 800); // resume polling after a failure
  }
});

// Detect immediately, then keep polling so the button auto-enables the moment the
// game finishes loading — no need to close/reopen the popup.
refresh();
pollTimer = setInterval(refresh, 800);
