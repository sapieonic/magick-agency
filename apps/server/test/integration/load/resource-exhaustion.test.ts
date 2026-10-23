import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ─── Running out: a tiny Postgres pool, a starved pool, Redis going away ────────
 *
 * The app is built with a pool of {@link POOL_MAX} connections (production defaults to 10;
 * `connectionTimeoutMillis` stays the production 5 s) and with a Redis client made exactly
 * as `src/index.ts` makes it (`new Redis(url, { keyPrefix })`, ioredis defaults), but
 * pointed at a TCP forwarder in front of this worktree's Redis db, so the suite can cut
 * Redis off and bring it back.
 *
 * What it pins:
 *  1. **Far more concurrent requests than connections** (a floor joining, marking DNC in
 *     transactions, dispositioning and polling at once, against 3 connections) all queue
 *     and complete — no 5xx, no pool self-deadlock (a transaction holding one connection
 *     while waiting for a second) — and the pool drains to idle afterwards.
 *  2. **A starved pool** (every connection held elsewhere): requests fail within the
 *     connect timeout with the MASKED 5xx contract — and never as `401`: the console
 *     treats a 401 as an expired session and signs the agent out, so a database stall
 *     answered 401 signs out the whole floor. `/healthz` stays 200, `/readyz` answers 503;
 *     once the connections come back, everything answers 200 again. This case found that
 *     defect (`sessionMiddleware` answered any failure of its user lookup as
 *     `401 Invalid or expired token`); fixed there — reverting it reds case 2.
 *  3. **Redis unavailable**: `/healthz` stays 200, `/readyz` reports 503, API requests fail
 *     with the masked 5xx (bounded, never hanging, never 401); when Redis comes back the
 *     client reconnects on its own and everything answers 200.
 */

const mocks = vi.hoisted(() => ({ verifyIdToken: vi.fn() }));
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { LightMyRequestResponse } from 'fastify';
import type { PoolClient } from 'pg';
import { getPool } from '@magick-agency/db';
import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { TEST_REDIS_URL } from '../../helpers/test-redis.js';
import { config } from '../../../src/config/index.js';
import { createRng, scaled } from '../../helpers/load-scale.js';
import {
  call, expectHealthy, expectMasked, scalar, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type LoadApp, type TenantFloor,
} from './load-harness.js';

const POOL_MAX = 3;
const AGENTS = scaled(25);
const rng = createRng();

/** A TCP forwarder to the test Redis that can be cut and restored on the same port. */
class Forwarder {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  port = 0;
  constructor(private readonly target: { host: string; port: number }) {}

