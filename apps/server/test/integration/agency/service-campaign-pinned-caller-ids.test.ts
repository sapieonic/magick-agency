import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgencyContact } from './agency-factories.js';

/**
 * ─── CR9 whatever path made the campaign: the service account never dials a tenant's number ─
 *
 * docs/carriers.md CR6 and CR9 against a real Postgres, through the real campaign routes. A
 * VoiceLink number on the service's own account can move once onto a tenant's VoiceLink account
 * (`phoneNumberRepository.pinToCredential`, CR6), and the move is refused only while an
 * UNFINISHED service-account campaign holds it. So a finished one may still hold it, and so may a
 * campaign written beside the move. Here:
 *  - a retry of a stopped service campaign whose number moved since is refused at the write,
 *    with the inherited caller ID named (`judgeAllServiceCallerIds`), no override needed;
 *  - a service campaign that still holds a pinned number never dials it: its dial pool drops it
 *    (`dialableCallerIds`), start refuses `campaign_caller_ids_unavailable` when nothing is left,
 *    and the stats strip names it while running;
 *  - a move clears the dial-pool cache of every campaign, the service's own included;
 *  - the write race: a campaign create, PATCH or retry adding a number as it is moved either
 *    sees the move (it committed first; the write waits on the number's row and refuses) or is
 *    seen by it (the move waits and answers `in_use`), never both committed;
 *  - a caller-ID edit of a campaign stored on a carrier the catalogue does not know is not
 *    refused for its carrier account (it is not being set), while CR9 still applies.
 *
 * VoiceLink takes both modes here by a catalogue double (`test/helpers/carrier-catalog-double.ts`).
 * The move is the repository call the super-admin route makes, then the route's clear
 * (`invalidateDialableCallerIds`); that the route clears is
 * `test/integration/api/super-admin-phone-numbers.routes.test.ts`.
 */

const carriers = vi.hoisted(() => ({ voicelink: { accounts: { service: true, tenant: true } } }));
vi.mock('../../../src/telephony/carrier-catalog.js', async (importOriginal) =>
  (await import('../../helpers/carrier-catalog-double.js')).catalogDouble(await importOriginal(), carriers));

vi.mock('@magick-agency/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('@magick-agency/db/connection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/db/connection')>()),
  getPool: () => getTestPool(),
}));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/audit/audit-logger.js', () => ({ auditLogger: { log: vi.fn() } }));
const { flags } = vi.hoisted(() => ({ flags: { isEnabled: vi.fn().mockResolvedValue(true) } }));
vi.mock('../../../src/feature-flags/index.js', () => ({
  getFeatureFlagService: () => flags,
  FLAGS: { agency_dialer_enabled: { key: 'agency_dialer_enabled', type: 'boolean' } },
}));

const { agencyCampaignRoutes } = await import('../../../src/api/routes/agency-campaigns.routes.js');
const { phoneNumberRepository } = await import('@magick-agency/db/repositories/phone-number.repository');
const { dialableCallerIds, invalidateDialableCallerIds } = await import('../../../src/agency/campaign-dialability.js');
type AgencyCampaignRouteDeps = import('../../../src/api/routes/agency-campaigns.routes.js').AgencyCampaignRouteDeps;

const TENANT = DEFAULTS.tenantId;
const ACCOUNT = DEFAULTS.accountId;
const HEADERS = { 'x-mgkvc-tenant': TENANT, 'x-mgkvc-account': ACCOUNT };
/** On the service's own account until a test moves it. */
const MOVED = '+919000000011';
/** Stays on the service's own account. */
const KEPT = '+919000000012';

let app: FastifyInstance;
let credT: string;
let voicelinkId: string;
const numberIds = new Map<string, string>();

const pool = () => getTestPool();

async function insertServiceNumber(phone: string): Promise<void> {
  const { rows } = await (await pool()).query<{ id: string }>(
    `INSERT INTO phone_numbers (phone_number, provider_id) VALUES ($1, $2) RETURNING id`, [phone, voicelinkId]);
  numberIds.set(phone, rows[0]!.id);
  await (await pool()).query(`INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id) VALUES ($1, $2)`, [TENANT, rows[0]!.id]);
}

