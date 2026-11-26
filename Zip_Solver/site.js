/*
 * Links to LinkedIn Ranked. Shared by the popup (script tag) and the background
 * worker (importScripts), so the URL lives in one place per extension. `src` names
 * the placement (a popup state, "menu", "install", "uninstall") so the site's
 * analytics can tell which one brought the visit. `page` picks a page made for that
 * moment ("welcome", "goodbye"); without it the link opens the home page.
 */
const SITE_URL = "https://magowan.dev/ranked";
const SITE_GAME = "trail";
const SITE_REF = "zip";

function siteUrl(src, page) {
  const url = new URL(page ? `${SITE_URL}/${page}/${SITE_GAME}` : SITE_URL);
  url.searchParams.set("ref", SITE_REF);
  url.searchParams.set("src", src);
  return url.toString();
}
