/*
 * The flag write routes are the super-admin routes in
 * `src/api/routes/super-admin-feature-flags.routes.ts`, and the tenant read route is
 * `src/api/routes/feature-flags.routes.ts` at `/feature-flags`. Harness notes:
 *  - writes authenticate as a REAL super admin (a `super_admins` row + a JWT signed with
 *    `SUPER_ADMIN_JWT_SECRET`, through the real `superAdminMiddleware`); the actor persisted as `updated_by` is that super admin's id, not a body field;
 *  - the read route's `sessionMiddleware` → `tenantContextMiddleware` → `requirePermission`
 *    chain is stubbed to read the tenant/account from plain headers, so the REAL `resolveClientExposed` runs;
 *  - the flag service runs over the REAL test Redis (6383, non-zero db, flushed per test)
 *    (not a null Redis), so write-path invalidation is exercised on the shared cache;
 *  - ids are UUIDs (`randomUUID()`): the override id columns are UUID;
 *  - the flag under test is `agency_dialer_enabled` (client-exposed, default off, env
 *    `FF_AGENCY_DIALER`); the never-leaks case checks `agency_late_binding` (the one agency
 *    flag that is not client-exposed);
 *  - the DB/config come from the test harness (`initDbPool` on the test database, env from
 *    `integration-env.ts`).
 */
import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import jwt from 'jsonwebtoken';

// ─── Mocks ──────────────────────────────────────────────────────────────────
// Real DB via the test pool; the feature-flag service singleton runs over the test Redis,
// and route writes invalidate it.
// This is the real toggle pass: write routes → DB → service cache/invalidate/resolve →
// tenant read route, over live Postgres. The fast logic through-line lives in
// test/unit/scenarios/feature-flag-rollout-scenarios.test.ts; this one closes the
// "real DB + both HTTP routes" gap.

const SA_JWT_SECRET = vi.hoisted(() => {
  const secret = 'rollout-super-admin-secret-0123456789';
  process.env['SUPER_ADMIN_JWT_SECRET'] = secret;
  return secret;
});

// Audit is fire-and-forget; stub so the through-line doesn't touch the audit buffer.
vi.mock('../../../src/audit/audit-logger.js', () => ({
  auditLogger: { log: vi.fn() },
}));

// Client surface: replace the session/tenant/RBAC chain with a pass-through
// that reads the tenant/account from plain headers, so we exercise the REAL
// resolveClientExposed resolution a tenant hits — without standing up Firebase sessions.
vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async () => {},
}));
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async (req: { headers: Record<string, string>; tenantId?: string; accountId?: string }) => {
    req.tenantId = req.headers['x-tenant-id'];
    req.accountId = req.headers['x-account-id'];
  },
}));
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));

// ─── Imports (after mocks) ──────────────────────────────────────────────────

