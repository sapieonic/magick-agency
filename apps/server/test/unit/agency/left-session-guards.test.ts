import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';

/*
 * The station WebSocket (`GET /station/:sessionId`, `registerStationSocket` in
 * `src/agency/station-socket.ts`) is mounted on the same instance and prefix beside
 * `agencyRoutes`; the socket path the ping cases open is `/api/v1/agency/station/:sessionId`.
 *
 * Q8: `requireOwnedSession` requires the actor the public API layer sends (the
 * session's agent, or a supervisor on `force-available`). `post` therefore sends the owning
 * agent's `agent_user_id`, so every case still exercises the route body it was written for.
 * The cases at the end pin the identity check itself.
 */

// ---------------------------------------------------------------------------
// A session that has LEFT must not be operable — and must stop renewing.
//
// ── The hole, which the one-live-session unique index makes routine ───────────
//
// `left_at` was checked in exactly two places: at the WebSocket upgrade, and in
// `/station-token`. Every other session route operated on a left session happily,
// and nothing rechecked the socket once it was open. Two consequences, neither of
// which shows up as an error anywhere:
//
//   * A SILENTLY DEAD AGENT. `POST /sessions/:id/available` set the Redis lease
//     and mirrored `available` onto a row with `left_at` set. The console renders
//     a ready agent and gets a 200 — while the pacing tick reads
//     `findLiveForCampaign`, which excludes left rows, and never dials them. A
//     station that looks live and can never ring.
//   * A LEAKED OWNERSHIP KEY. The station ping renews both the ownership key and
//     the agent lease, and neither renewal consults the row. A left session whose
//     console tab is still open renews forever, so
//     `AgencyReaper.isAgentHeldSomewhere` keeps skipping attempts that point at
//     it and their contacts sit `in_flight` past the leak threshold — the exact
//     harm the reaper exists to repair.
//
// Sessions are closed out from under whoever is holding them (one live
// session per agent), so the state is ordinary, not a deliberate leave with the
// tab left open. Hence guards rather than comments.
//
// ── And the other direction: leaving must not be free ─────────────────────
//
// `/leave` clears the lease, sets `left_at` and detaches — with no live-attempt
// check, while `releaseStationOnClose` has had exactly that check for the socket
// path since the socket path got it. An `on_call` agent could therefore leave, join campaign
// B (the row is left, so the upsert INSERTS rather than conflicting) and be
// bridged a second customer with the first call still up. That is the double
// bridge that index exists to prevent, one click away, and the unique index cannot see it
// because both rows satisfy it once the first has left.
//
// FALSIFICATION: remove the `left_at` branch from `requireOwnedSession` and the
// first group reds; remove the `hasLiveAttempt` guard and the third group reds;
// remove the ping recheck and the fourth.
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
  getTenantId: () => 't1',
  getAccountId: () => 'a1',
}));

const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', default: false } },
}));

const { repos } = vi.hoisted(() => ({
  repos: {
    attempt: { findById: vi.fn(), setState: vi.fn().mockResolvedValue(null) },
    campaign: { findById: vi.fn() },
    contact: { findById: vi.fn(), markState: vi.fn(), unclaim: vi.fn() },
    session: {
      findById: vi.fn(),
      setState: vi.fn().mockResolvedValue(undefined),
      leave: vi.fn().mockResolvedValue(undefined),
      joinOrRehydrate: vi.fn(),
    },
  },
}));
vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyAttemptRepository: repos.attempt,
  agencyCampaignRepository: repos.campaign,
  agencyContactRepository: repos.contact,
  agencyAgentSessionRepository: repos.session,
}));

import { agencyRoutes } from '../../../src/api/routes/agency.routes.js';
// The station socket lives in `agency/station-socket.ts` and is mounted beside the routes on the same instance (below).
import { registerStationSocket } from '../../../src/agency/station-socket.js';

const LIVE = {
  id: 'sess-1', agent_user_id: 'u-agent', campaign_id: 'camp-1',
  tenant_id: 't1', account_id: 'a1', state: 'available', left_at: null,
};
/** The same session after the dedupe (or a Leave) closed it. */
const LEFT = { ...LIVE, state: 'offline', left_at: new Date('2026-08-16T10:00:00Z') };

