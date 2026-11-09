import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, insertTenant } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgencyContact, insertAgentSession } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const {
  agencyInboundCallRepository: repo,
  agencyContactRepository: contacts,
  agencyCampaignRepository: campaigns,
} = await import('../../../src/db/repositories/agency.repository.js');
const { numberLiveSql } = await import('../../../src/db/repositories/agency/assignment-sql.js');
const { campaignStats } = await import('../../../src/db/repositories/agency/campaign-stats.js');
const { RETRY_INHERITED_CONFIG_KEYS } = await import('@magick-agency/domain/retry-campaign-bounds');
type ArrivalInput = import('../../../src/db/repositories/agency.repository.js').AgencyInboundArrivalInput;

/**
 * The agent side of the inbound spine on real Postgres (docs/inbound.md §2, §6, P2;
 * `0027_inbound_connect.sql`): the session-guarded offer, requeue and connect (one unsettled call
 * per session, racing writers), settlement as an unbridged call ends, the outcome (first write,
 * replay, refusals, two writers), the lapse and the startup sweep keeping a bridged call's outcome
 * owed; the account's busy probe gaining live inbound calls (pacing's claim, its plan, the soft
 * phone's read); the matched contact's settlement from each state and the uncharged return of a
 * superseded dial; the supervisor floor's marker; the campaign's `inbound_sticky_enabled` writes.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();
const CALLER = '+919876500001';

let credentialId: string;
let seq = 0;

function arrival(o: Partial<ArrivalInput> = {}): ArrivalInput {
  return {
    tenantId: T, accountId: A, routeId: null, phoneNumberId: null, provider: 'plivo',
    telephonyCredentialId: credentialId, providerCallId: `CA-${randomUUID()}`,
    fromE164: CALLER, toE164: '+14155550100',
    identification: { match: null, callerDnc: false, sticky: null },
    answered: true, recordingRequested: false, analysisProfileId: null,
    ...o,
  };
}

async function arrived(o: Partial<ArrivalInput> = {}) {
  return (await repo.insertArrival(arrival(o))).call!;
}

/** A call offered to `session` (a fresh one by default), from the queue. */
async function offered(session: string = randomUUID(), o: Partial<ArrivalInput> = {}) {
  const call = await arrived(o);
  await repo.transition(call.id, 'queued');
  const res = await repo.offer(call.id, session);
  if (!res.ok) throw new Error(`offer refused: ${res.reason}`);
  return { call: res.call, session };
}

/** A call that bridged to `session` and ended: its outcome owed. */
async function owing(session: string = randomUUID(), o: Partial<ArrivalInput> = {}, endedAt?: Date) {
  const { call } = await offered(session, o);
  await repo.connect(call.id, { sessionId: session, answeredByUserId: randomUUID() });
  const ended = await repo.end(call.id, {
    outcome: 'answered', talkSeconds: 42, followUp: null, callbackDueAt: null, voicemailKey: null, endedAt,
  });
  if (!ended.ended) throw new Error('not ended');
  return { call: ended.call, session };
}

const outcome = (id: string, o: Partial<Parameters<typeof repo.saveDisposition>[0]> = {}) => repo.saveDisposition({
  id, code: 'sale', source: 'route', notes: null, callbackAt: null, actorUserId: randomUUID(), onBehalf: false, ...o,
});

beforeEach(async () => {
  await truncateAll();
  await pool().query(`INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink'), ('plivo', 'Plivo')`);
  await insertTenant({ id: T });
  credentialId = (await pool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', $2) RETURNING id`,
    [T, `MA${String(++seq).padStart(18, '0')}`])).rows[0]!.id;
});

afterAll(async () => {
  // 0024's and 0027's Downs refuse while inbound calls exist: leave none for the down → up suites.
  await truncateAll();
  await closeTestPool();
});

describe('arrival', () => {
  it('mirrors the leg\'s recording flag onto the spine', async () => {
    expect(await arrived({ recordingRequested: true })).toMatchObject({ recording_requested: true });
    expect(await arrived()).toMatchObject({ recording_requested: false, session_id: null, offer_count: 0, settled_at: null });
  });
});

