import type {
  AgencyCompareMetricRef,
  AgencyCompareOptions,
  AgencyCompareOutcomeCode,
  CompareLens,
} from '@magick-agency/contracts/api/agency/compare';
import { applyToCatalog, compareLensDefaults, droppedNote, fallbackNote, type AppliedMetrics } from './compareMetrics';
import type { CompareUrlState } from './compareUrl';

/**
 * The lens, metrics and trend Compare agents shows (`docs/compare-agents.md` §4): the URL's, else
 * the campaign's default view, else the lens's own. A LEAF: pure, no React.
 */

/** The lens, metrics and trend the page shows, and where they came from. */
export interface CompareShape {
  lens: CompareLens;
  metrics: AgencyCompareMetricRef[];
  trend: AgencyCompareMetricRef | null;
  viewId: string | null;
  /** What applying a view or a link had to leave out, in words. */
  note: string | null;
}

/**
 * The shape for the URL's choices against the campaign's options. A link's metrics are applied to
 * the campaign's current catalog; with none in the link (and no lens or view named), the
 * campaign's default view is, unless it was deleted on this page (`deletedViews`). When none of
 * a link's or the default view's metrics can be shown, the lens's metrics are, and the note says
 * so, never silently.
 */
export function resolveShape(
  state: Pick<CompareUrlState, 'lens' | 'metrics' | 'trend' | 'viewId'>,
  opts: Pick<AgencyCompareOptions, 'starting_lens' | 'default_view'>,
  codes: readonly AgencyCompareOutcomeCode[],
  deletedViews: ReadonlySet<string>,
): CompareShape {
  const lens = state.lens ?? opts.starting_lens;
  const defaults = compareLensDefaults(lens, codes);
  const trend = state.trend === undefined ? defaults.trend : state.trend;
  const fromApplied = (applied: AppliedMetrics, shownLens: CompareLens, viewId: string | null): CompareShape => ({
    lens: shownLens,
    metrics: applied.metrics,
    trend: applied.trend,
    viewId,
    note: droppedNote(applied),
  });

  let fallback: string | null = null;
  if (state.metrics !== null) {
    const applied = applyToCatalog(state.metrics, trend, codes);
    if (applied.metrics.length > 0) return fromApplied(applied, lens, state.viewId);
    fallback = fallbackNote(applied, 'the link', lens);
  }
  const view = opts.default_view && !deletedViews.has(opts.default_view.id) ? opts.default_view : null;
  if (state.metrics === null && state.lens === null && state.viewId === null && view) {
    const applied = applyToCatalog(view.metrics, view.trend, codes);
    if (applied.metrics.length > 0) return fromApplied(applied, view.lens, view.id);
    fallback = fallbackNote(applied, `the campaign’s default view, “${view.name}”,`, opts.starting_lens);
  }
  const kept = trend ? applyToCatalog([], trend, codes) : null;
  // A link's trend the campaign cannot draw is left out and said, as its metrics would be; once
  // the fallback note has said it, it is not said twice.
  const note = fallback ?? (kept ? droppedNote(kept) : null);
  return { lens, metrics: defaults.metrics, trend: kept?.trend ?? null, viewId: state.viewId, note };
}
