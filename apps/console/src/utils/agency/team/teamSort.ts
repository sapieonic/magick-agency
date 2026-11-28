import type { AgencyTeamAgentRow } from '@magick-agency/contracts/api/agency/team-performance';
import { agentDisplayName } from '../../agencyAgentFloor';
import type { TeamSort } from './teamUrl';

/**
 * The agents table's order (TP16), in the browser: the server sends the rows unsorted. The rank
 * a row shows is its position. A LEAF: pure, no React.
 *
 * - `rate`: the main outcome's rate, rows that clear the floor first (highest first), then the
 *   rest by calls handled (a rate under the floor is not a rank);
 * - `calls`: calls handled, most first;
 * - `shortest`: the average call, shortest first; a row with no calls last.
 *
 * Ties go to the name, so the order never jumps between two reads of the same figures.
 */

/** A row's main-outcome rate when it clears the floor, else null (said in words, not ranked or drawn). */
export function rated(row: AgencyTeamAgentRow): number | null {
  return row.main.reportable && row.main.value !== null ? row.main.value : null;
}

const collator = new Intl.Collator('en-IN');

/** A row with the name the table shows for it, worked out once for the whole sort. */
interface Named {
  row: AgencyTeamAgentRow;
  name: string;
}

function byName(a: Named, b: Named): number {
  return collator.compare(a.name, b.name) || a.row.agent_user_id.localeCompare(b.row.agent_user_id);
}

function byCalls(a: Named, b: Named): number {
  return b.row.calls_handled - a.row.calls_handled || byName(a, b);
}

/** Two values by `both` when each has one, one with a value before one without, else by `neither`. */
function nullsLast(x: number | null, y: number | null, both: (x: number, y: number) => number, neither: () => number): number {
  if (x !== null && y !== null) return both(x, y);
  if (x !== null) return -1;
  if (y !== null) return 1;
  return neither();
}

const COMPARATORS: Readonly<Record<TeamSort, (a: Named, b: Named) => number>> = {
  rate: (a, b) => nullsLast(rated(a.row), rated(b.row), (x, y) => y - x || byCalls(a, b), () => byCalls(a, b)),
  calls: byCalls,
  shortest: (a, b) => nullsLast(a.row.avg_call_seconds, b.row.avg_call_seconds, (x, y) => x - y || byName(a, b), () => byName(a, b)),
};

/** The rows in `sort`'s order, as a new array. */
export function sortTeamRows(rows: readonly AgencyTeamAgentRow[], sort: TeamSort): AgencyTeamAgentRow[] {
  return rows
    .map((row): Named => ({ row, name: agentDisplayName(row) }))
    .sort(COMPARATORS[sort])
    .map((n) => n.row);
}
