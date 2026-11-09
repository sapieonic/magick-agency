import { AGENCY_INBOUND_VOICEMAIL_MAX_SECONDS } from '@magick-agency/contracts/agency';
import { createChildLogger } from '@magick-agency/observability';
import type { WebRtcBridgeManager } from '../../core/webrtc-bridge-manager.js';
import { createWavBuffer } from '../../tts/tts-file-cache.js';
import { deleteFile, isStorageConfigured, uploadFile } from '../../storage/s3.js';

const log = createChildLogger({ component: 'agency-inbound-voicemail' });

/**
 * ─── VOICEMAIL: A CALLER WHO REACHES NOBODY LEAVES A MESSAGE (docs/inbound.md §7, IB3, Q14) ───
 *
 * A route whose after-hours or overflow action is `voicemail` takes one instead of only telling
 * the caller we will call back. Recorded from our own stream (we hold the caller's audio; the
 * call is never moved to the carrier's `<Record>`): the bridge's `recordInboundAudio` stops
 * whatever plays, plays the action's message as the prompt (the router picks it: `closed` after
 * hours; the call-back message from the queue, `closed` for a withheld caller), then the built-in
 * beep, then captures the caller through a carrier tap, at most
 * {@link AGENCY_INBOUND_VOICEMAIL_MAX_SECONDS} (120 s). A recording that ran to the maximum ends
 * the call here (`inbound_voicemail`); a caller who hangs up ends it themselves.
 *
 * Kept only when the caller SPOKE ({@link callerSpoke}): at least a second of audio with one
 * 20 ms stretch above a quiet floor. A caller who hangs up at the beep, or during the prompt,
 * leaves no voicemail: their call is the action's ordinary Missed row (`closed` / `overflow`).
 *
 * Stored as a WAV (PCM16, 16 kHz, mono, as the bridge decodes it) in the app's bucket at
 * {@link voicemailKey}, beside nothing else of the call: a call's recording stays at its carrier
 * (`agency_calls.recording_url`), and both age out on the call-data window
 * (`AGENCY_RETENTION_DAYS`, `maintenance/retention-purge.ts`, which deletes the object and clears
 * the row's `voicemail_key`). Played back through `GET /proxy/agency/inbound/missed/:id/voicemail`.
 * No analysis of voicemails yet (P3).
 */

/** A recording shorter than this is no voicemail (a caller who hung up at the beep). */
export const INBOUND_VOICEMAIL_MIN_SECONDS = 1;
/** The RMS (PCM16) one 20 ms stretch must reach for the recording to hold speech: about -40 dBFS. */
export const INBOUND_VOICEMAIL_SPEECH_RMS = 330;

/** Where a call's voicemail is stored in the app's bucket. */
export function voicemailKey(tenantId: string, accountId: string, inboundCallId: string): string {
  return `inbound-voicemail/${tenantId}/${accountId}/${inboundCallId}.wav`;
}

/**
 * Whether a recording holds the caller speaking: at least {@link INBOUND_VOICEMAIL_MIN_SECONDS}
 * of audio, and one 20 ms stretch whose RMS reaches {@link INBOUND_VOICEMAIL_SPEECH_RMS}. Line
 * hiss and a caller listening in silence stay under it.
 */
export function callerSpoke(pcm16: Buffer, sampleRate: number): boolean {
  const samples = Math.floor(pcm16.length / 2);
  if (samples < sampleRate * INBOUND_VOICEMAIL_MIN_SECONDS) return false;
  const window = Math.max(1, Math.round(sampleRate / 50));
  const threshold = INBOUND_VOICEMAIL_SPEECH_RMS * INBOUND_VOICEMAIL_SPEECH_RMS * window;
  for (let start = 0; start + window <= samples; start += window) {
    let energy = 0;
    for (let i = start; i < start + window; i++) {
      const v = pcm16.readInt16LE(i * 2);
      energy += v * v;
    }
    if (energy >= threshold) return true;
  }
  return false;
}

