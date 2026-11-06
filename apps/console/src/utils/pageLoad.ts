/**
 * A full page load at `url` — not a router navigation.
 *
 * Switching tenant or account (decision B26) reloads the console at the new
 * account's home rather than re-rendering the page in place: every context,
 * cache, poll and open socket was built for the account being left, and a fresh
 * document is the one way to be sure none of it carries over.
 *
 * Its own module so tests can observe the load: jsdom cannot navigate.
 */
export function loadPage(url: string): void {
  window.location.assign(url);
}
