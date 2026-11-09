import { describe, it, expect } from 'vitest';

// The bridge's generated tones (`core/bridge/hold-tone.ts`): the built-in hold tone an inbound
// caller hears when the route has no hold clip (Q24) and the beep before a recording (Q14).

import {
  HOLD_TONE_PATTERN, RECORD_BEEP_PATTERN, TONE_SAMPLE_RATE, holdTonePcm16, recordBeepPcm16, synthesizeTones,
} from '../../../src/core/bridge/hold-tone.js';

const samples = (pcm: Buffer): number[] => Array.from({ length: pcm.length / 2 }, (_, i) => pcm.readInt16LE(i * 2));
const durationMs = (pattern: readonly { durationMs: number }[]) => pattern.reduce((a, s) => a + s.durationMs, 0);

describe('generated tones', () => {
  it('renders each segment at 8 kHz PCM16, silence where the pattern says', () => {
    const pcm = synthesizeTones([{ frequencyHz: 1000, durationMs: 50 }, { frequencyHz: null, durationMs: 25 }]);
    expect(pcm.length).toBe((400 + 200) * 2);
    const s = samples(pcm);
    expect(s.slice(400).every((v) => v === 0)).toBe(true);
    expect(s.slice(0, 400).some((v) => v !== 0)).toBe(true);
  });

  it('is soft (about -18 dBFS at its peak) and fades each note in and out, so nothing clicks', () => {
    const s = samples(synthesizeTones([{ frequencyHz: 1000, durationMs: 100 }]));
    const peak = Math.max(...s.map(Math.abs));
    expect(peak).toBeGreaterThan(0.1 * 32767);
    expect(peak).toBeLessThanOrEqual(Math.ceil(0.125 * 32767));
    expect(s[0]).toBe(0);
    expect(Math.abs(s.at(-1)!)).toBeLessThan(0.01 * 32767);
    // The first 1 ms is well under the note's level.
    expect(Math.max(...s.slice(0, 8).map(Math.abs))).toBeLessThan(0.02 * 32767);
  });

  it('the hold tone is a short chime then silence (~4 s a cycle, never a ringback cadence); the beep is 400 ms', () => {
    const hold = holdTonePcm16();
    expect(hold.sampleRate).toBe(TONE_SAMPLE_RATE);
    expect(hold.pcm16.length / 2 / TONE_SAMPLE_RATE * 1000).toBe(durationMs(HOLD_TONE_PATTERN));
    expect(durationMs(HOLD_TONE_PATTERN)).toBe(4000);
    const sounding = HOLD_TONE_PATTERN.filter((s) => s.frequencyHz !== null).reduce((a, s) => a + s.durationMs, 0);
    expect(sounding).toBeLessThan(500);
    expect(RECORD_BEEP_PATTERN.filter((s) => s.frequencyHz !== null).map((s) => s.durationMs)).toEqual([400]);
    expect(recordBeepPcm16().pcm16.length).toBe(durationMs(RECORD_BEEP_PATTERN) * 8 * 2);
    // Rendered once per process.
    expect(holdTonePcm16().pcm16).toBe(hold.pcm16);
  });
});
