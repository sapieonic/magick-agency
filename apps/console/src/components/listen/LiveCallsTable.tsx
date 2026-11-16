import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, Headphones, PhoneCall, Smartphone } from 'lucide-react';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { LiveDot } from '@magick-agency/web-ui/components/LiveDot';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { formatPhone } from '@magick-agency/web-ui/format';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { usePermission } from '../../hooks/usePermission';
import { useRepaintTick } from '../../hooks/useRepaintTick';
import { useLiveCalls } from '../../hooks/listen/useLiveCalls';
import { revealLiveCallNumber } from '../../api/liveCalls';
import { elapsedSince } from '../../utils/agencyClock';
import { initialsFor } from '../../utils/initials';
import {
  LIVE_CALLS_COPY,
  LISTEN_REFUSAL_FALLBACK,
  ORIGIN_LABELS,
  campaignCellLabel,
  customerLabel,
  formatClock,
  inProgressLabel,
  notListenableCopy,
  updatedAgoLabel,
} from '../../utils/listen/listenCopy';
import {
  DEFAULT_LIVE_CALL_SORT,
  LIVE_CALL_TYPE_FILTERS,
  NO_LIVE_CALL_FILTERS,
  agentName,
  filterLiveCalls,
  isLiveCallOverrun,
  liveCallFilterOptions,
  liveCallRowPagePath,
  nextLiveCallSort,
  sortLiveCalls,
  type LiveCallFilters,
  type LiveCallSort,
  type LiveCallSortKey,
  type ShownLiveCall,
} from '../../utils/listen/liveCallsTable';
import type { AgencyLiveCall } from '../../types/live-calls';
import { useListen, type ListenContextValue } from './ListenProvider';
import spine from '../agency/SpineListLayout.module.css';
import styles from './LiveCallsTable.module.css';

export interface LiveCallsTableProps {
  /** One campaign's calls (its Calls tab, Live): no Campaign column or filter. */
  campaignId?: string;
  /** `h1` on the account page; `h2` under a campaign's header. */
  headingLevel?: 'h1' | 'h2';
  /** The calls in progress, as read: the campaign's "Live" segment shows it. */
  onCount?: (count: number | null) => void;
}

type Reveal = { status: 'loading' } | { status: 'shown'; phone: string } | { status: 'error' };

/**
 * The calls in progress (`docs/listening.md` §9): read every 5 s while visible, each with its
 * agent, customer (masked, with Show/Hide), campaign, type, time on call on the server's clock,
 * recording, who is listening, and the Listen action for a reader who holds
 * `agency.calls.listen`. Sorted longest on call first; Agent and Time on call sort.
 */
