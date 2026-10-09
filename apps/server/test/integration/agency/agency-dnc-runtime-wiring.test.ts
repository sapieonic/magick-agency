import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Redis from 'ioredis';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { TEST_REDIS_URL } from '../../helpers/test-redis.js';
import { uuidFor } from '../setup/factories.js';

// The DB pool lives in `@magick-agency/db`.
vi.mock('@magick-agency/db', () => ({
  getPool: () => getTestPool(),
  healthCheck: async () => true,
}));
vi.mock('@magick-agency/db/connection', () => ({
  getPool: () => getTestPool(),
  healthCheck: async () => true,
}));

vi.mock('../../../src/config/index.js', () => ({
  config: {
    redis: { keyPrefix: '' },
    telephony: {}, // no carrier config is needed
  },
}));

vi.mock('@magick-agency/observability', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { AgencyRuntime } = await import('../../../src/agency/runtime.js');
const { DncRegistry } = await import('../../../src/agency/dnc-registry.js');
const { ScriptedBridge } = await import('./chaos/harness.js');

/*
 * Decision B8: there is no DNC outbox sweeper, no forward and no outbox write. A mark
 * writes `dnc_entries` in the agent's own transaction, and the dial-time gate reads
 * that table. The table `agency_dnc_outbox` stays in the baseline for the rollback
 * mirror and nothing writes it.
 *
 * The subject is "what the runtime's start/stop does to the DNC path, and whether a
 * record survives into a fresh runtime", against real Postgres and Redis:
 *  - `runtime.dnc` is the DB-backed registry (not a Redis set), live as soon as the
 *    runtime starts, with no network: a `dnc_entries` row answers `suppressed` and no
 *    `fetch` is ever issued ;
 *  - nothing writes `agency_dnc_outbox` across start → stop;
 *  - the record survives the replica: a FRESH runtime answers `suppressed` for it, the
 *    durability property;
 *  - and the gate fails closed: an unreadable table is `unavailable`, never `clear`.
 */

const REDIS_PREFIX = 'dnc-runtime:';
const TENANT = uuidFor('runtime-tenant'); // UUID column
const PHONE = '+14155550100';

let redis: Redis;
let runtime: InstanceType<typeof AgencyRuntime> | null;
let realFetch: typeof globalThis.fetch;

async function outboxCount(): Promise<number> {
  const { rows } = await getTestPool().query<{ n: string }>('SELECT COUNT(*)::text AS n FROM agency_dnc_outbox');
  return Number(rows[0]!.n);
}

describe('AgencyRuntime DNC gate wiring (integration, B8)', () => {
  beforeEach(async () => {
    await truncateAll();
    realFetch = globalThis.fetch;
    // the worktree's agency test Redis.
    redis = new Redis(TEST_REDIS_URL, {
      keyPrefix: REDIS_PREFIX,
      maxRetriesPerRequest: 3,
    });
    await redis.flushdb();
    runtime = null;
  });

  afterEach(async () => {
    globalThis.fetch = realFetch;
    if (runtime) await runtime.stop().catch(() => { /* already stopped */ });
    await redis.flushdb().catch(() => { /* connection already gone */ });
    redis.disconnect();
  });

  afterAll(closeTestPool);

  it('starts with the DB-backed gate (no sweeper, no network), and a fresh runtime reads the same record', async () => {
    await getTestPool().query(
      `INSERT INTO tenants (id, name, slug) VALUES ($1, 'runtime', $2)`,
      [TENANT, `runtime-${TENANT}`],
    );
    await getTestPool().query(
      `INSERT INTO dnc_entries (tenant_id, phone_e164, source, reason, added_by)
       VALUES ($1, $2, 'agent', 'runtime wiring', 'agent-runtime')`,
      [TENANT, PHONE],
    );

    // Any network call on the DNC path would be the deleted forward coming back.
    const fetchSpy = vi.fn(() => Promise.reject(new Error('the DNC path must not reach the network')));
    globalThis.fetch = fetchSpy as never;

    runtime = new AgencyRuntime(new ScriptedBridge() as never, redis, REDIS_PREFIX);
    await runtime.start();
    expect(runtime.dnc).toBeInstanceOf(DncRegistry);
    expect(await runtime.dnc.check(TENANT, PHONE, { accountId: null, campaignId: null })).toBe('suppressed');
    expect(await runtime.dnc.check(TENANT, '+14155550199', { accountId: null, campaignId: null })).toBe('clear');

    await runtime.stop();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await outboxCount()).toBe(0);

    // A fresh replica reads the same record — nothing was owed to a sweeper.
    const freshRuntime = new AgencyRuntime(new ScriptedBridge() as never, redis, REDIS_PREFIX);
    runtime = freshRuntime;
    await freshRuntime.start();
    expect(await freshRuntime.dnc.check(TENANT, PHONE, { accountId: null, campaignId: null })).toBe('suppressed');

    // Fail closed: the table unreadable is `unavailable`, never `clear`.
    // The rename is schema-wide on the shared worktree DB: safe ONLY because
    // `vitest.config.integration.ts` sets `fileParallelism: false` (no other file runs
    // while `dnc_entries` is gone).
    await getTestPool().query('ALTER TABLE dnc_entries RENAME TO dnc_entries_unreadable');
    try {
      expect(await freshRuntime.dnc.check(TENANT, '+14155550199', { accountId: null, campaignId: null }))
        .toBe('unavailable');
    } finally {
      await getTestPool().query('ALTER TABLE dnc_entries_unreadable RENAME TO dnc_entries');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await outboxCount()).toBe(0);
  });
});
