import { useCallback, useMemo, useRef } from 'react';
import { Users } from 'lucide-react';
import { trackAgencyCompareTrayOpened } from '../../analytics/events';
import type { AgencyRosterAgentRowWithName, AgencyRosterPage } from '../../types/agency-stats';
import type { AgentStatsWindow } from '../../utils/agencyAgentPerformance';
import {
  agentInitials,
  benchmarkUsable,
  ratedBasisNote,
  withheldRateTitle,
  type RosterCell,
} from '../../utils/agencyAgentRoster';
import { hasResolvedName } from '../../utils/agencyAgentFloor';
import {
  COMPARE_FLOOR_LABEL,
  COMPARE_FLOOR_SUBLINE,
  COMPARE_METRICS,
  compareAgentName,
  compareAvailable,
  compareBandBasisNote,
  compareCaption,
  compareFloorUtilisationBasis,
  compareReady,
  compareRows,
  compareSelectable,
  compareSelectionHint,
  compareToggle,
} from '../../utils/agencyCompareTray';
import table from './RosterTable.module.css';
import shell from './AgentAnalyticsSection.module.css';

/**
 * Two to four people from the roster, side by side against the floor's band.
 *
 * ── It issues ZERO requests ───────────────────────────────────────────────
 * Everything on screen comes off the `AgencyRosterPage` the table above it is
 * already rendering: its rows and its `benchmark`. So the tray cannot disagree with
 * the table two inches above it, which is the failure a "vs team" fetch would
 * introduce the first time the two reads straddled a dial. It is also why there is
 * no loading state, no error state and no retry here — there is nothing to fail.
 *
 * The server-side alternative was refused for a sharper reason than symmetry:
 * master holds ONE `AGENT_STATS_QUERY_PARAMS` whitelist shared by `/my-stats` and
 * its supervisory twin, so adding a `compare_to` param for a "vs team" line would
 * expose it on the agent's own scorecard in the same edit — and the cohort band is
 * supervisor-only by user ruling. See `utils/agencyCompareTray.ts`.
 *
 * ── Suppressed entirely on a pooled cohort ────────────────────────────────
 * The caller renders nothing at all when `compareAvailable(page)` is false. A pooled
 * multi-campaign cohort is not a peer group — different dealerships' lead lists
 * differ in intrinsic connectability by a large factor — and `mixedCohortNote`
 * already tells the reader the per-person comparison is switched off there. A tray
 * is the most emphatic per-person comparison against a band available on this
 * surface, so offering it would contradict that sentence in the loudest way
 * possible.
 *
 * ── Every cell is the ROSTER's cell ───────────────────────────────────────
 * `COMPARE_METRICS` holds the roster's own `connectRateCell`, `conversionCell`,
 * `handleTimeCell` and `utilisationCell` as function references, so a rate the
 * table declined to print renders "Not enough calls" here too — by construction
 * rather than by remembering to. The tray may not become a way to read a number the
 * table withheld.
 *
 * ── The stylesheet is the roster's, deliberately ──────────────────────────
 * `RosterTable.module.css` is already shared by two tables for the stated reason
 * that a supervisor moving between them in one click must not meet two dialects.
 * This is a third view of the same rows with the same three absence states and the
 * same pinned cohort row, so it is the same sheet — a second one is how the same
 * `subline` ends up two shades apart on two screens.
 */

export interface CompareTrayProps {
  /** The page the roster is rendering. Nothing here reads anything else. */
  page: AgencyRosterPage;
  /** The window, for the analytics event — the roster's own vocabulary. */
  window: AgentStatsWindow;
  /**
   * Whether the tray is open, and who is picked — **owned by the CALLER.**
   *
   * ── Why this is not local state, which is what it was ─────────────────────
   * This component is mounted only while the roster's state is `ready`, and every
   * refetch — a column header, a window change, the inactive toggle, a Retry —
   * passes through `loading` first. So the tray was UNMOUNTED on every refetch and
   * remounted with `open: false` and an empty selection. Two consequences, and the
   * second is the one that made it a bug rather than a preference:
   *
   *  1. A supervisor who picked four people and then re-sorted the table lost the
   *     comparison and had to build it again.
   *  2. Its own pruning logic could never run. A selection that outlives a refetch
   *     is precisely what `compareMissing` exists to clean up, and a selection
   *     could not outlive one — so the effect was dead code that read as a
   *     safeguard, and any test over it was testing a path the product cannot
   *     reach.
   *
   * Hoisting the two values to the caller — which holds a `page` across the loading
   * gap and can therefore prune when a NEW page arrives, whether the tray is open
   * or not — makes both real. Nothing about the roster hook's state machine
   * changed; the tray simply stopped being the owner of state that has to outlive
   * it.
   */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selected: readonly string[];
  onSelectedChange: (next: readonly string[]) => void;
}

