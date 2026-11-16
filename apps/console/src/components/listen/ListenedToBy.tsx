import { Headphones } from 'lucide-react';
import { durationWords } from '../../utils/format/duration';
import { formatClockTime, formatDayMonth } from '../../utils/format/date';
import { initialsFor } from '../../utils/initials';
import type { AgencyCallListenSession } from '../../types/live-calls';
import detail from '../../pages/calls/CallDetailPage.module.css';
import styles from './ListenedToBy.module.css';

/** A session's "14:02–14:05", with the day when it is not the start's, or "since 14:02" while open. */
export function listenSpanLabel(session: Pick<AgencyCallListenSession, 'started_at' | 'ended_at'>): string {
  const start = new Date(session.started_at);
  if (Number.isNaN(start.getTime())) return '—';
  const from = formatClockTime(start);
  if (!session.ended_at) return `since ${from}`;
  const end = new Date(session.ended_at);
  if (Number.isNaN(end.getTime())) return from;
  const sameDay = start.toDateString() === end.toDateString();
  return `${from}–${sameDay ? '' : `${formatDayMonth(end)} `}${formatClockTime(end)}`;
}

/** "3m 10s", or "Listening now" while the session is open. */
export function listenDurationLabel(session: Pick<AgencyCallListenSession, 'duration_seconds' | 'ended_at'>): string {
  if (session.ended_at === null || session.duration_seconds === null) return 'Listening now';
  return durationWords(session.duration_seconds);
}

/**
 * "Listened to by" on a call's page (`docs/listening.md` LS13): each supervisor who listened, when
 * and for how long, from `agency_listen_sessions` by the call, earliest first. Shown only when the
 * call detail answered sessions (`listen_sessions`) and there was at least one: a call nobody
 * listened to has no section, and a server that does not send the field is not read as "nobody".
 */
export function ListenedToBy({ sessions }: { sessions: readonly AgencyCallListenSession[] | undefined }) {
  if (!sessions || sessions.length === 0) return null;
  const ordered = [...sessions].sort((a, b) => a.started_at.localeCompare(b.started_at));
  return (
    <section className={detail.card} aria-labelledby="listened-to-by-title" data-testid="listened-to-by">
      <h3 id="listened-to-by-title" className={detail.cardTitle}>
        <Headphones size={16} className={detail.cardTitleIcon} aria-hidden="true" />
        Listened to by
      </h3>
      <ul className={styles.list}>
        {ordered.map((s) => {
          const name = s.listener_name?.trim() || 'A supervisor';
          return (
            <li key={s.listen_id} className={styles.item} data-testid={`listened-${s.listen_id}`}>
              <span className={styles.avatar} aria-hidden="true">
                {initialsFor(s.listener_name)}
              </span>
              <span className={styles.name}>{name}</span>
              <span className={styles.span}>{listenSpanLabel(s)}</span>
              <span className={styles.duration}>{listenDurationLabel(s)}</span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
