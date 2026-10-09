import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { AGENT_SURFACES } from '../../utils/agencyAgentSurfaces';
import { resolve } from 'node:path';

/**
 * The agency entry points, asserted against the REAL route table in `App.tsx`.
 *
 * ── Why a source scrape ────────────────────────────────────────────────────
 * The same reasoning as `agencyRoutes.test.tsx`: `App.tsx` pulls in Firebase, the
 * tenant context and twenty lazy chunks, so instantiating it here would test the
 * harness rather than the routes. What changed is the paths and their gates, and
 * those are exactly what a scrape can pin.
 *
 * ── What is at stake ───────────────────────────────────────────────────────
 * `/dialer` is the URL an agency hands to staff who never see the rest of the
 * platform. Three properties have to hold and none of them is visible from the
 * component itself:
 *
 *  1. the route EXISTS at that exact path — a rename breaks every bookmark;
 *  2. it sits OUTSIDE `AppLayout`, whose nav floors at `viewer`; an `agent` is
 *     level 5 and would render the shell's chrome around nothing;
 *  3. it is gated exactly like `/station` — same capability, same flag, both
 *     default off — so it cannot become a way around the entitlement that hides
 *     the whole feature.
 */
describe('the agency entry points', () => {
  const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

  /** The `/app` block, whose children are the ones inside `AppLayout`. */
  const appLayoutBlock = (() => {
    const start = app.indexOf('<Route path="/app"');
    expect(start).toBeGreaterThan(-1);
    // Up to the super-admin section, which is the next top-level route group.
    // The console has no super-admin section (it is
    // its own app), so the `/app` block ends at the catch-all, the next
    // top-level route.
    const end = app.indexOf('<Route path="*"');
    expect(end).toBeGreaterThan(start);
    return app.slice(start, end);
  })();

  it('declares /dialer', () => {
    expect(app).toContain('path="/dialer"');
  });

  it('keeps /dialer OUT of AppLayout, where an agent would get an empty shell', () => {
    // The gate that would be invisible in review: nesting it under `/app` compiles,
    // renders, and hands every agent a sidebar with nothing in it.
    expect(appLayoutBlock).not.toContain('path="/dialer"');
    expect(appLayoutBlock).not.toContain('path="dialer"');
  });

  it('gates /dialer exactly as /station is gated', () => {
    /**
     * Both default off, so the whole surface stays invisible until the API grants
     * the capability and the API enables the flag. Asserted by extracting each
     * route's own element block, so a gate removed from one and not the other
     * fails here rather than shipping a way around the entitlement.
     */
    const routeBlock = (path: string) => {
      const start = app.indexOf(`path="${path}"`);
      expect(start).toBeGreaterThan(-1);
      return app.slice(start, app.indexOf('/>', start));
    };

    for (const path of ['/station', '/dialer']) {
      const block = routeBlock(path);
      expect(block).toContain('<RequireAuth>');
      expect(block).toContain('capability="agency"');
      expect(block).toContain('flag="agency_dialer_enabled"');
    }
  });

  it('routes the /agency index through the persona redirect, not a fixed path', () => {
    // A fixed `<Navigate to="/agency/campaigns">` 403s an `agent`: that list floors
    // at `agency.campaigns.read` (`viewer`, 10) and an agent is level 5.
    expect(app).toContain('<Route index element={<AgencyHomeRedirect />} />');
    expect(app).not.toContain('<Route index element={<Navigate to="/agency/campaigns" replace />} />');
  });

  it('declares the supervisor analytics route inside the agency workspace', () => {
    expect(app).toContain('path="analytics"');
  });

  it('declares /dialer/performance', () => {
    // The agent's own numbers. A rename breaks the link `AgentHomePage` offers,
    // which for a dedicated agent is the only other screen in the product.
    expect(app).toContain('path="/dialer/performance"');
  });

  it('keeps /dialer/performance OUT of AppLayout too', () => {
    /**
     * Same defect as `/dialer`, same invisibility in review: nesting it under
     * `/app` compiles, renders, and hands every `agent` a sidebar with nothing in
     * it. `AgencyLayout` would be no better — its three nav entries also floor at
     * `viewer` or above.
     */
    expect(appLayoutBlock).not.toContain('path="/dialer/performance"');
    expect(appLayoutBlock).not.toContain('path="dialer/performance"');
  });

  it('gates /dialer/performance exactly as /dialer and /station are gated', () => {
    /**
     * Both entitlements default off, so this surface stays invisible until the API
     * grants the `agency` capability and the API enables the flag. Extracted per
     * route so a gate dropped from one and not the others fails here rather than
     * shipping a way around the entitlement — and note the assertion is on the
     * SAME two gates, not on new ones: this route needs no new capability, and
     * `RequireCapability`'s hand-maintained union already carries `agency`.
     */
    const routeBlock = (path: string) => {
      const start = app.indexOf(`path="${path}"`);
      expect(start).toBeGreaterThan(-1);
      return app.slice(start, app.indexOf('/>', start));
    };

    const block = routeBlock('/dialer/performance');
    expect(block).toContain('<RequireAuth>');
    expect(block).toContain('capability="agency"');
    expect(block).toContain('flag="agency_dialer_enabled"');
  });

  it('declares /dialer/attempts', () => {
    // "My calls" — the cross-campaign dial history. A rename breaks the links
    // `AgentHomePage` and `AgentPerformancePage` both offer, which for a dedicated
    // agent are the only routes into it that exist.
    expect(app).toContain('path="/dialer/attempts"');
  });

  it('keeps /dialer/attempts OUT of AppLayout too', () => {
    /**
     * Same defect as `/dialer` and `/dialer/performance`, and just as invisible in
     * review: nesting it under `/app` compiles, renders, and hands every `agent` a
     * sidebar with nothing in it. `AgencyLayout` would be no better — its nav
     * entries also floor at `viewer` or above.
     */
    expect(appLayoutBlock).not.toContain('path="/dialer/attempts"');
    expect(appLayoutBlock).not.toContain('path="dialer/attempts"');
  });

  it('gates /dialer/attempts exactly as its three siblings are gated', () => {
    /**
     * Both entitlements default off, so this surface stays invisible until the API
     * grants the `agency` capability and the API enables the flag. Extracted per route
     * so a gate dropped from one and not the others fails here rather than shipping
     * a way around the entitlement — and the assertion is on the SAME two gates,
     * not on new ones: `RequireCapability`'s hand-maintained union already carries
     * `agency` and this route needs no new capability.
     */
    const routeBlock = (path: string) => {
      const start = app.indexOf(`path="${path}"`);
      expect(start).toBeGreaterThan(-1);
      return app.slice(start, app.indexOf('/>', start));
    };

    const block = routeBlock('/dialer/attempts');
    expect(block).toContain('<RequireAuth>');
    expect(block).toContain('capability="agency"');
    expect(block).toContain('flag="agency_dialer_enabled"');
  });

  it('stays out of GlobalSearch, because everyone who could find it there is a supervisor', () => {
    /**
     * The house rule is that a new page joins `GlobalSearch`'s list, and this is
     * the documented exception rather than a forgotten step. `GlobalSearch` lives
     * in `TopBar`, inside `AppLayout` — so a dedicated `agent`, who never renders
     * that shell, could never find the entry, while everyone who could is a
     * supervisor or above and must not be sent to their own agent numbers. The
     * link on `AgentHomePage` is the entry point instead.
     */
    const search = readFileSync(
      resolve(process.cwd(), 'src/components/common/GlobalSearch.tsx'),
      'utf8',
    );
    expect(search).not.toContain('/dialer/performance');
  });

  it('keeps /dialer/attempts out of GlobalSearch for the same reason', () => {
    /**
     * `AgentPerformancePage` made this call first and pinned it; "My calls"
     * follows the precedent rather than re-litigating it. The reasoning is
     * unchanged and is not about this page's contents: `GlobalSearch` lives in
     * `TopBar`, inside `AppLayout`, which a dedicated `agent` never renders — so
     * the entry would be invisible to the only audience it is for, while everybody
     * who COULD find it there is a supervisor or above and must not be sent to an
     * agent-scoped page. Their surface is the per-agent section on
     * `AgencyAnalyticsPage`, which reads the supervisor twin of the same route.
     *
     * The entry points are the links on `AgentHomePage` — the one screen every
     * agent passes through — and the cross-link in `AgentPerformancePage`'s header.
     */
    const search = readFileSync(
      resolve(process.cwd(), 'src/components/common/GlobalSearch.tsx'),
      'utf8',
    );
    expect(search).not.toContain('/dialer/attempts');
  });

  it('offers every agent surface from AgentHomePage, the one screen they all pass through', () => {
    /**
     * A dedicated `agent` renders no shell, so this page is the whole map of the
     * product for them. `/dialer/attempts` is deliberately NOT reachable only via
     * `/dialer/performance`: "which calls did I take" is the more concrete of the
     * two questions and often the only one somebody wants after a bad afternoon,
     * so hiding the plain answer behind the summary of it would be the wrong way
     * round.
     *
     * This used to scan for two `to="…"` literals. It cannot any more, and the
     * reason is the fix: the destinations were three hand-written lists — one per
     * agent surface — and none of them named the whole set, so what an agent
     * could reach depended on where they were standing. They come from
     * `AGENT_SURFACES` through `AgentNav` now, so what this asserts is the
     * composition (the page mounts the nav) plus the set (the nav's list carries
     * both). `agencyAgentSurfaces.test.ts` owns the contents of that list, and
     * `AgentHomePage.test.tsx` renders the page and reads the hrefs back.
     */
    const home = readFileSync(
      resolve(process.cwd(), 'src/pages/agency/AgentHomePage.tsx'),
      'utf8',
    );
    expect(home).toContain('<AgentNav');

    const destinations = AGENT_SURFACES.map((surface) => surface.to);
    expect(destinations).toContain('/dialer/performance');
    expect(destinations).toContain('/dialer/attempts');
  });

  it('does not add a capability to RequireCapability’s union for it', () => {
    /**
     * `RequireCapability`'s union is hand-maintained and a capability string alone
     * does not compile — so the temptation on a new gated surface is to add one.
     * This route deliberately reuses `agency`: it is the same entitlement, and a
     * second capability would be a second thing an operator has to switch on for a
     * page that is part of the same product.
     */
    const guard = readFileSync(
      resolve(process.cwd(), 'src/components/auth/RequireCapability.tsx'),
      'utf8',
    );
    expect(guard).toContain("'agency'");
    expect(guard).not.toContain('agency.performance');
    expect(guard).not.toContain("'agency.stats'");
  });
});
