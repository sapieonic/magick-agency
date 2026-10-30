import { JoinCardHeader } from './JoinCardHeader';
import type { JoinDoor } from './joinDoor';
import styles from './AgencyJoin.module.css';

/**
 * The lookup itself failed — a network blip, or the server being unreachable.
 *
 * Separate from the four above because it is the only one that may resolve by
 * itself, which is exactly what makes a retry button the right control and a
 * "contact your supervisor" the wrong one. Telling somebody to chase a colleague
 * over a five-second outage is how a working invite becomes a support ticket.
 */
export function Unreachable({
  message,
  onRetry,
  door,
}: {
  message: string;
  onRetry: () => void;
  door: JoinDoor;
}) {
  return (
    <div className={styles.card}>
      <JoinCardHeader door={door} />
      <h1 className={styles.outcomeTitle}>We could not open your invitation</h1>
      <p className={styles.outcomeBody}>
        The link looks fine — we just could not reach us to read it. This is usually
        the connection rather than the invitation.
      </p>
      <p className={styles.errorText} role="alert">{message}</p>
      {/*
        No busy state on this button, and that is not an omission: `load()` puts
        the page back into `loading`, so pressing it replaces this whole screen
        with the skeleton. A disabled "Trying again…" would be a state that can
        never be seen.
      */}
      <button type="button" className="btn-primary" onClick={onRetry} style={{ width: '100%' }}>
        Try again
      </button>
    </div>
  );
}