const HEADERS = { 'x-mgkvc-tenant': 't1', 'x-mgkvc-account': 'a1' };

interface Harness {
  app: FastifyInstance;
  runtime: any;
  sent: any[];
  /** Every POST route the plugin registered under `/sessions/:id`, from the router itself. */
  sessionRoutes: string[];
}

async function harness(): Promise<Harness> {
  const sent: any[] = [];
  const sessionRoutes: string[] = [];
  /** What `attach` last registered — see the `stations` double below. */
  const holder: { ws: unknown } = { ws: undefined };
  const runtime = {
    replicaId: 'r1',
    agents: {
      get: vi.fn().mockResolvedValue({ state: 'available', attemptId: null, since: 1 }),
      set: vi.fn(), clear: vi.fn(), renew: vi.fn(),
    },
    wrapup: { stateFor: vi.fn(() => null), noteDisposition: vi.fn(), cancel: vi.fn(), force: vi.fn() },
    /**
     * STATEFUL, because `socketFor` answers an identity question and a constant
     * cannot answer one.
     *
     * This was `socketFor: () => undefined`, commented as "nothing else holds this
     * session". That reading is the CLOSE handler's — it asks whether someone else
     * has taken over — and it is the wrong reading for every other caller. The
     * route's `stillOurs` fence asks the opposite question, "am *I* still the
     * holder", and a constant `undefined` answers no to it forever, so the double
     * silently withheld `ready` from every test in this file the moment that fence
     * landed. A double that cannot distinguish "nobody" from "somebody else" cannot
     * be used to test a guard whose whole job is that distinction.
     *
     * Tracking what `attach` was handed is three lines and makes both readings
     * true at once, so a test that wants a supersede can stage one by reassigning
     * `holder.ws` rather than by defeating the guard.
     */
    stations: {
      attach: vi.fn(async (entry: any) => { holder.ws = entry.ws; }),
      detach: vi.fn(async (_id: string, ws?: unknown) => {
        // Identity-scoped exactly as the real one is: a superseded socket's detach
        // must not evict the socket that replaced it.
        if (ws === undefined || holder.ws === ws) holder.ws = undefined;
      }),
      heartbeat: vi.fn().mockResolvedValue(true),
      isLocallyOwned: vi.fn(() => true),
      socketFor: vi.fn(() => holder.ws),
      silentSince: vi.fn(() => []),
      // Honours `expectedWs` like the real one, so a mis-scoped send shows up here
      // as a missing frame rather than passing quietly.
      send: vi.fn((_id: string, frame: any, expectedWs?: unknown) => {
        if (expectedWs !== undefined && holder.ws !== expectedWs) return false;
        sent.push(frame);
        return true;
      }),
    },
    dialer: {
      reattachStation: vi.fn(() => null),
      takeMissedRelease: vi.fn(() => null),
      hasLiveAttempt: vi.fn(() => false),
      // Reached SYNCHRONOUSLY from the station close handler, before it awaits —
      // a double without it throws there, and vitest then exits non-zero while
      // still reporting every assertion as passed.
      noteStationClosed: vi.fn(),
      // Early binding by default, so every pre-existing case keeps asserting the
      // "finish or hang up your current call" wording it was written for.
      hasUnannouncedAttempt: vi.fn(() => false),
      hangupAttempt: vi.fn(),
      releaseAgent: vi.fn(),
    },
    breaks: { queue: vi.fn(), peek: vi.fn(() => null), take: vi.fn(() => null), cancel: vi.fn(() => false) },
    tokens: {
      mint: vi.fn().mockResolvedValue({ token: 'tok', expiresAt: new Date('2026-08-16T12:00:00Z') }),
      verifyAndConsume: vi.fn().mockResolvedValue(true),
    },
    wakeStationSweep: vi.fn(),
    rehydrateAgent: vi.fn().mockResolvedValue('break'),
    releaseStationOnClose: vi.fn().mockResolvedValue(true),
  };

  const app = Fastify();
  // The ROUTER's own list, not a list somebody maintained by hand. `onRoute` fires
  // for every route registered in this instance and every child registered after
  // it, so a session route added tomorrow appears here without anyone remembering
  // to add it — which is the entire argument for moving the `left_at` check onto
  // the shared path in the first place.
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    if (!methods.includes('POST')) return;
    const suffix = route.url.split('/sessions/:id')[1];
    if (route.url.includes('/sessions/:id') && suffix !== undefined) sessionRoutes.push(suffix);
  });
  await app.register(websocket);
  await app.register((a) => agencyRoutes(a as never, runtime as never), { prefix: '/api/v1/agency' });
  // The station socket, mounted on the same
  // instance under the same prefix (`/api/v1/agency/station/:sessionId`). GET-only, so the
  // `onRoute` POST list above is unchanged by it.
  await app.register(async (a) => registerStationSocket(a as never, runtime as never), { prefix: '/api/v1/agency' });
  await app.ready();
  return { app, runtime, sent, sessionRoutes };
}

