import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CueDispatcher,
  VISUAL_CUE_SPECS,
  escalatedVisualActive,
  fireEscalatedVisualHaptics,
  type CueName,
  type CueSink,
} from '../utils/agencyCues';
import {
  normalizeCuePrefs,
  readCuePrefs,
  writeCuePrefs,
  type CuePrefs,
} from '../utils/agencyCuePrefs';
import {
  WebAudioCueSink,
  createUnlockedAudioContext,
  unlockAudioContext,
} from '../utils/agencyWebAudioCueSink';
import type { DiagnosticEntry } from './useAgencyStation';

/**
 * The connect cue, wired to a real speaker (`MAG-39`).
 *
 * `CueDispatcher` and `WebAudioCueSink` were built, unit-tested and left with
 * **no production caller** — `useAgencyConsole` never passed `cues`, so an agent
 * on a power dialer got no audible signal that a call had connected, which is the
 * entire point of the subsystem. This hook is the missing half: it owns the
 * `AudioContext`, the dispatcher's lifetime, and the escalated-visual channel.
 *
 * ── Three things this has to get right, all of them easy to get wrong ────────
 *
 * **1. A stable identity, or the shift reconnects on every render.** The
 * dispatcher is handed to `useAgencyStation`, whose `handleFrame` depends on it,
 * whose `connect` depends on `handleFrame`, whose connect effect depends on
 * `connect`. A dispatcher rebuilt per render would tear down and re-open the
 * station socket every time the console repainted — and it would reset the dedupe
 * sets at the same time, which is the other half of the same defect. It therefore
 * lives in a ref, built lazily exactly once, exactly like the audio sink.
 *
 * **2. Its own `AudioContext`, never the playback one.** `useAudioPlayback` runs a
 * 16 kHz context with a jitter-cushioned schedule carrying the customer's voice.
 * Scheduling oscillators onto that timeline puts the cue and the customer through
 * one graph — the cue competes with the buffer it is announcing, and a mistimed
 * `currentTime` read there is a gap in the conversation rather than a flat note.
 * They are separate contexts and only meet at the speaker.
 *
 * **3. It must not fire on a reconnect.** A "customer connected" chime four
 * minutes into a live call tells the agent something happened when nothing did.
 * The dispatcher dedupes per `attempt_id` and `useAgencyStation`'s `ready` handler
 * calls `onRehydrated` rather than `onBridged`, so a resumed attempt is recorded
 * as already-connected and fires nothing — but only because the dispatcher
 * survived the reconnect, which is rule 1 again.
 *
 * ── The unlock, and why it rides on "Go available" ───────────────────────────
 * Every browser refuses to make sound from an `AudioContext` that was not created
 * or resumed inside a user gesture. "Go available" is the shift's one reliable
 * click at a moment the agent is *not* on a call — the same gesture the microphone
 * pre-flight already uses. Creating the context at `bridged` instead would mean
 * discovering the browser's refusal while a customer says hello.
 */

/**
 * The cue the console is currently showing **visually**, and which one it is.
 *
 * `cue` is the whole point (`AD-P2-U-07`). The escalation used to carry an attempt
 * id alone and fire on connect only, so the console had one thing to draw and an
 * agent who could not hear had no way to tell a ring from a connect from a
 * hang-up. The treatment is looked up in `VISUAL_CUE_SPECS`, never invented here.
 */
export interface CueFlash {
  cue: CueName;
  attemptId: string;
}

export interface AgencyCuesState {
  /** Hand this to `useAgencyStation`. Stable for the life of the hook. */
  dispatcher: CueDispatcher;
  /**
   * Create and unlock the `AudioContext`. **Call from a user gesture**, and call
   * it as often as you like.
   *
   * Idempotent in the number of contexts, not in the number of *attempts*: a
   * context the browser refused is re-unlocked in place on every call, because a
   * suspended context kept for the shift means the cue never sounds again and
   * nothing else on this page can rescue it.
   */
  unlock: () => void;
  /**
   * The cue the console must show *visually*, because the audible one could not
   * carry it. Cleared on a timer after that cue's own `durationMs`; `null` most of
   * the time.
   */
  cueFlash: CueFlash | null;
  /**
   * The connect half of `cueFlash`, kept because connect — and only connect —
   * additionally carries the full-shell border treatment. Scope is one of the axes
   * separating the three: the event that means a stranger is now talking is the
   * one that lights the whole console.
   */
  connectFlashAttemptId: string | null;
  /** The agent's own settings. Read by the dispatcher through a ref, not state. */
  prefs: CuePrefs;
  /** Persist and apply. Takes effect on the next cue, with no re-subscribe. */
  setPrefs: (next: CuePrefs) => void;
}

