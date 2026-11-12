import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `computeHealth`'s `abandonment.auto_pauses` (`src/agency/insights/health.ts`): the abandonment
 * guardrail's pauses only. The carrier-account pause writes the same `agency_campaign.auto_paused`
 * event (reason `carrier_auth` or `carrier_account_unavailable`) and must not be listed as a
 * guardrail pause; the guardrail's oldest rows carry no reason and still count.
 */

const mocks = vi.hoisted(() => ({
  findFiltered: vi.fn(),
}));

vi.mock('@magick-agency/db/repositories/audit.repository', () => ({
  auditRepository: { findFiltered: mocks.findFiltered },
}));

vi.mock('../../../src/db/repositories/agency.repository.js', () => ({
  agencyInsightsReadRepository: {
    abandonmentWindow: vi.fn(async () => ({ answered: 10, abandoned: 1, rate_pct: 10 })),
  },
  agencyInsightsPacingRepository: {
    pacingHistory: vi.fn(async () => ({
      predial_dnc_suppressed: 0,
      predial_invalid_suppressed: 0,
      outside_calling_hours_deferrals: 0,
      concurrency_limit_minutes: 0,
      our_fault_retired: 0,
      minutes_by_reason: {},
      episodes: [],
      episodes_truncated: false,
      history_since: null,
    })),
  },
  agencyInsightsRollupRepository: {
    callerIds: vi.fn(async () => []),
    carrierFailures: vi.fn(async () => ({ failed: 0, by_code: [] })),
    recording: vi.fn(async () => ({ recorded: 0 })),
    asOf: vi.fn(async () => ({ as_of: null, pending_buckets: 0 })),
  },
}));

import { computeHealth, isGuardrailPause, todayRange } from '../../../src/agency/insights/health.js';
import type { AgencyCampaignRecord } from '../../../src/db/models/agency.model.js';
import type { ServedInsightsRange } from '../../../src/agency/insights/range.js';

const CAMPAIGN = {
  id: '00000000-0000-4000-8000-0000000000c1',
  tenant_id: '00000000-0000-4000-8000-0000000000a1',
  account_id: '00000000-0000-4000-8000-0000000000b1',
  default_timezone: 'Asia/Kolkata',
  abandonment_ceiling_pct: 3,
} as unknown as AgencyCampaignRecord;

const RANGE: ServedInsightsRange = {
  from: new Date('2026-11-04T00:00:00.000Z'),
  to: new Date('2026-11-05T00:00:00.000Z'),
  lifetime: false,
  clamped: false,
  bucket: null,
};

const row = (timestamp: string, eventData: Record<string, unknown>) => ({
  id: timestamp,
  timestamp,
  event_type: 'agency_campaign.auto_paused',
  event_data: { campaign_id: CAMPAIGN.id, ...eventData },
});

