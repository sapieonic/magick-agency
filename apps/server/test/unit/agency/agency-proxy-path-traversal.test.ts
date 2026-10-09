import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

/**
 * ─── NO AGENCY PROXY ROUTE LETS A PARAM ESCAPE ITS PATH SEGMENT ─────────────
 *
 * `helpers/passthrough.ts` rejects a path-escaping param for the 99 declarative
 * proxy routes, and its comment explains why rejecting beats encoding. The
 * hand-written proxy routes — the ones that build an internal path by interpolating
 * `request.params.x` themselves — never went through it, so the guard the shared
 * helper enforces was exactly the guard they bypass.
 *
 * ── What this closes, stated precisely ────────────────────────────────────
 *
 * find-my-way routes on the ENCODED path and hands the handler a
 * percent-DECODED param, so `%2F` arrives as a real `/`.
 *
 * **The `..` traversal was already closed.** `callCore` (mocked here as
 * `proxyToCore`) refuses any path that does not survive a WHATWG parse
 * unchanged (`src/proxy/safe-core-path.ts`) — `..`, `%2e%2e`, `.%2e`,
 * `.<TAB>.`, `#`, `\\`. The last block in this file asserts that directly, so
 * nobody reads the cases above as a claim the textbook traversal was reachable.
 *
 * What the parse check deliberately allows is a **bare extra slash**, because a
 * path with no dot segments is an ordinary internal path. That is the live hole, and
 * the last block proves it end to end: a `viewer` reaching the agency attempt
 * read and its recording BYTES through `GET /proxy/agency/campaigns/:id`, whose
 * floor is two levels below the attempt read's and which asks for no recording
 * capability at all.
 *
 * ── Why this file exists rather than cases in the two route suites ──────────
 *
 * The guard is a PLUGIN hook, not a per-handler check, precisely so a route added
 * later inherits it. A file per plugin-hook property keeps that claim assertable
 * for both plugins in one place, next to the reason it is a hook — and the two
 * route suites are about what their routes forward, not about what never reaches
 * the internal handler at all.
 *
 * ── What each case asserts, and why the second half matters ─────────────────
 *
 * A 4xx alone proves nothing: the internal handler could have been called and answered
 * the 4xx itself, which is what would happen with the guard removed and the handler
 * refusing the traversed path. So every case also asserts `proxyToCore` (the mocked
 * `callCore`) was never touched. That is the property the guard buys — the refusal is
 * the public API layer's, raised before any handler status is recorded that
 * `errorMaskHook` could mistake for a forwarded one.
 *
 * ── The guard here is the CHARACTER CLASS, not a uuid check ─────────────────
 *
 * These two plugins are pre-existing and their ids are uuids only by convention —
 * nothing in either says so, and their own suites exercise short opaque ids
 * (`campaign-1`, `attempt-1`). Tightening to a uuid would change behaviour for
 * requests that are not exploits, which is its own change. The newer
 * `proxy-agency-calls.routes.ts` does take the tighter guard, because every id on
 * it is a uuid on every real call path; see that file's plugin hook.
 */

const TENANT = 'tenant-1';
const ACTING_USER = 'user-1';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
  config: { agency: { rosterReplaceEnabled: false } },
}));

vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('../../../src/storage/s3.js', () => ({
  getFileStream: vi.fn(), getFile: vi.fn(), uploadFile: vi.fn(),
}));
vi.mock('../../../src/agency/agency-ingest-job.repository.js', () => ({
  agencyIngestJobRepository: { create: vi.fn(), findById: vi.fn(), requestCancel: vi.fn() },
}));
vi.mock('../../../src/agency/agency-ingest.service.js', () => ({
  agencyIngestService: { run: vi.fn() },
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// There is no `require-capability` mock: governance does not exist here.
// `rbac.middleware.js` and `roles.js` are deliberately NOT mocked. The traversal
// cases run as `tenant_owner`, which clears every floor, so a real RBAC layer
// cannot make them pass for the wrong reason — and the escalation proof at the
// bottom of this file is ABOUT a floor, so stubbing it open would delete the
// only thing that case asserts.
vi.mock('../../../src/config/index.js', () => ({ config: mocks.config }));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: { findDisplayNamesInTenant: vi.fn().mockResolvedValue(new Map()) },
}));
vi.mock('../../../src/api/routes/proxy-agency-station.routes.js', () => ({
  rewriteStationWsUrl: (u: string) => u,
}));

import { proxyAgencyCampaignsRoutes } from '../../../src/api/routes/proxy-agency-campaigns.routes.js';
import { proxyAgencyAgentRoutes } from '../../../src/api/routes/proxy-agency-agent.routes.js';
import { PERMISSION_MATRIX, ROLE_HIERARCHY } from '@magick-agency/contracts/rbac';
import { isUnsafeCorePath } from '../../../src/proxy/safe-core-path.js';

const PREFIX = '/proxy/agency';

type Plugin = typeof proxyAgencyCampaignsRoutes;

