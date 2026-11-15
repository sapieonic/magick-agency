import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Promise to pay (decisions PT1–PT14) through the REAL app: `buildApp` with the agency runtime,
 * real Redis and Postgres, the real session → tenant → RBAC chain (Firebase's token check is the
 * one stub), the public `proxy-agency-agent.routes.ts` disposition and the internal handler
 * behind `callCore`, then the Contacts list, its CSV and the campaign PATCH.
 *
 * What it pins:
 *  1. **A promise alone never schedules a dial (PT3).** A promise entry with no follow-up leaves
 *     the contact where the entry's flags send it (a plain label: `completed`, no new
 *     `next_attempt_at`), with a `retry` the retry's delay decides, never the promised date.
 *  2. **The follow-up (PT2) is a callback:** the contact goes `pending` at the window opening of
 *     the promised day + N days in the customer's zone, deferred past a day with no window, and
 *     on a strict campaign the agent who took the promise owns it (CA4).
 *  3. **Validation (PT4, PT5, PT8):** a date before the customer's today (their zone, not UTC),
 *     past the bound, a bad amount, a missing date, a promise on another outcome: 400 with the
 *     code, nothing written.
 *  4. **Storage (PT1, PT6):** the attempt keeps every promise; the contact its latest; a replay
 *     corrects it; a later call's replaces it; an older call's replay never overwrites a newer.
 *  5. **State (PT7):** upcoming / due today / missed / followed up, the `?promise=` filter and
 *     the promise columns appended at the END of both CSV exports (PT12).
 *  6. **The catalogue (PT10):** a promise beside a callback time is refused at the PATCH.
 *
 * Mutation-checked (see docs/status.md, "Promise to pay"): making `promiseFollowUpAt` book the
 * promised date itself whatever the entry says reds case 1; dropping the past-date refusal
 * (`promiseDateRefusal`'s `ahead < 0`) reds the "yesterday in Kolkata" case.
 */

const mocks = vi.hoisted(() => {
  process.env['SUPER_ADMIN_JWT_SECRET'] = 'promise-routes-secret-0123456789';
  return { verifyIdToken: vi.fn() };
});

vi.mock('../../../src/auth/firebase.js', () => ({
  initFirebase: vi.fn(),
  verifyIdToken: mocks.verifyIdToken,
}));

import type { FastifyInstance } from 'fastify';
import { closePool, getPool, initDbPool } from '@magick-agency/db';
import { TEST_DB_URL, closeTestPool, getTestPool, truncateAll } from '../../../../../packages/db/test/helpers/test-db.js';
import {
  insertAccount,
  insertMembership,
  insertTenant,
  insertUser,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';
import { insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession } from '../agency/agency-factories.js';
import { config } from '../../../src/config/index.js';
import { buildApp } from '../../../src/app.js';
import type { AppContext } from '../../../src/app-context.js';
import { resetAgencyRuntimeForTests } from '../../../src/bootstrap/agency.js';
import { resetVoiceEngineForTests } from '../../../src/bootstrap/voice.js';
import { ATTEMPT_CSV_COLUMNS, CONTACT_CSV_COLUMNS } from '../../../src/agency/agency-spine.js';
import { AGENCY_PROMISE_MAX_DAYS_AHEAD } from '@magick-agency/contracts/agency';

const PTP = { code: 'ptp', label: 'Promised to pay', requires_promise: true };
const PTP_FOLLOW = { code: 'ptp_follow', label: 'Promised (follow up)', requires_promise: true, promise_follow_up_days: 2 };
const PTP_RETRY = { code: 'ptp_retry', label: 'Promised (retry)', requires_promise: true, retry: { delay_minutes: 60, max_attempts: 5 } };
const CATALOG = JSON.stringify([
  PTP, PTP_FOLLOW, PTP_RETRY,
  { code: 'reached', label: 'Reached', terminal: true },
  { code: 'callback', label: 'Call back', requires_datetime: true },
]);

let app: FastifyInstance;
let tenant: string;
let account: string;
let agent: { id: string; tok: string };
let supervisor: { id: string; tok: string };

async function user(role: string) {
  const u = await insertUser();
  await insertMembership({ user_id: u.id, tenant_id: tenant, account_id: account, role });
  return { id: u.id as string, tok: `tok:${u.firebase_uid as string}` };
}

function headers(who: { tok: string }) {
  return {
    authorization: `Bearer ${who.tok}`, 'x-tenant-id': tenant, 'x-account-id': account, 'content-type': 'application/json',
  };
}
const post = (url: string, who: { tok: string }, body: unknown) =>
  app.inject({ method: 'POST', url, headers: headers(who), payload: JSON.stringify(body) });
const get = (url: string, who: { tok: string }) => app.inject({ method: 'GET', url, headers: headers(who) });

/** The customer's calendar date `days` from now in `zone`, `YYYY-MM-DD`. */
function dayIn(zone: string, days: number, from = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(from.getTime() + days * 86_400_000));
  return parts;
}

interface Call { campaign: string; contact: string; attempt: string; session: string }

/** A campaign (strict by default) with one contact whose call ended bridged, parked for its write-up. */
async function parked(o: { campaign?: Record<string, unknown>; contact?: Record<string, unknown>; campaignId?: string; contactId?: string; createdAt?: Date } = {}): Promise<Call> {
  const campaign = o.campaignId ?? (await insertAgencyCampaign({
    status: 'running', disposition_catalog: CATALOG, tenant_id: tenant, account_id: account, ...o.campaign,
  })).id as string;
  const contact = o.contactId ?? (await insertAgencyContact(campaign, {
    tenant_id: tenant, account_id: account, state: 'connected', attempt_count: 1, last_outcome: 'connected', ...o.contact,
  })).id as string;
  if (o.contactId) await getTestPool().query(`UPDATE agency_contacts SET state = 'connected' WHERE id = $1`, [contact]);
  const { rows } = await getTestPool().query<{ id: string }>(
    `SELECT id FROM agency_agent_sessions WHERE agent_user_id = $1 AND left_at IS NULL`, [agent.id]);
  const session = rows[0]?.id ?? (await insertAgentSession(campaign, {
    tenant_id: tenant, account_id: account, agent_user_id: agent.id, state: 'wrapup',
  })).id as string;
  const n = await getTestPool().query<{ n: number }>('SELECT count(*)::int AS n FROM agency_call_attempts WHERE contact_id = $1', [contact]);
  const attempt = (await insertAgencyAttempt(campaign, contact, {
    tenant_id: tenant, account_id: account, state: 'ended', outcome: 'connected', attempt_number: n.rows[0]!.n + 1,
    reserved_agent_id: session, bridged_at: new Date(Date.now() - 60_000), ended_at: new Date(),
    ...(o.createdAt ? { created_at: o.createdAt } : {}),
  })).id as string;
  return { campaign, contact, attempt, session };
}

const dispose = (c: Call, body: Record<string, unknown>, who = agent) =>
  post(`/proxy/agency/attempts/${c.attempt}/disposition`, who, body);

async function contactRow(id: string) {
  const { rows } = await getTestPool().query(
    `SELECT state, next_attempt_at, assigned_user_id, last_disposition, promise_date::text AS promise_date, promise_amount,
            promise_due_from, promise_due_until, promise_call_at, promise_followed_up_at
       FROM agency_contacts WHERE id = $1`, [id]);
  return rows[0] as Record<string, unknown> & { next_attempt_at: Date };
}

async function attemptRow(id: string) {
  const { rows } = await getTestPool().query(
    'SELECT disposition_code, promise_date::text AS promise_date, promise_amount FROM agency_call_attempts WHERE id = $1', [id]);
  return rows[0];
}

beforeAll(async () => {
  initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 6 });
  mocks.verifyIdToken.mockImplementation(async (token: string) => {
    if (!token.startsWith('tok:')) throw new Error('bad token');
    return { uid: token.slice(4), email: 'ptp@example.com', email_verified: true };
  });
  await flushTestRedis();
  resetVoiceEngineForTests();
  await resetAgencyRuntimeForTests();
  const ctx: AppContext = { config, pool: getPool(), redis: getTestRedis() };
  app = await buildApp({ ctx });
  await app.ready();
});

