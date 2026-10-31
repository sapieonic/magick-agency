import { isCallLive } from './callState';
import type { LiveAttempt } from '../../hooks/agencyStation/types';
import type { AgencyManualCall } from '../../types/softphone';

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
 */
export function audioTarget(input: {
  stationIsGone: boolean;
  live: LiveAttempt | null;
  manualCall: AgencyManualCall | null;
}): { id: string | null; bridged: boolean } {
  if (input.stationIsGone) return { id: null, bridged: false };
  if (input.live) return { id: input.live.attempt.attempt_id, bridged: input.live.bridgedAt != null };
  const call = input.manualCall;
  if (isCallLive(call)) return { id: call.id, bridged: call.bridged_at != null };
  return { id: null, bridged: false };
}
