// Numbers on a tenant's own carrier account added by hand (docs/carriers.md CR6, CR7) and the
// read CR9 judges a service-account campaign's caller IDs with, against real Postgres:
//  - `phoneNumberRepository.createPinned`: the number pinned to an `active` credential of its
//    carrier and assigned untagged to the credential's tenant in the same transaction, as a
//    sync assigns the numbers it adds; nothing written for a credential not found, of another
//    carrier, not active, or a number already in the inventory;
//  - a hand-pinned number follows PL4, PL5 and PL13 as a synced one does: offered as a caller ID
//    only while its credential is `active`, one of that credential's numbers for its campaigns,
//    never assigned to another tenant;
//  - `findPinnedAmong`: the numbers pinned to any credential, whatever their status or tenant.
// The carrier here is VoiceLink, the one whose tenant-account numbers are added by hand: these
// rows need no catalogue (the route decides which carrier may take them).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant, insertAccount } from '../setup/factories.js';

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
  healthCheck: async () => true,
}));

const { phoneNumberRepository } = await import('../../../src/repositories/phone-number.repository.js');
const { tenantPhoneAssignmentRepository, PhoneNumberOtherTenantError } = await import('../../../src/repositories/tenant-phone-assignment.repository.js');

let tenant: string;
let otherTenant: string;
let account: string;
let admin: string;
let providers: { voicelink: string; plivo: string };

async function insertCredential(
  provider: 'voicelink' | 'plivo' = 'voicelink',
  tenantId = tenant,
  status: 'active' | 'disabled' | 'invalid' | 'revoked' = 'active',
): Promise<string> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref, status, revoked_at)
     VALUES ($1, $2, $3, $4, $5::varchar, CASE WHEN $5::varchar = 'revoked' THEN now() END) RETURNING id`,
    [tenantId, provider, `cred-${randomUUID().slice(0, 6)}`, `acct-${randomUUID().slice(0, 12)}`, status],
  );
  return rows[0]!.id;
}

const setStatus = (id: string, status: string) =>
  getTestPool().query(`UPDATE telephony_credentials SET status = $2::varchar, revoked_at = CASE WHEN $2::varchar = 'revoked' THEN now() END WHERE id = $1`, [id, status]);

const input = (phone: string, over: Record<string, unknown> = {}) => ({
  phone_number: phone, provider_id: providers.voicelink, max_concurrent_calls: 3, label: 'Desk', region: 'IN',
  capabilities: ['voice'], notes: 'by hand', created_by: admin, ...over,
});

async function numberRow(phone: string) {
  const { rows } = await getTestPool().query<{ id: string; status: string; telephony_credential_id: string | null; provider_id: string; max_concurrent_calls: number; created_by: string | null }>(
    'SELECT id, status, telephony_credential_id, provider_id, max_concurrent_calls, created_by FROM phone_numbers WHERE phone_number = $1', [phone]);
  return rows[0];
}

async function assignments(phone: string) {
  const { rows } = await getTestPool().query<{ tenant_id: string; is_default: boolean; assigned_by: string | null; tags: number }>(
    `SELECT tpa.tenant_id, tpa.is_default, tpa.assigned_by,
            (SELECT count(*)::int FROM phone_account_tags pat WHERE pat.assignment_id = tpa.id) AS tags
       FROM tenant_phone_assignments tpa JOIN phone_numbers pn ON pn.id = tpa.phone_number_id
      WHERE pn.phone_number = $1`, [phone]);
  return rows;
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

describe('phoneNumberRepository.createPinned (integration, CR6)', () => {
  it('creates the number pinned to the credential, on its carrier, and assigns it untagged to the credential`s tenant', async () => {
    const cred = await insertCredential();
    const created = await phoneNumberRepository.createPinned(input('+919800000001'), cred);
    expect(created).toMatchObject({ ok: true, tenantId: tenant, phoneNumber: { phone_number: '+919800000001', telephony_credential_id: cred } });
    expect(await numberRow('+919800000001')).toMatchObject({
      status: 'active', telephony_credential_id: cred, provider_id: providers.voicelink, max_concurrent_calls: 3, created_by: admin,
    });
    expect(await assignments('+919800000001')).toEqual([{ tenant_id: tenant, is_default: false, assigned_by: admin, tags: 0 }]);
  });

  it('assigns only the number it adds: another of the credential`s numbers a super-admin unassigned stays unassigned', async () => {
    const cred = await insertCredential();
    await phoneNumberRepository.createPinned(input('+919800000001'), cred);
    await getTestPool().query(`DELETE FROM tenant_phone_assignments`);
    await phoneNumberRepository.createPinned(input('+919800000002'), cred);
    expect(await assignments('+919800000001')).toEqual([]);
    expect(await assignments('+919800000002')).toHaveLength(1);
  });

  it('a sync still assigns every number pinned to its credential (the shared assignment, unnarrowed)', async () => {
    const cred = await insertCredential('plivo');
    await phoneNumberRepository.syncForCredential(cred, [{ phone_number: '+14155550001', label: null }], admin);
    await getTestPool().query(`DELETE FROM tenant_phone_assignments`);
    await phoneNumberRepository.syncForCredential(cred, [{ phone_number: '+14155550001', label: null }], admin);
    expect(await assignments('+14155550001')).toHaveLength(1);
  });

  it('nothing is written for an unknown credential, one of another carrier, one not active, or a number that exists', async () => {
    expect(await phoneNumberRepository.createPinned(input('+919800000001'), randomUUID())).toEqual({ ok: false, reason: 'credential_not_found' });
    const plivo = await insertCredential('plivo');
    expect(await phoneNumberRepository.createPinned(input('+919800000001'), plivo)).toEqual({ ok: false, reason: 'credential_not_found' });
    for (const status of ['disabled', 'invalid', 'revoked'] as const) {
      const cred = await insertCredential('voicelink', tenant, status);
      expect(await phoneNumberRepository.createPinned(input('+919800000001'), cred)).toEqual({ ok: false, reason: 'credential_not_active', status });
    }
    expect(await numberRow('+919800000001')).toBeUndefined();

    const cred = await insertCredential();
    await getTestPool().query(`INSERT INTO phone_numbers (phone_number, provider_id) VALUES ('+919800000009', $1)`, [providers.voicelink]);
    expect(await phoneNumberRepository.createPinned(input('+919800000009'), cred)).toEqual({ ok: false, reason: 'duplicate' });
    expect(await numberRow('+919800000009')).toMatchObject({ telephony_credential_id: null });
    expect(await assignments('+919800000009')).toEqual([]);
  });

  it('waits for a disable holding the credential row, then sees it and writes nothing', async () => {
    const cred = await insertCredential();
    const holder = await getTestPool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE telephony_credentials SET status = 'disabled' WHERE id = $1`, [cred]);
      const pending = phoneNumberRepository.createPinned(input('+919800000001'), cred);
      await new Promise((r) => setTimeout(r, 100));
      await holder.query('COMMIT');
      expect(await pending).toEqual({ ok: false, reason: 'credential_not_active', status: 'disabled' });
    } finally {
      holder.release();
    }
    expect(await numberRow('+919800000001')).toBeUndefined();
  });
});

describe('a hand-pinned number follows PL4, PL5 and PL13 as a synced one does (integration, CR7)', () => {
  it('assigned to another tenant: refused on the credential, whichever way the number was pinned', async () => {
    const cred = await insertCredential();
    await phoneNumberRepository.createPinned(input('+919800000001'), cred);
    const id = (await numberRow('+919800000001'))!.id;
    const err = await tenantPhoneAssignmentRepository.assign(otherTenant, id, false).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PhoneNumberOtherTenantError);
    expect(await assignments('+919800000001')).toEqual([{ tenant_id: tenant, is_default: false, assigned_by: admin, tags: 0 }]);
    // Its own tenant may have it back once unassigned.
    await tenantPhoneAssignmentRepository.unassign(tenant, id);
    expect(await tenantPhoneAssignmentRepository.assign(tenant, id, false)).toMatchObject({ tenant_id: tenant });
  });

  it('offered as a caller ID only while its credential is active; one of that credential`s numbers for its campaigns', async () => {
    const cred = await insertCredential();
    await phoneNumberRepository.createPinned(input('+919800000001'), cred);
    const offered = async () => (await tenantPhoneAssignmentRepository.findAvailableForAccount(tenant, account)).map((n) => n.phone_number);
    expect(await offered()).toEqual(['+919800000001']);
    expect(await tenantPhoneAssignmentRepository.findCredentialNumbersForAccount(tenant, account, cred, ['+919800000001'])).toEqual(['+919800000001']);
    for (const status of ['disabled', 'invalid', 'revoked']) {
      await setStatus(cred, status);
      expect(await offered()).toEqual([]);
    }
  });
});

