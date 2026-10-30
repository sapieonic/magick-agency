import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchRoutes } from 'react-router-dom';

/**
 * The two invite landing routes, asserted against `App.tsx` itself.
 *
 * ── Why a source scrape ────────────────────────────────────────────────────
 * For `agencyRoutes.test.tsx`'s reason: `App.tsx` pulls in Firebase, every
 * context and twenty lazy chunks, and every page test mounts its component under
 * a path it declares itself — so a route that lost its element, gained a guard or
 * moved under a shell would leave every page test green. What these routes
 * promise is in the route table, so the route table is what is read.
 *
 * The property that matters most is the one a reviewer is most likely to "fix":
 * neither route has a guard. A `RequireAuth` around either would bounce a visitor
 * who has no account yet — by definition, everybody this page is for — to a
 * sign-in page and throw the single-use token away.
 */
const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

/** The text of the `<Route>` element whose path is `path`, up to the next `<Route`. */
function routeSource(path: string): string {
  const at = app.indexOf(`path="${path}"`);
  expect(at, `${path} is declared`).toBeGreaterThan(-1);
  const start = app.lastIndexOf('<Route', at);
  const next = app.indexOf('<Route', at);
  return app.slice(start, next === -1 ? app.length : next);
}

/** Every top-level path, i.e. those declared with a leading slash. */
const topLevel = [...app.matchAll(/<Route\s+path="(\/[^"]*)"/g)].map((m) => m[1]!);

describe('/join/:token — the workspace invite page', () => {
  it('renders JoinPage, lazily, from the auth pages', () => {
    expect(app).toMatch(/const JoinPage = lazy\(\(\) => import\('\.\/pages\/auth\/JoinPage'\)\)/);
    expect(routeSource('/join/:token')).toContain('<JoinPage />');
  });

  it('has no guard in front of it, and claims no product surface', () => {
    const route = routeSource('/join/:token');
    expect(route).not.toContain('<RequireAuth>');
    expect(route).not.toContain('<RequireCapability');
    expect(route).not.toContain('<RequireFlag');
    // Like `/login`, it belongs to no shell — see the route's commentary and
    // `productSurface.test.tsx`, which counts the routes that DO claim one.
    expect(route).not.toContain('<ProductSurface');
  });

  it('is a top-level route, outside /agency and /app', () => {
    expect(topLevel).toContain('/join/:token');
  });

  it('resolves a token link to itself and not to the catch-all', () => {
    expect(app).toContain('<Route path="*"');
    const routes = [...topLevel, '*'].map((path) => ({ path }));
    expect(matchRoutes(routes, '/join/tok_abc123')?.[0]?.route.path).toBe('/join/:token');
    // A bare `/join` has no token and is nobody's invitation: the catch-all.
    expect(matchRoutes(routes, '/join')?.[0]?.route.path).toBe('*');
  });
});

describe('/agency/join/:token — the agent invite page', () => {
  it('is still public, and still the only ungated route claiming the agency product', () => {
    const route = routeSource('/agency/join/:token');
    expect(route).toContain('<AgencyJoinPage />');
    expect(route).not.toContain('<RequireAuth>');
    expect(route).not.toContain('<RequireCapability');
    expect(route).not.toContain('<RequireFlag');
  });

  it('outranks the /agency shell, whose RequireAuth would discard the token', () => {
    /*
      The shell is modelled as the prefix it is (`/agency/*`): its children are
      relative routes this scrape does not expand, and the property in question is
      the router's ranking of a static, more specific path above a shell's subtree
      — not anything visible in the order `App.tsx` declares them.
    */
    const routes = [...topLevel.filter((p) => p !== '/agency'), '/agency/*'].map((path) => ({ path }));
    expect(matchRoutes(routes, '/agency/join/tok_abc123')?.[0]?.route.path).toBe('/agency/join/:token');
    expect(matchRoutes(routes, '/agency/campaigns')?.[0]?.route.path).toBe('/agency/*');
  });
});
