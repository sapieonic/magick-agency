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

/** The name the table shows for a row (an id that no longer resolves stays marked as one). */
export function rowName(row: Pick<AgencyTeamAgentRow, 'agent_user_id' | 'agent_name'>): string {
  return agentDisplayName({ agent_user_id: row.agent_user_id, agent_name: row.agent_name });
}

function byName(a: AgencyTeamAgentRow, b: AgencyTeamAgentRow): number {
  return rowName(a).localeCompare(rowName(b), 'en-IN') || a.agent_user_id.localeCompare(b.agent_user_id);
}

function rated(row: AgencyTeamAgentRow): number | null {
  return row.main.reportable && row.main.value !== null ? row.main.value : null;
}

const COMPARATORS: Readonly<Record<TeamSort, (a: AgencyTeamAgentRow, b: AgencyTeamAgentRow) => number>> = {
  rate: (a, b) => {
    const ra = rated(a);
    const rb = rated(b);
    if (ra !== null && rb !== null) return rb - ra || b.calls_handled - a.calls_handled || byName(a, b);
    if (ra !== null) return -1;
    if (rb !== null) return 1;
    return b.calls_handled - a.calls_handled || byName(a, b);
  },
  calls: (a, b) => b.calls_handled - a.calls_handled || byName(a, b),
  shortest: (a, b) => {
    const sa = a.avg_call_seconds;
    const sb = b.avg_call_seconds;
    if (sa !== null && sb !== null) return sa - sb || byName(a, b);
    if (sa !== null) return -1;
    if (sb !== null) return 1;
    return byName(a, b);
  },
};

/** The rows in `sort`'s order, as a new array. */
export function sortTeamRows(rows: readonly AgencyTeamAgentRow[], sort: TeamSort): AgencyTeamAgentRow[] {
  return [...rows].sort(COMPARATORS[sort]);
}
