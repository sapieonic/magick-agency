import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ---------------------------------------------------------------------------
// `POST /agency-campaigns/:id/{start,pause,resume,stop}` — the lifecycle actor.
// The four handlers are pure `transitionStatus` writes (no runtime call); `stopping → stopped`
// is the pacing leader's and is not exercised here.
//
// The repository half of migration 108 is in
// `campaign-lifecycle-timestamps.test.ts` (the UPDATE's argument order, the
// terminal CASE, the wire fold). This file is the ROUTE half, and it exists for
// two assertions:
//
// 1. **No lifecycle timestamp is passed from here any more.** `/start` and
//    `/resume` both used to pass `{ started_at: new Date() }`, and that is what
//    overwrote a campaign\'s original start on every resume. The stamps are now
//    derived from the target status inside the one UPDATE that moves a status, so
//    the assertion is on the patch\'s KEY SET — a timestamp reappearing here is a
//    failure rather than something a matcher waves through.
//
// 2. **The actor is optional, and cannot refuse the transition.** `checkActor`
//    400s an attempt-scoped write with no actor; a transition is not that, and
//    refusing one for want of attribution would put a 400 in front of THE OFF
//    BUTTON for every caller not yet upgraded — the same class of mistake as
//    gating `/stop` behind the dialer flag.
//
// Separate FILE rather than a separate `describe`, because the two halves need
// incompatible module graphs: this one mocks the repository, and that one needs the
// real `AgencyCampaignRepository` over a mocked pool.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));

const { authSpy } = vi.hoisted(() => ({
  authSpy: vi.fn(async (_request: unknown, _reply: unknown) => { /* authenticated */ }),
}));
vi.mock('../../../src/api/middleware/auth.middleware.js', () => ({
  authMiddleware: authSpy,
  getTenantId: () => 't1',
  getAccountId: () => 'a1',
  getOriginator: () => null,
}));

