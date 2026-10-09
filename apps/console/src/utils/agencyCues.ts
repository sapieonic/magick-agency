/**
 * The connect cue — §A.4.3.1, `AD-P2-U-02`.
 *
 * §A.4.3 called for four redundant channels for the agent noticing that audio
 * connected. Phase 1 shipped **zero** of the non-visual one. QA's framing is the
 * one this module is written to: that was *an untested surface, not a passed one* —
 * and the requirement is a **timing** requirement. A cue that fires 400ms late, or
 * on the wrong frame, satisfies a checklist and fails the agent.
 *
 * ── Why the decisions live here and not in the hook ──────────────────────────
 * Everything that can be got wrong about a cue is a *decision*: which frame fires
 * it, whether this attempt already fired one, whether the agent muted it, whether
 * the visual escalation applies instead. None of that needs a browser, and all of
 * it needs testing. So the decisions are here, synchronous and injectable, and the
 * hook's only job is to call `onBridged` from inside the frame handler.
 *
 * ── The one thing this file cannot enforce, so it is stated loudly ───────────
 * **`dispatch` must be called from the frame handler, in the same task — never
 * from a `useEffect` watching `bridgedAt`.** An effect is deferred and batched;
 * under load it lands tens to hundreds of milliseconds late, and the lateness is
 * invisible in development, on an unloaded machine, with one call in flight. That
 * is why §A.4.3.1 states the budget as a **measurement** rather than an
 * instruction: the lag is written to the diagnostics buffer on every connect, so
 * a regression shows up as data instead of as an argument.
 */

/** The three cues. Distinguished by rhythm and contour, never by pitch alone. */
export type CueName = 'get_ready' | 'connect' | 'disconnect';

/**
 * One tone of a cue. Sine, one oscillator, created fresh and stopped at the end
 * of its envelope.
 */
export interface CueTone {
  hz: number;
  /** Seconds the tone holds at peak, before its release ramp. */
  holdS: number;
  /** Seconds of silence after this tone, before the next. */
  gapS: number;
}

export interface CueSpec {
  tones: CueTone[];
  /** Peak as a fraction of full scale. 0.14 FS ≈ −17 dBFS. */
  peak: number;
}

/** 8ms linear attack, 25ms linear release, per tone (§A.4.3.1). */
export const CUE_ATTACK_S = 0.008;
export const CUE_RELEASE_S = 0.025;
/** A 5ms lead so the envelope starts on a scheduling boundary, not mid-buffer. */
export const CUE_LEAD_S = 0.005;

/**
 * The cue table, normative in §A.4.3.1.
 *
 * **Get-ready is a rhythm** (three even knocks at one pitch, no melodic
 * movement); **connect rises**; **disconnect falls**. This supersedes §A.4.2's
 * rising three-tone get-ready: a rising 3-tone and a rising 2-tone are the two
 * cues that most need telling apart — one means *read now*, the other means *a
 * human can hear you* — and making them the same gesture at two lengths is the
 * exact confusion the redundancy exists to remove.
 */
export const CUE_SPECS: Record<CueName, CueSpec> = {
  get_ready: {
    tones: [
      { hz: 523, holdS: 0.055, gapS: 0.06 },
      { hz: 523, holdS: 0.055, gapS: 0.06 },
      { hz: 523, holdS: 0.055, gapS: 0 },
    ],
    peak: 0.1,
  },
  connect: {
    tones: [
      { hz: 660, holdS: 0.06, gapS: 0.01 },
      { hz: 990, holdS: 0.06, gapS: 0 },
    ],
    peak: 0.14,
  },
  disconnect: {
    tones: [
      { hz: 660, holdS: 0.065, gapS: 0 },
      { hz: 440, holdS: 0.065, gapS: 0 },
    ],
    peak: 0.11,
  },
};

