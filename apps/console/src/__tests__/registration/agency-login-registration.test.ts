import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchRoutes } from 'react-router-dom';

/**
 * That `/agency/login` is actually WIRED UP — asserted against `App.tsx` itself.
 *
 * ── Why this file exists, when the page already has a suite ────────────────
 * `AgencyLoginPage.test.tsx` mounts the component directly inside a
 * `MemoryRouter`. Every one of its cases passes with the route deleted from
 * `App.tsx`, and the failure that deletion causes is SILENT: the catch-all at the
 * bottom of the route table is `<Route path="*" element={<Navigate to="/app" />}>`,
 * so an unregistered `/agency/login` does not 404 — it redirects to `/app`, which
 * for a signed-out visitor becomes `/login?next=%2Fapp`. That is the primary app's
 * page with its Sign Up tab, handed to an agent following an invite link, which is
 * precisely the defect the agency door exists to prevent. It is also the exact
 * failure mode both commit messages name as the cost of shipping master's invite
 * change before this route lands.
 *
 * A defect invisible from inside a renderer needs a test outside one — the
 * rationale `analytics/productSurface.test.tsx` states for the same shape, and the
 * pattern `vocabularyRouteRedirects.test.tsx` and `analysis-profiles-registration`
 * already follow: parse the real declaration out of the real file.
 *
 * `App.tsx` cannot simply be rendered instead. The route table sits inside
 * `AuthProvider`, `TenantProvider`, `FeatureFlagsProvider`, `GovernanceProvider`
 * and `SuperAdminProvider`, all of which reach for Firebase and the network at
 * mount; standing that up would be testing the harness rather than the table.
 */

const APP_SOURCE = readFileSync(resolve(__dirname, '../../App.tsx'), 'utf8');

/**
 * The `<Route …>` declaration for `path`, as source text, from its opening `<Route`
 * through the `>` that ends the opening tag.
 *
 * Deliberately not a full-element parse: what the assertions below need is the
 * `element={…}` expression, which lives entirely inside the opening tag for every
 * route in this file (children, where a route has them, come after it).
 */
function routeDeclaration(path: string): string | null {
  const at = APP_SOURCE.indexOf(`path="${path}"`);
  if (at === -1) return null;
  const open = APP_SOURCE.lastIndexOf('<Route', at);
  if (open === -1) return null;
  // The first `>` at or after the path attribute closes the opening tag. Safe
  // because no route in this file puts a `>` inside an attribute value.
  const close = APP_SOURCE.indexOf('>', at);
  return APP_SOURCE.slice(open, close + 1);
}

describe('the agency door is registered in App.tsx', () => {
  it('declares a /agency/login route', () => {
    // The whole point: delete this line from App.tsx and every case in
    // AgencyLoginPage.test.tsx still passes.
    expect(routeDeclaration('/agency/login')).not.toBeNull();
  });

  it('renders AgencyLoginPage, not something else', () => {
    expect(routeDeclaration('/agency/login')).toContain('AgencyLoginPage');
  });

  it('the parser reports absence, so the cases above cannot go green on a bug in it', () => {
    /*
      Guards against the failure mode this whole file exists to catch, one level
      up: a `routeDeclaration` that matched anything (or that threw and was caught
      somewhere) would make every assertion here vacuous, and the suite would go
      green with the route deleted — the exact silent pass it is meant to prevent.
    */
    expect(routeDeclaration('/agency/definitely-not-a-route')).toBeNull();
  });

  it('lazy-imports the page from where the page lives', () => {
    // A stale import path would fail at runtime on a lazy chunk, i.e. only when
    // somebody opens the door.
    expect(APP_SOURCE).toContain("import('./pages/agency/AgencyLoginPage')");
  });
});

describe('the agency door is reachable without a session', () => {
  /**
   * Every gate is a way to make this page unreachable for the people it is for.
   *
   *  - `RequireAuth` would bounce a signed-out visitor to a sign-in page, which is
   *    what this page IS — the redirect would be to `/agency/login` itself, and
   *    `safeReturnPath` refuses that as a loop, so the visitor would end up on
   *    `/login` instead. The door would silently never work.
   *  - `RequireCapability` / `RequireFlag` resolve per tenant and per account.
   *    There is no tenant to resolve for somebody who has not signed in, so either
   *    gate would refuse or hang on a page whose whole job is to precede a
   *    session.
   */
  it.each(['RequireAuth', 'RequireCapability', 'RequireFlag'])(
    'is not wrapped in %s',
    (guard) => {
      expect(routeDeclaration('/agency/login')).not.toContain(guard);
    },
  );

  it('is declared beside /login rather than under the /agency shell', () => {
    /*
      Position is the property, not the string: a `login` child of the `/agency`
      route would inherit that route's `RequireAuth` and all three gates, which is
      the mistake this ordering exists to avoid. Asserted as "the door is declared
      before the shell", which is where a top-level sibling has to be.
    */
    const door = APP_SOURCE.indexOf('path="/agency/login"');
    const shell = APP_SOURCE.indexOf('path="/agency"');
    expect(door).toBeGreaterThan(-1);
    expect(shell).toBeGreaterThan(-1);
    expect(door).toBeLessThan(shell);
  });
});

describe('/agency/login out-ranks the /agency shell', () => {
  /**
   * The one thing about this route that is not obvious from reading it: `/agency`
   * has children, so `/agency/login` is a URL two declarations could plausibly
   * claim. React Router ranks a longer static path above a shorter one plus a
   * child, so the door wins — but that is a fact about the router's ranking, and a
   * future refactor that turned the door into an `/agency` child (or gave the
   * shell a splat child) would flip it silently.
   *
   * Exercised through the router's own `matchRoutes` against the real competing
   * patterns rather than by rendering, so what is asserted is the ranking rule
   * itself.
   */
  const ROUTES = [
    { path: '/login' },
    { path: '/agency/login' },
    { path: '/agency', children: [{ index: true }, { path: 'campaigns' }, { path: 'dnc' }] },
    { path: '*' },
  ];

  const matchedPath = (url: string) =>
    matchRoutes(ROUTES, url)?.map((m) => m.route.path ?? '(index)').join(' > ');

  it('resolves /agency/login to the door', () => {
    expect(matchedPath('/agency/login')).toBe('/agency/login');
  });

  it('still resolves /agency to the shell index', () => {
    // The door must not shadow the workspace it is named after.
    expect(matchedPath('/agency')).toBe('/agency > (index)');
  });

  it('still resolves the shell’s children', () => {
    expect(matchedPath('/agency/campaigns')).toBe('/agency > campaigns');
  });

  it('leaves /login alone', () => {
    expect(matchedPath('/login')).toBe('/login');
  });

  it('does not send /agency/login to the catch-all', () => {
    /*
      The catch-all is what makes an unregistered door fail silently rather than
      loudly, so it is worth pinning that the door does not land there. Contrast
      with a genuinely unknown agency path, which should.
    */
    expect(matchedPath('/agency/login')).not.toBe('*');
    expect(matchedPath('/agency/nope/deeper')).toBe('*');
  });
});
