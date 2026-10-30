import type { ReactNode } from 'react';
import { AppVersion } from '@magick-agency/web-ui/components/AppVersion';
import { StationIdentity, type StationIdentityUser } from '../agency/StationIdentity';
import { ConnectionHealthPill } from '../agency/ConnectionHealthPill';
import { AgentNav } from '../agency/AgentNav';
import type { StationConnection } from '../../hooks/agencyStation/types';
import type { SoftphoneState } from '../../hooks/useSoftphone';
import station from '../agency/AgentStation.module.css';
import styles from './SoftphoneView.module.css';

/** What leaving would do while a call is unsettled — the nav and the close both say it. */
export const SOFTPHONE_LEAVE_BLOCKED_COPY = 'Finish this call and save its outcome first — leaving now would cut the customer off.';

/** Recording disclosed as a dot plus the word, as on the station: the agent may have to announce it. */
export function recordingDisclosed(sp: SoftphoneState): boolean {
  if (sp.call) return sp.call.recording_requested;
  if (sp.campaign) return sp.campaign.record_calls;
  return Boolean(sp.bootstrap?.untagged.record_calls);
}

/**
 * The soft phone's header on `/dialer/phone`: who, the agent's screens (locked
 * while a call is unsettled), what is being disclosed (recording, muted, where
 * the call is logged), the connection, and the way out.
 */
export function SoftphoneHeader({
  user,
  sp,
  connection,
  missedPings,
  actions,
}: {
  user: StationIdentityUser | null | undefined;
  sp: SoftphoneState;
  connection: StationConnection;
  missedPings: number;
  /** The host's own controls (Close soft phone). */
  actions?: ReactNode;
}) {
  return (
    <header className={station.header}>
      <div className={station.identity}>
        <StationIdentity user={user} subline="Soft phone" />
        <AgentNav current="phone" variant="header" lockedReason={sp.call ? SOFTPHONE_LEAVE_BLOCKED_COPY : null} />
      </div>
      <div className={station.headerRight}>
        <SoftphoneDisclosures sp={sp} />
        {actions}
        <ConnectionHealthPill connection={connection} missedPings={missedPings} />
        <AppVersion version={__APP_VERSION__} variant="inline" />
      </div>
    </header>
  );
}

/** Recording, muted, and "Logging to" — shared by the page's header and the station's. */
export function SoftphoneDisclosures({ sp, showMuted = true }: { sp: SoftphoneState; showMuted?: boolean }) {
  const loggingTo = sp.campaign?.campaign_name ?? null;
  return (
    <>
      {recordingDisclosed(sp) ? (
        <span className={station.recording} data-testid="softphone-recording">
          <span className={station.recordingDot} aria-hidden="true" />
          Recording
        </span>
      ) : null}
      {showMuted && sp.micMuted ? (
        <span className={station.muted} data-testid="muted-pill">
          <span className={station.mutedDot} aria-hidden="true" />
          Muted
        </span>
      ) : null}
      <span className={`${styles.pill} ${loggingTo ? styles.pillAccent : ''}`} data-testid="logging-to">
        {loggingTo ? `Logging to: ${loggingTo}` : 'Not logged to a campaign'}
      </span>
    </>
  );
}
