import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Printer, RefreshCw } from 'lucide-react';
import type { AsyncResource } from '@magick-agency/web-ui/hooks/useAsyncResource';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useTenant } from '../../../../contexts/TenantContext';
import { useAfterFirstPaint, useInsightsLive, useInsightsRange } from '../../../../hooks/useCampaignInsights';
import { formatClockTime } from '../../../../utils/format/date';
import { rangeFreshness } from '../../../../utils/agency/insights/copy';
import {
  allowedBuckets,
  defaultBucket,
  INSIGHTS_RANGE_PRESETS,
  insightsRangeQuery,
  rangeChoiceFromParams,
  rangeChoiceKey,
  rangeChoiceToParams,
  resolveInsightsRange,
  zoneDay,
  type InsightsRangeChoice,
} from '../../../../utils/agency/insights/range';
import type { AgencyInsightsBucket } from '../../../../types/agency-insights';
import { InsightsHeadline } from './InsightsHeadline';
import { RosterSection } from './RosterSection';
import { AllocationSection } from './AllocationSection';
import { CallbacksSection, CallsSection, OverridesSection, type RangeSectionContext } from './ActivitySections';
import { AgentsSection } from './AgentsSection';
import { TrendsSection } from './TrendsSection';
import { HealthSection, RecordingSection } from './HealthSection';
import { UploadsSection } from './UploadsSection';
import { CampaignMeta, CampaignSettingsPanel } from './CampaignFacts';
import { Panel, SectionBody } from './InsightsParts';
import styles from './Insights.module.css';

interface InsightsPanelProps {
  campaignId: string;
  /** Both `agency.supervise` and `agency.campaigns.write`: the retry button in the headline. */
  canRetry: boolean;
  onRetry: () => void;
  /** Bumped by the shell's own Refresh control. */
  refreshToken: number;
  /** The shell's view of the status: a lifecycle action there re-reads the summary here. */
  shellStatus: string;
}

/**
 * The campaign's Insights tab (decision IN1): one analytic surface in every
 * status. The as-of-now reads paint first; the range reads load after that
 * paint (`useAfterFirstPaint`) and only reload on a range change or Refresh.
 * See `useCampaignInsights` for the refresh rules and `range.ts` for the range.
 */
