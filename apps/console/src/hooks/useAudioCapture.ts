import { useState, useRef, useCallback } from 'react';
import { getWorkletUrl } from '../utils/audio-worklet-processor';

/**
 * How the microphone failed, reduced to the cases a *person* can act on.
 *
 * The raw `DOMException.name` is kept alongside for diagnostics but is never the
 * thing a caller branches on: browsers disagree about which name they use for
 * the same situation (Firefox reports a dismissed prompt as `NotAllowedError`,
 * some Chromium builds as `AbortError`), so a caller matching on names would
 * render the wrong remedy on the wrong browser.
 */
export type AudioCaptureFailureKind =
  /** Blocked, or the prompt was dismissed. The agent must change a browser setting. */
  | 'permission_denied'
  /** No input device matched. Usually nothing plugged in. */
  | 'no_device'
  /** The OS or another app is holding the device. */
  | 'device_busy'
  /** The device went away *after* capture started — headset unplugged mid-call. */
  | 'device_lost'
  /**
   * The microphone opened but the browser will not run the audio graph: the
   * `AudioContext` is `suspended` because nothing in this page load was a user
   * gesture. **This is the one failure where every other signal says "fine"** —
   * `getUserMedia` resolved from the persisted permission, the track is live,
   * the recording indicator is lit, and the worklet simply never runs. It is
   * reachable on an ordinary mid-call reload, where the console rehydrates a
   * bridged attempt without the agent ever clicking anything.
   */
  | 'audio_blocked'
  /** No `mediaDevices` at all: an insecure origin, or a browser we can't use. */
  | 'unsupported'
  | 'unknown';

export interface AudioCaptureError {
  kind: AudioCaptureFailureKind;
  /** Raw `DOMException.name`. Diagnostics only — never shown to an agent. */
  name: string;
}

export interface AudioCaptureOptions {
  /**
   * Input device. **`undefined` means "follow the system default"**, which is
   * deliberately the default: an explicitly pinned `deviceId` stops tracking the
   * OS default, so an agent who switches headsets in the OS keeps capturing from
   * the old one. Pin only when the agent has actually chosen.
   */
  deviceId?: string;
}

interface AudioCaptureState {
  active: boolean;
  analyser: AnalyserNode | null;
  /**
   * Acquire the microphone + build the capture graph WITHOUT attaching a sink.
   * Lets a caller obtain mic permission up front (from a user gesture) before
   * committing to network work; frames are produced but discarded until
   * `start()` attaches a consumer. Idempotent while a stream is live.
   */
  prepare: () => Promise<void>;
  start: (onChunk: (base64: string) => void) => Promise<void>;
  stop: () => void;
  /**
   * Muted state. **Mute is enforced in two places** — the track is disabled at
   * the source *and* the chunk sink is gated — because either alone is a
   * half-measure: disabling the track still delivers silent frames to the
   * worklet (bandwidth, and a "muted" that depends on the browser honouring
   * `enabled`), while gating only the sink leaves the OS recording indicator
   * saying the mic is hot when we have promised it is not.
   */
  muted: boolean;
  setMuted: (muted: boolean) => void;
  /**
   * The last acquisition or device failure, or `null`. Sticky until the next
   * successful `prepare()` — a caller rendering it must be able to keep it on
   * screen, since the whole point is that silence is not self-announcing.
   *
   * **One exception, and it is the honest kind of exception:** `stop()` clears an
   * `audio_blocked`, because that kind is a claim about a live `AudioContext`
   * ("press this and I will resume it") and `stop()` closes the context. Every
   * other kind survives teardown, because every other kind is still true after
   * it. See the note in `stop()`.
   */
  error: AudioCaptureError | null;
  /**
   * Resume a capture `AudioContext` the browser suspended. **Call from a user
   * gesture** — that is the only thing that lifts the autoplay policy, and a
   * `resume()` from anywhere else silently leaves the context suspended.
   *
   * Clears an `audio_blocked` error on success, so the banner offering the
   * gesture disappears when the gesture works.
   */
  resume: () => Promise<void>;
}

