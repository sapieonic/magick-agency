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
  formatMetricValue,
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

  it('never writes an unknown count as 0', () => {
    expect(tooFewWords(metricInfo(builtin('success_rate')), null)).toBe('Too few to compare (needs 20)');
    expect(tooFewShort(metricInfo(builtin('success_rate')), null)).toBe('Too few (needs 20)');
    expect(tooFewWords(metricInfo(builtin('breaks_over_limit')), null)).toBe('Too few to compare');
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
    expect(outcomeSetProblem(['refused'], 'lower', '', SIX, CODES)).toMatch(/Six metrics/);
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
    expect(applied.trendDropped).toBe(true);
    expect(droppedNote(applied)).toBe('Paid was left out: this campaign no longer has its outcomes. The per-day trend was left out for the same reason.');
  });

  it('drops promise metrics on a campaign that does not record promises', () => {
    const applied = applyToCatalog([builtin('promises_rate'), builtin('promised_amount'), builtin('calls_handled')], builtin('promises_rate'), SALES_CODES);
    expect(applied.metrics.map(compareMetricId)).toEqual(['calls_handled']);
    expect(droppedNote(applied)).toBe('Promises, Amount promised were left out: this campaign no longer has their outcomes. The per-day trend was left out for the same reason.');
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
