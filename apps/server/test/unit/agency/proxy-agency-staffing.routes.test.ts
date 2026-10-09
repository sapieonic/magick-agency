import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { PERMISSION_MATRIX, hasPermission, type MembershipRole } from '@magick-agency/contracts/rbac';

/**
 * Agent → campaign STAFFING (`proxy-agency-staffing.routes.ts`), and the six
 * floors that make it safe.
 *
 * ── What is actually at risk here, and why RBAC is NOT stubbed ──────────────
 * Three of these routes edit who talks to customers and three must be reachable
 * by the *least* privileged role in the platform. Those are opposite failure
 * modes and a single stubbed-open `requirePermission` would hide both:
 *
 *  - any `my-*` route gated one notch too high 403s the only role it exists
 *    for. An `agent` (level 5) holds exactly four permissions, so gating it on
 *    anything `viewer`-floored — `proxy.contact_lists.read` being the obvious
 *    wrong choice, since every neighbouring campaign read uses it — breaks the
 *    agent landing page for every agent while looking entirely reasonable in
 *    review.
 *  - The three supervisory routes gated one notch too low let an `operator`, or
 *    an agent, restaff a campaign.
 *
 * So RBAC runs for real here (as in `proxy-agency-agent-actions.test.ts`) and the
 * cases are written per role rather than per route.
 *
 * PORT NOTE (magick-agency): ported from master `test/unit/agency/proxy-agency-staffing.routes.test.ts`
 * @a1f0756a. The core hop is `callCore` (`src/api/core-dispatch.ts`, decision B16), mocked under
 * master's variable name `mocks.proxyToCore` so every assertion on the outgoing request reads as
 * master's. Gone with what they tested: the `resolveCoreApiKey` mock and the four key-resolution
 * cases (no core API key in one process), the three system-key cases and the API-key half of the
 * caller harness (decision #5), the `timeoutMs` case (no transport to bound), the governance stub
 * (no `requireCapability`). `proxy.contact_lists.read` is `agency.campaigns.read` (same `viewer`
 * floor). See PORTING "Phase 8 — staffing".
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const CAMPAIGN = '22222222-2222-4222-8222-222222222222';
const OTHER_CAMPAIGN = '33333333-3333-4333-8333-333333333333';
const SUPERVISOR = '44444444-4444-4444-8444-444444444444';
const AGENT_USER = '55555555-5555-4555-8555-555555555555';

const mocks = vi.hoisted(() => ({
  proxyToCore: vi.fn(),
  auditLog: vi.fn(),
  findActiveForUser: vi.fn(),
  listActiveForUser: vi.fn(),
  listAllForUser: vi.fn(),
  listActiveForCampaign: vi.fn(),
  assign: vi.fn(),
  unassign: vi.fn(),
  findByUserAndTenant: vi.fn(),
  findIdentitiesInTenant: vi.fn(),
}));

vi.mock('../../../src/api/core-dispatch.js', () => ({ callCore: mocks.proxyToCore }));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: mocks.auditLog } }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/auth/session.middleware.js', () => ({ sessionMiddleware: async () => {} }));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async () => {},
}));
// PORT NOTE (magick-agency): master's `requireCapability('agency')` stub is gone with the
// governance gate it stubbed (the route no longer registers it; see the route's header).
vi.mock('@magick-agency/db/repositories/agency-campaign-agent.repository', async (orig) => {
  // The REAL error class is re-exported: the route branches on `instanceof`, so a
  // stubbed class would let a broken branch pass.
  const actual = await orig<
    typeof import('@magick-agency/db/repositories/agency-campaign-agent.repository')
  >();
  return {
    StaffingUpgradePendingError: actual.StaffingUpgradePendingError,
    // The real ceiling, so the truncation cases below cannot pass against a
    // number this file made up.
    HISTORY_LIMIT_MAX: actual.HISTORY_LIMIT_MAX,
    agencyCampaignAgentRepository: {
      findActiveForUser: mocks.findActiveForUser,
      listActiveForUser: mocks.listActiveForUser,
      listAllForUser: mocks.listAllForUser,
      listActiveForCampaign: mocks.listActiveForCampaign,
      assign: mocks.assign,
      unassign: mocks.unassign,
    },
  };
});
vi.mock('@magick-agency/db/repositories/membership.repository', () => ({
  membershipRepository: { findByUserAndTenant: mocks.findByUserAndTenant },
}));
// The identity enrichment itself is NOT mocked — only the query under it — so the
// degrade-never-500 rule is exercised rather than assumed.
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: { findIdentitiesInTenant: mocks.findIdentitiesInTenant },
}));

import { proxyAgencyStaffingRoutes } from '../../../src/api/routes/proxy-agency-staffing.routes.js';
import { HISTORY_LIMIT_MAX } from '@magick-agency/db/repositories/agency-campaign-agent.repository';

const PREFIX = '/proxy/agency';

interface Caller {
  role?: MembershipRole;
  userId?: string | null;
  // PORT NOTE (magick-agency): master's `apiKeyOnly` and `apiKeyCreatedBy` caller shapes
  // are deleted with platform API keys (decision #5): no middleware here produces
  // `apiKeyTenantId`. `userId: null` (a membership naming nobody) is the unattributable
  // shape that remains, and drives `resolveMyAgentId`'s surviving branch below.
}

async function buildApp(caller: Caller = { role: 'account_admin' }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.addHook('onRequest', async (request) => {
    // Via `unknown`: `FastifyRequest` and `Record<string, unknown>` do not
    // sufficiently overlap for a direct assertion (TS2352 under `lint:test`).
    const r = request as unknown as Record<string, unknown>;
    r['tenantId'] = TENANT;
    r['accountId'] = 'account-1';
    r['user'] = { id: caller.userId === undefined ? SUPERVISOR : caller.userId };
    r['membership'] = { role: caller.role ?? 'account_admin' };
  });
  await app.register(proxyAgencyStaffingRoutes, { prefix: PREFIX });
  await app.ready();
  return app;
}

const ASSIGNMENT_ID = '66666666-6666-4666-8666-666666666666';

function assignmentRow(campaignId = CAMPAIGN) {
  return {
    id: ASSIGNMENT_ID,
    tenant_id: TENANT,
    account_id: 'account-1',
    campaign_id: campaignId,
    user_id: AGENT_USER,
    assigned_by: SUPERVISOR,
    assigned_at: new Date('2026-08-16T09:00:00.000Z'),
    unassigned_at: null,
    created_at: new Date('2026-08-16T09:00:00.000Z'),
    updated_at: new Date('2026-08-16T09:00:00.000Z'),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.proxyToCore.mockResolvedValue({ status: 200, body: { id: CAMPAIGN, name: 'Q3 Renewals' } });
  mocks.findActiveForUser.mockResolvedValue(null);
  mocks.listActiveForUser.mockResolvedValue([]);
  mocks.listAllForUser.mockResolvedValue([]);
  mocks.listActiveForCampaign.mockResolvedValue([]);
  mocks.assign.mockResolvedValue(assignmentRow());
  // The CLOSED ROW'S id, not a boolean — that signature change is what let the
  // audit row reference the assignment rather than the campaign.
  mocks.unassign.mockResolvedValue(ASSIGNMENT_ID);
  mocks.findByUserAndTenant.mockResolvedValue([{ id: 'm-1', role: 'agent' }]);
  mocks.findIdentitiesInTenant.mockResolvedValue([]);
});

describe('GET /my-assignment — reachable by a BARE agent', () => {
  /**
   * The single most important case in this file. An `agent` is hierarchy level 5
   * and holds only the four `agency.*` permissions; every campaign read next door
   * floors at `proxy.contact_lists.read` (`viewer`, 10). If this route ever
   * acquires that floor, the agent landing page 403s for every agent — the exact
   * users the feature exists for — and nothing else in the suite notices, because
   * every other test caller is a supervisor.
   */
  it('answers 200 with the campaign for an assigned agent', async () => {
    mocks.findActiveForUser.mockResolvedValue(assignmentRow());
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-assignment` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ campaign_id: CAMPAIGN, campaign_name: 'Q3 Renewals' });
    await app.close();
  });

  it('answers 204 with NO body when nobody has staffed them', async () => {
    mocks.findActiveForUser.mockResolvedValue(null);
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-assignment` });

    // 204 rather than `200 { campaign_id: null }`: the console renders a different
    // screen entirely, and a field test is one a client can forget.
    expect(res.statusCode).toBe(204);
    expect(res.body).toBe('');
    await app.close();
  });

  it('does not require any permission an agent lacks', () => {
    // Asserted against the matrix as well as behaviourally above, because the
    // behavioural case would still pass if the floor moved to another permission
    // an agent happens to hold.
    expect(PERMISSION_MATRIX['agency.station.connect']).toBe('agent');
    expect(hasPermission('agent', 'agency.station.connect')).toBe(true);
    expect(hasPermission('agent', 'agency.campaigns.read')).toBe(false);
  });

  it('still answers 200 when the campaign-name lookup fails', async () => {
    // Enrichment must never turn a 200 into a 500 — the assignment IS the answer
    // and it is already in hand. The redirect keeps working with a null name.
    mocks.findActiveForUser.mockResolvedValue(assignmentRow());
    mocks.proxyToCore.mockRejectedValue(new Error('core unreachable'));
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-assignment` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ campaign_id: CAMPAIGN, campaign_name: null });
    await app.close();
  });

  it('answers 200 with a null name when core does not know the campaign', async () => {
    mocks.findActiveForUser.mockResolvedValue(assignmentRow());
    mocks.proxyToCore.mockResolvedValue({ status: 404, body: { error: 'Not Found' } });
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-assignment` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ campaign_id: CAMPAIGN, campaign_name: null });
    // Swallowed lookups must not be recorded for the error mask, or an unrelated
    // 4xx of our own could be flattened into a support message.
    expect(mocks.proxyToCore.mock.calls[0]![0].recordCoreErrors).toBe(false);
    await app.close();
  });

  // PORT NOTE (magick-agency): DELETED — master's 'refuses a platform API key, which has no "my"'.
  // A system key (NULL `created_by`) — decision #5: there are no platform API keys, so the shape
  // cannot be built. The no-membership refusal it reached is `requirePermission`'s, unchanged.

  // PORT NOTE (magick-agency): MODIFIED — master drove this with a creator-backed platform
  // API key (`apiKeyCreatedBy`). Decision #5 deletes keys and `resolveMyAgentId`'s key
  // branch; the branch that remains refuses a request whose `user` names nobody, so the
  // caller is a membership with `userId: null`. Assertions unchanged.
  it('refuses a CREATOR-BACKED key too, not just a system one', async () => {
    /**
     * The case the assertion above could not see, and the one that is actually
     * reachable in production.
     *
     * "A platform API key carries a tenant and no user" was written all over this
     * feature and it is false: `sessionMiddleware`'s API-key branch loads
     * `platform_api_keys.created_by` into `request.user`, and
     * `tenantContextMiddleware` then loads that user's membership. So a key minted
     * by a person reaches the handler carrying that person, and the old
     * `if (!request.user?.id)` guard let it through — answering with **the key
     * creator's own** active assignment to whoever holds the key string. The case above
     * only ever exercised a NULL-`created_by` system key.
     */
    const app = await buildApp({ role: 'agent', userId: null });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-assignment` });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('missing_actor');
    expect(mocks.findActiveForUser).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /my-assignments — the plural replacement', () => {
  /**
   * Same load-bearing floor as its predecessor: an `agent` is hierarchy level 5
   * and holds only the four `agency.*` permissions, so this must never acquire a
   * `viewer`-floored gate. See the singular route's block above — the risk is
   * identical and this is now the route that carries it for real traffic.
   */
  it('answers 200 with every campaign the agent is staffed on', async () => {
    mocks.listActiveForUser.mockResolvedValue([
      assignmentRow(CAMPAIGN),
      assignmentRow(OTHER_CAMPAIGN),
    ]);
    mocks.proxyToCore
      .mockResolvedValueOnce({ status: 200, body: { id: CAMPAIGN, name: 'Q3 Renewals', status: 'running' } })
      .mockResolvedValueOnce({ status: 200, body: { id: OTHER_CAMPAIGN, name: 'Collections', status: 'paused' } });
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-assignments` });

    expect(res.statusCode).toBe(200);
    expect(res.json().assignments).toEqual([
      {
        campaign_id: CAMPAIGN,
        campaign_name: 'Q3 Renewals',
        campaign_status: 'running',
        assigned_at: '2026-08-16T09:00:00.000Z',
      },
      {
        campaign_id: OTHER_CAMPAIGN,
        campaign_name: 'Collections',
        campaign_status: 'paused',
        assigned_at: '2026-08-16T09:00:00.000Z',
      },
    ]);
    await app.close();
  });

  it('answers 200 with an EMPTY ARRAY, not 204, when nobody has staffed them', async () => {
    // The deliberate divergence from the singular route. For a collection the
    // empty array IS the representation of the absence, so a client renders
    // "you're not assigned yet" from `assignments.length === 0` with no second
    // code path — which is exactly the branch the 204 forced clients to remember.
    mocks.listActiveForUser.mockResolvedValue([]);
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-assignments` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ assignments: [] });
    await app.close();
  });

  it('reports the campaign STATUS, so the picker can say what is not taking calls', async () => {
    // Without it the landing page can only offer every assignment identically and
    // let the agent discover a paused campaign by being refused at its station.
    mocks.listActiveForUser.mockResolvedValue([assignmentRow(CAMPAIGN)]);
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { id: CAMPAIGN, name: 'Q3 Renewals', status: 'stopped' },
    });
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-assignments` });

    expect(res.json().assignments[0].campaign_status).toBe('stopped');
    await app.close();
  });

  it('forwards an unrecognised status verbatim rather than mapping it to null', async () => {
    // Core owns the campaign lifecycle. A mirror here would turn a status core
    // added into "unknown" for the agent, about a campaign core knows perfectly
    // well; the client renders an unrecognised status as itself.
    mocks.listActiveForUser.mockResolvedValue([assignmentRow(CAMPAIGN)]);
    mocks.proxyToCore.mockResolvedValue({
      status: 200,
      body: { id: CAMPAIGN, name: 'Q3 Renewals', status: 'draining' },
    });
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-assignments` });

    expect(res.json().assignments[0].campaign_status).toBe('draining');
    await app.close();
  });

  it('still answers 200 when a campaign lookup throws', async () => {
    // Enrichment must never turn a 200 into a 500. The ids are the answer and are
    // already in hand, so every link on the landing page keeps working.
    mocks.listActiveForUser.mockResolvedValue([assignmentRow(CAMPAIGN)]);
    mocks.proxyToCore.mockRejectedValue(new Error('core unreachable'));
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-assignments` });

    expect(res.statusCode).toBe(200);
    expect(res.json().assignments).toEqual([
      {
        campaign_id: CAMPAIGN,
        campaign_name: null,
        campaign_status: null,
        assigned_at: '2026-08-16T09:00:00.000Z',
      },
    ]);
    await app.close();
  });

  it('lets ONE campaign’s failure null only its own labels, never a sibling’s', async () => {
    /**
     * The property that makes the concurrent fan-out safe. `resolveCampaignSummary`
     * is total — it never rejects — which is why `Promise.all` is correct here; if
     * a rejection could escape it, the first failure would discard every other
     * campaign's successful lookup and the agent would see a list of nameless rows
     * because one campaign was deleted.
     */
    mocks.listActiveForUser.mockResolvedValue([
      assignmentRow(CAMPAIGN),
      assignmentRow(OTHER_CAMPAIGN),
    ]);
    mocks.proxyToCore
      .mockRejectedValueOnce(new Error('core unreachable'))
      .mockResolvedValueOnce({ status: 200, body: { id: OTHER_CAMPAIGN, name: 'Collections', status: 'running' } });
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-assignments` });

    expect(res.statusCode).toBe(200);
    expect(res.json().assignments).toEqual([
      { campaign_id: CAMPAIGN, campaign_name: null, campaign_status: null, assigned_at: '2026-08-16T09:00:00.000Z' },
      { campaign_id: OTHER_CAMPAIGN, campaign_name: 'Collections', campaign_status: 'running', assigned_at: '2026-08-16T09:00:00.000Z' },
    ]);
    await app.close();
  });

  it('nulls the labels when core does not know the campaign, without recording the error', async () => {
    mocks.listActiveForUser.mockResolvedValue([assignmentRow(CAMPAIGN)]);
    mocks.proxyToCore.mockResolvedValue({ status: 404, body: { error: 'Not Found' } });
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-assignments` });

    expect(res.json().assignments[0].campaign_name).toBeNull();
    expect(res.json().assignments[0].campaign_status).toBeNull();
    // Swallowed lookups must not be recorded for the error mask, or an unrelated
    // 4xx of our own could be flattened into a support message.
    expect(mocks.proxyToCore.mock.calls[0]![0].recordCoreErrors).toBe(false);
    await app.close();
  });

  it('resolves every campaign CONCURRENTLY, one lookup each', async () => {
    // Sequential lookups would make an agent's landing page wait N core
    // round-trips before it can render anything at all.
    mocks.listActiveForUser.mockResolvedValue([
      assignmentRow(CAMPAIGN),
      assignmentRow(OTHER_CAMPAIGN),
    ]);
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    await app.inject({ method: 'GET', url: `${PREFIX}/my-assignments` });

    expect(mocks.proxyToCore).toHaveBeenCalledTimes(2);
    expect(mocks.proxyToCore.mock.calls.map((c) => c[0].path)).toEqual([
      `/agency-campaigns/${CAMPAIGN}`,
      `/agency-campaigns/${OTHER_CAMPAIGN}`,
    ]);
    await app.close();
  });

  it('CAPS the fan-out rather than bursting one request per assignment', async () => {
    /**
     * Migration 064 removed the only thing that actually bounded this: under 060's
     * index an agent held exactly one assignment, so the fan-out was 1 by
     * construction. Now it is however many rows exist, on a route the agent's home
     * calls on every sign-in — and the agent is blocked on all of them before their
     * page renders.
     *
     * Asserted by observing peak in-flight rather than total calls: every campaign
     * must still be resolved (the count assertion below), and it is the SIMULTANEITY
     * that is capped.
     */
    const many = Array.from({ length: 20 }, (_, i) =>
      assignmentRow(`aaaaaaaa-0000-4000-8000-${String(i).padStart(12, '0')}`),
    );
    mocks.listActiveForUser.mockResolvedValue(many);

    let inFlight = 0;
    let peak = 0;
    mocks.proxyToCore.mockImplementation(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight -= 1;
      return { status: 200, body: { name: 'X', status: 'running' } };
    });
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-assignments` });

    expect(res.statusCode).toBe(200);
    // Every campaign resolved…
    expect(res.json().assignments).toHaveLength(20);
    expect(mocks.proxyToCore).toHaveBeenCalledTimes(20);
    // …but never all at once. The exact cap is an implementation choice; that it is
    // well below the assignment count is the property.
    expect(peak).toBeLessThanOrEqual(8);
    expect(peak).toBeGreaterThan(0);
    await app.close();
  });

  // PORT NOTE (magick-agency): DELETED — master's 'resolves the core API key ONCE for the whole
  // fan-out'. No core API key in one process (the hop is `callCore`); the per-campaign lookup
  // count it also asserted is covered by 'resolves every campaign CONCURRENTLY, one lookup each'.

  // PORT NOTE (magick-agency): DELETED — master's 'does not resolve a key at all for an unstaffed
  // agent'. No key; 'asks core nothing at all for an unstaffed agent' keeps the behaviour.

  // PORT NOTE (magick-agency): DELETED — master's 'answers 200 with null labels when the key cannot
  // be resolved at all'. `resolveCoreApiKeyOrNull` is gone with the key; the null-label degrade
  // is still covered by the throw / 404 cases above.

  // PORT NOTE (magick-agency): DELETED — master's 'the singular route survives an unresolvable key
  // too'. No key; the singular route's degrade is 'still answers 200 when the campaign-name lookup
  // fails'.

  it('asks core nothing at all for an unstaffed agent', async () => {
    mocks.listActiveForUser.mockResolvedValue([]);
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    await app.inject({ method: 'GET', url: `${PREFIX}/my-assignments` });

    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  // PORT NOTE (magick-agency): DELETED — master's 'refuses a platform API key, which has no "my"'.
  // A system key (NULL `created_by`) — decision #5: there are no platform API keys, so the shape
  // cannot be built. The no-membership refusal it reached is `requirePermission`'s, unchanged.

  // PORT NOTE (magick-agency): MODIFIED — master drove this with a creator-backed platform
  // API key (`apiKeyCreatedBy`). Decision #5 deletes keys and `resolveMyAgentId`'s key
  // branch; the branch that remains refuses a request whose `user` names nobody, so the
  // caller is a membership with `userId: null`. Assertions unchanged.
  it('refuses a CREATOR-BACKED key too, not just a system one', async () => {
    /**
     * The case the assertion above could not see, and the one that is actually
     * reachable in production.
     *
     * "A platform API key carries a tenant and no user" was written all over this
     * feature and it is false: `sessionMiddleware`'s API-key branch loads
     * `platform_api_keys.created_by` into `request.user`, and
     * `tenantContextMiddleware` then loads that user's membership. So a key minted
     * by a person reaches the handler carrying that person, and the old
     * `if (!request.user?.id)` guard let it through — answering with **the key
     * creator's own** staffing to whoever holds the key string. The case above
     * only ever exercised a NULL-`created_by` system key.
     */
    const app = await buildApp({ role: 'agent', userId: null });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-assignments` });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('missing_actor');
    expect(mocks.listActiveForUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('is reachable by a bare agent and never gated on a viewer-floored permission', () => {
    expect(PERMISSION_MATRIX['agency.station.connect']).toBe('agent');
    expect(hasPermission('agent', 'agency.station.connect')).toBe(true);
    expect(hasPermission('agent', 'agency.campaigns.read')).toBe(false);
  });
});

