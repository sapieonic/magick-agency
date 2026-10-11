// The carrier-module registry is the bridge's only source of carrier facts (media
// protocol, hangup style, where the stream URL goes). These tests hold it equal to the
// adapter registry in `factory.ts` and pin each module's protocol, so a carrier added
// to one list but not the other, or a VoiceLink frame shape that drifts, goes red here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { carrierModuleNames, findCarrierModule } from '../../../src/telephony/carrier-modules.js';
import { encodeAlaw } from '../../../src/utils/audio.js';

/** The provider names `factory.ts`'s `instantiate` switch can construct. */
function adapterRegistryNames(): string[] {
  const src = readFileSync(resolve(process.cwd(), 'src/telephony/factory.ts'), 'utf8');
  const body = src.slice(src.indexOf('function instantiate('));
  const switchBody = body.slice(0, body.indexOf('function createProviderInstance'));
  return [...switchBody.matchAll(/case '([a-z0-9_]+)':/g)].map((m) => m[1]!);
}

describe('carrier-module registry', () => {
  it('names exactly the providers factory.ts can instantiate', () => {
    const adapters = adapterRegistryNames().sort();
    expect(adapters.length).toBeGreaterThan(0);
    expect(carrierModuleNames().sort()).toEqual(adapters);
  });

  it('has no module for an unknown name', () => {
    expect(findCarrierModule('nope')).toBeUndefined();
  });

  it('every module is keyed by its own name and declares every fact', () => {
    for (const name of carrierModuleNames()) {
      const m = findCarrierModule(name)!;
      expect(m.name).toBe(name);
      expect(['close_media', 'rest']).toContain(m.answeredHangup);
      expect(typeof m.mediaUrlInDialRequest).toBe('boolean');
      expect(typeof m.media.negotiatesOnStart).toBe('boolean');
      expect(m.media.formatLabel.length).toBeGreaterThan(0);
    }
  });
});

describe('voicelink carrier module', () => {
  const vl = findCarrierModule('voicelink')!;

  it('closes media to hang up and bakes the stream URL into the dial', () => {
    expect(vl.answeredHangup).toBe('close_media');
    expect(vl.mediaUrlInDialRequest).toBe(true);
    expect(vl.media.negotiatesOnStart).toBe(true);
  });

  it('accepts an A-law 8 kHz start and captures the carrier ids', () => {
    expect(vl.media.parseStart({
      event: 'start',
      start: { call_sid: 'c1', stream_sid: 's1', media_format: { encoding: 'audio/ALAW', sample_rate: '8000' } },
    })).toEqual({ ok: true, carrierCallId: 'c1', streamId: 's1' });
  });

  it('falls back to top-level ids, and to null when absent', () => {
    expect(vl.media.parseStart({
      call_sid: 'c2', start: { media_format: { encoding: 'audio/alaw', sample_rate: 8000 } },
    })).toEqual({ ok: true, carrierCallId: 'c2', streamId: null });
  });

  it.each([
    [{ start: { media_format: { encoding: 'audio/x-mulaw', sample_rate: '8000' } } }, 'audio/x-mulaw', '8000'],
    [{ start: { media_format: { encoding: 'audio/alaw', sample_rate: '16000' } } }, 'audio/alaw', '16000'],
    [{}, '', ''],
    [null, '', ''],
  ])('refuses an unsupported or missing format (%j)', (frame, encoding, rate) => {
    expect(vl.media.parseStart(frame)).toEqual({ ok: false, encoding, rate });
  });

  it('frames outbound audio as a plain media frame, with no stream id', () => {
    expect(vl.media.frameOutbound('QUJD', 'stream-1')).toEqual({ event: 'media', media: { payload: 'QUJD' } });
  });

  it('encodes a clip to A-law 8 kHz at one byte per sample', () => {
    const pcm = Buffer.alloc(16000 * 2); // one second of 16 kHz silence
    const clip = vl.media.encodeClip(pcm, 16000)!;
    expect(clip.byteRate).toBe(8000);
    expect(clip.buffer.length).toBe(8000);
    expect(vl.media.encodeClip(Buffer.alloc(0), 16000)).toBeNull();
  });

  it('transcodes A-law 8 kHz to PCM16 16 kHz and back at the expected sizes', () => {
    const codec = vl.media.createCodec();
    // Two 20 ms frames so the streaming resampler has emitted steady-state output.
    const alaw = encodeAlaw(new Int16Array(160));
    codec.carrierToPcm16k(alaw);
    const pcm = codec.carrierToPcm16k(alaw);
    expect(pcm.length).toBeGreaterThan(0);
    expect(pcm.length % 2).toBe(0);
    const back = codec.pcm16kToCarrier(Buffer.alloc(640));
    expect(back.length).toBeGreaterThan(0);
    expect(back.length).toBeLessThanOrEqual(160);
  });
});
