import { Link } from 'react-router-dom';
import { RotateCcw } from 'lucide-react';
import type { AsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import type {
  AgencyInsightsHeadline,
  AgencyInsightsReadiness,
  AgencyInsightsRoster,
  AgencyInsightsSummary,
} from '../../../../types/agency-insights';
import type { AgencyAgentState } from '../../../../types/agency';
import { formatCount, pct } from '../../../../utils/format/number';
import { stallCopy, AGENCY_STALL_LABELS, sortStallCodes } from '../../../../utils/agencyHealthStrip';
import {
  abandonmentRate,
  finishedRate,
  insightsRate,
  rateText,
} from '../../../../utils/agency/insights/rates';
import {
  actorName,
  formatZoned,
  longDuration,
  READINESS_LABELS,
  readinessDetail,
  readinessFix,
  secondsSince,
} from '../../../../utils/agency/insights/copy';
import { rosterBucketLink } from '../../../../utils/agency/insights/links';
import { CountLink, Kpi, Panel, rateFigure } from './InsightsParts';
import styles from './Insights.module.css';

/**
 * The status-aware block at the top of the Insights tab: one component per
 * campaign status, each reading its own member of `summary.headline` (the
 * contract guarantees exactly one is non-null) and, for a draft, the readiness
 * checklist. The sections below the headline are the same in every status.
 */

interface HeadlineContext {
  summary: AgencyInsightsSummary;
  now: Date;
  /** Retry is offered (both `agency.supervise` and `agency.campaigns.write`). */
  canRetry: boolean;
  onRetry: () => void;
  /** Agents staffed on the campaign, from the allocation read; null until it answers. */
  staffedAgents: number | null;
}

/** Completed / exhausted / suppressed across the roster, drawn to scale. */
export function RosterProgress({ roster }: { roster: AgencyInsightsRoster }) {
  const suppressed = roster.suppressed_dnc + roster.suppressed_invalid + roster.suppressed_other;
  const share = (n: number) => (roster.total > 0 ? (n / roster.total) * 100 : 0);
  const finished = finishedRate(roster);
  return (
    <div className={styles.progress} data-testid="roster-progress">
      <div
        className={styles.track}
        role="img"
        aria-label={`Completed ${formatCount(roster.completed)}, exhausted ${formatCount(roster.exhausted)}, suppressed ${formatCount(suppressed)}, of ${formatCount(roster.total)} contacts`}
      >
        <div className={`${styles.seg} ${styles.segCompleted}`} style={{ width: `${share(roster.completed)}%` }} />
        <div className={`${styles.seg} ${styles.segExhausted}`} style={{ width: `${share(roster.exhausted)}%` }} />
        <div className={`${styles.seg} ${styles.segSuppressed}`} style={{ width: `${share(suppressed)}%` }} />
      </div>
      <ul className={styles.legend}>
        <li className={styles.legendItem}><span className={`${styles.swatch} ${styles.segCompleted}`} aria-hidden="true" />Completed {formatCount(roster.completed)}</li>
        <li className={styles.legendItem}><span className={`${styles.swatch} ${styles.segExhausted}`} aria-hidden="true" />Exhausted {formatCount(roster.exhausted)}</li>
        <li className={styles.legendItem}><span className={`${styles.swatch} ${styles.segSuppressed}`} aria-hidden="true" />Suppressed {formatCount(suppressed)}</li>
        <li className={styles.legendItem}>{rateText(finished, 'contacts')} of contacts finished</li>
      </ul>
    </div>
  );
}

function RetryButton({ count, canRetry, onRetry }: { count: number; canRetry: boolean; onRetry: () => void }) {
  if (!canRetry || count <= 0) return null;
  return (
    <button type="button" className={`btn-primary ${styles.toolButton}`} onClick={onRetry} data-testid="insights-retry">
      <RotateCcw size={14} aria-hidden="true" />
      {`Create retry campaign (${formatCount(count)})`}
    </button>
  );
}

// ── draft ───────────────────────────────────────────────────────────────────

export function DraftHeadline({
  summary,
  readiness,
}: {
  summary: AgencyInsightsSummary;
  readiness: AsyncResource<AgencyInsightsReadiness | null>;
}) {
  const data = readiness.data;
  const passing = data ? data.checks.filter((c) => c.result === 'pass').length : 0;
  return (
    <Panel
      id="headline"
      title="Ready to launch?"
      sub={data ? `${passing} of ${data.checks.length} checks pass` : undefined}
      testId="headline-draft"
    >
      {!data ? (
        readiness.error
          ? <p className={styles.sectionError} role="alert">{readiness.error}</p>
          : <p className={styles.sectionState}>Checking the campaign…</p>
      ) : (
        <>
          <ul className={styles.checklist}>
            {data.checks.map((check) => {
              const fix = readinessFix(check.code, summary.campaign_id);
              return (
                <li key={check.code} className={styles.check} data-testid={`readiness-${check.code}`} data-result={check.result}>
                  <span className={styles.checkIcon} data-result={check.result} aria-hidden="true">
                    {check.result === 'pass' ? '✓' : check.result === 'fail' ? '✕' : '!'}
                  </span>
                  <div>
                    <span className={styles.checkTitle}>
                      {READINESS_LABELS[check.code]}
                      <span className="sr-only">{check.result === 'pass' ? ' (passes)' : check.result === 'fail' ? ' (fails)' : ' (warning)'}</span>
                    </span>
                    <span className={styles.checkDetail}>{readinessDetail(check, summary.settings.assignment_mode)}</span>
                  </div>
                  {check.result === 'pass' ? <span /> : (
                    <Link to={fix.to} className={styles.fixLink} aria-label={`${fix.label}: ${READINESS_LABELS[check.code]}`}>
                      {fix.label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
          <ul className={styles.callouts}>
            <li className={styles.callout} data-tone={data.ready ? 'ok' : 'bad'}>
              {data.ready
                ? 'Ready to start. Warnings do not block a launch.'
                : 'Fix the failed checks before starting this campaign.'}
            </li>
          </ul>
        </>
      )}
    </Panel>
  );
}

// ── running ─────────────────────────────────────────────────────────────────

const ONLINE_STATES: AgencyAgentState[] = ['available', 'reserved', 'on_call', 'wrapup', 'break'];

export function RunningHeadline({
  summary,
  live,
  now,
  staffedAgents,
}: HeadlineContext & { live: NonNullable<AgencyInsightsHeadline['running']> }) {
  const zone = summary.settings.timezone;
  const byState = live.agents_by_state;
  const online = ONLINE_STATES.reduce((sum, state) => sum + (byState[state] ?? 0), 0);
  const abandonment = abandonmentRate(live.abandonment_rate_24h);
  const ceiling = summary.settings.abandonment_ceiling_pct;
  const abandonTone = abandonment.kind !== 'value' ? undefined : abandonment.pct >= ceiling ? 'bad' : abandonment.pct >= ceiling * 0.8 ? 'warn' : undefined;
  const otherStalls = sortStallCodes(live.other_stalls);
  const ranFor = summary.started_at ? longDuration(secondsSince(summary.started_at, now)) : null;

  return (
    <Panel id="headline" title="Live now" sub={ranFor ? `Running for ${ranFor}` : undefined} testId="headline-running">
      <div className={styles.kpis}>
        <Kpi
          label="Agents online"
          value={staffedAgents !== null ? `${formatCount(online)} of ${formatCount(staffedAgents)}` : formatCount(online)}
          sub={`${formatCount(byState.on_call ?? 0)} on a call · ${formatCount(byState.wrapup ?? 0)} in wrap-up · ${formatCount(byState.break ?? 0)} on break`}
          testId="kpi-agents-online"
        />
        <Kpi
          label="Calls on the line"
          value={formatCount(live.calls_live)}
          sub={live.concurrency_limit === null
            ? `${formatCount(live.concurrency_in_use)} lines in use, no account limit`
            : `Concurrency ${formatCount(live.concurrency_in_use)} of ${formatCount(live.concurrency_limit)}`}
          testId="kpi-calls-live"
        />
        <Kpi
          label="Dial pace"
          value={live.dials_per_hour === null ? '—' : `${formatCount(Math.round(live.dials_per_hour))} / h`}
          withheld={live.dials_per_hour === null}
          sub={live.dials_per_hour === null ? 'No dials yet' : 'Over the last 15 minutes'}
          testId="kpi-dial-pace"
        />
        <Kpi
          label="Time to finish"
          value={live.eta_seconds === null ? 'Not known yet' : `≈ ${longDuration(live.eta_seconds)}`}
          withheld={live.eta_seconds === null}
          sub="At the current pace, inside calling hours"
          testId="kpi-eta"
        />
      </div>
      <RosterProgress roster={summary.roster} />
      <ul className={styles.callouts} aria-label="What is holding dials back">
        {live.stall ? (
          <li className={styles.callout} data-tone="warn" data-testid="headline-stall">
            <strong>{stallCopy(live.stall, (iso) => formatZoned(iso, zone)).headline}</strong>
          </li>
        ) : (
          <li className={styles.callout} data-tone="ok" data-testid="headline-stall">
            <strong>Dialling normally.</strong> Nothing is holding calls back.
          </li>
        )}
        {otherStalls.length > 0 ? (
          <li className={styles.callout} data-tone="warn">Also: {otherStalls.map((code) => AGENCY_STALL_LABELS[code]).join(' · ')}</li>
        ) : null}
        <li className={styles.callout} data-tone={abandonTone} data-testid="headline-abandonment">
          Abandonment over the last 24 hours: <strong>{rateText(abandonment)}</strong> against a {pct(ceiling)} ceiling
        </li>
      </ul>
    </Panel>
  );
}

// ── paused ──────────────────────────────────────────────────────────────────

export function PausedHeadline({
  summary,
  paused,
  now,
}: HeadlineContext & { paused: NonNullable<AgencyInsightsHeadline['paused']> }) {
  const zone = summary.settings.timezone;
  const auto = paused.reason === 'abandonment_ceiling';
  return (
    <Panel id="headline" title="Paused" sub={`Paused for ${longDuration(secondsSince(paused.paused_at, now))}`} testId="headline-paused">
      <div className={styles.kpis}>
        <Kpi
          label="Paused by"
          value={auto ? 'The abandonment guardrail' : actorName(paused.actor)}
          sub={auto
            ? `Abandonment reached ${paused.abandonment_rate_pct_at_pause === null ? 'the ceiling' : pct(paused.abandonment_rate_pct_at_pause)} (ceiling ${pct(summary.settings.abandonment_ceiling_pct)}), ${formatZoned(paused.paused_at, zone)}`
            : `Supervisor pause, ${formatZoned(paused.paused_at, zone)}`}
          testId="kpi-paused-by"
        />
        <Kpi label="Calls still finishing" value={formatCount(paused.calls_finishing)} sub="Live calls run to their end" testId="kpi-calls-finishing" />
        <Kpi
          label="Waiting to resume"
          value={<CountLink to={rosterBucketLink(summary.campaign_id, 'waiting_due_now')} value={paused.waiting_to_resume} label="contacts due now" />}
          sub="Due now"
          testId="kpi-waiting-to-resume"
        />
        <Kpi
          label="Callbacks missed while paused"
          value={formatCount(paused.callbacks_missed_while_paused)}
          sub={paused.callbacks_due_before_window_end > 0
            ? `${formatCount(paused.callbacks_due_before_window_end)} more fall due before today’s calling window ends`
            : undefined}
          testId="kpi-callbacks-missed"
        />
      </div>
      {paused.callbacks_missed_while_paused > 0 ? (
        <ul className={styles.callouts}>
          <li className={styles.callout} data-tone="warn">
            <strong>{`${formatCount(paused.callbacks_missed_while_paused)} ${paused.callbacks_missed_while_paused === 1 ? 'callback has' : 'callbacks have'}`}</strong>
            {' fallen due since the pause. Customers were promised these calls.'}
          </li>
        </ul>
      ) : null}
    </Panel>
  );
}

// ── stopping ────────────────────────────────────────────────────────────────

export function StoppingHeadline({
  summary,
  stopping,
}: HeadlineContext & { stopping: NonNullable<AgencyInsightsHeadline['stopping']> }) {
  return (
    <Panel id="headline" title="Stopping" sub="Waiting for live calls to end" testId="headline-stopping">
      <div className={styles.kpis}>
        <Kpi label="Stopped by" value={actorName(stopping.actor)} sub={formatZoned(stopping.stopped_at, summary.settings.timezone)} testId="kpi-stopped-by" />
        <Kpi label="Calls still finishing" value={formatCount(stopping.calls_finishing)} testId="kpi-calls-finishing" />
      </div>
    </Panel>
  );
}

// ── stopped ─────────────────────────────────────────────────────────────────

export function StoppedHeadline({
  summary,
  stopped,
  canRetry,
  onRetry,
}: HeadlineContext & { stopped: NonNullable<AgencyInsightsHeadline['stopped']> }) {
  const id = summary.campaign_id;
  const neverShare = insightsRate(stopped.never_attempted, summary.roster.total);
  return (
    <Panel
      id="headline"
      title="Stopped"
      sub={`Stopped ${formatZoned(stopped.stopped_at, summary.settings.timezone)} by ${actorName(stopped.actor)} · what was left undone`}
      actions={<RetryButton count={stopped.retry_matched} canRetry={canRetry} onRetry={onRetry} />}
      testId="headline-stopped"
    >
      <div className={styles.kpis}>
        <Kpi label="Pending at stop" value={<CountLink to={rosterBucketLink(id, 'waiting')} value={stopped.pending} label="contacts pending" />} sub="Due, waiting for a retry, or a callback" testId="kpi-pending" />
        <Kpi label="Callbacks scheduled" value={<CountLink to={rosterBucketLink(id, 'waiting_callback')} value={stopped.callbacks_scheduled} label="callbacks scheduled" />} sub="Promised, and now not dialled" testId="kpi-callbacks-scheduled" />
        <Kpi label="Never attempted" value={<CountLink to={rosterBucketLink(id, 'never_attempted')} value={stopped.never_attempted} label="contacts never attempted" />} sub={`${rateText(neverShare, 'contacts')} of the roster`} testId="kpi-never-attempted" />
        <Kpi label="A retry would pick up" value={formatCount(stopped.retry_matched)} sub="No answer, busy, or never reached. Do Not Call and invalid numbers are left out." testId="kpi-retry-matched" />
      </div>
      <RosterProgress roster={summary.roster} />
    </Panel>
  );
}

// ── completed ───────────────────────────────────────────────────────────────

export function CompletedHeadline({
  summary,
  completed,
  canRetry,
  onRetry,
}: HeadlineContext & { completed: NonNullable<AgencyInsightsHeadline['completed']> }) {
  const id = summary.campaign_id;
  const reachedShare = insightsRate(completed.reached, summary.roster.total);
  const success = rateFigure(insightsRate(completed.successes, completed.reached));
  return (
    <Panel
      id="headline"
      title="Completed"
      sub={`Final summary · completed ${formatZoned(completed.completed_at, summary.settings.timezone)}`}
      actions={<RetryButton count={completed.retry_matched} canRetry={canRetry} onRetry={onRetry} />}
      testId="headline-completed"
    >
      <div className={styles.kpis}>
        <Kpi label="Duration" value={longDuration(completed.duration_seconds)} sub="From start to the last call" testId="kpi-duration" />
        <Kpi label="Contacts reached" value={formatCount(completed.reached)} sub={`${rateText(reachedShare, 'contacts')} of the roster`} testId="kpi-reached" />
        <Kpi label="Successes" value={formatCount(completed.successes)} sub={`${success.value} of contacts reached`} testId="kpi-successes" />
        <Kpi label="Not reached" value={formatCount(completed.not_reached)} sub={`${formatCount(completed.retry_matched)} a retry could pick up`} testId="kpi-not-reached" />
        <Kpi label="Do Not Call" value={<CountLink to={rosterBucketLink(id, 'suppressed_dnc')} value={completed.dnc} label="contacts on Do Not Call" />} testId="kpi-dnc" />
      </div>
    </Panel>
  );
}

/** The headline for whichever status the campaign is in. */
export function InsightsHeadline({
  readiness,
  ...context
}: HeadlineContext & { readiness: AsyncResource<AgencyInsightsReadiness | null> }) {
  const { headline } = context.summary;
  if (headline.draft) return <DraftHeadline summary={context.summary} readiness={readiness} />;
  if (headline.running) return <RunningHeadline {...context} live={headline.running} />;
  if (headline.paused) return <PausedHeadline {...context} paused={headline.paused} />;
  if (headline.stopping) return <StoppingHeadline {...context} stopping={headline.stopping} />;
  if (headline.stopped) return <StoppedHeadline {...context} stopped={headline.stopped} />;
  if (headline.completed) return <CompletedHeadline {...context} completed={headline.completed} />;
  return null;
}
