import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertAccount, insertTenant } from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { closeTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { config } from '../../../src/config/index.js';
import type { AppContext } from '../../../src/app-context.js';
import { startPlatform } from '../../../src/bootstrap/platform.js';
import { platformAuditLogger } from '../../../src/audit/platform/audit-logger.js';
import { auditLogger } from '../../../src/audit/audit-logger.js';

/**
 * NEW (magick-agency, Phase 8 delta review 3): the platform bootstrap starts both buffered audit
 * writers and its stop flushes them — master `src/index.ts:320` (`auditLogger.start()`) and
 * `:697` (`auditLogger.shutdown()`)@a1f0756a, core `src/index.ts:579` / `:903`@4850d1d9.
 * Real Postgres (5436): rows are read back from `platform_audit_log` and `audit_logs`.
 *
 * Mutation-checked: dropping the two `shutdown()` calls from the stop reds case 1 (the rows are
 * still in the buffer when the stop returns); dropping the two `start()` calls reds case 2 (no
 * periodic flush).
 */

let ctx: AppContext;
let tenant: string;
let account: string;

beforeAll(() => {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  ctx = {
    // Background noise off: this suite is about the audit buffers only.
    config: { ...config, localCache: { ...config.localCache, enabled: false }, auditPartitions: { ...config.auditPartitions, enabled: false } },
    pool: getPool(),
    redis: getTestRedis(),
  };
});

beforeEach(async () => {
  await truncateAll();
  tenant = (await insertTenant()).id as string;
  account = (await insertAccount({ tenant_id: tenant })).id as string;
});

afterAll(async () => {
  await closePool();
  await closeTestPool();
  await closeTestRedis();
});

async function counts(): Promise<{ platform: number; core: number }> {
  const p = await getTestPool().query<{ n: number }>('SELECT count(*)::int AS n FROM platform_audit_log WHERE tenant_id = $1', [tenant]);
  const c = await getTestPool().query<{ n: number }>('SELECT count(*)::int AS n FROM audit_logs WHERE tenant_id = $1', [tenant]);
  return { platform: p.rows[0]!.n, core: c.rows[0]!.n };
}

function logBoth(): void {
  platformAuditLogger.log({
    tenant_id: tenant,
    account_id: account,
    actor_type: 'system',
    action: 'dnc_entry.created',
    resource_type: 'dnc_entry',
    details: { test: 'audit-flush-on-stop' },
  } as never);
  auditLogger.log({
    tenantId: tenant,
    accountId: account,
    eventType: 'agency.test',
    eventCategory: 'system',
    severity: 'info',
    eventData: { test: 'audit-flush-on-stop' },
  });
}

describe('the platform bootstrap owns the audit buffers (integration)', () => {
  it('the stop flushes rows still in both buffers, before it returns', async () => {
    const stop = await startPlatform(ctx);
    logBoth();
    await stop();
    expect(await counts()).toEqual({ platform: 1, core: 1 });
  });

  it('a started process flushes on the 500 ms timer, without waiting for 100 rows', async () => {
    const stop = await startPlatform(ctx);
    try {
      logBoth();
      const deadline = Date.now() + 3_000;
      let seen = await counts();
      while ((seen.platform < 1 || seen.core < 1) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
        seen = await counts();
      }
      expect(seen).toEqual({ platform: 1, core: 1 });
    } finally {
      await stop();
    }
  });
});
