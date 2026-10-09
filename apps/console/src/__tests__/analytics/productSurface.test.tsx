import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';

/**
 * The `product` super-property (E8).
 *
 * The two products share one PostHog project and a flat event catalog, so
 * `webrtc_call_placed` from the Softphone had nothing separating it from an
 * agency station dial. The shell registers the dimension once for everything
 * mounted under it — including autocapture, pageviews and errors, which have no
 * call site to thread a property through.
 *
 * The case worth testing is not "does register get called". It is the UNSET one:
 * a page outside both shells must send events with no `product` at all, because
 * a stale `product: 'agency'` on a login-page event is indistinguishable from a
 * real one and would misattribute whole funnels to whichever shell happened to
 * mount last.
 */

const mocks = vi.hoisted(() => ({
  init: vi.fn(),
  identify: vi.fn(),
  group: vi.fn(),
  reset: vi.fn(),
  capture: vi.fn(),
  register: vi.fn(),
  unregister: vi.fn(),
  isFeatureEnabled: vi.fn(),
  getFeatureFlag: vi.fn(),
  onFeatureFlags: vi.fn(),
}));

vi.mock('posthog-js', () => ({
  default: {
    init: mocks.init,
    identify: mocks.identify,
    group: mocks.group,
    reset: mocks.reset,
    capture: mocks.capture,
    register: mocks.register,
    unregister: mocks.unregister,
    isFeatureEnabled: mocks.isFeatureEnabled,
    getFeatureFlag: mocks.getFeatureFlag,
    onFeatureFlags: mocks.onFeatureFlags,
  },
}));

/**
 * The wrapper holds module-level state (`enabled`, and which shell owns
 * `product`), so each scenario resets the registry and re-imports. All three
 * modules are imported after the reset so the hook, the component form and the
 * assertions share one instance of the wrapper.
 *
 * `initAnalytics()` is what sets `enabled`, and every scenario needs it: a test
 * that imports `ProductSurface` on its own gets a fresh module graph with
 * `enabled` still false, so nothing registers. Two tests did exactly that and
 * passed only on the module instance a previous `describe` had left behind —
 * green in the full file, red on their own.
 */
async function loadModules(key = 'phc_test') {
  vi.resetModules();
  vi.stubEnv('VITE_POSTHOG_KEY', key);
  const posthogModule = await import('../../analytics/posthog');
  const hookModule = await import('../../analytics/useProductSurface');
  const componentModule = await import('../../analytics/ProductSurface');
  posthogModule.initAnalytics();
  mocks.register.mockClear();
  return { ...posthogModule, ...hookModule, ...componentModule };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

afterEach(cleanup);

describe('setting and clearing the dimension', () => {
  it('registers the product for the shell that mounted', async () => {
    const a = await loadModules();
    a.setProductSurface('agency');
    expect(mocks.register).toHaveBeenCalledWith({ product: 'agency' });
  });

  it('unregisters it when that shell leaves, so the next page is unattributed', async () => {
    const a = await loadModules();
    a.setProductSurface('ai');
    a.clearProductSurface('ai');
    expect(mocks.unregister).toHaveBeenCalledWith('product');
  });

  it('refuses to clear a value another shell has since registered', async () => {
    /**
     * Crossing between the shells unmounts one layout and mounts the other in
     * one commit. If the leaving shell's cleanup runs LAST, an unconditional
     * clear would strip the dimension the arriving shell just set and leave the
     * whole agency workspace unattributed — so the clear is ownership-checked
     * and the outcome is the same in either order.
     */
    const a = await loadModules();
    a.setProductSurface('ai');
    a.setProductSurface('agency');
    a.clearProductSurface('ai');
    expect(mocks.unregister).not.toHaveBeenCalled();

    // And the shell that does own it can still clear.
    a.clearProductSurface('agency');
    expect(mocks.unregister).toHaveBeenCalledWith('product');
  });

  it('gives up ownership on logout, since reset drops every super property', async () => {
    /**
     * `reset()` drops every super property, `product` included, so after it
     * NOBODY owns the dimension — and the ownership record has to say so.
     *
     * What this pins is modest, and the comment it replaces claimed more than the
     * assertion could see ("the shell's own unmount would then be refused"): on
     * the real logout path the leaving shell clears the same product it set, so it
     * is allowed either way and the observable difference is only whether a
     * redundant `unregister` follows a `reset` that has already dropped the
     * property. That is what is asserted, because it is what the line does. Its
     * value is the invariant behind it — the record mirrors what PostHog actually
     * holds — and an ownership record that outlived a reset would be a lie the next
     * ownership decision reads.
     *
     * The previous version of this test could not fail: it re-set the product
     * after the reset, which overwrites ownership regardless, so deleting
     * `productSurface = null` from `resetAnalytics` left it green.
     */
    const a = await loadModules();
    a.setProductSurface('ai');
    a.resetAnalytics();
    a.clearProductSurface('ai');
    expect(mocks.unregister).not.toHaveBeenCalled();

    // And nothing is stuck: the next shell to mount owns it again.
    a.setProductSurface('agency');
    a.clearProductSurface('agency');
    expect(mocks.unregister).toHaveBeenCalledWith('product');
  });

  it('stays a no-op with no key configured', async () => {
    const a = await loadModules('');
    a.setProductSurface('agency');
    a.clearProductSurface('agency');
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.unregister).not.toHaveBeenCalled();
  });
});