const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { default: false } },
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { repos } = vi.hoisted(() => ({
  repos: {
    campaigns: {
      findById: vi.fn(), transitionStatus: vi.fn(), rosterCounts: vi.fn(),
    },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: repos.campaigns,
  agencyAttemptRepository: {},
  agencyContactRepository: {},
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: { findActiveByIdScoped: vi.fn() },
}));

const { agencyCampaignRoutes } = await import('../../../src/api/routes/agency-campaigns.routes.js');

const DEPS = {
  runtime: { dnc: { appliedVersion: async () => 1 }, stations: { connectedBySession: async () => new Map() } },
  callManager: {
    accountConcurrencyGuard: { getDistributedAccountCount: async () => ({ status: 'unavailable' as const }) },
  },
} as unknown as Parameters<typeof agencyCampaignRoutes>[1];

const ROW = {
  id: 'camp-1', tenant_id: 't1', account_id: 'a1', name: 'Q3', status: 'running',
  started_at: null, ended_at: null, completed_at: null,
  last_transition_by_user_id: null, last_transition_by_name: null,
};

async function control(path: string, body?: unknown) {
  const app = Fastify();
  await app.register((a) => agencyCampaignRoutes(a as never, DEPS), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
  const res = await app.inject({
    method: 'POST',
    url: `/api/v1/agency-campaigns/camp-1/${path}`,
    headers: { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' },
    ...(body === undefined ? {} : { payload: body as object }),
  });
  await app.close();
  return res;
}

describe('the lifecycle routes read the actor from the body', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flags.isEnabled.mockResolvedValue(true);
    repos.campaigns.rosterCounts.mockResolvedValue({ total: 10, dialable: 10 });
    repos.campaigns.transitionStatus.mockResolvedValue(ROW);
  });

  it('threads { user_id, name } into the patch', async () => {
    repos.campaigns.findById.mockResolvedValue({ ...ROW, status: 'draft' });
    const res = await control('start', { actor_user_id: 'u-supervisor', actor_name: 'Test Supervisor' });
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(repos.campaigns.transitionStatus).toHaveBeenCalledWith(
      'camp-1', ['draft', 'paused'], 'running',
      { last_transition_by: { user_id: 'u-supervisor', name: 'Test Supervisor' } },
    );
  });

  it('passes an EMPTY patch when the body carries no actor — the transition still runs', async () => {
    repos.campaigns.findById.mockResolvedValue({ ...ROW, status: 'running' });
    const res = await control('stop');
    // ── The reason the actor is optional ──────────────────────────────────────
    // `checkActor` 400s an attempt-scoped write with no actor, because a
    // disposition IS the record of who said what about a customer. A transition is
    // not that. Refusing it for want of attribution would put a 400 in front of THE
    // OFF BUTTON for every caller not yet upgraded — the same class of mistake as
    // gating `/stop` behind the dialer flag.
    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(repos.campaigns.transitionStatus).toHaveBeenCalledWith(
      'camp-1', ['running', 'paused'], 'stopping', {},
    );
  });

  it('treats a blank or wrong-typed actor id as absent, never as an actor', async () => {
    for (const body of [{ actor_user_id: '   ' }, { actor_user_id: 42 }, { actor_name: 'Test Supervisor' }]) {
      vi.clearAllMocks();
      flags.isEnabled.mockResolvedValue(true);
      repos.campaigns.transitionStatus.mockResolvedValue(ROW);
      repos.campaigns.findById.mockResolvedValue({ ...ROW, status: 'running' });
      const res = await control('pause', body);
      expect(res.statusCode, JSON.stringify(body)).toBe(200);
      // A name with no id is not an actor: the id is what a console links to a user.
      expect(repos.campaigns.transitionStatus).toHaveBeenCalledWith(
        'camp-1', ['running'], 'paused', {},
      );
    }
  });

  it('DROPS an over-long actor id — an identity must not be truncated', async () => {
    repos.campaigns.findById.mockResolvedValue({ ...ROW, status: 'running' });
    const res = await control('pause', {
      actor_user_id: 'u-'.padEnd(200, 'x'),
      actor_name: 'Test Supervisor',
    });
    // The asymmetry with the name below is the point. An id is an IDENTITY — the public API layer
    // resolves it back to a user — so a truncated one is not a shortened answer, it
    // is a DIFFERENT user. Recording that would attribute the transition to the
    // wrong human, which is precisely what the `null`-means-unknown contract exists
    // to prevent. And it must not refuse the transition either, so the actor is
    // simply dropped.
    expect(res.statusCode).toBe(200);
    expect(repos.campaigns.transitionStatus).toHaveBeenCalledWith(
      'camp-1', ['running'], 'paused', {},
    );
  });

  it('TRUNCATES an over-long name rather than failing the transition', async () => {
    repos.campaigns.findById.mockResolvedValue({ ...ROW, status: 'paused' });
    const res = await control('resume', {
      actor_user_id: 'u-supervisor',
      actor_name: 'M'.repeat(400),
    });
    // `last_transition_by_name` is VARCHAR(255); a longer value raises 22001 and
    // would fail the TRANSITION — a supervisor losing a control because their
    // display name is long. Truncated attribution is a cosmetic loss; a refused
    // transition is a control that does not work.
    expect(res.statusCode).toBe(200);
    const patch = repos.campaigns.transitionStatus.mock.calls[0]![3] as
      { last_transition_by: { name: string } };
    expect(patch.last_transition_by.name).toHaveLength(255);
  });

  it('does NOT pass a lifecycle timestamp from the route any more', async () => {
    repos.campaigns.findById.mockResolvedValue({ ...ROW, status: 'paused' });
    await control('resume', { actor_user_id: 'u-supervisor' });
    const patch = repos.campaigns.transitionStatus.mock.calls[0]![3] as Record<string, unknown>;
    // THE fix, asserted at the site that used to be wrong: `/resume` passed
    // `{ started_at: new Date() }` and that is what overwrote the original start.
    // The stamp is now derived from the target status inside the UPDATE.
    expect(Object.keys(patch)).toEqual(['last_transition_by']);
    expect(patch).not.toHaveProperty('started_at');
    expect(patch).not.toHaveProperty('completed_at');
    expect(patch).not.toHaveProperty('ended_at');
  });

  it('serves the FOLDED campaign row back, not the raw columns', async () => {
    repos.campaigns.findById.mockResolvedValue({ ...ROW, status: 'draft' });
    repos.campaigns.transitionStatus.mockResolvedValue({
      ...ROW, last_transition_by_user_id: 'u-supervisor', last_transition_by_name: 'Test Supervisor',
    });
    const res = await control('start', { actor_user_id: 'u-supervisor', actor_name: 'Test Supervisor' });
    const body = res.json();
    expect(body.last_transition_by).toEqual({ user_id: 'u-supervisor', name: 'Test Supervisor' });
    expect(body).not.toHaveProperty('last_transition_by_user_id');
  });
});
