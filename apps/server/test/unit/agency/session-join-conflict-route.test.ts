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
//   * the body names the session that blocks the join and its account (often a
//     sibling), so the app can leave it — only ever the caller's own session;
//   * no station token is minted and no bootstrap is built on the refusal path —
//     a client handed a station URL here would open a socket for a session it
//     was just refused;
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
    telephony: { vobiz: { webhookBaseUrl: 'https://server.test/api/v1/webhooks/vobiz' } },
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
    contact: { findById: vi.fn(), probeAgentQueues: vi.fn() },
    session: { findById: vi.fn(), findLiveForAgent: vi.fn(), joinOrRehydrate: vi.fn(), setState: vi.fn(), leave: vi.fn(), claimStationDevice: vi.fn() },
    staffing: { isActiveOnCampaign: vi.fn() },
  },
}));
vi.mock('@magick-agency/db/repositories/agency-campaign-agent.repository', () => ({
  agencyCampaignAgentRepository: repos.staffing,
}));
const { accounts } = vi.hoisted(() => ({ accounts: { findByIdInTenant: vi.fn() } }));
vi.mock('@magick-agency/db/repositories/account.repository', () => ({ accountRepository: accounts }));
const { tenants } = vi.hoisted(() => ({ tenants: { findById: vi.fn() } }));
vi.mock('@magick-agency/db/repositories/tenant.repository', () => ({ tenantRepository: tenants }));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyCampaignRepository: repos.campaign,
  agencyContactRepository: repos.contact,
  agencyAgentSessionRepository: repos.session,
}));

import { readFileSync } from 'node:fs';
import { agencyRoutes } from '../../../src/api/routes/agency.routes.js';
import { rewriteStationWsUrl } from '../../../src/api/routes/proxy-agency-station.routes.js';

/** The mobile app's golden samples (`packages/contracts/fixtures/agent/session.json`). */
const AGENT_FIXTURES = JSON.parse(
  readFileSync(new URL('../../../../../packages/contracts/fixtures/agent/session.json', import.meta.url), 'utf8'),
) as Record<string, Record<string, any>>;

const REQUESTED = {
  id: 'camp-new', tenant_id: 't1', account_id: 'a1', name: 'Winback',
  status: 'running', disposition_catalog: [], wrapup_seconds: 30,
  wrapup_auto_return: true, record_calls: true, break_reasons: null, context_display: {},
};

const OTHER = { ...REQUESTED, id: 'camp-old', name: 'Q3 Renewals' };

/** An all-day, every-day calling window, so a queue read does not depend on when the suite runs. */
const ALL_DAY = {
  calling_window_start: '00:00:00', calling_window_end: '24:00:00', calling_days: [1, 2, 3, 4, 5, 6, 7], default_timezone: 'UTC',
};

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
/** OS7: whether the other tenant's session has a station attached (connected: it is working there). */
const stationPresence = vi.fn(async (): Promise<'connected' | 'absent' | 'unknown'> => 'connected');
const stationDetach = vi.fn();
const agentsGet = vi.fn();
const rehydrate = vi.fn();
const agentsTransition = vi.fn();
const agentsClear = vi.fn(async () => undefined);

function makeRuntime() {
  return {
    replicaId: 'r1',
    agents: { get: agentsGet, set: vi.fn(), clear: agentsClear, transition: agentsTransition },
    wrapup: { stateFor: vi.fn(() => null) },
    stations: {
      send: vi.fn(() => true), attach: vi.fn(), detach: stationDetach, isLocallyOwned: vi.fn(() => true),
      stationPresence: stationPresence,
    },
    // The soft phone's runtime surface (docs/softphone.md): nothing live in these tests.
    softphone: { hasLiveCall: vi.fn(() => false), reattachStation: vi.fn(async () => null) },
    dialer: {
      hasLiveAttempt: vi.fn(() => false), hasUnannouncedAttempt: vi.fn(() => false), hasRedialInFlight: vi.fn(() => false),
      noteStationClosed: vi.fn(), reattachStation: vi.fn(() => null),
    },
    breaks: { queue: vi.fn(), take: vi.fn(() => null), cancel: vi.fn(() => false), peek: vi.fn(() => null) },
    tokens: { mint, verifyAndConsume: vi.fn() },
    rehydrateAgent: rehydrate,
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
  rehydrate.mockResolvedValue('break');
  agentsTransition.mockResolvedValue(true);
  // Staffed by default: the conflict cases below are about the live-session index, not
  // staffing (`not_staffed` has its own describe at the end).
  repos.staffing.isActiveOnCampaign.mockResolvedValue(true);
  repos.session.findLiveForAgent.mockResolvedValue(null);
  repos.session.claimStationDevice.mockResolvedValue({ ok: true });
  stationPresence.mockResolvedValue('connected');
  accounts.findByIdInTenant.mockImplementation(async (id: string, tenantId: string) =>
    id === 'a2' && tenantId === 't1' ? { id: 'a2', tenant_id: 't1', name: 'North Region' } : null);
  app = await buildApp();
});

