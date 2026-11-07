// The carrier-module registry is the bridge's only source of carrier facts (media
// protocol, hangup style, where the stream URL goes). These tests hold it equal to the
// adapter registries in `factory.ts` (the `instantiate` switch for the service's own
// accounts, `BYOC_ADAPTERS` for tenant credentials) and pin each module's protocol, so
// a carrier added to one list but not the other, or a VoiceLink frame shape that
// drifts, goes red here. A BYOC adapter without a module would leave the bridge with
// no carrier: no audio relay and no media-socket token check.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { carrierCancelsRinging, carrierModuleNames, findCarrierModule } from '../../../src/telephony/carrier-modules.js';
import { carrierRingingDeclarations } from '../../../src/telephony/carrier-ringing.js';
import { byocProviderNames } from '../../../src/telephony/factory.js';
import { findCredentialSpec } from '../../../src/telephony/credentials/credential-specs.js';
import { decodeMulaw, encodeAlaw, encodeMulaw } from '../../../src/utils/audio.js';

/** The provider names `factory.ts`'s `instantiate` switch can construct. */
function adapterRegistryNames(): string[] {
  const src = readFileSync(resolve(process.cwd(), 'src/telephony/factory.ts'), 'utf8');
  const body = src.slice(src.indexOf('function instantiate('));
  const switchBody = body.slice(0, body.indexOf('function createProviderInstance'));
  return [...switchBody.matchAll(/case '([a-z0-9_]+)':/g)].map((m) => m[1]!);
}

