import type { AgencyCompareResponse } from '@magick-agency/contracts/api/agency/compare';
import { DAY_SPLIT_PARTS, wholePercents } from '../../../utils/agency/compare/compareCharts';
import { formatMetricValue, infoLabel } from '../../../utils/agency/compare/compareMetrics';
import { durationWords } from '../../../utils/format/duration';
import { formatCount } from '../../../utils/format/number';
import { agentColour, type ChartAgent } from './CompareCharts';
import styles from './Compare.module.css';

/**
 * The numbers (`docs/compare-agents.md` §2 item 6): the table behind every chart, so each figure
 * is readable as text. A rate shows its counts under it; a figure under the floor says how many
 * it had and needs; the team column is the median of the agents who clear the floor.
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
                  if (!v || v.value === null) {
                    return (
                      <td key={agent.id} className={`${styles.num} ${styles.muted}`}>
                        –
                      </td>
                    );
                  }
                  const counts =
                    unit === 'rate' && v.denominator !== null ? `${formatCount(v.numerator)} of ${formatCount(v.denominator)}` : null;
                  if (!v.reportable) {
                    return (
                      <td key={agent.id} className={`${styles.num} ${styles.muted}`}>
                        too few
                        {v.denominator !== null && info.definition.min_denominator !== null ? (
                          <span className={styles.cellSub}>{`${formatCount(v.denominator)} of ${formatCount(info.definition.min_denominator)} needed`}</span>
                        ) : null}
                      </td>
                    );
                  }
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