export function CompareTray({
  page,
  window: statsWindow,
  open,
  onOpenChange,
  selected,
  onSelectedChange,
}: CompareTrayProps) {
  const rows = useMemo(() => compareRows(page, selected), [page, selected]);
  const ready = compareReady(selected);

  /**
   * `agency_compare_tray_opened`, once per page identity.
   *
   * On OPEN rather than on a valid selection, because opening is the intent the
   * event is about and a firing per tick would count checkbox presses. Keyed on the
   * page's window and scope so re-opening it after a refetch is a second, real
   * opening rather than a suppressed one.
   */
  const trackedKey = useRef<string | null>(null);
  const onOpen = useCallback(() => {
    onOpenChange(true);
    const key = `${page.campaign_id ?? ''}:${page.from}:${page.to}`;
    if (trackedKey.current === key) return;
    trackedKey.current = key;
    trackAgencyCompareTrayOpened({
      /*
        A string, not nullable: the tray is suppressed entirely on a pooled cohort,
        so a firing with no campaign in scope would be a bug rather than a state.
        `?? ''` is the type's floor and is unreachable through the caller's guard.
      */
      campaign_id: page.campaign_id ?? '',
      window: statsWindow,
      rows_available: page.rows.length,
      agents_selected: selected.length,
      agents_rated: page.benchmark.agents_rated,
      benchmark_usable: benchmarkUsable(page.benchmark),
    });
  }, [page, statsWindow, selected.length, onOpenChange]);

  /*
    The caller is expected to check this too, and checking it here as well is not
    belt-and-braces: this component is the one that knows the tray is a per-person
    comparison against a band, and a future caller that forgot would otherwise ship
    exactly the screen `mixedCohortNote` says is switched off.
  */
  if (!compareAvailable(page)) return null;

  if (!open) {
    return (
      <div className={shell.inactiveRow}>
        <button
          type="button"
          className={shell.contributionEntry}
          data-testid="compare-tray-open"
          onClick={onOpen}
        >
          <Users size={14} aria-hidden="true" />
          Compare two to four people
        </button>
      </div>
    );
  }

  return (
    <section aria-label="Compare people on this roster" data-testid="compare-tray">
      <div className={shell.inactiveRow}>
        <p className={shell.note} data-testid="compare-tray-hint">
          {compareSelectionHint(selected)}
        </p>
        <button
          type="button"
          className={shell.contributionEntry}
          data-testid="compare-tray-close"
          onClick={() => onOpenChange(false)}
        >
          Close comparison
        </button>
      </div>

      {/*
        The picker is the page's OWN rows and nothing else — that is what "already on
        the roster page" means, and it is why nothing is fetched. At the cap the
        remaining boxes are disabled rather than silently swapping somebody out: a
        control that removes a person the reader deliberately chose is worse than one
        that does not move.
      */}
      <div className={shell.filters} role="group" aria-label="People to compare">
        {page.rows.map((row) => (
          <label
            key={row.agent_user_id}
            className={shell.toggle}
            htmlFor={`compare-pick-${row.agent_user_id}`}
          >
            <input
              id={`compare-pick-${row.agent_user_id}`}
              type="checkbox"
              checked={selected.includes(row.agent_user_id)}
              disabled={!compareSelectable(selected, row.agent_user_id)}
              data-testid={`compare-pick-${row.agent_user_id}`}
              onChange={() => onSelectedChange(compareToggle(selected, row.agent_user_id))}
            />
            {compareAgentName(row)}
          </label>
        ))}
      </div>

      {/*
        The one sentence the tray adds. It exists because the tray LOOKS like a
        comparison of the people in it and is not: every band on it is the whole
        floor's, including the people who were not picked. A reader who takes
        "middle half 28.4%–41.2%" for the middle half of the two columns above it
        has read a much narrower claim than the one being made.
      */}
      <p className={shell.note} data-testid="compare-tray-basis">
        {compareBandBasisNote(page)}
      </p>

      {!ready && (
        <p className={shell.empty} data-testid="compare-tray-incomplete">
          Tick at least two people above and their figures appear here, side by side
          with the floor’s own.
        </p>
      )}

      {ready && <CompareTable page={page} rows={rows} />}
    </section>
  );
}

