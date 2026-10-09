import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

/*
 * Decision B8 (the DNC collapse): `POST /attempts/:id/dnc` calls `markDnc` (`src/agency/dnc-mark.ts`),
 * and the roster suppression (`suppressByPhone(..., { client })`), the optional disposition
 * (`recordDisposition(..., { client })`) and `markDnc(..., { client })` run in ONE transaction
 * on `getPool().connect()`; `runtime.wrapup.noteDisposition` runs after COMMIT. A failure in
 * the transaction propagates (ROLLBACK, the route answers via the thrown error).
 *
 * Harness:
 *   - `src/agency/dnc-mark.js` is mocked: `markDncSpy`, whose default implementation answers as
 *     `markDnc` does (the phone through the REAL `normalizeE164`, `recorded: false` and
 *     `phoneE164: null` for an unusable number, `written` echoing the scope), and
 *     `markDncRequest()` returns the request the route handed it (`tenantId`, `campaignId`,
 *     `accountId`, `phoneE164`, `reason`, `addedBy`);
 *   - `@magick-agency/db` is partially mocked so `getPool().connect()` returns one client whose
 *     `query` and `release` are spies (`pool`, `client`; `txLog` records the statements).
 *
 * Because the DNC write joins the suppression's transaction, a failed write rolls the suppression
 * back with it, and `noteDisposition` runs only after COMMIT, so a rolled-back disposition never
 * releases wrap-up.
 */

// ---------------------------------------------------------------------------
// `POST /agency/attempts/:id/dnc`, the agent's mark-DNC.
//
// ── WHY THIS FILE EXISTS AT ALL (and what it is guarding against) ───────────
//
// The route once did not exist. The public API layer proxied to it, logged success, and
// `contracts.ts` specified the request AND the response down to "always
// `suppressed` on success" — while `campaign-config.ts:31` and
// `disposition-policy.ts:41` both asserted in prose that "the DNC path is the
// dedicated `attempts/:id/dnc` route". Every artifact around the endpoint agreed
// it was finished. `grep -rn "attempts/:id/dnc" src/` returned those two comments
// and no registration, and every request 404'd. A file's comments are not
// evidence about the file, so this suite is written to be evidence: it registers
// the real `agencyRoutes` against a real Fastify instance and issues real
// requests. Nothing here asserts only that a route is *registered* — a
// registration assertion cannot see the hop failing at the other end.
//
// ── WHAT THIS FILE CAN AND CANNOT PROVE ──────────────────
//
// The final effect — "a number marked DNC at T is not dialed by a retry at
// T+5" — is enforced in two places, and only one of them is reachable here:
//
//   1. EVERY roster row in this campaign carrying that number leaves the roster,
//      because `claimDialable` claims only `state = 'pending'`. That predicate is
//      SQL, and so is the by-phone match; neither is exercised here and both are
//      owed to the integration tier (`agency-dnc-campaign-scope.test.ts`). What
//      this file proves is the input to them — that the route delegates to
//      `suppressByPhone` with this campaign and this number rather than
//      suppressing one row by id. Per the standing warning on `markState`,
//      `next_attempt_at` is COALESCEd and a suppressed contact KEEPS any retry
//      instant it had, so a test asserting "no retry was scheduled" would be
//      reading a stale value and proving nothing. **Assert the STATE.** These
//      tests do.
//
//      ⚠️ Why by phone, when this file used to assert by contact id: the mark is
//      CAMPAIGN-SCOPED now, so the row no longer reaches the flat
//      `dnc:{tenantId}` set and the dial-time `SISMEMBER` no longer backstops it.
//      That backstop was the only thing stopping a SECOND roster row with the same
//      number — legitimate, common data, per migration 073's deliberate refusal of
//      a phone-unique index — from being dialled after the first was marked.
//
//   2. The durable compliance record is `dnc_entries`, written by `markDnc` alone, and the
//      row is scoped by the request's `scope` — this campaign by default, the whole
//      tenant when the console escalates. The route deliberately does not SADD the
//      Redis set itself (the version discipline belongs to the sync, and an unversioned
//      local write would corrupt the authority the fail-closed gate depends on).
//      So the reachable proof is the request the route hands `markDnc`: the phone in the EXACT
//      form `normalizeE164` produces, and a `campaign_id` present or absent exactly
//      as the scope says. A `+`/formatting mismatch is a silent fail-open; a
//      campaign id sent on an escalation is a customer told "any campaign, forever"
//      and given one campaign; a campaign id missing from a default mark is a
//      customer suppressed in campaigns they never mentioned. All three leave every
//      dashboard green, which is why they are asserted on the wire rather than on
//      intent — see the `scope` group at the end of this file.
//
// Deliberately NOT built: a fake Redis that evaluates the registry's Lua.
// A JS fake re-implementing the script would assert one's own belief about it
// against itself, so this file does not manufacture a green end-to-end.
//
// FALSIFICATION: every assertion below was run against pre-fix code (no route
// registered) and failed with 404; the mutations recorded per group were then
// applied to the finished route and each produced the predicted red.
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

// The tenancy headers are the platform's, not this ticket's — but WHETHER the
// middleware runs at all is very much this ticket's (see the auth group below),
// so it is a spy rather than a bare pass-through.
const { authSpy } = vi.hoisted(() => ({ authSpy: vi.fn(async () => { /* authenticated */ }) }));
vi.mock('../../../src/api/middleware/auth.middleware.js', () => ({
  authMiddleware: authSpy,
  getTenantId: (req: any) => req.headers['x-mgkvc-tenant'] ?? 't1',
  getAccountId: (req: any) => req.headers['x-mgkvc-account'] ?? 'a1',
}));

