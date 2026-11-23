import { Headphones } from 'lucide-react';
import { formatClockTime, formatDayMonth, upperDayPeriod } from '../../utils/format/date';
import { initialsFor } from '../../utils/initials';
import { LISTENED_TO_BY_COPY, listenedDurationLabel, listeningSinceLabel } from '../../utils/listen/listenCopy';
import { isoMs, mergeListenVisits, type ListenVisit } from '../../utils/listen/listenVisits';
import type { AgencyCallListenSession } from '../../types/live-calls';
import detail from '../../pages/calls/CallDetailPage.module.css';
import styles from './ListenedToBy.module.css';

/** A session's "14:02–14:05", with the day when it is not the start's, or "since 14:02" while open. */
export function listenSpanLabel(
  session: Pick<AgencyCallListenSession, 'started_at' | 'ended_at'>,
  formatClock: (date: Date) => string = formatClockTime,
): string {
  const start = new Date(session.started_at);
  if (Number.isNaN(start.getTime())) return '—';
  const from = formatClock(start);
  if (!session.ended_at) return listeningSinceLabel(from);
  const end = new Date(session.ended_at);
  if (Number.isNaN(end.getTime())) return from;
  const sameDay = start.toDateString() === end.toDateString();
  return `${from}–${sameDay ? '' : `${formatDayMonth(end)} `}${formatClock(end)}`;
}

/** One listen as the section shows it: a supervisor's sessions merged (LS19 b's rule). */
function visitsOf(sessions: readonly AgencyCallListenSession[]): ListenVisit<AgencyCallListenSession>[] {
  return mergeListenVisits(sessions, (s) => {
    const startedMs = isoMs(s.started_at);
    if (startedMs === null) return null;
    return {
      listenerId: s.listener_user_id,
      callId: '',
      id: s.listen_id,
      startedMs,
      endedMs: s.ended_at === null ? null : isoMs(s.ended_at),
      endReason: s.end_reason,
    };
  });
}

/**
 * "Listened to by" on a call's page (`docs/listening.md` LS13): each supervisor who listened, when
 * and for how long, from `agency_listen_sessions` by the call, earliest first. Shown only when the
 * call detail answered sessions (`listen_sessions`) and there was at least one: a call nobody
 * listened to has no section, and a server that does not send the field is not read as "nobody".
 *
 * Each reconnect is its own session; a supervisor's sessions within 30 s of each other (or while
 * one is open) are one listen here, as on the Listening history page (`mergeListenVisits`): its
 * first start to its last end, the time listened counted once.
 */
export function ListenedToBy({ sessions, upperCaseTimes = false }: {
  sessions: readonly AgencyCallListenSession[] | undefined;
  /** AM / PM in capitals: the inbound Call page says every time so (`upperDayPeriod`). */
  upperCaseTimes?: boolean;
}) {
  const formatClock = upperCaseTimes ? (date: Date) => upperDayPeriod(formatClockTime(date)) : formatClockTime;
  if (!sessions || sessions.length === 0) return null;
  const visits = visitsOf(sessions);
  if (visits.length === 0) return null;
  return (
    <section className={detail.card} aria-labelledby="listened-to-by-title" data-testid="listened-to-by">
      <h3 id="listened-to-by-title" className={detail.cardTitle}>
        <Headphones size={16} className={detail.cardTitleIcon} aria-hidden="true" />
        {LISTENED_TO_BY_COPY.title}
      </h3>
      <ul className={styles.list}>
        {visits.map((visit) => {
          const first = visit.sessions[0]!;
          const listenerName = visit.sessions.map((s) => s.listener_name?.trim()).find(Boolean) ?? null;
          const name = listenerName || LISTENED_TO_BY_COPY.aSupervisor;
          const ended = visit.endedMs === null ? null : new Date(visit.endedMs).toISOString();
          const seconds = visit.listenedMs === null ? null : Math.round(visit.listenedMs / 1000);
          return (
            <li key={first.listen_id} className={styles.item} data-testid={`listened-${first.listen_id}`}>
              <span className={styles.avatar} aria-hidden="true">
                {initialsFor(listenerName)}
              </span>
              <span className={styles.name}>{name}</span>
              <span className={styles.span}>{listenSpanLabel({ started_at: first.started_at, ended_at: ended }, formatClock)}</span>
              <span className={styles.duration}>{listenedDurationLabel(seconds, ended)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