describe('GET /my-campaigns — the staffing HISTORY, closed rows included', () => {
  /**
   * ── The defect this route closes ─────────────────────────────────────────
   * Migration 060 closes staffing rows (`unassigned_at`) rather than deleting
   * them, and says why: *"who was staffed on this campaign in March" is a question
   * supervisors and disputes actually ask, and a delete cannot answer it.* Every
   * reader on the table then filtered `unassigned_at IS NULL`, so the history was
   * being written and could not be read by anything.
   *
   * The case below is therefore not "does the route work" — it is the whole point
   * of the route, and a version of it built on `listActiveForUser` would pass every
   * other assertion in this block while answering the one question it exists for
   * with silence.
   */
  function closedRow(campaignId: string, unassignedAt: string) {
    return {
      ...assignmentRow(campaignId),
      unassigned_at: new Date(unassignedAt),
    };
  }

  it('returns CLOSED assignments alongside active ones', async () => {
    mocks.listAllForUser.mockResolvedValue([
      assignmentRow(CAMPAIGN),
      closedRow(OTHER_CAMPAIGN, '2026-04-01T00:00:00.000Z'),
    ]);
    mocks.proxyToCore
      .mockResolvedValueOnce({ status: 200, body: { name: 'Q3 Renewals', status: 'running' } })
      .mockResolvedValueOnce({ status: 200, body: { name: 'Collections', status: 'stopped' } });
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-campaigns` });

    expect(res.statusCode).toBe(200);
    expect(res.json().assignments).toEqual([
      {
        campaign_id: CAMPAIGN,
        campaign_name: 'Q3 Renewals',
        campaign_status: 'running',
        assigned_at: '2026-08-16T09:00:00.000Z',
        unassigned_at: null,
        active: true,
      },
      {
        campaign_id: OTHER_CAMPAIGN,
        campaign_name: 'Collections',
        campaign_status: 'stopped',
        assigned_at: '2026-08-16T09:00:00.000Z',
        // The raw timestamp, not just the boolean: "when did I come off this
        // campaign" is the question a dispute asks and a boolean cannot answer it.
        unassigned_at: '2026-04-01T00:00:00.000Z',
        active: false,
      },
    ]);
    await app.close();
  });

  it('reads the ALL-rows repository method, never the active-only one', async () => {
    /**
     * The mechanical half of the case above, asserted separately because it is what
     * a refactor would break silently: `listActiveForUser` returns the right SHAPE,
     * so a route switched onto it keeps answering 200 with plausible rows and simply
     * never mentions a closed assignment again.
     */
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    await app.inject({ method: 'GET', url: `${PREFIX}/my-campaigns` });

    expect(mocks.listAllForUser).toHaveBeenCalledWith(TENANT, AGENT_USER, {});
    expect(mocks.listActiveForUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('takes the user from the SESSION, never from the query string', async () => {
    // There is no "my" that a caller gets to name. A query param that could pick
    // the subject would make one agent's history readable by any other.
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    await app.inject({
      method: 'GET',
      url: `${PREFIX}/my-campaigns?user_id=${SUPERVISOR}&agent_user_id=${SUPERVISOR}`,
    });

    expect(mocks.listAllForUser).toHaveBeenCalledWith(TENANT, AGENT_USER, {});
    await app.close();
  });

  it('answers 200 with an empty array for someone never staffed', async () => {
    mocks.listAllForUser.mockResolvedValue([]);
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-campaigns` });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ assignments: [] });
    // Nothing to look up ⇒ nothing decrypted and nothing asked of core.
    // PORT NOTE (magick-agency): master's `expect(mocks.resolveCoreApiKey).not.toHaveBeenCalled()`
    // is dropped with the key (there is nothing to decrypt).
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('resolves each campaign ONCE even when the history repeats it', async () => {
    /**
     * A history repeats campaigns by construction — staffed in March, unstaffed in
     * April, staffed again in June is three rows and one campaign. Resolving per ROW
     * would spend three identical core round trips to print the same name three
     * times, on a route an agent opens from their own console.
     */
    mocks.listAllForUser.mockResolvedValue([
      assignmentRow(CAMPAIGN),
      closedRow(CAMPAIGN, '2026-04-01T00:00:00.000Z'),
      closedRow(CAMPAIGN, '2026-03-01T00:00:00.000Z'),
    ]);
    mocks.proxyToCore.mockResolvedValue({ status: 200, body: { name: 'Q3 Renewals', status: 'running' } });
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-campaigns` });

    expect(mocks.proxyToCore).toHaveBeenCalledTimes(1);
    // …and every row still carries the label.
    expect(res.json().assignments.map((a: { campaign_name: string }) => a.campaign_name))
      .toEqual(['Q3 Renewals', 'Q3 Renewals', 'Q3 Renewals']);
    await app.close();
  });

  it('still answers 200 with null labels when core is unreachable', async () => {
    // A history is the surface MOST likely to name campaigns core has since
    // deleted, so this degradation is the normal path here, not an edge case.
    mocks.listAllForUser.mockResolvedValue([closedRow(CAMPAIGN, '2026-04-01T00:00:00.000Z')]);
    mocks.proxyToCore.mockRejectedValue(new Error('core unreachable'));
    const app = await buildApp({ role: 'agent', userId: AGENT_USER });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-campaigns` });

    expect(res.statusCode).toBe(200);
    expect(res.json().assignments[0]).toMatchObject({
      campaign_id: CAMPAIGN,
      campaign_name: null,
      campaign_status: null,
      active: false,
    });
    await app.close();
  });

  describe('the fan-out is bounded, in all three places it can grow', () => {
    /**
     * ── Why this route and not `/my-assignments` ────────────────────────────
     * That one reads ACTIVE rows and is self-limiting. This one reads closed rows
     * too, so it only ever grows: every reassignment adds a row, every offboarding
     * adds one per campaign (`closeAllForUser`, in a single statement), and nothing
     * ever removes one — that is what migration 060 chose. It is reached by an
     * `agent`, the lowest-privileged role there is, on every visit to their own
     * console.
     *
     * Each case asserts the OUTGOING work rather than a status code, because an
     * unbounded page and a bounded one both answer 200.
     */
    /** `n` history rows spread over `n` distinct campaigns. */
    function historyRows(n: number) {
      return Array.from({ length: n }, (_, i) => ({
        ...assignmentRow(`campaign-${i}`),
        campaign_id: `campaign-${i}`,
      }));
    }

    it('passes NO caller-controllable limit — the ceiling is the repository’s', async () => {
      const app = await buildApp({ role: 'agent', userId: AGENT_USER });

      await app.inject({ method: 'GET', url: `${PREFIX}/my-campaigns?limit=100000` });

      // The third argument carries the window only. A `limit` that a query string
      // could raise is not a ceiling.
      expect(mocks.listAllForUser).toHaveBeenCalledWith(TENANT, AGENT_USER, {});
      await app.close();
    });

    it('forwards a from/to window to the repository, which is how the rest is reached', async () => {
      // The shape `listAllForUser`'s docstring nominated: the question a staffing
      // history answers is always about a period, so a window — not a cursor — is
      // what makes the row ceiling honest rather than lossy.
      const app = await buildApp({ role: 'agent', userId: AGENT_USER });

      await app.inject({
        method: 'GET',
        url: `${PREFIX}/my-campaigns?from=2026-01-01T00:00:00.000Z&to=2026-04-01T00:00:00.000Z`,
      });

      expect(mocks.listAllForUser).toHaveBeenCalledWith(TENANT, AGENT_USER, {
        from: new Date('2026-01-01T00:00:00.000Z'),
        to: new Date('2026-04-01T00:00:00.000Z'),
      });
      await app.close();
    });

    it('refuses an unparseable window rather than silently dropping it', async () => {
      // A dropped `from` answers with the WRONG period under a 200 — the same class
      // of failure as a dropped search filter, and invisible for the same reason.
      // `details` is carried so `errorMaskHook` forwards the 400 intact.
      const app = await buildApp({ role: 'agent', userId: AGENT_USER });

      const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-campaigns?from=march` });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'Validation Error' });
      expect(res.json().details).toBeDefined();
      expect(mocks.listAllForUser).not.toHaveBeenCalled();
      await app.close();
    });

    it('caps the DISTINCT campaigns it names, however many rows come back', async () => {
      /**
       * The row ceiling alone does not bound the fan-out: a full page can be a
       * full page of distinct campaigns, and each one is a core round trip an
       * agent is blocked on. Rows are newest-first, so the campaigns that get a
       * name are the recent ones.
       */
      mocks.listAllForUser.mockResolvedValue(historyRows(120));
      mocks.proxyToCore.mockResolvedValue({ status: 200, body: { name: 'C', status: 'running' } });
      const app = await buildApp({ role: 'agent', userId: AGENT_USER });

      const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-campaigns` });

      expect(res.statusCode).toBe(200);
      expect(mocks.proxyToCore.mock.calls.length).toBeLessThanOrEqual(25);
      // Every row is still returned — the cap is on the LOOKUPS, not the answer.
      expect(res.json().assignments).toHaveLength(120);
      await app.close();
    });

    it('still returns every row past the lookup cap, with a null caption', async () => {
      // The id is what the response is built from and every key is still present;
      // `null` is this route's documented normal path, not a new contract.
      mocks.listAllForUser.mockResolvedValue(historyRows(30));
      mocks.proxyToCore.mockResolvedValue({ status: 200, body: { name: 'C', status: 'running' } });
      const app = await buildApp({ role: 'agent', userId: AGENT_USER });

      const rows = (await app.inject({ method: 'GET', url: `${PREFIX}/my-campaigns` })).json()
        .assignments as Array<{ campaign_id: string; campaign_name: string | null }>;

      expect(rows[0]!.campaign_name).toBe('C');
      expect(rows[29]!.campaign_name).toBeNull();
      expect(rows[29]!.campaign_id).toBe('campaign-29');
      await app.close();
    });

    // PORT NOTE (magick-agency): DELETED — master's 'bounds each summary lookup in TIME, where there
    // was no bound at all'. Transport-only: `callCore` has no transport and ignores `timeoutMs`
    // (`core-dispatch.ts`); the option is still passed for call-site fidelity, but asserting it
    // would pin a value with no effect.

    it('reports a full page in a HEADER, leaving the body shape untouched', async () => {
      /**
       * The customer UI reads `assignments`, and a previous defect in this exact
       * area rendered every agent's history empty — so truncation is reported the
       * way the campaign activity export reports it, in a header a JSON reader
       * cannot trip over.
       */
      mocks.listAllForUser.mockResolvedValue(historyRows(HISTORY_LIMIT_MAX));
      mocks.proxyToCore.mockResolvedValue({ status: 200, body: { name: 'C', status: 'running' } });
      const app = await buildApp({ role: 'agent', userId: AGENT_USER });

      const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-campaigns` });

      expect(res.headers['x-staffing-truncated']).toBe('true');
      expect(Object.keys(res.json())).toEqual(['assignments']);
      await app.close();
    });

    it('sets no truncation header on a short page', async () => {
      mocks.listAllForUser.mockResolvedValue(historyRows(3));
      mocks.proxyToCore.mockResolvedValue({ status: 200, body: { name: 'C', status: 'running' } });
      const app = await buildApp({ role: 'agent', userId: AGENT_USER });

      const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-campaigns` });

      expect(res.headers['x-staffing-truncated']).toBeUndefined();
      await app.close();
    });
  });

  // PORT NOTE (magick-agency): DELETED — master's 'refuses a platform API key, which has no "my"'.
  // A system key (NULL `created_by`) — decision #5: there are no platform API keys, so the shape
  // cannot be built. The no-membership refusal it reached is `requirePermission`'s, unchanged.

  // PORT NOTE (magick-agency): MODIFIED — master drove this with a creator-backed platform
  // API key (`apiKeyCreatedBy`). Decision #5 deletes keys and `resolveMyAgentId`'s key
  // branch; the branch that remains refuses a request whose `user` names nobody, so the
  // caller is a membership with `userId: null`. Assertions unchanged.
  it('refuses a CREATOR-BACKED key too, not just a system one', async () => {
    /**
     * The case the assertion above could not see, and the one that is actually
     * reachable in production.
     *
     * "A platform API key carries a tenant and no user" was written all over this
     * feature and it is false: `sessionMiddleware`'s API-key branch loads
     * `platform_api_keys.created_by` into `request.user`, and
     * `tenantContextMiddleware` then loads that user's membership. So a key minted
     * by a person reaches the handler carrying that person, and the old
     * `if (!request.user?.id)` guard let it through — answering with **the key
     * creator's own** staffing history to whoever holds the key string. The case above
     * only ever exercised a NULL-`created_by` system key.
     */
    const app = await buildApp({ role: 'agent', userId: null });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-campaigns` });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('missing_actor');
    expect(mocks.listAllForUser).not.toHaveBeenCalled();
    await app.close();
  });

  it('is reachable by a bare agent, and refuses nobody above them', async () => {
    for (const role of ['agent', 'viewer', 'operator', 'account_admin'] as MembershipRole[]) {
      const app = await buildApp({ role, userId: AGENT_USER });
      const res = await app.inject({ method: 'GET', url: `${PREFIX}/my-campaigns` });
      expect(res.statusCode, `${role} must reach /my-campaigns`).toBe(200);
      await app.close();
    }
  });
});

describe('the supervisory routes floor at agency.supervise', () => {
  const REFUSED: MembershipRole[] = ['agent', 'viewer', 'operator'];
  const ALLOWED: MembershipRole[] = ['account_admin', 'tenant_admin', 'tenant_owner'];

  it('agency.supervise still floors at account_admin', () => {
    // Pinned here as well as in `roles.agent.test.ts` because these three routes
    // are the reason the floor matters: lowering it would let an operator restaff
    // a live campaign, and every case below would still pass.
    expect(PERMISSION_MATRIX['agency.supervise']).toBe('account_admin');
  });

  for (const role of REFUSED) {
    it(`refuses ${role} on all three`, async () => {
      const app = await buildApp({ role });

      const list = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/agents` });
      const add = await app.inject({
        method: 'POST',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
        payload: { user_id: AGENT_USER },
      });
      const remove = await app.inject({
        method: 'DELETE',
        url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${AGENT_USER}`,
      });

      expect([list.statusCode, add.statusCode, remove.statusCode]).toEqual([403, 403, 403]);
      // Not merely refused — nothing was written on the way to the refusal.
      expect(mocks.assign).not.toHaveBeenCalled();
      expect(mocks.unassign).not.toHaveBeenCalled();
      await app.close();
    });
  }

  for (const role of ALLOWED) {
    it(`admits ${role}`, async () => {
      const app = await buildApp({ role });

      const list = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/agents` });

      expect(list.statusCode).toBe(200);
      await app.close();
    });
  }
});