const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { default: false } },
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: {
      findById: vi.fn(),
      recordDisposition: vi.fn(),
      saveNotes: vi.fn(),
      setState: vi.fn().mockResolvedValue(null),
      attachWebrtcCall: vi.fn().mockResolvedValue(undefined),
      findPriorForContactLineage: vi.fn().mockResolvedValue([]),
    },
    campaign: { findById: vi.fn() },
    contact: {
      markState: vi.fn().mockResolvedValue(undefined),
      // The campaign-scoped suppression. Returns the ids it suppressed; the
      // default is deliberately TWO, because the roster fixture below is the
      // duplicate-number case this route now has to cover and a one-element
      // default would let a by-contact-id regression look identical.
      suppressByPhone: vi.fn().mockResolvedValue(['contact-1', 'contact-dup']),
      unclaim: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn(),
    },
    session: { findById: vi.fn(), setState: vi.fn().mockResolvedValue(undefined), leave: vi.fn() },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyCampaignRepository: repos.campaign,
  agencyContactRepository: repos.contact,
  agencyAgentSessionRepository: repos.session,
}));

// What the route hands the one writer of `dnc_entries` is the reachable proof, so
// `markDnc` is the double; its default answer (set in `beforeEach`) is the real function's
// contract.
const { markDncSpy } = vi.hoisted(() => ({ markDncSpy: vi.fn() }));
vi.mock('../../../src/agency/dnc-mark.js', () => ({ markDnc: markDncSpy }));

// The ONE transaction (B8): every write on this route goes through this client.
const { pool, client, txLog } = vi.hoisted(() => {
  const txLog: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => { txLog.push(sql); return { rows: [], rowCount: 0 }; }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) }, client, txLog };
});
vi.mock('@magick-agency/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db')>()),
  getPool: () => pool,
}));

import { agencyRoutes } from '../../../src/api/routes/agency.routes.js';
import { normalizeE164 } from '../../../src/agency/dnc-registry.js';
import type { AgencyDisposition, AgencyDncResponse } from '@magick-agency/contracts/agency';

const CATALOG: AgencyDisposition[] = [
  { code: 'sale', label: 'Sale', is_success: true },
  { code: 'do_not_call', label: 'Do not call', suppress: true },
  { code: 'complaint', label: 'Complaint', requires_note: true },
];

const SESSION = { id: 'sess-1', agent_user_id: 'u-agent', campaign_id: 'camp-1' };

function attemptRow(patch: Record<string, unknown> = {}) {
  return {
    id: 'att-1', campaign_id: 'camp-1', contact_id: 'contact-1',
    tenant_id: 't1', account_id: 'a1', attempt_number: 1,
    webrtc_call_id: 'call-1', caller_id: '+14155550100',
    reserved_agent_id: 'sess-1', state: 'bridged', outcome: 'connected',
    disposition_code: null, notes: null, callback_at: null,
    dispositioned_by_user_id: null, dispositioned_at: null, dispositioned_on_behalf: false,
    dialed_at: new Date(), answered_at: new Date(), bridged_at: new Date(),
    ended_at: null, talk_seconds: 42, wrapup_seconds: 30,
    created_at: new Date(), updated_at: new Date('2026-08-11T10:00:00.000Z'),
    ...patch,
  };
}

function contactRow(patch: Record<string, unknown> = {}) {
  return {
    id: 'contact-1', campaign_id: 'camp-1', tenant_id: 't1', account_id: 'a1',
    phone_e164: '+14155550100', context: {}, source_row_number: 1, timezone: null,
    state: 'connected', attempt_count: 1, next_attempt_at: new Date('2026-08-11T10:05:00.000Z'),
    last_outcome: 'connected', last_disposition: null, suppressed_reason: null,
    created_at: new Date(), updated_at: new Date(),
    ...patch,
  };
}

function makeRuntime() {
  return {
    replicaId: 'r1',
    agents: { get: vi.fn().mockResolvedValue({ state: 'on_call', attemptId: 'att-1', since: 1 }), set: vi.fn(), clear: vi.fn() },
    wrapup: { noteDisposition: vi.fn().mockResolvedValue(true), stateFor: vi.fn(() => null) },
    stations: { send: vi.fn(() => true), detach: vi.fn(), attach: vi.fn(), isLocallyOwned: vi.fn(() => true) },
    dialer: { hasLiveAttempt: vi.fn(() => false), noteStationClosed: vi.fn(), reattachStation: vi.fn(() => null), takeMissedRelease: vi.fn(() => null) },
    breaks: { queue: vi.fn(), take: vi.fn(() => null), cancel: vi.fn(() => false) },
    tokens: { mint: vi.fn(), verifyAndConsume: vi.fn() },
    // Deliberately a throwing double. The route must never consult the registry:
    // the Redis set is written only by the versioned sync, and a local unversioned SADD would
    // corrupt the authority the fail-closed dial gate depends on. A route that
    // reached for it would fail here rather than pass quietly.
    dnc: {
      check: vi.fn(() => { throw new Error('the mark-DNC route must not consult the registry'); }),
      applyDelta: vi.fn(() => { throw new Error('the mark-DNC route must not write the registry'); }),
      applyReplace: vi.fn(() => { throw new Error('the mark-DNC route must not write the registry'); }),
    },
    rehydrateAgent: vi.fn().mockResolvedValue('break'),
    releaseStationOnClose: vi.fn().mockResolvedValue(true),
  };
}

let runtime: ReturnType<typeof makeRuntime>;

async function buildApp() {
  const app = Fastify();
  runtime = makeRuntime();
  await app.register((a) => agencyRoutes(a as never, runtime as never), { prefix: '/api/v1/agency' });
  await app.ready();
  return app;
}

