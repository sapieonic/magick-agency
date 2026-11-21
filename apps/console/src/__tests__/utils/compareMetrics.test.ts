import { describe, it, expect } from 'vitest';
import {
  COMPARE_BUILTIN_METRIC_KEYS,
  compareMetricId,
  type AgencyCompareMetricRef,
} from '@magick-agency/contracts/api/agency/compare';
import {
  BUILTIN_COPY,
  addMetric,
  applyToCatalog,
  availableBuiltins,
  buildOutcomeSet,
  canAddMetric,
  droppedNote,
  fallbackNote,
  formatMetricValue,
  formatRate,
  inCatalogOrder,
  metricLabel,
  metricSubtitle,
  outcomeSetProblem,
  perWords,
  pickerGroups,
  removeMetric,
  toggleCode,
  tooFewShort,
  tooFewWords,
  trendChoices,
  withheldKind,
  withheldShort,
  withheldSpoken,
  withheldWords,
  type WithheldKind,
} from '../../utils/agency/compare/compareMetrics';
import { CODES, REFUSED_LOWER, SALES_CODES, WILL_PAY, metricInfo } from '../helpers/compare';

/**
 * The metric picker's rules and the metric words (`docs/compare-agents.md` §2, §3, CP17, CP18):
 * at most six metrics and five codes, promise metrics only when the campaign records promises, a
 * set's direction starting from the contract's default, a view's metrics dropped (and named) when
 * the campaign no longer has their outcomes, and every unit in the console's format.
 */

const builtin = (key: (typeof COMPARE_BUILTIN_METRIC_KEYS)[number]): AgencyCompareMetricRef => ({ kind: 'builtin', key });
const SIX: AgencyCompareMetricRef[] = ['calls_handled', 'calls_per_hour', 'connect_rate', 'success_rate', 'avg_call', 'choose_time'].map(
  (k) => builtin(k as never),
);

describe('words', () => {
  it('has a label, a noun, a denominator and a source for every built-in', () => {
    for (const key of COMPARE_BUILTIN_METRIC_KEYS) {
      const copy = BUILTIN_COPY[key];
      expect(copy.label, key).toMatch(/^[A-Z]/);
      expect(copy.noun, key).toMatch(/^[a-z]/);
      expect(copy.per[0] && copy.per[1], key).toBeTruthy();
      expect(copy.source, key).toBeTruthy();
    }
  });

  it('names an outcome set by its label, else its codes’ labels joined', () => {
    expect(metricLabel(WILL_PAY, CODES)).toBe('Will pay');
    expect(metricLabel({ kind: 'outcomes', codes: ['refused', 'wrong_number', 'call_back'], better: 'neutral' }, CODES)).toBe(
      'Refused, Wrong number or Call back',
    );
    expect(metricLabel(builtin('choose_time'), CODES)).toBe('Time to choose outcome');
  });

  it('says the direction and the source under each chart', () => {
    expect(metricSubtitle(metricInfo(builtin('success_rate')))).toBe('higher is better · calls ending in a success outcome');
    expect(metricSubtitle(metricInfo(REFUSED_LOWER))).toBe('lower is better · share of calls ending in these outcomes');
    expect(metricSubtitle(metricInfo(builtin('avg_call')))).toBe('shown, never flagged · talk time per call');
  });
});

