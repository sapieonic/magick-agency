import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENCY_REDIALED_DISPOSITION_CODE } from '@magick-agency/contracts/agency';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, insertTenant } from '../setup/factories.js';
import { AUTO_DISPOSITION_CODE } from '../../../src/agency/disposition.js';
import { VOICEMAIL_DISPOSITION_CODE } from '../../../src/db/repositories/agency/sql-fragments.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyInboundCallRepository: repo } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * A Missed inbound row and the customer being reached (docs/inbound.md §7; 0030), on real Postgres:
 *
 *  - the no-contact codes 0030's triggers spell are the server's own constants
 *    (`VOICEMAIL_DISPOSITION_CODE`, `AUTO_DISPOSITION_CODE`, `AGENCY_REDIALED_DISPOSITION_CODE`):
 *    each written on a conversation leaves the row open, a person-reached code closes it, so a
 *    renamed constant turns this red;
 *  - Reopen (`reopenMissed`): a handled row back to `open` with its reason, handler and time
 *    cleared and its assignee kept, how it had been handled answered for the audit; idempotent; an
 *    agent's own rows only; nothing of another account's;
 *  - Reopen beside a Mark handled, at the same instant: the row lock orders them and the second
 *    re-reads what the first wrote. Reopen beside a reached close: the row ends open in either
 *    order (a close that starts while the row is handled passes it over; a reopen after a close
 *    reopens it), so the person's reopen stands. Every write stays whole (the CHECKs never trip).
 *
 * Mutation-checked: dropping `t.follow_up_status = 'handled'` from `reopenMissed`'s UPDATE makes a
 * reopen of an open row report `changed` (the idempotency case goes red); dropping its assignee
 * condition lets an agent reopen another's row; dropping `voicemail` from 0030's attempt trigger
 * WHEN closes the row on a voicemail outcome.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const B = OTHER_ACCOUNT;
const CALLER = '+447700900123';
const pool = () => getTestPool();

let credentialId: string;
let seq = 0;

/** An ended call from `from` that reached nobody: an open Missed row of `account`, assigned to `assignee`. */
async function missedCall(o: { account?: string; assignee?: string | null; from?: string } = {}): Promise<string> {
  const call = (await repo.insertArrival({
    tenantId: T, accountId: o.account ?? A, routeId: null, phoneNumberId: null, provider: 'plivo', telephonyCredentialId: credentialId,
    providerCallId: `CA-${randomUUID()}`, fromE164: o.from ?? CALLER, toE164: '+14155550100',
    identification: { match: null, callerDnc: false, sticky: null }, answered: true, recordingRequested: false, analysisProfileId: null,
  })).call!;
  await pool().query('UPDATE agency_inbound_calls SET arrived_at = now() - interval \'1 hour\' WHERE id = $1', [call.id]);
  await repo.end(call.id, {
    outcome: 'closed', talkSeconds: null, followUp: { reason: 'closed', assigneeUserId: o.assignee ?? null },
    callbackDueAt: null, voicemailKey: null,
  });
  return call.id;
}

async function followUp(id: string) {
  const { rows } = await pool().query(
    'SELECT follow_up_status, handled_reason, handled_by_user_id, follow_up_assignee_user_id FROM agency_inbound_calls WHERE id = $1', [id]);
  return rows[0] as { follow_up_status: string; handled_reason: string | null; handled_by_user_id: string | null; follow_up_assignee_user_id: string | null };
}