export function useAgencyCues(
  /**
   * Where the cue's lag measurement goes. A **ref to the station's diagnostics
   * array**, pushed into rather than set, for the same reason the console pushes
   * its discarded-disposition entry there: the array is created by a hook that
   * does not exist yet at this point in the render, and re-rendering the console
   * fifty times a shift to show a diagnostic nobody has opened is not worth a
   * second state cell. `null` until the console points it at the station.
   */
  diagnostics: { current: DiagnosticEntry[] | null },
): AgencyCuesState {
  const ctxRef = useRef<ReturnType<typeof createUnlockedAudioContext>>(null);
  const [cueFlash, setCueFlash] = useState<CueFlash | null>(null);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The settings, in state for rendering and in a ref for the dispatcher.
   *
   * **The ref is not an optimisation, it is rule 1.** The dispatcher is built once
   * and handed to `useAgencyStation`, whose `handleFrame` → `connect` → connect
   * effect chain would tear down and re-open the station socket if the dispatcher's
   * identity changed — so it cannot be rebuilt when a preference changes. Reading
   * `prefs` from the closure instead would read the value from the render that
   * built the dispatcher, i.e. the defaults, forever: the settings surface would
   * appear to work, persist correctly, and change nothing an agent can hear.
   */
  const [prefs, setPrefsState] = useState<CuePrefs>(() =>
    readCuePrefs(typeof window === 'undefined' ? undefined : window.localStorage),
  );
  const prefsRef = useRef<CuePrefs>(prefs);
  prefsRef.current = prefs;

  const setPrefs = useCallback((next: CuePrefs) => {
    const normalized = normalizeCuePrefs(next);
    // Written to the ref first, so a cue arriving before React commits already
    // obeys the new setting. A `bridged` frame in that window is not hypothetical:
    // an agent turns the flash on *because* they are missing connects.
    prefsRef.current = normalized;
    setPrefsState(normalized);
    writeCuePrefs(typeof window === 'undefined' ? undefined : window.localStorage, normalized);
  }, []);

  /**
   * The sink reads `ctxRef` at play time rather than closing over a context.
   *
   * That is what lets the dispatcher exist from the first render while the context
   * it plays into is not created until the agent's first click — without it, the
   * dispatcher would have to be rebuilt at unlock, which is rule 1's forbidden
   * move. Before the unlock `audible()` is false, so the dispatcher takes the
   * escalation path instead of playing into nothing.
   */
  const sink = useRef<CueSink>({
    play: (cue: CueName, peakScale: number) => {
      const ctx = ctxRef.current;
      if (ctx) new WebAudioCueSink(ctx).play(cue, peakScale);
    },
    audible: () => ctxRef.current?.state === 'running',
  }).current;

  const dispatcherRef = useRef<CueDispatcher | null>(null);
  if (dispatcherRef.current === null) {
    dispatcherRef.current = new CueDispatcher({
      sink,
      volume: () => prefsRef.current.volume,
      escalated: () =>
        escalatedVisualActive({
          setting: prefsRef.current.connectFlash,
          volume: prefsRef.current.volume,
          audible: sink.audible(),
        }),
      now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
      log: (event, detail) => {
        const buffer = diagnostics.current;
        if (buffer) buffer.push({ at: Date.now(), attemptId: null, event, detail });
      },
      onEscalatedVisual: ({ attemptId, cue }) => {
        setCueFlash({ cue, attemptId });
        if (flashTimer.current !== null) clearTimeout(flashTimer.current);
        // Each cue is held for **its own** duration. A shared window would erase
        // one of the three axes the agent tells them apart by.
        flashTimer.current = setTimeout(
          () => setCueFlash(null),
          VISUAL_CUE_SPECS[cue].durationMs,
        );
        /**
         * **Haptics only here.** In the prototype the `vibrate` call sat outside
         * this branch and buzzed every hearing agent on every connect — ~200 times
         * a day. `fireEscalatedVisualHaptics` exists so that the branch is the
         * function's only caller-visible purpose; calling it anywhere else
         * re-creates the defect.
         *
         * The `cue === 'connect'` guard **narrows** that branch and does not widen
         * it: now that the visual fires for all three cues, an unguarded call here
         * would buzz three times per call instead of once, which is the same defect
         * at a third of the volume. Connect is the one that means a stranger just
         * started speaking; a ring and a hang-up are already on the screen the
         * agent is looking at.
         */
        if (cue === 'connect') {
          fireEscalatedVisualHaptics(typeof navigator === 'undefined' ? undefined : navigator);
        }
      },
    });
  }

  const unlock = useCallback(() => {
    const existing = ctxRef.current;

    /**
     * **Idempotent in the number of contexts, NOT in the number of attempts.**
     *
     * This used to `return` whenever a context existed, and the doc above it
     * claimed idempotence "after the first success" — it was idempotent after the
     * first *attempt*. A context the browser refused (`suspended`: backgrounded
     * tab, an OS device change, a gesture the browser did not count) was then kept
     * for the whole shift with `audible()` false forever, so the cue subsystem
     * degraded permanently to the visual flash. It fails safe, which is exactly
     * why nobody would notice — and nothing else could rescue it, because the
     * `resume()` on the microphone banner's button lives in `useAudioCapture` and
     * touches the capture/playback contexts, never this one.
     *
     * The per-page `AudioContext` cap the old guard was protecting against is real,
     * so the retry **reuses** the context rather than making another. Only a
     * `closed` one is replaced: `resume()` on a closed context rejects and can
     * never recover, and a closed context is not holding a slot.
     */
    if (existing === null || existing.state === 'closed') {
      ctxRef.current = createUnlockedAudioContext();
      return;
    }
    // `running` already ⇒ nothing to do; a redundant warm-up would schedule a
    // silent buffer on every press of a control an agent uses all shift.
    if (existing.state !== 'running') unlockAudioContext(existing);
  }, []);

  /**
   * Close the context on unmount. An `AudioContext` that outlives its page is the
   * leak that keeps a browser tab's audio indicator lit after the agent has left.
   */
  useEffect(
    () => () => {
      if (flashTimer.current !== null) clearTimeout(flashTimer.current);
      const ctx = ctxRef.current;
      ctxRef.current = null;
      void ctx?.close().catch(() => {
        // Already closed, or a context the browser tore down with the page.
      });
    },
    [],
  );

  return {
    dispatcher: dispatcherRef.current,
    unlock,
    cueFlash,
    // Derived, not a second state cell: two cells for one event drift, and the
    // shell treatment must never be lit for a cue that is not connect.
    connectFlashAttemptId: cueFlash?.cue === 'connect' ? cueFlash.attemptId : null,
    prefs,
    setPrefs,
  };
}
