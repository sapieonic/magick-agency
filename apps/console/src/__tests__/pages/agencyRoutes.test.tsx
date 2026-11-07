import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchRoutes } from 'react-router-dom';

/**
 * The agency workspace's route table, asserted against the REAL paths.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * The campaign-roster change reassigned `/agency/campaigns/:id/contacts` from the upload form to
 * the roster and moved the upload to `…/contacts/add`. Every page test mounts
 * its component under a path it declares itself, so the whole move was
 * invisible to the suite: `AgencyCampaignContactsPage.test.tsx` went on
 * mounting the upload page at the old URL and passing, and nothing anywhere
 * asserted which component either path actually resolves to.
 *
 * A source scrape rather than a full `App` render: `App.tsx` pulls in Firebase,
 * the tenant context and twenty lazy chunks, so instantiating it here would
 * test the harness. The paths are what changed and the paths are what this
 * pins — including their RANKING, which is the part that is easy to get wrong
 * and impossible to see.
 */
describe('agency campaign routes', () => {
  const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

  /** Every `<Route path="campaigns/…">` declared in the agency section. */
  const declared = [...app.matchAll(/<Route\s+path="(campaigns\/[^"]*)"/g)].map((m) => m[1]!);

  it('declares the roster, the upload, the drill-down and the attempts view', () => {
    expect(declared).toContain('campaigns/:id/contacts');
    expect(declared).toContain('campaigns/:id/contacts/add');
    expect(declared).toContain('campaigns/:id/contacts/:contactId');
    expect(declared).toContain('campaigns/:id/attempts');
  });

  /**
   * The ranking question: `/contacts/add` must reach the upload form and not be
   * swallowed by `/contacts/:contactId` as a contact whose id is "add".
   *
   * React Router v6 ranks static segments above dynamic ones regardless of
   * declaration order, so this holds — but it holds by a property of the
   * router, not by anything visible in `App.tsx`, and a future move to a router
   * that ranks by order would break it silently. Asserted with the real
   * matcher rather than by reading the file.
   */
  it('resolves /contacts/add to the upload form, not to a contact called "add"', () => {
    const routes = declared.map((path) => ({ path }));
    const matched = matchRoutes(routes, '/campaigns/camp-1/contacts/add');
    expect(matched?.[0]?.route.path).toBe('campaigns/:id/contacts/add');
  });

  it('resolves a real contact id to the drill-down', () => {
    const routes = declared.map((path) => ({ path }));
    const matched = matchRoutes(routes, '/campaigns/camp-1/contacts/3f2a1b0c-1111-4222-8333-444455556666');
    expect(matched?.[0]?.route.path).toBe('campaigns/:id/contacts/:contactId');
  });

  it('resolves the bare contacts path to the roster', () => {
    const routes = declared.map((path) => ({ path }));
    const matched = matchRoutes(routes, '/campaigns/camp-1/contacts');
    expect(matched?.[0]?.route.path).toBe('campaigns/:id/contacts');
  });

  /**
   * The upload page moved; the roster took its URL. Nothing in the repo may
   * still point at `…/contacts` expecting the upload form — an in-product link
   * that does is a user sent to the wrong screen.
   */
  it('no in-product link sends a user to the roster expecting the upload form', () => {
    // The detail page's header (and its "Add contacts" link) lives in its own file.
    const detail = readFileSync(
      resolve(process.cwd(), 'src/pages/agency/campaign-detail/CampaignDetailHeader.tsx'), 'utf8',
    );
    const roster = readFileSync(
      resolve(process.cwd(), 'src/pages/agency/AgencyCampaignRosterPage.tsx'), 'utf8',
    );
    // Both "Add contacts" affordances must target the new path.
    for (const [name, source] of [['detail page', detail], ['roster page', roster]] as const) {
      const addLink = source.match(/to=\{`\/agency\/campaigns\/\$\{[^}]+\}\/contacts(\/add)?`\}[\s\S]{0,220}?Add contacts/);
      expect(addLink, `${name} has an "Add contacts" link`).toBeTruthy();
      expect(addLink![1], `${name}'s "Add contacts" link must point at /contacts/add`).toBe('/add');
    }
  });
});

/**
 * Customer history (`docs/customer-history.md` §5, CH6): served at
 * `/agency/customers` in the agency shell and at `/dialer/customers` for an agent,
 * and neither path has a parameter, because the number never travels in a URL.
 */
describe('customer history routes', () => {
  const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');

  /** The `/agency` block: its children are relative paths inside `AgencyLayout`. */
  const agencyBlock = (() => {
    const start = app.indexOf('path="/agency"');
    const end = app.indexOf('<Route path="/app"');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return app.slice(start, end);
  })();

  it('declares customers inside the agency shell, as the page component', () => {
    expect(agencyBlock).toContain('<Route path="customers" element={<CustomerHistoryPage />} />');
    expect(app).toContain("import('./pages/agency/CustomerHistoryPage')");
  });

  it('declares /dialer/customers for agents, gated like the other agent surfaces', () => {
    const start = app.indexOf('path="/dialer/customers"');
    expect(start).toBeGreaterThan(-1);
    // Route elements are flat: the text up to the next `<Route` is this route alone.
    const next = app.indexOf('<Route', start);
    expect(next).toBeGreaterThan(start);
    const block = app.slice(start, next);
    expect(block).toContain('<RequireAuth>');
    expect(block).toContain('capability="agency"');
    expect(block).toContain('flag="agency_dialer_enabled"');
    expect(block).toContain('<AgentCustomerHistoryPage />');
    // Outside the agency shell: an agent renders nothing in it.
    expect(agencyBlock).not.toContain('path="/dialer/customers"');
  });

  it('takes no parameter on either path, so no number can be put in the URL', () => {
    const paths = [...app.matchAll(/path="([^"]*customers[^"]*)"/g)].map((m) => m[1]!);
    expect(paths.sort()).toEqual(['/dialer/customers', 'customers']);
    for (const path of paths) expect(path).not.toContain(':');
  });

  it('resolves /customers to the page and not to anything with a parameter', () => {
    const declared = [...app.matchAll(/<Route\s+path="([^"/][^"]*)"/g)].map((m) => ({ path: m[1]! }));
    expect(matchRoutes(declared, '/customers')?.[0]?.route.path).toBe('customers');
  });
});
