import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { insertAgencyCampaign, insertAgentSession, insertAgentSessionEvent } from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyAgentSessionRepository: repo } = await import('../../../src/db/repositories/agency.repository.js');
const { IdleSessionSweep } = await import('../../../src/agency/idle-session-sweep.js');

/**
 * OS9 on a real Postgres: the idle-session sweep's two statements (`findIdleOffline`, `leaveIdle`
 * in `agent-session.repository.ts`) and one pass of `IdleSessionSweep` over them. When a session
 * went offline is the later of `state_since` and its last `→ offline` event, so the startup
 * reaper's `markAllOffline` (which leaves `state_since` alone) never makes a working agent look idle.
 */

const HOUR = 60 * 60 * 1000;
const IDLE_MS = 2 * HOUR;
const ago = (ms: number) => new Date(Date.now() - ms);

async function sessionRow(id: string) {
  const { rows } = await getTestPool().query<{ state: string; left_at: Date | null; state_since: Date }>(
    'SELECT state, left_at, state_since FROM agency_agent_sessions WHERE id = $1', [id],
  );
  return rows[0]!;
}

async function eventCount(id: string): Promise<number> {
  const { rows } = await getTestPool().query<{ n: string }>(
    'SELECT count(*) AS n FROM agency_agent_session_events WHERE session_id = $1', [id],
  );
  return Number(rows[0]!.n);
}

