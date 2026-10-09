import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';


// ---------------------------------------------------------------------------
// The route's own behaviour.
//
// `disposition.test.ts` covers the pure rules. This covers what only the route
// can be wrong about: the ORDER the refusals come out in, the idempotent write,
// the contact write, and the wrap-up release. The property must hold where it is consumed, which is why it
// registers the real `agencyRoutes` against a real Fastify instance and issues
// real requests rather than calling the handler's parts — a validation order
// asserted on the helpers is not asserted where a client meets it.
//
// The repository is the double, because Postgres is not the subject. The
// idempotency PREDICATE is SQL and therefore not exercised here; it is asserted
// by inspecting the arguments the route hands the repository, and the guarded
// statement itself belongs to QA's integration tier where a real database can
// run two submissions concurrently.
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

// The tenancy headers are the platform's, not this ticket's. Authenticate
// everything and read the two ids straight off the headers.
vi.mock('../../../src/api/middleware/auth.middleware.js', () => ({
  authMiddleware: vi.fn(async () => { /* authenticated */ }),
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
      unclaim: vi.fn().mockResolvedValue(undefined),
      // Read to resolve the contact's own timezone before it
      // schedules a callback (D4). A callback is scheduled in the CUSTOMER's
      // window, so the route cannot answer from the campaign row alone.
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

import { agencyRoutes } from '../../../src/api/routes/agency.routes.js';
import { AUTO_DISPOSITION_CODE } from '../../../src/agency/disposition.js';
import type { AgencyDisposition } from '@magick-agency/contracts/agency';

const CATALOG: AgencyDisposition[] = [
  { code: 'sale', label: 'Sale', is_success: true },
  { code: 'not_interested', label: 'Not interested' },
  { code: 'complaint', label: 'Complaint', requires_note: true },
  { code: 'callback', label: 'Callback', requires_datetime: true },
];

/** The reserved agent's session, and the user id behind it. */
const SESSION = { id: 'sess-1', agent_user_id: 'u-agent', campaign_id: 'camp-1' };

function attemptRow(patch: Record<string, unknown> = {}) {
  return {
    id: 'att-1', campaign_id: 'camp-1', contact_id: 'contact-1',
    tenant_id: 't1', account_id: 'a1', attempt_number: 1,
    webrtc_call_id: 'call-1', caller_id: '+14155550100',
    reserved_agent_id: 'sess-1', state: 'ended', outcome: 'connected',
    disposition_code: null, notes: null, callback_at: null,
    dispositioned_by_user_id: null, dispositioned_at: null, dispositioned_on_behalf: false,
    dialed_at: new Date(), answered_at: new Date(), bridged_at: new Date(),
    ended_at: new Date(), talk_seconds: 42, wrapup_seconds: 30,
    created_at: new Date(), updated_at: new Date('2026-08-11T10:00:00.000Z'),
    ...patch,
  };
}

/** A runtime double — only the three surfaces the two routes actually touch. */
function makeRuntime() {
  return {
    replicaId: 'r1',
    agents: { get: vi.fn().mockResolvedValue({ state: 'available', attemptId: null, since: 1 }), set: vi.fn(), clear: vi.fn() },
    wrapup: { noteDisposition: vi.fn().mockResolvedValue(true), stateFor: vi.fn(() => null) },
    stations: { send: vi.fn(() => true), detach: vi.fn(), attach: vi.fn(), isLocallyOwned: vi.fn(() => true) },
    dialer: { hasLiveAttempt: vi.fn(() => false), noteStationClosed: vi.fn(), reattachStation: vi.fn(() => null), takeMissedRelease: vi.fn(() => null) },
    breaks: { queue: vi.fn(), take: vi.fn(() => null), cancel: vi.fn(() => false) },
    tokens: { mint: vi.fn(), verifyAndConsume: vi.fn() },
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

async function dispose(app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST', url: '/api/v1/agency/attempts/att-1/disposition',
    headers: HEADERS, payload,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  repos.attempt.findById.mockResolvedValue(attemptRow());
  // An all-day, every-day window by default. These cases are about
  // disposition semantics, and the migration-072 defaults (09:00–20:00 Mon–Fri)
  // would make every callback assertion depend on what time the suite ran.
  repos.campaign.findById.mockResolvedValue({
    id: 'camp-1', disposition_catalog: CATALOG,
    calling_window_start: '00:00:00', calling_window_end: '24:00:00',
    calling_days: [1, 2, 3, 4, 5, 6, 7], default_timezone: 'UTC',
  });
  repos.contact.findById.mockResolvedValue({ id: 'contact-1', timezone: null });
  repos.session.findById.mockResolvedValue(SESSION);
  // Default: the guarded UPDATE succeeded (first write or same-code replay).
  repos.attempt.recordDisposition.mockImplementation(async (p: any) =>
    attemptRow({ disposition_code: p.dispositionCode }));
  repos.attempt.saveNotes.mockImplementation(async (_id: string, notes: string) =>
    attemptRow({ notes }));
});

describe('POST /attempts/:id/disposition — the happy path and the contract shape', () => {
  it('records the disposition and returns every frozen field populated', async () => {
    const app = await buildApp();
    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'sale', notes: 'Upgraded' });

    expect(res.statusCode).toBe(200);
    // Asserted as the whole object, not field by field: a field silently dropped
    // from the response is exactly the drift a merged response would
    // break on, and a per-field assertion cannot see an absence.
    expect(res.json()).toEqual({
      attempt_id: 'att-1',
      contact_id: 'contact-1',
      campaign_id: 'camp-1',
      disposition_code: 'sale',
      contact_state: 'completed',
      next_attempt_at: null,
      // Additive: what the agent ASKED for, echoed separately so
      // `next_attempt_at` can be the instant we will actually dial rather than a
      // repeat of the request. Null here — no callback was requested.
      callback_requested_at: null,
      agent_state: 'available',
    });
    expect(repos.attempt.recordDisposition).toHaveBeenCalledWith(expect.objectContaining({
      attemptId: 'att-1', dispositionCode: 'sale', notes: 'Upgraded',
      callbackAt: null, actorUserId: 'u-agent', onBehalf: false,
    }));
  });

  it('leaves the contact `completed` and does not touch next_attempt_at', async () => {
    const app = await buildApp();
    await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'sale' });

    const [contactId, state, patch] = repos.contact.markState.mock.calls[0]!;
    expect([contactId, state]).toEqual(['contact-1', 'completed']);
    expect(patch.last_disposition).toBe('sale');
    expect(patch.next_attempt_at).toBeUndefined();
    // The attempt was already counted when it ended. Bumping here charges a
    // contact twice for one dial and, at `max_attempts: 3`, exhausts someone
    // after two real conversations.
    expect(patch.bump_attempt).toBeFalsy();
  });

  it('releases the wrap-up through the existing manager, keyed on BOTH ids', async () => {
    const app = await buildApp();
    await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'sale' });
    // Both arguments matter: `noteDisposition` no-ops unless that session is in
    // wrap-up for THAT attempt, which is what stops a supervisor dispositioning
    // an old call from pulling a live agent off a new one. Passing the session
    // alone would release whatever wrap-up the agent happens to be in now.
    expect(runtime.wrapup.noteDisposition).toHaveBeenCalledWith('sess-1', 'att-1');
  });

  it('reports agent_state as a snapshot read AFTER the release', async () => {
    // Advisory by contract, but it must still be the post-release read — a value
    // captured before `noteDisposition` would always say `wrapup` and a console
    // confirming the submission landed would see the state it was trying to leave.
    const app = await buildApp();
    const seen: string[] = [];
    runtime.wrapup.noteDisposition.mockImplementation(async () => { seen.push('release'); return true; });
    runtime.agents.get.mockImplementation(async () => {
      seen.push('read');
      return { state: 'available', attemptId: null, since: 1 };
    });
    await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'sale' });
    expect(seen).toEqual(['release', 'read']);
  });
});

