import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENCY_INBOUND_ROUTE_DEFAULTS, type AgencyInboundRouteConfig } from '@magick-agency/contracts/agency';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, insertTenant } from '../setup/factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyInboundRouteRepository: repo, inboundRouteToWire } = await import('../../../src/db/repositories/agency.repository.js');
const { parseInboundRouteCreate } = await import('../../../src/agency/inbound/route-config.js');

/**
 * The inbound route repository on real Postgres (docs/inbound.md §8; `0024_inbound.sql`): create and
 * update with the name rule, soft delete detaching the numbers, the account scope of every read
 * and write, attaching a number with every check (tenant, account tags, active, linked, one live
 * route per number, idempotent), the all-or-nothing number set, the §8.2 cascade's detach, and the
 * answer webhook's lookup by number.
 *
 * Mutation-checked: dropping `FOR UPDATE` from `lockRoute` lets a delete racing an attach leave a
 * number attached to a deleted route; dropping the account-tag clause lets a number tagged to
 * another account attach; dropping `tx.rollback()` from `setNumbers` keeps the half applied
 * before a refusal.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const B = OTHER_ACCOUNT;
const pool = () => getTestPool();

let credentialId: string;
let plivoId: string;
let seq = 0;

function config(o: Partial<AgencyInboundRouteConfig> = {}): AgencyInboundRouteConfig {
  const parsed = parseInboundRouteCreate({ name: `Route ${++seq}`, timezone: 'Europe/London', ...o });
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.issues));
  return parsed.config;
}

async function route(o: Partial<AgencyInboundRouteConfig> = {}, account: string = A) {
  const out = await repo.create({ tenantId: T, accountId: account, createdBy: randomUUID(), config: config(o) });
  if (!out.ok) throw new Error(out.reason);
  return out.route;
}

/**
 * A number on the tenant's credential: assigned to tenant `tenant` (null: not assigned), tagged
 * to `tags` (empty: every account), linked to inbound unless `linked: false`.
 */
async function number(o: { tenant?: string | null; tags?: string[]; linked?: boolean; status?: string } = {}) {
  const e164 = `+1415555${String(1000 + ++seq).padStart(4, '0')}`;
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO phone_numbers (phone_number, provider_id, telephony_credential_id, status, inbound_linked_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [e164, plivoId, credentialId, o.status ?? 'active', o.linked === false ? null : new Date()]);
  const id = rows[0]!.id;
  const tenant = o.tenant === undefined ? T : o.tenant;
  if (tenant) {
    const a = await pool().query<{ id: string }>(
      'INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id) VALUES ($1, $2) RETURNING id', [tenant, id]);
    for (const account of o.tags ?? []) {
      await pool().query('INSERT INTO phone_account_tags (assignment_id, account_id) VALUES ($1, $2)', [a.rows[0]!.id, account]);
    }
  }
  return { id, e164 };
}

async function activeLinks(phoneNumberId: string) {
  const { rows } = await pool().query<{ route_id: string }>(
    'SELECT route_id FROM agency_inbound_route_numbers WHERE phone_number_id = $1 AND detached_at IS NULL', [phoneNumberId]);
  return rows.map((r) => r.route_id);
}

beforeEach(async () => {
  await truncateAll();
  const { rows } = await pool().query<{ id: string }>(
    `INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink'), ('plivo', 'Plivo') RETURNING id, name`);
  plivoId = rows[1]!.id;
  await insertTenant({ id: T });
  for (const id of [A, B]) {
    await pool().query(`INSERT INTO accounts (id, tenant_id, name, slug) VALUES ($1, $2, 'Acct', $3)`, [id, T, `a-${randomUUID()}`]);
  }
  credentialId = (await pool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', 'MAAAAAAAAAAAAAAAAAAA') RETURNING id`,
    [T])).rows[0]!.id;
});

afterAll(closeTestPool);

