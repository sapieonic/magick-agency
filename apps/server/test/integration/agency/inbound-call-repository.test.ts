import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeKeysetCursor } from '@magick-agency/domain/keyset-cursor';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, insertTenant } from '../setup/factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyInboundCallRepository: repo } = await import('../../../src/db/repositories/agency.repository.js');
type ArrivalInput = import('../../../src/db/repositories/agency.repository.js').AgencyInboundArrivalInput;

/**
 * The inbound spine on real Postgres (docs/inbound.md §3, §7, §10; `0024_inbound.sql`): the arrival
 * with its media leg in one transaction and idempotent on the carrier's call id (concurrent
 * retries included), the guarded transitions (a terminal row never moves), the end with its
 * Missed row, the Missed list (scope, filters, keyset paging across ties, joins), mark handled
 * (idempotent, first handler kept, an agent's own rows only), and the sweep (SKIP LOCKED, a
 * bridged call ends answered).
 *
 * Mutation-checked: dropping `c.state <> 'ended'` from `end`'s WHERE lets a second end rewrite the
 * outcome; adding `ended` to `INBOUND_CALL_TRANSITIONS.queued` moves an ended row; dropping the
 * `t.follow_up_status = 'open'` arm from `markHandled` rewrites the first handler; dropping
 * `SKIP LOCKED` from the sweep's pick makes it wait on the held row; dropping `ON CONFLICT` from
 * the arrival throws on a retry.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const B = OTHER_ACCOUNT;
const pool = () => getTestPool();

let credentialId: string;
let seq = 0;

function arrival(o: Partial<ArrivalInput> = {}): ArrivalInput {
  return {
    tenantId: T,
    accountId: A,
    routeId: null,
    phoneNumberId: null,
    provider: 'plivo',
    telephonyCredentialId: credentialId,
    providerCallId: `CA-${randomUUID()}`,
    fromE164: '+919876543210',
    toE164: '+14155550100',
    identification: { match: null, callerDnc: false, sticky: null },
    answered: true,
    recordingRequested: false,
    analysisProfileId: null,
    ...o,
  };
}

async function arrived(o: Partial<ArrivalInput> = {}) {
  return (await repo.insertArrival(arrival(o))).call!;
}

/** An ended call that reached nobody (an open Missed row), arrived at `at`. */
async function missedCall(o: { at?: Date; account?: string | null; assignee?: string | null; routeId?: string | null; campaignId?: string | null } = {}) {
  const contact = o.campaignId ? { contactId: randomUUID(), campaignId: o.campaignId } : null;
  const call = await arrived({
    accountId: o.account === undefined ? A : o.account,
    routeId: o.routeId ?? null,
    identification: { match: contact, callerDnc: false, sticky: null },
  });
  if (o.at) await pool().query('UPDATE agency_inbound_calls SET arrived_at = $2 WHERE id = $1', [call.id, o.at]);
  await repo.end(call.id, {
    outcome: 'closed', talkSeconds: null, followUp: { reason: 'closed', assigneeUserId: o.assignee ?? null },
    callbackDueAt: null, voicemailKey: null,
  });
  return call.id;
}

async function legOf(id: string) {
  const { rows } = await pool().query('SELECT * FROM agency_calls WHERE inbound_call_id = $1', [id]);
  return rows;
}

beforeEach(async () => {
  await truncateAll();
  await pool().query(`INSERT INTO telephony_providers (name, display_name) VALUES ('voicelink', 'VoiceLink'), ('plivo', 'Plivo')`);
  await insertTenant({ id: T });
  credentialId = (await pool().query<{ id: string }>(
    `INSERT INTO telephony_credentials (tenant_id, provider, label, account_ref) VALUES ($1, 'plivo', 'Main', $2) RETURNING id`,
    [T, `MA${String(++seq).padStart(18, '0')}`])).rows[0]!.id;
});

afterAll(async () => {
  // 0024's Down refuses while inbound calls exist: leave none for the down → up suites.
  await truncateAll();
  await closeTestPool();
});