/**
 * Map whatever `getUserMedia` threw onto {@link AudioCaptureFailureKind}.
 *
 * `OverconstrainedError` lands in `no_device` rather than its own case on
 * purpose: the only constraint we ever pin is `deviceId`, so over-constrained
 * here always means "the device you chose is gone", which is the same remedy.
 */
export function classifyCaptureError(err: unknown): AudioCaptureError {
  const name = err instanceof Error ? err.name : 'Error';
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
    case 'PermissionDeniedError':
      return { kind: 'permission_denied', name };
    case 'AbortError':
      // Chromium uses this for a prompt the user dismissed without choosing.
      // Same remedy as a denial: the agent has to grant it.
      return { kind: 'permission_denied', name };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return { kind: 'no_device', name };
    case 'NotReadableError':
    case 'TrackStartError':
      return { kind: 'device_busy', name };
    default:
      return { kind: 'unknown', name };
  }
}

export function useAudioCapture(options: AudioCaptureOptions = {}): AudioCaptureState {
  const [active, setActive] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const [muted, setMutedState] = useState(false);
  const [error, setError] = useState<AudioCaptureError | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);

  /**
   * Options behind refs so `prepare`/`start` keep stable identities.
   *
   * Not tidiness: `useBrowserCall` lists the whole capture object in `start`'s
   * dependency array, and `useAgencyAudio` runs `prepare()` from an effect keyed
   * on the bridge state. A `prepare` that changed identity whenever an inline
   * options object was re-created would re-run that effect on every render of
   * the console — re-acquiring the microphone mid-conversation.
   */
  const optionsRef = useRef(options);
  optionsRef.current = options;

  /**
   * Read inside the worklet's `port.onmessage`, which is attached once in
   * `buildGraph`. A state value closed over there would freeze at whatever
   * `muted` was when the graph was built, so the mute button would appear to
   * work and change nothing on the wire.
   */
  const mutedRef = useRef(false);

  /**
   * Where a captured frame goes, or `null` for "nowhere yet".
   *
   * The uplink is opened by swapping this, **not** by attaching the worklet's
   * `port.onmessage` — see the long note in `buildGraph`. The handler is
   * attached once, when the node is built, so the port is enabled from the start
   * and frames produced before the call bridges are dropped as they arrive
   * instead of piling up in the port's queue.
   *
   * A ref rather than state for the same reason as `mutedRef`: this is read
   * ~50 times a second inside the port handler, and a value closed over there
   * would freeze at whatever it was when the graph was built.
   */
  const sinkRef = useRef<((base64: string) => void) | null>(null);

  /**
   * The acquisition already in flight, so concurrent `prepare()` calls share one
   * `getUserMedia`.
   *
   * The `streamRef` check alone is not idempotence — it is idempotence *after*
   * the await resolves, and the window before that is real: `React.StrictMode`
   * double-invokes effects in development, so the agency console's arm-the-mic
   * effect calls this twice in the same tick. Two `getUserMedia` calls means two
   * MediaStreams, one of which is never stored and therefore never stopped — a
   * recording indicator that stays lit with no track to explain it.
   */
  const preparingRef = useRef<Promise<void> | null>(null);

  /**
   * Cancellation token for an acquire that is still awaiting.
   *
   * `preparingRef` above stops two acquires racing; **this stops one acquire
   * outliving the hook that asked for it**, which is the other half of the same
   * bug and the more dangerous half. `acquire()` cannot publish anything until
   * after `getUserMedia` *and* `audioWorklet.addModule` have resolved, so for
   * that whole window `ctxRef`/`streamRef`/`nodeRef` are all `null` — and
   * `stop()` reads exactly those three. A `stop()` landing in the window is a
   * no-op, and the stream then resolves into refs nobody will ever read again:
   * a live microphone track, the recording indicator lit, and **no code path
   * anywhere that can stop it**.
   *
   * That window is not exotic. The console arms on `reserved`, so it is entered
   * on every single call, and it is left open for as long as the OS permission
   * prompt is on screen. An attempt released inside it (no-answer, busy, lease
   * expiry) or a navigation away is enough.
   *
   * `stop()` bumps this; `acquire()` re-checks it after every await and tears
   * down what it built rather than publishing it.
   *
   * **A cancellation is only one of two ways out of that window.** A *throw*
   * inside it — `addModule` refused by CSP, `new AudioWorkletNode` on a context
   * that never registered the processor — strands exactly the same live track by
   * exactly the same mechanism, and this token says nothing about it. That half
   * is `release()` in `acquire`.
   */
  const generationRef = useRef(0);

  const setMuted = useCallback((next: boolean) => {
    mutedRef.current = next;
    setMutedState(next);
    // Both halves — see the note on `muted` above.
    streamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !next;
    });
  }, []);

  const prepare = useCallback(async () => {
    // Already prepared/live — reuse the existing stream (idempotent).
    if (streamRef.current) return;
    if (preparingRef.current) return preparingRef.current;
    const run = acquire(generationRef.current);
    preparingRef.current = run;
    try {
      await run;
    } finally {
      // **Only if it is still ours.** `stop()` clears this so a cancelled
      // acquire cannot be handed to the next caller as if it were live; if a
      // fresh `prepare()` has since stored its own promise, nulling it here
      // would strand that one — the next caller would start a *third* acquire.
      if (preparingRef.current === run) preparingRef.current = null;
    }
  }, []);

  /**
   * Not a `useCallback`: `prepare` memoizes on `[]` and would capture whichever
   * `acquire` the first render produced. That is harmless only because
   * everything variable it reads goes through `optionsRef` — stating it here
   * rather than leaving the next reader to work out whether the staleness bites.
   */
  async function acquire(generation: number): Promise<void> {
    const { deviceId } = optionsRef.current;
    /** Superseded by a `stop()` that ran while we were awaiting. */
    const cancelled = () => generationRef.current !== generation;

    if (!navigator.mediaDevices?.getUserMedia) {
      // An insecure origin is the common cause and it is invisible otherwise:
      // `navigator.mediaDevices` is simply undefined over plain http, and the
      // reflexive `?.` would leave the caller with no error at all.
      setError({ kind: 'unsupported', name: 'NotSupportedError' });
      throw new Error('Microphone capture is not available in this browser.');
    }

    /**
     * **Looked up, not referenced** — a bare `new AudioContext(...)` where the
     * global is absent throws a `ReferenceError`/`TypeError` that
     * `classifyCaptureError` can only land in `unknown`, whose copy tells the
     * agent to reload and then ask their supervisor. `unsupported` names the real
     * situation and its remedy ("open the console over https in Chrome, Edge or
     * Firefox") is the one that works.
     *
     * **No `webkitAudioContext` fallback, unlike `useAudioPlayback`, and that is
     * a decision rather than an omission.** Playback needs only
     * `createBufferSource`, which prefixed-only Safari (≤14.0) has — so falling
     * back there buys working audio. Capture needs `AudioWorklet`, which no
     * browser lacking the unprefixed constructor has ever shipped, so the
     * fallback here would buy nothing except a later, vaguer failure: a
     * `TypeError` off `ctx.audioWorklet` classified as `unknown` in place of an
     * accurate `unsupported`.
     */
    const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
    if (!Ctor) {
      setError({ kind: 'unsupported', name: 'NotSupportedError' });
      throw new Error('Web Audio is not available in this browser.');
    }

    /**
     * **The context is built BEFORE `getUserMedia` is awaited, and the ordering
     * is load-bearing.**
     *
     * Autoplay policy is decided at *construction*: a context first created
     * outside the task that a user gesture started comes up `suspended`, and
     * `resume()` from outside a gesture is then refused for the life of that
     * context. Awaiting the permission prompt ends the gesture's task, so
     * constructing afterwards put every context this hook has ever built on the
     * wrong side of that line. It only looked survivable because Chromium is
     * lenient about it; where a browser is not, `preflight()` — whose whole job
     * is to spend the agent's "Go available" click on warming the audio path —
     * produced an `audio_blocked` from inside the very gesture that was supposed
     * to prevent one.
     *
     * Both other callers reach `prepare()` synchronously from a click handler
     * (`useWebRtcCall.start`, `useAgencyAudio.preflight`), so they gain the same
     * thing. `useBrowserCall` calls `start()` from `ws.onopen`, which is not a
     * gesture under either ordering — unchanged, not regressed.
     *
     * The cost is a context built on attempts that go on to fail at the prompt.
     * `release()` closes it, so the per-page context cap is not walked into.
     */
    let ctx: AudioContext;
    try {
      ctx = new Ctor({ sampleRate: 16000 });
    } catch (err) {
      // A page that has exhausted its context budget lands here. Nothing was
      // acquired yet, so there is nothing to release.
      setError({ kind: 'unknown', name: err instanceof Error ? err.name : 'Error' });
      throw err;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          // `exact`, never a soft preference: a soft `deviceId` silently falls
          // back to the default, so an agent who picked a headset would be told
          // they are on it while speaking into the laptop.
          ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        },
      });
    } catch (err) {
      void ctx.close().catch(() => {
        /* already closed with the page */
      });
      // Not reported when we were already cancelled: an agent who navigated
      // away should not be shown a microphone error about a call they left.
      if (!cancelled()) setError(classifyCaptureError(err));
      throw err;
    }

    /**
     * **The only reference to a granted-but-unpublished stream, and therefore the
     * only thing that can stop it.**
     *
     * From here until the three refs below are written, nothing outside this
     * closure knows the microphone is open: `stop()` reads
     * `ctxRef`/`streamRef`/`nodeRef` and all three are still `null`. So *every*
     * way out of this window has to come through here — the two cancellation
     * checks and, just as much, a throw. Miss one and the browser keeps a live
     * capture track with the recording indicator lit until the tab is closed,
     * which is the failure the generation token was added to prevent and which
     * survived on the throw path because only `getUserMedia` was ever guarded.
     */
    const release = () => {
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => {
        /* already closed with the page */
      });
    };

    if (cancelled()) {
      // The prompt was answered after the caller gave up.
      release();
      return;
    }

    /**
     * Returns `null` when the attempt was cancelled part-way through. A nested
     * step rather than inline statements so that the `catch` below is the single
     * place a half-built graph is released — the shape that made the leak
     * possible was a sequence of unguarded awaits with three separate exits.
     */
    const buildGraph = async (): Promise<{
      analyser: AnalyserNode;
      node: AudioWorkletNode;
    } | null> => {
      /**
       * **Autoplay policy.** A suspended context does not pull its worklet — so
       * the microphone is live, the track is enabled, and `process()` is never
       * called. `resume()` only succeeds when the page has sticky activation; the
       * failure is reported at the end of `acquire` rather than thrown, because a
       * suspended graph is a working call with no audio, not a failed
       * acquisition.
       */
      await ctx.resume().catch(() => {
        // Refused for want of a gesture. `ctx.state` below is the real answer.
      });
      /**
       * **Rejects in production, not only in theory.** The processor is served
       * from a `blob:` URL (`utils/audio-worklet-processor.ts`), so a
       * `script-src`/`worker-src` policy that omits `blob:` makes this reject on
       * every call in every browser — with `getUserMedia` already resolved and
       * the recording indicator already lit.
       */
      await ctx.audioWorklet.addModule(getWorkletUrl());
      if (cancelled()) return null;

      const source = ctx.createMediaStreamSource(stream);
      const analyserNode = ctx.createAnalyser();
      analyserNode.fftSize = 256;
      source.connect(analyserNode);

      const workletNode = new AudioWorkletNode(ctx, 'pcm16-processor');
      /**
       * **The port is enabled HERE, not in `start()`, and that is the whole
       * point of this line.**
       *
       * This used to read "no sink yet — frames until then are harmlessly
       * dropped". They were not dropped. A `MessagePort` is disabled until
       * something enables it, and assigning `onmessage` is what enables it
       * (implicit `port.start()`); until then every `postMessage` from the
       * worklet is **queued on the port**, not discarded. The worklet is
       * connected and rendering from this moment, so it posts a 20 ms frame
       * fifty times a second into that queue — and the queue was drained in one
       * burst at the instant `start()` assigned the handler.
       *
       * On the agency console that window is `reserved` → `bridged`: the whole
       * time the customer's phone is ringing. Staging measured it directly —
       * 565 surplus frames on a call whose arm-to-bridge gap was 11.38 s, i.e.
       * 11.3 s of the agent's room tone delivered to core the moment the
       * customer said hello, transcoded, and handed to the carrier, which plays
       * it out at real time. Everything the agent then said sat behind it for
       * the rest of the call. Inbound audio was unaffected (49.9 fps, exactly
       * 20 ms pacing), which is why it presented as one-way lag rather than a
       * broken call.
       *
       * So: enable the port as soon as the node exists, and let the handler drop
       * frames in real time while `sinkRef` is null. Nothing accumulates,
       * because nothing is ever queued.
       */
      workletNode.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
        const sink = sinkRef.current;
        // Armed but not bridged (or already released): there is nowhere for this
        // frame to go. Returning before the copy + base64 also keeps the ringing
        // window cheap, which it was not when these were being queued.
        if (sink === null) return;
        // Nothing leaves while muted — not even a silent frame. See `muted`.
        if (mutedRef.current) return;
        const pcm16 = new Uint8Array(e.data);
        let binary = '';
        for (let i = 0; i < pcm16.length; i++) {
          binary += String.fromCharCode(pcm16[i]!);
        }
        sink(btoa(binary));
      };
      source.connect(workletNode);
      workletNode.connect(ctx.destination);
      return { analyser: analyserNode, node: workletNode };
    };

    let graph: { analyser: AnalyserNode; node: AudioWorkletNode } | null;
    try {
      graph = await buildGraph();
    } catch (err) {
      release();
      /**
       * **Deliberately not `classifyCaptureError`.** That function maps
       * `getUserMedia`'s `DOMException` names, and the overlap is actively
       * misleading here: a worklet module whose fetch fails rejects with
       * `AbortError` (per spec), which `classifyCaptureError` reads as a
       * dismissed permission prompt — so a CSP misconfiguration would tell every
       * agent on the platform to allow microphone access they have already
       * allowed. `unknown` is the honest kind: its copy says the microphone could
       * not be opened and sends the agent to their supervisor, which is where a
       * CSP problem has to go. The raw name rides along for diagnostics.
       */
      if (!cancelled()) {
        setError({ kind: 'unknown', name: err instanceof Error ? err.name : 'Error' });
      }
      throw err;
    }
    if (graph === null) {
      release();
      return;
    }

    ctxRef.current = ctx;
    streamRef.current = stream;
    nodeRef.current = graph.node;

    /**
     * A track that ends on its own was NOT stopped by us — `stop()` clears
     * `streamRef` before the browser fires this, so the guard tells the two
     * apart. Unguarded, every ordinary teardown would report a device failure.
     */
    stream.getAudioTracks().forEach((track) => {
      track.enabled = !mutedRef.current;
      track.addEventListener('ended', () => {
        if (streamRef.current !== stream) return;
        setError({ kind: 'device_lost', name: 'ended' });
      });
    });

    setAnalyser(graph.analyser);
    setActive(true);
    /**
     * A suspended context is reported **as an error, not as success**.
     *
     * Everything above succeeded, which is exactly the problem: the permission
     * was granted, the track is live and the graph is built, so nothing else in
     * the console has any reason to think the agent is inaudible. Clearing the
     * error here unconditionally is what would make a mid-call reload look
     * perfect and sound like nothing.
     */
    setError(ctx.state === 'running' ? null : { kind: 'audio_blocked', name: ctx.state });
  }

  const resume = useCallback(async () => {
    const ctx = ctxRef.current;
    if (!ctx) return;
    await ctx.resume().catch(() => {
      /* still refused — `state` below stays suspended and the banner stays up */
    });
    // Only the blocked error is cleared. A denied permission or a lost device is
    // not fixed by a click, and dropping that message here would replace a true
    // statement with silence.
    setError((prev) =>
      ctx.state === 'running' && prev?.kind === 'audio_blocked' ? null : prev,
    );
  }, []);

  const start = useCallback(async (onChunk: (base64: string) => void) => {
    // Reuse a mic stream prepared up front; otherwise acquire it now (preserves
    // the original single-call behavior for callers that don't pre-acquire).
    if (!nodeRef.current) await prepare();

    /**
     * **`prepare()` can now resolve having published nothing**, which the
     * `nodeRef.current!` this replaced did not allow for.
     *
     * That outcome arrived with the generation token: a `stop()` landing while
     * this `await` is pending cancels the shared acquire, which then resolves
     * *successfully* with the graph torn down instead of stored. The assertion
     * then dereferenced `null` and `.port` threw a `TypeError` — swallowed by
     * `useAgencyAudio`'s `.catch`, so the symptom was `sending: false` with no
     * banner and a stack trace nobody would look for.
     *
     * A throw is still the right answer; a named one. There is deliberately **no
     * `setError`**: the only way here is a release the caller asked for, and
     * "your microphone could not be opened" about a call the agent has already
     * left is a false statement, not a diagnostic. The caller's own guard
     * (`armedForRef !== attempt`) is what decides `sending`, and it is already
     * correct — this exists so the failure has a name if it is ever reached
     * another way.
     */
    const workletNode = nodeRef.current;
    if (!workletNode) {
      throw new Error('Microphone capture was released before the uplink opened.');
    }
    /**
     * Opening the uplink is a **pointer swap**, not an `onmessage` assignment.
     * The handler has been attached since the node was built, precisely so that
     * this moment does not also flush a port queue holding every frame produced
     * since `prepare()` — which is what it used to do, and what put ~11 s of
     * ringing-window audio in front of the agent's first live word.
     *
     * `workletNode` is dereferenced above rather than ignored: it is the proof
     * that a graph exists to send from, and the throw is the whole reason this
     * function has to run after `prepare()` rather than before it.
     */
    sinkRef.current = onChunk;
  }, [prepare]);

  const stop = useCallback(() => {
    /**
     * **Cancels an acquire still in flight, before anything else.** Without
     * this, `stop()` during the permission prompt is a no-op over three null
     * refs and the stream that resolves afterwards is unreachable forever.
     * Clearing `preparingRef` alongside it means the next `prepare()` starts a
     * fresh acquire rather than awaiting the one we just cancelled.
     */
    generationRef.current += 1;
    preparingRef.current = null;

    /**
     * Detached before the tracks are stopped, so a frame already in flight
     * cannot reach a sink whose call has ended.
     *
     * **Both, and `sinkRef` is the one that matters now.** Nulling `onmessage`
     * alone would leave the caller's `onChunk` reachable through `sinkRef` if a
     * later graph attached its handler before `start()` ran again; nulling
     * `sinkRef` alone would leave a handler attached to a node we are about to
     * discard. Clearing the sink first is also what keeps the port *enabled and
     * draining* for the rest of this tick rather than silently re-queueing.
     */
    sinkRef.current = null;
    if (nodeRef.current) nodeRef.current.port.onmessage = null;
    nodeRef.current?.disconnect();
    nodeRef.current = null;
    const stream = streamRef.current;
    // Cleared FIRST: the `ended` listener above reads it to tell a deliberate
    // teardown from a device disappearing, and `track.stop()` fires `ended`.
    streamRef.current = null;
    stream?.getTracks().forEach(t => t.stop());
    ctxRef.current?.close();
    ctxRef.current = null;
    setAnalyser(null);
    setActive(false);
    /**
     * **`audio_blocked` does not outlive the context it was about.**
     *
     * The error state is otherwise sticky on purpose, and stays so: a denied
     * permission or an unplugged headset is still true after teardown, and
     * clearing those would replace a true statement with silence. `audio_blocked`
     * is the one kind that is *not* — it says "this context is suspended, press
     * the button and I will resume it", and `resume()` reads `ctxRef`, which this
     * function just nulled. Left in place it renders a banner whose only control
     * returns immediately and whose message wins the `??` in `useAgencyAudio`, so
     * a successful playback resume cannot clear it either: a dead button until
     * the next call arms the microphone.
     *
     * `preflight()` reaches this on every "Go available" — it is
     * `prepare().then(stop)` by construction — so a browser that will not run a
     * context the agent's own click created leaves the console permanently
     * announcing a failure it can no longer do anything about.
     */
    setError((prev) => (prev?.kind === 'audio_blocked' ? null : prev));
  }, []);

  return { active, analyser, prepare, start, stop, muted, setMuted, error, resume };
}
