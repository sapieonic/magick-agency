// Numbers on a tenant's own carrier account added by hand (docs/carriers.md CR6, CR7) and the
// read CR9 judges a service-account campaign's caller IDs with, against real Postgres:
//  - `phoneNumberRepository.createPinned`: the number pinned to an `active` credential of its
//    carrier and assigned untagged to the credential's tenant in the same transaction, as a
//    sync assigns the numbers it adds; nothing written for a credential not found, of another
//    carrier, not active, or a number already in the inventory;
//  - a hand-pinned number follows PL4, PL5 and PL13 as a synced one does: offered as a caller ID
//    only while its credential is `active`, one of that credential's numbers for its campaigns,
//    never assigned to another tenant;
//  - `findPinnedAmong`: the numbers pinned to any credential, whatever their status or tenant;
//  - `lockPinnedAmong`: the same, in a campaign write's transaction, holding the rows `FOR SHARE`
//    so a move and the write never both commit, in the order a sync locks them;
//  - `pinToCredential`: a number on the service's own account moved, one way, onto a tenant's
//    own account of its carrier, with every refusal, and its locks against a concurrent disable,
//    assignment, `createPinned` and sync.
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

/** A service-account number (no credential), optionally assigned to `assignedTo`. */
async function serviceNumber(phone: string, assignedTo: string[] = [], provider: 'voicelink' | 'plivo' = 'voicelink'): Promise<string> {
  const id = (await getTestPool().query<{ id: string }>(
    `INSERT INTO phone_numbers (phone_number, provider_id) VALUES ($1, $2) RETURNING id`, [phone, providers[provider]])).rows[0]!.id;
  for (const t of assignedTo) await tenantPhoneAssignmentRepository.assign(t, id, false);
  return id;
}

async function campaign(name: string, callerIds: string[], over: { status?: string; credentialId?: string | null; tenantId?: string; accountId?: string } = {}) {
  await getTestPool().query(
    `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids, telephony_provider, telephony_credential_id, status)
     VALUES ($1, $2, $3, $4, 'voicelink', $5, $6)`,
    [over.tenantId ?? tenant, over.accountId ?? account, name, callerIds, over.credentialId ?? null, over.status ?? 'draft'],
  );
}

