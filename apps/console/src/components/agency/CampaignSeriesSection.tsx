import { useEffect, useRef } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useCampaignSeries } from '../../hooks/useCampaignSeries';
import { bucketSeries } from '../../utils/agencyAgentPerformance';
import {
  CAMPAIGN_SERIES_WINDOW_LABELS,
  campaignLifespan,
  campaignSeriesRangeNotes,
  campaignSeriesReach,
  campaignSeriesWindows,
  campaignSeriesZoneNote,
  campaignSingleBucketNote,
  rateTrend,
  type CampaignSeriesReach,
} from '../../utils/agencyCampaignSeries';
import { CampaignActivityChart } from './CampaignActivityChart';
import { CampaignRateChart } from './CampaignRateChart';
import type { AgencyCampaign } from '../../types/agency-campaign';
import type { AgencyCampaignSeries } from '../../types/agency-campaign-series';
import styles from './CampaignSeriesSection.module.css';

/**
 * The workspace's TIME dimension — one section, two charts, one request.
 *
 * ── Why one component draws two different charts ───────────────────────────
 * `chart="activity"` (Overview) answers "is it dialing", `chart="rates"`
 * (Performance) answers "are the rates holding". They are two questions and two
 * forms, but they are the SAME request against the same endpoint with the same
 * range picker, the same four loading states and the same three notes. Splitting
 * them into two components would duplicate all of that and leave two places for
 * "today is still in progress" to be worded differently.
 *
 * ── Two hook instances is correct, not a leak ──────────────────────────────
 * Both sections mount this, so both call `useCampaignSeries`. They are never on
 * screen together: the workspace's sections are URLs (`campaignPanelFromPath`)
 * and the page renders exactly one panel, so at most one instance exists and
 * switching tabs unmounts one and mounts the other. That unmount is also the
 * only refresh this needs — see the hook's "it does not poll".
 *
 * ── The section decides nothing about the data ─────────────────────────────
 * Every number, proportion and sentence below comes from
 * `utils/agencyCampaignSeries.ts` (or, for the activity chart, from
 * `bucketSeries`, which is the per-agent chart's own derivation reused because
 * the API serves the same bucket shape). This file is assembly: a picker, four
 * states, and a choice of chart.
 */

export interface CampaignSeriesSectionProps {
  campaignId: string;
  /**
   * The campaign row, for the range picker's defaults.
   *
   * `null` while the first load is in flight. The hook tolerates it — the window
   * falls back to the last 14 days — and the picker simply offers one option
   * fewer until `started_at` arrives.
   */
  campaign: AgencyCampaign | null;
  chart: 'activity' | 'rates';
  /**
   * Bumped by the page's Refresh control, which re-reads it.
   *
   * The hook deliberately does not poll — this is a shape over days, and
   * re-requesting up to 92 buckets every ten seconds would move nothing a
   * supervisor can see. That made Refresh the only way to bring the charts
   * forward, and it was not wired: pressing it moved the counters and the
   * "Updated" stamp while the charts silently kept showing the older read, with
   * nothing on screen saying so.
   *
   * A token rather than an imperative handle, so the section keeps owning its
   * own fetch and the page never holds a reference into it.
   */
  reloadToken?: number;
}

const COPY = {
  activity: {
    heading: 'Dialing activity',
    description: 'What this campaign dialed and how many calls spoke to a person, one bar pair per day.',
  },
  rates: {
    heading: 'Are the rates holding?',
    description:
      'The figures above cover the whole campaign. This shows how each day compared.',
  },
} as const;

