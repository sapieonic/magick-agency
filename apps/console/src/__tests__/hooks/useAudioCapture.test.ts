import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAudioCapture } from '../../hooks/useAudioCapture';

/**
 * **`useAudioCapture`, at the hook.**
 *
 * ── Why this file exists at all ──────────────────────────────────────────────
 * This hook had no unit test. Everything it does was exercised only through
 * `AgentConsolePage.audio.test.tsx`, and a page test can only reach the states a
 * page can be driven into — so the doubles there are shaped for the page's
 * convenience, and one of those shapes hid two defects for the life of the
 * feature:
 *
 *   - its `audioWorklet.addModule` is `vi.fn(async () => {})`, which cannot
 *     reject. So the entire window between "the microphone was granted" and "the
 *     graph was published" was unreachable, and the throw that strands a live
 *     capture track in it was invisible. The rejection is not hypothetical: the
 *     processor is served from a `blob:` URL, so any `script-src`/`worker-src`
 *     policy without `blob:` reproduces it on every call.
 *   - its `AudioContext` decides `resume()` purely on the page's sticky
 *     activation, never on *when the context was constructed*. That erased the
 *     distinction the autoplay policy actually turns on, and with it the reason
 *     `preflight()` — a probe that exists to spend the agent's own click on
 *     warming the audio path — could report `audio_blocked` from inside that very
 *     click.
 *
 * ── What this file can and cannot prove ─────────────────────────────────────
 * happy-dom has no audio hardware, no `AudioWorklet` and no autoplay policy, so
 * nothing here proves a sound. What it proves is the *bookkeeping*: that no exit
 * from the acquire window leaves a track running, that a failure is classified
 * into something an agent can act on, that an error which has stopped being true
 * stops being displayed, and that the context is built on the side of the gesture
 * where a browser will run it. The doubles record what was asked of them and
 * decide nothing else.
 */

// ── Doubles ─────────────────────────────────────────────────────────────────

function fakeTrack() {
  return {
    kind: 'audio',
    enabled: true,
    stop: vi.fn(),
    addEventListener: () => {},
  };
}

let tracks: ReturnType<typeof fakeTrack>[] = [];
let contexts: FakeAudioContext[] = [];
let gumCalls = 0;
let gumResult: 'ok' | Error = 'ok';
/** Hold the OS permission prompt open, so a test can act inside the window. */
let gumMode: 'resolve' | 'hold' = 'resolve';
let heldPrompts: Array<() => void> = [];

/** Contexts come up suspended, as they do on a page with no gesture. */
let startsSuspended = false;
/** The page has had a user gesture at some point in its life. Monotonic. */
let stickyActivation = true;
/** What `audioWorklet.addModule` does. `'reject'` models a CSP without `blob:`. */
let addModuleResult: 'ok' | Error = 'ok';
/** Whether `new AudioWorkletNode` succeeds. */
let workletNodeThrows: Error | null = null;

/**
 * **Whether the page is still inside the task a user gesture started.**
 *
 * Flipped to `false` by the `getUserMedia` double at the moment it is *called*,
 * because awaiting the permission prompt is exactly what ends that task —
 * everything after `await getUserMedia(...)` runs in a later microtask, outside
 * the gesture. Browsers fix an `AudioContext`'s autoplay fate at **construction**
 * and never revisit it, so this one flag is precisely the discriminator between
 * the two possible orderings inside `acquire()`: build the context before asking
 * for the microphone, or after.
 *
 * `stickyActivation` is the other half of the real rule and is deliberately kept
 * separate: a gesture must have happened *somewhere* in the page's life for
 * `resume()` to be honoured at all, and the context must additionally have been
 * born inside one. Chromium is lenient about the second half; Safari and Firefox
 * are not, and the console has to work on all three.
 */
let inGestureTask = true;

