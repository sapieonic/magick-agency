import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, OTHER_ACCOUNT, OTHER_TENANT } from '../setup/factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyListenSessionRepository: repo } = await import('../../../src/db/repositories/agency.repository.js');
type OpenInput = import('../../../src/db/repositories/agency.repository.js').ListenSessionOpenInput;

/**
 * The listen session repository on real Postgres (docs/listening.md, `0047_listen_sessions.sql`): open writes
 * every field it is given; close ends an open row exactly once (a second close, or a close racing
 * another, changes nothing and answers null) and never writes an end before the start; each read's
 * tenant and account scope; the open-only reads skip closed rows; the reaps close a dead process's
 * open rows `server_restarted` and nothing else.
 *
 * Mutation-checked: dropping `AND ended_at IS NULL` from `close` lets the second close rewrite the
 * reason; dropping `tenant_id = $1` from `listOpenForCalls` returns another tenant's session;
 * dropping `account_id = $2` from `listForCall` returns another account's; dropping the `NOT` from
 * `closeOrphansExcept` closes the live replica's sessions instead of the dead one's.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();

function input(o: Partial<OpenInput> = {}): OpenInput {
  return {
    id: randomUUID(),
    tenantId: T,
    accountId: A,
    callId: randomUUID(),
    origin: 'campaign',
    campaignId: randomUUID(),
    correlationId: randomUUID(),
    agentSessionId: randomUUID(),
    agentUserId: randomUUID(),
    listenerUserId: randomUUID(),
    replicaId: 'replica-a',
    ...o,
  };
}

const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

describe('agency listen session repository', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('open writes every field it is given, open, started now, the counters at 0', async () => {
    const i = input({ origin: 'inbound', campaignId: null });
    const before = Date.now();
    const row = await repo.open(i);
    expect(row).toMatchObject({
      id: i.id, tenant_id: T, account_id: A, call_id: i.callId, origin: 'inbound', campaign_id: null,
      correlation_id: i.correlationId, agent_session_id: i.agentSessionId, agent_user_id: i.agentUserId,
      listener_user_id: i.listenerUserId, replica_id: 'replica-a',
      ended_at: null, end_reason: null, frames_sent: 0, frames_dropped: 0,
    });
    expect(row.started_at.getTime()).toBeGreaterThanOrEqual(before - 5_000);
    // A listen id has one row: a second open with it is refused, which the caller turns into a refusal.
    await expect(repo.open({ ...i, callId: randomUUID() })).rejects.toMatchObject({ code: '23505' });
    // So is a listen to one's own call (LS3): the grant refuses it first; the CHECK is the backstop.
    const agent = randomUUID();
    await expect(repo.open(input({ agentUserId: agent, listenerUserId: agent })))
      .rejects.toMatchObject({ code: '23514', constraint: 'ck_agency_listen_sessions_not_own_call' });
  });

  it('close ends an open row once, with its reason and counters; a second close changes nothing', async () => {
    const row = await repo.open(input());
    const closed = await repo.close(row.id, { reason: 'listener_stopped', framesSent: 3000, framesDropped: 12 });
    expect(closed).toMatchObject({ id: row.id, end_reason: 'listener_stopped', frames_sent: 3000, frames_dropped: 12 });
    expect(closed!.ended_at!.getTime()).toBeGreaterThanOrEqual(row.started_at.getTime());

    expect(await repo.close(row.id, { reason: 'call_ended', framesSent: 9999, framesDropped: 0 })).toBeNull();
    const { rows } = await pool().query('SELECT end_reason, frames_sent FROM agency_listen_sessions WHERE id = $1', [row.id]);
    expect(rows[0]).toEqual({ end_reason: 'listener_stopped', frames_sent: 3000 });
    // No row at all: null, not a throw.
    expect(await repo.close(randomUUID(), { reason: 'call_ended', framesSent: 0, framesDropped: 0 })).toBeNull();
  });

  it('two closes racing: exactly one wins', async () => {
    const row = await repo.open(input());
    const [a, b] = await Promise.all([
      repo.close(row.id, { reason: 'call_ended', framesSent: 1, framesDropped: 0 }),
      repo.close(row.id, { reason: 'listener_disconnected', framesSent: 2, framesDropped: 0 }),
    ]);
    expect([a, b].filter((r) => r !== null)).toHaveLength(1);
  });

  it('close never writes an end before the start, and clamps the counters at 0', async () => {
    // A start stamped ahead of the database clock (a clock step, a row from a skewed writer).
    const row = await repo.open(input());
    const future = new Date(Date.now() + 60_000);
    await pool().query('UPDATE agency_listen_sessions SET started_at = $2 WHERE id = $1', [row.id, future]);
    const closed = await repo.close(row.id, { reason: 'tap_error', framesSent: -5, framesDropped: 2.7 });
    expect(closed!.ended_at!.getTime()).toBe(future.getTime());
    expect(closed).toMatchObject({ frames_sent: 0, frames_dropped: 2 });
  });

  it('listOpenInAccount: the account\'s open sessions only, earliest first', async () => {
    const first = await repo.open(input());
    const second = await repo.open(input());
    await pool().query(`UPDATE agency_listen_sessions SET started_at = now() - interval '1 minute' WHERE id = $1`, [first.id]);
    const ended = await repo.open(input());
    await repo.close(ended.id, { reason: 'call_ended', framesSent: 0, framesDropped: 0 });
    await repo.open(input({ accountId: OTHER_ACCOUNT }));
    await repo.open(input({ tenantId: OTHER_TENANT }));

    expect(ids(await repo.listOpenInAccount(T, A))).toEqual([first.id, second.id]);
    expect(await repo.listOpenInAccount(T, randomUUID())).toEqual([]);
  });

  it('listOpenForCalls: the tenant\'s open sessions on those calls; no calls, no rows', async () => {
    const call = randomUUID();
    const two = randomUUID();
    const a = await repo.open(input({ callId: call }));
    const b = await repo.open(input({ callId: call }));
    const c = await repo.open(input({ callId: two, accountId: OTHER_ACCOUNT }));
    const ended = await repo.open(input({ callId: call }));
    await repo.close(ended.id, { reason: 'listener_stopped', framesSent: 0, framesDropped: 0 });
    // The same call id in another tenant is not this tenant's.
    await repo.open(input({ callId: call, tenantId: OTHER_TENANT }));
    await repo.open(input());

    expect(ids(await repo.listOpenForCalls(T, [call, two])).sort()).toEqual([a.id, b.id, c.id].sort());
    expect(await repo.listOpenForCalls(T, [])).toEqual([]);
  });

  it('listForCall: every session on the call in the account, open or closed, earliest first', async () => {
    const call = randomUUID();
    const first = await repo.open(input({ callId: call }));
    await pool().query(`UPDATE agency_listen_sessions SET started_at = now() - interval '5 minutes' WHERE id = $1`, [first.id]);
    await repo.close(first.id, { reason: 'listener_stopped', framesSent: 50, framesDropped: 0 });
    const second = await repo.open(input({ callId: call }));
    await repo.open(input({ callId: call, accountId: OTHER_ACCOUNT }));
    await repo.open(input({ callId: call, tenantId: OTHER_TENANT }));

    const rows = await repo.listForCall(T, A, call);
    expect(ids(rows)).toEqual([first.id, second.id]);
    expect(rows.map((r) => r.end_reason)).toEqual(['listener_stopped', null]);
    expect(await repo.listForCall(T, A, randomUUID())).toEqual([]);
  });

  it('listOpenForListener: one supervisor\'s open sessions in the tenant, newest first', async () => {
    const me = randomUUID();
    const older = await repo.open(input({ listenerUserId: me }));
    await pool().query(`UPDATE agency_listen_sessions SET started_at = now() - interval '1 minute' WHERE id = $1`, [older.id]);
    const newer = await repo.open(input({ listenerUserId: me, accountId: OTHER_ACCOUNT }));
    const ended = await repo.open(input({ listenerUserId: me }));
    await repo.close(ended.id, { reason: 'superseded', framesSent: 0, framesDropped: 0 });
    await repo.open(input({ listenerUserId: me, tenantId: OTHER_TENANT }));
    await repo.open(input());

    expect(ids(await repo.listOpenForListener(T, me))).toEqual([newer.id, older.id]);
  });

  it('closeOrphans: a dead process\'s open sessions close server_restarted; nothing else moves', async () => {
    const dead = await repo.open(input({ replicaId: 'worker-dead' }));
    const deadElsewhere = await repo.open(input({ replicaId: 'worker-dead', tenantId: OTHER_TENANT }));
    const deadEnded = await repo.open(input({ replicaId: 'worker-dead' }));
    await repo.close(deadEnded.id, { reason: 'call_ended', framesSent: 7, framesDropped: 0 });
    const live = await repo.open(input({ replicaId: 'worker-live' }));

    const closed = await repo.closeOrphans('worker-dead');
    expect(ids(closed).sort()).toEqual([dead.id, deadElsewhere.id].sort());
    expect(closed.every((r) => r.end_reason === 'server_restarted' && r.ended_at !== null)).toBe(true);
    const { rows } = await pool().query<{ id: string; end_reason: string | null; frames_sent: number }>(
      'SELECT id, end_reason, frames_sent FROM agency_listen_sessions WHERE id = ANY($1::uuid[]) ORDER BY id',
      [[deadEnded.id, live.id]]);
    expect(Object.fromEntries(rows.map((r) => [r.id, [r.end_reason, r.frames_sent]]))).toEqual({
      [deadEnded.id]: ['call_ended', 7],
      [live.id]: [null, 0],
    });
    expect(await repo.closeOrphans('worker-dead')).toEqual([]);
  });

  it('closeOrphansExcept: at boot, every open session of a process not running now closes server_restarted', async () => {
    const old = await repo.open(input({ replicaId: 'primary-before-restart' }));
    const oldWorker = await repo.open(input({ replicaId: 'worker-before-restart', tenantId: OTHER_TENANT }));
    const live = await repo.open(input({ replicaId: 'primary-now' }));

    expect(ids(await repo.closeOrphansExcept(['primary-now'])).sort()).toEqual([old.id, oldWorker.id].sort());
    expect(ids(await repo.listOpenInAccount(T, A))).toEqual([live.id]);
    // A fresh primary with nothing running yet: every open row is an orphan.
    expect(ids(await repo.closeOrphansExcept([]))).toEqual([live.id]);
    expect(await repo.listOpenInAccount(T, A)).toEqual([]);
  });
});
