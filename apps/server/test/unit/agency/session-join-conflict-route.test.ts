import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// ---------------------------------------------------------------------------
// `POST /agency/sessions` — the 409 that the one-live-session constraint makes reachable.
//
// ── What this file is for ──────────────────────────────────────────────────
//
// The constraint stops one human holding two live sessions (the reservation CAS key is
// per SESSION — `agency:agent:{sessionId}:state` — so two sessions are two
// independently reservable agents and one pair of ears). The database now
// refuses the second join, and this route is where that refusal becomes
// something an agent can act on.
//
// The *refusal itself* is Postgres's and is proven against a real database in
// `test/integration/agency/agency-session-tenant-unique.test.ts`. What is
// proven HERE is everything between the repository result and the wire, because
// that is where the refusal stops being actionable if it is got wrong:
//
//   * the status is 409 and the body carries the OTHER campaign's id and NAME —
//     the public API layer forwards this unchanged and the console renders it, so an id-only body is
//     an error message the agent cannot act on;
//   * `message` says the useful thing ON ITS OWN. The body is an
//     `AgencyActionErrorResponse`, and until the new code is mirrored in
//     `AGENCY_ACTION_ERROR_CODES` the error mask replaces unknown codes with
//     "contact support and quote this request id" — so the structured fields are
//     the ceiling and this sentence is the floor;
//   * the state comes from REDIS, not the durable mirror, because it is what
//     tells the agent whether leaving that station is safe right now;
//   * no station token is minted and no bootstrap is built on the refusal path —
//     a console that received a session id here would open a socket for a
//     session it does not hold;
//   * the mismatch assertion: a bootstrap must never echo the requested campaign
//     while the row points at another.
//
// FALSIFICATION: point `joinOrRehydrate` at `{ ok: true }` and every case here
// fails; drop the `campaign_name` lookup and the first case fails alone.
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
    attempt: { findById: vi.fn(), findPriorForContactLineage: vi.fn().mockResolvedValue([]) },
    campaign: { findById: vi.fn() },
    contact: { findById: vi.fn() },
    session: { findById: vi.fn(), joinOrRehydrate: vi.fn(), setState: vi.fn(), leave: vi.fn() },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyCampaignRepository: repos.campaign,
  agencyContactRepository: repos.contact,
  agencyAgentSessionRepository: repos.session,
}));

import { agencyRoutes } from '../../../src/api/routes/agency.routes.js';

const REQUESTED = {
  id: 'camp-new', tenant_id: 't1', account_id: 'a1', name: 'Winback',
  status: 'running', disposition_catalog: [], wrapup_seconds: 30,
  wrapup_auto_return: true, record_calls: true, break_reasons: null, context_display: {},
};

const OTHER = { ...REQUESTED, id: 'camp-old', name: 'Q3 Renewals' };

/** The live session the agent still holds on `camp-old`. */
function liveSession(patch: Record<string, unknown> = {}) {
  return {
    id: 'sess-old', tenant_id: 't1', account_id: 'a1',
    campaign_id: 'camp-old', agent_user_id: 'u-agent',
    state: 'break', break_reason: null, state_since: new Date(),
    owner_replica: 'r1', last_heartbeat: new Date(),
    joined_at: new Date(), left_at: null, created_at: new Date(), updated_at: new Date(),
    ...patch,
  };
}

const mint = vi.fn();
const agentsGet = vi.fn();

function makeRuntime() {
  return {
    replicaId: 'r1',
    agents: { get: agentsGet, set: vi.fn(), clear: vi.fn() },
    wrapup: { stateFor: vi.fn(() => null) },
    stations: { send: vi.fn(() => true), attach: vi.fn(), detach: vi.fn(), isLocallyOwned: vi.fn(() => true) },
    dialer: { hasLiveAttempt: vi.fn(() => false), noteStationClosed: vi.fn(), reattachStation: vi.fn(() => null) },
    breaks: { queue: vi.fn(), take: vi.fn(() => null), cancel: vi.fn(() => false) },
    tokens: { mint, verifyAndConsume: vi.fn() },
    rehydrateAgent: vi.fn().mockResolvedValue('break'),
    releaseStationOnClose: vi.fn().mockResolvedValue(true),
  };
}

const HEADERS = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };

let app: Awaited<ReturnType<typeof buildApp>>;

async function buildApp() {
  const instance = Fastify();
  await instance.register((a) => agencyRoutes(a as never, makeRuntime() as never), {
    prefix: '/api/v1/agency',
  });
  await instance.ready();
  return instance;
}