export function LiveCallsTable({ campaignId, headingLevel = 'h1', onCount }: LiveCallsTableProps) {
  const { tenantId, accountId } = useTenant();
  const { user } = useAuth();
  const supervise = usePermission('agency.supervise');
  const mayListen = usePermission('agency.calls.listen');
  const listen = useListen();
  const read = useLiveCalls({ tenantId, accountId, campaignId, enabled: supervise });
  const { rows, receivedAt, clockOffsetMs, failure } = read;
  useRepaintTick(rows !== null && rows.length > 0);

  const [filters, setFilters] = useState<LiveCallFilters>(NO_LIVE_CALL_FILTERS);
  const [sort, setSort] = useState<LiveCallSort>(DEFAULT_LIVE_CALL_SORT);
  const [reveals, setReveals] = useState<Record<string, Reveal>>({});
  const showCampaign = !campaignId;
  const showAction = Boolean(listen?.canListen);

  const liveCount = rows === null ? null : rows.filter((r) => r.endedAt === null).length;
  useEffect(() => {
    onCount?.(liveCount);
  }, [onCount, liveCount]);

  /*
    A shown number lives in this component's state only, never in the polled rows: leaving the
    page unmounts it and the number is masked again (LS9). A row that ends drops its number.
  */
  const liveIds = useMemo(() => new Set((rows ?? []).filter((r) => r.endedAt === null).map((r) => r.call.call_id)), [rows]);
  useEffect(() => {
    setReveals((prev) => {
      const kept = Object.entries(prev).filter(([id]) => liveIds.has(id));
      return kept.length === Object.keys(prev).length ? prev : Object.fromEntries(kept);
    });
  }, [liveIds]);

  const options = useMemo(() => liveCallFilterOptions((rows ?? []).map((r) => r.call)), [rows]);
  const shown = useMemo(() => sortLiveCalls(filterLiveCalls(rows ?? [], filters), sort), [rows, filters, sort]);

  const toggleNumber = useCallback(
    (callId: string) => {
      const current = reveals[callId];
      if (current && current.status !== 'error') {
        setReveals(({ [callId]: _gone, ...rest }) => rest);
        return;
      }
      setReveals((prev) => ({ ...prev, [callId]: { status: 'loading' } }));
      revealLiveCallNumber(callId, tenantId ?? undefined, accountId ?? undefined).then(
        (res) => setReveals((prev) => (prev[callId] ? { ...prev, [callId]: { status: 'shown', phone: res.customer_phone } } : prev)),
        () => setReveals((prev) => (prev[callId] ? { ...prev, [callId]: { status: 'error' } } : prev)),
      );
    },
    [reveals, tenantId, accountId],
  );

  const Heading = headingLevel;
  const now = Date.now();

  if (!supervise || failure === 'forbidden') {
    return <EmptyState icon={<PhoneCall size={22} />} title={LIVE_CALLS_COPY.title} description={LIVE_CALLS_COPY.forbidden} />;
  }
  if (failure === 'feature_disabled') {
    return <EmptyState icon={<PhoneCall size={22} />} title={LIVE_CALLS_COPY.title} description={LISTEN_REFUSAL_FALLBACK.featureDisabled} />;
  }

  return (
    /*
      `ph-no-capture`: every row carries a customer's name and number (the full number once
      shown), and PostHog autocapture, rage and dead clicks record a clicked element's text and
      attributes (the Show and Open call buttons are named after the customer). The whole table
      rather than chosen cells, so a column added later is covered too. See `CustomerSearchBox`
      for the mechanism and its pins (CH6: the number never reaches analytics).
    */
    <section aria-labelledby="live-calls-title" className="ph-no-capture" data-testid="live-calls">
      <header className={styles.header}>
        <div className={spine.headerCopy}>
          <span className={spine.titleIcon} aria-hidden="true">
            <PhoneCall size={20} />
          </span>
          <Heading id="live-calls-title" className={spine.title}>
            {LIVE_CALLS_COPY.title}
          </Heading>
        </div>
        {liveCount !== null ? (
          <span className={styles.countPill} data-testid="live-calls-count">
            <LiveDot live={liveCount > 0} size={7} />
            {inProgressLabel(liveCount)}
          </span>
        ) : null}
        {receivedAt !== null ? (
          <span className={styles.updated} data-testid="live-calls-updated">
            {updatedAgoLabel((now - receivedAt) / 1000)}
          </span>
        ) : null}
      </header>

      <div className={styles.filters} role="group" aria-label="Filter live calls">
        {showCampaign ? (
          <label className={styles.filter}>
            <span className="sr-only">Campaign</span>
            <select
              value={filters.campaign}
              onChange={(e) => setFilters((f) => ({ ...f, campaign: e.target.value }))}
              data-testid="live-calls-campaign-filter"
            >
              <option value="">All campaigns</option>
              {options.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className={styles.filter}>
          <span className="sr-only">Agent</span>
          <select
            value={filters.agent}
            onChange={(e) => setFilters((f) => ({ ...f, agent: e.target.value }))}
            data-testid="live-calls-agent-filter"
          >
            <option value="">All agents</option>
            {options.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.chips} role="group" aria-label="Type">
          {LIVE_CALL_TYPE_FILTERS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={styles.chip}
              aria-pressed={filters.type === t.id}
              onClick={() => setFilters((f) => ({ ...f, type: t.id }))}
              data-testid={`live-calls-type-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {failure === 'transient' ? (
        <p className={styles.error} role="alert" data-testid="live-calls-error">
          {LIVE_CALLS_COPY.error}
        </p>
      ) : null}

      {rows === null ? (
        failure ? null : <LoadingSpinner />
      ) : rows.length === 0 ? (
        <EmptyState icon={<PhoneCall size={22} />} title={LIVE_CALLS_COPY.emptyTitle} description={LIVE_CALLS_COPY.emptyBody} />
      ) : shown.length === 0 ? (
        <p className={styles.noMatch}>No calls in progress match these filters.</p>
      ) : (
        <div className={spine.tableWrap}>
          <table className={`${spine.table} ${styles.table}`} data-testid="live-calls-table">
            <caption className="sr-only">
              {campaignId ? 'Calls in progress on this campaign, longest on call first' : 'Calls in progress in this account, longest on call first'}
            </caption>
            <thead>
              <tr>
                <SortHeader label="Agent" sortKey="agent" sort={sort} onSort={setSort} />
                <th scope="col">Customer</th>
                {showCampaign ? <th scope="col">Campaign</th> : null}
                <th scope="col">Type</th>
                <SortHeader label="Time on call" sortKey="time" sort={sort} onSort={setSort} />
                <th scope="col">Recording</th>
                <th scope="col">Listening</th>
                {showAction ? <th scope="col"><span className="sr-only">Action</span></th> : null}
                <th scope="col"><span className="sr-only">{LIVE_CALLS_COPY.openCall}</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <LiveCallRow
                  key={row.call.call_id}
                  row={row}
                  now={now}
                  clockOffsetMs={clockOffsetMs}
                  showCampaign={showCampaign}
                  showAction={showAction}
                  listen={listen}
                  myUserId={user?.id ?? null}
                  reveal={reveals[row.call.call_id]}
                  onToggleNumber={toggleNumber}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!mayListen ? (
        <p className={styles.footnote} data-testid="live-calls-no-listen">
          {LIVE_CALLS_COPY.noPermission}
        </p>
      ) : null}
    </section>
  );
}

function SortHeader({
  label,
  sortKey,
  sort,
  onSort,
}: {
  label: string;
  sortKey: LiveCallSortKey;
  sort: LiveCallSort;
  onSort: (next: LiveCallSort) => void;
}) {
  const active = sort.key === sortKey;
  const Icon = active ? (sort.dir === 'asc' ? ArrowUp : ArrowDown) : ArrowUpDown;
  // Time on call `desc` is the longest first, which reads as descending time.
  const ariaSort = active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  return (
    <th scope="col" aria-sort={ariaSort}>
      <button type="button" className={styles.sortButton} onClick={() => onSort(nextLiveCallSort(sort, sortKey))} data-testid={`live-calls-sort-${sortKey}`}>
        {label}
        <Icon size={12} aria-hidden="true" />
      </button>
    </th>
  );
}

function LiveCallRow({
  row,
  now,
  clockOffsetMs,
  showCampaign,
  showAction,
  listen,
  myUserId,
  reveal,
  onToggleNumber,
}: {
  row: ShownLiveCall;
  now: number;
  clockOffsetMs: number;
  showCampaign: boolean;
  showAction: boolean;
  listen: ListenContextValue | null;
  myUserId: string | null;
  reveal: Reveal | undefined;
  onToggleNumber: (callId: string) => void;
}) {
  const { call, endedAt } = row;
  const ended = endedAt !== null;
  const session = listen?.state;
  const mine = Boolean(session && session.target?.callId === call.call_id && ['connecting', 'live', 'reconnecting'].includes(session.phase));
  const elapsed = elapsedSince(call.connected_at, clockOffsetMs, ended ? endedAt : now);
  // Amber past twice the campaign's average handle time, which the row carries (null: not known).
  const overrun = !ended && isLiveCallOverrun(elapsed, call.aht_seconds);
  const pagePath = liveCallRowPagePath(call);
  const name = agentName(call);
  const customer = customerLabel(call);
  const shownNumber = reveal?.status === 'shown' ? formatPhone(reveal.phone) : call.customer_phone_masked;

  return (
    <tr
      className={styles.row}
      data-mine={mine && session?.phase === 'live' ? 'true' : undefined}
      data-ended={ended ? 'true' : undefined}
      data-testid={`live-call-${call.call_id}`}
    >
      <td>
        <span className={styles.agent}>
          <span className={styles.avatar} aria-hidden="true">
            {initialsFor(call.agent_name ?? name)}
          </span>
          <span>{name}</span>
          {call.client_kind === 'mobile' ? (
            <span className={styles.mobile} title={LIVE_CALLS_COPY.mobileApp}>
              <Smartphone size={13} aria-hidden="true" />
              <span className="sr-only">{LIVE_CALLS_COPY.mobileApp}</span>
            </span>
          ) : null}
        </span>
      </td>
      <td>
        <span className={styles.customer}>
          <span className={call.customer_name ? styles.customerName : styles.muted}>{customer}</span>
          <span className={styles.number}>
            <span className={styles.mono} data-testid={`live-call-number-${call.call_id}`}>
              {shownNumber}
            </span>
            {!ended ? (
              <button
                type="button"
                className={styles.reveal}
                onClick={() => onToggleNumber(call.call_id)}
                disabled={reveal?.status === 'loading'}
                aria-label={`${reveal?.status === 'shown' ? LIVE_CALLS_COPY.hide : LIVE_CALLS_COPY.show} number for ${customer}`}
                data-testid={`live-call-reveal-${call.call_id}`}
              >
                {reveal?.status === 'shown' ? LIVE_CALLS_COPY.hide : LIVE_CALLS_COPY.show}
              </button>
            ) : null}
          </span>
          {reveal?.status === 'error' ? (
            <span className={styles.revealError} role="alert">
              {LIVE_CALLS_COPY.numberFailed}
            </span>
          ) : null}
        </span>
      </td>
      {showCampaign ? <td>{campaignCellLabel(call)}</td> : null}
      <td>
        <span className={styles.badge} data-origin={call.origin}>
          {ORIGIN_LABELS[call.origin]}
        </span>
      </td>
      <td>
        <span
          className={styles.timer}
          data-overrun={overrun ? 'true' : undefined}
          title={overrun ? LIVE_CALLS_COPY.overrun : undefined}
          data-testid={`live-call-timer-${call.call_id}`}
        >
          {formatClock(elapsed)}
          {overrun ? <span className="sr-only"> ({LIVE_CALLS_COPY.overrun})</span> : null}
        </span>
      </td>
      <td>
        <span className={styles.recording} data-on={call.recording ? 'true' : undefined}>
          <span className={styles.recordingDot} aria-hidden="true" />
          {call.recording ? LIVE_CALLS_COPY.recording : LIVE_CALLS_COPY.recordingOff}
        </span>
      </td>
      <td>
        <Listeners call={call} myUserId={myUserId} />
      </td>
      {showAction ? (
        <td className={styles.actionCell}>
          <Action call={call} ended={ended} mine={mine} listen={listen!} clockOffsetMs={clockOffsetMs} />
        </td>
      ) : null}
      <td className={styles.openCell}>
        {/* The call's own page (an inbound call has none in the console): open while live and after. */}
        {pagePath ? (
          <Link
            to={pagePath}
            className={styles.openCall}
            aria-label={`${LIVE_CALLS_COPY.openCall}: ${name} with ${customer}`}
            data-testid={`live-call-open-${call.call_id}`}
          >
            {LIVE_CALLS_COPY.openCall}
            <ExternalLink size={12} aria-hidden="true" />
          </Link>
        ) : null}
      </td>
    </tr>
  );
}

function Listeners({ call, myUserId }: { call: AgencyLiveCall; myUserId: string | null }) {
  if (call.listeners.length === 0) return <span className={styles.muted}>—</span>;
  const names = call.listeners.map((l) => (l.user_id === myUserId ? 'You' : l.name?.trim() || 'A supervisor'));
  return (
    <span className={styles.stack} title={names.join(', ')} data-testid={`live-call-listeners-${call.call_id}`}>
      {call.listeners.map((l, i) => (
        <span key={l.user_id} className={styles.stackAvatar} aria-hidden="true" data-you={l.user_id === myUserId ? 'true' : undefined}>
          {l.user_id === myUserId ? 'You' : initialsFor(l.name)}
        </span>
      )).slice(0, 3)}
      <span className="sr-only">{names.join(', ')}</span>
    </span>
  );
}

function Action({
  call,
  ended,
  mine,
  listen,
  clockOffsetMs,
}: {
  call: AgencyLiveCall;
  ended: boolean;
  mine: boolean;
  listen: ListenContextValue;
  clockOffsetMs: number;
}) {
  const reasonId = `live-call-reason-${call.call_id}`;
  if (ended) {
    return <span className={styles.muted} data-testid={`live-call-ended-${call.call_id}`}>{LIVE_CALLS_COPY.callEnded}</span>;
  }
  if (mine && listen.state.phase === 'live') {
    return (
      <button type="button" className={`btn-danger ${styles.actionButton}`} onClick={listen.stop} data-testid={`live-call-stop-${call.call_id}`}>
        <LiveDot live size={7} color="currentColor" />
        {LIVE_CALLS_COPY.stop}
      </button>
    );
  }
  if (mine) {
    return (
      <span className={styles.connecting} data-testid={`live-call-connecting-${call.call_id}`}>
        <LoadingSpinner size="sm" decorative />
        {LIVE_CALLS_COPY.connecting}
      </span>
    );
  }
  if (!call.listenable) {
    return (
      <span className={styles.refused}>
        <button type="button" className={`btn-secondary ${styles.actionButton}`} disabled aria-describedby={reasonId}>
          <Headphones size={14} aria-hidden="true" />
          {LIVE_CALLS_COPY.listen}
        </button>
        <span id={reasonId} className={styles.reason} data-testid={`live-call-reason-${call.call_id}`}>
          {notListenableCopy(call.not_listenable_reason)}
        </span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`btn-secondary ${styles.actionButton}`}
      onClick={() => listen.listen(call, clockOffsetMs)}
      aria-label={`Listen to ${agentName(call)}’s call`}
      data-listen-trigger={call.call_id}
      data-testid={`live-call-listen-${call.call_id}`}
    >
      <Headphones size={14} aria-hidden="true" />
      {LIVE_CALLS_COPY.listen}
    </button>
  );
}
