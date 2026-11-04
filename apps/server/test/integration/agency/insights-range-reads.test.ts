// Real Postgres: the insights range reads that do not read the rollup: agent state time and the
// online peak (the campaign variant of the shared occupancy intervals over
// agency_agent_session_events), and callback timing (IN4) over the booking attempts.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS } from '../setup/factories.js';
import {
  insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession, insertAgentShift,
} from './agency-factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const { agencyInsightsRollupRepository: repo, agencyAgentStatsRepository } = await import('../../../src/db/repositories/agency.repository.js');

const t = (hhmm: string, day = '2026-10-01'): Date => new Date(`${day}T${hhmm}:00.000Z`);
const MIN = 60;

beforeEach(truncateAll);
afterAll(closeTestPool);

/** Agent A (closed at 10:00), B (still on), D (10 minutes), and E on another campaign. */
async function floor() {
  const campaign = await insertAgencyCampaign({ status: 'running' });
  const other = await insertAgencyCampaign({ status: 'paused' });
  const a = await insertAgentSession(campaign.id, { joined_at: t('07:50'), left_at: t('10:00'), state: 'offline' });
  const b = await insertAgentSession(campaign.id, { joined_at: t('07:55') });
  const d = await insertAgentSession(campaign.id, { joined_at: t('09:05'), left_at: t('09:20'), state: 'offline' });
  const e = await insertAgentSession(other.id, { joined_at: t('07:00') });
  await insertAgentShift(a, [
    ['available', t('08:00')], ['reserved', t('08:30')], ['on_call', t('08:31')], ['wrapup', t('08:40')],
    ['break', t('08:45')], ['available', t('09:30')], ['offline', t('10:00')],
  ]);
  await getTestPool().query(`UPDATE agency_agent_session_events SET break_reason = 'lunch' WHERE session_id = $1 AND to_state = 'break'`, [a.id]);
  await insertAgentShift(b, [['break', t('08:00')], ['available', t('09:00')]]);
  await insertAgentShift(d, [['available', t('09:10')], ['offline', t('09:20')]]);
  await insertAgentShift(e, [['available', t('07:00')]]);
  return { campaign, a, b, d, e };
}

describe('agentStateSeconds', () => {
  it('splits each agent\'s window by state, reserved into available, break by reason', async () => {
    const { campaign, a, b, d } = await floor();
    const rows = await repo.agentStateSeconds({ campaignId: campaign.id, tenantId: DEFAULTS.tenantId, from: t('08:15'), to: t('10:15') });
    const byAgent = Object.fromEntries(rows.map(({ agent_user_id: id, ...rest }) => [id, rest]));
    expect(byAgent).toEqual({
      [a.agent_user_id]: { online_seconds: 105 * MIN, available: 46 * MIN, on_call: 9 * MIN, wrapup: 5 * MIN, break_by_reason: { lunch: 45 * MIN } },
      [b.agent_user_id]: { online_seconds: 120 * MIN, available: 75 * MIN, on_call: 0, wrapup: 0, break_by_reason: { unspecified: 45 * MIN } },
      [d.agent_user_id]: { online_seconds: 10 * MIN, available: 10 * MIN, on_call: 0, wrapup: 0, break_by_reason: {} },
    });
  });

  it('agrees with the per-agent record\'s occupancy over the same window (one interval spelling)', async () => {
    const { campaign, a } = await floor();
    const from = t('08:15');
    const to = t('10:15');
    const [mine] = (await repo.agentStateSeconds({ campaignId: campaign.id, tenantId: DEFAULTS.tenantId, from, to }))
      .filter((r) => r.agent_user_id === a.agent_user_id);
    const record = await agencyAgentStatsRepository.stats(
      { tenantId: DEFAULTS.tenantId, accountId: DEFAULTS.accountId, agentUserId: a.agent_user_id },
      { from, to, bucket: 'day', campaignId: campaign.id },
    );
    const occ = record.buckets.reduce((s, x) => ({
      shift: s.shift + x.occupancy.shift_seconds,
      available: s.available + x.occupancy.by_state.available + x.occupancy.by_state.reserved,
      on_call: s.on_call + x.occupancy.by_state.on_call,
      wrapup: s.wrapup + x.occupancy.by_state.wrapup,
      brk: s.brk + x.occupancy.by_state.break,
    }), { shift: 0, available: 0, on_call: 0, wrapup: 0, brk: 0 });
    expect({
      shift: mine!.online_seconds, available: mine!.available, on_call: mine!.on_call, wrapup: mine!.wrapup,
      brk: Object.values(mine!.break_by_reason).reduce((s, n) => s + n, 0),
    }).toEqual(occ);
  });

  it('reads another tenant\'s campaign as nobody', async () => {
    const { campaign } = await floor();
    expect(await repo.agentStateSeconds({ campaignId: campaign.id, tenantId: '00000000-0000-0000-0000-00000000dead', from: t('08:00'), to: t('10:00') })).toEqual([]);
  });
});

