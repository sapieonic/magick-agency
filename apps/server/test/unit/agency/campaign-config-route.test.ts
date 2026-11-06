import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ---------------------------------------------------------------------------
// Campaign config is validated at the internal handler's boundary.
//
// The public API layer's validator (`agency-campaign-config.ts`) runs on the
// proxy path only, and the internal handler answers a tenant API key without
// traversing it — so every rule it applies would be bypassable on its own. The
// invariants are CONSUMED by the retry engine and the calling-hours gate, so
// they have to hold here.
//
// ── WHY THE CASE TABLE, AND WHAT IT CAN HONESTLY CLAIM ──────────────────────
//
// The two validators must agree on every case. The pairing is carried by RULES
// below: one row per rule in `src/agency/agency-campaign-config.ts`, each naming
// the public-API-layer rule it pairs with and the decision BOTH validators are
// expected to reach.
//
// That is a real pairing and it is also the honest limit: it pins this validator
// against the other as that one was read on 2026-08-11, not as it is at any later
// moment. A change to the other validator does not red this file. A genuine
// guard would be a shared fixture both suites consume, which does not exist.
//
// The three DELIBERATE divergences are tested as divergences at the bottom, so
// they are a recorded decision rather than a gap someone later discovers.
// ---------------------------------------------------------------------------

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: { vobiz: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/vobiz' } },
  },
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