/** The super-admin move (CR6): the repository write, then the route's cache clear. */
async function move(phone: string): Promise<Awaited<ReturnType<typeof phoneNumberRepository.pinToCredential>>> {
  const result = await phoneNumberRepository.pinToCredential(numberIds.get(phone)!, credT, null);
  if (result.ok) invalidateDialableCallerIds();
  return result;
}

const create = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/api/v1/agency-campaigns', headers: HEADERS, payload: { name: 'C', ...payload } });
const patch = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/api/v1/agency-campaigns/${id}`, headers: HEADERS, payload });
const post = (id: string, verb: string, payload: Record<string, unknown> = {}) =>
  app.inject({ method: 'POST', url: `/api/v1/agency-campaigns/${id}/${verb}`, headers: HEADERS, payload });
const campaignCount = async () => (await (await pool()).query('SELECT 1 FROM agency_campaigns')).rows.length;

/** A transaction on a client of its own, left open until the test commits it. */
async function openTransaction(): Promise<PoolClient> {
  const client = await (await pool()).connect();
  await client.query('BEGIN');
  return client;
}

/** End a held transaction however the test went (a no-op after its COMMIT), and give the client back. */
async function done(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK').catch(() => undefined);
  client.release();
}

/** Wait until some statement of this database waits on a lock (the other side has blocked). */
async function untilSomeoneWaits(): Promise<void> {
  await vi.waitFor(async () => {
    const { rows } = await (await pool()).query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`);
    expect(rows[0]!.n).toBeGreaterThan(0);
  }, { timeout: 5000, interval: 20 });
}

/** What the move does in its transaction, held open: the number's row locked and pinned. */
async function moveHeldOpen(phone: string): Promise<PoolClient> {
  const client = await openTransaction();
  await client.query(`SELECT 1 FROM telephony_credentials WHERE id = $1 FOR NO KEY UPDATE`, [credT]);
  await client.query(`SELECT 1 FROM phone_numbers WHERE id = $1 FOR UPDATE`, [numberIds.get(phone)]);
  await client.query(`UPDATE phone_numbers SET telephony_credential_id = $2 WHERE id = $1`, [numberIds.get(phone), credT]);
  return client;
}

beforeEach(async () => {
  await truncateAll();
  flags.isEnabled.mockResolvedValue(true);
  numberIds.clear();
  const { rows } = await (await pool()).query<{ id: string }>(
    `INSERT INTO telephony_providers (name, display_name, status) VALUES ('voicelink', 'VoiceLink', 'active') RETURNING id`);
  voicelinkId = rows[0]!.id;
  await (await pool()).query(`INSERT INTO tenants (id, name, slug) VALUES ($1, $2, $2)`, [TENANT, `t-${randomUUID().slice(0, 8)}`]);
  const cred = await (await pool()).query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'voicelink', 'Own line', $2) RETURNING id`,
    [TENANT, `acct-${randomUUID().slice(0, 12)}`]);
  credT = cred.rows[0]!.id;
  await insertServiceNumber(MOVED);
  await insertServiceNumber(KEPT);
  invalidateDialableCallerIds();
  app = Fastify({ logger: false });
  await app.register(async (scope) => agencyCampaignRoutes(scope, {} as AgencyCampaignRouteDeps), { prefix: '/api/v1/agency-campaigns' });
  await app.ready();
});

afterEach(async () => {
  await app?.close();
});

afterAll(closeTestPool);

describe('a retry inherits no number moved onto a tenant`s account since its parent was written (CR9)', () => {
  it('stopped service campaign, number moved, retry with no overrides: refused at the write naming it, nothing created', async () => {
    const parent = await insertAgencyCampaign({ caller_ids: [MOVED], status: 'stopped' });
    await insertAgencyContact(parent.id);
    // The move is allowed: a stopped campaign is finished (CR6 refuses only while an unfinished one holds it).
    expect((await move(MOVED)).ok).toBe(true);

    const before = await campaignCount();
    const res = await post(parent.id, 'retry', { selector: { state: ['pending'] } });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().details.caller_ids).toBe(
      `a campaign on the service’s own carrier account cannot use a number of an organisation’s own carrier account; not: ${MOVED}`,
    );
    expect(await campaignCount()).toBe(before);

    // An override that keeps it is refused too; one that leaves it out is created.
    const kept = await post(parent.id, 'retry', { selector: { state: ['pending'] }, config_overrides: { caller_ids: [KEPT, MOVED] } });
    expect(kept.statusCode).toBe(400);
    expect(kept.json().details.caller_ids).toContain(MOVED);
    expect(kept.json().details.caller_ids).not.toContain(KEPT);
    const replaced = await post(parent.id, 'retry', { selector: { state: ['pending'] }, config_overrides: { caller_ids: [KEPT] } });
    expect(replaced.statusCode, replaced.body).toBe(201);
    expect(replaced.json().campaign).toMatchObject({ telephony_credential_id: null, caller_ids: [KEPT] });
  });

  it('a retry of a service campaign whose numbers did not move inherits them as before', async () => {
    const parent = await insertAgencyCampaign({ caller_ids: [MOVED, KEPT], status: 'stopped' });
    await insertAgencyContact(parent.id);
    const res = await post(parent.id, 'retry', { selector: { state: ['pending'] } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().campaign.caller_ids).toEqual([MOVED, KEPT]);
  });
});

