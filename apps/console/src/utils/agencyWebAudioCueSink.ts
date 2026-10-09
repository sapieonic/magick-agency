import {
  CUE_ATTACK_S,
  CUE_LEAD_S,
  CUE_RELEASE_S,
  CUE_SPECS,
  type CueName,
  type CueSink,
} from './agencyCues';

/**
 * The WebAudio `CueSink`
 *
 * **Synthesised, never fetched.** An audio asset is a network request that can
 * lose the race against `bridged`, needs a cache policy, and is one CSP change
 * away from silence. Two oscillators and a gain node cannot fail to load.
 *
 * The `AudioContext` is **not created here**. It is created and `resume()`d inside
 * the click handler of the pre-flight's "Test the connect sound" button, because
 * every browser requires a user gesture before an `AudioContext` will produce
 * sound and that button is the shift's one reliable gesture at a moment the agent
 * is not on a call. This sink is handed the context that gesture unlocked.
 */

/** The subset of `AudioContext` this sink uses, so a test can supply a double. */
export interface CueAudioContext {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly destination: AudioNode;
  createOscillator: () => OscillatorNode;
  createGain: () => GainNode;
  resume: () => Promise<void>;
}

export class WebAudioCueSink implements CueSink {
  private readonly ctx: CueAudioContext;

  constructor(ctx: CueAudioContext) {
    this.ctx = ctx;
  }

  audible(): boolean {
    return this.ctx.state === 'running';
  }

  play(cue: CueName, peakScale: number): void {
    const spec = CUE_SPECS[cue];
    // Guarded here as well as in the dispatcher: this class is the thing that
    // touches the hardware, and a sink that emits into a suspended context is a
    // silent failure with a cost.
    if (!this.audible()) return;

    let at = this.ctx.currentTime + CUE_LEAD_S;

    for (const tone of spec.tones) {
      /**
       * **One oscillator per tone, created fresh and stopped at the end of its
       * envelope.** Never a running oscillator gated by a gain node: in an
       * eight-hour tab that is a battery cost, and a stuck tone the moment the
       * gain ever ends up non-zero.
       */
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = tone.hz;

      const peak = spec.peak * peakScale;
      const attackEnd = at + CUE_ATTACK_S;
      const holdEnd = attackEnd + tone.holdS;
      const releaseEnd = holdEnd + CUE_RELEASE_S;

      /**
       * Both ramps are linear. **`exponentialRampToValueAtTime` cannot reach
       * zero** — it leaves a residual tail that clicks on the next cue, and it is
       * the standard bug in this exact code. A hard gate with no envelope is
       * equally wrong: a square-edged sine is a broadband click, and 200 clicks a
       * day is a fatigue source.
       */
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(peak, attackEnd);
      gain.gain.setValueAtTime(peak, holdEnd);
      gain.gain.linearRampToValueAtTime(0, releaseEnd);

      // `ctx.destination` ONLY. The outbound leg is microphone → media frames on
      // the socket, and the two never meet: there is no route by which the cue can
      // reach the customer except acoustic bleed from open speakers, which is why
      // the pre-flight asks for a headset rather than pretending to check.
      osc.connect(gain);
      gain.connect(this.ctx.destination);
      osc.start(at);
      osc.stop(releaseEnd);

      at = releaseEnd + tone.gapS;
    }
  }
}

/**
 * Create the context inside a user gesture and unlock it.
 *
 * The silent one-sample buffer is what actually forces the unlock on Safari:
 * `resume()` alone can leave the context `running` in name while the first real
 * sound is still swallowed. Returns null when the browser has no `AudioContext`
 * at all, which is a supported outcome — the console falls to escalated-visual.
 */
export function createUnlockedAudioContext(): AudioContext | null {
  const Ctor =
    typeof window === 'undefined'
      ? undefined
      : (window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  if (!Ctor) return null;

  const ctx = new Ctor();
  unlockAudioContext(ctx);
  return ctx;
}

/**
 * Re-attempt the unlock on a context that already exists.
 *
 * Extracted from `createUnlockedAudioContext` so a **retry does exactly what the
 * first attempt did**, rather than the cheaper `resume()`-only version that looks
 * equivalent and is not: the silent buffer is what actually forces the unlock on
 * Safari, so a resume-only retry can leave the context `running` in name with the
 * first real cue still swallowed — the same trap the original comment names.
 *
 * Exists because the first attempt genuinely can fail. `createUnlockedAudioContext`
 * runs inside a user gesture, but a gesture is necessary and not sufficient: a
 * backgrounded tab, an OS audio device change, or a browser that has not yet
 * counted the click all yield a context stuck `suspended`. Without a retry that
 * context was kept for the whole shift and `audible()` stayed false forever — the
 * cue subsystem silently degraded to the visual flash with no way back, because
 * `AudioContext.resume()` on the *capture* path (`useAudioCapture`) restores the
 * microphone and playback and never touches this one.
 */
export function unlockAudioContext(ctx: Pick<AudioContext, 'resume' | 'createBuffer' | 'createBufferSource' | 'destination' | 'sampleRate'>): void {
  void ctx.resume();
  try {
    const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // A browser that refuses the warm-up still gets the `resume()` above; there is
    // nothing further to try, and the pre-flight reports on `ctx.state`.
  }
}
