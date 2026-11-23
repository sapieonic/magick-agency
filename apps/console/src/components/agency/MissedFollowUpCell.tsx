import { AlertCircle, Check, Phone } from 'lucide-react';
import styles from '../../pages/agency/AgencyCampaignAttemptsPage.module.css';

/**
 * A missed call's Outcome cell in a list of calls. A missed call has no outcome of its own: the
 * cell says where its follow-up stands. Rung back ("Called back 3:31 PM", the pair's other
 * row), still owed ("To follow up", with the Missed list's two actions), or closed.
 */
export function MissedFollowUpCell({
  rowId, followUp, onCallBack, callBackDisabled = false, onMarkHandled, marking, error, testIds,
}: {
  rowId: string;
  /** `followUpWords` of the row. */
  followUp: { calledBack: string | null; status: string | null; open: boolean };
  /** Call back, or null where the reader cannot (no soft phone, or the caller withheld their number). */
  onCallBack: (() => void) | null;
  callBackDisabled?: boolean;
  /** Mark handled, or null where the reader may not. */
  onMarkHandled: (() => void) | null;
  /** The id of the row being marked handled, in this list. */
  marking: string | null;
  /** A refusal to say on this row. */
  error: string | null;
  /** Each list keeps its own test ids; each is completed with the row's id. */
  testIds: { cell: string; callBack: string; markHandled: string };
}) {
  return (
    <span className={styles.followUp} data-testid={`${testIds.cell}-${rowId}`}>
      {followUp.calledBack && <span className={styles.calledBack}>{followUp.calledBack}</span>}
      {followUp.status && <span className={followUp.open ? styles.toFollowUp : styles.mutedCell}>{followUp.status}</span>}
      {followUp.open && (onMarkHandled || onCallBack) && (
        <span className={styles.rowActions}>
          {onCallBack && (
            <button
              type="button"
              className={styles.rowAction}
              onClick={onCallBack}
              disabled={callBackDisabled}
              data-testid={`${testIds.callBack}-${rowId}`}
            >
              <Phone size={12} aria-hidden="true" />
              Call back
            </button>
          )}
          {onMarkHandled && (
            <button
              type="button"
              className={styles.rowAction}
              onClick={onMarkHandled}
              disabled={marking !== null}
              data-testid={`${testIds.markHandled}-${rowId}`}
            >
              <Check size={12} aria-hidden="true" />
              {marking === rowId ? 'Marking…' : 'Mark handled'}
            </button>
          )}
        </span>
      )}
      {error !== null && (
        <span className={styles.rowError} role="alert">
          <AlertCircle size={12} aria-hidden="true" />
          {error}
        </span>
      )}
    </span>
  );
}