let h: Harness;

beforeEach(async () => {
  vi.clearAllMocks();
  flags.isEnabled.mockResolvedValue(true);
  repos.session.findById.mockResolvedValue(LIVE);
  repos.campaign.findById.mockResolvedValue({ id: 'camp-1', break_reasons: null });
  h = await harness();
});

afterEach(async () => { await h.app.close(); });

// Q8: the actor the public API layer's handler sends for the session's own agent (`resolveAgencyActor`).
const post = (path: string, payload: Record<string, unknown> = {}) =>
  h.app.inject({
    method: 'POST', url: `/api/v1/agency/sessions/sess-1${path}`, headers: HEADERS,
    payload: { agent_user_id: LIVE.agent_user_id, ...payload },
  });

// ─── requireOwnedSession ────────────────────────────────────────────────────

describe('a left session is not operable', () => {
  // Table-driven over every route behind `requireOwnedSession`, because the point
  // of moving the check onto the shared path is that no route can be missed —
  // asserting one route would prove the one route.
  for (const path of ['/available', '/break', '/force-available', '/leave', '/station-token']) {
    it(`refuses POST ${path} with 409 session_ended`, async () => {
      repos.session.findById.mockResolvedValue(LEFT);

      const res = await post(path, { reason: 'lunch' });

      expect(res.statusCode).toBe(409);
      expect(res.json().code).toBe('session_ended');
    });
  }

  it('refuses EVERY POST route the router has under /sessions/:id', async () => {
    // ── Why this is derived from the router rather than written out above ────
    //
    // The hand-written table proves the routes somebody thought of. That is exactly
    // the failure this change was fixing: `left_at` was checked on ONE route, and
    // every route added afterwards inherited nothing. `/break/cancel` is already a
    // route the list above does not name.
    //
    // So the list comes from Fastify's `onRoute`, and a session route added
    // tomorrow is covered on the day it is registered — or turns this red, which is
    // the only two outcomes worth having.
    expect(h.sessionRoutes.length, 'no session routes were discovered — the onRoute collector is broken, not the guard').toBeGreaterThanOrEqual(6);
    expect(h.sessionRoutes).toContain('/break/cancel');

    for (const suffix of h.sessionRoutes) {
      repos.session.findById.mockResolvedValue(LEFT);
      const res = await post(suffix, { reason: 'lunch' });
      expect(res.statusCode, `POST /sessions/:id${suffix} did not refuse a left session`).toBe(409);
      expect(res.json().code, `POST /sessions/:id${suffix}`).toBe('session_ended');
    }
  });

  it('writes nothing on the refusal — no lease, no mirror, no token', async () => {
    // The silently-dead-agent case, asserted on the writes rather than the status:
    // a 409 that had already set the lease would still leave a console rendering a
    // ready agent that the tick will never dial.
    repos.session.findById.mockResolvedValue(LEFT);

    await post('/available');

    expect(h.runtime.agents.set).not.toHaveBeenCalled();
    expect(repos.session.setState).not.toHaveBeenCalled();
    expect(h.runtime.tokens.mint).not.toHaveBeenCalled();
  });

  it('still 404s a session belonging to someone else, ahead of the left check', async () => {
    // Ordering matters: a left session of ANOTHER tenant must not be distinguished
    // from one that does not exist, or the 409 becomes an existence oracle.
    repos.session.findById.mockResolvedValue({ ...LEFT, tenant_id: 'other-tenant' });

    const res = await post('/available');

    expect(res.statusCode).toBe(404);
  });

  it('still 404s a session in another ACCOUNT of this tenant, ahead of the left check', async () => {
    // The account half of the same ordering. It matters because
    // the constraint deliberately spans accounts, so a tenant's agents now routinely
    // hold sessions in an account other than the one on the request — and "this
    // session has ended" for a session in an account the caller cannot see would
    // confirm the id exists.
    repos.session.findById.mockResolvedValue({ ...LEFT, account_id: 'other-account' });

    const res = await post('/available');

    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBeUndefined();
  });

  it('lets a live session through unchanged', async () => {
    // The control. Without it every assertion above is satisfied by a guard that
    // refuses everything.
    const res = await post('/available');

    expect(res.statusCode).toBe(200);
    expect(h.runtime.agents.set).toHaveBeenCalled();
  });
});

