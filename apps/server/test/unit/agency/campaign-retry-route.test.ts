import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

/*
 * PORT NOTE (magick-agency, Phase 8): ported from core test/unit/agency/campaign-retry-route.test.ts@4850d1d9.
 * Mock paths re-pointed only (logger → a partial `@magick-agency/observability` mock;
 * announcement / call / account-settings / profile repositories → `@magick-agency/db/repositories/*`;
 * leaf modules → `@magick-agency/domain/*`; `contracts.js` → `@magick-agency/contracts/agency`).
 * Cases verbatim unless noted here.
 */

// ---------------------------------------------------------------------------
// The three retry routes — wire contract §2.
//
// What is pinned here is the REFUSAL SURFACE, because that is the half three
// repos implement against independently: master allow-lists the three `409`
// codes in its error mask, and a code core emits that master has not mirrored is
// rewritten into "contact support and quote this request id" — status intact,
// explanation destroyed, nothing red anywhere (`agency.md` §6.2). So the codes
// themselves are asserted as strings, not merely the statuses.
//
// The second thing pinned is that a retry create refuses every body `POST /`
// would refuse. Config is INHERITED, so the create route has no body to validate
// for most fields — which is exactly how a validated create surface acquires an
// unvalidated twin.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: { vobiz: { webhookBaseUrl: 'https://core.test/api/v1/webhooks/vobiz' } },
  },
}));

vi.mock('../../../src/api/middleware/auth.middleware.js', () => ({
  authMiddleware: vi.fn(async () => { /* authenticated */ }),
  getTenantId: () => 't1',
  getAccountId: () => 'a1',
  getOriginator: () => 'console',
}));

const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { default: false } },
}));

const { audit } = vi.hoisted(() => ({ audit: { log: vi.fn() } }));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: audit }));

const { campaigns, announcementRepo, preflight } = vi.hoisted(() => ({
  campaigns: {
    findById: vi.fn(),
    retryPreview: vi.fn(),
    retryFromCampaign: vi.fn(),
    campaignLineage: vi.fn(),
  },
  announcementRepo: { findActiveByIdScoped: vi.fn() },
  preflight: { preflightAnalysisProfile: vi.fn().mockResolvedValue(null) },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: announcementRepo,
}));
vi.mock('../../../src/analysis/profile-preflight.js', () => preflight);

import { agencyCampaignRoutes } from '../../../src/api/routes/agency-campaigns.routes.js';
import { RETRY_MAX_GENERATION, RETRY_MAX_SEED_ROWS } from '@magick-agency/domain/retry-campaign-bounds';

const HEALTH_DEPS = {
  runtime: { dnc: { appliedVersion: async () => 1 }, stations: { connectedBySession: async () => new Map() } },
  callManager: {
    accountConcurrencyGuard: { getDistributedAccountCount: async () => ({ status: 'unavailable' as const }) },
  },
} as unknown as Parameters<typeof agencyCampaignRoutes>[1];

const HEADERS = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };

const PARENT = {
  id: 'camp-parent', tenant_id: 't1', account_id: 'a1', name: 'Q3 Winback',
  caller_ids: ['+14155550100'], telephony_provider: 'vobiz', sip_connection_id: null,
  calling_window_start: '09:00:00', calling_window_end: '20:00:00',
  calling_days: [1, 2, 3, 4, 5], default_timezone: 'UTC',
  wrapup_seconds: 30, wrapup_auto_return: true,
  retry_policy: {}, disposition_catalog: [{ code: 'not_interested', label: 'Not Interested' }],
  context_display: {}, break_reasons: [],
  record_calls: false, analysis_profile_id: null, abandon_announcement_id: null,
  abandonment_ceiling_pct: 3,
  status: 'completed', contacts_total: 4000,
  parent_campaign_id: null, root_campaign_id: null, retry_generation: 0, retry_selector: null,
};

const CHILD = { ...PARENT, id: 'camp-child', name: 'Q3 Winback — Retry 1', status: 'draft', contacts_total: 812, parent_campaign_id: 'camp-parent', root_campaign_id: 'camp-parent', retry_generation: 1 };

