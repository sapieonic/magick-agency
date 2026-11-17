import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, Calendar, Download, Headphones, ListChecks, Play } from 'lucide-react';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { PageDescription } from '../../../components/common/PageDescription';
import { FiltersCard } from '../../../components/agency/FiltersCard';
import { useTenant } from '../../../contexts/TenantContext';
import { SOFTPHONE_FLAG, useFeatureFlagEnabled } from '../../../hooks/useFeatureFlagEnabled';
import { usePermission } from '../../../hooks/usePermission';
import { downloadListenHistoryCsv, listListenHistory } from '../../../api/listenHistory';
import { listTenantMembers } from '../../../api/tenants';
import { downloadBlob } from '../../../utils/agency/insights/csv';
import { errorStatus } from '../../../utils/agencyErrors';
import { formatSpineTimestamp } from '../../../utils/agencySpineCopy';
import {
  LISTEN_HISTORY_COPY,
  listenHistoryCountLabel,
  listenHistoryOpenLabel,
  listenHistoryTruncatedNotice,
} from '../../../utils/listen/listenCopy';
import {
  EMPTY_LISTEN_HISTORY_DRAFT,
  callRowGone,
  listenHistoryAgent,
  listenHistoryCallPath,
  listenHistoryCallType,
  listenHistoryCustomer,
  listenHistoryFilterCount,
  listenHistoryFilterOptions,
  listenHistoryHowEnded,
  listenHistoryListened,
  listenHistoryQuery,
  listenHistoryRangeReversed,
  listenHistorySupervisor,
  type ListenHistoryDraft,
  type ListenHistoryOption,
} from '../../../utils/listen/listenHistory';
import type { AgencyListenHistoryEntry } from '../../../types/listen-history';
import type { TenantMember } from '../../../types/team';
import spine from '../../../components/agency/SpineListLayout.module.css';
import styles from './ListenHistoryPage.module.css';

/** One page of visits. */
export const LISTEN_HISTORY_PAGE_SIZE = 50;

/**
 * `forbidden`: the reader may not read it (a 401 or 403: the permission was taken away), said,
 * never asked again. `failed`: anything else, with Try again. There is no "listening is off"
 * state: the history does not depend on the listening flag (LS19, amended 2026-11-17).
 */
type Failure = 'forbidden' | 'failed';

function failureOf(err: unknown): Failure {
  const status = errorStatus(err);
  return status === 401 || status === 403 ? 'forbidden' : 'failed';
}

/**
 * `/agency/listening-history` — "Listening history" (`docs/listening.md` §12, decision LS19): every
 * listen in the account, newest first, one entry per visit (the server merges a supervisor's
 * reconnects on one call): who listened, the agent, the call type, the customer (masked, or
 * "Withheld"), when, for how long, how it ended in words, and the call's page where it has one.
 * Filters for supervisor, agent and date range; keyset paging; the CSV with the same filters.
 *
 * Not behind the listening flag (LS19, amended 2026-11-17): past listens stay visible when listening
 * is turned off. On top of the `/agency` subtree's gates, a reader below `agency.supervise` reads
 * nothing (the server refuses them too).
 */
