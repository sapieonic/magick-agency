import { Link } from 'react-router-dom';
import { ChevronRight, TriangleAlert } from 'lucide-react';
import { LiveDot } from '@magick-agency/web-ui/components/LiveDot';
import { formatDate } from '@magick-agency/web-ui/format';
import { listWorkedRing } from '../../../utils/agency/overview/pulse';
import { stallCopy } from '../../../utils/agencyHealthStrip';
import { activeCardFigures, concurrencyLine } from '../../../utils/agencyCampaignsHome';
import { AgencyCampaignStatusBadge } from '../AgencyCampaignStatusBadge';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { readyStats, type CardState } from './useActiveCards';
import styles from '../AgencyCampaignsPage.module.css';

/**
 * One active campaign: its status, the health strip's top diagnosis, its calls in progress, who is
 * on its floor, who was reached of the dials placed, what is still waiting to dial, its
 * abandonment over the guardrail's 24 hours against its ceiling, its place in the account's line
 * limit and how much of its list is worked. The numbers are Home's board's (`useActiveCards`).
 */
export function ActiveCampaignCard({ campaign, state }: { campaign: AgencyCampaign; state: CardState }) {
  const stats = readyStats(state);
  const dialing = campaign.status === 'running';
  const stall = stats?.stall ? stallCopy(stats.stall, formatDate) : null;
  const figures = activeCardFigures(stats);
  const worked = listWorkedRing(stats);
  // Its live calls against its share of the account's lines, when other campaigns run too.
  const lines = concurrencyLine(campaign.status, stats?.concurrency);
  const href = `/agency/campaigns/${campaign.id}`;

  return (
    <article className={styles.liveCard} data-testid="active-campaign" aria-labelledby={`campaign-${campaign.id}`}>
      <div className={styles.liveHead}>
        <div className={styles.liveName}>
          <span className={styles.liveTitleRow}>
            <LiveDot live={dialing} color={dialing ? undefined : 'var(--warning)'} />
            <h3 id={`campaign-${campaign.id}`} className={styles.liveHeading}>
              <Link to={href} className={styles.liveTitle}>
                {campaign.name}
              </Link>
            </h3>
          </span>
          <AgencyCampaignStatusBadge status={campaign.status} />
        </div>
        <Link to={href} className={`btn-secondary ${styles.liveOpen}`} aria-label={`Open ${campaign.name}`}>
          Open
          <ChevronRight size={15} aria-hidden="true" />
        </Link>
      </div>

      {/* Not a live region: the headline can carry a count that changes on every
          poll ("5 of 10 lines in use"), and announcing it every ten seconds would
          drown the page. The detail page is where a diagnosis is followed. */}
      {stall && (
        <p className={styles.stall}>
          <TriangleAlert size={15} aria-hidden="true" />
          <span>{stall.headline}</span>
        </p>
      )}

      {state.status === 'error' ? (
        <p className={styles.liveError}>Live numbers didn’t load. Open the campaign to see them.</p>
      ) : (
        <>
          <dl className={styles.metrics}>
            <Metric label="Calls in progress" value={figures.callsLive} />
            <Metric label="Agents on the floor" value={figures.agentsLive} />
            {/* A call being connected to an agent counts as on a call, as on Home's floor. */}
            <Metric label="On a call" value={figures.onCall} />
            <Metric label="Available" value={figures.available} />
            {/* "Reached someone", as on the detail page: `attempts_connected`
                counts answering machines too. A person is `human_connects`. */}
            <Metric label="Reached someone" value={figures.reached} sub={`of ${figures.dials} dials`} />
            <Metric label="Waiting to dial" value={figures.waiting} />
            <Metric
              label="Abandoned (24h)"
              value={figures.abandonment.text}
              sub={figures.abandonment.sub}
              tone={figures.abandonment.level}
            />
          </dl>

          {/* Not a live region either, for the headline's reason above. */}
          {lines && (
            <p className={styles.lines} data-testid="campaign-lines">
              {lines}
            </p>
          )}

          <div className={styles.progress}>
            <div className={styles.progressHead}>
              <span>List worked</span>
              <span className={styles.progressValue}>{worked.label}</span>
            </div>
            <div
              className={styles.progressTrack}
              role="progressbar"
              aria-label="List worked"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={worked.percent === null ? undefined : Math.round(worked.percent)}
              aria-valuetext={worked.known ? undefined : 'Not known yet'}
            >
              <div
                className={`${styles.progressFill} ${dialing ? styles.progressFillLive : ''}`}
                style={{ width: `${Math.min(Math.max(worked.percent ?? 0, 0), 100)}%` }}
              />
            </div>
            <p className={styles.progressCaption}>
              {state.status === 'loading' ? 'Loading live numbers…' : worked.caption}
            </p>
          </div>
        </>
      )}
    </article>
  );
}

function Metric({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string | null;
  tone?: 'near' | 'over' | null;
}) {
  return (
    <div className={styles.metric}>
      <dt className={styles.metricLabel}>{label}</dt>
      <dd className={`${styles.metricValue} ${tone ? styles[`metric_${tone}`] : ''}`} data-tone={tone ?? undefined}>
        {value}
        {sub && <span className={styles.metricSub}>{sub}</span>}
      </dd>
    </div>
  );
}
