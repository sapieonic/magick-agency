/**
 * An agent's queue state (`AgencyQueueState`) from counts: due now, or nothing due and why.
 * Pure. The agent's summary (`GET /my-contacts/summary`) feeds it the contacts pacing would
 * pair the agent with (strict: their own; preferred: their own and the pool; pool: the
 * campaign's open contacts) and the campaign's calling window at its default timezone.
 *
 * In order: something due and the window open → due; nothing open → `queue_empty`; the
 * window closed → `outside_calling_hours` (next due: when it opens, if something is due now);
 * every open contact a callback → `callbacks_later`; otherwise `waiting_for_retry`.
 */
import type { AgencyQueueState } from '@magick-agency/contracts/agency';

export interface QueueInputs {
  /** Whether the campaign's calling window is open now. */
  windowOpen: boolean;
  /** When the window next opens (null when unknown or never). */
  nextWindowOpenAt: Date | null;
  /** Open contacts due now. */
  dueNow: number;
  /** Open contacts. */
  open: number;
  /** Open contacts that are not callbacks. */
  openNonCallback: number;
  /** The earliest `next_attempt_at` among the open contacts. */
  nextAttemptAt: Date | null;
}

export function computeQueueState(i: QueueInputs): AgencyQueueState {
  const iso = (d: Date | null) => (d ? d.toISOString() : null);
  if (i.open <= 0) return { due: false, reason: 'queue_empty', next_due_at: null };
  if (!i.windowOpen) {
    return {
      due: false,
      reason: 'outside_calling_hours',
      next_due_at: iso(i.dueNow > 0 ? i.nextWindowOpenAt ?? i.nextAttemptAt : i.nextAttemptAt),
    };
  }
  if (i.dueNow > 0) return { due: true, reason: null, next_due_at: iso(i.nextAttemptAt) };
  if (i.openNonCallback <= 0) return { due: false, reason: 'callbacks_later', next_due_at: iso(i.nextAttemptAt) };
  return { due: false, reason: 'waiting_for_retry', next_due_at: iso(i.nextAttemptAt) };
}