import { initDbPool, closePool, getPool } from '@magick-agency/db';
import { superAdminRepository } from '@magick-agency/db/repositories/super-admin.repository';
import { TEST_DB_URL, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { trackSuperAdminAuditWrites } from '../../helpers/drain-super-admin-audit.js';
import { superAdminFeatureFlagsRoutes } from '../../../src/api/routes/super-admin-feature-flags.routes.js';
import { featureFlagsRoutes } from '../../../src/api/routes/feature-flags.routes.js';
import { initFeatureFlagService } from '../../../src/feature-flags/index.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

const FLAG = 'agency_dialer_enabled';
const PREFIX = 'ma-rollout-test:';

function buildApp() {
  const app = Fastify({ logger: false });
  app.register(superAdminFeatureFlagsRoutes, { prefix: '/super-admin' }); // super-admin writes
  app.register(featureFlagsRoutes, { prefix: '/feature-flags' });         // tenant read
  return app;
}

const ACCOUNT = randomUUID();

/** The client-exposed flag map a tenant/account resolves. */
async function tenantSees(app: ReturnType<typeof buildApp>, tenantId: string, accountId = ACCOUNT) {
  const res = await app.inject({
    method: 'GET',
    url: '/feature-flags',
    headers: { 'x-tenant-id': tenantId, 'x-account-id': accountId },
  });
  expect(res.statusCode).toBe(200);
  return JSON.parse(res.body) as Record<string, unknown>;
}

let superAdminId: string;
let saHeaders: Record<string, string>;

describe('agency_dialer_enabled rollout — write → read through-line (integration)', () => {
  const tenant = Array.from({ length: 11 }, () => randomUUID()); // tenant[1] … tenant[10]

  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  });

  beforeEach(async () => {
    await truncateAll();
    await flushTestRedis();
    // Fresh service instance per test so no cached snapshot leaks across tests
    // (the singleton otherwise persists its local cache for the whole file).
    initFeatureFlagService(getTestRedis(), PREFIX);
    delete process.env['FF_AGENCY_DIALER'];

    const admin = await superAdminRepository.create({
      email: 'root@agency.example', password_hash: 'not-a-real-hash', name: 'Root',
    });
    superAdminId = admin.id;
    const token = jwt.sign({ sub: admin.id, email: admin.email, type: 'super_admin' }, SA_JWT_SECRET, { expiresIn: '1h' });
    saHeaders = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
  });

  // Drain the routes' fire-and-forget super-admin
  // audit writes before the next `truncateAll()`; an in-flight INSERT deadlocks
  // with the TRUNCATE (see test/helpers/drain-super-admin-audit.ts).
  const auditWrites = trackSuperAdminAuditWrites();
  afterEach(async () => {
    await auditWrites.drain();
  });

  afterAll(async () => {
    auditWrites.restore();
    await closeTestRedis();
    await closePool();
  });

  it('default-off → enable one tenant → only that tenant sees it → bulk enable → global flip', async () => {
    const app = buildApp();
    await app.ready();

    // ── 1. Default off: no overrides anywhere, env unset → every tenant sees false.
    expect((await tenantSees(app, tenant[1]!))[FLAG]).toBe(false);
    expect((await tenantSees(app, tenant[2]!))[FLAG]).toBe(false);

    // ── 2. Enable for tenant-1 only (PUT tenant override).
    const put = await app.inject({
      method: 'PUT',
      url: `/super-admin/feature-flags/${FLAG}/overrides`,
      headers: saHeaders,
      payload: { scope_type: 'tenant', tenant_id: tenant[1], value: true, reason: 'pilot' },
    });
    expect(put.statusCode).toBe(200);

    // The read route reflects it immediately (write-path invalidation, not the TTL).
    expect((await tenantSees(app, tenant[1]!))[FLAG]).toBe(true);
    // tenant-2 still off — the override is tenant-scoped.
    expect((await tenantSees(app, tenant[2]!))[FLAG]).toBe(false);

    // The override row persisted with the audit actor.
    const { rows: ov } = await getPool().query(
      `SELECT * FROM feature_flag_overrides WHERE flag_key=$1 AND scope_type='tenant' AND tenant_id=$2`,
      [FLAG, tenant[1]],
    );
    expect(ov).toHaveLength(1);
    expect(ov[0].value).toBe(true);
    expect(ov[0].updated_by).toBe(superAdminId);

    // ── 3. Bulk enable for a batch of tenants (gradual rollout).
    const bulk = await app.inject({
      method: 'POST',
      url: `/super-admin/feature-flags/${FLAG}/overrides/bulk`,
      headers: saHeaders,
      payload: { tenant_ids: [tenant[2], tenant[3]], value: true },
    });
    expect(bulk.statusCode).toBe(200);
    expect(JSON.parse(bulk.body).applied).toEqual([tenant[2], tenant[3]]);

    expect((await tenantSees(app, tenant[2]!))[FLAG]).toBe(true);
    expect((await tenantSees(app, tenant[3]!))[FLAG]).toBe(true);
    // A tenant NOT in the batch and with no override is still off.
    expect((await tenantSees(app, tenant[4]!))[FLAG]).toBe(false);

    // ── 4. GA via a global flip — every tenant without an explicit override flips on.
    const globalOn = await app.inject({
      method: 'PUT',
      url: `/super-admin/feature-flags/${FLAG}/overrides`,
      headers: saHeaders,
      payload: { scope_type: 'global', value: true, reason: 'GA' },
    });
    expect(globalOn.statusCode).toBe(200);

    // tenant-4 (no override) now inherits the global true.
    expect((await tenantSees(app, tenant[4]!))[FLAG]).toBe(true);

    await app.close();
  });

  it('precedence: an explicit tenant OFF survives a global ON (most-specific wins, D1)', async () => {
    const app = buildApp();
    await app.ready();

    // Explicitly disable tenant-9, then flip the global on.
    await app.inject({
      method: 'PUT', url: `/super-admin/feature-flags/${FLAG}/overrides`, headers: saHeaders,
      payload: { scope_type: 'tenant', tenant_id: tenant[9], value: false },
    });
    await app.inject({
      method: 'PUT', url: `/super-admin/feature-flags/${FLAG}/overrides`, headers: saHeaders,
      payload: { scope_type: 'global', value: true },
    });

    // tenant-9's explicit OFF wins over the global ON.
    expect((await tenantSees(app, tenant[9]!))[FLAG]).toBe(false);
    // A different tenant with no override inherits the global ON.
    expect((await tenantSees(app, tenant[10]!))[FLAG]).toBe(true);

    await app.close();
  });

  it('reset-to-inherited (DELETE) reverts a tenant to the layer beneath', async () => {
    const app = buildApp();
    await app.ready();

    // Global ON, tenant-5 explicitly OFF.
    await app.inject({
      method: 'PUT', url: `/super-admin/feature-flags/${FLAG}/overrides`, headers: saHeaders,
      payload: { scope_type: 'global', value: true },
    });
    await app.inject({
      method: 'PUT', url: `/super-admin/feature-flags/${FLAG}/overrides`, headers: saHeaders,
      payload: { scope_type: 'tenant', tenant_id: tenant[5], value: false },
    });
    expect((await tenantSees(app, tenant[5]!))[FLAG]).toBe(false);

    // Remove the tenant override → tenant-5 falls back to the global ON.
    const del = await app.inject({
      method: 'DELETE', url: `/super-admin/feature-flags/${FLAG}/overrides`, headers: saHeaders,
      payload: { scope_type: 'tenant', tenant_id: tenant[5] },
    });
    expect(del.statusCode).toBe(200);
    expect((await tenantSees(app, tenant[5]!))[FLAG]).toBe(true);

    await app.close();
  });

  it('the read route never leaks internal (non-clientExposed) flags', async () => {
    const app = buildApp();
    await app.ready();

    const flags = await tenantSees(app, tenant[1]!);
    expect(flags).toHaveProperty(FLAG);
    expect(flags).not.toHaveProperty('agency_late_binding');

    await app.close();
  });
});