describe('units', () => {
  it('formats a rate (a fraction on the wire) as a whole percentage', () => {
    expect(formatMetricValue('rate', 0.194)).toBe('19%');
    expect(formatMetricValue('rate', 0)).toBe('0%');
    expect(formatMetricValue('rate', 1)).toBe('100%');
  });

  it('formats seconds as words, per hour to one decimal, counts and amounts grouped the Indian way with no ₹ (PT5)', () => {
    expect(formatMetricValue('seconds', 252)).toBe('4m 12s');
    expect(formatMetricValue('seconds', 34.6)).toBe('35s');
    expect(formatMetricValue('per_hour', 6.25)).toBe('6.3');
    expect(formatMetricValue('count', 125000)).toBe('1,25,000');
    expect(formatMetricValue('amount', 1250000.4)).toBe('12,50,000');
    expect(formatMetricValue('amount', 1250000.4)).not.toContain('₹');
    expect(formatMetricValue('rate', null)).toBe('–');
  });

  it('words a figure under the floor with its own denominator', () => {
    expect(tooFewWords(metricInfo(builtin('success_rate')), 12)).toBe('Too few to compare (12 calls; needs 20)');
    expect(tooFewWords(metricInfo(builtin('callbacks_kept_rate')), 1)).toBe('Too few to compare (1 call-back due; needs 8)');
    expect(tooFewWords(metricInfo(builtin('choose_time')), 9)).toBe('Too few to compare (9 wrap-ups; needs 20)');
    expect(perWords(metricInfo(WILL_PAY), 1)).toBe('1 call');
    expect(tooFewShort(metricInfo(builtin('success_rate')), 12)).toBe('Too few (12 of 20)');
  });

  it('says "None due yet" for call-backs kept on time with no call-back due, never "Too few (0 of 8)"', () => {
    const kept = metricInfo(builtin('callbacks_kept_rate'));
    const noneDue = { value: null, denominator: 0, withheld: 'none_due' as const };
    expect(withheldWords(kept, noneDue)).toBe('None due yet');
    expect(withheldShort(kept, noneDue)).toBe('None due yet');
    expect(withheldShort(kept, { value: 0.3, denominator: 3, withheld: 'too_few' })).toBe('Too few (3 of 8)');
    // Only call-backs: a rate with no calls at all is still too few.
    expect(withheldShort(metricInfo(builtin('success_rate')), { value: null, denominator: 0, withheld: 'too_few' })).toBe('Too few (0 of 20)');
  });

  it('never writes an unknown count as 0', () => {
    expect(tooFewWords(metricInfo(builtin('success_rate')), null)).toBe('Too few to compare (needs 20)');
    expect(tooFewShort(metricInfo(builtin('success_rate')), null)).toBe('Too few (needs 20)');
    expect(tooFewWords(metricInfo(builtin('breaks_over_limit')), null)).toBe('Too few to compare');
  });
});

describe('a withheld figure (contract AgencyCompareValue)', () => {
  /** A withheld value as the server sends it: no figure, its counts, and the server's reason. */
  const v = (value: number | null, denominator: number | null, withheld: WithheldKind) => ({ value, denominator, withheld });

  it('takes the server\'s reason as it is, whatever the counts look like', () => {
    const promises = metricInfo(builtin('promises_rate'));
    // Counts under the floor that the server still says disagree: the server decides.
    expect(withheldKind(promises, { withheld: 'counts_disagree' })).toBe('counts_disagree');
    expect(withheldKind(promises, { withheld: 'too_few' })).toBe('too_few');
    for (const kind of ['too_few', 'none_due', 'counts_disagree', 'no_logged_in_time'] as const) {
      const value = { value: null, denominator: 30, withheld: kind };
      expect(withheldKind(promises, value)).toBe(kind);
      expect(withheldWords(promises, value), kind).not.toBe('');
      expect(withheldShort(promises, value), kind).not.toBe('');
      expect(withheldSpoken(promises, value), kind).not.toBe('');
    }
    // Every reason has its own words.
    const words = (['too_few', 'none_due', 'counts_disagree', 'no_logged_in_time'] as const)
      .map((kind) => withheldWords(promises, { value: null, denominator: 30, withheld: kind }));
    expect(new Set(words).size).toBe(4);
    expect(words).toEqual(['Too few to compare (30 calls; needs 20)', 'None due yet', 'Not shown: its counts don’t agree', 'No logged-in time']);
  });

  it('words counts that don’t agree as such, never "too few"', () => {
    // 52 promises on 45 conversations: the server withholds it and says why.
    const promises = metricInfo(builtin('promises_rate'));
    expect(withheldWords(promises, v(null, 45, 'counts_disagree'))).toBe('Not shown: its counts don’t agree');
    expect(withheldShort(promises, v(null, 45, 'counts_disagree'))).toBe('Counts don’t agree');
    expect(withheldSpoken(promises, v(null, 45, 'counts_disagree'))).toBe('not shown, its counts don’t agree');
    // Too few states its counts, figure or not.
    expect(withheldWords(promises, v(0.3, 12, 'too_few'))).toBe('Too few to compare (12 calls; needs 20)');
    expect(withheldWords(promises, v(null, 0, 'too_few'))).toBe('Too few to compare (0 calls; needs 20)');
  });

  it('never words calls per hour’s logged-in seconds as a count of hours', () => {
    const perHour = metricInfo(builtin('calls_per_hour'));
    expect(withheldWords(perHour, v(null, 5400, 'counts_disagree'))).toBe('Not shown: its counts don’t agree');
    expect(withheldShort(perHour, v(null, 5400, 'counts_disagree'))).toBe('Counts don’t agree');
    expect(withheldWords(perHour, v(null, 0, 'no_logged_in_time'))).toBe('No logged-in time');
    expect(withheldWords(perHour, v(null, null, 'no_logged_in_time'))).toBe('No logged-in time');
  });

  it('keeps "None due yet" for call-backs kept with none due', () => {
    const kept = metricInfo(builtin('callbacks_kept_rate'));
    expect(withheldWords(kept, v(null, 0, 'none_due'))).toBe('None due yet');
  });

  it('treats a withheld figure with no reason as too few (an answer that breaks the contract)', () => {
    const promises = metricInfo(builtin('promises_rate'));
    expect(withheldKind(promises, { withheld: null })).toBe('too_few');
  });
});