/** A campaign attempt to the caller, put through to `agent`, ended and owing its outcome. */
async function conversation(agent: string): Promise<string> {
  const campaign = (await pool().query<{ id: string }>(
    `INSERT INTO agency_campaigns (tenant_id, account_id, name, caller_ids) VALUES ($1, $2, 'C', ARRAY['+14155550100']) RETURNING id`, [T, A])).rows[0]!.id;
  const contact = (await pool().query<{ id: string }>(
    'INSERT INTO agency_contacts (campaign_id, tenant_id, account_id, phone_e164) VALUES ($1, $2, $3, $4) RETURNING id', [campaign, T, A, CALLER])).rows[0]!.id;
  const session = (await pool().query<{ id: string }>(
    'INSERT INTO agency_agent_sessions (campaign_id, tenant_id, account_id, agent_user_id) VALUES ($1, $2, $3, $4) RETURNING id',
    [campaign, T, A, agent])).rows[0]!.id;
  return (await pool().query<{ id: string }>(
    `INSERT INTO agency_call_attempts (campaign_id, contact_id, tenant_id, account_id, attempt_number, caller_id, state, reserved_agent_id,
                                       dialed_at, bridged_at, ended_at)
     VALUES ($1, $2, $3, $4, 1, '+14155550100', 'ended', $5, now() - interval '2 minutes', now() - interval '1 minute', now()) RETURNING id`,
    [campaign, contact, T, A, session])).rows[0]!.id;
}

const writeOutcome = (attemptId: string, code: string, db: Pick<PoolClient, 'query'> = pool()) =>
  db.query('UPDATE agency_call_attempts SET disposition_code = $2, dispositioned_at = now() WHERE id = $1', [attemptId, code]);

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

describe('the outcome that closes a Missed row (0030), by the server`s own codes', () => {
  it('voicemail, a lapse and a redial`s hand-off leave it open; a person-reached outcome closes it as the agent', async () => {
    expect([VOICEMAIL_DISPOSITION_CODE, AUTO_DISPOSITION_CODE, AGENCY_REDIALED_DISPOSITION_CODE]).toEqual(['voicemail', 'no_disposition', 'redialed']);
    const row = await missedCall();
    for (const code of [VOICEMAIL_DISPOSITION_CODE, AUTO_DISPOSITION_CODE, AGENCY_REDIALED_DISPOSITION_CODE]) {
      await writeOutcome(await conversation(randomUUID()), code);
      expect((await followUp(row)).follow_up_status, code).toBe('open');
    }
    const agent = randomUUID();
    await writeOutcome(await conversation(agent), 'callback');
    expect(await followUp(row)).toMatchObject({ follow_up_status: 'handled', handled_reason: 'reached', handled_by_user_id: agent });
  });
});

describe('reopenMissed', () => {
  it('puts a handled row back to open, clears how it was handled, keeps the assignee, and says how it had been handled', async () => {
    const agent = randomUUID();
    const person = randomUUID();
    const row = await missedCall({ assignee: agent });
    await repo.markHandled({ tenantId: T, accountId: A, id: row, userId: person });
    const reopened = await repo.reopenMissed({ tenantId: T, accountId: A, id: row });
    expect(reopened).toMatchObject({
      changed: true,
      previous: { reason: 'marked', handledByUserId: person, handledAt: expect.any(Date) },
      call: { id: row, follow_up_status: 'open', handled_reason: null, handled_by_user_id: null, handled_at: null, follow_up_assignee_user_id: agent },
    });
    // Idempotent: an open row is answered as it is.
    expect(await repo.reopenMissed({ tenantId: T, accountId: A, id: row })).toMatchObject({
      changed: false, previous: null, call: { follow_up_status: 'open' },
    });
  });

  it('an agent`s own rows only; another account`s, a call that is not a Missed row, or no such row: null', async () => {
    const agent = randomUUID();
    const theirs = await missedCall({ assignee: randomUUID() });
    const inB = await missedCall({ account: B, assignee: agent });
    for (const id of [theirs, inB]) await pool().query(
      `UPDATE agency_inbound_calls SET follow_up_status = 'handled', handled_reason = 'marked', handled_at = now() WHERE id = $1`, [id]);
    expect(await repo.reopenMissed({ tenantId: T, accountId: A, id: theirs, onlyAssignee: agent })).toBeNull();
    expect(await repo.reopenMissed({ tenantId: T, accountId: A, id: inB })).toBeNull();
    expect(await repo.reopenMissed({ tenantId: T, accountId: A, id: randomUUID() })).toBeNull();
    for (const id of [theirs, inB]) expect((await followUp(id)).follow_up_status).toBe('handled');
    const mine = await missedCall({ assignee: agent });
    await pool().query(`UPDATE agency_inbound_calls SET follow_up_status = 'handled', handled_reason = 'reached', handled_at = now() WHERE id = $1`, [mine]);
    expect(await repo.reopenMissed({ tenantId: T, accountId: A, id: mine, onlyAssignee: agent })).toMatchObject({ changed: true, previous: { reason: 'reached' } });
  });
});

