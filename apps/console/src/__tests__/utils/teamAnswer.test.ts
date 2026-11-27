import { describe, expect, it } from 'vitest';
import { COMPARE_BUILTIN_METRICS, type AgencyCompareMetricInfo, type AgencyCompareValue, type CompareBuiltinMetricKey } from '@magick-agency/contracts/api/agency/compare';
import {
  AGENCY_TEAM_MAIN_OUTCOME_KINDS,
  AGENCY_TEAM_TREND_SPANS,
  TEAM_FINDING_CODES,
  TEAM_FINDING_METRICS,
  TEAM_MAIN_OUTCOME_METRIC,
  TEAM_TREND_LOOKBACK_DAYS,
  TEAM_TREND_WORKING_DAYS,
  type AgencyTeamPerformance,
} from '@magick-agency/contracts/api/agency/team-performance';
import { compareValue } from '@magick-agency/domain/agent-compare/metrics';
import { cohortPercentiles } from '@magick-agency/domain/agent-compare/percentiles';
import { compareFindings } from '@magick-agency/domain/agent-compare/findings';
import { TEAM_ALL_CAMPAIGNS, TEAM_EMPTY, TEAM_ONE_CAMPAIGN } from '../helpers/teamRecorded';
import { TEAM_ROUTE_ALL_CAMPAIGNS, TEAM_ROUTE_ONE_CAMPAIGN } from '../helpers/teamRouteRecorded';

/**
 * The page's test answers are real answers (docs/team-performance.md §5, the contract's doc
 * comments): every rule the server's assembly guarantees, held over the answers recorded from the
 * real route AND the hand-made ones the page's tests read. The recorded ones keep the rules honest
 * (a rule the server does not keep fails on them); the hand-made ones may not drift from them.
 *
 * Tiles are sums over the table's rows (TP14): an agent with no dialler call has no row and is in
 * no tile. The per-day chart and the outcome bars are the whole team's in scope, so they are not
 * summed against the rows here.
 */

function builtin(key: CompareBuiltinMetricKey): AgencyCompareMetricInfo {
  const definition = COMPARE_BUILTIN_METRICS[key];
  return { id: key, ref: { kind: 'builtin', key }, label: null, definition, flaggable: definition.better !== 'neutral' };
}

const close = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 1e-9);
const sameValue = (a: AgencyCompareValue, b: AgencyCompareValue) =>
  a.numerator === b.numerator && a.denominator === b.denominator && a.reportable === b.reportable && a.withheld === b.withheld
  && close(a.value, b.value) && (a.interval === null ? b.interval === null : b.interval !== null && close(a.interval[0], b.interval[0]) && close(a.interval[1], b.interval[1]));
const ratio = (n: number, d: number) => (d === 0 ? null : n / d);
const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);
const median = (xs: ReadonlyArray<number | null>) => cohortPercentiles(xs.filter((x): x is number => x !== null)).median;