async function join(payload: Record<string, unknown> = { campaign_id: 'camp-new', agent_user_id: 'u-agent' }) {
  return app.inject({ method: 'POST', url: '/api/v1/agency/sessions', headers: HEADERS, payload });
}

beforeEach(async () => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  repos.campaign.findById.mockImplementation(async (id: string) =>
    id === 'camp-new' ? REQUESTED : id === 'camp-old' ? OTHER : null);
  mint.mockResolvedValue({ token: 'tok', expiresAt: new Date('2026-08-16T12:02:00.000Z') });
  agentsGet.mockResolvedValue(null);
  app = await buildApp();
});

describe('POST /sessions — agent already live on another campaign', () => {
  it('409s with the code, id and NAME of the campaign they must leave', async () => {
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession(),
    });

    const res = await join();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Conflict',
      code: 'session_on_other_campaign',
      message: expect.stringContaining('Q3 Renewals'),
      campaign_id: 'camp-old',
      campaign_name: 'Q3 Renewals',
      state: 'break',
    });
  });

  it('carries a `message` that is still useful with the structured fields stripped', async () => {
    // `message` is the FLOOR, not the ceiling. The error mask is keyed on
    // `AGENCY_ACTION_ERROR_CODES` and rewrites codes it has not mirrored into
    // "contact support and quote this request id"; a generic client error handler
    // shows `message` and nothing else. Either way an agent whose console never
    // learned this code still has to be told which station to leave.
    //
    // Asserted on CONTENT, not presence: a `message` of "Conflict" satisfies the
    // shape and none of the purpose.
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession(),
    });

    const { message } = (await join()).json();

    expect(message).toContain('Q3 Renewals');   // which station
    expect(message).toMatch(/leave/i);          // and what to do about it
    // Never the campaign they were trying to join. Telling an agent to leave the
    // station they are asking for is the one wording that cannot be acted on.
    expect(message).not.toContain('Winback');
  });

  it('is an `AgencyActionErrorResponse`, so a generic agency error handler reads it', async () => {
    // One error vocabulary on these routes, not two — this fails if the conflict
    // body ever drifts back into a shape of its own.
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession(),
    });

    const body = (await join()).json();

    for (const field of ['error', 'code', 'message']) {
      expect(typeof body[field], `${field} missing from the shared error shape`).toBe('string');
    }
  });

  it('reports the state from REDIS, not from the durable mirror', async () => {
    // The row says `break`; Redis holds a live `on_call` lease. Reporting the row
    // would tell an agent mid-conversation that leaving is a single click, which
    // is the same "derive availability from the mirror" mistake that
    // already cost this route once.
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession({ state: 'break' }),
    });
    agentsGet.mockResolvedValue({ state: 'on_call', attemptId: 'att-1', since: 1 });

    const res = await join();

    expect(res.statusCode).toBe(409);
    expect(res.json().state).toBe('on_call');
    expect(agentsGet).toHaveBeenCalledWith('sess-old');
  });

  it('falls back to the row when Redis has no key for that session', async () => {
    // No key means no lease, so nothing is in flight — the closest truthful
    // reading. Failing the request here would hide a conflict the agent can
    // actually resolve behind an error they cannot.
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession({ state: 'available' }),
    });
    agentsGet.mockResolvedValue(null);

    expect((await join()).json().state).toBe('available');
  });

  it('mints no station token and returns no session id on the refusal', async () => {
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession(),
    });

    const res = await join();

    // A console handed a session id here would open a station socket against a
    // session it was just refused.
    expect(res.json().session_id).toBeUndefined();
    expect(res.json().station_ws_url).toBeUndefined();
    expect(mint).not.toHaveBeenCalled();
  });

  it('is inert — the refusal seeds no lease and touches no session state', async () => {
    // A 409 that had already seeded a Redis lease for the OTHER session would
    // rewrite the state of a station the agent may be mid-conversation on, from a
    // request about a different campaign entirely — and `set` restamps `since`,
    // which is the idle clock the tick's fairness ordering sorts on. The only Redis
    // call on this path may be the READ that fills in `state`.
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession(),
    });

    const res = await join();

    expect(res.statusCode).toBe(409);
    expect(agentsGet).toHaveBeenCalledTimes(1);
    expect(repos.session.setState).not.toHaveBeenCalled();
    expect(repos.session.leave).not.toHaveBeenCalled();
  });

  it('still 409s when the NAME LOOKUP ITSELF fails', async () => {
    // The `.catch` on `agencyCampaignRepository.findById`, which exists for exactly
    // one reason: this lookup is cosmetic. It runs only to make the refusal
    // readable, and letting it reject would turn a 409 the agent can act on — leave
    // the other station — into a 500 they cannot, over a name. `campaign_id` below
    // already carries everything the console needs to route them.
    //
    // Reachable in the ordinary way a database is reachable: a connection blip, a
    // statement timeout under load. Not exotic, and distinct from the `null` case
    // below, which is the row being absent rather than the read failing.
    repos.campaign.findById.mockImplementation(async (id: string) => {
      if (id === 'camp-new') return REQUESTED;
      throw new Error('connection terminated unexpectedly');
    });
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession(),
    });

    const res = await join();

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('session_on_other_campaign');
    // The id is the part that is not cosmetic, and it comes from the session row
    // rather than from the failed lookup.
    expect(res.json().campaign_id).toBe('camp-old');
    expect(typeof res.json().campaign_name).toBe('string');
    expect(res.json().message).toMatch(/leave/i);
    expect(mint).not.toHaveBeenCalled();
  });

  it('does not name a campaign belonging to ANOTHER tenant', async () => {
    // `findById` is unscoped, so the row it returns has to be checked against
    // something. The right scope is the constraint's: the tenant. A campaign coming
    // back under a different tenant can only be a corrupt row or a repurposed id,
    // and putting its name in this body would leak across the boundary every query is scoped
    // on — into an error message the public API layer forwards unchanged and the
    // console renders to an agent.
    repos.campaign.findById.mockImplementation(async (id: string) =>
      (id === 'camp-new' ? REQUESTED : { ...OTHER, tenant_id: 'someone-else', name: 'Rival Tenant Collections' }));
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession(),
    });

    const body = (await join()).json();

    expect(body.campaign_name).not.toContain('Rival');
    expect(body.message).not.toContain('Rival');
    expect(body.campaign_name).toBe('another campaign');
    // Still a 409, and still carrying the id: the agent's own session row is not in
    // doubt, only the name resolved from it.
    expect(body.code).toBe('session_on_other_campaign');
    expect(body.campaign_id).toBe('camp-old');
  });

  it('names a campaign in ANOTHER ACCOUNT of the same tenant', async () => {
    // The case the scoping decision is FOR, and the reason the filter is not the
    // request's account: 092's index deliberately spans accounts, so the station an
    // agent has to be sent back to will often be in a different account of the
    // tenant. Filtering on the request's account would blank the name in exactly
    // the situation where the agent most needs it named.
    repos.campaign.findById.mockImplementation(async (id: string) =>
      (id === 'camp-new' ? REQUESTED : { ...OTHER, account_id: 'other-account' }));
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession({ account_id: 'other-account' }),
    });

    const body = (await join()).json();

    expect(body.campaign_name).toBe('Q3 Renewals');
    expect(body.message).toContain('Q3 Renewals');
  });

  it('still 409s when the other campaign cannot be named', async () => {
    // Unreachable in practice (`campaign_id` is ON DELETE CASCADE, so a live
    // session outlives its campaign never), but the error path must not be the
    // thing that throws: a TypeError here turns an actionable 409 into a 500.
    repos.campaign.findById.mockImplementation(async (id: string) => (id === 'camp-new' ? REQUESTED : null));
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession(),
    });

    const res = await join();

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('session_on_other_campaign');
    expect(typeof res.json().campaign_name).toBe('string');
  });
});

