import { useCallback, useMemo } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { formatDate, formatTime } from '@magick-agency/web-ui/format';
import { useTenant } from '../../contexts/TenantContext';
import { useMissedCallsAccess } from '../../hooks/useMissedCallsAccess';
import { HOME_FAST_MS, useHomeBoard } from '../../hooks/useHomeBoard';
import { useTodaySoFar } from '../../hooks/useTodaySoFar';
import { useAgentFloor } from '../../hooks/useAgentFloor';
import { usePromisesToday } from '../../hooks/usePromisesToday';
import { useNow } from '../../hooks/useNow';
import { hasPermission } from '../../utils/permissions';
import { holdsHomePermission } from '../../utils/consoleNav';
import { homeAttention, sortByRank, HOME_CAMPAIGN_CAP } from '../../utils/agency/home';
import {
  breakOverrunItems,
  cardsFor,
  floorAgentsWorking,
  floorRowsFor,
  rankFloorCards,
  willPayByCampaign,
  willPayFor,
} from '../../utils/agency/liveFloorAgents';
import { CAMPAIGN_FILTER_PARAM, readsFor, selectedCampaign } from '../../utils/agency/liveFloor';
import { formatCount } from '../../utils/format/number';
import { GetStarted } from './campaigns-home/GetStarted';
import { LiveFloorHeader } from './live-floor/LiveFloorHeader';
import { LiveFloorKpis } from './live-floor/LiveFloorKpis';
import { NeedsYouNow, type BreaksChecked } from './live-floor/NeedsYouNow';
import { CampaignsPanel } from './live-floor/CampaignsPanel';
import { AgentsPanel } from './live-floor/AgentsPanel';
import styles from './live-floor/LiveFloor.module.css';

/**
 * Live floor (decisions B28a, LF1): the supervisor's landing page, Home until the redesign, at the
 * URL Home had. What needs them now, the active campaigns with Pause and Resume, the floor, and
 * today's totals, for every active campaign or one picked in the filter. A supervisor lands here
 * from `/agency` and after an account switch.
 *
 * Gated at `agency.supervise` (`HOME_GATE` in `utils/consoleNav`): every read it makes floors
 * there. Anyone else who opens the URL is sent to `/agency`, whose index picks their landing.
 *
 * Its reads: Home's shared board (`useHomeBoard`, every 10 s while open), today so far
 * (`useTodaySoFar`, one grouped read a minute and at local midnight) and the missed-calls count;
 * and Phase 2's own (B28b), which only this page asks for: the account's floor (`useAgentFloor`,
 * every 5 s) and today's promises (`usePromisesToday`, a minute and at local midnight). Retry reads
 * all three of the board, the floor and the promises again, a refused one included. The filter is
 * client side over the board's campaigns and kept in `?campaign=`, so it survives a reload.
 *
 * One risk clock: the floor is ranked ONCE (`rankFloorCards`), on the server's clock moved every
 * 5 s, and the same cards feed the grid, its chips and the breaks over the limit in Needs you now,
 * so a card's `long_break` and its row cross the limit together. A risk (a stripe, the order, Make
 * available, a break row) shows at most 5 s late; only the cards' time in state ticks every second.
 */