export function CampaignSeriesSection({
  campaignId,
  campaign,
  chart,
  reloadToken = 0,
}: CampaignSeriesSectionProps) {
  const { state, window, setWindow, reload } = useCampaignSeries(campaignId, campaign);

  /*
    Skips the FIRST run: the hook already fetches on mount, and re-running here
    would make every open of the tab two requests. The ref holds the token the
    section was mounted with, so only a later change is a refresh.
  */
  const seenToken = useRef(reloadToken);
  useEffect(() => {
    if (seenToken.current === reloadToken) return;
    seenToken.current = reloadToken;
    reload();
  }, [reloadToken, reload]);
  const windows = campaignSeriesWindows(campaignLifespan(campaign));
  const copy = COPY[chart];

  const series = state.status === 'ready' ? state.series : null;
  const range = state.status === 'ready' ? state.range : null;
  /*
    Both "there is no chart" notes advise widening the range, and this picker
    DEFAULTS to the widest option on a terminal campaign — so without this the
    commonest reading of either note was advice to press a control that was
    already pressed. Derived here rather than inside the bodies because this is
    where the picker's own option list lives.

    The RANGE goes in as well as the window, and it has to be read after `range`
    is resolved above: `life` is clamped to 92 days on a longer campaign, and
    only an unclamped `life` lets the notes speak about the whole campaign. See
    `campaignSeriesReach`.
  */
  const reach = campaignSeriesReach(window, windows, range);
  const zoneNote = campaignSeriesZoneNote(series);
  const rangeNotes = range ? campaignSeriesRangeNotes(range) : [];

  return (
    <section className={styles.card} aria-labelledby={`campaign-series-${chart}`} data-testid={`campaign-series-${chart}`}>
      <div className={styles.head}>
        <div>
          <h3 className={styles.heading} id={`campaign-series-${chart}`}>{copy.heading}</h3>
          <p className={styles.description}>{copy.description}</p>
        </div>
        {/*
          `role="group"` + `aria-pressed`, the house pattern for a segmented
          control (`AgentFloor`'s sort toggle, `PerformancePanel`'s breakdown,
          `ActivityFeed`'s channel filter). Deliberately not a `tablist`: these
          buttons re-run a query rather than reveal one of several panels that
          are already on the page, and a tablist would tell a screen-reader user
          the content below is one tab among several. Deliberately not a
          `radiogroup` either — that one promises arrow-key traversal with a
          roving tabindex, which plain tabbable buttons do not provide.
        */}
        <div className={styles.windows} role="group" aria-label="Date range">
          {windows.map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={option === window}
              className={styles.window}
              data-active={option === window ? 'true' : 'false'}
              onClick={() => setWindow(option)}
            >
              {CAMPAIGN_SERIES_WINDOW_LABELS[option]}
            </button>
          ))}
        </div>
      </div>

      <div className={styles.body}>
        {state.status === 'error' && (
          /*
            The server's own sentence, and no retry button. An API that predates
            the route answers 404 on every attempt, so a Retry here would be a
            control that cannot work — and this console cannot tell that 404 from
            a transient one. The section says what happened and the rest of the
            page, which does not depend on this read, carries on.
          */
          <p className={styles.failed} data-testid="campaign-series-error">
            <AlertTriangle size={15} aria-hidden="true" />
            <span>
              We couldn’t load the day-by-day figures. {state.message} The figures above are
              unaffected.
            </span>
          </p>
        )}

        {(state.status === 'loading' || state.status === 'idle') && (
          /*
            A skeleton the size of the plot, not a spinner: the section is one of
            several on the panel, and a spinner in a card that is about to be 260px
            tall makes the whole page jump when it settles.

            Only for the FIRST read. A refetch keeps the previous chart on screen
            and marks it `stale` — see the hook. Unmounting a drawn chart for the
            length of a round-trip is exactly the churn this section otherwise
            goes to some length to avoid.
          */
          <div className={styles.skeleton} data-testid="campaign-series-loading" aria-hidden="true" />
        )}

        {state.status === 'ready' && (
          /*
            `aria-busy` while a newer read is in flight, and a dimming class — the
            numbers on screen are real, just one read behind, and saying so is
            better than either replacing them with a skeleton or pretending
            nothing is happening.
          */
          <div
            className={state.stale ? styles.stale : undefined}
            aria-busy={state.stale ? 'true' : undefined}
            data-stale={state.stale ? 'true' : 'false'}
            data-testid="campaign-series-body"
          >
            {chart === 'activity'
              ? <ActivityBody series={series} reach={reach} />
              : <RatesBody series={series} reach={reach} />}
          </div>
        )}

        {state.status === 'ready' && (zoneNote || rangeNotes.length > 0) && (
          <div className={styles.notes} data-testid="campaign-series-notes">
            {rangeNotes.map((note) => (
              <p key={note} className={styles.note}>{note}</p>
            ))}
            {zoneNote && <p className={styles.note}>{zoneNote}</p>}
          </div>
        )}
      </div>
    </section>
  );
}

/**
 * The bar chart, or the reason there isn't one.
 *
 * ── Three states, the same three the rate chart distinguishes ─────────────
 * These used to disagree. This side reported an empty `buckets` array as
 * "Nothing was dialed in this range" — but the endpoint's contract is that every
 * day arrives, zeros included, so an empty array means the range had no days in
 * it, and the rate chart one tab away said exactly that. Two panels, one
 * response, contradictory explanations.
 *
 * And the common case was missing entirely: a fortnight in which nothing was
 * dialed has fourteen buckets, so it is `drawable`, and it drew fourteen
 * zero-height bars on a blank axis with no sentence anywhere. A supervisor reads
 * that as a broken screen. `maxAttempts` is checked before `drawable` for that
 * reason — a chart of nothing is not a chart.
 */
function ActivityBody(
  { series, reach }: { series: AgencyCampaignSeries | null; reach: CampaignSeriesReach },
) {
  const points = bucketSeries(series?.buckets);
  const dialed = points.points.reduce((sum, point) => sum + point.attempts, 0);

  if (points.points.length === 0) {
    return (
      <p className={styles.empty} data-testid="campaign-series-single">
        There are no days in this range.
      </p>
    );
  }
  if (dialed === 0) {
    return (
      <p className={styles.empty} data-testid="campaign-series-single">
        Nothing was dialed in this range.
      </p>
    );
  }
  if (!points.drawable) {
    return (
      <p className={styles.empty} data-testid="campaign-series-single">
        {campaignSingleBucketNote(reach)}
      </p>
    );
  }
  return <CampaignActivityChart series={points} />;
}

function RatesBody(
  { series, reach }: { series: AgencyCampaignSeries | null; reach: CampaignSeriesReach },
) {
  const trend = rateTrend(series, reach);
  if (!trend.drawable) {
    return (
      <p className={styles.empty} data-testid="campaign-series-no-trend">
        {trend.reason}
      </p>
    );
  }
  return <CampaignRateChart trend={trend} />;
}

export default CampaignSeriesSection;