/**
 * How a cue is **seen** — the visual counterpart of `CUE_SPECS` (`AD-P2-U-07`).
 *
 * ── Why this table exists at all ─────────────────────────────────────────────
 * `AD-P2-U-02` shipped the audio half and **one** visual: a single generic flash,
 * fired on connect only. That satisfies "a visual exists" and fails the actual
 * requirement, which is that an agent who cannot hear the cues can tell *which*
 * event happened. A get-ready and a connect that look identical are worse than one
 * of them being absent: the agent opens their greeting into a phone that is still
 * ringing.
 *
 * ── The principle is carried over from the audio, not re-invented ────────────
 * §A.4.3.1 gave the three cues distinct **rhythm and contour** rather than
 * distinct pitch, because pitch alone is the axis a listener in a noisy room
 * loses first. The visual channel has exactly the same trap one axis over:
 * **colour alone is the axis a colour-blind agent loses first**, and this is an
 * accessibility ticket. So nothing here is a colour, and nothing here *may* be a
 * colour. The three cues separate on **count, direction and duration** — three
 * structural axes, and every pair differs on all three, so no single axis being
 * unavailable to a given agent collapses two cues into one.
 *
 *  - **get-ready — three still knocks.** The rhythm of the audio's three even
 *    pips, and the only cue with no direction at all.
 *  - **connect — one long rising sweep that holds.** The audio's rising pair,
 *    and the longest thing on the rail: this is the event the whole subsystem
 *    exists for, so it is deliberately unlike anything else the screen does.
 *    Connect *additionally* carries the full-shell border treatment
 *    (`AgentConsolePage.module.css`) that the other two do not — scope is a
 *    fourth axis, spent on the one cue that means a stranger is now talking.
 *  - **disconnect — two short falling flicks.** The audio's falling pair,
 *    inverted against connect and over quickly, because the news is that nothing
 *    is happening any more.
 *
 * ── The rendering is a function of these three numbers, by construction ──────
 * `StateRail.module.css` drives the pulse count and the duration from custom
 * properties (`--cue-pulses`, `--cue-duration`) and selects the keyframe from
 * `[data-cue-travel]` — it never keys off the cue *name*. So two cues with the
 * same triple would render identically and two with different triples cannot,
 * which is what makes the DOM assertion in
 * `__tests__/pages/AgentConsolePage.cueVisual.test.tsx` an assertion about what
 * the agent sees rather than about an attribute nobody reads.
 */
export interface VisualCueSpec {
  /** Discrete flashes. Mirrors the audio's rhythm. */
  pulses: number;
  /** Where the band travels across the rail. Mirrors the audio's contour. */
  travel: 'still' | 'up' | 'down';
  /** Total ms on screen, and the window the hook holds the attribute for. */
  durationMs: number;
}

export const VISUAL_CUE_SPECS: Record<CueName, VisualCueSpec> = {
  get_ready: { pulses: 3, travel: 'still', durationMs: 540 },
  connect: { pulses: 1, travel: 'up', durationMs: 900 },
  disconnect: { pulses: 2, travel: 'down', durationMs: 620 },
};

/**
 * The three structural axes as one comparable value, **colour excluded because
 * there is no colour in it to exclude.**
 *
 * Exists so "the three are told apart by sight" is a pairwise inequality a test
 * can assert, rather than a claim about a screenshot. Collapsing the table above
 * to one treatment makes all three signatures equal, which is the mutation that
 * has to fail.
 */
export function visualCueSignature(cue: CueName): string {
  const spec = VISUAL_CUE_SPECS[cue];
  return `${spec.pulses}x-${spec.travel}-${spec.durationMs}ms`;
}

/**
 * Where a cue actually gets played. Injectable so the rules above are unit
 * tests rather than audio captures (§A.4.3.1 "What QA can assert").
 */
export interface CueSink {
  /** Schedule the cue now. Called synchronously, from the frame handler. */
  play: (cue: CueName, peakScale: number) => void;
  /**
   * Whether sound can be produced **right now** — the `AudioContext` is running.
   * A suspended context does not mean "you will miss the cue", it means "you will
   * not hear customers at all", which is why the pre-flight owns that copy.
   */
  audible: () => boolean;
}

