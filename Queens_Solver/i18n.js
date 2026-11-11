/*
 * Translation helpers for the popup. Loaded before popup.js.
 *
 * The text itself lives in _locales/<locale>/messages.json, and both that and this
 * file are written by scripts/build_locales.py: edit scripts/i18n.js and the strings
 * in that script, then run it. This copy is identical in all five solvers.
 *
 * Chrome picks the locale from the browser's own language and falls back to English
 * for any language without a translation, so there is nothing to choose here.
 */

/** The message for `key` in the browser's language, with $1, $2… filled from `subs`. */
function t(key, ...subs) {
  return chrome.i18n.getMessage(key, subs.map(String)) || key;
}

// The engines run in the page, where chrome.i18n doesn't exist, so they report errors
// in English. Each entry pairs a pattern matching one of those errors with the message
// key that translates it; a group in the pattern becomes that message's $1, $2….
// BEGIN ENGINE_ERRORS (written by scripts/build_locales.py)
const ENGINE_ERRORS = [
  ["^A solve is already running on this board\\.$", "errBusy"],
  ["^Solve failed: (.+?)$", "errFailed"],
  ["^Board not found or still loading\\.$", "errNoBoard"],
  ["^No solution exists for this board\\.$", "errNoSolution"],
  ["^The board still isn't solved\\. Try again\\.$", "errUnsolved"],
  ["^A click didn't register\\. Try again\\.$", "errClick"],
  ["^Read (.+?) colours on a (.+?)\u00d7(.+?) board\\.$", "errColours"],
  ["^Couldn't tell clues from guesses on this board\\.$", "errCluesGuesses"],
  ["^Number pad not found\\. Start the round first\\.$", "errNoPad"],
  ["^A digit didn't register\\. Try again\\.$", "errDigit"],
  ["^Could not focus the gameboard\\.$", "errFocus"],
  ["^Cursor navigation failed\\.$", "errCursor"],
  ["^Couldn't clear the patches already on the board\\.$", "errClearPatches"],
  ["^Patch (.+?) of (.+?) wouldn't draw\\. Try again\\.$", "errPatchDraw"],
  ["^No rectangle tiling found for this board\\.$", "errNoTiling"],
  ["^Couldn't find a path in time\\. The board may have been misread\\.$", "errPathTime"],
  ["^No path exists for this board\\.$", "errNoPath"],
  ["^Couldn't clear the path already drawn\\. Undo it and try again\\.$", "errClearPath"],
  ["^Internal: non-adjacent path step\\.$", "errInternalStep"],
  ["^The path stopped after (.+?) of (.+?) cells\\. Try again\\.$", "errPathStopped"],
];
// END ENGINE_ERRORS

/** An engine's English error in the browser's language; unknown errors pass through. */
function tError(message) {
  if (!message) return message;
  for (const [pattern, key] of ENGINE_ERRORS) {
    const m = new RegExp(pattern).exec(message);
    if (m) return t(key, ...m.slice(1));
  }
  return message;
}

/** Seconds to one decimal place, written the way the popup's language writes it. */
function fmtSeconds(ms) {
  const n = Math.max(0, ms) / 1000;
  return (
    n.toLocaleString(t("localeTag"), {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    }) + "s"
  );
}

// Translate the static markup: data-i18n sets an element's text, data-i18n-aria-label
// its aria-label. popup.html keeps the English in place, so the page still reads
// correctly if this ever fails to run.
document.documentElement.lang = t("localeTag");
for (const el of document.querySelectorAll("[data-i18n]")) {
  el.textContent = t(el.dataset.i18n);
}
for (const el of document.querySelectorAll("[data-i18n-aria-label]")) {
  el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel));
}
