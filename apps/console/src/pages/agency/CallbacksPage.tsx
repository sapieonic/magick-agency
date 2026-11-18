import { useMemo } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ChevronRight, Clock, RefreshCw } from 'lucide-react';
import { ErrorAlert } from '@magick-agency/web-ui/components/ErrorAlert';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { formatTime } from '@magick-agency/web-ui/format';
import { useTenant } from '../../contexts/TenantContext';
import { HOME_SLOW_MS, useHomeBoard } from '../../hooks/useHomeBoard';
import { holdsHomePermission } from '../../utils/consoleNav';
import { campaignTabHref } from '../../utils/agencyCampaignTabs';
import {
  CALLBACKS_ERROR,
  CALLBACKS_REFUSED,
  boardIsPartial,
  callbackRows,
  callbacksSummary,
  lateCallbacks,
  lateCallbacksUnknown,
} from '../../utils/agency/liveFloor';
import { HOME_CAMPAIGN_CAP } from '../../utils/agency/home';
import { formatCount } from '../../utils/format/number';
import { ComingSoonBadge } from '../../components/common/ComingSoon';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
import styles from './live-floor/LiveFloor.module.css';
import own from './CallbacksPage.module.css';

/**
 * Callbacks (decision LF1): the account's callbacks. One list of every campaign's callbacks is
 * coming (it needs an account-wide read the server does not have yet); until then the page lists
 * each active campaign's overdue callbacks from Live floor's board, worst first, each linking to
 * the campaign's Callbacks tab, where they are. Gated as Live floor is (`CALLBACKS_GATE`): the
 * board's allocation is served to `agency.supervise` alone. It reads the shared board at the
 * badge's period, so with the sidebar badge mounted it adds no request.
 */
export default function CallbacksPage() {
  const { role, tenantId, accountId } = useTenant();
  const supervise = holdsHomePermission(role);
  const board = useHomeBoard({ tenantId, accountId, role, enabled: supervise, intervalMs: HOME_SLOW_MS });
  const rows = useMemo(() => callbackRows(board.reads), [board.reads]);

  if (role === undefined) return <LoadingSpinner />;
  if (!supervise) return <Navigate to="/agency" replace />;

  // Never an all-clear it did not read (B28a): every campaign on the board, and every one's known.
  const summary = callbacksSummary({
    total: lateCallbacks(board.reads),
    partial: boardIsPartial(board),
    unknown: lateCallbacksUnknown(board.reads),
  });
  const lastUpdated = board.lastUpdatedAt === null ? null : formatTime(new Date(board.lastUpdatedAt).toISOString());

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <div className={styles.headerText}>
          <h1 className={styles.title}>Callbacks</h1>
          {board.status === 'ready' && summary !== null && (
            <p className={styles.cardNote} data-testid="callbacks-summary">{summary}</p>
          )}
        </div>
      </header>

      <section className={`${styles.card} ${own.soon}`} aria-labelledby="callbacks-soon-heading" data-testid="callbacks-coming-soon">
        <h2 id="callbacks-soon-heading" className={styles.cardTitle}>
          <Clock size={18} aria-hidden="true" />
          One list of every campaign’s callbacks
          <ComingSoonBadge />
        </h2>
        <p className={styles.cardNote}>
          Every callback in this account in one place, with who owns it and when it is due, so the late
          ones can be handed to agents who are free. Until then, each campaign’s callbacks are on its
          Callbacks tab.
        </p>
      </section>

      {/* Its own words, never Live floor's (the board's `HOME_BOARD_ERROR` and `HOME_BOARD_REFUSED`). */}
      {board.status === 'error' && <ErrorAlert message={board.refused ? CALLBACKS_REFUSED : CALLBACKS_ERROR} onRetry={board.reload} />}
      {(board.status === 'loading' || board.status === 'idle') && <LoadingSpinner />}

      {board.status === 'ready' && board.stale && (
        <div className={styles.staleNote} role="status" data-testid="callbacks-stale">
          <span>{`Couldn’t refresh. Last updated ${lastUpdated ?? ''}`}</span>
          <button type="button" className={`btn-secondary ${styles.action}`} onClick={board.reload}>
            <RefreshCw size={14} aria-hidden="true" />
            Retry
          </button>
        </div>
      )}

      {board.status === 'ready' && (
        <section className={styles.card} aria-labelledby="callbacks-campaigns-heading">
          <div className={styles.cardHead}>
            <h2 id="callbacks-campaigns-heading" className={styles.cardTitle}>Late callbacks by campaign</h2>
          </div>
          {rows.length > 0 ? (
            <ul className={own.rows} data-testid="callbacks-campaigns">
              {rows.map((row) => (
                <li key={row.campaign.id} className={own.row} data-testid={`callbacks-row-${row.campaign.id}`}>
                  <div className={own.rowName}>
                    <span className={own.name}>{row.campaign.name}</span>
                    <AgencyCampaignStatusBadge status={row.campaign.status} />
                    {row.stale && <span className={styles.staleTag}>Not refreshed</span>}
                  </div>
                  <span className={own.figure} data-tone={row.overdue && row.overdue > 0 ? 'danger' : undefined}>
                    {row.overdue === null ? 'Not known' : row.overdue === 0 ? 'None late' : `${formatCount(row.overdue)} late`}
                    {row.ownerAway > 0 && <span className={own.away}>{`, ${formatCount(row.ownerAway)} with an agent who is away`}</span>}
                  </span>
                  <Link
                    to={campaignTabHref('callbacks', row.campaign.id)}
                    className={`btn-secondary ${styles.smallButton}`}
                    aria-label={`Open callbacks: ${row.campaign.name}`}
                  >
                    Open callbacks
                    <ChevronRight size={15} aria-hidden="true" />
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.quiet} data-testid="callbacks-none">No campaign is running or paused.</p>
          )}
          {board.activeTotal > board.reads.length && (
            <p className={styles.cardNote}>
              {`This lists the first ${HOME_CAMPAIGN_CAP} of ${formatCount(board.activeTotal)} active campaigns. The rest are on the Campaigns page.`}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
