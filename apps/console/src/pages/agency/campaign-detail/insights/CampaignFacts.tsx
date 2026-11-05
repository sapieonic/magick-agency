import { Link } from 'react-router-dom';
import type { AgencyInsightsSummary } from '../../../../types/agency-insights';
import { formatCount, pct } from '../../../../utils/format/number';
import { describeIsoDays, hhmm } from '../../../../utils/format/weekdays';
import { actorName, ASSIGNMENT_MODE_LABELS, formatZoned } from '../../../../utils/agency/insights/copy';
import { settingsLink } from '../../../../utils/agency/insights/links';
import { Panel } from './InsightsParts';
import styles from './Insights.module.css';

const STATUS_WORDS: Record<string, string> = {
  draft: 'Created',
  running: 'Started',
  paused: 'Paused',
  stopping: 'Stop pressed',
  stopped: 'Stopped',
  completed: 'Completed',
};

/** The line under the range bar: account, who made it, assignment, duplicate column, lineage. */
export function CampaignMeta({ summary }: { summary: AgencyInsightsSummary }) {
  const zone = summary.settings.timezone;
  const parts: string[] = [`Account ${summary.account.name ?? summary.account.id}`];
  parts.push(
    summary.created_by
      ? `created by ${actorName(summary.created_by)} on ${formatZoned(summary.created_at, zone)}`
      : `created ${formatZoned(summary.created_at, zone)}`,
  );
  parts.push(`assignment ${ASSIGNMENT_MODE_LABELS[summary.settings.assignment_mode].toLowerCase()}`);
  parts.push(`duplicates checked on ${summary.dedupe_column ?? 'phone'}`);
  return (
    <p className={styles.muted} data-testid="insights-meta">
      {parts.join(' · ')}
      {summary.parent_campaign ? (
        <>
          {' · retry of '}
          <Link to={`/agency/campaigns/${encodeURIComponent(summary.parent_campaign.id)}`}>{summary.parent_campaign.name}</Link>
        </>
      ) : null}
      {summary.child_campaigns.length > 0 ? ` · retried ${formatCount(summary.child_campaigns.length)} ${summary.child_campaigns.length === 1 ? 'time' : 'times'}` : ''}
    </p>
  );
}

/** The settings the numbers were produced under, and every lifecycle transition. */
export function CampaignSettingsPanel({ summary }: { summary: AgencyInsightsSummary }) {
  const s = summary.settings;
  const zone = s.timezone;
  const rows: Array<[string, string]> = [
    ['Calling hours', `${hhmm(s.calling_window_start)}–${hhmm(s.calling_window_end)}, ${describeIsoDays(s.calling_days) ?? 'no days'}${s.calling_hours_default ? ' (the default)' : ''}`],
    ['Time zone', zone],
    ['Caller IDs', s.caller_ids.length ? s.caller_ids.join(', ') : 'None'],
    ['Attempts per contact', formatCount(s.max_attempts)],
    ['Wrap-up', s.wrapup_seconds === null ? 'No limit' : `${formatCount(s.wrapup_seconds)} s${s.wrapup_auto_return ? ', then back to available' : ''}`],
    ['Wrap-up redial', s.allow_wrapup_redial ? `On, up to ${formatCount(s.wrapup_redial_limit)} per call` : 'Off'],
    ['Agent retry', s.allow_agent_retry ? `On, ${formatCount(s.agent_retry_rounds)} rounds, ${formatCount(s.agent_retry_cooldown_minutes)} min apart` : 'Off'],
    ['Outcome overrides', s.override_outcomes.length ? s.override_outcomes.map((o) => o.label).join(', ') : 'None'],
    ['Recording', s.record_calls ? 'On' : 'Off'],
    ['Call analysis', s.analysis_profile ? (s.analysis_profile.name ?? 'On') : 'Off'],
    ['Abandonment ceiling', pct(s.abandonment_ceiling_pct)],
    ['Assignment', ASSIGNMENT_MODE_LABELS[s.assignment_mode]],
  ];
  return (
    <Panel id="settings" title="Settings and lifecycle" sub="What these numbers were produced under" actions={<Link to={settingsLink(summary.campaign_id)} className={styles.fixLink}>Edit settings</Link>}>
      <dl className={styles.kpis} style={{ margin: 0 }}>
        {rows.map(([label, value]) => (
          <div key={label} className={styles.kpi}>
            <dt className={styles.kpiLabel}>{label}</dt>
            <dd className={styles.kpiSub} style={{ margin: 0 }}>{value}</dd>
          </div>
        ))}
      </dl>
      {summary.transitions.length > 0 ? (
        <>
          <h4 className={styles.subTitle}>Lifecycle</h4>
          <ol className={styles.callouts} data-testid="insights-transitions">
            {summary.transitions.map((t) => (
              <li key={`${t.to_status}-${t.at}`} className={styles.callout}>
                {`${STATUS_WORDS[t.to_status] ?? t.to_status} ${formatZoned(t.at, zone)} by ${t.reason === 'abandonment_ceiling' ? 'the abandonment guardrail' : actorName(t.actor, 'the dialler')}`}
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </Panel>
  );
}