describe('POST /campaigns/:id/agents', () => {
  it('assigns a tenant member and answers 201', async () => {
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
      payload: { user_id: AGENT_USER },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({
      // `id` is the assignment row itself, and it is what the audit entry
      // references as `resource_id` (see the audit case below). Asserted as part
      // of an exact-shape comparison so it cannot be dropped from the body while
      // the audit row keeps pointing at it — which would leave a client holding
      // no way to reach the record of the write it just made.
      id: ASSIGNMENT_ID,
      user_id: AGENT_USER,
      campaign_id: CAMPAIGN,
      assigned_at: '2026-08-16T09:00:00.000Z',
    });
    expect(mocks.assign).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: 'account-1',
      campaign_id: CAMPAIGN,
      user_id: AGENT_USER,
      assigned_by: SUPERVISOR,
    });
    await app.close();
  });

  it('takes the campaign from the URL, never from the body', async () => {
    // A body-supplied campaign would let a caller address one campaign and staff
    // another — the URL is what RBAC and the audit row are about.
    const app = await buildApp({ role: 'account_admin' });

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
      payload: { user_id: AGENT_USER, campaign_id: OTHER_CAMPAIGN },
    });

    expect(mocks.assign.mock.calls[0]![0].campaign_id).toBe(CAMPAIGN);
    await app.close();
  });

  it('answers 404 — not 403 — for a user who is not a member of this tenant', async () => {
    // 403 would confirm the user id exists somewhere, which is the id-oracle the
    // RBAC rules in CLAUDE.md forbid. A cross-tenant id and a nonexistent one must
    // be indistinguishable.
    mocks.findByUserAndTenant.mockResolvedValue([]);
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
      payload: { user_id: AGENT_USER },
    });

    expect(res.statusCode).toBe(404);
    expect(mocks.assign).not.toHaveBeenCalled();
    // Refused before any core round trip: a membership miss is master's own fact.
    expect(mocks.proxyToCore).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 404 campaign_not_found when core does not have the campaign', async () => {
    mocks.proxyToCore.mockResolvedValue({ status: 404, body: { error: 'Not Found' } });
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
      payload: { user_id: AGENT_USER },
    });

    expect(res.statusCode).toBe(404);
    // The `code` is what keeps `errorMaskHook` from flattening this into
    // "contact support and quote this request id".
    expect(res.json().code).toBe('campaign_not_found');
    expect(mocks.assign).not.toHaveBeenCalled();
    await app.close();
  });

  it('forwards a core failure rather than calling it "not found"', async () => {
    // Master could not PROVE the campaign is missing. Answering 404 for "we could
    // not ask" is the confident-wrong answer this codebase keeps un-learning.
    mocks.proxyToCore.mockResolvedValue({ status: 503, body: { error: 'Service Unavailable' } });
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
      payload: { user_id: AGENT_USER },
    });

    expect(res.statusCode).toBe(503);
    expect(mocks.assign).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a non-uuid user_id with 400 before touching anything', async () => {
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
      payload: { user_id: 'not-a-uuid' },
    });

    expect(res.statusCode).toBe(400);
    expect(mocks.findByUserAndTenant).not.toHaveBeenCalled();
    await app.close();
  });

  it('audits the assignment with ids only — no name, no email', async () => {
    const app = await buildApp({ role: 'account_admin' });

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
      payload: { user_id: AGENT_USER },
    });

    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: 'account-1',
      actor_type: 'human',
      user_id: SUPERVISOR,
      action: 'agency_campaign_agent.assigned',
      resource_type: 'agency_campaign_agent',
      resource_id: ASSIGNMENT_ID,
      campaign_id: CAMPAIGN,
      details: { campaign_id: CAMPAIGN, user_id: AGENT_USER },
    });
    await app.close();
  });
});