const { campaigns, announcementRepo, callerIds } = vi.hoisted(() => ({
  campaigns: { create: vi.fn(), update: vi.fn(), updateLocked: vi.fn(), findById: vi.fn() },
  announcementRepo: { findActiveByIdScoped: vi.fn() },
  callerIds: { mapForCampaign: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
  agencyAgentCallerIdRepository: callerIds,
}));
vi.mock('@magick-agency/db/repositories/announcement.repository', () => ({
  announcementRepository: announcementRepo,
}));

import { agencyCampaignRoutes } from '../../../src/api/routes/agency-campaigns.routes.js';

/**
 * This plugin takes dependencies, for the stats route's health strip
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

/** Stored campaign. The window matters: PATCH validates the MERGED result. */
const CAMPAIGN_ROW = {
  id: 'camp-1', tenant_id: 't1', account_id: 'a1', name: 'Q3 Renewals',
  caller_ids: ['+14155550100'], abandon_announcement_id: null, status: 'draft',
  calling_window_start: '09:00:00', calling_window_end: '20:00:00',
  calling_days: [1, 2, 3, 4, 5], default_timezone: 'UTC',
};

/** The minimum a create needs, so a case row carries only the field under test. */
const MINIMAL = { name: 'Q3', caller_ids: ['+14155550100'] };

async function makeApp() {
  const app = Fastify();
  await app.register((a) => agencyCampaignRoutes(a as never, HEALTH_DEPS), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
  return app;
}

const TX_CLIENT = { query: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  campaigns.findById.mockResolvedValue(CAMPAIGN_ROW);
  callerIds.mapForCampaign.mockResolvedValue(new Map());
  campaigns.create.mockImplementation(async (i: any) => ({ ...CAMPAIGN_ROW, ...i }));
  campaigns.update.mockImplementation(async (_id: string, p: any) => ({ ...CAMPAIGN_ROW, ...p }));
  // The locked write (a PATCH with caller_ids): the refusal asked of the stored row, then the
  // same write `update` stands for here, so the assertions on `update` hold for both paths.
  campaigns.updateLocked.mockImplementation(async (id: string, p: any, refuse: (row: any, client: unknown) => Promise<unknown>) => {
    const refused = await refuse(await campaigns.findById(id), TX_CLIENT);
    return refused !== null ? { refused } : { row: await campaigns.update(id, p) };
  });
  announcementRepo.findActiveByIdScoped.mockResolvedValue({ id: 'ann-1', tenant_id: 't1', account_id: 'a1' });
});

// ===========================================================================
// The paired rule table — criteria (a) and (b)
//
// FALSIFICATION: reverting `agency-campaigns.routes.ts` to pass the body
// straight to the repository (i.e. deleting the `configRejected` call from
// POST) reds every `reject` row — 21 of them — and no `accept` row. Confirmed
// by md5 before and after.
// ===========================================================================
interface Case {
  /** What the rule is, and the public-API-layer rule it pairs with. */
  name: string;
  body: Record<string, unknown>;
  /** null ⇒ both validators accept. Otherwise the field both must flag. */
  rejectField: string | null;
}

const RULES: Case[] = [
  // ── calling_days: ISO-8601, 0 refused ────────────────────────────────────
  {
    name: 'calling_days 0 is REFUSED, not read as Sunday (both validators: same)',
    body: { calling_days: [0, 1, 2] },
    rejectField: 'calling_days[0]',
  },
  {
    name: 'calling_days 8 is out of range',
    body: { calling_days: [1, 8] },
    rejectField: 'calling_days[1]',
  },
  { name: 'calling_days 7 (Sunday) is valid', body: { calling_days: [6, 7] }, rejectField: null },
  {
    name: 'an EMPTY calling_days is refused — the campaign could never dial',
    body: { calling_days: [] },
    rejectField: 'calling_days',
  },
  {
    name: 'calling_days must be an array',
    body: { calling_days: 'mon-fri' },
    rejectField: 'calling_days',
  },
  {
    name: 'a non-integer day is refused',
    body: { calling_days: [1.5] },
    rejectField: 'calling_days[0]',
  },

  // ── default_timezone ─────────────────────────────────────────────────────
  {
    name: "'EST' is refused — ICU resolves it to a zone with no DST",
    body: { default_timezone: 'EST' },
    rejectField: 'default_timezone',
  },
  { name: "'IST' is refused for the same reason", body: { default_timezone: 'IST' }, rejectField: 'default_timezone' },
  { name: "'Made/Up' is refused — passes the shape gate, fails Intl", body: { default_timezone: 'Made/Up' }, rejectField: 'default_timezone' },
  { name: "'America/New_York' is valid", body: { default_timezone: 'America/New_York' }, rejectField: null },
  { name: "'Asia/Kolkata' is valid", body: { default_timezone: 'Asia/Kolkata' }, rejectField: null },
  { name: "exactly 'UTC' is valid", body: { default_timezone: 'UTC' }, rejectField: null },
  { name: 'an empty timezone is refused', body: { default_timezone: '' }, rejectField: 'default_timezone' },
  { name: 'a non-string timezone is refused', body: { default_timezone: 42 }, rejectField: 'default_timezone' },

  // ── calling window ───────────────────────────────────────────────────────
  {
    name: 'start == end is refused — the voice engine reads it as "no opening exists"',
    body: { calling_window_start: '09:00', calling_window_end: '09:00' },
    rejectField: 'calling_window_end',
  },
  {
    name: "start == end across the HH:MM / HH:MM:SS spelling is still refused",
    body: { calling_window_start: '09:00', calling_window_end: '09:00:00' },
    rejectField: 'calling_window_end',
  },
  {
    name: 'a window WRAPPING midnight is valid and must not be caught',
    body: { calling_window_start: '22:00', calling_window_end: '06:00' },
    rejectField: null,
  },
  {
    name: 'a malformed time is refused before Postgres 22007s',
    body: { calling_window_start: '25:00' },
    rejectField: 'calling_window_start',
  },
  {
    name: 'HH:MM:SS is accepted — it is how Postgres renders the column back',
    body: { calling_window_start: '09:00:00', calling_window_end: '20:00:00' },
    rejectField: null,
  },

  // ── retry_policy ─────────────────────────────────────────────────────────
  {
    name: "'machine' is refused — AMD is off, so the rule could never fire",
    body: { retry_policy: { machine: { max_attempts: 2 } } },
    rejectField: 'retry_policy.machine',
  },
  {
    name: "'voicemail' as a retry KEY is refused (it is a disposition, not an outcome)",
    body: { retry_policy: { voicemail: { max_attempts: 2 } } },
    rejectField: 'retry_policy.voicemail',
  },
  {
    name: 'an unknown outcome key is refused',
    body: { retry_policy: { nonsense: { max_attempts: 1 } } },
    rejectField: 'retry_policy.nonsense',
  },
  {
    name: 'max_attempts is REQUIRED whenever a rule is present',
    body: { retry_policy: { no_answer: { delay_minutes: 30 } } },
    rejectField: 'retry_policy.no_answer.max_attempts',
  },
  {
    name: 'max_attempts above 20 is refused',
    body: { retry_policy: { busy: { max_attempts: 21 } } },
    rejectField: 'retry_policy.busy.max_attempts',
  },
  {
    name: 'delay_minutes beyond 30 days is refused',
    body: { retry_policy: { busy: { max_attempts: 2, delay_minutes: 43_201 } } },
    rejectField: 'retry_policy.busy.delay_minutes',
  },
  {
    name: 'an unknown retry field is refused',
    body: { retry_policy: { busy: { max_attempts: 2, backoff: 'exponential' } } },
    rejectField: 'retry_policy.busy.backoff',
  },
  {
    name: 'retry_policy must be an object, not an array',
    body: { retry_policy: [] },
    rejectField: 'retry_policy',
  },
  {
    name: 'a valid policy is accepted',
    body: { retry_policy: { no_answer: { max_attempts: 3, delay_minutes: 60 } } },
    rejectField: null,
  },
  {
    name: 'an EMPTY retry_policy is accepted — it means "the documented defaults"',
    body: { retry_policy: {} },
    rejectField: null,
  },

  // ── disposition_catalog ──────────────────────────────────────────────────
  {
    name: 'a duplicate code is refused — find() is first-wins, silently',
    body: {
      disposition_catalog: [
        { code: 'sale', label: 'Sale' },
        { code: 'sale', label: 'Sale again', terminal: true },
      ],
    },
    rejectField: 'disposition_catalog[1].code',
  },
  {
    name: 'an uppercase code is refused — comparison is byte-for-byte',
    body: { disposition_catalog: [{ code: 'Sale', label: 'Sale' }] },
    rejectField: 'disposition_catalog[0].code',
  },
  {
    name: 'a missing label is refused — it renders an unlabelled button',
    body: { disposition_catalog: [{ code: 'sale' }] },
    rejectField: 'disposition_catalog[0].label',
  },
  {
    name: 'a blank label is refused',
    body: { disposition_catalog: [{ code: 'sale', label: '   ' }] },
    rejectField: 'disposition_catalog[0].label',
  },
  {
    name: 'a non-boolean flag is refused',
    body: { disposition_catalog: [{ code: 'sale', label: 'Sale', suppress: 'yes' }] },
    rejectField: 'disposition_catalog[0].suppress',
  },
  {
    name: 'a catalog retry rule without max_attempts is refused',
    body: { disposition_catalog: [{ code: 'vm', label: 'VM', retry: { delay_minutes: 240 } }] },
    rejectField: 'disposition_catalog[0].retry.max_attempts',
  },
  {
    name: 'disposition_catalog must be an array',
    body: { disposition_catalog: { sale: 'Sale' } },
    rejectField: 'disposition_catalog',
  },
  {
    name: 'a fully-formed catalog entry is accepted',
    body: {
      disposition_catalog: [
        { code: 'do_not_call', label: 'Do not call', suppress: true, terminal: true },
        { code: 'voicemail', label: 'Voicemail', retry: { delay_minutes: 240, max_attempts: 2 } },
      ],
    },
    rejectField: null,
  },
];

describe('POST /agency-campaigns · the internal handler enforces the config rules the public API layer states', () => {
  for (const c of RULES) {
    it(c.name, async () => {
      const app = await makeApp();
      const res = await app.inject({
        method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
        payload: { ...MINIMAL, ...c.body },
      });

      if (c.rejectField === null) {
        expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
        expect(campaigns.create).toHaveBeenCalled();
        return;
      }

      expect(res.statusCode, JSON.stringify(res.json())).toBe(400);
      // The FIELD, not just the status: a 400 that names the wrong field sends an
      // operator to correct something that was never wrong, and a console marks
      // the wrong input.
      expect(Object.keys(res.json().details)).toContain(c.rejectField);
      // Nothing is written. A campaign half-created around a rejected config
      // would leave the operator with a campaign they did not ask for.
      expect(campaigns.create).not.toHaveBeenCalled();
    });
  }
});

// ===========================================================================
// Criterion (c) — the empty catalog stays legal
// ===========================================================================
describe('an empty disposition_catalog is a CONFIGURATION, not a mistake', () => {
  it('accepts an explicit empty catalog', async () => {
    // `requiresDisposition` reads an empty catalog as "no codes to pick, so
    // requiring one is a dead end" — a campaign whose agents do no write-up, with
    // outcome-driven retry still applying. Settled in session 2; a required-codes
    // rule would make that campaign unsaveable.
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { ...MINIMAL, disposition_catalog: [] },
    });

    expect(res.statusCode).toBe(201);
    expect(campaigns.create.mock.calls[0]![0].disposition_catalog).toEqual([]);
  });

  it('does not invent the three "built-in" codes on the internal handler\'s own path', async () => {
    // The internal handler does NOT force-merge built-ins, and must not: the empty catalog above
    // would stop being expressible. The public API layer applies a creation-time default on the
    // proxy path, so a campaign created directly at the handler differs from one created
    // through the wizard — recorded here as intended, not discovered later.
    const app = await makeApp();
    await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { ...MINIMAL, disposition_catalog: [] },
    });
    expect(campaigns.create.mock.calls[0]![0].disposition_catalog).toHaveLength(0);
  });
});