  async start(): Promise<void> {
    this.server = net.createServer((client) => {
      const upstream = net.connect(this.target);
      this.sockets.add(client).add(upstream);
      const drop = () => { client.destroy(); upstream.destroy(); this.sockets.delete(client); this.sockets.delete(upstream); };
      client.on('error', drop).on('close', drop);
      upstream.on('error', drop).on('close', drop);
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => this.server!.listen(this.port, '127.0.0.1', resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }
}

const target = new URL(TEST_REDIS_URL);
const forwarder = new Forwarder({ host: target.hostname, port: Number(target.port) });
let redis: Redis;
let loaded: LoadApp;
let floor: TenantFloor;
const app = () => loaded.app;

beforeAll(async () => {
  console.log(`[resource-exhaustion] seed=${rng.seed} pool=${POOL_MAX} agents=${AGENTS}`);
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  await forwarder.start();
  // As `src/index.ts` builds it, at this worktree's db index, through the forwarder.
  redis = new Redis(`redis://127.0.0.1:${forwarder.port}${target.pathname}`, { keyPrefix: config.redis.keyPrefix || undefined });
  loaded = await startLoadApp({
    poolMax: POOL_MAX,
    redis,
    configure: (c) => ({ ...c, rateLimit: { ...c.rateLimit, max: 1_000_000 } }),
  });
}, 60_000);

beforeEach(async () => {
  await truncateAll();
  floor = (await seedFloor({ tenants: 1, agentsPerTenant: AGENTS, supervisorsPerTenant: 2, campaignStatus: 'running' }))[0]!;
});

afterAll(async () => {
  await stopLoadApp(loaded);
  redis?.disconnect();
  await forwarder.stop();
});

const authedGet = () => call(app(), 'GET', '/proxy/agency/my-campaigns', floor.agents[0]!, floor);

/** One ended, bridged call for each agent's session, ready for a disposition or a DNC mark. */
async function seedCalls(): Promise<Map<string, string>> {
  const attemptOf = new Map<string, string>();
  for (const [i, agent] of floor.agents.entries()) {
    const session = randomUUID();
    const contact = randomUUID();
    const attempt = randomUUID();
    await getTestPool().query(
      `INSERT INTO agency_agent_sessions (id, tenant_id, account_id, campaign_id, agent_user_id, state, left_at)
       VALUES ($1, $2, $3, $4, $5, 'offline', now())`, [session, floor.tenant, floor.account, floor.campaigns[0], agent.id]);
    await getTestPool().query(
      `INSERT INTO agency_contacts (id, campaign_id, tenant_id, account_id, phone_e164, state) VALUES ($1, $2, $3, $4, $5, 'connected')`,
      [contact, floor.campaigns[0], floor.tenant, floor.account, `+9195${String(i).padStart(8, '0')}`]);
    await getTestPool().query(
      `INSERT INTO agency_call_attempts (id, campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state, outcome,
         reserved_agent_id, dialed_at, answered_at, bridged_at, ended_at)
       VALUES ($1, $2, $3, $4, $5, 1, '+919000000001', 'ended', 'connected', $6, now() - interval '2 min', now() - interval '100 s', now() - interval '99 s', now())`,
      [attempt, floor.campaigns[0], contact, floor.tenant, floor.account, session]);
    attemptOf.set(agent.id, attempt);
  }
  return attemptOf;
}

async function settleWithin<T>(ms: number, work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms} ms`)), ms); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

describe('resource exhaustion (integration, load)', () => {
  it(`1. a floor's worth of concurrent work on a ${POOL_MAX}-connection pool: everything queues and completes`, async () => {
    const attemptOf = await seedCalls();
    const started = Date.now();
    const work = floor.agents.flatMap((agent, i) => {
      const attempt = attemptOf.get(agent.id)!;
      const mark = i % 2 === 0;
      return [
        // The prior session left, so the join lands a fresh one.
        () => call(app(), 'POST', '/proxy/agency/sessions', agent, floor, { campaign_id: floor.campaigns[0] }),
        () => mark
          ? call(app(), 'POST', `/proxy/agency/attempts/${attempt}/dnc`, agent, floor, { disposition_code: 'do_not_call' })
          : call(app(), 'POST', `/proxy/agency/attempts/${attempt}/disposition`, agent, floor, { disposition_code: 'interested' }),
        () => call(app(), 'GET', '/proxy/agency/my-campaigns', agent, floor),
        () => call(app(), 'GET', `/proxy/agency/campaigns/${floor.campaigns[0]}/stats`, floor.supervisors[i % 2]!, floor),
      ];
    });
    const answers = await settleWithin(50_000, Promise.all(rng.shuffle(work).map((f) => f())), 'the burst');
    for (const res of answers) {
      expectHealthy(res, 'burst');
      expect(res.statusCode, res.body).toBeLessThan(300);
    }
    expect(Date.now() - started).toBeLessThan(50_000);
    expect(await scalar('SELECT count(*)::int AS n FROM dnc_entries')).toBe(Math.ceil(AGENTS / 2));
    expect(await scalar(`SELECT count(*)::int AS n FROM agency_call_attempts WHERE disposition_code IS NOT NULL`)).toBe(AGENTS);
    expect(await scalar('SELECT count(*)::int AS n FROM agency_agent_sessions WHERE left_at IS NULL')).toBe(AGENTS);
    const pool = getPool();
    expect(pool.totalCount).toBeLessThanOrEqual(POOL_MAX);
    expect(pool.waitingCount).toBe(0);
  }, 60_000);

