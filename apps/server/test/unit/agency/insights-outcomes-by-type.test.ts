import { describe, expect, it } from 'vitest';
import { AGENCY_SYSTEM_OUTCOME_LABELS } from '@magick-agency/contracts/api/agency/call-log';
import { AUTO_DISPOSITION_CODE } from '../../../src/agency/disposition.js';
import { outcomesByType } from '../../../src/agency/insights/activity.js';
import {
  inboundCampaignCountsStatement,
  outcomesByTypeStatement,
  readInboundCampaignCounts,
} from '../../../src/db/repositories/agency/inbound-campaign-sql.js';
import {
  inboundAnsweredSql,
  inboundCampaignRowConditions,
  inboundMissedOpenSql,
  inboundMissedSql,
  inboundOpenHoursSql,
} from '../../../src/db/repositories/agency/sql-fragments.js';

/**
 * Calls by type (`docs/call-log.md` §6): the pure half. The merge of the three types' outcomes
 * into one table, and the inbound figures' statement held to the Call log's own SQL fragments,
 * so the figure and the list cannot spell "an inbound call of this campaign" apart. The counts
 * on real rows are `test/integration/api/agency-calls-by-type.test.ts`.
 */

const labels = new Map<string, string | null>([['will_pay', 'Will pay'], ['call_later', 'Call later']]);
const success = new Set(['will_pay']);

describe('outcomesByType', () => {
  it('puts each call under its one type, adds the row, and lists the largest total first', () => {
    const rows = outcomesByType(
      [{ code: 'will_pay', count: 96 }, { code: 'call_later', count: 121 }, { code: null, count: 4 }],
      [
        { source: 'soft_phone', code: 'will_pay', count: 14 },
        { source: 'inbound', code: 'will_pay', count: 21 },
        { source: 'inbound', code: 'call_later', count: 8 },
        { source: 'inbound', code: null, count: 2 },
      ],
      labels,
      success,
    );
    expect(rows).toEqual([
      { code: 'will_pay', label: 'Will pay', is_success: true, dialler: 96, soft_phone: 14, inbound: 21, total: 131 },
      { code: 'call_later', label: 'Call later', is_success: false, dialler: 121, soft_phone: 0, inbound: 8, total: 129 },
      { code: null, label: null, is_success: false, dialler: 4, soft_phone: 0, inbound: 2, total: 6 },
    ]);
    // Nothing is counted twice: the totals are the inputs' sum.
    expect(rows.reduce((s, r) => s + r.total, 0)).toBe(96 + 121 + 4 + 14 + 21 + 8 + 2);
  });

  it('lists an outcome only another type holds, a code the catalog no longer has, and no empty row', () => {
    const rows = outcomesByType(
      [{ code: 'will_pay', count: 0 }],
      [{ source: 'soft_phone', code: 'retired_code', count: 3 }],
      labels,
      success,
    );
    expect(rows).toEqual([{ code: 'retired_code', label: null, is_success: false, dialler: 0, soft_phone: 3, inbound: 0, total: 3 }]);
  });
});

describe('a system code in the outcomes by type', () => {
  it('reads "No outcome chosen" for no_disposition, on every type, apart from a call with no code at all', () => {
    const rows = outcomesByType(
      [{ code: 'no_disposition', count: 5 }, { code: null, count: 2 }],
      [{ source: 'soft_phone', code: 'no_disposition', count: 3 }, { source: 'inbound', code: 'no_disposition', count: 1 }],
      labels,
      success,
    );
    expect(rows).toEqual([
      { code: 'no_disposition', label: 'No outcome chosen', is_success: false, dialler: 5, soft_phone: 3, inbound: 1, total: 9 },
      { code: null, label: null, is_success: false, dialler: 2, soft_phone: 0, inbound: 0, total: 2 },
    ]);
  });

  it('names the code the server stamps, not a spelling of its own', () => {
    expect(Object.keys(AGENCY_SYSTEM_OUTCOME_LABELS)).toEqual([AUTO_DISPOSITION_CODE]);
  });

  it('keeps a catalog\'s own label for a code, and leaves a retired code with none', () => {
    const own = outcomesByType([{ code: 'no_disposition', count: 1 }, { code: 'retired', count: 1 }], [], new Map([['no_disposition', 'Ran out of time']]), success);
    expect(own.map((r) => [r.code, r.label])).toEqual([['no_disposition', 'Ran out of time'], ['retired', null]]);
  });
});

describe('the inbound figures\' statement', () => {
  const q = { campaignId: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222' };
  const from = new Date('2026-11-22T00:00:00Z');
  const to = new Date('2026-11-23T00:00:00Z');

  it('counts by campaign_id, never the match or the outcome\'s catalog', () => {
    for (const { text } of [inboundCampaignCountsStatement({ ...q, from, to }), outcomesByTypeStatement({ ...q, from, to })]) {
      expect(text).toContain('i.campaign_id = $1::uuid');
      expect(text).not.toContain('matched_campaign_id');
      expect(text).not.toContain('disposition_source');
    }
  });

  it('spells what an inbound row is with the Call log\'s own fragments, in both halves', () => {
    const { text } = inboundCampaignCountsStatement({ ...q, from, to });
    for (const term of inboundCampaignRowConditions('i')) expect(text.split(term).length - 1, term).toBe(2);
    expect(text).toContain(inboundAnsweredSql('i'));
    expect(text).toContain(inboundMissedSql('i'));
    expect(text).toContain(inboundOpenHoursSql('i'));
    expect(text).toContain(inboundMissedOpenSql('i'));
    expect(inboundCampaignRowConditions('i')).toEqual(["i.state = 'ended'", "i.outcome IS DISTINCT FROM 'rejected'"]);
  });

  it('cuts the window half-open on arrived_at, and the calls to follow up by no date at all', () => {
    const { text, values } = inboundCampaignCountsStatement({ ...q, from, to });
    expect(values).toEqual([q.campaignId, q.tenantId, from, to]);
    expect(text).toContain('i.arrived_at >= $3::timestamptz');
    expect(text).toContain('i.arrived_at < $4::timestamptz');
    const openHalf = text.slice(text.indexOf('(SELECT count(*)::int'), text.indexOf('AS open_follow_ups'));
    expect(openHalf).toContain(inboundMissedOpenSql('i'));
    expect(openHalf).not.toContain('arrived_at');
    // Named by the campaign's own account, so it reads the account's open Missed rows
    // (`idx_agency_inbound_calls_missed`) and not every call the campaign ever had.
    expect(openHalf).toContain('i.account_id = (SELECT c.account_id FROM agency_campaigns c WHERE c.id = $1::uuid)');
  });

  it('with no range reads the campaign\'s whole life, and with no tenant takes the campaign\'s own', () => {
    const { text, values } = inboundCampaignCountsStatement({ campaignId: q.campaignId, tenantId: null });
    expect(values).toEqual([q.campaignId]);
    expect(text).not.toContain('arrived_at');
    expect(text).toContain('(SELECT c.tenant_id FROM agency_campaigns c WHERE c.id = $1::uuid)');
  });

  it('reads a count row defensively', () => {
    expect(readInboundCampaignCounts(undefined)).toEqual({ received: 0, answered: 0, missed: 0, open_follow_ups: 0, talk_seconds: 0, open_hours: 0 });
    expect(readInboundCampaignCounts({ received: '5', answered: 2, missed: null, talk_seconds: '352' }))
      .toEqual({ received: 5, answered: 2, missed: 0, open_follow_ups: 0, talk_seconds: 352, open_hours: 0 });
  });
});