describe('offer, requeue, connect', () => {
  it('offers from the queue (or straight from the greeting), stamping the session, the time and the count', async () => {
    const session = randomUUID();
    const call = await arrived();
    const queuedAt = new Date('2026-11-09T10:00:00Z');
    expect(await repo.transition(call.id, 'queued', { at: queuedAt })).toMatchObject({ state: 'queued', queued_at: queuedAt });
    const at = new Date('2026-11-09T10:00:30Z');
    expect(await repo.offer(call.id, session, { at })).toEqual({
      ok: true, call: expect.objectContaining({ state: 'offered', session_id: session, offered_at: at, offer_count: 1 }),
    });
    // Once offered, offered again (to anyone) is refused: it is with an agent.
    expect(await repo.offer(call.id, randomUUID())).toEqual({ ok: false, reason: 'not_offerable' });
    // A fast connect: from the greeting with nobody waiting ahead; it never queued.
    const fast = await arrived();
    await repo.transition(fast.id, 'greeting');
    expect(await repo.offer(fast.id, randomUUID())).toMatchObject({ ok: true, call: { state: 'offered', queued_at: null } });
    expect(await repo.offer(randomUUID(), randomUUID())).toEqual({ ok: false, reason: 'not_offerable' });
  });

  it('a requeue clears the session and keeps the first queue time; only the session it is offered to may requeue it', async () => {
    const { call, session } = await offered();
    const queuedAt = call.queued_at!;
    expect(await repo.requeue(call.id, randomUUID())).toBeNull();
    const back = await repo.requeue(call.id, session, { at: new Date(Date.now() + 60_000) });
    expect(back).toMatchObject({ state: 'queued', session_id: null, queued_at: queuedAt, offer_count: 1 });
    expect(await repo.requeue(call.id, session)).toBeNull();
    // Offered again, to someone else: the count says so.
    const next = randomUUID();
    expect(await repo.offer(call.id, next)).toMatchObject({ ok: true, call: { session_id: next, offer_count: 2 } });
    // Requeued after an offer straight from the greeting: it queues now.
    const fast = await arrived();
    await repo.transition(fast.id, 'greeting');
    const s = randomUUID();
    await repo.offer(fast.id, s);
    expect((await repo.requeue(fast.id, s))!.queued_at).toBeInstanceOf(Date);
  });

  it('the arrival-side move to queued never leaves an offer (that is the requeue, with its session)', async () => {
    const { call } = await offered();
    expect(await repo.transition(call.id, 'queued')).toBeNull();
    expect((await repo.findById(T, call.id))!.state).toBe('offered');
  });

  it('connects only the session it is offered to, stamping the bridge once', async () => {
    const { call, session } = await offered();
    const agent = randomUUID();
    expect(await repo.connect(call.id, { sessionId: randomUUID(), answeredByUserId: agent })).toBeNull();
    const at = new Date('2026-11-09T10:01:00Z');
    expect(await repo.connect(call.id, { sessionId: session, answeredByUserId: agent, at }))
      .toMatchObject({ state: 'connected', bridged_at: at, answered_by_user_id: agent, session_id: session });
    expect(await repo.connect(call.id, { sessionId: session, answeredByUserId: randomUUID() })).toBeNull();
    // Requeued calls cannot be connected by the session that lost them.
    const lost = await offered();
    await repo.requeue(lost.call.id, lost.session);
    expect(await repo.connect(lost.call.id, { sessionId: lost.session, answeredByUserId: agent })).toBeNull();
  });

  it('one unsettled call per session: a second offer is session_busy until the first settles', async () => {
    const session = randomUUID();
    const first = await owing(session);
    const second = await arrived();
    await repo.transition(second.id, 'queued');
    expect(await repo.offer(second.id, session)).toEqual({ ok: false, reason: 'session_busy' });
    expect((await repo.findById(T, second.id))!.state).toBe('queued');
    await outcome(first.call.id);
    expect(await repo.offer(second.id, session)).toMatchObject({ ok: true });
  });

  it('two calls offered to one session at once: one wins, the other is session_busy (the index, not a lost update)', async () => {
    for (let round = 0; round < 20; round++) {
      const session = randomUUID();
      const a = await arrived();
      const b = await arrived();
      await repo.transition(a.id, 'queued');
      await repo.transition(b.id, 'queued');
      const results = await Promise.all([repo.offer(a.id, session), repo.offer(b.id, session)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toEqual({ ok: false, reason: 'session_busy' });
      const { rows } = await pool().query('SELECT count(*)::int AS n FROM agency_inbound_calls WHERE session_id = $1', [session]);
      expect(rows[0].n).toBe(1);
    }
  });

  it('one call offered to two sessions at once: exactly one holds it', async () => {
    for (let round = 0; round < 20; round++) {
      const call = await arrived();
      await repo.transition(call.id, 'queued');
      const [s1, s2] = [randomUUID(), randomUUID()];
      const results = await Promise.all([repo.offer(call.id, s1), repo.offer(call.id, s2)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const row = (await repo.findById(T, call.id))!;
      expect(row.offer_count).toBe(1);
      expect([s1, s2]).toContain(row.session_id);
    }
  });
});

describe('the end and settlement', () => {
  it('a call that never bridged settles as it ends, and frees the session it was offered to', async () => {
    const { call, session } = await offered();
    const endedAt = new Date('2026-11-09T10:02:00Z');
    const ended = await repo.end(call.id, {
      outcome: 'abandoned_in_queue', talkSeconds: null, followUp: { reason: 'abandoned_in_queue', assigneeUserId: null },
      callbackDueAt: null, voicemailKey: null, endedAt,
    });
    expect(ended).toMatchObject({ ended: true, call: { settled_at: endedAt, session_id: session } });
    expect(await repo.findUnsettledForSession(session)).toBeNull();
    // P1's ends settle too (a closed call never had a session).
    const closed = await arrived();
    expect((await repo.end(closed.id, { outcome: 'closed', talkSeconds: null, followUp: { reason: 'closed', assigneeUserId: null }, callbackDueAt: null, voicemailKey: null }))
      .call!.settled_at).toBeInstanceOf(Date);
  });

  it('a bridged call stays unsettled at its end: the outcome is owed, and the session holds it', async () => {
    const { call, session } = await owing();
    expect(call).toMatchObject({ outcome: 'answered', settled_at: null, talk_seconds: 42 });
    expect(await repo.findUnsettledForSession(session)).toMatchObject({ id: call.id });
  });

  it('findUnsettledForSession: the offered or connected call, the owed one, nothing once settled', async () => {
    const { call, session } = await offered();
    expect(await repo.findUnsettledForSession(session)).toMatchObject({ id: call.id, state: 'offered' });
    await repo.connect(call.id, { sessionId: session, answeredByUserId: randomUUID() });
    expect(await repo.findUnsettledForSession(session)).toMatchObject({ state: 'connected' });
    expect(await repo.findUnsettledForSession(randomUUID())).toBeNull();
  });

  it('records a voicemail\'s length with it', async () => {
    const call = await arrived();
    expect((await repo.end(call.id, {
      outcome: 'voicemail', talkSeconds: null, followUp: { reason: 'closed', assigneeUserId: null }, callbackDueAt: null,
      voicemailKey: 'inbound-voicemail/t/a/x.wav', voicemailSeconds: 17,
    })).call).toMatchObject({ voicemail_key: 'inbound-voicemail/t/a/x.wav', voicemail_seconds: 17 });
  });
});

describe('the outcome', () => {
  it('saves and settles once; a replay of the same code is idempotent and last-write-wins on notes and callback', async () => {
    const { call } = await owing();
    const actor = randomUUID();
    const first = await outcome(call.id, { code: 'call_back', notes: 'wants Tuesday', callbackAt: new Date('2026-11-12T09:00:00Z'), actorUserId: actor });
    expect(first).toMatchObject({
      ok: true, replay: false,
      call: { disposition_code: 'call_back', disposition_source: 'route', notes: 'wants Tuesday', dispositioned_by_user_id: actor },
    });
    const settledAt = (first as { call: { settled_at: Date } }).call.settled_at;
    expect(settledAt).toBeInstanceOf(Date);
    const replay = await outcome(call.id, { code: 'call_back', notes: null, callbackAt: new Date('2026-11-13T09:00:00Z') });
    expect(replay).toMatchObject({ ok: true, replay: true, call: { notes: 'wants Tuesday', callback_at: new Date('2026-11-13T09:00:00Z'), settled_at: settledAt } });
    expect(await outcome(call.id, { code: 'sale' })).toMatchObject({ ok: false, reason: 'different_code' });
  });

  it('on behalf: a supervisor saves it for the agent', async () => {
    const { call } = await owing();
    const supervisor = randomUUID();
    expect(await outcome(call.id, { actorUserId: supervisor, onBehalf: true }))
      .toMatchObject({ ok: true, call: { dispositioned_by_user_id: supervisor, dispositioned_on_behalf: true } });
  });

  it('refuses a live call, one that never bridged, a lapsed one, and a missing one', async () => {
    const { call: live, session } = await offered();
    await repo.connect(live.id, { sessionId: session, answeredByUserId: randomUUID() });
    expect(await outcome(live.id)).toMatchObject({ ok: false, reason: 'live' });
    const nobody = await arrived();
    await repo.end(nobody.id, { outcome: 'closed', talkSeconds: null, followUp: { reason: 'closed', assigneeUserId: null }, callbackDueAt: null, voicemailKey: null });
    expect(await outcome(nobody.id)).toMatchObject({ ok: false, reason: 'not_bridged' });
    const lapsed = await owing(undefined, {}, new Date(Date.now() - 3_600_000));
    expect(await repo.lapseUnsettled()).toHaveLength(1);
    expect(await outcome(lapsed.call.id)).toMatchObject({ ok: false, reason: 'lapsed' });
    expect(await outcome(randomUUID())).toEqual({ ok: false, reason: 'not_found', call: null });
  });

  it('the source must agree with the match (the CHECK refuses rather than the repository coercing)', async () => {
    const { call } = await owing(undefined, { identification: { match: { contactId: randomUUID(), campaignId: randomUUID() }, callerDnc: false, sticky: null } });
    await expect(outcome(call.id, { source: 'route' })).rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_inbound_calls_disposition' });
    expect(await outcome(call.id, { source: 'campaign' })).toMatchObject({ ok: true, call: { disposition_source: 'campaign' } });
  });

  it('two different outcomes at once: one is saved, the other told so', async () => {
    for (let round = 0; round < 10; round++) {
      const { call } = await owing();
      const [a, b] = await Promise.all([outcome(call.id, { code: 'sale' }), outcome(call.id, { code: 'no_interest' })]);
      expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
      expect([a, b].find((r) => !r.ok)).toMatchObject({ reason: 'different_code' });
    }
  });

  it('notes: replaced while unsettled, cleared by an empty string, refused once settled', async () => {
    const { call } = await owing();
    expect(await repo.updateNotes(call.id, 'first')).toMatchObject({ notes: 'first' });
    expect(await repo.updateNotes(call.id, '')).toMatchObject({ notes: null });
    const { call: live } = await offered();
    expect(await repo.updateNotes(live.id, 'during the call')).toMatchObject({ notes: 'during the call' });
    await outcome(call.id);
    expect(await repo.updateNotes(call.id, 'late')).toBeNull();
  });
});

describe('the lapse sweep', () => {
  it('closes an owed outcome past the lapse, or when the session left: no_disposition, its source, nobody, settled', async () => {
    const campaign = await insertAgencyCampaign();
    const leftSession = await insertAgentSession(campaign.id, { left_at: new Date(), state: 'offline' });
    const old = await owing(undefined, {}, new Date(Date.now() - 31 * 60_000));
    const matched = await owing(undefined, {
      identification: { match: { contactId: randomUUID(), campaignId: campaign.id }, callerDnc: false, sticky: null },
    }, new Date(Date.now() - 31 * 60_000));
    const left = await owing(leftSession.id as string);
    const recent = await owing();
    const lapsed = await repo.lapseUnsettled();
    expect(lapsed.map((r) => r.id).sort()).toEqual([old.call.id, matched.call.id, left.call.id].sort());
    expect(lapsed.find((r) => r.id === old.call.id)).toMatchObject({
      disposition_code: 'no_disposition', disposition_source: 'route', dispositioned_by_user_id: null,
      settled_at: expect.any(Date), dispositioned_at: expect.any(Date),
    });
    expect(lapsed.find((r) => r.id === matched.call.id)).toMatchObject({ disposition_source: 'campaign' });
    expect((await repo.findById(T, recent.call.id))!.settled_at).toBeNull();
    expect(await repo.lapseUnsettled()).toEqual([]);
    expect(await repo.lapseUnsettled({ lapseMs: 0 })).toHaveLength(1);
  });

  it('takes at most `limit`, oldest first; skips a row another writer holds; two sweeps never close one call twice', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push((await owing(undefined, {}, new Date(Date.UTC(2026, 10, 1, 9, i)))).call.id);
    expect((await repo.lapseUnsettled({ limit: 2 })).map((r) => r.id).sort()).toEqual(ids.slice(0, 2).sort());
    const holder: PoolClient = await pool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM agency_inbound_calls WHERE id = $1 FOR UPDATE', [ids[2]]);
      expect((await repo.lapseUnsettled()).map((r) => r.id).sort()).toEqual(ids.slice(3).sort());
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    const [one, two] = await Promise.all([repo.lapseUnsettled(), repo.lapseUnsettled()]);
    expect([...one!, ...two!].map((r) => r.id)).toEqual([ids[2]]);
  });

  it('an outcome saved as the sweep runs: exactly one of them settles it', async () => {
    for (let round = 0; round < 10; round++) {
      const { call } = await owing(undefined, {}, new Date(Date.now() - 31 * 60_000));
      const [saved, swept] = await Promise.all([outcome(call.id), repo.lapseUnsettled()]);
      const row = (await repo.findById(T, call.id))!;
      if (saved.ok) {
        expect(swept).toEqual([]);
        expect(row.disposition_code).toBe('sale');
      } else {
        expect(swept.map((r) => r.id)).toEqual([call.id]);
        expect(row.disposition_code).toBe('no_disposition');
      }
    }
  });
});

describe('the startup sweep', () => {
  it('ends a bridged call answered and leaves its outcome owed; settles every other one', async () => {
    const live = await offered();
    await repo.connect(live.call.id, { sessionId: live.session, answeredByUserId: randomUUID() });
    const waiting = await offered();
    const queued = await arrived();
    await repo.transition(queued.id, 'queued');
    await pool().query(`UPDATE agency_inbound_calls SET arrived_at = now() - interval '1 hour'`);
    const swept = await repo.sweepStale(new Date(Date.now() - 60_000), 100);
    expect(swept.find((r) => r.id === live.call.id)).toMatchObject({ outcome: 'answered', settled_at: null });
    expect(swept.find((r) => r.id === waiting.call.id)).toMatchObject({ outcome: 'abandoned_in_queue', settled_at: expect.any(Date) });
    expect(swept.find((r) => r.id === queued.id)).toMatchObject({ outcome: 'abandoned_in_queue', settled_at: expect.any(Date) });
    expect(await repo.findUnsettledForSession(live.session)).toMatchObject({ id: live.call.id });
    expect(await repo.findUnsettledForSession(waiting.session)).toBeNull();
  });
});

describe('the busy probe (MC4, §5.4): a number with a live or owed inbound call', () => {
  async function due(campaignId: string, phones: string[]) {
    const base = Date.now() - 600_000;
    const out = [];
    for (const [i, phone_e164] of phones.entries()) {
      out.push(await insertAgencyContact(campaignId, { phone_e164, source_row_number: i + 1, next_attempt_at: new Date(base + i * 1_000) }));
    }
    return out;
  }

  it('pacing\'s claim skips the number while the call waits, is connected and owes its outcome; claims it once settled', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const [busy, free] = await due(campaign.id, ['+91 98765 00001', '+919876500002']);
    const session = randomUUID();
    const call = await arrived();
    await repo.transition(call.id, 'queued');
    expect((await contacts.claimDialable(campaign.id, 5)).map((c) => c.id)).toEqual([free!.id]);
    await repo.offer(call.id, session);
    await repo.connect(call.id, { sessionId: session, answeredByUserId: randomUUID() });
    expect(await contacts.claimDialable(campaign.id, 5)).toEqual([]);
    await repo.end(call.id, { outcome: 'answered', talkSeconds: 5, followUp: null, callbackDueAt: null, voicemailKey: null });
    expect(await contacts.claimDialable(campaign.id, 5)).toEqual([]);
    await outcome(call.id);
    expect((await contacts.claimDialable(campaign.id, 5)).map((c) => c.id)).toEqual([busy!.id]);
  });

  it('a call that ended without an agent frees the number at once; another account\'s call, a withheld one or the tenant default never holds it', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const [contact] = await due(campaign.id, [CALLER]);
    const elsewhere = await arrived({ accountId: OTHER_ACCOUNT });
    await repo.transition(elsewhere.id, 'queued');
    const withheld = await arrived({ fromE164: null });
    await repo.transition(withheld.id, 'queued');
    const tenantDefault = await arrived({ accountId: null });
    await repo.transition(tenantDefault.id, 'greeting');
    // Not admitted (refused at the route's cap, or by the shared scopes): it holds no line.
    const refused = await arrived();
    expect(refused.state).toBe('arrived');
    const gone = await arrived();
    await repo.end(gone.id, { outcome: 'closed', talkSeconds: null, followUp: { reason: 'closed', assigneeUserId: null }, callbackDueAt: null, voicemailKey: null });
    expect((await contacts.claimDialable(campaign.id, 5)).map((c) => c.id)).toEqual([contact!.id]);
  });

  it('the probe reads both partial indexes (the plan, on a large history)', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    await pool().query(
      `INSERT INTO agency_contacts (tenant_id, account_id, campaign_id, phone_e164, state, source_row_number)
       SELECT $1, $2, $3, '+4477009' || lpad(g::text, 5, '0'), 'completed', g + 100 FROM generate_series(1, 20000) g`,
      [T, A, campaign.id]);
    await pool().query(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, from_e164, to_e164, state, outcome, ended_at, settled_at)
       SELECT $1, $2, 'CA-h-' || g, '+4477009' || lpad(g::text, 5, '0'), '+14155550100', 'ended', 'closed', now(), now()
         FROM generate_series(1, 20000) g`, [T, A]);
    const [contact] = await due(campaign.id, ['+447700900001']);
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('ANALYZE agency_contacts');
      await client.query('ANALYZE agency_inbound_calls');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) SELECT c.id FROM agency_contacts c WHERE c.id = $1::uuid AND NOT ${numberLiveSql('c')}`, [contact!.id]);
      const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(plan).toMatch(/idx_agency_contacts_account_live_digits/);
      expect(plan).toMatch(/idx_agency_inbound_calls_live_from_digits/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('findBusyForNumber: the soft phone\'s read answers the oldest busy call of the account, nothing once settled', async () => {
    expect(await repo.findBusyForNumber(T, A, CALLER)).toBeNull();
    // An unadmitted call (`arrived`) holds no line: not busy.
    await arrived();
    expect(await repo.findBusyForNumber(T, A, CALLER)).toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    const first = await arrived();
    await repo.transition(first.id, 'greeting');
    await new Promise((r) => setTimeout(r, 5));
    await arrived();
    expect(await repo.findBusyForNumber(T, A, CALLER)).toMatchObject({ id: first.id });
    expect(await repo.findBusyForNumber(T, OTHER_ACCOUNT, CALLER)).toBeNull();
    expect(await repo.findBusyForNumber(T, A, '+919876500099')).toBeNull();
    expect(await repo.findBusyForNumber(T, A, 'not a number')).toBeNull();
    await pool().query(`UPDATE agency_inbound_calls SET state = 'ended', outcome = 'closed', ended_at = now(), settled_at = now()`);
    expect(await repo.findBusyForNumber(T, A, CALLER)).toBeNull();
  });
});

describe('the matched contact', () => {
  async function matchedOwing(state: string, o: Record<string, unknown> = {}) {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const contact = await insertAgencyContact(campaign.id, {
      phone_e164: CALLER, state, attempt_count: 3, our_fault_attempts: 1, last_outcome: 'no_answer',
      next_attempt_at: new Date('2026-11-20T09:00:00Z'), ...o,
    });
    const { call } = await owing(undefined, {
      identification: { match: { contactId: contact.id as string, campaignId: campaign.id as string }, callerDnc: false, sticky: null },
    });
    return { call, contactId: contact.id as string };
  }
  const row = async (id: string) => (await pool().query('SELECT * FROM agency_contacts WHERE id = $1', [id])).rows[0];
  const at = new Date('2026-11-12T09:00:00Z');

  it('pending: a callback is due at its time, a success completes, a suppress suppresses, anything else leaves it', async () => {
    const cases = [
      [{ kind: 'callback', at }, 'pending', at],
      [{ kind: 'completed' }, 'completed', new Date('2026-11-20T09:00:00Z')],
      [{ kind: 'suppressed', reason: 'dnc' }, 'suppressed', new Date('2026-11-20T09:00:00Z')],
      [{ kind: 'none' }, 'pending', new Date('2026-11-20T09:00:00Z')],
    ] as const;
    for (const [settlement, state, next] of cases) {
      const { call, contactId } = await matchedOwing('pending', { callback_source: 'inbound', callback_due_at: new Date() });
      const res = await contacts.settleFromInbound({ inboundCallId: call.id, settlement, lastDisposition: 'code_x' });
      expect(res).toMatchObject({ contactId, state, applied: 'settled' });
      const c = await row(contactId);
      expect(c).toMatchObject({
        state, next_attempt_at: next, last_outcome: 'connected', last_disposition: 'code_x',
        // Never charged: the customer rang us.
        attempt_count: 3, our_fault_attempts: 1,
        // The inbound callback is cleared: they have spoken to an agent.
        callback_source: null, callback_due_at: null,
      });
      if (state === 'suppressed') expect(c.suppressed_reason).toBe('dnc');
    }
  });

  it('exhausted: only a callback reopens it; a success or a suppress closes it; anything else leaves it exhausted', async () => {
    for (const [settlement, state] of [
      [{ kind: 'callback', at }, 'pending'],
      [{ kind: 'completed' }, 'completed'],
      [{ kind: 'suppressed', reason: 'dnc' }, 'suppressed'],
      [{ kind: 'none' }, 'exhausted'],
    ] as const) {
      const { call, contactId } = await matchedOwing('exhausted');
      expect(await contacts.settleFromInbound({ inboundCallId: call.id, settlement, lastDisposition: 'code_x' }))
        .toMatchObject({ state, applied: 'settled' });
      expect(await row(contactId)).toMatchObject({ state, attempt_count: 3 });
    }
  });

  it('in flight or connected on another call: only a suppress applies', async () => {
    for (const live of ['in_flight', 'connected']) {
      const { call, contactId } = await matchedOwing(live);
      expect(await contacts.settleFromInbound({ inboundCallId: call.id, settlement: { kind: 'callback', at }, lastDisposition: 'cb' }))
        .toMatchObject({ state: live, applied: 'unchanged' });
      expect(await row(contactId)).toMatchObject({ state: live, last_outcome: 'no_answer', last_disposition: null });
      expect(await contacts.settleFromInbound({ inboundCallId: call.id, settlement: { kind: 'suppressed', reason: 'dnc' }, lastDisposition: 'dnc' }))
        .toMatchObject({ state: 'suppressed', applied: 'suppressed' });
    }
  });

  it('completed, suppressed, or a DNC-suppressed pending row: never reopened', async () => {
    for (const [state, o] of [['completed', {}], ['suppressed', { suppressed_reason: 'invalid' }], ['pending', { suppressed_reason: 'dnc' }]] as const) {
      const { call, contactId } = await matchedOwing(state, o);
      for (const settlement of [{ kind: 'callback', at }, { kind: 'completed' }, { kind: 'suppressed', reason: 'dnc' }] as const) {
        expect(await contacts.settleFromInbound({ inboundCallId: call.id, settlement, lastDisposition: 'x' }))
          .toMatchObject({ state, applied: 'unchanged' });
      }
      expect(await row(contactId)).toMatchObject({ state, last_outcome: 'no_answer' });
    }
  });

  it('nothing for a call that matched no contact, or never bridged', async () => {
    const { call } = await owing();
    expect(await contacts.settleFromInbound({ inboundCallId: call.id, settlement: { kind: 'completed' }, lastDisposition: 'x' })).toBeNull();
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const contact = await insertAgencyContact(campaign.id, { phone_e164: CALLER });
    const unbridged = await arrived({ identification: { match: { contactId: contact.id as string, campaignId: campaign.id as string }, callerDnc: false, sticky: null } });
    expect(await contacts.settleFromInbound({ inboundCallId: unbridged.id, settlement: { kind: 'completed' }, lastDisposition: 'x' })).toBeNull();
    expect(await row(contact.id as string)).toMatchObject({ state: 'pending' });
  });

  it('unclaimUncharged: a superseded dial\'s contact back to pending now, neither ledger charged, a reopen restored', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const contact = await insertAgencyContact(campaign.id, {
      phone_e164: CALLER, state: 'in_flight', attempt_count: 2, our_fault_attempts: 1, last_outcome: 'busy',
      next_attempt_at: new Date('2026-12-01T00:00:00Z'), callback_source: 'inbound', callback_due_at: new Date(),
    });
    const before = Date.now();
    const res = await contacts.unclaimUncharged(contact.id as string, { restoreAgentReopen: true });
    expect(res).toMatchObject({ contactId: contact.id, state: 'pending' });
    expect(res!.nextAttemptAt!.getTime()).toBeLessThanOrEqual(Date.now() + 1_000);
    expect(res!.nextAttemptAt!.getTime()).toBeGreaterThan(before - 60_000);
    expect(await row(contact.id as string)).toMatchObject({
      attempt_count: 2, our_fault_attempts: 1, last_outcome: 'busy', agent_reopen_pending: true, callback_source: 'inbound',
    });
    // Not in flight any more: nothing to return.
    expect(await contacts.unclaimUncharged(contact.id as string)).toBeNull();
  });
});

describe('the supervisor floor', () => {
  it('marks a session with a live inbound call; not once it ended', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const [busy, idle] = [await insertAgentSession(campaign.id, { state: 'reserved' }), await insertAgentSession(campaign.id)];
    const { call } = await offered(busy.id as string);
    const floor = async () => Object.fromEntries((await campaignStats(campaign.id as string)).agents.map((a) => [a.session_id, a.on_inbound_call]));
    expect(await floor()).toEqual({ [busy.id as string]: true, [idle.id as string]: false });
    await repo.connect(call.id, { sessionId: busy.id as string, answeredByUserId: randomUUID() });
    expect((await floor())[busy.id as string]).toBe(true);
    await repo.end(call.id, { outcome: 'answered', talkSeconds: 3, followUp: null, callbackDueAt: null, voicemailKey: null });
    expect((await floor())[busy.id as string]).toBe(false);
  });
});