describe('Reopen beside another write to the row, at the same instant', () => {
  /** Run `first` in a transaction holding the row, start `second` on the pool, commit, and wait for both. */
  async function race<T1, T2>(first: (c: PoolClient) => Promise<T1>, second: () => Promise<T2>): Promise<[T1, T2]> {
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      const one = await first(client);
      const waiting = second();
      await new Promise((r) => setTimeout(r, 200));
      await client.query('COMMIT');
      return [one, await waiting];
    } finally {
      client.release();
    }
  }

  it('a reopen holding the row, then a Mark handled: the mark waits, finds it open, and marks it', async () => {
    const person = randomUUID();
    const row = await missedCall();
    await repo.markHandled({ tenantId: T, accountId: A, id: row, userId: randomUUID() });
    const [reopened, marked] = await race(
      (c) => repo.reopenMissed({ tenantId: T, accountId: A, id: row }, { client: c }),
      () => repo.markHandled({ tenantId: T, accountId: A, id: row, userId: person }),
    );
    expect(reopened?.changed).toBe(true);
    expect(marked?.changed).toBe(true);
    expect(await followUp(row)).toMatchObject({ follow_up_status: 'handled', handled_reason: 'marked', handled_by_user_id: person });
  });

  it('a Mark handled holding the row, then a reopen: the reopen waits, finds it handled, and reopens it', async () => {
    const row = await missedCall();
    const [marked, reopened] = await race(
      (c) => repo.markHandled({ tenantId: T, accountId: A, id: row, userId: randomUUID() }, { client: c }),
      () => repo.reopenMissed({ tenantId: T, accountId: A, id: row }),
    );
    expect(marked?.changed).toBe(true);
    expect(reopened).toMatchObject({ changed: true, previous: { reason: 'marked' } });
    expect((await followUp(row)).follow_up_status).toBe('open');
  });

  it('a reopen holding the row, then the customer reached: the close passes the row over (handled when it looked), so it ends open', async () => {
    const agent = randomUUID();
    const row = await missedCall();
    await pool().query(`UPDATE agency_inbound_calls SET follow_up_status = 'handled', handled_reason = 'marked', handled_at = now() WHERE id = $1`, [row]);
    const attempt = await conversation(agent);
    await race(
      (c) => repo.reopenMissed({ tenantId: T, accountId: A, id: row }, { client: c }),
      () => writeOutcome(attempt, 'callback'),
    );
    // The close's UPDATE matches open rows in its snapshot, where this one was still handled: it
    // neither waits nor closes. The person's reopen stands, as it does in the other order.
    expect(await followUp(row)).toMatchObject({ follow_up_status: 'open', handled_reason: null, handled_by_user_id: null });
    expect((await pool().query('SELECT disposition_code FROM agency_call_attempts WHERE id = $1', [attempt])).rows[0]).toEqual({ disposition_code: 'callback' });
    // The next conversation closes it, as any open row.
    const next = randomUUID();
    await writeOutcome(await conversation(next), 'callback');
    expect(await followUp(row)).toMatchObject({ follow_up_status: 'handled', handled_reason: 'reached', handled_by_user_id: next });
  });

  it('the customer reached holding the row, then a reopen: the reopen waits and reopens what the close wrote', async () => {
    const agent = randomUUID();
    const row = await missedCall();
    const attempt = await conversation(agent);
    const [, reopened] = await race(
      (c) => writeOutcome(attempt, 'callback', c),
      () => repo.reopenMissed({ tenantId: T, accountId: A, id: row }),
    );
    expect(reopened).toMatchObject({ changed: true, previous: { reason: 'reached', handledByUserId: agent } });
    expect(await followUp(row)).toMatchObject({ follow_up_status: 'open', handled_reason: null, handled_by_user_id: null });
  });
});