describe('POST /campaigns/:id/agents — the pre-064 database', () => {
  /**
   * ── Why this is a 409 and not a 500 ────────────────────────────────────────
   * `assign()` no longer names an `ON CONFLICT` arbiter, so it plans against
   * migration 060's index as well as 064's. Under 060 a second assignment is not
   * expressible, and the repository says so with a typed error rather than
   * exhausting its retry loop or — far worse — silently MOVING the agent, which
   * would make the result of one request depend on which migration had run.
   *
   * The route turns that into a 409 with a sentence a supervisor can act on. Only
   * reachable between deploying this code and applying 064, or after a
   * `migrate down`; it should never be seen in a settled deployment.
   */
  it('answers 409 with a code and an actionable message, not a 500', async () => {
    const { StaffingUpgradePendingError } = await import(
      '@magick-agency/db/repositories/agency-campaign-agent.repository'
    );
    mocks.assign.mockRejectedValue(
      new StaffingUpgradePendingError(AGENT_USER, OTHER_CAMPAIGN, CAMPAIGN),
    );
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
      payload: { user_id: AGENT_USER },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('staffing_upgrade_pending');
    // Names both remedies, because a supervisor mid-shift needs one that works now.
    expect(res.json().message).toMatch(/unassign them/i);
    expect(res.json().message).toMatch(/next deployment/i);
    await app.close();
  });

  it('writes no audit row for a refused assignment', async () => {
    // The trail records acts, not attempts — the same rule the DELETE route's
    // conditional audit follows.
    const { StaffingUpgradePendingError } = await import(
      '@magick-agency/db/repositories/agency-campaign-agent.repository'
    );
    mocks.assign.mockRejectedValue(
      new StaffingUpgradePendingError(AGENT_USER, OTHER_CAMPAIGN, CAMPAIGN),
    );
    const app = await buildApp({ role: 'account_admin' });

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
      payload: { user_id: AGENT_USER },
    });

    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });

  it('still lets an unrelated failure surface as a 500', async () => {
    // The catch must narrow on the typed error. Swallowing everything here would
    // turn a dropped connection into a confident "finish upgrading" message.
    mocks.assign.mockRejectedValue(new Error('connection terminated unexpectedly'));
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
      payload: { user_id: AGENT_USER },
    });

    expect(res.statusCode).toBe(500);
    expect(res.json().code).not.toBe('staffing_upgrade_pending');
    await app.close();
  });
});

