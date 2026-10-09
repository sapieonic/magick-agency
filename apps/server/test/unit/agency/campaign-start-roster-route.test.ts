import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

/*
 * PORT NOTE (magick-agency, Phase 8): ported from core test/unit/agency/campaign-start-roster-route.test.ts@4850d1d9.
 * Mock paths re-pointed only (logger → a partial `@magick-agency/observability` mock;
 * announcement / call / account-settings / profile repositories → `@magick-agency/db/repositories/*`;
 * leaf modules → `@magick-agency/domain/*`; `contracts.js` → `@magick-agency/contracts/agency`).
 * Cases verbatim unless noted here. `/start`'s roster gate is a repository read (no runtime call).
 */

// ---------------------------------------------------------------------------
// `POST /agency-campaigns/:id/start` — refuse a campaign with nothing to dial.
//
// ── WHY THIS IS WORSE THAN "IT JUST SITS THERE" ────────────────────────────
//
// The obvious reading is that an empty campaign starts and hangs on Running.
// It does not, and the truth is harder to diagnose: the pacing leader picks the
// campaign up on its next supervise pass (2s), finds `countOutstanding = 0`, and
// finalizes it straight to `completed`. So the operator gets a 200 saying
// Running, watches it flip to Completed a couple of seconds later, and is told
// nothing at all about the roster they forgot to upload. The campaign looks like
// it ran and finished.
//
// The gate lives at the route because this is the only moment a human is present
// to be told — and it distinguishes "never populated" from "run to exhaustion"
// because those are different mistakes with different remedies.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: { redis: { keyPrefix: '' }, telephony: {} },
}));

vi.mock('../../../src/api/middleware/auth.middleware.js', () => ({
  authMiddleware: vi.fn(async () => { /* authenticated */ }),
  getTenantId: (req: any) => req.headers['x-mgkvc-tenant'] ?? 't1',
  getAccountId: (req: any) => req.headers['x-mgkvc-account'] ?? 'a1',
  getOriginator: () => null,
}));

const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { default: false } },
}));

vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));

const { campaigns } = vi.hoisted(() => ({
  campaigns: {
    findById: vi.fn(),
    transitionStatus: vi.fn(),
    rosterCounts: vi.fn(),
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: { findActiveByIdScoped: vi.fn() },
}));

import { agencyCampaignRoutes } from '../../../src/api/routes/agency-campaigns.routes.js';

/**
 * `AD-P4-C-01` gave this plugin dependencies, for the stats route's health strip
 * only. Every test in this file exercises a DIFFERENT route, so the stubs exist
 * to satisfy the signature and are deliberately not exercised — a stub that
 * returned plausible health data here would invite an assertion about a surface
 * this file does not cover.
 */
const HEALTH_DEPS = {
  runtime: { dnc: { appliedVersion: async () => 1 } },
  callManager: {
    accountConcurrencyGuard: {
      getDistributedAccountCount: async () => ({ status: 'unavailable' as const }),
    },
  },
} as unknown as Parameters<typeof agencyCampaignRoutes>[1];

const HEADERS = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };

const DRAFT = {
  id: 'camp-1', tenant_id: 't1', account_id: 'a1', name: 'Q3 Renewals',
  caller_ids: ['+14155550100'], status: 'draft',
};

async function makeApp() {
  const app = Fastify();
  await app.register((a) => agencyCampaignRoutes(a as never, HEALTH_DEPS), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  campaigns.findById.mockResolvedValue(DRAFT);
  campaigns.transitionStatus.mockImplementation(async (_id: string, _from: string[], to: string) => ({
    ...DRAFT, status: to,
  }));
  campaigns.rosterCounts.mockResolvedValue({ total: 250, dialable: 250 });
});

