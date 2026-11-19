import { Info } from 'lucide-react';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { INBOUND_FLAG } from '../../utils/inbound/inboundFlag';
import styles from './SoftphoneView.module.css';

/**
 * Why an inbound caller never rings here (`docs/inbound.md` §4.3, §5.1): an agent on the soft
 * phone is on `break/soft_phone`, which is never offered a caller, and a caller nobody on a
 * campaign station could take overflows at once to a Missed row. Taking a caller on the soft
 * phone is P3's (§12, "Remaining"); until then the soft phone says so, or a call that never
 * rang reads as a fault. The way back differs by host: a soft-phone session joins a campaign;
 * a campaign switched to the soft phone (SP7) returns to it.
 */
export const SOFTPHONE_INBOUND_NOTICE = {
  lead: 'Inbound calls don’t ring on the soft phone.',
  page: 'They go to agents on a campaign station, or to Missed calls if none is free. Join a campaign to take them.',
  station: 'They go to agents on a campaign station, or to Missed calls if none is free. Return to your campaign to take them.',
} as const;

/**
 * The note under the dial pad while the soft phone is ready to dial, shown while the account has
 * inbound calls on (`agency_inbound_enabled`). The flag is the closest signal the console holds:
 * whether the account has a route or a linked number is read only by `agency.inbound.write`
 * (`/inbound/routes`, `/inbound/numbers`), never by an agent, and no new read is added for a
 * notice. Off (or no flag provider) it renders nothing: with inbound off callers hear the closed
 * message and no agent is offered them anywhere.
 *
 * `role="note"`: standing context, not news, so it is never announced on its own. It sits after
 * Call, so on a narrow screen it never pushes the keypad down.
 */
export function SoftphoneInboundNotice({ fromCampaign }: { fromCampaign: boolean }) {
  const inboundOn = useFeatureFlagEnabled(INBOUND_FLAG);
  if (!inboundOn) return null;
  return (
    <p className={styles.inboundNotice} role="note" data-testid="softphone-inbound-notice">
      <Info size={14} aria-hidden="true" className={styles.inboundNoticeIcon} />
      <span>
        <strong>{SOFTPHONE_INBOUND_NOTICE.lead}</strong>{' '}
        {fromCampaign ? SOFTPHONE_INBOUND_NOTICE.station : SOFTPHONE_INBOUND_NOTICE.page}
      </span>
    </p>
  );
}