async function buildApp(plugin: Plugin): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = 'account-1';
    r['user'] = { id: ACTING_USER };
    r['membership'] = { role: 'tenant_owner' };
  });
  await app.register(plugin, { prefix: PREFIX });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  // A 200 on every call, so a case that DOES reach the handler fails on the "never
  // called" assertion rather than on an unrelated error path.
  mocks.proxyToCore.mockResolvedValue({ status: 200, body: {}, headers: new Headers() });
});

/** The four characters that let a decoded param break out of its segment. */
const ESCAPES: Array<[string, string]> = [
  ['a traversal into another internal surface', 'x%2F..%2F..%2Fknowledge-bases'],
  ['a traversal into internal-only routes', 'a%2F..%2F..%2F..%2Finternal%2Faudit-logs'],
  ['a bare encoded slash', 'a%2Fb'],
  ['a query truncation', 'a%3Fadmin=1'],
  ['a fragment truncation', 'a%23frag'],
  ['a backslash', 'a%5Cb'],
];

describe('proxy-agency-campaigns: no param escapes its segment', () => {
  const cases: Array<[string, (id: string) => string]> = [
    ['campaign detail', (id) => `${PREFIX}/campaigns/${id}`],
    ['campaign stats', (id) => `${PREFIX}/campaigns/${id}/stats`],
    ['campaign attempts', (id) => `${PREFIX}/campaigns/${id}/attempts`],
    ['campaign contacts', (id) => `${PREFIX}/campaigns/${id}/contacts`],
    ['one contact', (id) => `${PREFIX}/campaigns/${id}/contacts/contact-1`],
    // The SECOND param, so the guard is proved to look at every param and not
    // only at whichever one happens to be called `id`.
    ['one contact by contactId', (id) => `${PREFIX}/campaigns/campaign-1/contacts/${id}`],
  ];

  for (const [routeName, url] of cases) {
    it.each(ESCAPES)(`${routeName}: refuses %s without calling the internal handler`, async (_label, id) => {
      const app = await buildApp(proxyAgencyCampaignsRoutes);

      const res = await app.inject({ method: 'GET', url: url(id) });

      expect(res.statusCode).toBe(400);
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
      await app.close();
    });
  }

  /**
   * The lifecycle writes, which are the worse half: a traversal on a POST aims a
   * WRITE at an internal surface nobody granted.
   */
  it.each(['start', 'pause', 'resume', 'stop'])('lifecycle %s: refuses a traversal', async (action) => {
    const app = await buildApp(proxyAgencyCampaignsRoutes);

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/x%2F..%2F..%2Fknowledge-bases/${action}`,
    });

    expect(res.statusCode).toBe(400);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * ...and an ordinary opaque id is untouched, which is the whole reason the
   * character class was chosen here over a uuid check: the guard must change
   * behaviour ONLY for requests that were already exploits.
   */
  it.each([
    ['a short opaque id', 'campaign-1'],
    ['a uuid', '55555555-5555-4555-8555-555555555555'],
    ['a numeric id', '12345'],
    ['a dotted name', 'file.v1.json'],
  ])('still forwards %s untouched', async (_label, id) => {
    const app = await buildApp(proxyAgencyCampaignsRoutes);

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${id}` });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore).toHaveBeenCalledOnce();
    // Decoded exactly as before the guard — the guard adds no re-encoding.
    expect(mocks.proxyToCore.mock.calls[0]![0].path).toBe(`/agency-campaigns/${id}`);
    await app.close();
  });
});

