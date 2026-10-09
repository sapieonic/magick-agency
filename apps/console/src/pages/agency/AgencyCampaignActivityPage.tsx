import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { AlertCircle, AlertTriangle, Calendar, Download, History, ListChecks, RefreshCw } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useToast } from '../../contexts/ToastContext';
import { getAgencyCampaign } from '../../api/agencyCampaigns';
import { downloadCampaignActivityCsv, getCampaignActivity } from '../../api/agencyActivity';
import { ApiError } from '../../api/client';
import { outcomeReportFilename } from '../../api/exportCsv';
import { hasPermission } from '../../utils/permissions';
import { getErrorMessage } from '../../utils/errors';
import {
  trackAgencyActivityFiltered,
  trackAgencyActivityLoadMore,
  trackAgencyActivityPartial,
  trackExportEvent,
} from '../../analytics/events';
import {
  ACTIVITY_SOURCE_LABEL,
  ACTIVITY_SOURCE_LEGEND,
  CLIENT_ACTOR_TOOLTIP,
  activityDetailSummary,
  activityTableCaption,
  formatActivityTimestamp,
  partialNotice,
  retentionNotice,
  truncationNotice,
} from '../../utils/agencyActivityCopy';
import { Breadcrumbs } from '../../components/common/Breadcrumbs';
import { CampaignTabs } from '../../components/agency/CampaignTabs';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { TruncatedId } from '../../components/common/TruncatedId';
import { PageDescription } from '../../components/common/PageDescription';
import { MultiSelectFilter } from '../../components/agency/MultiSelectFilter';
import { FiltersCard } from '../../components/agency/FiltersCard';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
import {
  activityActionLabel,
  activityActionLabels,
  activityActorKind,
  groupActivityActions,
  type ActivityFilters,
  type ActivityPage,
  type ActivityRow,
} from '../../types/agency-activity';
import type { AgencyCampaign } from '../../types/agency-campaign';
import spine from '../../components/agency/SpineListLayout.module.css';
import styles from './AgencyCampaignActivityPage.module.css';

const PAGE_SIZE = 50;

/**
 * The server's `partial_reason` (`src/types/agency-activity.ts`) is typed as a
 * bare `string`, but the two values master actually sends today are the exact
 * tokens `'core_unreachable'` and `'core_error'` (see `partialNotice` in
 * `agencyActivityCopy.ts`, and the fixtures in `AgencyCampaignActivityPage.
 * test.tsx`/`agencyActivityCopy.test.ts`) — never free-form prose. This is the
 * client-side allow-list: an EXACT match on either known token collapses to
 * the one bucketed reason a dashboard can chart; an unrecognised value (a
 * future reason master adds, or anything else) is `'other'` rather than
 * fabricating a match, so a wording change on master's side can never flip
 * this into the wrong bucket. No reason at all is `null`.
 */
function mapPartialReason(reason: string | null): 'core_unavailable' | 'other' | null {
  if (!reason) return null;
  return reason === 'core_unreachable' || reason === 'core_error' ? 'core_unavailable' : 'other';
}

/**
 * The 424 case (master refusing to write a file missing the dialer's half) is
 * the one failure this page already treats as an answer rather than a
 * transport error — see `onExport`'s catch comment — so it gets its own
 * `ExportFailureReason` rather than falling into `unknown_error`. Everything
 * else follows the same status/`TypeError` split used for network-vs-server
 * failures elsewhere in this codebase; there is no timeout signal on this
 * fetch (no `AbortController`), so that branch only fires if one is added later.
 */
function classifyExportFailureReason(
  err: unknown,
): 'timeout' | 'network_error' | 'permission_error' | 'incomplete_source' | 'unknown_error' {
  if (err instanceof ApiError) {
    if (err.statusCode === 424) return 'incomplete_source';
    if (err.statusCode === 403) return 'permission_error';
    if (err.statusCode === 408) return 'timeout';
    return 'unknown_error';
  }
  if (err instanceof DOMException && err.name === 'AbortError') return 'timeout';
  if (err instanceof TypeError) return 'network_error';
  return 'unknown_error';
}

