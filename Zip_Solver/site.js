/*
 * Links to the unlimited puzzle site. Shared by the popup (script tag) and the
 * background worker (importScripts), so the domain lives in one place per extension.
 * `src` names the placement (a popup state, "menu", "install", "uninstall") so the
 * site's analytics can tell which one brought the visit. `page` picks a page made for
 * that moment ("welcome", "goodbye"); without it the link opens the game's first level.
 */
const SITE_ORIGIN = "https://puzzle-site-lyart.vercel.app";
const SITE_GAME = "trail";
const SITE_REF = "zip";

function siteUrl(src, page) {
  const path = page ? `/${page}/${SITE_GAME}` : `/${SITE_GAME}/easy/1`;
  const url = new URL(path, SITE_ORIGIN);
  url.searchParams.set("ref", SITE_REF);
  url.searchParams.set("src", src);
  return url.toString();
}