/** How a voicemail attempt went ({@link takeVoicemail}). */
export type VoicemailTaken =
  /** Recorded and stored: the call's outcome is `voicemail`. */
  | { kind: 'kept'; key: string; seconds: number }
  /** The caller left without speaking, or what they said could not be stored: the action's ordinary end. */
  | { kind: 'none' }
  /** No media to record from (the call ended before or as it started). */
  | { kind: 'lost' };

export interface InboundVoicemailDeps {
  bridge: Pick<WebRtcBridgeManager, 'recordInboundAudio' | 'forceEndWithOutcome'>;
  /** The bucket (tests replace it). Default: the app's S3 bucket. */
  storage?: {
    configured(): boolean;
    upload(key: string, body: Buffer, contentType: string): Promise<void>;
    remove(key: string): Promise<void>;
  };
}

// Every member reads the storage module when called, never at load (a module that imports the
// router must not need the bucket's exports to load).
const S3_STORAGE: NonNullable<InboundVoicemailDeps['storage']> = {
  configured: () => isStorageConfigured(),
  upload: (key, body, contentType) => uploadFile(key, body, contentType),
  remove: (key) => deleteFile(key),
};

/** Delete a stored voicemail no row names (its call was ended by another writer first). Never throws. */
export async function discardVoicemail(deps: Pick<InboundVoicemailDeps, 'storage'>, key: string): Promise<void> {
  await (deps.storage ?? S3_STORAGE).remove(key)
    .catch((err: unknown) => log.warn({ err, key }, 'Could not delete a voicemail no call names'));
}

/** Whether this process can store a voicemail (the bucket is configured); without one the action falls back to its message. */
export function voicemailAvailable(deps: Pick<InboundVoicemailDeps, 'storage'>): boolean {
  return (deps.storage ?? S3_STORAGE).configured();
}

/**
 * Record a voicemail on the call (its correlation id `call.id`) after `promptClipHashes` and the
 * beep, end the call if the recording ran to the maximum, and store what the caller said. Never
 * throws.
 */
export async function takeVoicemail(
  deps: InboundVoicemailDeps,
  call: { id: string; tenant_id: string; account_id: string },
  promptClipHashes: readonly string[],
): Promise<VoicemailTaken> {
  const storage = deps.storage ?? S3_STORAGE;
  let recording;
  try {
    recording = await deps.bridge.recordInboundAudio(call.id, {
      maxSeconds: AGENCY_INBOUND_VOICEMAIL_MAX_SECONDS, promptClipHashes, beep: true,
    });
  } catch (err) {
    log.error({ err, inboundCallId: call.id }, 'Voicemail recording failed');
    return { kind: 'lost' };
  }
  if (recording.result === 'completed') {
    // The maximum: the caller is still on the line, and we put the call down.
    await deps.bridge.forceEndWithOutcome(call.id, 'inbound_voicemail')
      .catch((err: unknown) => log.warn({ err, inboundCallId: call.id }, 'Could not end the call after its voicemail'));
  }
  if (recording.result === 'no_media' || recording.result === 'not_found') return { kind: 'lost' };
  if (!callerSpoke(recording.pcm16, recording.sampleRate)) {
    log.info({ inboundCallId: call.id, seconds: recording.seconds, result: recording.result }, 'The caller left no voicemail');
    return { kind: 'none' };
  }
  const key = voicemailKey(call.tenant_id, call.account_id, call.id);
  try {
    await storage.upload(key, createWavBuffer(recording.pcm16, recording.sampleRate, 1), 'audio/wav');
  } catch (err) {
    log.error({ err, inboundCallId: call.id, seconds: recording.seconds }, 'Could not store a voicemail — the call is followed up without it');
    return { kind: 'none' };
  }
  const seconds = Math.max(0, Math.round(recording.seconds));
  log.info({ inboundCallId: call.id, seconds }, 'Voicemail stored');
  return { kind: 'kept', key, seconds };
}
