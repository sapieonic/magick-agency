import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUp, ArrowUpDown, ExternalLink, Headphones, PhoneCall, Smartphone } from 'lucide-react';
import { EmptyState } from '@magick-agency/web-ui/components/EmptyState';
import { LiveDot } from '@magick-agency/web-ui/components/LiveDot';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { formatPhone } from '@magick-agency/web-ui/format';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { SOFTPHONE_FLAG, useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { usePermission } from '../../hooks/usePermission';
import { useRepaintTick } from '../../hooks/useRepaintTick';
import { useLiveCalls } from '../../hooks/listen/useLiveCalls';
import { revealLiveCallNumber } from '../../api/liveCalls';
import { elapsedSince } from '../../utils/agencyClock';
import { errorCode, errorStatus } from '../../utils/agencyErrors';
import { initialsFor } from '../../utils/initials';
import {
  LIVE_CALLS_COPY,
  LISTEN_REFUSAL_FALLBACK,
  ORIGIN_LABELS,
  campaignCellLabel,
  customerLabel,
  formatClock,
  inProgressLabel,
  listenToLabel,
  moreListenersLabel,
  notListenableCopy,
  openCallLabel,
  revealLabel,
  stopListeningToLabel,
  updatedAgoLabel,
} from '../../utils/listen/listenCopy';
import {
  DEFAULT_LIVE_CALL_SORT,
  LIVE_CALL_TYPE_FILTERS,
  NO_LIVE_CALL_FILTERS,
  agentName,
  filterLiveCalls,
  hasLiveCallFilters,
  isLiveCallOverrun,
  liveCallFilterOptions,
  liveCallPagePath,
  nextLiveCallSort,
  sortLiveCalls,
  type LiveCallFilters,
  type LiveCallSort,
  type LiveCallSortKey,
  type LiveCallTypeFilter,
  type ShownLiveCall,
} from '../../utils/listen/liveCallsTable';
import type { FilterOption } from '../../utils/listen/filterOptions';
import type { ListenPhase } from '../../utils/listen/listenSessionReducer';
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

/**
 * One row's number reveal. `withheld`: the reveal answered `404 live_call_number_withheld` (the
 * row did not say so first): "Withheld", and Show is offered no more.
 */
type Reveal = { status: 'loading' } | { status: 'shown'; phone: string } | { status: 'withheld' } | { status: 'error' };

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
  // The clocks ("Updated N s ago", each row's time on call) repaint themselves: the table, its
  // rows and their filters do not re-render on every tick.

  // The agent and campaign chosen, by name: kept on offer after their calls end, so the filter in
  // force still reads as itself in its control.
  const [chosen, setChosen] = useState<ChosenLiveCallFilters>(NO_CHOSEN_FILTERS);
  const filters = useMemo<LiveCallFilters>(
    () => ({ type: chosen.type, agent: chosen.agent?.id ?? '', campaign: chosen.campaign?.id ?? '' }),
    [chosen],
  );
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

  const options = useMemo(() => liveCallFilterOptions((rows ?? []).map((r) => r.call), chosen), [rows, chosen]);
  const filtered = hasLiveCallFilters(filters);
  const clearFilters = useCallback(() => setChosen(NO_CHOSEN_FILTERS), []);
  const chooseAgent = (id: string) => setChosen((c) => ({ ...c, agent: options.agents.find((a) => a.id === id) ?? null }));
  const chooseCampaign = (id: string) => setChosen((c) => ({ ...c, campaign: options.campaigns.find((o) => o.id === id) ?? null }));
  const shown = useMemo(() => sortLiveCalls(filterLiveCalls(rows ?? [], filters), sort), [rows, filters, sort]);

  // The latest reveals for the toggle, which stays one function so the rows it is handed to keep
  // their memo.
  const revealsRef = useRef(reveals);
  revealsRef.current = reveals;
  const toggleNumber = useCallback(
    (callId: string) => {
      const current = revealsRef.current[callId];
      if (current?.status === 'withheld') return;
      if (current && current.status !== 'error') {
        setReveals(({ [callId]: _gone, ...rest }) => rest);
        return;
      }
      setReveals((prev) => ({ ...prev, [callId]: { status: 'loading' } }));
      revealLiveCallNumber(callId, tenantId ?? undefined, accountId ?? undefined).then(
        (res) => setReveals((prev) => (prev[callId] ? { ...prev, [callId]: { status: 'shown', phone: res.customer_phone } } : prev)),
        (err: unknown) => {
          const withheld = errorStatus(err) === 404 && errorCode(err) === 'live_call_number_withheld';
          setReveals((prev) => (prev[callId] ? { ...prev, [callId]: withheld ? { status: 'withheld' } : { status: 'error' } } : prev));
        },
      );
    },
    [tenantId, accountId],
  );

  // Read once for every row: the soft phone's call page is behind its flag.
  const softphoneEnabled = useFeatureFlagEnabled(SOFTPHONE_FLAG);
  // The row being listened to, and how far the listen has got; every other row gets null.
  const session = listen?.state;
  const minePhase = session && MINE_PHASES.has(session.phase) ? session.phase : null;
  const mineCallId = minePhase ? session?.target?.callId ?? null : null;

  const Heading = headingLevel;

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
        {/* Nothing in progress: the empty state says so; "0 in progress" beside it is noise. */}
        {liveCount !== null && liveCount > 0 ? (
          <span className={styles.countPill} data-testid="live-calls-count">
            <LiveDot live={liveCount > 0} size={7} />
            {inProgressLabel(liveCount)}
          </span>
        ) : null}
        {receivedAt !== null ? <UpdatedAgo receivedAt={receivedAt} /> : null}
      </header>

      <div className={styles.filters} role="group" aria-label={LIVE_CALLS_COPY.filters}>
        {showCampaign ? (
          <label className={styles.filter}>
            <span className="sr-only">{LIVE_CALLS_COPY.campaignFilter}</span>
            <select
              value={filters.campaign}
              onChange={(e) => chooseCampaign(e.target.value)}
              data-testid="live-calls-campaign-filter"
            >
              <option value="">{LIVE_CALLS_COPY.allCampaigns}</option>
              {options.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className={styles.filter}>
          <span className="sr-only">{LIVE_CALLS_COPY.agentFilter}</span>
          <select
            value={filters.agent}
            onChange={(e) => chooseAgent(e.target.value)}
            data-testid="live-calls-agent-filter"
          >
            <option value="">{LIVE_CALLS_COPY.allAgents}</option>
            {options.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <div className={styles.chips} role="group" aria-label={LIVE_CALLS_COPY.typeFilter}>
          {LIVE_CALL_TYPE_FILTERS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={styles.chip}
              aria-pressed={filters.type === t.id}
              onClick={() => setChosen((c) => ({ ...c, type: t.id }))}
              data-testid={`live-calls-type-${t.id}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        {filtered ? (
          <button type="button" className={styles.clearFilters} onClick={clearFilters} data-testid="live-calls-clear-filters">
            {LIVE_CALLS_COPY.clearFilters}
          </button>
        ) : null}
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
        <p className={styles.noMatch}>
          {LIVE_CALLS_COPY.noMatch}{' '}
          <button type="button" className={styles.clearFilters} onClick={clearFilters} data-testid="live-calls-clear-filters">
            {LIVE_CALLS_COPY.clearFilters}
          </button>
        </p>
      ) : (
        <div className={spine.tableWrap}>
          <table className={`${spine.table} ${styles.table}`} data-testid="live-calls-table">
            <caption className="sr-only">
              {campaignId ? LIVE_CALLS_COPY.captionCampaign : LIVE_CALLS_COPY.captionAccount}
            </caption>
            <thead>
              <tr>
                <SortHeader label={LIVE_CALLS_COPY.columnAgent} sortKey="agent" sort={sort} onSort={setSort} />
                <th scope="col">{LIVE_CALLS_COPY.columnCustomer}</th>
                {showCampaign ? <th scope="col">{LIVE_CALLS_COPY.columnCampaign}</th> : null}
                <th scope="col">{LIVE_CALLS_COPY.columnType}</th>
                <SortHeader label={LIVE_CALLS_COPY.columnTime} sortKey="time" sort={sort} onSort={setSort} />
                <th scope="col">{LIVE_CALLS_COPY.columnRecording}</th>
                <th scope="col">{LIVE_CALLS_COPY.columnListening}</th>
                {showAction ? <th scope="col"><span className="sr-only">{LIVE_CALLS_COPY.columnAction}</span></th> : null}
                <th scope="col"><span className="sr-only">{LIVE_CALLS_COPY.openCall}</span></th>
              </tr>
            </thead>
            <tbody>
              {shown.map((row) => (
                <LiveCallRow
                  key={row.call.call_id}
                  row={row}
                  clockOffsetMs={clockOffsetMs}
                  showCampaign={showCampaign}
                  showAction={showAction}
                  softphoneEnabled={softphoneEnabled}
                  minePhase={row.call.call_id === mineCallId ? minePhase : null}
                  onListen={listen?.listen}
                  onStop={listen?.stop}
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

/** "Updated N s ago", repainting itself: with no rows, a run of failed reads changes no state after the first. */
function UpdatedAgo({ receivedAt }: { receivedAt: number }) {
  useRepaintTick();
  return (
    <span className={styles.updated} data-testid="live-calls-updated">
      {updatedAgoLabel((Date.now() - receivedAt) / 1000)}
    </span>
  );
}

/** A row's time on call, on the server's clock, repainting itself while the call is live; amber past its overrun. */
function TimeOnCall({ call, endedAt, clockOffsetMs }: { call: AgencyLiveCall; endedAt: number | null; clockOffsetMs: number }) {
  const ended = endedAt !== null;
  useRepaintTick(!ended);
  const elapsed = elapsedSince(call.connected_at, clockOffsetMs, ended ? endedAt : Date.now());
  // Amber past twice the campaign's average handle time, which the row carries (null: not known).
  const overrun = !ended && isLiveCallOverrun(elapsed, call.aht_seconds);
  return (
    <span
      className={styles.timer}
      data-overrun={overrun ? 'true' : undefined}
      title={overrun ? LIVE_CALLS_COPY.overrun : undefined}
      data-testid={`live-call-timer-${call.call_id}`}
    >
      {formatClock(elapsed)}
      {overrun ? <span className="sr-only"> ({LIVE_CALLS_COPY.overrun})</span> : null}
    </span>
  );
}

/** The listen phases in which a row is the supervisor's own: Stop is offered on it. */
const MINE_PHASES: ReadonlySet<ListenPhase> = new Set(['connecting', 'live', 'reconnecting']);

/** The filters as chosen: the agent and campaign by name, so each stays on offer after its calls end. */
interface ChosenLiveCallFilters {
  type: LiveCallTypeFilter;
  agent: FilterOption | null;
  campaign: FilterOption | null;
}

const NO_CHOSEN_FILTERS: ChosenLiveCallFilters = { type: NO_LIVE_CALL_FILTERS.type, agent: null, campaign: null };

const LiveCallRow = memo(function LiveCallRow({
  row,
  clockOffsetMs,
  showCampaign,
  showAction,
  softphoneEnabled,
  minePhase,
  onListen,
  onStop,
  myUserId,
  reveal,
  onToggleNumber,
}: {
  row: ShownLiveCall;
  clockOffsetMs: number;
  showCampaign: boolean;
  showAction: boolean;
  softphoneEnabled: boolean;
  /** This row's listen, when it is the supervisor's own: how far it has got. */
  minePhase: ListenPhase | null;
  onListen: ListenContextValue['listen'] | undefined;
  onStop: ListenContextValue['stop'] | undefined;
  myUserId: string | null;
  reveal: Reveal | undefined;
  onToggleNumber: (callId: string) => void;
}) {
  const { call, endedAt } = row;
  const ended = endedAt !== null;
  // The soft phone's call page is behind its flag: no link to a page that would say it is unavailable.
  const pagePath = liveCallPagePath(call, softphoneEnabled);
  const name = agentName(call);
  const customer = customerLabel(call);
  // A caller who withheld their number has none to show: "Withheld", and no Show (LS22 i).
  const withheld = Boolean(call.customer_phone_withheld) || reveal?.status === 'withheld';
  const shownNumber = withheld
    ? LIVE_CALLS_COPY.withheld
    : reveal?.status === 'shown' ? formatPhone(reveal.phone) : call.customer_phone_masked;

  return (
    <tr
      className={styles.row}
      data-mine={minePhase === 'live' ? 'true' : undefined}
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
            {!ended && !withheld ? (
              <button
                type="button"
                className={styles.reveal}
                onClick={() => onToggleNumber(call.call_id)}
                disabled={reveal?.status === 'loading'}
                aria-label={revealLabel(reveal?.status === 'shown', customer)}
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
        <TimeOnCall call={call} endedAt={endedAt} clockOffsetMs={clockOffsetMs} />
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
          <Action call={call} ended={ended} minePhase={minePhase} onListen={onListen!} onStop={onStop!} clockOffsetMs={clockOffsetMs} />
        </td>
      ) : null}
      <td className={styles.openCell}>
        {/* The call's own page (an inbound call has none in the console): open while live and after. */}
        {pagePath ? (
          <Link
            to={pagePath}
            className={styles.openCall}
            aria-label={openCallLabel(name, customer)}
            data-testid={`live-call-open-${call.call_id}`}
          >
            {LIVE_CALLS_COPY.openCall}
            <ExternalLink size={12} aria-hidden="true" />
          </Link>
        ) : null}
      </td>
    </tr>
  );
});

/** Avatars shown in the Listening stack; the rest are "+N" (every name is in the title and to a screen reader). */
const LISTENER_AVATARS = 3;

function Listeners({ call, myUserId }: { call: AgencyLiveCall; myUserId: string | null }) {
  if (call.listeners.length === 0) return <span className={styles.muted}>—</span>;
  const names = call.listeners.map((l) => (l.user_id === myUserId ? LIVE_CALLS_COPY.you : l.name?.trim() || LIVE_CALLS_COPY.aSupervisor));
  const more = call.listeners.length - LISTENER_AVATARS;
  return (
    <span className={styles.stack} title={names.join(', ')} data-testid={`live-call-listeners-${call.call_id}`}>
      {call.listeners.slice(0, LISTENER_AVATARS).map((l) => (
        <span key={l.user_id} className={styles.stackAvatar} aria-hidden="true" data-avatar="" data-you={l.user_id === myUserId ? 'true' : undefined}>
          {l.user_id === myUserId ? LIVE_CALLS_COPY.you : initialsFor(l.name)}
        </span>
      ))}
      {more > 0 ? (
        <span className={`${styles.stackAvatar} ${styles.stackMore}`} aria-hidden="true" data-testid={`live-call-listeners-more-${call.call_id}`}>
          {moreListenersLabel(more)}
        </span>
      ) : null}
      <span className="sr-only">{names.join(', ')}</span>
    </span>
  );
}

function Action({
  call,
  ended,
  minePhase,
  onListen,
  onStop,
  clockOffsetMs,
}: {
  call: AgencyLiveCall;
  ended: boolean;
  minePhase: ListenPhase | null;
  onListen: ListenContextValue['listen'];
  onStop: ListenContextValue['stop'];
  clockOffsetMs: number;
}) {
  const reasonId = `live-call-reason-${call.call_id}`;
  if (ended) {
    return <span className={styles.muted} data-testid={`live-call-ended-${call.call_id}`}>{LIVE_CALLS_COPY.callEnded}</span>;
  }
  if (minePhase === 'live') {
    return (
      <button type="button" className={`btn-danger ${styles.actionButton}`} onClick={onStop} data-testid={`live-call-stop-${call.call_id}`}>
        <LiveDot live size={7} color="currentColor" />
        {LIVE_CALLS_COPY.stop}
      </button>
    );
  }
  if (minePhase) {
    // Connecting or reconnecting: still the supervisor's to stop, from the row as from the bar.
    return (
      <span className={styles.refused}>
        <span className={styles.connecting} data-testid={`live-call-connecting-${call.call_id}`}>
          <LoadingSpinner size="sm" decorative />
          {minePhase === 'reconnecting' ? LIVE_CALLS_COPY.reconnecting : LIVE_CALLS_COPY.connecting}
        </span>
        <button
          type="button"
          className={`btn-secondary ${styles.actionButton}`}
          onClick={onStop}
          aria-label={stopListeningToLabel(agentName(call))}
          data-testid={`live-call-stop-${call.call_id}`}
        >
          {LIVE_CALLS_COPY.stop}
        </button>
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
          {notListenableCopy(call.not_listenable_reason, call.listeners.length)}
        </span>
      </span>
    );
  }
  return (
    <button
      type="button"
      className={`btn-secondary ${styles.actionButton}`}
      onClick={() => onListen(call, clockOffsetMs)}
      aria-label={listenToLabel(agentName(call))}
      data-listen-trigger={call.call_id}
      data-testid={`live-call-listen-${call.call_id}`}
    >
      <Headphones size={14} aria-hidden="true" />
      {LIVE_CALLS_COPY.listen}
    </button>
  );
}
