import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SlidersHorizontal, Users } from 'lucide-react';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import {
  COMPARE_LENSES,
  COMPARE_PAGE_MAX_AGENTS,
  type AgencyCompareMetricRef,
  type AgencyCompareQuery,
  type AgencyCompareView,
  type CompareLens,
} from '@magick-agency/contracts/api/agency/compare';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { COMPARE_SETTLE_MS, useCompareRead, useSettledKey } from '../../hooks/useCompareRead';
import { hasPermission } from '../../utils/permissions';
import { listAgencyCampaigns, listArchivedAgencyCampaigns } from '../../api/agencyCampaigns';
import { pickerCampaignName } from '../../utils/agencyCampaignArchive';
import {
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
  keepAgents,
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
  fallbackNote,
  infoLabel,
} from '../../utils/agency/compare/compareMetrics';
import { defaultRosterCampaign } from '../../utils/agencyAgentRoster';
import { browserZone, todayIn } from '../../utils/reports/reportWindow';
import { dateFormatter } from '../../utils/format/date';
import { formatReportDay } from '../../utils/reports/reportCopy';
import { plural } from '../../utils/format/number';
import { CompareAgentChips, cohortAgentName } from '../../components/agency/compare/CompareAgentChips';
import { agentName } from '../../utils/agency/compare/compareFindingsCopy';
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
  /** Injectable for tests: how long the picks must stay still before the query is asked. */
  settleMs?: number;
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

