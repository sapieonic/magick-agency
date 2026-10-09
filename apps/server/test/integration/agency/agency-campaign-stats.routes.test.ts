import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT, uuidFor } from '../setup/factories.js';
import {
  insertAgencyAttempt,
  insertAgencyCampaign,
  insertAgencyContact,
  insertAgentSession,
} from './agency-factories.js';

/*
 * PORT NOTE (magick-agency, Phase 8): ported from core
 * test/integration/agency/agency-campaign-stats.routes.test.ts@4850d1d9 (7 cases, all kept).
 * Recorded changes:
 *  - core's handler module now runs only on the private in-process instance behind
 *    `callCore` (decision B16), where `authMiddleware` keeps only its header half: the
 *    `x-api-key` header, `insertApiKey`, and the `config.auth` / PostHog mocks that served
 *    the API-key branch are gone with it (decision #5);
 *  - the pool mock is `@magick-agency/db` (agency's `getPool`); the logger mock is partial;
 *  - ids: `'test-tenant'`/`'test-account'` are the shared `DEFAULTS` UUIDs (the factories'
 *    defaults, as core's were); `'other-tenant'`/`'other-account'` are `OTHER_TENANT` /
 *    `OTHER_ACCOUNT`; agent labels (`'at-their-desk'`, …) are `uuidFor(label)` (the
 *    baseline types `agent_user_id` UUID).
 * NEW cases (no source twin) at the end: the real DNC probe (`dnc-availability.ts`) on real
 * Postgres, and the spine's `?agent_user_id=` guard against a real `22P02`.
 */

vi.mock('@magick-agency/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({
  auditLogger: { log: vi.fn() },
}));

const { flags } = vi.hoisted(() => ({
  flags: { isEnabled: vi.fn().mockResolvedValue(true) },
}));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean' } },
}));

const { agencyCampaignRoutes } = await import(
  '../../../src/api/routes/agency-campaigns.routes.js'
);
type AgencyCampaignRouteDeps = import(
  '../../../src/api/routes/agency-campaigns.routes.js'
).AgencyCampaignRouteDeps;
const { AGENCY_CAMPAIGN_STATS_FIELDS } = await import('@magick-agency/contracts/agency');
const { dncAvailabilityProbe } = await import('../../../src/agency/dnc-availability.js');
const { DncRegistry } = await import('../../../src/agency/dnc-registry.js');

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;

/**
 * The strip's two non-SQL dependencies, as NARROW STUBS RETURNING REAL VALUES.
 *
 * A real `AgencyRuntime.dnc` is a `DncRegistry` over Redis and a real
 * `AccountConcurrencyGuard` is a second Redis client — too heavy for a route test
 * whose subject is the SQL and the assembler. The stubs are therefore narrow, but
 * they are deliberately NOT degraded: every one returns the value a healthy
 * dependency would. A stub that returned `null`/unavailable would pin the payload
 * against a permanently degraded strip, and every diagnosis these values feed
 * would then be untested while still looking green.
 *
 * `DNC_APPLIED_VERSION` non-null ⇒ `dnc_unavailable` must NOT be diagnosed;
 * `CONCURRENCY_IN_USE` must surface verbatim as `concurrency_in_use`. Both are
 * asserted below, so the wiring is pinned rather than merely present — this file
 * previously registered the plugin with no deps at all, which Fastify silently
 * satisfied with the register options object.
 */
const DNC_APPLIED_VERSION = 7;
const CONCURRENCY_IN_USE = 2;

const appliedVersion = vi.fn(async (_tenantId: string): Promise<number | null> => DNC_APPLIED_VERSION);
const getDistributedAccountCount = vi.fn(
  async (_tenantId: string, _accountId: string) =>
    ({ status: 'available', count: CONCURRENCY_IN_USE }) as
      | { status: 'available'; count: number }
      | { status: 'unavailable' },
);

