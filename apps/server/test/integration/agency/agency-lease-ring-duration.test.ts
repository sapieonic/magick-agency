import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
/*
 * Harness plumbing: the connection mock targets agency's `@magick-agency/db` (and its
 * `/connection` entry, which packages/db's repositories import); the config stub
 * carries no carrier config; import specifiers per the path
 * rule (domain leaves, `@magick-agency/contracts/agency`). `TEST_REDIS_URL`/`LEASE_DB` are the worktree's agency test Redis (see the note at the constant).
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import {
  closeTestPool,
  getTestPool,
  truncateAll,
} from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgencyContact, insertAgentSession } from './agency-factories.js';
import { TEST_REDIS_URL as AGENCY_TEST_REDIS_URL } from '../../helpers/test-redis.js';

// The DB pool lives in `@magick-agency/db`
// (the server's repositories import its root, packages/db's repositories `./connection`).
vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));
vi.mock('@magick-agency/db/connection', () => ({ getPool: () => getTestPool() }));

// `AgencyDialer` imports `WebRtcCallError` from the bridge — a value import, so
// the whole config graph loads, and `loadConfig` calls `process.exit(1)` on an
// incomplete schema. The repo `.env` does not satisfy every pipeline it enables,
// so without this the SUITE dies at import with no tests run. Same mock the unit
// tier uses. We never construct a real bridge here (the fake one below is the
// point of the test), so nothing real reads these values.
vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {}, // no carrier config is needed
  },
}));

const { AgentStateMachine, AGENT_LEASE_MS } = await import('../../../src/agency/agent-state-machine.js');
const { AgencyDialer } = await import('../../../src/agency/agency-dialer.js');
const { WrapupManager } = await import('../../../src/agency/wrapup-manager.js');
const { BreakRegistry } = await import('@magick-agency/domain/break-manager');
const { agencyAttemptRepository } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * The dialer with the collaborator set `AgencyRuntime` actually gives it.
 *
 * This file called `new AgencyDialer(bridge, stations, agents)` against a
 * five-parameter constructor, leaving `this.wrapup` and `this.breaks` undefined.
 * It did not go red here only because T-L2 never reaches `releaseAgent` — the
 * same drift failed T-P5 in `agency-context-ordering.test.ts` outright. Caught by
 * `npm run lint:test` (`TS2554`), which `npm run lint` structurally cannot see.
 */
function dialerWith(bridge: unknown, stations: never, agents: InstanceType<typeof AgentStateMachine>) {
  // `: Promise<void>` breaks the wrapup->dialer inference cycle; without it `tsc`
  // types both as `any` (TS7022) and stops checking arity at this call site.
  const wrapup = new WrapupManager(
    stations, agents,
    (sessionId: string): Promise<void> => dialer.releaseAgent(sessionId),
  );
  const dialer = new AgencyDialer(bridge as never, stations, agents, wrapup, new BreakRegistry());
  return dialer;
}

/**
 * T-L2 — the ring-duration lease. THE regression test for this feature.
 *
 * The bug this exists to prevent shipped in the first draft of the design and is
 * worth restating, because it breaks the central promise on the HAPPY PATH:
 *
 *   Carrier no-answer timeouts run 30–45s. Contact A rings 25s. Under a single
 *   flat 20s lease the reservation expires at t=20s, the agent flips back to
 *   `available`, the next tick reserves them for contact B — and then contact A
 *   answers at t=25s with no agent to bridge to. A structurally abandoned call,
 *   produced by the mechanism meant to prevent abandonment.
 *
 * So: real Redis, real `PTTL`, real wall-clock. Fake timers cannot test this —
 * an ioredis TTL is evaluated server-side and does not move when Vitest's clock
 * does, so a fake-timer version of this test passes against the very bug it
 * claims to catch.
 *
 * Cost: ~105s of wall time across three ring durations. That is why this lives
 * in its own file — CI shards the integration suite by FILE across
 * `parallelism: 2`, so bundling it with fast tests puts the whole 105s on one
 * shard.
 */

