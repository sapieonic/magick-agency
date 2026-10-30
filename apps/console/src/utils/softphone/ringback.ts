/**
 * The ringback tone: what the agent hears while the customer's phone rings.
 *
 * VoiceLink sends no early media on the agent's leg, so a soft phone that waited
 * for the carrier would ring in silence — and silence after pressing Call reads as
 * "nothing happened", which is how an agent ends up pressing it twice. The tone
 * is made here, in the browser (`docs/softphone.md` §4.1 step 5), from the
 * `manual_call` frame's `ringing` state, and it stops on `answered`, `bridged`,
 * `ended`, or the agent's own Mute.
 *
 * ── The cadence ──────────────────────────────────────────────────────────────
 * 400 + 450 Hz, ring-ring: 0.4 s on, 0.2 s off, 0.4 s on, 2 s off — the ringback
 * an agent in India (and the UK) has heard all their life. A North American
 * single long ring would sound like a different, foreign phone.
 *
 * The context is created on the Call click ({@link RingbackTone.unlock}), because
 * every browser refuses to make sound from an `AudioContext` that was not created
 * inside a user gesture; by the time `ringing` arrives the gesture is long gone.
 */

export interface RingbackAudioContext {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly destination: AudioNode;
  createOscillator: () => OscillatorNode;
  createGain: () => GainNode;
  resume: () => Promise<void>;
  /** Optional so a stand-in without one still fits; every browser context has it. */
  close?: () => Promise<void>;
}

export const RINGBACK_FREQUENCIES_HZ = [400, 450] as const;
/** On, off, on, off — seconds. */
export const RINGBACK_CADENCE_S = [0.4, 0.2, 0.4, 2.0] as const;
export const RINGBACK_CYCLE_MS = RINGBACK_CADENCE_S.reduce((a, b) => a + b, 0) * 1000;
/** Peak gain at volume 100. Kept well below the cues so a ring is never startling. */
export const RINGBACK_PEAK = 0.12;
const EDGE_S = 0.012;

export interface RingbackTimers {
  setInterval: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
  clearInterval: (id: ReturnType<typeof setInterval>) => void;
}

function defaultContextFactory(): RingbackAudioContext | null {
  const Ctor =
    typeof window !== 'undefined'
      ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext)
      : undefined;
  if (!Ctor) return null;
  try {
    return new Ctor();
  } catch {
    return null;
  }
}

export class RingbackTone {
  private ctx: RingbackAudioContext | null = null;
  private oscillators: OscillatorNode[] = [];
  private envelope: GainNode | null = null;
  private master: GainNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private volume = 0.7;
  private muted = false;

  constructor(
    private readonly createContext: () => RingbackAudioContext | null = defaultContextFactory,
    private readonly timers: RingbackTimers = {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (id) => clearInterval(id),
    },
  ) {}

  /** On a user gesture (the Call click): create or resume the context so it may make sound later. */
  unlock(): void {
    if (!this.ctx) this.ctx = this.createContext();
    if (this.ctx && this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  get playing(): boolean {
    return this.timer !== null;
  }

  /** 0–100, the agent's cue volume. */
  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(100, volume)) / 100;
  }

  /** Mute silences the ring immediately and keeps the cadence, so unmuting rejoins it mid-ring. */
  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) this.master.gain.setValueAtTime(muted ? 0 : 1, this.ctx.currentTime);
  }

  start(): void {
    if (this.timer !== null) return;
    if (!this.ctx) this.ctx = this.createContext();
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});

    const master = ctx.createGain();
    master.gain.setValueAtTime(this.muted ? 0 : 1, ctx.currentTime);
    master.connect(ctx.destination);
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0, ctx.currentTime);
    envelope.connect(master);
    this.oscillators = RINGBACK_FREQUENCIES_HZ.map((hz) => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(hz, ctx.currentTime);
      osc.connect(envelope);
      osc.start();
      return osc;
    });
    this.envelope = envelope;
    this.master = master;

    this.scheduleCycle();
    this.timer = this.timers.setInterval(() => this.scheduleCycle(), RINGBACK_CYCLE_MS);
  }

  stop(): void {
    if (this.timer !== null) this.timers.clearInterval(this.timer);
    this.timer = null;
    for (const osc of this.oscillators) {
      try {
        osc.stop();
      } catch {
        // Already stopped.
      }
      osc.disconnect();
    }
    this.oscillators = [];
    this.envelope?.disconnect();
    this.master?.disconnect();
    this.envelope = null;
    this.master = null;
  }

  /**
   * Stop and release the context: the soft phone unmounting (leaving the page, the
   * station returning to its campaign). Browsers cap live `AudioContext`s, so one
   * left open per visit is a leak. A later `unlock` or `start` makes a new one —
   * which is what a StrictMode remount needs.
   */
  close(): void {
    this.stop();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx?.close) void ctx.close().catch(() => {});
  }

  /** One ring-ring, scheduled on the audio clock so a busy main thread cannot stretch it. */
  private scheduleCycle(): void {
    const ctx = this.ctx;
    const gain = this.envelope?.gain;
    if (!ctx || !gain) return;
    const peak = RINGBACK_PEAK * this.volume;
    let t = ctx.currentTime + 0.02;
    const [on1, off1, on2] = RINGBACK_CADENCE_S;
    for (const [on, off] of [
      [on1, off1],
      [on2, 0],
    ] as const) {
      gain.setValueAtTime(0, t);
      gain.linearRampToValueAtTime(peak, t + EDGE_S);
      gain.setValueAtTime(peak, t + on - EDGE_S);
      gain.linearRampToValueAtTime(0, t + on);
      t += on + off;
    }
  }
}