/**
 * What the console must do when the cue cannot carry the information.
 *
 * **`cue` is not decoration.** It used to be absent, because the escalation fired
 * on connect and nothing else — so the console had exactly one thing it could
 * draw, and an agent who could not hear had no way to tell a ring from a connect
 * from a hang-up. The consumer looks the cue up in `VISUAL_CUE_SPECS`; it must not
 * invent a treatment of its own.
 */
export interface EscalatedVisual {
  attemptId: string;
  cue: CueName;
}

export interface CueDispatcherOptions {
  sink: CueSink;
  /** 0–100. **0 is a permitted setting**, not an error (§A.4.3.1). */
  volume: () => number;
  /** Whether the visual escalation applies — see `escalatedVisualActive`. */
  escalated: () => boolean;
  /** `performance.now()`, injected so the lag assertion is deterministic. */
  now: () => number;
  /** Writes to the diagnostics ring buffer (§A.3.1). */
  log: (event: string, detail: string) => void;
  /**
   * The visual channel for an agent who cannot hear the cue. **Haptics belong
   * inside this callback's implementation and nowhere else** — see the note on
   * `fireEscalatedVisual`.
   */
  onEscalatedVisual?: (signal: EscalatedVisual) => void;
}

/**
 * Bounded so an eight-hour shift cannot grow the dedupe sets without limit.
 * ~200 calls a day means this is never reached in practice; it exists because an
 * unbounded set in a long-lived tab is how a memory leak ships.
 */
const DEDUPE_LIMIT = 500;

function remember(set: Set<string>, key: string): void {
  set.add(key);
  if (set.size > DEDUPE_LIMIT) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
}

/**
 * Owns which cue fires, once, for which attempt.
 *
 * Deliberately a class with mutable sets rather than React state: the decision
 * has to be made **synchronously inside the frame handler**, and state read
 * through a closure would be the value from the render that built the handler.
 */
export class CueDispatcher {
  private readonly opts: CueDispatcherOptions;
  private readonly readied = new Set<string>();
  private readonly connected = new Set<string>();
  private readonly disconnected = new Set<string>();

  constructor(options: CueDispatcherOptions) {
    this.opts = options;
  }

  /** `reserved` — three even pips. The agent has ~4s to read the panel. */
  onReserved(attemptId: string): void {
    if (this.readied.has(attemptId)) return;
    remember(this.readied, attemptId);
    this.fire('get_ready', attemptId, null);
  }

  /**
   * `bridged`, **and nothing else**.
   *
   * @param frameReceivedAt `performance.now()` captured when the frame arrived,
   *   so the logged lag measures the console's own handling rather than being
   *   read back off the clock it is supposed to be checking.
   */
  onBridged(attemptId: string, frameReceivedAt: number): void {
    /**
     * **One cue per attempt, ever.** A socket reconnect can re-deliver state, and
     * a "customer connected" cue four minutes into a call is worse than silence:
     * it tells the agent something happened when nothing did.
     */
    if (this.connected.has(attemptId)) return;
    remember(this.connected, attemptId);
    this.fire('connect', attemptId, frameReceivedAt);
  }

  /** `released` — falling pair, **only if this attempt actually bridged**. */
  onReleased(attemptId: string): void {
    if (!this.connected.has(attemptId)) return;
    if (this.disconnected.has(attemptId)) return;
    remember(this.disconnected, attemptId);
    this.fire('disconnect', attemptId, null);
  }

  /**
   * A rehydrated socket is **not** a connect event, so this exists to record that
   * the console saw the attempt without ever firing anything for it.
   *
   * Marking it connected is what makes the invariant hold: `bridged` is emitted
   * once ever (§A.13.1.1), so if a later duplicate did arrive it must still fire
   * nothing — and a `released` for this attempt must still be able to fall.
   */
  onRehydrated(attemptId: string, bridged: boolean): void {
    if (bridged) remember(this.connected, attemptId);
    remember(this.readied, attemptId);
  }

