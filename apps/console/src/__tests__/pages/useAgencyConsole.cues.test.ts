import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  mintStationToken: vi.fn(),
  setAgentAvailable: vi.fn(),
  setAgentBreak: vi.fn(),
  cancelQueuedBreak: vi.fn(),
  submitDisposition: vi.fn(),
  saveAttemptNotes: vi.fn(),
}));
vi.mock('../../api/agency', () => mocks);

import { useAgencyConsole } from '../../pages/agency/useAgencyConsole';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';

/**
 * **The connect cue reaching a real speaker (`MAG-39`).**
 *
 * `CueDispatcher` and `WebAudioCueSink` were built, unit-tested and shipped with
 * **no production caller at all**: `useAgencyConsole` simply never passed `cues`
 * to the station. Every assertion in `utils/agencyCues.test.ts` passed against a
 * dispatcher the console constructed nowhere, so an agent on a power dialer heard
 * nothing when a call connected — the one thing the subsystem exists to do.
 *
 * These tests are therefore deliberately at the **console** level and drive real
 * socket frames. A dispatcher-level assertion cannot fail for the defect this
 * fixes, because the defect was never in the dispatcher.
 */

class FakeSocket {
  static instances: FakeSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
}

/**
 * The smallest `AudioContext` the cue sink actually touches, plus a record of
 * what it scheduled.
 *
 * `state` is settable so a test can produce the browser's real refusal — a
 * context that exists but will not run — which is the only route to the escalated
 * visual now that no volume control has shipped.
 */
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = 'running';
  currentTime = 0;
  sampleRate = 48_000;
  destination = {} as AudioNode;
  oscillators: Array<{ hz: number; start: number; stop: number }> = [];
  closed = false;
  /** How many times the unlock has been attempted on THIS context. */
  resumes = 0;
  readonly options: AudioContextOptions | undefined;

  constructor(options?: AudioContextOptions) {
    this.options = options;
    FakeAudioContext.instances.push(this);
  }

  /**
   * The **cue's** contexts, which are not the only ones on this page any more.
   *
   * `goAvailable` is one gesture carrying three unlocks: the microphone probe,
   * the playback context (`useAudioPlayback.warmup`, constructed with
   * `{ sampleRate: 16000 }`) and the cue context (`createUnlockedAudioContext`,
   * constructed with **no options**). These assertions used to index
   * `instances[0]` and were reading whichever happened to be built first — so
   * adding the playback warm-up ahead of the cue unlock silently re-pointed
   * every one of them at the wrong context, and four tests failed for a reason
   * that had nothing to do with cues.
   *
   * Selecting on the constructor signature rather than on creation order means
   * the order is free to change again.
   */
  static cueContexts(): FakeAudioContext[] {
    return FakeAudioContext.instances.filter((c) => c.options === undefined);
  }
  createOscillator(): OscillatorNode {
    const record = { hz: 0, start: 0, stop: 0 };
    this.oscillators.push(record);
    return {
      type: 'sine',
      frequency: {
        set value(hz: number) {
          record.hz = hz;
        },
        get value() {
          return record.hz;
        },
      },
      connect: () => undefined,
      start: (at: number) => {
        record.start = at;
      },
      stop: (at: number) => {
        record.stop = at;
      },
    } as unknown as OscillatorNode;
  }
  createGain(): GainNode {
    return {
      gain: {
        setValueAtTime: () => undefined,
        linearRampToValueAtTime: () => undefined,
      },
      connect: () => undefined,
    } as unknown as GainNode;
  }
  createBuffer(): AudioBuffer {
    return {} as AudioBuffer;
  }
  createBufferSource(): AudioBufferSourceNode {
    return { connect: () => undefined, start: () => undefined } as unknown as AudioBufferSourceNode;
  }
  resume(): Promise<void> {
    this.resumes += 1;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  contact_id: 'c-1',
  phone_e164: '+919876543210',
  caller_id: '+911234567890',
  attempt_number: 1,
  context: {},
  prior_attempts: [],
};

