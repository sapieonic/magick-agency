import { useCallback } from 'react';
import { Link } from 'react-router-dom';
import { useAsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { useTenant } from '../../../../contexts/TenantContext';
import { getInsightsSummary, getInsightsUploads } from '../../../../api/agencyInsights';
import type { AgencyInsightsSummary, AgencyInsightsTransition, AgencyInsightsUploads } from '../../../../types/agency-insights';
import { formatCount } from '../../../../utils/format/number';
import { actorName, ASSIGNMENT_MODE_LABELS, formatZoned } from '../../../../utils/agency/insights/copy';
import { Panel, SectionBody } from './InsightsParts';
import { UploadsSection } from './UploadsSection';
import styles from './Insights.module.css';
import { carrierPauseCopy } from '../../../../utils/agencyCarriers';

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
  parts.push(`duplicates checked on ${summary.dedupe_columns.length > 0 ? summary.dedupe_columns.join(' + ') : 'phone'}`);
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

/**
 * Every lifecycle transition, oldest first. On the Settings tab since IN13: the
 * settings themselves are the form above it, so the panel that repeated them on
 * Insights is gone, and what it carried besides them lives here.
 */
export function LifecyclePanel({ summary }: { summary: AgencyInsightsSummary }) {
  const zone = summary.settings.timezone;
  return (
    <Panel id="lifecycle" title="Lifecycle">
      <CampaignMeta summary={summary} />
      {summary.transitions.length > 0 ? (
        <ol className={styles.callouts} data-testid="insights-transitions">
          {summary.transitions.map((t) => (
            <li key={`${t.to_status}-${t.at}`} className={styles.callout}>
              {`${STATUS_WORDS[t.to_status] ?? t.to_status} ${formatZoned(t.at, zone)} ${transitionBy(t)}`}
            </li>
          ))}
        </ol>
      ) : (
        <p className={styles.muted}>Not started yet.</p>
      )}
    </Panel>
  );
}

/** Who or what made a lifecycle transition, as the end of "Paused 7 Nov, 10:00 …". */
function transitionBy(t: AgencyInsightsTransition): string {
  if (t.reason === 'abandonment_ceiling') return 'by the abandonment guardrail';
  // Nobody pressed Pause: the campaign's carrier account could not dial (refused by the
  // carrier, or no longer active). Every such reason has its copy in `CARRIER_PAUSE_COPY`.
  const carrier = carrierPauseCopy(t.reason);
  if (carrier) return `automatically: ${carrier.cause}. ${carrier.action}`;
  return `by ${actorName(t.actor, 'the dialler')}`;
}

/**
 * The Settings tab's history half: the lifecycle and the upload history. Read
 * once on arrival, never polled: neither moves while the form is being edited.
 * The caller mounts it for `agency.supervise` only, the floor of both reads.
 */
export function CampaignHistory({ campaignId }: { campaignId: string }) {
  const { tenantId, accountId } = useTenant();
  const ready = Boolean(tenantId && accountId);
  const t = tenantId ?? undefined;
  const a = accountId ?? undefined;
  const fetchSummary = useCallback(() => getInsightsSummary(campaignId, t, a), [campaignId, t, a]);
  const fetchUploads = useCallback(() => getInsightsUploads(campaignId, t, a), [campaignId, t, a]);
  const summary = useAsyncResource<AgencyInsightsSummary | null>(fetchSummary, {
    initialData: null,
    enabled: ready,
    errorMessage: 'Could not load the lifecycle.',
  });
  const uploads = useAsyncResource<AgencyInsightsUploads | null>(fetchUploads, {
    initialData: null,
    enabled: ready,
    errorMessage: 'Could not load the upload history.',
  });
  const zone = summary.data?.settings.timezone ?? null;

  return (
    <div className={styles.root} data-testid="campaign-history">
      {summary.data ? (
        <LifecyclePanel summary={summary.data} />
      ) : (
        <Panel id="lifecycle" title="Lifecycle">
          <SectionBody resource={summary}>{() => null}</SectionBody>
        </Panel>
      )}
      {uploads.data && summary.data && zone ? (
        <UploadsSection
          campaignId={campaignId}
          campaignName={summary.data.name}
          uploads={uploads.data}
          timezone={zone}
          tenantId={tenantId}
          accountId={accountId}
        />
      ) : (
        <Panel id="uploads" title="Upload history">
          {/* The table needs the campaign's name and zone too, so a summary that failed says so here. */}
          {/* Two elements, not one with a chosen resource: the two reads have different types. */}
          {uploads.data ? <SectionBody resource={summary}>{() => null}</SectionBody> : <SectionBody resource={uploads}>{() => null}</SectionBody>}
        </Panel>
      )}
    </div>
  );
}