describe('insertArrival', () => {
  it('writes the spine row and its inbound media leg, linked both ways, in one go', async () => {
    const sticky = randomUUID();
    const contact = randomUUID();
    const campaign = randomUUID();
    const inserted = await repo.insertArrival(arrival({
      providerCallId: 'CA-1', recordingRequested: true, analysisProfileId: null,
      identification: { match: { contactId: contact, campaignId: campaign }, callerDnc: true, sticky: { userId: sticky, reason: 'owner' } },
    }));
    const { created } = inserted;
    const call = inserted.call!;
    expect(created).toBe(true);
    expect(call).toMatchObject({
      tenant_id: T, account_id: A, provider: 'plivo', provider_call_id: 'CA-1', telephony_credential_id: credentialId,
      from_e164: '+919876543210', to_e164: '+14155550100', state: 'arrived', outcome: null,
      matched_contact_id: contact, matched_campaign_id: campaign, caller_dnc: true, sticky_user_id: sticky, sticky_reason: 'owner',
    });
    expect(call.answered_at).toBeInstanceOf(Date);
    const legs = await legOf(call.id);
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({
      id: call.webrtc_call_id, origin: 'inbound', inbound_call_id: call.id, tenant_id: T, account_id: A,
      // Our number is the caller ID, the customer's is the destination, as on every leg.
      caller_id: '+14155550100', destination_phone: '+919876543210', provider: 'plivo', provider_call_id: 'CA-1',
      telephony_credential_id: credentialId, status: 'in_progress', recording_requested: true,
      campaign_id: null, agency_attempt_id: null, manual_call_id: null,
    });
    expect(legs[0].answered_at).toEqual(call.answered_at);
  });

  it('a withheld caller: no number on the spine, an empty destination on the leg', async () => {
    const call = await arrived({ fromE164: null });
    expect(call.from_e164).toBeNull();
    expect((await legOf(call.id))[0]).toMatchObject({ destination_phone: '' });
  });

  it('refused with a hangup: not answered, the leg never went live', async () => {
    const call = await arrived({ answered: false });
    expect(call.answered_at).toBeNull();
    expect((await legOf(call.id))[0]).toMatchObject({ status: 'initiating', answered_at: null });
  });

  it('the tenant default (no account) has no leg', async () => {
    const call = await arrived({ accountId: null });
    expect(call).toMatchObject({ account_id: null, webrtc_call_id: null });
    expect(await legOf(call.id)).toEqual([]);
  });

  it('a credential that stopped being active still records the call (it is answered regardless, §10)', async () => {
    await pool().query(`UPDATE telephony_credentials SET status = 'disabled' WHERE id = $1`, [credentialId]);
    const call = await arrived();
    expect(await legOf(call.id)).toHaveLength(1);
  });

  it('is idempotent on the carrier\'s call id: a retry, even a concurrent one, writes nothing more', async () => {
    const first = await repo.insertArrival(arrival({ providerCallId: 'CA-retry' }));
    const again = await repo.insertArrival(arrival({ providerCallId: 'CA-retry', fromE164: '+14155550199' }));
    expect(again).toEqual({ created: false, call: first.call });
    const racing = await Promise.all([1, 2, 3].map(() => repo.insertArrival(arrival({ providerCallId: 'CA-race' }))));
    expect(racing.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(racing.map((r) => r.call!.id)).size).toBe(1);
    const { rows } = await pool().query(`SELECT count(*)::int AS n FROM agency_calls WHERE provider_call_id = 'CA-race'`);
    expect(rows[0].n).toBe(1);
    expect((await repo.findByProviderCallId('plivo', 'CA-race'))!.id).toBe(racing[0]!.call!.id);
    expect(await repo.findByProviderCallId('voicelink', 'CA-race')).toBeNull();
  });

  it('joins the caller\'s transaction: a rollback takes the spine row and the leg', async () => {
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await repo.insertArrival(arrival({ providerCallId: 'CA-tx' }), { client });
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await repo.findByProviderCallId('plivo', 'CA-tx')).toBeNull();
    expect((await pool().query(`SELECT 1 FROM agency_calls WHERE provider_call_id = 'CA-tx'`)).rowCount).toBe(0);
  });
});