describe('carrier-module registry', () => {
  it('names exactly the providers factory.ts can build, on the service’s accounts or a tenant’s', () => {
    const own = adapterRegistryNames();
    expect(own.length).toBeGreaterThan(0);
    const adapters = [...new Set([...own, ...byocProviderNames()])].sort();
    expect(carrierModuleNames().sort()).toEqual(adapters);
  });

  it('every BYOC provider has a credential spec to store its credential with', () => {
    for (const name of byocProviderNames()) expect(findCredentialSpec(name), name).toBeDefined();
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
      expect([null, 'alaw8']).toContain(m.media.wireFormat);
      expect(typeof m.cancelsRinging).toBe('boolean');
    }
  });

  it('the codec-free ringing declaration covers exactly the registered modules, and each module reads its own', () => {
    expect(carrierRingingDeclarations().sort()).toEqual(carrierModuleNames().sort());
    for (const name of carrierModuleNames()) {
      expect(findCarrierModule(name)!.cancelsRinging).toBe(carrierCancelsRinging(name));
    }
  });

  it('carrierCancelsRinging reads the module and fails closed', () => {
    expect(carrierCancelsRinging('plivo')).toBe(true);
    expect(carrierCancelsRinging('voicelink')).toBe(false);
    // No leg yet, or a name no carrier answers to: unable, so the agent is warned.
    expect(carrierCancelsRinging(null)).toBe(false);
    expect(carrierCancelsRinging(undefined)).toBe(false);
    expect(carrierCancelsRinging('nope')).toBe(false);
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

  it('declares A-law 8 kHz as its wire format, so an alaw8 station leg relays without a codec', () => {
    // The claim `wireFormat` makes: a `start` it accepts is A-law 8 kHz, and a frame's
    // payload is the raw bytes, base64 — what `frameOutbound` carries unchanged.
    expect(vl.media.wireFormat).toBe('alaw8');
    expect(vl.media.parseStart({ start: { media_format: { encoding: 'audio/alaw', sample_rate: '8000' } } }).ok).toBe(true);
    const raw = Buffer.from([0xd5, 0x55, 0x2a]);
    expect(Buffer.from((vl.media.frameOutbound(raw.toString('base64'), null).media as { payload: string }).payload, 'base64'))
      .toEqual(raw);
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

describe('plivo carrier module', () => {
  const pl = findCarrierModule('plivo')!;
  const start = (mediaFormat: unknown, extra: Record<string, unknown> = {}) => ({
    event: 'start',
    start: { callId: 'call-uuid-1', streamId: 'stream-1', accountId: 'MA1', tracks: ['inbound'], mediaFormat, ...extra },
  });

  it('hangs up over REST and takes the stream URL from the answer XML, not the dial', () => {
    expect(pl.answeredHangup).toBe('rest');
    expect(pl.mediaUrlInDialRequest).toBe(false);
    expect(pl.media.negotiatesOnStart).toBe(true);
    // No browser leg speaks μ-law: every leg transcodes.
    expect(pl.media.wireFormat).toBeNull();
    expect(pl.media.formatLabel).toBe('μ-law 8kHz');
  });

  it('accepts a μ-law 8 kHz start and captures Plivo’s call and stream ids', () => {
    expect(pl.media.parseStart(start({ encoding: 'audio/x-mulaw', sampleRate: 8000 })))
      .toEqual({ ok: true, carrierCallId: 'call-uuid-1', streamId: 'stream-1' });
    expect(pl.media.parseStart({ event: 'start', streamId: 's-top', start: { mediaFormat: { encoding: 'AUDIO/X-MULAW', sampleRate: '8000' } } }))
      .toEqual({ ok: true, carrierCallId: null, streamId: 's-top' });
  });

  it.each([
    [{ encoding: 'audio/x-l16', sampleRate: 8000 }, 'audio/x-l16', '8000'],
    [{ encoding: 'audio/x-mulaw', sampleRate: 16000 }, 'audio/x-mulaw', '16000'],
    [{ encoding: 'audio/alaw', sampleRate: 8000 }, 'audio/alaw', '8000'],
    [undefined, '', ''],
  ])('refuses any other format (%j)', (fmt, encoding, rate) => {
    expect(pl.media.parseStart(start(fmt))).toEqual({ ok: false, encoding, rate });
  });

  it('refuses a missing or VoiceLink-shaped start frame', () => {
    expect(pl.media.parseStart(null)).toEqual({ ok: false, encoding: '', rate: '' });
    expect(pl.media.parseStart({ start: { media_format: { encoding: 'audio/x-mulaw', sample_rate: '8000' } } }))
      .toEqual({ ok: false, encoding: '', rate: '' });
  });

  it('frames outbound audio as playAudio with its content type and rate', () => {
    expect(pl.media.frameOutbound('QUJD', 'stream-1')).toEqual({
      event: 'playAudio',
      media: { contentType: 'audio/x-mulaw', sampleRate: 8000, payload: 'QUJD' },
    });
  });

  it('encodes a clip to μ-law 8 kHz at one byte per sample', () => {
    const clip = pl.media.encodeClip(Buffer.alloc(16000 * 2), 16000)!;
    expect(clip.byteRate).toBe(8000);
    expect(clip.buffer.length).toBe(8000);
    expect(pl.media.encodeClip(Buffer.alloc(0), 16000)).toBeNull();
  });

  it('transcodes μ-law 8 kHz to PCM16 16 kHz and back, keeping a tone’s level', () => {
    const codec = pl.media.createCodec();
    const tone = new Int16Array(160 * 10);
    for (let i = 0; i < tone.length; i++) tone[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 8000));
    const mulaw = encodeMulaw(tone);
    const pcm: Buffer[] = [];
    for (let f = 0; f < 10; f++) pcm.push(codec.carrierToPcm16k(mulaw.subarray(f * 160, (f + 1) * 160)));
    const pcm16k = Buffer.concat(pcm);
    expect(pcm16k.length % 2).toBe(0);
    const back = Buffer.concat(Array.from({ length: 10 }, (_, f) => codec.pcm16kToCarrier(pcm16k.subarray(f * 640, (f + 1) * 640))));
    expect(back.length).toBeGreaterThan(1200);
    const decoded = decodeMulaw(back.subarray(400, 1200));
    const peak = decoded.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(peak).toBeGreaterThan(7000);
    expect(peak).toBeLessThan(9000);
  });
});

// The lifecycle hook: the bridge's status handling reads every carrier's events through
// it (B18: no `provider === …` branch in the bridge), so each module must have one, and
// it must read what that carrier's own parser produced.
describe('carrier lifecycle readers', () => {
  it('every module reads its own lifecycle events', () => {
    for (const name of carrierModuleNames()) {
      expect(findCarrierModule(name)!.lifecycle, name).toBeDefined();
    }
  });

  it('voicelink: the real call id, the recording and VoiceLink`s classifier, the bridge`s answer folded in', async () => {
    const { parseVoicelinkWebhook } = await import('../../../src/telephony/voicelink/voicelink.webhook.js');
    const lifecycle = findCarrierModule('voicelink')!.lifecycle!;
    // A real `call.ended` carries no callStatus: unanswered by itself.
    const event = parseVoicelinkWebhook({
      event: 'call.ended',
      call: { id: 'vl-1', status: 'ended', hangupCause: '16', recordingUrl: 'https://rec.example/r.mp3' },
    } as never, 'call-1')!;
    const facts = lifecycle.readEvent(event);
    expect(facts).toMatchObject({ carrierCallId: 'vl-1', recordingUrl: 'https://rec.example/r.mp3', wasAnswered: false });
    expect(facts.classify(true)).toMatchObject({ status: 'completed', outcome: 'remote_hangup' });
    expect(facts.classify(false).status).not.toBe('completed');
  });

  it('plivo: the CallUUID, the recording and Plivo`s classifier, read back off its own event', async () => {
    const { normalizePlivoCallback, plivoCallEvent } = await import('../../../src/telephony/plivo/plivo.webhook.js');
    const lifecycle = findCarrierModule('plivo')!.lifecycle!;
    const busy = lifecycle.readEvent(plivoCallEvent(normalizePlivoCallback('status', {
      CallStatus: 'busy', CallUUID: 'uuid-1', RequestUUID: 'req-1', HangupCauseName: 'Busy Line', HangupSource: 'Callee',
    }), 'call-1')!);
    expect(busy).toMatchObject({ carrierCallId: 'uuid-1', wasAnswered: false });
    expect(busy.classify(false)).toMatchObject({ status: 'busy', outcome: 'busy' });
    // The bridge's own answer anchor wins over a terminal that does not say it was answered.
    expect(busy.classify(true)).toMatchObject({ status: 'completed', outcome: 'remote_hangup' });

    const done = lifecycle.readEvent(plivoCallEvent(normalizePlivoCallback('status', {
      CallStatus: 'completed', CallUUID: 'uuid-2', Duration: '31', AnswerTime: '2026-11-07 10:00:00',
    }), 'call-1')!);
    expect(done).toMatchObject({ carrierCallId: 'uuid-2', wasAnswered: true });
    expect(done.classify(done.wasAnswered).status).toBe('completed');
  });
});