describe('DELETE /campaigns/:id/agents/:userId', () => {
  it('answers 204 and audits when a row was closed', async () => {
    mocks.unassign.mockResolvedValue(ASSIGNMENT_ID);
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${AGENT_USER}`,
    });

    expect(res.statusCode).toBe(204);
    expect(mocks.unassign).toHaveBeenCalledWith(TENANT, CAMPAIGN, AGENT_USER);

    /**
     * The PAYLOAD, not just the call count. Asserting only
     * `toHaveBeenCalledTimes(1)` is how this shipped filing the CAMPAIGN id as
     * `resource_id` under `resource_type: 'agency_campaign_agent'` — a resource
     * of a different type, and unjoinable with POST's entry, which files the
     * assignment id. A count assertion cannot see a wrong id; only an exact one
     * can.
     */
    expect(mocks.auditLog).toHaveBeenCalledWith({
      tenant_id: TENANT,
      account_id: 'account-1',
      actor_type: 'human',
      user_id: SUPERVISOR,
      action: 'agency_campaign_agent.unassigned',
      resource_type: 'agency_campaign_agent',
      resource_id: ASSIGNMENT_ID,
      campaign_id: CAMPAIGN,
      details: { campaign_id: CAMPAIGN, user_id: AGENT_USER },
    });
    await app.close();
  });

  it('files the ASSIGNMENT id, not the campaign id, so the two halves join up', async () => {
    // Stated as its own case because it is the specific regression: the assign
    // and unassign entries for one row's life must share a `resource_id`.
    const app = await buildApp({ role: 'account_admin' });

    await app.inject({
      method: 'POST',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
      payload: { user_id: AGENT_USER },
    });
    await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${AGENT_USER}`,
    });

    const ids = mocks.auditLog.mock.calls.map((c) => c[0].resource_id);
    expect(ids).toEqual([ASSIGNMENT_ID, ASSIGNMENT_ID]);
    expect(ids).not.toContain(CAMPAIGN);
    await app.close();
  });

  it('is idempotent: 204 with no audit row when there was nothing to close', async () => {
    // The requested state — "not staffed here" — holds either way, so a 404 would
    // make a retry look like a failure. The audit trail records acts, not requests.
    mocks.unassign.mockResolvedValue(null);
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({
      method: 'DELETE',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${AGENT_USER}`,
    });

    expect(res.statusCode).toBe(204);
    expect(mocks.auditLog).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('GET /campaigns/:id/agents — identity enrichment', () => {
  it('reports name, email and the HIGHEST role a member holds in the tenant', async () => {
    mocks.listActiveForCampaign.mockResolvedValue([assignmentRow()]);
    mocks.findIdentitiesInTenant.mockResolvedValue([
      { id: AGENT_USER, display_name: 'Sam Okoro', email: 'sam@example.com', role: 'agent' },
      { id: AGENT_USER, display_name: 'Sam Okoro', email: 'sam@example.com', role: 'operator' },
    ]);
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/agents` });

    expect(res.json()).toEqual({
      agents: [
        {
          user_id: AGENT_USER,
          name: 'Sam Okoro',
          email: 'sam@example.com',
          role: 'operator',
          assigned_at: '2026-08-16T09:00:00.000Z',
        },
      ],
    });
    await app.close();
  });

  it('degrades to nulls rather than 500ing when identity resolution fails', async () => {
    mocks.listActiveForCampaign.mockResolvedValue([assignmentRow()]);
    mocks.findIdentitiesInTenant.mockRejectedValue(new Error('db down'));
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/agents` });

    expect(res.statusCode).toBe(200);
    // The KEYS are still produced. A sometimes-absent key is a different defect
    // and a client cannot tell it from one it forgot to read.
    expect(res.json().agents[0]).toEqual({
      user_id: AGENT_USER,
      name: null,
      email: null,
      role: null,
      assigned_at: '2026-08-16T09:00:00.000Z',
    });
    await app.close();
  });

  it('keeps an unresolvable assignment in the list rather than dropping it', async () => {
    // Dropping it would hide a stale assignment from the one person who can fix
    // it, and read as "nobody is staffed" instead of "somebody unidentifiable is".
    mocks.listActiveForCampaign.mockResolvedValue([assignmentRow()]);
    mocks.findIdentitiesInTenant.mockResolvedValue([]);
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/agents` });

    expect(res.json().agents).toHaveLength(1);
    expect(res.json().agents[0].name).toBeNull();
    await app.close();
  });
});

