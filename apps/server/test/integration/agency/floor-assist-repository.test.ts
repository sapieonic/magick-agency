import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { AGENCY_HELP_EXPIRY_MS, type AgencyAgentState } from '@magick-agency/contracts/agency';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT } from '../setup/factories.js';
import {
  insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession, insertManualCall, insertSoftphoneSession,
} from './agency-factories.js';

/** A client to run the repository's next statement on, in a transaction the test holds; else the pool. */
const pinned = vi.hoisted(() => ({ client: null as null | import('pg').PoolClient }));

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => pinned.client ?? getTestPool(),
}));

const {
  agencyFloorAssistRepository: repo, agencyFloorRepository, SWEEP_EXPIRED_SQL, LIVE_CALL_FOR_SESSION_SQL, HELP_SWEEP_BATCH,
} = await import('../../../src/db/repositories/agency.repository.js');
const { registerFloorRoutes, clearFloorCallsTodayCacheForTests } = await import('../../../src/api/routes/agency/floor.js');

/**
 * Floor assist's SQL on a real Postgres (`floor-assist.repository.ts`, `0052_floor_assist.sql`; LF4,
 * LF5): a Need help request raised, raised again (idempotent), answered, cancelled, ended with its
 * session and expired, each exactly once, also when several race for the same request; the 15-minute
 * expiry at its edge, against the database's clock (rows backdated: a fake clock on `now()`); the
 * floor's read of an account's open requests (never another account's, another tenant's, a left
 * session's, an answered or an expired one) and the internal floor handler's `help`; the call a
 * request is raised on, on each spine; messages; and the plans on their indexes.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();
const EXPIRY = AGENCY_HELP_EXPIRY_MS;

beforeEach(async () => {
  await truncateAll();
  clearFloorCallsTodayCacheForTests();
});
afterAll(closeTestPool);

interface Session { id: string; tenant_id: string; account_id: string; agent_user_id: string; campaign_id: string | null }

async function session(over: Record<string, unknown> = {}): Promise<Session> {
  const campaign = await insertAgencyCampaign({ status: 'running', ...(over['tenant_id'] ? { tenant_id: over['tenant_id'] } : {}), ...(over['account_id'] ? { account_id: over['account_id'] } : {}) });
  return await insertAgentSession(campaign.id as string, { state: 'on_call', ...over }) as unknown as Session;
}

/** The sessions the account's floor rows carry an open Need help on (`FLOOR_ROWS_SQL`, the expiry applied in the read). */
async function floorHelp(tenantId: string, accountId: string): Promise<string[]> {
  const rows = await agencyFloorRepository.floorRows(tenantId, accountId, new Date(Date.now() - 3_600_000));
  return rows.flatMap((r) => (r.help_raised_at !== null && r.session_id !== null ? [r.session_id] : []));
}

const raise = (s: Session, callId: string | null = null, state: AgencyAgentState = 'on_call') =>
  repo.raise({ sessionId: s.id, tenantId: s.tenant_id, accountId: s.account_id, callId, state, expiryMs: EXPIRY });

/** Move the session's raise `ms` into the past (the database's clock is the expiry's). */
async function backdate(s: Session, ms: number): Promise<Date> {
  const { rows } = await pool().query<{ help_raised_at: Date }>(
    `UPDATE agency_agent_sessions SET help_raised_at = now() - $2::bigint * interval '1 millisecond' WHERE id = $1 RETURNING help_raised_at`,
    [s.id, ms]);
  return rows[0]!.help_raised_at;
}

