import { useId, useState } from 'react';
import { Modal } from '@magick-agency/web-ui/components/Modal';
import { useToast } from '@magick-agency/web-ui/contexts/ToastContext';
import { AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS } from '@magick-agency/contracts/agency/floor-assist';
import { sendSupervisorMessage } from '../../../api/agencyFloorAssist';
import { trackAgencySupervisorMessageSent } from '../../../analytics/events';
import { useTenant } from '../../../contexts/TenantContext';
import {
  messageFits,
  messageLength,
  messageRefusal,
  type MessageTarget,
} from '../../../utils/agency/floorAssist';
import { formatCount } from '../../../utils/format/number';
import styles from './LiveFloor.module.css';

/**
 * Talk to agent and Send reminder (LF5, LF29): one small dialog that writes a message the agent sees
 * on their station (`POST /sessions/:id/messages`). Send reminder opens it with friendly words
 * naming the break and its length, still editable; Talk opens it empty.
 *
 * - 1 to 500 characters once trimmed, counted as the server counts them (code points), with a live
 *   counter; Send stays disabled outside that.
 * - A refusal stays in the dialog with the text kept, in the console's words naming the agent
 *   (`messageRefusal`): `409 agent_not_live`, `400 message_invalid`, `403 floor_assist_disabled`, a
 *   session gone. A sent message closes it with a toast.
 * - The shared `Modal`: focus trapped and restored, Escape closes, the text box takes focus. The
 *   overlay does not dismiss it, so a stray click never throws a half-written message away.
 * - A sent message is `agency_supervisor_message_sent` (LF39): `reminder` from Send reminder, `talk`
 *   from Talk; never the text or the agent.
 */
export function MessageDialog({ target, onClose }: { target: MessageTarget; onClose: () => void }) {
  const { tenantId, accountId } = useTenant();
  const { showToast } = useToast();
  const textId = useId();
  const counterId = useId();
  const [text, setText] = useState(target.reminder ?? '');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const length = messageLength(text);
  const fits = messageFits(text);
  const reminder = target.reminder !== undefined;

  const send = async () => {
    if (!fits || sending || !tenantId || !accountId) return;
    setSending(true);
    setError(null);
    try {
      await sendSupervisorMessage(target.sessionId, text.trim(), tenantId, accountId);
      trackAgencySupervisorMessageSent({ kind: reminder ? 'reminder' : 'talk' });
      showToast(`Sent to ${target.name}.`, 'success');
      onClose();
    } catch (err: unknown) {
      setError(messageRefusal(err, target.name));
      setSending(false);
    }
  };

  return (
    <Modal
      open
      onClose={() => {
        if (!sending) onClose();
      }}
      title={reminder ? `Send ${target.name} a reminder` : `Message ${target.name}`}
      subtitle="It shows on their screen. Messages are kept for 90 days."
      size="sm"
      closeOnOverlayClick={false}
      footer={
        <div className={styles.dialogFooter}>
          <button type="button" className="btn-secondary" onClick={onClose} disabled={sending}>
            Cancel
          </button>
          <button
            type="button"
            className="btn-primary"
            onClick={() => void send()}
            disabled={!fits || sending}
            data-testid="message-send"
          >
            {sending ? 'Sending…' : 'Send'}
          </button>
        </div>
      }
    >
      <form
        data-testid="message-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label htmlFor={textId}>Message</label>
          <textarea
            id={textId}
            data-autofocus="true"
            rows={4}
            value={text}
            placeholder="Type a message…"
            aria-invalid={error || (text.length > 0 && !fits) ? true : undefined}
            aria-describedby={counterId}
            disabled={sending}
            onChange={(event) => {
              setText(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              // Ctrl or Cmd with Enter sends; Enter alone starts a new line.
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                void send();
              }
            }}
            data-testid="message-text"
          />
          <p id={counterId} className={styles.counter} data-state={length > AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS ? 'invalid' : 'ok'} data-testid="message-counter">
            {`${formatCount(length)} / ${formatCount(AGENCY_SUPERVISOR_MESSAGE_MAX_CHARS)}`}
          </p>
          {error && (
            <p className="error-text" role="alert" data-testid="message-error">
              {error}
            </p>
          )}
        </div>
      </form>
    </Modal>
  );
}