/**
 * §C.4 liveness, healthy by default: every session asked about is connected.
 *
 * Same rule as the two stubs above — a stub that answered `false` everywhere would
 * pin the floor against a permanently disconnected shift, and the `connected`
 * column would look tested while never once carrying a live agent.
 */
const connectedBySession = vi.fn(
  async (sessionIds: readonly string[]) => new Map(sessionIds.map((id) => [id, true])),
);

function statsDeps(): AgencyCampaignRouteDeps {
  return {
    runtime: { dnc: { appliedVersion }, stations: { connectedBySession } },
    callManager: { accountConcurrencyGuard: { getDistributedAccountCount } },
  };
}

let app: FastifyInstance;

function headers(overrides: Record<string, string> = {}) {
  return {
    'x-mgkvc-tenant': TENANT,
    'x-mgkvc-account': ACCOUNT,
    ...overrides,
  };
}

/** Every diagnosis in the ranking, winner first — `stall` plus `other_stalls`. */
function stallCodes(body: { stall: { code: string } | null; other_stalls: string[] }): string[] {
  return [...(body.stall ? [body.stall.code] : []), ...body.other_stalls];
}

async function getStats(campaignId: string, requestHeaders = headers()) {
  return app.inject({
    method: 'GET',
    url: `/api/v1/agency-campaigns/${campaignId}/stats`,
    headers: requestHeaders,
  });
}

