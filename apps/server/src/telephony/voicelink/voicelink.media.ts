// VoiceLink's media-stream protocol: Twilio-shaped JSON frames, audio carrier-forced
// to G.711 A-law 8 kHz, negotiated by a `start` frame that arrives after the socket opens.
import type { CarrierMediaProtocol, CarrierModule, CarrierStartResult } from '../carrier-module.js';
import { VoicelinkTranscoder } from '../../utils/audio-fir.js';
import { pcmToAlaw } from '../../utils/audio.js';

export const voicelinkMedia: CarrierMediaProtocol = {
  formatLabel: 'A-law 8kHz',
  negotiatesOnStart: true,

  parseStart(frame: unknown): CarrierStartResult {
    const data = (frame ?? {}) as Record<string, any>;
    const start = data.start ?? {};
    const fmt = start.media_format ?? {};
    const encoding = String(fmt.encoding ?? '').toLowerCase();
    const rate = String(fmt.sample_rate ?? '');
    // A-law 8 kHz is the only format the transcoder supports.
    if (encoding !== 'audio/alaw' || rate !== '8000') return { ok: false, encoding, rate };
    return {
      ok: true,
      carrierCallId: start.call_sid || data.call_sid || null,
      streamId: start.stream_sid || data.stream_sid || null,
    };
  },

  createCodec() {
    const t = new VoicelinkTranscoder();
    return {
      carrierToPcm16k: (alaw: Buffer) => t.alawToPcm16k(alaw),
      pcm16kToCarrier: (pcm: Buffer) => t.pcm16kToAlaw(pcm),
    };
  },

  // The plain {event:'media',media:{payload}} frame: no contentType, sampleRate or
  // stream_sid.
  frameOutbound(payloadBase64: string) {
    return { event: 'media', media: { payload: payloadBase64 } };
  },

  encodeClip(pcm16: Buffer, sampleRate: number) {
    // A-law: always 8 kHz, 1 byte per sample. `pcmToAlaw` resamples for us.
    const alaw = pcmToAlaw(pcm16, sampleRate);
    return alaw.length > 0 ? { buffer: alaw, byteRate: 8000 } : null;
  },
};

export const voicelinkCarrier: CarrierModule = {
  name: 'voicelink',
  media: voicelinkMedia,
  // VoiceLink's spec exposes no hangup endpoint: closing the lead WS is the only lever.
  answeredHangup: 'close_media',
  // `add_lead` carries the `websocket_url` VoiceLink dials out to; there is no answer XML.
  mediaUrlInDialRequest: true,
};
