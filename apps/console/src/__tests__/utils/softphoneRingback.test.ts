import { describe, it, expect, vi } from 'vitest';
import { RingbackTone, RINGBACK_CYCLE_MS, RINGBACK_FREQUENCIES_HZ, type RingbackAudioContext } from '../../utils/softphone/ringback';

/** A Web Audio stand-in that records what was scheduled. */
function fakeContext() {
  const oscillators: Array<{ hz: number; started: boolean; stopped: boolean }> = [];
  const gains: Array<{ calls: Array<[string, number, number]> }> = [];
  const ctx = {
    state: 'running' as AudioContextState,
    currentTime: 10,
    destination: {} as AudioNode,
    resume: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    createOscillator: () => {
      const rec = { hz: 0, started: false, stopped: false };
      oscillators.push(rec);
      return {
        type: 'sine',
        frequency: { setValueAtTime: (v: number) => { rec.hz = v; } },
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: () => { rec.started = true; },
        stop: () => { rec.stopped = true; },
      } as unknown as OscillatorNode;
    },
    createGain: () => {
      const rec = { calls: [] as Array<[string, number, number]> };
      gains.push(rec);
      const param = {
        setValueAtTime: (v: number, t: number) => rec.calls.push(['set', v, t]),
        linearRampToValueAtTime: (v: number, t: number) => rec.calls.push(['ramp', v, t]),
      };
      return { gain: param, connect: vi.fn(), disconnect: vi.fn() } as unknown as GainNode;
    },
  };
  return { ctx: ctx as unknown as RingbackAudioContext, oscillators, gains };
}

function timers() {
  const fns: Array<() => void> = [];
  return {
    fns,
    impl: {
      setInterval: (fn: () => void) => { fns.push(fn); return 1 as unknown as ReturnType<typeof setInterval>; },
      clearInterval: vi.fn(),
    },
  };
}

describe('RingbackTone', () => {
  it('rings 400 + 450 Hz, ring-ring, and keeps the cadence on the audio clock', () => {
    const { ctx, oscillators, gains } = fakeContext();
    const t = timers();
    const tone = new RingbackTone(() => ctx, t.impl);
    tone.unlock();
    tone.start();
    expect(tone.playing).toBe(true);
    expect(oscillators.map((o) => o.hz)).toEqual([...RINGBACK_FREQUENCIES_HZ]);
    expect(oscillators.every((o) => o.started)).toBe(true);
    // The envelope: two rings scheduled in the first cycle, each up and down.
    const envelope = gains[1]!;
    const peaks = envelope.calls.filter(([kind, v]) => kind === 'ramp' && v > 0);
    expect(peaks).toHaveLength(2);
    expect(RINGBACK_CYCLE_MS).toBe(3000);
    t.fns[0]!();
    expect(envelope.calls.filter(([kind, v]) => kind === 'ramp' && v > 0)).toHaveLength(4);
  });

  it('is silent when muted, and stops everything on stop', () => {
    const { ctx, oscillators, gains } = fakeContext();
    const t = timers();
    const tone = new RingbackTone(() => ctx, t.impl);
    tone.setMuted(true);
    tone.start();
    const master = gains[0]!;
    expect(master.calls[0]).toEqual(['set', 0, 10]);
    tone.setMuted(false);
    expect(master.calls[master.calls.length - 1]).toEqual(['set', 1, 10]);
    tone.stop();
    expect(tone.playing).toBe(false);
    expect(oscillators.every((o) => o.stopped)).toBe(true);
    expect(t.impl.clearInterval).toHaveBeenCalled();
  });

  it('close stops the ring and releases its context; a later ring makes a new one', () => {
    const first = fakeContext();
    const second = fakeContext();
    const contexts = [first.ctx, second.ctx];
    const t = timers();
    const tone = new RingbackTone(() => contexts.shift() ?? null, t.impl);
    tone.unlock();
    tone.start();
    tone.close();
    expect(tone.playing).toBe(false);
    expect(first.oscillators.every((o) => o.stopped)).toBe(true);
    expect(first.ctx.close).toHaveBeenCalledTimes(1);
    tone.start();
    expect(tone.playing).toBe(true);
    expect(second.oscillators).toHaveLength(2);
  });

  it('scales with the agent’s cue volume and does nothing without Web Audio', () => {
    const { ctx, gains } = fakeContext();
    const tone = new RingbackTone(() => ctx, timers().impl);
    tone.setVolume(0);
    tone.start();
    expect(gains[1]!.calls.filter(([kind, v]) => kind === 'ramp' && v > 0)).toHaveLength(0);
    const silent = new RingbackTone(() => null, timers().impl);
    silent.start();
    expect(silent.playing).toBe(false);
  });
});