  it('2. a starved pool fails requests with the masked 5xx — never 401 — and recovers when connections return', async () => {
    // Warm the per-request caches the way a live floor has them, then take every connection.
    expect((await authedGet()).statusCode).toBe(200);
    const held: PoolClient[] = [];
    for (let i = 0; i < POOL_MAX; i++) held.push(await getPool().connect());
    let answers: LightMyRequestResponse[];
    try {
      const probes = Promise.all([
        app().inject({ method: 'GET', url: '/healthz' }),
        app().inject({ method: 'GET', url: '/readyz' }),
      ]);
      answers = await settleWithin(20_000, Promise.all([
        ...floor.agents.slice(0, 6).map((a) => call(app(), 'GET', '/proxy/agency/my-campaigns', a, floor)),
        call(app(), 'GET', `/proxy/agency/campaigns/${floor.campaigns[0]}/stats`, floor.supervisors[0]!, floor),
        call(app(), 'POST', '/proxy/agency/sessions', floor.agents[7]!, floor, { campaign_id: floor.campaigns[0] }),
      ]), 'requests on a starved pool');
      const [healthz, readyz] = await settleWithin(20_000, probes, 'probes on a starved pool');
      expect(healthz.statusCode).toBe(200);
      expect(readyz.statusCode).toBe(503);
    } finally {
      for (const c of held) c.release();
    }
    for (const res of answers) {
      expectHealthy(res, 'starved', { allow5xx: true });
      expect(res.statusCode, `answered ${res.statusCode}: ${res.body}`).toBeGreaterThanOrEqual(500);
      expectMasked(res, 'starved');
    }
    // Recovery: the same requests, now served.
    const again = await Promise.all(floor.agents.slice(0, 6).map((a) => call(app(), 'GET', '/proxy/agency/my-campaigns', a, floor)));
    for (const res of again) expect(res.statusCode, res.body).toBe(200);
    expect((await app().inject({ method: 'GET', url: '/readyz' })).statusCode).toBe(200);
    expect(getPool().waitingCount).toBe(0);
  }, 60_000);

  it('3. Redis going away: liveness holds, readiness and the API fail cleanly and bounded, and both recover on their own', async () => {
    expect((await authedGet()).statusCode).toBe(200);
    await forwarder.stop();
    let during: LightMyRequestResponse[];
    const t0 = Date.now();
    try {
      const healthz = await settleWithin(2_000, app().inject({ method: 'GET', url: '/healthz' }), 'healthz without Redis');
      expect(healthz.statusCode).toBe(200);
      during = await settleWithin(40_000, Promise.all([
        app().inject({ method: 'GET', url: '/readyz' }),
        ...floor.agents.slice(0, 4).map((a) => call(app(), 'GET', '/proxy/agency/my-campaigns', a, floor)),
        call(app(), 'POST', '/proxy/agency/sessions', floor.agents[5]!, floor, { campaign_id: floor.campaigns[0] }),
      ]), 'requests without Redis');
    } finally {
      await forwarder.start();
    }
    console.log(`[resource-exhaustion] Redis outage answered in ${Date.now() - t0} ms`);
    const [readyz, ...api] = during;
    expect(readyz!.statusCode).toBe(503);
    for (const res of api) {
      expectHealthy(res, 'no redis', { allow5xx: true });
      expect(res.statusCode, `answered ${res.statusCode}: ${res.body}`).toBeGreaterThanOrEqual(500);
      expectMasked(res, 'no redis');
    }
    // Recovery: ioredis reconnects by itself; no restart, no manual reconnect.
    const deadline = Date.now() + 30_000;
    let ready = 0;
    while (Date.now() < deadline) {
      ready = (await app().inject({ method: 'GET', url: '/readyz' })).statusCode;
      if (ready === 200) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    expect(ready).toBe(200);
    const after = await Promise.all(floor.agents.slice(0, 4).map((a) => call(app(), 'GET', '/proxy/agency/my-campaigns', a, floor)));
    for (const res of after) expect(res.statusCode, res.body).toBe(200);
  }, 90_000);
});