describe('POST /attempts/:id/disposition — idempotency', () => {
  it('same code is an idempotent 200, with notes last-write-wins', async () => {
    // The rule that matters most to a submit path, and not the obvious one. An
    // agent presses Submit, the network blips, the console retries — a strict
    // conflict would show them an error for an action that succeeded, on the one
    // interaction whose whole purpose is recording what was said to a customer.
    const app = await buildApp();
    repos.attempt.findById.mockResolvedValue(attemptRow({ disposition_code: 'sale', notes: 'first' }));
    repos.attempt.recordDisposition.mockResolvedValue(attemptRow({ disposition_code: 'sale', notes: 'corrected' }));

    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'sale', notes: 'corrected' });

    expect(res.statusCode).toBe(200);
    expect(res.json().disposition_code).toBe('sale');
    // A replay is deliberately NOT flagged: it is a success from the agent's
    // side, and a client rendering it differently reports a network detail they
    // cannot act on. So the body must be indistinguishable from a first write.
    expect(Object.keys(res.json()).sort())
      .toEqual(['agent_state', 'attempt_id', 'callback_requested_at', 'campaign_id', 'contact_id',
        'contact_state', 'disposition_code', 'next_attempt_at']);
    expect(repos.attempt.recordDisposition).toHaveBeenCalledWith(
      expect.objectContaining({ notes: 'corrected' }),
    );
  });

  it('a DIFFERENT code is 409 already_dispositioned and writes nothing further', async () => {
    // Silently rewriting the record of a customer conversation is not a retry.
    const app = await buildApp();
    repos.attempt.findById.mockResolvedValue(attemptRow({ disposition_code: 'sale' }));
    // The guarded predicate matched no row — which happens ONLY on a different code.
    repos.attempt.recordDisposition.mockResolvedValue(null);

    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'not_interested' });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('already_dispositioned');
    // The refusal must be total: a contact moved or a wrap-up released on a
    // rejected submission leaves the agent returned to the pool with the call
    // still unwritten-up.
    expect(repos.contact.markState).not.toHaveBeenCalled();
    expect(runtime.wrapup.noteDisposition).not.toHaveBeenCalled();
  });

  it('the route never reads the incumbent code to decide — the WRITE decides', async () => {
    // If the route branched on `findById`'s
    // `disposition_code`, this test would supply the answer it claims to check:
    // here the row says `sale` and the write SUCCEEDS, which can only happen if
    // the decision came from the guarded statement. A read-then-write route
    // would 409 on this and fail.
    const app = await buildApp();
    repos.attempt.findById.mockResolvedValue(attemptRow({ disposition_code: 'sale' }));
    repos.attempt.recordDisposition.mockResolvedValue(attemptRow({ disposition_code: 'not_interested' }));

    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'not_interested' });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /attempts/:id/disposition — callback_at is honoured, not just captured', () => {
  const FUTURE = new Date(Date.now() + 86_400_000).toISOString();

  it('sends the contact back to pending, scheduled for the requested time when it is dialable', async () => {
    // `requires_datetime` is already reachable, so capturing the datetime and
    // acting on nothing would mean an agent tells a customer "we'll call you back
    // Tuesday" and nothing ever does.
    //
    // The campaign's window is all-day here, so the requested time IS dialable and
    // the scheduled time equals it. The pair below is what makes the next test
    // meaningful: the two fields agreeing is a result, not a tautology.
    const app = await buildApp();
    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'callback', callback_at: FUTURE });

    expect(res.statusCode).toBe(200);
    expect(res.json().contact_state).toBe('pending');
    expect(res.json().next_attempt_at).toBe(FUTURE);
    expect(res.json().callback_requested_at).toBe(FUTURE);

    const [, state, patch] = repos.contact.markState.mock.calls[0]!;
    expect(state).toBe('pending');
    expect(patch.next_attempt_at.toISOString()).toBe(FUTURE);
  });

  it('binds the callback to nobody — it goes to the pool (D11)', async () => {
    // The ratified decision. Nothing in the write may carry the originating
    // session, or agent-facing copy would have to say "I'll call you back".
    const app = await buildApp();
    await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'callback', callback_at: FUTURE });
    const patch = repos.contact.markState.mock.calls[0]![2];
    expect(Object.keys(patch)).not.toContain('preferred_agent_user_id');
    expect(JSON.stringify(patch)).not.toContain('sess-1');
  });

  // ── a callback lands on a time we can actually dial ──────────
  //
  // The whole content of the ticket, and the reason it is not just "store the
  // datetime". An agent says the time OUT LOUD to a customer. If the response
  // echoes a `callback_at` the pre-dial gate will later refuse, the console has
  // promised "Saturday at ten" on a Mon–Fri campaign through the agent's mouth,
  // and nothing in the system ever notices.
  describe('outside the calling window, the promise is corrected rather than echoed', () => {
    /** Fri 2026-08-14, 12:00 IST — a clock, so the instants below are exact. */
    const NOW = new Date('2026-08-14T06:30:00Z');
    /** Sat 2026-08-15, 10:00 IST — the agent's "call me Saturday morning". */
    const SATURDAY_10AM = '2026-08-15T04:30:00.000Z';

    beforeEach(() => {
      // ONLY `Date` is faked. Faking the timer functions too makes `app.inject`
      // hang — Fastify's request lifecycle waits on real timers — and the failure
      // presents as a 5s test timeout rather than as anything to do with clocks.
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(NOW);
      // A Mon–Fri, 09:00–20:00 IST campaign: Saturday is not dialable at all.
      repos.campaign.findById.mockResolvedValue({
        id: 'camp-1', disposition_catalog: CATALOG,
        calling_window_start: '09:00:00', calling_window_end: '20:00:00',
        calling_days: [1, 2, 3, 4, 5], default_timezone: 'Asia/Kolkata',
      });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('schedules the next window open and reports THAT, with the request echoed separately', async () => {
      const app = await buildApp();
      const res = await dispose(app, {
        agent_user_id: 'u-agent', disposition_code: 'callback', callback_at: SATURDAY_10AM,
      });

      expect(res.statusCode).toBe(200);
      // Mon 2026-08-17 09:00 IST. Exact, because "some time after Saturday" is
      // satisfied by Saturday 10:01 — which is still Saturday.
      expect(res.json().next_attempt_at).toBe('2026-08-17T03:30:00.000Z');
      // And the request survives, labelled as the request, so the console can say
      // "you asked for Saturday 10am — we'll call Monday at 9" instead of picking one.
      expect(res.json().callback_requested_at).toBe(SATURDAY_10AM);
      expect(res.json().next_attempt_at).not.toBe(res.json().callback_requested_at);

      // The CONTACT is scheduled for when we will dial...
      const patch = repos.contact.markState.mock.calls[0]![2];
      expect(patch.next_attempt_at.toISOString()).toBe('2026-08-17T03:30:00.000Z');
      // ...and the ATTEMPT keeps what was promised. Two different facts, and the
      // audit needs both: what the agent said, and what we scheduled.
      expect(repos.attempt.recordDisposition).toHaveBeenCalledWith(expect.objectContaining({
        callbackAt: new Date(SATURDAY_10AM),
      }));
    });

    it('uses the CONTACT timezone, not the campaign default', async () => {
      // D4 all the way through the callback path. 04:30Z is 10:00 IST — a Saturday
      // either way — but the next Monday 09:00 is a different instant in New York
      // than in Kolkata, and it is the customer's morning that matters.
      repos.contact.findById.mockResolvedValue({ id: 'contact-1', timezone: 'America/New_York' });
      const app = await buildApp();
      const res = await dispose(app, {
        agent_user_id: 'u-agent', disposition_code: 'callback', callback_at: SATURDAY_10AM,
      });

      // Mon 2026-08-17 09:00 EDT = 13:00Z, nine and a half hours after 09:00 IST.
      expect(res.json().next_attempt_at).toBe('2026-08-17T13:00:00.000Z');
    });

    it('falls back to the requested time when the window is unusable, rather than inventing one', async () => {
      // An unreadable campaign timezone has no computable next opening. The gate
      // parks such a contact and is the authority; fabricating an instant here
      // would be a second, quieter lie on top of the first.
      repos.campaign.findById.mockResolvedValue({
        id: 'camp-1', disposition_catalog: CATALOG,
        calling_window_start: '09:00:00', calling_window_end: '20:00:00',
        calling_days: [1, 2, 3, 4, 5], default_timezone: 'Not/AZone',
      });
      const app = await buildApp();
      const res = await dispose(app, {
        agent_user_id: 'u-agent', disposition_code: 'callback', callback_at: SATURDAY_10AM,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().next_attempt_at).toBe(SATURDAY_10AM);
    });

    it('still schedules when the contact row cannot be read', async () => {
      // A DB blip on the contact read must not fail an agent's disposition — the
      // conversation is over and the write is the record of it. The campaign
      // default zone applies, which is D4's own fallback.
      repos.contact.findById.mockRejectedValue(new Error('connection terminated'));
      const app = await buildApp();
      const res = await dispose(app, {
        agent_user_id: 'u-agent', disposition_code: 'callback', callback_at: SATURDAY_10AM,
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().next_attempt_at).toBe('2026-08-17T03:30:00.000Z');
    });
  });

  it('refuses a past callback rather than promising a call that already happened', async () => {
    const app = await buildApp();
    const res = await dispose(app, {
      agent_user_id: 'u-agent', disposition_code: 'callback',
      callback_at: new Date(Date.now() - 3600_000).toISOString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('invalid_callback_at');
    expect(repos.attempt.recordDisposition).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Disposition precedence, asserted WHERE THE PRECEDENCE IS
// CONSUMED.
//
// `disposition-policy.test.ts` proves `resolveDispositionDecision` in isolation.
// That is not enough: the rule is that a disposition
// overrides the OUTCOME policy, and the only place both exist is this route.
// Whether the property is true where it is consumed, not only
// where it is implemented, is the whole reason for this block. A route that
// computed the right decision and then wrote `callbackAt ? 'pending' :
// 'completed'` anyway (the earlier default, since replaced) would keep
// every policy-level test green.
//
// The default `CATALOG` above carries no `retry`, `terminal` or `suppress` entry
// at all, so none of these arms was reachable from this file before.
// ═══════════════════════════════════════════════════════════════════════════

describe('POST /attempts/:id/disposition — precedence over the outcome policy', () => {
  /** A clock, so `now + delay_minutes` is an exact instant rather than a window. */
  const NOW = new Date('2026-08-11T10:00:00.000Z');

  /** The built-in catalog block — the three built-ins carrying their real flags. */
  const SEMANTIC_CATALOG: AgencyDisposition[] = [
    { code: 'voicemail', label: 'Voicemail', retry: { delay_minutes: 240, max_attempts: 2 } },
    { code: 'not_interested', label: 'Not interested', terminal: true },
    { code: 'do_not_call', label: 'Do not call', suppress: true },
  ];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    repos.campaign.findById.mockResolvedValue({
      id: 'camp-1', disposition_catalog: SEMANTIC_CATALOG,
      calling_window_start: '00:00:00', calling_window_end: '24:00:00',
      calling_days: [1, 2, 3, 4, 5, 6, 7], default_timezone: 'UTC',
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) a `voicemail` retry beats `connected` being terminal by outcome policy', async () => {
    // The ticket's headline case, and the one D1 forces to exist: with AMD off the
    // carrier reports a voicemail pickup as `connected`, whose DEFAULT outcome rule
    // is `max_attempts: 0`. So the outcome policy's answer is "never call again"
    // and the agent's disposition's answer is "in four hours" — a cell where the
    // two halves genuinely disagree, which is what makes this assertion able to
    // fail.
    //
    // The attempt row's `outcome` is `connected` (the `attemptRow` default), and
    // one attempt of the two allowed is used.
    repos.contact.findById.mockResolvedValue({ id: 'contact-1', timezone: null, attempt_count: 1 });
    const app = await buildApp();
    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'voicemail' });

    expect(res.statusCode).toBe(200);
    // NOT `completed`, which is what the outcome policy alone would have produced.
    expect(res.json().contact_state).toBe('pending');
    // Exact, off the injected clock: 240 minutes.
    expect(res.json().next_attempt_at).toBe('2026-08-11T14:00:00.000Z');
    // A retry is not a callback. The console tells the two apart on this field, so
    // a retry leaking into it would render as a promise the agent never made.
    expect(res.json().callback_requested_at).toBeNull();

    const [, state, patch] = repos.contact.markState.mock.calls[0]!;
    expect(state).toBe('pending');
    expect(patch.next_attempt_at.toISOString()).toBe('2026-08-11T14:00:00.000Z');
    expect(patch.last_disposition).toBe('voicemail');
  });

  it('(a) the same `voicemail` code goes to `exhausted` ON its own attempts boundary', async () => {
    // The companion the criterion needs to be non-vacuous: if the retry arm fired
    // regardless of the budget, the case above would pass for the wrong reason.
    // `max_attempts: 2` with two used is ON the boundary, not past it — the case
    // an off-by-one actually lands on.
    repos.contact.findById.mockResolvedValue({ id: 'contact-1', timezone: null, attempt_count: 2 });
    const app = await buildApp();
    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'voicemail' });

    expect(res.statusCode).toBe(200);
    // `exhausted`, not `completed`: a supervisor reads the first as "we worked this
    // list" and the second as "it was never retryable".
    expect(res.json().contact_state).toBe('exhausted');
    expect(repos.contact.markState.mock.calls[0]![1]).toBe('exhausted');
  });

  it('(b) a `terminal` disposition ends the contact with attempts still remaining', async () => {
    // Criterion (b): "regardless of attempts remaining". One attempt used
    // of a budget that would otherwise allow more, so `terminal` is demonstrably
    // the thing that stopped it rather than the arithmetic.
    //
    // ⚠️ This case CONVERGES with the earlier `callbackAt ? 'pending' : 'completed'`
    // — both answer `completed` — so on its own it cannot tell "terminal decided"
    // from "the old default decided". Measured, not assumed: reverting the route to
    // that line reds the other three arms in this block and leaves this one green.
    // It is kept because it is the criterion as written; the test below is the one
    // that makes the criterion load-bearing.
    repos.contact.findById.mockResolvedValue({ id: 'contact-1', timezone: null, attempt_count: 1 });
    const app = await buildApp();
    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'not_interested' });

    expect(res.statusCode).toBe(200);
    expect(res.json().contact_state).toBe('completed');
    expect(res.json().next_attempt_at).toBeNull();
    expect(repos.contact.markState.mock.calls[0]![1]).toBe('completed');
  });

  it('(b) `terminal` BEATS a callback on the same submission, where the two answers differ', async () => {
    // The falsifiable form of (b), and a reachable submission rather than a
    // contrived one: `callback_at` is only *required* by `requires_datetime`, never
    // *refused* without it, so a console with a sticky datetime field or a
    // supervisor correcting a code without clearing the time produces exactly this.
    //
    // The earlier line answers `pending` here; the precedence rule answers `completed`.
    // A cell where the two halves genuinely disagree is the only kind that can
    // falsify the precedence claim.
    repos.contact.findById.mockResolvedValue({ id: 'contact-1', timezone: null, attempt_count: 1 });
    const app = await buildApp();
    const res = await dispose(app, {
      agent_user_id: 'u-agent', disposition_code: 'not_interested',
      callback_at: '2026-08-12T10:00:00.000Z',
    });

    expect(res.statusCode).toBe(200);
    // Resolved toward silence: the direction that cannot annoy a customer an
    // operator has already marked done.
    expect(res.json().contact_state).toBe('completed');
    expect(repos.contact.markState.mock.calls[0]![1]).toBe('completed');
    // ── The losing arm must not leave its instant behind ──────────────────
    // Measured defect, fixed with this test: `scheduledAt` is derived from the
    // callback arm, and when that arm LOSES its instant was still written and
    // returned — a contact marked `completed` reporting a dial time of
    // 2026-08-12T10:00Z. The agent's console would show a promise the precedence
    // had just cancelled. The request is still echoed on `callback_requested_at`,
    // which is where "what was asked for" belongs.
    expect(res.json().next_attempt_at).toBeNull();
    expect(res.json().callback_requested_at).toBe('2026-08-12T10:00:00.000Z');
    expect(repos.contact.markState.mock.calls[0]![2].next_attempt_at).toBeUndefined();
  });

  it('`suppress` with a callback on the same submission schedules NOTHING', async () => {
    // The same defect on the arm where it matters most. `callback_at` is accepted
    // on any code, so "do not call me again" submitted from a console whose
    // datetime field was already filled used to write a future dial instant onto a
    // suppressed contact. Inert for dialing (`claimDialable` gates on `pending`),
    // but it is the DNC arm reporting a next call, which is the one field a
    // compliance reviewer would stop on.
    repos.contact.findById.mockResolvedValue({ id: 'contact-1', timezone: null, attempt_count: 1 });
    const app = await buildApp();
    const res = await dispose(app, {
      agent_user_id: 'u-agent', disposition_code: 'do_not_call',
      callback_at: '2026-08-12T10:00:00.000Z',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().contact_state).toBe('suppressed');
    expect(res.json().next_attempt_at).toBeNull();
    const patch = repos.contact.markState.mock.calls[0]![2];
    expect(patch.next_attempt_at).toBeUndefined();
    expect(patch.suppressed_reason).toBe('dnc');
  });

  it('`suppress` sends the contact to `suppressed` and records the DNC reason', async () => {
    // Not a numbered criterion, but the arm with the compliance consequence: this
    // is the agent-side entry point to the DNC path, and `suppressed_reason` is
    // what a regulator-facing export reads.
    repos.contact.findById.mockResolvedValue({ id: 'contact-1', timezone: null, attempt_count: 1 });
    const app = await buildApp();
    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'do_not_call' });

    expect(res.statusCode).toBe(200);
    expect(res.json().contact_state).toBe('suppressed');
    const [, state, patch] = repos.contact.markState.mock.calls[0]!;
    expect(state).toBe('suppressed');
    expect(patch.suppressed_reason).toBe('dnc');
  });

  it('reads the attempt count ONLY when the decision can turn on it', async () => {
    // The route gates its `findById` on `entry.retry && !callbackAt`, so the common
    // path costs no query. Asserted because the `0` every other arm is handed is
    // inert TODAY and would silently become load-bearing if an arm later started
    // consulting `attemptsUsed` — the read would be absent exactly where it began
    // to matter.
    repos.contact.findById.mockResolvedValue({ id: 'contact-1', timezone: null, attempt_count: 1 });
    const app = await buildApp();

    await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'not_interested' });
    expect(repos.contact.findById).not.toHaveBeenCalled();

    repos.contact.findById.mockClear();
    await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'voicemail' });
    expect(repos.contact.findById).toHaveBeenCalledWith('contact-1');
  });

  it('a DB blip on the attempt count schedules a retry rather than failing the write', async () => {
    // The conversation is over and this write is the only record of it, so the read
    // is `.catch(() => null)`. The fallback is 0 — permissive on purpose: it
    // schedules a retry rather than declaring a budget spent on no evidence.
    repos.contact.findById.mockRejectedValue(new Error('connection terminated'));
    const app = await buildApp();
    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'voicemail' });

    expect(res.statusCode).toBe(200);
    expect(res.json().contact_state).toBe('pending');
    expect(res.json().next_attempt_at).toBe('2026-08-11T14:00:00.000Z');
  });
});

