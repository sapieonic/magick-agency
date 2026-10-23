import Fastify, { type FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { StationFleet, type FleetAgent, type FleetOptions } from '../../mocks/station-fleet.js';
import { createRng, type Rng } from '../../helpers/load-scale.js';

/**
 * ─── THE TRANSPORT-TIER LOAD WORLD ──────────────────────────────────────────
 *
 * The real station route (`proxyAgencyStationRoutes` → `handleStationSocket`) on a
 * real listening Fastify, in front of the real `AgencyRuntime` (registry, token
 * store, agent state machine, dialer, sweep), driven by a {@link StationFleet} of
 * real `ws` clients. Two things are doubles, and only two:
 *
 *  - **Postgres** — the caller's `vi.mock` of `agency.repository.js` answers
 *    `findById` from the {@link SessionTable} this world fills. The SQL has its own
 *    integration tier (`test/integration/load/`); this tier is about the socket.
 *  - **Redis** — {@link MemoryRedis}, which interprets the four Lua scripts the
 *    station path runs (token consume, agent CAS / SET / RENEW) by shape and honours
 *    `PX` TTLs against `Date.now()`, so a faked clock expires keys the way a real
 *    one would. Tokens are minted and consumed by the REAL `StationTokenStore`.
 *
 * Import this module only after the caller's `vi.mock` calls: it imports nothing
 * from `src/` statically, and `createStationWorld` loads the runtime and the route
 * dynamically so the mocks are in place first.
 */

// ─── Redis, by shape ────────────────────────────────────────────────────────

interface Expiring<T> { value: T; expiresAt: number | null }

export class MemoryRedis {
  private readonly strings = new Map<string, Expiring<string>>();
  private readonly hashes = new Map<string, Expiring<Record<string, string>>>();
  /** Every command issued, by name. Read by assertions about round trips. */
  readonly calls = new Map<string, number>();

  private count(name: string): void {
    this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
  }

  private live<T>(map: Map<string, Expiring<T>>, key: string): T | undefined {
    const e = map.get(key);
    if (!e) return undefined;
    if (e.expiresAt !== null && e.expiresAt <= Date.now()) {
      map.delete(key);
      return undefined;
    }
    return e.value;
  }

  async set(key: string, value: string, mode?: string, ms?: number): Promise<'OK'> {
    this.count('set');
    const expiresAt = mode === 'PX' && typeof ms === 'number' ? Date.now() + ms : null;
    this.strings.set(key, { value, expiresAt });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    this.count('get');
    return this.live(this.strings, key) ?? null;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    this.count('mget');
    return keys.map((k) => this.live(this.strings, k) ?? null);
  }

  async del(...keys: string[]): Promise<number> {
    this.count('del');
    let n = 0;
    for (const k of keys) {
      if (this.strings.delete(k)) n++;
      if (this.hashes.delete(k)) n++;
    }
    return n;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.count('hgetall');
    return { ...(this.live(this.hashes, key) ?? {}) };
  }

  pipeline() {
    const ops: string[] = [];
    const self = this;
    return {
      hgetall(key: string) { ops.push(key); return this; },
      async exec(): Promise<Array<[Error | null, Record<string, string>]>> {
        return Promise.all(ops.map(async (k) => [null, await self.hgetall(k)] as [null, Record<string, string>]));
      },
    };
  }

  /**
   * The four scripts the station path runs, recognised by their bodies. An
   * unrecognised script THROWS: a double that silently returned 0 for a script it
   * did not know would turn a new code path into a quiet "refused".
   */
  async eval(script: string, _numKeys: number, key: string, ...argv: Array<string | number>): Promise<number> {
    this.count('eval');
    const a = argv.map(String);
    if (script.includes("redis.call('GET', KEYS[1])") && script.includes('stored ~= ARGV[1]')) {
      // StationTokenStore CONSUME
      const stored = this.live(this.strings, key);
      if (stored === undefined || stored !== a[0]) return 0;
      this.strings.delete(key);
      return 1;
    }
    const h = this.live(this.hashes, key);
    if (script.includes("redis.call('EXISTS'")) {
      // RENEW: state-matched PEXPIRE
      if (!h || h['state'] !== a[0]) return 0;
      this.hashes.set(key, { value: h, expiresAt: Date.now() + Number(a[1]) });
      return 1;
    }
    if (script.includes("redis.call('HGET'")) {
      // CAS: from, to, attempt, leaseMs, since
      if (!h || h['state'] !== a[0]) return 0;
      this.hashes.set(key, { value: { state: a[1]!, attempt: a[2] ?? '', since: a[4] ?? '' }, expiresAt: Date.now() + Number(a[3]) });
      return 1;
    }
    if (script.includes("redis.call('HSET'")) {
      // SET: state, attempt, leaseMs, since
      this.hashes.set(key, { value: { state: a[0]!, attempt: a[1] ?? '', since: a[3] ?? '' }, expiresAt: Date.now() + Number(a[2]) });
      return 1;
    }
    throw new Error(`MemoryRedis: unrecognised script:\n${script}`);
  }

  /** Live keys matching a prefix, for leak and ownership assertions. */
  keys(prefix: string): string[] {
    const out: string[] = [];
    for (const k of [...this.strings.keys(), ...this.hashes.keys()]) {
      if (k.startsWith(prefix) && (this.live(this.strings, k) !== undefined || this.live(this.hashes, k) !== undefined)) out.push(k);
    }
    return out.sort();
  }

  rawGet(key: string): string | undefined {
    return this.live(this.strings, key);
  }

  agentState(sessionId: string): string | undefined {
    return this.live(this.hashes, `agency:agent:${sessionId}:state`)?.['state'];
  }
}

// ─── The session table the repository mock answers from ─────────────────────

export interface SessionRow {
  id: string;
  tenant_id: string;
  account_id: string;
  campaign_id: string;
  agent_user_id: string;
  state: string;
  left_at: Date | null;
}

export type SessionTable = Map<string, SessionRow>;

// ─── The world ──────────────────────────────────────────────────────────────

export interface StationWorldOptions {
  sessions: SessionTable;
  tenants?: number;
  campaignsPerTenant?: number;
  agents: number;
  rng?: Rng;
  heartbeatMs: number;
  fleet?: Partial<Pick<FleetOptions, 'actions'>>;
}

export interface StationWorld {
  app: FastifyInstance;
  origin: string;
  redis: MemoryRedis;
  runtime: import('../../../src/agency/runtime.js').AgencyRuntime;
  fleet: StationFleet;
  rng: Rng;
  tenants: string[];
  campaigns: Array<{ id: string; tenantId: string; accountId: string }>;
  /** The registry's Redis ownership key for a session (no key prefix on this tier). */
  ownershipKey(sessionId: string): string;
  teardown(): Promise<void>;
}

export async function createStationWorld(opts: StationWorldOptions): Promise<StationWorld> {
  const { AgencyRuntime } = await import('../../../src/agency/runtime.js');
  const { proxyAgencyStationRoutes } = await import('../../../src/api/routes/proxy-agency-station.routes.js');

  const rng = opts.rng ?? createRng();
  const redis = new MemoryRedis();
  // The bridge is never asked to dial on this tier: no attempt exists, so every
  // `reattachStation` / `hasLiveAttempt` answers from the dialer's own empty maps.
  const runtime = new AgencyRuntime({} as never, redis as never, '');

  const tenantCount = opts.tenants ?? 1;
  const perTenant = opts.campaignsPerTenant ?? 1;
  const tenants = Array.from({ length: tenantCount }, () => randomUUID());
  const campaigns = tenants.flatMap((tenantId) => {
    const accountId = randomUUID();
    return Array.from({ length: perTenant }, () => ({ id: randomUUID(), tenantId, accountId }));
  });

  const app = Fastify({ logger: false });
  await app.register(websocket);
  await app.register(proxyAgencyStationRoutes, { prefix: '/proxy/agency/station', getRuntime: () => runtime });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address() as AddressInfo;
  const origin = `ws://127.0.0.1:${port}`;

  const fleet = new StationFleet({
    origin,
    heartbeatMs: opts.heartbeatMs,
    rng,
    mintToken: async (agent: FleetAgent) => (await runtime.tokens.mint(agent.sessionId)).token,
    ...(opts.fleet?.actions ? { actions: opts.fleet.actions } : {}),
  });

  for (let i = 0; i < opts.agents; i++) {
    const c = campaigns[i % campaigns.length]!;
    const row: SessionRow = {
      id: randomUUID(), tenant_id: c.tenantId, account_id: c.accountId, campaign_id: c.id,
      agent_user_id: randomUUID(), state: 'break', left_at: null,
    };
    opts.sessions.set(row.id, row);
    fleet.add({
      sessionId: row.id, tenantId: row.tenant_id, accountId: row.account_id,
      campaignId: row.campaign_id, agentUserId: row.agent_user_id, label: `agent-${i}`,
    });
  }

  return {
    app, origin, redis, runtime, fleet, rng, tenants, campaigns,
    ownershipKey: (sessionId) => `agency:station:${sessionId}`,
    async teardown() {
      await fleet.closeAll().catch(() => { /* best effort; the leak check reports */ });
      runtime.stopStationSweep();
      runtime.wrapup.stop();
      await app.close();
      opts.sessions.clear();
    },
  };
}

/**
 * The leak check every scenario ends with, once every console has disconnected.
 * Returns the findings rather than asserting, so the caller's `expect` names them.
 */
export async function leakReport(world: StationWorld): Promise<{
  registry: number;
  ownershipKeys: string[];
  liveClientLegs: number;
  heartbeatingLegs: number;
  wrapups: number;
}> {
  return {
    registry: world.runtime.stations.size(),
    ownershipKeys: world.redis.keys('agency:station:'),
    liveClientLegs: world.fleet.liveLegs().length,
    heartbeatingLegs: world.fleet.heartbeatingLegs().length,
    wrapups: world.runtime.wrapup.active(),
  };
}

export const NO_LEAKS = { registry: 0, ownershipKeys: [], liveClientLegs: 0, heartbeatingLegs: 0, wrapups: 0 };

/** The server-side socket currently attached for a session, as the registry holds it. */
export function serverSocket(world: StationWorld, sessionId: string): import('ws').WebSocket | undefined {
  return world.runtime.stations.socketFor(sessionId) as unknown as import('ws').WebSocket | undefined;
}
