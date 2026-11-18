/*
 * Background worker: only here to point new and departing users at the puzzle
 * site. Opens its welcome page on first install (never on updates, so Zip Solver
 * users moving onto this extension aren't sent anywhere) and sets the page shown
 * after uninstall. Neither needs a permission.
 */
importScripts("games.js", "site.js");

chrome.runtime.onInstalled.addListener(({ reason }) => {
  chrome.runtime.setUninstallURL(siteUrl("uninstall", "goodbye"));
  if (reason === chrome.runtime.OnInstalledReason.INSTALL) {
    chrome.tabs.create({ url: siteUrl("install", "welcome") });
  }
});