describe('POST /:id/start — the roster gate', () => {
  it('starts normally when there is work to do', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/start', headers: HEADERS });

    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(res.json().status).toBe('running');
  });

  it('refuses a campaign that was never populated, and says to upload a roster', async () => {
    campaigns.rosterCounts.mockResolvedValue({ total: 0, dialable: 0 });
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/start', headers: HEADERS });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('campaign_roster_empty');
    // The message has to name the remedy. "No dialable contacts" is a restatement
    // of the error; "upload a contact roster" is the next action.
    expect(res.json().message).toMatch(/upload a contact roster/i);
    // And the status never moved — a campaign that 409s must not be left `running`.
    expect(campaigns.transitionStatus).not.toHaveBeenCalled();
  });

  it('distinguishes an EXHAUSTED campaign from an empty one', async () => {
    // Different mistake, different fix. Telling an operator who uploaded 250
    // contacts and dialed all of them that the campaign "has no contacts" sends
    // them looking for an upload that already succeeded.
    campaigns.rosterCounts.mockResolvedValue({ total: 250, dialable: 0 });
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/start', headers: HEADERS });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('campaign_roster_exhausted');
    expect(res.json().message).toMatch(/All 250 contacts/);
    expect(res.json().message).toMatch(/fresh roster/i);
    expect(campaigns.transitionStatus).not.toHaveBeenCalled();
  });

  it('asks the repository for the roster counts, and gates on `dialable` alone', async () => {
    // ── This used to claim to test retry backoff, and could not ───────────────
    // It mocked `{total: 40, dialable: 40}` and asserted 200 — true of any positive
    // number, and silent about backoff, because whether a backed-off contact counts
    // as dialable lives entirely in `rosterCounts`'s SQL `FILTER` clause. That
    // property is now pinned where it lives, in
    // `agency-repository.test.ts > rosterCounts — the start gate's predicate`.
    //
    // What IS this route's own behaviour, and all it can honestly assert: it asks
    // the right campaign, and it branches on `dialable` rather than on `total`.
    campaigns.rosterCounts.mockResolvedValue({ total: 250, dialable: 1 });
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/start', headers: HEADERS });

    expect(res.statusCode).toBe(200);
    expect(campaigns.rosterCounts).toHaveBeenCalledWith('camp-1');
  });

  it('gates on `dialable`, NOT on `total` — a fully-worked roster is refused', async () => {
    // The inverse of the case above, and the pair is what proves which field the
    // branch reads: a large `total` must not rescue a zero `dialable`.
    campaigns.rosterCounts.mockResolvedValue({ total: 9999, dialable: 0 });
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/start', headers: HEADERS });

    expect(res.statusCode).toBe(409);
  });

  it('reports a bad TRANSITION before it reports an empty roster', async () => {
    // An already-running campaign gets the transition error, not a roster error it
    // cannot act on — the roster is not what is wrong with that request.
    campaigns.findById.mockResolvedValue({ ...DRAFT, status: 'running' });
    campaigns.rosterCounts.mockResolvedValue({ total: 0, dialable: 0 });
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/start', headers: HEADERS });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('invalid_campaign_transition');
    // The roster was never even read — the guard is ordered, not merely present.
    expect(campaigns.rosterCounts).not.toHaveBeenCalled();
  });

  it('does not gate /stop — a stuck empty campaign must always be stoppable', async () => {
    // Gating every transition would make an empty campaign unstoppable, which is
    // the failure this whole change exists to avoid a version of.
    campaigns.findById.mockResolvedValue({ ...DRAFT, status: 'running' });
    campaigns.rosterCounts.mockResolvedValue({ total: 0, dialable: 0 });
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/stop', headers: HEADERS });

    expect(res.statusCode).toBe(200);
    expect(campaigns.rosterCounts).not.toHaveBeenCalled();
  });

  it('does not gate /pause or /resume', async () => {
    // `/resume` follows a pause the supervisor issued moments ago; a campaign that
    // drained while paused is finalized by the leader on its first tick. A 409 in
    // front of that control blocks the only thing left for it to do.
    campaigns.rosterCounts.mockResolvedValue({ total: 0, dialable: 0 });

    campaigns.findById.mockResolvedValue({ ...DRAFT, status: 'running' });
    const app = await makeApp();
    expect((await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/pause', headers: HEADERS })).statusCode).toBe(200);

    campaigns.findById.mockResolvedValue({ ...DRAFT, status: 'paused' });
    expect((await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/resume', headers: HEADERS })).statusCode).toBe(200);

    expect(campaigns.rosterCounts).not.toHaveBeenCalled();
  });

  it('stays behind the feature flag', async () => {
    flags.isEnabled.mockResolvedValue(false);
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/start', headers: HEADERS });

    expect(res.statusCode).toBe(403);
    expect(campaigns.rosterCounts).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// The kill switch must not remove the off button.
//
// `agency_dialer_enabled` now genuinely stops the pacing engine — but every
// lifecycle control was still behind the same flag, so turning the dialer off
// left the campaign row in `running` with its supervisor unable to stop it. The
// only route to the Stop button was to re-enable the dialer for the whole
// account: turn dialing back ON in order to turn it off.
//
// The line is what a control does to dialing VOLUME, not what it is.
// ===========================================================================
describe('lifecycle controls vs. the dialer flag', () => {
  beforeEach(() => { flags.isEnabled.mockResolvedValue(false); });

  it('STOP works with the dialer flag off — this is the off button', async () => {
    campaigns.findById.mockResolvedValue({ ...DRAFT, status: 'running' });
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/stop', headers: HEADERS });

    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    // `draft` is deliberately NOT a source — see the draft case below.
    expect(campaigns.transitionStatus).toHaveBeenCalledWith(
      'camp-1', ['running', 'paused'], 'stopping', {},
    );
  });

  it('REFUSES to stop a `draft` — stopping one bricks it permanently', async () => {
    // ── "Reduces dialing" is necessary and NOT sufficient ─────────────────────
    // A draft dials nothing, so it passed the old ungating rationale. But
    // `stopping` is left only by `maybeFinalize`, which returns early while
    // `countOutstanding > 0` — and every row of an un-started draft's roster is
    // outstanding. A 50k-row draft therefore answered 200 and parked in `stopping`
    // forever: `/start` refuses that status, and with the flag off create/PATCH/read
    // are all gated, so there is no route back without a DBA.
    campaigns.findById.mockResolvedValue({ ...DRAFT, status: 'draft' });
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/stop', headers: HEADERS });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('invalid_campaign_transition');
    expect(res.json().current_status).toBe('draft');
    expect(campaigns.transitionStatus).not.toHaveBeenCalled();
  });

  it('still stops a `paused` campaign with the flag off — that state IS recoverable', async () => {
    campaigns.findById.mockResolvedValue({ ...DRAFT, status: 'paused' });
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/stop', headers: HEADERS });

    expect(res.statusCode).toBe(200);
  });

  it('PAUSE works with the dialer flag off — it can only reduce dialing', async () => {
    campaigns.findById.mockResolvedValue({ ...DRAFT, status: 'running' });
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/pause', headers: HEADERS });

    expect(res.statusCode).toBe(200);
  });

  it('START still 403s with the flag off — it would begin dialing for a disabled tenant', async () => {
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/start', headers: HEADERS });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('feature_disabled');
    expect(campaigns.transitionStatus).not.toHaveBeenCalled();
  });

  it('RESUME still 403s with the flag off, for the same reason as start', async () => {
    campaigns.findById.mockResolvedValue({ ...DRAFT, status: 'paused' });
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/resume', headers: HEADERS });

    expect(res.statusCode).toBe(403);
    expect(campaigns.transitionStatus).not.toHaveBeenCalled();
  });

  it('still scopes an ungated stop to the caller — no flag, no ownership bypass', async () => {
    // The gate is a FEATURE check, never the tenancy check. Removing it must not
    // turn `/stop` into a route that can reach another tenant's campaign.
    campaigns.findById.mockResolvedValue({ ...DRAFT, tenant_id: 'other-tenant', status: 'running' });
    const app = await makeApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns/camp-1/stop', headers: HEADERS });

    expect(res.statusCode).toBe(404);
    expect(campaigns.transitionStatus).not.toHaveBeenCalled();
  });
});
