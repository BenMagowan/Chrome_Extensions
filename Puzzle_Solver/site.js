/*
 * Links to LinkedIn Ranked. Shared by the popup (script tag) and the background
 * worker (importScripts), so the URL lives in one place. Every link opens the home
 * page. `src` names the placement (a popup state, "menu", "install", "uninstall") so
 * the site's analytics can tell which one brought the visit. `game` is an entry in
 * GAMES; without one, `ref` is "puzzle-solver".
 */
const SITE_URL = "https://magowan.dev/ranked";

function siteUrl(src, game) {
  const url = new URL(SITE_URL);
  url.searchParams.set("ref", game ? game.ref : "puzzle-solver");
  url.searchParams.set("src", src);
  return url.toString();
}
