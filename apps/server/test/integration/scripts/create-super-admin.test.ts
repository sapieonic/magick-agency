import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import bcrypt from 'bcryptjs';
import { initDbPool, closePool, getPool } from '@magick-agency/db';
import { TEST_DB_URL, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import { createSuperAdmin, parseArgs } from '../../../scripts/create-super-admin.js';

/**
 * The CLI that creates the first super-admin,
 * on real Postgres. It mirrors `POST /super-admin/admins` (same body
 * schema, bcrypt cost, duplicate refusal, audit row). The login half — that the
 * created credentials actually authenticate through `POST /super-admin/login` —
 * is exercised by `test/integration/api/platform-onboarding.e2e.test.ts`.
 */

async function admins() {
  const { rows } = await getPool().query<{ email: string; name: string; password_hash: string; is_system: boolean; status: string }>(
    `SELECT email, name, password_hash, is_system, status FROM super_admins ORDER BY created_at`,
  );
  return rows;
}

describe('scripts/create-super-admin (integration)', () => {
  beforeAll(() => { initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 2 }); });
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await closePool(); });

  it('creates an active admin with a bcrypt hash (never the password) and an audit row', async () => {
    const result = await createSuperAdmin({ email: 'ops@agency.example', name: 'Ops', password: 'a-long-passphrase' });

    expect(result).toEqual({ ok: true, admin: expect.objectContaining({ email: 'ops@agency.example', is_system: false, status: 'active' }) });
    expect(JSON.stringify(result)).not.toContain('a-long-passphrase');
    const [row] = await admins();
    expect(row!.password_hash).not.toBe('a-long-passphrase');
    expect(await bcrypt.compare('a-long-passphrase', row!.password_hash)).toBe(true);
    const audit = await getPool().query(`SELECT action, resource_type, details FROM super_admin_audit_log`);
    expect(audit.rows).toEqual([{
      action: 'create_admin', resource_type: 'super_admin',
      details: { email: 'ops@agency.example', name: 'Ops', via: 'cli', is_system: false },
    }]);
    expect(JSON.stringify(audit.rows)).not.toContain('a-long-passphrase');
  });

  it('--system marks the admin is_system (the protection the seeded admin has)', async () => {
    const result = await createSuperAdmin({ email: 'root@agency.example', name: 'Root', password: 'a-long-passphrase', system: true });
    expect(result.ok && result.admin.is_system).toBe(true);
    expect((await admins())[0]!.is_system).toBe(true);
  });

  it('refuses an email already registered, writing nothing', async () => {
    await createSuperAdmin({ email: 'ops@agency.example', name: 'Ops', password: 'a-long-passphrase' });
    const again = await createSuperAdmin({ email: 'ops@agency.example', name: 'Other', password: 'another-passphrase' });
    expect(again).toEqual({ ok: false, error: 'Email already registered as super admin' });
    expect(await admins()).toHaveLength(1);
  });

  it('refuses what the console refuses (short password, bad email, empty name), writing nothing', async () => {
    for (const bad of [
      { email: 'ops@agency.example', name: 'Ops', password: 'short' },
      { email: 'not-an-email', name: 'Ops', password: 'a-long-passphrase' },
      { email: 'ops@agency.example', name: '', password: 'a-long-passphrase' },
    ]) {
      const result = await createSuperAdmin(bad);
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(await admins()).toEqual([]);
  });

  it('takes the password from the environment or stdin, never from argv', () => {
    expect(parseArgs(['--email', 'a@b.example', '--name', 'A', '--system', '--password', 'leak'])).toEqual({
      email: 'a@b.example', name: 'A', system: true,
    });
  });
});
