import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import Redis from 'ioredis';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { uuidFor } from '../setup/factories.js';
import { TEST_REDIS_URL } from '../../helpers/test-redis.js';
import { DEFAULTS as DB_DEFAULTS } from '../../../../../packages/db/test/integration/setup/factories.js';
import { insertAgencyCampaign, insertAgencyContacts } from './agency-factories.js';
import { FakeStationSocket, ScriptedBridge } from './chaos/harness.js';

/*
 * Harness notes — each point records something this suite does differently from a plain
 * API-key-authenticated server:
 *  - auth: there are no API keys in this application; `agency.routes.ts` is a handler module on the private
 *    in-process instance, and its `authMiddleware` keeps only the header half — so `post` sends
 *    `x-mgkvc-tenant` / `x-mgkvc-account` alone. The routes are registered here exactly as
 *    `src/index.ts` does (`agencyRoutes(scope, runtime)` under `/api/v1/agency`); the
 *    `@fastify/websocket` registration is gone with the station route, which moved to
 *    `agency/station-socket.ts` (this walk attaches a `FakeStationSocket` directly);
 *  - ids: TENANT / ACCOUNT are the factories' default UUIDs (agency's columns are `uuid`), the
 *    agent a stable `uuidFor`;
 *  - Redis: this worktree's test Redis (`TEST_REDIS_URL`, the same db the chaos suites use)
 *    with a `cycle:` key prefix; files run serially (`fileParallelism: false`);
 *  - the DNC sync in `beforeEach` (`runtime.dnc.applyReplace(...)` + its two expects) is
 *    deleted: there is no Redis DNC set, the pre-dial gate reads `dnc_entries` (decision B8),
 *    and an empty table is "nobody is suppressed" for real;
 *  - decision Q8: `post` adds the agent's `agent_user_id` on `/sessions/:id/*` (the
 *    actor the public API layer sends; `requireOwnedSession` refuses a request without it);
 *  - mocks: the pool through `@magick-agency/db` (as the chaos suites); the config stub drops
 *    `auth` and `telephony.vobiz`; the logger targets `@magick-agency/observability`; no metrics
 *    or analytics mocks are needed (the metric modules create no-op instruments without a
 *    provider, and `authMiddleware` does not call PostHog).
 */

/**
 * ─── THE AGENT STATE CYCLE ───────────────────────────────────────────────
 *
 * *"All six agent states entered and left correctly, including break with a
 * reason code and wrap-up with auto-return."*
 *
 * ── Why this is ONE test and not six ───────────────────────────────────────
 *
 * The failure mode criterion 2 exists to catch is **a state that can be entered
 * and not left.** A per-transition suite is structurally incapable of seeing it:
 * six tests that each seed a state, fire one transition and assert the result
 * will all pass against a machine in which `wrapup` is a one-way door, because
 * every one of them arrives at its starting state by fiat rather than by having
 * got there. The trap is invisible from inside any single hop.
 *
 * So this is a single continuous walk. Nothing is seeded mid-cycle; every state
 * is reached only by leaving the previous one. A state that traps the agent stops
 * the walk at that line, which is the property being asserted.
 *
 * It is also the criterion most likely to be waved through on a
 * screen-share — six states is exactly the sort of thing that gets demonstrated
 * live and recorded as met. A walk that fails at the trapped hop is the artefact
 * that cannot be demonstrated away.
 *
 * ── What is real, and what the two fakes are ────────────────────────────────
 *
 * Real: **the production assembly.** `new AgencyRuntime(...)` — the same
 * constructor `src/index.ts` calls — so the collaborator graph under test is the
 * one that ships, against real Postgres and real Redis, driven through the
 * real Fastify routes and a real feature-flag row.
 *
 * That choice is the point, not convenience. The question is: *is the property
 * true where it is consumed?* Every agent-initiated transition here is consumed
 * by an HTTP route, and the two rules criterion 2 names by name live only there —
 * break-reason validation is `POST /sessions/:id/break` calling
 * `validateBreakReason`, and the wrap-up guard is `POST /sessions/:id/available`
 * refusing to let an agent walk out of a wrap-up they still owe a disposition
 * for. Driving `AgentStateMachine` directly would assert neither, and hand-wiring
 * the collaborators is how the chaos harness came to construct `AgencyDialer`
 * with four of its five arguments.
 *
 * Fake: the carrier (`ScriptedBridge`) and the browser socket
 * (`FakeStationSocket`), reused from the chaos harness because they are the two
 * things this tier cannot host. Everything between them is real.
 *
 * ── What this deliberately does NOT cover ──────────────────────────────────
 *
 * **Wrap-up held on an outstanding required disposition.** the route
 * (`POST /attempts/:id/disposition`) does not exist yet, so the only exit
 * from a held wrap-up an agent controls is unbuilt. The supervisor exit does
 * exist and is walked below (`/force-available`), which is what keeps the held
 * branch from being a state with no demonstrated exit at all. When `C-04` lands,
 * the `disposition_submitted` exit belongs in this walk, and the campaign's
 * `disposition_catalog` here should stop being empty. Until then criterion 2 is
 * met for five of six exits from `wrapup` and that is stated rather than implied.
 */