describe('the lifecycle', () => {
  it('moves along the transition map, back from offered to queued, and stamps the bridge once', async () => {
    const call = await arrived();
    const agent = randomUUID();
    const session = randomUUID();
    expect((await repo.transition(call.id, 'greeting'))!.state).toBe('greeting');
    expect((await repo.transition(call.id, 'queued'))!.state).toBe('queued');
    expect((await repo.offer(call.id, session)).ok).toBe(true);
    // The station was lost before audio bound: back to the queue (§5.1).
    expect((await repo.requeue(call.id, session))!.state).toBe('queued');
    expect(await repo.transition(call.id, 'greeting')).toBeNull(); // never back to the greeting
    expect(await repo.connect(call.id, { sessionId: session, answeredByUserId: agent })).toBeNull(); // only from offered
    await repo.offer(call.id, session);
    const at = new Date('2026-11-09T10:00:00Z');
    const connected = await repo.connect(call.id, { sessionId: session, answeredByUserId: agent, at });
    expect(connected).toMatchObject({ state: 'connected', bridged_at: at, answered_by_user_id: agent });
    expect(await repo.transition(randomUUID(), 'greeting')).toBeNull();
  });

  it('end: once. A terminal row never moves, whatever comes after', async () => {
    const call = await arrived();
    await repo.transition(call.id, 'greeting');
    const sticky = randomUUID();
    const due = new Date('2026-11-10T09:00:00Z');
    const ended = await repo.end(call.id, {
      outcome: 'overflow', talkSeconds: null, followUp: { reason: 'overflow', assigneeUserId: sticky },
      callbackDueAt: null, voicemailKey: null, endedAt: new Date('2026-11-09T18:00:00Z'),
    });
    expect(ended).toMatchObject({
      ended: true,
      call: { state: 'ended', outcome: 'overflow', follow_up_status: 'open', follow_up_reason: 'overflow',
        follow_up_assignee_user_id: sticky, ended_at: new Date('2026-11-09T18:00:00Z') },
    });
    const second = await repo.end(call.id, {
      outcome: 'abandoned_in_queue', talkSeconds: 5, followUp: null, callbackDueAt: due, voicemailKey: 'vm',
    });
    expect(second).toEqual({ ended: false, call: ended.call });
    for (const to of ['greeting', 'queued'] as const) expect(await repo.transition(call.id, to)).toBeNull();
    expect(await repo.offer(call.id, randomUUID())).toEqual({ ok: false, reason: 'not_offerable' });
    expect(await repo.findById(T, call.id)).toEqual(ended.call);
    expect(await repo.end(randomUUID(), { outcome: 'failed', talkSeconds: null, followUp: null, callbackDueAt: null, voicemailKey: null }))
      .toEqual({ ended: false, call: null });
  });

  it('an answered end needs the bridge (the CHECK refuses the contradiction rather than the repository coercing it)', async () => {
    const call = await arrived();
    await expect(repo.end(call.id, { outcome: 'answered', talkSeconds: 30, followUp: null, callbackDueAt: null, voicemailKey: null }))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_inbound_calls_bridged' });
    const agent = randomUUID();
    const session = randomUUID();
    await repo.offer(call.id, session);
    await repo.connect(call.id, { sessionId: session, answeredByUserId: agent });
    expect(await repo.end(call.id, { outcome: 'answered', talkSeconds: 30, followUp: null, callbackDueAt: null, voicemailKey: null }))
      .toMatchObject({ ended: true, call: { outcome: 'answered', talk_seconds: 30, follow_up_status: null } });
  });

  it('records the callback it booked on the matched contact', async () => {
    const call = await arrived({ identification: { match: { contactId: randomUUID(), campaignId: randomUUID() }, callerDnc: false, sticky: null } });
    const due = new Date('2026-11-10T09:00:00Z');
    expect(await repo.end(call.id, { outcome: 'closed', talkSeconds: null, followUp: { reason: 'closed', assigneeUserId: null }, callbackDueAt: due, voicemailKey: null }))
      .toMatchObject({ ended: true, call: { callback_due_at: due } });
  });

  it('findById is the tenant\'s only', async () => {
    const call = await arrived();
    expect(await repo.findById(T, call.id)).toMatchObject({ id: call.id });
    expect(await repo.findById(randomUUID(), call.id)).toBeNull();
  });
});

