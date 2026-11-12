import { Link } from 'react-router-dom';
import { ChevronRight, TriangleAlert } from 'lucide-react';
import { LiveDot } from '@magick-agency/web-ui/components/LiveDot';
import { formatDate } from '@magick-agency/web-ui/format';
import { stallCopy } from '../../../utils/agencyHealthStrip';
import { activeCardFigures } from '../../../utils/agencyCampaignsHome';
import { AgencyCampaignStatusBadge } from '../AgencyCampaignStatusBadge';
import type { AgencyCampaign } from '../../../types/agency-campaign';
import { readyStats, type CardState } from './useActiveCards';
import styles from '../AgencyCampaignsPage.module.css';

/**
 * One active campaign: its status, the health strip's top diagnosis, who is on its floor and its
 * abandonment over the guardrail's 24 hours against its ceiling. The numbers are Home's board's
 * (`useActiveCards`); a campaign's calls, dials and progress are on its own page, one click away.
 */
export function ActiveCampaignCard({ campaign, state }: { campaign: AgencyCampaign; state: CardState }) {
  const stats = readyStats(state);
  const dialing = campaign.status === 'running';
  const stall = stats?.stall ? stallCopy(stats.stall, formatDate) : null;
  const figures = activeCardFigures(stats);
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
            <Metric label="Agents on the floor" value={figures.agentsLive} />
            {/* A call being connected to an agent counts as on a call, as on Home's floor. */}
            <Metric label="On a call" value={figures.onCall} />
            <Metric label="Available" value={figures.available} />
            <Metric
              label="Abandoned (24h)"
              value={figures.abandonment.text}
              sub={figures.abandonment.sub}
              tone={figures.abandonment.level}
            />
          </dl>
          {state.status === 'loading' && <p className={styles.liveNote}>Loading live numbers…</p>}
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
