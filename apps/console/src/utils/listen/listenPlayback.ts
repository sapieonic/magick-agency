import { AlawDownlinkDecoder } from '../alaw8/g711.js';
import type { AgencyListenLeg } from '../../types/live-calls';

/**
 * The listener's audio graph (`docs/listening.md` §2, "The browser"): ONE `AudioContext`; per leg
 * an `AlawDownlinkDecoder`, a scheduled-buffer queue with about 120 ms of cushion, an analyser
 * (the level meter) and a gain (the mute), both legs into one master gain (the volume). The two
 * legs are mixed here, never on the server.
 *
 * Receive only. Nothing here asks for the microphone, and nothing may: listening is silent, and a
 * permission prompt would be a lie about what the page does (`listenPlayback.test.ts` holds it).
 *
 * The browser's clock only moves while the context runs. While it does not (the autoplay policy,
 * an interruption such as another app taking the audio on iOS), frames are dropped and anything
 * queued is stopped, so nothing piles up against a frozen clock to play all at once later; and
 * only a gesture asks the browser to run it again (`resume`: the Listen click, "Turn sound on").
 *
 * A class with no React in it, so the scheduling is a unit test against a fake context;
 * `useListenPlayback` owns one per listening bar.
 */

/** The context's rate: the decoder interpolates 8 kHz A-law to 16 kHz. */
export const LISTEN_PLAYBACK_RATE = 16_000;

/** The cushion re-based onto on an underrun: about six frames, absorbing two WebSocket hops' jitter. */
export const LISTEN_CUSHION_MS = 120;

/**
 * The queue's ceiling: a leg scheduled further ahead than this (a burst after a stall) drops what
 * it had queued and re-bases, so a supervisor never hears the call seconds late, nor two moments
 * of it at once.
 */
export const LISTEN_MAX_AHEAD_MS = 600;

/** The agent's leg silent this long while live: "Agent is silent". */
export const LISTEN_AGENT_SILENCE_MS = 2_000;

export const LISTEN_LEGS: readonly AgencyListenLeg[] = ['agent', 'customer'];

/** The parts of the Web Audio API the engine uses (a fake in tests). */
export type ListenAudioContextFactory = () => AudioContext | null;

/** The real factory: a 16 kHz context, or null where the browser has no Web Audio. May throw. */
export function defaultAudioContextFactory(): AudioContext | null {
  const Ctor =
    typeof globalThis === 'undefined'
      ? undefined
      : (globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) return null;
  return new Ctor({ sampleRate: LISTEN_PLAYBACK_RATE });
}

interface LegGraph {
  decoder: AlawDownlinkDecoder;
  analyser: AnalyserNode;
  gain: GainNode;
  /** Context time the next buffer starts at. 0: nothing queued (the next frame re-bases). */
  nextTime: number;
  sources: Set<AudioBufferSourceNode>;
  /** Client ms of the leg's last frame; null before its first. */
  lastFrameAt: number | null;
  /** Scratch for the meter. */
  scratch: Float32Array<ArrayBuffer>;
}