/** A station socket that is open and records what was written to it. */
class FakeStationSocket extends EventEmitter {
  readyState = 1;
  readonly sent: unknown[] = [];
  send(raw: string): void {
    this.sent.push(JSON.parse(raw));
  }
  close(): void {
    this.readyState = 3;
  }
}

/** Minimal StationRegistry surface the dialer actually uses. */
function fakeStations(sessionId: string, socket: FakeStationSocket) {
  return {
    socketFor: (id: string) => (id === sessionId ? socket : undefined),
    isLocallyOwned: (id: string) => id === sessionId,
    send: (id: string, frame: unknown) => {
      if (id !== sessionId || socket.readyState !== 1) return false;
      socket.send(JSON.stringify(frame));
      return true;
    },
  } as never;
}

/**
 * A bridge that rings for `ringMs` and then answers.
 *
 * `createBridgedCall` resolves as soon as the leg is placed (as the real one
 * does); the answer arrives later on the lifecycle channel, which is exactly the
 * shape that makes the lease window load-bearing.
 */
function fakeBridge(ringMs: number) {
  const listeners: ((ev: unknown) => void)[] = [];
  const timers: NodeJS.Timeout[] = [];
  return {
    timers,
    onLifecycle(l: (ev: unknown) => void) {
      listeners.push(l);
      return () => { /* no-op */ };
    },
    async createBridgedCall(params: { agencyAttemptId: string }) {
      const callId = randomUUID();
      const t = setTimeout(() => {
        for (const l of listeners) {
          l({
            callId,
            correlationId: params.agencyAttemptId,
            phase: 'bridged',
            status: 'in_progress',
            answered: true,
          });
        }
      }, ringMs);
      timers.push(t);
      return { id: callId };
    },
  };
  // NOT `as never` — `dialerWith` takes `unknown` and casts at the constructor, so
  // the cast only erased `timers`, which `openTimerBags.push(bridge.timers)` below
  // depends on for its `afterEach` cleanup.
}

/**
 * A PRIVATE Redis database for this file, and the reason matters.
 *
 * The shared helper `flushTestRedis()` calls `FLUSHDB` on database 0. These
 * tests hold a key alive for up to 45 seconds, which is a very wide window for
 * any OTHER integration run on the same Docker stack to flush database 0 out
 * from under them — and this worktree is shared by several people, so
 * overlapping runs happen. That was not hypothetical: it produced exactly this
 * failure, with the key vanishing (`PTTL -2`) at a DIFFERENT second on each arm,
 * which reads convincingly like a lease bug and is not one.
 *
 * Database 6 is touched by nothing else, so a concurrent `FLUSHDB` on 0 cannot
 * reach it. Note the Postgres side is still shared — `truncateAll()` is global —
 * so overlapping integration runs remain an operational hazard in general. This
 * only fixes the part that a test can fix.
 */
