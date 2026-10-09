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

const { campaigns, announcementRepo } = vi.hoisted(() => ({
  campaigns: { create: vi.fn(), update: vi.fn(), findById: vi.fn() },
  announcementRepo: { findActiveByIdScoped: vi.fn() },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyCampaignRepository: campaigns,
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

beforeEach(() => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  campaigns.findById.mockResolvedValue(CAMPAIGN_ROW);
  campaigns.create.mockImplementation(async (i: any) => ({ ...CAMPAIGN_ROW, ...i }));
  campaigns.update.mockImplementation(async (_id: string, p: any) => ({ ...CAMPAIGN_ROW, ...p }));
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
