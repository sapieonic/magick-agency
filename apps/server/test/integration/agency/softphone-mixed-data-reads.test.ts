import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeTestPool, getTestPool, truncateAll } from '../setup/test-utils.js';
import { DEFAULTS, uuidFor } from '../setup/factories.js';

vi.mock('@magick-agency/db', async (orig) => ({
  ...(await orig<typeof import('@magick-agency/db')>()),
  getPool: () => getTestPool(),
}));

const {
  agencyAgentSessionRepository, agencyAgentStatsRepository, agencyCampaignRepository, agencyLiveConcurrencyRepository,
} = await import('../../../src/db/repositories/agency.repository.js');
const {
  insertAgencyAttempt, insertAgencyCampaign, insertAgencyContact, insertAgentSession, insertAgentShift,
  insertManualCall, insertSoftphoneSession,
} = await import('./agency-factories.js');

/**
 * ─── THE CAMPAIGN READS WITH SOFT-PHONE ROWS BESIDE THEM ─────────────────────
 *
 * docs/softphone.md §2: a soft-phone session is a session with `campaign_id NULL` on
 * the `soft_phone` break, and a campaign session can switch onto that break. Every
 * read that walks `agency_agent_sessions` now meets both. These fixtures put campaign
 * and soft-phone rows side by side for one agent and one account, and assert what
 * each read answers:
 *
 * - the per-agent occupancy record and the roster are one measurement at two
 *   altitudes (`sql-fragments.ts`, "THE OCCUPANCY INTERVALS"), so their shift and
 *   break seconds agree, with and without a campaign filter;
 * - the campaign's own stats, floor and health inputs see its sessions (a switched
 *   one as a `soft_phone` break) and never the account's soft-phone sessions;
 * - the pacing candidate read takes no soft-phone session;
 * - the fleet's live-concurrency reads: attempts per campaign, and the soft phone's
 *   live calls in their own family (no campaign owns their carrier slots).
 */

const T = DEFAULTS.tenantId;
const A = DEFAULTS.accountId;
const AGENT = uuidFor('u-mixed-softphone');
const FROM = new Date('2026-08-18T00:00:00.000Z');
const TO = new Date('2026-08-19T00:00:00.000Z');
const at = (hhmm: string) => new Date(`2026-08-18T${hhmm}:00.000Z`);

async function close(sessionId: string, leftAt: Date): Promise<void> {
  await getTestPool().query('UPDATE agency_agent_sessions SET left_at = $2, state = $3 WHERE id = $1', [sessionId, leftAt, 'offline']);
}

/**
 * The agent's day: a campaign shift 09:00–12:00 with one call (90 min available, 30 on
 * the call, 5 in wrap-up, 55 on a lunch break), then a soft-phone session 13:00–15:00
 * on the `soft_phone` break throughout.
 */
async function mixedDay(zone = 'Asia/Kolkata') {
  const campaign = await insertAgencyCampaign({ default_timezone: zone, status: 'running' });
  const shift = await insertAgentSession(campaign.id as string, { agent_user_id: AGENT, joined_at: at('09:00') });
  await insertAgentShift(shift, [
    ['available', at('09:00')],
    ['on_call', at('10:30')],
    ['wrapup', at('11:00')],
    ['break', at('11:05')],
    ['offline', at('12:00')],
  ]);
  await close(shift.id as string, at('12:00'));
  const contact = await insertAgencyContact(campaign.id as string, { state: 'completed' });
  await insertAgencyAttempt(campaign.id as string, contact.id as string, {
    state: 'ended', outcome: 'connected', reserved_agent_id: shift.id,
    dialed_at: at('10:29'), answered_at: at('10:30'), bridged_at: at('10:30'), ended_at: at('11:00'), talk_seconds: 1800,
  });

  const phone = await insertSoftphoneSession({ agent_user_id: AGENT, joined_at: at('13:00') });
  await insertAgentShift(phone, [['break', at('13:00')], ['offline', at('15:00')]]);
  await close(phone.id as string, at('15:00'));
  return { campaign, shift, phone };
}

const CAMPAIGN_SHIFT = (3 * 60 - 0) * 60; // 09:00–12:00, every non-offline second
const CAMPAIGN_BREAK = 55 * 60;
const SOFTPHONE_BREAK = 2 * 3600;