describe('a service campaign that still holds a pinned number never dials it (CR9 at the dial)', () => {
  it('the dial pool drops it; start refuses when nothing else is left, and starts once a service number is back', async () => {
    // Written before the move (a direct write stands in for a campaign saved before CR9, or beside a move).
    const both = await insertAgencyCampaign({ caller_ids: [MOVED, KEPT], status: 'stopped' });
    const only = await insertAgencyCampaign({ caller_ids: [MOVED], status: 'stopped' });
    expect((await move(MOVED)).ok).toBe(true);
    await (await pool()).query(`UPDATE agency_campaigns SET status = 'draft' WHERE id = ANY($1::uuid[])`, [[both.id, only.id]]);
    await insertAgencyContact(both.id);
    await insertAgencyContact(only.id);

    expect(await dialableCallerIds({ ...both, caller_ids: [MOVED, KEPT] })).toEqual([KEPT]);
    expect(await dialableCallerIds({ ...only, caller_ids: [MOVED] })).toEqual([]);

    const refused = await post(only.id, 'start');
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'campaign_caller_ids_unavailable' });
    expect(refused.json().message).not.toMatch(/plivo|voicelink/i);
    const started = await post(both.id, 'start');
    expect(started.statusCode, started.body).toBe(200);

    // The supervisor replaces the pool with a service number: it starts.
    expect((await patch(only.id, { caller_ids: [KEPT] })).statusCode).toBe(200);
    expect((await post(only.id, 'start')).statusCode).toBe(200);
  });

  it('the stats strip names a running service campaign left with no dialable caller ID', async () => {
    const campaign = await insertAgencyCampaign({ caller_ids: [MOVED], status: 'stopped' });
    expect((await move(MOVED)).ok).toBe(true);
    await (await pool()).query(`UPDATE agency_campaigns SET status = 'running' WHERE id = $1`, [campaign.id]);
    const res = await app.inject({ method: 'GET', url: `/api/v1/agency-campaigns/${campaign.id}/stats`, headers: HEADERS });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().stall).toEqual({ code: 'no_dialable_caller_ids', caller_ids_stored: 1 });
  });

  it('a move clears every campaign`s cached pool, a service campaign`s included: the next dial has it gone', async () => {
    const campaign = await insertAgencyCampaign({ caller_ids: [MOVED, KEPT], status: 'stopped' });
    const row = { ...campaign, caller_ids: [MOVED, KEPT] };
    expect(await dialableCallerIds(row)).toEqual([MOVED, KEPT]);
    // Pinned behind the cache's back (no clear): the cached pool still answers ...
    await (await pool()).query(`UPDATE phone_numbers SET telephony_credential_id = $2 WHERE phone_number = $1`, [KEPT, credT]);
    expect(await dialableCallerIds(row)).toEqual([MOVED, KEPT]);
    // ... and the move's clear drops both from the very next read.
    expect((await move(MOVED)).ok).toBe(true);
    expect(await dialableCallerIds(row)).toEqual([]);
  });
});