// ── Mocks ──────────────────────────────────────────────────────────────────

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));

// `AgencyDialer` value-imports `WebRtcCallError` from the bridge, which pulls the
// whole config graph — and `loadConfig` would `process.exit(1)` on the repo's
// incomplete `.env`, taking the test runner with it. Same mock the sibling agency
// integration files use, for the same reason.
vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {},
  },
}));

vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── Imports (after mocks) ──────────────────────────────────────────────────

const { AgencyRuntime } = await import('../../../src/agency/runtime.js');
const { agencyRoutes } = await import('../../../src/api/routes/agency.routes.js');
const { DEFAULT_BREAK_REASONS } = await import('@magick-agency/domain/break-manager');

// ── Constants ──────────────────────────────────────────────────────────────

const TENANT = DB_DEFAULTS.tenantId;
const ACCOUNT = DB_DEFAULTS.accountId;
const AGENT_USER = uuidFor('agent-cycle-1');

/**
 * Its own Redis database, and NOT database 7.
 *
 * 7 belongs to the chaos suite, which calls `FLUSHDB` on purpose. `flushTestRedis()`
 * flushes 0. This file is picked up by `npm run test:integration` alongside both,
 * and while `fileParallelism` is false today, a flush landing mid-walk would read
 * exactly like a lease bug — the failure this whole partition keeps re-learning.
 *
 * agency gives each worktree ONE test Redis db (`TEST_REDIS_URL`), so
 * this walk shares it with the chaos suites; with `fileParallelism: false` no two files run at
 * once, which is the property the separate db bought. The `cycle:` prefix is kept.
 */
const KEY_PREFIX = 'cycle:';

/**
 * One second, so the auto-return timer genuinely fires within the test.
 *
 * A real `setTimeout`, not a faked clock: `WrapupManager`'s countdown IS an
 * in-process timer, and a fake clock here
 * would let the harness advance it — which is how a doubled fake clock hid inside
 * a `toBeGreaterThan(0)` earlier in this phase. Everything clock-derived below is
 * asserted against an exact value or a two-sided bound, never a floor.
 */
const WRAPUP_SECONDS = 1;

/** The operator's configured catalog — deliberately NOT the built-in defaults. */
const BREAK_REASONS = [
  { code: 'lunch', label: 'Lunch' },
  { code: 'coaching', label: 'Coaching' },
  { code: 'technical_issue', label: 'Technical issue' },
];

// ── Harness ────────────────────────────────────────────────────────────────

let app: FastifyInstance;
let runtime: InstanceType<typeof AgencyRuntime>;
let redis: Redis;
let bridge: ScriptedBridge;