describe('phoneNumberRepository.pinToCredential (integration: a service number moved onto a tenant`s own account)', () => {
  it('pins the number and assigns it untagged to the credential`s tenant, keeping an assignment it already had there', async () => {
    const cred = await insertCredential();
    const id = await serviceNumber('+919000000001');
    const pinned = await phoneNumberRepository.pinToCredential(id, cred, admin);
    expect(pinned).toMatchObject({
      ok: true, tenantId: tenant,
      phoneNumber: { id, phone_number: '+919000000001', telephony_credential_id: cred, status: 'active', provider_name: 'voicelink' },
    });
    expect(await assignments('+919000000001')).toEqual([{ tenant_id: tenant, is_default: false, assigned_by: admin, tags: 0 }]);
    // Now one of the credential's numbers for its campaigns (PL13), and refused to another tenant (CR7).
    expect(await tenantPhoneAssignmentRepository.findCredentialNumbersForAccount(tenant, account, cred, ['+919000000001'])).toEqual(['+919000000001']);
    expect(await tenantPhoneAssignmentRepository.assign(otherTenant, id, false).catch((e: unknown) => e)).toBeInstanceOf(PhoneNumberOtherTenantError);

    // Already assigned to the credential's tenant, as default and tagged: left as it was.
    const kept = await serviceNumber('+919000000002');
    const a = await tenantPhoneAssignmentRepository.assign(tenant, kept, true, admin);
    await getTestPool().query(`INSERT INTO phone_account_tags (assignment_id, account_id) VALUES ($1, $2)`, [a.id, account]);
    expect((await phoneNumberRepository.pinToCredential(kept, cred, null)).ok).toBe(true);
    expect(await assignments('+919000000002')).toEqual([{ tenant_id: tenant, is_default: true, assigned_by: admin, tags: 1 }]);
  });

  it('refuses, writing nothing: no number, retired or deleted, already pinned, unknown credential or another carrier`s, credential not active', async () => {
    const cred = await insertCredential();
    expect(await phoneNumberRepository.pinToCredential(randomUUID(), cred, admin)).toEqual({ ok: false, reason: 'phone_number_not_found' });
    for (const [phone, status] of [['+919000000101', 'retired'], ['+919000000102', 'deleted']] as const) {
      const id = await serviceNumber(phone);
      await getTestPool().query(`UPDATE phone_numbers SET status = $2 WHERE id = $1`, [id, status]);
      expect(await phoneNumberRepository.pinToCredential(id, cred, admin)).toEqual({ ok: false, reason: 'phone_number_not_active', status });
    }
    await phoneNumberRepository.createPinned(input('+919800000001'), cred);
    const pinnedId = (await numberRow('+919800000001'))!.id;
    expect(await phoneNumberRepository.pinToCredential(pinnedId, cred, admin)).toEqual({ ok: false, reason: 'already_pinned' });
    expect(await phoneNumberRepository.pinToCredential(pinnedId, await insertCredential(), admin)).toEqual({ ok: false, reason: 'already_pinned' });

    const id = await serviceNumber('+919000000001');
    expect(await phoneNumberRepository.pinToCredential(id, randomUUID(), admin)).toEqual({ ok: false, reason: 'credential_not_found' });
    expect(await phoneNumberRepository.pinToCredential(id, await insertCredential('plivo'), admin)).toEqual({ ok: false, reason: 'credential_not_found' });
    for (const status of ['disabled', 'invalid', 'revoked'] as const) {
      expect(await phoneNumberRepository.pinToCredential(id, await insertCredential('voicelink', tenant, status), admin))
        .toEqual({ ok: false, reason: 'credential_not_active', status });
    }
    expect(await numberRow('+919000000001')).toMatchObject({ telephony_credential_id: null });
    expect(await assignments('+919000000001')).toEqual([]);
  });

  it('refuses a number assigned to any tenant other than the credential`s, naming how many', async () => {
    const cred = await insertCredential();
    const third = (await insertTenant()).id as string;
    const id = await serviceNumber('+919000000001', [tenant, otherTenant, third]);
    expect(await phoneNumberRepository.pinToCredential(id, cred, admin)).toEqual({ ok: false, reason: 'assigned_elsewhere', tenantCount: 2 });
    expect(await numberRow('+919000000001')).toMatchObject({ telephony_credential_id: null });
  });

  it('refuses while a service-account campaign that is not finished holds it as a caller ID, naming up to the limit, running first', async () => {
    const cred = await insertCredential();
    const id = await serviceNumber('+919000000001', [tenant]);
    const otherAccount = (await insertAccount({ tenant_id: otherTenant })).id as string;
    await campaign('Draft one', ['+919000000001']);
    await campaign('Running one', ['+919000000002', '+919000000001'], { status: 'running' });
    await campaign('Theirs paused', ['+919000000001'], { status: 'paused', tenantId: otherTenant, accountId: otherAccount });
    await campaign('Stopping one', ['+919000000001'], { status: 'stopping' });
    // Not counted: finished, another number, or on a credential.
    await campaign('Stopped one', ['+919000000001'], { status: 'stopped' });
    await campaign('Completed one', ['+919000000001'], { status: 'completed' });
    await campaign('Other number', ['+919000000002'], { status: 'running' });
    await campaign('On the credential', ['+919000000001'], { status: 'running', credentialId: cred });

    const refused = await phoneNumberRepository.pinToCredential(id, cred, admin, { campaignsNamed: 3 });
    expect(refused).toMatchObject({ ok: false, reason: 'in_use', total: 4 });
    expect(refused.ok === false && refused.reason === 'in_use' && refused.campaigns.map((c) => [c.campaign_name, c.status])).toEqual([
      ['Running one', 'running'], ['Stopping one', 'stopping'], ['Theirs paused', 'paused'],
    ]);
    expect(refused.ok === false && refused.reason === 'in_use' && refused.campaigns[0]).toMatchObject({ tenant_name: expect.any(String), account_name: expect.any(String) });
    expect(await numberRow('+919000000001')).toMatchObject({ telephony_credential_id: null });

    await getTestPool().query(`UPDATE agency_campaigns SET status = 'stopped' WHERE telephony_credential_id IS NULL`);
    expect((await phoneNumberRepository.pinToCredential(id, cred, admin)).ok).toBe(true);
  });

  it('waits for a disable holding the credential row, then sees it and writes nothing', async () => {
    const cred = await insertCredential();
    const id = await serviceNumber('+919000000001');
    const holder = await getTestPool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`UPDATE telephony_credentials SET status = 'disabled' WHERE id = $1`, [cred]);
      const pending = phoneNumberRepository.pinToCredential(id, cred, admin);
      await new Promise((r) => setTimeout(r, 100));
      await holder.query('COMMIT');
      expect(await pending).toEqual({ ok: false, reason: 'credential_not_active', status: 'disabled' });
    } finally {
      holder.release();
    }
    expect(await numberRow('+919000000001')).toMatchObject({ telephony_credential_id: null });
  });

  it('an assignment to another tenant racing the pin: whichever takes the number`s row first, the other sees it', async () => {
    const cred = await insertCredential();
    // The pin first: the assignment waits for it, then is refused on the credential.
    const id = await serviceNumber('+919000000001');
    const holder = await getTestPool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM telephony_credentials WHERE id = $1 FOR NO KEY UPDATE`, [cred]);
      await holder.query(`SELECT 1 FROM phone_numbers WHERE id = $1 FOR UPDATE`, [id]);
      await holder.query(`UPDATE phone_numbers SET telephony_credential_id = $2 WHERE id = $1`, [id, cred]);
      const assigning = tenantPhoneAssignmentRepository.assign(otherTenant, id, false).catch((e: unknown) => e);
      await new Promise((r) => setTimeout(r, 100));
      await holder.query('COMMIT');
      expect(await assigning).toBeInstanceOf(PhoneNumberOtherTenantError);
    } finally {
      holder.release();
    }
    expect(await assignments('+919000000001')).toEqual([]);

    // The assignment first: the pin waits for it, then refuses the number as assigned elsewhere.
    const second = await serviceNumber('+919000000002');
    const assigner = await getTestPool().connect();
    try {
      await assigner.query('BEGIN');
      await assigner.query(`SELECT 1 FROM phone_numbers WHERE id = $1 FOR SHARE`, [second]);
      await assigner.query(`INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id, is_default) VALUES ($1, $2, false)`, [otherTenant, second]);
      const pinning = phoneNumberRepository.pinToCredential(second, cred, admin);
      await new Promise((r) => setTimeout(r, 100));
      await assigner.query('COMMIT');
      expect(await pinning).toEqual({ ok: false, reason: 'assigned_elsewhere', tenantCount: 1 });
    } finally {
      assigner.release();
    }
  });

  it('takes its locks in createPinned`s and a sync`s order: all of them on one credential at once finish, none deadlocks', async () => {
    const cred = await insertCredential();
    const plivo = await insertCredential('plivo');
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await serviceNumber(`+91900000000${i}`));
    const results = await Promise.all([
      ...ids.map((id) => phoneNumberRepository.pinToCredential(id, cred, admin)),
      ...Array.from({ length: 6 }, (_, i) => phoneNumberRepository.createPinned(input(`+91980000000${i}`), cred)),
      // A sync of another credential naming the numbers being pinned: they are not its to take.
      phoneNumberRepository.syncForCredential(plivo, ids.map((_, i) => ({ phone_number: `+91900000000${i}`, label: null })), admin),
      // A pin of the same number twice at once: one lands, the other sees it pinned.
      phoneNumberRepository.pinToCredential(ids[0]!, cred, admin),
      // An assignment of a number being pinned, to another tenant: refused, whichever goes first.
      tenantPhoneAssignmentRepository.assign(otherTenant, ids[1]!, false).catch((e: unknown) => e),
    ]);
    const pins = results.slice(0, 6) as Array<{ ok: boolean; reason?: string }>;
    const created = results.slice(6, 12) as Array<{ ok: boolean }>;
    expect(created.every((r) => r.ok)).toBe(true);
    // ids[0] was pinned by one of the two pins; ids[1] by its pin unless the assignment went first.
    const twice = [pins[0]!, results[13] as { ok: boolean; reason?: string }];
    expect(twice.filter((r) => r.ok)).toHaveLength(1);
    expect(twice.find((r) => !r.ok)).toEqual({ ok: false, reason: 'already_pinned' });
    expect(pins.slice(2).every((r) => r.ok)).toBe(true);
    const assigned = results[14];
    if (pins[1]!.ok) expect(assigned).toBeInstanceOf(PhoneNumberOtherTenantError);
    else expect(pins[1]).toEqual({ ok: false, reason: 'assigned_elsewhere', tenantCount: 1 });
    expect(results[12]).toMatchObject({ added: [] });
    const { rows } = await getTestPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM phone_numbers WHERE telephony_credential_id = $1`, [cred]);
    expect(rows[0]!.n).toBe(pins[1]!.ok ? 12 : 11);
  });
});

