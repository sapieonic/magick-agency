import { useEffect, useRef, useState } from 'react';
import { MessageSquare, X } from 'lucide-react';
import type { AgencyStationSupervisorMessageFrame } from '@magick-agency/contracts/agency';
import { formatClockTime } from '../../utils/format/date';
import { messageSender } from '../../utils/agency/stationHelp';
import styles from './SupervisorMessages.module.css';

/** How many messages are on screen at once; the rest wait, counted, behind them (LF25). */
export const SUPERVISOR_MESSAGES_SHOWN = 3;

/**
 * Supervisors' messages on the agent's station (LF5, LF25), and the station's floor assist
 * announcements.
 *
 * ── Seen, never in the way ───────────────────────────────────────────────────
 * A card per message, oldest first, laid over the top right of the station (the full width under
 * the header on a phone), never over the action bar: the controls that act on the call stay where
 * the agent's hand is, and nothing moves under it (the station's frozen geometry). At most
 * {@link SUPERVISOR_MESSAGES_SHOWN} at once; the rest wait behind them, counted, and move up as the
 * agent dismisses. Nothing here takes focus: a message lands while the agent is talking, and
 * pulling focus to it would leave a keyboard agent's next key press on a card instead of the call.
 * Each card's Dismiss is reachable by Tab like any control.
 *
 * ── Plain text ────────────────────────────────────────────────────────────────
 * The text is the supervisor's, rendered as a React text node and nothing else (never as markup),
 * with its line breaks kept.
 *
 * ── Said out loud ─────────────────────────────────────────────────────────────
 * One polite live region (`aria-live="polite"`), visually hidden, says each new message ("Message from
 * Priya N: …") and what Need help says when it changes (`helpAnnouncement`): polite, because it
 * must not talk over the call's own assertive announcements (connect, disconnect).
 */
export function SupervisorMessages({
  messages,
  onDismiss,
  helpAnnouncement = null,
}: {
  messages: readonly AgencyStationSupervisorMessageFrame[];
  onDismiss: (id: string) => void;
  /** What Need help last said (`useStationHelp`); `seq` repeats the same words. */
  helpAnnouncement?: { text: string; seq: number } | null;
}) {
  const [said, setSaid] = useState('');
  // The newest message already said: a dismissal (or a reconnect) must not say one again.
  const saidIds = useRef(new Set<string>());
  useEffect(() => {
    const fresh = messages.filter((m) => !saidIds.current.has(m.id));
    for (const m of fresh) saidIds.current.add(m.id);
    const last = fresh[fresh.length - 1];
    if (last) setSaid(`Message from ${messageSender(last.from_name)}: ${last.text}`);
  }, [messages]);
  useEffect(() => {
    if (helpAnnouncement) setSaid(helpAnnouncement.text);
  }, [helpAnnouncement]);

  const shown = messages.slice(0, SUPERVISOR_MESSAGES_SHOWN);
  const waiting = messages.length - shown.length;

  return (
    <>
      {/* `aria-live` alone, not `role="status"`: the rail is the station's status (`getByRole('status')`). */}
      <div className={styles.srOnly} aria-live="polite" aria-atomic="true" data-testid="floor-assist-announcer">
        {said}
      </div>
      {shown.length > 0 ? (
        <section className={styles.stack} aria-label="Messages from your supervisors" data-testid="supervisor-messages">
          {shown.map((m) => {
            const sender = messageSender(m.from_name);
            const sentAt = new Date(m.sent_at);
            return (
              <article key={m.id} className={styles.card} data-testid="supervisor-message">
                <header className={styles.head}>
                  <MessageSquare size={14} aria-hidden="true" className={styles.icon} />
                  <strong className={styles.sender}>{sender}</strong>
                  {Number.isNaN(sentAt.getTime()) ? null : (
                    <time className={styles.time} dateTime={m.sent_at}>{formatClockTime(sentAt)}</time>
                  )}
                  <button
                    type="button"
                    className={styles.dismiss}
                    onClick={() => onDismiss(m.id)}
                    aria-label={`Dismiss message from ${sender}`}
                    title="Dismiss"
                  >
                    <X size={14} aria-hidden="true" />
                  </button>
                </header>
                <p className={styles.text} data-testid="supervisor-message-text">{m.text}</p>
              </article>
            );
          })}
          {waiting > 0 ? (
            <p className={styles.more} data-testid="supervisor-messages-more">
              {waiting === 1 ? '1 more message' : `${waiting} more messages`}
            </p>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
