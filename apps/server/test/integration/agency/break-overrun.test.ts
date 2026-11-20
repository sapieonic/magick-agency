import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import { insertAgencyCampaign, insertAgentSession, insertSoftphoneSession } from './agency-factories.js';

const metric = vi.hoisted(() => ({ overrun: vi.fn() }));

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));
vi.mock('@magick-agency/observability/metrics/agency', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/observability/metrics/agency')>()),
  trackBreakOverrun: metric.overrun,
}));

const { agencyAgentSessionRepository: sessions, agencyReportDatasetRepository: reports } =
  await import('../../../src/db/repositories/agency.repository.js');

/**
 * A break over its limit, recorded on the event that ends it (agent station BE-12, AS12;
 * `0060_session_event_break_overrun.sql`) on a real Postgres: every writer that ends a break through
 * the session-transition statement (`setState` to another state or another break, the station's
 * presence `offline`, `leave`) judges it against the campaign's catalog with `breakOverrun`; the
 * startup reaper (`markAllOffline`) never does; a reserved break, a reason with no limit and a break
 * inside its limit write nothing; each overrun is counted once (`agency_break_overruns_total`); the
 * agent report sums them (`agentBreakOverruns`).
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const pool = () => getTestPool();

beforeEach(async () => {
  await truncateAll();
  metric.overrun.mockClear();
});
afterAll(closeTestPool);

async function onBreak(reason: string, minutesAgo: number, catalog: unknown[] = []): Promise<{ id: string; agent_user_id: string }> {
  const campaign = await insertAgencyCampaign({ status: 'running', break_reasons: JSON.stringify(catalog) });
  const s = await insertAgentSession(campaign.id as string, {
    state: 'break', break_reason: reason, state_since: new Date(Date.now() - minutesAgo * 60_000),
  });
  return s as unknown as { id: string; agent_user_id: string };
}

async function lastEvent(sessionId: string) {
  const { rows } = await pool().query(
    `SELECT from_state, to_state, break_limit_minutes, break_overrun_seconds FROM agency_agent_session_events
      WHERE session_id = $1 ORDER BY at DESC LIMIT 1`, [sessionId]);
  return rows[0] as { from_state: string; to_state: string; break_limit_minutes: number | null; break_overrun_seconds: number | null };
}

describe('the event that ends a break', () => {
  it('Tea (15 min, the built-ins) taken for 17: the event back to Ready carries the limit and about 120 s over; counted once', async () => {
    // FALSIFIED: with the columns dropped from `recordTransitions`' INSERT, the event carries nulls
    // and this reds.
    const s = await onBreak('tea', 17);
    await sessions.setState(s.id, 'available', null);
    const e = await lastEvent(s.id);
    expect(e).toMatchObject({ from_state: 'break', to_state: 'available', break_limit_minutes: 15 });
    expect(e.break_overrun_seconds).toBeGreaterThanOrEqual(119);
    expect(e.break_overrun_seconds).toBeLessThanOrEqual(125);
    expect(metric.overrun).toHaveBeenCalledTimes(1);
    expect(metric.overrun).toHaveBeenCalledWith(T);
  });

  it('the campaign\'s own catalog; a switch to another break and the session\'s end are ends too', async () => {
    const prayer = [{ code: 'prayer', label: 'Prayer', limit_minutes: 5 }, { code: 'meeting', label: 'Meeting' }];
    const switched = await onBreak('prayer', 7, prayer);
    await sessions.setState(switched.id, 'break', 'meeting');
    expect(await lastEvent(switched.id)).toMatchObject({ from_state: 'break', to_state: 'break', break_limit_minutes: 5 });
    const left = await onBreak('lunch', 40);
    await sessions.leave(left.id);
    expect(await lastEvent(left.id)).toMatchObject({ to_state: 'offline', break_limit_minutes: 30 });
    // The station's close (presence offline, the reason kept) ends it as well.
    const closed = await onBreak('tea', 20);
    await sessions.setState(closed.id, 'offline');
    expect(await lastEvent(closed.id)).toMatchObject({ to_state: 'offline', break_limit_minutes: 15 });
    expect(metric.overrun).toHaveBeenCalledTimes(3);
  });

  it('nothing written or counted: inside the limit, a reason with no limit, a reserved break, the soft phone, a transition not out of a break', async () => {
    const inside = await onBreak('tea', 10);
    const noLimit = await onBreak('break', 120);
    const away = await onBreak('device_away', 120);
    const soft = await insertSoftphoneSession({ state_since: new Date(Date.now() - 120 * 60_000) }) as unknown as { id: string };
    const ready = await onBreak('tea', 0);
    await sessions.setState(ready.id, 'available', null);
    await pool().query(`UPDATE agency_agent_sessions SET state_since = now() - interval '2 hours' WHERE id = $1`, [ready.id]);
    for (const id of [inside.id, noLimit.id, away.id, soft.id, ready.id]) {
      if (id === soft.id) await sessions.leave(id);
      else await sessions.setState(id, id === ready.id ? 'reserved' : 'available', null);
      expect(await lastEvent(id), id).toMatchObject({ break_limit_minutes: null, break_overrun_seconds: null });
    }
    expect(metric.overrun).not.toHaveBeenCalled();
  });

  it('the startup reaper (a restart) never judges a break it cuts', async () => {
    const s = await onBreak('tea', 60);
    expect(await sessions.markAllOffline()).toBe(1);
    expect(await lastEvent(s.id)).toMatchObject({ from_state: 'break', to_state: 'offline', break_limit_minutes: null, break_overrun_seconds: null });
    expect(metric.overrun).not.toHaveBeenCalled();
  });
});

describe('the agent report\'s sum (agentBreakOverruns)', () => {
  it('the agent\'s overruns that ended in the window, in this account only', async () => {
    const agent = randomUUID();
    const campaign = await insertAgencyCampaign({ status: 'running' });
    for (const minutes of [17, 31]) {
      const s = await insertAgentSession(campaign.id as string, {
        agent_user_id: agent, state: 'break', break_reason: minutes === 17 ? 'tea' : 'lunch',
        state_since: new Date(Date.now() - minutes * 60_000),
      }) as unknown as { id: string };
      await sessions.leave(s.id);
    }
    const scope = { agentUserId: agent, tenantId: T, accountId: A, from: new Date(Date.now() - 3_600_000), to: new Date(Date.now() + 60_000) };
    const sum = await reports.agentBreakOverruns(scope);
    expect(sum.breaks).toBe(2);
    expect(sum.seconds_over).toBeGreaterThanOrEqual(120 + 60 - 2);
    expect(sum.seconds_over).toBeLessThanOrEqual(120 + 60 + 10);
    expect(await reports.agentBreakOverruns({ ...scope, accountId: randomUUID() })).toEqual({ breaks: 0, seconds_over: 0 });
    expect(await reports.agentBreakOverruns({ ...scope, to: new Date(Date.now() - 1_800_000) })).toEqual({ breaks: 0, seconds_over: 0 });
  });
});
