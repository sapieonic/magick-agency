// Voicemail (docs/inbound.md §7, IB3, IQ14; `inbound-voicemail.ts`): what is recorded, when it is
// kept, where it is stored and how the call ends. The bridge and the bucket are fakes; the
// recording member itself is the bridge's (its own suite), the end-to-end path the inbound
// voicemail e2e suite.
import { describe, expect, it, vi } from 'vitest';
import { AGENCY_INBOUND_VOICEMAIL_MAX_SECONDS } from '@magick-agency/contracts/agency';
import type { InboundAudioRecording } from '../../../../src/core/webrtc-bridge-manager.js';
import {
  INBOUND_VOICEMAIL_SPEECH_RMS,
  callerSpoke,
  takeVoicemail,
  voicemailKey,
} from '../../../../src/agency/inbound/inbound-voicemail.js';

const RATE = 16_000;

/** `seconds` of PCM16 at 16 kHz: a 400 Hz tone of `amplitude` for the first `loudSeconds`, then silence. */
function pcm(seconds: number, amplitude: number, loudSeconds = seconds): Buffer {
  const n = Math.round(seconds * RATE);
  const out = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = i < loudSeconds * RATE ? Math.round(amplitude * Math.sin((2 * Math.PI * 400 * i) / RATE)) : 0;
    out.writeInt16LE(v, i * 2);
  }
  return out;
}

function recording(result: InboundAudioRecording['result'], audio: Buffer = Buffer.alloc(0)): InboundAudioRecording {
  return { result, pcm16: audio, sampleRate: RATE, seconds: audio.length / (RATE * 2) };
}

function fakes(rec: InboundAudioRecording) {
  const bridge = {
    recordInboundAudio: vi.fn().mockResolvedValue(rec),
    forceEndWithOutcome: vi.fn().mockResolvedValue(true),
  };
  const stored = new Map<string, { body: Buffer; contentType: string }>();
  const storage = {
    configured: () => true,
    upload: vi.fn(async (key: string, body: Buffer, contentType: string) => { stored.set(key, { body, contentType }); }),
    remove: vi.fn(async () => undefined),
  };
  return { bridge, storage, stored };
}

const CALL = { id: 'call-1', tenant_id: 'tenant-1', account_id: 'account-1' };

describe('callerSpoke: kept only when the caller said something', () => {
  it('a second of speech is a voicemail; silence, line hiss or a moment at the beep is not', () => {
    expect(callerSpoke(pcm(3, 4000, 1.5), RATE)).toBe(true);
    expect(callerSpoke(pcm(3, 0), RATE)).toBe(false);
    // Hiss well under the floor (a sine's RMS is its amplitude / √2).
    expect(callerSpoke(pcm(3, INBOUND_VOICEMAIL_SPEECH_RMS), RATE)).toBe(false);
    // Loud, but shorter than a second: a caller who hung up at the beep.
    expect(callerSpoke(pcm(0.6, 8000), RATE)).toBe(false);
    // One 20 ms stretch over the floor is enough.
    expect(callerSpoke(pcm(2, 8000, 0.03), RATE)).toBe(true);
  });
});

describe('takeVoicemail', () => {
  it('records after the prompt and the beep for at most 120 s, stores a 16 kHz WAV under the call\'s key, answers its length', async () => {
    const { bridge, storage, stored } = fakes(recording('caller_left', pcm(4.4, 6000)));
    const taken = await takeVoicemail({ bridge, storage }, CALL, ['hash-closed']);

    expect(bridge.recordInboundAudio).toHaveBeenCalledWith('call-1', {
      maxSeconds: AGENCY_INBOUND_VOICEMAIL_MAX_SECONDS, promptClipHashes: ['hash-closed'], beep: true,
    });
    expect(taken).toEqual({ kind: 'kept', key: 'inbound-voicemail/tenant-1/account-1/call-1.wav', seconds: 4 });
    expect(voicemailKey('tenant-1', 'account-1', 'call-1')).toBe('inbound-voicemail/tenant-1/account-1/call-1.wav');
    const wav = stored.get('inbound-voicemail/tenant-1/account-1/call-1.wav')!;
    expect(wav.contentType).toBe('audio/wav');
    expect(wav.body.subarray(0, 4).toString()).toBe('RIFF');
    expect(wav.body.readUInt32LE(24)).toBe(RATE);
    expect(wav.body.readUInt16LE(22)).toBe(1);
    expect(wav.body.length).toBe(44 + Math.round(4.4 * RATE) * 2);
    // The caller hung up themselves: we put nothing down.
    expect(bridge.forceEndWithOutcome).not.toHaveBeenCalled();
  });

  it('a recording that ran to the maximum ends the call (`inbound_voicemail`) and is kept', async () => {
    const { bridge, storage } = fakes(recording('completed', pcm(2, 6000)));
    const taken = await takeVoicemail({ bridge, storage }, CALL, []);
    expect(bridge.forceEndWithOutcome).toHaveBeenCalledWith('call-1', 'inbound_voicemail');
    expect(taken.kind).toBe('kept');
  });

  it('a caller who left before speaking leaves no voicemail and nothing is stored', async () => {
    const { bridge, storage } = fakes(recording('caller_left', pcm(0.4, 9000)));
    expect(await takeVoicemail({ bridge, storage }, CALL, ['h'])).toEqual({ kind: 'none' });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('nothing to record from (no media, or no call) is lost; a store that fails is no voicemail', async () => {
    for (const result of ['no_media', 'not_found'] as const) {
      const { bridge, storage } = fakes(recording(result));
      expect(await takeVoicemail({ bridge, storage }, CALL, [])).toEqual({ kind: 'lost' });
    }
    const failing = fakes(recording('caller_left', pcm(3, 6000)));
    failing.storage.upload.mockRejectedValueOnce(new Error('S3 down'));
    expect(await takeVoicemail({ bridge: failing.bridge, storage: failing.storage }, CALL, [])).toEqual({ kind: 'none' });
  });
});
