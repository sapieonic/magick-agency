import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import {
  AlertCircle,
  Calendar,
  Download,
  ListChecks,
  MicOff,
  PhoneOutgoing,
  Play,
  RefreshCw,
  Search,
  User,
} from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useCampaignCrumbs } from '../../hooks/useCampaignCrumbs';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { getAgencyCampaign } from '../../api/agencyCampaigns';
import { listCampaignAgents } from '../../api/agency';
import { downloadSpineCsv, getCampaignAttempts } from '../../api/agencySpine';
import { outcomeReportFilename } from '../../api/exportCsv';
import { hasPermission } from '../../utils/permissions';
import { getErrorMessage } from '@magick-agency/web-ui/errors';
import {
  ATTEMPTS_DESCRIPTION,
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
import { CampaignTabs } from '../../components/agency/CampaignTabs';
import { CallLogViews } from '../../components/agency/CallLogViews';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { PageDescription } from '../../components/common/PageDescription';
import { FilterChip } from '../../components/agency/FilterChip';
import { AppliedFilterChips } from '../../components/agency/AppliedFilterChips';
import { FiltersCard } from '../../components/agency/FiltersCard';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
import {
  ATTEMPT_OUTCOME_LABELS,
  attemptOutcomeLabel,
  type AgencyAttempt,
  type AgencyAttemptFilters,
} from '../../types/agency-spine';
import type { AgencyAssignedAgent, AgencyCampaign } from '../../types/agency-campaign';
import spine from '../../components/agency/SpineListLayout.module.css';
import { attemptDateRange } from '../../utils/agencyAttemptFilters';
import {
  campaignAttemptAgentOptions,
  campaignAttemptFilterChips,
  campaignAttemptFilterRefusal,
  campaignAttemptFiltersFromParams,
  campaignAttemptFiltersToParams,
  isCampaignAttemptFiltered,
  phoneFilterUsable,
} from '../../utils/agencyCampaignAttemptParams';
import { formatCount } from '../../utils/format/number';
import styles from './AgencyCampaignAttemptsPage.module.css';
import { AttemptDispositionCell } from '../../components/agency/AttemptDispositionCell';

const PAGE_SIZE = 50;

/**
 * The campaign's Attempts view — one row per dial.
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
 * The first page asks for the exact total (`?include_total=1`): the server counts
 * the filtered set with the list's own predicate, once per filter change, not per
 * page. That is the number a drill-down is checked against, so it is shown as
 * "N attempts". Later pages keep it; a server that sends none leaves the count at
 * "showing N", never an "N of M" nothing counted.
 */
export function AgencyCampaignAttemptsPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const { tenantId, accountId, role } = useTenant();
  const { showToast, showErrorToast } = useToast();

  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);
  useCampaignCrumbs(id, campaign, 'attempts');
  const [rows, setRows] = useState<AgencyAttempt[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [total, setTotal] = useState<number | null>(null);
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
  const filters = useMemo(() => campaignAttemptFiltersFromParams(searchParams), [searchParams]);
  const pinnedContact = filters.contact_id ?? null;

  /** Applied filters → the URL. The single writer. */
  const applyToUrl = useCallback((next: AgencyAttemptFilters) => {
    setSearchParams(campaignAttemptFiltersToParams(next));
  }, [setSearchParams]);

  // Draft vs applied, so typing does not fire a request per keystroke and the
  // export is guaranteed to match exactly what is on screen.
  const [draftOutcomes, setDraftOutcomes] = useState<string[]>(() => filters.outcome ?? []);
  const [draftPhone, setDraftPhone] = useState(() => filters.phone ?? '');
  const [draftAgent, setDraftAgent] = useState(() => filters.agent_user_id ?? '');
  const [draftFrom, setDraftFrom] = useState(() => dayOf(filters.from));
  const [draftTo, setDraftTo] = useState(() => dayOf(filters.to));

  // A link (or the back button) changes the applied set: the form follows it, or
  // the panel shows controls that disagree with the list and Apply silently
  // undoes the link.
  useEffect(() => {
    setDraftOutcomes(filters.outcome ?? []);
    setDraftPhone(filters.phone ?? '');
    setDraftAgent(filters.agent_user_id ?? '');
    setDraftFrom(dayOf(filters.from));
    setDraftTo(dayOf(filters.to));
  }, [filters]);

  const canExport = hasPermission(role, 'agency.supervise');

  /**
   * Guards against a slow first page landing after a newer one — without it,
   * changing a filter twice quickly can leave the earlier response's rows under
   * the later filter's controls, which reads as rows that do not match the query
   * rather than as a race.
   */
  const requestSeq = useRef(0);

  const load = useCallback(async (active: AgencyAttemptFilters) => {
    if (!id || !tenantId || !accountId) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    setFilterRefused(false);
    try {
      const page = await getCampaignAttempts(
        id, active, { limit: PAGE_SIZE, includeTotal: true }, tenantId, accountId,
      );
      if (seq !== requestSeq.current) return;
      setRows(page.rows);
      setNextCursor(page.next_cursor);
      setTotal(typeof page.total === 'number' ? page.total : null);
    } catch (err: unknown) {
      if (seq !== requestSeq.current) return;
      /*
        The rows on screen belong to the PREVIOUS filters. Left under the new chips and the
        error they read as the filtered answer: "Agent: hari" above all 284 rows, every
        agent among them. A failed load shows no rows.
      */
      setRows([]);
      setNextCursor(null);
      setTotal(null);
      const refusal = campaignAttemptFilterRefusal(err);
      setFilterRefused(refusal !== null);
      setError(refusal ?? getErrorMessage(err, 'Could not load this campaign’s call attempts.'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [id, tenantId, accountId]);

  useEffect(() => {
    /*
      The route has no `key`, so moving to another campaign (or account) keeps this page mounted:
      drop the previous campaign's header and agents at once, or the Agent picker offers them
      until the new answer lands, and ignore an answer that lands after the move.
    */
    setCampaign(null);
    setAssignedAgents([]);
    if (!id || !tenantId || !accountId) return;
    let live = true;
    getAgencyCampaign(id, tenantId, accountId)
      // The attempts are the point of the page; a header that will not load is
      // not a reason to withhold them.
      .then((answer) => { if (live) setCampaign(answer); })
      .catch(() => { if (live) setCampaign(null); });
    listCampaignAgents(id, tenantId, accountId)
      .then((answer) => { if (live) setAssignedAgents(answer.agents ?? []); })
      .catch(() => { if (live) setAssignedAgents([]); });
    return () => {
      live = false;
    };
  }, [id, tenantId, accountId]);

  useEffect(() => {
    void load(filters);
  }, [load, filters]);

  const onLoadMore = useCallback(async () => {
    if (!id || !nextCursor || loadingMore) return;
    const seq = requestSeq.current;
    setLoadingMore(true);
    try {
      const page = await getCampaignAttempts(
        id, filters, { cursor: nextCursor, limit: PAGE_SIZE },
        tenantId ?? undefined, accountId ?? undefined,
      );
      // A filter change mid-request would make these rows belong to a different
      // query than the ones already on screen.
      if (seq !== requestSeq.current) return;
      setRows((current) => [...current, ...page.rows]);
      setNextCursor(page.next_cursor);
    } catch (err: unknown) {
      showErrorToast(err, 'Could not load more attempts.');
    } finally {
      setLoadingMore(false);
    }
  }, [id, nextCursor, loadingMore, filters, tenantId, accountId, showErrorToast]);

  const onExport = useCallback(async () => {
    if (!id) return;
    setExporting(true);
    try {
      const result = await downloadSpineCsv(
        id, 'attempts',
        filters as Record<string, string | string[] | undefined>,
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
      showErrorToast(err, 'Could not export these attempts.');
    } finally {
      setExporting(false);
    }
  }, [id, filters, campaign, tenantId, accountId, showToast, showErrorToast]);

  const applyFilters = useCallback(() => {
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
    });
  }, [filters, applyToUrl, draftOutcomes, draftPhone, draftAgent, draftFrom, draftTo]);

  const clearFilters = useCallback(() => {
    applyToUrl(pinnedContact ? { contact_id: pinnedContact } : {});
  }, [applyToUrl, pinnedContact]);

  // `contact_id` counts, and leaving it out was a real defect: arriving from a
  // contact with no attempts on a campaign that dialled thousands, the empty
  // state read "No calls were placed — this campaign has not dialed anyone yet."
  // An empty result taken as a fact about the campaign rather than about the
  // query is the exact failure this surface exists to prevent. Every URL key
  // counts, by construction.
  const filtered = useMemo(() => isCampaignAttemptFiltered(filters), [filters]);

  const agentOptions = useMemo(
    () => campaignAttemptAgentOptions(assignedAgents, rows, filters.agent_user_id),
    [assignedAgents, rows, filters.agent_user_id],
  );

  const chips = useMemo(() => campaignAttemptFilterChips(filters, {
    dispositionLabel: (code) => dispositionLabel(code, campaign?.disposition_catalog),
    agentName: (userId) => agentOptions.find((option) => option.id === userId)?.name ?? null,
  }), [filters, campaign, agentOptions]);

  const removeChip = useCallback((chipId: string) => {
    const chip = chips.find((c) => c.id === chipId);
    if (chip) applyToUrl(chip.without);
  }, [chips, applyToUrl]);

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
    return n;
  }, [filters]);

  // Caught here rather than sent: the server refuses it too (400), but telling the
  // supervisor before they press Apply is the difference between a correction
  // and a support ticket.
  const invertedRange = Boolean(draftFrom && draftTo && draftFrom > draftTo);
  // The server's rule too (a phone filter needs a digit), said here before Apply.
  const phoneUnusable = !phoneFilterUsable(draftPhone);

  return (
    <div className={styles.page}>

      {/*
        The campaign workspace's section bar, in the same slot on every one of
        its screens. These four sections used to be reachable only
        as secondary buttons on the detail page's header row — the same row
        that carries Stop — so getting from Contacts to Call attempts meant
        going back through the campaign first.
      */}
      {id && (
        <CampaignTabs campaignId={id} active="attempts" role={role} campaignStatus={campaign?.status} />
      )}

      {/* Dialler calls | Soft-phone calls (decision IN14); nothing when only this view is open. */}
      {id && <CallLogViews campaignId={id} active="attempts" role={role} />}

      <header className={spine.header}>
        <div className={spine.headerCopy}>
          <span className={spine.titleIcon} aria-hidden="true"><PhoneOutgoing size={20} /></span>
          <h1 className={spine.title}>Call log</h1>
          {campaign && <AgencyCampaignStatusBadge status={campaign.status} />}
        </div>
        <div className={spine.actions}>
          <button
            type="button"
            className={`${spine.actionButton} btn-secondary`}
            onClick={() => void load(filters)}
            disabled={loading}
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
              title="Download everything matching the filters above, not just the rows on screen"
            >
              <Download size={16} />
              {exporting ? 'Preparing…' : 'Export CSV'}
            </button>
          )}
        </div>
      </header>

      <PageDescription
        pageKey="agency-campaign-attempts"
        description={ATTEMPTS_DESCRIPTION}
        tips={[
          'Attempts with no agent are real rows — the call was abandoned, failed, or never answered.',
          'A recording is only kept for a call that actually connected, and only while the call itself is kept.',
          'Export CSV downloads everything matching the filters, not just the rows on screen.',
        ]}
      />

      {pinnedContact && (
        <p className={styles.pinnedNote} data-testid="attempts-pinned-contact">
          Showing only this contact’s attempts.{' '}
          <Link to={`/agency/campaigns/${id}/attempts${withQuery(campaignAttemptFiltersToParams({ ...filters, contact_id: undefined }))}`}>
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
            </div>
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
                  aria-invalid={phoneUnusable || undefined}
                  onChange={(e) => setDraftPhone(e.target.value)}
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
          </div>

          <div className={spine.filterFooter}>
            {invertedRange && (
              <p className={spine.filterError} role="alert" data-testid="attempts-inverted-range">
                <AlertCircle size={13} aria-hidden="true" />
                The “From” date is after the “To” date, so nothing could match. Swap them to continue.
              </p>
            )}
            {phoneUnusable && (
              <p className={spine.filterError} role="alert" data-testid="attempts-phone-unusable">
                <AlertCircle size={13} aria-hidden="true" />
                Type at least one digit of the phone number.
              </p>
            )}
            <div className={spine.filterActions}>
              <button type="button" className="btn-primary" onClick={applyFilters} disabled={invertedRange || phoneUnusable}>
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
        chips={chips.filter((chip) => chip.id !== 'contact_id')}
        onRemove={removeChip}
        testIdPrefix="attempts"
      />

      {error && <ErrorAlert message={error} onRetry={filterRefused ? undefined : () => void load(filters)} />}

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
            {attemptsCountCopy(rows.length, total, nextCursor !== null)}
          </>
        )}
      </p>

      {loading && <LoadingSpinner />}

      {!loading && rows.length === 0 && !error && (
        <EmptyState
          icon={<PhoneOutgoing size={32} />}
          title={filtered ? 'Nothing matches those filters' : 'No calls were placed'}
          description={
            filtered
              ? 'Widen the date range or clear the filters to see every attempt.'
              : 'This campaign has not dialled anyone yet. Attempts appear here as they are placed, '
                + 'including the ones that never reach an agent.'
          }
        />
      )}

      {!loading && rows.length > 0 && (
        <>
          <div className={spine.tableWrap}>
            <table className={spine.table}>
              <caption className={styles.srOnly}>
                {`Call attempts on ${campaign?.name ?? 'this campaign'}, newest first`}
              </caption>
              <thead>
                <tr>
                  <th>When</th>
                  <th>Number</th>
                  <th>Try</th>
                  <th>Agent</th>
                  <th>Outcome</th>
                  <th>Disposition</th>
                  <th>Talk time</th>
                  <th>Call</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((attempt) => {
                  const agent = agentCellCopy(attempt);
                  const noRecording = recordingCellCopy(attempt);
                  return (
                    <tr key={attempt.id} data-testid={`attempt-row-${attempt.id}`}>
                      <td className={styles.when}>{formatSpineTimestamp(attempt.created_at)}</td>
                      <td>
                        <Link
                          to={`/agency/campaigns/${id}/contacts/${attempt.contact_id}`}
                          className={styles.phoneLink}
                        >
                          {attempt.phone_e164}
                        </Link>
                      </td>
                      <td className={styles.numeric}>{attempt.attempt_number}</td>
                      <td className={agent.muted ? styles.mutedCell : undefined}>{agent.text}</td>
                      <td>
                        <span
                          className={styles.outcome}
                          data-outcome={attempt.outcome ?? 'unknown'}
                          data-testid={`attempt-outcome-${attempt.id}`}
                        >
                          {attemptOutcomeLabel(attempt.outcome)}
                        </span>
                      </td>
                      <td>
                        <AttemptDispositionCell
                          attempt={attempt}
                          catalog={campaign?.disposition_catalog}
                          placeholder="—"
                          testIdPrefix="attempt"
                        />
                      </td>
                      <td className={styles.numeric}>{formatTalkTime(attempt.talk_seconds)}</td>
                      <td>
                        {noRecording === null ? (
                          /*
                            A link, never an embedded player: the call may have
                            been purged since — the API keeps this id un-FK'd so the
                            attempt outlives the call — and the destination page
                            is where "no longer available" can be said properly.

                            Keyed on the ATTEMPT, not the call. That is what lets
                            the destination exist for a purged call at all: the
                            attempt is still here, and the page reads it and says
                            so. It is also what keeps the reader inside this shell.
                          */
                          <Link
                            to={`/agency/campaigns/${id}/attempts/${attempt.id}`}
                            className={styles.recordingLink}
                          >
                            <Play size={13} aria-hidden="true" />
                            Open call
                          </Link>
                        ) : (
                          <span className={styles.mutedCell}>{noRecording}</span>
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
                {loadingMore ? 'Loading…' : 'Load older attempts'}
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
 * The count line. With the server's exact total: "1,234 attempts — showing 50". Without one
 * (a server that does not send it): what is on screen, never an "N of M" nothing counted.
 */
function attemptsCountCopy(shown: number, total: number | null, more: boolean): string {
  const noun = (n: number) => `attempt${n === 1 ? '' : 's'}`;
  if (total !== null) {
    return `${formatCount(total)} ${noun(total)}` + (shown < total ? ` — showing ${formatCount(shown)}` : '');
  }
  return `Showing ${shown.toLocaleString()} ${noun(shown)}` + (more ? ' — there are more' : '');
}