async function post(path: string, rawBody?: unknown) {
  // decision Q8: `requireOwnedSession` requires the actor the public API layer sends for the
  // session's own agent, so every `/sessions/:id/*` call carries it (the walk is one agent's).
  const body = /^\/sessions\/[^/]+\//.test(path)
    ? { agent_user_id: AGENT_USER, ...((rawBody ?? {}) as Record<string, unknown>) }
    : rawBody;
  return app.inject({
    method: 'POST',
    url: `/api/v1/agency${path}`,
    headers: {
      'x-mgkvc-tenant': TENANT,
      'x-mgkvc-account': ACCOUNT,
      // `content-type` ONLY when there is a body. Sending
      // `application/json` with an empty payload makes Fastify reject the
      // request 400 `FST_ERR_CTP_EMPTY_JSON_BODY` before any handler runs — and
      // several routes here legitimately take no body, so every one of their
      // status assertions would have been measuring the content-type header
      // rather than the route. It cost this file its first red: `/available`
      // returned 400 where the walk expected the 409 `no_station` guard, which
      // reads as a missing guard rather than a malformed request.
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

/**
 * The agent's state as **Redis** holds it — the authority the pacing tick reads.
 *
 * Deliberately separate from the DB reader below. makes Redis the authority
 * and the `agency_agent_sessions` row a mirror, so a transition that writes one
 * and not the other is a real defect class: a row reading `available` for an
 * agent who is actually bridged is how a break gets applied mid-conversation.
 * Every hop below asserts BOTH, and they are asserted separately so a failure
 * says which half diverged.
 */
async function liveState(sessionId: string): Promise<string | null> {
  const s = await runtime.agents.get(sessionId);
  return s?.state ?? null;
}

async function rowState(sessionId: string): Promise<{ state: string; break_reason: string | null }> {
  const { rows } = await getTestPool().query<{ state: string; break_reason: string | null }>(
    'SELECT state, break_reason FROM agency_agent_sessions WHERE id = $1',
    [sessionId],
  );
  return rows[0]!;
}

async function attemptRow(attemptId: string) {
  const { rows } = await getTestPool().query<{ state: string; outcome: string | null; bridged_at: Date | null }>(
    'SELECT state, outcome, bridged_at FROM agency_call_attempts WHERE id = $1',
    [attemptId],
  );
  return rows[0]!;
}

async function liveAttemptIdFor(campaignId: string): Promise<string> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `SELECT id FROM agency_call_attempts WHERE campaign_id = $1 AND state <> 'ended'
      ORDER BY created_at DESC LIMIT 1`,
    [campaignId],
  );
  return rows[0]!.id;
}

/**
 * Wait for the agent's live state to STOP being `from`, then return what it is.
 *
 * A bounded poll rather than a sleep, and it returns the observed value rather
 * than asserting it — so the caller asserts an exact state and a timeout surfaces
 * as "still `wrapup` after 5s" rather than a bare hang. Never used to wait for a
 * state to *arrive*: polling until the value you want appears is how a test comes
 * to supply its own answer.
 */
async function waitForExitFrom(sessionId: string, from: string, budgetMs = 5_000): Promise<string | null> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const s = await liveState(sessionId);
    if (s !== from) return s;
    if (Date.now() > deadline) return s;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/**
 * The same wait, on the **durable mirror** rather than on Redis.
 *
 * Needed because the two are written in order, not together: `releaseAgent` does
 * `agents.set(...)` and *then* `agencyAgentSessionRepository.setState(...)`, so
 * there is a real window in which Redis says `available` and the row still says
 * `wrapup`. makes that correct — Redis is the authority, the row is a
 * best-effort mirror whose write is explicitly allowed to fail — but it means a
 * row assertion placed straight after `waitForExitFrom` is racing the second
 * write.
 *
 * It cost this file a **50% flake** (`secondRow.state` reading `wrapup`), which is
 * the worst possible failure shape: an intermittent red on a gate-criterion test
 * teaches people to re-run it. Fixed by waiting for the mirror rather than by
 * sleeping or by loosening the assertion to "not wrapup" — the value is still
 * asserted exactly, and this returns what it observed rather than polling until
 * the wanted answer appears.
 *
 * Only the timer-driven hops need it. A transition made inside an HTTP request has
 * both writes awaited before the response, so the row is already current there.
 */
async function waitForRowToLeave(sessionId: string, from: string, budgetMs = 5_000): Promise<string> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const row = await rowState(sessionId);
    if (row.state !== from) return row.state;
    if (Date.now() > deadline) return row.state;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('the agent state machine, walked as one cycle (integration)', () => {
  beforeEach(async () => {
    await truncateAll();

    redis = new Redis(TEST_REDIS_URL, {
      keyPrefix: KEY_PREFIX,
      maxRetriesPerRequest: 3,
    });
    await redis.flushdb();

    bridge = new ScriptedBridge();
    runtime = new AgencyRuntime(bridge as never, redis, '');

    // No DNC set is synced here: the pre-dial gate reads `dnc_entries` (decision B8).
    // `dialer.start()` only — NOT `runtime.start()`. The latter starts the pacing
    // supervisor's `setInterval`, and a wall-clock loop racing a scripted walk is
    // how a suite becomes something people re-run rather than read. Ticks are
    // driven explicitly.
    runtime.dialer.start();

    app = Fastify();
    await app.register(async (scope) => agencyRoutes(scope, runtime), { prefix: '/api/v1/agency' });
    await app.ready();
  });

  // Teardown in `afterEach`, never at the end of a test body: a failing
  // assertion mid-walk would otherwise leak a live dialer, a pending wrap-up
  // timer and a Redis connection into the next case — and this file's neighbours
  // call `truncateAll()` and `FLUSHDB`.
  afterEach(async () => {
    runtime.wrapup.stop();
    runtime.dialer.stop();
    await runtime.pacing.stop().catch(() => { /* never started */ });
    runtime.reaper.stop();
    await app?.close();
    await redis.flushdb().catch(() => { /* connection already gone */ });
    redis.disconnect();
  });

  afterAll(closeTestPool);

  it('walks offline → break → available → reserved → on_call → wrapup → break → available → offline, leaving every state', async () => {
    // ── Fixtures ───────────────────────────────────────────────────────────
    const campaign = await insertAgencyCampaign({
      status: 'running',
      wrapup_seconds: WRAPUP_SECONDS,
      wrapup_auto_return: true,
      break_reasons: JSON.stringify(BREAK_REASONS),
      // Empty ON PURPOSE. `requiresDisposition()` returns false for an empty
      // catalog, which is what lets the auto-return timer actually fire — with a
      // non-empty catalog the wrap-up is HELD pending a disposition and the only
      // agent-controlled exit is the unbuilt route. See the file
      // header; the held branch is walked separately at the end via the
      // supervisor exit, which does exist.
      disposition_catalog: '[]',
    });
    // Two contacts: the walk goes round twice, and the second lap is what proves
    // the queued break was CONSUMED rather than merely applied (below).
    await insertAgencyContacts(campaign.id, 2);
    await getTestPool().query(
      `INSERT INTO account_settings (tenant_id, account_id, max_concurrent_calls)
       VALUES ($1, $2, 1)
       ON CONFLICT (tenant_id, account_id) DO UPDATE SET max_concurrent_calls = 1`,
      [TENANT, ACCOUNT],
    );
    // A real override row against the real flag service — the `agency_dialer_enabled`
    // gate is one of the four independent layers a feature needs, and mocking it
    // out would leave the walk unable to say the composition works.
    await getTestPool().query(
      `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value)
       VALUES ('agency_dialer_enabled', 'account', $1, $2, 'true'::jsonb)`,
      [TENANT, ACCOUNT],
    );

    /** Every state actually observed, in order. Asserted as a set at the end. */
    const ledger: string[] = [];
    const observe = async (sessionId: string) => {
      const s = await liveState(sessionId);
      if (s && ledger[ledger.length - 1] !== s) ledger.push(s);
      return s;
    };

    // ── 1. `offline` — the state before there is a session at all ──────────
    //
    // Asserted as the absence of a live key rather than the string 'offline'.
    // Nothing has claimed this agent, so there is nothing for the tick to count,
    // which is what `offline` MEANS here.
    const preJoin = await getTestPool().query(
      'SELECT id FROM agency_agent_sessions WHERE campaign_id = $1', [campaign.id],
    );
    expect(preJoin.rows).toHaveLength(0);
    ledger.push('offline');

    // ── 2. `offline → break` — joining ─────────────────────────────
    //
    // NOT `offline → available`. The rule is that every joining agent lands every joining or rehydrating agent in
    // `break`, never `available`, because the engine must not dial into a pool
    // that has not demonstrably re-attached a socket. So the honest first hop is
    // into `break`, and the diagram's `offline → available` edge is really two.
    const join = await post('/sessions', { campaign_id: campaign.id, agent_user_id: AGENT_USER });
    expect(join.statusCode).toBe(201);
    const bootstrap = join.json();
    const sessionId = bootstrap.session_id as string;
    expect(bootstrap.state).toBe('break');
    expect(await observe(sessionId)).toBe('break');
    expect((await rowState(sessionId)).state).toBe('break');

    // The bootstrap advertises the operator's catalog, not the built-ins — the
    // single-authority claim in `resolveBreakReasons`. Asserted here because the
    // rejection below echoes the same list, and if bootstrap and validation drew
    // on different sources the agent's console would offer a code the server
    // refuses. Both halves, or neither is proven.
    expect(bootstrap.break_reasons).toEqual(BREAK_REASONS);
    expect(bootstrap.break_reasons).not.toEqual(DEFAULT_BREAK_REASONS);
    expect(bootstrap.wrapup_seconds).toBe(WRAPUP_SECONDS);
    expect(bootstrap.wrapup_auto_return).toBe(true);

    // ── 3. `break` cannot be left without a station ────────────────────────
    //
    // The INVERSE assertion, and it is what stops step 4 from being vacuous.
    // "The agent went available" is satisfied just as well by a route that lets
    // anyone go available at any time — which is a defect, not a feature: the
    // tick would dial into an agent with no media path and manufacture exactly
    // the abandoned call reserve-before-dial exists to prevent. So: no socket, no
    // pool.
    const noStation = await post(`/sessions/${sessionId}/available`);
    expect(noStation.statusCode).toBe(409);
    expect(noStation.json().code).toBe('no_station');
    expect(await liveState(sessionId)).toBe('break'); // and it did not move them

    // ── 4. `break → available` — the one click that opens the pool ─────────
    const socket = new FakeStationSocket();
    await runtime.stations.attach({
      sessionId,
      campaignId: campaign.id,
      tenantId: TENANT,
      accountId: ACCOUNT,
      agentUserId: AGENT_USER,
      ws: socket as never,
    });

    const goAvailable = await post(`/sessions/${sessionId}/available`);
    expect(goAvailable.statusCode).toBe(200);
    expect(await observe(sessionId)).toBe('available');
    expect((await rowState(sessionId)).state).toBe('available');
    // Leaving `break` must clear the reason, or a supervisor dashboard shows an
    // available agent still labelled "Lunch" for the rest of the shift.
    expect((await rowState(sessionId)).break_reason).toBeNull();

    // ── 5. A break reason outside the catalog is REFUSED by the server ─────
    //
    // Criterion 2 says "break with a reason code", and the load-bearing word is
    // *code*: free text reaching `break_reason` fails the gate. This is the only
    // assertion in the walk that the validation is server-side — a console-side
    // menu is not a validator, so the catalog has to be enforced here.
    const badReason = await post(`/sessions/${sessionId}/break`, { reason: 'just because' });
    expect(badReason.statusCode).toBe(400);
    expect(badReason.json().code).toBe('unknown_break_reason');
    // The valid set is echoed, so a console holding a stale catalog recovers in
    // one round trip instead of stranding an agent who cannot go on break.
    expect(badReason.json().allowed_codes).toEqual(BREAK_REASONS.map((r) => r.code));
    // A built-in code must ALSO be refused once the operator has configured a
    // catalog. Without this the test passes against a validator that accepts the
    // union of configured and default codes, which would silently let a campaign
    // that deliberately removed a reason keep accepting it.
    const builtInReason = await post(`/sessions/${sessionId}/break`, { reason: 'admin' });
    expect(builtInReason.statusCode).toBe(400);
    expect(builtInReason.json().code).toBe('unknown_break_reason');
    // And a rejected break does not move the agent — twice refused, still pooled.
    expect(await liveState(sessionId)).toBe('available');

    // ── 6. `available → reserved` — the pacing CAS ─────────────────────────
    //
    // The tick and the carrier are advanced SEPARATELY here, unlike the chaos
    // harness's `tick()` which does both. `reserved` is only observable between
    // them: `bridge.flush()` would carry the agent straight through to `on_call`
    // and the walk would skip a state while appearing to pass.
    bridge.setDefaultScript({ answer: true, bridge: true, status: 'completed', talkTimeSeconds: 12, hold: true });
    await runtime.pacing.tickOnce(campaign.id);

    expect(await observe(sessionId)).toBe('reserved');
    const attemptOne = await liveAttemptIdFor(campaign.id);

    // The reservation names the real attempt by the time the tick returns.
    //
    // Note what this does NOT assert, because getting it wrong once is instructive:
    // `pacing-engine.ts` reserves with a `'reserving'` MARKER rather than an
    // id, since reserve-before-dial holds the agent before the attempt exists.
    // That marker is genuinely unobservable from here — it lives only inside
    // `tickOnce`, between the CAS and `executeDial` overwriting it, with no await
    // boundary a caller can interleave on. So the honest claim at this hop is the
    // post-condition: `reserved`, carrying the attempt that will be bridged.
    // Pinning the marker would need a unit-tier seam and belongs there.
    //
    // A `reserved` with no attempt attached is an agent nothing can bridge to,
    // which is why this is asserted rather than left implicit in the state string.
    const reservedLive = await runtime.agents.get(sessionId);
    expect(reservedLive!.attemptId).toBe(attemptOne);

    // ── 7. A break requested from `reserved` must QUEUE, not apply ─────────
    //
    // The case makes easy to miss. An agent reserved for a dial already at
    // the carrier is about to be bridged to someone who is about to answer;
    // applying a break there produces the abandoned call the whole reservation
    // design is meant to prevent.
    const breakWhileReserved = await post(`/sessions/${sessionId}/break`, { reason: 'lunch' });
    expect(breakWhileReserved.statusCode).toBe(200);
    expect(breakWhileReserved.json().pending_state).toBe('break');
    expect(breakWhileReserved.json().state).toBe('reserved');
    // Queued, and observably so. The agent's Redis state is deliberately
    // unchanged while a break waits, so state alone cannot tell a correctly
    // queued break from a silently dropped one — the registry is the only honest
    // observer, and it must be the ONE registry the routes wrote into.
    expect(runtime.breaks.peek(sessionId)?.code).toBe('lunch');
    expect(await liveState(sessionId)).toBe('reserved');

    // ── 8. …and a queued break can be taken back ──────────────────────────
    //
    // Cancelled here so the walk can reach `wrapup` and then re-enter `break` by
    // the other mechanism. Without this route the window between asking for a
    // break mid-call and it landing at wrap-up end is un-undoable: `/available`
    // acts on the current state and leaves the queue alone, so the break would
    // still arrive the moment wrap-up ended.
    const cancel = await post(`/sessions/${sessionId}/break/cancel`);
    expect(cancel.statusCode).toBe(200);
    expect(runtime.breaks.peek(sessionId)).toBeNull();
    expect(await liveState(sessionId)).toBe('reserved');

    // ── 9. `reserved → on_call` — the bridge ───────────────────────────────
    await bridge.flush();
    expect(await observe(sessionId)).toBe('on_call');
    expect((await attemptRow(attemptOne)).state).toBe('bridged');
    expect((await attemptRow(attemptOne)).bridged_at).not.toBeNull();
    // The MIRROR of this hop, which nothing else in this
    // file asserts. The supervisor breakdown reads `agents_by_state` off this row,
    // and before the mirror existed it showed agents idle while they were talking
    // to customers — the row still held the `available` written back at step 4.
    //
    // Waited for, not read: `AgencyDialer` does `agents.set(…)` and only THEN the
    // best-effort `setState(…, 'on_call')`, so `bridge.flush()` can release with
    // the row write still in flight — the same second-write race step 11 documents.
    // Unambiguous here in a way it is not later: the row has been `available` since
    // step 4 and `wrapup` is several steps away, so exactly one write can move it.
    //
    // `reserved` is deliberately NOT mirrored and must stay that way (see
    // `dialUpTo`) — which is why this hop, not the one before it, is where the row
    // first departs `available`.
    expect(await waitForRowToLeave(sessionId, 'available')).toBe('on_call');
    // …and NOW the live state names the real attempt, where step 6 held only the
    // marker. The pair is the assertion: a hash that carried `reserving` all the
    // way through a bridged call would leave the lease renewer and the deferred
    // hangup with nothing to key on.
    expect((await runtime.agents.get(sessionId))!.attemptId).toBe(attemptOne);

    // ── 10. A break requested from `on_call` queues too ───────────────────
    //
    // This one is NOT cancelled: it is the break that will apply at the end of
    // wrap-up, which is how the walk re-enters `break` — the "applied after
    // wrap-up", never mid-conversation.
    const breakWhileOnCall = await post(`/sessions/${sessionId}/break`, { reason: 'technical_issue' });
    expect(breakWhileOnCall.statusCode).toBe(200);
    expect(breakWhileOnCall.json().pending_state).toBe('break');
    expect(breakWhileOnCall.json().state).toBe('on_call');
    expect(runtime.breaks.peek(sessionId)?.code).toBe('technical_issue');
    // Mid-conversation is exactly what must not happen.
    expect(await liveState(sessionId)).toBe('on_call');

    // ── 11. `on_call → wrapup` ─────────────────────────────────────────────
    await bridge.endHeld();
    // `waitForExitFrom('on_call')`, NOT a bare read. The harness's absorption
    // barrier waits for the attempt row to reach `ended`, and `setState(…,
    // 'ended')` runs BEFORE `wrapup.enter()` in the dialer's teardown — so the
    // barrier releases while the agent is still `on_call` and the wrap-up write is
    // in flight. Read immediately, this hop is a coin flip: it passed on lap one
    // and failed on lap two of the very same walk.
    //
    // The helper waits for ANY exit and hands back what it found; the assertion
    // then names `wrapup` exactly. Polling until `wrapup` appears would be the
    // test supplying its own answer, and would pass just as happily against a
    // machine that reached `wrapup` via `available` — which is a real defect,
    // because a returned-then-withdrawn agent can be reserved in the gap.
    expect(await waitForExitFrom(sessionId, 'on_call')).toBe('wrapup');
    await observe(sessionId);
    // The MIRROR, waited for rather than read straight away — the same second-write
    // race step 12 documents, but on wrap-up's ENTRY rather than its exit, which is
    // why it was missed here. `WrapupManager.enter` does `agents.set(…, 'wrapup')`
    // and only THEN `agencyAgentSessionRepository.setState(…, 'wrapup')`, so the
    // `waitForExitFrom` above releases on the Redis write while the row write is
    // still in flight.
    //
    // ── Waited from `on_call`, not from `available` — the row walks both now ──
    //
    // This read `waitForRowToLeave(…, 'available')` on the stated premise that
    // "nothing mirrors `reserved` or `on_call`", so the row sat at the `available`
    // written back at step 4 right through the call and the only mirror write it
    // could possibly see next was `wrapup`.
    //
    // The durable mirror makes that false for exactly one of the two states (step 9), and
    // the wait became a race the moment it landed: the row leaves `available` at
    // the bridge, so by the time control reaches here the helper returns on
    // whichever of `on_call` or `wrapup` the poll happens to catch. It caught
    // `wrapup` often enough to pass on the branch that introduced it and to pass
    // one CI shard while failing another — the intermittent-red-on-a-gate-criterion
    // shape this helper's own doc comment calls the worst possible one.
    //
    // Naming `on_call` as the departure state restores the helper's contract: one
    // known starting state, one write that can move it, and the landing state still
    // asserted exactly rather than polled for until the wanted answer appears.
    expect(await waitForRowToLeave(sessionId, 'on_call')).toBe('wrapup');
    expect((await attemptRow(attemptOne)).outcome).toBe('connected');

    // The window is REAL, and this is the assertion that makes "auto-return"
    // mean something. An implementation with no wrap-up at all — straight from
    // `on_call` back to `available` — satisfies every "the agent returned"
    // assertion that could be written about step 12. So: they are in `wrapup`
    // now, and the countdown is armed with the operator's number.
    const wrapup = runtime.wrapup.stateFor(sessionId);
    expect(wrapup).not.toBeNull();
    expect(wrapup!.attempt_id).toBe(attemptOne);
    expect(wrapup!.seconds_total).toBe(WRAPUP_SECONDS); // exact, not a floor
    expect(wrapup!.auto_return).toBe(true);
    expect(wrapup!.held_reason).toBeNull();
    // Two-sided bound on the only clock-derived value, because a floor is what
    // hid a doubled fake clock earlier in this phase: a countdown armed for twice
    // the configured window fails the upper bound rather than passing a `> 0`.
    const remainingMs = new Date(wrapup!.ends_at!).getTime() - Date.now();
    expect(remainingMs).toBeGreaterThan(0);
    expect(remainingMs).toBeLessThanOrEqual(WRAPUP_SECONDS * 1000);

    // ── 12. `wrapup → break` — auto-return, with the queued break applied ─
    const afterWrapup = await waitForExitFrom(sessionId, 'wrapup');
    // EXACTLY `break`, not merely "not wrapup". Landing in `available` here would
    // mean the queued break was dropped on the one path that is supposed to
    // deliver it, and an agent who asked for a break mid-call would be handed
    // another customer instead.
    expect(afterWrapup).toBe('break');
    ledger.push('break');
    // The MIRROR, waited for rather than read straight away — see
    // `waitForRowToLeave`. Redis moved first; this is the second write.
    expect(await waitForRowToLeave(sessionId, 'wrapup')).toBe('break');
    const afterRow = await rowState(sessionId);
    expect(afterRow.state).toBe('break');
    // The REASON survives to the durable row — a break with no reason code is
    // the thing criterion 2 refuses to accept.
    expect(afterRow.break_reason).toBe('technical_issue');
    // Wrap-up was LEFT, not merely entered: no entry, no timer, nothing that
    // could return an agent who is already back.
    expect(runtime.wrapup.stateFor(sessionId)).toBeNull();
    // And consumed exactly once, which is why `take()` is consuming rather than
    // peeking. A registry that left the entry in place would pull this agent back
    // out of the pool at the end of their NEXT call — step 15 is where that
    // would surface, and it can only surface if this walk continues.
    expect(runtime.breaks.peek(sessionId)).toBeNull();

    // ── 13. `break → available`, the second time ───────────────────────────
    const backFromBreak = await post(`/sessions/${sessionId}/available`);
    expect(backFromBreak.statusCode).toBe(200);
    expect(await observe(sessionId)).toBe('available');
    expect((await rowState(sessionId)).break_reason).toBeNull();

    // ── 14–15. Second lap: wrap-up auto-return to `available` ─────────────
    //
    // The criterion says "wrap-up with auto-return", and lap one could not show
    // it: the queued break diverted the return. This lap has no queued break, so
    // it demonstrates the plain auto-return AND — the same assertion, from the
    // other side — that the consumed break did not re-apply.
    await runtime.pacing.tickOnce(campaign.id);
    expect(await liveState(sessionId)).toBe('reserved');
    const attemptTwo = await liveAttemptIdFor(campaign.id);
    expect(attemptTwo).not.toBe(attemptOne);
    await bridge.flush();
    expect(await liveState(sessionId)).toBe('on_call');
    await bridge.endHeld();
    expect(await waitForExitFrom(sessionId, 'on_call')).toBe('wrapup');
    await observe(sessionId);

    const afterSecondWrapup = await waitForExitFrom(sessionId, 'wrapup');
    expect(afterSecondWrapup).toBe('available');
    expect(await waitForRowToLeave(sessionId, 'wrapup')).toBe('available');
    const secondRow = await rowState(sessionId);
    expect(secondRow.state).toBe('available');
    expect(secondRow.break_reason).toBeNull();

    // ── 16. The held branch, and its one existing exit ────────────────────
    //
    // Everything above ran with an empty `disposition_catalog`. Flip it on the
    // live campaign and the next wrap-up is HELD — `ends_at: null`,
    // `held_reason: 'disposition_required'`, no timer — which is a state that can
    // be entered and, until the agent-side disposition route exists, cannot be left by the agent. That
    // is precisely the failure mode criterion 2 names, so it needs its exit
    // walked rather than assumed.
    await getTestPool().query(
      `UPDATE agency_campaigns SET disposition_catalog = $2::jsonb WHERE id = $1`,
      [campaign.id, JSON.stringify([{ code: 'sale', label: 'Sale' }])],
    );
    await insertAgencyContacts(campaign.id, 1, { source_row_number: 900 });
    await runtime.pacing.tickOnce(campaign.id);
    await bridge.flush();
    await bridge.endHeld();

    expect(await waitForExitFrom(sessionId, 'on_call')).toBe('wrapup');

    // ── Two phases, and conflating them is a real mistake ─────────────────
    //
    // A required disposition on a TIMED wrap-up does not hold immediately. The
    // countdown runs first (`ends_at` set, `held_reason` null) and the hold is
    // applied by `onExpiry` when the timer fires. The timerless form
    // (`wrapup_seconds = 0` + a required disposition) is the one that is held
    // from the instant it starts.
    //
    // Asserting the held shape straight after `endHeld()` failed here, and the
    // failure was the useful kind: it would have been "fixed" just as easily by
    // relaxing the assertion, which would have left the walk unable to tell a
    // wrap-up that holds at expiry from one that auto-returns at expiry — the
    // difference between a disposition being required and being optional.
    const counting = runtime.wrapup.stateFor(sessionId);
    expect(counting).not.toBeNull();
    expect(counting!.requires_disposition).toBe(true);
    expect(counting!.held_reason).toBeNull();
    expect(counting!.ends_at).not.toBeNull();

    // Now let the timer fire. The agent must NOT be returned: `auto_return` is
    // on, so an implementation that ignored the outstanding disposition would
    // send them straight back to `available` and the record of the call they
    // just had would never be captured. `waitForExitFrom` returning `'wrapup'`
    // is the assertion — the budget elapsed and they are still here.
    expect(await waitForExitFrom(sessionId, 'wrapup', 2_500)).toBe('wrapup');
    const held = runtime.wrapup.stateFor(sessionId);
    expect(held).not.toBeNull();
    expect(held!.held_reason).toBe('disposition_required');
    // The deadline is CLEARED on hold, not left pointing at a past instant: the
    // console renders `ends_at: null` as "ends when you act", where a stale
    // timestamp renders as a countdown that already expired and never fired.
    expect(held!.ends_at).toBeNull();

    // The agent's own control must NOT release it. Collapsing "I'm ready" and
    // "I'm done writing up" would let an agent skip every disposition by
    // clicking Available, and a disposition is the record of what was said to a
    // customer.
    const skipAttempt = await post(`/sessions/${sessionId}/available`);
    expect(skipAttempt.statusCode).toBe(409);
    expect(skipAttempt.json().code).toBe('attempt_not_dispositionable');
    expect(await liveState(sessionId)).toBe('wrapup');

    // The supervisor exit does exist, and it is gated at `agency.supervise` in
    // the public API layer — out of an `agent`'s reach entirely — so the route that can
    // skip a disposition is one the person who would benefit cannot call.
    const forced = await post(`/sessions/${sessionId}/force-available`);
    expect(forced.statusCode).toBe(200);
    expect(await waitForExitFrom(sessionId, 'wrapup')).toBe('available');
    expect(runtime.wrapup.stateFor(sessionId)).toBeNull();

    // ── 17. `* → offline` — logout, closing the cycle ─────────────────────
    const leave = await post(`/sessions/${sessionId}/leave`);
    expect(leave.statusCode).toBe(200);
    // The live key is GONE, not set to a string: `offline` is the absence of
    // presence, and a lingering key is an agent the tick could still count.
    expect(await liveState(sessionId)).toBeNull();
    expect((await rowState(sessionId)).state).toBe('offline');
    ledger.push('offline');

    // ── The ledger ────────────────────────────────────────────────────────
    //
    // Criterion 2 as a single readable assertion, so "all six states" is
    // something a reviewer can check rather than infer from 200 lines of walk.
    // Built by observation during the walk — never asserted from a list this test
    // wrote in advance, which would be the same mistake in a new place.
    expect(new Set(ledger)).toEqual(
      new Set(['offline', 'break', 'available', 'reserved', 'on_call', 'wrapup']),
    );
    // And every state was LEFT: the walk ended where it started, so nothing on
    // the path was a one-way door. A trapped state cannot produce this sequence
    // however many individual transitions pass.
    expect(ledger[0]).toBe('offline');
    expect(ledger[ledger.length - 1]).toBe('offline');
    // Two full laps of the pool, so `available` and `wrapup` were each entered
    // and left more than once. A state that can be left exactly once is a
    // different bug from one that cannot be left at all, and only a repeated
    // circuit distinguishes them.
    expect(ledger.filter((s) => s === 'available').length).toBeGreaterThanOrEqual(2);
    expect(ledger.filter((s) => s === 'wrapup').length).toBeGreaterThanOrEqual(2);
  });
});
