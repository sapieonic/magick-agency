import { AGENCY_LISTEN_HISTORY_MERGE_GAP_MS } from '../../types/listen-history';
import type { AgencyListenEndReason } from '../../types/live-calls';

/**
 * A supervisor's sessions on one call, merged into visits for display (`docs/listening.md` §9,
 * LS19 b): the server's history rule, here for the views that read single sessions (a call's
 * "Listened to by", a campaign History's listen rows). Each reconnect is its own session row, so
 * one listen with two drops reads as three; merged, it reads as the one listen it was.
 *
 * The rule is `LISTEN_HISTORY_SQL`'s: sessions of one listener on one call, earliest first, join
 * the visit before them while they start at most {@link AGENCY_LISTEN_HISTORY_MERGE_GAP_MS} after
 * every earlier one ended, or while an earlier one is still open. The time listened counts each
 * instant once (a session's share starts where the earlier ones ended) and the gaps not at all;
 * the visit ends as its last session to end did. Pure.
 */

/** What the merge reads of one session (client ms). */
export interface ListenSessionSpan {
  listenerId: string;
  callId: string;
  /** A stable tie-break for sessions that started together: the listen id. */
  id: string;
  startedMs: number;
  /** Null while the session is open. */
  endedMs: number | null;
  /** Null while the session is open (or not known). */
  endReason: AgencyListenEndReason | null;
}

export interface ListenVisit<T> {
  listenerId: string;
  callId: string;
  /** Its sessions, earliest first. */
  sessions: T[];
  startedMs: number;
  /** The last session's end; null while any is open. */
  endedMs: number | null;
  /** Time listened, overlaps once, gaps not at all; null while any session is open. */
  listenedMs: number | null;
  /** How the session that ended last ended; null while any is open. */
  endReason: AgencyListenEndReason | null;
}

interface Building<T> {
  visit: ListenVisit<T>;
  /** The latest end among the visit's ended sessions, and whether one is open. */
  lastEnded: number | null;
  lastReason: AgencyListenEndReason | null;
  open: boolean;
  listened: number;
}

/**
 * The visits in `sessions`, earliest first. `span` reads each item (an item it cannot read, null,
 * is left out); `gapMs` is the server's merge gap unless a test says otherwise.
 */
export function mergeListenVisits<T>(
  sessions: readonly T[],
  span: (session: T) => ListenSessionSpan | null,
  gapMs: number = AGENCY_LISTEN_HISTORY_MERGE_GAP_MS,
): ListenVisit<T>[] {
  const read = sessions
    .map((item) => ({ item, s: span(item) }))
    .filter((x): x is { item: T; s: ListenSessionSpan } => x.s !== null && Number.isFinite(x.s.startedMs))
    .sort((a, b) => a.s.startedMs - b.s.startedMs || (a.s.id < b.s.id ? -1 : a.s.id > b.s.id ? 1 : 0));

  const current = new Map<string, Building<T>>();
  const done: Building<T>[] = [];
  for (const { item, s } of read) {
    const key = `${s.listenerId}\u0000${s.callId}`;
    let b = current.get(key);
    const joins = b !== undefined && (b.open || (b.lastEnded !== null && s.startedMs <= b.lastEnded + gapMs));
    if (!b || !joins) {
      b = {
        visit: { listenerId: s.listenerId, callId: s.callId, sessions: [], startedMs: s.startedMs, endedMs: null, listenedMs: null, endReason: null },
        lastEnded: null,
        lastReason: null,
        open: false,
        listened: 0,
      };
      current.set(key, b);
      done.push(b);
    }
    b.visit.sessions.push(item);
    if (s.endedMs === null || !Number.isFinite(s.endedMs)) {
      b.open = true;
      continue;
    }
    const from = Math.max(s.startedMs, b.lastEnded ?? s.startedMs);
    b.listened += Math.max(0, s.endedMs - from);
    // The last to end gives the reason; a tie keeps the later session's, as the server's order does.
    if (b.lastEnded === null || s.endedMs >= b.lastEnded) {
      b.lastEnded = s.endedMs;
      b.lastReason = s.endReason;
    }
  }

  return done
    .map(({ visit, open, lastEnded, lastReason, listened }) => ({
      ...visit,
      endedMs: open ? null : lastEnded,
      listenedMs: open ? null : listened,
      endReason: open ? null : lastReason,
    }))
    .sort((a, b) => a.startedMs - b.startedMs);
}

/** An ISO instant as client ms, or null. */
export function isoMs(at: string | null | undefined): number | null {
  if (!at) return null;
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? ms : null;
}