export default function HomePage() {
  const { role, tenantId, accountId, accounts } = useTenant();
  // `HOME_GATE`'s permission; its capability and flag are `/agency`'s route gates, passed here.
  const supervise = holdsHomePermission(role);
  const board = useHomeBoard({ tenantId, accountId, role, enabled: supervise, intervalMs: HOME_FAST_MS });
  const today = useTodaySoFar(tenantId, accountId, supervise);
  const missed = useMissedCallsAccess();
  // Live floor's own reads (B28b): only this page asks for them, never the sidebar badge.
  const agentFloor = useAgentFloor(tenantId, accountId, supervise, role);
  const promises = usePromisesToday(tenantId, accountId, supervise, role);
  // Retry reads everything the page asks for (B28a: a refusal stops the asking until Retry), so a
  // refused floor or promises read never stays stopped behind a board that came back.
  const { reload: reloadBoard } = board;
  const { reload: reloadFloor } = agentFloor;
  const { reload: reloadPromises } = promises;
  const retryFloor = useCallback(() => {
    reloadFloor();
    reloadPromises();
  }, [reloadFloor, reloadPromises]);
  const retry = useCallback(() => {
    reloadBoard();
    retryFloor();
  }, [reloadBoard, retryFloor]);
  const [params, setParams] = useSearchParams();

  const floorRows = agentFloor.floor?.agents;
  // The server's now (every anchor on the floor is the server's), moved every 5 s: the risks'
  // clock, which also keeps break rows counting while the floor's reads fail (marked stale then).
  const floorNowMs = useNow(5_000) + agentFloor.clockOffsetMs;
  const ranked = useMemo(() => (floorRows ? rankFloorCards(floorRows, floorNowMs) : null), [floorRows, floorNowMs]);
  const attention = useMemo(
    () => homeAttention(board.reads, { available: missed.available, count: missed.count }, formatDate),
    [board.reads, missed.available, missed.count],
  );
  const breaks = useMemo(
    () => (ranked ? breakOverrunItems(ranked, board.reads.map((r) => r.campaign), agentFloor.stale) : []),
    [ranked, board.reads, agentFloor.stale],
  );
  const items = useMemo(() => (breaks.length === 0 ? attention : sortByRank([...attention, ...breaks])), [attention, breaks]);
  const picked = selectedCampaign(params.get(CAMPAIGN_FILTER_PARAM), board.reads);
  const pickedId = picked?.id ?? null;
  const shown = useMemo(() => readsFor(board.reads, pickedId), [board.reads, pickedId]);
  const shownFloor = useMemo(() => (floorRows ? floorRowsFor(floorRows, pickedId) : null), [floorRows, pickedId]);
  const shownCards = useMemo(() => (ranked ? cardsFor(ranked, pickedId) : null), [ranked, pickedId]);
  const summary = promises.status === 'ready' ? promises.summary : null;
  const willPay = useMemo(() => (summary ? willPayFor(summary, pickedId) : null), [summary, pickedId]);
  const willPayByCard = useMemo(() => (summary ? willPayByCampaign(summary) : undefined), [summary]);
  const pick = useCallback((id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set(CAMPAIGN_FILTER_PARAM, id);
    else next.delete(CAMPAIGN_FILTER_PARAM);
    setParams(next, { replace: true });
  }, [params, setParams]);
  const showAll = useCallback(() => pick(null), [pick]);

  if (role === undefined) return <LoadingSpinner />;
  if (!supervise) return <Navigate to="/agency" replace />;

  const canCreate = hasPermission(role, 'agency.campaigns.write');
  const accountName = accounts?.find((a) => a.id === accountId)?.name;
  const noCampaigns = board.status === 'ready' && board.anyCampaign === false;
  const lastUpdated = board.lastUpdatedAt === null ? null : formatTime(new Date(board.lastUpdatedAt).toISOString());

  // Breaks over the limit come from the floor: unread, failed, refused or stale, they are unchecked.
  const breaksChecked: BreaksChecked = agentFloor.status === 'loading'
    ? 'checking'
    : agentFloor.status === 'ready' && agentFloor.floor && !agentFloor.stale ? 'checked' : 'unchecked';
  const agents = agentFloor.floor && shownFloor ? floorAgentsWorking(agentFloor.floor, shownFloor, pickedId, board.reads) : undefined;

  return (
    <div className={styles.page}>
      <LiveFloorHeader
        accountName={accountName}
        campaigns={board.reads.map((r) => r.campaign)}
        selectedId={pickedId}
        onSelect={pick}
        // With no campaign at all the get-started card carries the button instead.
        canCreate={canCreate && !noCampaigns}
        showFilter={board.status === 'ready' && board.reads.length > 0}
      />

      {/* The hook's copy (`HOME_BOARD_ERROR`), never the server's text. */}
      {board.status === 'error' && board.error && <ErrorAlert message={board.error} onRetry={retry} />}
      {(board.status === 'loading' || board.status === 'idle') && <LoadingSpinner />}

      {board.status === 'ready' && board.stale && (
        <div className={styles.staleNote} role="status" data-testid="home-stale">
          <span>{`Couldn’t refresh. Last updated ${lastUpdated ?? ''}`}</span>
          <button type="button" className={`btn-secondary ${styles.action}`} onClick={retry}>
            <RefreshCw size={14} aria-hidden="true" />
            Retry
          </button>
        </div>
      )}

      {/* Its own read, so it shows whatever became of the board's. */}
      <LiveFloorKpis board={board} reads={shown} today={today} campaignId={pickedId} agents={agents} willPay={willPay} />

      {board.status === 'ready' && (
        <>
          <div className={styles.mid}>
            <NeedsYouNow
              items={items}
              campaignId={pickedId}
              campaignName={picked?.name ?? null}
              stale={board.stale}
              lastUpdated={lastUpdated}
              breaks={breaksChecked}
              onShowAll={showAll}
            />
            {noCampaigns ? (
              <GetStarted canCreate={canCreate} canInvite={hasPermission(role, 'user.invite')} />
            ) : (
              <CampaignsPanel reads={shown} onChanged={board.reload} willPay={willPayByCard} />
            )}
          </div>

          {!noCampaigns && (
            <AgentsPanel
              reads={shown}
              floor={shownFloor && shownCards ? { rows: shownFloor, cards: shownCards, clockOffsetMs: agentFloor.clockOffsetMs, stale: agentFloor.stale, onChanged: agentFloor.reload } : null}
              floorFailed={agentFloor.status === 'error' || agentFloor.status === 'refused'}
              onRetryFloor={retryFloor}
            />
          )}

          {board.activeTotal > board.reads.length && (
            <p className={styles.cardNote} data-testid="home-cap-note">
              {`Live floor reads the first ${HOME_CAMPAIGN_CAP} of ${formatCount(board.activeTotal)} active campaigns. The rest are on the Campaigns page.`}
            </p>
          )}
        </>
      )}
    </div>
  );
}