// ─── /leave ─────────────────────────────────────────────────────────────────

describe('leaving a station mid-attempt', () => {
  it('is refused with 409 agent_on_live_call', async () => {
    h.runtime.dialer.hasLiveAttempt.mockReturnValue(true);

    const res = await post('/leave');

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('agent_on_live_call');
    expect(res.json().message).toMatch(/call/i);
  });

  // ── Late binding (pilot 2026-09-08) ───────────────────────────────────────
  //
  // The refusal is right and the OLD MESSAGE IS A LIE. Under late binding an
  // agent with a dial in flight sees an idle console: no panel, no ringing call,
  // and no hangup affordance. "Finish or hang up your current call" describes a
  // screen they are not looking at and asks for an action they cannot take.
  //
  // FALSIFICATION: make the message unconditional again and this reds while the
  // three cases above stay green — which is the split that matters, because the
  // refusal itself must not move.
  it('refuses an UNBOUND dial with wording about a call being placed, not one to finish', async () => {
    h.runtime.dialer.hasLiveAttempt.mockReturnValue(true);
    h.runtime.dialer.hasUnannouncedAttempt.mockReturnValue(true);

    const res = await post('/leave');

    // Still refused, still the same code — allowing the leave would manufacture
    // an abandoned call the moment the carrier answered, and a new error code
    // would be rewritten by the public API layer's error mask into "contact support".
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('agent_on_live_call');
    expect(res.json().message).toMatch(/being placed/i);
    expect(res.json().message).not.toMatch(/hang up/i);
    // And it says HOW LONG. The wait is bounded by the carrier's terminal-state
    // report (45-75s on VoiceLink), not by any campaign setting — an earlier
    // draft of both this message and the comment above it claimed a "campaign
    // ring timeout" that does not exist. A refusal that says "wait" without
    // saying how long is what turns an end-of-shift leave into a support ticket.
    expect(res.json().message).toMatch(/up to a minute/i);
  });

  it('leaves the session and the lease alone for an unbound dial too', async () => {
    // The wording branch must be inert on everything else: a message-only change
    // that also started clearing the lease would produce exactly the abandoned
    // call the refusal exists to prevent, while still reading as a refusal.
    h.runtime.dialer.hasLiveAttempt.mockReturnValue(true);
    h.runtime.dialer.hasUnannouncedAttempt.mockReturnValue(true);

    await post('/leave');

    expect(repos.session.leave).not.toHaveBeenCalled();
    expect(h.runtime.agents.clear).not.toHaveBeenCalled();
    expect(h.runtime.stations.detach).not.toHaveBeenCalled();
  });

  it('leaves the session, the lease and the station exactly as they were', async () => {
    // The refusal has to be inert. A `/leave` that cleared the lease and THEN
    // reported a conflict would produce the double-bridge it is refusing to allow,
    // and would look like a working guard in the response body.
    h.runtime.dialer.hasLiveAttempt.mockReturnValue(true);

    await post('/leave');

    expect(repos.session.leave).not.toHaveBeenCalled();
    expect(h.runtime.agents.clear).not.toHaveBeenCalled();
    expect(h.runtime.stations.detach).not.toHaveBeenCalled();
  });

  it('is allowed when nothing is in flight', async () => {
    // `hasLiveAttempt` covers `dialing` through `bridged` AND the deferred-hangup
    // window, so "no live attempt" really does mean the agent can walk away.
    const res = await post('/leave');

    expect(res.statusCode).toBe(200);
    expect(repos.session.leave).toHaveBeenCalledWith('sess-1');
    expect(h.runtime.agents.clear).toHaveBeenCalledWith('sess-1');
    // The station is detached too — a leave that cleared the lease but left the
    // socket attached would keep the ownership key alive and blind the reaper.
    expect(h.runtime.stations.detach).toHaveBeenCalledWith('sess-1');
  });

  it('asks about THIS session’s attempts, not about the replica in general', async () => {
    // `hasLiveAttempt()` with no argument, or with the wrong id, would refuse every
    // leave on a busy replica and allow every leave on a quiet one — and both
    // failures look exactly like a working guard from the response body.
    await post('/leave');

    expect(h.runtime.dialer.hasLiveAttempt).toHaveBeenCalledWith('sess-1');
  });

  it('reports the session as ENDED, not as busy, when it has already left', async () => {
    // Guard ordering. A left session cannot be leaving again, and `agent_on_live_call`
    // tells the console to wait for a call to finish — on a session that no longer
    // exists to finish one. `session_ended` is the code the console re-bootstraps on.
    repos.session.findById.mockResolvedValue(LEFT);
    h.runtime.dialer.hasLiveAttempt.mockReturnValue(true);

    const res = await post('/leave');

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('session_ended');
  });
});