describe('campaign ownership is proved on ALL THREE routes, not just the write', () => {
  /**
   * ── The hole this group exists for ────────────────────────────────────────
   * Campaign ownership is `(tenant_id, account_id)` and master holds neither —
   * it keeps no campaign table. For one commit only `POST` established it (by
   * round-tripping core, whose `requireOwned` compares both and answers 404),
   * while `GET` and `DELETE` filtered on `(campaign_id, tenant_id)` alone. So an
   * `account_admin` scoped to Account A could READ Account B's staffing list —
   * names and emails included — and could UNSTAFF B's agents, while being
   * correctly refused if they tried to add one. A read/delete surface weaker
   * than the write surface guarding the same rows is backwards.
   *
   * `requirePermission` proves the caller's ROLE and never looks at the target
   * row (CLAUDE.md's RBAC section, rule 1), so nothing in the middleware chain
   * could have caught this. These cases are per-route on purpose: the defect was
   * precisely that the three routes disagreed.
   */
  const ROUTES: ReadonlyArray<{
    name: string;
    inject: (app: FastifyInstance) => Promise<{ statusCode: number; json: () => never }>;
  }> = [
    {
      name: 'GET /campaigns/:id/agents',
      inject: (app) =>
        app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/agents` }) as never,
    },
    {
      name: 'POST /campaigns/:id/agents',
      inject: (app) =>
        app.inject({
          method: 'POST',
          url: `${PREFIX}/campaigns/${CAMPAIGN}/agents`,
          payload: { user_id: AGENT_USER },
        }) as never,
    },
    {
      name: 'DELETE /campaigns/:id/agents/:userId',
      inject: (app) =>
        app.inject({
          method: 'DELETE',
          url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/${AGENT_USER}`,
        }) as never,
    },
  ];

  for (const route of ROUTES) {
    it(`${route.name} asks core whether this caller may act on the campaign`, async () => {
      const app = await buildApp({ role: 'account_admin' });

      await route.inject(app);

      // The account is what makes this a real check: core compares it, master
      // cannot. A call that omitted `accountId` would pass a tenant check and
      // still leak across accounts.
      expect(mocks.proxyToCore).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          path: `/agency-campaigns/${CAMPAIGN}`,
          tenantId: TENANT,
          accountId: 'account-1',
        }),
      );
      await app.close();
    });

    it(`${route.name} answers 404 for a campaign in another account, and touches nothing`, async () => {
      // Core's `requireOwned` answers 404 for both "wrong account" and "no such
      // campaign", so master cannot tell them apart — which is the non-oracle
      // property, not a limitation.
      mocks.proxyToCore.mockResolvedValue({ status: 404, body: { error: 'Not Found' } });
      const app = await buildApp({ role: 'account_admin' });

      const res = await route.inject(app);

      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'campaign_not_found' });
      // Nothing was read and nothing was written on the way to the refusal.
      expect(mocks.listActiveForCampaign).not.toHaveBeenCalled();
      expect(mocks.assign).not.toHaveBeenCalled();
      expect(mocks.unassign).not.toHaveBeenCalled();
      expect(mocks.auditLog).not.toHaveBeenCalled();
      await app.close();
    });

    it(`${route.name} forwards a core failure rather than calling it "not found"`, async () => {
      // Master could not PROVE the campaign is out of scope. Answering 404 for
      // "we could not ask" is the confident-wrong answer, and on DELETE it would
      // additionally look like a successful no-op.
      mocks.proxyToCore.mockResolvedValue({ status: 503, body: { error: 'Service Unavailable' } });
      const app = await buildApp({ role: 'account_admin' });

      const res = await route.inject(app);

      expect(res.statusCode).toBe(503);
      expect(mocks.assign).not.toHaveBeenCalled();
      expect(mocks.unassign).not.toHaveBeenCalled();
      await app.close();
    });
  }

  it('the leak case, end to end: another account’s names and emails are not returned', async () => {
    // The concrete harm, asserted on the response rather than on a mock: a
    // campaign core refuses must never come back with a staffing list attached.
    mocks.proxyToCore.mockResolvedValue({ status: 404, body: { error: 'Not Found' } });
    mocks.listActiveForCampaign.mockResolvedValue([assignmentRow()]);
    mocks.findIdentitiesInTenant.mockResolvedValue([
      { id: AGENT_USER, display_name: 'Sam Okoro', email: 'sam@example.com', role: 'agent' },
    ]);
    const app = await buildApp({ role: 'account_admin' });

    const res = await app.inject({ method: 'GET', url: `${PREFIX}/campaigns/${CAMPAIGN}/agents` });

    expect(res.statusCode).toBe(404);
    expect(res.body).not.toContain('sam@example.com');
    expect(res.body).not.toContain('Sam Okoro');
    await app.close();
  });
});

