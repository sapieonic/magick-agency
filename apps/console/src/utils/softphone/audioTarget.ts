import { isCallLive } from './callState';
import type { LiveAttempt } from '../../hooks/agencyStation/types';
import type { AgencyManualCall } from '../../types/softphone';
import type { AgencyInboundCall } from '../../types/inbound';
import { isInboundCallLive } from '../inbound/inboundCall';

/**
 * What `useAgencyAudio.sync` should be told, for a station that may carry a
 * campaign attempt OR a soft-phone call on the same socket.
 *
 * The two gates are the station's, unchanged:
 *
 *  - **armed** (`id`) opens the microphone. For a campaign attempt that is
 *    `reserved`; for a soft-phone call it is the moment dialling starts
 *    (`queued`), so `getUserMedia` is not on the path of the customer's "hello".
 *  - **bridged** opens the uplink, and only `bridged_at` may set it — the instant
 *    audio is live both ways (`AgencyStationManualCallFrame`). Deriving it from
 *    `answered` would put the agent's voice on the wire before audio reaches them.
 *
 * A campaign attempt wins over a manual call: they cannot both be live on one
 * session (the soft phone is a break, and pacing never reserves a break), so if
 * both are set the attempt is the newer truth and the manual copy is stale.
 *
 * An inbound call (P2) rides the same gates on a campaign session: the microphone arms on the
 * offer (`offered`, about 1.5 s before the caller's audio binds) and the uplink opens on
 * `bridged_at`. It ranks after a campaign attempt (no attempt is reserved onto a session
 * holding one) and before a manual call (an inbound call is offered only to an `available`
 * agent, never to one on the soft phone).
 */
export function audioTarget(input: {
  stationIsGone: boolean;
  live: LiveAttempt | null;
  manualCall: AgencyManualCall | null;
  inboundCall?: AgencyInboundCall | null;
}): { id: string | null; bridged: boolean } {
  if (input.stationIsGone) return { id: null, bridged: false };
  if (input.live) return { id: input.live.attempt.attempt_id, bridged: input.live.bridgedAt != null };
  const inbound = input.inboundCall;
  if (isInboundCallLive(inbound)) {
    return { id: inbound.id, bridged: inbound.state === 'connected' && inbound.bridged_at != null };
  }
  const call = input.manualCall;
  if (isCallLive(call)) return { id: call.id, bridged: call.bridged_at != null };
  return { id: null, bridged: false };
}