// ─── the station socket's ping ──────────────────────────────────────────────

/**
 * Open the station socket, send one `ping`, and report what happened.
 *
 * The upgrade itself reads the session, so the first `findById` must return a live
 * row whatever the ping is meant to find — otherwise the socket closes at 4404
 * before a ping is ever sent and the test proves the upgrade guard instead.
 */
async function pingOnce(onPing: () => unknown): Promise<{ closedWith: number | null }> {
  repos.session.findById.mockReset();
  repos.session.findById.mockResolvedValueOnce(LIVE).mockImplementation(async () => onPing());

  const ws = await h.app.injectWS('/api/v1/agency/station/sess-1?token=tok');
  await vi.waitFor(() => expect(h.sent.some((f) => f.event === 'ready')).toBe(true));

  let closedWith: number | null = null;
  ws.on('close', (code: number) => { closedWith = code; });

  ws.send(JSON.stringify({ event: 'ping', ts: 1 }));
  await vi.waitFor(() => expect(repos.session.findById.mock.calls.length).toBeGreaterThan(1));
  // Let the close frame or the pong land before anything is asserted.
  await vi.waitFor(() => expect(closedWith !== null || h.sent.some((f) => f.event === 'pong')).toBe(true));
  ws.terminate();
  return { closedWith };
}

describe('a station socket outliving its session', () => {
  it('closes on the next ping when the session has left', async () => {
    // The renewal leak. The tab is still open — that is the whole premise — so
    // nothing else will ever notice.
    const { closedWith } = await pingOnce(() => LEFT);

    expect(closedWith).toBe(4404);
  });

  it('renews nothing on that ping', async () => {
    // The assertion that matters more than the close code: a renewed ownership key
    // blinds `AgencyReaper.isAgentHeldSomewhere`, and a renewed agent lease
    // advertises an agent the pacing tick will never dial.
    await pingOnce(() => LEFT);

    expect(h.runtime.agents.renew).not.toHaveBeenCalled();
    expect(h.sent.some((f) => f.event === 'pong')).toBe(false);
  });

  it('renews the ownership key at most once more, and the agent lease not at all', async () => {
    // The honest boundary, stated rather than glossed. `stations.heartbeat` runs
    // BEFORE the liveness recheck — it is the `then` the recheck lives inside — so
    // the ownership key does get one more TTL out of this ping. What it does not
    // get is another: the socket is closed on this same ping, and the close path
    // detaches. The agent lease gets nothing at all, which is the half that
    // advertises a dialable agent.
    //
    // Worth pinning because "a left session stops renewing" is the claim, and the
    // truthful version of it is "stops after this one".
    await pingOnce(() => LEFT);

    expect(h.runtime.stations.heartbeat).toHaveBeenCalledTimes(1);
    expect(h.runtime.agents.renew).not.toHaveBeenCalled();
  });

  it('renews as before while the session is live', async () => {
    // The control, and the reason the recheck is on the ping rather than on a
    // timer: presence IS the heartbeat, and it must go on working.
    const { closedWith } = await pingOnce(() => LIVE);

    expect(closedWith).toBeNull();
    expect(h.runtime.agents.renew).toHaveBeenCalledWith('sess-1', 'available', expect.any(Number));
    expect(h.sent.some((f) => f.event === 'pong')).toBe(true);
  });

  it('does not evict a live agent when the liveness read fails', async () => {
    // A database blip is not an absence. Closing here would drop a working station
    // — and every console in the account at once, if the blip is general.
    const { closedWith } = await pingOnce(() => { throw new Error('pg down'); });

    expect(closedWith).toBeNull();
    expect(h.sent.some((f) => f.event === 'pong')).toBe(true);
  });
});