describe('formatRate and amounts, through the shared number formatters', () => {
  it('a rate as a whole percentage, rounded half up as before', () => {
    expect(formatRate(0.194)).toBe('19%');
    expect(formatRate(0.195)).toBe('20%');
    expect(formatRate(0.285)).toBe('28%');
    expect(formatRate(0)).toBe('0%');
    expect(formatRate(1)).toBe('100%');
    for (let i = 0; i <= 10_000; i += 1) {
      const f = i / 10_000;
      expect(formatRate(f), String(f)).toBe(`${Math.round(f * 100)}%`);
    }
  });

  it('an amount grouped, whole, as the dropped formatter wrote it', () => {
    const whole = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 });
    for (const a of [0, 0.4, 0.5, 1.5, 2.5, 999.5, 1000, 125000, 1250000.4, 1250000.5, 99999999.49]) {
      expect(formatMetricValue('amount', a), String(a)).toBe(whole.format(a));
    }
  });
});

describe('the picker', () => {
  it('offers promise metrics only when the campaign records promises', () => {
    expect(availableBuiltins(CODES)).toContain('promises_rate');
    expect(availableBuiltins(CODES)).toContain('promised_amount');
    expect(availableBuiltins(SALES_CODES)).not.toContain('promises_rate');
    expect(availableBuiltins(SALES_CODES)).not.toContain('promised_amount');
    expect(availableBuiltins(SALES_CODES)).toHaveLength(COMPARE_BUILTIN_METRIC_KEYS.length - 2);
  });

  it('groups the built-ins in the catalog’s order', () => {
    expect(pickerGroups(CODES).map((g) => g.group)).toEqual(['volume', 'outcomes', 'handling', 'time_use']);
    expect(pickerGroups(CODES)[0]!.keys).toEqual(['calls_handled', 'calls_per_hour', 'connect_rate']);
  });

  it('holds at most six metrics, each once, and never removes the last', () => {
    expect(canAddMetric(SIX)).toBe(false);
    expect(addMetric(SIX, builtin('no_outcome_rate'))).toHaveLength(6);
    expect(addMetric(SIX.slice(0, 5), builtin('no_outcome_rate')).map(compareMetricId)).toContain('no_outcome_rate');
    expect(addMetric(SIX.slice(0, 2), builtin('calls_handled'))).toHaveLength(2);
    expect(removeMetric(SIX, 'avg_call').map(compareMetricId)).not.toContain('avg_call');
    expect(removeMetric([builtin('avg_call')], 'avg_call')).toHaveLength(1);
  });

  it('offers as trend each countable metric on the page, then promises, then the current trend', () => {
    const ids = trendChoices([builtin('calls_handled'), WILL_PAY, REFUSED_LOWER], null, CODES).map(compareMetricId);
    expect(ids).toEqual([compareMetricId(WILL_PAY), compareMetricId(REFUSED_LOWER), 'promises_rate']);
    expect(trendChoices([builtin('calls_handled')], null, SALES_CODES)).toEqual([]);
    const extra = { kind: 'outcomes' as const, codes: ['call_back'], better: 'neutral' as const };
    expect(trendChoices([], extra, CODES).map(compareMetricId)).toEqual(['promises_rate', compareMetricId(extra)]);
  });
});

