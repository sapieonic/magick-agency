import { useCallback, useEffect, useRef, useState } from 'react';
import { useAudioCapture, classifyCaptureError, type AudioCaptureError } from './useAudioCapture';
import { useAudioPlayback } from './useAudioPlayback';
import type { AgencyStationAudioSink } from './useAgencyStation';
import { trackAgencyMicState } from '../analytics/events';

/**
 * The agent's two-way audio, over the station socket.
 *
 * ── Why this composes the AI-call hooks rather than replacing them ──────────
 * `useAudioCapture` and `useAudioPlayback` already produce and consume exactly
 * the format the API wants on this socket — base64 PCM16 mono 16 kHz, in 20 ms
 * frames — because the AI-call bridge and the agency bridge are the *same*
 * `WebRtcBridgeManager` browser leg. Writing a second encoder would be two
 * implementations of one wire format, and the second one would be the one
 * nobody exercised until a live shift.
 *
 * What genuinely differs is not the audio, it is the **lifetime**. The AI call
 * is one socket, one call, mic open from `start()` to hangup. The agency station
 * is one socket for an eight-hour shift carrying a couple of hundred calls, and
 * across it the microphone must open and close per attempt. So the two hooks
 * were extended where they were short (mute, classified permission errors,
 * device selection, a jitter cushion) and the *sequencing* — the part that is
 * actually agency-shaped — lives here.
 *
 * ── The two gates, and why they are two ─────────────────────────────────────
 * 1. **Arm on `reserved`.** The microphone is acquired the moment an attempt
 *    appears, roughly four seconds before the customer can answer. Acquiring it
 *    at `bridged` instead costs tens of milliseconds of `getUserMedia` at the
 *    exact instant a human says "hello", and clips the first word of every call.
 * 2. **Send on `bridged`, and only then.** Arming produces frames that go
 *    nowhere: `prepare()` builds the graph without attaching a sink. Nothing
 *    reaches the socket until the attempt is genuinely bridged.
 *
 * Between calls the microphone is **released**, not held muted. A station that
 * keeps the recording indicator lit through an agent's lunch break is a
 * different product than the one we said we were shipping.
 *
 * ── Playback is deliberately NOT gated ──────────────────────────────────────
 * Inbound frames play whenever they arrive. The API only relays media while the
 * PSTN leg is live, so the gate already exists on the side that has the
 * authority — and a second gate here would be one that can disagree: `bridged`
 * and the first media frame race each other on a fast carrier, and losing that
 * race clips the customer's opening words with no way to tell.
 */

/**
 * Playback cushion. Three 20 ms frames — enough to absorb an ordinary spike
 * across two WebSocket hops, small enough that it does not turn a duplex
 * conversation into people talking over each other.
 *
 * Applied only on an underrun (see `useAudioPlayback`), so it is paid once at
 * the start of a call and again only after a genuine gap.
 */
export const AGENCY_PLAYBACK_JITTER_MS = 60;

export interface AgencyAudioState {
  /**
   * Hand this to `useAgencyStation`. **Stable for the life of the hook** — see
   * the note on `AgencyStationAudioSink`; a fresh object here re-opens the
   * station socket on every render.
   */
  sink: AgencyStationAudioSink;
  /**
   * Drive the lifecycle from the station's current state. Called from one effect
   * in `useAgencyConsole`, which is where it has to be: the sink must exist
   * *before* the station is created and the gates are read *from* the station,
   * so the two cannot be collapsed into a single hook call without one of them
   * reading a value that does not exist yet.
   */
  sync: (input: {
    /** The attempt the station holds, or `null`. Non-null arms the microphone. */
    attemptId: string | null;
    /** `live.bridgedAt !== null` — and nothing else. Opens the uplink. */
    bridged: boolean;
    /** `station.sendMedia`. Stable, and read at send time. */
    send: (payload: string) => boolean;
  }) => void;
  /**
   * Warm both `AudioContext`s and probe the microphone, to surface a permission
   * or autoplay problem **before** a customer is on the line. Call from a user
   * gesture — the contexts depend on it, not merely benefit from it.
   */
  preflight: () => void;
  /**
   * Resume contexts the browser suspended. **Must be called from a user
   * gesture**, so the console renders it behind a button rather than firing it
   * on a timer: a `resume()` from anywhere else is refused, and a refusal that
   * looks like an attempt is worse than not trying.
   */
  resume: () => void;
  muted: boolean;
  toggleMute: () => void;
  /** True once frames are going up the socket. */
  sending: boolean;
  /** The last microphone failure, sticky until the next success. */
  error: AudioCaptureError | null;
}

/**
 * `campaignId` is analytics-only — nothing in the audio lifecycle branches on
 * it. Optional and defaulted to `''` so every existing caller (there is
 * currently exactly one, `useAgencyConsole`) and test is unaffected.
 */