// ===========================================================================
// Criterion (d) — 'EST' rejected WITHOUT relying on Intl throwing
// ===========================================================================
describe("the 'EST' trap", () => {
  it('rejects EST, and the rejection does NOT come from Intl throwing', async () => {
    // The whole point of the rule. If this ever starts passing because `Intl`
    // began throwing, the shape gate could be deleted and nobody would notice —
    // so the test asserts the premise as well as the behaviour.
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: 'EST' })).not.toThrow();
    // And it resolves to something ICU is perfectly happy with.
    expect(
      new Intl.DateTimeFormat('en-US', { timeZone: 'EST' }).resolvedOptions().timeZone,
    ).toBeTruthy();

    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { ...MINIMAL, default_timezone: 'EST' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().details.default_timezone).toMatch(/daylight saving/i);
  });
});

// ===========================================================================
// The DEFAULT path — the retry feature nearly shipped inert on exactly this
//
// The empty/absent config is the ORDINARY case: the public API layer does not send
// `retry_policy`, and every window field has a column default. So the case that
// must not break is "a body carrying no config at all", and the case that must
// not slip through is one where the COLUMN DEFAULT completes a broken window.
// ===========================================================================
describe('the default path', () => {
  it('accepts a create carrying no config fields whatsoever', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: MINIMAL,
    });

    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
    expect(campaigns.create).toHaveBeenCalled();
  });

  it('refuses a window the COLUMN DEFAULT completes into start == end', async () => {
    // The schema defaults `calling_window_end` to '20:00'. A create sending
    // only `calling_window_start: '20:00'` therefore stores 20:00–20:00 — a
    // campaign that can never dial — and a body-only validator sees one
    // well-formed time and nothing to complain about. This is the rule arriving
    // by the default path rather than the configured one.
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { ...MINIMAL, calling_window_start: '20:00' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().details).toHaveProperty('calling_window_end');
    expect(campaigns.create).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// PATCH — config is what an operator edits AFTER the campaign exists
// ===========================================================================
describe('PATCH /agency-campaigns/:id · the same rules, on the merged result', () => {
  it('refuses a patch that makes the STORED window degenerate', async () => {
    // The stored campaign is 09:00–20:00. Patching only the start to 20:00 makes
    // it 20:00–20:00. Validating the body alone sees one valid time; the campaign
    // that results can never dial. The internal handler can merge because it owns the row —
    // the public API layer cannot, by design, which is why enforcement belongs here.
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { calling_window_start: '20:00' },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().details).toHaveProperty('calling_window_end');
    expect(campaigns.update).not.toHaveBeenCalled();
  });

  it('accepts a patch that leaves a usable window', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { calling_window_start: '08:00' },
    });

    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(campaigns.update).toHaveBeenCalledWith('camp-1', { calling_window_start: '08:00' });
  });

  it('refuses calling_days 0 on the patch too, not only on create', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { calling_days: [0] },
    });

    expect(res.statusCode).toBe(400);
    expect(campaigns.update).not.toHaveBeenCalled();
  });

  it('leaves a config-free patch alone', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { name: 'Renamed' },
    });

    expect(res.statusCode).toBe(200);
    expect(campaigns.update).toHaveBeenCalledWith('camp-1', { name: 'Renamed' });
  });
});

// ===========================================================================
// DELIBERATE DIVERGENCES FROM THE PUBLIC API LAYER'S VALIDATOR
//
// Recorded as tests so they are a decision with evidence rather than a gap.
// Each was reached by reading `resolveRetryDecision` — the only consumer of a
// retry-policy key — instead of copying the other validator's list.
// ===========================================================================
describe('divergences from the public API layer\'s validator, each read off the consumer', () => {
  it("ACCEPTS 'orphaned', which the public API layer rejects and which genuinely fires", async () => {
    // `agency-dialer.ts` and `reaper.ts` both write `outcome: 'orphaned'`, and
    // `resolveRetryDecision` looks the key up in the policy. `DEFAULT_RETRY_POLICY`
    // has no entry, so WITHOUT a policy key the answer is `no_policy_for_outcome`
    // and the contact is marked `completed` — a customer retired because our own
    // process restarted. A policy key is the only lever that changes that, so
    // refusing it here would remove the fix rather than enforce a rule.
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { ...MINIMAL, retry_policy: { orphaned: { max_attempts: 2, delay_minutes: 5 } } },
    });

    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
  });

  it("ACCEPTS 'agent_disconnected', which the public API layer rejects and which genuinely fires", async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { ...MINIMAL, retry_policy: { agent_disconnected: { max_attempts: 1 } } },
    });

    expect(res.statusCode, JSON.stringify(res.json())).toBe(201);
  });

  it("REFUSES 'invalid', because suppression happens before any policy is read", async () => {
    // Replaces the case that asserted a 201 here. That test carried the standing
    // instruction "if this test ever starts failing, the paired change has landed
    // — delete the test, do not relax it". That paired change has landed: the public
    // API layer refuses the key and the console stops sending it, so the two
    // validators agree.
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { ...MINIMAL, retry_policy: { invalid: { max_attempts: 3 } } },
    });

    expect(res.statusCode).toBe(400);

    // ⚠️ Status alone is satisfied by absence — a missing route, a mis-typed URL
    // and a body the handler never reached all 400 too. Assert the field path and
    // the reason, which only the retry-policy validator can emit.
    const body = res.json();
    const detail = JSON.stringify(body);
    expect(detail).toContain('retry_policy.invalid');
    expect(detail).toContain('suppressed');
    // And the message must explain WHY rather than just listing valid keys,
    // exactly as the `machine` rule does.
    expect(detail).toContain('does not become good');
  });
});

