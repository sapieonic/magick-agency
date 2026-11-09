import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

/**
 * ─── Inbound routes and the Missed inbound list through the real app and Postgres ──────────
 *
 * `/proxy/agency/inbound/*` (docs/inbound.md §7, §8.1): the session (Firebase stubbed), tenant
 * context, RBAC, the `agency_inbound_enabled` flag, the public routes, `callCore`, the internal
 * handlers (`api/routes/agency/inbound.ts`) and the repositories on real Postgres, with the audit
 * rows they write.
 *
 * What it pins:
 *  1. a route's whole life: create with its numbers, read, list, PATCH (fields and the number
 *     set), a PATCH that changes nothing (no audit), delete (numbers detached), each audited
 *     with ids only;
 *  2. validation: the body's shape, `voicemail` refused in this build (create and PATCH), the
 *     account's own clips / profile / pool campaigns, the cross-field rule judged on the merged
 *     route, the name rule;
 *  3. numbers: unlinked, another account's, on another route of the account (named) or of
 *     another account (not named), and a refused number leaves nothing written;
 *  4. the editor's choices (numbers with why one cannot be used; the account's audio files);
 *  5. access: an agent cannot reach the routes, the flag off refuses everyone, another account
 *     or tenant reads nothing, a malformed id is the family's 404;
 *  6. the Missed list: an agent sees only their own rows whatever they ask, a supervisor the
 *     account's with every filter and keyset paging, names filled;
 *  7. Mark handled: an agent's own row only, idempotent (first handler kept, one audit row),
 *     a supervisor any row of the account, never another account's.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'inbound-routes-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});
vi.mock('../../../src/auth/firebase.js', () => ({ initFirebase: vi.fn(), verifyIdToken: mocks.verifyIdToken }));
/** The app's bucket, in memory: the voicemails the playback route streams (ranges as S3 answers them). */
const bucket = vi.hoisted(() => ({ files: new Map<string, Buffer>() }));
vi.mock('../../../src/storage/s3.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/storage/s3.js')>();
  const { Readable } = await import('node:stream');
  return {
    ...actual,
    isStorageConfigured: () => true,
    getFileStream: async (key: string, opts: { range?: string } = {}) => {
      const file = bucket.files.get(key);
      if (!file) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey', $metadata: { httpStatusCode: 404 } });
      const m = opts.range ? /^bytes=(\d+)-(\d*)$/.exec(opts.range) : null;
      if (!m) return { body: Readable.from([file]), contentLength: file.length };
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), file.length - 1) : file.length - 1;
      const part = file.subarray(start, end + 1);
      return { body: Readable.from([part]), contentLength: part.length, contentRange: `bytes ${start}-${end}/${file.length}` };
    },
  };
});

import { getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  drainAudits, headersFor, seedFloor, startLoadApp, stopLoadApp, verifyTestToken,
  type Actor, type LoadApp, type TenantFloor,
} from '../load/load-harness.js';
import { getFeatureFlagService } from '../../../src/feature-flags/index.js';
import { agencyInboundCallRepository } from '../../../src/db/repositories/agency.repository.js';

const q = (sql: string, values: unknown[] = []) => getTestPool().query(sql, values);

let loaded: LoadApp;
let floor: TenantFloor;
let other: TenantFloor;
let accountB: string;
let supB: Actor;
let plivo: string;
const credentials = new Map<string, string>();
const sup = () => floor.supervisors[0]!;
const agent = (i: number) => floor.agents[i]!;

