import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgentSession } from './agency-factories.js';
import { closeTestRedis, flushTestRedis, getTestRedis } from '../../helpers/test-redis.js';

const metric = vi.hoisted(() => ({ overrun: vi.fn() }));

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('@magick-agency/observability/metrics/agency', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/observability/metrics/agency')>()),
  trackBreakOverrun: metric.overrun,
}));
vi.mock('../../../src/audit/platform/audit-logger.js', () => ({ platformAuditLogger: { log: vi.fn() } }));

const { AgencyRuntime, BREAK_RESUME_MAX_MS } = await import('../../../src/agency/runtime.js');
const { AGENT_LEASE_MS } = await import('../../../src/agency/agent-state-machine.js');
const { agencyAgentSessionRepository: sessions } = await import('../../../src/db/repositories/agency.repository.js');

/**
 * A named break split by a station drop is one break (agent station BE-12, AS12; 0062), through the
 * real runtime on real Redis and Postgres: the station's close (`releaseStationOnClose`) writes the
 * session `offline` and suspends the break; its lease lapses; the reconnect's rehydrate
 * (`rehydrateAgent`, over the row the station attach reads, `readForStationAttach`, or the one the
 * join's upsert returns) restores Lunch with its original start, in Redis (`since`) and as the
 * row's `state_since` (the Live floor's `break_over` clock); the break is judged once, from that
 * start, when the agent goes Ready: one overrun, counted once. A station back too late (the next
 * day) starts a fresh break, and the suspended one is judged as ended at the drop.
 *
 * Time is controlled as in `break-overrun.test.ts`: the break's `state_since` set in the past, and
 * "the agent stays 25 more minutes" is `state_since` moved 25 minutes back.
 */

const key = (sid: string) => `agency:agent:${sid}:state`;
const pool = () => getTestPool();

beforeEach(async () => {
  await truncateAll();
  await flushTestRedis();
  metric.overrun.mockClear();
});
afterAll(async () => {
  await closeTestRedis();
  await closeTestPool();
});

const runtime = () => new AgencyRuntime({} as never, getTestRedis(), '');

/** A station on Lunch (30 minutes, the built-ins) for `minutes`, in Redis and the row. */
async function onLunch(rt: InstanceType<typeof AgencyRuntime>, minutes: number) {
  const campaign = await insertAgencyCampaign({ status: 'running' });
  const start = new Date(Date.now() - minutes * 60_000);
  const s = await insertAgentSession(campaign.id as string, {
    agent_user_id: randomUUID(), state: 'break', break_reason: 'lunch', state_since: start,
  }) as unknown as { id: string; agent_user_id: string; campaign_id: string };
  await rt.agents.set(s.id, 'break', { leaseMs: AGENT_LEASE_MS.break, breakReason: 'lunch', sinceMs: start.getTime() });
  const { rows } = await pool().query<{ state_since: Date }>('SELECT state_since FROM agency_agent_sessions WHERE id = $1', [s.id]);
  return { ...s, start: rows[0]!.state_since };
}

/** The station goes, and its lease lapses (45 s later, here at once). */
async function drop(rt: InstanceType<typeof AgencyRuntime>, id: string) {
  expect(await rt.releaseStationOnClose(id)).toBe(true);
  expect(await rt.agents.get(id)).toMatchObject({ state: 'offline' });
  await getTestRedis().del(key(id));
}

async function row(id: string) {
  const { rows } = await pool().query('SELECT state, break_reason, state_since, suspended_break_since FROM agency_agent_sessions WHERE id = $1', [id]);
  return rows[0] as { state: string; break_reason: string | null; state_since: Date; suspended_break_since: Date | null };
}

async function overruns(id: string) {
  const { rows } = await pool().query(
    `SELECT from_state, to_state, break_limit_minutes, break_overrun_seconds FROM agency_agent_session_events
      WHERE session_id = $1 AND break_overrun_seconds IS NOT NULL ORDER BY at`, [id]);
  return rows as Array<{ from_state: string; to_state: string; break_limit_minutes: number; break_overrun_seconds: number }>;
}

const passes = (id: string, minutes: number) => pool().query(
  'UPDATE agency_agent_sessions SET state_since = state_since - make_interval(mins => $2) WHERE id = $1', [id, minutes]);

function aboutMinutes(seconds: number, minutes: number) {
  expect(seconds).toBeGreaterThanOrEqual(minutes * 60 - 1);
  expect(seconds).toBeLessThanOrEqual(minutes * 60 + 5);
}

