import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, X } from 'lucide-react';
import type { AgencyStationSupervisorMessageFrame } from '@magick-agency/contracts/agency';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { formatClockTime } from '../../utils/format/date';
import { messageSender } from '../../utils/agency/stationHelp';
import styles from './SupervisorMessages.module.css';

/** How many messages are on screen at once; the rest wait, counted, behind them (LF25). */
export const SUPERVISOR_MESSAGES_SHOWN = 3;
/** On a phone, one: three cards there could cover most of the screen, the outcome form included. */
export const SUPERVISOR_MESSAGES_SHOWN_NARROW = 1;
/** A phone, as the stylesheet's own breakpoint for the stack says it. */
export const SUPERVISOR_MESSAGES_NARROW_QUERY = '(max-width: 767px)';

/** How many recent announcements the live region keeps as nodes (older ones are dropped silently). */
export const FLOOR_ASSIST_LINES_KEPT = 4;

export interface FloorAssistLine {
  id: number;
  text: string;
}

/**
 * What the station's floor assist live region says (LF25): each new supervisor message ("Message
 * from Priya N: …") and what Need help says when it changes (`helpAnnouncement`).
 *
 * ── Nothing clobbers anything ────────────────────────────────────────────────
 * Each utterance is its own node, appended (the region is `aria-atomic="false"`, so a screen reader
 * says the node added, not the region): a message and the help answer that follows it a moment
 * later (Talk sends `supervisor_message`, then `help_answered`) are both said, and the same words
 * twice (two identical messages, the same refusal again) are a new node and said again. Only the
 * last {@link FLOOR_ASSIST_LINES_KEPT} stay; a removal is not announced.
 *
 * ── Held by the page, not by a view ──────────────────────────────────────────
 * A hook the station page calls once, above its views: switching between the campaign's screen, an
 * inbound call and the soft phone neither forgets which messages were said nor says anything again.
 */
export function useFloorAssistAnnouncer(
  messages: readonly AgencyStationSupervisorMessageFrame[],
  helpAnnouncement: { text: string; seq: number } | null,
): FloorAssistLine[] {
  const [lines, setLines] = useState<FloorAssistLine[]>([]);
  const nextId = useRef(0);
  const say = useCallback((texts: readonly string[]) => {
    if (texts.length === 0) return;
    setLines((was) => {
      const added = texts.map((text) => ({ id: ++nextId.current, text }));
      return [...was, ...added].slice(-FLOOR_ASSIST_LINES_KEPT);
    });
  }, []);
  // The messages already said: a dismissal (or a reconnect) must not say one again.
  const saidIds = useRef(new Set<string>());
  useEffect(() => {
    const fresh = messages.filter((m) => !saidIds.current.has(m.id));
    for (const m of fresh) saidIds.current.add(m.id);
    say(fresh.map((m) => `Message from ${messageSender(m.from_name)}: ${m.text}`));
  }, [messages, say]);
  // `seq` moves on every say, the same words included; the object is new each time.
  useEffect(() => {
    if (helpAnnouncement) say([helpAnnouncement.text]);
  }, [helpAnnouncement, say]);
  return lines;
}

/**
 * The polite live region for what supervisors say ({@link useFloorAssistAnnouncer}), visually
 * hidden: polite, because it must not talk over the call's own assertive announcements (connect,
 * disconnect). `aria-live` alone, not `role="status"`: the rail is the station's status
 * (`getByRole('status')`). Rendered once by the page, outside its views.
 */
export function FloorAssistAnnouncer({ lines }: { lines: readonly FloorAssistLine[] }) {
  return (
    <div className={styles.srOnly} aria-live="polite" aria-atomic="false" aria-relevant="additions" data-testid="floor-assist-announcer">
      {lines.map((line) => (
        <p key={line.id} data-testid="floor-assist-said">{line.text}</p>
      ))}
    </div>
  );
}

/**
 * Supervisors' messages on the agent's station (LF5, LF25).
 *
 * ── Seen, never in the way ───────────────────────────────────────────────────
 * A card per message, oldest first, laid over the top right of the station (the full width under
 * the header on a phone), never over the action bar: the controls that act on the call stay where
 * the agent's hand is, and nothing moves under it (the station's frozen geometry). At most
 * {@link SUPERVISOR_MESSAGES_SHOWN} at once (one on a phone, where three could cover the outcome
 * form); the rest wait behind them, counted, and move up as the agent dismisses. Nothing here
 * takes focus: a message lands while the agent is talking, and pulling focus to it would leave a
 * keyboard agent's next key press on a card instead of the call. Each card's Dismiss is reachable
 * by Tab like any control, after the call's own controls (the page renders the stack after them).
 *
 * ── Plain text ────────────────────────────────────────────────────────────────
 * The text is the supervisor's, rendered as a React text node and nothing else (never as markup),
 * with its line breaks kept. Said out loud by {@link FloorAssistAnnouncer}, not here.
 */
export function SupervisorMessages({
  messages,
  onDismiss,
}: {
  messages: readonly AgencyStationSupervisorMessageFrame[];
  onDismiss: (id: string) => void;
}) {
  const narrow = useMediaQuery(SUPERVISOR_MESSAGES_NARROW_QUERY);
  const shown = messages.slice(0, narrow ? SUPERVISOR_MESSAGES_SHOWN_NARROW : SUPERVISOR_MESSAGES_SHOWN);
  const waiting = messages.length - shown.length;

  if (shown.length === 0) return null;
  return (
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
  );
}