// ===========================================================================
// `caller_ids` — the one required field the PATCH did not re-check
//
// Not part of `validateAgencyCampaignConfig`'s remit (that validator owns the
// retry/window/disposition invariants), so neither the case table above nor
// the public API layer's paired validator covered it. Create refused an empty pool from day
// one; PATCH accepted one, and the pacing engine then threw mid-tick out of
// `create({ callerId: … })`'s argument list — leaking every agent reservation
// and contact claim the tick had taken.
//
// FALSIFICATION: deleting the `'caller_ids' in body` guard from `patchHandler`
// reds the three `reject` cases here and none of the `accept` ones.
// ===========================================================================
describe('PATCH /:id — caller_ids may not be emptied', () => {
  it('rejects an empty array', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { caller_ids: [] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual({ caller_ids: 'at least one caller ID is required' });
    // And nothing reached the repository — a 400 that still wrote would be worse
    // than no validation at all.
    expect(campaigns.update).not.toHaveBeenCalled();
  });

  it('rejects a non-array, which would store and then fail at dial time', async () => {
    const app = await makeApp();
    for (const value of [null, 'not-an-array', 42]) {
      const res = await app.inject({
        method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
        payload: { caller_ids: value },
      });
      expect(res.statusCode, JSON.stringify(value)).toBe(400);
    }
    expect(campaigns.update).not.toHaveBeenCalled();
  });

  it('mirrors the wording create already uses, so one console string covers both', async () => {
    const app = await makeApp();
    const created = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Q3', caller_ids: [] },
    });
    const patched = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { caller_ids: [] },
    });

    expect(created.json().details.caller_ids).toBe(patched.json().details.caller_ids);
  });

  it('rejects a non-empty array of JUNK — length was never the real check', async () => {
    // `caller_ids: ['']` satisfied "at least one" on both create and PATCH.
    // `pickCallerId` then returns `''`, which is falsy, so the pacing engine takes
    // its no-caller-IDs halt and reports "has no caller IDs" about a campaign that
    // has one — a genuinely confusing thing to hand an operator. `[123]` was stored
    // as-is and reached the dial.
    const app = await makeApp();
    for (const value of [[''], ['  '], [123], [null], ['+14155550100', ''], [{}]]) {
      const res = await app.inject({
        method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
        payload: { caller_ids: value },
      });
      expect(res.statusCode, JSON.stringify(value)).toBe(400);
      expect(res.json().details.caller_ids, JSON.stringify(value))
        .toBe('every caller ID must be a non-empty string');
    }
    expect(campaigns.update).not.toHaveBeenCalled();
  });

  it('applies the SAME element check on create', async () => {
    // One helper behind both, so the two cannot drift — the original defect was
    // create and PATCH disagreeing about what `caller_ids` had to be.
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { name: 'Q3', caller_ids: [''] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().details.caller_ids).toBe('every caller ID must be a non-empty string');
    expect(campaigns.create).not.toHaveBeenCalled();
  });

  it('trims what it stores, so a padded entry cannot become a blank one later', async () => {
    const app = await makeApp();
    await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { caller_ids: ['  +14155550100  '] },
    });

    expect(campaigns.update).toHaveBeenCalledWith('camp-1', { caller_ids: ['+14155550100'] });
  });

  it('accepts a non-empty pool', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { caller_ids: ['+14155550199'] },
    });

    expect(res.statusCode, JSON.stringify(res.json())).toBe(200);
    expect(campaigns.update).toHaveBeenCalledWith('camp-1', { caller_ids: ['+14155550199'] });
  });

  it('leaves a PATCH that does not mention caller_ids alone', async () => {
    // `'caller_ids' in body`, not a truthiness check on the value — a partial
    // update that omits the field must not be read as emptying it.
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { name: 'Renamed' },
    });

    expect(res.statusCode).toBe(200);
    expect(campaigns.update).toHaveBeenCalledWith('camp-1', { name: 'Renamed' });
  });
});

describe('PATCH /:id — a dedicated caller ID cannot be dropped (DN6)', () => {
  const POOL = ['+14155550100', '+14155550101', '+14155550102'];
  beforeEach(() => {
    campaigns.findById.mockResolvedValue({ ...CAMPAIGN_ROW, caller_ids: POOL });
    callerIds.mapForCampaign.mockResolvedValue(new Map([['u1', '+14155550101'], ['u2', '+14155550102']]));
  });

  it('refuses a caller_ids that drops a dedicated number: 409 caller_id_dedicated naming every one, nothing written', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { caller_ids: ['+14155550100'] },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({
      error: 'Conflict', code: 'caller_id_dedicated', message: expect.stringContaining('dedicated to agents'),
      details: { caller_ids: ['+14155550101', '+14155550102'] },
    });
    // Read inside the locked write, on its client (DN6 under the campaign row's lock).
    expect(callerIds.mapForCampaign).toHaveBeenCalledWith('camp-1', TX_CLIENT);
    expect(campaigns.updateLocked).toHaveBeenCalledWith('camp-1', { caller_ids: ['+14155550100'] }, expect.any(Function));
    expect(campaigns.update).not.toHaveBeenCalled();

    const one = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { caller_ids: ['+14155550100', ' +14155550102 '] },
    });
    expect(one.statusCode).toBe(409);
    expect(one.json().details).toEqual({ caller_ids: ['+14155550101'] });
    expect(one.json().message).toBe('+14155550101 is dedicated to an agent on this campaign. Release it from the agent before removing it.');
  });

  it('accepts one that keeps every dedicated number (trimmed), drops an undedicated one, or adds', async () => {
    const app = await makeApp();
    for (const caller_ids of [[' +14155550101', '+14155550102 '], [...POOL, '+14155550199']]) {
      const res = await app.inject({
        method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS, payload: { caller_ids },
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(campaigns.update).toHaveBeenCalledTimes(2);
  });

  it('a dedicated number the campaign no longer has (a direct write) does not block; no read without caller_ids', async () => {
    callerIds.mapForCampaign.mockResolvedValue(new Map([['u1', '+19999999999']]));
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS, payload: { caller_ids: ['+14155550100'] },
    });
    expect(res.statusCode, res.body).toBe(200);
    callerIds.mapForCampaign.mockClear();
    const renamed = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS, payload: { name: 'Renamed' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(callerIds.mapForCampaign).not.toHaveBeenCalled();
    expect(campaigns.updateLocked).toHaveBeenCalledTimes(1);
  });

  it('a malformed caller_ids is still the 400 that names the field, before the dedication read', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS, payload: { caller_ids: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(callerIds.mapForCampaign).not.toHaveBeenCalled();
  });
});

