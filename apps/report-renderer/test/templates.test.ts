/**
 * The HTML each template renders: the right figures under the right labels, rates without
 * enough calls as words (never 0), and the `self` audience's copy with no benchmark or quality
 * block at all (RP5).
 */
import { describe, expect, it } from 'vitest';
import { count, dayLabel, duration, pct } from '../src/format';
import { renderReportHtml } from '../src/pdf/render-pdf';
import { accountFixture } from './fixtures/account';
import { agentClockChangeFixture, agentFixture } from './fixtures/agent';
import { campaignFixture } from './fixtures/campaign';

const NO_FONTS = { fonts: { css: '', embedded: false } };

/** The HTML of one `data-block` / `data-page` / `data-kpi` element (to its matching close is not needed: a slice to the next block). */
function block(html: string, attr: string, name: string): string {
  const start = html.indexOf(`${attr}="${name}"`);
  if (start < 0) return '';
  const next = html.indexOf(`${attr}="`, start + attr.length + name.length + 3);
  return html.slice(start, next < 0 ? undefined : next);
}
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

describe('agent review', () => {
  const { dataset: d } = agentFixture();
  const html = renderReportHtml(d, NO_FONTS);
  const t = text(html);

  it('prints the record’s figures on page 1 under their labels', () => {
    expect(text(block(html, 'data-kpi', 'station'))).toContain(duration(d.presence.station_seconds));
    expect(text(block(html, 'data-kpi', 'connected'))).toContain(count(d.record.connected));
    expect(text(block(html, 'data-kpi', 'connected'))).toContain(`of ${count(d.record.attempts)} dials`);
    expect(text(block(html, 'data-kpi', 'connect_rate'))).toContain(pct(d.record.connect_rate_pct!));
    // RP11: the occupancy tile is the roster's occupancy_pct.
    expect(text(block(html, 'data-kpi', 'occupancy'))).toContain(pct(d.roster_row!.occupancy_pct!));
    expect(t).toContain(`on a call ${pct(d.occupancy.on_call_pct!)} of station time, ${pct(d.occupancy.on_call_pct_excl_break!)} excluding breaks`);
  });

  it('lists one sessions row per day worked and the representative day', () => {
    const sessions = block(html, 'data-block', 'sessions');
    expect((sessions.match(/<tr>/g) ?? []).length - 1).toBe(d.presence.days_worked);
    expect(t).toContain('A representative day');
  });

  it('draws the outcomes, the floor bands and call analysis in the supervisor’s copy', () => {
    for (const o of d.outcomes.slice(0, 3)) expect(text(block(html, 'data-block', 'outcomes'))).toContain(o.label);
    expect(html).toContain('data-block="floor"');
    expect(text(block(html, 'data-block', 'floor'))).toContain(`compared with ${d.benchmark!.pool_size} agents`);
    expect(html).toContain('data-block="quality"');
    const quality = text(block(html, 'data-block', 'quality'));
    expect(quality).toContain(count(d.quality!.sentiment.positive));
    // Mixed is its own part of the bar and the legend, never folded into neutral.
    expect(d.quality!.sentiment.mixed).toBeGreaterThan(0);
    expect(quality).toContain(`Mixed ${count(d.quality!.sentiment.mixed)} (`);
    expect(quality).toContain(`Neutral ${count(d.quality!.sentiment.neutral)} (`);
  });

  it('writes a per-campaign rate below the roster floor as words, not 0', () => {
    const legacy = d.per_campaign.find((r) => !r.rates_reportable)!;
    expect(legacy.connect_rate_pct).not.toBeNull();
    const row = text(block(html, 'data-block', 'per-campaign')).split(legacy.campaign_name)[1]!.slice(0, 200);
    expect(row).toContain('Not enough calls to rate');
    expect(row).not.toContain(pct(legacy.connect_rate_pct!));
  });

  it('prints the definitions and notes on the last page', () => {
    const last = text(block(html, 'data-page', 'definitions'));
    for (const def of d.definitions) expect(last).toContain(def.label);
    expect(last).toContain(d.notes[0]!);
  });
});