describe('agentsOnlinePeak', () => {
  it('peaks per bucket, zero-filled, a state change never counting one agent twice', async () => {
    const { campaign } = await floor();
    const q = { campaignId: campaign.id, tenantId: DEFAULTS.tenantId, from: t('08:00'), to: t('10:15') };
    expect(await repo.agentsOnlinePeak({ ...q, bucket: 'hour', timezone: 'UTC' })).toEqual([
      { bucket_start: '2026-10-01T08:00:00.000Z', agents_online_peak: 2 },
      { bucket_start: '2026-10-01T09:00:00.000Z', agents_online_peak: 3 },
      { bucket_start: '2026-10-01T10:00:00.000Z', agents_online_peak: 1 },
    ]);
    const quarters = await repo.agentsOnlinePeak({ ...q, bucket: 'quarter_hour', timezone: 'UTC' });
    expect(quarters.map((x) => x.agents_online_peak)).toEqual([2, 2, 2, 2, 3, 3, 2, 2, 1]);
    // UTC+05:45: local hours start at :15 past the UTC hour.
    expect(await repo.agentsOnlinePeak({ ...q, bucket: 'hour', timezone: 'Asia/Kathmandu' })).toEqual([
      { bucket_start: '2026-10-01T07:15:00.000Z', agents_online_peak: 2 },
      { bucket_start: '2026-10-01T08:15:00.000Z', agents_online_peak: 3 },
      { bucket_start: '2026-10-01T09:15:00.000Z', agents_online_peak: 3 },
    ]);
    expect(await repo.agentsOnlinePeak({ ...q, bucket: 'day', timezone: 'Asia/Kolkata' }))
      .toEqual([{ bucket_start: '2026-10-01', agents_online_peak: 3 }]);
    // A window with nobody on: every bucket, at zero.
    expect(await repo.agentsOnlinePeak({ ...q, from: t('03:00'), to: t('05:00'), bucket: 'hour', timezone: 'UTC' })).toEqual([
      { bucket_start: '2026-10-01T03:00:00.000Z', agents_online_peak: 0 },
      { bucket_start: '2026-10-01T04:00:00.000Z', agents_online_peak: 0 },
    ]);
  });
});

describe('callbackTiming', () => {
  it('classifies each callback booked in range by the follow-up dial (IN4), and the open ones by owner', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const owner = '00000000-0000-0000-0000-0000000000a1';
    let phone = 0;
    const contact = (o: Record<string, unknown> = {}) => insertAgencyContact(campaign.id, { phone_e164: `+9180000000${String(phone++).padStart(2, '0')}`, ...o });
    const book = async (c: { id: string }, callbackAt: Date, next?: { dialed_at: Date | null }) => {
      await insertAgencyAttempt(campaign.id, c.id, { attempt_number: 1, state: 'ended', outcome: 'connected', dialed_at: t('08:00'), callback_at: callbackAt, disposition_code: 'callback' });
      if (next) await insertAgencyAttempt(campaign.id, c.id, { attempt_number: 2, state: next.dialed_at ? 'ended' : 'queued', dialed_at: next.dialed_at });
    };
    await book(await contact(), t('10:00'), { dialed_at: t('10:10') });                                  // on time
    await book(await contact(), t('10:00'), { dialed_at: t('09:00') });                                  // early: kept
    await book(await contact(), t('10:00'), { dialed_at: t('10:30') });                                  // late
    await book(await contact({ state: 'completed' }), t('15:00'));                                        // missed: passed, closed
    await book(await contact({ assigned_user_id: owner, assigned_at: t('07:00') }), t('08:00', '2026-10-02'));  // overdue
    await book(await contact({ assigned_user_id: owner, assigned_at: t('07:00') }), t('20:00', '2026-10-02'));  // future
    await book(await contact({ state: 'exhausted' }), t('22:00', '2026-10-02'));                          // future (closed, not yet passed)
    await book(await contact(), t('11:00'), { dialed_at: null });                                         // a queued follow-up is no dial: overdue
    await book(await contact(), t('10:00', '2026-10-04'));                                                // out of range

    const q = { campaignId: campaign.id, tenantId: DEFAULTS.tenantId, from: t('00:00'), to: t('00:00', '2026-10-03'), now: t('12:00', '2026-10-02') };
    expect(await repo.callbackTiming(q)).toEqual({
      due_in_range: 8, kept_on_time: 2, kept_late: 1, missed: 1, pending_future: 2, pending_due: 2, pending: 4,
      by_owner: [
        { agent_user_id: null, open: 2, overdue: 1 },
        { agent_user_id: owner, open: 2, overdue: 1 },
      ].sort((x, y) => y.open - x.open || String(x.agent_user_id).localeCompare(String(y.agent_user_id))),
    });

    // The campaign ends: every callback never dialled is missed.
    await getTestPool().query(`UPDATE agency_campaigns SET status = 'stopped' WHERE id = $1`, [campaign.id]);
    expect(await repo.callbackTiming(q)).toMatchObject({ kept_on_time: 2, kept_late: 1, missed: 5, pending: 0, by_owner: [] });
    // Scoped by tenant.
    expect(await repo.callbackTiming({ ...q, tenantId: '00000000-0000-0000-0000-00000000dead' })).toBeNull();
  });

  it('reads the booking attempts through the callback index', async () => {
    const campaign = await insertAgencyCampaign();
    const client = await getTestPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `EXPLAIN (COSTS OFF) SELECT b.id FROM agency_call_attempts b
          WHERE b.campaign_id = $1 AND b.callback_at IS NOT NULL AND b.callback_at >= $2 AND b.callback_at < $3`,
        [campaign.id, t('00:00'), t('00:00', '2026-10-03')]);
      expect(rows.map((r) => r['QUERY PLAN']).join('\n')).toMatch(/idx_agency_attempts_campaign_callback/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