/**
 * **A `MessagePort` that queues, because the real one does.**
 *
 * The previous double was `{ onmessage: null }` — a plain slot. That models a
 * port which *drops* whatever is posted before a handler exists, and the whole
 * agency latency defect lived in the gap between that and the platform: a
 * `MessagePort` is **disabled** until something enables it, assigning
 * `onmessage` is what enables it (implicit `start()`), and everything posted
 * beforehand is **queued and then delivered in one burst**. A double that drops
 * cannot fail the test that matters, so it agreed with the bug.
 *
 * `emit()` stands in for the worklet's `this.port.postMessage(...)`.
 */
class FakePort {
  private handler: ((e: { data: ArrayBuffer }) => void) | null = null;
  private queue: ArrayBuffer[] = [];

  get onmessage(): ((e: { data: ArrayBuffer }) => void) | null {
    return this.handler;
  }
  set onmessage(next: ((e: { data: ArrayBuffer }) => void) | null) {
    this.handler = next;
    if (!next) return;
    // Enabling the port delivers everything that accumulated while it was not.
    this.queue.splice(0).forEach((data) => next({ data }));
  }

  /** One 20 ms frame produced by the worklet. */
  emit(data: ArrayBuffer): void {
    if (this.handler) this.handler({ data });
    else this.queue.push(data);
  }

  /** Frames sitting in the port's queue, undelivered. */
  get depth(): number {
    return this.queue.length;
  }
}

let workletNodes: FakeAudioWorkletNode[] = [];

class FakeAudioWorkletNode {
  port = new FakePort();
  constructor() {
    if (workletNodeThrows) throw workletNodeThrows;
    workletNodes.push(this);
  }
  connect(): void {}
  disconnect(): void {}
}

class FakeAudioContext {
  state = startsSuspended ? 'suspended' : 'running';
  destination = {};
  closed = false;
  readonly bornInGesture = inGestureTask;
  audioWorklet = {
    addModule: vi.fn(async () => {
      if (addModuleResult !== 'ok') throw addModuleResult;
    }),
  };

  constructor() {
    contexts.push(this);
  }
  createMediaStreamSource() {
    return { connect: () => {} };
  }
  createAnalyser() {
    return { fftSize: 0, connect: () => {} };
  }
  async close() {
    this.closed = true;
  }
  async resume() {
    if (stickyActivation && this.bornInGesture) this.state = 'running';
  }
}

beforeEach(() => {
  tracks = [];
  contexts = [];
  workletNodes = [];
  gumCalls = 0;
  gumResult = 'ok';
  gumMode = 'resolve';
  heldPrompts = [];
  startsSuspended = false;
  stickyActivation = true;
  addModuleResult = 'ok';
  workletNodeThrows = null;
  inGestureTask = true;

  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode as unknown as typeof AudioWorkletNode);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async () => {
        gumCalls += 1;
        // The gesture's task is over the moment we are awaited. See the note on
        // `inGestureTask`.
        inGestureTask = false;
        if (gumMode === 'hold') {
          await new Promise<void>((resolve) => {
            heldPrompts.push(resolve);
          });
        }
        if (gumResult !== 'ok') throw gumResult;
        const track = fakeTrack();
        tracks.push(track);
        return {
          getTracks: () => [track],
          getAudioTracks: () => [track],
        } as unknown as MediaStream;
      }),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  // @ts-expect-error — removing the property defined above.
  delete navigator.mediaDevices;
});

function named(name: string, message = name): Error {
  const err = new Error(message);
  err.name = name;
  return err;
}