describe('POST /sessions — agent live on the soft phone', () => {
  it('409s session_on_softphone with the session, naming no campaign', async () => {
    // A soft-phone session (docs/softphone.md) holds the agent's one live session in
    // the tenant and has no campaign, so `session_on_other_campaign` has nothing to
    // name. The remedy is leaving the soft phone.
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign',
      session: liveSession({ kind: 'softphone', campaign_id: null, break_reason: 'soft_phone' }),
    });

    const res = await join();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Conflict',
      code: 'session_on_softphone',
      message: expect.stringMatching(/soft phone/i),
      session_id: 'sess-old',
      account_id: 'a1',
      account_name: null,
    });
    // No campaign lookup for a NULL id, no token, no state touched.
    expect(repos.campaign.findById).toHaveBeenCalledTimes(1);
    expect(repos.campaign.findById).toHaveBeenCalledWith('camp-new');
    expect(mint).not.toHaveBeenCalled();
    expect(repos.session.setState).not.toHaveBeenCalled();
  });

  it('names the sibling account a soft-phone session is in, where the console leaves it', async () => {
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'on_softphone',
      session: liveSession({ account_id: 'a2', kind: 'softphone', campaign_id: null, break_reason: 'soft_phone' }),
    });

    const res = await join();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'session_on_softphone', session_id: 'sess-old', account_id: 'a2', account_name: 'North Region',
    });
    expect(accounts.findByIdInTenant).toHaveBeenCalledWith('a2', 't1');
  });

  it('a failed account-name read still answers the 409, with the account id', async () => {
    accounts.findByIdInTenant.mockRejectedValue(new Error('db down'));
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'on_softphone',
      session: liveSession({ account_id: 'a2', kind: 'softphone', campaign_id: null, break_reason: 'soft_phone' }),
    });

    const res = await join();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'session_on_softphone', account_id: 'a2', account_name: null });
  });
});