  private fire(cue: CueName, attemptId: string, frameReceivedAt: number | null): void {
    const volume = this.opts.volume();
    const escalated = this.opts.escalated();

    /**
     * The visual channel fires **before** the audio, for **all three cues**: for an
     * agent who cannot hear them this is not redundancy, it is the whole channel,
     * and it must carry the same *timing* information.
     *
     * It used to read `cue === 'connect' && escalated`, which is how the console
     * ended up able to say "something happened" and unable to say what. The three
     * frames driving it are unchanged and are the point: `get_ready` rides
     * `reserved`, `connect` rides **`bridged` and nothing else**, `disconnect`
     * rides a `released` that actually bridged. A visual on `status:answered`
     * would tell the agent a human is on the line while they are on dead air —
     * the same defect in the visual channel that §A.4.3.1's assertion 2 pins in
     * the audible one.
     */
    if (escalated) {
      this.opts.onEscalatedVisual?.({ attemptId, cue });
    }

    // 0% is a permitted setting and switches the escalation on permanently. An
    // agent is allowed to work in silence; the console's job is to make that safe
    // rather than to argue with them.
    const playable = volume > 0 && this.opts.sink.audible();
    if (playable) this.opts.sink.play(cue, volume / 100);

    if (cue !== 'connect') return;

    /**
     * The artefact QA asserts against, and the answer to "did the agent get told"
     * when a supervisor asks about one specific call. Logged whether or not the
     * cue was audible — "muted" is itself the answer to that question.
     */
    const lag = frameReceivedAt === null ? 0 : Math.max(0, this.opts.now() - frameReceivedAt);
    this.opts.log(
      'cue:connect',
      `attempt=${attemptId} lag=${Math.round(lag)}ms ${playable ? 'played' : escalated ? 'escalated-visual' : 'silent'}`,
    );
  }
}

export type ConnectFlashSetting = 'auto' | 'always' | 'never';

/**
 * Whether the visual escalation is on.
 *
 * *Auto* is the default and means "on when the cue cannot do the job" — muted, or
 * an `AudioContext` that will not run. *Always* and *Never* are the agent's
 * explicit override, filed under display with **no disclosure of any kind**: an
 * agent who needs *Always* sets it in two clicks without telling their employer
 * anything about themselves.
 */
export function escalatedVisualActive(input: {
  setting: ConnectFlashSetting;
  volume: number;
  audible: boolean;
}): boolean {
  if (input.setting === 'always') return true;
  if (input.setting === 'never') return false;
  return input.volume === 0 || !input.audible;
}

/**
 * **Haptics live here, inside the escalated-visual path, and nowhere else.**
 *
 * Found in the prototype and fixed there: the `navigator.vibrate` call sat
 * *outside* the escalated branch, so a hearing agent with working sound got a buzz
 * on every connect — **~200 times a day**. The mistake is easy to repeat because
 * the vibrate call reads as an independent "extra channel" rather than as part of
 * a specific mitigation, so the branch is expressed as this function's *only*
 * caller-visible purpose.
 *
 * Wrapped, because an un-consented `vibrate` throws or warns on every single call,
 * and a console full of benign errors is where a real one goes unnoticed. That is
 * not defensive tidiness — the haptics defect above surfaced *only* because
 * console noise was being treated as a signal.
 */
export function fireEscalatedVisualHaptics(nav: Pick<Navigator, 'vibrate'> | undefined): boolean {
  if (!nav || typeof nav.vibrate !== 'function') return false;
  try {
    nav.vibrate([40, 30, 60]);
    return true;
  } catch {
    // Absent on desktop Chrome and blocked without engagement elsewhere. A bonus
    // channel, never the mitigation, so failure is not worth a word to anyone.
    return false;
  }
}
