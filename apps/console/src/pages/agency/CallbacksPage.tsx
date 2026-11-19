import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { formatDate, formatTime } from '@magick-agency/web-ui/format';
import type { AgencyAccountCallback, AgencyCallbacksDue } from '@magick-agency/contracts/api/agency/callbacks';
import { listAccountCallbacks } from '../../api/agencyFloorAssist';
import { useTenant } from '../../contexts/TenantContext';
import { HOME_SLOW_MS, useHomeBoard } from '../../hooks/useHomeBoard';
import { holdsHomePermission } from '../../utils/consoleNav';
import { callbacksSummary, lateCallbacksFigure } from '../../utils/agency/liveFloor';
import {
  CALLBACKS_CAMPAIGN_PARAM,
  CALLBACKS_DUE_PARAM,
  CALLBACKS_TABS,
  CALLBACK_SOURCE_LABELS,
  appendCallbackRows,
  callbackContactHref,
  callbackCustomer,
  callbackDueText,
  callbackOwner,
  callbackRowKey,
  callbacksDueOf,
  callbacksEmptyText,
  callbacksErrorText,
} from '../../utils/agency/accountCallbacks';
import styles from './live-floor/LiveFloor.module.css';
import own from './CallbacksPage.module.css';

type ListState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; rows: AgencyAccountCallback[]; cursor: string | null; asOf: string };

/**
 * Callbacks (decisions LF1, LF22, LF32): every open callback in the account in one list, from
 * `GET /proxy/agency/callbacks`, oldest due first across the active campaigns.
 *
 * - **Tabs**: Overdue (the default) and Due later today, kept in `?due=`; a campaign filter kept in
 *   `?campaign=` (the board's active campaigns name the choices). Changing either reads page one again.
 * - **Rows**: the customer's name (never the number: the read carries none), the campaign, when it is
 *   due in the reader's zone, who has it and whether they are live on the campaign now (or the shared
 *   queue), how it was booked, and a link to the contact in its campaign.
 * - **Paging**: a keyset "Load more" from the page's `next_cursor`, appended; a failed page keeps the
 *   rows and offers to try again. A late answer for a tab or filter no longer shown is dropped.
 * - The summary line is the board's late-callbacks figure (`callbacksSummary`, the badge's), read at
 *   the badge's period; with the sidebar badge mounted it adds no request.
 *
 * Gated as Live floor (`CALLBACKS_GATE`, `agency.supervise`, which the read floors at).
 */