function CompareTable({
  page,
  rows,
}: {
  page: AgencyRosterPage;
  rows: readonly AgencyRosterAgentRowWithName[];
}) {
  const floorBasis = compareFloorUtilisationBasis(page.benchmark);

  return (
    <div className={table.tableWrap} data-testid="compare-tray-table">
      <table className={table.table}>
        <caption className={table.srOnly}>{compareCaption(rows)}</caption>
        <thead>
          <tr>
            <th scope="col">
              <span className={table.headLabel}>Agent</span>
            </th>
            {COMPARE_METRICS.map((metric) => (
              <th key={metric.key} scope="col" data-numeric="true">
                <span className={table.headLabel}>{metric.label}</span>
                {/* The denominator on the header, as on the contribution table: on
                    this table every rate has a different one, and a denominator a
                    reader has to hover for is one most of them never see. */}
                <span className={table.headHint}>{metric.hint}</span>
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => (
            <tr key={row.agent_user_id} data-testid={`compare-row-${row.agent_user_id}`}>
              <th scope="row" className={table.agentCell}>
                {/*
                  A plain cell, not a button. The roster row directly above is the
                  way into a person's figures and it already is one; a second control
                  doing the same thing from a comparison panel would be two
                  affordances for one destination, and the tray's job is the
                  comparison rather than the navigation.
                */}
                <span className={table.agentStatic}>
                  <span className={table.avatar} aria-hidden="true">
                    {agentInitials(compareAgentName(row))}
                  </span>
                  <span className={table.agentText}>
                    <span className={hasResolvedName(row) ? table.name : table.nameFallback}>
                      {compareAgentName(row)}
                    </span>
                  </span>
                </span>
              </th>
              {COMPARE_METRICS.map((metric) => (
                <td key={metric.key} data-numeric="true">
                  {/*
                    The ROSTER's cell function, called on the roster's row. A rate
                    the table withheld is withheld here by construction — there is
                    no second implementation that could disagree with it.
                  */}
                  <MetricCell cell={metric.cell(row)} basis={metric.basis?.(row) ?? null} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>

        {/*
          The floor, pinned in a `<tfoot>` — the same element, the same styling and
          the same reasoning as the roster's team row: it is not one of the people
          above, it must never look pressable, and `tfoot` says "the figure the rows
          are read against" to a screen reader without a label claiming it.

          Every figure in it is the BENCHMARK's, never a sum of the columns above:
          the benchmark is deliberately unaffected by `include_inactive`, and a
          row-derived floor figure would move when the reader revealed former
          members — a different number under the same name.
        */}
        <tfoot>
          <tr className={table.teamRow} data-testid="compare-floor-row">
            <th scope="row">
              <span className={table.teamName}>{COMPARE_FLOOR_LABEL}</span>
              <span className={table.subline}>{COMPARE_FLOOR_SUBLINE}</span>
              <span className={table.ratedCount} data-testid="compare-rated-count">
                {ratedBasisNote(page.benchmark)}
              </span>
            </th>
            {COMPARE_METRICS.map((metric) => {
              const band = metric.band(page.benchmark);
              return (
                <td key={metric.key} data-numeric="true">
                  <div className={table.teamRate}>
                    <span className={table.teamPooled}>{metric.pooled(page.benchmark)}</span>
                    {metric.key === 'occupancy' && floorBasis !== null && (
                      <span className={table.subline} data-testid="compare-floor-basis">
                        {floorBasis}
                      </span>
                    )}
                    {/*
                      `null` renders NO line rather than "no median yet": that
                      sentence is a claim about the floor, and making it about a
                      percentile block master has not shipped (`aht` is additive)
                      would be a false one.
                    */}
                    {band !== null && (
                      <span className={table.subline} data-testid={`compare-band-${metric.key}`}>
                        {band}
                      </span>
                    )}
                  </div>
                </td>
              );
            })}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

/**
 * One metric, in whichever of its three states it is in — the roster's renderer.
 *
 * The `withheld` arm names the threshold in its `title` for the roster's reason:
 * every withheld cell would otherwise repeat the same sentence, and a column of
 * repeated sentences is one nobody reads.
 *
 * Through `withheldRateTitle`, so the tooltip names the rate's own denominator.
 * The tray is the third copy of a sentence that said "calls" in all three, and a
 * tray is where a withheld conversion rate is most likely to be read closely:
 * every column beside it is another person's answer to the same question.
 */
function MetricCell({ cell, basis }: { cell: RosterCell; basis: string | null }) {
  if (cell.kind === 'measured') {
    return (
      <span className={table.utilisation}>
        <span className={table.value}>{cell.text}</span>
        {basis !== null && <span className={table.subline}>{basis}</span>}
      </span>
    );
  }
  return (
    <span
      className={cell.kind === 'withheld' ? table.withheld : table.unmeasured}
      title={cell.kind === 'withheld' ? withheldRateTitle(cell) : undefined}
    >
      <span className={table.absentText}>{cell.text}</span>
      <span className={table.subline}>{cell.note}</span>
    </span>
  );
}

export default CompareTray;