describe('the shell hook', () => {
  it('registers on mount and clears on unmount', async () => {
    const { useProductSurface } = await loadModules();
    function Shell() {
      useProductSurface('agency');
      return null;
    }

    const view = render(<Shell />);
    expect(mocks.register).toHaveBeenCalledWith({ product: 'agency' });

    view.unmount();
    expect(mocks.unregister).toHaveBeenCalledWith('product');
  });
});

describe('who calls it', () => {
  /**
   * A source assertion, for the reason `agencyShellBoundary.test.ts` gives: the
   * defect is invisible from inside a renderer. A layout that stopped setting
   * its product would render identically and simply report nothing, and the
   * events would still arrive — just filed under the wrong product or none.
   */
  function layout(name: string): string {
    return readFileSync(resolve(process.cwd(), `src/components/layout/${name}`), 'utf8');
  }

  it('AppLayout claims the AI product', () => {
    expect(layout('AppLayout.tsx')).toContain("useProductSurface('ai')");
  });

  it('AgencyLayout claims the agency product', () => {
    expect(layout('AgencyLayout.tsx')).toContain("useProductSurface('agency')");
  });

  /**
   * The agency routes that have no shell to claim them.
   *
   * `/station`, `/dialer`, `/dialer/performance` and `/dialer/attempts` are
   * deliberately full-viewport and OUTSIDE both shells, so an agent on a live call
   * cannot navigate away and drop the station socket. Under a strictly shell-set
   * rule they therefore reported **no product at all** — and they are where
   * dispositions and mid-call DNC marks come from, i.e. the most agency-specific
   * events the platform records were the ones missing from the agency's funnel.
   *
   * `/agency/join/:token` joined them for a different reason and with the same
   * consequence: it is the invite landing page, it is outside both shells because
   * the visitor has no session to hang one on, and the events it fires are the
   * only measurement of whether agency onboarding works at all.
   *
   * Asserted against `App.tsx`'s source for the same reason as the layouts above:
   * a route that lost its wrapper renders identically and just stops reporting.
   * Counted, not merely present, because "one of them is wrapped" is the failure
   * mode a `toContain` alone would pass.
   */
  const SHELL_LESS_AGENCY_PAGES = [
    'AgentConsolePage',
    'AgentHomePage',
    'AgentPerformancePage',
    'AgentAttemptsPage',
    'AgencyJoinPage',
  ];

  it('every shell-less agency route claims the agency product', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const wrapped = app.match(/<ProductSurface product="agency">/g) ?? [];
    expect(wrapped).toHaveLength(SHELL_LESS_AGENCY_PAGES.length);

    for (const page of SHELL_LESS_AGENCY_PAGES) {
      // The wrapper must be around the PAGE, not merely somewhere in the file.
      expect(app).toMatch(
        new RegExp(`<ProductSurface product="agency">\\s*<${page} />\\s*</ProductSurface>`),
      );
    }
  });

  /**
   * The one route allowed to register the agency product with no gate in front
   * of it, named here so a SECOND one cannot appear quietly.
   *
   * `/agency/join/:token` is fully public by design — no `RequireAuth`, no
   * capability, no flag — because the visitor has no account and no tenant to
   * resolve an entitlement against; the single-use token in the URL is the
   * authority, and the server enforces it on the claim. The reason the gates matter
   * everywhere else does not apply here either: they exist so a REFUSED reader
   * never registers a surface they were not shown, and nobody can be refused a
   * page with no gate on it.
   */
  const UNGATED_PRODUCT_SURFACE_ROUTE = '/agency/join/:token';

  it('sits inside the capability and flag gates, so a refused reader registers nothing', () => {
    /**
     * Ordering is the whole point: a reader who fails `RequireCapability` or
     * `RequireFlag` never mounts the wrapper, so a refusal cannot leave a stale
     * `product: 'agency'` behind for whatever they navigate to next.
     *
     * **Scoped to the enclosing `<Route>`, which is the whole test.** Searching the
     * file prefix — `app.slice(0, m.index)` then `lastIndexOf` — finds the nearest
     * preceding gate ANYWHERE earlier in `App.tsx`, including one belonging to a
     * different route. Under that version, deleting both gates from the
     * `/dialer/attempts` route while leaving `<ProductSurface>` around the page
     * kept all three source assertions green while a full-viewport agency route
     * shipped ungated: the gates from `/dialer/performance` above it answered for
     * it. These route elements are flat (no nested `<Route>`), so the text between
     * the `<Route` that opens this one and the next `<Route` is exactly this route
     * and nothing else.
     *
     * **The exemption is keyed on the route's own PATH, not on a count or an
     * index.** A count would be satisfied by any four of the five, so deleting the
     * gates from `/station` and adding them to nothing would pass the moment the
     * public route absorbed the slack; reading the path means a newly ungated
     * route fails under its own name, and adding a second public one is a
     * deliberate edit to the constant above rather than a number quietly going up.
     */
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const matches = [...app.matchAll(/<ProductSurface product="agency">/g)];
    expect(matches).toHaveLength(SHELL_LESS_AGENCY_PAGES.length);

    const ungated: string[] = [];

    for (const m of matches) {
      const at = m.index ?? -1;
      const routeStart = app.lastIndexOf('<Route', at);
      expect(routeStart).toBeGreaterThan(-1);
      const nextRoute = app.indexOf('<Route', at);
      const route = app.slice(routeStart, nextRoute === -1 ? app.length : nextRoute);

      const path = /path="([^"]+)"/.exec(route)?.[1] ?? '';
      expect(path).not.toBe('');

      if (path === UNGATED_PRODUCT_SURFACE_ROUTE) {
        /*
          Asserted rather than merely skipped. If this route ever grew a gate the
          exemption would be stale, and a stale exemption is how the next public
          route gets waved through on a name that no longer means anything.
        */
        expect(route).not.toContain('<RequireCapability');
        expect(route).not.toContain('<RequireFlag');
        expect(route).not.toContain('<RequireAuth>');
        ungated.push(path);
        continue;
      }

      const gateAt = route.indexOf('<RequireFlag flag="agency_dialer_enabled">');
      const capAt = route.indexOf('<RequireCapability capability="agency">');
      expect(capAt).toBeGreaterThan(-1);
      expect(gateAt).toBeGreaterThan(-1);
      expect(gateAt).toBeGreaterThan(capAt);
    }

    // Exactly one exemption was used, and it was the one named above.
    expect(ungated).toEqual([UNGATED_PRODUCT_SURFACE_ROUTE]);
  });
});

describe('the component form', () => {
  /**
   * Both of these load modules like every other test in the file. They used to
   * import `ProductSurface` directly, which meant they carried no `initAnalytics`
   * of their own and depended on `enabled` leaking from whichever instance the
   * previous `describe` had built — so they passed in a full-file run and failed
   * under `-t "the component form"`. A test whose result depends on which other
   * tests ran is not pinning the behaviour it names.
   */
  it('registers the product and renders its children', async () => {
    const { ProductSurface } = await loadModules();
    const { getByText } = render(
      <ProductSurface product="agency"><span>station</span></ProductSurface>,
    );
    expect(getByText('station')).toBeTruthy();
    expect(mocks.register).toHaveBeenCalledWith({ product: 'agency' });
  });

  it('clears the product when the route unmounts', async () => {
    const { ProductSurface } = await loadModules();
    const { unmount } = render(<ProductSurface product="agency"><span>station</span></ProductSurface>);
    unmount();
    expect(mocks.unregister).toHaveBeenCalledWith('product');
  });
});