describe('POST /attempts/:id/disposition — refusals, and the order they come in', () => {
  it('the ownership rule is checked BEFORE the catalog', async () => {
    // Order is the thing only the route can get wrong, and this one is a leak: a
    // caller with no business here must not learn the campaign's catalog from the
    // `allowed_codes` echo on a validation error.
    const app = await buildApp();
    const res = await dispose(app, { agent_user_id: 'u-other', disposition_code: 'nonsense' });

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('not_your_attempt');
    expect(res.json().allowed_codes, 'the catalog leaked to a non-owner').toBeUndefined();
  });

  it('dispositionability is checked before the submitted code is validated', async () => {
    // Telling an agent "unknown code" about a call that can never be
    // dispositioned is a misleading first answer — they would go fix the code.
    const app = await buildApp();
    repos.attempt.findById.mockResolvedValue(attemptRow({ bridged_at: null, outcome: 'no_answer' }));
    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'nonsense' });

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('attempt_not_dispositionable');
  });

  it('an auto-closed attempt is refused DISTINCTLY from an already-dispositioned one', async () => {
    const app = await buildApp();
    repos.attempt.findById.mockResolvedValue(attemptRow({ disposition_code: AUTO_DISPOSITION_CODE }));
    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'sale' });
    // The console offers "this call was auto-closed", not "you already did this".
    expect(res.json().code).toBe('attempt_not_dispositionable');
  });

  it('an unknown code 400s WITH the valid set echoed', async () => {
    const app = await buildApp();
    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'nonsense' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('unknown_disposition_code');
    // The echo is what lets a console holding a stale catalog recover in one
    // round trip instead of stranding the agent mid-shift.
    expect(res.json().allowed_codes).toEqual(['sale', 'not_interested', 'complaint', 'callback']);
  });

  it('enforces requires_note and requires_datetime server-side', async () => {
    // Both are ALSO enforced in the console, and the duplication is the point:
    // they are operator config, a console can hold a stale catalog for a whole
    // shift, and the server is the only place the requirement is really true.
    const app = await buildApp();
    const noNote = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'complaint' });
    expect([noNote.statusCode, noNote.json().code]).toEqual([400, 'note_required']);

    const noDate = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'callback' });
    expect([noDate.statusCode, noDate.json().code]).toEqual([400, 'datetime_required']);
    expect(repos.attempt.recordDisposition).not.toHaveBeenCalled();
  });

  it('a missing actor is 400 missing_actor, not an anonymous write', async () => {
    const app = await buildApp();
    const res = await dispose(app, { disposition_code: 'sale' });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe('missing_actor');
    expect(repos.attempt.recordDisposition).not.toHaveBeenCalled();
  });

  it('a supervisor on_behalf is allowed and the on-behalf fact is RECORDED', async () => {
    const app = await buildApp();
    const res = await dispose(app, { agent_user_id: 'u-super', on_behalf: true, disposition_code: 'sale' });

    expect(res.statusCode).toBe(200);
    expect(repos.attempt.recordDisposition).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 'u-super', onBehalf: true,
    }));
    // And the reserved agent is untouched — the conversation stays attributed to
    // whoever had it, or the agent vanishes from their own numbers.
    expect(repos.attempt.recordDisposition.mock.calls[0]![0])
      .not.toHaveProperty('reservedAgentId');
  });

  it('another tenant\'s attempt is a 404, never a 403', async () => {
    // Whether an attempt id exists in another tenant is not a fact this caller
    // may learn. Distinct from `not_your_attempt`, which is a 403 *within* the
    // caller's own account.
    const app = await buildApp();
    repos.attempt.findById.mockResolvedValue(attemptRow({ tenant_id: 'other-tenant' }));
    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'sale' });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBeUndefined();
  });

  it('the feature flag gates the route with feature_disabled', async () => {
    const app = await buildApp();
    flags.isEnabled.mockResolvedValue(false);
    const res = await dispose(app, { agent_user_id: 'u-agent', disposition_code: 'sale' });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('feature_disabled');
    expect(repos.attempt.findById, 'the flag was checked after the DB read').not.toHaveBeenCalled();
  });
});