async function makeApp() {
  const app = Fastify();
  await app.register((a) => agencyCampaignRoutes(a as never, HEALTH_DEPS), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
  return app;
}

async function postRetry(body: unknown, id = 'camp-parent') {
  const app = await makeApp();
  return app.inject({
    method: 'POST', url: `/api/v1/agency-campaigns/${id}/retry`, headers: HEADERS, payload: body as never,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  campaigns.findById.mockResolvedValue(PARENT);
  campaigns.retryFromCampaign.mockResolvedValue({
    status: 'created', campaign: CHILD, contacts_seeded: 812, duplicates_collapsed: 0,
    excluded: { dnc: 14, invalid: 3 },
  });
  campaigns.retryPreview.mockResolvedValue({
    matched: 812, by_last_outcome: { no_answer: 812 }, by_last_disposition: { __none__: 812 },
    excluded: { dnc: 14, invalid: 3 }, parent_contacts_total: 4000,
    retry_generation: 1, max_seed_rows: RETRY_MAX_SEED_ROWS,
  });
  campaigns.campaignLineage.mockResolvedValue({
    root_campaign_id: 'camp-parent',
    campaigns: [
      { id: 'camp-parent', name: 'Q3 Winback', status: 'completed', retry_generation: 0, parent_campaign_id: null, contacts_total: 4000, created_at: '2026-08-01T00:00:00.000Z', started_at: null, ended_at: null },
      { id: 'camp-child', name: 'Q3 Winback — Retry 1', status: 'draft', retry_generation: 1, parent_campaign_id: 'camp-parent', contacts_total: 812, created_at: '2026-08-20T00:00:00.000Z', started_at: null, ended_at: null },
    ],
  });
  announcementRepo.findActiveByIdScoped.mockResolvedValue({ id: 'ann-1' });
  preflight.preflightAnalysisProfile.mockResolvedValue(null);
});

// ── The three routes are gated and scoped like every other campaign route ──

describe('auth, the feature gate and tenant scoping', () => {
  it.each([
    ['GET', '/api/v1/agency-campaigns/camp-parent/retry/preview'],
    ['POST', '/api/v1/agency-campaigns/camp-parent/retry'],
    ['GET', '/api/v1/agency-campaigns/camp-parent/lineage'],
  ])('%s %s is behind the dialer flag', async (method, url) => {
    // A create route that writes a DIALABLE ROSTER must not be reachable for a
    // tenant the platform believes has no dialer — and none of the reasoning that
    // ungates `/stop` and `/pause` applies, since a retry increases dialing.
    flags.isEnabled.mockResolvedValue(false);
    const app = await makeApp();
    const res = await app.inject({ method: method as 'GET', url, headers: HEADERS, payload: {} as never });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('feature_disabled');
  });

  it.each([
    ['GET', '/api/v1/agency-campaigns/other/retry/preview'],
    ['POST', '/api/v1/agency-campaigns/other/retry'],
    ['GET', '/api/v1/agency-campaigns/other/lineage'],
  ])('%s %s 404s a campaign belonging to another account', async (method, url) => {
    campaigns.findById.mockResolvedValue({ ...PARENT, account_id: 'a2' });
    const app = await makeApp();
    const res = await app.inject({ method: method as 'GET', url, headers: HEADERS, payload: {} as never });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('campaign_not_found');
    expect(campaigns.retryFromCampaign).not.toHaveBeenCalled();
  });
});

// ── §1's refusals, reaching the wire as field-level `details` ──────────────

describe('selector refusals arrive as 400 with field-level details', () => {
  // Field-level `details` is what makes master's error mask pass these through
  // untouched — the mask rewrites a 4xx carrying neither `details` nor an
  // allow-listed `code`, so a selector refusal without them would reach the
  // supervisor as "contact support and quote this request id".
  const CASES: Array<[string, Record<string, unknown>, string]> = [
    ['no dimension at all', {}, 'selector'],
    ['a DNC suppression', { suppressed_reason: ['dnc'] }, 'suppressed_reason'],
    ['an invalid suppression', { suppressed_reason: ['invalid'] }, 'suppressed_reason'],
    ['an unknown disposition', { last_disposition: ['nope'] }, 'last_disposition'],
    ['a phone filter', { state: ['pending'], phone: '+1415' }, 'phone'],
    ['a created_at bound', { state: ['pending'], from: '2026-01-01' }, 'from'],
    ['never_attempted with a lower bound', { never_attempted: true, attempt_count_gte: 2 }, 'never_attempted'],
    ['an inverted range', { attempt_count_gte: 5, attempt_count_lte: 1 }, 'attempt_count_gte'],
    ['an unknown state', { state: ['finished'] }, 'state'],
    ['an unknown outcome', { last_outcome: ['connceted'] }, 'last_outcome'],
  ];

  it.each(CASES)('refuses %s on the create', async (_label, selector, field) => {
    const res = await postRetry({ selector });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.map((d: { param: string }) => d.param)).toContain(field);
    expect(campaigns.retryFromCampaign).not.toHaveBeenCalled();
  });

  it.each(CASES)('refuses %s on the preview, identically', async (_label, selector, field) => {
    // The preview and the create must refuse the same things or a supervisor gets
    // a count for a selection the create then rejects.
    const app = await makeApp();
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(selector)) {
      for (const entry of Array.isArray(value) ? value : [value]) query.append(key, String(entry));
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/agency-campaigns/camp-parent/retry/preview?${query.toString()}`,
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.map((d: { param: string }) => d.param)).toContain(field);
    expect(campaigns.retryPreview).not.toHaveBeenCalled();
  });

  it('refuses a selector that is not an object', async () => {
    const res = await postRetry({ selector: ['pending'] });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toHaveProperty('selector');
  });

  it('validates last_disposition against the PARENT\'s catalog', async () => {
    // Not the child's — the child does not exist yet, and the selector is about
    // what the parent's agents recorded.
    const res = await postRetry({ selector: { last_disposition: ['not_interested'] } });
    expect(res.statusCode).toBe(201);
  });
});

// ── The three `409` codes master must allow-list ───────────────────────────

describe('the 409 refusals carry a code, because that is all master forwards', () => {
  it('retry_generation_exceeded, checked before the body is read at all', async () => {
    campaigns.findById.mockResolvedValue({ ...PARENT, retry_generation: RETRY_MAX_GENERATION });
    const res = await postRetry({ selector: { state: ['pending'] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('retry_generation_exceeded');
    expect(campaigns.retryFromCampaign).not.toHaveBeenCalled();
  });

  it('allows generation 9 → 10 and refuses 10 → 11', async () => {
    // The bound is on the PARENT, so the deepest campaign that can exist is
    // generation 10 and it cannot itself be retried.
    campaigns.findById.mockResolvedValue({ ...PARENT, retry_generation: RETRY_MAX_GENERATION - 1 });
    expect((await postRetry({ selector: { state: ['pending'] } })).statusCode).toBe(201);
    campaigns.findById.mockResolvedValue({ ...PARENT, retry_generation: RETRY_MAX_GENERATION });
    expect((await postRetry({ selector: { state: ['pending'] } })).statusCode).toBe(409);
  });

  it('retry_selection_empty, and it names the DNC exclusions when there were any', async () => {
    // A supervisor who selected "everything suppressed" and matched nothing needs
    // to be told the rows were there and were excluded, or the campaign looks
    // empty when it is not.
    campaigns.retryFromCampaign.mockResolvedValue({ status: 'empty', excluded: { dnc: 14, invalid: 3 } });
    const res = await postRetry({ selector: { state: ['suppressed'] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('retry_selection_empty');
    expect(res.json().message).toContain('14');
    expect(res.json().message).toContain('DNC');
  });

  it('retry_selection_empty with no exclusions says only that the selection was empty', async () => {
    campaigns.retryFromCampaign.mockResolvedValue({ status: 'empty', excluded: { dnc: 0, invalid: 0 } });
    const res = await postRetry({ selector: { last_outcome: ['connected'] } });
    expect(res.json().code).toBe('retry_selection_empty');
    expect(res.json().message).not.toContain('DNC');
  });

  it('retry_selection_too_large, naming both the count and the cap', async () => {
    campaigns.retryFromCampaign.mockResolvedValue({ status: 'too_large', matched: 300_000 });
    const res = await postRetry({ selector: { state: ['pending'] } });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('retry_selection_too_large');
    expect(res.json().message).toContain('300000');
    expect(res.json().message).toContain(String(RETRY_MAX_SEED_ROWS));
  });

  it('writes NO audit row for any of the three refusals', async () => {
    // Nothing was created, so nothing happened. An audit row here would report a
    // campaign that does not exist.
    campaigns.retryFromCampaign.mockResolvedValue({ status: 'empty', excluded: { dnc: 0, invalid: 0 } });
    await postRetry({ selector: { state: ['pending'] } });
    expect(audit.log).not.toHaveBeenCalled();
  });
});

// ── Config inheritance and the overrides (DR-10) ───────────────────────────

describe('config is inherited from the parent, then patched', () => {
  it('passes every inherited column through when no override is sent', async () => {
    await postRetry({ selector: { state: ['pending'] } });
    const [{ config }] = campaigns.retryFromCampaign.mock.calls[0]!;
    expect(config).toMatchObject({
      caller_ids: PARENT.caller_ids,
      telephony_provider: 'vobiz',
      calling_window_start: '09:00:00',
      calling_days: [1, 2, 3, 4, 5],
      wrapup_seconds: 30,
      abandonment_ceiling_pct: 3,
      break_reasons: [],
    });
  });

  it('applies config_overrides on top', async () => {
    await postRetry({
      selector: { state: ['pending'] },
      config_overrides: { caller_ids: [' +14155550199 '], calling_window_end: '18:00' },
    });
    const [{ config }] = campaigns.retryFromCampaign.mock.calls[0]!;
    // Trimmed, like `POST /` and `PATCH` do — a whitespace-only entry is the same
    // defect as an empty one and arrives from the same place.
    expect(config.caller_ids).toEqual(['+14155550199']);
    expect(config.calling_window_end).toBe('18:00');
    expect(config.calling_window_start).toBe('09:00:00');
  });

  it('refuses an unknown override key BY NAME rather than dropping it', async () => {
    // Silently ignoring one produces a campaign configured differently from what
    // the operator asked for, with a 201 saying it worked — and adjusting the
    // caller IDs or the window is the entire point of the overrides.
    const res = await postRetry({
      selector: { state: ['pending'] },
      config_overrides: { status: 'running', contacts_total: 5 },
    });
    expect(res.statusCode).toBe(400);
    expect(Object.keys(res.json().details).sort()).toEqual(['contacts_total', 'status']);
  });

  it('refuses an override the create route would refuse — an empty caller-ID pool', async () => {
    const res = await postRetry({
      selector: { state: ['pending'] }, config_overrides: { caller_ids: [''] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toHaveProperty('caller_ids');
  });

  it('refuses a one-sided window override that collapses the effective window', async () => {
    // The rule is evaluated against the STORED PARENT as the base, so a one-sided
    // override is checked against the EFFECTIVE result rather than against nothing:
    // `{ calling_window_start: '20:00' }` alone equals the parent's stored end and
    // produces a campaign that can never dial. Validating the override in isolation
    // sees nothing wrong. Same helper and same idiom as `PATCH`, so the two cannot
    // drift — and note a WRAPPING window (22:00 → 06:00) is legal and is
    // deliberately not caught.
    const res = await postRetry({
      selector: { state: ['pending'] }, config_overrides: { calling_window_start: '20:00' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toHaveProperty('calling_window_end');
    expect(campaigns.retryFromCampaign).not.toHaveBeenCalled();
  });

  it('refuses an override the create route would refuse — a bad retry policy', async () => {
    const res = await postRetry({
      selector: { state: ['pending'] },
      config_overrides: { retry_policy: { machine: { max_attempts: 2 } } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('validates an OVERRIDDEN announcement and analysis profile, guarded on presence', async () => {
    announcementRepo.findActiveByIdScoped.mockResolvedValue(null);
    const refused = await postRetry({
      selector: { state: ['pending'] }, config_overrides: { abandon_announcement_id: 'ann-gone' },
    });
    expect(refused.statusCode).toBe(404);
    expect(refused.json().code).toBe('announcement_not_found');

    // …and a request that does not MENTION the announcement is unaffected, even
    // though the parent names one. Re-validating an inherited value would make a
    // retry refusable for a reason that has nothing to do with the retry, with no
    // affordance in the dialog to clear it; master's capability assertion over the
    // merged config is the layer that owns that question.
    campaigns.findById.mockResolvedValue({ ...PARENT, abandon_announcement_id: 'ann-gone' });
    const allowed = await postRetry({ selector: { state: ['pending'] } });
    expect(allowed.statusCode).toBe(201);
    expect(announcementRepo.findActiveByIdScoped).toHaveBeenCalledTimes(1);
  });

  it('does not preflight an inherited analysis profile', async () => {
    campaigns.findById.mockResolvedValue({ ...PARENT, analysis_profile_id: 'prof-1' });
    const res = await postRetry({ selector: { state: ['pending'] } });
    expect(res.statusCode).toBe(201);
    expect(preflight.preflightAnalysisProfile).not.toHaveBeenCalled();
  });
});

// ── The name, the actor and the audit row ──────────────────────────────────

describe('naming, attribution and the trail', () => {
  it('defaults the name to `<parent> — Retry <n>`', async () => {
    await postRetry({ selector: { state: ['pending'] } });
    expect(campaigns.retryFromCampaign.mock.calls[0]![0].name).toBe('Q3 Winback — Retry 1');
  });

  it('numbers the default name by the CHILD\'s generation', async () => {
    campaigns.findById.mockResolvedValue({ ...PARENT, name: 'Q3 Winback — Retry 2', retry_generation: 2 });
    await postRetry({ selector: { state: ['pending'] } });
    expect(campaigns.retryFromCampaign.mock.calls[0]![0].name).toBe('Q3 Winback — Retry 2 — Retry 3');
  });

  it('clips the generated name to the column rather than letting Postgres raise 22001', async () => {
    // `agency_campaigns.name` is VARCHAR(255) and a parent name can already fill
    // it, so the suffix comes out of the parent's share. A `22001` here would fail
    // the create over a name the operator never typed.
    campaigns.findById.mockResolvedValue({ ...PARENT, name: 'x'.repeat(255) });
    await postRetry({ selector: { state: ['pending'] } });
    const { name } = campaigns.retryFromCampaign.mock.calls[0]![0];
    expect(name.length).toBeLessThanOrEqual(255);
    expect(name.endsWith(' — Retry 1')).toBe(true);
  });

  it('takes an explicit name over the default', async () => {
    await postRetry({ selector: { state: ['pending'] }, name: '  Winter push  ' });
    expect(campaigns.retryFromCampaign.mock.calls[0]![0].name).toBe('Winter push');
  });

  it('records the actor on the audit row, not in created_by', async () => {
    // `created_by` holds an origination LABEL (a client hint) for every other
    // campaign in the table and would change meaning if it held a user id here.
    await postRetry({
      selector: { state: ['pending'] }, agent_user_id: 'usr_123', actor_name: 'Priya S',
    });
    expect(campaigns.retryFromCampaign.mock.calls[0]![0].createdBy).toBe('console');
    expect(audit.log).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'agency_campaign.created',
      eventCategory: 'call',
      severity: 'info',
      eventData: expect.objectContaining({
        campaign_id: 'camp-child',
        name: 'Q3 Winback — Retry 1',
        parent_campaign_id: 'camp-parent',
        retry_generation: 1,
        contacts_seeded: 812,
        actor_user_id: 'usr_123',
        actor_name: 'Priya S',
      }),
    }));
  });

  it('records a duplicate collapse on the trail ONLY when one happened', async () => {
    // A `duplicates_collapsed: 0` on every row is noise in a trail read by eye;
    // a non-zero one is the explanation for a roster smaller than the preview.
    campaigns.retryFromCampaign.mockResolvedValue({
      status: 'created', campaign: CHILD, contacts_seeded: 809, duplicates_collapsed: 3,
      excluded: { dnc: 14, invalid: 3 },
    });
    const res = await postRetry({ selector: { state: ['pending'] } });
    expect(res.json().duplicates_collapsed).toBe(3);
    expect(audit.log.mock.calls[0]![0].eventData).toMatchObject({ duplicates_collapsed: 3 });
  });

  it('leaves a zero collapse OFF the trail', async () => {
    await postRetry({ selector: { state: ['pending'] } });
    expect(audit.log.mock.calls[0]![0].eventData).not.toHaveProperty('duplicates_collapsed');
  });

  it('creates the campaign anyway when no actor was supplied', async () => {
    // Core's API answers a tenant API key directly, and `POST /` records no actor
    // at all — refusing here would make the feature unreachable for every caller
    // that has not been upgraded. Same argument as `readTransitionActor`'s.
    const res = await postRetry({ selector: { state: ['pending'] } });
    expect(res.statusCode).toBe(201);
    expect(audit.log.mock.calls[0]![0].eventData).not.toHaveProperty('actor_user_id');
  });

  it('drops an over-long actor id rather than truncating it into a different human', async () => {
    await postRetry({ selector: { state: ['pending'] }, agent_user_id: 'u'.repeat(101) });
    expect(audit.log.mock.calls[0]![0].eventData).not.toHaveProperty('actor_user_id');
  });
});

// ── The success payload and the lineage read ───────────────────────────────

describe('the 201 and the lineage strip', () => {
  it('serves the CHILD with its seeded count and the exclusions', async () => {
    const res = await postRetry({ selector: { last_outcome: ['no_answer'] } });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.campaign.id).toBe('camp-child');
    // DR-9: creation and starting stay separate verbs, and it side-steps
    // `uq_agency_campaign_running` at creation time.
    expect(body.campaign.status).toBe('draft');
    expect(body.campaign.retry_generation).toBe(1);
    expect(body.campaign.parent_campaign_id).toBe('camp-parent');
    expect(body.contacts_seeded).toBe(812);
    expect(body.excluded).toEqual({ dnc: 14, invalid: 3 });
    // Normally 0, and served anyway: the preview's `matched` is a promise about
    // this commit, so a roster that came in short must arrive with its reason
    // attached rather than as a smaller number the supervisor has to interpret.
    expect(body.duplicates_collapsed).toBe(0);
    // Folded by the shared formatter, like every other campaign payload.
    expect(body.campaign).toHaveProperty('last_transition_by');
  });

  it('serves the preview verbatim, including the cap the console must not hardcode', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/agency-campaigns/camp-parent/retry/preview?last_outcome=no_answer,busy',
      headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ matched: 812, max_seed_rows: RETRY_MAX_SEED_ROWS, retry_generation: 1 });
    expect(campaigns.retryPreview).toHaveBeenCalledWith(
      'camp-parent', { last_outcome: ['no_answer', 'busy'] },
    );
  });

  it('serves a lineage of one for a campaign in no chain, not a 404', async () => {
    campaigns.campaignLineage.mockResolvedValue({
      root_campaign_id: 'camp-parent',
      campaigns: [{ id: 'camp-parent', name: 'Q3 Winback', status: 'completed', retry_generation: 0, parent_campaign_id: null, contacts_total: 4000, created_at: '2026-08-01T00:00:00.000Z', started_at: null, ended_at: null }],
    });
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agency-campaigns/camp-parent/lineage', headers: HEADERS,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().campaigns).toHaveLength(1);
    expect(campaigns.campaignLineage).toHaveBeenCalledWith('t1', 'a1', 'camp-parent');
  });

  it('404s the lineage only when the campaign vanished between the two reads', async () => {
    campaigns.campaignLineage.mockResolvedValue(null);
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agency-campaigns/camp-parent/lineage', headers: HEADERS,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('campaign_not_found');
  });
});

// ── Route precedence ───────────────────────────────────────────────────────

describe('route precedence against the campaign routes that already existed', () => {
  it('/:id/retry/preview and /:id/retry reach different handlers', async () => {
    // MAG-106 in this repository was an assertion that passed vacuously against a
    // route that did not exist; a 404 and a wrong-handler 200 are both invisible to
    // a status assertion on the sibling. Both directions are pinned.
    const app = await makeApp();
    const preview = await app.inject({
      method: 'GET', url: '/api/v1/agency-campaigns/camp-parent/retry/preview', headers: HEADERS,
    });
    // No selector ⇒ the parser's refusal, which proves the PREVIEW handler ran.
    expect(preview.statusCode).toBe(400);
    expect(preview.json().details[0].param).toBe('selector');
    expect(campaigns.retryFromCampaign).not.toHaveBeenCalled();

    const created = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns/camp-parent/retry', headers: HEADERS,
      payload: { selector: { state: ['pending'] } },
    });
    expect(created.statusCode).toBe(201);
  });

  it('/:id/lineage does not shadow /:id/stats', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'GET', url: '/api/v1/agency-campaigns/camp-parent/lineage', headers: HEADERS,
    });
    expect(res.statusCode).not.toBe(404);
    expect(campaigns.campaignLineage).toHaveBeenCalled();
  });
});