export default function CallbacksPage() {
  const { role, tenantId, accountId } = useTenant();
  const supervise = holdsHomePermission(role);
  const board = useHomeBoard({ tenantId, accountId, role, enabled: supervise, intervalMs: HOME_SLOW_MS });
  const [params, setParams] = useSearchParams();
  const due = callbacksDueOf(params.get(CALLBACKS_DUE_PARAM));
  const campaignId = params.get(CALLBACKS_CAMPAIGN_PARAM) || null;
  const [list, setList] = useState<ListState>({ status: 'loading' });
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle');
  const [reloads, setReloads] = useState(0);
  // The query a response answers must still be the one shown: a tab switched mid-read drops it.
  const generation = useRef(0);
  const tabsId = useId();
  const filterId = useId();
  const now = new Date();

  useEffect(() => {
    if (!supervise || !tenantId || !accountId) return;
    const mine = ++generation.current;
    setList({ status: 'loading' });
    setMore('idle');
    listAccountCallbacks({ due, ...(campaignId ? { campaign_id: campaignId } : {}) }, tenantId, accountId)
      .then((page) => {
        if (generation.current === mine) setList({ status: 'ready', rows: page.rows, cursor: page.next_cursor, asOf: page.as_of });
      })
      .catch((err: unknown) => {
        if (generation.current === mine) setList({ status: 'error', message: callbacksErrorText(err) });
      });
  }, [supervise, tenantId, accountId, due, campaignId, reloads]);

  const loadMore = useCallback(() => {
    if (list.status !== 'ready' || list.cursor === null || !tenantId || !accountId) return;
    const mine = generation.current;
    const { rows, cursor } = list;
    setMore('loading');
    listAccountCallbacks({ due, cursor, ...(campaignId ? { campaign_id: campaignId } : {}) }, tenantId, accountId)
      .then((page) => {
        if (generation.current !== mine) return;
        // A row can move between pages while paging (its due time changed, another came in): each once.
        setList({ status: 'ready', rows: appendCallbackRows(rows, page.rows), cursor: page.next_cursor, asOf: page.as_of });
        setMore('idle');
      })
      .catch(() => {
        if (generation.current === mine) setMore('error');
      });
  }, [list, tenantId, accountId, due, campaignId]);

  const setParam = useCallback((key: string, value: string | null) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  }, [params, setParams]);
  const pickTab = useCallback((id: AgencyCallbacksDue) => setParam(CALLBACKS_DUE_PARAM, id === 'overdue' ? null : id), [setParam]);

  const campaigns = useMemo(() => board.reads.map((r) => r.campaign), [board.reads]);
  const pickedName = campaignId
    ? campaigns.find((c) => c.id === campaignId)?.name
      ?? (list.status === 'ready' ? list.rows[0]?.campaign_name : undefined)
      ?? null
    : null;

  if (role === undefined) return <LoadingSpinner />;
  if (!supervise) return <Navigate to="/agency" replace />;

  const summary = board.status === 'ready' ? callbacksSummary(lateCallbacksFigure(board)) : null;

  // Arrow keys move between the tabs (the WAI-ARIA tabs pattern), Home and End to either end.
  const onTabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const last = CALLBACKS_TABS.length - 1;
    const to = event.key === 'ArrowRight' ? (index === last ? 0 : index + 1)
      : event.key === 'ArrowLeft' ? (index === 0 ? last : index - 1)
        : event.key === 'Home' ? 0 : event.key === 'End' ? last : null;
    if (to === null) return;
    event.preventDefault();
    const tab = CALLBACKS_TABS[to]!;
    pickTab(tab.id);
    document.getElementById(`${tabsId}-${tab.id}`)?.focus();
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>Callbacks</h1>
          {summary !== null && <p className={styles.cardNote} data-testid="callbacks-summary">{summary}</p>}
        </div>
      </header>

      <section className={styles.card} aria-labelledby={`${tabsId}-${due}`}>
        <div className={own.controls}>
          <div role="tablist" aria-label="Which callbacks" className={own.tabs}>
            {CALLBACKS_TABS.map((tab, index) => (
              <button
                key={tab.id}
                id={`${tabsId}-${tab.id}`}
                type="button"
                role="tab"
                aria-selected={due === tab.id}
                aria-controls={`${tabsId}-panel`}
                tabIndex={due === tab.id ? 0 : -1}
                className={own.tab}
                onClick={() => pickTab(tab.id)}
                onKeyDown={(event) => onTabKey(event, index)}
                data-testid={`callbacks-tab-${tab.id}`}
              >
                {tab.label}
              </button>
            ))}
          </div>
          <div className={own.filter}>
            <label htmlFor={filterId} className={styles.cardNote}>Campaign</label>
            <select
              id={filterId}
              className={own.select}
              value={campaignId ?? ''}
              onChange={(event) => setParam(CALLBACKS_CAMPAIGN_PARAM, event.target.value || null)}
              data-testid="callbacks-campaign"
            >
              <option value="">All active campaigns</option>
              {campaignId && !campaigns.some((c) => c.id === campaignId) && (
                <option value={campaignId}>{pickedName ?? 'This campaign'}</option>
              )}
              {campaigns.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <button
              type="button"
              className={`btn-secondary ${styles.smallButton}`}
              onClick={() => setReloads((n) => n + 1)}
              disabled={list.status === 'loading'}
              data-testid="callbacks-refresh"
            >
              <RefreshCw size={14} aria-hidden="true" />
              Refresh
            </button>
          </div>
        </div>

        <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${due}`} className={own.panel}>
          {list.status === 'loading' && <LoadingSpinner />}
          {list.status === 'error' && <ErrorAlert message={list.message} onRetry={() => setReloads((n) => n + 1)} />}
          {list.status === 'ready' && (
            <>
              <p className={styles.cardNote} data-testid="callbacks-as-of">
                {`As of ${formatTime(list.asOf)}. Times are in your time zone.`}
              </p>
              {list.rows.length === 0 ? (
                <p className={styles.quiet} data-testid="callbacks-empty">{callbacksEmptyText(due, campaignId ? { name: pickedName } : null)}</p>
              ) : (
                <ul className={own.rows} data-testid="callbacks-list">
                  {list.rows.map((row) => {
                    const owner = callbackOwner(row);
                    const customer = callbackCustomer(row);
                    return (
                      <li key={callbackRowKey(row)} className={own.row} data-testid={`callbacks-row-${row.contact_id}`}>
                        <div className={own.rowName}>
                          <span className={own.name}>{customer}</span>
                          <span className={own.campaign}>{row.campaign_name}</span>
                        </div>
                        <dl className={own.facts}>
                          <div>
                            <dt>Due</dt>
                            <dd data-tone={due === 'overdue' ? 'danger' : undefined}>
                              <time dateTime={row.due_at} title={formatDate(row.due_at)}>{callbackDueText(row.due_at, now)}</time>
                            </dd>
                          </div>
                          <div>
                            <dt>With</dt>
                            <dd>
                              {owner.name}
                              {owner.live !== null && (
                                <span className={own.presence} data-live={owner.live ? 'true' : 'false'}>
                                  {owner.live ? 'Live' : 'Away'}
                                </span>
                              )}
                            </dd>
                          </div>
                          <div>
                            <dt>From</dt>
                            <dd>{CALLBACK_SOURCE_LABELS[row.source]}</dd>
                          </div>
                        </dl>
                        <Link
                          to={callbackContactHref(row)}
                          className={`btn-secondary ${styles.smallButton}`}
                          aria-label={`Open contact: ${customer}, ${row.campaign_name}`}
                        >
                          Open contact
                          <ChevronRight size={15} aria-hidden="true" />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
              {list.cursor !== null && (
                <div className={own.more}>
                  {more === 'error' && <p className="error-text" role="alert">We couldn’t load more callbacks. Try again.</p>}
                  <button
                    type="button"
                    className="btn-secondary"
                    onClick={loadMore}
                    disabled={more === 'loading'}
                    data-testid="callbacks-more"
                  >
                    {more === 'loading' ? 'Loading…' : 'Load more'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </section>
    </div>
  );
}
