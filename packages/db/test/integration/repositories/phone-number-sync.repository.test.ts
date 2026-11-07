// `phoneNumberRepository.syncForCredential` and the reads that follow a synced number
// (`findAvailableForAccount`, `findCredentialNumbersForAccount`) against real Postgres
// (0018, decisions B18–B22): inserted on the credential's provider and pinned to it,
// assigned to the credential's tenant, a number registered elsewhere refused rather than
// taken over, numbers gone from the account retired (never deleted), a credential that is
// not active refused with nothing written.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant, insertAccount } from '../setup/factories.js';

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
  healthCheck: async () => true,
}));

const { phoneNumberRepository } = await import('../../../src/repositories/phone-number.repository.js');
const { tenantPhoneAssignmentRepository } = await import('../../../src/repositories/tenant-phone-assignment.repository.js');

let tenant: string;
let otherTenant: string;
let account: string;
let admin: string;
let providers: { voicelink: string; plivo: string };

async function insertCredential(tenantId = tenant, status: 'active' | 'disabled' | 'invalid' = 'active'): Promise<string> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref, status)
     VALUES ($1, 'plivo', $2, $3, $4) RETURNING id`,
    [tenantId, `cred-${randomUUID().slice(0, 6)}`, `MA${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`, status],
  );
  return rows[0]!.id;
}

const listed = (...numbers: string[]) => numbers.map((n) => ({ phone_number: n, label: `alias ${n.slice(-2)}` }));

async function numberRow(phone: string) {
  const { rows } = await getTestPool().query<{
    status: string; telephony_credential_id: string | null; provider_id: string; label: string | null; capabilities: string[]; created_by: string | null;
  }>('SELECT status, telephony_credential_id, provider_id, label, capabilities, created_by FROM phone_numbers WHERE phone_number = $1', [phone]);
  return rows[0];
}

async function assignedTenants(phone: string): Promise<string[]> {
  const { rows } = await getTestPool().query<{ tenant_id: string }>(
    `SELECT tpa.tenant_id FROM tenant_phone_assignments tpa JOIN phone_numbers pn ON pn.id = tpa.phone_number_id
      WHERE pn.phone_number = $1 ORDER BY tpa.tenant_id`, [phone]);
  return rows.map((r) => r.tenant_id);
}

beforeEach(async () => {
  await truncateAll();
  const { rows } = await getTestPool().query<{ id: string; name: string }>(
    `INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink'), ('plivo', 'Plivo') RETURNING id, name`,
  );
  providers = { voicelink: rows.find((r) => r.name === 'voicelink')!.id, plivo: rows.find((r) => r.name === 'plivo')!.id };
  tenant = (await insertTenant()).id as string;
  otherTenant = (await insertTenant()).id as string;
  account = (await insertAccount({ tenant_id: tenant })).id as string;
  admin = (await getTestPool().query<{ id: string }>(
    `INSERT INTO super_admins (email, password_hash, name) VALUES ($1, 'x', 'Root') RETURNING id`,
    [`root-${randomUUID()}@example.test`],
  )).rows[0]!.id;
});

afterAll(async () => {
  await closeTestPool();
});