describe('break_reasons at the write', () => {
  it('refuses a catalog listing the soft phone\'s reserved reason, and nothing else about it', async () => {
    const { validateAgencyCampaignConfig: validate } = await import('../../../src/agency/campaign-config.js');
    expect(validate({ break_reasons: [{ code: 'lunch', label: 'Lunch' }, { code: 'soft_phone', label: 'Soft phone' }] }))
      .toEqual([{ field: 'break_reasons', message: expect.stringContaining('reserved for the soft phone') }]);
    expect(validate({ break_reasons: [{ code: 'lunch', label: 'Lunch' }] })).toEqual([]);
    expect(validate({ break_reasons: [] })).toEqual([]);
  });

  it('refuses the mobile app\'s device_away like the soft phone\'s, one issue per reserved code', async () => {
    const { validateAgencyCampaignConfig: validate } = await import('../../../src/agency/campaign-config.js');
    expect(validate({ break_reasons: [{ code: 'device_away', label: 'Away' }] }))
      .toEqual([{ field: 'break_reasons', message: expect.stringContaining('"device_away": it is reserved for the mobile app') }]);
    expect(validate({ break_reasons: [{ code: 'soft_phone', label: 'S' }, { code: 'device_away', label: 'A' }, { code: 'lunch', label: 'L' }] }))
      .toEqual([
        { field: 'break_reasons', message: expect.stringContaining('"soft_phone"') },
        { field: 'break_reasons', message: expect.stringContaining('"device_away"') },
      ]);
    // A malformed entry is not a reserved one (the column's own shape checks own it).
    expect(validate({ break_reasons: [null, 'device_away', { label: 'no code' }] })).toEqual([]);
  });

  it('a PATCH listing device_away is a 400 and writes nothing', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { break_reasons: [{ code: 'device_away', label: 'Away (app in background)' }] },
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('device_away');
    expect(campaigns.update).not.toHaveBeenCalled();
  });
});

describe('allow_wrapup_redial (wrap-up redial, 0008)', () => {
  it('accepts a boolean either way and refuses anything else, null included', async () => {
    const { validateAgencyCampaignConfig: validate } = await import('../../../src/agency/campaign-config.js');
    expect(validate({ allow_wrapup_redial: true })).toEqual([]);
    expect(validate({ allow_wrapup_redial: false })).toEqual([]);
    expect(validate({})).toEqual([]);
    // `null` would reach the NOT NULL column as a 23502; a string or a number would
    // be coerced by Postgres into a setting nobody chose.
    for (const bad of ['yes', 'true', 1, 0, null, {}, []]) {
      expect(validate({ allow_wrapup_redial: bad }), String(bad)).toEqual([
        { field: 'allow_wrapup_redial', message: 'allow_wrapup_redial must be a boolean.' },
      ]);
    }
  });

  it('POST passes it to the repository, and leaves it unset when omitted (the column default is false)', async () => {
    const app = await makeApp();
    const on = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { ...MINIMAL, allow_wrapup_redial: true },
    });
    expect(on.statusCode, on.body).toBe(201);
    expect(campaigns.create.mock.calls[0]![0].allow_wrapup_redial).toBe(true);

    const omitted = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS, payload: MINIMAL,
    });
    expect(omitted.statusCode, omitted.body).toBe(201);
    expect(campaigns.create.mock.calls[1]![0].allow_wrapup_redial).toBeUndefined();
  });

  it('POST refuses a non-boolean and creates nothing', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { ...MINIMAL, allow_wrapup_redial: 'yes' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual({ allow_wrapup_redial: 'allow_wrapup_redial must be a boolean.' });
    expect(campaigns.create).not.toHaveBeenCalled();
  });

  it('PATCH writes it on a RUNNING campaign, like wrapup_auto_return: no status gate', async () => {
    campaigns.findById.mockResolvedValue({ ...CAMPAIGN_ROW, status: 'running' });
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { allow_wrapup_redial: true },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(campaigns.update).toHaveBeenCalledWith('camp-1', { allow_wrapup_redial: true });
    expect(res.json().allow_wrapup_redial).toBe(true);
  });

  it('PATCH refuses null and writes nothing', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { allow_wrapup_redial: null },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toHaveProperty('allow_wrapup_redial');
    expect(campaigns.update).not.toHaveBeenCalled();
  });
});

/**
 * Bodies each contact-assignment rule refuses, with the field it refuses on. Shared by
 * the internal validator's cases below and by the pairing test at the bottom, so the
 * two validators are held to agree on every one.
 */
