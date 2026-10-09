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
import { useToast } from '../../contexts/ToastContext';
import { getAgencyCampaign } from '../../api/agencyCampaigns';
import { downloadSpineCsv, getCampaignAttempts } from '../../api/agencySpine';
import { outcomeReportFilename } from '../../api/exportCsv';
import { hasPermission } from '../../utils/permissions';
import { getErrorMessage } from '../../utils/errors';
import {
  ATTEMPTS_DESCRIPTION,
  SPINE_PRIVACY_NOTE,
  agentCellCopy,
  dispositionLabel,
  exportTruncationNotice,
  formatSpineTimestamp,
  formatTalkTime,
  recordingCellCopy,
  recordingDisabledNote,
} from '../../utils/agencySpineCopy';
import { Breadcrumbs } from '../../components/common/Breadcrumbs';
import { CampaignTabs } from '../../components/agency/CampaignTabs';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { PageDescription } from '../../components/common/PageDescription';
import { FilterChip } from '../../components/agency/FilterChip';
import { FiltersCard } from '../../components/agency/FiltersCard';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
import {
  ATTEMPT_OUTCOME_LABELS,
  attemptOutcomeLabel,
  type AgencyAttempt,
  type AgencyAttemptFilters,
} from '../../types/agency-spine';
import type { AgencyCampaign } from '../../types/agency-campaign';
import spine from '../../components/agency/SpineListLayout.module.css';
import styles from './AgencyCampaignAttemptsPage.module.css';

const PAGE_SIZE = 50;

/**
 * The campaign's Attempts view — one row per dial.
 *
 * ── Why this is not `/app/calls/softphone/history` ─────────────────────────
 * Agency legs do land in `webrtc_calls`, so that page can show the ones that
 * connected. It cannot show the ones that did not: being a CALL list, an
 * attempt that was abandoned because no agent was free, or that failed before
 * it dialed, has no row there at all. Those are the rows a compliance question
 * is usually about, and this page is built on the attempt table so they appear.
 * That page is also gated on `calls.dialer` and has no campaign filter.
 *
 * ── A terminal campaign is the PRIMARY case ─────────────────────────────────
 * "What did this campaign do" is normally asked after the run. So nothing here
 * is gated on the campaign being live, there is no polling, and the filters that
 * matter on a finished campaign — the date range and the outcome — are
 * first-class controls rather than an afterthought.
 *
 * ── There is no total, deliberately ─────────────────────────────────────────
 * Counting a filtered set of up to a million rows costs a second scan on every
 * page, for a number that is stale before it renders on a live campaign. So the
 * page says "showing N" and offers "Load more" — never "N of M", which would be
 * a number the API cannot honestly produce.
 */
export function AgencyCampaignAttemptsPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const { tenantId, accountId, role } = useTenant();
  const { showToast, showErrorToast } = useToast();

  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);
  const [rows, setRows] = useState<AgencyAttempt[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Arriving from a contact's drill-down pins the view to that contact. Read
  // once into the applied filters rather than held as a separate mode, so the
  // export and the "load more" both carry it without a second code path.
  const pinnedContact = searchParams.get('contact_id');

  // Draft vs applied, so typing does not fire a request per keystroke and the
  // export is guaranteed to match exactly what is on screen.
  const [draftOutcomes, setDraftOutcomes] = useState<string[]>([]);
  const [draftPhone, setDraftPhone] = useState('');
  const [draftAgent, setDraftAgent] = useState('');
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [filters, setFilters] = useState<AgencyAttemptFilters>(
    pinnedContact ? { contact_id: pinnedContact } : {},
  );

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
    try {
      const page = await getCampaignAttempts(id, active, { limit: PAGE_SIZE }, tenantId, accountId);
      if (seq !== requestSeq.current) return;
      setRows(page.rows);
      setNextCursor(page.next_cursor);
    } catch (err: unknown) {
      if (seq !== requestSeq.current) return;
      setError(getErrorMessage(err, 'Could not load this campaign’s call attempts.'));
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [id, tenantId, accountId]);

  useEffect(() => {
    if (!id || !tenantId || !accountId) return;
    getAgencyCampaign(id, tenantId, accountId)
      // The attempts are the point of the page; a header that will not load is
      // not a reason to withhold them.
      .then(setCampaign)
      .catch(() => setCampaign(null));
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
    setFilters({
      ...(pinnedContact ? { contact_id: pinnedContact } : {}),
      ...(draftOutcomes.length > 0 ? { outcome: draftOutcomes } : {}),
      ...(draftPhone.trim() ? { phone: draftPhone.trim() } : {}),
      ...(draftAgent.trim() ? { agent_user_id: draftAgent.trim() } : {}),
      ...(draftFrom ? { from: new Date(`${draftFrom}T00:00:00`).toISOString() } : {}),
      // Inclusive of the chosen day: a supervisor picking "to 3 August" means
      // the end of the 3rd, and the off-by-one silently drops a whole day of a
      // compliance window.
      ...(draftTo ? { to: new Date(`${draftTo}T23:59:59.999`).toISOString() } : {}),
    });
  }, [pinnedContact, draftOutcomes, draftPhone, draftAgent, draftFrom, draftTo]);

  const clearFilters = useCallback(() => {
    setDraftOutcomes([]);
    setDraftPhone('');
    setDraftAgent('');
    setDraftFrom('');
    setDraftTo('');
    setFilters(pinnedContact ? { contact_id: pinnedContact } : {});
  }, [pinnedContact]);

  const filtered = useMemo(
    () => Boolean(
      filters.outcome?.length || filters.phone || filters.agent_user_id
      || filters.from || filters.to
      // `contact_id` counts, and leaving it out was a real defect: arriving
      // from a contact with no attempts on a campaign that dialled thousands,
      // the empty state read "No calls were placed — this campaign has not
      // dialed anyone yet." An empty result taken as a fact about the campaign
      // rather than about the query is the exact failure this surface exists
      // to prevent, arriving through the empty state instead of the table.
      || filters.contact_id,
    ),
    [filters],
  );

  // How many independent filter groups are APPLIED (not merely drafted), for
  // the small badge on the filter panel — a supervisor scanning back to this
  // page later should see at a glance that the view is narrowed, not have to
  // re-read every field to notice.
  const recordingNote = recordingDisabledNote(campaign);

  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.outcome?.length) n += 1;
    if (filters.phone) n += 1;
    if (filters.agent_user_id) n += 1;
    if (filters.from || filters.to) n += 1;
    return n;
  }, [filters]);

  // Caught here rather than sent: the server refuses it too (400), but telling the
  // supervisor before they press Apply is the difference between a correction
  // and a support ticket.
  const invertedRange = Boolean(draftFrom && draftTo && draftFrom > draftTo);

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[
          { label: 'Campaigns', href: '/agency/campaigns' },
          ...(campaign ? [{ label: campaign.name, href: `/agency/campaigns/${campaign.id}` }] : []),
          { label: 'Call attempts' },
        ]}
      />

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

      <header className={spine.header}>
        <div className={spine.headerCopy}>
          <span className={spine.titleIcon} aria-hidden="true"><PhoneOutgoing size={20} /></span>
          <h1 className={spine.title}>Call attempts</h1>
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
          <Link to={`/agency/campaigns/${id}/attempts`}>Show the whole campaign</Link>
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
                  placeholder="Whole number, or the last few digits"
                  onChange={(e) => setDraftPhone(e.target.value)}
                />
              </span>
            </label>
            <label className={spine.field}>
              <span className={spine.fieldLabel}>Agent</span>
              <span className={spine.inputWrap}>
                <User size={14} className={spine.inputIcon} aria-hidden="true" />
                <input
                  type="text"
                  className={spine.fieldInput}
                  value={draftAgent}
                  placeholder="Agent user id"
                  onChange={(e) => setDraftAgent(e.target.value)}
                />
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
            <div className={spine.filterActions}>
              <button type="button" className="btn-primary" onClick={applyFilters} disabled={invertedRange}>
                Apply
              </button>
              {filtered && (
                <button type="button" className="btn-secondary" onClick={clearFilters}>Clear</button>
              )}
            </div>
          </div>
      </FiltersCard>

      {error && <ErrorAlert message={error} onRetry={() => void load(filters)} />}

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
            {`Showing ${rows.length.toLocaleString()} attempt${rows.length === 1 ? '' : 's'}`
              + (nextCursor ? ' — there are more' : '')}
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
              : 'This campaign has not dialed anyone yet. Attempts appear here as they are placed, '
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
                        {dispositionLabel(attempt.disposition_code, campaign?.disposition_catalog)
                          ?? <span className={styles.mutedCell}>—</span>}
                        {attempt.dispositioned_on_behalf && (
                          <span className={styles.onBehalf} title="Filed by someone other than the agent on the call">
                            on behalf
                          </span>
                        )}
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
