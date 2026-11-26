import { useState } from 'react';
import { Footprints } from 'lucide-react';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { sendSupervisorMessage } from '../../../api/agencyFloorAssist';
import { trackAgencySupervisorMessageSent } from '../../../analytics/events';
import { useTenant } from '../../../contexts/TenantContext';
import { COMING_TO_DESK_TEXT, messageRefusal } from '../../../utils/agency/floorAssist';
import styles from './LiveFloor.module.css';

/**
 * "I’m coming" on Need help's row and card (BE-9): one press sends the agent
 * "I am coming to your desk." (`COMING_TO_DESK_TEXT`) through the supervisor-message route
 * (`POST /sessions/:id/messages`, the answer a message already is, LF14), so the request is
 * answered whatever the agent was doing, a call or none. Pressed again while it is on its way, it
 * does nothing. Sent, a toast says so (the next floor read clears the request); refused, a toast
 * says why in the console's words (`messageRefusal`). Shown only where Talk is: floor assist on.
 * Sent, it is `agency_supervisor_message_sent` with `kind: 'coming_to_desk'` (LF39).
 *
 * `compact` is the card's icon button; otherwise the row's button with its words.
 */
export function ComingToDeskButton({ sessionId, name, compact = false }: {
  sessionId: string;
  name: string;
  compact?: boolean;
}) {
  const { tenantId, accountId } = useTenant();
  const { showToast } = useToast();
  const [sending, setSending] = useState(false);
  const label = `Tell ${name} you are coming to their desk`;

  const send = async () => {
    if (sending || !tenantId || !accountId) return;
    setSending(true);
    try {
      await sendSupervisorMessage(sessionId, COMING_TO_DESK_TEXT, tenantId, accountId);
      trackAgencySupervisorMessageSent({ kind: 'coming_to_desk' });
      showToast(`Told ${name} you are coming to their desk.`, 'success');
    } catch (err: unknown) {
      showToast(messageRefusal(err, name), 'error');
    } finally {
      setSending(false);
    }
  };

  return (
    <button
      type="button"
      className={`btn-secondary ${compact ? styles.iconButton : styles.smallButton}`}
      onClick={() => void send()}
      disabled={sending}
      aria-label={label}
      title={`Sends “${COMING_TO_DESK_TEXT}” to ${name}’s screen`}
    >
      <Footprints size={compact ? 15 : 14} aria-hidden="true" />
      {compact ? null : 'I’m coming'}
    </button>
  );
}
