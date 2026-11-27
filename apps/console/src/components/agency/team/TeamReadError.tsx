import { isRetryableTeamError, teamErrorMessage } from '../../../api/teamPerformance';
import styles from './Team.module.css';

/**
 * A team performance read that failed, in the console's words, with Try again only when the
 * failure can clear by itself (busy, timed out, 5xx, the network: Compare's rule). Any other
 * refusal needs the reader to change a filter first, so asking again would only fail again.
 */
export function TeamReadError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const canRetry = isRetryableTeamError(error);
  return (
    <div className={`${styles.note} ${styles.errorBox}`} role="alert" data-testid="team-error">
      <p className={styles.errorText}>{teamErrorMessage(error, 'The team’s figures couldn’t be loaded.')}</p>
      {canRetry ? (
        <button type="button" className={styles.linkButton} onClick={onRetry} data-testid="team-retry">
          Try again
        </button>
      ) : null}
    </div>
  );
}