const ASSIGNMENT_REFUSALS: ReadonlyArray<{ body: Record<string, unknown>; field: string; message: string }> = [
  ...['shared', 'POOL', '', 1, null, true].map((v) => ({
    body: { assignment_mode: v }, field: 'assignment_mode',
    message: 'assignment_mode must be one of: pool, strict, preferred.',
  })),
  ...['pool', 'Keep', null, 0].map((v) => ({
    body: { on_unstaff: v }, field: 'on_unstaff',
    message: 'on_unstaff must be one of: return_to_pool, keep.',
  })),
  ...['return_to_pool', 'never', null].map((v) => ({
    body: { callback_fallback: v }, field: 'callback_fallback',
    message: 'callback_fallback must be one of: pool, wait.',
  })),
  ...[-1, 10081, 1.5, '30', null].map((v) => ({
    body: { callback_owner_grace_minutes: v }, field: 'callback_owner_grace_minutes',
    message: 'callback_owner_grace_minutes must be an integer between 0 and 10080.',
  })),
  ...[0, 11, 2.5, '1', null].map((v) => ({
    body: { agent_retry_rounds: v }, field: 'agent_retry_rounds',
    message: 'agent_retry_rounds must be an integer between 1 and 10.',
  })),
  ...[-1, 10081, 0.5, '30', null].map((v) => ({
    body: { agent_retry_cooldown_minutes: v }, field: 'agent_retry_cooldown_minutes',
    message: 'agent_retry_cooldown_minutes must be an integer between 0 and 10080.',
  })),
  ...['true', 1, 0, null, {}].map((v) => ({
    body: { allow_agent_retry: v }, field: 'allow_agent_retry',
    message: 'allow_agent_retry must be a boolean.',
  })),
];

/** An outcome entry carrying `override`, as the catalog's only entry. */
const withOverride = (override: unknown, entry: Record<string, unknown> = {}) => ({
  disposition_catalog: [{ code: 'promise_to_pay', label: 'Promise to pay', ...entry, override }],
});
const AT = 'disposition_catalog[0].override';

const OVERRIDE_REFUSALS: ReadonlyArray<{ body: Record<string, unknown>; field: string; message: string }> = [
  // DNC is never overridable: there is no key for it, and any key that is not one of
  // the three is refused, whatever it is spelled.
  ...['dnc', 'do_not_call', 'suppress', 'max_attempts'].map((key) => ({
    body: withOverride({ retry_delay: true, [key]: true }), field: `${AT}.${key}`,
    message: `Unknown override field '${key}'. An outcome may grant only extra_attempts, retry_delay and calling_hours; do-not-call is never overridable.`,
  })),
  ...[0, 6, 1.5, '2', null].map((v) => ({
    body: withOverride({ extra_attempts: v }), field: `${AT}.extra_attempts`,
    message: 'extra_attempts must be an integer between 1 and 5.',
  })),
  { body: withOverride({ retry_delay: 'yes' }), field: `${AT}.retry_delay`, message: 'retry_delay must be a boolean.' },
  { body: withOverride({ calling_hours: 1 }), field: `${AT}.calling_hours`, message: 'calling_hours must be a boolean.' },
  ...[{}, { retry_delay: false, calling_hours: false }].map((override) => ({
    body: withOverride(override), field: AT,
    message: 'override must grant at least one of extra_attempts, retry_delay or calling_hours.',
  })),
  ...[null, [], 'retry_delay', true].map((override) => ({
    body: withOverride(override), field: AT, message: 'override must be an object.',
  })),
  {
    body: withOverride({ extra_attempts: 2 }, { suppress: true }), field: AT,
    message: 'An outcome that suppresses the contact cannot grant an override: do-not-call is never overridable.',
  },
  {
    body: withOverride({ retry_delay: true }, { terminal: true }), field: AT,
    message: 'A terminal outcome cannot grant an override: it finishes the contact, so nothing could spend it.',
  },
];