const numbers = { linked1: '', linked2: '', linked3: '', unlinked: '', onlyB: '' };
let clipA: string;
let clipB: string;
let profileA: string;
let profileB: string;

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
function call(method: Method, url: string, actor: Actor, body?: unknown, opts: { f?: TenantFloor; account?: string } = {}) {
  const f = opts.f ?? floor;
  return loaded.app.inject({
    method,
    url: `/proxy/agency/inbound${url}`,
    headers: headersFor(actor, f, {
      ...(opts.account ? { 'x-account-id': opts.account } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    }),
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

async function setFlag(tenant: string, on: boolean, account?: string): Promise<void> {
  await q(`DELETE FROM feature_flag_overrides WHERE flag_key = 'agency_inbound_enabled' AND tenant_id = $1
            AND scope_type = $2 AND account_id IS NOT DISTINCT FROM $3`, [tenant, account ? 'account' : 'tenant', account ?? null]);
  await q(`INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, account_id, value)
           VALUES ('agency_inbound_enabled', $1, $2, $3, $4::jsonb)`, [account ? 'account' : 'tenant', tenant, account ?? null, on ? 'true' : 'false']);
  await getFeatureFlagService().invalidate({ tenantId: tenant });
}

let seq = 0;
/** A number on the tenant's Plivo credential, assigned to it, tagged to `tags`, linked unless told. */
async function number(tenant: string, o: { tags?: string[]; linked?: boolean } = {}): Promise<string> {
  const { rows } = await q(
    `INSERT INTO phone_numbers (phone_number, provider_id, telephony_credential_id, status, inbound_linked_at)
     VALUES ($1, $2, $3, 'active', $4) RETURNING id`,
    [`+1415666${String(1000 + ++seq).padStart(4, '0')}`, plivo, credentials.get(tenant), o.linked === false ? null : new Date()]);
  const id = rows[0]!.id as string;
  const a = await q('INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id) VALUES ($1, $2) RETURNING id', [tenant, id]);
  for (const account of o.tags ?? []) {
    await q('INSERT INTO phone_account_tags (assignment_id, account_id) VALUES ($1, $2)', [a.rows[0]!.id, account]);
  }
  return id;
}

async function audioFile(tenant: string, account: string, name: string): Promise<string> {
  const { rows } = await q(
    `INSERT INTO audio_files (tenant_id, account_id, name, slug, original_filename, content_type, size_bytes, s3_key, duration_seconds)
     VALUES ($1, $2, $3, $4, 'clip.mp3', 'audio/mpeg', 1000, $5, 4.5) RETURNING id`,
    [tenant, account, name, `clip-${randomUUID()}`, `audio/${randomUUID()}.mp3`]);
  return rows[0]!.id as string;
}

async function audits(action: string, resourceId: string) {
  await drainAudits();
  const { rows } = await q(
    `SELECT user_id, account_id, details FROM platform_audit_log WHERE action = $1 AND resource_id = $2`, [action, resourceId]);
  return rows as Array<{ user_id: string; account_id: string; details: Record<string, unknown> }>;
}

async function liveNumbersOf(routeId: string): Promise<string[]> {
  const { rows } = await q('SELECT phone_number_id FROM agency_inbound_route_numbers WHERE route_id = $1 AND detached_at IS NULL ORDER BY 1', [routeId]);
  return rows.map((r) => r.phone_number_id as string);
}

async function createRoute(actor: Actor, body: Record<string, unknown>, opts: { account?: string } = {}) {
  const res = await call('POST', '/routes', actor, { timezone: 'Europe/London', ...body }, opts);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().route as { id: string; name: string; numbers: Array<{ phone_number_id: string }> };
}

/** An ended call that reached nobody: an open Missed row. */
async function missed(o: {
  tenant?: string; account?: string; assignee?: string | null; reason?: 'closed' | 'overflow' | 'abandoned_in_queue';
  at: Date; from?: string | null; dnc?: boolean; voicemail?: { key: (id: string) => string; seconds: number };
}): Promise<string> {
  const tenant = o.tenant ?? floor.tenant;
  const row = (await agencyInboundCallRepository.insertArrival({
    tenantId: tenant, accountId: o.account ?? floor.account, routeId: null, phoneNumberId: null,
    provider: 'plivo', telephonyCredentialId: credentials.get(tenant)!, providerCallId: `CA-${randomUUID()}`,
    fromE164: o.from === undefined ? '+447700900123' : o.from, toE164: '+14155550100',
    identification: { match: null, callerDnc: o.dnc ?? false, sticky: null },
    answered: true, recordingRequested: false, analysisProfileId: null,
  })).call!;
  await q('UPDATE agency_inbound_calls SET arrived_at = $2 WHERE id = $1', [row.id, o.at]);
  const reason = o.reason ?? 'closed';
  await agencyInboundCallRepository.end(row.id, {
    outcome: o.voicemail ? 'voicemail' : reason, talkSeconds: null, followUp: { reason, assigneeUserId: o.assignee ?? null },
    callbackDueAt: null, voicemailKey: o.voicemail?.key(row.id) ?? null, voicemailSeconds: o.voicemail?.seconds ?? null,
  });
  return row.id;
}

beforeAll(async () => {
  mocks.verifyIdToken.mockImplementation(verifyTestToken);
  loaded = await startLoadApp();
  await truncateAll();
  [floor, other] = (await seedFloor({ tenants: 2, agentsPerTenant: 2, supervisorsPerTenant: 1, campaignsPerTenant: 1 })) as [TenantFloor, TenantFloor];

  accountB = randomUUID();
  await q(`INSERT INTO accounts (id, tenant_id, name, slug, settings, status) VALUES ($1, $2, 'South', $3, '{}'::jsonb, 'active')`,
    [accountB, floor.tenant, `south-${accountB.slice(0, 8)}`]);
  const supBId = randomUUID();
  const uid = `inb-supb-${supBId.slice(0, 8)}`;
  await q(`INSERT INTO users (id, firebase_uid, email, display_name, status) VALUES ($1, $2, $3, 'Supervisor B', 'active')`,
    [supBId, uid, `${uid}@load.example.com`]);
  await q(`INSERT INTO memberships (id, user_id, tenant_id, account_id, role, status) VALUES ($1, $2, $3, $4, 'account_admin', 'active')`,
    [randomUUID(), supBId, floor.tenant, accountB]);
  supB = { id: supBId, uid, tok: `tok:${uid}`, role: 'account_admin', ip: '10.77.0.1' };

  await q(`INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink'), ('plivo', 'Plivo') ON CONFLICT DO NOTHING`);
  plivo = (await q(`SELECT id FROM telephony_providers WHERE name = 'plivo'`)).rows[0]!.id as string;
  for (const f of [floor, other]) {
    const { rows } = await q(
      `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', $2) RETURNING id`,
      [f.tenant, `MA${randomUUID().replace(/-/g, '').slice(0, 18).toUpperCase()}`]);
    credentials.set(f.tenant, rows[0]!.id as string);
    await setFlag(f.tenant, true);
  }
  numbers.linked1 = await number(floor.tenant);
  numbers.linked2 = await number(floor.tenant);
  numbers.linked3 = await number(floor.tenant);
  numbers.unlinked = await number(floor.tenant, { linked: false });
  numbers.onlyB = await number(floor.tenant, { tags: [accountB] });

  clipA = await audioFile(floor.tenant, floor.account, 'Welcome');
  clipB = await audioFile(floor.tenant, accountB, 'South welcome');
  profileA = (await q(`INSERT INTO call_analysis_profiles (tenant_id, account_id, name, is_active) VALUES ($1, $2, 'Inbound summary', true) RETURNING id`,
    [floor.tenant, floor.account])).rows[0]!.id as string;
  profileB = (await q(`INSERT INTO call_analysis_profiles (tenant_id, account_id, name, is_active) VALUES ($1, $2, 'South summary', true) RETURNING id`,
    [floor.tenant, accountB])).rows[0]!.id as string;
});

afterAll(async () => {
  // 0024's Down refuses while inbound calls exist: leave none for the down → up suites.
  await truncateAll();
  await stopLoadApp(loaded);
});

describe('a route’s life', () => {
  it('creates with its numbers, reads, lists, changes, and deletes, auditing each write with ids only', async () => {
    const created = await createRoute(sup(), {
      name: 'Main line',
      weekly_hours: [{ day: 1, start: '09:00', end: '17:30' }, { day: 5, start: '22:00', end: '02:00' }],
      holidays: [{ from: '2026-12-25', to: '2026-12-26', label: 'Christmas' }],
      clips: { greeting: clipA },
      analysis_profile_id: profileA,
      pool_campaign_ids: [floor.campaigns[0]],
      phone_number_ids: [numbers.linked1],
    });
    expect(created).toMatchObject({
      name: 'Main line', timezone: 'Europe/London', sticky_mode: 'loose', sticky_wait_seconds: 30, sticky_lookback_days: 30,
      queue_max_wait_seconds: 120, max_waiting: 10, max_concurrent: 20, after_hours_action: 'callback', overflow_action: 'callback',
      record_calls: false, recording_notice: true, analysis_profile_id: profileA, pool_campaign_ids: [floor.campaigns[0]],
      clips: { greeting: clipA, hold: null, closed: null, busy: null, recording_notice: null, callback: null },
      weekly_hours: [{ day: 1, start: '09:00', end: '17:30' }, { day: 5, start: '22:00', end: '02:00' }],
      holidays: [{ from: '2026-12-25', to: '2026-12-26', label: 'Christmas' }],
    });
    expect(created.numbers.map((n) => n.phone_number_id)).toEqual([numbers.linked1]);
    const [createdRow] = await audits('agency_inbound_route.created', created.id);
    expect(createdRow).toMatchObject({ user_id: sup().id, account_id: floor.account, details: { numbers_added: [numbers.linked1] } });

    const read = await call('GET', `/routes/${created.id}`, sup());
    expect(read.statusCode).toBe(200);
    expect(read.json().route).toEqual(created);
    const list = await call('GET', '/routes', sup());
    expect(list.json().routes.map((r: { id: string }) => r.id)).toContain(created.id);

    const changed = await call('PATCH', `/routes/${created.id}`, sup(), {
      name: 'Main line (UK)', sticky_mode: 'strict', phone_number_ids: [numbers.linked2],
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().route).toMatchObject({ name: 'Main line (UK)', sticky_mode: 'strict', clips: { greeting: clipA } });
    expect(await liveNumbersOf(created.id)).toEqual([numbers.linked2]);
    const [updatedRow] = await audits('agency_inbound_route.updated', created.id);
    expect(updatedRow!.details).toEqual({ fields: ['name', 'sticky_mode'], numbers_added: [numbers.linked2], numbers_removed: [numbers.linked1] });

    // The same values again: nothing changes, nothing is audited.
    const same = await call('PATCH', `/routes/${created.id}`, sup(), { name: 'Main line (UK)', phone_number_ids: [numbers.linked2] });
    expect(same.statusCode).toBe(200);
    expect(await audits('agency_inbound_route.updated', created.id)).toHaveLength(1);

    const deleted = await call('DELETE', `/routes/${created.id}`, sup());
    expect(deleted.statusCode).toBe(204);
    expect(await liveNumbersOf(created.id)).toEqual([]);
    expect((await call('GET', `/routes/${created.id}`, sup())).json()).toMatchObject({ code: 'inbound_route_not_found' });
    expect((await call('DELETE', `/routes/${created.id}`, sup())).statusCode).toBe(404);
    const [deletedRow] = await audits('agency_inbound_route.deleted', created.id);
    expect(deletedRow!.details).toEqual({ numbers_removed: [numbers.linked2] });
    // A deleted route frees its name.
    const again = await createRoute(sup(), { name: 'MAIN LINE (uk)' });
    await call('DELETE', `/routes/${again.id}`, sup());
  });
});

describe('validation', () => {
  it('answers every shape problem at its path', async () => {
    const res = await call('POST', '/routes', sup(), {
      name: '', timezone: 'EST', weekly_hours: [{ day: 8, start: '09:00', end: '09:00' }], max_waiting: 30, max_concurrent: 5, extra: 1,
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.code).toBe('inbound_route_invalid');
    const paths = body.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'timezone', 'weekly_hours[0].day', '']));
  });

  it('takes voicemail (P2), on create and on a PATCH, and says what a route without its recordings will do (advisory, never a refusal)', async () => {
    const res = await call('POST', '/routes', sup(), { name: 'VM', timezone: 'UTC', overflow_action: 'voicemail' });
    expect(res.statusCode, res.body).toBe(201);
    const created = res.json().route;
    expect(created.overflow_action).toBe('voicemail');
    // No recordings: a waiting caller hears only the beep before their voicemail (agents are
    // connected in one process), and withheld callers too.
    expect(created.warnings.map((w: { code: string; path: string }) => `${w.code}@${w.path}`))
      .toEqual(['voicemail_beep_only@clips.callback', 'voicemail_beep_only@clips.closed']);
    expect(created.warnings[0].message).toMatch(/Choose a recording for “We’ll call you back”/);
    const patch = await call('PATCH', `/routes/${created.id}`, sup(), { after_hours_action: 'voicemail', overflow_action: 'callback', clips: { callback: clipA } });
    expect(patch.statusCode, patch.body).toBe(200);
    expect(patch.json().route.warnings.map((w: { code: string; path: string }) => `${w.code}@${w.path}`))
      .toEqual(['overflow_message_silent@clips.closed', 'voicemail_needs_prompt@clips.closed']);
    // Every read carries them.
    const read = await call('GET', `/routes/${created.id}`, sup());
    expect(read.json().route.warnings).toHaveLength(2);
    const listed = (await call('GET', '/routes', sup())).json().routes.find((r: { id: string }) => r.id === created.id);
    expect(listed.warnings).toHaveLength(2);
    await call('DELETE', `/routes/${created.id}`, sup());
  });

  it('takes only the account’s own clips, profile and pool campaigns', async () => {
    const res = await call('POST', '/routes', sup(), {
      name: 'Borrowed', timezone: 'UTC', clips: { greeting: clipB, hold: randomUUID() }, analysis_profile_id: profileB,
      pool_campaign_ids: [floor.campaigns[0], other.campaigns[0]],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().details.map((d: { path: string }) => d.path).sort())
      .toEqual(['analysis_profile_id', 'clips.greeting', 'clips.hold', 'pool_campaign_ids[1]']);
    expect((await q(`SELECT 1 FROM agency_inbound_routes WHERE name = 'Borrowed'`)).rowCount).toBe(0);
  });

  it('judges a PATCH as the route it makes, and checks only the references it sets', async () => {
    const route = await createRoute(sup(), { name: 'Cross', max_waiting: 10, max_concurrent: 20 });
    const res = await call('PATCH', `/routes/${route.id}`, sup(), { max_concurrent: 5 });
    expect(res.statusCode).toBe(400);
    expect(res.json().details).toEqual([{ path: 'max_waiting', message: expect.any(String) }]);
    // A profile that went inactive after it was set does not block an unrelated change.
    const p = (await q(`INSERT INTO call_analysis_profiles (tenant_id, account_id, name, is_active) VALUES ($1, $2, 'Old', true) RETURNING id`,
      [floor.tenant, floor.account])).rows[0]!.id as string;
    expect((await call('PATCH', `/routes/${route.id}`, sup(), { analysis_profile_id: p })).statusCode).toBe(200);
    await q('UPDATE call_analysis_profiles SET is_active = false WHERE id = $1', [p]);
    expect((await call('PATCH', `/routes/${route.id}`, sup(), { max_concurrent: 15 })).statusCode).toBe(200);
    expect((await call('PATCH', `/routes/${route.id}`, sup(), { analysis_profile_id: p })).json().details[0].path).toBe('analysis_profile_id');
    await call('DELETE', `/routes/${route.id}`, sup());
  });

  it('two PATCHes that are each valid but together break a cross-field rule: the second is judged on the first', async () => {
    const route = await createRoute(sup(), { name: 'Racing', max_waiting: 10, max_concurrent: 60 });
    // Hold the route row, so both PATCHes are in flight before either reads it.
    const holder = await getTestPool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM agency_inbound_routes WHERE id = $1 FOR UPDATE', [route.id]);
      const raising = call('PATCH', `/routes/${route.id}`, sup(), { max_waiting: 50 });
      await new Promise((r) => setTimeout(r, 150));
      const lowering = call('PATCH', `/routes/${route.id}`, sup(), { max_concurrent: 40 });
      await new Promise((r) => setTimeout(r, 150));
      await holder.query('COMMIT');
      const [a, b] = await Promise.all([raising, lowering]);
      expect([a.statusCode, b.statusCode]).toEqual([200, 400]);
      expect(b.json().details).toEqual([{ path: 'max_waiting', message: expect.any(String) }]);
    } finally {
      holder.release();
    }
    const stored = (await call('GET', `/routes/${route.id}`, sup())).json().route;
    expect(stored).toMatchObject({ max_waiting: 50, max_concurrent: 60 });
    await call('DELETE', `/routes/${route.id}`, sup());
  });

  it('one live name per account, case-insensitive; another account may use it', async () => {
    const first = await createRoute(sup(), { name: 'Sales' });
    const dup = await call('POST', '/routes', sup(), { name: 'SALES', timezone: 'UTC' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().code).toBe('inbound_route_name_taken');
    const second = await createRoute(sup(), { name: 'Support' });
    const rename = await call('PATCH', `/routes/${second.id}`, sup(), { name: 'sales', phone_number_ids: [numbers.linked3] });
    expect(rename.json().code).toBe('inbound_route_name_taken');
    // The refused rename took its number change with it.
    expect(await liveNumbersOf(second.id)).toEqual([]);
    const inB = await createRoute(supB, { name: 'Sales' }, { account: accountB });
    for (const id of [first.id, second.id]) await call('DELETE', `/routes/${id}`, sup());
    await call('DELETE', `/routes/${inB.id}`, supB, undefined, { account: accountB });
  });
});

describe('numbers', () => {
  it('refuses an unlinked number, another account’s, and one on another route, writing nothing', async () => {
    const unlinked = await call('POST', '/routes', sup(), { name: 'U', timezone: 'UTC', phone_number_ids: [numbers.linked1, numbers.unlinked] });
    expect(unlinked.statusCode).toBe(409);
    expect(unlinked.json()).toMatchObject({ code: 'inbound_number_not_linked', phone_number_id: numbers.unlinked });
    // All or nothing: no route, no attachment.
    expect((await q(`SELECT 1 FROM agency_inbound_routes WHERE name = 'U' AND deleted_at IS NULL`)).rowCount).toBe(0);
    expect((await q('SELECT 1 FROM agency_inbound_route_numbers WHERE phone_number_id = $1 AND detached_at IS NULL', [numbers.linked1])).rowCount).toBe(0);

    const tagged = await call('POST', '/routes', sup(), { name: 'T', timezone: 'UTC', phone_number_ids: [numbers.onlyB] });
    expect(tagged.json()).toMatchObject({ code: 'inbound_number_not_found', phone_number_id: numbers.onlyB });

    const holder = await createRoute(sup(), { name: 'Holder', phone_number_ids: [numbers.linked1] });
    const clash = await call('POST', '/routes', sup(), { name: 'Clash', timezone: 'UTC', phone_number_ids: [numbers.linked1] });
    expect(clash.json()).toEqual(expect.objectContaining({ code: 'inbound_number_in_use', phone_number_id: numbers.linked1, route_id: holder.id }));

    // Held by another account's route (an untagged number is shared): not named.
    const south = await createRoute(supB, { name: 'South', phone_number_ids: [numbers.linked2] }, { account: accountB });
    const foreign = await call('POST', '/routes', sup(), { name: 'Foreign', timezone: 'UTC', phone_number_ids: [numbers.linked2] });
    expect(foreign.json().code).toBe('inbound_number_in_use');
    expect(foreign.json()).not.toHaveProperty('route_id');

    const options = await call('GET', '/numbers', sup());
    expect(options.statusCode).toBe(200);
    const byId = new Map(options.json().numbers.map((n: { phone_number_id: string }) => [n.phone_number_id, n]));
    expect(byId.get(numbers.linked1)).toMatchObject({ linked: true, route_id: holder.id, route_name: 'Holder', held_elsewhere: false });
    expect(byId.get(numbers.linked2)).toMatchObject({ linked: true, route_id: null, route_name: null, held_elsewhere: true });
    expect(byId.get(numbers.linked3)).toMatchObject({ linked: true, route_id: null, held_elsewhere: false });
    expect(byId.get(numbers.unlinked)).toMatchObject({ linked: false });
    expect(byId.has(numbers.onlyB)).toBe(false);
    const optionsB = await call('GET', '/numbers', supB, undefined, { account: accountB });
    expect(optionsB.json().numbers.find((n: { phone_number_id: string }) => n.phone_number_id === numbers.onlyB)).toBeTruthy();
    expect(optionsB.json().numbers.find((n: { phone_number_id: string }) => n.phone_number_id === numbers.linked2))
      .toMatchObject({ route_id: south.id, route_name: 'South', held_elsewhere: false });

    await call('DELETE', `/routes/${holder.id}`, sup());
    await call('DELETE', `/routes/${south.id}`, supB, undefined, { account: accountB });
  });

  it('lists only the account’s own audio files as clips', async () => {
    const res = await call('GET', '/clips', sup());
    expect(res.statusCode).toBe(200);
    expect(res.json().clips).toEqual([{ id: clipA, name: 'Welcome', duration_seconds: 4.5 }]);
  });
});

describe('access', () => {
  it('an agent cannot reach the routes; the flag off refuses everyone; another account or tenant reads nothing', async () => {
    const route = await createRoute(sup(), { name: 'Private' });
    for (const [method, url] of [['GET', '/routes'], ['GET', `/routes/${route.id}`], ['GET', '/numbers'], ['GET', '/clips'], ['DELETE', `/routes/${route.id}`]] as const) {
      const res = await call(method, url, agent(0));
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().message).toMatch(/^Insufficient permissions/);
    }
    expect((await call('POST', '/routes', agent(0), { name: 'X', timezone: 'UTC' })).statusCode).toBe(403);

    // Account B's supervisor and the other tenant's see none of account A's.
    expect((await call('GET', `/routes/${route.id}`, supB, undefined, { account: accountB })).statusCode).toBe(404);
    expect((await call('GET', '/routes', supB, undefined, { account: accountB })).json().routes
      .some((r: { id: string }) => r.id === route.id)).toBe(false);
    expect((await call('PATCH', `/routes/${route.id}`, other.supervisors[0]!, { name: 'Mine' }, { f: other })).statusCode).toBe(404);
    expect((await call('DELETE', `/routes/${route.id}`, other.supervisors[0]!, undefined, { f: other })).statusCode).toBe(404);
    expect((await call('GET', `/routes/${route.id}`, sup())).json().route.name).toBe('Private');

    // A malformed id is the family's not-found, never a 500.
    expect((await call('GET', '/routes/not-a-uuid', sup())).json()).toMatchObject({ code: 'inbound_route_not_found' });
    expect((await call('POST', '/missed/not-a-uuid/handled', sup())).json()).toMatchObject({ code: 'inbound_missed_call_not_found' });

    await setFlag(floor.tenant, false, floor.account);
    try {
      for (const [actor, method, url] of [[sup(), 'GET', '/routes'], [sup(), 'GET', '/missed'], [agent(0), 'GET', '/missed']] as const) {
        const res = await call(method, url, actor);
        expect(res.statusCode).toBe(403);
        expect(res.json()).toMatchObject({ code: 'inbound_disabled' });
      }
      // The flag is per account: account B's still answers.
      expect((await call('GET', '/routes', supB, undefined, { account: accountB })).statusCode).toBe(200);
    } finally {
      await q(`DELETE FROM feature_flag_overrides WHERE flag_key = 'agency_inbound_enabled' AND account_id = $1`, [floor.account]);
      await getFeatureFlagService().invalidate({ tenantId: floor.tenant });
    }
    await call('DELETE', `/routes/${route.id}`, sup());
  });
});

describe('the Missed inbound list and Mark handled', () => {
  const DAY = 86_400_000;
  const T0 = Date.now() - 20 * DAY;
  const at = (days: number) => new Date(T0 + days * DAY);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    ids['a0old'] = await missed({ assignee: agent(0).id, at: at(1), reason: 'closed' });
    ids['a0new'] = await missed({ assignee: agent(0).id, at: at(5), reason: 'overflow', dnc: true });
    ids['a1'] = await missed({ assignee: agent(1).id, at: at(3), reason: 'abandoned_in_queue' });
    ids['none1'] = await missed({ assignee: null, at: at(2), reason: 'closed', from: null });
    ids['none2'] = await missed({ assignee: null, at: at(4), reason: 'closed' });
    ids['inB'] = await missed({ account: accountB, assignee: null, at: at(2) });
    ids['otherTenant'] = await missed({ tenant: other.tenant, account: other.account, assignee: null, at: at(2) });
  });

  const idsOf = (res: { json: () => { rows: Array<{ id: string }> } }) => res.json().rows.map((r) => r.id);

  it('an agent sees only their own rows, whatever they ask for', async () => {
    for (const query of ['', '?assignee=unassigned', `?assignee=${agent(1).id}`, '?assignee=me']) {
      const res = await call('GET', `/missed${query}`, agent(0));
      expect(res.statusCode, res.body).toBe(200);
      expect(idsOf(res), query).toEqual([ids['a0new'], ids['a0old']]);
    }
    const row = (await call('GET', '/missed', agent(0))).json().rows[0];
    expect(row).toMatchObject({
      id: ids['a0new'], account_id: floor.account, reason: 'overflow', outcome: 'overflow', status: 'open', caller_dnc: true,
      from_e164: '+447700900123', to_e164: '+14155550100', assignee_user_id: agent(0).id, assignee_name: 'agent 0.0',
      handled_by_user_id: null, handled_by_name: null, handled_at: null, has_voicemail: false, callback_due_at: null,
    });
  });

  it('a supervisor sees the account’s, with every filter and keyset paging', async () => {
    expect(idsOf(await call('GET', '/missed', sup()))).toEqual([ids['a0new'], ids['none2'], ids['a1'], ids['none1'], ids['a0old']]);
    expect(idsOf(await call('GET', '/missed?assignee=unassigned', sup()))).toEqual([ids['none2'], ids['none1']]);
    expect(idsOf(await call('GET', `/missed?assignee=${agent(1).id}`, sup()))).toEqual([ids['a1']]);
    expect(idsOf(await call('GET', '/missed?assignee=me', sup()))).toEqual([]);
    expect(idsOf(await call('GET', '/missed?reason=closed', sup()))).toEqual([ids['none2'], ids['none1'], ids['a0old']]);
    const range = `?from=${encodeURIComponent(at(2).toISOString())}&to=${encodeURIComponent(at(4).toISOString())}`;
    expect(idsOf(await call('GET', `/missed${range}`, sup()))).toEqual([ids['a1'], ids['none1']]);
    expect((await call('GET', '/missed?status=nope', sup())).statusCode).toBe(400);
    expect((await call('GET', '/missed?cursor=garbage', sup())).statusCode).toBe(400);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const res = await call('GET', `/missed?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, sup());
      seen.push(...idsOf(res));
      cursor = res.json().next_cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual([ids['a0new'], ids['none2'], ids['a1'], ids['none1'], ids['a0old']]);
    // Never another account's or tenant's.
    expect(seen).not.toContain(ids['inB']);
    expect(idsOf(await call('GET', '/missed', supB, undefined, { account: accountB }))).toEqual([ids['inB']]);
  });

  it('Mark handled: an agent their own rows only, idempotent with the first handler kept, audited once', async () => {
    expect((await call('POST', `/missed/${ids['a1']}/handled`, agent(0))).statusCode).toBe(404);
    expect((await call('POST', `/missed/${ids['none1']}/handled`, agent(0))).statusCode).toBe(404);

    const first = await call('POST', `/missed/${ids['a0old']}/handled`, agent(0));
    expect(first.statusCode, first.body).toBe(200);
    const call1 = first.json().call;
    expect(call1).toMatchObject({ id: ids['a0old'], status: 'handled', handled_by_user_id: agent(0).id, handled_by_name: 'agent 0.0' });

    const again = await call('POST', `/missed/${ids['a0old']}/handled`, sup());
    expect(again.statusCode).toBe(200);
    expect(again.json().call).toMatchObject({ handled_by_user_id: agent(0).id, handled_at: call1.handled_at });
    const rows = await audits('agency_inbound_call.handled', ids['a0old']!);
    expect(rows).toEqual([expect.objectContaining({ user_id: agent(0).id, account_id: floor.account, details: { reason: 'closed' } })]);

    expect(idsOf(await call('GET', '/missed', agent(0)))).toEqual([ids['a0new']]);
    expect(idsOf(await call('GET', '/missed?status=handled', agent(0)))).toEqual([ids['a0old']]);

    // A supervisor marks any row of the account; never another account's or tenant's.
    expect((await call('POST', `/missed/${ids['none1']}/handled`, sup())).json().call.handled_by_name).toBe('account_admin 0.0');
    expect((await call('POST', `/missed/${ids['inB']}/handled`, sup())).statusCode).toBe(404);
    expect((await call('POST', `/missed/${ids['otherTenant']}/handled`, sup())).statusCode).toBe(404);
  });
});

describe('a Missed row`s voicemail (P2, §7): GET /proxy/agency/inbound/missed/:id/voicemail', () => {
  const vm = (tenant: string, account: string) => ({ key: (id: string) => `inbound-voicemail/${tenant}/${account}/${id}.wav`, seconds: 3 });
  const wav = (n: number) => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(n - 4, 7)]);
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    const at = new Date(Date.now() - 86_400_000);
    ids['mine'] = await missed({ assignee: agent(0).id, at, voicemail: vm(floor.tenant, floor.account) });
    ids['theirs'] = await missed({ assignee: agent(1).id, at, voicemail: vm(floor.tenant, floor.account) });
    ids['none'] = await missed({ assignee: agent(0).id, at });
    ids['inB'] = await missed({ account: accountB, assignee: null, at, voicemail: vm(floor.tenant, accountB) });
    ids['gone'] = await missed({ assignee: null, at, voicemail: vm(floor.tenant, floor.account) });
    for (const k of ['mine', 'theirs', 'inB']) {
      const account = k === 'inB' ? accountB : floor.account;
      bucket.files.set(`inbound-voicemail/${floor.tenant}/${account}/${ids[k]}.wav`, wav(1000));
    }
  });

  it('names it on the Missed row (`voicemail_url`, relative to the proxy) only when there is one', async () => {
    const rows = (await call('GET', '/missed', agent(0))).json().rows as Array<Record<string, unknown>>;
    expect(rows.find((r) => r['id'] === ids['mine'])).toMatchObject({ has_voicemail: true, voicemail_url: `/inbound/missed/${ids['mine']}/voicemail`, outcome: 'voicemail' });
    expect(rows.find((r) => r['id'] === ids['none'])).not.toHaveProperty('voicemail_url');
  });

  it('streams it, audio/wav, whole or by range, to the agent it is assigned to and to a supervisor', async () => {
    for (const actor of [agent(0), sup()]) {
      const res = await call('GET', `/missed/${ids['mine']}/voicemail`, actor);
      expect(res.statusCode, res.body).toBe(200);
      expect(res.headers['content-type']).toBe('audio/wav');
      expect(res.headers['content-length']).toBe('1000');
      expect(res.headers['accept-ranges']).toBe('bytes');
      expect(res.rawPayload.length).toBe(1000);
      expect(res.rawPayload.subarray(0, 4).toString()).toBe('RIFF');
    }
    const part = await loaded.app.inject({
      method: 'GET', url: `/proxy/agency/inbound/missed/${ids['mine']}/voicemail`, headers: headersFor(sup(), floor, { range: 'bytes=10-19' }),
    });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 10-19/1000');
    expect(part.rawPayload.length).toBe(10);
    // No automatic HEAD: Fastify's would run the handler and open a bucket stream for nothing.
    const head = await loaded.app.inject({
      method: 'HEAD', url: `/proxy/agency/inbound/missed/${ids['mine']}/voicemail`, headers: headersFor(sup(), floor),
    });
    expect(head.statusCode).toBe(404);
  });

  it('the Missed list`s rules: another agent`s row, a row with none, another account`s or tenant`s, an object aged out, a malformed id: inbound_missed_call_not_found', async () => {
    const notFound = async (path: string, actor: Actor, opts: { account?: string; f?: TenantFloor } = {}) => {
      const res = await call('GET', path, actor, undefined, opts);
      expect(res.statusCode, `${path} ${res.body}`).toBe(404);
      expect(res.json()).toMatchObject({ code: 'inbound_missed_call_not_found' });
    };
    await notFound(`/missed/${ids['theirs']}/voicemail`, agent(0));
    await notFound(`/missed/${ids['none']}/voicemail`, sup());
    await notFound(`/missed/${ids['inB']}/voicemail`, sup());
    await notFound(`/missed/${ids['mine']}/voicemail`, other.supervisors[0]!, { f: other });
    await notFound(`/missed/${ids['gone']}/voicemail`, sup());
    await notFound('/missed/not-a-uuid/voicemail', sup());
    // Account B's own supervisor plays it.
    expect((await call('GET', `/missed/${ids['inB']}/voicemail`, supB, undefined, { account: accountB })).statusCode).toBe(200);
  });

  it('the permission and the flag guard it like the list', async () => {
    await setFlag(floor.tenant, false, floor.account);
    try {
      const res = await call('GET', `/missed/${ids['mine']}/voicemail`, agent(0));
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: 'inbound_disabled' });
    } finally {
      await q(`DELETE FROM feature_flag_overrides WHERE flag_key = 'agency_inbound_enabled' AND account_id = $1`, [floor.account]);
      await getFeatureFlagService().invalidate({ tenantId: floor.tenant });
    }
  });
});