describe('phoneNumberRepository.findPinnedAmong (integration, CR9)', () => {
  it('names the numbers pinned to any credential, whatever their status or tenant; never a service number or an unknown one', async () => {
    const mine = await insertCredential();
    const theirs = await insertCredential('plivo', otherTenant);
    await phoneNumberRepository.createPinned(input('+919800000001'), mine);
    await phoneNumberRepository.syncForCredential(theirs, [{ phone_number: '+14155550001', label: null }, { phone_number: '+14155550002', label: null }], admin);
    // A sync that no longer lists +14155550002 retires it: it is still the tenant's number.
    await phoneNumberRepository.syncForCredential(theirs, [{ phone_number: '+14155550001', label: null }], admin);
    await getTestPool().query(`INSERT INTO phone_numbers (phone_number, provider_id) VALUES ('+919000000001', $1)`, [providers.voicelink]);
    await setStatus(mine, 'revoked');

    expect(await phoneNumberRepository.findPinnedAmong(['+919000000001', '+14155550002', '+919800000001', '+14155550001', '+10000000000']))
      .toEqual(['+14155550001', '+14155550002', '+919800000001']);
    expect(await phoneNumberRepository.findPinnedAmong(['+919000000001'])).toEqual([]);
    expect(await phoneNumberRepository.findPinnedAmong([])).toEqual([]);
  });
});

describe('phoneNumberRepository.findInboundLink carries the number`s carrier (integration, CR11)', () => {
  it('a hand-pinned number reads as its own carrier`s, a service number too', async () => {
    const cred = await insertCredential();
    await phoneNumberRepository.createPinned(input('+919800000001'), cred);
    const own = (await getTestPool().query<{ id: string }>(
      `INSERT INTO phone_numbers (phone_number, provider_id) VALUES ('+919000000001', $1) RETURNING id`, [providers.voicelink])).rows[0]!.id;
    expect(await phoneNumberRepository.findInboundLink((await numberRow('+919800000001'))!.id)).toMatchObject({
      provider_name: 'voicelink', telephony_credential_id: cred, credential_tenant_id: tenant, assigned: true,
    });
    expect(await phoneNumberRepository.findInboundLink(own)).toMatchObject({ provider_name: 'voicelink', telephony_credential_id: null });
  });
});