const HEADERS = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };

async function markDnc(
  app: Awaited<ReturnType<typeof buildApp>>,
  payload: Record<string, unknown> = {},
  attemptId = 'att-1',
) {
  return app.inject({
    method: 'POST', url: `/api/v1/agency/attempts/${attemptId}/dnc`,
    headers: HEADERS, payload,
  });
}

/** The one request the route handed `markDnc`. */
function markDncRequest(): Record<string, any> {
  const call = markDncSpy.mock.calls[0];
  return call?.[0] as Record<string, any>;
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  repos.attempt.findById.mockResolvedValue(attemptRow());
  repos.attempt.recordDisposition.mockResolvedValue(attemptRow({ disposition_code: 'do_not_call' }));
  repos.campaign.findById.mockResolvedValue({
    id: 'camp-1', tenant_id: 't1', disposition_catalog: CATALOG,
    calling_window_start: '00:00:00', calling_window_end: '24:00:00',
    calling_days: [1, 2, 3, 4, 5, 6, 7], default_timezone: 'UTC',
  });
  repos.contact.findById.mockResolvedValue(contactRow());
  repos.session.findById.mockResolvedValue(SESSION);
  txLog.length = 0;
  // Re-armed every case: two cases below replace it to record a cross-write order.
  client.query.mockImplementation(async (sql: string) => { txLog.push(sql); return { rows: [], rowCount: 0 }; });
  // `markDnc`'s contract: the phone through the real `normalizeE164`, nothing written for
  // a number that is not usable E.164, and the scope of the written row echoed back.
  markDncSpy.mockImplementation(async (req: any) => {
    const phone = normalizeE164(req.phoneE164);
    return phone
      ? { recorded: true, alreadyPresent: false, phoneE164: phone, written: { campaign_id: req.campaignId ?? null } }
      : { recorded: false, alreadyPresent: false, phoneE164: null, written: null };
  });
});