// The worktree's whole test db (6383, `.test-env.local.json`) is already private to this
// checkout, and every other db index belongs to another worktree or stack, so the
// "private database" is the worktree's own — read off the agency harness URL. A
// hard-coded fallback URL would risk reaching another stack's port.
const TEST_REDIS_URL = AGENCY_TEST_REDIS_URL;
const LEASE_DB = Number(new URL(TEST_REDIS_URL).pathname.replace(/^\//, '') || '0');
let redis: Redis;

/**
 * Distinguish "the lease broke" from "the environment moved under us".
 *
 * `truncateAll()` is global and this worktree is shared, so a concurrent
 * integration run on the same Docker stack will TRUNCATE these tables and
 * FLUSHDB Redis in the middle of a 45-second window. When that happens the
 * symptoms are indistinguishable from a real lease failure — the key is gone,
 * the row is gone — and the test would report a lease bug that does not exist.
 * That is the worst possible outcome for a regression test: it burns the
 * credibility of the one assertion that must be trusted.
 *
 * So: before blaming the mechanism, check whether our own fixture still exists.
 * If it does not, something else truncated it, and we say so.
 */
async function assertNoConcurrentTruncate(campaignId: string): Promise<void> {
  const { rows } = await getTestPool().query(
    'SELECT id FROM agency_campaigns WHERE id = $1',
    [campaignId],
  );
  if (rows.length === 0) {
    throw new Error(
      'ENVIRONMENT, NOT A LEASE FAILURE: this test\'s own campaign row disappeared mid-run, ' +
      'which means another integration run truncated the shared test database while this ' +
      '45-second window was open. Re-run on a quiet stack — `ps aux | grep vitest` first. ' +
      'Overlapping integration runs against one Docker stack are not safe; see the test plan\'s ' +
      'environment section.',
    );
  }
}

describe('agency lease lifecycle — ring duration (integration, slow)', () => {
  beforeAll(() => {
    redis = new Redis(TEST_REDIS_URL, { keyPrefix: 'test:', db: LEASE_DB });
  });
  /**
   * Cleanup MUST be `afterEach`, not the last statements of the test body.
   *
   * When an `it.each` case fails, its assertion throws and any trailing
   * `dialer.stop()` / `clearTimeout` never runs — so a live `AgencyDialer` with
   * its 5s lease renewers, plus pending fake-bridge ring timers, leak into the
   * NEXT case, which then flushes the same Redis database in its own
   * `beforeEach` while they are still firing. That turns one failure into a
   * cascade and makes the failing set move between runs, which is exactly the
   * behaviour that made this suite look nondeterministic.
   */
  const openDialers: { stop(): void }[] = [];
  // The bridge's ring timer is created later, inside `createBridgedCall`, so we
  // register the BAG (by reference) and drain it in afterEach — registering a
  // snapshot here would capture an empty array and clean up nothing.
  const openTimerBags: NodeJS.Timeout[][] = [];

  beforeEach(async () => {
    await truncateAll();
    await redis.flushdb();
  });

  afterEach(() => {
    for (const d of openDialers.splice(0)) {
      try { d.stop(); } catch { /* already stopped */ }
    }
    for (const bag of openTimerBags.splice(0)) {
      for (const t of bag.splice(0)) clearTimeout(t);
    }
  });
  afterAll(async () => {
    redis.disconnect();
    await closeTestPool();
  });

  it.each([25_000, 35_000, 45_000])(
    'T-L2: a contact ringing %ims never loses its reserved agent',
    async (ringMs) => {
      const agents = new AgentStateMachine(redis, '');
      const campaign = await insertAgencyCampaign({ status: 'running' });
      const contact = await insertAgencyContact(campaign.id);
      const session = await insertAgentSession(campaign.id, { state: 'available' });

      const socket = new FakeStationSocket();
      const bridge = fakeBridge(ringMs);
      const dialer = dialerWith(bridge, fakeStations(session.id, socket), agents);
      dialer.start();
      // Registered for afterEach cleanup BEFORE any assertion can throw.
      openDialers.push(dialer);
      openTimerBags.push(bridge.timers as NodeJS.Timeout[]);

      // Put the agent in the pool and reserve them, exactly as the tick does.
      await agents.set(session.id, 'available', { leaseMs: AGENT_LEASE_MS.available });
      expect(await agents.reserve(session.id, `${campaign.id}:${contact.id}`)).toBe('reserved');

      const attempt = await agencyAttemptRepository.create({
        campaignId: campaign.id,
        contactId: contact.id,
        tenantId: campaign.tenant_id,
        accountId: campaign.account_id,
        callerId: '+919000000001',
        reservedAgentId: session.id,
      });
      expect(attempt).not.toBeNull();

      const key = `agency:agent:${session.id}:state`;

      // Dial. Do NOT await to completion of the ring — we need to sample during it.
      const dialing = dialer.executeDial({
        attemptId: attempt!.id,
        campaignId: campaign.id,
        contactId: contact.id,
        sessionId: session.id,
        ownerReplica: 'replica-test',
        tenantId: campaign.tenant_id,
        accountId: campaign.account_id,
        callerId: '+919000000001',
        attemptNumber: 1,
        campaign,
        contact,
      } as never);
      await dialing;

      // ── Sample every second for the ring, stopping just short of the answer ──
      //
      // The window is deadline-based rather than a fixed sample count: each
      // iteration costs a sleep plus two Redis round-trips, so a counted loop
      // drifts and the last sample lands ON the answer, where `on_call` is the
      // CORRECT state. Stopping 2s short keeps this assertion strictly about the
      // ring, and the post-answer state is asserted separately below — so the
      // test cannot pass by accident on a boundary.
      const samples: { t: number; state: string | null; attempt: string | null; pttl: number }[] = [];
      const startedAt = Date.now();
      const sampleUntil = startedAt + ringMs - 2_000;
      while (Date.now() < sampleUntil) {
        await new Promise((r) => setTimeout(r, 1000));
        if (Date.now() >= sampleUntil) break;
        const h = await redis.hgetall(key);
        const pttl = await redis.pttl(key);
        samples.push({
          t: Math.round((Date.now() - startedAt) / 1000),
          state: h?.state ?? null,
          attempt: h?.attempt ?? null,
          pttl,
        });
      }

      // The window must actually have spanned the interesting region. A flat 20s
      // lease is only detectable if we sampled past 20s, so for the 25s+ arms
      // this guards against the loop degenerating.
      expect(samples.length).toBeGreaterThanOrEqual(Math.floor(ringMs / 1000) - 4);
      expect(samples.at(-1)!.t).toBeGreaterThan(20);

      // THE assertion: `reserved` at EVERY sample. Under a flat 20s lease the
      // t=20 sample is null and this fails with a readable timeline.
      // If our own fixture was truncated by a concurrent run, say THAT rather
      // than reporting a lease failure that did not happen.
      if (samples.some((s) => s.state === null)) await assertNoConcurrentTruncate(campaign.id);

      const lost = samples.filter((s) => s.state !== 'reserved');
      expect(
        lost,
        `agent left 'reserved' during a ${ringMs}ms ring: ${JSON.stringify(lost)}`,
      ).toEqual([]);

      // The lease never lapsed (PTTL > 0 throughout) and never grew beyond the
      // documented dialing lease — a renewer that quietly extends to minutes is
      // a business timer in disguise.
      for (const s of samples) {
        expect(s.pttl).toBeGreaterThan(0);
        expect(s.pttl).toBeLessThanOrEqual(AGENT_LEASE_MS.reserved_dialing);
      }

      // The agent stayed bound to THIS attempt the whole time — nothing else
      // reserved them out from under the ringing call.
      const boundTo = new Set(samples.map((s) => s.attempt));
      expect(boundTo.size).toBe(1);
      expect([...boundTo][0]).toBe(attempt!.id);

      // ── The answer lands, and it lands on the same agent ────────────────
      // Wait past the ring plus the bridge's own async handling.
      await new Promise((r) => setTimeout(r, Math.max(0, startedAt + ringMs - Date.now()) + 2_000));
      await assertNoConcurrentTruncate(campaign.id);
      const after = await redis.hgetall(key);
      expect(after.state).toBe('on_call');
      expect(after.attempt).toBe(attempt!.id);

      const bridgedFrame = socket.sent.find((f) => (f as { event: string }).event === 'bridged');
      expect(bridgedFrame).toBeTruthy();

      const row = await agencyAttemptRepository.findById(attempt!.id);
      expect(row?.state).toBe('bridged');
      expect(row?.outcome).not.toBe('abandoned');

      // Zero-abandonment, measured by the abandonment predicate.
      const { rows } = await getTestPool().query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM agency_call_attempts
          WHERE campaign_id = $1
            AND answered_at IS NOT NULL
            AND (outcome = 'abandoned' OR bridged_at IS NULL
                 OR bridged_at - answered_at > interval '1 second')`,
        [campaign.id],
      );
      expect(Number(rows[0]!.n)).toBe(0);

    },
    90_000,
  );

  it('T-L3: when the renewer stops, the lease lapses — it is still a liveness detector', async () => {
    // The complement to T-L2. If the fix for "never expires mid-ring" were
    // "make the lease enormous", this test would fail: the TTL must still
    // detect a dead owner promptly.
    const agents = new AgentStateMachine(redis, '');
    const sessionId = randomUUID();

    await agents.set(sessionId, 'available', { leaseMs: AGENT_LEASE_MS.available });
    await agents.reserve(sessionId, 'attempt-x');
    // Move to the dialing lease, then never renew — i.e. the owning replica died.
    await agents.transition(sessionId, 'reserved', 'reserved', {
      attemptId: 'attempt-x',
      leaseMs: AGENT_LEASE_MS.reserved_dialing,
    });

    const key = `agency:agent:${sessionId}:state`;
    expect(await redis.pttl(key)).toBeGreaterThan(0);

    // Well inside the 15s dialing lease, the agent is still there...
    await new Promise((r) => setTimeout(r, 10_000));
    expect((await redis.hgetall(key)).state).toBe('reserved');

    // ...and past it, they are gone. Nothing renewed, so nothing survives.
    await new Promise((r) => setTimeout(r, 6_000));
    expect(await agents.get(sessionId)).toBeNull();
  }, 40_000);

  it('T-L4a: business configuration does not leak into any liveness TTL', async () => {
    // Configuration invariance. Two campaigns whose BUSINESS timings differ by
    // two orders of magnitude must produce IDENTICAL lease TTLs — a wrap-up
    // length or max-duration that reaches a Redis TTL shows up here as a
    // difference, and a TTL cannot distinguish "took too long" from "the
    // process died".
    const agents = new AgentStateMachine(redis, '');

    const short = await insertAgencyCampaign({ status: 'draft', wrapup_seconds: 5 });
    const long = await insertAgencyCampaign({ status: 'draft', wrapup_seconds: 3600 });

    const ttlsFor = async (campaignId: string) => {
      const session = await insertAgentSession(campaignId, { state: 'available' });
      const key = `agency:agent:${session.id}:state`;
      const out: Record<string, number> = {};

      await agents.set(session.id, 'available', { leaseMs: AGENT_LEASE_MS.available });
      out.available = await redis.pttl(key);

      await agents.reserve(session.id, 'a1');
      out.reserved_predial = await redis.pttl(key);

      await agents.transition(session.id, 'reserved', 'reserved', {
        attemptId: 'a1', leaseMs: AGENT_LEASE_MS.reserved_dialing,
      });
      out.reserved_dialing = await redis.pttl(key);

      await agents.set(session.id, 'on_call', { attemptId: 'a1', leaseMs: AGENT_LEASE_MS.on_call });
      out.on_call = await redis.pttl(key);
      return out;
    };

    const a = await ttlsFor(short.id);
    const b = await ttlsFor(long.id);

    // Compare at 100ms granularity — these are wall-clock PTTLs, not constants.
    const round = (o: Record<string, number>) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v / 100)]));
    expect(round(a)).toEqual(round(b));
  });

  it('T-L4b: the lease table is keyed on agent state only, never on a business duration', async () => {
    // Structural arm. The table's whole contract is that every value is a
    // liveness parameter; a future addition should have to defend itself here.
    expect(Object.keys(AGENT_LEASE_MS).sort()).toEqual([
      'available', 'break', 'on_call', 'renew_interval',
      'reserved_dialing', 'reserved_predial', 'wrapup',
    ]);

    // The reserved lease MUST be split, and the dialing half must outlive a
    // realistic carrier ring once renewal is accounted for.
    expect(AGENT_LEASE_MS.reserved_predial).toBeLessThan(AGENT_LEASE_MS.reserved_dialing);
    // Renewal must be comfortably more frequent than the lease it renews, or a
    // single slow tick lapses a live reservation.
    expect(AGENT_LEASE_MS.renew_interval * 2).toBeLessThanOrEqual(AGENT_LEASE_MS.reserved_dialing);
    expect(AGENT_LEASE_MS.renew_interval * 2).toBeLessThanOrEqual(AGENT_LEASE_MS.on_call);
  });
});