// ─── the `reserved` leak on a deferred break (late binding) ─────────────────
//
// `breakMustWait` defers on `reserved`, and under late binding an unbound dial
// holds the agent at `reserved` for the WHOLE ring. So the frame that tells a
// reconnecting agent "a break is pending" was also telling them `state:
// 'reserved'` for a call they had never been shown — which `StateRail` renders
// as the warning-toned "Ringing — get ready". An agent who obeys it waits for a
// call that usually never arrives, and it is reachable by pressing Break: the
// exact frame `FF_AGENCY_LATE_BINDING` exists to remove, re-entered through a
// control the agent pressed themselves.
//
// Suppressed rather than softened — `state` is authoritative by contract, so a
// state we know to be false is worse than no frame at all. Nothing is lost: the
// HTTP response still carries the pending break (the only fields the console reads),
// `ready.pending_state` covers a mid-ring reconnect, and `releaseAgent` sends
// the authoritative frame when the dial resolves.
//
// FALSIFICATION: drop the `hasUnannouncedAttempt` condition around the send and
// the first test here reds on a leaked `state: 'reserved'`.
describe('/available while an unannounced dial is ringing', () => {
  // `agents.set` is an unconditional Redis write. Under late binding the console
  // shows an idle station for the whole ring, so Available is a control the agent
  // is entitled to press — and pressing it overwrote the `reserved` lease
  // `executeDial` renews, freed them for a SECOND reservation, and left the first
  // customer to answer into `abandonAnsweredCall` against the 3% ceiling.
  //
  // FALSIFICATION: drop the `hasUnannouncedAttempt` refusal and the first case
  // here reds on `agents.set` having been called with 'available'.
  it('refuses, and does not touch the lease', async () => {
    h.runtime.agents.get.mockResolvedValue({ state: 'reserved', attemptId: 'att-1', since: 1 });
    h.runtime.dialer.hasUnannouncedAttempt.mockReturnValue(true);

    const res = await post('/available');

    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('agent_on_live_call');
    // The lease is the thing being protected — not just the status code.
    expect(h.runtime.agents.set).not.toHaveBeenCalled();
    expect(h.sent.filter((f) => f.event === 'agent_state')).toHaveLength(0);
  });

  it('still lets an agent with nothing in flight go available', async () => {
    // The guard must be narrow: this route is how the pool opens at all, so a
    // refusal that fired on an idle agent would stop every campaign.
    h.runtime.dialer.hasUnannouncedAttempt.mockReturnValue(false);

    const res = await post('/available');

    expect(res.statusCode).toBe(200);
    expect(h.runtime.agents.set).toHaveBeenCalledWith('sess-1', 'available', expect.anything());
  });

  it('leaves an ANNOUNCED live attempt alone — that agent can see their call', async () => {
    // Scoped deliberately. An agent looking at a panel is making an informed
    // choice, and widening this to `hasLiveAttempt` would change behaviour on a
    // path late binding does not touch.
    h.runtime.dialer.hasLiveAttempt.mockReturnValue(true);
    h.runtime.dialer.hasUnannouncedAttempt.mockReturnValue(false);

    const res = await post('/available');

    expect(res.statusCode).toBe(200);
  });
});