/**
 * One hidden node carries `CLIENT_ACTOR_TOOLTIP` for every client-actor cell to
 * point at via `aria-describedby`. The text never varies row to row, so a
 * single shared id is enough — `aria-describedby` allows one id to be
 * referenced from many elements, and it avoids rendering the same sentence
 * once per row the way the old per-row `title` effectively did.
 */
const CLIENT_ACTOR_DESC_ID = 'activity-client-actor-desc';

/**
 * The campaign's Activity view — what happened during this run, who did it, and
 * when, without a database client.
 *
 * ── It lives in the agency workspace, not at `/app/audit-log` ────────────────
 * A supervisor should not have to leave the campaign to ask what happened to it,
 * and `/app/audit-log` is a different shell, tenant-wide, with no campaign
 * scoping. This page is reached from the campaign it is about.
 *
 * ── A terminal campaign is the PRIMARY case ─────────────────────────────────
 * The question "what happened during this run" is normally asked after the run.
 * So nothing here is gated on the campaign being live, there is no polling, and
 * the date-range filter — the one that matters on a finished campaign — is a
 * first-class control rather than an afterthought.
 *
 * ── Every gap is stated ─────────────────────────────────────────────────────
 * Three things could make this list shorter than the truth, and each says so in
 * words: `partial` (the dialer's half could not be loaded), the retention
 * horizon (older entries have been purged), and the export ceiling. An audit
 * view that silently omits rows is worse than one that says it is incomplete —
 * that is the whole design rule, and it is why none of the three is left to be
 * inferred from an absence.
 */
