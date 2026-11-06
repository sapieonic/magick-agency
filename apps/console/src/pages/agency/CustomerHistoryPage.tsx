import { useCallback, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Check, Copy, Download, History } from 'lucide-react';
import type {
  CustomerSearchResponse,
  CustomerTimelineEntry,
} from '@magick-agency/contracts/api/agency/customer-history';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { PageHeader } from '@magick-agency/web-ui/components/PageHeader';
import { exportCustomerHistory, getCustomerTimeline, searchCustomers } from '../../api/customerHistory';
import { useTenant } from '../../contexts/TenantContext';
import { hasPermission } from '../../utils/permissions';
import { AgentSurfaceShell } from '../../components/agency/AgentSurfaceShell';
import { CustomerSearchBox } from '../../components/agency/customers/CustomerSearchBox';
import { CustomerHistorySummary, DncStatus } from '../../components/agency/customers/CustomerHistorySummary';
import { CustomerTimelineList } from '../../components/agency/customers/CustomerTimeline';
import {
  CustomerTimelineFiltersBar,
  EMPTY_FILTER_FORM,
  filtersFromForm,
  hasAnyFilter,
  type CustomerTimelineFilterForm,
} from '../../components/agency/customers/CustomerTimelineFiltersBar';
import {
  customerSearchAnswer,
  rememberCustomerSearchAnswer,
  searchIdFromLocationState,
  type CustomerHistoryLocationState,
} from '../../utils/customerHistoryStore';
import { customerHistoryRefusal } from '../../utils/customerHistoryCopy';
import styles from '../../components/agency/customers/CustomerHistory.module.css';

/**
 * Customer history (`docs/customer-history.md`): one phone number, every
 * interaction with it in the accounts the caller can see.
 *
 * Served twice: at `/agency/customers` inside the agency shell, and at
 * `/dialer/customers` in the agent's own frame (`AgentSurfaceShell`), because an
 * `agent` is below every entry of the agency shell (CH1: everyone can search).
 *
 * ── The number is never in the URL (CH6) ───────────────────────────────────
 * The page's address carries no number and no query. The search box puts only
 * the search id in the history state; the answer is held in memory
 * (`utils/customerHistoryStore`). A reload, or an id this tab never saw, shows the
 * empty page with the search box.
 */

type Surface = 'agency' | 'agent';

const RESULTS_PATH: Record<Surface, string> = {
  agency: '/agency/customers',
  agent: '/dialer/customers',
};

const NO_HISTORY_TITLE = 'No calls to this number in the accounts you can see';

function accountsSeen(answer: CustomerSearchResponse): number {
  const ids = new Set<string>();
  for (const c of answer.summary.contacts) ids.add(c.account_id);
  for (const d of answer.summary.dnc) if (d.account_id) ids.add(d.account_id);
  for (const e of answer.timeline.entries) if (e.account_id) ids.add(e.account_id);
  return ids.size;
}

function CopyNumberButton({ value, display }: { value: string; display: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={styles.copy}
      aria-label={copied ? 'Number copied' : `Copy ${display}`}
      title="Copy the number"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          // The clipboard can be unavailable (an insecure origin, a denied permission).
        }
      }}
    >
      {copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
    </button>
  );
}

