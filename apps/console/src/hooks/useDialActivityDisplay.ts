import { useEffect, useState } from 'react';
import type { AgencyDialActivity } from '../types/agency';

/**
 * How long "Dialling a customer…" stays up after a hidden dial ends unanswered.
 *
 * The server sends the next dial's `dial_activity` about 0.3–2 s after the last one ended, so
 * without a hold the screen (and the rail, the station's status region, `aria-live="polite"`)
 * would flick to "Waiting for a call" and back between every pair of dials. Client-side only:
 * the server sends no frame for this.
 *
 * **Accepted trade-off.** The hold covers the usual gap, not every gap. When the next dial comes
 * later than this (slow pacing, nothing due for a while, a concurrency or rate cap holding it
 * back), the rail falls back to "Waiting for a call" and a screen reader hears it, then
 * "Dialling a customer…" again when the next dial rings: one pair of announcements per dial at
 * most, each of them true. A longer hold would claim a dial that is not happening. The count
 * line ("No answer from the last N numbers") is deliberately not live, so it never adds to
 * them.
 */
export const DIAL_GAP_HOLD_MS = 4000;

/** What the idle slot and the rail show for the hidden dials, or `null` for today's copy. */
export interface DialActivityDisplay {
  /** A hidden dial is ringing, or one ended under {@link DIAL_GAP_HOLD_MS} ago. */
  dialling: boolean;
  /** Hidden dials in a row that ended unanswered (the line under the headline when above 0). */
  unansweredInARow: number;
}

/**
 * The hidden dials as the station's idle slot shows them: `dial_activity` with the gap between
 * one dial and the next smoothed over.
 *
 * `eligible` is the slot's own condition — the agent is `available`, the campaign is dialling,
 * no attempt (or inbound call) is on screen and the socket is open. Outside it nothing is shown
 * and any hold is dropped at once, as it is when a `reserved` clears the activity or the next
 * dial starts ringing.
 *
 * The hold starts in render, not in an effect: a hold set after commit would let one frame of
 * "Waiting for a call" reach the screen and the rail's live region between two dials, which is
 * the flicker this exists to remove. The effect only ends it.
 */
export function useDialActivityDisplay(
  activity: AgencyDialActivity | null,
  eligible: boolean,
): DialActivityDisplay | null {
  const shown = eligible && activity !== null;
  const [phase, setPhase] = useState<'ringing' | 'held' | 'quiet'>('quiet');

  // Ringing → not ringing with the agent still waiting and the activity still stated: the gap
  // before the next dial, held. Any other change (a `reserved`, leaving `available`, the
  // campaign stopping) ends a hold rather than starting one.
  let current = phase;
  if (shown && activity.ringing) current = 'ringing';
  else if (phase === 'ringing') current = shown ? 'held' : 'quiet';
  else if (phase === 'held' && !shown) current = 'quiet';
  if (current !== phase) setPhase(current);

  useEffect(() => {
    if (phase !== 'held') return;
    const timer = setTimeout(() => setPhase('quiet'), DIAL_GAP_HOLD_MS);
    return () => clearTimeout(timer);
  }, [phase]);

  if (!shown) return null;
  const dialling = current !== 'quiet';
  if (!dialling && activity.unanswered_in_a_row === 0) return null;
  return { dialling, unansweredInARow: activity.unanswered_in_a_row };
}