describe('agent review, the representative day on a clock change', () => {
  /** The timeline strip's state rectangles (x, width) in order, and its hour tick labels. */
  function strip(html: string) {
    const svg = block(html, 'data-block', 'timeline');
    const rects = [...svg.matchAll(/<rect x="([\d.]+)" y="4" width="([\d.]+)" height="26" fill="(?!#f6f7f9)[^"]+"><title>/g)].map((m) => ({
      x: Number(m[1]),
      w: Number(m[2]),
    }));
    const ticks = [...svg.matchAll(/font-family="[^"]*Mono[^"]*"[^>]*>([^<]+)<\/text>/g)].map((m) => m[1]);
    return { rects, ticks, text: text(svg) };
  }

  it('draws a 25-hour day by elapsed time: segments in order, an hour of the scale twice', () => {
    const d = agentClockChangeFixture('back');
    const { rects, ticks, text: t } = strip(renderReportHtml(d, NO_FONTS));
    expect(rects.length).toBe(d.timeline!.segments.length);
    // Every segment starts where the one before it ended: none drawn over another.
    for (let i = 1; i < rects.length; i++) expect(rects[i]!.x).toBeCloseTo(rects[i - 1]!.x + rects[i - 1]!.w, 1);
    // 01 twice (BST, then GMT), then on to 23: the scale runs past 24 hours in.
    expect(ticks.filter((h) => h === '01')).toHaveLength(2);
    expect(ticks.at(-1)).toBe('23');
    expect(ticks.length).toBe(24);
    expect(t).toContain('last out 22:30');
    expect(t).toContain('A 25-hour day: the clocks went back');
  });

  it('draws a 23-hour day with the skipped hour missing from the scale', () => {
    const d = agentClockChangeFixture('forward');
    const { rects, ticks, text: t } = strip(renderReportHtml(d, NO_FONTS));
    for (let i = 1; i < rects.length; i++) expect(rects[i]!.x).toBeCloseTo(rects[i - 1]!.x + rects[i - 1]!.w, 1);
    expect(ticks).not.toContain('01');
    expect(ticks.slice(0, 2)).toEqual(['00', '02']);
    expect(t).toContain('A 23-hour day: the clocks went forward');
  });

  it('says nothing about clocks on an ordinary day', () => {
    expect(renderReportHtml(agentFixture().dataset, NO_FONTS)).not.toContain('data-note="clock-change"');
  });
});

describe('agent review, self audience (RP5)', () => {
  const { dataset: d } = agentFixture({ audience: 'self' });
  const html = renderReportHtml(d, NO_FONTS);

  it('has no benchmark or quality block at all, not an empty one', () => {
    expect(d.benchmark).toBeNull();
    expect(d.quality).toBeNull();
    expect(html).not.toContain('data-block="floor"');
    expect(html).not.toContain('data-block="quality"');
    expect(html).not.toContain('Against the floor');
    expect(html).not.toContain('Call analysis');
    expect(html).not.toContain('supervisors’ copy');
    expect(html).toContain('own copy');
  });

  it('still prints the agent’s own figures', () => {
    expect(text(block(html, 'data-kpi', 'connected'))).toContain(count(d.record.connected));
  });
});

describe('agent review with nothing measurable', () => {
  const { dataset: base } = agentFixture();
  const d = structuredClone(base);
  d.record.connect_rate_pct = null;
  d.record.success_rate_pct = null;
  d.record.aht_seconds = null;
  d.occupancy = { handling_pct: null, on_call_pct: null, on_call_pct_excl_break: null };
  d.roster_row = null;
  d.daily = d.daily.map((r) => ({ ...r, first_dials: 0 }));
  const html = renderReportHtml(d, NO_FONTS);

  it('renders nullable rates as words, never 0%', () => {
    expect(text(block(html, 'data-kpi', 'connect_rate'))).toContain('No calls to rate');
    expect(text(block(html, 'data-kpi', 'occupancy'))).toContain('Not measured');
    expect(text(block(html, 'data-kpi', 'aht'))).toContain('No connected calls');
    expect(text(block(html, 'data-kpi', 'connect_rate'))).not.toMatch(/\b0%/);
    expect(text(block(html, 'data-kpi', 'occupancy'))).not.toMatch(/\b0%/);
  });

  it('withholds a served rate the roster says may not be quoted', () => {
    const d2 = structuredClone(base);
    d2.roster_row = { ...d2.roster_row!, rates_reportable: false };
    expect(text(block(renderReportHtml(d2, NO_FONTS), 'data-kpi', 'connect_rate'))).toContain('Not enough calls to rate');
  });
});