export function InsightsPanel({ campaignId, canRetry, onRetry, refreshToken, shellStatus }: InsightsPanelProps) {
  const { tenantId, accountId } = useTenant();
  const live = useInsightsLive(campaignId);
  const summary = live.summary.data;
  const timezone = summary?.settings.timezone ?? null;

  // ── Range, in the URL ──────────────────────────────────────────────────
  const [searchParams, setSearchParams] = useSearchParams();
  const choice = rangeChoiceFromParams(searchParams);
  const choiceKey = rangeChoiceKey(choice);
  /** When the range's clock was read: on a range change and on Refresh, never per render. */
  const [rangeNow, setRangeNow] = useState(() => new Date());
  const range = useMemo(
    () => (timezone === null ? null : resolveInsightsRange(choice, timezone, rangeNow)),
    // `choice` is rebuilt from the URL each render; its key is its identity.
    [choiceKey, timezone, rangeNow],
  );
  const setChoice = useCallback(
    (next: InsightsRangeChoice) => {
      setRangeNow(new Date());
      setSearchParams((prev) => rangeChoiceToParams(next, prev), { replace: false });
    },
    [setSearchParams],
  );

  const [draftFrom, setDraftFrom] = useState(choice.fromDay ?? '');
  const [draftTo, setDraftTo] = useState(choice.toDay ?? '');
  const [customOpen, setCustomOpen] = useState(choice.preset === 'custom');

  // ── Bucket ─────────────────────────────────────────────────────────────
  // The server's lifetime starts at `created_at` (its default `from`), so the bucket choices do too.
  const lifetimeStart = summary?.created_at ?? null;
  const bucketOptions = range ? allowedBuckets(range, lifetimeStart, rangeNow) : (['day'] as AgencyInsightsBucket[]);
  const [chosenBucket, setChosenBucket] = useState<AgencyInsightsBucket | null>(null);
  const bucket = chosenBucket && bucketOptions.includes(chosenBucket)
    ? chosenBucket
    : range ? defaultBucket(range, lifetimeStart, rangeNow) : 'day';

  // ── Lazy range sections, Refresh and Print ─────────────────────────────
  const [printRequested, setPrintRequested] = useState(false);
  const active = useAfterFirstPaint(summary !== null, printRequested);
  const [rangeToken, setRangeToken] = useState(0);
  const rangeData = useInsightsRange(campaignId, range, bucket, active, rangeToken);

  /**
   * What a screen reader is told after a Refresh. The visible stamp is NOT a
   * live region: it changes on every 10 s poll, and a region that speaks every
   * ten seconds is one a reader turns off (the shell's header stamp is quiet
   * for the same reason). A refresh the reader asked for is worth confirming.
   */
  const [announcement, setAnnouncement] = useState('');
  const refreshLive = live.refresh;
  const refresh = useCallback(() => {
    setRangeNow(new Date());
    setRangeToken((n) => n + 1);
    void refreshLive().then(() => setAnnouncement(`Insights updated at ${formatClockTime(new Date())}`));
  }, [refreshLive]);

  // The shell's Refresh reloads every section too (skipping the first render).
  const lastShellToken = useRef(refreshToken);
  useEffect(() => {
    if (lastShellToken.current === refreshToken) return;
    lastShellToken.current = refreshToken;
    refresh();
  }, [refreshToken, refresh]);

  // A Start / Pause / Stop in the shell changes the headline: re-read the as-of-now half.
  const lastShellStatus = useRef(shellStatus);
  useEffect(() => {
    if (lastShellStatus.current === shellStatus) return;
    lastShellStatus.current = shellStatus;
    void refreshLive();
  }, [shellStatus, refreshLive]);

  // Print once every section has loaded and painted.
  useEffect(() => {
    if (!printRequested || !active || !summary) return;
    if (range && !range.error && rangeData.loading) return;
    setPrintRequested(false);
    window.print();
  }, [printRequested, active, summary, range, rangeData.loading]);

  // ── Names ──────────────────────────────────────────────────────────────
  const allocation = live.allocation.data;
  const activity = rangeData.activity.data;
  const names = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of allocation?.agents ?? []) if (row.agent_name) map.set(row.agent_user_id, row.agent_name);
    for (const row of activity?.agents ?? []) if (row.agent_user_id && row.agent_name) map.set(row.agent_user_id, row.agent_name);
    return map;
  }, [allocation, activity]);
  const agentName = useCallback(
    (id: string | null) => (id === null ? 'Unassigned' : names.get(id) ?? 'Unknown agent'),
    [names],
  );

  if (!summary) {
    if (live.summary.error) return <ErrorAlert message={live.summary.error} onRetry={() => void live.summary.reload()} />;
    return <LoadingSpinner />;
  }

  const now = new Date();
  const ctx: RangeSectionContext = {
    campaignId,
    campaignName: summary.name,
    range: range ? insightsRangeQuery(range) : {},
    rangeLabel: range?.label ?? 'Lifetime',
    agentName,
  };
  const staffedAgents = allocation ? allocation.agents.filter((a) => a.staffed).length : null;
  const zone = range?.timezone ?? summary.settings.timezone;
  const today = zoneDay(zone, now);
  /** A custom range that cannot be sent leaves the range sections saying so, not loading forever. */
  const blocked = range?.error ? 'Choose a valid range to see these figures.' : null;
  const freshness = blocked ? null : rangeFreshness(activity, zone);

  return (
    <section className={styles.root} aria-label="Campaign insights" data-testid="insights-panel">
      <div className={styles.toolbar}>
        <div className={styles.rangeGroup}>
          <div className={styles.segmented} role="group" aria-label="Time range">
            {INSIGHTS_RANGE_PRESETS.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={styles.segment}
                aria-pressed={choice.preset === preset.id}
                onClick={() => {
                  setCustomOpen(false);
                  setChoice({ preset: preset.id });
                }}
              >
                {preset.label}
              </button>
            ))}
            <button
              type="button"
              className={styles.segment}
              aria-pressed={choice.preset === 'custom' || customOpen}
              aria-expanded={customOpen}
              onClick={() => setCustomOpen(true)}
            >
              Custom
            </button>
          </div>
          {customOpen ? (
            <form
              className={styles.customRange}
              onSubmit={(e) => {
                e.preventDefault();
                setChoice({ preset: 'custom', fromDay: draftFrom, toDay: draftTo });
              }}
            >
              <label>
                From{' '}
                <input type="date" className={styles.dateInput} value={draftFrom} max={today} onChange={(e) => setDraftFrom(e.target.value)} />
              </label>
              <label>
                To{' '}
                <input type="date" className={styles.dateInput} value={draftTo} max={today} onChange={(e) => setDraftTo(e.target.value)} />
              </label>
              <button type="submit" className={`btn-secondary ${styles.toolButton}`} disabled={!draftFrom || !draftTo}>Apply</button>
            </form>
          ) : null}
        </div>
        <div className={styles.toolbarRight}>
          <p className="sr-only" aria-live="polite" aria-atomic="true" data-testid="insights-announcement">{announcement}</p>
          <p className={styles.stamp} data-testid="insights-updated">
            {live.lastUpdatedAt ? `Updated ${formatClockTime(live.lastUpdatedAt)}` : 'Loading…'}
            {live.polling ? ' · auto-refreshing' : ' · not refreshing'}
          </p>
          <button type="button" className={`btn-secondary ${styles.toolButton}`} onClick={refresh} aria-label="Refresh insights">
            <RefreshCw size={14} aria-hidden="true" />
            Refresh
          </button>
          <button type="button" className={`btn-secondary ${styles.toolButton}`} onClick={() => setPrintRequested(true)} disabled={printRequested}>
            <Printer size={14} aria-hidden="true" />
            {printRequested ? 'Preparing…' : 'Print'}
          </button>
        </div>
      </div>
      <p className={styles.rangeNote}>
        {`Times in ${zone}${range?.zoneFallback ? ' (the campaign’s time zone is not recognised)' : ''} · roster and allocation are as of now; calls, agents, trends and health follow the range (${range?.label ?? 'Lifetime'}).`}
      </p>
      {range?.error ? <p className={styles.rangeError} role="alert">{range.error}</p> : null}
      {freshness ? <p className={styles.rangeNote} data-testid="insights-freshness">{freshness}</p> : null}

      <CampaignMeta summary={summary} />

      <InsightsHeadline
        summary={summary}
        readiness={live.readiness}
        now={now}
        canRetry={canRetry}
        onRetry={onRetry}
        staffedAgents={staffedAgents}
      />

      <div className={styles.grid2}>
        <RosterSection campaignId={campaignId} campaignName={summary.name} roster={summary.roster} />
        <RangePanel id="calls" title="Calls and outcomes" resource={rangeData.activity} blocked={blocked}>
          {(data) => <CallsSection ctx={ctx} activity={data} />}
        </RangePanel>
      </div>

      {allocation ? (
        <AllocationSection campaignId={campaignId} campaignName={summary.name} allocation={allocation} timezone={zone} />
      ) : (
        <Panel id="allocation" title="Allocation by agent" sub="As of now">
          <SectionBody resource={live.allocation}>{() => null}</SectionBody>
        </Panel>
      )}

      <div className={styles.grid2}>
        <RangePanel blocked={blocked} id="callbacks" title="Callbacks" resource={rangeData.activity}>
          {(data) => <CallbacksSection ctx={ctx} activity={data} />}
        </RangePanel>
        <RangePanel blocked={blocked} id="overrides" title="Overrides" resource={rangeData.activity}>
          {(data) => <OverridesSection ctx={ctx} activity={data} settings={summary.settings} />}
        </RangePanel>
      </div>

      <RangePanel blocked={blocked} id="agents" title="Agents" resource={rangeData.activity}>
        {(data) => <AgentsSection ctx={ctx} activity={data} />}
      </RangePanel>

      <RangePanel blocked={blocked} id="trends" title="Trends" resource={rangeData.trends}>
        {(data) => (
          <TrendsSection
            ctx={ctx}
            trends={data}
            bucket={bucket}
            bucketOptions={bucketOptions}
            onBucketChange={setChosenBucket}
            timezone={zone}
            ceilingPct={summary.settings.abandonment_ceiling_pct}
          />
        )}
      </RangePanel>

      <RangePanel blocked={blocked} id="health" title="Health and compliance" resource={rangeData.health}>
        {(data) => <HealthSection ctx={ctx} health={data} timezone={zone} />}
      </RangePanel>

      <div className={styles.grid2}>
        <RangePanel blocked={blocked} id="recording" title="Recording and analysis" resource={rangeData.health}>
          {(data) => <RecordingSection ctx={ctx} health={data} settings={summary.settings} />}
        </RangePanel>
        <CampaignSettingsPanel summary={summary} />
      </div>

      {live.uploads.data ? (
        <UploadsSection
          campaignId={campaignId}
          campaignName={summary.name}
          uploads={live.uploads.data}
          timezone={zone}
          tenantId={tenantId}
          accountId={accountId}
        />
      ) : (
        <Panel id="uploads" title="Upload history">
          <SectionBody resource={live.uploads}>{() => null}</SectionBody>
        </Panel>
      )}
    </section>
  );
}

/**
 * A range section before its data arrives: the titled panel with a loading line
 * or the error, so the page keeps its shape while the heavy reads come in.
 */
function RangePanel<T>({
  id,
  title,
  resource,
  blocked,
  children,
}: {
  id: string;
  title: string;
  resource: AsyncResource<T | null>;
  blocked: string | null;
  children: (data: T) => ReactNode;
}) {
  if (blocked) {
    return (
      <Panel id={id} title={title}>
        <p className={styles.sectionState}>{blocked}</p>
      </Panel>
    );
  }
  if (resource.data !== null) {
    return (
      <>
        {resource.error ? <p className={styles.sectionError} role="alert">{resource.error}</p> : null}
        {children(resource.data)}
      </>
    );
  }
  return (
    <Panel id={id} title={title}>
      <SectionBody resource={resource}>{() => null}</SectionBody>
    </Panel>
  );
}

export default InsightsPanel;