describe('campaign reads beside soft-phone rows (integration)', () => {
  beforeEach(truncateAll);
  afterAll(closeTestPool);

  it('per-agent occupancy and the roster agree, soft-phone break time included', async () => {
    await mixedDay();
    const record = await agencyAgentStatsRepository.stats(
      { tenantId: T, accountId: A, agentUserId: AGENT }, { from: FROM, to: TO, bucket: 'day' } as never,
    );
    const roster = await agencyAgentStatsRepository.roster(
      { tenantId: T, accountId: A }, { from: FROM, to: TO, sort: 'attempts', order: 'desc', limit: 50 } as never,
    );
    expect(roster.rows).toHaveLength(1);
    const row = roster.rows[0]!;

    expect(record.totals.occupancy.shift_seconds).toBe(CAMPAIGN_SHIFT + SOFTPHONE_BREAK);
    expect(record.totals.occupancy.by_state.break).toBe(CAMPAIGN_BREAK + SOFTPHONE_BREAK);
    expect(row.shift_seconds).toBe(record.totals.occupancy.shift_seconds);
    expect(row.break_seconds).toBe(record.totals.occupancy.by_state.break);
  });

  it('with a campaign filter both reads leave the soft-phone session out, and still agree', async () => {
    const { campaign } = await mixedDay();
    const record = await agencyAgentStatsRepository.stats(
      { tenantId: T, accountId: A, agentUserId: AGENT },
      { from: FROM, to: TO, bucket: 'day', campaignId: campaign.id } as never,
    );
    const roster = await agencyAgentStatsRepository.roster(
      { tenantId: T, accountId: A },
      { from: FROM, to: TO, sort: 'attempts', order: 'desc', limit: 50, campaignId: campaign.id } as never,
    );
    expect(record.totals.occupancy.shift_seconds).toBe(CAMPAIGN_SHIFT);
    expect(record.totals.occupancy.by_state.break).toBe(CAMPAIGN_BREAK);
    expect(roster.rows[0]!.shift_seconds).toBe(CAMPAIGN_SHIFT);
    expect(roster.rows[0]!.break_seconds).toBe(CAMPAIGN_BREAK);
  });

  it('the soft-phone session is bucketed in UTC (it has no campaign zone), the campaign shift in its own', async () => {
    // Pacific/Auckland is UTC+12 in August: the campaign shift (09:00–12:00Z) is the
    // evening of the 18th there, and the soft-phone session (13:00–15:00Z) would be the
    // small hours of the 19th. In UTC it is the afternoon of the 18th.
    await mixedDay('Pacific/Auckland');
    const record = await agencyAgentStatsRepository.stats(
      { tenantId: T, accountId: A, agentUserId: AGENT }, { from: FROM, to: TO, bucket: 'day' } as never,
    );
    // (The campaign session's closing `offline` runs on into the 19th there, which is not
    // shift time; only the shift seconds are asserted per day.)
    const shift = Object.fromEntries(record.buckets.map((b) => [b.bucket_start, b.occupancy.shift_seconds]));
    expect(shift['2026-08-18']).toBe(CAMPAIGN_SHIFT + SOFTPHONE_BREAK);
    expect(shift['2026-08-19'] ?? 0).toBe(0);
  });

  it('campaign stats, floor and health count the switched campaign session, never a soft-phone session', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    await insertAgentSession(campaign.id as string, { state: 'break', break_reason: 'soft_phone' });
    await insertAgentSession(campaign.id as string, { state: 'available' });
    // The account's soft-phone sessions: no campaign, so no campaign read may count them.
    await insertSoftphoneSession();
    await insertSoftphoneSession();

    const stats = await agencyCampaignRepository.stats(campaign.id as string);
    expect(stats.agents_live).toBe(2);
    expect(stats.agents).toHaveLength(2);
    expect(stats.agents.map((a) => a.break_reason).sort()).toEqual([null, 'soft_phone'].sort());

    const health = await agencyCampaignRepository.healthInputs(campaign.id as string);
    expect(health.onBreakByReason).toEqual({ soft_phone: 1 });

    const candidates = await agencyAgentSessionRepository.findLiveForCampaign(campaign.id as string);
    expect(candidates).toHaveLength(2);
    expect(candidates.every((s) => s.campaign_id === campaign.id)).toBe(true);
  });

  it('fleet live concurrency: attempts by campaign, live soft-phone calls by tenant and state, ended ones in neither', async () => {
    const campaign = await insertAgencyCampaign({ status: 'running' });
    const contact = await insertAgencyContact(campaign.id as string, { state: 'in_flight' });
    await insertAgencyAttempt(campaign.id as string, contact.id as string, { state: 'bridged' });
    const shift = await insertAgentSession(campaign.id as string, { state: 'break', break_reason: 'soft_phone' });
    await insertManualCall(shift as never, { campaign_id: campaign.id, state: 'ringing' });
    await insertManualCall(await insertSoftphoneSession(), { state: 'bridged' });
    await insertManualCall(await insertSoftphoneSession(), { state: 'bridged' });
    await insertManualCall(await insertSoftphoneSession(), { state: 'ended', ended_at: new Date() });

    expect(await agencyLiveConcurrencyRepository.liveByState()).toEqual([
      { tenant_id: T, campaign_id: campaign.id, state: 'bridged', live: 1 },
    ]);
    const manual = await agencyLiveConcurrencyRepository.liveManualByState();
    expect([...manual].sort((a, b) => a.state.localeCompare(b.state))).toEqual([
      { tenant_id: T, state: 'bridged', live: 2 },
      { tenant_id: T, state: 'ringing', live: 1 },
    ]);
  });
});