beforeEach(async () => {
  await truncateAll();
  tenant = (await insertTenant()).id as string;
  account = (await insertAccount({ tenant_id: tenant })).id as string;
  await getTestPool().query(
    `INSERT INTO feature_flag_overrides (flag_key, scope_type, tenant_id, value)
     VALUES ('agency_dialer_enabled', 'tenant', $1, 'true'::jsonb)`, [tenant]);
  agent = await user('agent');
  supervisor = await user('account_admin');
});

afterAll(async () => {
  await app?.close();
  await resetAgencyRuntimeForTests();
  resetVoiceEngineForTests();
  await closePool();
  await closeTestPool();
  await closeTestRedis();
});

describe('PT3: a promise alone never schedules a dial', () => {
  it('a plain promise records the promise and closes the contact as any label does; nothing is scheduled', async () => {
    const c = await parked({ contact: { next_attempt_at: new Date('2020-01-01T00:00:00Z') } });
    const date = dayIn('UTC', 3);
    const res = await dispose(c, { disposition_code: 'ptp', promise_date: date, promise_amount: '12500' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({
      contact_state: 'completed', next_attempt_at: null, callback_requested_at: null,
      promise_date: date, promise_amount: '12500.00',
    });
    const row = await contactRow(c.contact);
    expect(row).toMatchObject({ state: 'completed', promise_date: date, promise_amount: '12500.00', promise_followed_up_at: null });
    // The stored next dial is untouched: the promise did not write it.
    expect(row.next_attempt_at.toISOString()).toBe('2020-01-01T00:00:00.000Z');
    expect(await attemptRow(c.attempt)).toEqual({ disposition_code: 'ptp', promise_date: date, promise_amount: '12500.00' });
  });

  it('a promise on an entry that retries is retried on the retry\'s delay, never on the promised date', async () => {
    const c = await parked();
    const before = Date.now();
    const res = await dispose(c, { disposition_code: 'ptp_retry', promise_date: dayIn('UTC', 20) });
    expect(res.statusCode, res.body).toBe(200);
    const row = await contactRow(c.contact);
    expect(row.state).toBe('pending');
    const at = row.next_attempt_at.getTime();
    expect(at).toBeGreaterThanOrEqual(before + 60 * 60_000 - 5_000);
    expect(at).toBeLessThan(Date.now() + 60 * 60_000 + 5_000);
  });
});

describe('PT2: the follow-up is a callback', () => {
  it('books the window opening of the promised day + N days in the customer\'s zone, owned by the agent who took it (CA4)', async () => {
    const c = await parked({
      campaign: {
        assignment_mode: 'strict', default_timezone: 'UTC',
        calling_window_start: '09:00:00', calling_window_end: '18:00:00', calling_days: [1, 2, 3, 4, 5, 6, 7],
      },
      contact: { timezone: 'Asia/Kolkata' },
    });
    const date = dayIn('Asia/Kolkata', 5);
    const res = await dispose(c, { disposition_code: 'ptp_follow', promise_date: date });
    expect(res.statusCode, res.body).toBe(200);
    // date + 2 days, 09:00 in Kolkata (03:30 UTC).
    const [y, m, d] = date.split('-').map(Number);
    const expected = new Date(Date.UTC(y!, m! - 1, d! + 2, 3, 30));
    expect(res.json()).toMatchObject({ contact_state: 'pending', next_attempt_at: expected.toISOString(), callback_requested_at: null });
    const row = await contactRow(c.contact);
    expect(row).toMatchObject({ state: 'pending', assigned_user_id: agent.id, last_disposition: 'ptp_follow' });
    expect(row.next_attempt_at.toISOString()).toBe(expected.toISOString());
  });

  it('a follow-up landing on a day with no calling window moves to the next calling day', async () => {
    // Find a promised date whose date + 2 is a Sunday, and allow Monday to Saturday only.
    let offset = 1;
    for (; offset < 9; offset++) {
      const [y, m, d] = dayIn('UTC', offset).split('-').map(Number);
      if (new Date(Date.UTC(y!, m! - 1, d! + 2)).getUTCDay() === 0) break;
    }
    const c = await parked({ campaign: { calling_window_start: '10:00:00', calling_window_end: '17:00:00', calling_days: [1, 2, 3, 4, 5, 6] } });
    const date = dayIn('UTC', offset);
    const res = await dispose(c, { disposition_code: 'ptp_follow', promise_date: date });
    expect(res.statusCode, res.body).toBe(200);
    const [y, m, d] = date.split('-').map(Number);
    expect(res.json().next_attempt_at).toBe(new Date(Date.UTC(y!, m! - 1, d! + 3, 10)).toISOString());
  });
});

describe('PT4, PT5, PT8: validation', () => {
  it.each([
    ['no date on a promise outcome', { disposition_code: 'ptp' }, 'promise_required'],
    ['an amount without a date', { disposition_code: 'ptp', promise_amount: '5' }, 'promise_required'],
    ['a date that does not exist', { disposition_code: 'ptp', promise_date: '2026-02-30' }, 'invalid_promise_date'],
    ['a date-time instead of a date', { disposition_code: 'ptp', promise_date: '2099-01-01T00:00:00Z' }, 'invalid_promise_date'],
    ['a date past the bound', { disposition_code: 'ptp', promise_date: dayIn('UTC', AGENCY_PROMISE_MAX_DAYS_AHEAD + 1) }, 'invalid_promise_date'],
    ['a negative amount', { disposition_code: 'ptp', promise_date: dayIn('UTC', 1), promise_amount: '-1' }, 'invalid_promise_amount'],
    ['three decimal places', { disposition_code: 'ptp', promise_date: dayIn('UTC', 1), promise_amount: '1.005' }, 'invalid_promise_amount'],
    ['a promise on another outcome', { disposition_code: 'reached', promise_date: dayIn('UTC', 1) }, 'promise_not_expected'],
  ])('%s is a 400 with its code, and nothing is written', async (_name, body, code) => {
    const c = await parked();
    const res = await dispose(c, body);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code });
    expect(typeof res.json().message).toBe('string');
    expect(await attemptRow(c.attempt)).toMatchObject({ disposition_code: null, promise_date: null });
    expect((await contactRow(c.contact)).promise_date).toBeNull();
  });

  it('"today" is the customer\'s: yesterday in Kolkata is refused, today in Kolkata is accepted (even where UTC is still on yesterday)', async () => {
    const c = await parked({ contact: { timezone: 'Asia/Kolkata' } });
    const refused = await dispose(c, { disposition_code: 'ptp', promise_date: dayIn('Asia/Kolkata', -1) });
    expect(refused.statusCode, refused.body).toBe(400);
    expect(refused.json()).toMatchObject({ code: 'invalid_promise_date' });
    const today = dayIn('Asia/Kolkata', 0);
    const ok = await dispose(c, { disposition_code: 'ptp', promise_date: today });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await contactRow(c.contact)).promise_date).toBe(today);
  });

  it('the old-app path: a promise outcome with no date is refused with a message naming the fix', async () => {
    const c = await parked();
    const res = await dispose(c, { disposition_code: 'ptp' });
    expect(res.json().message).toMatch(/update it or pick another outcome/);
  });
});