describe('campaign report', () => {
  const { dataset: d } = campaignFixture();
  const html = renderReportHtml(d, NO_FONTS);
  const calls = d.activity.calls;

  it('prints the calls block and its derived rates', () => {
    expect(text(block(html, 'data-kpi', 'dials'))).toContain(count(calls.dials));
    const connect = (calls.human_connects / (calls.dials - calls.redials.placed)) * 100;
    expect(text(block(html, 'data-kpi', 'connect_rate'))).toContain(pct(connect));
    expect(text(block(html, 'data-kpi', 'success_rate'))).toContain(pct((calls.successes / calls.conversations) * 100));
  });

  it('draws trends, best hours, agents, callbacks and health', () => {
    for (const id of ['headline', 'outcomes', 'trends', 'best-hours', 'agents', 'callbacks', 'stalls', 'caller-ids']) expect(html).toContain(`data-block="${id}"`);
    expect(text(block(html, 'data-block', 'agents'))).toContain('Arjun Mehta');
    // An agent whose user no longer resolves is printed by id, marked as one.
    expect(text(block(html, 'data-block', 'agents'))).toContain('Unknown user 0a6e7f80');
    expect(text(block(html, 'data-block', 'callbacks'))).toContain(count(d.activity.callbacks.booked));
  });

  it('dates each day bucket by its bucket_start, not by counting from range.from', () => {
    // A trend read that starts two days into the window (the first two days had no rollup rows).
    const late = structuredClone(d);
    late.trends.buckets = late.trends.buckets.slice(2);
    const first = late.trends.buckets[0]!.bucket_start;
    expect(first).not.toBe(late.range.from);
    const trends = text(block(renderReportHtml(late, NO_FONTS), 'data-block', 'trends'));
    expect(trends).toContain(`${dayLabel(first)}: ${count(late.trends.buckets[0]!.dials)} dials`);
    expect(trends).not.toContain(`${dayLabel(late.range.from)}:`);
  });

  it('rounds the live pace to whole dials an hour', () => {
    const live = structuredClone(d);
    live.summary.headline.running!.dials_per_hour = 1234.567;
    const headline = text(block(renderReportHtml(live, NO_FONTS), 'data-block', 'headline'));
    expect(headline).toContain('1,235 dials an hour');
    expect(headline).not.toContain('1,234.567');
  });

  it('withholds an agent rate below the Insights floor', () => {
    const thin = structuredClone(d);
    thin.activity.agents[0] = { ...thin.activity.agents[0]!, dials: 20, redials: 0, human_connects: 9, conversations: 12, successes: 4 };
    const agents = text(block(renderReportHtml(thin, NO_FONTS), 'data-block', 'agents'));
    expect(agents).toContain('Not enough calls to rate');
  });
});

describe('account report', () => {
  const { dataset: d } = accountFixture();
  const html = renderReportHtml(d, NO_FONTS);
  const t = text(html);

  it('lists every campaign with a totals row, recomputing the total rate from the sums', () => {
    const campaigns = text(block(html, 'data-block', 'campaigns'));
    for (const c of d.campaigns) expect(campaigns).toContain(c.name);
    expect(campaigns).toContain('All campaigns');
    const t = d.totals.calls;
    expect(campaigns).toContain(pct((t.human_connects / (t.dials - t.redials.placed)) * 100));
  });

  it('shows the agents with floor bands and words for the new joiner', () => {
    const agents = text(block(html, 'data-block', 'agents'));
    expect(agents).toContain('Floor: 25th percentile');
    expect(agents).toContain(pct(d.benchmark.cohort.connect_rate.median!));
    const kavya = agents.split('Kavya Nair')[1]!.slice(0, 160);
    expect(kavya).toContain('Not enough calls to rate');
  });

  it('prints no peak agents section or column clause when no day measures one (v1)', () => {
    expect(d.daily.every((r) => r.agents_online_peak === null)).toBe(true);
    expect(html).not.toContain('data-block="peaks"');
    expect(t).not.toContain('Peak agents online');
    expect(t).not.toMatch(/not measured/i);
  });

  it('prints the peaks when a dataset carries them', () => {
    const { dataset: measured } = accountFixture({ attemptsCap: 5000, peaks: true });
    const day = measured.daily.find((r) => r.agents_online_peak !== null && r.dials > 0)!;
    const m = renderReportHtml(measured, NO_FONTS);
    expect(text(block(m, 'data-block', 'peaks'))).toContain('Peak agents online per day');
    expect(text(block(m, 'data-block', 'daily'))).toContain(`${count(day.agents_online_peak!)} agents at the peak`);
    expect(text(block(m, 'data-block', 'daily'))).toContain('peak agents not measured');
  });

  it('prints health per campaign and the truncation note', () => {
    expect(html).toContain('data-block="health"');
    expect(text(block(html, 'data-block', 'notes'))).toContain('stops at 5,000 rows');
  });
});
