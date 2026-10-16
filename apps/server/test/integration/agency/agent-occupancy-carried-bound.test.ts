import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, uuidFor } from '../setup/factories.js';

vi.mock('@magick-agency/db', () => ({ getPool: () => getTestPool() }));

const { agencyAgentStatsRepository } = await import('../../../src/db/repositories/agency.repository.js');
const {
  insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession, insertAgentShift,
} = await import('./agency-factories.js');

/**
 * ─── The carried-in state when it was set LONG before the window ─────────────
 *
 * Both occupancy reads (`stats()`'s `occupancyBuckets` and the roster's
 * `rosterOccupancyTotals`) bound their `carried` CTE — "the last event before
 * `from`, per session" — to events at or after the earliest `joined_at` of the
 * sessions overlapping the window, so the range scan on
 * `idx_agency_session_events_agent (agent_user_id, at)` stops there instead of
 * reading the agent's whole tenure. That is exact because a session's events
 * never predate its `joined_at` (see the repository's `carriedEventsSql`).
 *
 * These cases put the state an agent is in at `from` a MONTH back, behind two
 * months of closed shifts with many events of their own, and require that state to
 * be carried across the whole window, on both reads.
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const AGENT = uuidFor('u-long-tenure');
const FROM = new Date('2026-08-18T00:00:00.000Z');
const TO = new Date('2026-08-19T00:00:00.000Z');
const DAY = 86_400;

async function close(sessionId: string, leftAt: Date): Promise<void> {
  await getTestPool().query('UPDATE agency_agent_sessions SET left_at = $2 WHERE id = $1', [sessionId, leftAt]);
}

/** A closed shift with a dozen transitions, on `day`. */
async function busyPastShift(campaignId: string, day: string) {
  const session = await insertAgentSession(campaignId, { agent_user_id: AGENT, joined_at: new Date(`${day}T08:00:00Z`) });
  const steps: Array<[string, Date]> = [['break', new Date(`${day}T08:00:00Z`)]];
  for (let h = 9; h < 15; h++) {
    const hh = String(h).padStart(2, '0');
    steps.push(['available', new Date(`${day}T${hh}:00:00Z`)]);
    steps.push(['on_call', new Date(`${day}T${hh}:20:00Z`)]);
  }
  steps.push(['offline', new Date(`${day}T16:00:00Z`)]);
  await insertAgentShift(session, steps);
  await close(session.id as string, new Date(`${day}T16:00:00Z`));
}

describe('occupancy carries a state set long before the window (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('a session that went available a month ago and never moved is available all window, on both reads', async () => {
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'running' });
    for (const day of ['2026-06-10', '2026-06-20', '2026-07-01', '2026-07-10']) {
      await busyPastShift(campaign.id as string, day);
    }
    // Joined 2026-07-18, went available a minute later, and has not moved since.
    const live = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-07-18T08:00:00Z'),
    });
    await insertAgentShift(live, [
      ['break', new Date('2026-07-18T08:00:00Z')],
      ['available', new Date('2026-07-18T08:01:00Z')],
    ]);
    // One dial in the window, so the attempts-driven roster has a row for this agent.
    const contact = await insertAgencyContact(campaign.id as string, { state: 'completed' });
    await insertAgencyAttempt(campaign.id as string, contact.id as string, {
      state: 'ended', outcome: 'no_answer', reserved_agent_id: live.id,
      dialed_at: new Date('2026-08-18T12:00:00Z'), ended_at: new Date('2026-08-18T12:00:30Z'),
    });

    const record = await agencyAgentStatsRepository.stats(
      { tenantId: T, accountId: A, agentUserId: AGENT }, { from: FROM, to: TO, bucket: 'day' },
    );
    expect(record.totals.occupancy.by_state.available).toBe(DAY);
    expect(record.totals.occupancy.shift_seconds).toBe(DAY);
    expect(record.totals.occupancy.by_state.offline).toBe(0);

    const roster = await agencyAgentStatsRepository.roster(
      { tenantId: T, accountId: A },
      { from: FROM, to: TO, sort: 'attempts', order: 'desc', limit: 50 } as never,
    );
    expect(roster.rows).toHaveLength(1);
    expect(roster.rows[0]!.shift_seconds).toBe(DAY);
    expect(roster.rows[0]!.break_seconds).toBe(0);
  });

  it('two overlapping sessions, one joined weeks before the other: each carries its own state', async () => {
    const campaign = await insertAgencyCampaign({ default_timezone: 'UTC', status: 'running' });
    await busyPastShift(campaign.id as string, '2026-06-15');
    // Joined 2026-07-20 and on a break since; left at 06:00 inside the window.
    const old = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-07-20T08:00:00Z'),
    });
    await insertAgentShift(old, [['break', new Date('2026-07-20T08:00:00Z')]]);
    await insertAgentShift(old, [['offline', new Date('2026-08-18T06:00:00Z')]]);
    await close(old.id as string, new Date('2026-08-18T06:00:00Z'));
    // Joined the evening before the window, available since 23:00.
    const recent = await insertAgentSession(campaign.id as string, {
      agent_user_id: AGENT, joined_at: new Date('2026-08-17T22:00:00Z'),
    });
    await insertAgentShift(recent, [
      ['break', new Date('2026-08-17T22:00:00Z')],
      ['available', new Date('2026-08-17T23:00:00Z')],
    ]);

    const record = await agencyAgentStatsRepository.stats(
      { tenantId: T, accountId: A, agentUserId: AGENT }, { from: FROM, to: TO, bucket: 'day' },
    );
    expect(record.totals.occupancy.by_state.break).toBe(6 * 3600);
    expect(record.totals.occupancy.by_state.available).toBe(DAY);
    // The old session's offline interval runs from 06:00 to the window's end.
    expect(record.totals.occupancy.by_state.offline).toBe(18 * 3600);
  });
});
