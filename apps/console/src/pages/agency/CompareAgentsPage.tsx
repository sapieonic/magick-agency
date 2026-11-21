import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SlidersHorizontal, Users } from 'lucide-react';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import {
  COMPARE_LENSES,
  type AgencyCompareMetricRef,
  type AgencyCompareQuery,
  type AgencyCompareView,
  type CompareLens,
} from '@magick-agency/contracts/api/agency/compare';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { useCompareRead } from '../../hooks/useCompareRead';
import { hasPermission } from '../../utils/permissions';
import { listAgencyCampaigns } from '../../api/agencyCampaigns';
import {
  compareErrorCode,
  compareErrorMessage,
  getCompareOptions,
  isRetryableCompareError,
  listCompareViews,
  queryCompare,
} from '../../api/compare';
import { CapabilityUnavailable } from '../../components/common/CapabilityUnavailable';
import { COMPARE_FLAG } from '../../utils/agency/compare/compareFlag';
import {
  COMPARE_WINDOW_PRESETS,
  EMPTY_SLOTS,
  compareStateFromParams,
  compareStateToParams,
  longerWindow,
  pickedAgents,
  toggleAgent,
  windowDates,
  windowError,
  type CompareUrlState,
  type CompareWindowPreset,
} from '../../utils/agency/compare/compareUrl';
import {
  LENS_LABELS,
  applyToCatalog,
  compareLensDefaults,
  droppedNote,
  infoLabel,
} from '../../utils/agency/compare/compareMetrics';
import { defaultRosterCampaign } from '../../utils/agencyAgentRoster';
import { browserZone, todayIn } from '../../utils/reports/reportWindow';
import { formatClockTime } from '../../utils/format/date';
import { CompareAgentChips, cohortAgentName } from '../../components/agency/compare/CompareAgentChips';
import { CompareMetricPicker } from '../../components/agency/compare/CompareMetricPicker';
import { CompareFindings } from '../../components/agency/compare/CompareFindings';
import { CompareNumbers } from '../../components/agency/compare/CompareNumbers';
import { CompareViews } from '../../components/agency/compare/CompareViews';
import {
  DaySplitBars,
  DaySplitLegend,
  MetricBars,
  TrendChart,
  agentColour,
  type ChartAgent,
} from '../../components/agency/compare/CompareCharts';
import styles from '../../components/agency/compare/Compare.module.css';

/**
 * Compare agents (`docs/compare-agents.md`): Reports' tab where a supervisor puts up to three
 * agents of one campaign side by side against the rest of its agents, and is told what stands
 * out, for coaching (CP4). Supervisors only (CP3, `agency.supervise`), behind
 * `agency_compare_enabled`; the route's `RequireFlag` already gates it and the flag is read again
 * here so the page fails closed when mounted without its route.
 *
 * Everything the page shows is in its URL (`compareUrl.ts`): a link opens the same comparison.
 */
export default function CompareAgentsPage() {
  const { role, tenantId, accountId } = useTenant();
  const enabled = useFeatureFlagEnabled(COMPARE_FLAG);
  const userId = useUserIdOrNull();

  if (role === undefined) return <LoadingSpinner />;
  if (!enabled) return <CapabilityUnavailable />;
  if (!hasPermission(role, 'agency.supervise')) {
    return (
      <EmptyState
        icon={<Users size={32} />}
        title="Compare agents is for supervisors"
        description="Ask an account admin if you need to compare agents."
      />
    );
  }
  if (!tenantId || !accountId) return <LoadingSpinner />;
  return (
    <CompareAgentsView
      tenantId={tenantId}
      accountId={accountId}
      userId={userId}
      canListen={hasPermission(role, 'agency.calls.listen')}
    />
  );
}

function useUserIdOrNull(): string | null {
  try {
    return useAuth().user?.id ?? null;
  } catch {
    return null;
  }
}

export interface CompareAgentsViewProps {
  tenantId: string;
  accountId: string;
  userId: string | null;
  /** `agency.calls.listen`: the listening next steps are offered (RC1). */
  canListen: boolean;
  /** Injectable for tests: the clock "today" is read from. */
  now?: Date;
}

type Campaign = Awaited<ReturnType<typeof listAgencyCampaigns>>[number];

/** The lens, metrics and trend the page shows, and where they came from. */
interface Resolved {
  lens: CompareLens;
  metrics: AgencyCompareMetricRef[];
  trend: AgencyCompareMetricRef | null;
  viewId: string | null;
  /** What applying a view or a link had to leave out, in words. */
  note: string | null;
}

