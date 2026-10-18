import type { StationConnection } from '../../hooks/useAgencyStation';
import styles from './AgentStation.module.css';

/**
 * The pill's word for each connection state.
 *
 * A `Record` over the closed `StationConnection` union, so a state added without
 * a label is a compile error rather than a fall-through. It was a six-deep ternary
 * ending in `'Connecting'`, which is exactly how `disconnected` once read as
 * "Connecting" — a stopped console claiming to be on its way. `idle` is named
 * too: it is the moment before the first connect, so "Connecting" is true there
 * (the other way into it, closing the socket on `beforeunload`, is gone — see
 * `useAgencyStation`'s unload note).
 */
export const CONNECTION_LABEL: Record<StationConnection, string> = {
  idle: 'Connecting',
  connecting: 'Connecting',
  open: 'Connected',
  reconnecting: 'Reconnecting',
  superseded: 'Moved to another window',
  session_gone: 'Session ended',
  disconnected: 'Disconnected',
};

export function ConnectionHealthPill({
  connection,
  missedPings,
}: {
  /**
   * `StationConnection`, not `string`. It was `string`, which is why the compiler
   * could not flag the missing `disconnected` arm when that state was added — the
   * label silently fell through to "Connecting" and the dot to green. A closed
   * vocabulary here is the same convention `agencyStatsConsumers.ts` and
   * `AuditActionOption` use to make an unhandled member a compile error.
   */
  connection: StationConnection;
  missedPings: number;
}) {
  // One missed ping is not an alarm — a single 10s gap is normal on wifi.
  const label =
    connection === 'open' && missedPings >= 2 ? 'Weak connection' : CONNECTION_LABEL[connection];

  return (
    <span className={styles.healthPill} data-state={connection}>
      <span className={styles.healthDot} aria-hidden="true" />
      {label}
    </span>
  );
}
