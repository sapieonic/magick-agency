import { useMemo } from 'react';
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
import { hasPermission } from '../../utils/permissions';
import { holdsHomePermission } from '../../utils/consoleNav';
import { homeAttention, sortByRank, HOME_CAMPAIGN_CAP } from '../../utils/agency/home';
import {
  breakOverrunItems,
  floorAgentsWorking,
  floorRowsFor,
  rankFloorCards,
  willPayByCampaign,
  willPayFor,
  willPayLine,
} from '../../utils/agency/liveFloorAgents';
import { CAMPAIGN_FILTER_PARAM, readsFor, selectedCampaign } from '../../utils/agency/liveFloor';
import { formatCount } from '../../utils/format/number';
import { GetStarted } from './campaigns-home/GetStarted';
import { LiveFloorHeader } from './live-floor/LiveFloorHeader';
import { LiveFloorKpis } from './live-floor/LiveFloorKpis';
import { NeedsYouNow } from './live-floor/NeedsYouNow';
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
 * Its reads are Home's: the shared board (`useHomeBoard`, every 10 s while open), today so far
 * (`useTodaySoFar`, one grouped read a minute) and the missed-calls count. The filter is client
 * side over the board's campaigns and kept in `?campaign=`, so it survives a reload.
 */
export default function HomePage() {
  const { role, tenantId, accountId, accounts } = useTenant();
  // `HOME_GATE`'s permission; its capability and flag are `/agency`'s route gates, passed here.
  const supervise = holdsHomePermission(role);
  const board = useHomeBoard({ tenantId, accountId, role, enabled: supervise, intervalMs: HOME_FAST_MS });
  const today = useTodaySoFar(tenantId, accountId, supervise);
  const missed = useMissedCallsAccess();
  // Live floor's own reads (B28b): only this page asks for them, never the sidebar badge.
  const agentFloor = useAgentFloor(tenantId, accountId, supervise);
  const promises = usePromisesToday(tenantId, accountId, supervise);
  const [params, setParams] = useSearchParams();

  const floorRows = agentFloor.floor?.agents;
  const items = useMemo(() => {
    const fromBoard = homeAttention(board.reads, { available: missed.available, count: missed.count }, formatDate);
    if (!floorRows) return fromBoard;
    // Breaks over the limit, from the floor (re-measured on every floor read, every 5 s).
    const breaks = breakOverrunItems(rankFloorCards(floorRows, Date.now()), board.reads.map((r) => r.campaign));
    return sortByRank([...fromBoard, ...breaks]);
  }, [board.reads, missed.available, missed.count, floorRows]);
  const picked = selectedCampaign(params.get(CAMPAIGN_FILTER_PARAM), board.reads);
  const pickedId = picked?.id ?? null;
  const shown = useMemo(() => readsFor(board.reads, pickedId), [board.reads, pickedId]);
  const shownFloor = useMemo(() => (floorRows ? floorRowsFor(floorRows, pickedId) : null), [floorRows, pickedId]);

  if (role === undefined) return <LoadingSpinner />;
  if (!supervise) return <Navigate to="/agency" replace />;

  const canCreate = hasPermission(role, 'agency.campaigns.write');
  const accountName = accounts?.find((a) => a.id === accountId)?.name;
  const noCampaigns = board.status === 'ready' && board.anyCampaign === false;
  const lastUpdated = board.lastUpdatedAt === null ? null : formatTime(new Date(board.lastUpdatedAt).toISOString());

  const agents = agentFloor.floor ? floorAgentsWorking(agentFloor.floor, pickedId, board.reads) : undefined;
  const willPay = promises.status === 'ready' ? willPayFor(promises.summary, pickedId) : null;
  const outcome = willPay
    ? { label: 'Will pay', value: formatCount(willPay.promises), sub: willPayLine(willPay), testId: 'kpi-outcome' }
    : undefined;
  const extras = promises.status === 'ready'
    ? Object.fromEntries(Object.entries(willPayByCampaign(promises.summary)).map(([id, n]) => [id, { willPay: n }]))
    : undefined;

  const pick = (id: string | null) => {
    const next = new URLSearchParams(params);
    if (id) next.set(CAMPAIGN_FILTER_PARAM, id);
    else next.delete(CAMPAIGN_FILTER_PARAM);
    setParams(next, { replace: true });
  };

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
      {board.status === 'error' && board.error && <ErrorAlert message={board.error} onRetry={board.reload} />}
      {(board.status === 'loading' || board.status === 'idle') && <LoadingSpinner />}

      {board.status === 'ready' && board.stale && (
        <div className={styles.staleNote} role="status" data-testid="home-stale">
          <span>{`Couldn’t refresh. Last updated ${lastUpdated ?? ''}`}</span>
          <button type="button" className={`btn-secondary ${styles.action}`} onClick={board.reload}>
            <RefreshCw size={14} aria-hidden="true" />
            Retry
          </button>
        </div>
      )}

      {/* Its own read, so it shows whatever became of the board's. */}
      <LiveFloorKpis board={board} reads={shown} today={today} campaignId={pickedId} agents={agents} outcome={outcome} />

      {board.status === 'ready' && (
        <>
          <div className={styles.mid}>
            <NeedsYouNow
              items={items}
              campaignId={pickedId}
              campaignName={picked?.name ?? null}
              stale={board.stale}
              lastUpdated={lastUpdated}
              onShowAll={() => pick(null)}
            />
            {noCampaigns ? (
              <GetStarted canCreate={canCreate} canInvite={hasPermission(role, 'user.invite')} />
            ) : (
              <CampaignsPanel reads={shown} onChanged={board.reload} extras={extras} />
            )}
          </div>

          {!noCampaigns && (
            <AgentsPanel
              reads={shown}
              floor={shownFloor ? { rows: shownFloor, clockOffsetMs: agentFloor.clockOffsetMs, stale: agentFloor.stale, onChanged: agentFloor.reload } : null}
              floorFailed={agentFloor.status === 'error' || agentFloor.status === 'refused'}
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
