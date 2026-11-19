import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { AGENCY_HELP_EXPIRY_MS } from '@magick-agency/contracts/agency';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT } from '../setup/factories.js';
import {
  insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession, insertManualCall, insertSoftphoneSession,
} from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const {
  agencyFloorAssistRepository: repo, OPEN_HELP_FOR_ACCOUNT_SQL, SWEEP_EXPIRED_SQL, LIVE_CALL_FOR_SESSION_SQL, HELP_SWEEP_BATCH,
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

const raise = (s: Session, callId: string | null = null) =>
  repo.raise({ sessionId: s.id, tenantId: s.tenant_id, accountId: s.account_id, callId, expiryMs: EXPIRY });

/** Move the session's raise `ms` into the past (the database's clock is the expiry's). */
async function backdate(s: Session, ms: number): Promise<Date> {
  const { rows } = await pool().query<{ help_raised_at: Date }>(
    `UPDATE agency_agent_sessions SET help_raised_at = now() - $2::bigint * interval '1 millisecond' WHERE id = $1 RETURNING help_raised_at`,
    [s.id, ms]);
  return rows[0]!.help_raised_at;
}

async function row(s: Session) {
  const { rows } = await pool().query(
    'SELECT help_raised_at, help_call_id, help_answered_at, help_answered_by FROM agency_agent_sessions WHERE id = $1', [s.id]);
  return rows[0] as { help_raised_at: Date | null; help_call_id: string | null; help_answered_at: Date | null; help_answered_by: string | null };
}

describe('raise', () => {
  it('raises on the session, with its call; raising again while open answers the same request (idempotent)', async () => {
    const s = await session();
    const call = randomUUID();
    const first = await raise(s, call);
    expect(first).toMatchObject({ raised: true, help: { session_id: s.id, call_id: call }, expiredMeanwhile: [] });
    const again = await raise(s, randomUUID());
    expect(again).toMatchObject({ raised: false, help: { session_id: s.id, call_id: call }, expiredMeanwhile: [] });
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
    expect(await repo.answer(s.id, T, randomUUID(), EXPIRY)).not.toBeNull();
    const next = await raise(s);
    expect(next.raised).toBe(true);
    expect(await row(s)).toMatchObject({ help_answered_at: null, help_answered_by: null });
  });

  it('never on a session that has left, nor across tenants or accounts', async () => {
    const left = await session({ left_at: new Date(), state: 'offline' });
    expect(await raise(left)).toEqual({ raised: false, help: null, expiredMeanwhile: [] });
    const s = await session();
    expect(await repo.raise({ sessionId: s.id, tenantId: OTHER_TENANT, accountId: A, callId: null, expiryMs: EXPIRY }))
      .toEqual({ raised: false, help: null, expiredMeanwhile: [] });
    expect(await repo.raise({ sessionId: s.id, tenantId: T, accountId: OTHER_ACCOUNT, callId: null, expiryMs: EXPIRY }))
      .toEqual({ raised: false, help: null, expiredMeanwhile: [] });
    expect((await row(s)).help_raised_at).toBeNull();
  });

  it('a request found expired in between is expired by the raise (returned once) and a new one raised', async () => {
    const s = await session();
    await raise(s);
    const old = await backdate(s, EXPIRY + 1_000);
    const out = await raise(s);
    expect(out.raised).toBe(true);
    expect(out.expiredMeanwhile.map((r) => r.raised_at.getTime())).toEqual([old.getTime()]);
  });
});

describe('the 15-minute expiry, against the database clock', () => {
  it('a second before it the request is open (floor, answer); at it, it is not, and the sweep clears it once with what it held', async () => {
    const s = await session();
    const call = randomUUID();
    await raise(s, call);
    const raisedAt = await backdate(s, EXPIRY - 2_000);
    expect((await repo.openForAccount(T, A, EXPIRY)).map((r) => r.session_id)).toEqual([s.id]);
    expect(await repo.expireDue(EXPIRY, { sweep: true })).toEqual([]);
    await backdate(s, EXPIRY + 1_000);
    const expiredAt = (await row(s)).help_raised_at!;
    expect(await repo.openForAccount(T, A, EXPIRY)).toEqual([]);
    expect(await repo.openForSession(s.id, T, A, EXPIRY)).toBeNull();
    expect(await repo.answer(s.id, T, randomUUID(), EXPIRY)).toBeNull();
    expect(await repo.cancel(s.id, T, EXPIRY)).toBeNull();
    expect(await repo.endWithSession(s.id, EXPIRY)).toBeNull();
    const swept = await repo.expireDue(EXPIRY, { sweep: true });
    expect(swept).toEqual([{
      session_id: s.id, tenant_id: T, account_id: A, campaign_id: s.campaign_id, agent_user_id: s.agent_user_id,
      raised_at: expiredAt, call_id: call,
    }]);
    expect(raisedAt.getTime()).toBeGreaterThan(expiredAt.getTime());
    expect(await row(s)).toEqual({ help_raised_at: null, help_call_id: null, help_answered_at: null, help_answered_by: null });
    expect(await repo.expireDue(EXPIRY, { sweep: true })).toEqual([]);
  });

  it('one session\'s expiry touches only that session; the sweep pages through more than a batch', async () => {
    const sessions = await Promise.all(Array.from({ length: HELP_SWEEP_BATCH + 3 }, () => session()));
    await pool().query(
      `UPDATE agency_agent_sessions SET help_raised_at = now() - interval '16 minutes' WHERE id = ANY($1::uuid[])`,
      [sessions.map((s) => s.id)]);
    expect((await repo.expireDue(EXPIRY, { sessionId: sessions[0]!.id })).map((r) => r.session_id)).toEqual([sessions[0]!.id]);
    const swept = await repo.expireDue(EXPIRY, { sweep: true });
    expect(swept).toHaveLength(HELP_SWEEP_BATCH + 2);
    expect(new Set(swept.map((r) => r.session_id)).size).toBe(HELP_SWEEP_BATCH + 2);
  });

  it('an answered request never expires', async () => {
    const s = await session();
    await raise(s);
    await repo.answer(s.id, T, randomUUID(), EXPIRY);
    await backdate(s, EXPIRY * 2);
    expect(await repo.expireDue(EXPIRY, { sweep: true })).toEqual([]);
  });
});

describe('each request ends exactly once', () => {
  /**
   * Every transition on one session at once, the sweep (twice) and the session's own expiry among
   * them, over requests on BOTH sides of the expiry: `due` ones backdated a minute past it, `fresh`
   * ones a minute short of it, so which side each request is on never depends on how long a round
   * trip takes. The sweeps are issued first or last (`sweepFirst`), so each order of arrival at
   * Postgres is exercised. Answers, per session, which calls won.
   */
  async function raceAll(sessions: Array<{ s: Session; due: boolean }>, sweepFirst: boolean) {
    for (const { s, due } of sessions) {
      await raise(s);
      await backdate(s, due ? EXPIRY + 60_000 : EXPIRY - 60_000);
    }
    const sweeps = sweepFirst
      ? [repo.expireDue(EXPIRY, { sweep: true }), repo.expireDue(EXPIRY, { sweep: true })]
      : [];
    const perSession = sessions.map(({ s }) => [
      repo.answer(s.id, T, randomUUID(), EXPIRY).then((r) => (r ? 'answer' : null)),
      repo.cancel(s.id, T, EXPIRY).then((r) => (r ? 'cancel' : null)),
      repo.endWithSession(s.id, EXPIRY).then((r) => (r ? 'end' : null)),
      repo.answer(s.id, T, randomUUID(), EXPIRY).then((r) => (r ? 'answer' : null)),
      repo.expireDue(EXPIRY, { sessionId: s.id }).then((r) => r.map((x) => x.session_id)),
    ] as const);
    if (!sweepFirst) sweeps.push(repo.expireDue(EXPIRY, { sweep: true }), repo.expireDue(EXPIRY, { sweep: true }));
    const [flat, sweptLists] = await Promise.all([Promise.all(perSession.flatMap((calls) => calls)), Promise.all(sweeps)]);
    const expiredBy = sweptLists.flat().map((r) => r.session_id);
    return sessions.map(({ s }, i) => {
      const results = flat.slice(i * 5, i * 5 + 5);
      const transitions = results.slice(0, 4).filter((r): r is 'answer' | 'cancel' | 'end' => typeof r === 'string');
      const ownExpiry = (results[4] as string[]).filter((id) => id === s.id).length;
      const swept = expiredBy.filter((id) => id === s.id).length;
      return { transitions, expired: ownExpiry + swept };
    });
  }

  it('answer, cancel, end with the session, its own expiry and two sweeps racing: exactly one wins every request; a due one only by an expiry, a fresh one never by one', async () => {
    // FALSIFIED: with `fresh()` dropped from the answer's WHERE, a due request is answered instead
    // of expired; with the expiry dropped from the sweep's pick, a fresh request is swept in the
    // rounds whose sweeps reach Postgres first. Both red.
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
      expect(await repo.expireDue(EXPIRY, { sweep: true }), `round ${round}`).toEqual([]);
    }
  });

  it('the sweep and an answer racing: past the expiry the sweep takes it, short of it the answer does, never both; at the edge itself, at most one', async () => {
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
      const sweep = round % 2 === 0 ? repo.expireDue(EXPIRY, { sweep: true }) : null;
      const answering = Promise.all(sessions.map((s) => repo.answer(s.id, T, randomUUID(), EXPIRY)));
      const [answers, swept] = await Promise.all([answering, sweep ?? repo.expireDue(EXPIRY, { sweep: true })]);
      const sweptIds = new Set(swept.map((r) => r.session_id));
      sessions.forEach((s, i) => {
        const label = `round ${round}, session ${i} (${sides[i] ? 'past' : 'short'})`;
        expect(answers[i] !== null, label).toBe(!sides[i]);
        expect(sweptIds.has(s.id), label).toBe(sides[i]);
      });
    }
    for (let round = 0; round < 6; round++) {
      const s = await session();
      await raise(s);
      await backdate(s, EXPIRY + (round % 2 === 0 ? 1 : -1) * 5);
      const [answered, swept] = await Promise.all([
        repo.answer(s.id, T, randomUUID(), EXPIRY),
        repo.expireDue(EXPIRY, { sweep: true }),
      ]);
      expect([answered !== null, swept.length === 1].filter(Boolean).length, `edge round ${round}`).toBeLessThanOrEqual(1);
      // Neither (the sweep ran just short of the edge, the answer just past it): a later sweep takes it.
      if (answered === null && swept.length === 0) expect(await repo.expireDue(EXPIRY, { sweep: true }), `edge round ${round}`).toHaveLength(1);
    }
  });

  it('answer keeps the raise and stamps who answered; a second answer is nothing', async () => {
    const s = await session();
    const raised = (await raise(s, null)).help!;
    const by = randomUUID();
    const answered = await repo.answer(s.id, T, by, EXPIRY);
    expect(answered).toMatchObject({ session_id: s.id, raised_at: raised.raised_at, call_id: null, agent_user_id: s.agent_user_id });
    expect(answered!.answered_at.getTime()).toBeGreaterThanOrEqual(raised.raised_at.getTime());
    expect(await row(s)).toMatchObject({ help_raised_at: raised.raised_at, help_answered_by: by });
    expect(await repo.answer(s.id, T, randomUUID(), EXPIRY)).toBeNull();
    // Another tenant cannot answer it.
    const t = await session();
    await raise(t);
    expect(await repo.answer(t.id, OTHER_TENANT, randomUUID(), EXPIRY)).toBeNull();
  });

  it('cancel and the end of the session clear the columns and answer what they held', async () => {
    const s = await session();
    const call = randomUUID();
    const raised = (await raise(s, call)).help!;
    expect(await repo.cancel(s.id, OTHER_TENANT, EXPIRY)).toBeNull();
    expect(await repo.cancel(s.id, T, EXPIRY)).toMatchObject({ session_id: s.id, raised_at: raised.raised_at, call_id: call });
    expect(await row(s)).toEqual({ help_raised_at: null, help_call_id: null, help_answered_at: null, help_answered_by: null });
    await raise(s);
    expect(await repo.endWithSession(s.id, EXPIRY)).toMatchObject({ session_id: s.id });
    expect(await repo.endWithSession(s.id, EXPIRY)).toBeNull();
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
    expect((await repo.openForAccount(T, A, EXPIRY)).map((r) => r.session_id).sort()).toEqual([open.id, soft.id].sort());
    expect((await repo.openForAccount(T, OTHER_ACCOUNT, EXPIRY)).map((r) => r.session_id)).toEqual([otherAccount.id]);
  });

  it('the internal floor handler serves each open session\'s help, null on the rest', async () => {
    const helped = await session({ agent_user_id: randomUUID() });
    const quiet = await session({ agent_user_id: randomUUID() });
    const raised = (await raise(helped, null)).help!;
    const app = Fastify();
    const runtime = { stations: { connectedBySession: async (ids: readonly string[]) => new Map(ids.map((id) => [id, true])) } };
    await app.register(async (sub) => registerFloorRoutes(sub, runtime as never), { prefix: '/api/v1/agency' });
    try {
      const res = await app.inject({
        method: 'GET', url: `/api/v1/agency/floor?from=${encodeURIComponent(new Date(Date.now() - 3_600_000).toISOString())}`,
        headers: { 'x-mgkvc-tenant': T, 'x-mgkvc-account': A },
      });
      expect(res.statusCode, res.body).toBe(200);
      const bySession = new Map((res.json().agents as Array<{ session_id: string; help: unknown }>).map((a) => [a.session_id, a.help]));
      expect(bySession.get(helped.id)).toEqual({ raised_at: raised.raised_at.toISOString(), call_id: null });
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

  it('the floor\'s read and the sweep walk the partial index of requests not answered', async () => {
    expect(await plan(OPEN_HELP_FOR_ACCOUNT_SQL, [T, A, EXPIRY])).toContain('idx_agency_agent_sessions_help_open');
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