/** Until `n` backends of this database wait on a lock. */
async function waitForLockWaiters(n: number): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const { rows } = await pool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND datname = current_database()`);
    if (rows[0]!.n >= n) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`fewer than ${n} backends ever waited on a lock`);
}

async function row(s: Session) {
  const { rows } = await pool().query(
    'SELECT help_raised_at, help_call_id, help_answered_at, help_answered_by, help_state FROM agency_agent_sessions WHERE id = $1', [s.id]);
  return rows[0] as {
    help_raised_at: Date | null; help_call_id: string | null; help_answered_at: Date | null; help_answered_by: string | null;
    help_state: AgencyAgentState | null;
  };
}

describe('raise', () => {
  it('raises on the session, with its call; raising again while open answers the same request (idempotent)', async () => {
    const s = await session();
    const call = randomUUID();
    const first = await raise(s, call);
    expect(first).toMatchObject({ raised: true, help: { session_id: s.id, call_id: call }, expired: null });
    const again = await raise(s, randomUUID());
    expect(again).toMatchObject({ raised: false, help: { session_id: s.id, call_id: call }, expired: null });
    expect(again.help!.raised_at.getTime()).toBe(first.help!.raised_at.getTime());
    expect(await row(s)).toMatchObject({ help_call_id: call, help_answered_at: null, help_answered_by: null });
  });

  it('two raises at once: one raises, the other answers the same open request', async () => {
    const s = await session();
    const both = await Promise.all([raise(s), raise(s), raise(s)]);
    expect(both.filter((r) => r.raised)).toHaveLength(1);
    expect(new Set(both.map((r) => r.help!.raised_at.getTime())).size).toBe(1);
  });

  it('after an answer a new raise is a new request: the answer is cleared', async () => {
    const s = await session();
    await raise(s);
    expect(await repo.answer(s.id, T, randomUUID(), EXPIRY)).toMatchObject({ expired: false });
    const next = await raise(s);
    expect(next).toMatchObject({ raised: true, expired: null });
    expect(await row(s)).toMatchObject({ help_answered_at: null, help_answered_by: null });
  });

  it('never on a session that has left, nor across tenants or accounts', async () => {
    const left = await session({ left_at: new Date(), state: 'offline' });
    expect(await raise(left)).toEqual({ raised: false, help: null, expired: null });
    const s = await session();
    expect(await repo.raise({ sessionId: s.id, tenantId: OTHER_TENANT, accountId: A, callId: null, state: 'on_call', expiryMs: EXPIRY }))
      .toEqual({ raised: false, help: null, expired: null });
    expect(await repo.raise({ sessionId: s.id, tenantId: T, accountId: OTHER_ACCOUNT, callId: null, state: 'on_call', expiryMs: EXPIRY }))
      .toEqual({ raised: false, help: null, expired: null });
    expect((await row(s)).help_raised_at).toBeNull();
  });

  it('a request past the expiry is expired by the raise, in the same statement (returned once, as it was), and a new one raised', async () => {
    const s = await session();
    const call = randomUUID();
    await raise(s, call);
    const old = await backdate(s, EXPIRY + 1_000);
    const out = await raise(s);
    expect(out.raised).toBe(true);
    expect(out.expired).toEqual({
      session_id: s.id, tenant_id: T, account_id: A, campaign_id: s.campaign_id, agent_user_id: s.agent_user_id,
      raised_at: old, call_id: call, state: 'on_call',
    });
    expect(out.help!.raised_at.getTime()).toBeGreaterThan(old.getTime());
    expect(await repo.expireDue(EXPIRY)).toEqual([]);
  });
});

describe('the 15-minute expiry, against the database clock', () => {
  it('a second before it the request is open (floor, sweep); at it, it is not, and the sweep clears it once with what it held', async () => {
    const s = await session();
    const call = randomUUID();
    await raise(s, call);
    const raisedAt = await backdate(s, EXPIRY - 2_000);
    expect(await floorHelp(T, A)).toEqual([s.id]);
    expect(await repo.expireDue(EXPIRY)).toEqual([]);
    await backdate(s, EXPIRY + 1_000);
    const expiredAt = (await row(s)).help_raised_at!;
    expect(await floorHelp(T, A)).toEqual([]);
    expect(await repo.openForSession(s.id, T, A, EXPIRY)).toBeNull();
    const swept = await repo.expireDue(EXPIRY);
    expect(swept).toEqual([{
      session_id: s.id, tenant_id: T, account_id: A, campaign_id: s.campaign_id, agent_user_id: s.agent_user_id,
      raised_at: expiredAt, call_id: call, state: 'on_call',
    }]);
    expect(raisedAt.getTime()).toBeGreaterThan(expiredAt.getTime());
    expect(await row(s)).toEqual({ help_raised_at: null, help_call_id: null, help_answered_at: null, help_answered_by: null, help_state: null });
    expect(await repo.expireDue(EXPIRY)).toEqual([]);
  });

  it('past it, an answer, a cancel or the session ending expires the request instead (expired, with what it held), and only the first', async () => {
    for (const first of ['answer', 'cancel', 'end'] as const) {
      const s = await session();
      const call = randomUUID();
      await raise(s, call);
      const expiredAt = await backdate(s, EXPIRY + 1_000);
      const transitions = {
        answer: () => repo.answer(s.id, T, randomUUID(), EXPIRY),
        cancel: () => repo.cancel(s.id, T, EXPIRY),
        end: () => repo.endWithSession(s.id, EXPIRY),
      };
      expect(await transitions[first](), first).toEqual({
        session_id: s.id, tenant_id: T, account_id: A, campaign_id: s.campaign_id, agent_user_id: s.agent_user_id,
        raised_at: expiredAt, call_id: call, state: 'on_call', expired: true, ...(first === 'answer' ? { answered_at: null } : {}),
      });
      expect(await row(s), first).toEqual({ help_raised_at: null, help_call_id: null, help_answered_at: null, help_answered_by: null, help_state: null });
      for (const next of Object.values(transitions)) expect(await next(), first).toBeNull();
      expect(await repo.expireDue(EXPIRY), first).toEqual([]);
    }
  });

  it('a transition on one session expires only that session; the sweep pages through more than a batch', async () => {
    const sessions = await Promise.all(Array.from({ length: HELP_SWEEP_BATCH + 3 }, () => session()));
    await pool().query(
      `UPDATE agency_agent_sessions SET help_raised_at = now() - interval '16 minutes' WHERE id = ANY($1::uuid[])`,
      [sessions.map((s) => s.id)]);
    expect(await repo.cancel(sessions[0]!.id, T, EXPIRY)).toMatchObject({ session_id: sessions[0]!.id, expired: true });
    const swept = await repo.expireDue(EXPIRY);
    expect(swept).toHaveLength(HELP_SWEEP_BATCH + 2);
    expect(new Set(swept.map((r) => r.session_id)).size).toBe(HELP_SWEEP_BATCH + 2);
  });

  it('an answered request never expires', async () => {
    const s = await session();
    await raise(s);
    await repo.answer(s.id, T, randomUUID(), EXPIRY);
    await backdate(s, EXPIRY * 2);
    expect(await repo.expireDue(EXPIRY)).toEqual([]);
    expect(await repo.cancel(s.id, T, EXPIRY)).toBeNull();
    expect(await repo.endWithSession(s.id, EXPIRY)).toBeNull();
  });
});

describe('each request ends exactly once', () => {
  /** A transition's result as who ended the request: the transition, the expiry (`expired`), or nobody. */
  const by = (name: 'answer' | 'cancel' | 'end') => (r: { expired: boolean } | null) => (r === null ? null : r.expired ? 'expiry' : name);

  /**
   * Every transition on one session at once, and the sweep (twice), over requests on BOTH sides of
   * the expiry: `due` ones backdated a minute past it, `fresh` ones a minute short of it, so which
   * side each request is on never depends on how long a round trip takes. The sweeps are issued
   * first or last (`sweepFirst`), so each order of arrival at Postgres is exercised. Answers, per
   * session, which calls ended the request as themselves (`transitions`) and how many expired it
   * (a transition that found it past the expiry, or a sweep).
   */
  async function raceAll(sessions: Array<{ s: Session; due: boolean }>, sweepFirst: boolean) {
    for (const { s, due } of sessions) {
      await raise(s);
      await backdate(s, due ? EXPIRY + 60_000 : EXPIRY - 60_000);
    }
    const sweeps = sweepFirst ? [repo.expireDue(EXPIRY), repo.expireDue(EXPIRY)] : [];
    const perSession = sessions.map(({ s }) => [
      repo.answer(s.id, T, randomUUID(), EXPIRY).then(by('answer')),
      repo.cancel(s.id, T, EXPIRY).then(by('cancel')),
      repo.endWithSession(s.id, EXPIRY).then(by('end')),
      repo.answer(s.id, T, randomUUID(), EXPIRY).then(by('answer')),
    ]);
    if (!sweepFirst) sweeps.push(repo.expireDue(EXPIRY), repo.expireDue(EXPIRY));
    const [flat, sweptLists] = await Promise.all([Promise.all(perSession.flat()), Promise.all(sweeps)]);
    const expiredBy = sweptLists.flat().map((r) => r.session_id);
    return sessions.map(({ s }, i) => {
      const results = flat.slice(i * 4, i * 4 + 4);
      const transitions = results.filter((r) => r !== null && r !== 'expiry');
      const ownExpiry = results.filter((r) => r === 'expiry').length;
      const swept = expiredBy.filter((id) => id === s.id).length;
      return { transitions, expired: ownExpiry + swept };
    });
  }

  it('answer, cancel, end with the session and two sweeps racing: exactly one ends every request; a due one only as expired, a fresh one never', async () => {
    // FALSIFIED: with the expiry dropped from the answer's `expired` (a due request answered), a
    // due request is answered instead of expired; with the expiry dropped from the sweep's pick, a
    // fresh request is swept in the rounds whose sweeps reach Postgres first. Both red.
    for (let round = 0; round < 6; round++) {
      const sessions = await Promise.all([true, false, true, false].map(async (due) => ({ s: await session(), due })));
      const outcome = await raceAll(sessions, round % 2 === 0);
      sessions.forEach(({ due }, i) => {
        const { transitions, expired } = outcome[i]!;
        const label = `round ${round}, session ${i} (${due ? 'due' : 'fresh'}): ${JSON.stringify(outcome[i])}`;
        expect(transitions.length + expired, label).toBe(1);
        if (due) expect(expired, label).toBe(1);
        else expect(expired, label).toBe(0);
      });
      // Nothing is left for a later sweep: each request ended in the race.
      expect(await repo.expireDue(EXPIRY), `round ${round}`).toEqual([]);
    }
  });

  it('the sweep and an answer racing: past the expiry it is expired (by whichever reaches it first), short of it the answer takes it, never both; at the edge itself, at most one', async () => {
    // Both sides deterministically (a minute either side of the expiry, so no round trip moves a
    // request across it), several sessions at once per round; then the edge itself, where either
    // may win but never both. FALSIFIED as the test above: each mutation reds this one too.
    for (let round = 0; round < 4; round++) {
      const sides = [true, false, true, false, true, false];
      const sessions = await Promise.all(sides.map(() => session()));
      for (const [i, s] of sessions.entries()) {
        await raise(s);
        await backdate(s, sides[i] ? EXPIRY + 60_000 : EXPIRY - 60_000);
      }
      // The sweep issued first in half the rounds, last in the others.
      const sweep = round % 2 === 0 ? repo.expireDue(EXPIRY) : null;
      const answering = Promise.all(sessions.map((s) => repo.answer(s.id, T, randomUUID(), EXPIRY).then(by('answer'))));
      const [answers, swept] = await Promise.all([answering, sweep ?? repo.expireDue(EXPIRY)]);
      const sweptIds = new Set(swept.map((r) => r.session_id));
      sessions.forEach((s, i) => {
        const label = `round ${round}, session ${i} (${sides[i] ? 'past' : 'short'})`;
        expect(answers[i] === 'answer', label).toBe(!sides[i]);
        expect(Number(answers[i] === 'expiry') + Number(sweptIds.has(s.id)), label).toBe(sides[i] ? 1 : 0);
      });
    }
    for (let round = 0; round < 6; round++) {
      const s = await session();
      await raise(s);
      await backdate(s, EXPIRY + (round % 2 === 0 ? 1 : -1) * 5);
      const [answered, swept] = await Promise.all([
        repo.answer(s.id, T, randomUUID(), EXPIRY).then(by('answer')),
        repo.expireDue(EXPIRY),
      ]);
      expect([answered !== null, swept.length === 1].filter(Boolean).length, `edge round ${round}`).toBeLessThanOrEqual(1);
      // Neither (the sweep ran just short of the edge, the answer just past it... and found nothing): a later sweep takes it.
      if (answered === null && swept.length === 0) expect(await repo.expireDue(EXPIRY), `edge round ${round}`).toHaveLength(1);
    }
  });

  it('answer keeps the raise and stamps who answered; a second answer is nothing', async () => {
    const s = await session();
    const raised = (await raise(s, null)).help!;
    const answerer = randomUUID();
    const answered = await repo.answer(s.id, T, answerer, EXPIRY);
    expect(answered).toMatchObject({ session_id: s.id, raised_at: raised.raised_at, call_id: null, agent_user_id: s.agent_user_id, expired: false });
    expect(answered!.expired === false && answered!.answered_at.getTime()).toBeGreaterThanOrEqual(raised.raised_at.getTime());
    expect(await row(s)).toMatchObject({ help_raised_at: raised.raised_at, help_answered_by: answerer });
    expect(await repo.answer(s.id, T, randomUUID(), EXPIRY)).toBeNull();
    // Another tenant cannot answer it.
    const t = await session();
    await raise(t);
    expect(await repo.answer(t.id, OTHER_TENANT, randomUUID(), EXPIRY)).toBeNull();
  });

  it('an answer whose transaction began before the agent raised again answers the new request, never before it was raised', async () => {
    // The answer's now() is its transaction's start. A request past the expiry, unswept: the agent
    // raises again (the raise holds the row and writes a later now()) while a listen's answer, begun
    // earlier, waits on the row; it then re-reads the fresh request and answers it. Stamped with its
    // own now() that answer would precede the raise and break ck_agency_agent_sessions_help.
    const s = await session();
    await raise(s);
    await backdate(s, EXPIRY + 60_000);
    const answering = await pool().connect();
    const raising = await pool().connect();
    try {
      await answering.query('BEGIN');
      const answerNow = (await answering.query<{ now: Date }>('SELECT now()')).rows[0]!.now;
      // A gap a Date (milliseconds) can see between the answer's now() and the raise's.
      await raising.query('SELECT pg_sleep(0.02)');
      await raising.query('BEGIN');
      pinned.client = raising;
      const raisedAgain = await raise(s);
      pinned.client = answering;
      const answerer = randomUUID();
      const answer = repo.answer(s.id, T, answerer, EXPIRY);
      pinned.client = null;
      await waitForLockWaiters(1);
      await raising.query('COMMIT');
      expect(raisedAgain).toMatchObject({ raised: true, expired: { session_id: s.id } });
      const newRaise = raisedAgain.help!.raised_at;
      expect(newRaise.getTime()).toBeGreaterThan(answerNow.getTime());
      const answered = await answer;
      await answering.query('COMMIT');
      expect(answered).toMatchObject({ session_id: s.id, raised_at: newRaise, expired: false });
      expect(answered!.expired === false && answered!.answered_at.getTime()).toBeGreaterThanOrEqual(newRaise.getTime());
      const after = await row(s);
      expect(after).toMatchObject({ help_raised_at: newRaise, help_answered_by: answerer });
      expect(after.help_answered_at!.getTime()).toBeGreaterThanOrEqual(newRaise.getTime());
    } finally {
      pinned.client = null;
      await answering.query('ROLLBACK').catch(() => undefined);
      await raising.query('ROLLBACK').catch(() => undefined);
      answering.release();
      raising.release();
    }
  });

  it('cancel and the end of the session clear the columns and answer what they held', async () => {
    const s = await session();
    const call = randomUUID();
    const raised = (await raise(s, call)).help!;
    expect(await repo.cancel(s.id, OTHER_TENANT, EXPIRY)).toBeNull();
    expect(await repo.cancel(s.id, T, EXPIRY)).toMatchObject({ session_id: s.id, raised_at: raised.raised_at, call_id: call, expired: false });
    expect(await row(s)).toEqual({ help_raised_at: null, help_call_id: null, help_answered_at: null, help_answered_by: null, help_state: null });
    await raise(s);
    expect(await repo.endWithSession(s.id, EXPIRY)).toMatchObject({ session_id: s.id, expired: false });
    expect(await repo.endWithSession(s.id, EXPIRY)).toBeNull();
  });
});

describe('the state Need help was raised in (BE-9, 0059)', () => {
  it('recorded by the raise and kept by an answer and a repeated raise; cleared with help_raised_at by every statement that clears it (cancel, end, expiry, the sweep, an expired answer)', async () => {
    // FALSIFIED: with `help_state = NULL` dropped from `clearSql` (or from the answer's expired arm),
    // 0059's CHECK refuses the statement (a state on a request that is not raised) and this reds.
    const s = await session({ state: 'available' });
    expect((await raise(s, null, 'available')).help).toMatchObject({ state: 'available' });
    expect(await row(s)).toMatchObject({ help_state: 'available' });
    expect((await raise(s, null, 'break')).help).toMatchObject({ state: 'available' });
    expect(await repo.openForSession(s.id, T, A, EXPIRY)).toMatchObject({ state: 'available' });
    await repo.answer(s.id, T, randomUUID(), EXPIRY);
    expect(await row(s)).toMatchObject({ help_state: 'available' });
    const cleared = { help_raised_at: null, help_call_id: null, help_state: null };
    await raise(s, null, 'break');
    expect(await row(s)).toMatchObject({ help_state: 'break', help_answered_at: null });
    expect(await repo.cancel(s.id, T, EXPIRY)).toMatchObject({ state: 'break', expired: false });
    expect(await row(s)).toMatchObject(cleared);
    await raise(s, null, 'offline');
    expect(await repo.endWithSession(s.id, EXPIRY)).toMatchObject({ state: 'offline' });
    expect(await row(s)).toMatchObject(cleared);
    for (const end of ['sweep', 'answer', 'raise'] as const) {
      await raise(s, null, 'wrapup');
      await backdate(s, EXPIRY + 1_000);
      if (end === 'sweep') expect(await repo.expireDue(EXPIRY)).toMatchObject([{ session_id: s.id, state: 'wrapup' }]);
      if (end === 'answer') expect(await repo.answer(s.id, T, randomUUID(), EXPIRY)).toMatchObject({ expired: true, state: 'wrapup' });
      if (end === 'raise') {
        const again = await raise(s, null, 'reserved');
        expect(again).toMatchObject({ raised: true, help: { state: 'reserved' }, expired: { state: 'wrapup' } });
        expect(await repo.cancel(s.id, T, EXPIRY)).toMatchObject({ state: 'reserved' });
      }
      expect(await row(s), end).toMatchObject(cleared);
    }
  });

  it('a request raised before 0059 (no state) reads as none, and clears as before', async () => {
    const s = await session();
    await pool().query('UPDATE agency_agent_sessions SET help_raised_at = now() WHERE id = $1', [s.id]);
    expect(await repo.openForSession(s.id, T, A, EXPIRY)).toMatchObject({ state: null });
    expect(await repo.cancel(s.id, T, EXPIRY)).toMatchObject({ state: null, expired: false });
  });

  it('the CHECK refuses a state on a session with no request, and a value outside the six states', async () => {
    const s = await session();
    await expect(pool().query(`UPDATE agency_agent_sessions SET help_state = 'available' WHERE id = $1`, [s.id]))
      .rejects.toMatchObject({ constraint: 'ck_agency_agent_sessions_help_state' });
    await expect(pool().query(`UPDATE agency_agent_sessions SET help_raised_at = now(), help_state = 'lunch' WHERE id = $1`, [s.id]))
      .rejects.toMatchObject({ constraint: 'ck_agency_agent_sessions_help_state' });
  });
});

describe('the floor\'s read', () => {
  it('an account\'s open requests on open sessions only: never another account\'s or tenant\'s, a left session\'s, an answered or an expired one', async () => {
    const open = await session();
    const answered = await session();
    const expired = await session();
    const left = await session();
    const otherAccount = await session({ account_id: OTHER_ACCOUNT });
    const otherTenant = await session({ tenant_id: OTHER_TENANT, account_id: randomUUID() });
    const soft = await insertSoftphoneSession() as unknown as Session;
    for (const s of [open, answered, expired, left, otherAccount, otherTenant, soft]) await raise(s);
    await repo.answer(answered.id, T, randomUUID(), EXPIRY);
    await backdate(expired, EXPIRY + 1);
    await pool().query(`UPDATE agency_agent_sessions SET left_at = now(), state = 'offline' WHERE id = $1`, [left.id]);
    expect((await floorHelp(T, A)).sort()).toEqual([open.id, soft.id].sort());
    expect(await floorHelp(T, OTHER_ACCOUNT)).toEqual([otherAccount.id]);
  });

  it('the internal floor handler serves each open session\'s help, null on the rest', async () => {
    const helped = await session({ agent_user_id: randomUUID() });
    const quiet = await session({ agent_user_id: randomUUID() });
    const raised = (await raise(helped, null)).help!;
    const app = Fastify();
    const runtime = {
      stations: { connectedBySession: async (ids: readonly string[]) => new Map(ids.map((id) => [id, true])) },
      stationDisconnects: { disconnectedSince: () => new Map(), goneSessionIds: () => [] },
    };
    await app.register(async (sub) => registerFloorRoutes(sub, runtime as never), { prefix: '/api/v1/agency' });
    try {
      const res = await app.inject({
        method: 'GET', url: `/api/v1/agency/floor?from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`,
        headers: { 'x-mgkvc-tenant': T, 'x-mgkvc-account': A },
      });
      expect(res.statusCode, res.body).toBe(200);
      const bySession = new Map((res.json().agents as Array<{ session_id: string; help: unknown }>).map((a) => [a.session_id, a.help]));
      expect(bySession.get(helped.id)).toEqual({ raised_at: raised.raised_at.toISOString(), call_id: null, state_at_raise: 'on_call' });
      expect(bySession.get(quiet.id)).toBeNull();
      await repo.cancel(helped.id, T, EXPIRY);
      const after = await app.inject({
        method: 'GET', url: `/api/v1/agency/floor?from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`,
        headers: { 'x-mgkvc-tenant': T, 'x-mgkvc-account': A },
      });
      expect((after.json().agents as Array<{ help: unknown }>).every((a) => a.help === null)).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('the call a request is raised on', () => {
  it('a bridged campaign attempt\'s, a bridged soft-phone call\'s, a connected inbound call\'s; none in wrap-up', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const contact = await insertAgencyContact(campaign.id as string);
    const onAttempt = await insertAgentSession(campaign.id as string, { state: 'on_call' }) as unknown as Session;
    const attemptCall = randomUUID();
    await insertAgencyAttempt(campaign.id as string, contact.id as string, {
      state: 'bridged', reserved_agent_id: onAttempt.id, dialed_at: new Date(), bridged_at: new Date(), webrtc_call_id: attemptCall,
    });
    expect(await repo.liveCallIdForSession(onAttempt.id, T)).toBe(attemptCall);
    expect(await repo.liveCallIdForSession(onAttempt.id, OTHER_TENANT)).toBeNull();

    const soft = await insertSoftphoneSession() as unknown as Session;
    const manualCall = randomUUID();
    await insertManualCall(soft, { state: 'bridged', bridged_at: new Date(), webrtc_call_id: manualCall });
    expect(await repo.liveCallIdForSession(soft.id, T)).toBe(manualCall);

    const inbound = await insertAgentSession(campaign.id as string, { state: 'on_call' }) as unknown as Session;
    const inboundCall = randomUUID();
    await pool().query(
      `INSERT INTO agency_inbound_calls (tenant_id, account_id, provider_call_id, to_e164, state, bridged_at, answered_by_user_id, session_id, offered_at, offer_count, webrtc_call_id)
       VALUES ($1, $2, 'fa-ib-1', '+919000000002', 'connected', now(), $3, $4, now(), 1, $5)`,
      [T, A, inbound.agent_user_id, inbound.id, inboundCall]);
    expect(await repo.liveCallIdForSession(inbound.id, T)).toBe(inboundCall);

    const wrapup = await insertAgentSession(campaign.id as string, { state: 'wrapup' }) as unknown as Session;
    await insertAgencyAttempt(campaign.id as string, contact.id as string, {
      state: 'ended', outcome: 'completed', attempt_number: 2, reserved_agent_id: wrapup.id, dialed_at: new Date(), bridged_at: new Date(), ended_at: new Date(), webrtc_call_id: randomUUID(),
    });
    expect(await repo.liveCallIdForSession(wrapup.id, T)).toBeNull();
  });
});

describe('messages', () => {
  it('stored undelivered, then marked delivered', async () => {
    const s = await session();
    const sender = randomUUID();
    const stored = await repo.insertMessage({
      tenantId: T, accountId: A, sessionId: s.id, agentUserId: s.agent_user_id, senderUserId: sender, text: 'Offer the 3-month plan',
    });
    const read = () => pool().query('SELECT tenant_id, account_id, session_id, agent_user_id, sender_user_id, text, delivered, sent_at FROM agency_supervisor_messages WHERE id = $1', [stored.id]);
    expect((await read()).rows[0]).toEqual({
      tenant_id: T, account_id: A, session_id: s.id, agent_user_id: s.agent_user_id, sender_user_id: sender,
      text: 'Offer the 3-month plan', delivered: false, sent_at: stored.sent_at,
    });
    await repo.markDelivered(stored.id);
    expect((await read()).rows[0]).toMatchObject({ delivered: true });
  });
});

describe('the plans', () => {
  async function plan(sql: string, params: unknown[]): Promise<string> {
    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(`EXPLAIN ${sql}`, params);
      return rows.map((r) => r['QUERY PLAN']).join('\n');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('the sweep walks the partial index of requests not answered', async () => {
    expect(await plan(SWEEP_EXPIRED_SQL, [EXPIRY, HELP_SWEEP_BATCH])).toContain('idx_agency_agent_sessions_help_open');
  });

  it('the call read reads each spine on an index, never a scan of the table', async () => {
    const p = await plan(LIVE_CALL_FOR_SESSION_SQL, [randomUUID(), T]);
    expect(p).not.toMatch(/Seq Scan/);
    for (const table of ['agency_call_attempts', 'agency_manual_calls', 'agency_inbound_calls']) {
      expect(p, table).toMatch(new RegExp(`Index (Only )?Scan using \\S+ on ${table}`));
    }
  });
});
