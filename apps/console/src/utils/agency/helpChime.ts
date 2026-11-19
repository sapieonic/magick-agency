import type { CueSpec } from '../agencyCues';
import {
  createUnlockedAudioContext,
  playCueTones,
  unlockAudioContext,
  type CueAudioContext,
} from '../agencyWebAudioCueSink';

/**
 * Need help's chime on Live floor (LF4, LF31): two short rising notes from an oscillator, no audio
 * file, scheduled as the station's cues are (`agencyWebAudioCueSink`). Its own `AudioContext`, made
 * and unlocked the first time it is needed (never the station's, which is the agent's, on another
 * page).
 *
 * **Fails silently, always.** A browser refuses sound from a context that no user gesture unlocked
 * (a page loaded and never clicked), and some have no `AudioContext` at all; the red row and card
 * carry the request either way, so a refusal is no error: nothing here throws or logs. A context left
 * `suspended` is asked to resume and plays only if it does, once however many requests came in
 * while it waited (`pendingPlay`). {@link unlockHelpChime} is called from
 * the sound toggle, a gesture, so turning the sound on also makes it able to play (with the
 * station's unlock, whose silent buffer is what Safari needs).
 */

/**
 * The subset of `AudioContext` the chime uses (the cue sink's, plus what the unlock's silent buffer
 * needs), so a test can hand it a double.
 */
export type ChimeAudioContext = CueAudioContext & Parameters<typeof unlockAudioContext>[0];

/** Two short rising notes, in the station cues' envelope (`playCueTones`). */
const HELP_CHIME: CueSpec = {
  tones: [
    { hz: 880, holdS: 0.127, gapS: 0.02 },
    { hz: 1175, holdS: 0.127, gapS: 0 },
  ],
  peak: 0.18,
};

let context: ChimeAudioContext | null = null;
/**
 * A play is waiting on the context's `resume()`. At most one: a suspended context resumes only on
 * a gesture, possibly minutes later, and every play queued behind it would then sound at once, one
 * loud clipped burst. Requests that came in meanwhile are on screen; one chime says so.
 */
let pendingPlay = false;
let makeContext: () => ChimeAudioContext | null = createUnlockedAudioContext;

/** Tests only: the context factory, and forgetting the context made so far. */
export function setHelpChimeContextFactoryForTests(factory: () => ChimeAudioContext | null): void {
  makeContext = factory;
  context = null;
  pendingPlay = false;
}

function contextOrNull(): ChimeAudioContext | null {
  try {
    context ??= makeContext();
  } catch {
    context = null;
  }
  return context;
}

/** Plays the chime if the browser lets this page make sound now; otherwise nothing, silently. */
export function playHelpChime(): void {
  try {
    const ctx = contextOrNull();
    if (!ctx) return;
    if (ctx.state === 'running') {
      playCueTones(ctx, HELP_CHIME, 1);
      return;
    }
    if (pendingPlay) return;
    pendingPlay = true;
    ctx.resume().then(() => {
      pendingPlay = false;
      if (ctx.state === 'running') playCueTones(ctx, HELP_CHIME, 1);
    }).catch(() => {
      // Blocked until a gesture: the row and the card carry the request.
      pendingPlay = false;
    });
  } catch {
    // No audio here: the row and the card carry the request.
    pendingPlay = false;
  }
}

/** From a user gesture (the sound toggle): makes the context and lets it play from now on. */
export function unlockHelpChime(): void {
  try {
    const ctx = contextOrNull();
    if (ctx && ctx.state !== 'running') unlockAudioContext(ctx);
  } catch {
    // Nothing to unlock: the chime stays silent.
  }
}
