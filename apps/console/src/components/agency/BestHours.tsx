import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useBestHours } from '../../hooks/useBestHours';
import { trackAgencyBestHoursViewed } from '../../analytics/events';
import {
  AGENT_STATS_WINDOWS,
  AGENT_STATS_WINDOW_LABELS,
  campaignLabel,
  windowRangeReadout,
  type AgentStatsWindow,
} from '../../utils/agencyAgentPerformance';
import { contributionCampaignOptions } from '../../utils/agencyCampaignContribution';
import {
  BEST_HOURS_CELLS,
  BEST_HOURS_DEFAULT_VIEW,
  BEST_HOURS_VIEWS,
  BEST_HOURS_VIEW_HINTS,
  BEST_HOURS_VIEW_LABELS,
  BEST_HOURS_ZONE_UNKNOWN_NOTE,
  bestHoursCountReadout,
  bestHoursCoverageNote,
  bestHoursMatrix,
  bestHoursWithheldReadout,
  bestHoursZone,
  weekdayCoverage,
  type BestHoursView,
} from '../../utils/agencyBestHours';
import { BestHoursMatrix } from './BestHoursMatrix';
import { ErrorAlert } from '../common/ErrorAlert';
import { LoadingSpinner } from '../common/LoadingSpinner';
import styles from './AgentAnalyticsSection.module.css';

/**
 * "When does this campaign actually connect" — the best-hours surface.
 *
 * ── The question, and why it is a screen rather than a column ──────────────
 * The roster answers "who should I be asking about" and the contribution table
 * answers "who drove this campaign". Neither can answer "when should I roster
 * people", because both fold the whole window into one figure per person. This
 * reads the same grouped route cut by weekday and hour instead, and colours the
 * result.
 *
 * ── One campaign, and there is no pooled view ─────────────────────────────
 * Stronger than the contribution screen's preference: both time dimensions are
 * spent, so `campaign` cannot also be grouped, and the read's zone is unambiguous
 * only because exactly one campaign is filtered. A pooled read is a
 * `400 timezone_ambiguous` upstream, so the selector has **no "all campaigns"
 * option** and the caller only offers the way in with a campaign in scope. The 400
 * is never "handled" by retrying in UTC — an Asia/Kolkata campaign's real connect
 * peak sits five and a half hours from where a UTC fallback would draw it.
 *
 * ── The view switch RE-RENDERS ────────────────────────────────────────────
 * `view` is component state and is not an input to `useBestHours`: the payload
 * carries every metric on every cell, so all three views come from one read. A view
 * switch that fired a request would let the three views disagree about one
 * campaign's week — a reader flipping between "connect rate" and "volume" would
 * watch the map change under a control that is supposed to be re-colouring the same
 * numbers.
 *
 * ── Two zones on one screen, and both are correctly labelled ──────────────
 * The window readout beneath the controls is in the READER's zone, because
 * `windowRange` cut those bounds from a local `Date` — `windowRangeReadout` says so.
 * The hour axis is in the CAMPAIGN's zone, from `resolved_timezone`, and says that.
 * They are genuinely different facts and the screen names each of them; what it
 * never does is let one stand in for the other. When `resolved_timezone` did not
 * arrive, the axis carries no zone at all and a sentence says why.
 *
 * ── What this screen deliberately does NOT do ────────────────────────────
 * No composite score, no recommended call window, no auto-refresh, and no mix
 * adjustment. The map is DESCRIPTIVE: an hour looks good partly because of *who*
 * was rostered on it, and a "best time to call" pick would be a composite score
 * with one input that inherits every one of those problems while reading as advice.
 * The map shows the numbers and the supervisor decides.
 */

export interface BestHoursProps {
  campaignId: string;
  /**
   * The campaign names the page already holds.
   *
   * The map rather than a resolved string, so this component uses the same
   * `campaignLabel` stand-in every other agency surface does: an id with no match
   * renders as a shortened id, never blank and never a name this client invented.
   */
  campaignNames: ReadonlyMap<string, string | null>;
  /** The roster's window, as the starting point. */
  period: AgentStatsWindow;
  /**
   * A different campaign was chosen here.
   *
   * The caller owns {@link campaignId} for the contribution screen's reason: there
   * has to be one answer to "which campaign is this", and going back must land on
   * the roster the reader left rather than one this screen re-scoped behind them.
   */
  onCampaignChange: (campaignId: string) => void;
  onBack: () => void;
}