describe('POST /sessions — the happy path stays intact', () => {
  it('201s with a bootstrap for the requested campaign', async () => {
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: true, session: liveSession({ id: 'sess-new', campaign_id: 'camp-new' }),
    });

    const res = await join();

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.session_id).toBe('sess-new');
    expect(body.campaign_id).toBe('camp-new');
    expect(body.campaign_name).toBe('Winback');
    // The rehydrated state, never the row's.
    expect(body.state).toBe('break');
    expect(body.station_ws_url).toBe('/api/v1/agency/station/sess-new?token=tok');
  });

  it('refuses to bootstrap a session whose row points at another campaign', async () => {
    // Unreachable through the real repository — the upsert's
    // `DO UPDATE … WHERE campaign_id = EXCLUDED.campaign_id` cannot return a
    // foreign row. Asserted because the failure is silent and expensive: the
    // console would render `camp-new`'s disposition catalog, break reasons and
    // context display while every reservation, attempt and stat landed on
    // `camp-old`, and the agent would be writing up calls with codes that do not
    // belong to them.
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: true, session: liveSession({ id: 'sess-old', campaign_id: 'camp-old' }),
    });

    const res = await join();

    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe('Internal Server Error');
    // Loudly, and without handing out a credential for the mismatched session.
    expect(mint).not.toHaveBeenCalled();
  });
});
