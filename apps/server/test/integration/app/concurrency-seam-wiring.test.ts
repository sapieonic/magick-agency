import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * NEW (magick-agency, lead, at lane C's merge): the concurrency seam
 * (docs/seams.md §3.3) is wired in the REAL app, not only in the voice engine's
 * own suite. Lane A's super-admin concurrency PUT commits the allocation and then
 * calls `getConcurrencyControl().invalidateAccountLimit` / `invalidateProviderLimits`;
 * with the seam unwired those throw after the commit and the route answers 500.
 * `buildApp` with a real context registers the voice plugin, whose
 * `ensureVoiceEngine` calls `setConcurrencyControl`, so the same PUT answers 200.
 *
 * Real Postgres (5436) and real Redis (6383, this worktree's db).
 */

vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'seam-wiring-test-secret-0123456789';
});

import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { insertAccount, insertTenant } from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { trackSuperAdminAuditWrites } from '../../helpers/drain-super-admin-audit.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import { getVoiceEngine, resetVoiceEngineForTests } from '../../../src/bootstrap/voice.js';
import { getConcurrencyControl, resetConcurrencyControl } from '../../../src/seams/concurrency-control.js';

const EMAIL = 'seam-admin@test.com';
const PASSWORD = 'SeamPassword123!';

const audit = trackSuperAdminAuditWrites();
let app: FastifyInstance;

describe('concurrency seam wiring in the built app (integration)', () => {
  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  });

  beforeEach(async () => {
    await audit.drain();
    await truncateAll();
    await flushTestRedis();
    resetVoiceEngineForTests();
    resetConcurrencyControl();
  });

  afterAll(async () => {
    await audit.drain();
    audit.restore();
    await app?.close();
    const engine = getVoiceEngine();
    await engine?.bridge.gracefulShutdown();
    await engine?.guardHost.gracefulShutdown();
    resetVoiceEngineForTests();
    resetConcurrencyControl();
    await closePool();
    await closeTestPool();
    await closeTestRedis();
  });

  it('is unwired before the app is built (the precondition this suite guards)', async () => {
    await expect(getConcurrencyControl().getAccountCount(randomUUID(), randomUUID())).rejects.toThrow(
      /ConcurrencyControl not wired/,
    );
  });

  it('a super-admin concurrency PUT through buildApp commits, invalidates through the seam, and answers 200', async () => {
    app = await buildApp({ ctx: { config, pool: getTestPool(), redis: getTestRedis() } });
    await app.ready();

    const tenant = await insertTenant();
    const account = await insertAccount({ tenant_id: tenant.id });
    await getTestPool().query(
      `INSERT INTO super_admins (id, email, password_hash, name, status) VALUES ($1, $2, $3, 'Seam Admin', 'active')`,
      [randomUUID(), EMAIL, await bcrypt.hash(PASSWORD, 10)],
    );

    const login = await app.inject({ method: 'POST', url: '/super-admin/login', payload: { email: EMAIL, password: PASSWORD } });
    expect(login.statusCode).toBe(200);
    const auth = { authorization: `Bearer ${login.json().token}` };
    const url = `/super-admin/tenants/${tenant.id}/accounts/${account.id}/concurrency`;

    const put = await app.inject({ method: 'PUT', url, headers: auth, payload: { max_concurrent_calls: 7 } });
    expect(put.statusCode).toBe(200);

    const { rows } = await getTestPool().query<{ max_concurrent_calls: number }>(
      'SELECT max_concurrent_calls FROM account_settings WHERE tenant_id = $1 AND account_id = $2',
      [tenant.id, account.id],
    );
    expect(rows[0]?.max_concurrent_calls).toBe(7);

    // The seam the route used is the voice engine's, and it reads the live guards.
    await expect(getConcurrencyControl().getAccountCount(tenant.id, account.id)).resolves.toBe(0);

    const get = await app.inject({ method: 'GET', url, headers: auth });
    expect(get.statusCode).toBe(200);
  });
});
