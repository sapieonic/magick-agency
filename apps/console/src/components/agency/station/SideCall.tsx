import type { ReactNode } from 'react';
import { Check, MicOff } from 'lucide-react';
import { HoldToConfirmButton, type HoldToConfirmCopy } from '../HoldToConfirmButton';
import { useRepaintTick } from '../../../hooks/useRepaintTick';
import type { ServerClock } from '../../../hooks/useServerClock';
import { STATION_COPY } from '../../../utils/agency/stationCopy';
import { SIDE_COPY } from '../../../utils/agency/sideViewCopy';
import { clockTime, runningClock } from '../../../utils/agency/stationFormat';
import styles from './Station.module.css';

/**
 * The parts the station's two side views (an inbound call, the soft phone) share with screens 04
 * and 05 (AS1, AS3): End call held in the bottom-right corner, Mute bottom left, Save as the main
 * button on What happened?, and the time left before an unsaved call closes. Look and words only:
 * what each press does is the side view's own hook (`useInboundCall`, `useSoftphone`).
 */

/** What the station's frame needs from the page that hosts a side view. */
export interface SideFrameProps {
  agentName: string;
  workName: string | null;
  brandMark: string;
  /** Need help and the listening notice, top right. */
  needHelp: ReactNode;
  /** ⋮ More, built by the page for the items the side view says (`sideMenu`). */
  menu: (items: Array<'sound' | 'theme' | 'finish'>) => ReactNode;
  /** The page's banners (microphone, internet, supervisor's message, the listening notice). */
  banners: ReactNode;
  /** The cue's flash in the band, for an agent who cannot hear the cue. */
  cueFlash: ReactNode;
  /**
   * `AS9`: how the station shows a customer's number, read by the inbound call's card. The soft
   * phone's card follows the call's campaign's own setting instead (AS19 S3(b), `softphoneCustomerCard`).
   */
  phoneDisplay: 'full' | 'masked';
  readAloud: { available: boolean; say: (text: string) => void };
}

/** The station's End call words (AS3), with a side view's own id prefix: two buttons never share a hint id. */
export function sideEndCallCopy(idPrefix: string): HoldToConfirmCopy {
  return {
    idPrefix,
    labels: {
      idle: STATION_COPY.endCall,
      holding: STATION_COPY.endCallHolding,
      armed: STATION_COPY.endCallArmed,
      ending: STATION_COPY.endCallEnding,
      failed: STATION_COPY.endCall,
    },
    hint: STATION_COPY.endCallHint,
    failedCopy: STATION_COPY.endCallFailed,
    shortcutScope: 'window',
    confirmation: 'external',
    analyticsControl: 'hangup',
  };
}

/** End call, the main button on a live call (AS3): press and hold, or `E` twice. */
export function SideEndCall({
  callId,
  onConfirm,
  copy,
}: {
  callId: string;
  onConfirm: () => void;
  copy: HoldToConfirmCopy;
}) {
  return (
    <span className={styles.endCallWrap}>
      <HoldToConfirmButton attemptId={callId} enabled onConfirm={onConfirm} copy={copy} buttonClassName={styles.endCall} />
    </span>
  );
}

/** Mute, bottom left (secondary): amber and "Unmute" while on. */
export function SideMute({
  muted,
  onToggle,
  label,
  testId,
}: {
  muted: boolean;
  onToggle: () => void;
  /** The words while not muted and while muted. */
  label: { off: string; on: string };
  testId: string;
}) {
  return (
    <button
      type="button"
      className={`${styles.btn} ${muted ? styles.btnOn : ''}`}
      onClick={onToggle}
      aria-pressed={muted}
      aria-keyshortcuts="M"
      data-testid={testId}
    >
      <MicOff size={22} aria-hidden="true" />
      {muted ? label.on : label.off}
      <span className={styles.key} aria-hidden="true">M</span>
    </button>
  );
}

/**
 * Save, the main button on a side view's What happened?. AS1's one exception: it stays in place,
 * faded, until it can save; pressing it then shakes the tiles and says what is missing (the
 * screen's). Repaints itself while a time-bound outcome is picked: the time can slide into the past.
 */
export function SideSave({
  blocked,
  ticking,
  saving,
  onSave,
  shake,
  describedBy,
  testId,
}: {
  /** Whether Save cannot save now, read at render. */
  blocked: () => boolean;
  ticking: boolean;
  saving: boolean;
  onSave: () => void;
  shake: number;
  describedBy: string | null;
  testId: string;
}) {
  useRepaintTick(ticking);
  const disabled = blocked() || saving;
  return (
    <button
      key={`save-${shake}`}
      type="button"
      className={`${styles.btn} ${styles.btnBig} ${styles.btnGo}`}
      onClick={onSave}
      aria-disabled={disabled || undefined}
      aria-describedby={describedBy ?? undefined}
      aria-keyshortcuts="Enter Control+Enter"
      data-shake={shake > 0 && describedBy ? 'true' : undefined}
      data-testid={testId}
    >
      <Check size={24} aria-hidden="true" />
      {saving ? SIDE_COPY.saving : SIDE_COPY.save}
      <span className={styles.key} aria-hidden="true">Enter</span>
    </button>
  );
}

/**
 * "Time left 0:22" (spec 05's ring) for a side view: an owed outcome closes by itself at
 * `dueAt` (the inbound route's wrap-up window, the soft phone's lapse). The digits are
 * `aria-hidden`; the time it closes at is said once, in words, for a screen reader.
 */
export function OutcomeDueRing({
  dueAt,
  startedAt,
  clock,
  testId,
}: {
  dueAt: string;
  /** When the window opened (the call's end), for the ring's fill. */
  startedAt: string | null;
  clock: ServerClock;
  testId: string;
}) {
  useRepaintTick();
  const left = clock.until(dueAt);
  const at = clock.corrected(dueAt);
  if (left === null || at === null) return null;
  const from = startedAt ? clock.corrected(startedAt) : null;
  const span = from !== null ? at - from : null;
  const fraction = span && span > 0 ? Math.min(1, left / span) : 1;
  const r = 18;
  const c = 2 * Math.PI * r;
  return (
    <span className={styles.ring} data-testid={testId}>
      <svg className={styles.ringSvg} viewBox="0 0 44 44" aria-hidden="true">
        <circle className={styles.ringTrack} cx="22" cy="22" r={r} />
        <circle className={styles.ringFill} cx="22" cy="22" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - fraction)} />
      </svg>
      <span>
        <small aria-hidden="true">{left > 0 ? STATION_COPY.timeLeft : SIDE_COPY.closing}</small>
        <span className={styles.num} aria-hidden="true" data-testid={`${testId}-digits`}>{runningClock(left)}</span>
        <span className={styles.srOnly}>{SIDE_COPY.closesAt(clockTime(at))}</span>
      </span>
    </span>
  );
}

/** "Call is recorded", with its red dot, in the band (spec 04). */
export function RecordedPill({ testId }: { testId: string }) {
  return (
    <span className={styles.pill} data-testid={testId}>
      <span className={styles.recDot} aria-hidden="true" />
      {STATION_COPY.callRecorded}
    </span>
  );
}
