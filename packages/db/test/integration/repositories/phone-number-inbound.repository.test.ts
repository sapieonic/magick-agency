// `phoneNumberRepository`'s inbound links (0024; docs/inbound.md §8.1, §8.2) against real
// Postgres: the read Link checks (credential, assignment to its tenant, the live route), the
// conditional link write (taken under the credential's `FOR SHARE` lock, so a disable's
// `FOR UPDATE` cannot interleave), and the clear that returns the link as it was.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant } from '../setup/factories.js';

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
  healthCheck: async () => true,
}));

const { phoneNumberRepository } = await import('../../../src/repositories/phone-number.repository.js');
const { telephonyCredentialRepository } = await import('../../../src/repositories/telephony-credential.repository.js');

const H1 = 'a'.repeat(64);
const URLS = {
  answerUrl: 'https://hooks.example.test/api/v1/webhooks/plivo/inbound-answer/x',
  hangupUrl: 'https://hooks.example.test/api/v1/webhooks/plivo/inbound-status/x',
  fallbackAnswerUrl: 'https://hooks.example.test/api/v1/webhooks/plivo/inbound-fallback',
};

let tenant: string;
let otherTenant: string;
let admin: string;
let plivo: string;

async function credential(status: 'active' | 'disabled' = 'active', app: string | null = 'app-1'): Promise<string> {
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref)
     VALUES ($1, 'plivo', $2, $3) RETURNING id`,
    [tenant, `cred-${randomUUID().slice(0, 6)}`, `MA${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`],
  );
  const id = rows[0]!.id;
  if (app) await telephonyCredentialRepository.enableInbound(id, { appId: app, tokenHash: H1, ...URLS }, admin);
  if (status !== 'active') await getTestPool().query('UPDATE telephony_credentials SET status = $2 WHERE id = $1', [id, status]);
  return id;
}

async function number(credentialId: string | null, opts: { assignTo?: string | null; status?: string } = {}): Promise<{ id: string; phone: string }> {
  const phone = `+1415555${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}`;
  const { rows } = await getTestPool().query<{ id: string }>(
    `INSERT INTO phone_numbers (phone_number, provider_id, telephony_credential_id, status) VALUES ($1, $2, $3, $4) RETURNING id`,
    [phone, plivo, credentialId, opts.status ?? 'active'],
  );
  const id = rows[0]!.id;
  const assignee = opts.assignTo === undefined ? tenant : opts.assignTo;
  if (assignee) await getTestPool().query('INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id) VALUES ($1, $2)', [assignee, id]);
  return { id, phone };
}

async function inTx<T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> {
  const client = await getTestPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

beforeEach(async () => {
  await truncateAll();
  plivo = (await getTestPool().query<{ id: string }>(
    `INSERT INTO telephony_providers (name, display_name) VALUES ('plivo', 'Plivo') RETURNING id`,
  )).rows[0]!.id;
  tenant = (await insertTenant()).id as string;
  otherTenant = (await insertTenant()).id as string;
  admin = (await getTestPool().query<{ id: string }>(
    `INSERT INTO super_admins (email, password_hash, name) VALUES ($1, 'x', 'Root') RETURNING id`,
    [`root-${randomUUID()}@example.test`],
  )).rows[0]!.id;
});

afterAll(async () => {
  await closeTestPool();
});

describe('phoneNumberRepository inbound links (integration)', () => {
  it('findInboundLink reads the number, its credential, its assignment to that tenant and its live route', async () => {
    const cred = await credential();
    const n = await number(cred);
    expect(await phoneNumberRepository.findInboundLink(n.id)).toMatchObject({
      phone_number_id: n.id, phone_number: n.phone, status: 'active', telephony_credential_id: cred,
      inbound_linked_at: null, inbound_previous_app_id: null, credential_status: 'active', credential_tenant_id: tenant,
      credential_app_id: 'app-1', assigned: true, route_id: null,
    });
    // Assigned only to another tenant: not this credential's tenant's.
    const elsewhere = await number(cred, { assignTo: otherTenant });
    expect((await phoneNumberRepository.findInboundLink(elsewhere.id))!.assigned).toBe(false);
    // On the service's own account: no credential.
    const own = await number(null);
    expect(await phoneNumberRepository.findInboundLink(own.id)).toMatchObject({ telephony_credential_id: null, credential_status: null, assigned: false });
    expect(await phoneNumberRepository.findInboundLink(randomUUID())).toBeNull();

    // A live route answering it is read; a detached one is not.
    await inTx((c) => phoneNumberRepository.linkInbound({ phoneNumberId: n.id, credentialId: cred, appId: 'app-1', previousAppId: null }, c));
    const route = (await getTestPool().query<{ id: string }>(
      `INSERT INTO agency_inbound_routes (tenant_id, account_id, name, timezone) VALUES ($1, $2, 'Main', 'UTC') RETURNING id`,
      [tenant, randomUUID()],
    )).rows[0]!.id;
    await getTestPool().query(`INSERT INTO agency_inbound_route_numbers (route_id, phone_number_id) VALUES ($1, $2)`, [route, n.id]);
    expect(await phoneNumberRepository.findInboundLink(n.id)).toMatchObject({ route_id: route, route_name: 'Main' });
    await getTestPool().query(`UPDATE agency_inbound_route_numbers SET detached_at = now(), detached_reason = 'detached' WHERE route_id = $1`, [route]);
    expect((await phoneNumberRepository.findInboundLink(n.id))!.route_id).toBeNull();
  });

  it('listInboundForCredential lists the credential`s numbers that are not deleted, by number', async () => {
    const cred = await credential();
    const a = await number(cred);
    const b = await number(cred, { status: 'retired' });
    await number(cred, { status: 'deleted' });
    await number(await credential('active', null));
    const listed = await phoneNumberRepository.listInboundForCredential(cred);
    expect(listed.map((r) => r.phone_number)).toEqual([a.phone, b.phone].sort());
  });

  it('links only an active number synced from the credential, assigned to its tenant, while the credential is active with that Application', async () => {
    const cred = await credential();
    const link = (phoneNumberId: string, credentialId = cred, appId = 'app-1', previousAppId: string | null = 'their-app') =>
      inTx((c) => phoneNumberRepository.linkInbound({ phoneNumberId, credentialId, appId, previousAppId }, c));

    const ok = await number(cred);
    const linked = await link(ok.id);
    expect(linked).toMatchObject({ id: ok.id, inbound_previous_app_id: 'their-app' });
    expect(linked!.inbound_linked_at).toBeInstanceOf(Date);
    // Twice: the second does not land (the first link and its previous app are kept).
    expect(await link(ok.id, cred, 'app-1', 'app-1')).toBeNull();
    expect((await phoneNumberRepository.findInboundLink(ok.id))!.inbound_previous_app_id).toBe('their-app');

    expect(await link((await number(cred, { status: 'retired' })).id)).toBeNull();
    expect(await link((await number(cred, { assignTo: null })).id)).toBeNull();
    expect(await link((await number(cred, { assignTo: otherTenant })).id)).toBeNull();
    const otherCred = await credential();
    expect(await link((await number(otherCred)).id)).toBeNull(); // synced from another credential
    expect(await link((await number(cred)).id, cred, 'app-stale')).toBeNull(); // the Application was replaced
    const off = await credential('disabled');
    expect(await link((await number(off)).id, off)).toBeNull();
    const noInbound = await credential('active', null);
    expect(await link((await number(noInbound)).id, noInbound, 'app-1')).toBeNull();
  });

  it('a link rolled back with its transaction leaves the number unlinked (the carrier refused)', async () => {
    const cred = await credential();
    const n = await number(cred);
    await expect(inTx(async (c) => {
      expect(await phoneNumberRepository.linkInbound({ phoneNumberId: n.id, credentialId: cred, appId: 'app-1', previousAppId: null }, c)).not.toBeNull();
      throw new Error('carrier refused');
    })).rejects.toThrow('carrier refused');
    expect((await phoneNumberRepository.findInboundLink(n.id))!.inbound_linked_at).toBeNull();
  });

  it('a link waits for a disable holding the credential row, then does not land on the disabled Application', async () => {
    const cred = await credential();
    const n = await number(cred);
    const holder = await getTestPool().connect();
    try {
      await holder.query('BEGIN');
      await telephonyCredentialRepository.lockInbound(cred, holder);
      let done = false;
      const linking = inTx((c) => phoneNumberRepository.linkInbound({ phoneNumberId: n.id, credentialId: cred, appId: 'app-1', previousAppId: null }, c))
        .then((r) => { done = true; return r; });
      await new Promise((r) => setTimeout(r, 150));
      expect(done).toBe(false);
      expect(await telephonyCredentialRepository.disableInbound(cred, admin, { client: holder })).toMatchObject({ ok: true });
      await holder.query('COMMIT');
      expect(await linking).toBeNull();
    } finally {
      holder.release();
    }
    expect((await phoneNumberRepository.findInboundLink(n.id))!.inbound_linked_at).toBeNull();
  });

  it('clearInboundLink returns the link as it was, once; a number not linked is null', async () => {
    const cred = await credential();
    const n = await number(cred);
    await inTx((c) => phoneNumberRepository.linkInbound({ phoneNumberId: n.id, credentialId: cred, appId: 'app-1', previousAppId: 'their-app' }, c));
    const cleared = await phoneNumberRepository.clearInboundLink(n.id);
    expect(cleared).toMatchObject({
      phone_number_id: n.id, phone_number: n.phone, status: 'active', telephony_credential_id: cred, inbound_previous_app_id: 'their-app',
    });
    expect(cleared!.inbound_linked_at).toBeInstanceOf(Date);
    expect(await phoneNumberRepository.findInboundLink(n.id)).toMatchObject({ inbound_linked_at: null, inbound_previous_app_id: null });
    expect(await phoneNumberRepository.clearInboundLink(n.id)).toBeNull();
    expect(await phoneNumberRepository.clearInboundLink(randomUUID())).toBeNull();
  });

  it('the credential`s linked count follows the links (what disable inbound refuses on)', async () => {
    const cred = await credential();
    const n = await number(cred);
    await inTx((c) => phoneNumberRepository.linkInbound({ phoneNumberId: n.id, credentialId: cred, appId: 'app-1', previousAppId: null }, c));
    expect((await telephonyCredentialRepository.findInbound(cred))!.linked_numbers).toBe(1);
    expect(await telephonyCredentialRepository.disableInbound(cred, admin)).toEqual({ ok: false, reason: 'numbers_linked' });
    await phoneNumberRepository.clearInboundLink(n.id);
    expect((await telephonyCredentialRepository.disableInbound(cred, admin)).ok).toBe(true);
  });
  it('findAll names the live route answering each number (inbound_route_name), and none for an unrouted one', async () => {
    const cred = await credential();
    const routed = await number(cred);
    const unrouted = await number(cred);
    for (const n of [routed, unrouted]) {
      await inTx((c) => phoneNumberRepository.linkInbound({ phoneNumberId: n.id, credentialId: cred, appId: 'app-1', previousAppId: null }, c));
    }
    const route = (await getTestPool().query<{ id: string }>(
      `INSERT INTO agency_inbound_routes (tenant_id, account_id, name, timezone) VALUES ($1, $2, 'Main line', 'UTC') RETURNING id`,
      [tenant, randomUUID()],
    )).rows[0]!.id;
    await getTestPool().query(`INSERT INTO agency_inbound_route_numbers (route_id, phone_number_id) VALUES ($1, $2)`, [route, routed.id]);
    const byId = new Map((await phoneNumberRepository.findAll()).map((r) => [r.id, r]));
    expect(byId.get(routed.id)).toMatchObject({ inbound_route_name: 'Main line' });
    expect(byId.get(unrouted.id)).toMatchObject({ inbound_route_name: null });
    // Detached: no longer answered by it.
    await getTestPool().query(`UPDATE agency_inbound_route_numbers SET detached_at = now(), detached_reason = 'detached' WHERE route_id = $1`, [route]);
    expect((await phoneNumberRepository.findAll()).find((r) => r.id === routed.id)).toMatchObject({ inbound_route_name: null });
  });

  it('findUnroutedMissed counts a number`s open tenant-default Missed rows and names the latest; nothing else counts', async () => {
    const cred = await credential();
    const n = await number(cred);
    const other = await number(cred);
    const account = randomUUID();
    let seq = 0;
    const missed = async (o: { number?: string; tenantId?: string; accountId?: string | null; from?: string | null; at: string; status?: 'open' | 'handled' }) => {
      const id = randomUUID();
      const handled = o.status === 'handled';
      await getTestPool().query(
        `INSERT INTO agency_inbound_calls
           (id, tenant_id, account_id, phone_number_id, provider_call_id, to_e164, from_e164, state, outcome,
            arrived_at, answered_at, ended_at, settled_at, follow_up_status, follow_up_reason, handled_at)
         VALUES ($1, $2, $3, $4, $5, '+14155550100', $6, 'ended', 'closed', $7, $7, $7, $7, $8, 'closed', $9)`,
        [id, o.tenantId ?? tenant, o.accountId ?? null, o.number ?? n.id, `CA-${++seq}-${id}`,
          o.from === undefined ? '+447700900001' : o.from, new Date(o.at), handled ? 'handled' : 'open', handled ? new Date(o.at) : null],
      );
    };
    expect(await phoneNumberRepository.findUnroutedMissed(tenant, n.id)).toEqual({ open_count: 0, latest_arrived_at: null, latest_from_e164: null });

    await missed({ at: '2026-11-01T09:00:00Z', from: '+447700900001' });
    await missed({ at: '2026-11-03T09:00:00Z', from: null });                 // the latest: a withheld caller
    await missed({ at: '2026-11-02T09:00:00Z', from: '+447700900002' });
    await missed({ at: '2026-11-04T09:00:00Z', status: 'handled' });          // handled: not open
    await missed({ at: '2026-11-05T09:00:00Z', accountId: account });         // an account's row: its Missed list shows it
    await missed({ at: '2026-11-05T09:00:00Z', number: other.id });           // another number
    await missed({ at: '2026-11-05T09:00:00Z', tenantId: otherTenant });      // another tenant's row naming the number

    const got = await phoneNumberRepository.findUnroutedMissed(tenant, n.id);
    expect(got).toEqual({ open_count: 3, latest_arrived_at: new Date('2026-11-03T09:00:00Z'), latest_from_e164: null });
  });
});