export function CompareAgentsView({ tenantId, accountId, userId, canListen, now }: CompareAgentsViewProps) {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => compareStateFromParams(params), [params]);
  const update = useCallback(
    (patch: Partial<CompareUrlState>) =>
      setParams((prev) => compareStateToParams({ ...compareStateFromParams(prev), ...patch }), { replace: true }),
    [setParams],
  );
  const [zone] = useState(browserZone);
  const [clock] = useState(() => now ?? new Date());
  const today = todayIn(zone, clock);
  const ids = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [viewNote, setViewNote] = useState<string | null>(null);

  // ── Campaigns ──
  const [campaigns, setCampaigns] = useState<Campaign[] | null>(null);
  const [campaignsFailed, setCampaignsFailed] = useState(false);
  useEffect(() => {
    let live = true;
    listAgencyCampaigns(tenantId, accountId)
      .then((list) => live && setCampaigns(list))
      .catch(() => {
        if (!live) return;
        setCampaigns([]);
        setCampaignsFailed(true);
      });
    return () => {
      live = false;
    };
  }, [tenantId, accountId]);
  useEffect(() => {
    if (state.campaignId || !campaigns || campaigns.length === 0) return;
    const first = defaultRosterCampaign(campaigns);
    if (first) update({ campaignId: first });
  }, [state.campaignId, campaigns, update]);
  const campaign = campaigns?.find((c) => c.id === state.campaignId) ?? null;

  // ── The window ──
  const dates = windowDates(state, today);
  const dateError = windowError(dates, today);
  const window = dateError === null ? dates : null;

  // ── Options: the cohort, the outcome codes, the starting lens, the default view ──
  const optionsQuery =
    state.campaignId && window ? { campaign_id: state.campaignId, from: window.from, to: window.to, timezone: zone } : null;
  const options = useCompareRead(optionsQuery ? JSON.stringify(optionsQuery) : null, (signal) =>
    getCompareOptions(optionsQuery!, tenantId, accountId, signal),
  );
  // The last answer stays up while a new one loads; one for another campaign is not this page's.
  const opts = options.data && options.data.campaign_id === state.campaignId ? options.data : null;
  const codes = useMemo(() => opts?.outcome_codes ?? [], [opts]);

  // ── Saved views ──
  const [views, setViews] = useState<AgencyCompareView[] | null>(null);
  const [viewsVersion, setViewsVersion] = useState(0);
  useEffect(() => {
    if (!state.campaignId) return;
    let live = true;
    setViews(null);
    listCompareViews({ campaign_id: state.campaignId }, tenantId, accountId)
      .then((list) => live && setViews(list.views))
      .catch(() => live && setViews([]));
    return () => {
      live = false;
    };
  }, [state.campaignId, tenantId, accountId, viewsVersion]);

  // ── The lens, metrics and trend: the URL's, else the campaign's default view, else the lens's ──
  const resolved = useMemo<Resolved | null>(() => {
    if (!opts) return null;
    const lensDefaults = (lens: CompareLens) => compareLensDefaults(lens, codes);
    if (state.metrics !== null) {
      const lens = state.lens ?? opts.starting_lens;
      const trend = state.trend === undefined ? lensDefaults(lens).trend : state.trend;
      const applied = applyToCatalog(state.metrics, trend, codes);
      if (applied.metrics.length > 0) {
        return { lens, metrics: applied.metrics, trend: applied.trend, viewId: state.viewId, note: droppedNote(applied) };
      }
    }
    const view = opts.default_view;
    if (state.metrics === null && state.lens === null && state.viewId === null && view) {
      const applied = applyToCatalog(view.metrics, view.trend, codes);
      if (applied.metrics.length > 0) {
        return { lens: view.lens, metrics: applied.metrics, trend: applied.trend, viewId: view.id, note: droppedNote(applied) };
      }
    }
    const lens = state.lens ?? opts.starting_lens;
    const d = lensDefaults(lens);
    const trend = state.trend === undefined ? d.trend : state.trend;
    return { lens, metrics: d.metrics, trend: trend && applyToCatalog([], trend, codes).trend, viewId: state.viewId, note: null };
  }, [opts, codes, state.metrics, state.lens, state.trend, state.viewId]);

  const appliedView =
    resolved?.viewId ? ((views ?? []).find((v) => v.id === resolved.viewId) ?? (opts?.default_view?.id === resolved.viewId ? opts.default_view : null)) : null;

  // ── Agents: the URL's picks that are in this window's cohort ──
  const cohortIds = useMemo(() => new Set((opts?.agents ?? []).map((a) => a.agent_user_id)), [opts]);
  const picked = pickedAgents(state.slots);
  const inCohort = opts ? picked.filter((id) => cohortIds.has(id)) : [];
  const outOfCohort = opts ? picked.length - inCohort.length : 0;
  const chartAgents: ChartAgent[] = inCohort.map((id) => {
    const agent = opts!.agents.find((a) => a.agent_user_id === id)!;
    return { id, name: cohortAgentName(agent), slot: state.slots.indexOf(id) };
  });

  // ── The comparison ──
  const query: AgencyCompareQuery | null =
    opts && window && resolved && inCohort.length > 0
      ? {
          campaign_id: opts.campaign_id,
          agent_ids: inCohort,
          metrics: resolved.metrics,
          trend: resolved.trend,
          from: window.from,
          to: window.to,
          timezone: zone,
        }
      : null;
  const result = useCompareRead(query ? JSON.stringify(query) : null, (signal) => queryCompare(query!, tenantId, accountId, signal));
  const response = result.data && query && result.data.campaign_id === query.campaign_id ? result.data : null;

  // ── Changes ──
  const setCampaign = (campaignId: string) =>
    update({ campaignId, slots: [...EMPTY_SLOTS], lens: null, metrics: null, trend: undefined, viewId: null });
  const setWindow = (preset: CompareWindowPreset) =>
    update(preset === 'custom' ? { window: preset, from: dates?.from ?? today, to: dates?.to ?? today } : { window: preset, from: null, to: null });
  const setLens = (lens: CompareLens) => {
    setViewNote(null);
    update({ lens, metrics: null, trend: undefined, viewId: null });
  };
  const setMetrics = (metrics: AgencyCompareMetricRef[]) =>
    resolved && update({ lens: resolved.lens, metrics, trend: resolved.trend, viewId: resolved.viewId });
  const setTrend = (trend: AgencyCompareMetricRef | null) =>
    resolved && update({ lens: resolved.lens, metrics: resolved.metrics, trend, viewId: resolved.viewId });
  const applyView = (view: AgencyCompareView) => {
    const applied = applyToCatalog(view.metrics, view.trend, codes);
    if (applied.metrics.length === 0) {
      setViewNote(`“${view.name}” uses only outcomes this campaign doesn’t have, so it can’t be applied here.`);
      return;
    }
    setViewNote(droppedNote(applied));
    update({ lens: view.lens, metrics: applied.metrics, trend: applied.trend ?? null, viewId: view.id });
  };
  const longer = window ? longerWindow(state, today) : null;
  const checkLonger = longer ? () => update(longer) : undefined;

  const note = viewNote ?? resolved?.note ?? null;
  const flaggable = response?.metrics.filter((m) => m.flaggable).length ?? 0;

  return (
    <div className={styles.page}>
      <PageHeader
        title="Compare agents"
        subtitle="Up to 3 agents of one campaign side by side, against the rest of its agents, for coaching."
        actions={
          state.campaignId && resolved ? (
            <CompareViews
              tenantId={tenantId}
              accountId={accountId}
              userId={userId}
              campaignId={state.campaignId}
              campaignName={opts?.campaign_name ?? campaign?.name ?? null}
              views={views}
              applied={appliedView}
              current={{ lens: resolved.lens, metrics: resolved.metrics, trend: resolved.trend }}
              onApply={applyView}
              onSaved={(view) => {
                setViewsVersion((n) => n + 1);
                update({ lens: view.lens, metrics: view.metrics, trend: view.trend ?? null, viewId: view.id });
              }}
              onDeleted={() => {
                setViewsVersion((n) => n + 1);
                update({ viewId: null });
              }}
            />
          ) : null
        }
      />

      <div className={styles.filters}>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${ids}-campaign`}>
            Campaign
          </label>
          <select
            id={`${ids}-campaign`}
            className={styles.campaignSelect}
            value={state.campaignId ?? ''}
            disabled={campaigns === null}
            onChange={(e) => e.target.value && setCampaign(e.target.value)}
            data-testid="compare-campaign"
          >
            {campaigns === null ? <option value="">Loading campaigns…</option> : null}
            {campaigns !== null && !state.campaignId ? <option value="">Choose a campaign</option> : null}
            {state.campaignId && campaigns !== null && !campaign ? (
              <option value={state.campaignId}>{opts?.campaign_name ?? 'This campaign'}</option>
            ) : null}
            {(campaigns ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor={`${ids}-when`}>
            When
          </label>
          <select id={`${ids}-when`} value={state.window} onChange={(e) => setWindow(e.target.value as CompareWindowPreset)} data-testid="compare-when">
            {COMPARE_WINDOW_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        {state.window === 'custom' ? (
          <div className={styles.dates}>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={`${ids}-from`}>
                From
              </label>
              <input id={`${ids}-from`} type="date" value={state.from ?? ''} max={today} onChange={(e) => update({ from: e.target.value || null })} />
            </div>
            <div className={styles.field}>
              <label className={styles.fieldLabel} htmlFor={`${ids}-to`}>
                To
              </label>
              <input id={`${ids}-to`} type="date" value={state.to ?? ''} max={today} onChange={(e) => update({ to: e.target.value || null })} />
            </div>
          </div>
        ) : null}
        {resolved ? (
          <>
            <div className={styles.field}>
              <span className={styles.fieldLabel} id={`${ids}-lens`}>
                Lens
              </span>
              <div className={styles.lensTabs} role="tablist" aria-labelledby={`${ids}-lens`}>
                {COMPARE_LENSES.map((lens) => (
                  <button
                    key={lens}
                    type="button"
                    role="tab"
                    aria-selected={resolved.lens === lens}
                    className={styles.lensTab}
                    onClick={() => setLens(lens)}
                    data-testid={`compare-lens-${lens}`}
                  >
                    {LENS_LABELS[lens]}
                  </button>
                ))}
              </div>
            </div>
            <button
              type="button"
              className={`btn-secondary ${styles.metricsButton}`}
              aria-expanded={pickerOpen}
              aria-controls={`${ids}-picker`}
              onClick={() => setPickerOpen((o) => !o)}
              data-testid="compare-metrics-button"
            >
              <SlidersHorizontal size={14} aria-hidden="true" />
              {`Metrics · ${resolved.metrics.length}`}
            </button>
          </>
        ) : null}
      </div>
      {dateError && state.window === 'custom' ? (
        <p className={styles.inlineError} role="alert">
          {dateError}
        </p>
      ) : null}
      <p className={styles.hint}>Like for like: only calls on this campaign count, for everyone.</p>

      {resolved && pickerOpen ? (
        <CompareMetricPicker
          id={`${ids}-picker`}
          metrics={resolved.metrics}
          trend={resolved.trend}
          codes={codes}
          onMetrics={setMetrics}
          onTrend={setTrend}
        />
      ) : null}

      {note ? (
        <p className={styles.note} role="status" data-testid="compare-note">
          {note}
        </p>
      ) : null}

      {campaigns !== null && campaigns.length === 0 ? (
        <EmptyState
          icon={<Users size={32} />}
          title={campaignsFailed ? 'The campaigns couldn’t be loaded' : 'No campaigns yet'}
          description={campaignsFailed ? 'Refresh the page to try again.' : 'Agents are compared within one campaign. Create a campaign first.'}
        />
      ) : null}

      {options.status === 'error' && !opts ? (
        <ReadError error={options.error} onRetry={options.retry} fallback="The campaign’s agents couldn’t be loaded." />
      ) : null}
      {options.status === 'loading' && !opts ? <LoadingSpinner /> : null}

      {opts ? (
        <section className={styles.card} aria-labelledby={`${ids}-agents`}>
          <div className={styles.pickHead}>
            <h2 className={styles.cardTitle} id={`${ids}-agents`}>
              Pick up to 3 agents
            </h2>
            <span className={styles.cardSub}>{`${opts.agents.length} took calls on ${opts.campaign_name} in this window`}</span>
          </div>
          <CompareAgentChips agents={opts.agents} slots={state.slots} onToggle={(id) => update({ slots: toggleAgent(state.slots, id) })} />
          {outOfCohort > 0 ? (
            <p className={styles.note} role="status">
              {outOfCohort === 1
                ? 'One agent in the link didn’t take calls on this campaign in this window, so they are left out.'
                : `${outOfCohort} agents in the link didn’t take calls on this campaign in this window, so they are left out.`}
            </p>
          ) : null}
        </section>
      ) : null}

      {opts && chartAgents.length > 0 ? (
        <ul className={styles.legend} aria-label="Legend">
          {chartAgents.map((a) => (
            <li key={a.id}>
              <span className={styles.swatch} style={{ background: agentColour(a.slot) }} aria-hidden="true" />
              {a.name}
            </li>
          ))}
          <li>
            <span className={styles.swatchLine} aria-hidden="true" />
            Team median
          </li>
          <li>
            <span className={styles.swatchBand} aria-hidden="true" />
            Middle half of the team
          </li>
        </ul>
      ) : null}

      {query && result.status === 'error' && !response ? (
        <ReadError error={result.error} onRetry={result.retry} fallback="The comparison couldn’t be worked out." />
      ) : null}
      {query && result.status === 'loading' && !response ? <LoadingSpinner /> : null}

      {response && query ? (
        <>
          {result.status === 'loading' ? (
            <p className={styles.updating} role="status">
              Updating…
            </p>
          ) : null}
          {result.status === 'error' ? (
            <ReadError error={result.error} onRetry={result.retry} fallback="The comparison couldn’t be worked out." />
          ) : null}
          <div className={styles.board}>
            <section className={styles.card} aria-labelledby={`${ids}-sbs`}>
              <div className={styles.cardHead}>
                <h2 className={styles.cardTitle} id={`${ids}-sbs`}>
                  Side by side
                </h2>
                <span className={styles.cardSub}>{`${response.cohort.agents} agents on this campaign · as of ${formatClockTime(new Date(response.as_of))}`}</span>
              </div>
              <div className={styles.bars}>
                {response.metrics.map((info) => (
                  <MetricBars key={info.id} info={info} agents={chartAgents} columns={response.agents} cohort={response.cohort.per_metric[info.id]} />
                ))}
              </div>
              <p className={styles.foot}>
                Grey band: the middle half of the team. Line: the team median. Whisker on a rate: its likely range (95%), wide when calls are few.
                Agents under the floor are left out of the band.
              </p>
            </section>
            <section className={styles.card} aria-labelledby={`${ids}-finds`}>
              <div className={styles.cardHead}>
                <h2 className={styles.cardTitle} id={`${ids}-finds`}>
                  What stands out
                </h2>
                {flaggable > 0 ? <span className={styles.cardSub}>for coaching</span> : null}
              </div>
              <CompareFindings response={response} codes={codes} timezone={zone} canListen={canListen} onLonger={checkLonger} />
            </section>
          </div>
          <div className={styles.boardEven}>
            <section className={styles.card} aria-labelledby={`${ids}-trend`}>
              <div className={styles.cardHead}>
                <h2 className={styles.cardTitle} id={`${ids}-trend`}>
                  {response.trend_metric ? `${infoLabel(response.trend_metric)} per day` : 'Per day'}
                </h2>
                {response.trend ? <span className={styles.cardSub}>{`${response.trend.dates.length} days · dashed: team median`}</span> : null}
              </div>
              {response.trend && response.trend_metric && response.trend.dates.length > 1 ? (
                <TrendChart trend={response.trend} agents={chartAgents} label={infoLabel(response.trend_metric)} />
              ) : (
                <p className={styles.hint}>
                  {response.trend
                    ? 'A per-day line needs at least two days. Choose a longer window.'
                    : 'No per-day trend chosen. Choose one under Metrics: an outcome set or promises.'}
                </p>
              )}
            </section>
            <section className={styles.card} aria-labelledby={`${ids}-day`}>
              <div className={styles.cardHead}>
                <h2 className={styles.cardTitle} id={`${ids}-day`}>
                  Where their day went
                </h2>
                <span className={styles.cardSub}>share of logged-in time, breaks included</span>
              </div>
              <DaySplitLegend />
              <DaySplitBars agents={chartAgents} columns={response.agents} />
              <p className={styles.foot}>Waiting for a call depends on the dialler and the list, not the agent, so it is shown but never flagged.</p>
            </section>
          </div>
          <section className={styles.card} aria-labelledby={`${ids}-numbers`}>
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle} id={`${ids}-numbers`}>
                The numbers
              </h2>
              <span className={styles.cardSub}>the table behind every chart</span>
            </div>
            <CompareNumbers response={response} agents={chartAgents} />
          </section>
        </>
      ) : null}

      {opts && opts.agents.length > 0 && chartAgents.length === 0 ? (
        <EmptyState
          icon={<Users size={32} />}
          title="Pick an agent to start"
          description="Their figures appear beside the rest of the campaign’s agents, with what stands out."
        />
      ) : null}
    </div>
  );
}

function ReadError({ error, onRetry, fallback }: { error: unknown; onRetry: () => void; fallback: string }) {
  // A refusal that clears by itself (busy, timed out) or a failure with no code (the network)
  // can be tried again; any other refusal needs the reader to change something first.
  const canRetry = isRetryableCompareError(error) || compareErrorCode(error) === null;
  return (
    <div className={`${styles.note} ${styles.errorBox}`} role="alert" data-testid="compare-error">
      <p className={styles.emptyNote}>{compareErrorMessage(error, fallback)}</p>
      {canRetry ? (
        <button type="button" className={styles.linkButton} onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}
