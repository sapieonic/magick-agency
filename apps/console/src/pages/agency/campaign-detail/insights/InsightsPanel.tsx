import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
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
  servedRangeView,
  rangeChoiceFromParams,
  rangeChoiceKey,
  rangeChoiceToParams,
  resolveInsightsRange,
  zoneDay,
  type InsightsRangeChoice,
} from '../../../../utils/agency/insights/range';
import type { AgencyInsightsBucket } from '../../../../types/agency-insights';
import { CAMPAIGN_TABS, type CampaignPanelId } from '../../../../utils/agencyCampaignTabs';
import type { InsightsRangeNeeds } from '../../../../hooks/useCampaignInsights';
import { campaignAttention } from '../../../../utils/agency/insights/overview';
import { AttentionPanel, OverviewKpis, OverviewTeasers } from './OverviewSection';
import { InsightsHeadline } from './InsightsHeadline';
import { RosterSection } from './RosterSection';
import { AllocationSection } from './AllocationSection';
import { CallbacksSection, CallsSection, OverridesSection, type RangeSectionContext } from './ActivitySections';
import { AgentsSection } from './AgentsSection';
import { TrendsSection } from './TrendsSection';
import { HealthSection, RecordingSection } from './HealthSection';
import { CampaignMeta } from './CampaignFacts';
import { Panel, SectionBody } from './InsightsParts';
import { ExportReportButton } from '../../../../components/agency/reports/ExportReportButton';
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
  /** Which tab is on screen (decision IN13): each shows its own sections over the same reads. */
  view: CampaignPanelId;
  /**
   * The overdue callbacks as of now, for the Callbacks tab's badge; null until known. With the
   * campaign the count was read for: a reload keeps the last answer on screen, so for a moment
   * after the route moves to another campaign the allocation is still the previous one's.
   */
  onCallbacksOverdue?: (count: number | null, campaignId: string | null) => void;
}

/** The range reads each tab shows. */
const VIEW_NEEDS: Record<CampaignPanelId, InsightsRangeNeeds> = {
  overview: { activity: true, trends: false, health: true },
  calls: { activity: true, trends: true, health: false },
  agents: { activity: true, trends: false, health: false },
  callbacks: { activity: true, trends: false, health: false },
  health: { activity: false, trends: false, health: true },
};

const ALL_VIEWS_NEEDS: InsightsRangeNeeds = { activity: true, trends: true, health: true };

/**
 * The reads asked for by any tab opened so far. Sticky, so going back to a tab
 * shows what it showed instead of loading again: switching tabs never drops a
 * read, only a range change or Refresh reloads one. The price: a read stays on
 * after its tab is left, so a range change on Overview also reloads the trends
 * once Calls has been opened. One extra read, against a reload on every switch.
 */
function useStickyNeeds(view: CampaignPanelId, printing: boolean): InsightsRangeNeeds {
  const [needs, setNeeds] = useState<InsightsRangeNeeds>(() => VIEW_NEEDS[view]);
  // Print is the whole report, every tab, so it asks for every read.
  const wanted = printing ? ALL_VIEWS_NEEDS : VIEW_NEEDS[view];
  const missing = (wanted.activity && !needs.activity) || (wanted.trends && !needs.trends) || (wanted.health && !needs.health);
  if (missing) {
    // Adjusting state during render: React re-renders at once, before paint.
    const next = { activity: needs.activity || wanted.activity, trends: needs.trends || wanted.trends, health: needs.health || wanted.health };
    setNeeds(next);
    return next;
  }
  return needs;
}

/**
 * The campaign's analytic tabs (decisions IN1, IN13): one analytic surface in
 * every status, shown a question at a time — Overview, Calls, Agents (below the
 * floor and the staffing), Callbacks and Health. Mounted once for all five, so
 * the reads and the range survive moving between them. The as-of-now reads paint first; the range reads load after that
 * paint (`useAfterFirstPaint`) and only reload on a range change or Refresh.
 * See `useCampaignInsights` for the refresh rules and `range.ts` for the range.
 */