describe('a Lunch split by a station drop', () => {
  it('25 + 25 minutes, the station reconnecting: Lunch resumes from its start (Redis and the floor\'s clock), one overrun of about 20 minutes, counted once', async () => {
    // FALSIFIED: with the rehydrate writing Lunch from now (no `stateSince`), the drop and the
    // resumed half are two breaks of 25 minutes, both under the limit: nothing recorded.
    const rt = runtime();
    const s = await onLunch(rt, 25);
    await drop(rt, s.id);
    expect(await overruns(s.id)).toEqual([]);
    const attached = (await sessions.readForStationAttach(s.id, 'web'))!;
    expect(attached).toMatchObject({ state: 'offline', break_reason: 'lunch' });

    expect(await rt.rehydrateAgent(s.id, attached)).toBe('break');
    expect(await rt.agents.get(s.id)).toMatchObject({ state: 'break', breakReason: 'lunch', since: s.start.getTime() });
    expect(await row(s.id)).toMatchObject({ state: 'break', break_reason: 'lunch', state_since: s.start, suspended_break_since: null });

    await passes(s.id, 25);
    await sessions.setState(s.id, 'available', null);
    const recorded = await overruns(s.id);
    expect(recorded).toMatchObject([{ from_state: 'break', to_state: 'available', break_limit_minutes: 30 }]);
    aboutMinutes(recorded[0]!.break_overrun_seconds, 20);
    expect(metric.overrun).toHaveBeenCalledTimes(1);
    expect(metric.overrun).toHaveBeenCalledWith(DEFAULTS.tenantId);
  });

  it('25 + 25 minutes, the agent joining again (the upsert promotes the row): the same, one overrun', async () => {
    const rt = runtime();
    const s = await onLunch(rt, 25);
    await drop(rt, s.id);
    const join = await sessions.joinOrRehydrate({
      tenantId: DEFAULTS.tenantId, accountId: DEFAULTS.accountId, campaignId: s.campaign_id, agentUserId: s.agent_user_id, replicaId: 'r1',
    });
    expect(join).toMatchObject({ ok: true, created: false, session: { state: 'break', break_reason: 'lunch' } });
    if (!join.ok) throw new Error('join refused');
    expect(await rt.rehydrateAgent(join.session.id, join.session)).toBe('break');
    expect(await row(s.id)).toMatchObject({ state: 'break', state_since: s.start, suspended_break_since: null });
    expect(await rt.agents.get(s.id)).toMatchObject({ since: s.start.getTime() });
    await passes(s.id, 25);
    await sessions.leave(s.id);
    const recorded = await overruns(s.id);
    expect(recorded).toMatchObject([{ from_state: 'break', to_state: 'offline', break_limit_minutes: 30 }]);
    aboutMinutes(recorded[0]!.break_overrun_seconds, 20);
    expect(metric.overrun).toHaveBeenCalledTimes(1);
  });

  it('the station back the next day: a fresh Lunch, and the suspended one judged as ended at the drop (45 minutes: 15 over), once', async () => {
    const rt = runtime();
    const s = await onLunch(rt, 45);
    await drop(rt, s.id);
    // A day passes: the break's start, the drop and its event all move back 20 hours.
    await pool().query(
      `UPDATE agency_agent_sessions SET state_since = state_since - interval '20 hours',
              suspended_break_since = suspended_break_since - interval '20 hours' WHERE id = $1`, [s.id]);
    await pool().query(`UPDATE agency_agent_session_events SET at = at - interval '20 hours' WHERE session_id = $1`, [s.id]);
    expect(Date.now() - (await row(s.id)).suspended_break_since!.getTime()).toBeGreaterThan(BREAK_RESUME_MAX_MS);

    expect(await rt.rehydrateAgent(s.id, (await sessions.readForStationAttach(s.id, 'web'))!)).toBe('break');
    const back = await row(s.id);
    expect(back).toMatchObject({ state: 'break', break_reason: 'lunch', suspended_break_since: null });
    expect(Date.now() - back.state_since.getTime()).toBeLessThan(60_000);
    expect(Date.now() - (await rt.agents.get(s.id))!.since!).toBeLessThan(60_000);
    const recorded = await overruns(s.id);
    expect(recorded).toMatchObject([{ from_state: 'break', to_state: 'offline', break_limit_minutes: 30 }]);
    aboutMinutes(recorded[0]!.break_overrun_seconds, 15);
    await sessions.setState(s.id, 'available', null);
    expect(await overruns(s.id)).toHaveLength(1);
    expect(metric.overrun).toHaveBeenCalledTimes(1);
  });

  it('a reserved break (device_away) is not carried: it comes back from now, as before', async () => {
    const rt = runtime();
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const s = await insertAgentSession(campaign.id as string, {
      state: 'break', break_reason: 'device_away', state_since: new Date(Date.now() - 30 * 60_000),
    }) as unknown as { id: string };
    await rt.agents.set(s.id, 'break', { leaseMs: AGENT_LEASE_MS.break, breakReason: 'device_away' });
    await drop(rt, s.id);
    expect(await rt.rehydrateAgent(s.id, (await sessions.readForStationAttach(s.id, 'mobile'))!)).toBe('break');
    const back = await row(s.id);
    expect(back).toMatchObject({ state: 'break', break_reason: 'device_away', suspended_break_since: null });
    expect(Date.now() - back.state_since.getTime()).toBeLessThan(60_000);
    expect(await overruns(s.id)).toEqual([]);
  });
});
