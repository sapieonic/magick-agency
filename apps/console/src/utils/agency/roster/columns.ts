import type { AgencyRosterSort } from '../../../types/agency-stats';

/*
  The roster's columns and sort vocabulary: one list builds both the table
  headers and the sort menu. Out of `agencyAgentRoster.ts`, which re-exports
  everything here.
*/

/**
 * What each sortable column is called, in the product's voice.
 *
 * Keyed by the WIRE value so a column header, the truncation sentence and the
 * request parameter cannot drift: the header is the thing that issues the sort,
 * and a second mapping is how a table ends up sorted by something other than the
 * column the reader pressed.
 */
export const SORT_LABELS: Record<AgencyRosterSort, string> = {
  attempts: 'dials',
  // **Connects**, not "conversations". Two quantities, one vocabulary — see
  // `conversionCell`, and the 5x misreading that motivated it.
  connected: 'connects',
  connect_rate_pct: 'connect rate',
  successes: 'conversions',
  success_rate_pct: 'conversion rate',
  aht_seconds: 'handle time',
  talk_seconds: 'talk time',
  occupancy_pct: 'utilisation',
  agent_user_id: 'agent',
};

/**
 * The table's columns, in the order they are read — and the ONLY sortable set.
 *
 * ── Why this lives here rather than in the component ──────────────────────
 * The sort menu above the table and the pressable column headers are two
 * affordances over one piece of state, and the menu used to be built from
 * `Object.keys(SORT_LABELS)`. That is the whole wire enum, so it offered
 * `successes` and `talk_seconds` — two orders with no column to show them, one of
 * which was also the DEFAULT. The table then loaded ranked by a number that
 * appeared nowhere on screen, with `aria-sort="none"` on every header, and nothing
 * about the page said what it was ordered by.
 *
 * Deriving both from this one list makes "every sort option has a column" true by
 * construction instead of by two lists agreeing. `SORT_LABELS` stays complete over
 * the wire enum because {@link truncationNote} renders whatever `sort` the SERVER
 * echoes, which need not be something this client can ask for.
 *
 * ── `talk_seconds` is deliberately absent ─────────────────────────────────
 * It has no column and is therefore not offered. Handle time already carries the
 * per-call duration a supervisor reads, utilisation carries where the shift went,
 * and a tenth column for the raw talk total would be a column nobody scans on a
 * table that already scrolls sideways. The wire still accepts it; this console
 * does not ask.
 */
export interface RosterColumn {
  sort: AgencyRosterSort;
  label: string;
  /** Numeric columns are right-aligned and tabular; the name column is not. */
  numeric: boolean;
  /**
   * The definition, rendered under the header rather than hidden in a `title`.
   *
   * Only where the label is genuinely ambiguous about its denominator — which on
   * this table is every rate. A hint on "Dials" would be noise.
   */
  hint?: string;
}

export const ROSTER_COLUMNS: readonly RosterColumn[] = [
  { sort: 'agent_user_id', label: 'Agent', numeric: false },
  { sort: 'attempts', label: 'Dials', numeric: true },
  { sort: 'connected', label: 'Connects', numeric: true, hint: 'answered' },
  { sort: 'connect_rate_pct', label: 'Connect rate', numeric: false, hint: 'of dials' },
  // The count, immediately left of its rate — the same pairing as dials and
  // connect rate, and the reason both are on screen: this is the column the
  // roster's default order ranks by, and the one a dealer pays for.
  { sort: 'successes', label: 'Conversions', numeric: true, hint: 'booked' },
  { sort: 'success_rate_pct', label: 'Conversion rate', numeric: true, hint: 'of connects' },
  { sort: 'aht_seconds', label: 'AHT', numeric: true, hint: 'talk + wrap-up per connect' },
  {
    sort: 'occupancy_pct',
    label: 'Utilisation',
    numeric: true,
    // The definition on the header, the denominator on every row — see
    // `utilisationBasis`, which also names the break time the shift includes. This
    // is the figure most likely to reach a pay review.
    hint: 'handled ÷ time on shift',
  },
];

/**
 * The `limit` this console asks for — the contract's maximum.
 *
 * This console used to send none, so the server's default of 100 applied and an agency with
 * 180 agents silently lost 80 rows. Under `conversions desc` the eighty cut are
 * the LOWEST converters, which is the exact population a supervisor is triaging.
 * 200 is the contract's ceiling (`limit` is `1..200`), there is no server-side
 * paging in phase 01, and asking for the maximum is the only lever this client
 * has. Beyond 200 the honest affordances take over: {@link truncationNote} says
 * the roster was cut and by which order, and the flag filter
 * ({@link rosterAttentionRows}) makes a marked row reachable without re-sorting.
 */
export const ROSTER_LIMIT = 200;

/**
 * The direction a column should START in when it is first pressed.
 *
 * Descending for every metric, because pressing "dials" means "who dialled most"
 * — and ascending for the name, because pressing a name column means A–Z. A
 * uniform default would make one of the two need two presses to do the obvious
 * thing.
 */
export function initialOrder(sort: AgencyRosterSort): 'asc' | 'desc' {
  return sort === 'agent_user_id' ? 'asc' : 'desc';
}

/** `aria-sort`'s vocabulary, which is not `asc`/`desc`. */
export function ariaSort(
  column: AgencyRosterSort,
  sort: AgencyRosterSort,
  order: 'asc' | 'desc',
): 'ascending' | 'descending' | 'none' {
  if (column !== sort) return 'none';
  return order === 'asc' ? 'ascending' : 'descending';
}
