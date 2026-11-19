/**
 * Need help's chime on Live floor (LF4, LF31): two short rising notes from an oscillator, no audio
 * file. Its own `AudioContext`, made the first time it is needed (never the station's, which is the
 * agent's, on another page).
 *
 * **Fails silently, always.** A browser refuses sound from a context that no user gesture unlocked
 * (a page loaded and never clicked), and some have no `AudioContext` at all; the red row and card
 * carry the request either way, so a refusal is no error: nothing here throws or logs. A context left
 * `suspended` is asked to resume and plays only if it does. {@link unlockHelpChime} is called from
 * the sound toggle, a gesture, so turning the sound on also makes it able to play.
 */

/** The subset of `AudioContext` the chime uses, so a test can hand it a double. */
export interface ChimeAudioContext {
  readonly state: AudioContextState;
  readonly currentTime: number;
  readonly destination: AudioNode;
  createOscillator: () => OscillatorNode;
  createGain: () => GainNode;
  resume: () => Promise<void>;
}

/** The notes: frequency and start, in seconds from the chime's start; each lasts {@link NOTE_S}. */
const NOTES: ReadonlyArray<{ hz: number; at: number }> = [
  { hz: 880, at: 0 },
  { hz: 1175, at: 0.18 },
];
const NOTE_S = 0.16;
const PEAK = 0.18;

let context: ChimeAudioContext | null = null;
let makeContext: () => ChimeAudioContext | null = () => {
  const Ctor = typeof window === 'undefined'
    ? undefined
    : window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? new Ctor() : null;
};

/** Tests only: the context factory, and forgetting the context made so far. */
export function setHelpChimeContextFactoryForTests(factory: () => ChimeAudioContext | null): void {
  makeContext = factory;
  context = null;
}

function contextOrNull(): ChimeAudioContext | null {
  try {
    context ??= makeContext();
  } catch {
    context = null;
  }
  return context;
}

function tones(ctx: ChimeAudioContext): void {
  const start = ctx.currentTime + 0.02;
  for (const note of NOTES) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = note.hz;
    const at = start + note.at;
    // Linear ramps to and from zero: no click at either edge (see `agencyWebAudioCueSink`).
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(PEAK, at + 0.02);
    gain.gain.setValueAtTime(PEAK, at + NOTE_S - 0.04);
    gain.gain.linearRampToValueAtTime(0, at + NOTE_S);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(at);
    osc.stop(at + NOTE_S);
  }
}

/** Plays the chime if the browser lets this page make sound now; otherwise nothing, silently. */
export function playHelpChime(): void {
  try {
    const ctx = contextOrNull();
    if (!ctx) return;
    if (ctx.state === 'running') {
      tones(ctx);
      return;
    }
    ctx.resume().then(() => {
      if (ctx.state === 'running') tones(ctx);
    }).catch(() => {
      // Blocked until a gesture: the row and the card carry the request.
    });
  } catch {
    // No audio here: the row and the card carry the request.
  }
}

/** From a user gesture (the sound toggle): makes the context and lets it play from now on. */
export function unlockHelpChime(): void {
  try {
    const ctx = contextOrNull();
    if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => {});
  } catch {
    // Nothing to unlock: the chime stays silent.
  }
}