describe('phoneNumberRepository.syncForCredential (integration)', () => {
  it('a first sync inserts each number on the credential\'s provider, pinned, and assigns it to the tenant untagged', async () => {
    const cred = await insertCredential();
    const result = await phoneNumberRepository.syncForCredential(cred, listed('+14155550002', '+14155550001'), admin);
    expect(result).toEqual({
      added: ['+14155550001', '+14155550002'], reactivated: [], unchanged: [], retired: [], conflicts: [], active: 2,
    });
    expect(await numberRow('+14155550001')).toEqual({
      status: 'active', telephony_credential_id: cred, provider_id: providers.plivo,
      label: 'alias 01', capabilities: ['voice'], created_by: admin,
    });
    expect(await assignedTenants('+14155550001')).toEqual([tenant]);
    // Untagged, so every account of the tenant may dial from it, and the console list says which credential.
    const available = await tenantPhoneAssignmentRepository.findAvailableForAccount(tenant, account);
    expect(available.map((a) => [a.phone_number, a.provider_name, a.telephony_credential_id, a.is_default])).toEqual([
      ['+14155550001', 'plivo', cred, false],
      ['+14155550002', 'plivo', cred, false],
    ]);
  });

  it('a re-sync: unchanged numbers stay, a number gone from the account is retired (not deleted), a returning one is reactivated', async () => {
    const cred = await insertCredential();
    await phoneNumberRepository.syncForCredential(cred, listed('+14155550001', '+14155550002'), admin);
    const second = await phoneNumberRepository.syncForCredential(cred, listed('+14155550001', '+14155550003'), admin);
    expect(second).toEqual({
      added: ['+14155550003'], reactivated: [], unchanged: ['+14155550001'], retired: ['+14155550002'], conflicts: [], active: 2,
    });
    expect((await numberRow('+14155550002'))!.status).toBe('retired');
    // A retired number keeps its assignment row but is no longer offered.
    expect(await assignedTenants('+14155550002')).toEqual([tenant]);
    const available = await tenantPhoneAssignmentRepository.findAvailableForAccount(tenant, account);
    expect(available.map((a) => a.phone_number)).toEqual(['+14155550001', '+14155550003']);

    const third = await phoneNumberRepository.syncForCredential(cred, listed('+14155550001', '+14155550002', '+14155550003'), admin);
    expect(third).toMatchObject({ added: [], reactivated: ['+14155550002'], unchanged: ['+14155550001', '+14155550003'], retired: [], active: 3 });
    expect((await numberRow('+14155550002'))!.status).toBe('active');
  });

  it('an empty account list retires every number of the credential and deletes none', async () => {
    const cred = await insertCredential();
    await phoneNumberRepository.syncForCredential(cred, listed('+14155550001', '+14155550002'), admin);
    const result = await phoneNumberRepository.syncForCredential(cred, [], admin);
    expect(result).toMatchObject({ retired: ['+14155550001', '+14155550002'], active: 0 });
    const { rows } = await getTestPool().query<{ n: number }>('SELECT count(*)::int AS n FROM phone_numbers');
    expect(rows[0]!.n).toBe(2);
  });

  it('a number already in the inventory elsewhere is refused, never taken over: another credential, another tenant, or the service account', async () => {
    const mine = await insertCredential();
    const theirs = await insertCredential(otherTenant);
    await phoneNumberRepository.syncForCredential(theirs, listed('+14155550001'), admin);
    // The service's own number (NULL credential), assigned to the other tenant by a super-admin.
    const own = await getTestPool().query<{ id: string }>(
      `INSERT INTO phone_numbers (phone_number, provider_id) VALUES ('+14155550002', $1) RETURNING id`, [providers.voicelink]);
    await getTestPool().query(
      `INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id) VALUES ($1, $2)`, [otherTenant, own.rows[0]!.id]);

    const result = await phoneNumberRepository.syncForCredential(mine, listed('+14155550001', '+14155550002', '+14155550003'), admin);
    expect(result).toEqual({
      added: ['+14155550003'], reactivated: [], unchanged: [], retired: [],
      conflicts: [
        { phone_number: '+14155550001', reason: 'registered_elsewhere' },
        { phone_number: '+14155550002', reason: 'registered_elsewhere' },
      ],
      active: 1,
    });
    // Untouched: still the other credential's and the service's, still only the other tenant's.
    expect(await numberRow('+14155550001')).toMatchObject({ telephony_credential_id: theirs, status: 'active' });
    expect(await numberRow('+14155550002')).toMatchObject({ telephony_credential_id: null, provider_id: providers.voicelink });
    expect(await assignedTenants('+14155550001')).toEqual([otherTenant]);
    expect(await assignedTenants('+14155550002')).toEqual([otherTenant]);
    // ...and a later sync of the owner does not see them retired by mine.
    expect(await phoneNumberRepository.syncForCredential(theirs, listed('+14155550001'), admin))
      .toMatchObject({ unchanged: ['+14155550001'], retired: [] });
  });

  it('a number of this credential a super-admin deleted is reported, not brought back', async () => {
    const cred = await insertCredential();
    await phoneNumberRepository.syncForCredential(cred, listed('+14155550001'), admin);
    await getTestPool().query(`UPDATE phone_numbers SET status = 'deleted' WHERE phone_number = '+14155550001'`);
    const result = await phoneNumberRepository.syncForCredential(cred, listed('+14155550001'), admin);
    expect(result).toMatchObject({ conflicts: [{ phone_number: '+14155550001', reason: 'deleted' }], active: 0 });
    expect((await numberRow('+14155550001'))!.status).toBe('deleted');
  });

  it('existing assignments keep their tags and default; a re-sync adds no second assignment', async () => {
    const cred = await insertCredential();
    await phoneNumberRepository.syncForCredential(cred, listed('+14155550001'), admin);
    await getTestPool().query(`UPDATE tenant_phone_assignments SET is_default = true WHERE tenant_id = $1`, [tenant]);
    await phoneNumberRepository.syncForCredential(cred, listed('+14155550001'), admin);
    const { rows } = await getTestPool().query<{ is_default: boolean }>('SELECT is_default FROM tenant_phone_assignments');
    expect(rows).toEqual([{ is_default: true }]);
  });

  it.each(['disabled', 'invalid'] as const)('a %s credential: null, nothing written', async (status) => {
    const cred = await insertCredential(tenant, status);
    expect(await phoneNumberRepository.syncForCredential(cred, listed('+14155550001'), admin)).toBeNull();
    const { rows } = await getTestPool().query<{ n: number }>('SELECT count(*)::int AS n FROM phone_numbers');
    expect(rows[0]!.n).toBe(0);
  });

  it('a revoked credential\'s numbers are left as they are: null', async () => {
    const cred = await insertCredential();
    await phoneNumberRepository.syncForCredential(cred, listed('+14155550001'), admin);
    await getTestPool().query(`UPDATE telephony_credentials SET status = 'revoked', revoked_at = NOW() WHERE id = $1`, [cred]);
    expect(await phoneNumberRepository.syncForCredential(cred, [], admin)).toBeNull();
    expect((await numberRow('+14155550001'))!.status).toBe('active');
  });
});

