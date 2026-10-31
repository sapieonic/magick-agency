import { Link } from 'react-router-dom';
import { agentLandingPath } from '../../utils/agencyStationExit';
import styles from './AgentStation.module.css';

/** The remedy, on the button: what it does, in the order it does it. */
export const SOFTPHONE_CLOSE_AND_JOIN_LABEL = 'Close the soft phone and join';

/** A soft-phone call is live or owes its outcome, so the soft phone was left open. */
export const SOFTPHONE_CALL_PENDING_COPY =
  'Your soft phone has a call that isn’t finished. Hang up and save its outcome there, then come back to join.';

/**
 * The campaign join refused with `session_on_softphone`: the agent's one live
 * session is a soft-phone session (`docs/softphone.md` §2), which has no campaign
 * to name the way `JoinConflictScreen` does.
 *
 * The remedy is one click — close the soft phone and join here
 * (`useStationJoin`'s `closeSoftphoneAndJoin`) — because a soft phone left open
 * on another screen is the ordinary way to get here, and sending the agent to
 * the soft phone to press Close and back again is a detour. "Open the soft phone"
 * stays as the second way, and becomes the first when a call there is not
 * finished: that call is the agent's to end, never this screen's.
 */
export function SoftphoneJoinScreen({
  closing,
  failure,
  callPending,
  onCloseAndJoin,
}: {
  closing: boolean;
  failure: string | null;
  callPending: boolean;
  onCloseAndJoin: () => void;
}) {
  return (
    <div className={styles.shell}>
      <div className={styles.fatal} role="alert" data-testid="join-on-softphone">
        <h1>You’re on the soft phone</h1>
        <p>You can only have one session at a time, and yours is the soft phone.</p>
        <p>Close it to join this campaign.</p>
        {callPending ? (
          <p className="error-text" data-testid="join-softphone-call-pending">
            {SOFTPHONE_CALL_PENDING_COPY}
          </p>
        ) : (
          <button
            type="button"
            className={styles.fatalAction}
            onClick={onCloseAndJoin}
            disabled={closing}
            aria-busy={closing || undefined}
            data-testid="join-close-softphone"
          >
            {closing ? 'Closing the soft phone…' : SOFTPHONE_CLOSE_AND_JOIN_LABEL}
          </button>
        )}
        {failure ? (
          <p className="error-text" data-testid="join-close-softphone-failure">
            {failure}
          </p>
        ) : null}
        <Link
          className={callPending ? styles.fatalAction : styles.fatalEscape}
          to="/dialer/phone"
          data-testid="join-open-softphone"
        >
          Open the soft phone
        </Link>
        <Link className={styles.fatalEscape} to={agentLandingPath('refused')}>
          Back to your home screen
        </Link>
      </div>
    </div>
  );
}