export default function ListenHistoryPage() {
  const { tenantId, accountId } = useTenant();
  const supervise = usePermission('agency.supervise');
  const { showToast, showErrorToast } = useToast();

  const [draft, setDraft] = useState<ListenHistoryDraft>(EMPTY_LISTEN_HISTORY_DRAFT);
  const [applied, setApplied] = useState<ListenHistoryDraft>(EMPTY_LISTEN_HISTORY_DRAFT);
  const [entries, setEntries] = useState<AgencyListenHistoryEntry[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [exporting, setExporting] = useState(false);
  const [members, setMembers] = useState<TenantMember[]>([]);
  // The supervisor and agent chosen, by name: kept on offer whatever the rows hold.
  const [chosen, setChosen] = useState<{ supervisor: ListenHistoryOption | null; agent: ListenHistoryOption | null }>({ supervisor: null, agent: null });
  const seq = useRef(0);

  useEffect(() => {
    if (!supervise || !tenantId) return;
    listTenantMembers(tenantId)
      .then((list) => setMembers(list ?? []))
      // Names for the filters are a courtesy: the rows' own names still fill them.
      .catch(() => setMembers([]));
  }, [supervise, tenantId]);

  const load = useCallback(
    async (filters: ListenHistoryDraft) => {
      if (!supervise || !tenantId || !accountId) return;
      const mine = ++seq.current;
      setLoading(true);
      setMoreError(false);
      // The last query's cursor is a keyset position in another question: Load older is not
      // offered until this query answers with its own.
      setNextCursor(null);
      try {
        const page = await listListenHistory({ ...listenHistoryQuery(filters), limit: LISTEN_HISTORY_PAGE_SIZE }, tenantId, accountId);
        if (mine !== seq.current) return;
        setEntries(page.entries);
        setNextCursor(page.next_cursor);
        setFailure(null);
      } catch (err) {
        if (mine !== seq.current) return;
        // The rows on show answer the filters before these: not left under the error.
        setEntries([]);
        setFailure(failureOf(err));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [supervise, tenantId, accountId],
  );

  useEffect(() => {
    void load(applied);
  }, [load, applied]);

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore || !tenantId || !accountId) return;
    const mine = seq.current;
    setLoadingMore(true);
    setMoreError(false);
    try {
      const page = await listListenHistory(
        { ...listenHistoryQuery(applied), cursor: nextCursor, limit: LISTEN_HISTORY_PAGE_SIZE },
        tenantId,
        accountId,
      );
      // The filters changed under the request: these rows answer another question.
      if (mine !== seq.current) return;
      setEntries((current) => [...current, ...page.entries]);
      setNextCursor(page.next_cursor);
    } catch {
      if (mine === seq.current) setMoreError(true);
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, tenantId, accountId, applied]);

  const onExport = useCallback(async () => {
    if (!tenantId || !accountId) return;
    setExporting(true);
    try {
      const result = await downloadListenHistoryCsv(listenHistoryQuery(applied), tenantId, accountId);
      downloadBlob(result.filename, result.blob);
      if (result.truncated) showToast(listenHistoryTruncatedNotice(result.reason, result.rowLimit), 'error');
      else showToast(LISTEN_HISTORY_COPY.exported, 'success');
    } catch (err: unknown) {
      showErrorToast(err, LISTEN_HISTORY_COPY.exportFailed);
    } finally {
      setExporting(false);
    }
  }, [tenantId, accountId, applied, showToast, showErrorToast]);

  const softphoneEnabled = useFeatureFlagEnabled(SOFTPHONE_FLAG);
  const options = useMemo(
    () => listenHistoryFilterOptions(members, entries, chosen, accountId ?? null),
    [members, entries, chosen, accountId],
  );
  const reversed = listenHistoryRangeReversed(draft);
  const active = listenHistoryFilterCount(applied);
  const set = (patch: Partial<ListenHistoryDraft>) => setDraft((current) => ({ ...current, ...patch }));
  const chooseSupervisor = (id: string) => {
    set({ supervisor: id });
    setChosen((c) => ({ ...c, supervisor: options.supervisors.find((o) => o.id === id) ?? null }));
  };
  const chooseAgent = (id: string) => {
    set({ agent: id });
    setChosen((c) => ({ ...c, agent: options.agents.find((o) => o.id === id) ?? null }));
  };

  const header = (exportable: boolean) => (
    <header className={spine.header}>
      <div className={spine.headerCopy}>
        <span className={spine.titleIcon} aria-hidden="true">
          <Headphones size={20} />
        </span>
        <h1 className={spine.title}>{LISTEN_HISTORY_COPY.title}</h1>
      </div>
      {exportable ? (
        <div className={spine.actions}>
          <button
            type="button"
            className={`${spine.actionButton} btn-secondary`}
            onClick={() => void onExport()}
            disabled={exporting || loading}
            data-testid="listen-history-export"
          >
            <Download size={16} aria-hidden="true" />
            {exporting ? LISTEN_HISTORY_COPY.exporting : LISTEN_HISTORY_COPY.exportCsv}
          </button>
        </div>
      ) : null}
    </header>
  );

  if (!supervise || failure === 'forbidden') {
    return (
      <div className={styles.page}>
        {header(false)}
        <EmptyState icon={<Headphones size={22} />} title={LISTEN_HISTORY_COPY.title} description={LISTEN_HISTORY_COPY.forbidden} />
      </div>
    );
  }
  const failed = failure === 'failed';

  return (
    <div className={styles.page}>
      {header(true)}
      <PageDescription pageKey="agency-listening-history" description={LISTEN_HISTORY_COPY.description} tips={[...LISTEN_HISTORY_COPY.tips]} />

      <FiltersCard activeCount={active}>
        <div className={spine.fieldRow}>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>{LISTEN_HISTORY_COPY.supervisorFilter}</span>
            <select
              className={styles.select}
              value={draft.supervisor}
              onChange={(e) => chooseSupervisor(e.target.value)}
              data-testid="listen-history-supervisor"
            >
              <option value="">{LISTEN_HISTORY_COPY.allSupervisors}</option>
              {options.supervisors.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>{LISTEN_HISTORY_COPY.agentFilter}</span>
            <select
              className={styles.select}
              value={draft.agent}
              onChange={(e) => chooseAgent(e.target.value)}
              data-testid="listen-history-agent"
            >
              <option value="">{LISTEN_HISTORY_COPY.allAgents}</option>
              {options.agents.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>{LISTEN_HISTORY_COPY.fromFilter}</span>
            <span className={spine.inputWrap}>
              <Calendar size={14} className={spine.inputIcon} aria-hidden="true" />
              <input
                type="date"
                className={spine.fieldInput}
                value={draft.from}
                onChange={(e) => set({ from: e.target.value })}
                data-testid="listen-history-from"
              />
            </span>
          </label>
          <label className={spine.field}>
            <span className={spine.fieldLabel}>{LISTEN_HISTORY_COPY.toFilter}</span>
            <span className={spine.inputWrap}>
              <Calendar size={14} className={spine.inputIcon} aria-hidden="true" />
              <input
                type="date"
                className={spine.fieldInput}
                value={draft.to}
                onChange={(e) => set({ to: e.target.value })}
                data-testid="listen-history-to"
              />
            </span>
          </label>
        </div>
        <div className={spine.filterFooter}>
          {reversed ? (
            <p className={spine.filterError} role="alert">
              <AlertCircle size={13} aria-hidden="true" />
              {LISTEN_HISTORY_COPY.reversedRange}
            </p>
          ) : null}
          <div className={spine.filterActions}>
            <button type="button" className="btn-primary" onClick={() => setApplied(draft)} disabled={reversed} data-testid="listen-history-apply">
              {LISTEN_HISTORY_COPY.apply}
            </button>
            {active > 0 ? (
              <button
                type="button"
                className="btn-secondary"
                onClick={() => {
                  setDraft(EMPTY_LISTEN_HISTORY_DRAFT);
                  setApplied(EMPTY_LISTEN_HISTORY_DRAFT);
                  setChosen({ supervisor: null, agent: null });
                }}
                data-testid="listen-history-clear"
              >
                {LISTEN_HISTORY_COPY.clear}
              </button>
            ) : null}
          </div>
        </div>
      </FiltersCard>

      {failed ? (
        <div data-testid="listen-history-error">
          <ErrorAlert message={LISTEN_HISTORY_COPY.failed} onRetry={() => void load(applied)} />
        </div>
      ) : null}

      <p className={spine.count} aria-live="polite" aria-atomic="true" data-testid="listen-history-count">
        {!loading && entries.length > 0 ? (
          <>
            <ListChecks size={14} className={spine.countIcon} aria-hidden="true" />
            {listenHistoryCountLabel(entries.length, nextCursor !== null)}
          </>
        ) : null}
      </p>

      {loading && entries.length === 0 ? <LoadingSpinner /> : null}

      {!loading && !failed && entries.length === 0 ? (
        <EmptyState
          icon={<Headphones size={32} />}
          title={active > 0 ? LISTEN_HISTORY_COPY.noMatchTitle : LISTEN_HISTORY_COPY.emptyTitle}
          description={active > 0 ? LISTEN_HISTORY_COPY.noMatchBody : LISTEN_HISTORY_COPY.emptyBody}
        />
      ) : null}

      {/*
        `ph-no-capture`: the rows carry customers' names and masked numbers, and PostHog autocapture
        records a clicked element's text and attributes (CH6), as on the Live calls table.
      */}
      <div className="ph-no-capture" data-testid="listen-history">
        {entries.length > 0 ? (
          <>
            <div className={spine.tableWrap}>
              <table className={spine.table} data-testid="listen-history-table">
                <caption className="sr-only">{LISTEN_HISTORY_COPY.caption}</caption>
                <thead>
                  <tr>
                    <th scope="col">{LISTEN_HISTORY_COPY.columnSupervisor}</th>
                    <th scope="col">{LISTEN_HISTORY_COPY.columnAgent}</th>
                    <th scope="col">{LISTEN_HISTORY_COPY.columnType}</th>
                    <th scope="col">{LISTEN_HISTORY_COPY.columnCustomer}</th>
                    <th scope="col">{LISTEN_HISTORY_COPY.columnStarted}</th>
                    <th scope="col">{LISTEN_HISTORY_COPY.columnListened}</th>
                    <th scope="col">{LISTEN_HISTORY_COPY.columnEnded}</th>
                    <th scope="col">{LISTEN_HISTORY_COPY.columnCall}</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <HistoryRow key={entry.id} entry={entry} softphoneEnabled={softphoneEnabled} />
                  ))}
                </tbody>
              </table>
            </div>
            {moreError ? (
              <p className={styles.loadMoreError} role="alert">
                {LISTEN_HISTORY_COPY.loadMoreFailed}
              </p>
            ) : null}
            {nextCursor ? (
              <div className={spine.more}>
                <button type="button" className="btn-secondary" onClick={() => void loadMore()} disabled={loadingMore} data-testid="listen-history-more">
                  {loadingMore ? LISTEN_HISTORY_COPY.loadingMore : LISTEN_HISTORY_COPY.loadMore}
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function HistoryRow({ entry, softphoneEnabled }: { entry: AgencyListenHistoryEntry; softphoneEnabled: boolean }) {
  const supervisor = listenHistorySupervisor(entry);
  const agent = listenHistoryAgent(entry);
  const customer = listenHistoryCustomer(entry);
  const path = listenHistoryCallPath(entry, softphoneEnabled);
  const gone = callRowGone(entry);
  return (
    <tr data-testid={`listen-history-row-${entry.id}`}>
      <td className={styles.person}>{supervisor}</td>
      <td className={styles.person}>{agent}</td>
      <td>{listenHistoryCallType(entry)}</td>
      <td>
        <span className={styles.customer}>
          <span className={entry.customer_name ? undefined : styles.muted}>{customer.name}</span>
          {customer.number ? <span className={styles.mono}>{customer.number}</span> : null}
        </span>
      </td>
      <td className={styles.when}>{formatSpineTimestamp(entry.started_at)}</td>
      <td className={styles.mono}>{listenHistoryListened(entry)}</td>
      <td>{listenHistoryHowEnded(entry)}</td>
      <td>
        {path ? (
          <Link to={path} className={styles.openLink} aria-label={listenHistoryOpenLabel(supervisor, agent)}>
            <Play size={13} aria-hidden="true" />
            {LISTEN_HISTORY_COPY.openCall}
          </Link>
        ) : gone ? (
          <span className={styles.muted}>{LISTEN_HISTORY_COPY.callGone}</span>
        ) : null}
      </td>
    </tr>
  );
}