/** Every way `a` breaks a rule the server keeps; empty when it keeps them all. */
function problems(a: AgencyTeamPerformance): string[] {
  const out: string[] = [];
  const check = (ok: boolean, what: string) => { if (!ok) out.push(what); };
  const kind = a.main_outcome.kind;
  const main = builtin(TEAM_MAIN_OUTCOME_METRIC[kind]);
  const choose = builtin('choose_time');
  const rows = a.agents;

  check(AGENCY_TEAM_MAIN_OUTCOME_KINDS.includes(kind), 'main_outcome.kind');
  check(JSON.stringify(a.main_outcome.codes) === JSON.stringify([...new Set(a.main_outcome.codes)].sort()), 'main_outcome.codes sorted and distinct');
  check(a.comparable === (a.campaign_id !== null), 'comparable is campaign_id !== null');
  check(a.from <= a.to, 'from <= to');

  // Rows: Compare's figures from the row's own counts.
  check(new Set(rows.map((r) => r.agent_user_id)).size === rows.length, 'one row per agent');
  for (const r of rows) {
    const id = r.agent_name ?? r.agent_user_id;
    check(close(r.avg_call_seconds, ratio(r.talk_seconds, r.calls_handled)), `${id}: avg_call_seconds`);
    check(sameValue(r.choose, compareValue(choose, r.wrapup_seconds, r.measured_wrapups)), `${id}: choose`);
    check(r.measured_wrapups <= r.calls_handled, `${id}: measured wrap-ups within calls`);
    check(r.break_seconds <= r.shift_seconds, `${id}: break inside the shift`);
    if (kind === 'successes') check(r.main.denominator === r.calls_handled, `${id}: successes are over calls handled`);
    else check((r.main.denominator ?? 0) >= r.calls_handled, `${id}: promises are over calls handled and more`);
    if (r.main.withheld !== 'counts_disagree') check(sameValue(r.main, compareValue(main, r.main.numerator, r.main.denominator)), `${id}: main`);
  }

  // Totals: sums over the rows (TP14), ratios of sums.
  const t = a.totals;
  check(t.agents === rows.length, 'totals.agents');
  check(t.calls_handled === sum(rows.map((r) => r.calls_handled)), 'totals.calls_handled');
  check(t.main.numerator === sum(rows.map((r) => r.main.numerator)), 'totals.main.numerator');
  check(t.main.denominator === sum(rows.map((r) => r.main.denominator ?? 0)), 'totals.main.denominator');
  check(t.other_conversations === (kind === 'promises' ? (t.main.denominator ?? 0) - t.calls_handled : 0), 'totals.other_conversations');
  if (t.main.withheld !== 'counts_disagree') check(sameValue(t.main, compareValue(main, t.main.numerator, t.main.denominator)), 'totals.main');
  check(close(t.avg_call_seconds, ratio(sum(rows.map((r) => r.talk_seconds)), t.calls_handled)), 'totals.avg_call_seconds');
  check(close(t.choose_seconds, ratio(sum(rows.map((r) => r.wrapup_seconds)), sum(rows.map((r) => r.measured_wrapups)))), 'totals.choose_seconds');
  const cb = t.callbacks;
  check(cb.due === cb.on_time + cb.late + cb.missed + cb.pending_due, 'callbacks.due');
  check(t.wrapup_allowed.seconds === null || !t.wrapup_allowed.varies, 'wrapup_allowed: one value or varies');

  // Medians: `cohortPercentiles` over the rows that qualify.
  check(close(a.medians.calls_handled, median(rows.map((r) => r.calls_handled))), 'medians.calls_handled');
  check(close(a.medians.main_rate, median(rows.map((r) => (r.main.reportable ? r.main.value : null)))), 'medians.main_rate');
  check(close(a.medians.avg_call_seconds, median(rows.map((r) => r.avg_call_seconds))), 'medians.avg_call_seconds');
  check(close(a.medians.choose_seconds, median(rows.map((r) => (r.choose.reportable ? r.choose.value : null)))), 'medians.choose_seconds');

  // Outcome bars: most first, no outcome chosen last among equals, each code once, none empty.
  check(new Set(a.outcomes.map((o) => o.code)).size === a.outcomes.length, 'outcomes: each code once');
  a.outcomes.forEach((o, i) => {
    check(o.conversations > 0, `outcomes[${i}] has conversations`);
    if (o.code === null) check(o.label === null && o.icon === null, 'no outcome chosen has no label or icon');
    const next = a.outcomes[i + 1];
    if (next) check(o.conversations > next.conversations || (o.conversations === next.conversations && o.code !== null), `outcomes[${i}] order`);
  });

  // The per-day chart: working days in order, one count each, inside its span (TP12).
  const { span, dates, counts } = a.trend;
  check(AGENCY_TEAM_TREND_SPANS.includes(span), 'trend.span');
  check(counts.length === dates.length, 'trend: a count per date');
  check(dates.every((d, i) => i === 0 || dates[i - 1]! < d), 'trend: dates ascending');
  check(dates.every((d) => d <= a.to), 'trend: no date after to');
  if (span === 'window') check(dates.every((d) => d >= a.from), 'trend: window dates inside it');
  else {
    check(dates.length <= TEAM_TREND_WORKING_DAYS, 'trend: at most the last working days');
    const first = new Date(`${a.to}T00:00:00Z`);
    first.setUTCDate(first.getUTCDate() + 1 - TEAM_TREND_LOOKBACK_DAYS);
    check(dates.every((d) => d >= first.toISOString().slice(0, 10)), 'trend: inside the look-back');
  }

  // Findings: only with one campaign; Compare's findings over every row, the team's codes only (TP15).
  if (!a.comparable) check(a.findings.length === 0, 'findings only when comparable');
  const ids = new Set(rows.map((r) => r.agent_user_id));
  for (const f of a.findings) {
    check(ids.has(f.agent_user_id), `finding on a row: ${f.agent_user_id}`);
    check((TEAM_FINDING_CODES as readonly string[]).includes(f.code), `finding code ${f.code}`);
    check((TEAM_FINDING_METRICS as readonly string[]).includes(f.metric), `finding metric ${f.metric}`);
  }
  if (a.comparable) {
    const cohort = (pick: (r: AgencyTeamPerformance['agents'][number]) => AgencyCompareValue) =>
      rows.filter((r) => pick(r).withheld !== 'counts_disagree').map((r) => ({ agent_user_id: r.agent_user_id, ...pick(r) }));
    const expected = compareFindings({
      metrics: [{ metric: main, cohort: cohort((r) => r.main) }, { metric: choose, cohort: cohort((r) => r.choose) }],
      picked: rows.map((r) => r.agent_user_id),
    }).findings.filter((f) => (TEAM_FINDING_CODES as readonly string[]).includes(f.code));
    const key = (f: { code: string; metric: string; agent_user_id: string }) => `${f.code} ${f.metric} ${f.agent_user_id}`;
    check(JSON.stringify(a.findings.map(key).sort()) === JSON.stringify(expected.map(key).sort()), 'findings are compareFindings over every row');
  }
  return out;
}

