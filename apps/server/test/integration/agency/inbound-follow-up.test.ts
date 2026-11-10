import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, insertTenant } from '../setup/factories.js';
import {
  insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession, insertManualCall, insertSoftphoneSession,
} from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const {
  agencyContactRepository: contacts,
  agencyAttemptRepository: attempts,
  agencyInboundAnswerRepository: answers,
  agencyInboundCallRepository: spine,
} = await import('../../../src/db/repositories/agency.repository.js');
const { contactBucketSql } = await import('../../../src/db/repositories/agency/assignment-sql.js');
const { sweepCallbackFallback } = await import('../../../src/agency/pacing/callback-fallback.js');
const { params } = await import('../../../src/db/repositories/agency/query-builders.js');

/**
 * The inbound follow-up on real Postgres (docs/inbound.md §7, decisions IB3, IB4, IB5): the
 * callback booked on a contact (`bookInboundCallback`) and what every reader then makes of it:
 * the bucket (`isCallbackSql` widened), the dialer's own claims (pool and owner), the CA5
 * fallback, and the clear when the contact's next call settles. Plus pacing's live count (the
 * inbound arm) and the identification reads (`AgencyInboundAnswerRepository`).
 *
 * Mutation-checked (each red, then restored): `bookInboundCallback` without its `state IN
 * ('pending', 'exhausted')` reopens a completed contact; without the campaign-status join books on a
 * completed campaign; without `suppressed_reason IS DISTINCT FROM 'dnc'` reopens a DNC-pending row;
 * `isCallbackSql` without its `callback_source` arm buckets an inbound callback `pending`; the CA5
 * fallback with its old no-callback-codes early return leaves an inbound callback owned forever;
 * `chargeAttempt` without the clear keeps the callback after a placed call; `countLiveForAccount`
 * without its inbound arm reads 0 with a live inbound call.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();
const OWNER = randomUUID();
const OTHER_AGENT = randomUUID();
const minutes = (m: number) => new Date(Date.now() + m * 60_000);

async function row(id: string) {
  const { rows } = await pool().query<{
    state: string; next_attempt_at: Date; callback_source: string | null; callback_due_at: Date | null; assigned_user_id: string | null;
  }>('SELECT state, next_attempt_at, callback_source, callback_due_at, assigned_user_id FROM agency_contacts WHERE id = $1', [id]);
  return rows[0]!;
}

async function bucketOf(id: string, codes: string[] = []): Promise<string> {
  const p = params();
  const codesParam = p.add(codes);
  const idParam = p.add(id);
  const { rows } = await pool().query<{ bucket: string }>(
    `SELECT ${contactBucketSql('c', codesParam)} AS bucket FROM agency_contacts c WHERE c.id = ${idParam}::uuid`, p.values);
  return rows[0]!.bucket;
}

async function campaign(o: Record<string, unknown> = {}) {
  return (await insertAgencyCampaign({ tenant_id: T, account_id: A, status: 'running', ...o })).id as string;
}

async function contact(campaignId: string, o: Record<string, unknown> = {}) {
  return (await insertAgencyContact(campaignId, { tenant_id: T, account_id: A, phone_e164: '+919812345678', ...o })).id as string;
}

const book = (contactId: string, dueAt: Date, tenantId: string = T) => contacts.bookInboundCallback({ tenantId, contactId, dueAt });

beforeEach(async () => {
  await truncateAll();
  await insertTenant({ id: T });
});

afterAll(async () => {
  await truncateAll();
  await closeTestPool();
});

describe('bookInboundCallback', () => {
  it('a pending contact: callback_source inbound, due by then; one due sooner keeps its sooner time', async () => {
    const k = await campaign();
    const later = await contact(k, { next_attempt_at: minutes(600) });
    const due = minutes(30);
    expect(await book(later, due)).toMatchObject({ contactId: later, reopened: false });
    expect(await row(later)).toMatchObject({ state: 'pending', callback_source: 'inbound' });
    expect((await row(later)).next_attempt_at.getTime()).toBe(due.getTime());
    expect((await row(later)).callback_due_at!.getTime()).toBe(due.getTime());

    const soon = minutes(5);
    const sooner = await contact(k, { next_attempt_at: soon, phone_e164: '+919800000001' });
    await book(sooner, due);
    expect((await row(sooner)).next_attempt_at.getTime()).toBe(soon.getTime());
    expect((await row(sooner)).callback_due_at!.getTime()).toBe(due.getTime());
  });

  it('IB4: an exhausted contact is reopened, due at the callback time', async () => {
    const k = await campaign();
    const c = await contact(k, { state: 'exhausted', attempt_count: 3, next_attempt_at: minutes(-60) });
    const due = minutes(45);
    expect(await book(c, due)).toMatchObject({ reopened: true });
    const r = await row(c);
    expect(r).toMatchObject({ state: 'pending', callback_source: 'inbound' });
    expect(r.next_attempt_at.getTime()).toBe(due.getTime());
  });

  it('a terminal contact (completed, suppressed) and a live one (in_flight, connected) are never touched', async () => {
    const k = await campaign();
    for (const state of ['completed', 'suppressed', 'in_flight', 'connected']) {
      const c = await contact(k, { state, phone_e164: `+91980000${String(Math.floor(Math.random() * 10_000)).padStart(4, '0')}` });
      expect(await book(c, minutes(10)), state).toBeNull();
      expect(await row(c), state).toMatchObject({ state, callback_source: null, callback_due_at: null });
    }
  });

  it('a DNC-suppressed pending row (a pre-fix leftover) is never booked (B8)', async () => {
    const c = await contact(await campaign(), { suppressed_reason: 'dnc' });
    expect(await book(c, minutes(10))).toBeNull();
    expect((await row(c)).callback_source).toBeNull();
  });

  it('only on a running or paused campaign', async () => {
    for (const status of ['running', 'paused']) {
      const c = await contact(await campaign({ status }));
      expect(await book(c, minutes(10)), status).not.toBeNull();
    }
    for (const status of ['draft', 'completed', 'stopped']) {
      const c = await contact(await campaign({ status }));
      expect(await book(c, minutes(10)), status).toBeNull();
    }
  });

  it('another tenant\'s contact is not found', async () => {
    const c = await contact(await campaign());
    expect(await book(c, minutes(10), randomUUID())).toBeNull();
  });

  it('a second inbound call keeps the earlier due time', async () => {
    const c = await contact(await campaign(), { next_attempt_at: minutes(600) });
    const [d10, d30, d90] = [minutes(10), minutes(30), minutes(90)];
    await book(c, d30);
    await book(c, d90);
    expect((await row(c)).callback_due_at!.getTime()).toBe(d30.getTime());
    await book(c, d10);
    expect((await row(c)).callback_due_at!.getTime()).toBe(d10.getTime());
    expect((await row(c)).next_attempt_at.getTime()).toBe(d10.getTime());
  });

  it('0029: the contact remembers whether its callback reopened it (a second booking keeps it); a booking after the callback was settled writes it afresh', async () => {
    const reopenedOf = async (id: string) => (await pool().query<{ callback_reopened: boolean }>(
      'SELECT callback_reopened FROM agency_contacts WHERE id = $1', [id])).rows[0]!.callback_reopened;
    const k = await campaign();
    const pending = await contact(k, { next_attempt_at: minutes(600) });
    await book(pending, minutes(30));
    expect(await reopenedOf(pending)).toBe(false);
    const exhausted = await contact(k, { state: 'exhausted', attempt_count: 3, phone_e164: '+919800000002' });
    await book(exhausted, minutes(30));
    expect(await reopenedOf(exhausted)).toBe(true);
    // A second missed call: the contact is `pending` now, but its callback is still the reopening one.
    await book(exhausted, minutes(10));
    expect(await reopenedOf(exhausted)).toBe(true);
    // A placed dial settled the callback (the flag is left, meaningless without a source); the next booking rewrites it.
    await contacts.chargeAttempt(exhausted, 'no_answer');
    expect(await row(exhausted)).toMatchObject({ callback_source: null });
    await book(exhausted, minutes(20));
    expect(await reopenedOf(exhausted)).toBe(false);
  });
});

describe('what the dialer makes of an inbound callback', () => {
  it('the bucket reads `callback` (isCallbackSql widened), with no callback code and no last disposition', async () => {
    const c = await contact(await campaign(), { state: 'exhausted', attempt_count: 2, last_outcome: 'no_answer' });
    expect(await bucketOf(c)).toBe('exhausted');
    await book(c, minutes(10));
    expect(await bucketOf(c)).toBe('callback');
  });

  it('pool: the claim dials it at its due time, not before', async () => {
    const k = await campaign();
    const future = await contact(k, { state: 'exhausted', attempt_count: 3 });
    await book(future, minutes(30));
    expect(await contacts.claimDialable(k, 5)).toEqual([]);
    const now = await contact(k, { state: 'exhausted', attempt_count: 3, phone_e164: '+919800000002' });
    await book(now, minutes(-1));
    expect((await contacts.claimDialable(k, 5)).map((c) => c.id)).toEqual([now]);
  });

  it('strict: the owner\'s claim takes it, never another agent\'s; preferred likewise', async () => {
    for (const mode of ['strict', 'preferred'] as const) {
      await truncateAll();
      await insertTenant({ id: T });
      const k = await campaign({ assignment_mode: mode });
      const c = await contact(k, { state: 'exhausted', attempt_count: 3, assigned_user_id: OWNER, assigned_at: new Date() });
      await book(c, minutes(-1));
      expect(await contacts.claimForAgents(k, [OTHER_AGENT], mode), mode).toEqual([]);
      const claimed = await contacts.claimForAgents(k, [OTHER_AGENT, OWNER], mode);
      expect(claimed.map((x) => [x.agentUserId, x.contact.id]), mode).toEqual([[OWNER, c]]);
    }
  });

  it('CA5: an overdue inbound callback whose owner is absent falls back to the pool, even on a catalog with no callback codes', async () => {
    const k = await campaign({
      assignment_mode: 'strict', callback_fallback: 'pool', callback_owner_grace_minutes: 0,
      disposition_catalog: JSON.stringify([]),
    });
    const c = await contact(k, { assigned_user_id: OWNER, assigned_at: new Date() });
    await book(c, minutes(-5));
    const { rows } = await pool().query('SELECT * FROM agency_campaigns WHERE id = $1', [k]);
    expect(await sweepCallbackFallback(rows[0])).toBe(1);
    expect((await row(c)).assigned_user_id).toBeNull();
    // ... and an owner who is present keeps it.
    const kept = await contact(k, { assigned_user_id: OTHER_AGENT, assigned_at: new Date(), phone_e164: '+919800000003' });
    await insertAgentSession(k, { tenant_id: T, account_id: A, agent_user_id: OTHER_AGENT, state: 'available' });
    await book(kept, minutes(-5));
    await sweepCallbackFallback(rows[0]);
    expect((await row(kept)).assigned_user_id).toBe(OTHER_AGENT);
  });

  it('the contact\'s next placed call settles it: chargeAttempt clears; an our-fault charge keeps it', async () => {
    const k = await campaign();
    const c = await contact(k);
    await book(c, minutes(10));
    await contacts.chargeOurFaultAttempt(c, 'agent_disconnected');
    expect((await row(c)).callback_source).toBe('inbound');
    await contacts.chargeAttempt(c, 'no_answer');
    expect(await row(c)).toMatchObject({ callback_source: null, callback_due_at: null });
  });

  it('a soft-phone call that claimed the contact settles it (placed); one never placed keeps it', async () => {
    const k = await campaign();
    for (const charge of ['none', 'attempt'] as const) {
      const session = await insertSoftphoneSession({ tenant_id: T, account_id: A });
      const c = await contact(k, { state: 'in_flight', phone_e164: `+9198000001${charge === 'none' ? '0' : '1'}` });
      await pool().query(`UPDATE agency_contacts SET callback_source = 'inbound', callback_due_at = now() WHERE id = $1`, [c]);
      const m = await insertManualCall(session as never, {
        tenant_id: T, account_id: A, campaign_id: k, contact_id: c, contact_claimed: true, contact_prior_state: 'pending',
      });
      await contacts.settleFromManual({
        manualCallId: m.id as string, decision: { contactState: 'pending', nextAttemptAt: minutes(60), suppressedReason: null },
        charge, lastOutcome: 'no_answer', lastDisposition: null,
      });
      expect((await row(c)).callback_source, charge).toBe(charge === 'attempt' ? null : 'inbound');
    }
  });
});

describe('pacing\'s live count (IB5)', () => {
  it('counts the account\'s live admitted inbound calls: not one turned away (`arrived`), nor ended ones, nor another account\'s', async () => {
    await pool().query(`INSERT INTO telephony_providers (name, display_name) VALUES ('plivo', 'Plivo') ON CONFLICT DO NOTHING`);
    const cred = (await pool().query<{ id: string }>(
      `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', 'MA000000000000000001') RETURNING id`, [T])).rows[0]!.id;
    const arrive = (accountId: string) => spine.insertArrival({
      tenantId: T, accountId, routeId: null, phoneNumberId: null, provider: 'plivo', telephonyCredentialId: cred,
      providerCallId: `CA-${randomUUID()}`, fromE164: '+919812345678', toE164: '+14155550101',
      identification: { match: null, callerDnc: false, sticky: null }, answered: true, recordingRequested: false, analysisProfileId: null,
    });
    expect(await attempts.countLiveForAccount(T, A)).toBe(0);
    const live = (await arrive(A)).call!;
    const other = (await arrive(OTHER_ACCOUNT)).call!;
    await spine.transition(other.id, 'greeting');
    const done = (await arrive(A)).call!;
    await spine.transition(done.id, 'greeting');
    await spine.end(done.id, { outcome: 'closed', talkSeconds: null, followUp: { reason: 'closed', assigneeUserId: null }, callbackDueAt: null, voicemailKey: null });
    // Arrived and not admitted (it would hear "busy"): no part of the account's total.
    expect(await attempts.countLiveForAccount(T, A)).toBe(0);
    await spine.transition(live.id, 'greeting');
    expect(await answers.countLiveAdmittedOnRoute(randomUUID())).toBe(0);
    expect(await attempts.countLiveForAccount(T, A)).toBe(1);
    // The bridge's shared scopes turned it away after all: the admission is taken back.
    expect(await spine.refuseAdmission(live.id)).toMatchObject({ state: 'arrived' });
    expect(await attempts.countLiveForAccount(T, A)).toBe(0);
    // Only from `greeting`: an ended or further-on call never goes back.
    expect(await spine.refuseAdmission(done.id)).toBeNull();

    // A recorded route's caller turned away hears "busy" and is never recorded: the request is
    // taken back with the admission, on the spine and on its media leg.
    const recorded = (await spine.insertArrival({
      tenantId: T, accountId: A, routeId: null, phoneNumberId: null, provider: 'plivo', telephonyCredentialId: cred,
      providerCallId: `CA-${randomUUID()}`, fromE164: '+919812345678', toE164: '+14155550101',
      identification: { match: null, callerDnc: false, sticky: null }, answered: true, recordingRequested: true, analysisProfileId: null,
    })).call!;
    await spine.transition(recorded.id, 'greeting');
    expect(await spine.refuseAdmission(recorded.id)).toMatchObject({ state: 'arrived', recording_requested: false });
    const leg = await pool().query('SELECT recording_requested FROM agency_calls WHERE id = $1', [recorded.webrtc_call_id]);
    expect(leg.rows[0].recording_requested).toBe(false);
  });
});

describe('the identification reads', () => {
  const RUNG = '+14155550101';

  async function numberWithTags(tagAccounts: string[]) {
    await pool().query(`INSERT INTO telephony_providers (name, display_name) VALUES ('plivo', 'Plivo') ON CONFLICT DO NOTHING`);
    const provider = (await pool().query<{ id: string }>(`SELECT id FROM telephony_providers WHERE name = 'plivo'`)).rows[0]!.id;
    const pn = (await pool().query<{ id: string }>(
      `INSERT INTO phone_numbers (phone_number, provider_id) VALUES ($1, $2) RETURNING id`, [RUNG, provider])).rows[0]!.id;
    const tpa = (await pool().query<{ id: string }>(
      `INSERT INTO tenant_phone_assignments (tenant_id, phone_number_id) VALUES ($1, $2) RETURNING id`, [T, pn])).rows[0]!.id;
    for (const account of tagAccounts) {
      await pool().query(`INSERT INTO phone_account_tags (assignment_id, account_id) VALUES ($1, $2)`, [tpa, account]);
    }
    return pn;
  }

  async function account(id: string, status = 'active') {
    await pool().query(`INSERT INTO accounts (id, tenant_id, name, slug, status) VALUES ($1, $2, 'acct', $3, $4)`, [id, T, `a-${id.slice(0, 8)}`, status]);
  }

  async function activeAgent(id: string, active = true) {
    await pool().query(`INSERT INTO users (id, firebase_uid, email, status) VALUES ($1, $2, $3, $4)`, [id, `fb-${id}`, `${id}@example.test`, active ? 'active' : 'inactive']);
    await pool().query(`INSERT INTO memberships (user_id, tenant_id, account_id, role) VALUES ($1, $2, $3, 'agent')`, [id, T, A]);
  }

  it('the number\'s roster rows in every live account of the tenant, with the tag rule and the latest attempt', async () => {
    await account(A);
    await account(OTHER_ACCOUNT);
    const deleted = randomUUID();
    await account(deleted, 'deleted');
    const pn = await numberWithTags([A]);
    const k = await campaign();
    const mine = await contact(k);
    const kb = (await insertAgencyCampaign({ tenant_id: T, account_id: OTHER_ACCOUNT, status: 'running' })).id as string;
    const theirs = await contact(kb, { account_id: OTHER_ACCOUNT });
    const kd = (await insertAgencyCampaign({ tenant_id: T, account_id: deleted, status: 'running' })).id as string;
    await contact(kd, { account_id: deleted });
    await insertAgencyAttempt(k, mine, { tenant_id: T, account_id: A, attempt_number: 1, caller_id: '+14155550199', state: 'ended' });
    await insertAgencyAttempt(k, mine, { tenant_id: T, account_id: A, attempt_number: 2, caller_id: RUNG, state: 'ended' });
    const rows = await answers.findContactCandidates({ tenantId: T, fromE164: '+919812345678', phoneNumberId: pn });
    const byId = new Map(rows.map((r) => [r.contact_id, r]));
    expect([...byId.keys()].sort()).toEqual([mine, theirs].sort());
    // Tagged to A only: B may not use it.
    expect(byId.get(mine)).toMatchObject({ account_may_use: true, last_attempt_caller_id: RUNG, campaign_status: 'running' });
    expect(byId.get(theirs)).toMatchObject({ account_may_use: false, last_attempt_at: null });
  });

  it('calls inside the lookback by agents still active in the tenant: attempts (by the reserved session) and soft-phone calls', async () => {
    await account(A);
    const active = randomUUID();
    const gone = randomUUID();
    await activeAgent(active);
    await activeAgent(gone, false);
    const k = await campaign();
    const c = await contact(k);
    const s1 = await insertAgentSession(k, { tenant_id: T, account_id: A, agent_user_id: active });
    const s2 = await insertAgentSession(k, { tenant_id: T, account_id: A, agent_user_id: gone });
    await insertAgencyAttempt(k, c, { tenant_id: T, account_id: A, attempt_number: 1, caller_id: RUNG, reserved_agent_id: s1.id, state: 'ended', outcome: 'connected' });
    await insertAgencyAttempt(k, c, { tenant_id: T, account_id: A, attempt_number: 2, caller_id: RUNG, reserved_agent_id: s2.id, state: 'ended' });
    await insertAgencyAttempt(k, c, {
      tenant_id: T, account_id: A, attempt_number: 3, caller_id: RUNG, reserved_agent_id: s1.id, state: 'ended', created_at: minutes(-60 * 24 * 40),
    });
    // The agent's campaign session has left before they opened the soft phone (one live session each).
    await pool().query(`UPDATE agency_agent_sessions SET left_at = now(), state = 'offline' WHERE agent_user_id = $1`, [active]);
    const soft = await insertSoftphoneSession({ tenant_id: T, account_id: A, agent_user_id: active });
    await insertManualCall(soft as never, { destination_e164: '+919812345678', caller_id: RUNG });
    const rows = await answers.findCallSignals({ tenantId: T, fromE164: '+919812345678', since: minutes(-60 * 24 * 30) });
    expect(rows.map((r) => [r.channel, r.agent_user_id, r.connected]).sort()).toEqual([
      ['campaign', active, true],
      ['softphone', active, false],
    ].sort());
  });

  it('filterAccountMembers: active users with a tenant-level or this account\'s membership', async () => {
    await account(A);
    await account(OTHER_ACCOUNT);
    const here = randomUUID();
    const elsewhere = randomUUID();
    const tenantLevel = randomUUID();
    for (const [id, accountId] of [[here, A], [elsewhere, OTHER_ACCOUNT], [tenantLevel, null]] as const) {
      await pool().query(`INSERT INTO users (id, firebase_uid, email) VALUES ($1, $2, $3)`, [id, `fb-${id}`, `${id}@example.test`]);
      await pool().query(`INSERT INTO memberships (user_id, tenant_id, account_id, role) VALUES ($1, $2, $3, 'agent')`, [id, T, accountId]);
    }
    expect([...await answers.filterAccountMembers(T, A, [here, elsewhere, tenantLevel, randomUUID()])].sort()).toEqual([here, tenantLevel].sort());
  });
});