describe('the Missed inbound list', () => {
  it('the account\'s rows of one status, newest first, with the route and campaign names; nothing else', async () => {
    const routeId = (await pool().query<{ id: string }>(
      `INSERT INTO agency_inbound_routes (tenant_id, account_id, name, timezone) VALUES ($1, $2, 'Main line', 'UTC') RETURNING id`, [T, A])).rows[0]!.id;
    const campaignId = (await pool().query<{ id: string }>(
      `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids) VALUES ($1, $2, 'Renewals', ARRAY['+14155550100']) RETURNING id`, [T, A])).rows[0]!.id;
    const older = await missedCall({ at: new Date('2026-11-09T09:00:00Z') });
    const newer = await missedCall({ at: new Date('2026-11-09T10:00:00Z'), routeId, campaignId });
    await missedCall({ account: B });
    await missedCall({ account: null });
    const answered = await arrived(); // never a Missed row
    void answered;
    const live = await arrived(); // not ended
    void live;

    const page = await repo.listMissed({ tenantId: T, accountId: A, status: 'open', limit: 50 });
    expect(page.rows.map((r) => r.id)).toEqual([newer, older]);
    expect(page.rows[0]).toMatchObject({ route_name: 'Main line', matched_campaign_name: 'Renewals', follow_up_status: 'open', follow_up_reason: 'closed' });
    expect(page.rows[1]).toMatchObject({ route_name: null, matched_campaign_name: null });
    expect(page.next_cursor).toBeNull();
    expect((await repo.listMissed({ tenantId: T, accountId: A, status: 'handled', limit: 50 })).rows).toEqual([]);
    // The tenant default's rows are their own list, never every account's.
    expect((await repo.listMissed({ tenantId: T, accountId: null, status: 'open', limit: 50 })).rows).toHaveLength(1);
    expect((await repo.listMissed({ tenantId: randomUUID(), accountId: A, status: 'open', limit: 50 })).rows).toEqual([]);
  });

  it('filters by assignee (one user, or the unassigned) and by arrival window [from, to)', async () => {
    const agent = randomUUID();
    const mine = await missedCall({ assignee: agent, at: new Date('2026-11-09T09:00:00Z') });
    const nobodys = await missedCall({ at: new Date('2026-11-09T10:00:00Z') });
    await missedCall({ assignee: randomUUID(), at: new Date('2026-11-09T11:00:00Z') });
    const ids = async (o: object) => (await repo.listMissed({ tenantId: T, accountId: A, status: 'open', limit: 50, ...o })).rows.map((r) => r.id);
    expect(await ids({ assignee: { userId: agent } })).toEqual([mine]);
    expect(await ids({ assignee: 'unassigned' })).toEqual([nobodys]);
    expect(await ids({ from: new Date('2026-11-09T09:00:00Z'), to: new Date('2026-11-09T10:00:00Z') })).toEqual([mine]);
    expect(await ids({ from: new Date('2026-11-09T10:00:00Z') })).toHaveLength(2);
  });

  it('pages by keyset across rows that share an arrival instant, never skipping or repeating one', async () => {
    const at = new Date('2026-11-09T09:00:00Z');
    const all: string[] = [];
    for (let i = 0; i < 7; i++) all.push(await missedCall({ at }));
    await pool().query(`UPDATE agency_inbound_calls SET arrived_at = arrived_at + interval '123 microseconds' WHERE id = $1`, [all[0]]);
    const seen: string[] = [];
    let after;
    for (let guard = 0; guard < 10; guard++) {
      const page = await repo.listMissed({ tenantId: T, accountId: A, status: 'open', limit: 3, ...(after ? { after } : {}) });
      seen.push(...page.rows.map((r) => r.id));
      if (!page.next_cursor) break;
      after = decodeKeysetCursor(page.next_cursor)!;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(all));
    expect(seen[0]).toBe(all[0]); // the microsecond-later row is newest
  });

  it('mark handled: idempotent, the first handler and time kept; an agent only on their own rows', async () => {
    const agent = randomUUID();
    const id = await missedCall({ assignee: agent });
    const supervisor = randomUUID();
    expect(await repo.markHandled({ tenantId: T, accountId: A, id, userId: randomUUID(), onlyAssignee: randomUUID() })).toBeNull();
    const first = await repo.markHandled({ tenantId: T, accountId: A, id, userId: supervisor });
    expect(first).toMatchObject({ changed: true, call: { id, follow_up_status: 'handled', handled_by_user_id: supervisor } });
    expect(first!.call.handled_at).toBeInstanceOf(Date);
    const again = await repo.markHandled({ tenantId: T, accountId: A, id, userId: agent, onlyAssignee: agent });
    expect(again).toEqual({ changed: false, call: first!.call });
    expect((await repo.listMissed({ tenantId: T, accountId: A, status: 'handled', limit: 50 })).rows.map((r) => r.id)).toEqual([id]);
    // Another account, or a call that is not a Missed row: nothing to mark.
    expect(await repo.markHandled({ tenantId: T, accountId: B, id, userId: supervisor })).toBeNull();
    const notMissed = await arrived();
    expect(await repo.markHandled({ tenantId: T, accountId: A, id: notMissed.id, userId: supervisor })).toBeNull();
    expect(await repo.findMissed(T, A, notMissed.id)).toBeNull();
    expect(await repo.findMissed(T, A, id)).toMatchObject({ id, follow_up_status: 'handled' });
  });

  it('two people marking one row at once: one handler wins, the other is told it was already handled', async () => {
    const id = await missedCall();
    const [x, y] = [randomUUID(), randomUUID()];
    const outs = await Promise.all([x, y].map((userId) => repo.markHandled({ tenantId: T, accountId: A, id, userId })));
    expect(outs.map((o) => o!.changed).sort()).toEqual([false, true]);
    const winner = outs.find((o) => o!.changed)!.call.handled_by_user_id;
    expect(outs.every((o) => o!.call.handled_by_user_id === winner)).toBe(true);
  });
});