export function useAgencyAudio(campaignId?: string): AgencyAudioState {
  const [sending, setSending] = useState(false);

  /**
   * Behind a ref, like `captureRef`/`playbackRef` below, and for the same
   * reason: `preflight` and `sync` must keep stable identities for the life of
   * the hook (see their own docs), so `campaignId` cannot sit in either
   * callback's dependency array without risking a re-identity on a value that,
   * in practice, is fixed for the session anyway.
   */
  const campaignIdRef = useRef(campaignId ?? '');
  campaignIdRef.current = campaignId ?? '';

  /**
   * Every failure — a refused prompt, and a device that vanishes mid-call with
   * no promise to reject into — is recorded in the capture hook's own `error`
   * state, which this hook re-exports unchanged. There is deliberately no second
   * copy kept here: two records of one failure are two that can disagree.
   */
  const capture = useAudioCapture();
  const playback = useAudioPlayback({ jitterMs: AGENCY_PLAYBACK_JITTER_MS });

  const captureRef = useRef(capture);
  captureRef.current = capture;
  const playbackRef = useRef(playback);
  playbackRef.current = playback;

  /** The attempt the microphone is currently armed for, or `null`. */
  const armedForRef = useRef<string | null>(null);
  /** Whether the worklet's sink is attached and frames are on the wire. */
  const sendingRef = useRef(false);
  /** Guards `start()` against a second call while the first is still awaiting. */
  const openingRef = useRef(false);

  /**
   * Created once. `useRef(...).current` rather than `useMemo`, because `useMemo`
   * is a cache with no identity guarantee — React may discard and recompute it,
   * and a recomputed sink would re-open the station socket.
   */
  const sink = useRef<AgencyStationAudioSink>({
    onMedia: (payload) => playbackRef.current.play(payload),
  }).current;

  /**
   * Release everything the microphone owns. Idempotent, because it is reached
   * from `sync`, from the unmount effect, and (in development) from
   * `StrictMode`'s double-invoked teardown.
   */
  const disarm = useCallback(() => {
    armedForRef.current = null;
    openingRef.current = false;
    if (sendingRef.current) {
      sendingRef.current = false;
      setSending(false);
    }
    captureRef.current.stop();
    /**
     * **Mute does not survive the call it was applied to.**
     *
     * Both directions are defensible and the tie is broken by which failure is
     * worse. A mute that persists means the next customer gets dead air from a
     * control the agent pressed for the previous one — the exact defect this
     * whole path exists to remove, re-introduced by a UI toggle. A mute that
     * resets means an agent who muted for privacy starts the next call hot,
     * which the console's mute state makes visible before they speak.
     */
    captureRef.current.setMuted(false);
    /**
     * The queue is flushed but the context is kept. Flushing drops whatever was
     * still scheduled — audio from a call that is over must not play over the
     * next one — while keeping the `AudioContext` avoids re-creating one per
     * call, which browsers cap and which needs a user gesture to resume.
     */
    playbackRef.current.flush();
  }, []);

  const sync = useCallback(
    ({
      attemptId,
      bridged,
      send,
    }: {
      attemptId: string | null;
      bridged: boolean;
      send: (payload: string) => boolean;
    }) => {
      if (attemptId === null) {
        if (armedForRef.current !== null) disarm();
        return;
      }

      // A new attempt on top of an old one: tear the previous graph down first
      // rather than leaving the worklet's sink pointed at the finished call.
      if (armedForRef.current !== null && armedForRef.current !== attemptId) disarm();

      if (armedForRef.current === null) {
        armedForRef.current = attemptId;
        // Gate 1 — armed. `prepare()` acquires the microphone and builds the
        // graph but attaches no sink, so nothing can leave yet.
        void captureRef.current.prepare().catch(() => {
          /**
           * Swallowed **here and only here**: `prepare` has already classified
           * the failure into `error`, so the rejection carries nothing this hook
           * does not already have — and the console is already rendering it.
           * Left unhandled it would be an unhandled promise rejection.
           */
        });
      }

      if (!bridged || sendingRef.current || openingRef.current) return;

      // Gate 2 — bridged. Attach the sink; frames now reach the socket.
      openingRef.current = true;
      const attempt = attemptId;
      void captureRef.current
        .start((payload) => {
          /**
           * Re-checked at send time against the attempt this `start` was opened
           * for. The worklet port is asynchronous, so a frame produced before
           * `disarm()` ran can still be delivered after it — and a frame from
           * the previous customer arriving on the next customer's socket is the
           * worst possible version of this bug.
           */
          if (armedForRef.current !== attempt) return;
          send(payload);
        })
        .then(() => {
          openingRef.current = false;
          // The attempt may have been released while `start` was awaiting.
          if (armedForRef.current !== attempt) return;
          sendingRef.current = true;
          setSending(true);
        })
        .catch(() => {
          openingRef.current = false;
          // Classified into `error` by `prepare`; nothing to add.
        });
    },
    [disarm],
  );

  const preflight = useCallback(() => {
    /**
     * **The playback context is created here, inside the gesture.**
     *
     * This is not an optimisation. `useBrowserCall` and `useWebRtcCall` both
     * call `warmup()` from their click handlers and both say why: a context
     * first constructed from a WebSocket `onmessage` — which is what `play()`
     * would do — starts `suspended`, and every buffer scheduled onto it is
     * silent. The agency console has no "Call" button to hang this on, so
     * "Go available" carries it, alongside the microphone probe and the cue
     * unlock. All three are the same bargain with the same click.
     */
    playbackRef.current.warmup();

    /**
     * A **probe**, not an arm: acquire, then release immediately.
     *
     * The point is to move the permission prompt off the moment a customer
     * answers and onto the moment the agent presses "Go available" — a real user
     * gesture, with nobody on the line. Holding the stream afterwards would be
     * the easier implementation and the wrong one: it is the microphone held
     * open between calls that this design refuses.
     *
     * Skipped outright when a call is already up, because `stop()` here would
     * cut the agent off mid-conversation to check something the live call has
     * already proved.
     */
    if (armedForRef.current !== null) return;
    void captureRef.current
      .prepare()
      .then(() => {
        trackAgencyMicState({
          campaign_id: campaignIdRef.current,
          outcome: 'ok',
          stage: 'preflight',
        });
        if (armedForRef.current !== null) return;
        captureRef.current.stop();
      })
      .catch((err) => {
        // Already classified into `error`, which is the entire product of this
        // call — the agent finds out now instead of mid-call. Classified again
        // here, off the same rejection, purely for the analytics enum.
        trackAgencyMicState({
          campaign_id: campaignIdRef.current,
          outcome: classifyCaptureError(err).kind,
          stage: 'preflight',
        });
      });
  }, []);

  const toggleMute = useCallback(() => {
    captureRef.current.setMuted(!captureRef.current.muted);
  }, []);

  const resume = useCallback(() => {
    // Both, because a page load with no gesture suspends both, and an agent who
    // can hear the customer but cannot be heard is no better off than one who
    // can do neither.
    void captureRef.current.resume();
    void playbackRef.current.resume();
  }, []);

  /**
   * Analytics: a mid-call microphone failure — a permission revoked, a headset
   * unplugged, an `AudioContext` the browser suspended under a rehydrated call.
   *
   * This is the "capture library's error callback" this hook actually has:
   * `capture.error` is the one place every such failure lands, from `acquire`'s
   * several `setError` calls, the `ended` device-loss listener, and `resume()` —
   * so watching it here covers all of them without duplicating a track call at
   * each site. Gated on `armedForRef.current !== null` so this never fires for
   * the `preflight()` probe above, which tracks its own outcome directly and
   * runs with nothing armed; the effect only re-runs when `capture.error`
   * itself changes (a fresh object from a fresh `setError`), which is what
   * keeps this to one event per genuinely new failure rather than one per
   * render. A transition to `null` (recovery) is not tracked — `outcome` has no
   * `'ok'` for `stage: 'mid_call'` in the catalog.
   */
  useEffect(() => {
    const err = capture.error;
    if (!err) return;
    if (armedForRef.current === null) return;
    trackAgencyMicState({
      campaign_id: campaignIdRef.current,
      outcome: err.kind,
      stage: 'mid_call',
    });
  }, [capture.error]);

  /**
   * Teardown on unmount — leaving the console, navigating away, logging out.
   *
   * **Routed through `disarm()` rather than calling `capture.stop()` directly.**
   * The direct version released the device but left `armedForRef` holding an
   * attempt id and `sendingRef` still `true`; a hook that mounts, unmounts and
   * mounts again — which is precisely what `StrictMode` does — would then come
   * back believing it was already armed and already sending, skip both gates,
   * and never re-acquire the microphone or re-attach the worklet's sink. The
   * console would report `sending: true` over a dead uplink. It is unreachable
   * today only because the double-invoke happens before any frame sets `live`,
   * which is an ordering, not a guarantee.
   *
   * `cleanup()` and not `disarm()`'s `flush()`: this is the only place the
   * playback `AudioContext` is closed, and one that outlives its page is the
   * leak that shows up as a browser tab still claiming the microphone.
   */
  useEffect(
    () => () => {
      disarm();
      playbackRef.current.cleanup();
    },
    [disarm],
  );

  return {
    sink,
    sync,
    preflight,
    resume,
    muted: capture.muted,
    toggleMute,
    sending,
    /**
     * Capture's verdict wins. A blocked *playback* context is real and worth
     * saying, but a denied microphone is the more consequential half — the
     * customer cannot hear the agent at all — and both notices carry the same
     * remedy, so showing the capture one first loses nothing.
     */
    error:
      capture.error ??
      (playback.blocked ? { kind: 'audio_blocked' as const, name: 'suspended' } : null),
  };
}
