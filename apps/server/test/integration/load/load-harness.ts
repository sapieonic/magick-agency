/**
 * Shared harness for the public-API load suites in this folder.
 *
 * Every suite drives the REAL app (`buildApp` with a real context: real Postgres 5436 and
 * this worktree's Redis db, the real rate limiter, error handler and 5xx mask, the agency
 * runtime and the internal handler instance behind `callCore`). Firebase's token check is
 * the one stub, and each suite installs it itself (a `vi.mock` must live in the test file):
 * a bearer `tok:<uid>` verifies as `<uid>`, see {@link verifyTestToken}.
 *
 * ── Who the floor is ────────────────────────────────────────────────────────
 * {@link seedFloor} writes N tenants, each with one account, its campaigns, its agents
 * (`agent`) and supervisors (`account_admin`), in bulk statements. Every actor carries
 * its own client address, sent as `X-Forwarded-For` the way the one trusted proxy
 * (`TRUST_PROXY_HOPS=1`) appends it, so the IP rate limiter buckets each browser apart as
 * it does in production instead of charging the whole floor to 127.0.0.1.
 *
 * ── What every suite checks on every response ───────────────────────────────
 *  - {@link expectHealthy}: no 5xx, and no stack trace or driver text in any body.
 *  - {@link foreignIdsIn}: no UUID owned by another tenant appears anywhere in a body.
 */
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { expect } from 'vitest';
import type { Redis } from 'ioredis';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import type { AppContext } from '../../../src/app-context.js';
import { resetAgencyRuntimeForTests } from '../../../src/bootstrap/agency.js';
import { resetVoiceEngineForTests } from '../../../src/bootstrap/voice.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { auditLogger } from '../../../src/audit/audit-logger.js';

export type AppConfig = typeof config;

/** The stubbed Firebase check: `tok:<uid>` is `<uid>`, anything else is refused. */
export async function verifyTestToken(token: string): Promise<{ uid: string; email: string; email_verified: boolean }> {
  if (!token.startsWith('tok:')) throw new Error('bad token');
  const uid = token.slice(4);
  return { uid, email: `${uid}@load.example.com`, email_verified: true };
}

export interface LoadApp {
  app: FastifyInstance;
  ctx: AppContext;
}

/**
 * Build the real app. `configure` may override config blocks (rate-limit ceilings, the
 * local cache); `redis` replaces the context's client (the outage suite's proxied one).
 */
export async function startLoadApp(opts: {
  poolMax?: number;
  configure?: (c: AppConfig) => AppConfig;
  redis?: Redis;
} = {}): Promise<LoadApp> {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: opts.poolMax ?? config.db.poolMax });
  await flushTestRedis();
  resetVoiceEngineForTests();
  await resetAgencyRuntimeForTests();
  const base: AppConfig = { ...config, localCache: { ...config.localCache, enabled: false } };
  const ctx: AppContext = {
    config: opts.configure ? opts.configure(base) : base,
    pool: getPool(),
    redis: opts.redis ?? getTestRedis(),
  };
  const app = await buildApp({ ctx });
  await app.ready();
  return { app, ctx };
}

export async function stopLoadApp(loaded: LoadApp | undefined): Promise<void> {
  await loaded?.app.close();
  await drainAudits();
  await resetAgencyRuntimeForTests();
  resetVoiceEngineForTests();
  await closePool();
  await closeTestPool();
  await closeTestRedis();
}

/** Write both buffered audit trails out, so rows can be counted. */
export async function drainAudits(): Promise<void> {
  await platformAuditLogger.shutdown();
  await auditLogger.shutdown();
}

// ── The floor ────────────────────────────────────────────────────────────────

export interface Actor {
  id: string;
  uid: string;
  tok: string;
  role: 'agent' | 'account_admin';
  /** This browser's address, as the trusted proxy appends it. */
  ip: string;
}

export interface TenantFloor {
  index: number;
  tenant: string;
  account: string;
  campaigns: string[];
  agents: Actor[];
  supervisors: Actor[];
}

export const CATALOG = [
  { code: 'interested', label: 'Interested', is_success: true, terminal: true },
  { code: 'not_interested', label: 'Not interested', terminal: true },
  { code: 'voicemail', label: 'Voicemail', retry: { delay_minutes: 240, max_attempts: 3 } },
  { code: 'callback', label: 'Call back', requires_datetime: true },
  { code: 'do_not_call', label: 'Do not call', suppress: true },
];