export class ListenPlaybackEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private legs: Partial<Record<AgencyListenLeg, LegGraph>> = {};
  private muted: Record<AgencyListenLeg, boolean> = { agent: false, customer: false };
  private volume = 1;
  private unavailable = false;
  /** Client ms of the last `reset()` (an attach): a leg silent since then is silent. */
  private attachedAt: number | null = null;

  constructor(
    private readonly createContext: ListenAudioContextFactory = defaultAudioContextFactory,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Build the graph, or reuse it. Null where the browser has no Web Audio, or will not make a
   * context now (the Listen click then refuses to start). Never asks the browser to run it:
   * that is {@link resume}, from a gesture.
   */
  ensure(): AudioContext | null {
    if (this.unavailable) return null;
    if (!this.ctx || this.ctx.state === 'closed') {
      let ctx: AudioContext | null;
      try {
        ctx = this.createContext();
      } catch {
        // Refused this time (too many contexts, an unsupported rate): no audio, and no crash.
        return null;
      }
      if (!ctx) {
        this.unavailable = true;
        return null;
      }
      const master = ctx.createGain();
      master.gain.value = this.volume;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      this.legs = {};
      // The clock stopped (an interruption, or `release`): what is queued would play in a heap later.
      ctx.onstatechange = () => {
        if (this.ctx === ctx && ctx.state !== 'running') this.flushQueues();
      };
    }
    return this.ctx;
  }

  /** True when the browser will not run the audio: suspended by the autoplay policy, or no Web Audio. */
  get blocked(): boolean {
    if (this.unavailable) return true;
    return this.ctx !== null && this.ctx.state !== 'running' && this.ctx.state !== 'closed';
  }

  /** Ask the browser to run the audio: from a gesture only (the Listen click, "Turn sound on"). */
  async resume(): Promise<void> {
    const ctx = this.ensure();
    if (!ctx) return;
    await ctx.resume().catch(() => {});
  }

  private leg(leg: AgencyListenLeg): LegGraph | null {
    const ctx = this.ensure();
    if (!ctx || !this.master) return null;
    let graph = this.legs[leg];
    if (!graph) {
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const gain = ctx.createGain();
      gain.gain.value = this.muted[leg] ? 0 : 1;
      // The meter reads before the mute, so a muted leg still shows that someone is talking.
      analyser.connect(gain);
      gain.connect(this.master);
      graph = {
        decoder: new AlawDownlinkDecoder(),
        analyser,
        gain,
        nextTime: 0,
        sources: new Set(),
        lastFrameAt: null,
        scratch: new Float32Array(analyser.fftSize),
      };
      this.legs[leg] = graph;
    }
    return graph;
  }

  /** One 20 ms A-law frame of `leg`: decoded and queued behind what that leg already has. */
  push(leg: AgencyListenLeg, frame: Uint8Array): void {
    const graph = this.leg(leg);
    if (!graph || !this.ctx) return;
    graph.lastFrameAt = this.now();
    const ctx = this.ctx;
    // Not running: its clock is frozen, so a queued frame would wait and then play in a heap.
    // Drop it (and anything queued); the leg re-bases once a gesture runs the context again.
    if (ctx.state !== 'running') {
      this.flushLeg(graph, true);
      return;
    }
    const t = ctx.currentTime;
    // Too far ahead (a burst after a stall): drop what is queued rather than play the call late,
    // and never schedule over it, so two moments of the call are never heard at once.
    if (graph.nextTime - t > LISTEN_MAX_AHEAD_MS / 1000) this.flushLeg(graph, false);
    const samples = graph.decoder.decode(frame);
    const buffer = ctx.createBuffer(1, samples.length, LISTEN_PLAYBACK_RATE);
    buffer.getChannelData(0).set(samples);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(graph.analyser);
    // Underrun (nothing queued, the queue played out, or just dropped): re-base onto the cushion.
    const start = graph.nextTime <= t ? t + LISTEN_CUSHION_MS / 1000 : graph.nextTime;
    source.start(start);
    graph.nextTime = start + buffer.duration;
    graph.sources.add(source);
    source.onended = () => {
      graph.sources.delete(source);
    };
  }

  setMuted(leg: AgencyListenLeg, muted: boolean): void {
    this.muted[leg] = muted;
    const graph = this.legs[leg];
    if (graph) graph.gain.gain.value = muted ? 0 : 1;
  }

  isMuted(leg: AgencyListenLeg): boolean {
    return this.muted[leg];
  }

  /** The master volume, 0–1. */
  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume));
    if (this.master) this.master.gain.value = this.volume;
  }

  /** The leg's level now, 0–1 (RMS of the analyser's window, scaled for speech). 0 with no audio. */
  level(leg: AgencyListenLeg): number {
    const graph = this.legs[leg];
    if (!graph) return 0;
    graph.analyser.getFloatTimeDomainData(graph.scratch);
    let sum = 0;
    for (let i = 0; i < graph.scratch.length; i++) sum += graph.scratch[i]! * graph.scratch[i]!;
    const rms = Math.sqrt(sum / graph.scratch.length);
    return Math.min(1, rms * 4);
  }

  /**
   * Ms since the leg's last frame, or since the last attach when it has sent none since; null
   * before any attach.
   */
  silentFor(leg: AgencyListenLeg): number | null {
    const at = this.legs[leg]?.lastFrameAt ?? this.attachedAt;
    return at === null ? null : Math.max(0, this.now() - at);
  }

  /** Stop what `graph` has queued; its next frame re-bases onto the cushion. */
  private flushLeg(graph: LegGraph, resetDecoder: boolean): void {
    for (const source of graph.sources) {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
    }
    graph.sources.clear();
    graph.nextTime = 0;
    // Frames were dropped: the next one does not follow the last decoded, so no filter history.
    if (resetDecoder) graph.decoder.reset();
  }

  private flushQueues(): void {
    for (const graph of Object.values(this.legs)) if (graph) this.flushLeg(graph, true);
  }

  /**
   * Drop every queued buffer and the decoders' history: a new attach starts clean, its first
   * frame re-based onto the cushion and not smeared with the last attach's tail.
   */
  reset(): void {
    this.attachedAt = this.now();
    this.flushQueues();
    for (const graph of Object.values(this.legs)) if (graph) graph.lastFrameAt = null;
  }

  /**
   * The listen is over (stopped, ended, lost): silence at once, nothing left queued, and the
   * context suspended rather than running for the shell's life. The next Listen click resumes it.
   */
  release(): void {
    this.reset();
    this.attachedAt = null;
    const ctx = this.ctx;
    if (ctx && ctx.state === 'running') void ctx.suspend().catch(() => {});
  }

  /** Stop and release the context. The engine can be ensured again afterwards. */
  close(): void {
    this.reset();
    this.attachedAt = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.master = null;
    this.legs = {};
    if (ctx && ctx.state !== 'closed') void ctx.close().catch(() => {});
  }
}
