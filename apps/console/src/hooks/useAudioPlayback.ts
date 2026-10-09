import { useRef, useState, useCallback } from 'react';

export interface AudioPlaybackOptions {
  /**
   * Cushion, in milliseconds, inserted **only when the schedule has fallen into
   * the past** — i.e. on the first frame of a stream and after any gap long
   * enough that the previously-scheduled audio has already finished.
   *
   * Zero (the default) reproduces the original behaviour exactly, which is what
   * the AI-call path keeps: that stream is server-paced TTS over a direct socket
   * and re-basing it with latency would only add delay to a turn-taking loop.
   *
   * A live PSTN conversation relayed through the API is the other case. Its
   * frames arrive in 20 ms bursts whose spacing is at the mercy of two
   * WebSocket hops, so a schedule with no cushion re-bases to "now" on every
   * jitter spike and each re-base is an audible click. One cushion of a few
   * frames absorbs the spikes; it is deliberately small, because on a duplex
   * call every millisecond of buffer is a millisecond of people talking over
   * each other.
   */
  jitterMs?: number;
}

interface AudioPlaybackState {
  play: (base64: string) => void;
  flush: () => void;
  cleanup: () => void;
  warmup: () => void;
  /**
   * The context exists but the browser will not run it — no user gesture has
   * happened in this page load, so every scheduled buffer is queued into a
   * suspended timeline and nothing is heard.
   *
   * Reported rather than merely retried because the retry cannot work: only a
   * gesture lifts the autoplay policy. A caller that does not surface this shows
   * a healthy call with no sound coming out of it.
   */
  blocked: boolean;
  /** Resume after a gesture. Safe to call when there is no context yet. */
  resume: () => Promise<void>;
}

export function useAudioPlayback(options: AudioPlaybackOptions = {}): AudioPlaybackState {
  const ctxRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const nextPlayTimeRef = useRef(0);
  const [blocked, setBlocked] = useState(false);
  /**
   * Mirrors `blocked` for the `play()` path, which runs ~50 times a second from
   * a socket handler. Comparing against a ref means the `setBlocked` commit
   * happens on the transition only — calling it every frame would re-render the
   * console fifty times a second, which is the defect the `media` frame handler
   * exists to avoid.
   */
  const blockedRef = useRef(false);

  const noteState = (ctx: AudioContext): void => {
    const next = ctx.state !== 'running';
    if (next === blockedRef.current) return;
    blockedRef.current = next;
    setBlocked(next);
  };
  // Behind a ref for the same reason `useAudioCapture` refs its options: `play`
  // is handed to a socket frame handler and must not change identity.
  const jitterSecRef = useRef(0);
  jitterSecRef.current = (options.jitterMs ?? 0) / 1000;

  /**
   * Build or reuse the context. Returns `null` when the browser has no
   * `AudioContext` at all.
   *
   * **The null case is load-bearing, not defensive dressing.** `warmup()` is
   * this function, and it is called from click handlers — the agency console
   * calls it from "Go available". An unguarded `new AudioContext()` there throws
   * synchronously *inside the handler*, which aborts the rest of it: the agent
   * presses the button, no presence request is sent, and nothing is reported.
   * That is exactly what happened when the warm-up was first added — the
   * console's whole go-available path broke in every environment without Web
   * Audio, and it broke silently.
   */
  const ensureContext = (): { ctx: AudioContext; gain: GainNode } | null => {
    if (!ctxRef.current || ctxRef.current.state === 'closed') {
      const Ctor =
        typeof globalThis === 'undefined'
          ? undefined
          : (globalThis.AudioContext ??
            (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
              .webkitAudioContext);
      if (!Ctor) {
        // No Web Audio: nothing can play, and the caller must be able to say so
        // rather than crash. `blocked` is the honest report — the audio graph is
        // not running — and it is the same banner the suspended case raises.
        if (!blockedRef.current) {
          blockedRef.current = true;
          setBlocked(true);
        }
        return null;
      }
      const ctx = new Ctor({ sampleRate: 16000 });
      const gain = ctx.createGain();
      gain.connect(ctx.destination);
      ctxRef.current = ctx;
      gainRef.current = gain;
      nextPlayTimeRef.current = 0;
    }
    if (ctxRef.current.state === 'suspended') {
      // Kept: from inside a gesture this is all that is needed. From outside one
      // it is a no-op the browser refuses, which `noteState` then records.
      void ctxRef.current.resume();
    }
    noteState(ctxRef.current);
    return { ctx: ctxRef.current, gain: gainRef.current! };
  };

  const play = useCallback((base64: string) => {
    const ready = ensureContext();
    // No Web Audio. Dropping the frame is the only option; `blocked` is already
    // set, so the console is saying why rather than going quietly silent.
    if (ready === null) return;
    const { ctx, gain } = ready;

    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }

    const int16 = new Int16Array(bytes.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i]! / (int16[i]! < 0 ? 0x8000 : 0x7fff);
    }

    const buffer = ctx.createBuffer(1, float32.length, 16000);
    buffer.getChannelData(0).set(float32);

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);

    const now = ctx.currentTime;
    /**
     * Underrun ⇒ re-base with the cushion. Otherwise queue immediately after the
     * frame already scheduled, so continuous audio stays sample-contiguous.
     *
     * **`<=`, not `<`.** A schedule sitting exactly on the playhead has nothing
     * queued ahead of it, which is the underrun this branch exists to absorb —
     * and it is the state a stream starts in, since `nextPlayTime` begins at 0.
     * With `<` the very first frame of every call is scheduled with no cushion
     * at all, and the cushion then only ever appears after a gap: the one moment
     * it is most needed is the one moment it is missing.
     *
     * With `jitterMs: 0` this is `Math.max(now, nextPlayTime)` — identical to the
     * original — so nothing about the AI-call path changes.
     */
    const startTime =
      nextPlayTimeRef.current <= now ? now + jitterSecRef.current : nextPlayTimeRef.current;
    source.start(startTime);
    nextPlayTimeRef.current = startTime + buffer.duration;

    sourcesRef.current.push(source);
    source.onended = () => {
      sourcesRef.current = sourcesRef.current.filter(s => s !== source);
    };
  }, []);

  const flush = useCallback(() => {
    sourcesRef.current.forEach(s => {
      try { s.stop(); } catch { /* already stopped */ }
    });
    sourcesRef.current = [];
    // Back to zero, which the underrun branch above reads as "re-base on the
    // next frame". That is what makes `flush()` the right call after a socket
    // reconnect: the queue is dropped and the cushion is rebuilt from scratch
    // rather than the new stream inheriting the dead one's schedule.
    nextPlayTimeRef.current = 0;
  }, []);

  const cleanup = useCallback(() => {
    flush();
    ctxRef.current?.close();
    ctxRef.current = null;
    gainRef.current = null;
  }, [flush]);

  // Not a hook — plain function to avoid changing hook count
  const warmup = ensureContext;

  const resume = useCallback(async () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    await ctx.resume().catch(() => {
      /* still refused; `noteState` keeps `blocked` true */
    });
    noteState(ctx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return { play, flush, cleanup, warmup, blocked, resume };
}