describe('path params are validated as strictly as bodies', () => {
  /**
   * A non-UUID `:id` used to reach a `UUID` column, raise Postgres `22P02` from
   * inside the query, and surface as a 500 — which `errorMaskHook` then rewrote
   * into "contact support and quote this request id" for what is a typo. It also
   * put a client error into the 5xx rate.
   *
   * The local pattern is `threads.routes.ts`'s `threadIdParams.safeParse`, plus
   * `user.repository.ts` filtering non-UUIDs before `ANY($1::uuid[])` and
   * `tenant-context.middleware.ts` mapping `22P02` to a refusal. This follows it.
   */
  const CASES: ReadonlyArray<{ name: string; method: 'GET' | 'POST' | 'DELETE'; url: string }> = [
    { name: 'GET with a bad campaign id', method: 'GET', url: `${PREFIX}/campaigns/not-a-uuid/agents` },
    { name: 'POST with a bad campaign id', method: 'POST', url: `${PREFIX}/campaigns/not-a-uuid/agents` },
    {
      name: 'DELETE with a bad campaign id',
      method: 'DELETE',
      url: `${PREFIX}/campaigns/not-a-uuid/agents/${AGENT_USER}`,
    },
    {
      name: 'DELETE with a bad user id',
      method: 'DELETE',
      url: `${PREFIX}/campaigns/${CAMPAIGN}/agents/not-a-uuid`,
    },
  ];

  for (const c of CASES) {
    it(`${c.name} → 400, not a masked 500`, async () => {
      const app = await buildApp({ role: 'account_admin' });

      const res = await app.inject({
        method: c.method,
        url: c.url,
        ...(c.method === 'POST' ? { payload: { user_id: AGENT_USER } } : {}),
      });

      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: 'Validation Error' });
      // Refused before the database AND before the core round trip — a malformed
      // id is master's own fact and costs nothing to reject.
      expect(mocks.listActiveForCampaign).not.toHaveBeenCalled();
      expect(mocks.assign).not.toHaveBeenCalled();
      expect(mocks.unassign).not.toHaveBeenCalled();
      expect(mocks.proxyToCore).not.toHaveBeenCalled();
      await app.close();
    });
  }
});

