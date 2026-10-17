import { Link } from 'react-router-dom';
import { ChevronRight, TriangleAlert } from 'lucide-react';
import { LiveDot } from '@magick-agency/web-ui/components/LiveDot';
import { formatDate } from '@magick-agency/web-ui/format';
import { listWorkedRing } from '../../../utils/agencyCampaignOverview';
import { stallCopy } from '../../../utils/agencyHealthStrip';
import { formatCount } from '../../../utils/format/number';
import { AgencyCampaignStatusBadge } from '../AgencyCampaignStatusBadge';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { readyStats, type StatsState } from './useCampaignsHome';
import styles from '../AgencyCampaignsPage.module.css';

function figure(value: number | undefined): string {
  return typeof value === 'number' ? formatCount(value) : '—';
}

export function ActiveCampaignCard({ campaign, state }: { campaign: AgencyCampaign; state: StatsState }) {
  const stats = readyStats(state);
  const dialing = campaign.status === 'running';
  const worked = listWorkedRing(stats);
  const stall = stats?.stall ? stallCopy(stats.stall, formatDate) : null;
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
            <Metric label="Calls in progress" value={figure(stats?.attempts_live)} />
            <Metric label="Agents on the floor" value={figure(stats?.agents_live)} />
            {/* "Reached someone", as on the detail page: `attempts_connected`
                counts answering machines too. A person is `human_connects`. */}
            <Metric
              label="Reached someone"
              value={figure(stats?.attempts_connected)}
              sub={`of ${figure(stats?.attempts_total)} dials`}
            />
            <Metric label="Waiting to dial" value={figure(stats?.contacts_pending)} />
          </dl>

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

function Metric({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className={styles.metric}>
      <dt className={styles.metricLabel}>{label}</dt>
      <dd className={styles.metricValue}>
        {value}
        {sub && <span className={styles.metricSub}>{sub}</span>}
      </dd>
    </div>
  );
}