describe('tenantPhoneAssignmentRepository.findCredentialNumbersForAccount (integration)', () => {
  it('only active numbers synced to that credential, assigned to the tenant and available to the account', async () => {
    const cred = await insertCredential();
    const otherCred = await insertCredential();
    await phoneNumberRepository.syncForCredential(cred, listed('+14155550001', '+14155550002', '+14155550003'), admin);
    await phoneNumberRepository.syncForCredential(otherCred, listed('+14155550004'), admin);
    // Retired, and tagged to another account only.
    await getTestPool().query(`UPDATE phone_numbers SET status = 'retired' WHERE phone_number = '+14155550002'`);
    const sibling = (await insertAccount({ tenant_id: tenant })).id as string;
    const assignment = await getTestPool().query<{ id: string }>(
      `SELECT tpa.id FROM tenant_phone_assignments tpa JOIN phone_numbers pn ON pn.id = tpa.phone_number_id
        WHERE pn.phone_number = '+14155550003'`);
    await getTestPool().query('INSERT INTO phone_account_tags (assignment_id, account_id) VALUES ($1, $2)', [assignment.rows[0]!.id, sibling]);

    const asked = ['+14155550001', '+14155550002', '+14155550003', '+14155550004', '+19999999999'];
    expect(await tenantPhoneAssignmentRepository.findCredentialNumbersForAccount(tenant, account, cred, asked)).toEqual(['+14155550001']);
    expect((await tenantPhoneAssignmentRepository.findCredentialNumbersForAccount(tenant, sibling, cred, asked)).sort())
      .toEqual(['+14155550001', '+14155550003']);
    // Another tenant never sees them, even naming the credential.
    expect(await tenantPhoneAssignmentRepository.findCredentialNumbersForAccount(otherTenant, account, cred, asked)).toEqual([]);
  });
});