describe('the sweep (§10)', () => {
  it('ends the calls left non-terminal before the cutoff: failed (we lost them, QA-F9) with a Missed row for its sticky agent, or answered once bridged', async () => {
    const old = new Date(Date.now() - 3_600_000);
    const sticky = randomUUID();
    const waiting = await arrived({ identification: { match: null, callerDnc: false, sticky: { userId: sticky, reason: 'owner' } } });
    await repo.transition(waiting.id, 'queued');
    const nobody = await arrived();
    const bridged = await arrived();
    const session = randomUUID();
    await repo.offer(bridged.id, session);
    await repo.connect(bridged.id, { sessionId: session, answeredByUserId: randomUUID() });
    const recent = await arrived();
    const done = await missedCall();
    // Started before the cutoff: arrived, and bridged (the bind re-arms the call's max duration).
    await pool().query(`UPDATE agency_inbound_calls SET arrived_at = $1::timestamptz, bridged_at = CASE WHEN bridged_at IS NULL THEN NULL ELSE $1::timestamptz END WHERE id <> $2`, [old, recent.id]);

    const swept = await repo.sweepStale(new Date(Date.now() - 60_000), 100);
    expect(swept.map((r) => r.id).sort()).toEqual([waiting.id, nobody.id, bridged.id].sort());
    expect(swept.find((r) => r.id === waiting.id)).toMatchObject({
      state: 'ended', outcome: 'failed', follow_up_status: 'open', follow_up_reason: 'failed',
      follow_up_assignee_user_id: sticky,
    });
    expect(swept.find((r) => r.id === nobody.id)).toMatchObject({ outcome: 'failed', follow_up_assignee_user_id: null });
    expect(swept.find((r) => r.id === bridged.id)).toMatchObject({ outcome: 'answered', follow_up_status: null });
    expect((await repo.findById(T, recent.id))!.state).toBe('arrived');
    expect((await repo.findById(T, done))!.follow_up_reason).toBe('closed');
    expect(await repo.sweepStale(new Date(), 100)).toHaveLength(1); // only `recent` is left
  });

  it('takes at most `limit`, oldest first; skips a row another writer holds; two sweeps never end one call twice', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const c = await arrived();
      await pool().query(`UPDATE agency_inbound_calls SET arrived_at = $2 WHERE id = $1`, [c.id, new Date(Date.UTC(2026, 10, 9, 9, i))]);
      ids.push(c.id);
    }
    const cutoff = new Date('2026-11-10T00:00:00Z');
    expect((await repo.sweepStale(cutoff, 2)).map((r) => r.id)).toEqual(ids.slice(0, 2));
    const holder = await pool().connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM agency_inbound_calls WHERE id = $1 FOR UPDATE', [ids[2]]);
      const swept = await repo.sweepStale(cutoff, 100);
      expect(swept.map((r) => r.id)).toEqual(ids.slice(3));
      await holder.query('ROLLBACK');
    } finally {
      holder.release();
    }
    const [one, two] = await Promise.all([repo.sweepStale(cutoff, 100), repo.sweepStale(cutoff, 100)]);
    expect([...one!, ...two!].map((r) => r.id)).toEqual([ids[2]]);
  });
});
