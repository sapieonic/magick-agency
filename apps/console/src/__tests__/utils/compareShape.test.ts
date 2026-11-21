import { describe, it, expect } from 'vitest';
import { compareMetricId, type AgencyCompareMetricRef } from '@magick-agency/contracts/api/agency/compare';
import { compareLensDefaults } from '../../utils/agency/compare/compareMetrics';
import { resolveShape } from '../../utils/agency/compare/compareShape';
import type { CompareUrlState } from '../../utils/agency/compare/compareUrl';
import { CODES, WILL_PAY, compareOptions, compareView } from '../helpers/compare';

/**
 * The lens, metrics and trend Compare agents shows (`docs/compare-agents.md` §4): the link's,
 * else the campaign's default view, else the lens's own; what could not be shown is said.
 */

type Choices = Pick<CompareUrlState, 'lens' | 'metrics' | 'trend' | 'viewId'>;
const NOTHING: Choices = { lens: null, metrics: null, trend: undefined, viewId: null };
const NONE = new Set<string>();
const GONE: AgencyCompareMetricRef = { kind: 'outcomes', codes: ['paid_in_full'], better: 'higher', label: 'Paid in full' };
const AVG_CALL: AgencyCompareMetricRef = { kind: 'builtin', key: 'avg_call' };
const CALLS_HANDLED: AgencyCompareMetricRef = { kind: 'builtin', key: 'calls_handled' };
const ids = (refs: readonly AgencyCompareMetricRef[]) => refs.map(compareMetricId);

describe('resolveShape', () => {
  it('shows the starting lens’s own metrics and trend when the link names nothing and there is no default view', () => {
    const defaults = compareLensDefaults('collections', CODES);
    expect(resolveShape(NOTHING, compareOptions(), CODES, NONE)).toEqual({
      lens: 'collections',
      metrics: defaults.metrics,
      trend: defaults.trend,
      viewId: null,
      note: null,
    });
  });

  it('shows the link’s metrics on the link’s lens, leaving out and naming what the campaign cannot show', () => {
    const shape = resolveShape({ lens: 'sales', metrics: [GONE, WILL_PAY], trend: null, viewId: 'view-9' }, compareOptions(), CODES, NONE);
    expect(shape).toMatchObject({ lens: 'sales', trend: null, viewId: 'view-9' });
    expect(ids(shape.metrics)).toEqual([compareMetricId(WILL_PAY)]);
    expect(shape.note).toBe('Paid in full was left out: this campaign doesn’t have its outcomes.');
  });

  it('falls back to the lens’s metrics when none of the link’s can be shown, and says so', () => {
    const shape = resolveShape({ ...NOTHING, lens: 'sales', metrics: [GONE] }, compareOptions(), CODES, NONE);
    expect(shape.lens).toBe('sales');
    expect(shape.metrics).toEqual(compareLensDefaults('sales', CODES).metrics);
    expect(shape.note).toBe(
      'Paid in full was left out: this campaign doesn’t have its outcomes. None of the metrics in the link can be shown on this campaign, so the Sales lens’s metrics are shown instead.',
    );
  });

  it('applies the campaign’s default view only when the link names no lens, metrics or view, and never once deleted', () => {
    const view = compareView({ id: 'view-d', is_campaign_default: true, lens: 'sales', metrics: [AVG_CALL, GONE], trend: null });
    const opts = compareOptions({ default_view: view });
    expect(resolveShape(NOTHING, opts, CODES, NONE)).toEqual({
      lens: 'sales',
      metrics: [AVG_CALL],
      trend: null,
      viewId: 'view-d',
      note: 'Paid in full was left out: this campaign doesn’t have its outcomes.',
    });
    expect(resolveShape({ ...NOTHING, lens: 'collections' }, opts, CODES, NONE).viewId).toBeNull();
    expect(resolveShape(NOTHING, opts, CODES, new Set(['view-d']))).toMatchObject({ lens: 'collections', viewId: null, note: null });
  });

  it('falls back to the starting lens when none of the default view’s metrics can be shown, and says so', () => {
    const view = compareView({ name: 'Old default', is_campaign_default: true, lens: 'sales', metrics: [GONE], trend: null });
    const shape = resolveShape(NOTHING, compareOptions({ default_view: view }), CODES, NONE);
    expect(shape).toMatchObject({ lens: 'collections', metrics: compareLensDefaults('collections', CODES).metrics, viewId: null });
    expect(shape.note).toBe(
      'Paid in full was left out: this campaign doesn’t have its outcomes. None of the metrics in the campaign’s default view, “Old default”, can be shown on this campaign, so the Collections lens’s metrics are shown instead.',
    );
  });

  it('leaves out and names a link’s trend that cannot be counted per day; “none” is no trend and no note', () => {
    const shape = resolveShape({ ...NOTHING, trend: CALLS_HANDLED }, compareOptions(), CODES, NONE);
    expect(shape.trend).toBeNull();
    expect(shape.note).toBe('Calls handled can’t be counted per day, so no per-day trend is shown. Choose an outcome set or promises for it.');
    expect(resolveShape({ ...NOTHING, trend: null }, compareOptions(), CODES, NONE)).toMatchObject({ trend: null, note: null });
  });
});
