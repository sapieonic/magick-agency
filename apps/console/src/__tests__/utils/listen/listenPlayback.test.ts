import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LISTEN_CUSHION_MS,
  LISTEN_MAX_AHEAD_MS,
  LISTEN_PLAYBACK_RATE,
  ListenPlaybackEngine,
} from '../../../utils/listen/listenPlayback';
import { AlawDownlinkDecoder, alawEncodeSample } from '../../../utils/alaw8/g711.js';

/**
 * The listener's audio graph (`docs/listening.md` §2): one context; per leg its own decoder,
 * queue, analyser and gain; one master gain. Each leg is scheduled on its own with ~120 ms of
 * cushion, mute silences one leg only, and nothing ever asks for the microphone.
 */

interface FakeNode {
  kind: string;
  connections: FakeNode[];
  connect: (to: FakeNode) => void;
  gain?: { value: number };
}

let contexts: FakeContext[];

class FakeContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  destination: FakeNode = node('destination');
  gains: FakeNode[] = [];
  started: { at: number; samples: Float32Array; target: FakeNode; duration: number; stoppedAt: number | null }[] = [];
  stopped = 0;
  resumes = 0;
  suspends = 0;
  closed = false;
  level = 0;
  onstatechange: (() => void) | null = null;
  constructor() {
    contexts.push(this);
  }
  createGain() {
    const g = { ...node('gain'), gain: { value: 1 } };
    this.gains.push(g);
    return g;
  }
  createAnalyser() {
    const ctx = this;
    return {
      ...node('analyser'),
      fftSize: 2048,
      getFloatTimeDomainData(out: Float32Array) {
        out.fill(ctx.level);
      },
    };
  }
  createBuffer(_channels: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => data };
  }
  createBufferSource() {
    const ctx = this;
    const source = {
      ...node('source'),
      buffer: null as null | { getChannelData: () => Float32Array },
      onended: null as null | (() => void),
      entry: null as null | FakeContext['started'][number],
      start(at: number) {
        const samples = source.buffer!.getChannelData();
        source.entry = { at, samples, target: source.connections[0]!, duration: samples.length / LISTEN_PLAYBACK_RATE, stoppedAt: null };
        ctx.started.push(source.entry);
      },
      stop() {
        ctx.stopped += 1;
        if (source.entry && source.entry.stoppedAt === null) source.entry.stoppedAt = ctx.currentTime;
      },
    };
    return source;
  }
  async resume() {
    this.resumes += 1;
    this.state = 'running';
  }
  async suspend() {
    this.suspends += 1;
    this.state = 'suspended';
    this.onstatechange?.();
  }
  async close() {
    this.closed = true;
    this.state = 'closed';
  }
}

function node(kind: string): FakeNode {
  const n: FakeNode = {
    kind,
    connections: [],
    connect(to: FakeNode) {
      n.connections.push(to);
    },
  };
  return n;
}

function tone(frames: number): Uint8Array[] {
  return Array.from({ length: frames }, (_, f) => {
    const bytes = new Uint8Array(160);
    for (let i = 0; i < 160; i++) bytes[i] = alawEncodeSample(Math.round(6000 * Math.sin((2 * Math.PI * 440 * (f * 160 + i)) / 8000)));
    return bytes;
  });
}

let now = 0;
const engine = () => new ListenPlaybackEngine(() => new FakeContext() as unknown as AudioContext, () => now);