async function bulkInsert(table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (rows.length === 0) return;
  const cols = Object.keys(rows[0]!);
  const values: unknown[] = [];
  const tuples = rows.map((row) => {
    const ph = cols.map((c) => { values.push(row[c]); return `$${values.length}`; });
    return `(${ph.join(', ')})`;
  });
  await getTestPool().query(`INSERT INTO ${table} (${cols.join(', ')}) VALUES ${tuples.join(', ')}`, values);
}

/**
 * N tenants, each with one account, `campaignsPerTenant` campaigns (status `campaignStatus`,
 * the {@link CATALOG}), `agentsPerTenant` agents and `supervisorsPerTenant` supervisors, and
 * the `agency_dialer_enabled` override that gates the dialer.
 */
export async function seedFloor(opts: {
  tenants: number;
  agentsPerTenant: number;
  supervisorsPerTenant?: number;
  campaignsPerTenant?: number;
  campaignStatus?: string;
}): Promise<TenantFloor[]> {
  const floors: TenantFloor[] = [];
  const tenants: Record<string, unknown>[] = [];
  const accounts: Record<string, unknown>[] = [];
  const users: Record<string, unknown>[] = [];
  const memberships: Record<string, unknown>[] = [];
  const campaigns: Record<string, unknown>[] = [];
  const flags: Record<string, unknown>[] = [];

  for (let t = 0; t < opts.tenants; t++) {
    const tenant = randomUUID();
    const account = randomUUID();
    const slug = tenant.slice(0, 8);
    tenants.push({ id: tenant, name: `Load Tenant ${t}`, slug: `load-${slug}`, settings: '{}', status: 'active' });
    accounts.push({ id: account, tenant_id: tenant, name: `Load Account ${t}`, slug: `load-acct-${slug}`, settings: '{}', status: 'active' });
    flags.push({ flag_key: 'agency_dialer_enabled', scope_type: 'tenant', tenant_id: tenant, value: 'true' });

    const actor = (role: Actor['role'], n: number): Actor => {
      const id = randomUUID();
      const uid = `load-${role}-${t}-${n}-${id.slice(0, 8)}`;
      users.push({ id, firebase_uid: uid, email: `${uid}@load.example.com`, display_name: `${role} ${t}.${n}`, status: 'active' });
      memberships.push({ id: randomUUID(), user_id: id, tenant_id: tenant, account_id: account, role, status: 'active' });
      // 10.<tenant>.<role>.<n>: distinct per browser, stable per run.
      const ip = `10.${t + 1}.${role === 'agent' ? 1 + Math.floor(n / 250) : 200}.${(n % 250) + 1}`;
      return { id, uid, tok: `tok:${uid}`, role, ip };
    };
    const floor: TenantFloor = {
      index: t, tenant, account, campaigns: [],
      agents: Array.from({ length: opts.agentsPerTenant }, (_, n) => actor('agent', n)),
      supervisors: Array.from({ length: opts.supervisorsPerTenant ?? 1 }, (_, n) => actor('account_admin', n)),
    };
    for (let c = 0; c < (opts.campaignsPerTenant ?? 1); c++) {
      const id = randomUUID();
      floor.campaigns.push(id);
      campaigns.push({
        id, tenant_id: tenant, account_id: account, name: `Load ${t}.${c}`,
        caller_ids: ['+919000000001'], telephony_provider: 'voicelink', status: opts.campaignStatus ?? 'draft',
        disposition_catalog: JSON.stringify(CATALOG),
        calling_window_start: '00:00:00', calling_window_end: '24:00:00',
        calling_days: [1, 2, 3, 4, 5, 6, 7], default_timezone: 'UTC',
      });
    }
    floors.push(floor);
  }

  await bulkInsert('tenants', tenants);
  await bulkInsert('accounts', accounts);
  for (let i = 0; i < users.length; i += 500) await bulkInsert('users', users.slice(i, i + 500));
  for (let i = 0; i < memberships.length; i += 500) await bulkInsert('memberships', memberships.slice(i, i + 500));
  await bulkInsert('agency_campaigns', campaigns);
  for (const f of flags) {
    await getTestPool().query(
      `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value) VALUES ($1, $2, $3, $4::jsonb)`,
      [f['flag_key'], f['scope_type'], f['tenant_id'], f['value']],
    );
  }
  return floors;
}

/** Every UUID the OTHER tenants own: their tenant, account, campaigns and people. */
export function foreignIdsOf(floors: TenantFloor[], self: TenantFloor): Set<string> {
  const out = new Set<string>();
  for (const f of floors) {
    if (f === self) continue;
    out.add(f.tenant);
    out.add(f.account);
    for (const c of f.campaigns) out.add(c);
    for (const a of [...f.agents, ...f.supervisors]) out.add(a.id);
  }
  return out;
}