/** Until some statement of this database waits on a lock (the other side has blocked). */
async function untilSomeoneWaits(): Promise<void> {
  await vi.waitFor(async () => {
    const { rows } = await getTestPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    expect(rows[0]!.n).toBeGreaterThan(0);
  }, { timeout: 5000, interval: 20 });
}

describe('phoneNumberRepository.lockPinnedAmong (integration: a campaign write against a move, CR9)', () => {
  it('names the pinned numbers as findPinnedAmong does, whatever their status or tenant, sorted; an unknown number is not one', async () => {
    const mine = await insertCredential();
    const theirs = await insertCredential('plivo', otherTenant);
    await phoneNumberRepository.createPinned(input('+919800000001'), mine);
    await phoneNumberRepository.syncForCredential(theirs, [{ phone_number: '+14155550001', label: null }], admin);
    await serviceNumber('+919000000001');
    await setStatus(mine, 'revoked');
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      expect(await phoneNumberRepository.lockPinnedAmong(client, ['+919000000001', '+919800000001', '+14155550001', '+10000000000']))
        .toEqual(['+14155550001', '+919800000001']);
      expect(await phoneNumberRepository.lockPinnedAmong(client, [])).toEqual([]);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('the write first: a move of the number waits for it, then sees the campaign holding it (`in_use`)', async () => {
    const cred = await insertCredential();
    const id = await serviceNumber('+919000000001');
    const writer = await getTestPool().connect();
    try {
      await writer.query('BEGIN');
      expect(await phoneNumberRepository.lockPinnedAmong(writer, ['+919000000001'])).toEqual([]);
      await writer.query(
        `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids) VALUES ($1, $2, 'Racing', '{+919000000001}')`,
        [tenant, account]);
      const pinning = phoneNumberRepository.pinToCredential(id, cred, admin);
      await untilSomeoneWaits();
      await writer.query('COMMIT');
      expect(await pinning).toMatchObject({ ok: false, reason: 'in_use', total: 1 });
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
    }
    expect(await numberRow('+919000000001')).toMatchObject({ telephony_credential_id: null });
  });

  it('the move first: the write waits for it, then sees the number pinned', async () => {
    const cred = await insertCredential();
    const id = await serviceNumber('+919000000001');
    await serviceNumber('+919000000002');
    const mover = await getTestPool().connect();
    const writer = await getTestPool().connect();
    try {
      await mover.query('BEGIN');
      await mover.query(`SELECT 1 FROM phone_numbers WHERE id = $1 FOR UPDATE`, [id]);
      await mover.query(`UPDATE phone_numbers SET telephony_credential_id = $2 WHERE id = $1`, [id, cred]);
      await writer.query('BEGIN');
      const locking = phoneNumberRepository.lockPinnedAmong(writer, ['+919000000001', '+919000000002']);
      await untilSomeoneWaits();
      await mover.query('COMMIT');
      expect(await locking).toEqual(['+919000000001']);
    } finally {
      await writer.query('ROLLBACK').catch(() => undefined);
      await mover.query('ROLLBACK').catch(() => undefined);
      mover.release();
      writer.release();
    }
  });

  it('takes the rows in a sync`s order: campaign writes and a sync over the same numbers at once all finish', async () => {
    const cred = await insertCredential('plivo');
    const numbers = Array.from({ length: 8 }, (_, i) => `+1415555010${i}`);
    await phoneNumberRepository.syncForCredential(cred, numbers.map((n) => ({ phone_number: n, label: null })), admin);
    const write = async (order: string[]) => {
      const client = await getTestPool().connect();
      try {
        await client.query('BEGIN');
        const pinned = await phoneNumberRepository.lockPinnedAmong(client, order);
        await new Promise((r) => setTimeout(r, 20));
        await client.query('COMMIT');
        return pinned;
      } finally {
        client.release();
      }
    };
    const results = await Promise.all([
      write(numbers), write([...numbers].reverse()), write([numbers[3]!, numbers[0]!, numbers[7]!]),
      phoneNumberRepository.syncForCredential(cred, [...numbers].reverse().map((n) => ({ phone_number: n, label: null })), admin),
      write([numbers[5]!, numbers[1]!, numbers[6]!, numbers[2]!]),
    ]);
    expect(results[0]).toEqual([...numbers].sort());
    expect(results[3]).toMatchObject({ unchanged: [...numbers].sort() });
  });
});