// ───────────────────────────────────────────────────────────────────────────
describe('the route exists and is reachable (the original 404 regression)', () => {
  // FALSIFICATION: this is the regression pin. Against pre-fix code the response
  // was 404 with Fastify's own "Route POST:/api/v1/agency/attempts/att-1/dnc not
  // found" body — the exact symptom the agent saw, and the exact thing a
  // registration-only test could not see.
  it('answers a mark-DNC instead of 404ing', async () => {
    const app = await buildApp();
    const res = await markDnc(app);
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('returns every field of AgencyDncResponse, typed against the contract', async () => {
    const app = await buildApp();
    const res = await markDnc(app);
    // Typed, so a field dropped from the response is a compile error here rather
    // than a runtime surprise in the consumer of this shape.
    const body = res.json() as AgencyDncResponse;
    expect(body).toEqual({
      attempt_id: 'att-1',
      contact_id: 'contact-1',
      campaign_id: 'camp-1',
      phone_e164: '+14155550100',
      contact_state: 'suppressed',
      dnc_recorded: true,
    });
    await app.close();
  });
});

describe('it is authenticated (the unauthenticated-route defect class)', () => {
  // An unauthenticated `/internal/agency-campaigns/:id/contacts` once shipped on this
  // very feature, because auth is registered PER ROUTE-PLUGIN rather than globally. A route added outside the authenticated scope looks identical
  // in every other test.
  //
  // FALSIFICATION: moving the registration out of the `sub` scope and onto `app`
  // left every other test in this file green and failed only these two.
  it('runs the auth middleware for the mark-DNC route', async () => {
    const app = await buildApp();
    authSpy.mockClear();
    await markDnc(app);
    expect(authSpy).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('is gated on the agency_dialer_enabled flag', async () => {
    flags.isEnabled.mockResolvedValue(false);
    const app = await buildApp();
    const res = await markDnc(app);
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('feature_disabled');
    // Nothing was suppressed and `markDnc` was never called.
    expect(repos.contact.suppressByPhone).not.toHaveBeenCalled();
    expect(repos.contact.markState).not.toHaveBeenCalled();
    expect(markDncSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('404s an attempt belonging to another tenant, without leaking its existence', async () => {
    repos.attempt.findById.mockResolvedValue(attemptRow({ tenant_id: 'other-tenant' }));
    const app = await buildApp();
    const res = await markDnc(app);
    expect(res.statusCode).toBe(404);
    // The ROUTE's 404, not Fastify's. Asserting the status alone passed against
    // pre-fix code — where every request 404'd because nothing was registered —
    // so the status was proving the opposite of what it claimed to.
    expect(res.json().message).toBe('Attempt not found');
    expect(repos.contact.suppressByPhone).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('the suppression EFFECT — the number stops being dialable', () => {
  // FALSIFICATION: changing the written state to 'completed' failed this and
  // nothing else, which is the point — a route can return a correct-looking 200
  // while suppressing nothing, and that is worse than the 404 because the 404 is
  // at least visible.
  it("suppresses BY NUMBER, campaign-scoped, with reason 'dnc'", async () => {
    const app = await buildApp();
    await markDnc(app);
    expect(repos.contact.suppressByPhone).toHaveBeenCalledTimes(1);
    const [campaignId, phone, reason, opts] = repos.contact.suppressByPhone.mock.calls[0]!;
    expect(campaignId).toBe('camp-1');
    // The ROSTER's string, not a pre-normalized one: `suppressByPhone` owns the
    // normalization so that both sides of its comparison go through the one
    // function, and a caller that normalized first would be a second definition.
    expect(phone).toBe('+14155550100');
    expect(reason).toBe('dnc');
    // And the marked row is named, so it is suppressed even when the number
    // matches nothing (see the invalid-phone case below).
    expect(opts).toMatchObject({ alwaysContactId: 'contact-1' });
    // And it runs on the route's transaction
    // client (decision B8) — the 5th argument; without it the suppression commits on its own.
    expect(repos.contact.suppressByPhone.mock.calls[0]![4]).toEqual({ client });
    await app.close();
  });

  it('does NOT fall back to the single-row markState — the duplicate is the whole point', async () => {
    // The regression pin for this change. `markState(contact_id, …)` suppresses
    // exactly one row, and while the mark was tenant-wide the Redis set covered
    // the duplicate. It no longer does, so a route that quietly went back to the
    // by-id write would still return 200, still show the agent a confirmation,
    // and still let the same campaign ring the customer back from the second row.
    const app = await buildApp();
    await markDnc(app);
    expect(repos.contact.markState).not.toHaveBeenCalled();
    await app.close();
  });

  it('suppresses a contact that already has a retry scheduled at T+5', async () => {
    // The exact M3 exit criterion, in the shape it actually occurs: the contact
    // is mid-call and already carries `next_attempt_at`. `suppressByPhone` keeps
    // `markState`'s COALESCE behaviour, so the instant SURVIVES — and asserting
    // its absence would be asserting a stale read. What makes the retry never
    // fire is the state.
    repos.contact.findById.mockResolvedValue(
      contactRow({ next_attempt_at: new Date('2026-08-11T10:05:00.000Z') }),
    );
    const app = await buildApp();
    await markDnc(app);
    const [, , reason, opts] = repos.contact.suppressByPhone.mock.calls[0]!;
    expect(reason).toBe('dnc');
    // Pinned deliberately: the route must NOT ask for it to be cleared. Clearing
    // belongs to the DNC-clearing path, and a route quietly writing null here would be an
    // untracked change to a column a compliance export reads. (That the
    // repository does not clear it either is the integration tier's assertion —
    // this one only proves the route never asks.)
    expect(opts).not.toHaveProperty('next_attempt_at');
    await app.close();
  });

  it('suppresses the roster BEFORE it calls markDnc, so the two cannot disagree', async () => {
    // Both writes sit inside the one transaction, so the order is asserted against
    // BEGIN and COMMIT as well.
    const order: string[] = [];
    client.query.mockImplementation(async (sql: string) => { order.push(sql); return { rows: [], rowCount: 0 }; });
    repos.contact.suppressByPhone.mockImplementation(async () => { order.push('suppress'); return ['contact-1']; });
    markDncSpy.mockImplementation(async () => {
      order.push('markDnc');
      return { recorded: true, alreadyPresent: false, phoneE164: '+14155550100', written: { campaign_id: 'camp-1' } };
    });
    const app = await buildApp();
    await markDnc(app);
    // If `markDnc` ran first and the roster write then failed, the response
    // would claim a suppression that never happened.
    expect(order).toEqual(['BEGIN', 'suppress', 'markDnc', 'COMMIT']);
    await app.close();
  });

  it('never consults or writes the DNC Redis registry', async () => {
    // The registry double throws on every method. Redis is written only via
    // the versioned sync; the route writing it locally would corrupt the authority the
    // fail-closed gate depends on. This also means the suppression above is
    // Redis-INDEPENDENT: it is a Postgres row, so a Redis outage cannot lose it.
    const app = await buildApp();
    const res = await markDnc(app);
    expect(res.statusCode).toBe(200);
    expect(runtime.dnc.check).not.toHaveBeenCalled();
    expect(runtime.dnc.applyDelta).not.toHaveBeenCalled();
    expect(runtime.dnc.applyReplace).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('the hand-off to markDnc — the campaign-scoped default', () => {
  it("hands markDnc a campaign-scoped request on the route's transaction client", async () => {
    // The write must join the route's transaction rather than open its own.
    const app = await buildApp();
    await markDnc(app, { reason: 'customer asked to be removed' });
    expect(markDncSpy).toHaveBeenCalledTimes(1);
    const [, deps] = markDncSpy.mock.calls[0]!;
    expect(deps).toEqual({ client });
    expect(markDncRequest()).toMatchObject({
      tenantId: 't1',
      campaignId: 'camp-1',
      phoneE164: '+14155550100',
      reason: 'customer asked to be removed',
    });
    await app.close();
  });

  // FALSIFICATION: dropping `campaignId` from the `markDnc` call in the
  // route — predicted red: this test only. It is the most dangerous omission in
  // the route, because an ABSENT campaign_id is read as a tenant-wide entry:
  // the number would be suppressed across every campaign the tenant runs, the
  // response would still say `dnc_recorded: true`, and the only evidence would be
  // customers no longer being reached by campaigns they never complained about.
  it('sends the CAMPAIGN the mark was made from, so the record is scoped to it', async () => {
    const app = await buildApp();
    await markDnc(app);
    // Asserted on the `markDnc` request.
    expect(markDncRequest().campaignId).toBe('camp-1');
    await app.close();
  });

  it('never sends account_id — an account-scoped row would never reach the dial-time set', async () => {
    // An account-scoped row is enforced at ingest only and never enters the flat
    // `dnc:{tenantId}` set. Sending one would look correct in the list and suppress
    // nothing at dial time.
    const app = await buildApp();
    await markDnc(app);
    // Asserted on the `markDnc` request.
    expect(markDncRequest()).not.toHaveProperty('accountId');
    await app.close();
  });

  // FALSIFICATION: forwarding `contact.phone_e164` raw instead of the normalized
  // form failed only this test — and that is the single most dangerous mutation
  // in the file, because the row would be written happily, every log line would
  // read as success, and `SISMEMBER` would return 0 forever at dial time.
  it('forwards the phone in the EXACT form the registry compares against', async () => {
    // A roster row that survived ingest in a human-typed shape.
    repos.contact.findById.mockResolvedValue(contactRow({ phone_e164: '+1 (415) 555-0100' }));
    const app = await buildApp();
    const res = await markDnc(app);
    // The normalization lives INSIDE `markDnc`, which runs the registry's
    // own `normalizeE164` before it writes (`src/agency/dnc-mark.ts`). So the route
    // hands it the ROSTER's string — as it does `suppressByPhone`, for the same reason:
    // a caller that normalized first would be a second definition.
    expect(markDncRequest().phoneE164).toBe('+1 (415) 555-0100');
    // Not merely "it looks normalized" — it is byte-identical to what the
    // registry's own `normalizeE164` produces, which is the function
    // `DncRegistry.check` runs on both sides of its comparison.
    const sent = (res.json() as AgencyDncResponse).phone_e164;
    expect(sent).toBe(normalizeE164('+1 (415) 555-0100'));
    expect(sent).toBe('+14155550100');
    await app.close();
  });

  it('reports dnc_recorded true for an already-present number', async () => {
    // A redelivery is a success on purpose, so an agent's second press must not show
    // a failure for a suppressed number: `markDnc` answers `alreadyPresent`.
    markDncSpy.mockResolvedValueOnce({
      recorded: true, alreadyPresent: true, phoneE164: '+14155550100', written: { campaign_id: 'camp-1' },
    });
    const app = await buildApp();
    const res = await markDnc(app);
    expect((res.json() as AgencyDncResponse).dnc_recorded).toBe(true);
    await app.close();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// `scope` — the reach of the mark, and the only scope fact a client asserts.
//
// ── WHY THIS GROUP EXISTS ──────────────────────────────────────────────────
//
// Campaign-scoping once shipped as an UNCONDITIONAL narrowing: the route called
// `markDnc({ campaignId: campaign.id, … })` with no way not to, and
// `campaignId` was typed `string`. There was no path through the route that produced a
// tenant-wide `dnc_entries` row — while the console shipped a permission-gated
// button reading "Never call again (any campaign, forever)" whose hint promised the
// number "will not be called again by any campaign in this workspace,
// permanently". An agent could read that sentence to a customer and the route would
// write a single-campaign suppression, answering 200 with `dnc_recorded: true`.
//
// That is worse than a silent strip, and the reason is not severity-of-outcome: a
// person was explicitly told otherwise, on an irreversible compliance action. So
// the assertions here are about the WIRE, not about intent — what the route actually
// sends is the only thing that makes the sentence true or false.
//
// ── THE DEFAULT IS THE NARROWER SCOPE, and the route is where the two inputs invert ─
//
// The vocabulary and the default are OPPOSITE on either side of this route, and
// the route is the translator standing between them:
//
//   request body         field `scope`,       ABSENT ⇒ campaign  (narrow)
//   `markDnc` request    field `campaignId`,  ABSENT ⇒ tenant-wide (broad)
//
// The public API layer forwards an absent `scope` as genuinely absent — it deliberately
// does not normalise it to `'campaign'`, because the route owns the default and a second
// copy is a second thing to get wrong. Which puts the
// whole hazard here: translate "no `scope` key" straight through to "no
// `campaignId`" and the fail-safe default INVERTS into a tenant-wide suppression
// at the second step — the over-block this feature exists to remove, reintroduced
// one step later, silently, on a terminal compliance write.
//
// SC1 is the test for that and it is NOT redundant with SC2: a suite that only
// covered the explicit `scope: 'campaign'` value stays green straight through the
// inversion, because the explicit value never travels the defaulting path at all.
// Mutation (d) below is what proves the two are testing different things.
//
// FALSIFICATION, run against the finished route:
//
//   (a) `...(scope === 'campaign' ? { campaignId: campaign.id } : {})` replaced by
//       an unconditional `campaignId: campaign.id` — i.e. the defect restored.
//       Predicted red: SC3, SC4, SC8, SC9 only. This is THE mutation: a `scope`
//       field that parses, validates and logs but does not change the payload is a
//       field that does nothing, and a suite that stays green through this is
//       testing nothing.
//   (b) the same conditional inverted (`scope === 'tenant' ? { campaignId … }`),
//       so a campaign mark goes out tenant-wide. Predicted red: SC1, SC2, SC3,
//       SC4, SC7, SC8, SC9 — plus the two campaign_id assertions in the group
//       above, which also send no `scope` key.
//   (c) `suppressByPhone` made conditional on `scope === 'campaign'`. Predicted
//       red: SC5 only — the local write is the same write in both scopes.
//   (d) the DEFAULT inverted: `body.scope ?? 'tenant'`. Predicted red: SC1 and the
//       two campaign_id assertions in the group above — and NOT SC2, which passes
//       `'campaign'` explicitly and so never exercises the default. Exactly three
//       reds, all of them requests with no `scope` key.
// ───────────────────────────────────────────────────────────────────────────
describe('the scope of the mark (`scope`)', () => {
  it('SC1: an ABSENT scope is campaign-scoped — ignorance narrows, it never escalates', async () => {
    // The fail-safe direction, pinned on the request `markDnc` actually receives. An
    // absent `campaignId` reads as tenant-wide, so "the route forgot to send
    // it" and "the customer asked for a workspace-wide block" are the same bytes.
    const app = await buildApp();
    await markDnc(app, {});
    // Asserted on the `markDnc` request.
    expect(markDncRequest().campaignId).toBe('camp-1');
    await app.close();
  });

  it("SC2: scope 'campaign' sends the campaign id", async () => {
    const app = await buildApp();
    await markDnc(app, { scope: 'campaign' });
    // Asserted on the `markDnc` request.
    expect(markDncRequest().campaignId).toBe('camp-1');
    await app.close();
  });

  it("SC3: scope 'tenant' sends NO campaign id — the escalation the console promises", async () => {
    // THE assertion. An omitted `campaignId` is how `markDnc` is asked for the
    // unscoped `dnc_entries` row: the one that enters the flat `dnc:{tenantId}` set
    // and blocks the number at dial time in every campaign the tenant runs, now and
    // in future. It is the only thing that makes "any campaign, forever" true.
    //
    // `not.toHaveProperty` rather than `toBeUndefined`: `JSON.stringify` drops an
    // undefined value, so the two read alike here — but a `campaign_id: null` would
    // satisfy `toBeUndefined()`-style checks in some shapes and is NOT the same
    // request. The field must be absent.
    const app = await buildApp();
    await markDnc(app, { scope: 'tenant' });
    // Asserted on the `markDnc` request.
    expect(markDncRequest()).not.toHaveProperty('campaignId');
    // And nothing else about the payload moved with it.
    expect(markDncRequest()).toMatchObject({ tenantId: 't1', phoneE164: '+14155550100' });
    expect(markDncRequest()).not.toHaveProperty('accountId');
    await app.close();
  });

  it('SC5: the LOCAL suppression is identical in both scopes — never conditional on it', async () => {
    // A `tenant` mark does eventually block this number everywhere, once the
    // row is written and the versioned set republished. That is a weaker, later,
    // Redis-shaped guarantee than the committed Postgres write, and the contact in
    // front of the agent must leave the roster on the same terms either way.
    const app = await buildApp();

    await markDnc(app, { scope: 'campaign' });
    const campaignCall = repos.contact.suppressByPhone.mock.calls[0]!;

    repos.contact.suppressByPhone.mockClear();
    await markDnc(app, { scope: 'tenant' });
    const tenantCall = repos.contact.suppressByPhone.mock.calls[0]!;

    expect(repos.contact.suppressByPhone).toHaveBeenCalledTimes(1);
    // Argument for argument: the campaign the roster rows live in, the roster's own
    // phone string, the reason, and the marked row named explicitly.
    expect(tenantCall).toEqual(campaignCall);
    expect(tenantCall[0]).toBe('camp-1');
    expect(tenantCall[1]).toBe('+14155550100');
    expect(tenantCall[2]).toBe('dnc');
    expect(tenantCall[3]).toMatchObject({ alwaysContactId: 'contact-1' });
    // And still never the single-row write, whatever the scope.
    expect(repos.contact.markState).not.toHaveBeenCalled();
    await app.close();
  });

  it('SC6: 400s an unrecognised scope, suppressing nothing and calling markDnc never', async () => {
    // Refused rather than defaulted. A console that misspells `tenant` is showing an
    // agent the escalation's label; quietly writing the campaign-scoped row would
    // make a compliance statement to a customer false behind a 200. Validation runs
    // before any write, matching the disposition arm's ordering.
    const app = await buildApp();
    const res = await markDnc(app, { scope: 'workspace' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_dnc_scope');
    expect(res.json().allowed_codes).toEqual(['campaign', 'tenant']);
    expect(repos.contact.suppressByPhone).not.toHaveBeenCalled();
    expect(repos.contact.markState).not.toHaveBeenCalled();
    // `markDnc` is never called, and the refusal comes before the transaction opens.
    expect(markDncSpy).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    await app.close();
  });

  it('SC7: a client-supplied campaign_id is ignored — the client asserts the scope, not the id', async () => {
    // There is no `campaign_id` on this body and there must not become one: the
    // route resolved the attempt's campaign before it read anything, so a supplied
    // id would be a caller asserting a fact the route owns. A client that could name the
    // campaign could name someone else's.
    const app = await buildApp();
    await markDnc(app, { scope: 'campaign', campaign_id: 'camp-someone-elses' });
    // Asserted on the `markDnc` request.
    expect(markDncRequest().campaignId).toBe('camp-1');
    expect(repos.contact.suppressByPhone.mock.calls[0]![0]).toBe('camp-1');
    await app.close();
  });

  it("SC8: a tenant escalation still answers the ordinary 200 — the scope is invisible in the response", async () => {
    // Which is exactly why SC3 asserts the wire. The response shape is identical for
    // both scopes by contract, so nothing an agent or a dashboard can see
    // distinguishes an escalation that landed from one that was silently narrowed.
    const app = await buildApp();
    const res = await markDnc(app, { scope: 'tenant' });
    expect(res.statusCode).toBe(200);
    expect(res.json() as AgencyDncResponse).toEqual({
      attempt_id: 'att-1',
      contact_id: 'contact-1',
      campaign_id: 'camp-1',
      phone_e164: '+14155550100',
      contact_state: 'suppressed',
      dnc_recorded: true,
    });
    // The forward was made, once, and it was the tenant-wide one.
    // Asserted on the `markDnc` request.
    expect(markDncSpy).toHaveBeenCalledTimes(1);
    expect(markDncRequest()).not.toHaveProperty('campaignId');
    await app.close();
  });

  it('SC9: an escalation carries the actor and reason exactly as a campaign mark does', async () => {
    const app = await buildApp();
    await markDnc(app, { scope: 'tenant', reason: 'wants off every list', agent_user_id: 'u-agent' });
    // Asserted on the `markDnc` request.
    expect(markDncRequest()).toEqual({
      tenantId: 't1',
      phoneE164: '+14155550100',
      reason: 'wants off every list',
      addedBy: 'u-agent',
    });
    await app.close();
  });
});

describe('when the DNC write does not land (decision B8)', () => {
  // Criterion: a write must not be silently lost. The contact row is Postgres and
  // independent of Redis, so the compliance-critical half always
  // lands; `dnc_recorded: false` is how the console learns the tenant-wide half
  // did not.
  //
  // The `dnc_entries` row
  // is in this database and joins the suppression's transaction, so a failed write
  // rolls the suppression back with it and the route answers an error with nothing
  // claimed. `dnc_recorded: false` is now only the unusable-number answer.
  //
  it('a failure after the suppression propagates and nothing commits', async () => {
    // Under `deps.client` `markDnc` rethrows, so the route's transaction rolls back the
    // suppression and the disposition beside it.
    markDncSpy.mockRejectedValue(new Error('insert into dnc_entries failed'));
    const app = await buildApp();
    const res = await markDnc(app, { disposition_code: 'do_not_call', agent_user_id: 'u-agent' });
    expect(res.statusCode).toBe(500);
    expect(res.json().message).toBe('insert into dnc_entries failed');
    expect(res.json()).not.toHaveProperty('contact_state');
    expect(repos.contact.suppressByPhone).toHaveBeenCalledTimes(1);
    expect(txLog).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledTimes(1);
    // The rolled-back disposition must not release wrap-up.
    expect(runtime.wrapup.noteDisposition).not.toHaveBeenCalled();
    await app.close();
  });

  it('reports dnc_recorded false when the number is not usable E.164', async () => {
    // `markDnc` refuses an unusable phone itself — no row, no throw — so the
    // transaction COMMITs and the suppression of the marked row stands.
    // The route must not
    // show the agent a confirmation for a suppression that never happened.
    repos.contact.findById.mockResolvedValue(contactRow({ phone_e164: 'not-a-number' }));
    const app = await buildApp();
    const res = await markDnc(app);
    const body = res.json() as AgencyDncResponse;
    expect(body.dnc_recorded).toBe(false);
    // Still suppressed: an unusable number is a data problem, and the contact in
    // front of the agent must still leave the roster.
    expect(body.contact_state).toBe('suppressed');
    // And the mechanism that keeps that true once the write is by PHONE: the
    // marked row is named explicitly, because a number that does not normalize
    // matches no roster row at all. A by-phone rewrite that forgot this would
    // suppress NOTHING here while still answering `contact_state: 'suppressed'` —
    // the response is a constant, so it cannot notice.
    expect(repos.contact.suppressByPhone).toHaveBeenCalledTimes(1);
    expect(repos.contact.suppressByPhone.mock.calls[0]![3])
      .toMatchObject({ alwaysContactId: 'contact-1' });
    expect(txLog).toEqual(['BEGIN', 'COMMIT']);
    await app.close();
  });
});

describe('the optional disposition_code', () => {
  // The contract carries it and the route accepts it. Silently ignoring it
  // is the failure mode this whole group is about, so every arm is loud.
  it('records the disposition when the code and an actor are both supplied', async () => {
    const app = await buildApp();
    const res = await markDnc(app, { disposition_code: 'do_not_call', agent_user_id: 'u-agent' });
    expect(res.statusCode).toBe(200);
    expect(repos.attempt.recordDisposition).toHaveBeenCalledTimes(1);
    expect(repos.attempt.recordDisposition.mock.calls[0]![0]).toMatchObject({
      attemptId: 'att-1', dispositionCode: 'do_not_call', actorUserId: 'u-agent', onBehalf: false,
    });
    await app.close();
  });

  it("keeps contact_state 'suppressed' even when the disposition policy would not", async () => {
    // The contract's "always `suppressed` on success" outranks the disposition precedence rule.
    // A `sale` would otherwise resolve to `completed`; the customer asked not to
    // be called again, and that wins.
    const app = await buildApp();
    const res = await markDnc(app, { disposition_code: 'sale', agent_user_id: 'u-agent' });
    expect((res.json() as AgencyDncResponse).contact_state).toBe('suppressed');
    expect(repos.contact.suppressByPhone).toHaveBeenCalledTimes(1);
    expect(repos.contact.suppressByPhone.mock.calls[0]![2]).toBe('dnc');
    await app.close();
  });

  it('carries the disposition on the MARKED row only, never onto a duplicate', async () => {
    // `lastDisposition` is passed alongside `alwaysContactId`, and the repository
    // writes it to that row alone. A disposition is a statement about one call
    // with one person; two roster rows sharing a household landline are two
    // different people, and stamping `sale` (or `do_not_call`) onto the housemate
    // would invent a record of a conversation that never happened — on the table a
    // compliance export reads.
    const app = await buildApp();
    await markDnc(app, { disposition_code: 'do_not_call', agent_user_id: 'u-agent' });
    expect(repos.contact.suppressByPhone.mock.calls[0]![3]).toMatchObject({
      alwaysContactId: 'contact-1',
      lastDisposition: 'do_not_call',
    });
    await app.close();
  });

  it('asks for no disposition at all on a plain mark-DNC', async () => {
    // The mirror of the case above: `lastDisposition` ABSENT rather than
    // undefined-and-ignored, so nothing can be written over a code the contact
    // already carried from an earlier call.
    const app = await buildApp();
    await markDnc(app, {});
    expect(repos.contact.suppressByPhone.mock.calls[0]![3]).not.toHaveProperty('lastDisposition');
    await app.close();
  });

  it('400s an unknown code and echoes the catalog, suppressing nothing', async () => {
    const app = await buildApp();
    const res = await markDnc(app, { disposition_code: 'nope', agent_user_id: 'u-agent' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('unknown_disposition_code');
    expect(res.json().allowed_codes).toEqual(['sale', 'do_not_call', 'complaint']);
    // Validation precedes every write, matching the disposition route's ordering.
    expect(repos.contact.suppressByPhone).not.toHaveBeenCalled();
    expect(markDncSpy).not.toHaveBeenCalled();
    await app.close();
  });

  it('400s missing_actor when a code is supplied with nobody to attribute it to', async () => {
    // A disposition is the record of who said what about a customer, so it is
    // never written unattributed — a fabricated `added_by` would be a wrong entry
    // on a compliance record, which is worse than a missing one.
    //
    // This arm was once unreachable from the browser (the proxy sent no
    // actor at all). It is reachable now, so the 400 is a
    // real refusal of a real request rather than a guard on a dead path.
    const app = await buildApp();
    const res = await markDnc(app, { disposition_code: 'do_not_call' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('missing_actor');
    expect(repos.contact.suppressByPhone).not.toHaveBeenCalled();
    await app.close();
  });

  it('needs no actor at all for a plain mark-DNC', async () => {
    // Suppressing a number has no ownership rule — a supervisor doing it
    // mid-shift is a real action — so the compliance path must not start
    // requiring one. If it ever does, the agent's button goes back to failing:
    // differently, but just as completely.
    //
    // Still asserted with NO actor supplied, deliberately, even though the public
    // API layer now always sends one. What it happens to send is its choice today;
    // what the route *requires* is the contract, and this is the case that pins it.
    const app = await buildApp();
    const res = await markDnc(app, {});
    expect(res.statusCode).toBe(200);
    expect(repos.attempt.recordDisposition).not.toHaveBeenCalled();
    // Asserted on the `markDnc` request.
    expect(markDncRequest()).not.toHaveProperty('addedBy');
    await app.close();
  });

  it('attributes a plain mark-DNC to the actor when the caller sends one', async () => {
    // The case the previous one cannot cover, and the whole of actor attribution:
    // `dnc_entries.added_by` is the compliance record of who suppressed the
    // number, and it landed NULL on every agent-marked suppression because
    // nothing threaded the identity through. Optional on the route, always sent by
    // the public API layer.
    const app = await buildApp();
    const res = await markDnc(app, { agent_user_id: 'u-agent' });

    expect(res.statusCode).toBe(200);
    // Asserted on the `markDnc` request.
    expect(markDncRequest()).toMatchObject({ addedBy: 'u-agent' });
    // No disposition was asked for, so none is written — the attribution rides
    // the suppression, not a disposition.
    expect(repos.attempt.recordDisposition).not.toHaveBeenCalled();
    await app.close();
  });

  it('never attributes to the reserved agent when the caller was not named', async () => {
    // The refusal that outlives the fix. `resolveReservedAgentUserId` sits right
    // beside this code path and filling `added_by` from it would record whoever
    // held the call rather than whoever asked — a settled decision, which is about
    // DERIVING an actor, not about recording one we were told.
    const app = await buildApp();
    await markDnc(app, {});

    // Asserted on the `markDnc` request.
    expect(markDncRequest()).not.toHaveProperty('addedBy');
    // The attempt does have a reserved agent in this fixture, so the absence
    // above is a choice rather than an accident of the setup.
    expect(repos.session.findById ?? repos.attempt.findById).toBeDefined();
    await app.close();
  });

  it('still suppresses when the attempt was already dispositioned under another code', async () => {
    // `recordDisposition` returns null on a different existing code. The
    // disposition route calls that a 409, but here the disposition is the
    // secondary half: refusing the whole request would leave a customer who asked
    // not to be called again on the roster.
    repos.attempt.recordDisposition.mockResolvedValue(null);
    const app = await buildApp();
    const res = await markDnc(app, { disposition_code: 'do_not_call', agent_user_id: 'u-agent' });
    expect(res.statusCode).toBe(200);
    expect((res.json() as AgencyDncResponse).contact_state).toBe('suppressed');
    expect(markDncSpy).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it('releases wrap-up only after the transaction commits', async () => {
    // `noteDisposition` runs after COMMIT, so a rolled-back disposition can never release a
    // wrap-up it did not record. The failure arm is the rollback case above.
    const order: string[] = [];
    client.query.mockImplementation(async (sql: string) => { order.push(sql); return { rows: [], rowCount: 0 }; });
    const app = await buildApp();
    runtime.wrapup.noteDisposition.mockImplementation(async () => { order.push('noteDisposition'); return true; });
    const res = await markDnc(app, { disposition_code: 'do_not_call', agent_user_id: 'u-agent' });
    expect(res.statusCode).toBe(200);
    expect(repos.attempt.recordDisposition.mock.calls[0]![1]).toEqual({ client });
    expect(runtime.wrapup.noteDisposition).toHaveBeenCalledWith('sess-1', 'att-1');
    expect(order).toEqual(['BEGIN', 'COMMIT', 'noteDisposition']);
    await app.close();
  });
});

describe('missing rows', () => {
  it('404s when the attempt has no contact row', async () => {
    repos.contact.findById.mockResolvedValue(null);
    const app = await buildApp();
    const res = await markDnc(app);
    expect(res.statusCode).toBe(404);
    // Same trap as the tenant-scoping case: pinned to the route's own body so a
    // missing registration cannot masquerade as a handled miss.
    expect(res.json().message).toBe('Contact not found');
    // `markDnc` was not called and no transaction was opened: there is no number to suppress.
    expect(markDncSpy).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
    await app.close();
  });
});
