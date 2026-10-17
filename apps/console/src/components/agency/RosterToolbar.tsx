import type { Dispatch, SetStateAction } from 'react';
import {
  AGENT_STATS_WINDOWS,
  AGENT_STATS_WINDOW_LABELS,
  type AgentStatsWindow,
} from '../../utils/agencyAgentPerformance';
import { ROSTER_COLUMNS, SORT_LABELS, rosterCountReadout } from '../../utils/agencyAgentRoster';
import type { AgentRosterFilters } from '../../hooks/useAgentRoster';
import type { AgencyRosterPage, AgencyRosterSort } from '../../types/agency-stats';
import styles from './AgentAnalyticsSection.module.css';

interface RosterToolbarProps {
  filters: AgentRosterFilters;
  onFiltersChange: Dispatch<SetStateAction<AgentRosterFilters>>;
  /** A column was chosen in the sort menu — the same handler the column headers call. */
  onSort: (column: AgencyRosterSort) => void;
  /** Campaigns the caller can name, sorted by that name. */
  campaignOptions: readonly (readonly [string, string])[];
  /** The page on screen, or `null` while there is none. */
  page: AgencyRosterPage | null;
  onlyFlagged: boolean;
  onOnlyFlaggedChange: (on: boolean) => void;
  /** How many rows on the page carry a flag. */
  attention: number;
}

/**
 * The roster's controls: the campaign in scope, the window, the order, the
 * "needs attention" filter and the count of who is on screen. Out of
 * `AgentAnalyticsPanel`, which owns the filter state every control here writes.
 */
export function RosterToolbar({
  filters,
  onFiltersChange,
  onSort,
  campaignOptions,
  page,
  onlyFlagged,
  onOnlyFlaggedChange,
  attention,
}: RosterToolbarProps) {
  return (
    <div className={styles.filters} role="group" aria-label="Roster filters">
      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="roster-campaign">
          Campaign
        </label>
        {/*
          Defaults to one campaign, not to all of them — see the panel's defaulting effect. The
          "All campaigns" option stays, because "how much did the floor dial this
          week" is a real question; what it loses is the band comparison, which is
          the part that is not true across lead lists.
        */}
        <select
          id="roster-campaign"
          className={styles.control}
          value={filters.campaignId ?? ''}
          data-testid="roster-campaign"
          onChange={(event) =>
            onFiltersChange((prev) => ({ ...prev, campaignId: event.target.value || null }))
          }
        >
          <option value="">All campaigns</option>
          {campaignOptions.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="roster-period">
          Window
        </label>
        {/*
          The per-agent panel's three to-date ranges, from the same `periodRange`,
          plus the two COMPLETED ones the roster needs. A weekly review is run on a
          Monday morning, and "this week" at 09:30 is ninety minutes of dials —
          every row under the rating threshold, every rate "not enough calls",
          every band "no median yet". A screen that is useless at the moment it is
          opened is not a window problem the reader can work around.
        */}
        <select
          id="roster-period"
          className={styles.control}
          value={filters.period}
          data-testid="roster-period"
          onChange={(event) =>
            onFiltersChange((prev) => ({ ...prev, period: event.target.value as AgentStatsWindow }))
          }
        >
          {AGENT_STATS_WINDOWS.map((value) => (
            <option key={value} value={value}>
              {AGENT_STATS_WINDOW_LABELS[value]}
            </option>
          ))}
        </select>
      </div>

      <div className={styles.field}>
        <label className={styles.fieldLabel} htmlFor="roster-sort">
          Sort by
        </label>
        {/*
          A second affordance over the SAME state the column headers write, not a
          second piece of state. It earns its place because the table scrolls
          sideways on a narrow screen — the headers are the better control when
          they are visible and no control at all when they are not — and because
          "sorted by" is the one thing about a truncated roster the reader must be
          able to see without hunting for an arrow.

          Built from `ROSTER_COLUMNS`, the same list the headers come from, so
          every order the reader can choose has a column showing it. It used to be
          built from the whole wire enum and offered two that did not — `successes`
          (the DEFAULT) and `talk_seconds`.
        */}
        <select
          id="roster-sort"
          className={styles.control}
          value={filters.sort}
          data-testid="roster-sort"
          onChange={(event) => onSort(event.target.value as AgencyRosterSort)}
        >
          {ROSTER_COLUMNS.map((column) => (
            <option key={column.sort} value={column.sort}>
              {SORT_LABELS[column.sort]}
            </option>
          ))}
        </select>
      </div>

      {page && page.rows.length > 0 && (
        <label className={styles.toggle} htmlFor="roster-only-flagged">
          <input
            id="roster-only-flagged"
            type="checkbox"
            checked={onlyFlagged}
            data-testid="roster-only-flagged"
            onChange={(event) => onOnlyFlaggedChange(event.target.checked)}
          />
          {/*
            The count is on the control rather than rendered as a fraction of the
            page — the reader wants to know whether pressing it is worth it, and
            "3 of 12" over three independent facts is the shape this surface
            refuses everywhere else.
          */}
          {`Only rows that need attention (${attention})`}
        </label>
      )}

      {page && (
        <p className={styles.countReadout} data-testid="roster-count">
          {rosterCountReadout(page)}
        </p>
      )}
    </div>
  );
}