describe('every staffing route carries its RBAC permission', () => {
  /**
   * A source-text assertion, copied from `proxy-agency-route-table.test.ts` rather
   * than reinvented, and it earns its place for the same measured reason: a guard
   * DELETED from a route this file exercises would red above, but a route ADDED
   * without a guard would pass every case and be invisible. The registration count
   * is what catches that one.
   */
  const source = readFileSync(
    new URL('../../../src/api/routes/proxy-agency-staffing.routes.ts', import.meta.url),
    'utf8',
  );

  const EXPECTED: ReadonlyArray<readonly [string, string, string]> = [
    ['get', '/my-assignments', 'agency.station.connect'],
    ['get', '/my-campaigns', 'agency.station.connect'],
    ['get', '/my-assignment', 'agency.station.connect'],
    ['get', '/campaigns/:id/agents', 'agency.supervise'],
    ['post', '/campaigns/:id/agents', 'agency.supervise'],
    ['delete', '/campaigns/:id/agents/:userId', 'agency.supervise'],
  ];

  it.each(EXPECTED)('%s %s requires %s', (verb, path, permission) => {
    const pattern = new RegExp(
      `\\.${verb}(?:<[^>]*>)?\\(\\s*'${path.replace(/[/:.]/g, '\\$&')}'\\s*,\\s*\\{\\s*` +
        `preHandler: requirePermission\\('${permission.replace(/\./g, '\\.')}'\\)`,
    );

    expect(pattern.test(source), `${verb.toUpperCase()} ${path} must be guarded by ${permission}`)
      .toBe(true);
  });

  it('knows about every route in the file, so a NEW unguarded one reds', () => {
    const registrations =
      source.match(/\b(?:app|sub)\.(?:get|post|patch|put|delete)(?:<[^>]*>)?\(/g) ?? [];

    expect(registrations).toHaveLength(EXPECTED.length);
  });

  it('registers exactly these six routes, as Fastify sees them', async () => {
    const app = Fastify({ logger: false });
    const routes: string[] = [];
    app.addHook('onRoute', (route) => {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const method of methods) {
        if (method === 'HEAD') continue;
        routes.push(`${method} ${route.url}`);
      }
    });
    await app.register(proxyAgencyStaffingRoutes, { prefix: PREFIX });
    await app.ready();

    expect([...routes].sort()).toEqual([
      'DELETE /proxy/agency/campaigns/:id/agents/:userId',
      'GET /proxy/agency/campaigns/:id/agents',
      'GET /proxy/agency/my-assignment',
      'GET /proxy/agency/my-assignments',
      'GET /proxy/agency/my-campaigns',
      'POST /proxy/agency/campaigns/:id/agents',
    ]);
    await app.close();
  });
});