// ── Requests ─────────────────────────────────────────────────────────────────

export function headersFor(actor: Actor, floor: TenantFloor, extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${actor.tok}`,
    'x-tenant-id': floor.tenant,
    'x-account-id': floor.account,
    'x-forwarded-for': actor.ip,
    ...extra,
  };
}

export function call(
  app: FastifyInstance,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  actor: Actor,
  floor: TenantFloor,
  body?: unknown,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method,
    url,
    headers: headersFor(actor, floor, body === undefined ? {} : { 'content-type': 'application/json' }),
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Driver text, stack frames and internal paths that must never reach a client. */
const LEAK_PATTERNS = [
  /\bat [\w.<>]+ \(/, // a stack frame
  /node_modules/,
  /\/src\/[\w/-]+\.ts/,
  /invalid input syntax/i,
  /duplicate key value/i,
  /violates (unique|foreign key|check) constraint/i,
  /deadlock detected/i,
  /relation "[\w_]+"/i,
  /syntax error at or near/i,
  /\bSELECT\b[\s\S]*\bFROM\b/,
];

/** No 5xx except the masked contract, and no internals in any body. */
export function expectHealthy(res: LightMyRequestResponse, label: string, opts: { allow5xx?: boolean } = {}): void {
  if (!opts.allow5xx) expect(res.statusCode, `${label}: ${res.body.slice(0, 300)}`).toBeLessThan(500);
  for (const p of LEAK_PATTERNS) expect(res.body, `${label} leaks ${p}`).not.toMatch(p);
  if (res.statusCode >= 500) expectMasked(res, label);
}

/** The masked 5xx body: the fixed sentence and the request id, nothing else. */
export function expectMasked(res: LightMyRequestResponse, label: string): void {
  const body = res.json() as Record<string, unknown>;
  expect(Object.keys(body).sort(), label).toEqual(['error', 'message', 'requestId', 'statusCode']);
  expect(body['statusCode'], label).toBe(res.statusCode);
  expect(String(body['message']), label).toMatch(/^Something went wrong while processing your request/);
}

/** Every foreign id that appears anywhere in the body (empty when isolation holds). */
export function foreignIdsIn(body: string, foreign: ReadonlySet<string>): string[] {
  const found = body.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? [];
  return [...new Set(found.map((s) => s.toLowerCase()))].filter((id) => foreign.has(id));
}

export async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await getTestPool().query<{ n: number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}

/** Postgres's own deadlock counter for this database (pg_stat_database.deadlocks). */
export async function deadlockCount(): Promise<number> {
  return scalar('SELECT deadlocks::int AS n FROM pg_stat_database WHERE datname = current_database()');
}

/**
 * Decisions Q7/Q9: `injectWS` builds its upgrade request with no `socket`, which
 * proxy-addr dereferences for `request.ip`; a real upgrade always has one.
 */
export const WS_UPGRADE = { socket: { remoteAddress: '127.0.0.1' } } as unknown as Parameters<FastifyInstance['injectWS']>[1];

export type StationSocket = Awaited<ReturnType<FastifyInstance['injectWS']>>;

/**
 * Open the station socket at `wsUrl` and resolve with it once its `ready` frame arrives.
 * The upgrade carries the browser's `X-Forwarded-For` like every other request of it: an
 * upgrade is charged to the same IP bucket.
 */
export async function openStation(app: FastifyInstance, wsUrl: string, ip?: string): Promise<StationSocket> {
  const ws = await app.injectWS(wsUrl, {
    ...(WS_UPGRADE as object),
    ...(ip ? { headers: { 'x-forwarded-for': ip } } : {}),
  } as Parameters<FastifyInstance['injectWS']>[1]);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ready frame on ${wsUrl}`)), 10_000);
    ws.on('message', (raw: Buffer) => {
      const frame = JSON.parse(raw.toString()) as { event?: string };
      if (frame.event === 'ready') { clearTimeout(timer); resolve(); }
    });
    ws.on('close', (code: number) => { clearTimeout(timer); reject(new Error(`station closed ${code}`)); });
  });
  return ws;
}

export function closeStation(ws: StationSocket): Promise<void> {
  return new Promise<void>((resolve) => {
    if (ws.readyState === ws.CLOSED) return resolve();
    ws.on('close', () => resolve());
    ws.close();
  });
}