export function CompareAgentsView({ tenantId, accountId, userId, canListen, now, settleMs = COMPARE_SETTLE_MS }: CompareAgentsViewProps) {
  const [params, setParams] = useSearchParams();
  const state = useMemo(() => compareStateFromParams(params), [params]);
  const update = useCallback(
    (patch: Partial<CompareUrlState>) =>
      setParams((prev) => compareStateToParams({ ...compareStateFromParams(prev), ...patch }), { replace: true }),
    [setParams],
  );
  const [zone] = useState(browserZone);
  const today = useToday(zone, now);
  const ids = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [viewNote, setViewNote] = useState<string | null>(null);
  // Views deleted on this page: a campaign default among them is never applied again from options
  // read before the delete.
  const [deletedViews, setDeletedViews] = useState<ReadonlySet<string>>(() => new Set());

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
  // A campaign the URL holds that the list leaves out may be archived since: it is named
  // "(archived)", as every other picker names one, rather than by its name alone.
  const [archived, setArchived] = useState<Campaign[] | null>(null);
  const heldMissing = campaigns !== null && state.campaignId !== null && campaign === null;
  useEffect(() => {
    if (!heldMissing || archived !== null) return;
    let live = true;
    listArchivedAgencyCampaigns(tenantId, accountId)
      .then((list) => live && setArchived(list))
      .catch(() => live && setArchived([]));
    return () => {
      live = false;
    };
  }, [heldMissing, archived, tenantId, accountId]);
  const heldArchived = heldMissing ? (archived?.find((c) => c.id === state.campaignId) ?? null) : null;

  // ── The window ──
  const dates = windowDates(state, today);
  const dateError = windowError(dates, today);
  const window = dateError === null ? dates : null;

  // ── Options: the cohort, the outcome codes, the starting lens, the default view ──
  const optionsQuery =
    state.campaignId && window ? { campaign_id: state.campaignId, from: window.from, to: window.to, timezone: zone } : null;
  const optionsKey = optionsQuery ? JSON.stringify(optionsQuery) : null;
  const options = useCompareRead(optionsKey, (signal) => getCompareOptions(optionsQuery!, tenantId, accountId, signal));
  // The options for THIS campaign, window and zone: only these may shape a query, since the
  // cohort changes with the window (an agent of last week's may not be in today's).
  const readyOpts = options.data && options.dataKey === optionsKey ? options.data : null;
  // Options for a new window are on their way: the comparison is held until they are in.
  const optionsPending = optionsKey !== null && options.doneKey !== optionsKey;
  // What the filters and chips show: the current options, else the last of this campaign's while
  // the next load (so a window change does not blank the page).
  const opts =
    readyOpts ?? (optionsPending && options.data && options.data.campaign_id === state.campaignId ? options.data : null);
  const codes = useMemo(() => opts?.outcome_codes ?? [], [opts]);

  // ── Saved views ──
  const [views, setViews] = useState<AgencyCompareView[] | null>(null);
  const [viewsFailed, setViewsFailed] = useState(false);
  const [viewsVersion, setViewsVersion] = useState(0);
  // Another campaign's list is not this one's; a re-read after a save keeps the list (and the
  // applied view's buttons) on screen until the new one comes.
  useEffect(() => setViews(null), [state.campaignId]);
  useEffect(() => {
    if (!state.campaignId) return;
    let live = true;
    setViewsFailed(false);
    listCompareViews({ campaign_id: state.campaignId }, tenantId, accountId)
      .then((list) => live && setViews(list.views))
      // A failed read is said, with a way to read again: never "No saved views yet".
      .catch(() => live && setViewsFailed(true));
    return () => {
      live = false;
    };
  }, [state.campaignId, tenantId, accountId, viewsVersion]);

  // ── The lens, metrics and trend: the URL's, else the campaign's default view, else the lens's ──
  const resolved = useMemo<Resolved | null>(() => {
    if (!opts) return null;
    const lensDefaults = (lens: CompareLens) => compareLensDefaults(lens, codes);
    // What a link or the default view had to leave out when none of its metrics could be shown:
    // the page falls back to the lens's metrics and says so, never silently.
    let fallback: string | null = null;
    if (state.metrics !== null) {
      const lens = state.lens ?? opts.starting_lens;
      const trend = state.trend === undefined ? lensDefaults(lens).trend : state.trend;
      const applied = applyToCatalog(state.metrics, trend, codes);
      if (applied.metrics.length > 0) {
        return { lens, metrics: applied.metrics, trend: applied.trend, viewId: state.viewId, note: droppedNote(applied) };
      }
      fallback = fallbackNote(applied, 'the link', lens);
    }
    const view = opts.default_view && !deletedViews.has(opts.default_view.id) ? opts.default_view : null;
    if (state.metrics === null && state.lens === null && state.viewId === null && view) {
      const applied = applyToCatalog(view.metrics, view.trend, codes);
      if (applied.metrics.length > 0) {
        return { lens: view.lens, metrics: applied.metrics, trend: applied.trend, viewId: view.id, note: droppedNote(applied) };
      }
      fallback = fallbackNote(applied, `the campaign’s default view, “${view.name}”,`, opts.starting_lens);
    }
    const lens = state.lens ?? opts.starting_lens;
    const d = lensDefaults(lens);
    const wanted = state.trend === undefined ? d.trend : state.trend;
    const trend = wanted ? applyToCatalog([], wanted, codes) : null;
    // A link's trend the campaign cannot draw is left out and said, as its metrics would be;
    // once the fallback note has said it, it is not said twice.
    const note = fallback ?? (trend ? droppedNote(trend) : null);
    return { lens, metrics: d.metrics, trend: trend?.trend ?? null, viewId: state.viewId, note };
  }, [opts, codes, state.metrics, state.lens, state.trend, state.viewId, deletedViews]);

  const appliedView =
    resolved?.viewId ? ((views ?? []).find((v) => v.id === resolved.viewId) ?? (opts?.default_view?.id === resolved.viewId ? opts.default_view : null)) : null;

  // ── Agents: the URL's picks that are in this window's cohort ──
  const cohortIds = useMemo(() => new Set((opts?.agents ?? []).map((a) => a.agent_user_id)), [opts]);
  const readyIds = useMemo(() => new Set((readyOpts?.agents ?? []).map((a) => a.agent_user_id)), [readyOpts]);
  const picked = pickedAgents(state.slots);
  const inCohort = readyOpts ? picked.filter((id) => readyIds.has(id)) : [];
  const outOfCohort = readyOpts ? picked.length - inCohort.length : 0;
  const pickedShown = picked.filter((id) => cohortIds.has(id));

  // ── The comparison: asked only with the current window's options, once the picks settle ──
  const query: AgencyCompareQuery | null =
    readyOpts && window && resolved && inCohort.length > 0
      ? {
          campaign_id: readyOpts.campaign_id,
          agent_ids: inCohort,
          metrics: resolved.metrics,
          trend: resolved.trend,
          from: window.from,
          to: window.to,
          timezone: zone,
        }
      : null;
  const queryKey = query ? JSON.stringify(query) : null;
  const askedKey = useSettledKey(queryKey, settleMs, optionsPending);
  // Paused while a new window's options load, or once the question has moved on from the one
  // asked: the query in flight is cancelled (its slot freed, §2; its answer would be for choices
  // no longer on screen) and the last answer stays up, marked as updating.
  const result = useCompareRead(
    askedKey,
    (signal) => queryCompare(JSON.parse(askedKey!) as AgencyCompareQuery, tenantId, accountId, signal),
    optionsPending || askedKey !== queryKey,
  );
  const response = result.data && result.data.campaign_id === state.campaignId ? result.data : null;
  const optionsFailed = options.status === 'error' && options.doneKey === optionsKey;
  const queryFailed = askedKey !== null && result.status === 'error';
  // A read failed and the answer on screen was read for other choices (another window, agents
  // or metrics): it is kept, but said to be the last that loaded, with its window, never passed
  // off as the answer to what the filters now say.
  const stale = response !== null && (optionsFailed || queryFailed) && result.dataKey !== queryKey;
  const updating = !stale && (optionsPending || result.status === 'loading' || (queryKey !== null && askedKey !== queryKey));
  // The charts draw the picked agents the answer on screen has, in their colour slots. A pick
  // the answer does not have yet (its read pending or failed) is not drawn: it has no figures,
  // and drawing it as "too few calls" or "not logged in" would say what is not known.
  const chartAgents: ChartAgent[] = response
    ? state.slots.flatMap((id, slot) => {
        if (id === null || !response.agents.some((c) => c.agent_user_id === id)) return [];
        const agent = opts?.agents.find((a) => a.agent_user_id === id);
        return [{ id, name: agent ? cohortAgentName(agent) : agentName(response, id), slot }];
      })
    : [];

  // ── Changes ──
  const setCampaign = (campaignId: string) => {
    setViewNote(null);
    update({ campaignId, slots: [...EMPTY_SLOTS], lens: null, metrics: null, trend: undefined, viewId: null });
  };
  const setWindow = (preset: CompareWindowPreset) =>
    update(preset === 'custom' ? { window: preset, from: dates?.from ?? today, to: dates?.to ?? today } : { window: preset, from: null, to: null });
  const setLens = (lens: CompareLens) => {
    setViewNote(null);
    update({ lens, metrics: null, trend: undefined, viewId: null });
  };
  // A note about what applying a view left out is about that moment: an edit, a save, a delete or
  // another campaign ends it, so it never outranks the note of what is on screen now.
  const setMetrics = (metrics: AgencyCompareMetricRef[]) => {
    if (!resolved) return;
    setViewNote(null);
    update({ lens: resolved.lens, metrics, trend: resolved.trend, viewId: resolved.viewId });
  };
  const setTrend = (trend: AgencyCompareMetricRef | null) => {
    if (!resolved) return;
    setViewNote(null);
    update({ lens: resolved.lens, metrics: resolved.metrics, trend, viewId: resolved.viewId });
  };
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
        subtitle={`Up to ${COMPARE_PAGE_MAX_AGENTS} agents of one campaign side by side, against the rest of its agents, for coaching.`}
        actions={
          state.campaignId && resolved ? (
            <CompareViews
              tenantId={tenantId}
              accountId={accountId}
              userId={userId}
              campaignId={state.campaignId}
              campaignName={opts?.campaign_name ?? campaign?.name ?? null}
              views={views}
              viewsFailed={viewsFailed}
              onRetryViews={() => {
                setViewsFailed(false);
                setViewsVersion((n) => n + 1);
              }}
              applied={appliedView}
              current={{ lens: resolved.lens, metrics: resolved.metrics, trend: resolved.trend }}
              onApply={applyView}
              onSaved={(view) => {
                setViewNote(null);
                setViewsVersion((n) => n + 1);
                update({ lens: view.lens, metrics: view.metrics, trend: view.trend ?? null, viewId: view.id });
              }}
              onChanged={() => setViewsVersion((n) => n + 1)}
              onDeleted={(viewId) => {
                setViewNote(null);
                setViewsVersion((n) => n + 1);
                setDeletedViews((prev) => new Set(prev).add(viewId));
                // "The page stays as it is": what the deleted view put on screen goes into the URL,
                // so a campaign default the page opened on (no metrics in the link) stays applied
                // as plain metrics rather than as a view that no longer exists.
                update({ lens: resolved.lens, metrics: resolved.metrics, trend: resolved.trend, viewId: null });
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
              <option value={state.campaignId}>
                {heldArchived ? pickerCampaignName(heldArchived) : (opts?.campaign_name ?? 'This campaign')}
              </option>
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
              {/* Toggle buttons, not tabs: a lens resets the metrics in place and opens no panel of its own. */}
              <div className={styles.lensTabs} role="group" aria-labelledby={`${ids}-lens`}>
                {COMPARE_LENSES.map((lens) => (
                  <button
                    key={lens}
                    type="button"
                    aria-pressed={resolved.lens === lens}
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
              aria-controls={pickerOpen ? `${ids}-picker` : undefined}
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

      {optionsFailed ? (
        <ReadError error={options.error} onRetry={options.retry} fallback="The campaign’s agents couldn’t be loaded." />
      ) : null}
      {options.status === 'loading' && !opts ? <LoadingSpinner /> : null}

      {opts ? (
        <section className={styles.card} aria-labelledby={`${ids}-agents`}>
          <div className={styles.pickHead}>
            <h2 className={styles.cardTitle} id={`${ids}-agents`}>
              {`Pick up to ${COMPARE_PAGE_MAX_AGENTS} agents`}
            </h2>
            <span className={styles.cardSub}>{`${opts.agents.length} took calls on ${opts.campaign_name} in this window`}</span>
          </div>
          <CompareAgentChips
            agents={opts.agents}
            slots={state.slots}
            onToggle={(id) => update({ slots: toggleAgent(keepAgents(state.slots, cohortIds), id) })}
          />
          {outOfCohort > 0 ? (
            <p className={styles.note} role="status">
              {outOfCohort === 1
                ? 'One picked agent didn’t take calls on this campaign in this window, so they are left out.'
                : `${outOfCohort} picked agents didn’t take calls on this campaign in this window, so they are left out.`}
            </p>
          ) : null}
        </section>
      ) : null}

      {response && chartAgents.length > 0 ? (
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

      {queryFailed ? (
        <ReadError error={result.error} onRetry={result.retry} fallback="The comparison couldn’t be worked out." />
      ) : null}
      {updating && pickedShown.length > 0 && (!response || chartAgents.length === 0) ? <LoadingSpinner /> : null}

      {response && chartAgents.length > 0 ? (
        <>
          {updating ? (
            <p className={styles.updating} role="status">
              Updating…
            </p>
          ) : null}
          {stale ? (
            <p className={styles.note} role="status" data-testid="compare-stale">
              {`These are the last figures that loaded, for ${windowWords(response.from, response.to)}, not for the choices above.`}
            </p>
          ) : null}
          <div className={styles.board}>
            <section className={styles.card} aria-labelledby={`${ids}-sbs`}>
              <div className={styles.cardHead}>
                <h2 className={styles.cardTitle} id={`${ids}-sbs`}>
                  Side by side
                </h2>
                <span className={styles.cardSub}>{`${plural(response.cohort.agents, 'agent')} on this campaign · as of ${asOfTime(response.as_of)}`}</span>
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
                {response.trend ? (
                  <span className={styles.cardSub}>{`${plural(response.trend.dates.length, 'day')} · dashed: team median`}</span>
                ) : null}
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

      {opts && opts.agents.length > 0 && pickedShown.length === 0 ? (
        <EmptyState
          icon={<Users size={32} />}
          title="Pick an agent to start"
          description="Their figures appear beside the rest of the campaign’s agents, with what stands out."
        />
      ) : null}
    </div>
  );
}

/** A window in words: "15 Nov to 21 Nov", or "21 Nov" for one day. */
export function windowWords(from: string, to: string): string {
  return from === to ? formatReportDay(from, false) : `${formatReportDay(from, false)} to ${formatReportDay(to, false)}`;
}

/**
 * Today in `zone`, kept current: read on every render, and the page re-renders when the day
 * turns (checked each minute, and when the tab is shown or focused again), so a page left open
 * past midnight moves Today, the presets and the date pickers' latest day with it. `now` (tests)
 * fixes the clock.
 */
function useToday(zone: string, now: Date | undefined): string {
  const [, setDay] = useState(() => todayIn(zone, now ?? new Date()));
  useEffect(() => {
    if (now) return;
    const check = () => setDay(todayIn(zone, new Date()));
    const timer = setInterval(check, 60_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') check();
    };
    window.addEventListener('focus', check);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [zone, now]);
  return todayIn(zone, now ?? new Date());
}

/** When the figures were read, as the console writes a time: "3:05 PM" (AS15). */
export function asOfTime(iso: string): string {
  return dateFormatter({ hour: 'numeric', minute: '2-digit', hour12: true })
    .format(new Date(iso))
    .replace(/\s*(am|pm)$/i, (_m, half: string) => ` ${half.toUpperCase()}`);
}

function ReadError({ error, onRetry, fallback }: { error: unknown; onRetry: () => void; fallback: string }) {
  // Only a failure that can clear by itself is offered again (`isRetryableCompareError`); any
  // other refusal needs the reader to change something first.
  const canRetry = isRetryableCompareError(error);
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