describe('the outcome-set builder', () => {
  it('ticks at most five codes', () => {
    let codes: string[] = [];
    for (const c of CODES) codes = toggleCode(codes, c.code);
    expect(codes).toEqual(['will_pay', 'part_paid', 'refused', 'call_back', 'wrong_number']);
    expect(toggleCode(codes, 'will_pay')).toEqual(['part_paid', 'refused', 'call_back', 'wrong_number']);
  });

  it('builds the set in catalog order and keeps a typed name only when it is not the default', () => {
    expect(buildOutcomeSet(['part_paid', 'will_pay'], 'higher', '', CODES)).toEqual({ kind: 'outcomes', codes: ['will_pay', 'part_paid'], better: 'higher' });
    expect(buildOutcomeSet(['part_paid', 'will_pay'], 'higher', ' Will pay or Part paid ', CODES)).not.toHaveProperty('label');
    expect(buildOutcomeSet(['refused'], 'lower', '  Said no ', CODES)).toEqual({ kind: 'outcomes', codes: ['refused'], better: 'lower', label: 'Said no' });
  });

  it('says why a set cannot be added yet', () => {
    expect(outcomeSetProblem([], 'neutral', '', [], CODES)).toBe('Choose at least one outcome.');
    expect(outcomeSetProblem(['refused'], 'lower', '', SIX, CODES)).toMatch(/6 metrics are chosen/);
    expect(outcomeSetProblem(['refused'], 'lower', 'x'.repeat(61), [], CODES)).toMatch(/60 characters/);
    expect(outcomeSetProblem(['refused'], 'lower', '', [REFUSED_LOWER], CODES)).toBe('That outcome set is already on the page.');
    expect(outcomeSetProblem(['refused'], 'higher', '', [REFUSED_LOWER], CODES)).toBeNull();
  });
});

describe('a view applied to a campaign', () => {
  it('keeps what the catalog can show and names what it cannot', () => {
    const gone = { kind: 'outcomes' as const, codes: ['paid_in_full'], better: 'higher' as const, label: 'Paid' };
    const applied = applyToCatalog([builtin('calls_handled'), gone, WILL_PAY], gone, CODES);
    expect(applied.metrics.map(compareMetricId)).toEqual(['calls_handled', compareMetricId(WILL_PAY)]);
    expect(applied.dropped).toEqual(['Paid']);
    expect(applied.trend).toBeNull();
    expect(applied.trendDropped).toEqual({ label: 'Paid', reason: 'catalog' });
    expect(droppedNote(applied)).toBe('Paid was left out: this campaign doesn’t have its outcomes. The per-day trend was left out for the same reason.');
  });

  it('gives a trend left out on its own its own reason', () => {
    const gone = { kind: 'outcomes' as const, codes: ['paid_in_full'], better: 'higher' as const, label: 'Paid' };
    const alone = applyToCatalog([builtin('avg_call')], gone, CODES);
    expect(alone.metrics.map(compareMetricId)).toEqual(['avg_call']);
    expect(droppedNote(alone)).toBe('The per-day trend, Paid, was left out: this campaign doesn’t have its outcomes.');
    // A trend that is not a count per day is not an outcome problem.
    const notCountable = applyToCatalog([builtin('avg_call')], builtin('calls_handled'), CODES);
    expect(notCountable.trend).toBeNull();
    expect(notCountable.trendDropped).toEqual({ label: 'Calls handled', reason: 'not_countable' });
    expect(droppedNote(notCountable)).toBe(
      'Calls handled can’t be counted per day, so no per-day trend is shown. Choose an outcome set or promises for it.',
    );
    expect(droppedNote(notCountable)).not.toMatch(/outcomes\./);
  });

  it('says what is shown instead when none of the metrics can be shown', () => {
    const gone = { kind: 'outcomes' as const, codes: ['paid_in_full'], better: 'higher' as const, label: 'Paid' };
    const applied = applyToCatalog([gone], gone, CODES);
    expect(applied.metrics).toEqual([]);
    expect(fallbackNote(applied, 'the link', 'sales')).toBe(
      'Paid was left out: this campaign doesn’t have its outcomes. The per-day trend was left out for the same reason. None of the metrics in the link can be shown on this campaign, so the Sales lens’s metrics are shown instead.',
    );
  });

  it('drops promise metrics on a campaign that does not record promises', () => {
    const applied = applyToCatalog([builtin('promises_rate'), builtin('promised_amount'), builtin('calls_handled')], builtin('promises_rate'), SALES_CODES);
    expect(applied.metrics.map(compareMetricId)).toEqual(['calls_handled']);
    expect(droppedNote(applied)).toBe('Promises, Amount promised were left out: this campaign doesn’t have their outcomes. The per-day trend was left out for the same reason.');
  });

  it('says nothing when everything was kept, and puts a link’s sorted codes back in catalog order', () => {
    const fromLink = { kind: 'outcomes' as const, codes: ['part_paid', 'will_pay'], better: 'higher' as const };
    const applied = applyToCatalog([fromLink], fromLink, CODES);
    expect(droppedNote(applied)).toBeNull();
    expect(applied.metrics[0]).toEqual({ ...fromLink, codes: ['will_pay', 'part_paid'] });
    expect(metricLabel(applied.metrics[0]!, CODES)).toBe('Will pay or Part paid');
    expect(inCatalogOrder(builtin('avg_call'), CODES)).toEqual(builtin('avg_call'));
  });
});