export function AgencyCampaignActivityPage() {
  const { id } = useParams<{ id: string }>();
  const { tenantId, accountId, role } = useTenant();
  const { showToast, showErrorToast } = useToast();

  const [campaign, setCampaign] = useState<AgencyCampaign | null>(null);
  const [page, setPage] = useState<ActivityPage | null>(null);
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  // Draft vs applied, so typing a date does not fire a request per keystroke and
  // the export can be guaranteed to match exactly what is on screen.
  const [draftActions, setDraftActions] = useState<string[]>([]);
  const [draftFrom, setDraftFrom] = useState('');
  const [draftTo, setDraftTo] = useState('');
  const [filters, setFilters] = useState<ActivityFilters>({});

  // How many independent filter groups are APPLIED, for the small badge on the
  // filter panel — a supervisor should see at a glance that the trail is
  // narrowed. Declared ahead of `onExport` (which reads it as the export's
  // `field_count`, this scope having no column selector) so a `useCallback`
  // deps array never captures it before its `useMemo` has initialised.
  const activeFilterCount = useMemo(() => {
    let n = 0;
    if (filters.actions?.length) n += 1;
    if (filters.from || filters.to) n += 1;
    return n;
  }, [filters]);

  const canExport = hasPermission(role, 'audit.read');

  /**
   * Guards against a slow first page landing after a newer one. Without it,
   * changing the filter twice in quick succession can leave the earlier
   * response's rows under the later filter's chips — which on an audit surface
   * reads as rows that do not match the query rather than as a race.
   */
  const requestSeq = useRef(0);

  const load = useCallback(
    async (activeFilters: ActivityFilters) => {
      if (!id || !tenantId || !accountId) return;
      const seq = ++requestSeq.current;
      setLoading(true);
      setError(null);
      try {
        const result = await getCampaignActivity(
          id,
          activeFilters,
          { limit: PAGE_SIZE },
          tenantId,
          accountId,
        );
        if (seq !== requestSeq.current) return;
        setPage(result);
        setRows(result.rows);
        if (result.partial) {
          trackAgencyActivityPartial({ campaign_id: id, reason: mapPartialReason(result.partial_reason) });
        }
      } catch (err: unknown) {
        if (seq !== requestSeq.current) return;
        setError(getErrorMessage(err, 'Could not load this campaign’s activity.'));
      } finally {
        if (seq === requestSeq.current) setLoading(false);
      }
    },
    [id, tenantId, accountId],
  );

  useEffect(() => {
    if (!id || !tenantId || !accountId) return;
    getAgencyCampaign(id, tenantId, accountId)
      .then(setCampaign)
      // The trail is the point of the page; a campaign header that will not load
      // is not a reason to withhold it.
      .catch(() => setCampaign(null));
  }, [id, tenantId, accountId]);

  useEffect(() => {
    void load(filters);
  }, [load, filters]);

  const onLoadMore = useCallback(async () => {
    if (!id || !page?.next_cursor || loadingMore) return;
    const seq = requestSeq.current;
    // The page index being fetched — the count of full pages already on screen.
    // Purely a `rows.length` derivation, not a separately-maintained counter, so
    // it cannot drift from what is actually rendered.
    const pageIndex = Math.floor(rows.length / PAGE_SIZE);
    setLoadingMore(true);
    try {
      const next = await getCampaignActivity(
        id,
        filters,
        { cursor: page.next_cursor, limit: PAGE_SIZE },
        tenantId ?? undefined,
        accountId ?? undefined,
      );
      // A filter change mid-request would make these rows belong to a different
      // query than the ones already on screen.
      if (seq !== requestSeq.current) return;
      if (next.partial) {
        trackAgencyActivityPartial({ campaign_id: id, reason: mapPartialReason(next.partial_reason) });
      }
      // `partial` is sticky for the session, not per page. A degraded first page
      // followed by a whole second one would otherwise REMOVE the banner while
      // page one's incomplete rows are still on screen — turning a stated gap
      // back into a silent one. Same for the retention horizon, which a partial
      // page reports as `null`.
      setPage((prev) => ({
        ...next,
        partial: (prev?.partial ?? false) || next.partial,
        partial_reason: prev?.partial ? prev.partial_reason : next.partial_reason,
        retention: next.retention ?? prev?.retention ?? null,
        // Kept from the page that had one. It is the same static list on every
        // response, so this only matters if one ever arrives without it — and
        // losing it would take the filter off screen mid-session, with the
        // supervisor's ticked boxes still applied to the rows below.
        available_actions: next.available_actions ?? prev?.available_actions,
      }));
      setRows((current) => [...current, ...next.rows]);
      trackAgencyActivityLoadMore({ campaign_id: id, page_index: pageIndex, failed: false });
    } catch (err: unknown) {
      showErrorToast(err, 'Could not load more of the trail.');
      trackAgencyActivityLoadMore({ campaign_id: id, page_index: pageIndex, failed: true });
    } finally {
      setLoadingMore(false);
    }
  }, [id, page, filters, loadingMore, rows.length, tenantId, accountId, showErrorToast]);

  const onExport = useCallback(async () => {
    if (!id) return;
    setExporting(true);
    // The export has no column selector — every field is always included — so
    // the closest thing to `field_count` this scope has is how many filter
    // groups narrowed what gets downloaded.
    const filterCount = activeFilterCount;
    trackExportEvent('csv_export_started', { scope: 'agency_activity', field_count: filterCount });
    try {
      const result = await downloadCampaignActivityCsv(
        id,
        filters,
        tenantId ?? undefined,
        accountId ?? undefined,
      );
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      // Campaign names are free text and routinely carry `/`, `:` and `?`,
      // which browsers reject or mangle in `download` — so the name goes
      // through the same sanitiser the outcome-report exports use rather than
      // straight into the attribute. The `activity-` prefix is applied OUTSIDE
      // it on purpose: sanitised as part of the name, a campaign called `///`
      // would strip down to a bare `activity.csv` and lose the only thing left
      // identifying which campaign the file came from, whereas outside it the
      // helper's own empty-after-sanitising fallback still reaches the id.
      link.download = `activity-${outcomeReportFilename(campaign?.name ?? null, id)}`;
      link.click();
      URL.revokeObjectURL(url);
      if (result.truncated) showToast(truncationNotice(result.rowLimit), 'error');
      else showToast('Export downloaded.', 'success');
      trackExportEvent('csv_export_succeeded', {
        scope: 'agency_activity',
        field_count: filterCount,
        truncated: result.truncated,
      });
    } catch (err: unknown) {
      // Master's 424 is an answer — it refused to write a file missing the
      // dialer's half — so its message is shown rather than a generic failure.
      showErrorToast(err, 'Could not export this trail.');
      trackExportEvent('csv_export_failed', {
        scope: 'agency_activity',
        field_count: filterCount,
        reason: classifyExportFailureReason(err),
      });
    } finally {
      setExporting(false);
    }
  }, [id, filters, campaign, tenantId, accountId, showToast, showErrorToast, activeFilterCount]);

  const applyFilters = useCallback(() => {
    setFilters({
      ...(draftActions.length > 0 ? { actions: draftActions } : {}),
      ...(draftFrom ? { from: new Date(`${draftFrom}T00:00:00`).toISOString() } : {}),
      // Inclusive of the chosen day: a supervisor picking "to 3 August" means
      // the end of the 3rd, not its first instant, and the off-by-one silently
      // drops a whole day of a compliance window.
      ...(draftTo ? { to: new Date(`${draftTo}T23:59:59.999`).toISOString() } : {}),
    });
    if (id) {
      trackAgencyActivityFiltered({
        campaign_id: id,
        action_filter_count: draftActions.length,
        has_date_range: Boolean(draftFrom || draftTo),
        // Equivalent to `actionGroups.length > 0` (see `groupActivityActions`)
        // without depending on that later `useMemo` from this earlier callback.
        vocabulary_available: Boolean(page?.available_actions?.length),
      });
    }
  }, [draftActions, draftFrom, draftTo, id, page]);

  const clearFilters = useCallback(() => {
    setDraftActions([]);
    setDraftFrom('');
    setDraftTo('');
    setFilters({});
  }, []);

  const filtered = useMemo(
    () => Boolean(filters.actions?.length || filters.from || filters.to),
    [filters],
  );

  /**
   * The filter's options and the table's labels both come from the response.
   *
   * This client used to keep its own copy of the action names, and it could not
   * be checked against anything — master and core are separate repositories,
   * neither a dependency of this one. Master knows both stores' vocabularies, so
   * it serves them and nothing here is transcribed.
   */
  const actionGroups = useMemo(() => groupActivityActions(page?.available_actions), [page]);
  const actionLabels = useMemo(() => activityActionLabels(page?.available_actions), [page]);

  /**
   * No vocabulary, no filter — the control is hidden rather than drawn from a
   * built-in list.
   *
   * A fallback copy is exactly the mirror this replaced: it would go stale
   * silently, and every stale entry is a checkbox that returns an empty trail,
   * which reads as "this never happened". Hiding it costs a supervisor the
   * action filter against an older master and keeps the dates, which are the
   * filter that matters on a finished campaign, working untouched.
   */
  const actionFilterUnavailable = page !== null && actionGroups.length === 0;

  // Only once a page has actually arrived. `retentionNotice(null)` is the
  // "could not be checked" warning, so reading it off an unloaded `page` put an
  // alarming, false notice on screen during every first paint — and left it
  // there permanently if the request errored.
  const retentionLine = page ? retentionNotice(page.retention) : null;

  // The dates are the filter that matters on a finished campaign, so an
  // inverted range is caught here rather than sent to the server. Master
  // refuses it too (400), but telling the supervisor before they press Apply is
  // the difference between a correction and a support ticket.
  const invertedRange = Boolean(draftFrom && draftTo && draftFrom > draftTo);

  return (
    <div className={styles.page}>
      <Breadcrumbs
        items={[
          { label: 'Campaigns', href: '/agency/campaigns' },
          ...(campaign
            ? [{ label: campaign.name, href: `/agency/campaigns/${campaign.id}` }]
            : []),
          { label: 'Activity' },
        ]}
      />

      {/*
        The campaign workspace's section bar, in the same slot on every one of
        its screens (`MAG-166`). These four sections used to be reachable only
        as secondary buttons on the detail page's header row — the same row
        that carries Stop — so getting from Contacts to Call attempts meant
        going back through the campaign first.
      */}
      {id && (
        <CampaignTabs campaignId={id} active="activity" role={role} campaignStatus={campaign?.status} />
      )}

      <header className={spine.header}>
        <div className={spine.headerCopy}>
          <span className={spine.titleIcon} aria-hidden="true"><History size={20} /></span>
          <h1 className={spine.title}>Activity</h1>
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
              title="Download everything matching the filters above, not just the entries on screen"
            >
              <Download size={16} />
              {exporting ? 'Preparing…' : 'Export CSV'}
            </button>
          )}
        </div>
      </header>

      <PageDescription
        pageKey="agency-campaign-activity"
        description={
          'Everything recorded for this campaign, newest first — who did it, when, and to what. '
          + 'Two systems record here: the console logs what someone pressed, the dialer logs what '
          + 'the campaign then did, so a pause legitimately appears twice.'
        }
        tips={[
          'Automatic pauses show the abandonment rate that was measured and the ceiling it broke.',
          'A disposition filed for another agent says so — look for “on behalf”.',
          'Export CSV downloads everything matching the filters, not just the entries on screen.',
        ]}
      />

      {/*
        Not a subtle icon. This banner is the difference between a trail that is
        short and a trail that is short AND says so, which is the entire reason
        the API carries `partial` at all.

        `role="status"` (polite), not `role="alert"`: this only ever appears
        after a fetch has resolved, never mid-keystroke, so there is no race to
        win by interrupting. `alert` is for something urgent enough to cut off
        whatever the user is doing — a stated data gap on a page that already
        loaded is not that.
      */}
      {page?.partial && (
        <div className={styles.partialBanner} role="status" data-testid="activity-partial">
          <AlertTriangle size={16} aria-hidden="true" />
          <span>{partialNotice(page.partial_reason)}</span>
        </div>
      )}

      {retentionLine && (
        <p className={styles.retention} data-testid="activity-retention">
          {retentionLine}
        </p>
      )}

      <FiltersCard activeCount={activeFilterCount}>
        {/*
          Rendered from `available_actions`, and simply absent when the server
          did not send one — see `actionFilterUnavailable`. There is deliberately
          no built-in list to fall back to.
        */}
        {actionFilterUnavailable && (
          <p className={styles.retention} data-testid="activity-action-filter-unavailable">
            Filtering by what happened is unavailable — this workspace’s server did not send the
            list of actions it records, and a guessed list would offer filters that match nothing.
            The date range below still works, and every entry is shown.
          </p>
        )}

        {actionGroups.length > 0 && (
          <fieldset className={styles.actionFilter}>
            <legend className={spine.filterLegend}>What happened</legend>
            <div className={spine.multiSelectRow}>
              {actionGroups.map((group) => {
                // Each dropdown only owns its own group's values, so opening
                // "Calls" and clearing it cannot touch a box ticked under
                // "Staffing" — `draftActions` stays one flat list underneath,
                // the same shape `applyFilters` has always sent.
                const groupValues = group.actions.map((action) => action.value);
                const selectedInGroup = draftActions.filter((value) => groupValues.includes(value));
                return (
                  <MultiSelectFilter
                    key={group.label}
                    label={group.label}
                    options={group.actions}
                    selected={selectedInGroup}
                    onToggle={(value) => setDraftActions((current) => (
                      current.includes(value)
                        ? current.filter((v) => v !== value)
                        : [...current, value]
                    ))}
                    onClear={() => setDraftActions((current) => (
                      current.filter((value) => !groupValues.includes(value))
                    ))}
                  />
                );
              })}
            </div>
          </fieldset>
        )}

        <div className={spine.fieldRow}>
          {/*
            No `aria-label` here: with one, a voice-control user who says what
            they see ("From") lands on nothing, because the accessible name
            silently became "Show activity from this date" instead — WCAG
            2.5.3 Label in Name. The visible text stayed terse, so it grew a
            word rather than growing a hidden override.
          */}
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
            <p className={spine.filterError} role="alert" data-testid="activity-inverted-range">
              <AlertCircle size={13} aria-hidden="true" />
              The “From” date is after the “To” date, so nothing could match. Swap them to continue.
            </p>
          )}
          <div className={spine.filterActions}>
            <button
              type="button"
              className="btn-primary"
              onClick={applyFilters}
              disabled={invertedRange}
            >
              Apply
            </button>
            {filtered && (
              <button type="button" className="btn-secondary" onClick={clearFilters}>
                Clear
              </button>
            )}
          </div>
        </div>
      </FiltersCard>

      {error && <ErrorAlert message={error} onRetry={() => void load(filters)} />}

      {/*
        The count, and the page's only announcement channel.

        Without it a supervisor cannot tell a complete trail from the first page
        of a long one except by noticing a button. `total` is `null` exactly when
        the dialer's half is missing, and is then omitted rather than guessed at
        — the banner above already explains why.

        ── It is mounted UNCONDITIONALLY, and that is the whole point ───────────
        A screen reader only announces an `aria-live` region that was already in
        the accessibility tree when its contents changed; a region inserted
        already-populated is announced by some AT and silently dropped by most.
        Rendered inside the rows block it unmounted behind the spinner on every
        reload and remounted full, so the one signal that applying a filter
        changed anything was exactly the signal least likely to arrive. Empty
        while loading, filled when the rows land — so the change happens to a
        region that was already there.

        One region only: a second would compete with the partial banner's and
        garble both.
      */}
      <p
        className={spine.count}
        data-testid="activity-count"
        aria-live="polite"
        aria-atomic="true"
      >
        {!loading && rows.length > 0 && (
          <>
            <ListChecks size={14} className={spine.countIcon} aria-hidden="true" />
            {page?.total != null
              ? `Showing ${rows.length.toLocaleString()} of ${page.total.toLocaleString()} entries`
              : `Showing ${rows.length.toLocaleString()} entries`}
          </>
        )}
      </p>

      {loading && <LoadingSpinner />}

      {!loading && rows.length === 0 && !error && (
        <EmptyState
          icon={<History size={32} />}
          title={filtered ? 'Nothing matches those filters' : 'Nothing recorded yet'}
          description={
            filtered
              ? 'Widen the date range or clear the filters to see the whole trail.'
              : 'Actions on this campaign — starting it, filing dispositions, marking do-not-call '
                + '— appear here as they happen.'
          }
        />
      )}

      {!loading && rows.length > 0 && (
        <>
          {/* Same fact as ACTIVITY_SOURCE_LEGEND, said once here rather than
              on every row's tag — see that constant for why. */}
          <p className={styles.sourceLegend}>{ACTIVITY_SOURCE_LEGEND}</p>
          {/* The description every `[data-testid="activity-client-actor"]`
              cell points at via `aria-describedby` — see CLIENT_ACTOR_DESC_ID. */}
          <span id={CLIENT_ACTOR_DESC_ID} className={styles.srOnly}>
            {CLIENT_ACTOR_TOOLTIP}
          </span>
          <div className={spine.tableWrap}>
            <table className={spine.table}>
              <caption className={styles.srOnly}>
                {activityTableCaption(campaign?.name ?? null)}
              </caption>
            <thead>
              <tr>
                <th>When</th>
                <th>What</th>
                <th>Who</th>
                <th>On what</th>
                <th>Details</th>
                <th>Recorded by</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const summary = activityDetailSummary(row);
                return (
                  <tr key={row.id} data-testid={`activity-row-${row.id}`}>
                    <td className={styles.when}>{formatActivityTimestamp(row.at)}</td>
                    <td className={styles.action}>{activityActionLabel(row.action, actionLabels)}</td>
                    <td className={actorClassName(row)}>
                      {actorKind(row) === 'system' ? (
                        row.actor.display ?? 'Automatic'
                      ) : actorKind(row) === 'api_key' ? (
                        /*
                         * A platform API key, named as the CREDENTIAL and never
                         * as the person who minted it (86d45t7rm). Master used
                         * to stamp that person here and now does not — so
                         * `user_id` is null on these rows, and the pre-existing
                         * `system` branch above would have rendered them
                         * "Automatic": nothing human was involved in an action
                         * somebody's credential performed. It does not, because
                         * `actor.system` is false for a key; this branch is what
                         * gives the row somewhere correct to go.
                         *
                         * `display` is the key's own NAME, resolved by master
                         * ("Nightly sync"), which is the thing a supervisor acts
                         * on — the follow-up is to find and revoke that key. It
                         * falls back to master's own bare label rather than to a
                         * uuid, so the id stays in the tooltip where it is
                         * looked up rather than in the cell where it identifies
                         * nobody.
                         */
                        <span
                          className={styles.keyActorLabel}
                          data-testid="activity-key-actor"
                        >
                          {/*
                            * The marker is APPENDED to a resolved name, never
                            * wrapped around the fallback — `{display ?? 'API
                            * key'} (API key)` printed "API key (API key)" on
                            * every row master could not name, which is the
                            * common case for a revoked key.
                            */}
                          {row.actor.display ? `${row.actor.display} (API key)` : 'API key'}
                          {row.actor.api_key_id && (
                            <>
                              {' '}
                              {/*
                                * The id was a `title` on the label, i.e. hover
                                * only — unreachable by keyboard or touch, and
                                * this file already rejects that pattern for the
                                * client actor immediately below. It is the
                                * handle the key is looked up and revoked by, so
                                * it gets a real control.
                                */}
                              <TruncatedId
                                value={row.actor.api_key_id}
                                label="API key ID"
                                className={styles.keyActorId}
                              />
                            </>
                          )}
                        </span>
                      ) : actorKind(row) === 'client' ? (
                        // The dialer has no user table, so this is the CLIENT that
                        // made the request, not a person. Rendered plainly it
                        // reads as the name of whoever acted. The explanation
                        // was a `title` — invisible to keyboard and
                        // screen-reader users — so it is now reachable by tab
                        // (`tabIndex`) and announced via `aria-describedby`,
                        // pointing at the one shared node carrying
                        // `CLIENT_ACTOR_TOOLTIP` (this varies row to row only
                        // in whether it applies, not in what it says, so per
                        // row it is a description behind focus, not a legend).
                        <span
                          className={styles.clientActorLabel}
                          tabIndex={0}
                          aria-describedby={CLIENT_ACTOR_DESC_ID}
                          data-testid="activity-client-actor"
                        >
                          {row.actor.display ?? 'Unattributed'} (app)
                        </span>
                      ) : (
                        row.actor.display ?? row.actor.user_id ?? 'Unattributed'
                      )}
                    </td>
                    <td className={styles.target}>
                      {row.target.id ? (
                        <>
                          <span className={styles.targetType}>{row.target.type ?? 'item'}</span>
                          <code className={styles.targetId}>{row.target.id}</code>
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={styles.detail}>
                      {summary ?? <RawDetail detail={row.detail} />}
                    </td>
                    <td>
                      {/*
                        No `title` — the explanation of what "Console"/"Dialer"
                        mean lives once, in the legend above the table
                        (ACTIVITY_SOURCE_LEGEND), not repeated per row in a
                        form that only a mouse could reach. The `aria-label`
                        here is plain, matching the visible tag exactly, so
                        the accessible name is never a surprise.
                      */}
                      <span
                        className={styles.sourceTag}
                        aria-label={ACTIVITY_SOURCE_LABEL[row.source] ?? row.source}
                        data-testid={`activity-source-${row.source}`}
                      >
                        {ACTIVITY_SOURCE_LABEL[row.source] ?? row.source}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
            </table>
          </div>

          {page?.next_cursor && (
            <div className={spine.more}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => void onLoadMore()}
                disabled={loadingMore}
              >
                {loadingMore ? 'Loading…' : 'Load older entries'}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * The fallback for a row whose action this build does not summarise.
 *
 * Shown rather than hidden: an unrecognised audit row is exactly the one nobody
 * anticipated, and dropping it is the single omission this view cannot afford.
 */
/**
 * A row whose "who" is not a person does not get the plain-person style.
 *
 * Keyed on {@link activityActorKind} rather than re-deriving, so the cell and
 * its styling cannot disagree about which of the four a row is — and so the
 * `system` branch keeps reading `actor.system` (the rendering flag) rather than
 * `actor.type`, which on a pre-067 row says `'unknown'`. See `ActivityActor`.
 */
function actorClassName(row: ActivityRow): string | undefined {
  switch (activityActorKind(row)) {
    case 'system': return styles.systemActor;
    case 'api_key': return styles.keyActor;
    case 'client': return styles.clientActor;
    case 'person': return undefined;
  }
}

/** Local alias so the JSX below reads as a question about the row. */
const actorKind = activityActorKind;

function RawDetail({ detail }: { detail: Record<string, unknown> }) {
  const entries = Object.entries(detail ?? {}).filter(([key]) => key !== 'campaign_id');
  if (entries.length === 0) return <span className={styles.noDetail}>—</span>;
  return (
    <ul className={styles.rawDetail}>
      {entries.map(([key, value]) => (
        <li key={key}>
          <span className={styles.rawKey}>{key}</span>
          <span>{typeof value === 'string' ? value : JSON.stringify(value)}</span>
        </li>
      ))}
    </ul>
  );
}

export default AgencyCampaignActivityPage;
