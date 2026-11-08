/**
 * The fixtures hold the dataset contract's own sum rules, so a template or workbook test that
 * checks a printed figure is checking a figure a real dataset could carry.
 */
import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { REPORT_DETAIL_SHEETS_BY_KIND } from '@magick-agency/contracts/reports';
import { accountFixture } from './fixtures/account';
import { agentFixture } from './fixtures/agent';
import { campaignFixture } from './fixtures/campaign';

const lines = (b: Buffer) => gunzipSync(b).toString('utf8').split('\n').filter(Boolean).length;

describe('agent fixture', () => {
  const { dataset: d, details } = agentFixture();
  const sum = (k: keyof (typeof d.daily)[number]) => d.daily.reduce((s, r) => s + (r[k] as number), 0);

  it('has one daily row per day, summing to the record and presence', () => {
    expect(d.daily).toHaveLength(d.range.days);
    expect(sum('dials')).toBe(d.record.attempts);
    expect(sum('connected')).toBe(d.record.connected);
    expect(sum('successes')).toBe(d.record.successes);
    expect(sum('talk_s')).toBe(d.record.talk_seconds);
    expect(sum('on_call_s')).toBe(d.presence.by_state.on_call);
    expect(sum('station_s')).toBe(d.presence.station_seconds);
    expect(d.presence.break_by_reason.reduce((s, b) => s + b.seconds, 0)).toBe(d.presence.by_state.break);
    expect(d.outcomes.reduce((s, o) => s + o.conversations, 0)).toBe(sum('conversations'));
    expect(d.presence.days_worked).toBe(22);
  });

  it('per-campaign rows sum to the record', () => {
    expect(d.per_campaign.reduce((s, r) => s + r.attempts, 0)).toBe(d.record.attempts);
    expect(d.per_campaign.reduce((s, r) => s + r.successes, 0)).toBe(d.record.successes);
    expect(d.per_campaign.some((r) => !r.rates_reportable)).toBe(true);
  });

  it('the timeline is contiguous and covers the day', () => {
    const segs = d.timeline!.segments;
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.start).toBe(segs[i - 1]!.end);
    expect(Date.parse(segs.at(-1)!.end) - Date.parse(segs[0]!.start)).toBe(86_400_000);
  });

  it('detail files carry the rows they say, in kind order; self drops the recording and sentiment columns', () => {
    expect(d.detail_files.map((f) => f.sheet)).toEqual(REPORT_DETAIL_SHEETS_BY_KIND.agent);
    for (const f of d.detail_files) expect(lines(details.get(f.key)!)).toBe(f.rows);
    expect(d.detail_files[2]!.rows).toBe(d.record.attempts);
    const self = agentFixture({ audience: 'self' }).dataset;
    expect(self.benchmark).toBeNull();
    expect(self.quality).toBeNull();
    expect(self.detail_files[2]!.columns.map((c) => c.key)).not.toContain('sentiment');
  });
});

describe('campaign fixture', () => {
  const { dataset: d, details } = campaignFixture();
  it('trend buckets, agent rows and best hours sum to the calls block', () => {
    expect(d.trends.buckets).toHaveLength(d.range.days);
    expect(d.trends.buckets.reduce((s, b) => s + b.dials, 0)).toBe(d.activity.calls.dials);
    expect(d.trends.buckets.reduce((s, b) => s + b.human_connects, 0)).toBe(d.activity.calls.human_connects);
    expect(d.activity.agents.reduce((s, a) => s + a.dials, 0)).toBe(d.activity.calls.dials);
    expect(d.trends.best_hours.reduce((s, h) => s + h.dials, 0)).toBe(d.activity.calls.dials);
    expect(d.activity.outcomes.reduce((s, o) => s + o.count, 0)).toBe(d.activity.calls.conversations);
    expect(lines(details.get(d.detail_files[0]!.key)!)).toBe(d.activity.calls.dials);
  });
});

describe('account fixture', () => {
  const { dataset: d, details } = accountFixture();
  it('totals are the campaigns summed; the roster sums to the campaigns; the attempts sheet is truncated', () => {
    expect(d.totals.calls.dials).toBe(d.campaigns.reduce((s, c) => s + c.calls.dials, 0));
    expect(d.daily.reduce((s, r) => s + r.dials, 0)).toBe(d.totals.calls.dials);
    const abandoned = d.totals.calls.by_outcome.abandoned;
    expect(d.agents.reduce((s, a) => s + a.attempts, 0)).toBe(d.totals.calls.dials - abandoned);
    expect(d.agents.some((a) => !a.rates_reportable)).toBe(true);
    expect(d.detail_files[0]!.truncated).toBe(true);
    expect(lines(details.get(d.detail_files[0]!.key)!)).toBe(d.detail_files[0]!.rows);
  });
});