describe('idle-session sweep (OS9): the statements', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('finds open sessions offline past the cutoff, oldest first, and nothing else', async () => {
    const c = await insertAgencyCampaign({ status: 'running' });
    const days = await insertAgentSession(c.id, { state: 'offline', state_since: ago(19 * 24 * HOUR) });
    const hours = await insertAgentSession(c.id, { state: 'offline', state_since: ago(3 * HOUR) });
    await insertAgentSession(c.id, { state: 'offline', state_since: ago(30 * 60 * 1000) }); // too recent
    await insertAgentSession(c.id, { state: 'available', state_since: ago(5 * HOUR) }); // working
    await insertAgentSession(c.id, { state: 'break', state_since: ago(5 * HOUR) }); // a break, Mode B's away-ring among them
    await insertAgentSession(c.id, { state: 'offline', state_since: ago(5 * HOUR), left_at: ago(4 * HOUR) }); // already left

    const found = await repo.findIdleOffline(IDLE_MS, 10);
    expect(found.map((r) => r.id)).toEqual([days.id, hours.id]);
    expect(found[0]!.offline_since.getTime()).toBeCloseTo(ago(19 * 24 * HOUR).getTime(), -4);
    expect(found[0]).toMatchObject({ tenant_id: days.tenant_id, account_id: days.account_id, agent_user_id: days.agent_user_id });

    expect((await repo.findIdleOffline(IDLE_MS, 1)).map((r) => r.id)).toEqual([days.id]);
  });

  it('dates a session by its last move to offline when that is later than state_since', async () => {
    const c = await insertAgencyCampaign({ status: 'running' });
    // state_since says 6 h; the session went offline 10 min ago (a restart's markAllOffline).
    const s = await insertAgentSession(c.id, { state: 'offline', state_since: ago(6 * HOUR) });
    await insertAgentSessionEvent({ ...s, campaign_id: c.id }, 'offline', ago(10 * 60 * 1000), { from_state: 'available' });
    expect(await repo.findIdleOffline(IDLE_MS, 10)).toEqual([]);
    expect(await repo.leaveIdle(s.id, IDLE_MS)).toBe(false);
    expect((await sessionRow(s.id)).left_at).toBeNull();
  });

  it('a working agent the startup reaper writes offline is not idle (markAllOffline, the real writer)', async () => {
    const c = await insertAgencyCampaign({ status: 'running' });
    const s = await insertAgentSession(c.id, { state: 'available', state_since: ago(5 * HOUR) });
    expect(await repo.markAllOffline()).toBe(1);
    const row = await sessionRow(s.id);
    expect(row.state).toBe('offline');
    expect(row.state_since.getTime()).toBeLessThan(ago(4 * HOUR).getTime()); // the reaper leaves it
    expect(await repo.findIdleOffline(IDLE_MS, 10)).toEqual([]);
    // A minute's cutoff finds it, dated to the reap.
    const [found] = await repo.findIdleOffline(0, 10);
    expect(found!.offline_since.getTime()).toBeGreaterThan(ago(60_000).getTime());
  });

  it('leaveIdle ends the session at the moment it went offline, and logs no transition', async () => {
    const c = await insertAgencyCampaign({ status: 'running' });
    const wentAt = ago(3 * HOUR);
    const s = await insertAgentSession(c.id, { state: 'offline', state_since: wentAt });
    const events = await eventCount(s.id);

    expect(await repo.leaveIdle(s.id, IDLE_MS)).toBe(true);
    const row = await sessionRow(s.id);
    expect(row.state).toBe('offline');
    expect(row.left_at!.getTime()).toBe(wentAt.getTime());
    expect(await eventCount(s.id)).toBe(events);
    // A second leave writes nothing.
    expect(await repo.leaveIdle(s.id, IDLE_MS)).toBe(false);
    expect(await repo.findIdleOffline(IDLE_MS, 10)).toEqual([]);
  });

  it('leaveIdle leaves alone a session that came back, or is not idle long enough', async () => {
    const c = await insertAgencyCampaign({ status: 'running' });
    const back = await insertAgentSession(c.id, { state: 'break', break_reason: 'tea', state_since: ago(3 * HOUR) });
    const recent = await insertAgentSession(c.id, { state: 'offline', state_since: ago(HOUR) });
    expect(await repo.leaveIdle(back.id, IDLE_MS)).toBe(false);
    expect(await repo.leaveIdle(recent.id, IDLE_MS)).toBe(false);
    expect((await sessionRow(back.id)).left_at).toBeNull();
    expect((await sessionRow(recent.id)).left_at).toBeNull();
  });

  it('an ended session frees the agent to join again (the one-live-session index)', async () => {
    const c = await insertAgencyCampaign({ status: 'running' });
    const s = await insertAgentSession(c.id, { state: 'offline', state_since: ago(3 * HOUR) });
    expect(await repo.leaveIdle(s.id, IDLE_MS)).toBe(true);
    const join = await repo.joinOrRehydrate({
      tenantId: s.tenant_id, accountId: s.account_id, campaignId: c.id, agentUserId: s.agent_user_id, replicaId: 'r1',
    });
    expect(join.ok).toBe(true);
    if (join.ok) expect(join.session.id).not.toBe(s.id);
  });
});

describe('idle-session sweep (OS9): one pass over the real statements', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('ends the idle session and keeps the one whose station is still attached', async () => {
    const c = await insertAgencyCampaign({ status: 'running' });
    const gone = await insertAgentSession(c.id, { state: 'offline', state_since: ago(3 * HOUR) });
    const attached = await insertAgentSession(c.id, { state: 'offline', state_since: ago(3 * HOUR) });
    const cleared: string[] = [];
    const detached: string[] = [];
    const sweep = new IdleSessionSweep({
      stations: {
        stationPresence: async (id) => (id === attached.id ? 'connected' : 'absent'),
        detach: (id) => { detached.push(id); },
        sessionEnded: () => undefined,
      },
      agents: { get: async () => ({ state: 'offline' }), clear: async (id) => { cleared.push(id); } },
      dialer: { hasLiveAttempt: () => false, hasRedialInFlight: () => false },
      softphone: { hasLiveCall: () => false },
    }, repo, { idleMs: IDLE_MS });

    expect(await sweep.sweep()).toBe(1);
    expect((await sessionRow(gone.id)).left_at).not.toBeNull();
    expect((await sessionRow(attached.id)).left_at).toBeNull();
    expect(cleared).toEqual([gone.id]);
    expect(detached).toEqual([gone.id]);
  });
});