describe('POST /sessions — one station per agent (OS1, OS3)', () => {
  const DEVICE = 'tab-0123456789abcdef';
  const OTHER_DEVICE = 'phone-fedcba9876543210';

  it('409s session_in_other_tenant naming only the tenant, and touches nothing', async () => {
    tenants.findById.mockResolvedValue({ id: 't2', name: 'Acme Collections' });
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_tenant', session: liveSession({ tenant_id: 't2', account_id: 'a9', campaign_id: 'camp-there' }),
    });

    const res = await join();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Conflict',
      code: 'session_in_other_tenant',
      message: expect.stringContaining('Acme Collections'),
      tenant_id: 't2',
      tenant_name: 'Acme Collections',
    });
    // Nothing of the other tenant's campaigns or accounts is read or named.
    expect(repos.campaign.findById).toHaveBeenCalledTimes(1);
    expect(accounts.findByIdInTenant).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(rehydrate).not.toHaveBeenCalled();
  });

  it('OS7: an idle session in the other tenant is ended as its Leave would, and the join goes through', async () => {
    stationPresence.mockResolvedValue('absent');
    agentsGet.mockResolvedValue({ state: 'break' });
    repos.session.joinOrRehydrate
      .mockResolvedValueOnce({ ok: false, reason: 'other_tenant', session: liveSession({ id: 'sess-there', tenant_id: 't2' }) })
      .mockResolvedValueOnce({ ok: true, created: true, session: liveSession({ id: 'sess-1', campaign_id: 'camp-new' }) });

    const res = await join();

    expect(res.statusCode).toBe(201);
    expect(agentsClear).toHaveBeenCalledWith('sess-there');
    expect(repos.session.leave).toHaveBeenCalledWith('sess-there');
    expect(stationDetach).toHaveBeenCalledWith('sess-there');
    expect(repos.session.joinOrRehydrate).toHaveBeenCalledTimes(2);
  });

  it('OS7: a working session in the other tenant (station attached) is left alone and the join refused', async () => {
    stationPresence.mockResolvedValue('connected');
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_tenant', session: liveSession({ id: 'sess-there', tenant_id: 't2' }),
    });

    const res = await join();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'session_in_other_tenant' });
    expect(repos.session.leave).not.toHaveBeenCalled();
    expect(repos.session.joinOrRehydrate).toHaveBeenCalledTimes(1);
  });

  it('a failed tenant-name read still answers the 409', async () => {
    tenants.findById.mockRejectedValue(new Error('db down'));
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_tenant', session: liveSession({ tenant_id: 't2' }),
    });

    const res = await join();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'session_in_other_tenant', tenant_id: 't2', tenant_name: null });
  });

  it('a resume from another device than the holder is refused before the upsert writes anything', async () => {
    repos.session.findLiveForAgent.mockResolvedValue(liveSession({
      id: 'sess-1', kind: 'campaign', campaign_id: 'camp-new', station_device_id: OTHER_DEVICE, client_kind: 'mobile',
    }));

    const res = await join({ campaign_id: 'camp-new', agent_user_id: 'u-agent', device_id: DEVICE });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Conflict',
      code: 'station_on_other_device',
      message: expect.stringMatching(/phone/),
      session_id: 'sess-1',
      client_kind: 'mobile',
    });
    expect(repos.session.joinOrRehydrate).not.toHaveBeenCalled();
    expect(repos.session.claimStationDevice).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(rehydrate).not.toHaveBeenCalled();
  });

  it('take_over joins from another device: the claim is asked to take it, then the token is minted', async () => {
    repos.session.findLiveForAgent.mockResolvedValue(liveSession({
      id: 'sess-1', campaign_id: 'camp-new', station_device_id: OTHER_DEVICE,
    }));
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: true, created: false, session: liveSession({ id: 'sess-1', campaign_id: 'camp-new', station_device_id: OTHER_DEVICE }),
    });

    const res = await join({ campaign_id: 'camp-new', agent_user_id: 'u-agent', device_id: DEVICE, take_over: true });

    expect(res.statusCode).toBe(201);
    expect(repos.session.claimStationDevice).toHaveBeenCalledWith('sess-1', DEVICE, true);
    expect(mint).toHaveBeenCalledWith('sess-1');
  });

  it('a claim lost to a racing take-over is the same 409, with no rehydrate and no token', async () => {
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: true, created: false, session: liveSession({ id: 'sess-1', campaign_id: 'camp-new' }),
    });
    repos.session.claimStationDevice.mockResolvedValue({ ok: false, reason: 'held_elsewhere', client_kind: 'web' });

    const res = await join({ campaign_id: 'camp-new', agent_user_id: 'u-agent', device_id: DEVICE });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'station_on_other_device', session_id: 'sess-1', client_kind: 'web' });
    expect(repos.session.claimStationDevice).toHaveBeenCalledWith('sess-1', DEVICE, false);
    expect(rehydrate).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });

  it('a join with no device id (an older client) claims with none, and is not pre-checked', async () => {
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: true, created: true, session: liveSession({ id: 'sess-1', campaign_id: 'camp-new' }),
    });

    const res = await join();

    expect(res.statusCode).toBe(201);
    expect(repos.session.findLiveForAgent).not.toHaveBeenCalled();
    expect(repos.session.claimStationDevice).toHaveBeenCalledWith('sess-1', null, false);
  });

  it('a malformed device id from an internal caller is treated as none, never stored', async () => {
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: true, created: true, session: liveSession({ id: 'sess-1', campaign_id: 'camp-new' }),
    });

    const res = await join({ campaign_id: 'camp-new', agent_user_id: 'u-agent', device_id: 'bad id!', take_over: true });

    expect(res.statusCode).toBe(201);
    expect(repos.session.claimStationDevice).toHaveBeenCalledWith('sess-1', null, false);
  });
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
      session_id: 'sess-old',
      account_id: 'a1',
      account_name: null,
    });
  });

  it('names the session to leave and the SIBLING account it is in', async () => {
    // The mobile app leaves that session from the join screen (`POST /sessions/:id/leave`,
    // scoped to the session's account), so the body names the session and its account.
    // A sibling account is the common case: the one-live-session index spans the tenant.
    repos.campaign.findById.mockImplementation(async (id: string) =>
      (id === 'camp-new' ? REQUESTED : { ...OTHER, account_id: 'a2' }));
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession({ account_id: 'a2' }),
    });

    const res = await join();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'session_on_other_campaign', session_id: 'sess-old', account_id: 'a2', account_name: 'North Region',
    });
    // The account name is read in the session's own tenant, never unscoped.
    expect(accounts.findByIdInTenant).toHaveBeenCalledWith('a2', 't1');
  });

  it('a failed account-name read still answers the 409, with the session and account ids', async () => {
    accounts.findByIdInTenant.mockRejectedValue(new Error('db down'));
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession({ account_id: 'a2' }),
    });

    const res = await join();

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({
      code: 'session_on_other_campaign', session_id: 'sess-old', account_id: 'a2', account_name: null,
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

  it('mints no station token on the refusal, and names only the session that blocks it', async () => {
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession(),
    });

    const res = await join();

    // The only session id on the body is the agent's OTHER live session, the one to
    // leave: no new session was created, and no credential is handed out for either.
    // Opening that station still needs a token minted by its own authenticated route.
    expect(res.json().session_id).toBe('sess-old');
    expect(res.json().station_ws_url).toBeUndefined();
    expect(res.json().station_token_expires_at).toBeUndefined();
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
    // request's account: the unique index deliberately spans accounts, so the station an
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
    // On a break with no recorded reason (a rehydrate after a restart), none is named.
    expect(body).not.toHaveProperty('break_reason');
  });

  it('carries the campaign\'s allow_wrapup_redial, as a boolean either way', async () => {
    for (const [stored, served] of [[true, true], [false, false], [undefined, false]] as const) {
      repos.campaign.findById.mockResolvedValue({ ...REQUESTED, allow_wrapup_redial: stored });
      repos.session.joinOrRehydrate.mockResolvedValue({
        ok: true, session: liveSession({ id: 'sess-new', campaign_id: 'camp-new' }),
      });
      const res = await join();
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json().allow_wrapup_redial).toBe(served);
    }
  });

  it('carries the assignment mode and agent retry, and no queue, on a pool campaign', async () => {
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: true, session: liveSession({ id: 'sess-new', campaign_id: 'camp-new' }),
    });
    // A row from before 0009 (no column) reads as `pool`; agent retry as a boolean.
    for (const campaign of [REQUESTED, { ...REQUESTED, assignment_mode: 'pool', allow_agent_retry: true }]) {
      repos.campaign.findById.mockResolvedValue(campaign);
      const body = (await join()).json();
      expect(body.assignment_mode).toBe('pool');
      expect(body.allow_agent_retry).toBe((campaign as { allow_agent_retry?: boolean }).allow_agent_retry === true);
      expect(body).not.toHaveProperty('queue');
    }
    expect(repos.contact.probeAgentQueues).not.toHaveBeenCalled();
  });

  it("carries this agent's queue on a strict campaign, read for the joining agent", async () => {
    repos.campaign.findById.mockResolvedValue({ ...REQUESTED, ...ALL_DAY, assignment_mode: 'strict', allow_agent_retry: false });
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: true, session: liveSession({ id: 'sess-new', campaign_id: 'camp-new' }),
    });
    const later = new Date(Date.now() + 3_600_000);
    repos.contact.probeAgentQueues.mockResolvedValue({
      agents: [{ agentUserId: 'u-agent', ownDue: false, ownNextAt: later, ownHasNonCallback: true }], pool: null,
    });

    const body = (await join()).json();

    expect(body.assignment_mode).toBe('strict');
    expect(body.allow_agent_retry).toBe(false);
    expect(body.queue).toEqual({ due: false, reason: 'waiting_for_retry', next_due_at: later.toISOString() });
    expect(repos.contact.probeAgentQueues).toHaveBeenCalledWith('camp-new', ['u-agent'], expect.objectContaining({ callbackCodes: [] }));
  });

  it('joins without the queue when it cannot be read (best effort, like the retry context)', async () => {
    repos.campaign.findById.mockResolvedValue({ ...REQUESTED, assignment_mode: 'preferred' });
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: true, session: liveSession({ id: 'sess-new', campaign_id: 'camp-new' }),
    });
    repos.contact.probeAgentQueues.mockRejectedValue(new Error('db down'));

    const res = await join();

    expect(res.statusCode).toBe(201);
    expect(res.json().assignment_mode).toBe('preferred');
    expect(res.json()).not.toHaveProperty('queue');
  });

  it('names the break reason the row holds when the agent is on break (the app paused while away)', async () => {
    // The mobile app is paused with `device_away` when it leaves the foreground, and is
    // often killed by the OS while paused. On relaunch the bootstrap is what it renders
    // first, so it says why: "you left the app", not a generic break.
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: true, session: liveSession({ id: 'sess-new', campaign_id: 'camp-new', state: 'break', break_reason: 'device_away' }),
    });

    const body = (await join()).json();

    expect(body.state).toBe('break');
    expect(body.break_reason).toBe('device_away');
  });

  it('names no break reason when the rehydrated state is not break, whatever the row kept', async () => {
    // `offline` keeps the last break's reason on the row; it must not leak onto a
    // session that the rehydrate found `available` (or anything else).
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: true, session: liveSession({ id: 'sess-new', campaign_id: 'camp-new', state: 'offline', break_reason: 'lunch' }),
    });
    rehydrate.mockResolvedValueOnce('available');

    const body = (await join()).json();

    expect(body.state).toBe('available');
    expect(body).not.toHaveProperty('break_reason');
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

