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
import { hasPermission } from '../../utils/permissions';
import { holdsHomePermission } from '../../utils/consoleNav';
import { homeAttention, HOME_CAMPAIGN_CAP } from '../../utils/agency/home';
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
  const [params, setParams] = useSearchParams();

  const items = useMemo(
    () => homeAttention(board.reads, { available: missed.available, count: missed.count }, formatDate),
    [board.reads, missed.available, missed.count],
  );
  const picked = selectedCampaign(params.get(CAMPAIGN_FILTER_PARAM), board.reads);
  const pickedId = picked?.id ?? null;
  const shown = useMemo(() => readsFor(board.reads, pickedId), [board.reads, pickedId]);

  if (role === undefined) return <LoadingSpinner />;
  if (!supervise) return <Navigate to="/agency" replace />;

  const canCreate = hasPermission(role, 'agency.campaigns.write');
  const accountName = accounts?.find((a) => a.id === accountId)?.name;
  const noCampaigns = board.status === 'ready' && board.anyCampaign === false;
  const lastUpdated = board.lastUpdatedAt === null ? null : formatTime(new Date(board.lastUpdatedAt).toISOString());

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
      <LiveFloorKpis board={board} reads={shown} today={today} campaignId={pickedId} />

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
              <CampaignsPanel reads={shown} onChanged={board.reload} />
            )}
          </div>

          {!noCampaigns && <AgentsPanel reads={shown} />}

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