describe('PT1, PT6: what is stored, replays and later promises', () => {
  it('a same-code replay corrects the promise on the attempt and the contact; a supervisor may file it on behalf', async () => {
    const c = await parked();
    await dispose(c, { disposition_code: 'ptp', promise_date: dayIn('UTC', 3), promise_amount: '100' });
    const res = await dispose(c, { disposition_code: 'ptp', promise_date: dayIn('UTC', 4) }, supervisor);
    expect(res.statusCode, res.body).toBe(200);
    expect(await attemptRow(c.attempt)).toEqual({ disposition_code: 'ptp', promise_date: dayIn('UTC', 4), promise_amount: null });
    expect(await contactRow(c.contact)).toMatchObject({ promise_date: dayIn('UTC', 4), promise_amount: null });
  });

  it('a later call\'s promise replaces the earlier one; the earlier call\'s replay never puts its own back', async () => {
    const first = await parked({ createdAt: new Date(Date.now() - 3_600_000) });
    await dispose(first, { disposition_code: 'ptp', promise_date: dayIn('UTC', 3) });
    const second = await parked({ campaignId: first.campaign, contactId: first.contact });
    expect((await dispose(second, { disposition_code: 'ptp', promise_date: dayIn('UTC', 10), promise_amount: '50.5' })).statusCode).toBe(200);
    expect(await contactRow(first.contact)).toMatchObject({ promise_date: dayIn('UTC', 10), promise_amount: '50.50' });
    // The first call's correction lands on its own attempt only.
    expect((await dispose(first, { disposition_code: 'ptp', promise_date: dayIn('UTC', 5) })).statusCode).toBe(200);
    expect(await attemptRow(first.attempt)).toMatchObject({ promise_date: dayIn('UTC', 5) });
    expect(await contactRow(first.contact)).toMatchObject({ promise_date: dayIn('UTC', 10) });
    // History keeps both.
    const { rows } = await getTestPool().query(
      'SELECT promise_date::text AS d FROM agency_call_attempts WHERE contact_id = $1 ORDER BY created_at', [first.contact]);
    expect(rows.map((r) => r.d)).toEqual([dayIn('UTC', 5), dayIn('UTC', 10)]);
  });
});