/** The agent answers the OS prompt. */
async function answerPrompt() {
  await act(async () => {
    heldPrompts.splice(0).forEach((resolve) => resolve());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('a throw between the grant and the publish releases the microphone', () => {
  /**
   * **The leak the generation token did not cover.**
   *
   * `acquire()` publishes `ctxRef`/`streamRef`/`nodeRef` only once the whole graph
   * is built, and `stop()` reads exactly those three. So for the entire span
   * between `getUserMedia` resolving and that publish, the closure inside
   * `acquire` is the only thing in the program that knows the microphone is open.
   * The token handles one way out of that span — a cancellation. A throw is the
   * other, and it was unguarded: `new AudioContext`, `addModule` and
   * `new AudioWorkletNode` all sat outside any `catch`, so a rejection there left
   * a live capture track with the browser's recording indicator lit and no code
   * path anywhere able to stop it.
   */

  it('stops the granted track when the worklet module is refused', async () => {
    // A `script-src`/`worker-src` CSP without `blob:` is this, on every call, in
    // every browser — the processor is loaded from a `blob:` URL.
    addModuleResult = named('AbortError', 'Failed to load module script');
    const { result } = renderHook(() => useAudioCapture());

    let rejected: unknown;
    await act(async () => {
      await result.current.prepare().catch((err: unknown) => {
        rejected = err;
      });
    });

    // The grant happened, so this is not vacuous: the browser handed us a live
    // microphone and the only question is whether anything still holds it.
    expect(rejected).toBeInstanceOf(Error);
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.stop).toHaveBeenCalled();
  });

  it('closes the AudioContext built around the stream it just released', async () => {
    // The half that accumulates silently. Browsers cap contexts per page, so a
    // shift of refused acquires eventually cannot create any more.
    addModuleResult = named('AbortError');
    const { result } = renderHook(() => useAudioCapture());

    await act(async () => {
      await result.current.prepare().catch(() => {});
    });

    expect(contexts).toHaveLength(1);
    expect(contexts[0]!.closed).toBe(true);
  });

  it('says so, rather than failing with the console reporting health', async () => {
    // The defect's real cost. `setError` was never reached on this path, so the
    // banner — the one thing that makes an inaudible agent aware of it — did not
    // render, and `prepare()`'s rejection was swallowed by `useAgencyAudio`.
    addModuleResult = named('AbortError');
    const { result } = renderHook(() => useAudioCapture());

    await act(async () => {
      await result.current.prepare().catch(() => {});
    });

    expect(result.current.error).not.toBeNull();
    expect(result.current.active).toBe(false);
  });

  it('does not read a refused worklet fetch as a refused permission', async () => {
    /**
     * `addModule` rejects with `AbortError` when the module fetch fails (per
     * spec), and `classifyCaptureError` maps `AbortError` to `permission_denied`
     * — Chromium uses that name for a dismissed prompt. Routing the graph failure
     * through that function would therefore tell every agent on the platform to
     * allow microphone access they had already allowed, for a problem in our own
     * Content-Security-Policy. The kind has to come from *where* the throw
     * happened, not from its name.
     */
    addModuleResult = named('AbortError');
    const { result } = renderHook(() => useAudioCapture());

    await act(async () => {
      await result.current.prepare().catch(() => {});
    });

    expect(result.current.error?.kind).toBe('unknown');
    // The raw name still rides along, because it is the only diagnostic there is.
    expect(result.current.error?.name).toBe('AbortError');
  });

  it('stops the granted track when the worklet node cannot be constructed', async () => {
    // The third unguarded statement. A context whose module resolved but never
    // registered `pcm16-processor` throws here, after the grant, same as above.
    workletNodeThrows = named('InvalidStateError');
    const { result } = renderHook(() => useAudioCapture());

    await act(async () => {
      await result.current.prepare().catch(() => {});
    });

    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.stop).toHaveBeenCalled();
    expect(contexts[0]!.closed).toBe(true);
  });

  it('leaves nothing published, so a later stop() is not a second teardown', async () => {
    // The refs must be as they were: a `stop()` after a failed acquire has to be
    // a no-op, not a `close()` on a context that is already closed.
    addModuleResult = named('AbortError');
    const { result } = renderHook(() => useAudioCapture());

    await act(async () => {
      await result.current.prepare().catch(() => {});
    });
    act(() => {
      result.current.stop();
    });

    expect(contexts).toHaveLength(1);
    expect(tracks[0]!.stop).toHaveBeenCalledTimes(1);
  });

  it('never opens the microphone at all when the browser has no audio graph', async () => {
    /**
     * `unsupported`, and asserted on `gumCalls` rather than only on the kind:
     * asking for a device we have already established we cannot use would light
     * the OS recording indicator to no purpose. This is only true because the
     * context is constructed *before* the prompt — which is also what fixes the
     * `audio_blocked` case below, so the two properties stand or fall together.
     */
    vi.stubGlobal('AudioContext', undefined);
    const { result } = renderHook(() => useAudioCapture());

    await act(async () => {
      await result.current.prepare().catch(() => {});
    });

    expect(result.current.error?.kind).toBe('unsupported');
    expect(gumCalls).toBe(0);
  });
});

describe('the context is built inside the gesture that was spent on it', () => {
  /**
   * **The cause behind `preflight()`'s unclearable `audio_blocked`.**
   *
   * `preflight()` is `prepare().then(stop)` and exists to move the permission
   * prompt and the autoplay unlock onto the agent's "Go available" click. But a
   * browser decides a context's fate at construction, and `acquire()` constructed
   * one only *after* awaiting `getUserMedia` — by which time the gesture's task
   * had ended. So on any browser that enforces this, the click bought the
   * microphone and nothing else: the context came up suspended, `resume()` was
   * refused, and the probe reported `audio_blocked` from inside the very gesture
   * whose purpose was to prevent one.
   */
  it('comes up running when prepare() is reached from a gesture', async () => {
    startsSuspended = true;
    stickyActivation = true;
    const { result } = renderHook(() => useAudioCapture());

    // Synchronously from the gesture, exactly as `useAgencyAudio.preflight` and
    // `useWebRtcCall.start` call it.
    await act(async () => {
      await result.current.prepare();
    });

    expect(contexts[0]!.state).toBe('running');
    expect(result.current.error).toBeNull();
  });

  it('still reports a suspended graph when there has been no gesture at all', async () => {
    /**
     * The mid-call reload, which the reordering does **not** fix and must not
     * paper over: `getUserMedia` resolves from the persisted permission, the
     * track is live, and there is no gesture anywhere in the page's life — so the
     * context is suspended whenever it was built. This has to stay an error, or
     * a reload looks perfect and sounds like nothing.
     */
    startsSuspended = true;
    stickyActivation = false;
    const { result } = renderHook(() => useAudioCapture());

    await act(async () => {
      await result.current.prepare();
    });

    expect(result.current.error?.kind).toBe('audio_blocked');
    // And it is a *working* acquisition, which is what makes it dangerous.
    expect(result.current.active).toBe(true);
  });
});

describe('an error that has stopped being true stops being shown', () => {
  /**
   * `audio_blocked` is a claim about a live `AudioContext` — "press this and I
   * will resume it" — and `resume()` reads `ctxRef`, which `stop()` nulls. Left
   * in place after a teardown it renders a banner whose only button returns
   * immediately, and whose message wins the `??` in `useAgencyAudio`, so even a
   * successful *playback* resume cannot clear it. `preflight()` reaches exactly
   * this state on every "Go available".
   */
  it('clears a blocked-context error when the context is closed', async () => {
    startsSuspended = true;
    stickyActivation = false;
    const { result } = renderHook(() => useAudioCapture());

    await act(async () => {
      await result.current.prepare();
    });
    expect(result.current.error?.kind).toBe('audio_blocked');

    act(() => {
      result.current.stop();
    });

    expect(result.current.error).toBeNull();
  });

  it('keeps a denied permission through the same teardown', async () => {
    // The other side of the rule, and the reason `stop()` does not simply clear
    // everything: a blocked permission is still blocked after teardown, and
    // replacing that sentence with silence is how the agent stops finding out.
    gumResult = named('NotAllowedError');
    const { result } = renderHook(() => useAudioCapture());

    await act(async () => {
      await result.current.prepare().catch(() => {});
    });
    expect(result.current.error?.kind).toBe('permission_denied');

    act(() => {
      result.current.stop();
    });

    expect(result.current.error?.kind).toBe('permission_denied');
  });

  it('keeps a lost device through the same teardown', async () => {
    gumResult = named('NotFoundError');
    const { result } = renderHook(() => useAudioCapture());

    await act(async () => {
      await result.current.prepare().catch(() => {});
    });

    act(() => {
      result.current.stop();
    });

    expect(result.current.error?.kind).toBe('no_device');
  });
});

describe('start() after the acquire it was waiting on was cancelled', () => {
  /**
   * An outcome the generation token created: `prepare()` can resolve
   * *successfully* having published nothing. `start()` awaits the shared in-flight
   * promise, so a `stop()` landing in that window left it dereferencing a `null`
   * worklet node — a `TypeError` on `.port`, caught by `useAgencyAudio`, leaving
   * `sending` false with no banner and no name for what happened.
   *
   * The rejection is still correct: the attempt the caller was opening for is
   * gone. What was wrong was that it arrived as a null dereference rather than as
   * a statement, and that a reader of `nodeRef.current!` would conclude the case
   * could not happen.
   */
  /**
   * Arm and open, both left in flight with the OS prompt on screen, and the
   * rejection handler attached **synchronously** — `answerPrompt()` flushes
   * microtasks, so a `.catch` added after it is one Vitest has already reported
   * as an unhandled rejection.
   */
  function openedThenReleased(result: { current: ReturnType<typeof useAudioCapture> }) {
    const outcome: { armed?: unknown; opened?: unknown } = {};
    const arming = result.current.prepare().then(
      () => {
        outcome.armed = 'resolved';
      },
      (err: unknown) => {
        outcome.armed = err;
      },
    );
    const opening = result.current.start(() => {}).then(
      () => {
        outcome.opened = 'resolved';
      },
      (err: unknown) => {
        outcome.opened = err;
      },
    );
    return { outcome, settled: Promise.all([arming, opening]) };
  }

  it('rejects with the reason rather than dereferencing a null node', async () => {
    gumMode = 'hold';
    const { result } = renderHook(() => useAudioCapture());

    // Armed: the prompt is on screen and nothing is published yet.
    const { outcome, settled } = openedThenReleased(result);

    // The attempt is released while both are still awaiting — a no-answer, a
    // lease expiry, or the agent navigating away.
    act(() => {
      result.current.stop();
    });
    await answerPrompt();
    await settled;

    // The cancelled acquire itself resolves — publishing nothing is its correct
    // outcome — which is exactly what leaves `start()` holding a null node.
    expect(outcome.armed).toBe('resolved');
    expect(outcome.opened).toBeInstanceOf(Error);
    expect((outcome.opened as Error).message).toMatch(/released before the uplink opened/);
    // Not the shape the `nodeRef.current!` produced, which is the whole point.
    expect((outcome.opened as Error).message).not.toMatch(/null/i);
  });

  it('does not invent a microphone failure for a call the agent already left', async () => {
    // No banner. The agent released the attempt; telling them their microphone
    // could not be opened would be a false statement, not a diagnostic.
    gumMode = 'hold';
    const { result } = renderHook(() => useAudioCapture());

    const { settled } = openedThenReleased(result);
    act(() => {
      result.current.stop();
    });
    await answerPrompt();
    await settled;

    expect(result.current.error).toBeNull();
    // And the stream that arrived after the release is not still running.
    expect(tracks[0]!.stop).toHaveBeenCalled();
  });
});

describe('the arming window does not accumulate audio', () => {
  /**
   * **The agency dialer's latency defect, at the hook that caused it.**
   *
   * The console arms the microphone on `reserved` — the moment an attempt
   * appears — and opens the uplink only on `bridged`. Between those two the
   * customer's phone is ringing, and the worklet is already connected and
   * rendering: it posts a 20 ms frame fifty times a second for the whole
   * duration.
   *
   * `start()` used to be the thing that assigned `port.onmessage`, and the
   * comment where the node was built claimed frames until then were "harmlessly
   * dropped". They were queued. Assigning the handler enabled the port and
   * delivered the entire backlog in one burst, at the exact instant the customer
   * answered — so the server received several thousand frames back-to-back,
   * transcoded them, and handed them to the carrier, which plays audio out at
   * real time and cannot catch up.
   *
   * Staging measured it end-to-end. On a call whose arm-to-bridge gap was
   * 11.38 s, the server counted 2098 browser→PSTN frames across a 30.67 s relay
   * window — 565 more than 20 ms pacing allows, i.e. 11.29 s of surplus audio,
   * matching the ringing window to within 90 ms. The customer→agent direction
   * over the same window was 48.9 fps, textbook. One-way lag, growing with how
   * long the phone rang.
   *
   * These tests are written against the *symptom the server measured* — the count of
   * frames that reach the sink — rather than against the implementation, so
   * they stay honest if the fix is ever rewritten.
   */

  /** 20 ms of PCM16 at 16 kHz: 320 samples, 640 bytes. */
  const frame = () => new ArrayBuffer(640);

  async function armed() {
    const view = renderHook(() => useAudioCapture());
    await act(async () => {
      await view.result.current.prepare();
    });
    const node = workletNodes.at(-1)!;
    return { view, node };
  }

  it('drops the ringing window instead of queueing it for the bridge', async () => {
    const { view, node } = await armed();

    // The phone rings for ~11 s. This is what the worklet does in that time.
    for (let i = 0; i < 565; i++) node.port.emit(frame());

    // Nothing is holding them: the port is enabled, so they were delivered and
    // dropped as they arrived. This is the assertion the old double could not
    // make, because a plain `{ onmessage: null }` slot discards by construction.
    expect(node.port.depth).toBe(0);

    const sent: string[] = [];
    await act(async () => {
      await view.result.current.start((payload) => sent.push(payload));
    });

    // The customer answers. Opening the uplink must deliver *nothing* — not the
    // 565 frames of the agent's room tone that the carrier would then play out
    // ahead of their first live word.
    expect(sent).toHaveLength(0);

    // And from here the uplink runs at real time: five frames in, five out.
    for (let i = 0; i < 5; i++) node.port.emit(frame());
    expect(sent).toHaveLength(5);
  });

  it('keeps the uplink at the rate the carrier drains, however long it rang', async () => {
    // The defect scaled with the ringing window, which is why a slow answer hurt
    // more than a fast one. The rate after the bridge must not.
    const { view, node } = await armed();
    for (let i = 0; i < 3000; i++) node.port.emit(frame());

    const sent: string[] = [];
    await act(async () => {
      await view.result.current.start((payload) => sent.push(payload));
    });
    for (let i = 0; i < 50; i++) node.port.emit(frame());

    // Exactly one second of audio for one second of call. No surplus to sit in
    // front of the agent for the rest of the conversation.
    expect(sent).toHaveLength(50);
  });

  it('still drops muted frames, and still sends after unmute', async () => {
    const { view, node } = await armed();
    const sent: string[] = [];
    await act(async () => {
      await view.result.current.start((payload) => sent.push(payload));
    });

    act(() => {
      view.result.current.setMuted(true);
    });
    for (let i = 0; i < 10; i++) node.port.emit(frame());
    // Not queued for later either — muted audio must never arrive late.
    expect(sent).toHaveLength(0);
    expect(node.port.depth).toBe(0);

    act(() => {
      view.result.current.setMuted(false);
    });
    node.port.emit(frame());
    expect(sent).toHaveLength(1);
  });

  it('sends nothing to the previous call after stop()', async () => {
    // The frame that arrives after teardown is the worst version of this bug:
    // one customer's audio on the next customer's socket. `useAgencyAudio` also
    // guards it, but the sink is released here and must be released here.
    const { view, node } = await armed();
    const sent: string[] = [];
    await act(async () => {
      await view.result.current.start((payload) => sent.push(payload));
    });
    node.port.emit(frame());
    expect(sent).toHaveLength(1);

    act(() => {
      view.result.current.stop();
    });
    node.port.emit(frame());
    expect(sent).toHaveLength(1);
  });
});