describe('the campaign\'s inbound_sticky_enabled', () => {
  it('defaults on at create, takes false, is patchable, and a retry inherits it', async () => {
    const base = { tenant_id: T, account_id: A, caller_ids: ['+919000000001'] };
    expect(await campaigns.create({ ...base, name: 'Default' })).toMatchObject({ inbound_sticky_enabled: true });
    const off = await campaigns.create({ ...base, name: 'Off', inbound_sticky_enabled: false });
    expect(off.inbound_sticky_enabled).toBe(false);
    expect(await campaigns.update(off.id, { inbound_sticky_enabled: true })).toMatchObject({ inbound_sticky_enabled: true });
    await campaigns.update(off.id, { inbound_sticky_enabled: false });
    await pool().query(`UPDATE agency_campaigns SET status = 'completed' WHERE id = $1`, [off.id]);
    await insertAgencyContact(off.id, { phone_e164: '+919876500050', state: 'exhausted' });
    const parent = (await campaigns.findById(off.id))!;
    const config = Object.fromEntries(RETRY_INHERITED_CONFIG_KEYS.map((k) => [k, (parent as unknown as Record<string, unknown>)[k]]));
    const result = await campaigns.retryFromCampaign({
      parent, selector: {}, name: 'Retry', config: config as never, createdBy: null, idempotencyKey: null,
    });
    expect(result.status).toBe('created');
    if (result.status === 'created') expect(result.campaign.inbound_sticky_enabled).toBe(false);
  });
});