describe('PT1, PT4, PT7: a same-code replay', () => {
  it('keeps a later call\'s follow-up mark when it keeps the date (an amount corrected); a moved date starts unmarked', async () => {
    const a = await parked({ createdAt: new Date(Date.now() - 3_600_000) });
    expect((await dispose(a, { disposition_code: 'ptp', promise_date: dayIn('UTC', 0) })).statusCode).toBe(200);
    // Call B, made today after A, records another outcome: A's promise is followed up.
    const b = await parked({ campaignId: a.campaign, contactId: a.contact });
    expect((await dispose(b, { disposition_code: 'reached' })).statusCode).toBe(200);
    const marked = (await contactRow(a.contact)).promise_followed_up_at as Date;
    expect(marked).not.toBeNull();
    // A is saved again with the same date (its amount corrected, or a queued retry): still followed up.
    const replay = await dispose(a, { disposition_code: 'ptp', promise_date: dayIn('UTC', 0), promise_amount: '75' }, supervisor);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(await contactRow(a.contact)).toMatchObject({ promise_amount: '75.00', promise_followed_up_at: marked });
    // A moves the date: a new day, not known to be followed up.
    expect((await dispose(a, { disposition_code: 'ptp', promise_date: dayIn('UTC', 1) })).statusCode).toBe(200);
    expect(await contactRow(a.contact)).toMatchObject({ promise_date: dayIn('UTC', 1), promise_followed_up_at: null });
  });

  it('is not refused for the stored date having passed (a retry queued across midnight); a new past date is', async () => {
    const c = await parked();
    expect((await dispose(c, { disposition_code: 'ptp', promise_date: dayIn('UTC', 0) })).statusCode).toBe(200);
    // The promise was for yesterday: as if the first save landed yesterday.
    await getTestPool().query('UPDATE agency_call_attempts SET promise_date = $2::date WHERE id = $1', [c.attempt, dayIn('UTC', -1)]);
    const kept = await dispose(c, { disposition_code: 'ptp', promise_date: dayIn('UTC', -1), promise_amount: '20' });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(await attemptRow(c.attempt)).toEqual({ disposition_code: 'ptp', promise_date: dayIn('UTC', -1), promise_amount: '20.00' });
    const moved = await dispose(c, { disposition_code: 'ptp', promise_date: dayIn('UTC', -2) });
    expect(moved.statusCode, moved.body).toBe(400);
    expect(moved.json()).toMatchObject({ code: 'invalid_promise_date' });
    // A first save of the same past date on another call is refused as before.
    const other = await parked({ campaignId: c.campaign, contactId: c.contact });
    const first = await dispose(other, { disposition_code: 'ptp', promise_date: dayIn('UTC', -1) });
    expect(first.statusCode, first.body).toBe(400);
    expect(first.json()).toMatchObject({ code: 'invalid_promise_date' });
  });
});

