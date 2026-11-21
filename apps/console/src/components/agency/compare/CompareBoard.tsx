import type { ReactNode } from 'react';
import type { AgencyCompareOutcomeCode, AgencyCompareResponse } from '@magick-agency/contracts/api/agency/compare';
import { infoLabel } from '../../../utils/agency/compare/compareMetrics';
import { clockTime } from '../../../utils/agency/stationFormat';
import { plural } from '../../../utils/format/number';
import { formatReportDay } from '../../../utils/reports/reportCopy';
import { CompareCard } from './CompareCard';
import { CompareFindings } from './CompareFindings';
import { CompareNumbers } from './CompareNumbers';
import { DaySplitBars, DaySplitLegend, MetricBars, TrendChart, agentColour, type ChartAgent } from './CompareCharts';
import styles from './Compare.module.css';

/**
 * The comparison on screen (`docs/compare-agents.md` §2 items 3–6): the legend, Side by side,
 * What stands out, the per-day trend, Where their day went and The numbers, for the picked agents
 * the answer has (`agents`, never empty).
 */
export interface CompareBoardProps {
  response: AgencyCompareResponse;
  agents: readonly ChartAgent[];
  codes: readonly AgencyCompareOutcomeCode[];
  timezone: string;
  canListen: boolean;
  /** Check a longer window; absent when the window is already as long as allowed. */
  onLonger?: () => void;
  /** A newer read is on its way: the answer on screen stays up, marked as updating. */
  updating: boolean;
  /** The answer on screen was read for other choices, and the read for these failed. */
  stale: boolean;
  /** A failed read, said between the legend and the figures it kept up. */
  error: ReactNode;
}

export function CompareBoard({ response, agents, codes, timezone, canListen, onLonger, updating, stale, error }: CompareBoardProps) {
  const flaggable = response.metrics.filter((m) => m.flaggable).length;
  return (
    <>
      <ul className={styles.legend} aria-label="Legend">
        {agents.map((a) => (
          <li key={a.id}>
            <span className={styles.swatch} style={{ background: agentColour(a.slot) }} aria-hidden="true" />
            {a.name}
          </li>
        ))}
        <li>
          <span className={styles.swatchLine} aria-hidden="true" />
          Team median
        </li>
        <li>
          <span className={styles.swatchBand} aria-hidden="true" />
          Middle half of the team
        </li>
      </ul>
      {error}
      {updating ? (
        <p className={styles.updating} role="status">
          Updating…
        </p>
      ) : null}
      {stale ? (
        <p className={styles.note} role="status" data-testid="compare-stale">
          {`These are the last figures that loaded, for ${windowWords(response.from, response.to)}, not for the choices above.`}
        </p>
      ) : null}
      <div className={styles.board}>
        <CompareCard
          title="Side by side"
          sub={`${plural(response.cohort.agents, 'agent')} on this campaign · as of ${clockTime(new Date(response.as_of))}`}
        >
          <div className={styles.bars}>
            {response.metrics.map((info) => (
              <MetricBars key={info.id} info={info} agents={agents} columns={response.agents} cohort={response.cohort.per_metric[info.id]} />
            ))}
          </div>
          <p className={styles.foot}>
            Grey band: the middle half of the team. Line: the team median. Whisker on a rate: its likely range (95%), wide when calls are few.
            Agents under the floor are left out of the band.
          </p>
        </CompareCard>
        <CompareCard title="What stands out" sub={flaggable > 0 ? 'for coaching' : null}>
          <CompareFindings response={response} codes={codes} timezone={timezone} canListen={canListen} onLonger={onLonger} />
        </CompareCard>
      </div>
      <div className={styles.boardEven}>
        <CompareCard
          title={response.trend_metric ? `${infoLabel(response.trend_metric)} per day` : 'Per day'}
          sub={response.trend ? `${plural(response.trend.dates.length, 'day')} · dashed: team median` : null}
        >
          {response.trend && response.trend_metric && response.trend.dates.length > 1 ? (
            <TrendChart trend={response.trend} agents={agents} label={infoLabel(response.trend_metric)} />
          ) : (
            <p className={styles.hint}>
              {response.trend
                ? 'A per-day line needs at least two days. Choose a longer window.'
                : 'No per-day trend chosen. Choose one under Metrics: an outcome set or promises.'}
            </p>
          )}
        </CompareCard>
        <CompareCard title="Where their day went" sub="share of logged-in time, breaks included">
          <DaySplitLegend />
          <DaySplitBars agents={agents} columns={response.agents} />
          <p className={styles.foot}>Waiting for a call depends on the dialler and the list, not the agent, so it is shown but never flagged.</p>
        </CompareCard>
      </div>
      <CompareCard title="The numbers" sub="the table behind every chart">
        <CompareNumbers response={response} agents={agents} />
      </CompareCard>
    </>
  );
}

/** A window in words: "15 Nov to 21 Nov", or "21 Nov" for one day. */
function windowWords(from: string, to: string): string {
  return from === to ? formatReportDay(from, false) : `${formatReportDay(from, false)} to ${formatReportDay(to, false)}`;
}