// ---------------------------------------------------------------------------
// `not_staffed`: a NEW session needs an active staffing row on the campaign, unless the
// caller's role supervises (`supervise`, set by the public API layer from the membership).
// A rehydrate of the agent's own live session on the campaign is allowed (see
// `mayStartOrResume` in `sessions.ts`).
// ---------------------------------------------------------------------------
describe('POST /sessions — the staffing check', () => {
  const NOT_STAFFED = {
    error: 'Forbidden',
    code: 'not_staffed',
    message: "You're not assigned to this campaign. Ask your supervisor to add you.",
  };

  beforeEach(() => {
    repos.staffing.isActiveOnCampaign.mockResolvedValue(false);
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: true, session: liveSession({ id: 'sess-new', campaign_id: 'camp-new' }),
    });
  });

  it('refuses an unstaffed agent 403 not_staffed, and starts nothing', async () => {
    const res = await join();

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual(NOT_STAFFED);
    expect(repos.staffing.isActiveOnCampaign).toHaveBeenCalledWith('t1', 'camp-new', 'u-agent');
    expect(repos.session.joinOrRehydrate).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });

  it('joins a staffed agent without reading their live session', async () => {
    repos.staffing.isActiveOnCampaign.mockResolvedValue(true);

    const res = await join();

    expect(res.statusCode).toBe(201);
    expect(repos.session.findLiveForAgent).not.toHaveBeenCalled();
  });

  it('lets a supervising caller join unstaffed, without consulting staffing', async () => {
    const res = await join({ campaign_id: 'camp-new', agent_user_id: 'u-agent', supervise: true });

    expect(res.statusCode).toBe(201);
    expect(repos.staffing.isActiveOnCampaign).not.toHaveBeenCalled();
  });

  it.each([['false', false], ['the string "true"', 'true'], ['1', 1]])(
    'treats supervise=%s as not supervising',
    async (_label, supervise) => {
      const res = await join({ campaign_id: 'camp-new', agent_user_id: 'u-agent', supervise });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe('not_staffed');
    },
  );

  it('rehydrates the agent\'s own live session on this campaign, though they were unassigned mid-shift', async () => {
    repos.session.findLiveForAgent.mockResolvedValue(liveSession({ id: 'sess-new', campaign_id: 'camp-new', state: 'on_call' }));

    const res = await join();

    expect(res.statusCode).toBe(201);
    expect(res.json().session_id).toBe('sess-new');
    expect(repos.session.findLiveForAgent).toHaveBeenCalledWith('t1', 'u-agent');
  });

  it('a live session on ANOTHER campaign does not make this one a rehydrate', async () => {
    repos.session.findLiveForAgent.mockResolvedValue(liveSession());

    const res = await join();

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('not_staffed');
    expect(repos.session.joinOrRehydrate).not.toHaveBeenCalled();
  });

  it('a live soft-phone session does not make this one a rehydrate', async () => {
    repos.session.findLiveForAgent.mockResolvedValue(
      liveSession({ kind: 'softphone', campaign_id: null, break_reason: 'soft_phone' }),
    );

    const res = await join();

    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('not_staffed');
  });

  it('answers an unknown campaign 404 before staffing, and a disabled flag 403 before both', async () => {
    const unknown = await join({ campaign_id: 'camp-missing', agent_user_id: 'u-agent' });
    expect(unknown.statusCode).toBe(404);

    flags.isEnabled.mockResolvedValue(false);
    const disabled = await join();
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json().error).toBe('Feature Not Enabled');
    expect(repos.staffing.isActiveOnCampaign).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The device-away break that cannot land: every compare-and-swap lost to a state that
// kept moving. A conflict, answered in the action-error vocabulary (409 `state_changing`),
// never the soft phone's `dial_failed`: the app must not show dial-failure copy for it.
// ---------------------------------------------------------------------------
describe('POST /sessions/:id/break — device_away that keeps losing its CAS', () => {
  it('409s state_changing and writes nothing', async () => {
    repos.session.findById.mockResolvedValue(liveSession({ id: 'sess-1', campaign_id: 'camp-new', state: 'available' }));
    agentsGet.mockResolvedValue({ state: 'available', since: 1 });
    agentsTransition.mockResolvedValue(false);

    const res = await app.inject({
      method: 'POST', url: '/api/v1/agency/sessions/sess-1/break', headers: HEADERS,
      payload: { reason: 'device_away', agent_user_id: 'u-agent' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Conflict',
      code: 'state_changing',
      message: expect.stringMatching(/nothing changed/i),
    });
    expect(agentsTransition).toHaveBeenCalledTimes(3);
    expect(repos.session.setState).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The agent app's fixtures are decoded by its Dart suite as the real wire. They are
// checked here against what this handler actually sends, so a fixture cannot keep a
// shape or a value the server stopped producing (a station URL without the session id,
// a 30 s grace served to a phone, a conflict missing the fields the app leaves by).
// ---------------------------------------------------------------------------
describe('the agent fixtures are what this handler sends', () => {
  it('bootstrap_first_join: a mobile join\'s intervals and station URL (after the public rewrite)', async () => {
    const fixture = AGENT_FIXTURES['bootstrap_first_join']!;
    const token = /[?&]token=([^&]+)/.exec(fixture['station_ws_url'])![1]!;
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: true, session: liveSession({ id: fixture['session_id'], campaign_id: 'camp-new' }),
    });
    mint.mockResolvedValue({ token, expiresAt: new Date(fixture['station_token_expires_at']) });

    const body = (await join({ campaign_id: 'camp-new', agent_user_id: 'u-agent', client_kind: 'mobile' })).json();

    expect(body.intervals).toEqual(fixture['intervals']);
    expect(rewriteStationWsUrl(body.station_ws_url)).toBe(fixture['station_ws_url']);
    expect(AGENT_FIXTURES['bootstrap_retry_rehydrated']!['intervals']).toEqual(body.intervals);
  });

  it("bootstrap_first_join: a strict campaign's mode, agent retry and empty queue", async () => {
    const fixture = AGENT_FIXTURES['bootstrap_first_join']!;
    repos.campaign.findById.mockResolvedValue({
      ...REQUESTED, ...ALL_DAY, assignment_mode: fixture['assignment_mode'], allow_agent_retry: fixture['allow_agent_retry'],
    });
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: true, session: liveSession({ id: fixture['session_id'], campaign_id: 'camp-new' }),
    });
    // Nothing assigned to the agent: no open contact of theirs.
    repos.contact.probeAgentQueues.mockResolvedValue({
      agents: [{ agentUserId: 'u-agent', ownDue: false, ownNextAt: null, ownHasNonCallback: null }], pool: null,
    });

    const body = (await join({ campaign_id: 'camp-new', agent_user_id: 'u-agent', client_kind: 'mobile' })).json();

    expect(body.assignment_mode).toBe(fixture['assignment_mode']);
    expect(body.allow_agent_retry).toBe(fixture['allow_agent_retry']);
    expect(body.queue).toEqual(fixture['queue']);
    // The pool-mode sample carries none of it, as a pool join omits `queue`.
    expect(AGENT_FIXTURES['bootstrap_retry_rehydrated']).not.toHaveProperty('queue');
  });

  it('conflict_other_campaign: the same fields the handler sends', async () => {
    repos.session.joinOrRehydrate.mockResolvedValue({
      ok: false, reason: 'other_campaign', session: liveSession({ account_id: 'a2' }),
    });

    const body = (await join()).json();

    expect(Object.keys(body).sort()).toEqual(Object.keys(AGENT_FIXTURES['conflict_other_campaign']!).sort());
  });
});
