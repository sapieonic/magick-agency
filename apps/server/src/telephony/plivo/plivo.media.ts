// Plivo's media-stream protocol. Plivo opens the socket to the URL our answer XML names
// (`<Stream bidirectional="true" contentType="audio/x-mulaw;rate=8000">`), negotiates with
// a `start` frame, then sends `{event:'media', media:{track, timestamp, chunk, payload}}`
// and finally `{event:'stop'}`. Audio to Plivo goes as `playAudio` frames. G.711 μ-law
// 8 kHz both ways; no browser leg speaks it, so every leg transcodes.
import type { CarrierLifecycle, CarrierMediaProtocol, CarrierModule, CarrierStartResult } from '../carrier-module.js';
import type { CallEvent } from '../types.js';
import { classifyPlivoOutcome, plivoCallbackFromEvent } from './plivo.webhook.js';
import { MulawTranscoder } from '../../utils/audio-fir.js';
import { pcmToMulaw } from '../../utils/audio.js';
import { declaredCancelsRinging } from '../carrier-ringing.js';

/** The `contentType` the answer XML asks for and every outbound frame declares. */
export const PLIVO_STREAM_CONTENT_TYPE = 'audio/x-mulaw';
export const PLIVO_STREAM_SAMPLE_RATE = 8000;

export const plivoMedia: CarrierMediaProtocol = {
  formatLabel: 'μ-law 8kHz',
  negotiatesOnStart: true,
  wireFormat: null,

  parseStart(frame: unknown): CarrierStartResult {
    const data = (frame ?? {}) as Record<string, any>;
    const start = (data.start ?? {}) as Record<string, any>;
    const fmt = (start.mediaFormat ?? {}) as Record<string, any>;
    const encoding = String(fmt.encoding ?? '').toLowerCase();
    const rate = String(fmt.sampleRate ?? '');
    // μ-law 8 kHz is the only format the transcoder supports.
    if (encoding !== PLIVO_STREAM_CONTENT_TYPE || rate !== String(PLIVO_STREAM_SAMPLE_RATE)) {
      return { ok: false, encoding, rate };
    }
    return {
      ok: true,
      carrierCallId: typeof start.callId === 'string' && start.callId ? start.callId : null,
      streamId: (typeof start.streamId === 'string' && start.streamId)
        || (typeof data.streamId === 'string' && data.streamId)
        || null,
    };
  },

  createCodec() {
    const t = new MulawTranscoder();
    return {
      carrierToPcm16k: (mulaw: Buffer) => t.mulawToPcm16k(mulaw),
      pcm16kToCarrier: (pcm: Buffer) => t.pcm16kToMulaw(pcm),
    };
  },

  frameOutbound(payloadBase64: string) {
    return {
      event: 'playAudio',
      media: { contentType: PLIVO_STREAM_CONTENT_TYPE, sampleRate: PLIVO_STREAM_SAMPLE_RATE, payload: payloadBase64 },
    };
  },

  encodeClip(pcm16: Buffer, sampleRate: number) {
    // μ-law: 8 kHz, 1 byte per sample. `pcmToMulaw` resamples for us.
    const mulaw = pcmToMulaw(pcm16, sampleRate);
    return mulaw.length > 0 ? { buffer: mulaw, byteRate: PLIVO_STREAM_SAMPLE_RATE } : null;
  },
};

/** Plivo's events (`plivoCallEvent`), read for the bridge. */
export const plivoLifecycle: CarrierLifecycle = {
  readEvent(event: CallEvent) {
    const n = plivoCallbackFromEvent(event);
    return {
      carrierCallId: n.callUuid,
      ...(n.recordingUrl ? { recordingUrl: n.recordingUrl } : {}),
      wasAnswered: n.wasAnswered,
      classify: (answered: boolean) => classifyPlivoOutcome({ ...n, wasAnswered: answered }),
    };
  },
};

export const plivoCarrier: CarrierModule = {
  name: 'plivo',
  media: plivoMedia,
  // `DELETE /Call/{call_uuid}/` hangs an answered call up; teardown finalises at once.
  answeredHangup: 'rest',
  // The stream URL goes in the answer XML Plivo fetches on answer, not in the dial.
  mediaUrlInDialRequest: false,
  // A ringing dial is cancelled by its request id (`DELETE /Request/{id}/`): `carrier-ringing.ts`.
  cancelsRinging: declaredCancelsRinging('plivo'),
  lifecycle: plivoLifecycle,
};
