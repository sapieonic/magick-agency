import { useRepaintTick } from '../../../hooks/useRepaintTick';
import type { ServerClock } from '../../../hooks/useServerClock';
import { wrapupView, type WrapupAnchor } from '../../../utils/agencyWrapup';
import { STATION_COPY } from '../../../utils/agency/stationCopy';
import { runningClock } from '../../../utils/agency/stationFormat';
import styles from './Station.module.css';

/**
 * The station's running numbers, each its own leaf so only it repaints (the page re-renders on
 * frames and actions, never four times a second). Every one is `aria-hidden`: a clock inside a
 * live region would speak on every tick.
 */

/** Time since a server anchor: Ready's waiting time, the call's talk time, the break's time used. */
export function SinceClock({
  anchor,
  clock,
  className,
  testId,
}: {
  anchor: string | null;
  clock: ServerClock;
  className?: string;
  testId?: string;
}) {
  useRepaintTick(anchor !== null);
  const ms = anchor ? clock.since(anchor) : null;
  if (ms === null) return null;
  return (
    <span className={`${styles.num} ${className ?? ''}`} aria-hidden="true" data-testid={testId}>
      {runningClock(ms)}
    </span>
  );
}

/** 09's "Trying again in 0:08", to the reconnect ladder's next try (local clock). */
export function RetryCountdown({ at }: { at: number | null }) {
  useRepaintTick(at !== null);
  if (at === null) return null;
  const left = at - Date.now();
  return (
    <span className={styles.bandSide} data-testid="retry-countdown">
      <span>
        <small>{left > 0 ? STATION_COPY.tryingAgainIn : STATION_COPY.tryingNow}</small>
        {left > 0 ? (
          <span className={`${styles.num} ${styles.bandClock}`} aria-hidden="true">{runningClock(left + 999)}</span>
        ) : null}
      </span>
    </span>
  );
}

/** 10's "Call is kept for 0:12": the bootstrap's `deferred_hangup_ms`, from when the socket closed. */
export function KeptCountdown({ from, windowMs }: { from: number; windowMs: number }) {
  useRepaintTick();
  const left = Math.max(0, from + windowMs - Date.now());
  return (
    <span className={styles.bandSide} data-testid="call-kept">
      <span>
        <small>{STATION_COPY.callKeptFor}</small>
        <span className={`${styles.num} ${styles.bandClock}`} aria-hidden="true">{runningClock(left + 999)}</span>
      </span>
    </span>
  );
}

/**
 * 05's "Time left 0:22" ring, from the wrap-up frame. Turns into "Time is over 0:00" when the time
 * ran out with nothing saved (05d); with no deadline (a held wrap-up) it is not drawn.
 */
export function TimeLeftRing({
  anchor,
  clock,
  submitted,
}: {
  anchor: WrapupAnchor;
  clock: ServerClock;
  submitted: boolean;
}) {
  useRepaintTick(anchor.deadlineMs !== null);
  const view = wrapupView(anchor, clock.now(), submitted);
  /*
    05d: when the time runs out with nothing saved, the server ends the countdown with a wrap-up
    frame carrying no deadline and `held_reason: 'disposition_required'`. The ring stays, red, at
    "Time is over 0:00", rather than vanishing; any other wrap-up with no deadline has no ring.
  */
  const timeOver = view.panel === 'held' && anchor.heldReason === 'disposition_required' && !submitted;
  if (!timeOver && (view.panel === 'held' || view.remainingMs === null)) return null;
  const remainingMs = timeOver ? 0 : view.remainingMs ?? 0;
  const over = remainingMs === 0 && !submitted;
  const r = 18;
  const c = 2 * Math.PI * r;
  const fraction = timeOver ? 0 : view.fraction ?? 0;
  return (
    <span className={styles.ring} data-over={over ? 'true' : undefined} data-testid="time-left">
      <svg className={styles.ringSvg} viewBox="0 0 44 44" aria-hidden="true">
        <circle className={styles.ringTrack} cx="22" cy="22" r={r} />
        <circle className={styles.ringFill} cx="22" cy="22" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - fraction)} />
      </svg>
      <span>
        <small>{over ? STATION_COPY.timeOver : STATION_COPY.timeLeft}</small>
        <span className={styles.num} aria-hidden="true" data-testid="wrapup-digits">
          {runningClock(remainingMs)}
        </span>
      </span>
    </span>
  );
}