function CustomerHistoryResults({ answer, resultsPath }: { answer: CustomerSearchResponse; resultsPath: string }) {
  const { tenantId, accountId } = useTenant();
  const navigate = useNavigate();
  const [entries, setEntries] = useState<CustomerTimelineEntry[]>(answer.timeline.entries);
  const [nextCursor, setNextCursor] = useState<string | null>(answer.timeline.next_cursor);
  const [form, setForm] = useState<CustomerTimelineFilterForm>(EMPTY_FILTER_FORM);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [researching, setResearching] = useState(false);
  const seq = useRef(0);

  const tenant = tenantId ?? undefined;
  const account = accountId ?? undefined;
  const filters = useMemo(() => filtersFromForm(form), [form]);
  const filtered = hasAnyFilter(form);
  const showAccounts = useMemo(() => accountsSeen(answer) > 1, [answer]);
  const { summary } = answer;
  const isEmptyHistory = summary.contacts.length === 0 && summary.totals.calls === 0;

  const onRefusal = useCallback((err: unknown, fallback: string) => {
    const refusal = customerHistoryRefusal(err, fallback);
    if (refusal.kind === 'search_expired') setExpired(true);
    else setError(refusal.message);
  }, []);

  const applyForm = useCallback(
    async (next: CustomerTimelineFilterForm) => {
      setForm(next);
      setError(null);
      setExportNote(null);
      const mine = ++seq.current;
      setLoading(true);
      try {
        const nextFilters = filtersFromForm(next);
        const page = await getCustomerTimeline(
          {
            search_id: answer.search_id,
            ...(Object.keys(nextFilters).length > 0 ? { filters: nextFilters } : {}),
          },
          tenant,
          account,
        );
        if (mine !== seq.current) return;
        setEntries(page.entries);
        setNextCursor(page.next_cursor);
      } catch (err: unknown) {
        if (mine !== seq.current) return;
        onRefusal(err, 'Could not load the timeline.');
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [answer.search_id, tenant, account, onRefusal],
  );

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return;
    const mine = seq.current;
    setLoadingMore(true);
    setError(null);
    try {
      const page = await getCustomerTimeline(
        {
          search_id: answer.search_id,
          cursor: nextCursor,
          ...(Object.keys(filters).length > 0 ? { filters } : {}),
        },
        tenant,
        account,
      );
      // A filter change mid-request: these rows belong to a different query.
      if (mine !== seq.current) return;
      setEntries((current) => [...current, ...page.entries]);
      setNextCursor(page.next_cursor);
    } catch (err: unknown) {
      if (mine !== seq.current) return;
      onRefusal(err, 'Could not load more of the timeline.');
    } finally {
      setLoadingMore(false);
    }
  }, [nextCursor, loadingMore, answer.search_id, filters, tenant, account, onRefusal]);

  const onExport = useCallback(async () => {
    setExporting(true);
    setExportNote(null);
    setError(null);
    try {
      const result = await exportCustomerHistory(
        { search_id: answer.search_id, ...(Object.keys(filters).length > 0 ? { filters } : {}) },
        tenant,
        account,
      );
      const url = URL.createObjectURL(result.blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
      setExportNote(
        result.truncated
          ? 'Export downloaded, but this history is longer than one file holds: only the newest rows are in it. Narrow the filters to export the rest.'
          : 'Export downloaded.',
      );
    } catch (err: unknown) {
      onRefusal(err, 'Could not export this history.');
    } finally {
      setExporting(false);
    }
  }, [answer.search_id, filters, tenant, account, onRefusal]);

  /** The search id lapsed (30 minutes): search the same number again, from memory. */
  const searchAgain = useCallback(async () => {
    setResearching(true);
    setError(null);
    try {
      const fresh = await searchCustomers({ by: answer.key.by, value: answer.key.value }, tenant, account);
      rememberCustomerSearchAnswer(fresh);
      const state: CustomerHistoryLocationState = { searchId: fresh.search_id };
      navigate(resultsPath, { state, replace: true });
    } catch (err: unknown) {
      setError(customerHistoryRefusal(err, 'Could not search this number again.').message);
    } finally {
      setResearching(false);
    }
  }, [answer.key, tenant, account, navigate, resultsPath]);

  return (
    <div className={styles.results}>
      <div className={styles.resultsHeader}>
        <h2 className={styles.resultsTitle} data-testid="customer-results-title">
          Results for <span className={styles.number}>{answer.key.display}</span>
        </h2>
        <CopyNumberButton value={answer.key.value} display={answer.key.display} />
      </div>

      {expired && (
        <div className={styles.expired} role="alert" data-testid="customer-search-expired">
          <p>This search has expired. Search the number again to see its latest history.</p>
          <button type="button" className="btn-primary" onClick={searchAgain} disabled={researching}>
            {researching ? 'Searching…' : 'Search again'}
          </button>
        </div>
      )}

      {error && <ErrorAlert message={error} />}

      {isEmptyHistory ? (
        <>
          <EmptyState
            icon={<History size={28} />}
            title={NO_HISTORY_TITLE}
            description="Nobody has called this number from a campaign or the soft phone, and it is not on any roster you can see."
          />
          <DncStatus entries={summary.dnc} />
        </>
      ) : (
        <>
          <CustomerHistorySummary summary={summary} showAccounts={showAccounts} />

          <section className={`card ${styles.section}`} aria-labelledby="customer-timeline-heading">
            <div className={styles.timelineHeader}>
              <h2 id="customer-timeline-heading" className={styles.sectionTitle}>Timeline</h2>
              <button
                type="button"
                className="btn-secondary"
                onClick={onExport}
                disabled={exporting || expired}
              >
                <Download size={14} aria-hidden="true" />
                {exporting ? 'Exporting…' : 'Export CSV'}
              </button>
            </div>
            {exportNote && (
              <p className={styles.muted} role="status" data-testid="customer-export-note">{exportNote}</p>
            )}

            <CustomerTimelineFiltersBar
              options={summary.filter_options}
              form={form}
              onChange={(next) => void applyForm(next)}
              disabled={expired}
            />

            {loading ? (
              <LoadingSpinner />
            ) : entries.length === 0 ? (
              <p className={styles.muted} data-testid="customer-timeline-empty">
                {filtered ? 'Nothing in this history matches these filters.' : 'Nothing to show yet.'}
              </p>
            ) : (
              <CustomerTimelineList entries={entries} />
            )}

            {!loading && nextCursor && (
              <div className={styles.loadMore}>
                <button type="button" className="btn-secondary" onClick={loadMore} disabled={loadingMore || expired}>
                  {loadingMore ? 'Loading…' : 'Load more'}
                </button>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export default function CustomerHistoryPage({ surface = 'agency' }: { surface?: Surface }) {
  const { role } = useTenant();
  const location = useLocation();
  const searchId = searchIdFromLocationState(location.state);
  const answer = customerSearchAnswer(searchId);
  const resultsPath = RESULTS_PATH[surface];

  let body;
  if (role === undefined) {
    body = <LoadingSpinner />;
  } else if (!hasPermission(role, 'agency.customer_history.read')) {
    body = (
      <EmptyState
        title="Customer history isn't available to you"
        description="Ask an account admin if you need to look up a customer's calls."
      />
    );
  } else {
    body = (
      <>
        <section className={`card ${styles.section}`} aria-label="Search a number">
          <CustomerSearchBox resultsPath={resultsPath} autoFocus={!answer} />
        </section>
        {answer ? (
          <CustomerHistoryResults key={answer.search_id} answer={answer} resultsPath={resultsPath} />
        ) : (
          <p className={styles.muted} data-testid="customer-history-intro">
            Search a phone number to see every call, callback and do-not-call entry for it, across every campaign
            and the soft phone, in the accounts you can see.
          </p>
        )}
      </>
    );
  }

  if (surface === 'agent') {
    return (
      <AgentSurfaceShell
        icon={<History size={20} />}
        title="Customer history"
        subtitle="Search a number to see every call to it."
        current="customers"
      >
        <div className={styles.page}>{body}</div>
      </AgentSurfaceShell>
    );
  }

  return (
    <div className={styles.page}>
      <PageHeader
        title="Customer history"
        subtitle="One number, every call to it across your campaigns and the soft phone."
      />
      {body}
    </div>
  );
}

/** `/dialer/customers`: the same page in the agent's own frame. */
export function AgentCustomerHistoryPage() {
  return <CustomerHistoryPage surface="agent" />;
}