describe('proxy-agency-agent: no param escapes its segment', () => {
  const cases: Array<[string, string, (id: string) => string]> = [
    ['session available', 'POST', (id) => `${PREFIX}/sessions/${id}/available`],
    ['session leave', 'POST', (id) => `${PREFIX}/sessions/${id}/leave`],
    ['station token', 'POST', (id) => `${PREFIX}/sessions/${id}/station-token`],
    ['attempt hangup', 'POST', (id) => `${PREFIX}/attempts/${id}/hangup`],
  ];

  for (const [routeName, method, url] of cases) {
    it.each(ESCAPES)(`${routeName}: refuses %s without calling the internal handler`, async (_label, id) => {
      const app = await buildApp(proxyAgencyAgentRoutes);

      const res = await app.inject({ method: method as 'POST', url: url(id) });

      expect(res.statusCode).toBe(400);
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
      await app.close();
    });
  }

  /**
   * A refused traversal must leave no audit row either. These routes write one on
   * a successful internal call, and a row for an action that never happened is worse
   * than no row: it is a false entry on the trail a compliance question reads.
   */
  it('writes no audit row for a refused traversal', async () => {
    const app = await buildApp(proxyAgencyAgentRoutes);

    await app.inject({ method: 'POST', url: `${PREFIX}/sessions/a%2F..%2F..%2Fprompts/leave` });

    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('still forwards an ordinary session id untouched', async () => {
    const app = await buildApp(proxyAgencyAgentRoutes);

    const res = await app.inject({ method: 'POST', url: `${PREFIX}/sessions/session-1/available` });

    expect(res.statusCode).toBe(200);
    expect(mocks.proxyToCore.mock.calls[0]![0].path).toBe('/agency/sessions/session-1/available');
    await app.close();
  });
});

/**
 * ─── WHY THE GUARD IS NOT REDUNDANT WITH `isUnsafeCorePath` ─────────────────
 *
 * `callCore` (mocked here as `proxyToCore`) already refuses a path that does not
 * survive a WHATWG parse unchanged (`src/proxy/safe-core-path.ts`), and that
 * chokepoint is strictly stronger than a per-character check against the
 * DOT-SEGMENT family: it catches `..`, `%2e%2e`, `.%2e`, `.<TAB>.`, `#` and `\`.
 * So the classic `x%2F..%2F..%2Fknowledge-bases` traversal never reached the internal handler —
 * it was already a 400 from inside `callCore`.
 *
 * What that chokepoint deliberately does NOT refuse is a **bare extra slash**. A
 * path with no dot segments survives the parse byte-for-byte, so
 * `/agency-campaigns/c/attempts/a` is allowed — and it has to be, because it is a
 * perfectly ordinary internal path. It is only dangerous when a caller put those
 * extra segments there through a param.
 *
 * That is a real privilege escalation on this plugin, because its routes do not
 * share one floor:
 *
 *   GET /proxy/agency/campaigns/:id          → `proxy.contact_lists.read`  (VIEWER, 10)
 *   GET .../campaigns/:id/attempts/:aId      → `agency.supervise`  (ACCOUNT_ADMIN, 30)
 *                                              + `agency.recording` for the media
 *
 * and the first one interpolates `:id` as the LAST segment of the internal path. So a
 * `viewer` sending `:id = c%2Fattempts%2Fa` built `/agency-campaigns/c/attempts/a`
 * — the agency attempt read — through a route floored two levels below it, and
 * `:id = c%2Fattempts%2Fa%2Frecording` reached the recording BYTES with no
 * `agency.recording` capability anywhere in the request. The second one is the C2
 * gap this whole surface was built to close ("the capability gated enabling
 * recording, not hearing it"), reopened by a slash.
 *
 * These cases are the reason the guard exists. They run with REAL RBAC.
 */
describe('the bare-slash escalation the parse-based chokepoint cannot see', () => {
  async function asViewer(): Promise<FastifyInstance> {
    const app = Fastify({ logger: false });
    app.addHook('onRequest', async (request) => {
      const r = request as unknown as Record<string, unknown>;
      r['tenantId'] = TENANT;
      r['accountId'] = 'account-1';
      r['user'] = { id: ACTING_USER };
      r['membership'] = { role: 'viewer' };
    });
    await app.register(proxyAgencyCampaignsRoutes, { prefix: PREFIX });
    await app.ready();
    return app;
  }

  /** The floors this case turns on, pinned against the real matrix. */
  it('is a real escalation because the two routes have different floors', () => {
    expect(PERMISSION_MATRIX['agency.campaigns.read']).toBe('viewer');
    expect(PERMISSION_MATRIX['agency.supervise']).toBe('account_admin');
    expect(ROLE_HIERARCHY['viewer']).toBeLessThan(ROLE_HIERARCHY['account_admin']);
  });

  /** ...and the viewer really does clear the campaign-detail floor. */
  it('lets a viewer read a campaign, which is the route being abused', async () => {
    const app = await asViewer();

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/campaign-1` });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it.each([
    ['the attempt read, floored at account_admin', 'campaign-1%2Fattempts%2Fattempt-1'],
    ['the recording bytes, gated on agency.recording', 'campaign-1%2Fattempts%2Fattempt-1%2Frecording'],
    ['the contact list', 'campaign-1%2Fcontacts'],
    ['the campaign stats', 'campaign-1%2Fstats'],
  ])('refuses a viewer reaching %s through the campaign id', async (_label, id) => {
    const app = await asViewer();

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${id}` });

    expect(res.statusCode).toBe(400);
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  /**
   * The half that proves the guard is load-bearing rather than duplicated: the
   * paths those ids build are ones `isUnsafeCorePath` ALLOWS. If this ever starts
   * failing, the chokepoint has been tightened and this plugin's hook has become
   * genuine defence in depth — which would be good news, and worth knowing.
   */
  it.each([
    '/agency-campaigns/campaign-1/attempts/attempt-1',
    '/agency-campaigns/campaign-1/attempts/attempt-1/recording',
    '/agency-campaigns/campaign-1/contacts',
    '/agency-campaigns/campaign-1/stats',
  ])('the proxy client would have allowed %s', (path) => {
    expect(isUnsafeCorePath(path)).toBe(false);
  });

  /**
   * And the dot-segment family really is already covered upstream, which is why
   * this file's other cases are about the CHARACTER and not about `..`.
   */
  it.each([
    '/agency-campaigns/x/../../knowledge-bases/attempts/a',
    '/agency-campaigns/c/attempts/a/../../../internal/audit-logs',
    '/agency-campaigns/x/%2e%2e/%2e%2e/knowledge-bases',
  ])('the proxy client already refused %s on its own', (path) => {
    expect(isUnsafeCorePath(path)).toBe(true);
  });
});