describe('PT13: Mark DNC with an outcome', () => {
  it('refuses a promise outcome (it carries no date) with `promise_required`, before anything is written', async () => {
    const c = await parked();
    const res = await post(`/proxy/agency/attempts/${c.attempt}/dnc`, agent, { disposition_code: 'ptp' });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json()).toMatchObject({ code: 'promise_required' });
    expect(await attemptRow(c.attempt)).toMatchObject({ disposition_code: null });
    expect((await contactRow(c.contact)).state).toBe('connected');
    const { rows } = await getTestPool().query('SELECT count(*)::int AS n FROM dnc_entries');
    expect(rows[0]!.n).toBe(0);
    // Another outcome is taken as before.
    const ok = await post(`/proxy/agency/attempts/${c.attempt}/dnc`, agent, { disposition_code: 'reached' });
    expect(ok.statusCode, ok.body).toBe(200);
  });
});

describe('PT7, PT12: the Contacts list, its filter and the exports', () => {
  async function promised(state: 'upcoming' | 'due_today' | 'missed' | 'followed_up', campaign?: string) {
    const c = await parked(campaign ? { campaignId: campaign } : {});
    await dispose(c, { disposition_code: 'ptp', promise_date: dayIn('UTC', 2), promise_amount: '10' });
    const shift: Record<typeof state, string> = {
      upcoming: '',
      due_today: `promise_due_from = now() - interval '1 hour', promise_due_until = now() + interval '1 hour'`,
      missed: `promise_due_from = now() - interval '2 days', promise_due_until = now() - interval '1 day'`,
      followed_up: `promise_due_from = now() - interval '2 days', promise_due_until = now() - interval '1 day', promise_followed_up_at = now()`,
    };
    if (shift[state]) await getTestPool().query(`UPDATE agency_contacts SET ${shift[state]} WHERE id = $1`, [c.contact]);
    return c;
  }

  it('reads each state on the list and filters by it; `any` is every promise', async () => {
    const up = await promised('upcoming');
    const due = await promised('due_today', up.campaign);
    const missed = await promised('missed', up.campaign);
    const done = await promised('followed_up', up.campaign);
    const none = await insertAgencyContact(up.campaign, { tenant_id: tenant, account_id: account });
    const all = await get(`/proxy/agency/campaigns/${up.campaign}/contacts`, supervisor);
    expect(all.statusCode, all.body).toBe(200);
    const byId = new Map(all.json().rows.map((r: { id: string }) => [r.id, r]));
    expect(byId.get(up.contact)).toMatchObject({ promise: { date: dayIn('UTC', 2), amount: '10.00', state: 'upcoming' } });
    expect(byId.get(due.contact)).toMatchObject({ promise: { state: 'due_today' } });
    expect(byId.get(missed.contact)).toMatchObject({ promise: { state: 'missed' } });
    expect(byId.get(done.contact)).toMatchObject({ promise: { state: 'followed_up' } });
    expect(byId.get(none.id as string)).toMatchObject({ promise: null });

    const ids = async (q: string) => (await get(`/proxy/agency/campaigns/${up.campaign}/contacts?${q}`, supervisor))
      .json().rows.map((r: { id: string }) => r.id).sort();
    expect(await ids('promise=missed')).toEqual([missed.contact]);
    expect(await ids('promise=due_today,upcoming')).toEqual([due.contact, up.contact].sort());
    expect(await ids('promise=followed_up')).toEqual([done.contact]);
    expect(await ids('promise=any')).toEqual([up.contact, due.contact, missed.contact, done.contact].sort());
    const bad = await get(`/proxy/agency/campaigns/${up.campaign}/contacts?promise=paid`, supervisor);
    expect(bad.statusCode).toBe(400);
  });

  it('a later call\'s outcome on or after the promised day marks it followed up; one before the day does not', async () => {
    const c = await parked({ createdAt: new Date(Date.now() - 3 * 86_400_000) });
    await dispose(c, { disposition_code: 'ptp', promise_date: dayIn('UTC', 0) });
    // An outcome from a call made before the promised day began: still missed once the day ends.
    await getTestPool().query(`UPDATE agency_contacts SET promise_due_from = now() + interval '1 hour', promise_due_until = now() + interval '1 day' WHERE id = $1`, [c.contact]);
    const before = await parked({ campaignId: c.campaign, contactId: c.contact });
    expect((await dispose(before, { disposition_code: 'reached' })).statusCode).toBe(200);
    expect((await contactRow(c.contact)).promise_followed_up_at).toBeNull();
    // An outcome from a call made on the promised day: followed up.
    await getTestPool().query(`UPDATE agency_contacts SET promise_due_from = now() - interval '1 hour' WHERE id = $1`, [c.contact]);
    const after = await parked({ campaignId: c.campaign, contactId: c.contact });
    expect((await dispose(after, { disposition_code: 'reached' })).statusCode).toBe(200);
    expect((await contactRow(c.contact)).promise_followed_up_at).not.toBeNull();
  });

  it('appends the promise columns at the END of both CSV exports', async () => {
    const c = await promised('missed');
    expect(ATTEMPT_CSV_COLUMNS.slice(-2)).toEqual(['promise_date', 'promise_amount']);
    expect(CONTACT_CSV_COLUMNS.slice(-3)).toEqual(['promise_date', 'promise_amount', 'promise_state']);
    const contacts = await get(`/proxy/agency/campaigns/${c.campaign}/contacts.csv`, supervisor);
    expect(contacts.statusCode, contacts.body).toBe(200);
    const lines = contacts.body.trim().split(/\r?\n/).filter((l) => !l.startsWith('#'));
    expect(lines[0]!.endsWith('promise_date,promise_amount,promise_state')).toBe(true);
    expect(lines[1]!.endsWith(`${dayIn('UTC', 2)},10.00,missed`)).toBe(true);
    const attempts = await get(`/proxy/agency/campaigns/${c.campaign}/attempts.csv`, supervisor);
    const aLines = attempts.body.trim().split(/\r?\n/).filter((l) => !l.startsWith('#'));
    expect(aLines[0]!.endsWith('promise_date,promise_amount')).toBe(true);
    expect(aLines[1]!.endsWith(`${dayIn('UTC', 2)},10.00`)).toBe(true);
  });
});

describe('PT10: the catalogue', () => {
  it('a PATCH that asks for a promise beside a callback time is refused with the field named; a follow-up out of range too', async () => {
    const campaign = (await insertAgencyCampaign({ status: 'paused', disposition_catalog: CATALOG, tenant_id: tenant, account_id: account })).id as string;
    const res = await app.inject({
      method: 'PATCH', url: `/proxy/agency/campaigns/${campaign}`, headers: headers(supervisor),
      payload: JSON.stringify({ disposition_catalog: [
        { code: 'ptp', label: 'Promised', requires_promise: true, requires_datetime: true },
        { code: 'ptp2', label: 'Promised 2', requires_promise: true, promise_follow_up_days: 15 },
      ] }),
    });
    expect(res.statusCode, res.body).toBe(400);
    expect(res.body).toContain('disposition_catalog[0].requires_promise');
    expect(res.body).toContain('disposition_catalog[1].promise_follow_up_days');
  });
});
