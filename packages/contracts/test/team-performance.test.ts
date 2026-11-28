import { describe, expect, it } from 'vitest';
import {
  AGENCY_TEAM_MAIN_OUTCOME_KINDS,
  AGENCY_TEAM_TREND_SPANS,
  TEAM_FINDING_CODES,
  TEAM_FINDING_METRICS,
  TEAM_MAIN_OUTCOME_METRIC,
  TEAM_OUTCOME_BARS_MAX,
  TEAM_PERFORMANCE_BUSY_RETRY_AFTER_SECONDS,
  TEAM_PERFORMANCE_CACHE_TTL_MS,
  TEAM_PERFORMANCE_READ_TIMEOUT_MS,
  TEAM_PERFORMANCE_TENANT_CONCURRENT_READS,
  TEAM_TREND_LOOKBACK_DAYS,
  TEAM_TREND_WORKING_DAYS,
  teamWindowProblem,
  type AgencyTeamAgentRow,
  type AgencyTeamMainOutcome,
  type AgencyTeamMainOutcomeKind,
  type AgencyTeamPerformance,
  type AgencyTeamTrendSpan,
} from '../src/api/agency/team-performance';
import { COMPARE_BUILTIN_METRICS, compareWindowProblem, type AgencyCompareFinding, type AgencyCompareValue } from '../src/api/agency/compare';
import { reportWindowProblem } from '../src/api/agency/reports';
import type { AgencyTileIcon } from '../src/agency/tile-icons';
import { AgencyApi } from '../src/index';
import type { Equals } from './type-equals';

// ── Type-level: each list is exactly its union; the figures are Compare's own shapes (TP2).
const _kinds: Equals<(typeof AGENCY_TEAM_MAIN_OUTCOME_KINDS)[number], AgencyTeamMainOutcomeKind> = true;
const _spans: Equals<(typeof AGENCY_TEAM_TREND_SPANS)[number], AgencyTeamTrendSpan> = true;
const _rowMain: Equals<AgencyTeamAgentRow['main'], AgencyCompareValue> = true;
const _rowChoose: Equals<AgencyTeamAgentRow['choose'], AgencyCompareValue> = true;
const _totalsMain: Equals<AgencyTeamPerformance['totals']['main'], AgencyCompareValue> = true;
const _findings: Equals<AgencyTeamPerformance['findings'], AgencyCompareFinding[]> = true;
const _icon: Equals<AgencyTeamPerformance['outcomes'][number]['icon'], AgencyTileIcon | null> = true;
// The main outcome's fields, exactly: `mixed` is required, so every answer says whether the note shows (TP8);
// `bar_conversations` is required, so the console never sums merged bars for TP13's footnote.
const _mainKeys: Equals<keyof AgencyTeamMainOutcome, 'kind' | 'codes' | 'label' | 'mixed' | 'bar_conversations'> = true;
const _mixed: Equals<AgencyTeamMainOutcome['mixed'], boolean> = true;
const _barConversations: Equals<AgencyTeamMainOutcome['bar_conversations'], number> = true;
// Reached through the AgencyApi namespace like its siblings.
const _namespaced: Equals<AgencyApi.AgencyTeamPerformance, AgencyTeamPerformance> = true;
void [_kinds, _spans, _mainKeys, _mixed, _barConversations, _rowMain, _rowChoose, _totalsMain, _findings, _icon, _namespaced];

describe('team performance vocabularies (SNAPSHOT, written out by hand)', () => {
  it('main outcome kinds and trend spans', () => {
    expect([...AGENCY_TEAM_MAIN_OUTCOME_KINDS]).toEqual(['promises', 'successes']);
    expect([...AGENCY_TEAM_TREND_SPANS]).toEqual(['last_working_days', 'window']);
  });

  it('findings are rate gaps and praise only, on the main rate and the time to choose (TP15)', () => {
    expect([...TEAM_FINDING_CODES]).toEqual(['clear_gap', 'stands_out']);
    expect([...TEAM_FINDING_METRICS]).toEqual(['promises_rate', 'success_rate', 'choose_time']);
  });
});