const ANSWERS: Record<string, AgencyTeamPerformance> = {
  'recorded from the route, one campaign': TEAM_ROUTE_ONE_CAMPAIGN,
  'recorded from the route, All campaigns': TEAM_ROUTE_ALL_CAMPAIGNS,
  'the page tests\' one campaign': TEAM_ONE_CAMPAIGN,
  'the page tests\' All campaigns': TEAM_ALL_CAMPAIGNS,
  'the page tests\' empty answer': TEAM_EMPTY,
};

describe('the team performance answers the console is tested on keep the server\'s rules', () => {
  for (const [name, answer] of Object.entries(ANSWERS)) {
    it(name, () => {
      expect(problems(answer)).toEqual([]);
    });
  }

  it('the rules catch a broken answer', () => {
    const broken: AgencyTeamPerformance = {
      ...TEAM_ROUTE_ONE_CAMPAIGN,
      totals: { ...TEAM_ROUTE_ONE_CAMPAIGN.totals, calls_handled: TEAM_ROUTE_ONE_CAMPAIGN.totals.calls_handled + 1 },
      comparable: false,
    };
    expect(problems(broken)).toEqual(expect.arrayContaining(['totals.calls_handled', 'comparable is campaign_id !== null', 'findings only when comparable']));
  });

  it('the hand-made answers hold every field the route sends, and no other', () => {
    const keys = (o: object) => Object.keys(o).sort();
    for (const a of [TEAM_ONE_CAMPAIGN, TEAM_ALL_CAMPAIGNS, TEAM_EMPTY]) {
      expect(keys(a)).toEqual(keys(TEAM_ROUTE_ONE_CAMPAIGN));
      expect(keys(a.totals)).toEqual(keys(TEAM_ROUTE_ONE_CAMPAIGN.totals));
      expect(keys(a.medians)).toEqual(keys(TEAM_ROUTE_ONE_CAMPAIGN.medians));
      for (const r of a.agents) expect(keys(r)).toEqual(keys(TEAM_ROUTE_ONE_CAMPAIGN.agents[0]!));
      for (const f of a.findings) expect(keys(f)).toEqual(keys(TEAM_ROUTE_ONE_CAMPAIGN.findings[0]!));
    }
  });
});