describe('a break queued behind an UNANNOUNCED dial', () => {
  beforeEach(() => {
    h.runtime.agents.get.mockResolvedValue({ state: 'reserved', attemptId: 'att-1', since: 1 });
    h.runtime.dialer.hasUnannouncedAttempt.mockReturnValue(true);
  });

  it('queues the break and sends NO agent_state frame, so `reserved` never reaches the console', async () => {
    const res = await post('/break', { reason: 'lunch' });

    expect(res.statusCode).toBe(200);
    // Queued server-side — the break is not lost, only unannounced on the socket.
    expect(h.runtime.breaks.queue).toHaveBeenCalledTimes(1);
    // Nothing on the wire at all…
    expect(h.sent.filter((f) => f.event === 'agent_state')).toHaveLength(0);
    // …and specifically not the state that renders "Ringing — get ready".
    expect(h.sent.some((f) => f.state === 'reserved')).toBe(false);

    // The response still tells the console everything it actually reads.
    const body = res.json();
    expect(body.pending_state).toBe('break');
    expect(body.break_reason).toBe('lunch');
  });

  it('still frames the break when the agent HAS seen the call (early binding, or already bridged)', async () => {
    // The suppression must be narrow: an `on_call` agent mid-conversation has a
    // panel on screen, so the frame is correct and load-bearing for a reconnect.
    h.runtime.agents.get.mockResolvedValue({ state: 'on_call', attemptId: 'att-1', since: 1 });
    h.runtime.dialer.hasUnannouncedAttempt.mockReturnValue(false);

    const res = await post('/break', { reason: 'lunch' });

    expect(res.statusCode).toBe(200);
    const frames = h.sent.filter((f) => f.event === 'agent_state');
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ state: 'on_call', pending_state: 'break', pending_break_reason: 'lunch' });
  });

  it('also stays silent on break/cancel — the two routes are symmetric', async () => {
    // The first version of this fix guarded the queue route and left `break/cancel`
    // fifty lines below it unguarded, so the agent who queued a break in silence
    // got the `reserved` frame handed straight back the moment they cancelled it.
    h.runtime.breaks.cancel.mockReturnValue(true);

    const res = await post('/break/cancel');

    expect(res.statusCode).toBe(200);
    expect(h.sent.filter((f) => f.event === 'agent_state')).toHaveLength(0);
    // The response body still confirms the cancel — it is what clears the pill for
    // the window that clicked.
    expect(res.json().state).toBe('reserved');
  });

  it('still frames break/cancel when the agent HAS seen the call', async () => {
    // The clearing signal this frame carries (pending fields OMITTED) must keep
    // reaching every other case, or a cancelled break's pill strands on screen.
    h.runtime.agents.get.mockResolvedValue({ state: 'on_call', attemptId: 'att-1', since: 1 });
    h.runtime.dialer.hasUnannouncedAttempt.mockReturnValue(false);
    h.runtime.breaks.cancel.mockReturnValue(true);

    await post('/break/cancel');

    const frames = h.sent.filter((f) => f.event === 'agent_state');
    expect(frames).toHaveLength(1);
    expect(frames[0]!.state).toBe('on_call');
    // Absence is the statement: these must be omitted, not null.
    expect(frames[0]).not.toHaveProperty('pending_state');
  });

  it('applies the break immediately from `available`, untouched by the guard', async () => {
    // A guard on the DEFERRING branch must not alter the non-deferring one: an
    // available agent's break still applies now, and `hasUnannouncedAttempt` is
    // never consulted because `breakMustWait` short-circuits first.
    h.runtime.agents.get.mockResolvedValue({ state: 'available', attemptId: null, since: 1 });
    h.runtime.dialer.hasUnannouncedAttempt.mockReturnValue(true);

    const res = await post('/break', { reason: 'lunch' });

    expect(res.statusCode).toBe(200);
    expect(h.runtime.breaks.queue).not.toHaveBeenCalled();
    expect(h.runtime.agents.set).toHaveBeenCalledWith('sess-1', 'break', expect.anything());
  });
});

