/**
 * A recording the carrier delivered for a call that did not ask for one (RC1). The bridge
 * never stores it: not on the live session, not in the terminal write, not as late carrier
 * data. VoiceLink is never told whether to record (its `add_lead` has no such field), so it
 * records on its own account default and posts a `recordingUrl` on `call.completed`; Plivo is
 * told (`<Record>` only when recording), so a discard there means something asked it to record
 * that we did not.
 *
 * Each discard is noted here: one warn log (call id and provider, never the URL: a signed
 * carrier URL can carry a secret) and one `recording_discarded_unrequested_total{provider}` per
 * call, however many terminal, recording and retried callbacks carry the URL. Bounded, oldest
 * first: a call it has forgotten logs and counts again, which is noise, never a stored recording.
 */
import { createChildLogger } from '@magick-agency/observability';
import { trackRecordingDiscardedUnrequested } from '@magick-agency/observability/metrics/voice';

const log = createChildLogger({ component: 'webrtc-bridge-manager' });

/** How many calls' discards are remembered (oldest forgotten first). */
export const UNREQUESTED_RECORDINGS_REMEMBERED = 10_000;

/** Where the URL arrived: on a live call, in its terminal event, or after teardown. */
export type UnrequestedRecordingWhere = 'live' | 'terminal' | 'late';

export class UnrequestedRecordings {
  private readonly seen = new Set<string>();

  constructor(private readonly max = UNREQUESTED_RECORDINGS_REMEMBERED) {}

  /** Note that `callId`'s recording URL was discarded: logged and counted on the call's first one only. */
  discard(callId: string, provider: string, where: UnrequestedRecordingWhere): void {
    if (this.seen.has(callId)) return;
    if (this.seen.size >= this.max) this.seen.delete(this.seen.values().next().value!);
    this.seen.add(callId);
    trackRecordingDiscardedUnrequested(provider);
    log.warn(
      { callId, provider, where },
      'Carrier delivered a recording for a call that did not ask for one — discarded, not stored',
    );
  }
}
