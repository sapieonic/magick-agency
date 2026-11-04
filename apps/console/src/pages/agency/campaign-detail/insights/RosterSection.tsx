import type { AgencyInsightsRoster } from '../../../../types/agency-insights';
import { formatCount } from '../../../../utils/format/number';
import {
  averageAttempts,
  completionRate,
  insightsRate,
  penetrationRate,
  rateText,
} from '../../../../utils/agency/insights/rates';
import { rosterBucketLink, type RosterBucket } from '../../../../utils/agency/insights/links';
import { toCsv } from '../../../../utils/agency/insights/csv';
import { insightsCsvFilename } from '../../../../utils/agency/insights/csv';
import { CountLink, CsvButton, Kpi, Panel, rateFigure, ReconciliationChips } from './InsightsParts';
import styles from './Insights.module.css';

export interface FunnelRow {
  bucket: RosterBucket;
  label: string;
  count: number;
  /** A part of the row above it. */
  indent: boolean;
}

/**
 * The full state funnel, as of now. The un-indented rows partition the roster
 * (waiting + on a call + in wrap-up + completed + exhausted + suppressed =
 * total, the server's `contact_states_vs_total` check); the indented rows split
 * the row above them.
 */
export function rosterFunnel(roster: AgencyInsightsRoster): FunnelRow[] {
  const waiting = roster.waiting_due_now + roster.waiting_retry + roster.waiting_callback;
  const suppressed = roster.suppressed_dnc + roster.suppressed_invalid + roster.suppressed_other;
  return [
    { bucket: 'waiting', label: 'Waiting', count: waiting, indent: false },
    { bucket: 'waiting_due_now', label: 'Due now', count: roster.waiting_due_now, indent: true },
    { bucket: 'waiting_retry', label: 'Waiting for retry time', count: roster.waiting_retry, indent: true },
    { bucket: 'waiting_callback', label: 'Callback scheduled', count: roster.waiting_callback, indent: true },
    { bucket: 'on_call', label: 'On a call', count: roster.on_call, indent: false },
    { bucket: 'in_wrapup', label: 'In wrap-up', count: roster.in_wrapup, indent: false },
    { bucket: 'completed', label: 'Completed', count: roster.completed, indent: false },
    { bucket: 'exhausted', label: 'Exhausted', count: roster.exhausted, indent: false },
    { bucket: 'suppressed', label: 'Suppressed', count: suppressed, indent: false },
    { bucket: 'suppressed_dnc', label: 'Do Not Call', count: roster.suppressed_dnc, indent: true },
    { bucket: 'suppressed_invalid', label: 'Invalid number', count: roster.suppressed_invalid, indent: true },
    { bucket: 'suppressed_other', label: 'Attempt limit or manual', count: roster.suppressed_other, indent: true },
  ];
}

/** Attempts per contact as shares of the attempted contacts (decision IN6: every dial). */
export function attemptsShares(roster: AgencyInsightsRoster): Array<{ label: string; count: number; share: string }> {
  const { one, two, three, four_plus } = roster.attempts_per_contact;
  return [
    ['1', one],
    ['2', two],
    ['3', three],
    ['4+', four_plus],
  ].map(([label, count]) => ({
    label: label as string,
    count: count as number,
    share: rateText(insightsRate(count as number, roster.attempted), 'contacts'),
  }));
}

export function RosterSection({
  campaignId,
  campaignName,
  roster,
}: {
  campaignId: string;
  campaignName: string;
  roster: AgencyInsightsRoster;
}) {
  const funnel = rosterFunnel(roster);
  const penetration = rateFigure(penetrationRate(roster), 'contacts');
  const completion = rateFigure(completionRate(roster), 'contacts');
  const avg = averageAttempts(roster);
  const shares = attemptsShares(roster);

  return (
    <Panel
      id="roster"
      title="Roster and progress"
      sub={`${formatCount(roster.total)} contacts · as of now`}
      actions={
        <CsvButton
          filename={insightsCsvFilename(campaignName, 'roster', campaignId)}
          build={() =>
            toCsv(
              ['State', 'Part of', 'Contacts'],
              [
                ...funnel.map((row) => [row.label, row.indent ? parentOf(funnel, row) : '', row.count]),
                ['Total', '', roster.total],
                ['Attempted at least once', '', roster.attempted],
                ...shares.map((s) => [`Attempted ${s.label} times`, 'Attempted at least once', s.count]),
                ['Dials placed', '', roster.dials_placed],
              ],
            )
          }
        />
      }
    >
      <div className={styles.kpis}>
        <Kpi
          label="Penetration"
          value={penetration.value}
          withheld={penetration.withheld}
          sub={<><CountLink to={rosterBucketLink(campaignId, 'attempted')} value={roster.attempted} label="contacts attempted" /> attempted at least once</>}
          testId="kpi-penetration"
        />
        <Kpi
          label="Completion"
          value={completion.value}
          withheld={completion.withheld}
          sub={<><CountLink to={rosterBucketLink(campaignId, 'completed')} value={roster.completed} label="contacts completed" /> completed</>}
          testId="kpi-completion"
        />
        <Kpi
          label="Average attempts per contact"
          value={avg === null ? '—' : avg.toFixed(1)}
          withheld={avg === null}
          sub={shares.map((s) => `${s.label}: ${s.share}`).join(' · ')}
          testId="kpi-attempts-per-contact"
        />
      </div>

      <ul className={styles.funnel} aria-label="Where the contacts stand">
        {funnel.map((row) => (
          <li key={row.bucket} className={styles.funnelRow} data-indent={String(row.indent)} data-testid={`funnel-${row.bucket}`}>
            <span className={styles.funnelLabel}>{row.label}</span>
            <span className={styles.funnelBar} aria-hidden="true">
              <span
                className={styles.funnelFill}
                style={{ display: 'block', width: `${roster.total > 0 ? (row.count / roster.total) * 100 : 0}%` }}
              />
            </span>
            <span className={styles.funnelValue}>
              <CountLink to={rosterBucketLink(campaignId, row.bucket)} value={row.count} label={`contacts: ${row.label}`} />
            </span>
          </li>
        ))}
      </ul>

      <ReconciliationChips checks={roster.reconciliation} />
    </Panel>
  );
}

function parentOf(funnel: FunnelRow[], row: FunnelRow): string {
  const index = funnel.indexOf(row);
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = funnel[i];
    if (candidate && !candidate.indent) return candidate.label;
  }
  return '';
}