describe('create and update', () => {
  it('stores the whole config, defaults included, and reads it back as the console shape', async () => {
    const created = await route({ weekly_hours: [{ day: 1, start: '09:00', end: '17:00' }], max_concurrent: 30 });
    expect(created).toMatchObject({
      tenant_id: T, account_id: A, sticky_mode: 'loose', sticky_wait_seconds: 30, sticky_lookback_days: 30,
      queue_max_wait_seconds: 120, max_waiting: 10, max_concurrent: 30, after_hours_action: 'callback',
      record_calls: false, recording_notice: true, pool_campaign_ids: [], deleted_at: null,
    });
    const read = await repo.findById(T, A, created.id);
    const wire = inboundRouteToWire(read!);
    const { id: _id, account_id: _a, numbers, created_at, updated_at, ...cfg } = wire;
    expect(cfg).toEqual({ ...config({ weekly_hours: [{ day: 1, start: '09:00', end: '17:00' }], max_concurrent: 30 }), name: created.name });
    expect(numbers).toEqual([]);
    expect(typeof created_at).toBe('string');
    expect(typeof updated_at).toBe('string');
    expect(wire.clips).toEqual(AGENCY_INBOUND_ROUTE_DEFAULTS.clips);
  });

  it('one live name per account, case-insensitive, answered without breaking the caller\'s transaction', async () => {
    await route({ name: 'Main line' });
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      const out = await repo.create({ tenantId: T, accountId: A, createdBy: null, config: config({ name: 'MAIN LINE' }) }, { client });
      expect(out).toEqual({ ok: false, reason: 'name_taken' });
      // The transaction is still usable.
      await expect(client.query('SELECT 1')).resolves.toBeTruthy();
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    await route({ name: 'Main line' }, B); // another account
  });

  it('a patch replaces only the fields present, clips per slot; a rename onto a taken name is name_taken', async () => {
    const clip = (await pool().query<{ id: string }>(
      `INSERT INTO audio_files (tenant_id, account_id, name, slug, original_filename, content_type, size_bytes, s3_key)
       VALUES ($1, $2, 'Hello', 'hello', 'hello.mp3', 'audio/mpeg', 1, 'k') RETURNING id`, [T, A])).rows[0]!.id;
    const r = await route({ name: 'One' });
    await route({ name: 'Two' });
    const out = await repo.update(T, A, r.id, { clips: { greeting: clip }, max_waiting: 4, holidays: [{ from: '2026-12-25', to: '2026-12-25', label: 'Christmas Day' }] }, randomUUID());
    expect(out).toMatchObject({
      ok: true,
      route: { name: 'One', greeting_audio_id: clip, closed_audio_id: null, max_waiting: 4, max_concurrent: 20,
        holidays: [{ from: '2026-12-25', to: '2026-12-25', label: 'Christmas Day' }] },
    });
    expect(await repo.update(T, A, r.id, { name: 'two' }, null)).toEqual({ ok: false, reason: 'name_taken' });
    expect(await repo.update(T, A, r.id, {}, null)).toMatchObject({ ok: true, route: { id: r.id } });
    // Another account's, a missing and a deleted route are all not_found.
    expect(await repo.update(T, B, r.id, { max_waiting: 1 }, null)).toEqual({ ok: false, reason: 'not_found' });
    expect(await repo.update(T, A, randomUUID(), { max_waiting: 1 }, null)).toEqual({ ok: false, reason: 'not_found' });
    await repo.softDelete(T, A, r.id, null);
    expect(await repo.update(T, A, r.id, { max_waiting: 1 }, null)).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe('the validator and the table agree', () => {
  it('the validator\'s extremes are stored (every bound the API accepts, the CHECKs accept)', async () => {
    const L = (await import('@magick-agency/contracts/agency')).AGENCY_INBOUND_ROUTE_LIMITS;
    const highs = config({
      name: 'x'.repeat(L.NAME_MAX),
      weekly_hours: Array.from({ length: L.WEEKLY_HOURS_MAX }, (_, i) => ({ day: (i % 7) + 1, start: '00:00', end: '24:00' })),
      holidays: Array.from({ length: L.HOLIDAYS_MAX }, () => ({ from: '2026-12-01', to: '2026-12-31', label: 'y'.repeat(L.HOLIDAY_LABEL_MAX) })),
      sticky_wait_seconds: L.STICKY_WAIT_SECONDS.max, sticky_lookback_days: L.STICKY_LOOKBACK_DAYS.max,
      pool_campaign_ids: Array.from({ length: L.POOL_CAMPAIGNS_MAX }, () => randomUUID()),
      queue_max_wait_seconds: L.QUEUE_MAX_WAIT_SECONDS.max, max_waiting: L.MAX_WAITING.max, max_concurrent: L.MAX_CONCURRENT.max,
    });
    await expect(repo.create({ tenantId: T, accountId: A, createdBy: null, config: highs })).resolves.toMatchObject({ ok: true });
    const lows = config({
      sticky_wait_seconds: L.STICKY_WAIT_SECONDS.min, sticky_lookback_days: L.STICKY_LOOKBACK_DAYS.min,
      queue_max_wait_seconds: L.QUEUE_MAX_WAIT_SECONDS.min, max_waiting: L.MAX_WAITING.min, max_concurrent: L.MAX_CONCURRENT.min,
    });
    await expect(repo.create({ tenantId: T, accountId: A, createdBy: null, config: lows })).resolves.toMatchObject({ ok: true });
  });
});

describe('numbers', () => {
  it('attach: the tenant\'s active, linked number the account may use; idempotent on its own route', async () => {
    const r = await route();
    const n = await number();
    expect(await repo.attachNumber({ tenantId: T, accountId: A, routeId: r.id, phoneNumberId: n.id, attachedBy: null }))
      .toEqual({ ok: true, attached: true });
    expect(await repo.attachNumber({ tenantId: T, accountId: A, routeId: r.id, phoneNumberId: n.id, attachedBy: null }))
      .toEqual({ ok: true, attached: false });
    // Tagged to this account: fine.
    const tagged = await number({ tags: [A] });
    expect(await repo.attachNumber({ tenantId: T, accountId: A, routeId: r.id, phoneNumberId: tagged.id, attachedBy: null }))
      .toMatchObject({ ok: true });
    expect((await repo.findById(T, A, r.id))!.numbers.map((x) => x.phone_number)).toEqual([n.e164, tagged.e164].sort());
  });

  it.each([
    ['not assigned to the tenant', { tenant: null }],
    ['tagged to another account only', { tags: [B] }],
    ['retired', { status: 'retired' }],
  ])('refuses a number %s as number_not_found', async (_label, o) => {
    const r = await route();
    const n = await number(o);
    expect(await repo.attachNumber({ tenantId: T, accountId: A, routeId: r.id, phoneNumberId: n.id, attachedBy: null }))
      .toEqual({ ok: false, reason: 'number_not_found', phoneNumberId: n.id });
  });

  it('refuses a number not linked to inbound, one on another live route, and a route that is not the account\'s', async () => {
    const r = await route();
    const other = await route();
    const unlinked = await number({ linked: false });
    expect(await repo.attachNumber({ tenantId: T, accountId: A, routeId: r.id, phoneNumberId: unlinked.id, attachedBy: null }))
      .toEqual({ ok: false, reason: 'number_not_linked', phoneNumberId: unlinked.id });
    const n = await number();
    await repo.attachNumber({ tenantId: T, accountId: A, routeId: other.id, phoneNumberId: n.id, attachedBy: null });
    expect(await repo.attachNumber({ tenantId: T, accountId: A, routeId: r.id, phoneNumberId: n.id, attachedBy: null }))
      .toEqual({ ok: false, reason: 'number_in_use', phoneNumberId: n.id, routeId: other.id });
    const bRoute = await route({}, B);
    expect(await repo.attachNumber({ tenantId: T, accountId: A, routeId: bRoute.id, phoneNumberId: (await number()).id, attachedBy: null }))
      .toEqual({ ok: false, reason: 'route_not_found' });
  });

  it('two routes racing for one number: exactly one wins, the other is told which route has it', async () => {
    const [r1, r2] = [await route(), await route()];
    const n = await number();
    const outs = await Promise.all([r1, r2].map((r) =>
      repo.attachNumber({ tenantId: T, accountId: A, routeId: r.id, phoneNumberId: n.id, attachedBy: null })));
    expect(outs.filter((o) => o.ok)).toHaveLength(1);
    const lost = outs.find((o) => !o.ok);
    expect(lost).toMatchObject({ reason: 'number_in_use' });
    expect(await activeLinks(n.id)).toHaveLength(1);
  });

  it('setNumbers replaces the whole set, all or nothing', async () => {
    const r = await route();
    const [n1, n2, n3] = [await number(), await number(), await number()];
    expect(await repo.setNumbers({ tenantId: T, accountId: A, routeId: r.id, phoneNumberIds: [n1.id, n2.id], userId: null }))
      .toEqual({ ok: true, added: [n1.id, n2.id].sort(), removed: [] });
    expect(await repo.setNumbers({ tenantId: T, accountId: A, routeId: r.id, phoneNumberIds: [n2.id, n3.id, n3.id], userId: null }))
      .toEqual({ ok: true, added: [n3.id], removed: [n1.id] });
    // A refusal half-way rolls back the detach of n2 and the attach of n1 before it.
    const unlinked = await number({ linked: false });
    expect(await repo.setNumbers({ tenantId: T, accountId: A, routeId: r.id, phoneNumberIds: [n1.id, unlinked.id], userId: null }))
      .toEqual({ ok: false, reason: 'number_not_linked', phoneNumberId: unlinked.id });
    expect((await repo.findById(T, A, r.id))!.numbers.map((x) => x.phone_number_id).sort()).toEqual([n2.id, n3.id].sort());
    expect(await repo.setNumbers({ tenantId: T, accountId: A, routeId: r.id, phoneNumberIds: [], userId: null }))
      .toEqual({ ok: true, added: [], removed: [n2.id, n3.id].sort() });
    expect(await repo.setNumbers({ tenantId: T, accountId: B, routeId: r.id, phoneNumberIds: [], userId: null }))
      .toEqual({ ok: false, reason: 'route_not_found' });
  });

  it('the §8.2 cascade detaches a number from whichever route answers it', async () => {
    const r = await route();
    const n = await number();
    await repo.attachNumber({ tenantId: T, accountId: A, routeId: r.id, phoneNumberId: n.id, attachedBy: null });
    expect(await repo.detachNumberEverywhere(n.id)).toEqual({ routeId: r.id, tenantId: T, accountId: A });
    expect(await repo.detachNumberEverywhere(n.id)).toBeNull();
    const { rows } = await pool().query('SELECT detached_reason, detached_at IS NOT NULL AS gone FROM agency_inbound_route_numbers WHERE phone_number_id = $1', [n.id]);
    expect(rows).toEqual([{ detached_reason: 'number_unlinked', gone: true }]);
  });
});

describe('delete and list', () => {
  it('soft delete detaches the numbers, frees the name, and hides the route from every read', async () => {
    const r = await route({ name: 'Sales' });
    const kept = await route({ name: 'Support' });
    const [n1, n2] = [await number(), await number()];
    await repo.setNumbers({ tenantId: T, accountId: A, routeId: r.id, phoneNumberIds: [n1.id, n2.id], userId: null });
    expect(await repo.softDelete(T, B, r.id, null)).toBeNull();
    const by = randomUUID();
    const out = await repo.softDelete(T, A, r.id, by);
    expect(out!.route).toMatchObject({ id: r.id, deleted_by: by });
    expect(out!.detachedPhoneNumberIds).toEqual([n1.id, n2.id].sort());
    expect(await repo.softDelete(T, A, r.id, by)).toBeNull();
    expect(await repo.findById(T, A, r.id)).toBeNull();
    expect((await repo.listForAccount(T, A)).map((x) => x.id)).toEqual([kept.id]);
    await route({ name: 'sales' });
    const { rows } = await pool().query(
      `SELECT DISTINCT detached_reason FROM agency_inbound_route_numbers WHERE route_id = $1`, [r.id]);
    expect(rows).toEqual([{ detached_reason: 'route_deleted' }]);
    // The numbers are free for another route.
    const again = await route();
    expect(await repo.attachNumber({ tenantId: T, accountId: A, routeId: again.id, phoneNumberId: n1.id, attachedBy: null }))
      .toEqual({ ok: true, attached: true });
  });

  it('a delete and an attach on one route serialise: no number is left on a deleted route', async () => {
    for (let i = 0; i < 5; i++) {
      const r = await route();
      const n = await number();
      await Promise.all([
        repo.softDelete(T, A, r.id, null),
        repo.attachNumber({ tenantId: T, accountId: A, routeId: r.id, phoneNumberId: n.id, attachedBy: null }),
      ]);
      expect(await activeLinks(n.id)).toEqual([]);
    }
  });

  it('lists the account\'s live routes oldest first, each with its numbers, and nothing of another account', async () => {
    const r1 = await route({ name: 'First' });
    const r2 = await route({ name: 'Second' });
    await route({ name: 'Elsewhere' }, B);
    const n = await number();
    await repo.attachNumber({ tenantId: T, accountId: A, routeId: r2.id, phoneNumberId: n.id, attachedBy: null });
    const list = await repo.listForAccount(T, A);
    expect(list.map((x) => [x.id, x.numbers.map((m) => m.phone_number)])).toEqual([[r1.id, []], [r2.id, [n.e164]]]);
  });
});

describe('findRouteForNumber (the answer webhook\'s lookup)', () => {
  it('the number, its tenant and credential, and the live route answering it', async () => {
    const r = await route({ name: 'Main line' });
    const n = await number();
    await repo.attachNumber({ tenantId: T, accountId: A, routeId: r.id, phoneNumberId: n.id, attachedBy: null });
    const found = await repo.findRouteForNumber(credentialId, n.e164);
    expect(found).toMatchObject({
      phone_number_id: n.id, phone_number: n.e164, number_status: 'active', telephony_credential_id: credentialId,
      tenant_id: T, credential_status: 'active', route_account_may_use: true,
      route: { id: r.id, name: 'Main line', account_id: A, sticky_mode: 'loose', max_waiting: 10 },
    });
    expect(found!.inbound_linked_at).toBeInstanceOf(Date);
    expect(found!.assignment_id).toEqual(expect.any(String));
    expect(found!.route!.created_at).toBeInstanceOf(Date);
    expect(found!.route!.deleted_at).toBeNull();
  });

  it('no route: route null; another credential\'s number: null; untagged from the route\'s account: may_use false', async () => {
    const n = await number();
    expect(await repo.findRouteForNumber(credentialId, n.e164)).toMatchObject({ route: null, route_account_may_use: false });
    expect(await repo.findRouteForNumber(randomUUID(), n.e164)).toBeNull();
    expect(await repo.findRouteForNumber(credentialId, '+19999999999')).toBeNull();
    const r = await route();
    const tagged = await number({ tags: [A] });
    await repo.attachNumber({ tenantId: T, accountId: A, routeId: r.id, phoneNumberId: tagged.id, attachedBy: null });
    // A super-admin re-tags it to B only (the cascade has not run yet): the lookup says so.
    await pool().query(`UPDATE phone_account_tags SET account_id = $1`, [B]);
    expect(await repo.findRouteForNumber(credentialId, tagged.e164)).toMatchObject({ route: { id: r.id }, route_account_may_use: false });
    // Not assigned to the credential's tenant: no assignment, and no account may use it.
    const loose = await number({ tenant: null });
    expect(await repo.findRouteForNumber(credentialId, loose.e164)).toMatchObject({ assignment_id: null, route: null });
  });
});
