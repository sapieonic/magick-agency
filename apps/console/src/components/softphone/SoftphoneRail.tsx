import { formatDuration } from '../../utils/agencyClock';
import { useRepaintTick } from '../../hooks/useRepaintTick';
import { describeSoftphoneRail } from '../../utils/softphone/callState';
import type { ServerClock } from '../../hooks/useServerClock';
import type { StationConnection } from '../../hooks/agencyStation/types';
import type { AgencyManualCall } from '../../types/softphone';
import styles from '../agency/StateRail.module.css';

/**
 * The soft phone's state rail: Ready, Dialing, Ringing, On call, Outcome needed.
 *
 * The station's rail (`StateRail`) in everything but its table — the same 64px
 * band, the same tints and accent bar, the same 40px timer — so an agent who
 * switches from a campaign to the soft phone reads the same signal in the same
 * place. It is a separate component rather than more arms in `describeRail`
 * because the soft phone is a BREAK (`docs/softphone.md` §2): `StateRail`'s break
 * arm offers "End break", and a soft-phone break must never show it — returning
 * to the campaign is its own act, in the header, refused while a call is unsettled.
 *
 * The rail is the screen's polite live region, as on the station; the timer
 * inside it is `aria-hidden` and repaints itself alone.
 */
export function SoftphoneRail({
  connection,
  call,
  lastCall,
  fromCampaign,
  contactName,
  clock,
  onReconnect,
}: {
  connection: StationConnection;
  call: AgencyManualCall | null;
  lastCall: AgencyManualCall | null;
  fromCampaign: boolean;
  contactName: string | null;
  clock: ServerClock;
  onReconnect?: () => void;
}) {
  const rail = describeSoftphoneRail({ connection, call, lastCall, fromCampaign, contactName });
  const recoverable = connection === 'disconnected' || connection === 'superseded';

  return (
    <div
      className={`${styles.rail} ${styles[`tone_${rail.tone}`]}`}
      role="status"
      aria-live="polite"
      data-tone={rail.tone}
      data-testid="softphone-rail"
    >
      <span className={styles.accent} aria-hidden="true" />
      <span className={styles.label} data-testid="rail-label">
        {rail.label}
      </span>
      {rail.detail ? (
        <span className={styles.detail} data-testid="rail-detail">
          {rail.detail}
        </span>
      ) : null}
      {rail.timerFrom ? <RailTimer from={rail.timerFrom} clock={clock} /> : null}
      {recoverable && onReconnect ? (
        <span className={styles.recovery}>
          <button type="button" className={styles.recoveryPrimary} onClick={onReconnect}>
            {connection === 'superseded' ? 'Use this window instead' : 'Reconnect'}
          </button>
        </span>
      ) : null}
    </div>
  );
}

/** Its own leaf so that only the digits repaint, four times a second. */
function RailTimer({ from, clock }: { from: string; clock: ServerClock }) {
  useRepaintTick();
  const ms = clock.since(from);
  if (ms === null) return null;
  return (
    <span className={styles.talkTimer} data-testid="softphone-timer" aria-hidden="true">
      {formatDuration(ms)}
    </span>
  );
}