const BOOTSTRAP: AgencySessionBootstrap = {
  session_id: 'sess-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  agent_user_id: 'u-1',
  state: 'offline',
  campaign_status: 'running',
  station_ws_url: '/proxy/agency/station/sess-1?token=t1',
  disposition_catalog: [],
  wrapup_seconds: 0,
  wrapup_auto_return: true,
  record_calls: false,
  break_reasons: [],
  context_display: {},
  intervals: {
    heartbeat_ms: 10_000,
    heartbeat_grace_ms: 30_000,
    reservation_lease_ms: 10_000,
    countdown_ms: 3000,
  },
};

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

beforeEach(() => {
  FakeSocket.instances = [];
  FakeAudioContext.instances = [];
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.setAgentAvailable.mockResolvedValue(undefined);
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function opened() {
  const view = renderHook(() => useAgencyConsole(BOOTSTRAP, 'tenant-1', 'account-1'));
  await act(async () => {});
  act(() => latest().open());
  return view;
}

/** The shift's one reliable user gesture, which is where the context unlocks. */
async function goAvailable(view: Awaited<ReturnType<typeof opened>>) {
  await act(async () => {
    view.result.current.goAvailable();
  });
}

const cueEntries = (view: Awaited<ReturnType<typeof opened>>) =>
  view.result.current.station.diagnostics.filter((d) => d.event === 'cue:connect');

describe('the connect cue is wired to the console, not just to a test', () => {
  it('plays a rising two-tone on `bridged` and nothing before it', async () => {
    const view = await opened();
    await goAvailable(view);

    act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
    const ctx = FakeAudioContext.cueContexts()[0]!;
    // Three even knocks at ONE pitch — get-ready is a rhythm, not a melody, so it
    // cannot be confused with the rising connect.
    const ready = ctx.oscillators.map((o) => o.hz);
    expect(ready).toEqual([523, 523, 523]);

    act(() =>
      latest().emit({
        event: 'bridged',
        attempt_id: 'att-1',
        bridged_at: '2026-08-11T10:00:04.000Z',
      }),
    );

    // Connect RISES. This is the assertion that distinguishes it from get-ready
    // and from disconnect, and it is the whole reason the table is a rhythm/contour
    // table rather than three pitches.
    expect(ctx.oscillators.slice(3).map((o) => o.hz)).toEqual([660, 990]);
  });

  it('records the connect lag, which is what a supervisor is answered with', async () => {
    // Logged whether or not the cue was audible — "muted" is itself the answer to
    // "did the agent get told about this call".
    const view = await opened();
    await goAvailable(view);
    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({
        event: 'bridged',
        attempt_id: 'att-1',
        bridged_at: '2026-08-11T10:00:04.000Z',
      });
    });

    const entry = cueEntries(view)[0];
    expect(entry).toBeDefined();
    expect(entry!.detail).toContain('attempt=att-1');
    // Parsed as a number under §A.4.3.1's 150ms budget, not matched as a
    // substring: `lag=NaNms` would satisfy a `toContain('lag=')`.
    const lag = Number(/lag=(\d+)ms/.exec(entry!.detail)?.[1]);
    expect(Number.isFinite(lag)).toBe(true);
    expect(lag).toBeLessThan(150);
  });

  it('does NOT fire on a reconnect onto a call already in progress', async () => {
    /**
     * The failure this must never produce: a "customer connected" chime four
     * minutes into a live conversation, telling the agent something happened when
     * nothing did. Core deliberately does not re-emit `bridged` for a resumed
     * attempt for exactly this reason — `ready.active_attempt` carries `bridged_at`
     * instead — and the dispatcher records the attempt as already-connected.
     */
    const view = await opened();
    await goAvailable(view);

    act(() =>
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'on_call',
        active_attempt: { ...ATTEMPT, bridged_at: '2026-08-11T10:00:04.000Z', state: 'bridged' },
      }),
    );

    expect(FakeAudioContext.cueContexts()[0]!.oscillators).toEqual([]);
    expect(cueEntries(view)).toHaveLength(0);
    // And the panel IS restored as live — silence here is not the panel failing.
    expect(view.result.current.station.live?.bridgedAt).toBe('2026-08-11T10:00:04.000Z');
  });

  it('falls a two-tone on release, and only for a call that actually connected', async () => {
    const view = await opened();
    await goAvailable(view);
    const ctx = FakeAudioContext.cueContexts()[0]!;

    // A reservation that never bridged, released: a cue for the end of a call that
    // never happened is a report of something that did not happen.
    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'no_answer',
        requires_disposition: false,
        message: 'Nobody picked up.',
      });
    });
    expect(ctx.oscillators.map((o) => o.hz)).toEqual([523, 523, 523]);

    // Now one that did connect. Disconnect FALLS.
    act(() => {
      latest().emit({ event: 'reserved', attempt: { ...ATTEMPT, attempt_id: 'att-2' } });
      latest().emit({
        event: 'bridged',
        attempt_id: 'att-2',
        bridged_at: '2026-08-11T10:02:00.000Z',
      });
      latest().emit({
        event: 'released',
        attempt_id: 'att-2',
        reason: 'remote_hangup',
        requires_disposition: true,
        message: 'The customer hung up.',
      });
    });
    expect(ctx.oscillators.slice(-2).map((o) => o.hz)).toEqual([660, 440]);
  });

  it('makes no sound before the user gesture, and does not pretend to', async () => {
    /**
     * Every browser refuses to produce sound from an `AudioContext` created outside
     * a user gesture, so the context is not created until "Go available". Before
     * that the sink reports itself inaudible and the dispatcher takes the visual
     * path — which is the honest outcome, not a silent drop.
     */
    const view = await opened();
    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({
        event: 'bridged',
        attempt_id: 'att-1',
        bridged_at: '2026-08-11T10:00:04.000Z',
      });
    });

    expect(FakeAudioContext.cueContexts()).toHaveLength(0);
    expect(view.result.current.connectFlashAttemptId).toBe('att-1');
    expect(cueEntries(view)[0]!.detail).toContain('escalated-visual');
  });

  it('escalates to the visual when the browser will not run the context', async () => {
    // A context that exists but stays `suspended` is the browser's real refusal,
    // and for that agent the flash is not redundancy — it is the entire channel.
    const view = await opened();
    await goAvailable(view);
    FakeAudioContext.cueContexts()[0]!.state = 'suspended';

    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({
        event: 'bridged',
        attempt_id: 'att-1',
        bridged_at: '2026-08-11T10:00:04.000Z',
      });
    });

    expect(FakeAudioContext.cueContexts()[0]!.oscillators).toEqual([]);
    expect(view.result.current.connectFlashAttemptId).toBe('att-1');
  });

  it('does not flash for an agent who can hear the cue', async () => {
    // An unconditional flash 200 times a day is the visual version of the haptics
    // defect: a mitigation firing for people who do not need it.
    const view = await opened();
    await goAvailable(view);

    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({
        event: 'bridged',
        attempt_id: 'att-1',
        bridged_at: '2026-08-11T10:00:04.000Z',
      });
    });

    expect(view.result.current.connectFlashAttemptId).toBeNull();
  });

  it('creates ONE context however many times the agent goes available', async () => {
    // Browsers cap `AudioContext`s per page, and an agent presses this control many
    // times a shift.
    const view = await opened();
    await goAvailable(view);
    await goAvailable(view);
    await goAvailable(view);

    expect(FakeAudioContext.cueContexts()).toHaveLength(1);
  });

  describe('a context the browser refused is retried, not kept for the shift', () => {
    /**
     * `unlock()` used to `return` whenever a context existed, and its doc claimed
     * idempotence "after the first success" — it was idempotent after the first
     * *attempt*. A gesture is necessary and not sufficient: a backgrounded tab, an
     * OS audio device change, or a click the browser has not yet counted all yield a
     * context stuck `suspended`. That context was then kept for the whole shift with
     * `audible()` false forever, so the cue subsystem degraded permanently to the
     * visual flash — safely, silently, and with nothing able to rescue it, because
     * the `resume()` behind the microphone banner lives in `useAudioCapture` and
     * touches the capture and playback contexts, never this one.
     */
    it('re-unlocks a suspended context on the next gesture and sounds again', async () => {
      const view = await opened();
      await goAvailable(view);
      // The CUE context, selected on its constructor signature — `goAvailable` also
      // warms the 16 kHz playback context, and indexing by creation order would read
      // whichever happened to be built first.
      const ctx = FakeAudioContext.cueContexts()[0]!;

      // The browser refused. Nothing plays, and the console escalates — correctly.
      ctx.state = 'suspended';
      act(() => {
        latest().emit({ event: 'reserved', attempt: ATTEMPT });
        latest().emit({
          event: 'bridged',
          attempt_id: 'att-1',
          bridged_at: '2026-08-11T10:00:04.000Z',
        });
      });
      expect(ctx.oscillators).toEqual([]);

      /**
       * The agent's next "Go available", later in the shift.
       *
       * The browser relents **in response to being asked again** — so the fake flips
       * to `running` inside `resume()` rather than before the click. Setting the state
       * up-front would be the test defeating itself: `unlock()` skips the warm-up on a
       * context that is already running, so it would pass with the retry deleted.
       */
      const askAgain = ctx.resume.bind(ctx);
      ctx.resume = () => {
        ctx.state = 'running';
        return askAgain();
      };
      await goAvailable(view);

      act(() => {
        latest().emit({ event: 'reserved', attempt: { ...ATTEMPT, attempt_id: 'att-2' } });
        latest().emit({
          event: 'bridged',
          attempt_id: 'att-2',
          bridged_at: '2026-08-11T10:02:00.000Z',
        });
      });

      // Audible again — and through the SAME context, because the per-page
      // `AudioContext` cap is real and a retry must reuse rather than allocate.
      expect(ctx.oscillators.map((o) => o.hz)).toEqual([523, 523, 523, 660, 990]);
      expect(FakeAudioContext.cueContexts()).toHaveLength(1);
      expect(ctx.resumes).toBeGreaterThan(1);
    });

    it('replaces a CLOSED context rather than resuming one that cannot recover', async () => {
      // `resume()` on a closed context rejects and can never come back, and a closed
      // context is not holding a slot — so this is the one case where allocating
      // another is right.
      const view = await opened();
      await goAvailable(view);
      FakeAudioContext.cueContexts()[0]!.state = 'closed';

      await goAvailable(view);

      expect(FakeAudioContext.cueContexts()).toHaveLength(2);
      expect(FakeAudioContext.cueContexts()[1]!.state).toBe('running');
    });

    it('does not warm up a context that is already running', async () => {
      // An agent presses this control many times a shift; a redundant silent buffer
      // per press is work for nothing.
      const view = await opened();
      await goAvailable(view);
      const cue = FakeAudioContext.cueContexts()[0]!;
      const resumesAfterFirst = cue.resumes;

      await goAvailable(view);
      await goAvailable(view);

      expect(cue.resumes).toBe(resumesAfterFirst);
    });
  });

  it('does not re-open the station socket when the console re-renders', async () => {
    /**
     * The structural hazard behind the whole wiring. The dispatcher is handed to
     * `useAgencyStation`, whose `handleFrame` depends on it, whose `connect`
     * depends on `handleFrame`, whose connect effect depends on `connect` — so a
     * dispatcher rebuilt per render would tear down and re-open the station socket
     * on every repaint of the console, re-minting a token each time and resetting
     * the dedupe sets that stop the cue re-firing.
     */
    const view = await opened();
    expect(FakeSocket.instances).toHaveLength(1);

    act(() => {
      view.rerender();
      view.rerender();
    });
    act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
    act(() => view.rerender());

    expect(FakeSocket.instances).toHaveLength(1);
    expect(mocks.mintStationToken).not.toHaveBeenCalled();
  });
});