export function InsightsPanel({ campaignId, canRetry, onRetry, refreshToken, shellStatus, view, onCallbacksOverdue }: InsightsPanelProps) {
  const { search } = useLocation();
  const { tenantId, accountId } = useTenant();
  // The Agents tab has the floor's own stats poll: the insights reads are read once there.
  const live = useInsightsLive(campaignId, view !== 'agents');
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
  const needs = useStickyNeeds(view, printRequested);
  const rangeData = useInsightsRange(campaignId, range, bucket, active, rangeToken, needs);

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

  // The Callbacks tab's badge, as of now (the allocation is polled).
  const overdueNow = allocation ? allocation.totals.callbacks_overdue : null;
  const overdueFor = allocation ? allocation.campaign_id : null;
  useEffect(() => {
    onCallbacksOverdue?.(overdueNow, overdueFor);
  }, [overdueNow, overdueFor, onCallbacksOverdue]);
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
  // What the server served: a lifetime past 92 days comes back clamped, labelled and linked as such.
  const served = servedRangeView(range, activity?.range ?? rangeData.trends.data?.range ?? rangeData.health.data?.range);
  const ctx: RangeSectionContext = {
    campaignId,
    campaignName: summary.name,
    range: served.query,
    rangeLabel: served.label,
    agentName,
  };
  const staffedAgents = allocation ? allocation.agents.filter((a) => a.staffed).length : null;
  const zone = range?.timezone ?? summary.settings.timezone;
  const today = zoneDay(zone, now);
  /** A custom range that cannot be sent leaves the range sections saying so, not loading forever. */
  const blocked = range?.error ? 'Choose a valid range to see these figures.' : null;
  // What the Overview's range figures show: nothing while the range is invalid.
  const shownActivity = blocked ? null : activity;
  const shownHealth = blocked ? null : rangeData.health.data;
  // Why a read has nothing to show (an invalid range, or a failed read): the
  // Overview's figures and cards say so rather than wait for ever. The detail
  // tabs say the same through RangePanel.
  const COULD_NOT_LOAD = 'Could not load. Refresh to try again.';
  const unavailable = {
    activity: blocked ?? (activity === null && rangeData.activity.error !== null ? COULD_NOT_LOAD : null),
    health: blocked ?? (rangeData.health.data === null && rangeData.health.error !== null ? COULD_NOT_LOAD : null),
    allocation: allocation === null && live.allocation.error !== null ? COULD_NOT_LOAD : null,
  };
  const overviewError = blocked
    ? null
    : rangeData.activity.error ?? rangeData.health.error ?? (unavailable.allocation ? live.allocation.error : null);
  /**
   * A tab's sections: on screen for the tab shown. While printing, every other
   * tab's sections render too, print-only, so the printout is the whole report
   * and the screen does not change under the "Preparing…" button.
   */
  const section = (v: CampaignPanelId, render: () => ReactNode) => {
    if (v === view) return render();
    if (!printRequested) return null;
    return (
      <div className={styles.printOnly} data-print-view={v}>
        <h2 className={styles.viewTitle}>{CAMPAIGN_TABS.find((t) => t.id === v)!.label}</h2>
        {render()}
      </div>
    );
  };
  // The freshness of the read this tab shows (Health shows no activity).
  const freshness = blocked ? null : rangeFreshness(view === 'health' ? shownHealth : activity, zone);

  return (
    <section className={styles.root} aria-label="Campaign insights" data-testid="insights-panel" data-view={view}>
      {view === 'agents' ? <h2 className={styles.viewTitle}>Performance</h2> : null}
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
            {/*
              "Figures", so it is not read as the header's stamp, which covers the
              campaign's status and floor and polls on its own rule. Only the "now"
              figures ever poll; the range figures reload on Refresh.
            */}
            {live.lastUpdatedAt ? `Figures updated ${formatClockTime(live.lastUpdatedAt)}` : 'Loading…'}
            {live.polling ? ' · “now” figures auto-refresh' : ' · not auto-refreshing'}
          </p>
          <button type="button" className={`btn-secondary ${styles.toolButton}`} onClick={refresh} aria-label="Refresh insights">
            <RefreshCw size={14} aria-hidden="true" />
            Refresh
          </button>
          <button type="button" className={`btn-secondary ${styles.toolButton}`} onClick={() => setPrintRequested(true)} disabled={printRequested}>
            <Printer size={14} aria-hidden="true" />
            {printRequested ? 'Preparing…' : 'Print'}
          </button>
          {/* "Export campaign report" (`docs/reports.md`): PDF and Excel in the
              campaign's own zone (RP3). Nothing while reports are off. */}
          <ExportReportButton
            entry="campaign_insights"
            className={`btn-secondary ${styles.toolButton}`}
            target={{
              kind: 'campaign',
              subject: { id: campaignId, name: summary?.name ?? null },
              campaignTimezone: timezone,
            }}
          />
        </div>
      </div>
      <p className={styles.rangeNote}>
        {`Times in ${zone}${range?.zoneFallback ? ' (the campaign’s time zone is not recognised)' : ''} · figures marked “now” are live; the rest follow the range (${served.label}).`}
      </p>
      {range?.error ? <p className={styles.rangeError} role="alert">{range.error}</p> : null}
      {freshness ? <p className={styles.rangeNote} data-testid="insights-freshness">{freshness}</p> : null}

      {section('overview', () => (
        <>
          {overviewError ? (
            <p className={styles.sectionError} role="alert" data-testid="overview-error">{`${overviewError} Refresh to try again.`}</p>
          ) : null}
          <CampaignMeta summary={summary} />
          <InsightsHeadline
            summary={summary}
            readiness={live.readiness}
            now={now}
            canRetry={canRetry}
            onRetry={onRetry}
            staffedAgents={staffedAgents}
          />
          <OverviewKpis
            ctx={ctx}
            summary={summary}
            allocation={allocation}
            activity={shownActivity}
            health={shownHealth}
            unavailable={unavailable}
          />
          <div className={styles.overviewGrid}>
            <AttentionPanel
              attention={campaignAttention({ summary, allocation, health: shownHealth })}
              campaignId={campaignId}
              search={search}
              loading={(allocation === null && !unavailable.allocation) || (shownHealth === null && !unavailable.health)}
              healthUnavailable={blocked ? 'choose a valid range.' : unavailable.health ? 'the read failed. Refresh to try again.' : null}
            />
            <RosterSection campaignId={campaignId} campaignName={summary.name} roster={summary.roster} />
            {/* Third, so it follows the roster on a phone; beside two columns it fills the space under the attention list (see `.overviewGrid`). */}
            <OverviewTeasers
              campaignId={campaignId}
              search={search}
              activity={shownActivity}
              allocation={allocation}
              health={shownHealth}
              unavailable={unavailable}
            />
          </div>
        </>
      ))}

      {section('calls', () => (
        <>
          <RangePanel id="calls" title="Calls and outcomes" resource={rangeData.activity} blocked={blocked}>
            {(data) => <CallsSection ctx={ctx} activity={data} />}
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
        </>
      ))}

      {section('agents', () => (
        <>
          <RangePanel blocked={blocked} id="agents" title="Agents" resource={rangeData.activity}>
            {(data) => <AgentsSection ctx={ctx} activity={data} />}
          </RangePanel>
          {allocation ? (
            <AllocationSection campaignId={campaignId} campaignName={summary.name} allocation={allocation} timezone={zone} />
          ) : (
            <Panel id="allocation" title="Allocation by agent" sub="As of now">
              <SectionBody resource={live.allocation}>{() => null}</SectionBody>
            </Panel>
          )}
          <RangePanel blocked={blocked} id="overrides" title="Overrides" resource={rangeData.activity}>
            {(data) => <OverridesSection ctx={ctx} activity={data} settings={summary.settings} />}
          </RangePanel>
        </>
      ))}

      {section('callbacks', () => (
        <RangePanel blocked={blocked} id="callbacks" title="Callbacks" resource={rangeData.activity}>
          {(data) => <CallbacksSection ctx={ctx} activity={data} />}
        </RangePanel>
      ))}

      {section('health', () => (
        <>
          <RangePanel blocked={blocked} id="health" title="Health and compliance" resource={rangeData.health}>
            {(data) => <HealthSection ctx={ctx} health={data} timezone={zone} />}
          </RangePanel>
          <RangePanel blocked={blocked} id="recording" title="Recording and analysis" resource={rangeData.health}>
            {(data) => <RecordingSection ctx={ctx} health={data} settings={summary.settings} />}
          </RangePanel>
        </>
      ))}
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
