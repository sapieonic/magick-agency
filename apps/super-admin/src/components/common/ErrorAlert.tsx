import { AlertCircle, RotateCcw } from 'lucide-react';
import { splitRequestId } from '../../utils/errors';
import { RequestId } from './RequestId';
import styles from './ErrorAlert.module.css';

/** Make generic fetch errors more user-friendly */
function friendlyMessage(message: string): string {
  const lower = message.toLowerCase();
  if (lower.includes('failed to fetch') || lower.includes('networkerror')) {
    return 'Unable to connect to the server. Please check your internet connection and try again.';
  }
  if (lower.includes('401') || lower.includes('unauthorized')) {
    return 'Your session may have expired. Please refresh the page or log in again.';
  }
  if (lower.includes('403') || lower.includes('forbidden')) {
    return 'You don\'t have permission to perform this action. Contact your admin if you think this is a mistake.';
  }
  if (lower.includes('500') || lower.includes('internal server error')) {
    return 'Something went wrong on our end. Please try again in a moment.';
  }
  // A bare "Bad Request" carries no field-level detail (e.g. an empty/unparsable
  // 400 body) — most often a required field left blank. Point the user at the form
  // rather than showing the raw HTTP status text.
  if (lower.trim() === 'bad request') {
    return "We couldn't save your changes — please check that all required fields are filled in and try again.";
  }
  return message;
}

interface ErrorAlertProps {
  message: string;
  onRetry?: () => void;
  /**
   * Optional explicit request id. Usually unnecessary — when `message` carries
   * an embedded id (masked errors from `ApiError`) it is detected and surfaced
   * automatically. Provide this only when the id isn't part of the message.
   */
  requestId?: string;
}

export function ErrorAlert({ message, onRetry, requestId }: ErrorAlertProps) {
  // Masked errors arrive with the request id embedded in the message; split it
  // out so we can render it as a copyable chip rather than inline text.
  const { message: text, requestId: embeddedId } = splitRequestId(message);
  const resolvedId = requestId ?? embeddedId;

  return (
    <div className={styles.container} role="alert">
      <AlertCircle size={18} className={styles.icon} aria-hidden="true" />
      <div className={styles.body}>
        <p className={styles.message}>{friendlyMessage(text)}</p>
        {resolvedId && <RequestId requestId={resolvedId} tone="error" />}
        {onRetry && (
          <button
            type="button"
            className={styles.retryButton}
            onClick={onRetry}
            aria-label="Retry loading"
          >
            <RotateCcw size={12} aria-hidden="true" />
            Retry
          </button>
        )}
      </div>
    </div>
  );
}
