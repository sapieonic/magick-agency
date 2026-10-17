import { formatCount } from '../../format/number';

/*
  One Overview number and its absence: the shape every figure on the panel
  shares, the em dash an unknown one shows, and a count as a figure.
*/

/** One figure in the pulse strip, ready to render. */
export interface OverviewFigure {
  /** The formatted number, or `—` when nothing arrived. */
  value: string;
  /** True only when a real measurement is behind {@link value}. */
  known: boolean;
  /**
   * A supporting sentence beneath the number, or `null`.
   *
   * `null` is the honest answer whenever the figure that would fill it is
   * absent or un-measurable — a sub-line is dropped, never faked with a zero.
   */
  sub: string | null;
}

export const DASH = '—';

export function countFigure(value: number | undefined): OverviewFigure {
  return typeof value === 'number'
    ? { value: formatCount(value), known: true, sub: null }
    : { value: DASH, known: false, sub: null };
}