describe('computeHealth abandonment.auto_pauses', () => {
  beforeEach(() => {
    mocks.findFiltered.mockReset();
  });

  it('lists the guardrail\'s pauses, with or without a reason, and leaves the carrier\'s out', async () => {
    // Newest first, as `findFiltered` returns them.
    mocks.findFiltered.mockResolvedValue({
      total: null,
      rows: [
        row('2026-11-04T10:00:00.000Z', { reason: 'carrier_refusing_calls', telephony_provider: 'plivo', telephony_credential_id: 'c' }),
        row('2026-11-04T09:00:00.000Z', { reason: 'carrier_account_unavailable', telephony_provider: 'plivo', telephony_credential_id: 'c' }),
        row('2026-11-04T08:00:00.000Z', { reason: 'abandonment_ceiling', measured_pct: 3.4, ceiling_pct: 3 }),
        row('2026-11-04T07:00:00.000Z', { reason: 'carrier_auth', telephony_provider: 'plivo', telephony_credential_id: 'c' }),
        // The guardrail's oldest rows predate `reason`.
        row('2026-11-04T06:00:00.000Z', { measured_pct: 5.1, ceiling_pct: 5 }),
      ],
    });

    const health = await computeHealth(CAMPAIGN, RANGE, { now: new Date('2026-11-05T00:00:00.000Z') });

    expect(mocks.findFiltered).toHaveBeenCalledWith(expect.objectContaining({ eventTypes: ['agency_campaign.auto_paused'], campaignId: CAMPAIGN.id }));
    expect(health.abandonment.auto_pauses).toEqual([
      { at: '2026-11-04T06:00:00.000Z', measured_pct: 5.1, ceiling_pct: 5 },
      { at: '2026-11-04T08:00:00.000Z', measured_pct: 3.4, ceiling_pct: 3 },
    ]);
  });

  it('a range holding only carrier pauses has no guardrail pauses', async () => {
    mocks.findFiltered.mockResolvedValue({
      total: null,
      rows: [row('2026-11-04T07:00:00.000Z', { reason: 'carrier_auth' })],
    });
    const health = await computeHealth(CAMPAIGN, RANGE, { now: new Date('2026-11-05T00:00:00.000Z') });
    expect(health.abandonment.auto_pauses).toEqual([]);
  });
});

describe('isGuardrailPause', () => {
  it('is the guardrail\'s reason or none; any other writer\'s reason is not', () => {
    expect(isGuardrailPause({ reason: 'abandonment_ceiling' })).toBe(true);
    expect(isGuardrailPause({})).toBe(true);
    expect(isGuardrailPause({ reason: null })).toBe(true);
    expect(isGuardrailPause({ reason: 'carrier_auth' })).toBe(false);
    expect(isGuardrailPause({ reason: 'carrier_account_unavailable' })).toBe(false);
    expect(isGuardrailPause({ reason: 'carrier_refusing_calls' })).toBe(false);
  });
});

describe('todayRange (Home’s "today": the console’s Today range, as the range reads serve it)', () => {
  const campaign = (zone: string, createdAt = '2026-01-01T00:00:00.000Z') =>
    ({ default_timezone: zone, created_at: new Date(createdAt) }) as unknown as AgencyCampaignRecord;

  it('starts at the campaign zone’s midnight and ends at the bucket now falls in', () => {
    const now = new Date('2026-11-12T10:07:00.000Z');
    const range = todayRange(campaign('Asia/Kolkata'), now);
    // 12 Nov in Kolkata began at 18:30 UTC on the 11th.
    expect(range.from.toISOString()).toBe('2026-11-11T18:30:00.000Z');
    expect(range.to.toISOString()).toBe('2026-11-12T10:15:00.000Z');
    expect(range.lifetime).toBe(false);
  });

  it('is the UTC day when the zone is unknown, and the day before midnight in the zone is not today', () => {
    expect(todayRange(campaign('Mars/Olympus'), new Date('2026-11-12T10:07:00.000Z')).from.toISOString())
      .toBe('2026-11-12T00:00:00.000Z');
    // 18:20 UTC is still the 12th in UTC but 23:50 in Kolkata; 18:40 UTC is the 13th there.
    expect(todayRange(campaign('Asia/Kolkata'), new Date('2026-11-12T18:20:00.000Z')).from.toISOString())
      .toBe('2026-11-11T18:30:00.000Z');
    expect(todayRange(campaign('Asia/Kolkata'), new Date('2026-11-12T18:40:00.000Z')).from.toISOString())
      .toBe('2026-11-12T18:30:00.000Z');
  });

  it('a day 23 hours long (a spring-forward zone) still starts at its own midnight', () => {
    // 29 Mar 2026 in London: midnight is 00:00 GMT, the clocks go forward at 01:00.
    const range = todayRange(campaign('Europe/London'), new Date('2026-03-29T22:00:00.000Z'));
    expect(range.from.toISOString()).toBe('2026-03-29T00:00:00.000Z');
  });
});
