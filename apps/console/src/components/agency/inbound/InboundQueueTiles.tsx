import { PhoneIncoming } from 'lucide-react';
import { useTenant } from '../../../contexts/TenantContext';
import { useFeatureFlagEnabled } from '../../../hooks/useFeatureFlagEnabled';
import { SettingsEntryLink } from '../../common/SettingsEntryLink';
import { useInboundQueue } from '../../../hooks/useInboundQueue';
import { INBOUND_FLAG } from '../../../utils/inbound/inboundFlag';
import { hasPermission } from '../../../utils/permissions';
import { statClock } from '../../../utils/format/duration';
import type { AgencyInboundQueueTile } from '../../../types/inbound';
import styles from './InboundQueueTiles.module.css';

/**
 * Whether a route is open but nobody can take its calls at all (everyone on a break, offline, on
 * the phone app or outside its pool): a caller now goes straight to Missed calls (PM-M6).
 */
export function tileOpenWithNobody(tile: AgencyInboundQueueTile): boolean {
  return tile.open_now && tile.no_agents_available;
}

/**
 * Whether a tile needs the supervisor: callers wait and nobody is free to take them, or the route
 * is open with nobody who could take a call at all. Waiting with agents free is a queue moving.
 */
export function tileNeedsAttention(tile: AgencyInboundQueueTile): boolean {
  return (tile.waiting > 0 && tile.eligible_agents === 0) || tileOpenWithNobody(tile);
}

/**
 * The supervisor's inbound queue (P2, `docs/inbound.md` §6): one tile per live route — open or
 * closed, callers waiting and the longest wait, calls offered or connected, agents free who could
 * take its callers, and whether an open route has nobody at all who could take a call — read
 * every 5 s (IQ23). On the agency home and the Missed calls page.
 *
 * Renders nothing without `agency_inbound_enabled` or `agency.supervise` (the route's own
 * permission), or before the first answer. Not a live region: numbers that change every five
 * seconds would talk over everything else on the page; the section is headed and each tile is
 * read as a whole.
 */
export function InboundQueueTiles() {
  const { tenantId, accountId, role } = useTenant();
  const flagOn = useFeatureFlagEnabled(INBOUND_FLAG);
  const enabled = flagOn && hasPermission(role, 'agency.supervise');
  const { tiles, error, reload } = useInboundQueue({
    tenantId: tenantId ?? undefined,
    accountId: accountId ?? undefined,
    enabled,
  });

  if (!enabled) return null;
  if (tiles === null && !error) return null;

  return (
    <section className={styles.section} aria-labelledby="inbound-queue-heading" data-testid="inbound-queue">
      <div className={styles.head}>
        <h2 id="inbound-queue-heading" className={styles.title}>
          <PhoneIncoming size={16} aria-hidden="true" />
          Inbound calls now
        </h2>
        <p className={styles.hint}>Updated every 5 seconds</p>
      </div>
      {error ? (
        <p className={styles.error} data-testid="inbound-queue-error">
          {tiles ? 'These numbers have stopped updating. ' : 'We couldn’t load the inbound queue. '}
          <button type="button" className={styles.retry} onClick={reload}>
            Try again
          </button>
        </p>
      ) : null}
      {tiles && tiles.length === 0 ? (
        <p className={styles.hint} data-testid="inbound-queue-empty">
          No inbound routes are answering calls in this account.{' '}
          {/* Where a route is set up, for the reader who may set one up. */}
          <SettingsEntryLink entry="inbound" />
        </p>
      ) : null}
      {tiles && tiles.length > 0 ? (
        <ul className={styles.grid} role="list">
          {tiles.map((tile) => (
            <li
              key={tile.route_id}
              className={styles.tile}
              data-attention={tileNeedsAttention(tile) || undefined}
              data-testid={`inbound-queue-tile-${tile.route_id}`}
            >
              <div className={styles.tileHead}>
                <h3 className={styles.routeName}>{tile.route_name}</h3>
                <span className={styles.status} data-open={tile.open_now}>
                  {tile.open_now ? 'Open' : 'Closed'}
                </span>
              </div>
              <dl className={styles.stats}>
                <div className={styles.stat}>
                  <dt>Waiting</dt>
                  <dd data-testid="tile-waiting">{tile.waiting}</dd>
                </div>
                <div className={styles.stat}>
                  <dt>Longest wait</dt>
                  <dd data-testid="tile-longest">{tile.waiting > 0 ? statClock(tile.longest_wait_seconds) : '—'}</dd>
                </div>
                <div className={styles.stat}>
                  <dt>With an agent</dt>
                  <dd data-testid="tile-connected">{tile.connected}</dd>
                </div>
                <div className={styles.stat}>
                  <dt>Agents free</dt>
                  <dd data-testid="tile-eligible">{tile.eligible_agents}</dd>
                </div>
              </dl>
              {tileOpenWithNobody(tile) ? (
                <p className={styles.attention} data-testid="tile-no-agents">
                  Open, but no one can take calls: callers go straight to Missed calls instead of waiting.
                </p>
              ) : tileNeedsAttention(tile) ? (
                <p className={styles.attention} data-testid="tile-attention">
                  Callers are waiting and no agent is free to take them.
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
