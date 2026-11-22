import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  Calendar,
  Download,
  ListChecks,
  Check,
  MicOff,
  Phone,
  PhoneOutgoing,
  Play,
  Voicemail,
  RefreshCw,
  Search,
  User,
} from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { SOFTPHONE_FLAG, useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { INBOUND_FLAG } from '../../utils/inbound/inboundFlag';
import { markMissedInboundCallHandled } from '../../api/inbound';
import { refreshMissedCallsCount } from '../../hooks/useMissedCallsCount';
import { inboundRefusalCopy } from '../../utils/inbound/inboundCopy';
import { softphonePrefillState } from '../../utils/softphone/prefill';
import { useCampaignCrumbs } from '../../hooks/useCampaignCrumbs';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { listCampaignAgents } from '../../api/agency';
import { downloadSpineCsv, getCampaignCallLog } from '../../api/agencySpine';
import { outcomeReportFilename } from '../../api/exportCsv';
import { hasPermission } from '../../utils/permissions';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import {
  PHONE_FILTER_PLACEHOLDER,
  SPINE_PRIVACY_NOTE,
  agentCellCopy,
  dispositionLabel,
  exportTruncationNotice,
  formatSpineTimestamp,
  formatTalkTime,
  recordingCellCopy,
  recordingDisabledNote,
} from '../../utils/agencySpineCopy';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { PageDescription } from '../../components/common/PageDescription';
import { FilterChip } from '../../components/agency/FilterChip';
import { AppliedFilterChips } from '../../components/agency/AppliedFilterChips';
import { FiltersCard } from '../../components/agency/FiltersCard';
import { CampaignWorkspace } from './campaign-detail/CampaignWorkspace';
import { ATTEMPT_OUTCOME_LABELS, type AgencyAttemptFilters } from '../../types/agency-spine';
import type {
  AgencyCallLogCounts,
  AgencyCallLogInboundRow,
  AgencyCallLogRow,
  AgencyCallLogStatus,
  AgencyCallLogTypeFilter,
} from '../../types/agency-call-log';
import type { AgencyAssignedAgent, AgencyCampaign, AgencyCampaignStats } from '../../types/agency-campaign';
import { showsSoftphone } from '../../utils/agencyCampaignPerformance';
import spine from '../../components/agency/SpineListLayout.module.css';
import { attemptDateRange } from '../../utils/agencyAttemptFilters';
import {
  campaignAttemptAgentOptions,
  campaignAttemptFilterChips,
  campaignAttemptFilterRefusal,
  campaignAttemptFiltersFromParams,
  isCampaignAttemptFiltered,
  phoneFilterUsable,
  phoneFilterDraftError,
  INVERTED_RANGE_COPY,
} from '../../utils/agencyCampaignAttemptParams';
import { formatCount } from '../../utils/format/number';
import {
  CALL_LOG_DESCRIPTION,
  CALL_LOG_INBOUND_OUTCOME_HINT,
  CALL_LOG_INBOUND_OUTCOME_OPTIONS,
  CALL_LOG_STATUS_HINT,
  CALL_LOG_STATUS_OPTIONS,
  TO_FOLLOW_UP_NOTE,
  callLogBadges,
  callLogCountCopy,
  callLogEmptyState,
  callLogOpening,
  callLogOutcomeFilterLabel,
  callLogOutcomePlaceholder,
  callLogParams,
  callLogRowKey,
  callLogRowPath,
  callLogStatusLabel,
  callLogTypeFacts,
  callLogTypeLabel,
  callLogViewFromParams,
  callLogWhatHappened,
  effectiveCallLogFilters,
  followUpCopy,
  inboundAgentCopy,
  isCallLogFiltered,
  isMissedInbound,
  isNotDialled,
  lastSevenDays,
  localDay,
  manualCallsRedirectPath,
  onOpeningView,
  pairedRowKey,
  selectedCallLogCount,
  softphoneAgentCopy,
  visibleCallLogChips,
  type CallLogView,
} from '../../utils/agency/callLog';
import styles from './AgencyCampaignAttemptsPage.module.css';
import { AttemptDispositionCell } from '../../components/agency/AttemptDispositionCell';

const PAGE_SIZE = 50;
/** The applied-filter chip of the soft-phone status (the attempt filters' chips have their own ids). */
const STATUS_CHIP = 'softphone_status';

/**
 * The campaign's Call log: one row per call, whatever it was (decisions CL1, CL11,
 * `docs/call-log.md`). The dialler's attempts, the soft-phone calls logged to the campaign and
 * the inbound calls filed under it are one list on one keyset, with type chips ("All · Dialler ·
 * Soft phone · Inbound") over it and **To follow up**, the campaign's missed calls that are still
 * open; a row opens the Call page of its own type. A missed call and the soft-phone call that
 * rang it back point at each other.
 *
 * ── What it opens on ────────────────────────────────────────────────────────
 * With no filter in the URL a live campaign's list shows today's calls, and an empty day
 * offers the last seven and every date. A finished or archived campaign opens on every date:
 * "what did this campaign do" is asked after the run, and today would be an empty page. Any
 * filter in the URL (an Insights number, one contact) means exactly what it says and is never
 * narrowed to today; `?dates=all` asks for every date (`utils/agency/callLog.ts`).
 *
 * ── Why this is built on attempts, not calls ───────────────────────────────
 * Agency legs do land in `agency_calls`, so a call list could show the ones that
 * connected. It cannot show the ones that did not: an attempt that was abandoned
 * because no agent was free, or that failed before it dialed, has no call row at
 * all. Those are the rows a compliance question is usually about, and this page
 * is built on the attempt table so they appear.
 *
 * ── A terminal campaign is the PRIMARY case ─────────────────────────────────
 * "What did this campaign do" is normally asked after the run. So nothing here
 * is gated on the campaign being live, there is no polling, and the filters that
 * matter on a finished campaign — the date range and the outcome — are
 * first-class controls rather than an afterthought.
 *
 * ── The filters are in the URL, and the total is asked for once ─────────────
 * Every filter is read from the query string and written back when it changes
 * (`agencyCampaignAttemptParams.ts`), so a number on the Insights tab opens this
 * list already narrowed, the back button undoes a filter, and the view can be
 * sent to a colleague. Each applied filter is a removable chip, including the
 * ones the form has no control for (a dialled window, a caller ID, a redial flag).
 *
 * The first page asks for the chips' counts (`?include_counts=1`): the server counts
 * the filtered set per type with the list's own predicates, once per filter change, not
 * per page. The count of the chip that is on is the number a drill-down is checked
 * against, so it is shown as "N calls". Later pages keep it; a server that sends none
 * leaves the count at "showing N", never an "N of M" nothing counted.
 */
export function AgencyCampaignAttemptsPage() {
  const { id } = useParams<{ id: string }>();
  if (!id) return null;

  /*
    In the campaign's workspace, like every campaign screen: its header (name, status,
    lifecycle), the health strip and the section bar.
  */
  return (
    <CampaignWorkspace campaignId={id} active="attempts">
      {(campaign, section) => (
        <AttemptsSection id={id} campaign={campaign} campaignLoading={section.loading} stats={section.stats} />
      )}
    </CampaignWorkspace>
  );
}

/**
 * The call log itself, given the workspace's campaign (see `CampaignWorkspace`) for names
 * only: the export's file, the dispositions, the recording note; and the workspace's stats,
 * for whether the campaign holds soft-phone calls.
 */
function AttemptsSection({ id, campaign, campaignLoading, stats }: {
  id: string;
  campaign: AgencyCampaign | null;
  /** The workspace is still reading the campaign: what the list opens on is not known yet. */
  campaignLoading: boolean;
  stats: AgencyCampaignStats | null;
}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const { tenantId, accountId, role } = useTenant();
  const { showToast, showErrorToast } = useToast();
  const navigate = useNavigate();

  useCampaignCrumbs(id, campaign, 'attempts');
  const [rows, setRows] = useState<AgencyCallLogRow[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  /** The chips' counts for the applied filters, from the first page. */
  const [counts, setCounts] = useState<AgencyCallLogCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The server refused the filters themselves: Retry would send them again, so none is offered. */
  const [filterRefused, setFilterRefused] = useState(false);
  const [exporting, setExporting] = useState(false);
  /** The campaign's assigned agents, for the Agent filter. A courtesy: rows still name the rest. */
  const [assignedAgents, setAssignedAgents] = useState<AgencyAssignedAgent[]>([]);

  /*
    ── The applied filters live in the URL; the drafts do not ────────────────
    Derived from the query string on every render rather than mirrored into
    state, so there is one answer to "what is applied" (the roster page's rule).
    Arriving from a contact's drill-down pins the view to that contact through
    the same path: `contact_id` is one more applied filter, so the export and
    "load more" carry it without a second code path.
  */
  const urlFilters = useMemo(() => campaignAttemptFiltersFromParams(searchParams), [searchParams]);
  /** The chip that is on, and whether every date was asked for: beside the filters, in the URL. */
  const view = useMemo(() => callLogViewFromParams(searchParams), [searchParams]);
  /**
   * What a URL with no filter opens on: today for a campaign that is live, every date for one
   * that has finished or is archived (`callLogOpening`). A value, not the campaign object: the
   * workspace hands over a new object on every poll, and the list must not be read again for it.
   * Null while the campaign is still being read; if it cannot be read, today.
   */
  const opening = campaign ? callLogOpening(campaign) : campaignLoading ? null : 'today';
  /** The reader's day the opening view shows. Taken again on Refresh, so it moves on past midnight. */
  const [today, setToday] = useState(() => localDay());
  /**
   * What the list is read with: the URL's filters, or on the opening view of a live campaign,
   * today. The form, the chips, the export and every page use this one set, so what is on
   * screen is what was asked for.
   */
  const filters = useMemo(
    () => effectiveCallLogFilters(urlFilters, view, opening ?? 'today', today),
    [urlFilters, view, opening, today],
  );
  /** The opening view of a campaign not read yet: nothing is asked for until it is known. */
  const awaitingOpening = opening === null && onOpeningView(urlFilters, view);
  const pinnedContact = filters.contact_id ?? null;
  const { type, status } = view;

  /** Filters and view → the URL. The single writer. */
  const writeUrl = useCallback((next: AgencyAttemptFilters, nextView: CallLogView) => {
    setSearchParams(callLogParams(next, nextView));
  }, [setSearchParams]);

  /**
   * An edit to the filters (Apply, a chip removed): the chip stays on. An edit that leaves no
   * filter at all asked for every date, and the URL says so (`dates=all`); without that an
   * emptied form would spring back to today.
   */
  const applyToUrl = useCallback((next: AgencyAttemptFilters, nextStatus: AgencyCallLogStatus | null = status) => {
    writeUrl(next, { type, allDates: true, status: nextStatus });
  }, [writeUrl, type, status]);

  const chooseType = useCallback((next: AgencyCallLogTypeFilter) => {
    writeUrl(urlFilters, { type: next, allDates: view.allDates, status });
  }, [writeUrl, urlFilters, view.allDates, status]);

  // Draft vs applied, so typing does not fire a request per keystroke and the
  // export is guaranteed to match exactly what is on screen.
  const [draftOutcomes, setDraftOutcomes] = useState<string[]>(() => filters.outcome ?? []);
  const [draftPhone, setDraftPhone] = useState(() => filters.phone ?? '');
  /** Apply was pressed on a phone filter with no digit: say so even for a bare "+". */
  const [phoneChecked, setPhoneChecked] = useState(false);
  const [draftAgent, setDraftAgent] = useState(() => filters.agent_user_id ?? '');
  const [draftFrom, setDraftFrom] = useState(() => dayOf(filters.from));
  const [draftTo, setDraftTo] = useState(() => dayOf(filters.to));
  const [draftStatus, setDraftStatus] = useState<AgencyCallLogStatus | ''>(() => status ?? '');

  // A link (or the back button) changes the applied set: the form follows it, or
  // the panel shows controls that disagree with the list and Apply silently
  // undoes the link.
  useEffect(() => {
    setDraftOutcomes(filters.outcome ?? []);
    setDraftPhone(filters.phone ?? '');
    setDraftAgent(filters.agent_user_id ?? '');
    setDraftFrom(dayOf(filters.from));
    setDraftTo(dayOf(filters.to));
    setDraftStatus(status ?? '');
  }, [filters, status]);

  const canExport = hasPermission(role, 'agency.supervise');
  /**
   * The export is the campaign's call log (SR6): its dials and the soft-phone calls logged to it,
   * each row's `source` column saying which. Said beside the button while the soft phone is on,
   * or whenever the campaign holds soft-phone calls (`/stats`, the SR5 rule the Analytics cards
   * use): the file carries them whatever the flag says now.
   */
  const softphoneOn = useFeatureFlagEnabled(SOFTPHONE_FLAG);
  const exportHoldsSoftphone = (type === 'all' || type === 'soft_phone') && (softphoneOn || showsSoftphone(stats, false));
  const exportTitle = exportHoldsSoftphone
    ? 'Download everything matching the filters above, not just the rows on screen, with the soft-phone calls logged to this campaign (its source column says which)'
    : 'Download everything matching the filters above, not just the rows on screen';
  const inboundOn = useFeatureFlagEnabled(INBOUND_FLAG);
  const availability = useMemo(() => ({ softphoneEnabled: softphoneOn, inboundEnabled: inboundOn }), [softphoneOn, inboundOn]);
  /** Mark handled is the Missed list's action, under its permission. */
  const canMarkHandled = hasPermission(role, 'agency.inbound.read');
  /** Call back opens the soft phone with the number on the pad: only where the viewer may dial from it. */
  const canCallBack = softphoneOn && hasPermission(role, 'agency.softphone.dial');
  /** The Missed row being marked handled, and a refusal said on its row. */
  const [marking, setMarking] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
  /** The other half of the pair under the pointer or the focus: a missed call and its call back light each other. */
  const [pairLit, setPairLit] = useState<string | null>(null);

  /**
   * Guards against a slow first page landing after a newer one — without it,
   * changing a filter twice quickly can leave the earlier response's rows under
   * the later filter's controls, which reads as rows that do not match the query
   * rather than as a race.
   */
  const requestSeq = useRef(0);
  /**
   * What the counts on screen were counted for (campaign, filters, status). The chip is not in
   * it: the counts are of every type whatever chip is on, so choosing a chip reads the rows
   * again and keeps the counts.
   */
  const countedFor = useRef<string | null>(null);

  const load = useCallback(async (
    active: AgencyAttemptFilters,
    chip: AgencyCallLogTypeFilter,
    activeStatus: AgencyCallLogStatus | null,
    recount = false,
  ) => {
    if (!id || !tenantId || !accountId) return;
    const seq = ++requestSeq.current;
    const countKey = JSON.stringify([id, tenantId, accountId, active, activeStatus]);
    const includeCounts = recount || countedFor.current !== countKey;
    setLoading(true);
    setError(null);
    setFilterRefused(false);
    try {
      const page = await getCampaignCallLog(
        id, active,
        { limit: PAGE_SIZE, type: chip, ...(activeStatus ? { status: activeStatus } : {}), ...(includeCounts ? { includeCounts: true } : {}) },
        tenantId, accountId,
      );
      if (seq !== requestSeq.current) return;
      setRows(page.rows);
      setNextCursor(page.next_cursor);
      if (includeCounts) {
        setCounts(page.counts ?? null);
        countedFor.current = page.counts ? countKey : null;
      }
    } catch (err: unknown) {
      if (seq !== requestSeq.current) return;
      /*
        The rows on screen belong to the PREVIOUS filters. Left under the new chips and the
        error they read as the filtered answer: "Agent: hari" above all 284 rows, every
        agent among them. A failed load shows no rows.
      */
      setRows([]);
      setNextCursor(null);
      setCounts(null);
      countedFor.current = null;
      const refusal = campaignAttemptFilterRefusal(err);
      setFilterRefused(refusal !== null);
      setError(refusal ?? getErrorMessage(err, 'Could not load this campaign’s call log.'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [id, tenantId, accountId]);

  useEffect(() => {
    /*
      The route has no `key`, so moving to another campaign (or account) keeps this page mounted:
      drop the previous campaign's agents at once, or the Agent picker offers them until the new
      answer lands, and ignore an answer that lands after the move. (The campaign itself is the
      workspace's, which hands over only the campaign the URL names.)
    */
    setAssignedAgents([]);
    if (!id || !tenantId || !accountId) return;
    let live = true;
    listCampaignAgents(id, tenantId, accountId)
      .then((answer) => { if (live) setAssignedAgents(answer.agents ?? []); })
      .catch(() => { if (live) setAssignedAgents([]); });
    return () => {
      live = false;
    };
  }, [id, tenantId, accountId]);

  useEffect(() => {
    if (awaitingOpening) return;
    void load(filters, type, status);
  }, [load, filters, type, status, awaitingOpening]);

  /**
   * Refresh: the list and its counts again. On the opening view the day is taken again first,
   * so a list left open past midnight shows the new day (the changed filters are the reload).
   */
  const refresh = useCallback(() => {
    const now = localDay();
    if (now !== today) {
      countedFor.current = null;
      setToday(now);
      if (onOpeningView(urlFilters, view) && opening === 'today') return;
    }
    void load(filters, type, status, true);
  }, [today, urlFilters, view, opening, load, filters, type, status]);

  const onLoadMore = useCallback(async () => {
    if (!id || !nextCursor || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const page = await getCampaignCallLog(
        id, filters, { cursor: nextCursor, limit: PAGE_SIZE, type, ...(status ? { status } : {}) },
        tenantId ?? undefined, accountId ?? undefined,
      );
      // A filter change mid-request would make these rows belong to a different
      // query than the ones already on screen.
      if (seq !== requestSeq.current) return;
      setRows((current) => [...current, ...page.rows]);
      setNextCursor(page.next_cursor);
    } catch (err: unknown) {
      showErrorToast(err, 'Could not load older calls.');
    } finally {
      setLoadingMore(false);
    }
  }, [id, nextCursor, loadingMore, filters, type, status, tenantId, accountId, showErrorToast]);

  /**
   * Mark handled: the Missed list's own action (`POST /inbound/missed/:id/handled`, idempotent).
   * The list and its counts are read again, so the row leaves To follow up and every chip agrees.
   */
  const markHandled = useCallback(async (row: AgencyCallLogInboundRow) => {
    if (marking) return;
    setMarking(row.id);
    setRowError(null);
    const result = await markMissedInboundCallHandled(row.id, tenantId ?? undefined, accountId ?? undefined);
    setMarking(null);
    if (!result.ok) {
      setRowError({ id: row.id, message: inboundRefusalCopy(result.refusal) });
      return;
    }
    refreshMissedCallsCount();
    void load(filters, type, status, true);
  }, [marking, tenantId, accountId, load, filters, type, status]);

  /**
   * Call back: the soft phone with the caller's number on the pad, this campaign as "Log to",
   * and the missed call's id, so the call placed is linked to it (CL1). Nothing is dialled until
   * the agent presses Call.
   */
  const callBack = useCallback((row: AgencyCallLogInboundRow) => {
    if (!row.phone_e164) return;
    navigate('/dialer/phone', {
      state: softphonePrefillState({ number: row.phone_e164, campaignId: row.campaign_id, inboundCallId: row.id }),
    });
  }, [navigate]);

  const onExport = useCallback(async () => {
    if (!id) return;
    setExporting(true);
    try {
      // The file is what the list shows: its filters (the dates among them), its soft-phone
      // status, and its chip as the export's `source`.
      const result = await downloadSpineCsv(
        id, 'attempts',
        { ...filters, ...(status ? { status } : {}), ...(type !== 'all' ? { source: type } : {}) } as Record<string, string | string[] | undefined>,
        tenantId ?? undefined, accountId ?? undefined,
      );
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      // Campaign names are free text and routinely carry `/`, `:` and `?`,
      // which browsers reject or mangle in `download` — so the name goes
      // through the same sanitiser the other exports use. The prefix is applied
      // OUTSIDE it on purpose: sanitised as part of the name, a campaign called
      // `///` would strip to a bare `attempts.csv` and lose the only thing
      // identifying which campaign the file came from.
      link.download = `attempts-${outcomeReportFilename(campaign?.name ?? null, id)}`;
      link.click();
      URL.revokeObjectURL(url);
      if (result.truncated) {
        // Not a success toast with a footnote: a large campaign truncates by
        // design, and an operator who reads this as "done" hands over a file
        // that is missing most of the campaign.
        showToast(
          exportTruncationNotice(result.reason, result.rowLimit, result.rows, 'attempts'),
          'error',
        );
      } else {
        showToast('Export downloaded.', 'success');
      }
    } catch (err: unknown) {
      showErrorToast(err, 'Could not export these calls.');
    } finally {
      setExporting(false);
    }
  }, [id, filters, type, status, campaign, tenantId, accountId, showToast, showErrorToast]);

  const applyFilters = useCallback(() => {
    // A phone filter with no digit is refused by the server: said under the field, not sent.
    if (!phoneFilterUsable(draftPhone)) {
      setPhoneChecked(true);
      return;
    }
    // The form's five controls are rebuilt from the drafts; every filter the form
    // has no control for (a link's dialled window, caller ID, flags, write-up,
    // contact) is kept, so Apply narrows a drill-down rather than undoing it.
    const {
      outcome: _outcome, phone: _phone, agent_user_id: _agent, from: _from, to: _to, ...kept
    } = filters;
    void _outcome; void _phone; void _agent; void _from; void _to;
    applyToUrl({
      ...kept,
      ...(draftOutcomes.length > 0 ? { outcome: draftOutcomes } : {}),
      ...(draftPhone.trim() ? { phone: draftPhone.trim() } : {}),
      ...(draftAgent.trim() ? { agent_user_id: draftAgent.trim() } : {}),
      // Inclusive of both chosen days, in the viewer's zone, DST-safe
      // (`attemptDateRange`): "to 3 August" means the end of the 3rd, and the
      // off-by-one silently drops a whole day of a compliance window.
      ...attemptDateRange(draftFrom, draftTo),
    }, draftStatus === '' ? null : draftStatus);
  }, [filters, applyToUrl, draftOutcomes, draftPhone, draftAgent, draftFrom, draftTo, draftStatus]);

  /** Clear: back to the opening view (or the pinned contact), the chip kept. */
  const clearFilters = useCallback(() => {
    writeUrl(pinnedContact ? { contact_id: pinnedContact } : {}, { type, allDates: false, status: null });
  }, [writeUrl, pinnedContact, type]);

  /** An empty day's first way out: the last seven days, today included. */
  const showLastSevenDays = useCallback(() => {
    const { from: _from, to: _to, ...kept } = filters;
    void _from; void _to;
    writeUrl({ ...kept, ...lastSevenDays() }, { type, allDates: false, status });
  }, [writeUrl, filters, type, status]);

  /** Its second: every date (the dates dropped, and the URL saying so). */
  const showAllDates = useCallback(() => {
    const { from: _from, to: _to, ...kept } = filters;
    void _from; void _to;
    writeUrl(kept, { type, allDates: true, status });
  }, [writeUrl, filters, type, status]);

  // `contact_id` counts, and leaving it out was a real defect: arriving from a
  // contact with no attempts on a campaign that dialled thousands, the empty
  // state read "No calls were placed — this campaign has not dialed anyone yet."
  // An empty result taken as a fact about the campaign rather than about the
  // query is the exact failure this surface exists to prevent. Every URL key
  // counts, by construction.
  const filtered = useMemo(() => isCallLogFiltered(urlFilters, view) || view.allDates, [urlFilters, view]);
  const typeChips = useMemo(() => visibleCallLogChips(counts, type, availability), [counts, type, availability]);
  const total = selectedCallLogCount(counts, type);
  const empty = useMemo(() => callLogEmptyState(filters, { type, status }), [filters, type, status]);
  /**
   * The Status filter is the soft phone's: offered while the soft phone is on, while the
   * filters match soft-phone calls, or while one is applied (so it can be seen and removed).
   */
  const offersStatus = softphoneOn || (counts?.soft_phone ?? 0) > 0 || status !== null;
  /**
   * What happened's inbound choices (Missed, Voicemail, Abandoned): offered while inbound is on,
   * while the filters match inbound calls, on an inbound view, or while one is applied.
   */
  const offersInboundOutcomes = inboundOn || (counts?.inbound ?? 0) > 0 || type === 'inbound' || type === 'to_follow_up'
    || (filters.outcome ?? []).some((value) => CALL_LOG_INBOUND_OUTCOME_OPTIONS.some((option) => option.value === value));
  /** Whether the list is already on the last seven days: the empty state then offers nothing it has done. */
  const onLastSevenDays = useMemo(() => {
    const week = lastSevenDays();
    return filters.from === week.from && filters.to === week.to;
  }, [filters]);

  const agentOptions = useMemo(
    () => campaignAttemptAgentOptions(assignedAgents, rows, filters.agent_user_id),
    [assignedAgents, rows, filters.agent_user_id],
  );

  const chips = useMemo(() => campaignAttemptFilterChips(filters, {
    dispositionLabel: (code) => dispositionLabel(code, campaign?.disposition_catalog),
    agentName: (userId) => agentOptions.find((option) => option.id === userId)?.name ?? null,
  }), [filters, campaign, agentOptions]);
  /** The attempt filters' chips, then the soft-phone status's. */
  const shownChips = useMemo(() => [
    // A What happened chip of an inbound choice says it in the filter's own words.
    ...chips.filter((chip) => chip.id !== 'contact_id').map((chip) => (chip.id.startsWith('outcome:')
      ? { ...chip, label: `Outcome: ${callLogOutcomeFilterLabel(chip.id.slice('outcome:'.length))}` }
      : chip)),
    ...(status ? [{ id: STATUS_CHIP, label: `Soft-phone status: ${callLogStatusLabel(status)}` }] : []),
  ], [chips, status]);

  const removeChip = useCallback((chipId: string) => {
    if (chipId === STATUS_CHIP) {
      applyToUrl(filters, null);
      return;
    }
    const chip = chips.find((c) => c.id === chipId);
    if (chip) applyToUrl(chip.without);
  }, [chips, applyToUrl, filters]);

  // How many independent filter groups are APPLIED (not merely drafted), for
  // the small badge on the filter panel — a supervisor scanning back to this
  // page later should see at a glance that the view is narrowed, not have to
  // re-read every field to notice.
  const recordingNote = recordingDisabledNote(campaign);

  // Groups, not values: three outcomes ticked is one narrowing. The pinned
  // contact has its own note above and is not counted here.
  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.outcome?.length) n += 1;
    if (filters.state?.length) n += 1;
    if (filters.disposition_code?.length) n += 1;
    if (filters.phone) n += 1;
    if (filters.agent_user_id) n += 1;
    if (filters.caller_id) n += 1;
    if (filters.redial) n += 1;
    if (filters.agent_manual) n += 1;
    if (filters.agent_reopened) n += 1;
    if (filters.override_applied) n += 1;
    if (filters.placed) n += 1;
    if (filters.dialed_from || filters.dialed_to) n += 1;
    if (filters.from || filters.to) n += 1;
    if (status) n += 1;
    return n;
  }, [filters, status]);

  // Caught here rather than sent: the server refuses it too (400), but telling the
  // supervisor before they press Apply is the difference between a correction
  // and a support ticket.
  const invertedRange = Boolean(draftFrom && draftTo && draftFrom > draftTo);
  // The server's rule too (a phone filter needs a digit), said here before Apply; a number
  // still being typed ("+") is said only once Apply is pressed (`phoneFilterDraftError`).
  const phoneError = phoneFilterDraftError(draftPhone, phoneChecked);

  return (
    <div>
      <header className={spine.header}>
        <div className={spine.headerCopy}>
          <span className={spine.titleIcon} aria-hidden="true"><PhoneOutgoing size={20} /></span>
          <h2 className={spine.title}>Call log</h2>
        </div>
        <div className={spine.actions}>
          <button
            type="button"
            className={`${spine.actionButton} btn-secondary`}
            onClick={refresh}
            disabled={loading}
            aria-label="Refresh call log"
          >
            <RefreshCw size={16} />
            Refresh
          </button>
          {canExport && (
            <button
              type="button"
              className={`${spine.actionButton} btn-secondary`}
              onClick={() => void onExport()}
              disabled={exporting || loading}
              title={exportTitle}
            >
              <Download size={16} />
              {exporting ? 'Preparing…' : 'Export CSV'}
            </button>
          )}
        </div>
      </header>

      <PageDescription
        pageKey="agency-campaign-attempts"
        description={CALL_LOG_DESCRIPTION}
        tips={[
          'A dialler call with no agent is a real row: the call was abandoned, failed, or never answered.',
          ...(inboundOn || (counts?.inbound ?? 0) > 0
            ? ['An inbound call is listed once it has ended. A missed call stays under To follow up until the customer is reached or someone marks it handled.']
            : []),
          'A recording is only kept for a call that actually connected, and only while the call itself is kept.',
          'Export CSV downloads everything matching the filters, not just the rows on screen.',
          'The export follows the dates shown above. Clear the dates to export every call on the campaign.',
          ...(exportHoldsSoftphone
            ? ['The export also holds the soft-phone calls logged to this campaign, marked soft_phone in its source column.']
            : []),
        ]}
      />

      {pinnedContact && (
        <p className={styles.pinnedNote} data-testid="attempts-pinned-contact">
          Showing only this contact’s calls.{' '}
          <Link to={`/agency/campaigns/${id}/attempts${withQuery(callLogParams({ ...filters, contact_id: undefined }, { type, allDates: true, status }))}`}>
            Show the whole campaign
          </Link>
        </p>
      )}

      <p className={styles.privacyNote}>{SPINE_PRIVACY_NOTE}</p>

      {/*
        Stated once, above the table, rather than discovered one row at a time.
        The Call column links every row to its drill-down and the tip above says
        a recording is kept for any call that connected — both true, and neither
        mentions that this campaign records nothing at all, which is the default.
      */}
      {recordingNote && (
        <p className={styles.recordingNote} data-testid="attempts-recording-off">
          <MicOff size={14} aria-hidden="true" />
          <span>{recordingNote}</span>
        </p>
      )}

      {/*
        The type chips, with how many calls the filters below match for each (the words Live
        calls uses). Not a filter in the card: choosing one keeps every filter and its count.
      */}
      {typeChips.length > 0 && (
        <div className={styles.typeChips} role="group" aria-label="Call type" data-testid="call-log-types">
          {typeChips.map((chip) => (
            <button
              key={chip.id}
              type="button"
              className={styles.typeChip}
              aria-pressed={type === chip.id}
              onClick={() => chooseType(chip.id)}
              data-testid={`call-log-type-${chip.id}`}
              data-warning={chip.warning ? '' : undefined}
            >
              {chip.id !== 'all' && !chip.warning && <span className={styles.typeSwatch} data-type={chip.id} aria-hidden="true" />}
              {chip.label}
              {chip.count !== null && <span className={styles.typeCount}>{formatCount(chip.count)}</span>}
            </button>
          ))}
        </div>
      )}
      {type === 'to_follow_up' && (
        <p className={styles.followUpNote} data-testid="call-log-follow-up-note">{TO_FOLLOW_UP_NOTE}</p>
      )}

      <FiltersCard activeCount={activeFilterCount}>
        <fieldset className={styles.outcomeFilter}>
            <legend className={spine.filterLegend}>What happened</legend>
            <div className={styles.outcomes}>
              {Object.entries(ATTEMPT_OUTCOME_LABELS).map(([value, label]) => (
                <FilterChip
                  key={value}
                  label={label}
                  checked={draftOutcomes.includes(value)}
                  onChange={(checked) => setDraftOutcomes((current) => (
                    checked ? [...current, value] : current.filter((item) => item !== value)
                  ))}
                />
              ))}
              {offersInboundOutcomes && CALL_LOG_INBOUND_OUTCOME_OPTIONS.map(({ value, label }) => (
                <FilterChip
                  key={value}
                  label={label}
                  checked={draftOutcomes.includes(value)}
                  onChange={(checked) => setDraftOutcomes((current) => (
                    checked ? [...current, value] : current.filter((item) => item !== value)
                  ))}
                />
              ))}
            </div>
            {offersInboundOutcomes && (
              <span className={styles.fieldHint} data-testid="call-log-inbound-outcome-hint">{CALL_LOG_INBOUND_OUTCOME_HINT}</span>
            )}
          </fieldset>

          <div className={spine.fieldRow}>
            <label className={spine.field}>
              <span className={spine.fieldLabel}>Phone number</span>
              <span className={spine.inputWrap}>
                <Search size={14} className={spine.inputIcon} aria-hidden="true" />
                <input
                  type="text"
                  className={spine.fieldInput}
                  value={draftPhone}
                  placeholder={PHONE_FILTER_PLACEHOLDER}
                  aria-invalid={phoneError !== null || undefined}
                  aria-describedby={phoneError !== null ? 'attempts-phone-unusable' : undefined}
                  onChange={(e) => {
                    setDraftPhone(e.target.value);
                    if (phoneFilterUsable(e.target.value)) setPhoneChecked(false);
                  }}
                />
              </span>
            </label>
            {/* Picked by name from the campaign's agents; the id is what is sent. */}
            <label className={spine.field}>
              <span className={spine.fieldLabel}>Agent</span>
              <span className={spine.inputWrap}>
                <User size={14} className={spine.inputIcon} aria-hidden="true" />
                <select
                  className={spine.fieldInput}
                  value={draftAgent}
                  onChange={(e) => setDraftAgent(e.target.value)}
                  data-testid="attempts-agent-filter"
                >
                  <option value="">All agents</option>
                  {agentOptions.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </select>
              </span>
            </label>
            <label className={spine.field}>
              <span className={spine.fieldLabel}>From date</span>
              <span className={spine.inputWrap}>
                <Calendar size={14} className={spine.inputIcon} aria-hidden="true" />
                <input
                  type="date"
                  className={spine.fieldInput}
                  value={draftFrom}
                  onChange={(e) => setDraftFrom(e.target.value)}
                />
              </span>
            </label>
            <label className={spine.field}>
              <span className={spine.fieldLabel}>To date</span>
              <span className={spine.inputWrap}>
                <Calendar size={14} className={spine.inputIcon} aria-hidden="true" />
                <input
                  type="date"
                  className={spine.fieldInput}
                  value={draftTo}
                  onChange={(e) => setDraftTo(e.target.value)}
                />
              </span>
            </label>
            {/*
              The campaign's old Soft-phone calls view had this filter. It is the soft phone's:
              a dialler call has no such status, so with one chosen only soft-phone calls are
              listed, and the hint says so before it is applied.
            */}
            {offersStatus && (
              <label className={spine.field}>
                <span className={spine.fieldLabel}>Soft-phone status</span>
                <span className={spine.inputWrap}>
                  <select
                    className={spine.fieldInput}
                    value={draftStatus}
                    onChange={(e) => setDraftStatus(e.target.value as AgencyCallLogStatus | '')}
                    aria-describedby="call-log-status-hint"
                    data-testid="call-log-status-filter"
                  >
                    <option value="">Any</option>
                    {CALL_LOG_STATUS_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </span>
                <span className={styles.fieldHint} id="call-log-status-hint">{CALL_LOG_STATUS_HINT}</span>
              </label>
            )}
          </div>

          <div className={spine.filterFooter}>
            {invertedRange && (
              <p className={spine.filterError} role="alert" data-testid="attempts-inverted-range">
                <AlertCircle size={13} aria-hidden="true" />
                {INVERTED_RANGE_COPY}
              </p>
            )}
            {phoneError !== null && (
              <p className={spine.filterError} role="alert" id="attempts-phone-unusable" data-testid="attempts-phone-unusable">
                <AlertCircle size={13} aria-hidden="true" />
                {phoneError}
              </p>
            )}
            <div className={spine.filterActions}>
              <button type="button" className="btn-primary" onClick={applyFilters} disabled={invertedRange || phoneError !== null}>
                Apply
              </button>
              {filtered && (
                <button type="button" className="btn-secondary" onClick={clearFilters}>Clear</button>
              )}
            </div>
          </div>
      </FiltersCard>

      {/* The pinned contact has its own note above, so it is not a chip twice. */}
      <AppliedFilterChips
        chips={shownChips}
        onRemove={removeChip}
        testIdPrefix="attempts"
      />

      {error && <ErrorAlert message={error} onRetry={filterRefused ? undefined : () => void load(filters, type, status, true)} />}

      {/*
        Mounted UNCONDITIONALLY. A screen reader only announces an `aria-live`
        region that was already in the accessibility tree when its contents
        changed; rendered inside the rows block it would unmount behind the
        spinner on every reload and remount full, so the one signal that a
        filter changed anything is the signal least likely to arrive.
      */}
      <p className={spine.count} data-testid="attempts-count" aria-live="polite" aria-atomic="true">
        {!loading && rows.length > 0 && (
          <>
            <ListChecks size={14} className={spine.countIcon} aria-hidden="true" />
            {callLogCountCopy(rows.length, total, nextCursor !== null)}
          </>
        )}
      </p>

      {(loading || awaitingOpening) && <LoadingSpinner />}

      {!loading && !awaitingOpening && rows.length === 0 && !error && (
        <EmptyState
          icon={<PhoneOutgoing size={32} />}
          title={empty.title}
          description={empty.description}
          action={
            empty.kind === 'dates' ? (
              <span className={styles.emptyActions}>
                {!onLastSevenDays && (
                  <button type="button" className="btn-secondary" onClick={showLastSevenDays} data-testid="call-log-last-7-days">
                    Show last 7 days
                  </button>
                )}
                <button type="button" className="btn-secondary" onClick={showAllDates} data-testid="call-log-all-dates">
                  Show all dates
                </button>
              </span>
            ) : empty.kind === 'filtered' && filtered ? (
              <button type="button" className="btn-secondary" onClick={clearFilters} data-testid="call-log-empty-clear">
                Clear
              </button>
            ) : undefined
          }
        />
      )}

      {!loading && !awaitingOpening && rows.length > 0 && (
        <>
          <div className={spine.tableWrap}>
            <table className={spine.table}>
              <caption className={styles.srOnly}>
                {`Calls on ${campaign?.name ?? 'this campaign'}, newest first`}
              </caption>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Type</th>
                  <th>Customer</th>
                  <th>Agent</th>
                  <th>What happened</th>
                  <th>Outcome</th>
                  <th>Talk time</th>
                  <th>Call</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const agent: { text: string; muted: boolean; detail?: string } = row.type === 'dialler'
                    ? agentCellCopy(row)
                    : row.type === 'inbound' ? inboundAgentCopy(row) : softphoneAgentCopy(row);
                  const happened = callLogWhatHappened(row);
                  const facts = callLogTypeFacts(row);
                  const badges = callLogBadges(row);
                  const path = callLogRowPath(row, id, availability);
                  // A dialler row with no media leg says why there is nothing to open.
                  const noRecording = row.type === 'dialler' ? recordingCellCopy(row) : null;
                  const key = callLogRowKey(row);
                  const pair = pairedRowKey(row);
                  const missed = row.type === 'inbound' && isMissedInbound(row) ? row : null;
                  const followUp = missed ? followUpCopy(missed) : null;
                  return (
                    <tr
                      key={key}
                      data-testid={`attempt-row-${row.id}`}
                      data-type={row.type}
                      data-not-dialled={isNotDialled(row) ? '' : undefined}
                      data-paired={pair ? '' : undefined}
                      data-pair-lit={pairLit === key ? '' : undefined}
                      className={[isNotDialled(row) ? styles.notDialled : '', pair ? styles.paired : ''].filter(Boolean).join(' ') || undefined}
                      onMouseEnter={pair ? () => setPairLit(pair) : undefined}
                      onMouseLeave={pair ? () => setPairLit(null) : undefined}
                      onFocus={pair ? () => setPairLit(pair) : undefined}
                      onBlur={pair ? () => setPairLit(null) : undefined}
                    >
                      <td className={styles.when}>{formatSpineTimestamp(row.created_at)}</td>
                      <td>
                        <span className={styles.type} data-type={row.type} data-testid={`call-type-${row.id}`}>
                          {callLogTypeLabel(row.type)}
                        </span>
                        {facts.length > 0 && (
                          <span className={styles.secondLine} data-testid={`call-facts-${row.id}`}>{facts.join(' · ')}</span>
                        )}
                        {badges.length > 0 && (
                          <span className={styles.badges}>
                            {badges.map((badge) => (
                              <span key={badge.label} className={styles.badge} title={badge.title}>{badge.label}</span>
                            ))}
                          </span>
                        )}
                      </td>
                      <td>
                        {row.phone_e164 === null ? (
                          <span className={styles.mutedCell}>Number withheld</span>
                        ) : row.contact_id ? (
                          <Link
                            to={`/agency/campaigns/${id}/contacts/${row.contact_id}`}
                            className={styles.phoneLink}
                          >
                            {row.phone_e164}
                          </Link>
                        ) : (
                          <>
                            <span className={styles.numeric}>{row.phone_e164}</span>
                            <span className={styles.secondLine}>not on the list</span>
                          </>
                        )}
                      </td>
                      <td>
                        <span className={agent.muted ? styles.mutedCell : undefined}>{agent.text}</span>
                        {agent.detail && (
                          <span className={styles.secondLine} data-testid={`call-assignee-${row.id}`}>{agent.detail}</span>
                        )}
                      </td>
                      <td>
                        <span
                          className={styles.outcome}
                          data-outcome={happened.key}
                          data-testid={`attempt-outcome-${row.id}`}
                        >
                          {happened.text}
                        </span>
                        {happened.detail && (
                          <span className={styles.secondLine} data-testid={`call-happened-detail-${row.id}`}>{happened.detail}</span>
                        )}
                      </td>
                      <td>
                        {missed && followUp ? (
                          /*
                            A missed call has no outcome of its own: this cell says where its
                            follow-up stands. Rung back ("Called back 3:31 PM", the pair's other
                            row), still owed ("To follow up", with the Missed list's two actions),
                            or closed.
                          */
                          <span className={styles.followUp} data-testid={`call-follow-up-${row.id}`}>
                            {followUp.calledBack && <span className={styles.calledBack}>{followUp.calledBack}</span>}
                            {followUp.status && (
                              <span className={followUp.open ? styles.toFollowUp : styles.mutedCell}>{followUp.status}</span>
                            )}
                            {followUp.open && (canMarkHandled || (canCallBack && missed.phone_e164)) && (
                              <span className={styles.rowActions}>
                                {canCallBack && missed.phone_e164 && (
                                  <button
                                    type="button"
                                    className={styles.rowAction}
                                    onClick={() => callBack(missed)}
                                    data-testid={`call-back-${row.id}`}
                                  >
                                    <Phone size={12} aria-hidden="true" />
                                    Call back
                                  </button>
                                )}
                                {canMarkHandled && (
                                  <button
                                    type="button"
                                    className={styles.rowAction}
                                    onClick={() => void markHandled(missed)}
                                    disabled={marking !== null}
                                    data-testid={`mark-handled-${row.id}`}
                                  >
                                    <Check size={12} aria-hidden="true" />
                                    {marking === row.id ? 'Marking…' : 'Mark handled'}
                                  </button>
                                )}
                              </span>
                            )}
                            {rowError?.id === row.id && (
                              <span className={styles.rowError} role="alert">
                                <AlertCircle size={12} aria-hidden="true" />
                                {rowError.message}
                              </span>
                            )}
                          </span>
                        ) : (
                          <AttemptDispositionCell
                            attempt={row.type === 'dialler' ? row : { ...row, auto_disposition_code: null }}
                            catalog={campaign?.disposition_catalog}
                            placeholder={callLogOutcomePlaceholder(row)}
                            testIdPrefix="attempt"
                          />
                        )}
                      </td>
                      <td className={styles.numeric}>{formatTalkTime(row.talk_seconds)}</td>
                      <td>
                        {noRecording !== null ? (
                          <span className={styles.mutedCell}>{noRecording}</span>
                        ) : path !== null ? (
                          /*
                            A link, never an embedded player: the call may have been purged
                            since (the API keeps the media leg's id un-FK'd so the row outlives
                            the call), and the destination page is where "no longer available"
                            can be said properly.

                            Keyed on the ROW (the attempt, the soft-phone call, the inbound
                            call), not the media leg. That is what lets the destination exist
                            for a purged call at all, and what keeps the reader inside this shell.

                            A missed call that left a voicemail says so: its Call page plays it.
                          */
                          <Link to={path} className={styles.recordingLink}>
                            {row.type === 'inbound' && row.voicemail_seconds !== null ? (
                              <>
                                <Voicemail size={13} aria-hidden="true" />
                                {`Voicemail ${formatTalkTime(row.voicemail_seconds)}`}
                              </>
                            ) : (
                              <>
                                <Play size={13} aria-hidden="true" />
                                Open call
                              </>
                            )}
                          </Link>
                        ) : (
                          <span className={styles.mutedCell}>—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {nextCursor && (
            <div className={spine.more}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void onLoadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load older calls'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default AgencyCampaignAttemptsPage;

/** A `YYYY-MM-DD` for a date picker from an instant the URL carries, in the viewer's zone. */
function dayOf(iso: string | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function withQuery(params: URLSearchParams): string {
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/**
 * `/agency/campaigns/:id/manual-calls`: the campaign's Soft-phone calls view until the Call log
 * became one list (CL11). Its links and bookmarks land on the Call log with the Soft phone chip
 * on and their query kept, replacing the entry so Back does not bounce.
 */
export function CampaignManualCallsRedirect() {
  const { id } = useParams<{ id: string }>();
  const { search } = useLocation();
  if (!id) return null;
  // Whatever the old link carried is kept, so a bookmarked filter survives the move.
  return <Navigate to={manualCallsRedirectPath(id, search)} replace />;
}