export function BestHours({
  campaignId,
  campaignNames,
  period: initialPeriod,
  onCampaignChange,
  onBack,
}: BestHoursProps) {
  const [period, setPeriod] = useState<AgentStatsWindow>(initialPeriod);
  /*
    The view is state HERE and nowhere near the hook. See the header: one read
    carries all three, so switching is a re-render.
  */
  const [view, setView] = useState<BestHoursView>(BEST_HOURS_DEFAULT_VIEW);

  const { state, reload } = useBestHours({ campaignId, period });
  const name = campaignLabel(campaignId, campaignNames);

  /*
    The same option list the contribution selector offers — no "all campaigns", the
    campaign in scope always present (a `<select>` whose value matches no option
    renders blank), the rest sorted by name. One helper, so the two screens cannot
    come to describe different sets of campaigns.
  */
  const campaignOptions = useMemo(
    () => contributionCampaignOptions(campaignId, campaignNames),
    [campaignId, campaignNames],
  );

  const page = state.status === 'ready' || state.status === 'empty' ? state.page : null;

  /**
   * The zone, and the coverage derived IN it.
   *
   * Both memoised on the page rather than on the view, because neither depends on
   * which metric is being coloured — and the coverage walk is the one piece of real
   * work on this screen (it steps the window half-hour by half-hour so a DST
   * transition inside it cannot put every later cell an hour out).
   */
  const zone = page === null ? null : bestHoursZone(page);
  const coverage = useMemo(
    () => (page === null ? { known: false, covered: new Map() } : weekdayCoverage(page.from, page.to, zone)),
    [page, zone],
  );

  /* The matrix depends on the view, and only on the view. */
  const matrix = useMemo(
    () => (page === null ? null : bestHoursMatrix(page, view, coverage)),
    [page, view, coverage],
  );

  /**
   * `agency_best_hours_viewed`, once per campaign in scope.
   *
   * Keyed on the campaign rather than on the mount, because the selector re-reads
   * WITHOUT remounting — the contribution view's own event does the same for the
   * same reason. Deliberately not re-fired on a view switch or a window change: one
   * event per view would make "how often is this map opened" a count of how often
   * three radio buttons were pressed.
   *
   * It carries the honesty state the map is read under, because that is what a
   * question about this screen will be about — and `withheld_cells` is the console's
   * own answer rather than three counts for a funnel to re-derive.
   */
  const tracked = useRef<string | null>(null);
  useEffect(() => {
    if (matrix === null || page === null) return;
    if (tracked.current === campaignId) return;
    tracked.current = campaignId;
    trackAgencyBestHoursViewed({
      campaign_id: campaignId,
      window: period,
      view,
      resolved_timezone: zone,
      zone_read: zone !== null,
      cells: BEST_HOURS_CELLS,
      cells_with_dials: matrix.dialled,
      withheld_cells: matrix.withheld,
      out_of_window_cells: matrix.outOfWindow,
      coverage_known: matrix.coverageKnown,
      total_groups: page.total_groups,
    });
  }, [matrix, page, campaignId, period, view, zone]);

  const withheld = matrix === null ? null : bestHoursWithheldReadout(matrix);
  const coverageNote = matrix === null ? null : bestHoursCoverageNote(matrix);

  return (
    <>
      <div className={styles.drilldownHeader}>
        <button type="button" className={styles.back} onClick={onBack} data-testid="best-hours-back">
          <ArrowLeft size={14} aria-hidden="true" />
          All agents
        </button>
        <h3 className={styles.drilldownName}>When {name} connects</h3>
      </div>

      <p className={styles.description}>
        Every weekday and hour this campaign dialled in the window, coloured by{' '}
        {BEST_HOURS_VIEW_LABELS[view].toLowerCase()}. It describes what happened; it does
        not recommend a time to call — an hour also looks good because of who was
        rostered on it, and that is not something this read can separate out.
      </p>

      <div className={styles.filters} role="group" aria-label="Best hours filters">
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="best-hours-campaign">
            Campaign
          </label>
          {/*
            No "All campaigns" option, and here that is not a preference — a pooled
            read is a 400 upstream, because with both time dimensions grouped there
            is no way for the zone to be unambiguous except a single campaign filter.
          */}
          <select
            id="best-hours-campaign"
            className={styles.control}
            value={campaignId}
            data-testid="best-hours-campaign"
            onChange={(event) => onCampaignChange(event.target.value)}
          >
            {campaignOptions.map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="best-hours-period">
            Window
          </label>
          <select
            id="best-hours-period"
            className={styles.control}
            value={period}
            data-testid="best-hours-period"
            onChange={(event) => setPeriod(event.target.value as AgentStatsWindow)}
          >
            {AGENT_STATS_WINDOWS.map((value) => (
              <option key={value} value={value}>
                {AGENT_STATS_WINDOW_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="best-hours-view">
            Colour by
          </label>
          {/*
            A re-render, not a re-read — see the header. Every metric is already on
            every cell of the one page in hand.
          */}
          <select
            id="best-hours-view"
            className={styles.control}
            value={view}
            data-testid="best-hours-view"
            onChange={(event) => setView(event.target.value as BestHoursView)}
          >
            {BEST_HOURS_VIEWS.map((value) => (
              <option key={value} value={value}>
                {`${BEST_HOURS_VIEW_LABELS[value]} (${BEST_HOURS_VIEW_HINTS[value]})`}
              </option>
            ))}
          </select>
        </div>

        {matrix && (
          <p className={styles.countReadout} data-testid="best-hours-count">
            {bestHoursCountReadout(matrix)}
          </p>
        )}

        {/*
          The window's DAYS, in the READER's zone — which is what `windowRange` cut
          them in, and what this readout says. It is a different zone from the hour
          axis's and both are labelled: see the header.
        */}
        {page && windowRangeReadout(page.from, page.to) && (
          <p className={styles.countReadout} data-testid="best-hours-window-range">
            {windowRangeReadout(page.from, page.to)}
          </p>
        )}
      </div>

      {/*
        ABOVE the grid, all three of them, because every one is about how to read
        what IS on screen rather than what is missing from it: which rows were never
        asked about, how many cells are not on the scale, and whether the hours are
        labelled with a zone at all. A caveat met after the map has been read is not
        a caveat.
      */}
      {coverageNote && (
        <p className={styles.warning} data-testid="best-hours-coverage">
          {coverageNote}
        </p>
      )}

      {page && zone === null && (
        <p className={styles.warning} data-testid="best-hours-zone-unknown">
          {BEST_HOURS_ZONE_UNKNOWN_NOTE}
        </p>
      )}

      {withheld && (
        <p className={styles.warning} data-testid="best-hours-withheld">
          {withheld}
        </p>
      )}

      {state.status === 'loading' && (
        <div className={styles.centred} data-testid="best-hours-loading">
          <LoadingSpinner />
        </div>
      )}

      {state.status === 'error' && (
        /* A failure with a retry — a different fact from "nobody dialled it", and an
           empty grid for both is how a supervisor concludes a campaign did nothing. */
        <div data-testid="best-hours-error">
          <ErrorAlert message={state.message} onRetry={reload} />
        </div>
      )}

      {state.status === 'empty' && (
        <p className={styles.empty} data-testid="best-hours-empty">
          Nobody dialled {name} in this window, so there are no hours to compare. Try a
          longer window.
        </p>
      )}

      {state.status === 'ready' && matrix && (
        <BestHoursMatrix
          matrix={matrix}
          /*
            The campaign's zone, from the payload — never the reader's, and never
            re-derived inside the grid. E3, and the reason the prop exists.
          */
          zone={zone}
          caption={`When ${name} connects — ${AGENT_STATS_WINDOW_LABELS[
            period
          ].toLowerCase()}, coloured by ${BEST_HOURS_VIEW_LABELS[view].toLowerCase()}`}
        />
      )}
    </>
  );
}

export default BestHours;
