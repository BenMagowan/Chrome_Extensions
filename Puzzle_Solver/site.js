/*
 * Links to the unlimited puzzle site. Shared by the popup (script tag) and the
 * background worker (importScripts), so the domain lives in one place.
 * `src` names the placement (a popup state, "menu", "list", "install", "uninstall")
 * so the site's analytics can tell which one brought the visit. `page` picks a page
 * made for that moment ("welcome", "goodbye"). The site only has those per game
 * (/welcome/<game>), so `page` needs a `game` the site has; otherwise, and with no
 * `game`, the link opens the home page. `game` is an entry in GAMES. Without one,
 * `ref` is "puzzle-solver".
 */
const SITE_ORIGIN = "https://puzzle-site-lyart.vercel.app";

function siteUrl(src, page, game) {
  const slug = game && game.site;
  let path = "/";
  if (slug) path = page ? `/${page}/${slug}` : `/${slug}`;
  const url = new URL(path, SITE_ORIGIN);
  url.searchParams.set("ref", game ? game.ref : "puzzle-solver");
  url.searchParams.set("src", src);
  return url.toString();
}
