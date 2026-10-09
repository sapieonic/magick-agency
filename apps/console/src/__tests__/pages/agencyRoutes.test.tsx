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
    const detail = readFileSync(
      resolve(process.cwd(), 'src/pages/agency/AgencyCampaignDetailPage.tsx'), 'utf8',
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