describe('contact assignment settings (0009)', () => {
  it('accepts every vocabulary member, each bound, both booleans and the defaults', async () => {
    const { validateAgencyCampaignConfig: validate } = await import('../../../src/agency/campaign-config.js');
    const { AGENCY_CONTACT_ASSIGNMENT_DEFAULTS } = await import('@magick-agency/contracts/agency');
    expect(validate({ ...AGENCY_CONTACT_ASSIGNMENT_DEFAULTS })).toEqual([]);
    for (const assignment_mode of ['pool', 'strict', 'preferred']) expect(validate({ assignment_mode })).toEqual([]);
    for (const on_unstaff of ['return_to_pool', 'keep']) expect(validate({ on_unstaff })).toEqual([]);
    for (const callback_fallback of ['pool', 'wait']) expect(validate({ callback_fallback })).toEqual([]);
    for (const v of [0, 10080]) {
      expect(validate({ callback_owner_grace_minutes: v, agent_retry_cooldown_minutes: v })).toEqual([]);
    }
    for (const agent_retry_rounds of [1, 10]) expect(validate({ agent_retry_rounds })).toEqual([]);
    for (const allow_agent_retry of [true, false]) expect(validate({ allow_agent_retry })).toEqual([]);
  });

  it('refuses each out-of-vocabulary, out-of-bound or mistyped value, null included, on its field', async () => {
    const { validateAgencyCampaignConfig: validate } = await import('../../../src/agency/campaign-config.js');
    for (const { body, field, message } of ASSIGNMENT_REFUSALS) {
      expect(validate(body), JSON.stringify(body)).toEqual([{ field, message }]);
    }
  });

  it('POST passes all seven to the repository, and leaves them unset when omitted (the column defaults)', async () => {
    const app = await makeApp();
    const settings = {
      assignment_mode: 'strict', on_unstaff: 'keep', callback_owner_grace_minutes: 15,
      callback_fallback: 'wait', allow_agent_retry: true, agent_retry_rounds: 3, agent_retry_cooldown_minutes: 60,
    };
    const on = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS, payload: { ...MINIMAL, ...settings },
    });
    expect(on.statusCode, on.body).toBe(201);
    expect(campaigns.create.mock.calls[0]![0]).toMatchObject(settings);

    const omitted = await app.inject({ method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS, payload: MINIMAL });
    expect(omitted.statusCode, omitted.body).toBe(201);
    for (const key of Object.keys(settings)) expect(campaigns.create.mock.calls[1]![0][key], key).toBeUndefined();
  });

  it('POST refuses a bad value and creates nothing', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { ...MINIMAL, assignment_mode: 'shared' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual({ assignment_mode: 'assignment_mode must be one of: pool, strict, preferred.' });
    expect(campaigns.create).not.toHaveBeenCalled();
  });

  it('PATCH writes the other six on a RUNNING campaign: no status gate', async () => {
    campaigns.findById.mockResolvedValue({ ...CAMPAIGN_ROW, status: 'running', assignment_mode: 'strict' });
    const app = await makeApp();
    const patch = {
      on_unstaff: 'keep', callback_owner_grace_minutes: 5, callback_fallback: 'wait',
      allow_agent_retry: true, agent_retry_rounds: 2, agent_retry_cooldown_minutes: 0,
    };
    const res = await app.inject({ method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS, payload: patch });
    expect(res.statusCode, res.body).toBe(200);
    expect(campaigns.update).toHaveBeenCalledWith('camp-1', patch);
  });

  describe('assignment_mode changes only while draft or paused (CA10)', () => {
    it.each(['running', 'stopping', 'completed', 'stopped'])('a change on a %s campaign is 409 mode_change_requires_pause and writes nothing', async (status) => {
      campaigns.findById.mockResolvedValue({ ...CAMPAIGN_ROW, status, assignment_mode: 'pool' });
      const app = await makeApp();
      const res = await app.inject({
        method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
        payload: { assignment_mode: 'strict', wrapup_seconds: 40 },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json()).toEqual({
        error: 'Conflict',
        code: 'mode_change_requires_pause',
        message: `The assignment mode can be changed only while the campaign is a draft or paused; it is ${status}. Pause it first.`,
      });
      expect(campaigns.update).not.toHaveBeenCalled();
    });

    it.each(['draft', 'paused'])('a change on a %s campaign is written', async (status) => {
      campaigns.findById.mockResolvedValue({ ...CAMPAIGN_ROW, status, assignment_mode: 'pool' });
      const app = await makeApp();
      const res = await app.inject({
        method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
        payload: { assignment_mode: 'preferred' },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(campaigns.update).toHaveBeenCalledWith('camp-1', { assignment_mode: 'preferred' });
    });

    it('sending the stored mode again on a RUNNING campaign is not a change, and is written', async () => {
      campaigns.findById.mockResolvedValue({ ...CAMPAIGN_ROW, status: 'running', assignment_mode: 'strict' });
      const app = await makeApp();
      const res = await app.inject({
        method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
        payload: { assignment_mode: 'strict', allow_agent_retry: true },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(campaigns.update).toHaveBeenCalledWith('camp-1', { assignment_mode: 'strict', allow_agent_retry: true });
    });

    it('a malformed mode is the 400 that names the field, not the 409', async () => {
      campaigns.findById.mockResolvedValue({ ...CAMPAIGN_ROW, status: 'running', assignment_mode: 'pool' });
      const app = await makeApp();
      const res = await app.inject({
        method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS, payload: { assignment_mode: null },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().details).toHaveProperty('assignment_mode');
    });
  });
});

describe('an outcome override on a catalog entry (CA8)', () => {
  it('accepts each part alone, all three together, and the extra_attempts bounds', async () => {
    const { validateAgencyCampaignConfig: validate } = await import('../../../src/agency/campaign-config.js');
    for (const override of [
      { extra_attempts: 1 }, { extra_attempts: 5 }, { retry_delay: true }, { calling_hours: true },
      { extra_attempts: 2, retry_delay: true, calling_hours: true },
      // One part granted is enough; the others may say false.
      { retry_delay: true, calling_hours: false },
    ]) {
      expect(validate(withOverride(override)), JSON.stringify(override)).toEqual([]);
    }
    // An entry with no override is untouched, the built-ins included.
    expect(validate({ disposition_catalog: [{ code: 'not_interested', label: 'Not interested' }] })).toEqual([]);
  });

  it('refuses an unknown key (a DNC one among them), a bad part, a grant of nothing, and an override on a suppress or terminal entry', async () => {
    const { validateAgencyCampaignConfig: validate } = await import('../../../src/agency/campaign-config.js');
    for (const { body, field, message } of OVERRIDE_REFUSALS) {
      expect(validate(body), JSON.stringify(body)).toEqual([{ field, message }]);
    }
  });

  it('a POST whose catalog grants a dnc override is a 400 and creates nothing', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { ...MINIMAL, ...withOverride({ extra_attempts: 1, dnc: true }) },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual({ [`${AT}.dnc`]: expect.stringContaining('do-not-call is never overridable') });
    expect(campaigns.create).not.toHaveBeenCalled();
  });

  it('the soft phone\'s catalog refuses any override, through the same validator', async () => {
    const { validateAgencyCampaignConfig: validate } = await import('../../../src/agency/campaign-config.js');
    const body = withOverride({ retry_delay: true });
    expect(validate(body)).toEqual([]);
    expect(validate(body, {}, { allowDispositionOverride: false })).toEqual([{
      field: AT, message: "Overrides are a campaign feature: the soft phone's outcome catalog cannot grant one.",
    }]);
    // Everything else about the catalog is held to the same rules either way.
    expect(validate({ disposition_catalog: [{ code: 'redialed', label: 'R' }] }, {}, { allowDispositionOverride: false }))
      .toEqual(validate({ disposition_catalog: [{ code: 'redialed', label: 'R' }] }));
  });
});

describe("the reserved system disposition code 'redialed'", () => {
  it('refuses a catalog entry using it, on the entry\'s code field, and nothing else about the catalog', async () => {
    const { AGENCY_REDIALED_DISPOSITION_CODE } = await import('@magick-agency/contracts/agency');
    const { validateAgencyCampaignConfig: validate } = await import('../../../src/agency/campaign-config.js');
    expect(AGENCY_REDIALED_DISPOSITION_CODE).toBe('redialed');
    expect(validate({
      disposition_catalog: [
        { code: 'not_interested', label: 'Not interested' },
        { code: AGENCY_REDIALED_DISPOSITION_CODE, label: 'Redialled' },
      ],
    })).toEqual([{
      field: 'disposition_catalog[1].code',
      message: "Disposition code 'redialed' is reserved: the system writes it on a call the agent redialled from wrap-up. Choose another code.",
    }]);
    // Byte-for-byte, like every other code comparison: a code that merely
    // contains the word is an ordinary code.
    expect(validate({ disposition_catalog: [{ code: 'redialed_later', label: 'Later' }] })).toEqual([]);
  });

  it('a POST carrying it is a 400 and creates nothing', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { ...MINIMAL, disposition_catalog: [{ code: 'redialed', label: 'Redialled' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details['disposition_catalog[0].code']).toContain('reserved');
    expect(campaigns.create).not.toHaveBeenCalled();
  });

  it('a PATCH carrying it is a 400 and writes nothing', async () => {
    const app = await makeApp();
    const res = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { disposition_catalog: [{ code: 'redialed', label: 'Redialled' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details['disposition_catalog[0].code']).toContain('reserved');
    expect(campaigns.update).not.toHaveBeenCalled();
  });

  it('the public API layer\'s validator refuses the same code and the same boolean, with the same messages', async () => {
    const internal = await import('../../../src/agency/campaign-config.js');
    const pub = await import('../../../src/agency/agency-campaign-config.js');
    for (const body of [
      { disposition_catalog: [{ code: 'redialed', label: 'Redialled' }] },
      { allow_wrapup_redial: 'yes' },
      { allow_wrapup_redial: null },
    ]) {
      expect(pub.validateAgencyCampaignConfig(body)).toEqual(internal.validateAgencyCampaignConfig(body));
      expect(pub.validateAgencyCampaignConfig(body)).toHaveLength(1);
    }
  });

  it('the two validators agree on every contact-assignment setting and every override rule', async () => {
    const internal = await import('../../../src/agency/campaign-config.js');
    const pub = await import('../../../src/agency/agency-campaign-config.js');
    for (const { body } of [...ASSIGNMENT_REFUSALS, ...OVERRIDE_REFUSALS]) {
      expect(pub.validateAgencyCampaignConfig(body), JSON.stringify(body)).toEqual(internal.validateAgencyCampaignConfig(body));
      expect(pub.validateAgencyCampaignConfig(body), JSON.stringify(body)).toHaveLength(1);
    }
    // And on the accepts: neither refuses what the other takes.
    for (const body of [
      { assignment_mode: 'preferred', on_unstaff: 'keep', callback_owner_grace_minutes: 0, callback_fallback: 'wait',
        allow_agent_retry: true, agent_retry_rounds: 10, agent_retry_cooldown_minutes: 10080 },
      withOverride({ extra_attempts: 5, retry_delay: true, calling_hours: true }),
    ]) {
      expect(pub.validateAgencyCampaignConfig(body)).toEqual([]);
      expect(internal.validateAgencyCampaignConfig(body)).toEqual([]);
    }
  });
});

describe('abandonment_ceiling_pct (the per-campaign auto-pause ceiling)', () => {
  const NOT_A_NUMBER = { field: 'abandonment_ceiling_pct', message: 'abandonment_ceiling_pct must be a number.' };
  const OUT_OF_RANGE = {
    field: 'abandonment_ceiling_pct', message: 'abandonment_ceiling_pct must be greater than 0 and at most 100.',
  };

  it('accepts (0, 100] and refuses the rest, with the bounds of the column CHECK', async () => {
    const { validateAgencyCampaignConfig: validate } = await import('../../../src/agency/campaign-config.js');
    for (const ok of [0.1, 3, 4.5, 100]) expect(validate({ abandonment_ceiling_pct: ok }), String(ok)).toEqual([]);
    expect(validate({})).toEqual([]);
    // 0 is refused: a zero ceiling pauses on the first abandon, a kill switch posing as
    // a strict setting. Over 100 cannot be a rate.
    for (const bad of [0, -0.5, -1, 100.0001, 101]) {
      expect(validate({ abandonment_ceiling_pct: bad }), String(bad)).toEqual([OUT_OF_RANGE]);
    }
    // `null` would reach the NOT NULL column as a 23502; a numeric string would be
    // coerced by Postgres into a value nobody typed as a number.
    for (const bad of ['4.5', '', null, true, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(validate({ abandonment_ceiling_pct: bad }), String(bad)).toEqual([NOT_A_NUMBER]);
    }
  });

  it('POST passes it to the repository, and leaves it unset when omitted (the repository applies 3)', async () => {
    const app = await makeApp();
    const set = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { ...MINIMAL, abandonment_ceiling_pct: 4.5 },
    });
    expect(set.statusCode, set.body).toBe(201);
    expect(campaigns.create.mock.calls[0]![0].abandonment_ceiling_pct).toBe(4.5);

    const omitted = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS, payload: MINIMAL,
    });
    expect(omitted.statusCode, omitted.body).toBe(201);
    expect(campaigns.create.mock.calls[1]![0].abandonment_ceiling_pct).toBeUndefined();
  });

  it('POST refuses 0 and creates nothing; PATCH refuses null and writes nothing', async () => {
    const app = await makeApp();
    const post = await app.inject({
      method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS,
      payload: { ...MINIMAL, abandonment_ceiling_pct: 0 },
    });
    expect(post.statusCode).toBe(400);
    expect(post.json().details).toEqual({ abandonment_ceiling_pct: OUT_OF_RANGE.message });
    expect(campaigns.create).not.toHaveBeenCalled();

    campaigns.findById.mockResolvedValue({ ...CAMPAIGN_ROW, status: 'running' });
    const patch = await app.inject({
      method: 'PATCH', url: '/api/v1/agency-campaigns/camp-1', headers: HEADERS,
      payload: { abandonment_ceiling_pct: null },
    });
    expect(patch.statusCode).toBe(400);
    expect(patch.json().details).toEqual({ abandonment_ceiling_pct: NOT_A_NUMBER.message });
    expect(campaigns.update).not.toHaveBeenCalled();
  });

  it('a recorded divergence: the public API layer\'s validator has no rule for it, so this handler\'s is the only one', async () => {
    // The console's 400 for a bad ceiling is this handler's, forwarded through `callCore`
    // unchanged (pinned end to end in `test/integration/api/agency-campaign-abandonment-ceiling.test.ts`).
    // A rule added to the public layer must use these messages; this case then changes.
    const pub = await import('../../../src/agency/agency-campaign-config.js');
    const internal = await import('../../../src/agency/campaign-config.js');
    expect(pub.validateAgencyCampaignConfig({ abandonment_ceiling_pct: 0 })).toEqual([]);
    expect(internal.validateAgencyCampaignConfig({ abandonment_ceiling_pct: 0 })).toEqual([OUT_OF_RANGE]);
  });
});
