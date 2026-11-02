import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAudioPlayback } from '../../hooks/useAudioPlayback';
import { AlawDownlinkDecoder, alawEncodeSample } from '../../utils/alaw8/g711.js';

/**
 * **`playAlaw`: the customer's voice in `media=alaw8`.**
 *
 * Each binary frame is decoded and interpolated to 16 kHz in the hook's one decoder,
 * whose filter history runs across frames (no click at a 20 ms boundary), and then
 * scheduled by the same code as a `pcm16` frame. `flush()` ends the stream: the next
 * call's first frame must not carry the last call's tail.
 */

interface Scheduled {
  samples: Float32Array;
  rate: number;
  at: number;
}
let scheduled: Scheduled[] = [];

class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  destination = {};
  createGain() {
    return { connect: () => {}, gain: { value: 1 } };
  }
  createBuffer(_ch: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return { duration: length / rate, rate, getChannelData: () => data };
  }
  createBufferSource() {
    const node = {
      buffer: null as { getChannelData: () => Float32Array; rate: number } | null,
      connect: () => {},
      start: (at: number) => {
        scheduled.push({ samples: node.buffer!.getChannelData(), rate: node.buffer!.rate, at });
      },
      stop: () => {},
      onended: null,
    };
    return node;
  }
  async resume() {}
  async close() {}
}

function toneFrames(count: number): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (let f = 0; f < count; f++) {
    const bytes = new Uint8Array(160);
    for (let i = 0; i < 160; i++) {
      bytes[i] = alawEncodeSample(Math.round(8000 * Math.sin((2 * Math.PI * 1000 * (f * 160 + i)) / 8000)));
    }
    out.push(bytes.buffer);
  }
  return out;
}

beforeEach(() => {
  scheduled = [];
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useAudioPlayback.playAlaw', () => {
  it('schedules 320 samples at 16 kHz per 160-byte frame, back to back', () => {
    const { result } = renderHook(() => useAudioPlayback({ jitterMs: 60 }));
    const frames = toneFrames(3);
    act(() => frames.forEach((f) => result.current.playAlaw(f)));

    expect(scheduled.map((s) => [s.samples.length, s.rate])).toEqual([
      [320, 16000],
      [320, 16000],
      [320, 16000],
    ]);
    expect(scheduled[0]!.at).toBeCloseTo(0.06, 9);
    expect(scheduled[1]!.at).toBeCloseTo(0.08, 9);
    expect(scheduled[2]!.at).toBeCloseTo(0.1, 9);
  });

  it('carries the filter across frames: frame by frame equals one continuous decode', () => {
    const { result } = renderHook(() => useAudioPlayback());
    const frames = toneFrames(5);
    act(() => frames.forEach((f) => result.current.playAlaw(f)));

    const whole = new Uint8Array(800);
    frames.forEach((f, i) => whole.set(new Uint8Array(f), i * 160));
    const expected = new AlawDownlinkDecoder().decode(whole);
    const played = new Float32Array(1600);
    scheduled.forEach((s, i) => played.set(s.samples, i * 320));
    expect(played).toEqual(expected);
  });

  it('flush() starts the next stream from a clean filter', () => {
    const { result } = renderHook(() => useAudioPlayback());
    const frames = toneFrames(2);
    act(() => {
      result.current.playAlaw(frames[0]!);
      result.current.playAlaw(frames[1]!);
      result.current.flush();
      result.current.playAlaw(frames[0]!);
    });
    expect(scheduled[2]!.samples).toEqual(scheduled[0]!.samples);
  });

  it('ignores an empty message', () => {
    const { result } = renderHook(() => useAudioPlayback());
    act(() => result.current.playAlaw(new ArrayBuffer(0)));
    expect(scheduled).toEqual([]);
  });
});
