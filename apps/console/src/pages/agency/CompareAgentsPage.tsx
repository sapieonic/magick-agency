import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Users } from 'lucide-react';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import {
  COMPARE_PAGE_MAX_AGENTS,
  type AgencyCompareQuery,
  type AgencyCompareView,
  type CompareLens,
} from '@magick-agency/contracts/api/agency/compare';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { COMPARE_SETTLE_MS, useCompareRead, useSettledKey } from '../../hooks/useCompareRead';
import { useRefetchOnReturn } from '../../hooks/useRefetchOnReturn';
import { useVisibleInterval } from '../../hooks/useVisibleInterval';
import { hasPermission } from '../../utils/permissions';
import { listAgencyCampaigns, listArchivedAgencyCampaigns } from '../../api/agencyCampaigns';
import { pickerCampaignName } from '../../utils/agencyCampaignArchive';
import { getCompareOptions, listCompareViews, queryCompare } from '../../api/compare';
import { CapabilityUnavailable } from '../../components/common/CapabilityUnavailable';
import { COMPARE_FLAG } from '../../utils/agency/compare/compareFlag';
import {
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
import { applyToCatalog, droppedNote } from '../../utils/agency/compare/compareMetrics';
import { resolveShape, type CompareShape } from '../../utils/agency/compare/compareShape';
import { defaultRosterCampaign } from '../../utils/agencyAgentRoster';
import { browserZone, todayIn } from '../../utils/reports/reportWindow';
import { CompareAgentChips, cohortAgentName } from '../../components/agency/compare/CompareAgentChips';
import { agentName } from '../../utils/agency/compare/compareFindingsCopy';
import { CompareBoard } from '../../components/agency/compare/CompareBoard';
import { CompareCard } from '../../components/agency/compare/CompareCard';
import { CompareFilters } from '../../components/agency/compare/CompareFilters';
import { CompareMetricPicker } from '../../components/agency/compare/CompareMetricPicker';
import { CompareReadError } from '../../components/agency/compare/CompareReadError';
import { CompareViews } from '../../components/agency/compare/CompareViews';
import type { ChartAgent } from '../../components/agency/compare/CompareCharts';
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

/** A lens, metrics, trend and view, as the URL holds them. */
type PinnedShape = Pick<CompareShape, 'lens' | 'metrics' | 'trend' | 'viewId'>;

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
  const pickerId = useId();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [viewNote, setViewNote] = useState<string | null>(null);
  // Views deleted on this page: a campaign default among them is never applied again from options
  // read before the delete.
  const [deletedViews, setDeletedViews] = useState<ReadonlySet<string>>(() => new Set());
  const scope = `${tenantId}/${accountId}`;

  // ── Campaigns ──
  const campaignsRead = useCompareRead(scope, () => listAgencyCampaigns(tenantId, accountId));
  const campaignsFailed = campaignsRead.status === 'error';
  const campaigns = campaignsFailed ? [] : campaignsRead.data;
  useEffect(() => {
    if (state.campaignId || !campaigns || campaigns.length === 0) return;
    const first = defaultRosterCampaign(campaigns);
    if (first) update({ campaignId: first });
  }, [state.campaignId, campaigns, update]);
  const campaign = campaigns?.find((c) => c.id === state.campaignId) ?? null;
  // A campaign the URL holds that the list leaves out may be archived since: it is named
  // "(archived)", as every other picker names one, rather than by its name alone.
  const heldMissing = campaigns !== null && state.campaignId !== null && campaign === null;
  const archived = useCompareRead(heldMissing ? scope : null, () => listArchivedAgencyCampaigns(tenantId, accountId));
  const heldArchived = heldMissing ? (archived.data?.find((c) => c.id === state.campaignId) ?? null) : null;

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
  // Another campaign's list is not this one's; a re-read after a save keeps the list (and the
  // applied view's buttons) on screen until the new one comes. A failed read is said, with a way
  // to read again: never "No saved views yet".
  const viewsKey = state.campaignId ? `${scope}/${state.campaignId}` : null;
  const viewsRead = useCompareRead(viewsKey, () =>
    listCompareViews({ campaign_id: state.campaignId! }, tenantId, accountId).then((list) => list.views),
  );
  const views = viewsRead.dataKey === viewsKey ? viewsRead.data : null;
  const viewsFailed = viewsRead.status === 'error' && viewsRead.doneKey === viewsKey;

  // ── The lens, metrics and trend: the URL's, else the campaign's default view, else the lens's ──
  const resolved = useMemo(
    () => (opts ? resolveShape({ lens: state.lens, metrics: state.metrics, trend: state.trend, viewId: state.viewId }, opts, codes, deletedViews) : null),
    [opts, codes, state.metrics, state.lens, state.trend, state.viewId, deletedViews],
  );

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
  // The answer on screen, when it has an agent to draw.
  const board = chartAgents.length > 0 ? response : null;

  // ── Changes ──
  // A note about what applying a view left out is about that moment: an edit, a save, a delete or
  // another campaign ends it, so it never outranks the note of what is on screen now.
  const edit = (patch: Partial<CompareUrlState>, note: string | null = null) => {
    setViewNote(note);
    update(patch);
  };
  // A lens, metrics, trend and view into the URL, so a link opens what is on screen.
  const pin = (shape: PinnedShape, note: string | null = null) =>
    edit({ lens: shape.lens, metrics: shape.metrics, trend: shape.trend, viewId: shape.viewId }, note);
  const setCampaign = (campaignId: string) =>
    edit({ campaignId, slots: [...EMPTY_SLOTS], lens: null, metrics: null, trend: undefined, viewId: null });
  const setWindow = (preset: CompareWindowPreset) =>
    update(preset === 'custom' ? { window: preset, from: dates?.from ?? today, to: dates?.to ?? today } : { window: preset, from: null, to: null });
  const setLens = (lens: CompareLens) => edit({ lens, metrics: null, trend: undefined, viewId: null });
  const applyView = (view: AgencyCompareView) => {
    const applied = applyToCatalog(view.metrics, view.trend, codes);
    if (applied.metrics.length === 0) {
      setViewNote(`“${view.name}” uses only outcomes this campaign doesn’t have, so it can’t be applied here.`);
      return;
    }
    pin({ lens: view.lens, metrics: applied.metrics, trend: applied.trend, viewId: view.id }, droppedNote(applied));
  };
  const longer = window ? longerWindow(state, today) : null;
  const checkLonger = longer ? () => update(longer) : undefined;

  const note = viewNote ?? resolved?.note ?? null;
  const queryError = queryFailed ? (
    <CompareReadError error={result.error} onRetry={result.retry} fallback="The comparison couldn’t be worked out." />
  ) : null;

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
              onRetryViews={viewsRead.retry}
              applied={appliedView}
              current={{ lens: resolved.lens, metrics: resolved.metrics, trend: resolved.trend }}
              onApply={applyView}
              onSaved={(view) => {
                viewsRead.retry();
                pin({ lens: view.lens, metrics: view.metrics, trend: view.trend, viewId: view.id });
              }}
              onChanged={viewsRead.retry}
              onDeleted={(viewId) => {
                viewsRead.retry();
                setDeletedViews((prev) => new Set(prev).add(viewId));
                // "The page stays as it is": what the deleted view put on screen goes into the URL,
                // so a campaign default the page opened on (no metrics in the link) stays applied
                // as plain metrics rather than as a view that no longer exists.
                pin({ ...resolved, viewId: null });
              }}
            />
          ) : null
        }
      />

      <CompareFilters
        campaigns={campaigns}
        campaignId={state.campaignId}
        heldName={heldArchived ? pickerCampaignName(heldArchived) : (opts?.campaign_name ?? 'This campaign')}
        onCampaign={setCampaign}
        when={state.window}
        from={state.from}
        to={state.to}
        today={today}
        onWindow={setWindow}
        onDates={update}
        dateError={dateError}
        shape={resolved ? { lens: resolved.lens, metricCount: resolved.metrics.length } : null}
        onLens={setLens}
        pickerOpen={pickerOpen}
        pickerId={pickerId}
        onTogglePicker={() => setPickerOpen((o) => !o)}
      />

      {resolved && pickerOpen ? (
        <CompareMetricPicker
          id={pickerId}
          metrics={resolved.metrics}
          trend={resolved.trend}
          codes={codes}
          onMetrics={(metrics) => pin({ ...resolved, metrics })}
          onTrend={(trend) => pin({ ...resolved, trend })}
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
        <CompareReadError error={options.error} onRetry={options.retry} fallback="The campaign’s agents couldn’t be loaded." />
      ) : null}
      {options.status === 'loading' && !opts ? <LoadingSpinner /> : null}

      {opts ? (
        <CompareCard
          title={`Pick up to ${COMPARE_PAGE_MAX_AGENTS} agents`}
          sub={`${opts.agents.length} took calls on ${opts.campaign_name} in this window`}
          headClassName={styles.pickHead}
        >
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
        </CompareCard>
      ) : null}

      {board ? (
        <CompareBoard
          response={board}
          agents={chartAgents}
          codes={codes}
          timezone={zone}
          canListen={canListen}
          onLonger={checkLonger}
          updating={updating}
          stale={stale}
          error={queryError}
        />
      ) : (
        <>
          {queryError}
          {updating && pickedShown.length > 0 ? <LoadingSpinner /> : null}
        </>
      )}

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

/**
 * Today in `zone`, kept current: read on every render, and the page re-renders when the day
 * turns (checked each minute while the tab is shown, and when it is shown or focused again), so a
 * page left open past midnight moves Today, the presets and the date pickers' latest day with
 * it. `now` (tests) fixes the clock.
 */
function useToday(zone: string, now: Date | undefined): string {
  const [, setDay] = useState(() => todayIn(zone, now ?? new Date()));
  const check = () => {
    if (!now) setDay(todayIn(zone, new Date()));
  };
  useVisibleInterval(check, 60_000, !now);
  useRefetchOnReturn(check);
  return todayIn(zone, now ?? new Date());
}
