import { describe, expect, it } from 'vitest';
import {
  COMPARE_LENSES,
  COMPARE_MAX_METRICS,
  compareMetricId,
  type AgencyCompareOutcomeCode,
} from '@magick-agency/contracts/api/agency/compare';
import { compareLensDefaults, compareStartingLens } from '../../../src/agent-compare/lens';
import { resolveCompareMetrics } from '../../../src/agent-compare/metrics';

const code = (c: string, o: Partial<AgencyCompareOutcomeCode> = {}): AgencyCompareOutcomeCode =>
  ({ code: c, label: c, is_success: false, requires_promise: false, ...o });

const COLLECTIONS = [
  code('promise_to_pay', { requires_promise: true }),
  code('paid', { is_success: true }),
  code('refused'),
  code('wrong_number'),
];
const SALES = [code('sale', { is_success: true }), code('upsell', { is_success: true }), code('not_interested')];
const NO_SUCCESS = [code('reached'), code('not_reached')];

const ids = (lens: (typeof COMPARE_LENSES)[number], codes: AgencyCompareOutcomeCode[]) =>
  compareLensDefaults(lens, codes).metrics.map(compareMetricId);

describe('compareStartingLens', () => {
  it('collections when the catalog records promises, else sales', () => {
    expect(compareStartingLens(COLLECTIONS)).toBe('collections');
    expect(compareStartingLens(SALES)).toBe('sales');
    expect(compareStartingLens([])).toBe('sales');
  });
});

describe('compareLensDefaults', () => {
  it('collections: "Will pay" over the promise codes, higher, and it is the trend', () => {
    const d = compareLensDefaults('collections', COLLECTIONS);
    expect(d.metrics.map(compareMetricId)).toEqual([
      'calls_handled', 'outcomes:higher:promise_to_pay', 'choose_time', 'no_outcome_rate', 'avg_call', 'breaks_over_limit',
    ]);
    expect(d.metrics[1]).toEqual({ kind: 'outcomes', codes: ['promise_to_pay'], better: 'higher', label: 'Will pay' });
    expect(d.trend).toEqual(d.metrics[1]);
  });

  it('sales and verification: "Success" over the success codes, higher, as the trend', () => {
    expect(ids('sales', SALES)).toEqual([
      'calls_handled', 'outcomes:higher:sale,upsell', 'callbacks_booked', 'callbacks_kept_rate', 'avg_call', 'calls_per_hour',
    ]);
    expect(ids('verification', SALES)).toEqual([
      'calls_handled', 'calls_per_hour', 'outcomes:higher:sale,upsell', 'no_outcome_rate', 'avg_call', 'choose_time',
    ]);
    const d = compareLensDefaults('sales', SALES);
    expect(d.metrics[1]).toMatchObject({ label: 'Success' });
    expect(d.trend).toEqual(d.metrics[1]);
  });

  it('collections on a catalog without promises falls back to "Success"', () => {
    expect(compareLensDefaults('collections', SALES).metrics[1]).toMatchObject({ codes: ['sale', 'upsell'], label: 'Success' });
  });

  it('more codes than an outcome set holds: the built-in that counts them all, never a cut list', () => {
    const many = (o: Partial<AgencyCompareOutcomeCode>) => Array.from({ length: 6 }, (_, i) => code(`c${i}`, o));
    const promises = compareLensDefaults('collections', many({ requires_promise: true }));
    expect(promises.metrics[1]).toEqual({ kind: 'builtin', key: 'promises_rate' });
    expect(promises.trend).toEqual({ kind: 'builtin', key: 'promises_rate' });
    const sales = compareLensDefaults('sales', many({ is_success: true }));
    expect(sales.metrics[1]).toEqual({ kind: 'builtin', key: 'success_rate' });
    expect(sales.trend).toBeNull();
  });

  it('no success code: the slot is left out and there is no trend', () => {
    const d = compareLensDefaults('sales', NO_SUCCESS);
    expect(d.metrics.map(compareMetricId)).toEqual(['calls_handled', 'callbacks_booked', 'callbacks_kept_rate', 'avg_call', 'calls_per_hour']);
    expect(d.trend).toBeNull();
  });

  it('every lens\'s defaults resolve on the catalog they came from: the server accepts what a lens offers', () => {
    for (const codes of [COLLECTIONS, SALES, NO_SUCCESS]) {
      for (const lens of COMPARE_LENSES) {
        const d = compareLensDefaults(lens, codes);
        const r = resolveCompareMetrics(d.metrics, d.trend, codes, COMPARE_MAX_METRICS);
        expect(r.ok, `${lens} on ${codes.map((c) => c.code).join(',')}`).toBe(true);
      }
    }
  });
});