describe('POST /attempts/:id/notes', () => {
  async function saveNotes(app: Awaited<ReturnType<typeof buildApp>>, payload: Record<string, unknown>) {
    return app.inject({
      method: 'POST', url: '/api/v1/agency/attempts/att-1/notes',
      headers: HEADERS, payload,
    });
  }

  it('saves notes and returns the frozen shape', async () => {
    const app = await buildApp();
    const res = await saveNotes(app, { agent_user_id: 'u-agent', notes: 'Customer is on holiday' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      attempt_id: 'att-1',
      notes: 'Customer is on holiday',
      updated_at: '2026-08-11T10:00:00.000Z',
    });
  });

  it('accepts notes on an attempt that is still LIVE and never bridged', async () => {
    // Agents type while the customer is talking, so notes cannot be gated on the
    // same dispositionability check the submit uses — `bridged_at` may not exist
    // yet on a call the agent is already writing into.
    const app = await buildApp();
    repos.attempt.findById.mockResolvedValue(attemptRow({ state: 'bridged', bridged_at: null, ended_at: null }));
    const res = await saveNotes(app, { agent_user_id: 'u-agent', notes: 'mid-call' });
    expect(res.statusCode).toBe(200);
  });

  it('accepts notes on an AUTO-CLOSED attempt', async () => {
    // Where what the agent wrote is the only record of the conversation left.
    const app = await buildApp();
    repos.attempt.findById.mockResolvedValue(attemptRow({ disposition_code: AUTO_DISPOSITION_CODE }));
    expect((await saveNotes(app, { agent_user_id: 'u-agent', notes: 'late' })).statusCode).toBe(200);
  });

  it('an empty string clears the notes, rather than being rejected as absent', async () => {
    const app = await buildApp();
    const res = await saveNotes(app, { agent_user_id: 'u-agent', notes: '' });
    expect(res.statusCode).toBe(200);
    expect(repos.attempt.saveNotes).toHaveBeenCalledWith('att-1', '');
  });

  it('does NOT release the wrap-up and does NOT satisfy requires_disposition', async () => {
    // Per the contract. An autosave that ended wrap-up would return the agent to
    // the pool mid-typing and the disposition would never be recorded.
    const app = await buildApp();
    await saveNotes(app, { agent_user_id: 'u-agent', notes: 'typing' });
    expect(runtime.wrapup.noteDisposition).not.toHaveBeenCalled();
    expect(repos.contact.markState).not.toHaveBeenCalled();
  });

  it('applies the same ownership rule as the submit', async () => {
    const app = await buildApp();
    expect((await saveNotes(app, { notes: 'x' })).json().code).toBe('missing_actor');
    expect((await saveNotes(app, { agent_user_id: 'u-other', notes: 'x' })).json().code).toBe('not_your_attempt');
    expect((await saveNotes(app, { agent_user_id: 'u-super', on_behalf: true, notes: 'x' })).statusCode).toBe(200);
  });
});