beforeEach(() => {
  contexts = [];
  now = 1_000;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('scheduling', () => {
  it('re-bases the first frame onto the cushion, then queues back to back at 16 kHz', () => {
    const e = engine();
    tone(3).forEach((f) => e.push('customer', f));
    const ctx = contexts[0]!;
    expect(ctx.started.map((s) => s.samples.length)).toEqual([320, 320, 320]);
    expect(ctx.started[0]!.at).toBeCloseTo(LISTEN_CUSHION_MS / 1000, 9);
    expect(ctx.started[1]!.at).toBeCloseTo(LISTEN_CUSHION_MS / 1000 + 0.02, 9);
    expect(ctx.started[2]!.at).toBeCloseTo(LISTEN_CUSHION_MS / 1000 + 0.04, 9);
  });

  it('keeps each leg’s own queue and decoder: the legs play together, not one after the other', () => {
    const e = engine();
    const frames = tone(2);
    e.push('customer', frames[0]!);
    e.push('agent', frames[0]!);
    e.push('customer', frames[1]!);
    e.push('agent', frames[1]!);
    const ctx = contexts[0]!;
    expect(ctx.started.map((s) => s.at.toFixed(3))).toEqual(['0.120', '0.120', '0.140', '0.140']);
    // Each leg decodes through its own filter: the agent's second frame is exactly a continuous decode.
    const whole = new Uint8Array(320);
    whole.set(frames[0]!, 0);
    whole.set(frames[1]!, 160);
    const expected = new AlawDownlinkDecoder().decode(whole).slice(320);
    expect(ctx.started[3]!.samples).toEqual(expected);
  });

  it('re-bases after an underrun, and when a burst would put the call too far behind', () => {
    const e = engine();
    const ctx = () => contexts[0]!;
    e.push('agent', tone(1)[0]!);
    ctx().currentTime = 5;
    e.push('agent', tone(1)[0]!);
    expect(ctx().started[1]!.at).toBeCloseTo(5 + LISTEN_CUSHION_MS / 1000, 9);
    // A burst: queue past the ceiling, and the next frame starts over at the cushion.
    const burst = Math.ceil(LISTEN_MAX_AHEAD_MS / 20) + 2;
    tone(burst).forEach((f) => e.push('agent', f));
    const starts = ctx().started.map((s) => s.at);
    expect(Math.max(...starts) - 5).toBeLessThanOrEqual(LISTEN_MAX_AHEAD_MS / 1000 + LISTEN_CUSHION_MS / 1000 + 0.02);
  });

  it('a burst past the ceiling re-bases without talking over what one leg already queued', () => {
    const e = engine();
    e.ensure();
    const ctx = contexts[0]!;
    // A TCP burst after a stall: far more than the ceiling arrives at one instant.
    tone(Math.ceil(LISTEN_MAX_AHEAD_MS / 20) * 2).forEach((f) => e.push('agent', f));
    ctx.currentTime = 0.05;
    tone(10).forEach((f) => e.push('agent', f));
    expect(Math.max(...ctx.started.map((s) => s.at)) - ctx.currentTime).toBeLessThanOrEqual(LISTEN_MAX_AHEAD_MS / 1000 + 0.02);
    // What each source really plays: from its start to its end, or to when it was stopped.
    const heard = ctx.started
      .map((s) => ({ from: s.at, to: Math.min(s.at + s.duration, s.stoppedAt === null ? Infinity : Math.max(s.at, s.stoppedAt)) }))
      .filter((s) => s.to > s.from)
      .sort((a, b) => a.from - b.from);
    for (let i = 1; i < heard.length; i++) {
      expect(heard[i]!.from, `source ${i} starts before the one before it ends`).toBeGreaterThanOrEqual(heard[i - 1]!.to - 1e-9);
    }
  });

  it('runs one context at the playback rate for both legs', () => {
    const e = engine();
    e.push('agent', tone(1)[0]!);
    e.push('customer', tone(1)[0]!);
    expect(contexts).toHaveLength(1);
    expect(LISTEN_PLAYBACK_RATE).toBe(16_000);
  });
});

describe('the graph: meter before mute, both legs into one master', () => {
  it('source → analyser → leg gain → master → destination', () => {
    const e = engine();
    e.push('agent', tone(1)[0]!);
    const ctx = contexts[0]!;
    const analyser = ctx.started[0]!.target;
    expect(analyser.kind).toBe('analyser');
    const legGain = analyser.connections[0]!;
    expect(legGain.kind).toBe('gain');
    const master = legGain.connections[0]!;
    expect(master).toBe(ctx.gains[0]);
    expect(master.connections[0]).toBe(ctx.destination);
  });

  it('mute silences one leg and leaves the other', () => {
    const e = engine();
    e.push('agent', tone(1)[0]!);
    e.push('customer', tone(1)[0]!);
    e.setMuted('agent', true);
    const ctx = contexts[0]!;
    const legGain = (i: number) => ctx.started[i]!.target.connections[0]!.gain!.value;
    expect(legGain(0)).toBe(0);
    expect(legGain(1)).toBe(1);
    expect(e.isMuted('agent')).toBe(true);
    e.setMuted('agent', false);
    expect(legGain(0)).toBe(1);
  });

  it('a leg muted before its first frame starts muted', () => {
    const e = engine();
    e.setMuted('customer', true);
    e.push('customer', tone(1)[0]!);
    expect(contexts[0]!.started[0]!.target.connections[0]!.gain!.value).toBe(0);
  });

  it('volume sets the master gain, clamped to 0–1, before and after the graph exists', () => {
    const e = engine();
    e.setVolume(0.4);
    e.push('agent', tone(1)[0]!);
    expect(contexts[0]!.gains[0]!.gain!.value).toBe(0.4);
    e.setVolume(3);
    expect(contexts[0]!.gains[0]!.gain!.value).toBe(1);
    e.setVolume(-1);
    expect(contexts[0]!.gains[0]!.gain!.value).toBe(0);
  });

  it('level: 0 before a leg has audio, and the analyser’s RMS scaled to 0–1', () => {
    const e = engine();
    expect(e.level('agent')).toBe(0);
    e.push('agent', tone(1)[0]!);
    contexts[0]!.level = 0.1;
    expect(e.level('agent')).toBeCloseTo(0.4, 5);
    contexts[0]!.level = 0.9;
    expect(e.level('agent')).toBe(1);
  });
});

describe('silence, blocking, reset and close', () => {
  it('silentFor: null before an attach, then since the attach or the leg’s last frame', () => {
    const e = engine();
    expect(e.silentFor('agent')).toBeNull();
    e.reset();
    now = 3_500;
    expect(e.silentFor('agent')).toBe(2_500);
    e.push('agent', tone(1)[0]!);
    now = 4_000;
    expect(e.silentFor('agent')).toBe(500);
    expect(e.silentFor('customer')).toBe(3_000);
  });

  it('blocked while the browser keeps the context suspended; resume lifts it', async () => {
    const e = engine();
    e.ensure();
    const ctx = contexts[0]!;
    ctx.state = 'suspended';
    ctx.resume = async () => {};
    expect(e.blocked).toBe(true);
    ctx.resume = async () => {
      ctx.state = 'running';
    };
    await e.resume();
    expect(e.blocked).toBe(false);
  });

  it('while the browser will not run the context, frames are dropped, not queued on a frozen clock, and resume is never asked per frame', () => {
    const e = engine();
    e.ensure();
    const ctx = contexts[0]!;
    ctx.state = 'suspended';
    ctx.resume = async () => {
      ctx.resumes += 1;
    };
    tone(100).forEach((f) => {
      e.push('agent', f);
      e.push('customer', f);
    });
    expect(ctx.started).toHaveLength(0);
    expect(ctx.resumes).toBe(0);
    expect(e.blocked).toBe(true);
    // The leg is still arriving: blocked sound is not a silent agent.
    expect(e.silentFor('agent')).toBe(0);
  });

  it('"Turn sound on" plays from now: no burst of what arrived while blocked', async () => {
    const e = engine();
    e.ensure();
    const ctx = contexts[0]!;
    ctx.state = 'suspended';
    ctx.resume = async () => {
      ctx.resumes += 1;
    };
    tone(50).forEach((f) => e.push('agent', f));
    ctx.currentTime = 3;
    ctx.resume = async () => {
      ctx.resumes += 1;
      ctx.state = 'running';
    };
    await e.resume();
    e.push('agent', tone(1)[0]!);
    const playing = ctx.started.filter((s) => s.stoppedAt === null);
    expect(playing).toHaveLength(1);
    expect(playing[0]!.at).toBeCloseTo(3 + LISTEN_CUSHION_MS / 1000, 9);
  });

  it('an interruption (the context leaving running) stops what was queued', () => {
    const e = engine();
    tone(5).forEach((f) => e.push('customer', f));
    const ctx = contexts[0]!;
    ctx.state = 'interrupted' as AudioContextState;
    ctx.onstatechange?.();
    expect(ctx.stopped).toBe(5);
    // And if the browser says nothing, the next frame finds out.
    ctx.state = 'running';
    tone(5).forEach((f) => e.push('customer', f));
    ctx.state = 'suspended';
    e.push('customer', tone(1)[0]!);
    expect(ctx.stopped).toBe(10);
  });

  it('release drops the queue and suspends the context; the next gesture resumes it', async () => {
    const e = engine();
    tone(3).forEach((f) => e.push('agent', f));
    const ctx = contexts[0]!;
    e.release();
    expect(ctx.stopped).toBe(3);
    expect(ctx.suspends).toBe(1);
    expect(ctx.closed).toBe(false);
    await e.resume();
    expect(ctx.state).toBe('running');
    e.push('agent', tone(1)[0]!);
    expect(ctx.started[3]!.at).toBeCloseTo(LISTEN_CUSHION_MS / 1000, 9);
    expect(contexts).toHaveLength(1);
  });

  it('a context the browser refuses to create is no audio, not a crash', () => {
    const e = new ListenPlaybackEngine(() => {
      throw new DOMException('too many contexts', 'NotSupportedError');
    });
    expect(e.ensure()).toBeNull();
    expect(() => e.push('agent', tone(1)[0]!)).not.toThrow();
    expect(e.level('agent')).toBe(0);
  });

  it('blocked, without a crash, where there is no Web Audio at all', () => {
    const e = new ListenPlaybackEngine(() => null);
    e.push('agent', tone(1)[0]!);
    expect(e.blocked).toBe(true);
    expect(e.level('agent')).toBe(0);
  });

  it('reset stops what is queued and starts the next frame on a fresh cushion', () => {
    const e = engine();
    tone(3).forEach((f) => e.push('customer', f));
    e.reset();
    const ctx = contexts[0]!;
    expect(ctx.stopped).toBe(3);
    e.push('customer', tone(1)[0]!);
    expect(ctx.started[3]!.at).toBeCloseTo(LISTEN_CUSHION_MS / 1000, 9);
  });

  it('close releases the context; the engine can start again', () => {
    const e = engine();
    e.push('agent', tone(1)[0]!);
    e.close();
    expect(contexts[0]!.closed).toBe(true);
    e.push('agent', tone(1)[0]!);
    expect(contexts).toHaveLength(2);
  });
});

describe('receive only', () => {
  it('never asks for the microphone', () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
    const e = engine();
    e.ensure();
    tone(5).forEach((f) => {
      e.push('agent', f);
      e.push('customer', f);
    });
    e.setMuted('agent', true);
    e.reset();
    e.close();
    expect(getUserMedia).not.toHaveBeenCalled();
  });
});

describe('receive only, in the source', () => {
  it('no listening module mentions the microphone APIs', () => {
    const src = dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
    const dirs = ['utils/listen', 'hooks/listen', 'components/listen'];
    const files = dirs.flatMap((d) => readdirSync(join(src, d)).filter((f) => /\.tsx?$/.test(f)).map((f) => join(src, d, f)));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(/getUserMedia|mediaDevices|AudioWorklet|MediaStream/);
    }
  });
});