describe('the main outcome is a Compare metric (TP2, TP8)', () => {
  it('promises read promises_rate, successes read success_rate', () => {
    expect(TEAM_MAIN_OUTCOME_METRIC).toEqual({ promises: 'promises_rate', successes: 'success_rate' });
    expect(Object.isFrozen(TEAM_MAIN_OUTCOME_METRIC)).toBe(true);
  });

  it('each is a higher-is-better rate on the roster floor, so findings and floors are Compare\'s', () => {
    for (const kind of AGENCY_TEAM_MAIN_OUTCOME_KINDS) {
      const d = COMPARE_BUILTIN_METRICS[TEAM_MAIN_OUTCOME_METRIC[kind]];
      expect(d.unit, kind).toBe('rate');
      expect(d.better, kind).toBe('higher');
      expect(d.min_denominator, kind).toBe(20);
    }
    expect(COMPARE_BUILTIN_METRICS.choose_time.better).toBe('lower');
  });

  it('every finding metric is one of the kinds\' rates or choose_time', () => {
    const allowed = new Set<string>([...Object.values(TEAM_MAIN_OUTCOME_METRIC), 'choose_time']);
    for (const m of TEAM_FINDING_METRICS) expect(allowed.has(m), m).toBe(true);
    expect(TEAM_FINDING_METRICS).toHaveLength(allowed.size);
  });
});

describe('limits and guards', () => {
  it('hold the values the docs and the console are written to', () => {
    expect(TEAM_PERFORMANCE_TENANT_CONCURRENT_READS).toBe(2);
    expect(TEAM_PERFORMANCE_BUSY_RETRY_AFTER_SECONDS).toBe(2);
    expect(TEAM_PERFORMANCE_READ_TIMEOUT_MS).toBe(8_000);
    expect(TEAM_PERFORMANCE_CACHE_TTL_MS).toBe(30_000);
    expect(TEAM_TREND_WORKING_DAYS).toBe(7);
    expect(TEAM_TREND_LOOKBACK_DAYS).toBe(14);
    expect(TEAM_OUTCOME_BARS_MAX).toBe(7);
  });

  it('the short window looks back further than the days it shows', () => {
    expect(TEAM_TREND_LOOKBACK_DAYS).toBeGreaterThan(TEAM_TREND_WORKING_DAYS);
  });
});

describe('teamWindowProblem', () => {
  it.each([
    ['2026-11-01', '2026-11-30', '2026-11-30'], // one calendar month
    ['2026-11-27', '2026-11-27', '2026-11-27'], // today alone
    ['2026-10-29', '2026-11-27', '2026-11-27'], // 30 days
  ])('accepts %s..%s (today %s)', (from, to, today) => {
    expect(teamWindowProblem(from, to, today)).toBeNull();
  });

  it.each([
    ['2026-11-28', '2026-11-27', '2026-11-27'], // to before from
    ['2026-11-27', '2026-11-28', '2026-11-27'], // past today
    ['2026-10-01', '2026-11-27', '2026-11-27'], // too long
    ['2026-11-x', '2026-11-27', '2026-11-27'], // malformed
  ])('refuses %s..%s (today %s) with team_window_invalid', (from, to, today) => {
    expect(teamWindowProblem(from, to, today)).toBe('team_window_invalid');
  });

  it('is the reports rule, as Compare\'s is (one window rule for every Reports tab)', () => {
    const cases: Array<[string, string, string]> = [
      ['2026-11-01', '2026-11-30', '2026-11-30'], ['2026-10-01', '2026-11-27', '2026-11-27'],
      ['2026-11-27', '2026-11-28', '2026-11-27'], ['2026-02-01', '2026-02-28', '2026-03-10'],
    ];
    for (const [from, to, today] of cases) {
      expect(teamWindowProblem(from, to, today) === null).toBe(reportWindowProblem(from, to, today) === null);
      expect(teamWindowProblem(from, to, today) === null).toBe(compareWindowProblem(from, to, today) === null);
    }
  });
});
