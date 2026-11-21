import type { AgencyCompareResponse } from '@magick-agency/contracts/api/agency/compare';
import { DAY_SPLIT_PARTS, wholePercents } from '../../../utils/agency/compare/compareCharts';
import type { AgencyCompareMetricInfo } from '@magick-agency/contracts/api/agency/compare';
import {
  COUNTS_DISAGREE_SHORT,
  NONE_DUE_WORDS,
  NO_LOGGED_IN_WORDS,
  formatMetricValue,
  infoLabel,
  withheldKind,
  type WithheldKind,
} from '../../../utils/agency/compare/compareMetrics';
import { durationWords } from '../../../utils/format/duration';
import { formatCount } from '../../../utils/format/number';
import { agentColour, type ChartAgent } from './CompareCharts';
import styles from './Compare.module.css';

/**
 * A withheld figure's cell (`withheldKind`, the server's reason, the one the chart words too):
 * "None due yet", "too few" with how many it had and needs, "not shown" with "counts don’t agree",
 * "No logged-in time".
 */
const WITHHELD_CELL: Readonly<Record<WithheldKind, string>> = {
  none_due: NONE_DUE_WORDS,
  too_few: 'too few',
  counts_disagree: 'not shown',
  no_logged_in_time: NO_LOGGED_IN_WORDS,
};

/** The line under a withheld cell: what too few had and needs, or why it is not shown. */
function withheldCellSub(withheld: WithheldKind, info: AgencyCompareMetricInfo, denominator: number | null) {
  if (withheld === 'counts_disagree') return <span className={styles.cellSub}>{COUNTS_DISAGREE_SHORT.toLowerCase()}</span>;
  if (withheld === 'too_few' && denominator !== null && info.definition.min_denominator !== null) {
    return <span className={styles.cellSub}>{`${formatCount(denominator)} of ${formatCount(info.definition.min_denominator)} needed`}</span>;
  }
  return null;
}

/**
 * The numbers (`docs/compare-agents.md` §2 item 6): the table behind every chart, so each figure
 * is readable as text. A rate shows its counts under it; a withheld figure says why, as the chart
 * does ({@link WITHHELD_CELL}); the team column is the median of the agents who clear the floor.
 */
export function CompareNumbers({ response, agents }: { response: AgencyCompareResponse; agents: readonly ChartAgent[] }) {
  const columns = agents.map((a) => ({ agent: a, column: response.agents.find((c) => c.agent_user_id === a.id) }));
  return (
    <div className={styles.tableWrap}>
      <table className={styles.numbers} data-testid="compare-numbers">
        <caption className={styles.srOnly}>Every figure on this page, by agent, with the team median</caption>
        <thead>
          <tr>
            <th scope="col">Metric</th>
            {columns.map(({ agent }) => (
              <th key={agent.id} scope="col" className={styles.num}>
                <span className={`${styles.swatch} ${styles.swatchGap}`} style={{ background: agentColour(agent.slot) }} aria-hidden="true" />
                {agent.name}
              </th>
            ))}
            <th scope="col" className={styles.num}>
              Team median
            </th>
          </tr>
        </thead>
        <tbody>
          {response.metrics.map((info) => {
            const unit = info.definition.unit;
            const cohort = response.cohort.per_metric[info.id];
            return (
              <tr key={info.id}>
                <th scope="row">{infoLabel(info)}</th>
                {columns.map(({ agent, column }) => {
                  const v = column?.values[info.id];
                  if (!v || (v.reportable && v.value === null)) {
                    return (
                      <td key={agent.id} className={`${styles.num} ${styles.muted}`}>
                        –
                      </td>
                    );
                  }
                  if (!v.reportable) {
                    // The chart's reason in the table's few words: the same reason, never a dash.
                    const withheld = withheldKind(info, v);
                    return (
                      <td key={agent.id} className={`${styles.num} ${styles.muted}`}>
                        {WITHHELD_CELL[withheld]}
                        {withheldCellSub(withheld, info, v.denominator)}
                      </td>
                    );
                  }
                  const counts =
                    unit === 'rate' && v.denominator !== null ? `${formatCount(v.numerator)} of ${formatCount(v.denominator)}` : null;
                  return (
                    <td key={agent.id} className={styles.num}>
                      {formatMetricValue(unit, v.value)}
                      {counts ? <span className={styles.cellSub}>{counts}</span> : null}
                    </td>
                  );
                })}
                <td className={`${styles.num} ${styles.muted}`}>{formatMetricValue(unit, cohort?.median ?? null)}</td>
              </tr>
            );
          })}
          <tr className={styles.group}>
            <td colSpan={columns.length + 2}>Where their day went</td>
          </tr>
          <tr>
            <th scope="row">Logged in</th>
            {columns.map(({ agent, column }) => (
              <td key={agent.id} className={styles.num}>
                {column ? durationWords(column.day_split.shift_seconds) : '–'}
              </td>
            ))}
            <td className={`${styles.num} ${styles.muted}`}>–</td>
          </tr>
          {DAY_SPLIT_PARTS.map((part, partIndex) => (
            <tr key={part.key}>
              <th scope="row">{part.label}</th>
              {columns.map(({ agent, column }) => {
                if (!column || column.day_split.shift_seconds <= 0) {
                  return (
                    <td key={agent.id} className={`${styles.num} ${styles.muted}`}>
                      –
                    </td>
                  );
                }
                const percents = wholePercents(DAY_SPLIT_PARTS.map((p) => column.day_split[p.key]));
                return (
                  <td key={agent.id} className={styles.num}>
                    {`${percents[partIndex]}%`}
                    <span className={styles.cellSub}>{durationWords(column.day_split[part.key])}</span>
                  </td>
                );
              })}
              <td className={`${styles.num} ${styles.muted}`}>–</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