describe('a campaign write and a move of one of its numbers never both commit (CR9 under lock)', () => {
  it('create: the move commits while the create waits on the number`s row; the create is refused and writes nothing', async () => {
    const mover = await moveHeldOpen(MOVED);
    try {
      const pending = create({ caller_ids: [KEPT, MOVED] });
      await untilSomeoneWaits();
      await mover.query('COMMIT');
      const res = await pending;
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().details.caller_ids).toContain(MOVED);
      expect(res.json().details.caller_ids).not.toContain(KEPT);
      expect(await campaignCount()).toBe(0);
    } finally {
      await done(mover);
    }
  });

  it('PATCH: a caller-ID edit adding the number while it moves is refused', async () => {
    const campaign = await insertAgencyCampaign({ caller_ids: [KEPT] });
    const mover = await moveHeldOpen(MOVED);
    try {
      const pending = patch(campaign.id, { caller_ids: [KEPT, MOVED] });
      await untilSomeoneWaits();
      await mover.query('COMMIT');
      const res = await pending;
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().details.caller_ids).toContain(MOVED);
      const { rows } = await (await pool()).query('SELECT caller_ids FROM agency_campaigns WHERE id = $1', [campaign.id]);
      expect(rows[0]!.caller_ids).toEqual([KEPT]);
    } finally {
      await done(mover);
    }
  });

  it('retry (REPEATABLE READ): the move commits while the retry waits; the retry runs again, sees it and is refused', async () => {
    const parent = await insertAgencyCampaign({ caller_ids: [MOVED], status: 'stopped' });
    await insertAgencyContact(parent.id);
    const before = await campaignCount();
    const mover = await moveHeldOpen(MOVED);
    try {
      const pending = post(parent.id, 'retry', { selector: { state: ['pending'] } });
      await untilSomeoneWaits();
      await mover.query('COMMIT');
      const res = await pending;
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json().details.caller_ids).toContain(MOVED);
      expect(await campaignCount()).toBe(before);
    } finally {
      await done(mover);
    }
  });

  it('the write first: the move waits on the number`s row, then sees the campaign holding it and is refused `in_use`', async () => {
    // What a create's transaction does (`createLocked` over `lockPinnedAmong`), held open.
    const writer = await openTransaction();
    try {
      expect(await phoneNumberRepository.lockPinnedAmong(writer, [MOVED])).toEqual([]);
      await writer.query(
        `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids) VALUES ($1, $2, 'Racing', $3)`,
        [TENANT, ACCOUNT, [MOVED]]);
      const moving = phoneNumberRepository.pinToCredential(numberIds.get(MOVED)!, credT, null);
      await untilSomeoneWaits();
      await writer.query('COMMIT');
      expect(await moving).toMatchObject({ ok: false, reason: 'in_use', total: 1 });
      const { rows } = await (await pool()).query('SELECT telephony_credential_id FROM phone_numbers WHERE phone_number = $1', [MOVED]);
      expect(rows[0]!.telephony_credential_id).toBeNull();
    } finally {
      await done(writer);
    }
  });
});

describe('a caller-ID edit does not re-judge the carrier account the campaign is stored on (CR8)', () => {
  it('on a carrier the catalogue does not know, a caller-ID-only edit is accepted; adding a pinned number is still refused', async () => {
    const campaign = await insertAgencyCampaign({ telephony_provider: 'legacy-test-carrier', caller_ids: [KEPT] });
    const ok = await patch(campaign.id, { caller_ids: [KEPT, '+919000000013'] });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().caller_ids).toEqual([KEPT, '+919000000013']);

    expect((await move(MOVED)).ok).toBe(true);
    const refused = await patch(campaign.id, { caller_ids: [KEPT, MOVED] });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().details.caller_ids).toContain(MOVED);

    // Naming the carrier is setting it: judged on the mode.
    const named = await patch(campaign.id, { telephony_credential_id: null });
    expect(named.statusCode).toBe(400);
    expect(named.json().details).toEqual({ telephony_provider: 'must name a carrier this service can dial on' });
  });
});
