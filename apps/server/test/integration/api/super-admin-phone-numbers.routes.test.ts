/*
 * The super-admin number routes on real Postgres (docs/carriers.md CR6, CR7, and the provider
 * capabilities): `POST /super-admin/phone-numbers` by account mode, a number added by hand pinned
 * to a credential and assigned to its tenant in one write, a pin that no later write moves, and
 * `POST /super-admin/phone-numbers/:id/pin`, the one way a service number moves onto a tenant's
 * own account.
 *
 * Carriers come from a catalogue double (`test/helpers/carrier-catalog-double.ts`), so each mode
 * is named here whatever the real catalogue declares: VoiceLink has the service's account AND
 * tenant accounts, its tenant numbers added by hand (it has no number list); Plivo is real (tenant
 * accounts only, numbers synced).
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { closePool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/integration/setup/test-utils.js';
import { insertAccount, insertTenant } from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { trackSuperAdminAuditWrites } from '../../helpers/drain-super-admin-audit.js';

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

const carriers = vi.hoisted(() => ({ voicelink: { accounts: { service: true, tenant: true } } }));
vi.mock('../../../src/telephony/carrier-catalog.js', async (importOriginal) =>
  (await import('../../helpers/carrier-catalog-double.js')).catalogDouble(await importOriginal(), carriers));

const admin = vi.hoisted(() => ({ id: '' }));
vi.mock('../../../src/auth/super-admin.middleware.js', () => ({
  superAdminMiddleware: async (req: { superAdmin?: unknown }) => {
    req.superAdmin = { id: admin.id, email: 'root@example.test' };
  },
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// The PL13 caller-ID cache: a number write clears it.
const dialability = vi.hoisted(() => ({ invalidate: vi.fn() }));
vi.mock('../../../src/agency/campaign-dialability.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  invalidateDialableCallerIds: dialability.invalidate,
}));

const { superAdminPhoneRoutes } = await import('../../../src/api/routes/super-admin-phone.routes.js');

let app: FastifyInstance;
let tenant: string;
let otherTenant: string;
let providers: { voicelink: string; plivo: string };
let credVl: string;

const auditWrites = trackSuperAdminAuditWrites();
const pool = () => getTestPool();

async function insertCredential(provider: string, tenantId: string, status = 'active'): Promise<string> {
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref, status, revoked_at)
     VALUES ($1, $2, $3, $4, $5::varchar, CASE WHEN $5::varchar = 'revoked' THEN now() END) RETURNING id`,
    [tenantId, provider, `cred-${randomUUID().slice(0, 6)}`, `acct-${randomUUID().slice(0, 12)}`, status]);
  return rows[0]!.id;
}

const createNumber = (payload: Record<string, unknown>) => app.inject({
  method: 'POST', url: '/super-admin/phone-numbers',
  payload: { phone_number: '+919800000001', provider_id: providers.voicelink, max_concurrent_calls: 2, ...payload },
});

async function numberRow(phone: string) {
  const { rows } = await pool().query<{ id: string; telephony_credential_id: string | null; provider_id: string; status: string }>(
    'SELECT id, telephony_credential_id, provider_id, status FROM phone_numbers WHERE phone_number = $1', [phone]);
  return rows[0];
}

async function assignedTenants(phone: string): Promise<string[]> {
  const { rows } = await pool().query<{ tenant_id: string }>(
    `SELECT tpa.tenant_id FROM tenant_phone_assignments tpa JOIN phone_numbers pn ON pn.id = tpa.phone_number_id
      WHERE pn.phone_number = $1`, [phone]);
  return rows.map((r) => r.tenant_id);
}

beforeEach(async () => {
  await truncateAll();
  admin.id = (await pool().query<{ id: string }>(
    `INSERT INTO super_admins (email, password_hash, name) VALUES ($1, 'x', 'Root') RETURNING id`,
    [`root-${randomUUID()}@example.test`])).rows[0]!.id;
  const { rows } = await pool().query<{ id: string; name: string }>(
    `INSERT INTO telephony_providers (name, display_name, status) VALUES ('voicelink', 'VoiceLink', 'active'), ('plivo', 'Plivo', 'active') RETURNING id, name`);
  providers = { voicelink: rows.find((r) => r.name === 'voicelink')!.id, plivo: rows.find((r) => r.name === 'plivo')!.id };
  tenant = (await insertTenant()).id as string;
  otherTenant = (await insertTenant()).id as string;
  credVl = await insertCredential('voicelink', tenant);
  app = Fastify({ logger: false });
  await app.register(superAdminPhoneRoutes, {
    prefix: '/super-admin', inbound: () => ({ reconcileNumber: vi.fn().mockResolvedValue(false) }) as never,
  });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
  await auditWrites.drain();
});

afterAll(async () => {
  auditWrites.restore();
  await closePool();
  await closeTestPool();
});

describe('POST /super-admin/phone-numbers by account mode (CR6)', () => {
  it('with a credential: created pinned, assigned untagged to the credential`s tenant, and audited with the credential', async () => {
    const res = await createNumber({ telephony_credential_id: credVl, label: 'Desk' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().phone_number).toMatchObject({ phone_number: '+919800000001', telephony_credential_id: credVl, label: 'Desk' });
    expect(await numberRow('+919800000001')).toMatchObject({ telephony_credential_id: credVl, provider_id: providers.voicelink, status: 'active' });
    expect(await assignedTenants('+919800000001')).toEqual([tenant]);
    const tags = await pool().query(
      `SELECT 1 FROM phone_account_tags pat JOIN tenant_phone_assignments tpa ON tpa.id = pat.assignment_id
        JOIN phone_numbers pn ON pn.id = tpa.phone_number_id WHERE pn.phone_number = '+919800000001'`);
    expect(tags.rows).toHaveLength(0);
    await auditWrites.drain();
    const audit = await pool().query<{ action: string; details: Record<string, unknown> }>(
      `SELECT action, details FROM super_admin_audit_log WHERE resource_type = 'phone_number'`);
    expect(audit.rows).toEqual([{
      action: 'create_phone_number',
      details: { phone_number: '+919800000001', provider_id: providers.voicelink, telephony_credential_id: credVl, tenant_id: tenant },
    }]);
  });

  it('without one, on a carrier with a service account: on the service`s own account, assigned to nobody', async () => {
    const res = await createNumber({});
    expect(res.statusCode, res.body).toBe(201);
    expect(await numberRow('+919800000001')).toMatchObject({ telephony_credential_id: null });
    expect(await assignedTenants('+919800000001')).toEqual([]);
  });

  it('a credential not found, of another carrier, or not active: 404 / 409 with the campaign codes, nothing written', async () => {
    const plivo = await insertCredential('plivo', tenant);
    for (const id of [randomUUID(), plivo]) {
      const res = await createNumber({ telephony_credential_id: id });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'telephony_credential_not_found' });
    }
    for (const status of ['disabled', 'invalid', 'revoked']) {
      const res = await createNumber({ telephony_credential_id: await insertCredential('voicelink', tenant, status) });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'telephony_credential_not_active' });
      expect(res.json().message).toContain(status);
    }
    expect(await numberRow('+919800000001')).toBeUndefined();
  });

  it('Plivo, whose numbers are synced, still refuses numbers by hand with or without a credential', async () => {
    const plivo = await insertCredential('plivo', tenant);
    for (const payload of [{}, { telephony_credential_id: plivo }]) {
      const res = await createNumber({ provider_id: providers.plivo, ...payload });
      expect(res.statusCode).toBe(400);
      expect(res.json().message).toBe('Numbers on this carrier come from the tenant’s carrier account: sync them from its credential instead');
    }
    expect(await numberRow('+919800000001')).toBeUndefined();
  });

  it('a credential on a carrier with no tenant accounts is refused before any write', async () => {
    carriers.voicelink = { accounts: { service: true, tenant: false } };
    try {
      const res = await createNumber({ telephony_credential_id: credVl });
      expect(res.statusCode).toBe(400);
      expect(await numberRow('+919800000001')).toBeUndefined();
    } finally {
      carriers.voicelink = { accounts: { service: true, tenant: true } };
    }
  });

  it('a number already in the inventory is 409, and its pin is untouched', async () => {
    await createNumber({});
    const res = await createNumber({ telephony_credential_id: credVl });
    expect(res.statusCode).toBe(409);
    expect(await numberRow('+919800000001')).toMatchObject({ telephony_credential_id: null });
  });
});

describe('a pin never moves (CR7)', () => {
  it('a hand-pinned number cannot be assigned to another tenant; its own tenant may have it back', async () => {
    await createNumber({ telephony_credential_id: credVl });
    const { id } = (await numberRow('+919800000001'))!;
    const other = await app.inject({ method: 'POST', url: `/super-admin/phone-numbers/${id}/assign`, payload: { tenant_id: otherTenant } });
    expect(other.statusCode).toBe(409);
    expect(other.json().message).toBe('This number is on another tenant’s own carrier account and can only be assigned to that tenant');
    expect(await assignedTenants('+919800000001')).toEqual([tenant]);

    const unassigned = await app.inject({ method: 'DELETE', url: `/super-admin/phone-numbers/${id}/assign/${tenant}` });
    expect(unassigned.statusCode).toBe(200);
    // Unassigned, it is still pinned: still nobody else's.
    expect((await app.inject({ method: 'POST', url: `/super-admin/phone-numbers/${id}/assign`, payload: { tenant_id: otherTenant } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: `/super-admin/phone-numbers/${id}/assign`, payload: { tenant_id: tenant } })).statusCode).toBe(201);
  });

  it('PUT cannot clear or move the pin, nor change the carrier', async () => {
    await createNumber({ telephony_credential_id: credVl });
    const { id } = (await numberRow('+919800000001'))!;
    const otherCred = await insertCredential('voicelink', otherTenant);
    for (const pin of [null, otherCred]) {
      const res = await app.inject({
        method: 'PUT', url: `/super-admin/phone-numbers/${id}`,
        payload: { label: 'Renamed', telephony_credential_id: pin, provider_id: providers.plivo },
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    expect(await numberRow('+919800000001')).toMatchObject({ telephony_credential_id: credVl, provider_id: providers.voicelink });
  });

  it('a number on the service`s own account still goes to any tenant', async () => {
    await createNumber({});
    const { id } = (await numberRow('+919800000001'))!;
    for (const tenantId of [tenant, otherTenant]) {
      expect((await app.inject({ method: 'POST', url: `/super-admin/phone-numbers/${id}/assign`, payload: { tenant_id: tenantId } })).statusCode).toBe(201);
    }
  });
});

describe('GET /super-admin/telephony-providers carries each carrier`s capabilities', () => {
  it('a carrier with both modes and numbers by hand; Plivo with tenant accounts, numbers synced and inbound', async () => {
    const res = await app.inject({ method: 'GET', url: '/super-admin/telephony-providers' });
    const byName = Object.fromEntries((res.json().providers as Array<Record<string, unknown>>).map((p) => [p['name'], p]));
    expect(byName['voicelink']).toMatchObject({
      service_account: true, tenant_accounts: true, takes_tenant_credentials: true, number_source: 'manual', supports_inbound: false,
    });
    expect(byName['plivo']).toMatchObject({
      service_account: false, tenant_accounts: true, takes_tenant_credentials: true, number_source: 'sync', supports_inbound: true,
    });
  });
});

describe('POST /super-admin/phone-numbers/:id/pin: a service number moved onto a tenant`s own account (CR6)', () => {
  const pin = (id: string, payload: Record<string, unknown> = { telephony_credential_id: credVl }) =>
    app.inject({ method: 'POST', url: `/super-admin/phone-numbers/${id}/pin`, payload });

  /** A number on the service's own account, as every VoiceLink number registered before tenant accounts is. */
  async function serviceNumber(phone = '+919000000001', provider: 'voicelink' | 'plivo' = 'voicelink'): Promise<string> {
    const res = await pool().query<{ id: string }>(
      `INSERT INTO phone_numbers (phone_number, provider_id) VALUES ($1, $2) RETURNING id`, [phone, providers[provider]]);
    return res.rows[0]!.id;
  }

  async function campaigns(n: number, phone: string, status = 'running') {
    const account = (await insertAccount({ tenant_id: tenant, name: 'Collections' })).id as string;
    for (let i = 0; i < n; i++) {
      await pool().query(
        `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids, telephony_provider, status)
         VALUES ($1, $2, $3, $4, 'voicelink', $5)`,
        [tenant, account, `Drive ${i + 1}`, [phone], status]);
    }
  }

  it('pins it, assigns it untagged to the credential`s tenant, clears the caller-ID cache and audits it with the credential', async () => {
    const id = await serviceNumber();
    dialability.invalidate.mockClear();
    const res = await pin(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      tenant_id: tenant,
      phone_number: { id, phone_number: '+919000000001', telephony_credential_id: credVl, status: 'active', provider_name: 'voicelink' },
    });
    expect(res.json().phone_number).not.toHaveProperty('pool_eligible');
    expect(await numberRow('+919000000001')).toMatchObject({ telephony_credential_id: credVl, status: 'active' });
    expect(await assignedTenants('+919000000001')).toEqual([tenant]);
    expect(dialability.invalidate).toHaveBeenCalledTimes(1);
    await auditWrites.drain();
    const audit = await pool().query<{ action: string; resource_id: string; details: Record<string, unknown> }>(
      `SELECT action, resource_id, details FROM super_admin_audit_log WHERE resource_type = 'phone_number'`);
    expect(audit.rows).toEqual([{
      action: 'pin_phone_number', resource_id: id,
      details: { phone_number: '+919000000001', telephony_credential_id: credVl, tenant_id: tenant },
    }]);

    // One way: a second pin, to any credential, is refused, and the pin is as it was.
    const again = await pin(id, { telephony_credential_id: await insertCredential('voicelink', tenant) });
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: 'phone_number_already_pinned' });
    expect(await numberRow('+919000000001')).toMatchObject({ telephony_credential_id: credVl });
  });

  it('a malformed id or body is refused before any read; an unknown number is 404', async () => {
    const id = await serviceNumber();
    expect((await pin('not-a-uuid')).json()).toMatchObject({ code: 'phone_number_not_found' });
    expect((await pin(randomUUID())).statusCode).toBe(404);
    for (const payload of [{}, { telephony_credential_id: 'x' }, { telephony_credential_id: credVl, tenant_id: otherTenant }]) {
      expect((await pin(id, payload)).statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect(await numberRow('+919000000001')).toMatchObject({ telephony_credential_id: null });
  });

  it('a carrier whose numbers are synced, or one with no tenant accounts, takes no pin by hand', async () => {
    const plivoNumber = await serviceNumber('+14155550001', 'plivo');
    const plivo = await pin(plivoNumber, { telephony_credential_id: await insertCredential('plivo', tenant) });
    expect(plivo.statusCode).toBe(409);
    expect(plivo.json()).toMatchObject({ code: 'carrier_numbers_not_pinned_by_hand' });

    const id = await serviceNumber();
    carriers.voicelink = { accounts: { service: true, tenant: false } };
    try {
      const res = await pin(id);
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'carrier_numbers_not_pinned_by_hand' });
    } finally {
      carriers.voicelink = { accounts: { service: true, tenant: true } };
    }
    expect(await numberRow('+919000000001')).toMatchObject({ telephony_credential_id: null });
  });

  it('a credential not found, of another carrier, or not active: the create route`s codes; a retired number: 409', async () => {
    const id = await serviceNumber();
    for (const cred of [randomUUID(), await insertCredential('plivo', tenant)]) {
      const res = await pin(id, { telephony_credential_id: cred });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ code: 'telephony_credential_not_found' });
    }
    for (const status of ['disabled', 'invalid', 'revoked']) {
      const res = await pin(id, { telephony_credential_id: await insertCredential('voicelink', tenant, status) });
      expect(res.statusCode).toBe(409);
      expect(res.json()).toMatchObject({ code: 'telephony_credential_not_active', status });
    }
    await pool().query(`UPDATE phone_numbers SET status = 'retired' WHERE id = $1`, [id]);
    const retired = await pin(id);
    expect(retired.statusCode).toBe(409);
    expect(retired.json()).toMatchObject({ code: 'phone_number_not_active', status: 'retired', message: 'The number is retired, so it cannot be moved. Reactivate it first.' });
    expect(await numberRow('+919000000001')).toMatchObject({ telephony_credential_id: null });
  });

  it('assigned to other tenants: refused naming how many; unassigning is a separate action', async () => {
    const id = await serviceNumber();
    for (const t of [tenant, otherTenant]) await pool().query(
      `INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id, is_default) VALUES ($1, $2, false)`, [t, id]);
    const res = await pin(id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({
      error: 'Conflict', code: 'phone_number_assigned_elsewhere', tenant_count: 1,
      message: 'This number is assigned to 1 other tenant. Unassign it from that tenant first.',
    });
    await app.inject({ method: 'DELETE', url: `/super-admin/phone-numbers/${id}/assign/${otherTenant}` });
    expect((await pin(id)).statusCode).toBe(200);
    expect(await assignedTenants('+919000000001')).toEqual([tenant]);
  });

  it('held as a caller ID by service-account campaigns that are not finished: refused naming the first five and how many more', async () => {
    const id = await serviceNumber();
    await campaigns(7, '+919000000001');
    const res = await pin(id);
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body).toMatchObject({ code: 'phone_number_in_use', campaigns_total: 7 });
    expect(body.campaigns).toHaveLength(5);
    expect(body.campaigns[0]).toMatchObject({ campaign_name: 'Drive 1', status: 'running', account_name: 'Collections', tenant_name: expect.any(String) });
    expect(body.message).toMatch(/^7 campaigns that are not finished use this number as a caller ID on the service’s own carrier account: “Drive 1” \(.+ \/ Collections, running\), /);
    expect(body.message).toMatch(/“Drive 5” \(.+ \/ Collections, running\) and 2 more\. Remove the number from them, or stop them, first\.$/);
    expect(await numberRow('+919000000001')).toMatchObject({ telephony_credential_id: null });
  });

  it('two pins of one number at once, to two credentials: one lands, the other is refused as already pinned', async () => {
    const id = await serviceNumber();
    const second = await insertCredential('voicelink', tenant);
    const [a, b] = await Promise.all([pin(id), pin(id, { telephony_credential_id: second })]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
    const lost = a.statusCode === 409 ? a : b;
    expect(lost.json()).toMatchObject({ code: 'phone_number_already_pinned' });
    expect((await numberRow('+919000000001'))!.telephony_credential_id).toBe(a.statusCode === 200 ? credVl : second);
  });
});
