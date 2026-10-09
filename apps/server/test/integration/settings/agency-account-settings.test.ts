import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { buildAgencyAccountSettingsMap } from '../../../src/settings/agency-account-settings.js';
import { buildSessionPayload } from '../../../src/auth/session-payload.js';

/**
 * The session settings map on real Postgres
 * (decision Q3a). The unit suite
 * (`test/unit/settings/agency-account-settings.test.ts`) mocks the two reads;
 * this proves the SQL behind them: `status != 'deleted'` keeps a deleted account
 * out, `findByIds(…, tenantId)` keeps a sibling and a foreign account out, NULL
 * columns come back as NULL and resolve to the defaults, and a revoked
 * membership reaches nothing — all through the real `memberships` rows the
 * session payload reads.
 */
describe('agency account settings map (integration)', () => {
  beforeAll(() => {
    initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });
  });

  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await closePool();
    await closeTestPool();
  });

  async function settingsRow(tenantId: string, accountId: string, cols: Record<string, unknown>) {
    const keys = Object.keys(cols);
    await getTestPool().query(
      `INSERT INTO account_settings (tenant_id, account_id, ${keys.join(', ')})
       VALUES ($1, $2, ${keys.map((_, i) => `$${i + 3}`).join(', ')})`,
      [tenantId, accountId, ...Object.values(cols)],
    );
  }

  it('reaches every live account for a tenant-wide membership, only its own for an account-scoped one, and resolves NULLs to defaults', async () => {
    const t1 = await insertTenant();
    const t2 = await insertTenant();
    const a1 = await insertAccount({ tenant_id: t1.id });
    const a2 = await insertAccount({ tenant_id: t1.id });
    const deleted = await insertAccount({ tenant_id: t1.id, status: 'deleted' });
    const b1 = await insertAccount({ tenant_id: t2.id });
    const b2 = await insertAccount({ tenant_id: t2.id });

    await settingsRow(t1.id, a1.id, { max_concurrent_calls: 12, allow_recording: true, analyze_calls: true, webrtc_max_duration_seconds: 600 });
    await settingsRow(t1.id, a2.id, { max_concurrent_calls: 3, allow_recording: null, analyze_calls: null, webrtc_max_duration_seconds: null });
    await settingsRow(t1.id, deleted.id, { max_concurrent_calls: 99, allow_recording: true });
    await settingsRow(t2.id, b2.id, { max_concurrent_calls: 8, allow_recording: true });

    const user = await insertUser();
    // Tenant-wide in t1, account-scoped to b1 in t2, and a REVOKED tenant-wide
    // membership in t2 that must reach nothing.
    await insertMembership({ user_id: user.id, tenant_id: t1.id, account_id: null, role: 'tenant_admin' });
    await insertMembership({ user_id: user.id, tenant_id: t2.id, account_id: b1.id, role: 'agent' });
    await insertMembership({ user_id: user.id, tenant_id: t2.id, account_id: null, role: 'viewer', status: 'revoked' });

    const { rows: memberships } = await getTestPool().query('SELECT * FROM memberships WHERE user_id = $1', [user.id]);
    const map = await buildAgencyAccountSettingsMap(memberships);

    expect(Object.keys(map).sort()).toEqual([a1.id, a2.id, b1.id].sort());
    expect(map[a1.id]).toMatchObject({
      tenant_id: t1.id, account_id: a1.id,
      max_concurrent_calls: 12, allow_recording: true, analyze_calls: true, webrtc_max_duration_seconds: 600,
    });
    // NULL columns → documented defaults; the row's own cap is kept.
    expect(map[a2.id]).toMatchObject({
      max_concurrent_calls: 3, allow_recording: false, analyze_calls: false, webrtc_max_duration_seconds: 1800,
    });
    // No row → all defaults, updated_at from the account.
    expect(map[b1.id]).toMatchObject({
      tenant_id: t2.id, max_concurrent_calls: 5, allow_recording: false, analyze_calls: false, webrtc_max_duration_seconds: 1800,
    });
    expect(map[b1.id]!.updated_at).toBe(new Date(b1.updated_at).toISOString());
    // Deleted account and the sibling account b2 (reached only by the revoked
    // membership) are absent.
    expect(map[deleted.id]).toBeUndefined();
    expect(map[b2.id]).toBeUndefined();

    // And the session payload carries exactly that map.
    const payload = await buildSessionPayload({ id: user.id }, user.id);
    expect(payload.settings).toEqual(map);
    expect(payload).not.toHaveProperty('governance');
  });
});
