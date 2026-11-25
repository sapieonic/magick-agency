import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgencyStationSupervisorMessageFrame } from '@magick-agency/contracts/agency';
import { messageSender } from '../../utils/agency/stationHelp';
import { trackAgencySupervisorMessageShown } from '../../analytics/events';
import { useLatestRef } from '../../hooks/useLatestRef';
import styles from './SupervisorMessages.module.css';

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
 * `agency_supervisor_message_shown` (LF39): once per message id, as it is first queued for the agent,
 * with whether they were on a call or owed an outcome then (`onCall`). Never the text, the sender or
 * the id. A dismissal, the next message coming up and a reconnect send nothing; the reducer already
 * keeps each id once, and this remembers every id it counted, dismissed ones included. Held above
 * the screens that come and go (on the station `StationScreen`, which stays mounted through its
 * inbound and soft phone views; on `/dialer/phone` the page), so a move between them counts nothing again.
 */
export function useSupervisorMessageShown(messages: readonly AgencyStationSupervisorMessageFrame[], onCall: boolean): void {
  const counted = useRef(new Set<string>());
  const onCallRef = useLatestRef(onCall);
  useEffect(() => {
    for (const m of messages) {
      if (counted.current.has(m.id)) continue;
      counted.current.add(m.id);
      trackAgencySupervisorMessageShown({ on_call: onCallRef.current });
    }
  }, [messages, onCallRef]);
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