describe('GET /api/v1/agency-campaigns/:id/stats (integration)', () => {
  beforeEach(async () => {
    await truncateAll();
    flags.isEnabled.mockResolvedValue(true);
    appliedVersion.mockClear();
    getDistributedAccountCount.mockClear();
    connectedBySession.mockClear();
    connectedBySession.mockImplementation(
      async (sessionIds: readonly string[]) => new Map(sessionIds.map((id) => [id, true])),
    );

    app = Fastify({ logger: false });
    // Wrapped in a closure, exactly as `src/index.ts` registers it. Registering
    // the plugin function directly makes Fastify pass the OPTIONS object as
    // `deps`, so `deps.runtime` is `undefined` — which is what this file used to
    // do, and why the strip was never executed here.
    await app.register(async (scope) => agencyCampaignRoutes(scope, statsDeps()), {
      prefix: '/api/v1/agency-campaigns',
    });
    await app.ready();
  });

  afterEach(async () => {
    await app?.close();
  });

  afterAll(closeTestPool);

  it('executes the real 24h SQL predicate and serves the complete typed payload', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });

    const pendingNow = await insertAgencyContact(campaign.id, {
      state: 'pending', next_attempt_at: new Date(Date.now() - 60_000), source_row_number: 1,
    });
    const pendingRetry = await insertAgencyContact(campaign.id, {
      state: 'pending', next_attempt_at: new Date(Date.now() + 60 * 60_000), source_row_number: 2,
    });
    const inFlight = await insertAgencyContact(campaign.id, {
      state: 'in_flight', source_row_number: 3,
    });
    const completed = await insertAgencyContact(campaign.id, {
      state: 'completed', source_row_number: 4,
    });
    const suppressed = await insertAgencyContact(campaign.id, {
      state: 'suppressed', suppressed_reason: 'dnc', source_row_number: 5,
    });
    const exhausted = await insertAgencyContact(campaign.id, {
      state: 'exhausted', source_row_number: 6,
    });

    const now = Date.now();
    const answeredHealthy = new Date(now - 2 * 60 * 60_000);
    const answeredNoBridge = new Date(now - 3 * 60 * 60_000);
    const answeredLateBridge = new Date(now - 4 * 60 * 60_000);
    const answeredOutsideWindow = new Date(now - 25 * 60 * 60_000);
    const answeredLive = new Date(now - 5 * 60_000);

    await insertAgencyAttempt(campaign.id, pendingNow.id, {
      attempt_number: 1,
      state: 'ended', outcome: 'connected', answered_at: answeredHealthy,
      bridged_at: new Date(answeredHealthy.getTime() + 500), ended_at: new Date(),
    });
    await insertAgencyAttempt(campaign.id, pendingRetry.id, {
      attempt_number: 1,
      state: 'ended', outcome: 'failed', answered_at: answeredNoBridge,
      bridged_at: null, ended_at: new Date(),
    });
    await insertAgencyAttempt(campaign.id, inFlight.id, {
      attempt_number: 1,
      state: 'ended', outcome: 'connected', answered_at: answeredLateBridge,
      bridged_at: new Date(answeredLateBridge.getTime() + 2_000), ended_at: new Date(),
    });
    await insertAgencyAttempt(campaign.id, completed.id, {
      attempt_number: 1,
      state: 'ended', outcome: 'abandoned', answered_at: answeredOutsideWindow,
      bridged_at: null, ended_at: new Date(),
    });
    await insertAgencyAttempt(campaign.id, suppressed.id, {
      attempt_number: 1,
      state: 'answered', outcome: null, answered_at: answeredLive,
      bridged_at: null, ended_at: null,
    });
    await insertAgencyAttempt(campaign.id, exhausted.id, {
      attempt_number: 1,
      state: 'ended', outcome: 'no_answer', answered_at: null,
      bridged_at: null, ended_at: new Date(),
    });

    const otherCampaign = await insertAgencyCampaign({ status: 'draft' });
    const otherContact = await insertAgencyContact(otherCampaign.id, { source_row_number: 1 });
    await insertAgencyAttempt(otherCampaign.id, otherContact.id, {
      state: 'ended', outcome: 'abandoned',
      answered_at: new Date(now - 60_000), bridged_at: null, ended_at: new Date(),
    });

    await insertAgentSession(campaign.id, { state: 'available', left_at: null });
    await insertAgentSession(campaign.id, { state: 'offline', left_at: new Date() });
    await insertAgentSession(otherCampaign.id, { state: 'available', left_at: null });

    const response = await getStats(campaign.id);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(Object.keys(body).sort()).toEqual(Object.keys(AGENCY_CAMPAIGN_STATS_FIELDS).sort());
    expect(body).toMatchObject({
      campaign_id: campaign.id,
      status: 'running',
      contacts_total: 6,
      contacts_pending: 2,
      contacts_in_flight: 1,
      contacts_completed: 1,
      contacts_suppressed: 1,
      contacts_exhausted: 1,
      retries_pending: 1,
      attempts_live: 1,
      attempts_total: 6,
      attempts_connected: 2,
      agents_live: 1,
      answered_24h: 3,
      abandoned_24h: 2,
    });
    expect(body.abandonment_rate_24h_pct).toBeCloseTo(200 / 3, 8);

    // The strip half, pinned to the injected deps rather than merely present.
    // `concurrency_in_use` is the stub's count verbatim, and a non-null applied
    // DNC version means `dnc_unavailable` must not appear anywhere in the
    // ranking — both would still "pass" as `null`/present under the degraded
    // wiring this file used to have.
    expect(appliedVersion).toHaveBeenCalledWith(TENANT);
    expect(getDistributedAccountCount).toHaveBeenCalledWith(TENANT, ACCOUNT);
    expect(body.concurrency_in_use).toBe(CONCURRENCY_IN_USE);
    expect(stallCodes(body)).not.toContain('dnc_unavailable');
  });

  it('degrades the strip to a 200 when a dependency throws synchronously', async () => {
    // The failure the route's best-effort comment claims to cover and did not:
    // `.catch()` only handles a REJECTED promise, so a dependency that throws
    // while the argument list is being evaluated — a getter that throws, or a
    // `deps` object Fastify filled with register options — escaped before any
    // promise existed and 500'd the whole route. Both shapes are exercised here:
    // `runtime` throws on property access, `callManager.accountConcurrencyGuard`
    // is missing entirely.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    // One live agent, so the floor is non-empty and its liveness column has
    // something to be unknown ABOUT — on an empty floor `connected` is vacuous and
    // this assertion would pass against a route that never resolved it at all.
    await insertAgentSession(campaign.id, { state: 'available' });

    const degraded = Fastify({ logger: false });
    const brokenDeps = {
      get runtime(): AgencyCampaignRouteDeps['runtime'] {
        throw new Error('agency runtime unavailable');
      },
      callManager: {} as AgencyCampaignRouteDeps['callManager'],
    } as AgencyCampaignRouteDeps;
    await degraded.register(async (scope) => agencyCampaignRoutes(scope, brokenDeps), {
      prefix: '/api/v1/agency-campaigns',
    });
    await degraded.ready();

    try {
      const response = await degraded.inject({
        method: 'GET',
        url: `/api/v1/agency-campaigns/${campaign.id}/stats`,
        headers: headers(),
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      // Degraded means the documented fallbacks, not a guess: unknown in-use, and
      // the DNC diagnosis raised precisely because sync state could not be read.
      expect(body.concurrency_in_use).toBeNull();
      expect(stallCodes(body)).toContain('dnc_unavailable');
      // The SQL half is unaffected by a broken strip dependency.
      expect(Object.keys(body).sort()).toEqual(Object.keys(AGENCY_CAMPAIGN_STATS_FIELDS).sort());
      // And the floor still lists its agents — with liveness UNKNOWN, never
      // `false`. A degraded read must not manufacture "disconnected" on the screen
      // a supervisor acts from; `null` says we could not tell, which is the truth.
      expect(body.agents).toHaveLength(1);
      expect(body.agents[0].connected).toBeNull();
    } finally {
      await degraded.close();
    }
  });

  it('returns null rather than a reassuring zero when the denominator is empty', async () => {
    const campaign = await insertAgencyCampaign({ status: 'draft' });

    const response = await getStats(campaign.id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      campaign_id: campaign.id,
      answered_24h: 0,
      abandoned_24h: 0,
      abandonment_rate_24h_pct: null,
    });
  });

  it('serves per-agent liveness, asked once for the whole floor', async () => {
    // §C.4 risk rank 4. `connected` is the ROUTE's field — the roster is SQL and
    // liveness is Redis — so this is the seam where a missing merge would show up
    // as `undefined` on the wire.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const here = await insertAgentSession(campaign.id, {
      agent_user_id: uuidFor('at-their-desk'), state: 'available',
    });
    const ghost = await insertAgentSession(campaign.id, {
      agent_user_id: uuidFor('browser-died'), state: 'available',
    });
    // A session row says the shift is open; only the station key says the human is
    // still there. This is the pair the floor exists to tell apart.
    connectedBySession.mockResolvedValue(new Map([[here.id, true], [ghost.id, false]]));

    const response = await getStats(campaign.id);

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const byUser = Object.fromEntries(
      (body.agents as Array<{ agent_user_id: string; connected: boolean | null }>)
        .map((a) => [a.agent_user_id, a.connected]),
    );
    expect(byUser).toEqual({ [uuidFor('at-their-desk')]: true, [uuidFor('browser-died')]: false });

    // One call for the whole floor, not one per agent: this route is polled, and a
    // per-row lookup is the N+1 that only shows up under a full shift.
    expect(connectedBySession).toHaveBeenCalledTimes(1);
    expect([...connectedBySession.mock.calls[0]![0]].sort()).toEqual([here.id, ghost.id].sort());
  });

  it('reports an agent the registry omits as unknown, not as disconnected', async () => {
    // A session the liveness read simply did not answer for — a partial reply, a
    // shape change, an agent who joined between the two reads. `?? null` is what
    // keeps that from being read as a confident "disconnected"; `?? false` would
    // have been the easy and wrong default.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    await insertAgentSession(campaign.id, { agent_user_id: uuidFor('unanswered-for') });
    connectedBySession.mockResolvedValue(new Map());

    const body = (await getStats(campaign.id)).json();

    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].connected).toBeNull();
  });

  it('never asks about liveness when the floor is empty', async () => {
    // `MGET` with no keys is an error, and a campaign between shifts is the common
    // case — so the empty floor must short-circuit rather than reach Redis.
    const campaign = await insertAgencyCampaign({ status: 'running' });

    const body = (await getStats(campaign.id)).json();

    expect(body.agents).toEqual([]);
    expect(connectedBySession).toHaveBeenCalledWith([]);
  });

  it('does not expose another tenant account\'s campaign statistics', async () => {
    const campaign = await insertAgencyCampaign({
      tenant_id: OTHER_TENANT, account_id: OTHER_ACCOUNT, status: 'running',
    });

    const response = await getStats(campaign.id);

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'Not Found' });
  });
  // ── NEW (magick-agency, Phase 8) ────────────────────────────────────────────

  it('the real DNC probe answers null exactly when the real gate read answers unavailable (real Postgres)', async () => {
    // `dnc-availability.ts`'s equivalence on the real `dnc_entries` read: a healthy read
    // is a non-null "version"; a read Postgres refuses (a real 22P02 on a malformed
    // tenant id) is `null`, which is the `dnc_unavailable` stall — and in both cases the
    // gate's own `check` agrees.
    const registry = new DncRegistry();
    const probe = dncAvailabilityProbe(registry);
    const scope = { accountId: null, campaignId: null };

    expect(await registry.check(TENANT, '+10000000000', scope)).not.toBe('unavailable');
    expect(await probe.appliedVersion(TENANT)).toBe(1);

    expect(await registry.check('not-a-uuid', '+10000000000', scope)).toBe('unavailable');
    expect(await probe.appliedVersion('not-a-uuid')).toBeNull();
  });

  it('wired with the real DNC probe, a healthy tenant shows no dnc_unavailable stall', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const real = Fastify({ logger: false });
    await real.register(async (scope) => agencyCampaignRoutes(scope, {
      ...statsDeps(),
      runtime: { dnc: dncAvailabilityProbe(), stations: { connectedBySession } },
    }), { prefix: '/api/v1/agency-campaigns' });
    await real.ready();
    try {
      const response = await real.inject({
        method: 'GET', url: `/api/v1/agency-campaigns/${campaign.id}/stats`, headers: headers(),
      });
      expect(response.statusCode).toBe(200);
      expect(stallCodes(response.json())).not.toContain('dnc_unavailable');
    } finally {
      await real.close();
    }
  });

  it('the spine refuses a non-UUID agent filter with 400 before Postgres, and a UUID matching nobody is an empty page', async () => {
    // Core's column was VARCHAR, so `?agent_user_id=u9` matched nothing; agency's is UUID,
    // so the same value would be a real 22P02 (a 500). The route refuses it first.
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const contact = await insertAgencyContact(campaign.id, { source_row_number: 1 });
    await insertAgencyAttempt(campaign.id, contact.id, { state: 'ended', outcome: 'no_answer' });

    const bad = await app.inject({
      method: 'GET', url: `/api/v1/agency-campaigns/${campaign.id}/attempts?agent_user_id=u9`, headers: headers(),
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().details[0].param).toBe('agent_user_id');

    const nobody = await app.inject({
      method: 'GET',
      url: `/api/v1/agency-campaigns/${campaign.id}/attempts?agent_user_id=${uuidFor('nobody')}`,
      headers: headers(),
    });
    expect(nobody.statusCode).toBe(200);
    expect(nobody.json().rows).toEqual([]);

    const all = await app.inject({
      method: 'GET', url: `/api/v1/agency-campaigns/${campaign.id}/attempts`, headers: headers(),
    });
    expect(all.json().rows).toHaveLength(1);
  });
});