// ─── decision Q8: the session must be the caller's ──────────────────
//
// `requireOwnedSession` checks the actor as well as tenant + account + `left_at`;
// without that check an agent holding a colleague's session id could mint its station token, set it
// available or on break, or make it leave. Table-driven over the ROUTER's list, for the
// same reason as the `left_at` case above: a session route added later inherits the rule
// or turns this red.
describe('Q8: a session route acts only for the session\'s own agent', () => {
  const as = (path: string, actor: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    h.app.inject({
      method: 'POST', url: `/api/v1/agency/sessions/sess-1${path}`, headers: HEADERS,
      payload: { reason: 'lunch', ...extra, ...actor },
    });

  it('refuses another agent on EVERY session route with the not-found 404, and writes nothing', async () => {
    expect(h.sessionRoutes.length).toBeGreaterThanOrEqual(6);
    for (const suffix of h.sessionRoutes) {
      const res = await as(suffix, { agent_user_id: 'u-colleague' });
      expect(res.statusCode, `POST /sessions/:id${suffix} let a non-owner act`).toBe(404);
      expect(res.json(), `POST /sessions/:id${suffix}`).toEqual({ error: 'Not Found', message: 'Session not found' });
    }
    expect(h.runtime.tokens.mint).not.toHaveBeenCalled();
    expect(h.runtime.agents.set).not.toHaveBeenCalled();
    expect(repos.session.setState).not.toHaveBeenCalled();
    expect(h.runtime.wrapup.force).not.toHaveBeenCalled();
  });

  it("a non-owner's 404 is byte-identical to a missing session's (no existence oracle)", async () => {
    const foreign = await as('/station-token', { agent_user_id: 'u-colleague' });
    repos.session.findById.mockResolvedValue(null);
    const missing = await as('/station-token', { agent_user_id: 'u-colleague' });
    expect(foreign.statusCode).toBe(missing.statusCode);
    expect(foreign.body).toBe(missing.body);
  });

  it('a non-owner of a LEFT session still gets the 404, not the 409 that would confirm it exists', async () => {
    repos.session.findById.mockResolvedValue(LEFT);
    const res = await as('/available', { agent_user_id: 'u-colleague' });
    expect(res.statusCode).toBe(404);
  });

  it('a request with no actor is 400 missing_actor, before the session is even looked up', async () => {
    const res = await h.app.inject({
      method: 'POST', url: '/api/v1/agency/sessions/sess-1/station-token', headers: HEADERS, payload: {},
    });
    expect(res.statusCode).toBe(400);
    // The attempt routes' shape (`sendActionError`), with a session-specific sentence.
    expect(res.json()).toEqual({
      error: 'Validation failed', code: 'missing_actor',
      message: 'The request did not identify which agent is acting on this session.',
    });
    expect(repos.session.findById).not.toHaveBeenCalled();
  });

  it('the owning agent may (station-token mints for their own session)', async () => {
    const res = await as('/station-token', { agent_user_id: LIVE.agent_user_id });
    expect(res.statusCode).toBe(200);
    expect(h.runtime.tokens.mint).toHaveBeenCalledWith('sess-1');
  });

  it("a supervisor (on_behalf) may NOT drive an agent's own presence routes", async () => {
    for (const suffix of ['/station-token', '/available', '/break', '/break/cancel', '/leave']) {
      const res = await as(suffix, { agent_user_id: 'u-supervisor', on_behalf: true });
      expect(res.statusCode, `POST /sessions/:id${suffix} let a supervisor act for the agent`).toBe(404);
    }
    expect(h.runtime.tokens.mint).not.toHaveBeenCalled();
  });

  it('a supervisor (on_behalf) MAY force-available another agent; without on_behalf they may not', async () => {
    const without = await as('/force-available', { agent_user_id: 'u-supervisor' });
    expect(without.statusCode).toBe(404);
    const withIt = await as('/force-available', { agent_user_id: 'u-supervisor', on_behalf: true });
    expect(withIt.statusCode).toBe(200);
    expect(h.runtime.wrapup.force).toHaveBeenCalledWith('sess-1');
  });
});
