import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  createAgencySession: vi.fn(),
  mintStationToken: vi.fn(),
  setAgentAvailable: vi.fn(),
  setAgentBreak: vi.fn(),
  cancelQueuedBreak: vi.fn(),
  submitDisposition: vi.fn(),
  saveAttemptNotes: vi.fn(),
  hangupAttempt: vi.fn(),
  markContactDnc: vi.fn(),
  useTenant: vi.fn(),
}));
vi.mock('../../api/agency', () => mocks);
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 'u-1', display_name: 'Asha Kumar', email: 'asha@example.com', avatar_url: null },
  }),
}));

import AgentConsolePage from '../../pages/agency/AgentConsolePage';
import { AGENCY_PLAYBACK_JITTER_MS } from '../../hooks/useAgencyAudio';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';

/**
 * **The audio path, at the page.**
 *
 * Every agency call was dead air on both ends: the console never asked for the
 * microphone and never read the `media` frames the API was relaying to it. Nothing
 * errored — the panel populated, `bridged` arrived, the talk timer ran and the
 * call billed — which is precisely why it survived to a live shift.
 *
 * ── What this file can and cannot prove ─────────────────────────────────────
 * jsdom/happy-dom has no audio hardware, no real `AudioWorklet` and no real
 * resampler, so nothing here proves the *sound* is right. What it can prove, and
 * what a reviewer would otherwise have to take on faith, is the wiring: that
 * frames leave only while an attempt is bridged, in the envelope the API reads;
 * that mute stops them; that a blocked microphone produces a sentence the agent
 * can act on; and that every track is stopped when the call ends and when the
 * page goes away. The doubles below are therefore deliberately dumb — they
 * record what was asked of them and nothing else. A double clever enough to
 * simulate audio would be a second implementation to be wrong in.
 *
 * The assertion discipline is `AgentConsolePage.test.tsx`'s: drive real events,
 * assert observable consequences, never that a handler exists.
 */

// ── Web Audio + getUserMedia doubles ────────────────────────────────────────

/**
 * A microphone track. `stop()` is the thing teardown has to reach, and the
 * listener map is how a test can make the device disappear mid-call — the
 * browser fires `ended` on the track and there is no other signal.
 */
function fakeTrack(label = 'default') {
  const listeners = new Map<string, () => void>();
  return {
    kind: 'audio',
    label,
    enabled: true,
    stop: vi.fn(),
    addEventListener: (event: string, handler: () => void) => {
      listeners.set(event, handler);
    },
    /** Test driver: the OS took the device away. */
    unplug: () => listeners.get('ended')?.(),
  };
}

let tracks: ReturnType<typeof fakeTrack>[] = [];
let gumCalls: MediaStreamConstraints[] = [];
let gumResult: 'ok' | Error = 'ok';
/** The most recent worklet node, so a test can push a captured frame through. */
let worklet: FakeAudioWorkletNode | null = null;
/**
 * Every buffer source started **on the playback context** — i.e. every inbound
 * frame that actually reached the speaker.
 *
 * Scoped by role rather than counting every `createBufferSource().start()` on
 * the page, because it is not the only context that schedules one:
 * `createUnlockedAudioContext` (the cue unlock, from `useAgencyCues`) starts a
 * one-sample silent buffer to warm its own context. Counting that made "no
 * frame has been played" false the instant the agent pressed Go available.
 */
let played: number[] = [];
/** Every `FakeAudioContext` ever constructed, so teardown can be asserted. */
let contexts: FakeAudioContext[] = [];

/**
 * Hold `getUserMedia` open, the way the OS permission prompt does.
 *
 * Without this the suite could not reach the window between "the console asked
 * for the microphone" and "the microphone arrived" — every existing teardown
 * test unmounts *after* an awaited acquire has already published its refs, so
 * they all skip the one state in which `stop()` had nothing to stop.
 */
let gumMode: 'resolve' | 'hold' = 'resolve';
/**
 * Every held `getUserMedia`, so a test can leave *several* prompts outstanding
 * and answer them together. A single resolver could not express the case that
 * matters most — a second attempt reserved while the first prompt is still on
 * screen.
 */
let heldPrompts: Array<() => void> = [];

/**
 * Whether an `AudioContext` starts suspended, and whether `resume()` works.
 *
 * These model the autoplay policy, which is the only browser behaviour in this
 * feature that can silence a call while every other signal reports health. A
 * double hard-coded to `state = 'running'` — which this file used to be — makes
 * the entire failure mode structurally unrepresentable, so the console could
 * never have been shown to handle it.
 */
let audioStartsSuspended = false;
/**
 * The page's **sticky activation**: whether any user gesture has happened yet.
 *
 * `false` makes `resume()` a no-op, which is the browser's real refusal. It is
 * **monotonic** — one click grants it for the rest of the page's lifetime — so a
 * test may flip it `false → true` to model a click, and must never flip it back.
 * An earlier draft did flip it back to model "no further gestures", which is not
 * a state a browser can be in, and produced a failure that looked like a console
 * bug and was an artefact of the double.
 */
let stickyActivation = true;

/**
 * A `MessagePort` that **queues**, matching `useAudioCapture.test.ts`'s `FakePort`.
 *
 * This was a bare `{ onmessage: null }` slot, which drops anything posted before a
 * handler exists. That is not what the platform does — a `MessagePort` is disabled
 * until `onmessage` is assigned, and everything posted beforehand is queued and
 * then burst-delivered — and the gap between the two was the ringing-window defect
 * (~11 s of stale audio delivered the instant a call bridged). A dropping double
 * agrees with that bug, so the page-level "sends NOTHING while only reserved" case
 * below passed identically before and after the fix, for an unrelated reason.
 *
 * `emit()` stands in for the worklet's `postMessage`, so `speak()` exercises the
 * enable/queue mechanic rather than poking `onmessage?.()` directly.
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
    this.queue.splice(0).forEach((data) => next({ data }));
  }

  emit(data: ArrayBuffer): void {
    if (this.handler) this.handler({ data });
    else this.queue.push(data);
  }

  /** Frames sitting undelivered on the port. */
  get depth(): number {
    return this.queue.length;
  }
}

class FakeAudioWorkletNode {
  port = new FakePort();
  constructor() {
    worklet = this;
  }
  connect(): void {}
  disconnect(): void {}
}

class FakeAudioContext {
  state = audioStartsSuspended ? 'suspended' : 'running';
  currentTime = 0;
  destination = {};
  closed = false;
  audioWorklet = { addModule: vi.fn(async () => {}) };
  /**
   * Which hook built it.
   *
   * Both construct with `{ sampleRate: 16000 }`, so the constructor cannot tell
   * them apart — but their graphs can: only `useAudioCapture` calls
   * `createMediaStreamSource`, and only `useAudioPlayback` calls `createGain`.
   * Without this, "the playback context was created on the gesture" is
   * satisfied by the *capture* context and the assertion proves nothing; that
   * is exactly how it first passed against an implementation with the warm-up
   * deleted.
   */
  role: 'capture' | 'playback' | 'unknown' = 'unknown';

  constructor() {
    contexts.push(this);
  }
  createMediaStreamSource() {
    this.role = 'capture';
    return { connect: () => {} };
  }
  createAnalyser() {
    return { fftSize: 0, connect: () => {} };
  }
  createGain() {
    // `useAudioPlayback` is the only hook here that builds a gain node as part
    // of its main graph; the cue sink builds one per tone, but only while
    // actually playing a cue, which no test in this file does.
    if (this.role === 'unknown') this.role = 'playback';
    return {
      connect: () => {},
      gain: {
        value: 1,
        setValueAtTime: () => {},
        linearRampToValueAtTime: () => {},
      },
    };
  }
  createBuffer(_ch: number, length: number, rate: number) {
    return { duration: length / rate, getChannelData: () => new Float32Array(length) };
  }
  createBufferSource() {
    const owner = this;
    return {
      buffer: null as { duration: number } | null,
      connect: () => {},
      start: (at: number) => {
        if (owner.role === 'playback') played.push(at);
      },
      stop: () => {},
      onended: null,
    };
  }

  /**
   * Only the cue sink uses these. Present so that `useAgencyCues`' real
   * `WebAudioCueSink` can run against this double — it shares the page's
   * `window.AudioContext`, so a stub missing them throws out of the connect cue
   * and fails tests that have nothing to do with cues.
   */
  createOscillator() {
    return {
      type: 'sine',
      frequency: { value: 0 },
      connect: () => {},
      start: () => {},
      stop: () => {},
    };
  }
  async close() {
    this.closed = true;
  }
  /**
   * Succeeds only when the page has sticky activation, exactly like the real
   * thing. A `resume()` that always worked would make every suspended-context
   * test pass for free and prove nothing about where the gesture is.
   */
  async resume() {
    if (stickyActivation) this.state = 'running';
  }
}

/** One 20ms frame of PCM16 — 320 samples, the shape the real worklet emits. */
function capturedFrame(): ArrayBuffer {
  return new Int16Array(320).buffer;
}

/**
 * The 640 zero bytes a silent 20 ms PCM16 frame decodes to.
 *
 * **Written as `'\0'`, an escape sequence — never as a literal NUL byte.** An
 * earlier revision of this file embedded five raw `0x00` bytes inside string
 * literals, which makes the file *binary* to `grep` and `ripgrep`: both classify
 * it and skip it silently, so this test file was invisible to every codebase
 * search. It took a byte-level read to find.
 *
 * The value has to stay NUL rather than becoming a printable filler: the capture
 * assertion compares against `new Int16Array(320)`, which is 640 zero bytes, so
 * a space would be a different string and the test would be asserting the wrong
 * encoding. Naming it once removes both the ambiguity and the repetition.
 */
const SILENT_FRAME_BYTES = '\0'.repeat(640);

// ── Station socket double ───────────────────────────────────────────────────

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
  send(data: string): void {
    this.sent.push(data);
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

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

/** Frames the console put on the wire as audio, in the API's envelope. */
function mediaFrames(): string[] {
  return latest()
    .sent.filter((raw) => (JSON.parse(raw) as { event: string }).event === 'media')
    .map((raw) => (JSON.parse(raw) as { media: { payload: string } }).media.payload);
}

const ATTEMPT: AgencyReservedAttempt = {
  attempt_id: 'att-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  contact_id: 'c-1',
  phone_e164: '+919876543210',
  caller_id: '+911234567890',
  attempt_number: 1,
  context: { 'First Name': 'Asha' },
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
  disposition_catalog: [{ code: 'sale', label: 'Sale' }],
  wrapup_seconds: 30,
  wrapup_auto_return: true,
  record_calls: false,
  break_reasons: [{ code: 'lunch', label: 'Lunch' }],
  context_display: {},
  intervals: {
    heartbeat_ms: 10_000,
    heartbeat_grace_ms: 30_000,
    reservation_lease_ms: 10_000,
    countdown_ms: 3000,
  },
};

beforeEach(() => {
  FakeSocket.instances = [];
  tracks = [];
  gumCalls = [];
  gumResult = 'ok';
  gumMode = 'resolve';
  heldPrompts = [];
  worklet = null;
  played = [];
  contexts = [];
  audioStartsSuspended = false;
  stickyActivation = true;
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'tenant_owner',
  });
  mocks.createAgencySession.mockResolvedValue(BOOTSTRAP);
  mocks.setAgentAvailable.mockResolvedValue(undefined);
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });

  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode as unknown as typeof AudioWorkletNode);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: vi.fn(async (constraints: MediaStreamConstraints) => {
        gumCalls.push(constraints);
        if (gumMode === 'hold') {
          // The OS prompt is on screen. Nothing resolves until `answerPrompt()`.
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
  // Explicit: Testing Library's auto-cleanup does not run in this repo (Vitest
  // is configured without `globals`, so RTL's `typeof afterEach === 'function'`
  // guard never fires). A page left mounted keeps a station socket and its
  // heartbeat interval alive into the next test.
  cleanup();
  vi.unstubAllGlobals();
  // @ts-expect-error — removing the property we defined above.
  delete navigator.mediaDevices;
});

async function mounted() {
  const view = render(
    <MemoryRouter initialEntries={['/station?campaign=camp-1']}>
      <AgentConsolePage />
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    latest().open();
  });
  return view;
}

/** Reserved — panel up, carrier still ringing. The microphone arms here. */
async function reserved() {
  const view = await mounted();
  await act(async () => {
    latest().emit({ event: 'reserved', attempt: ATTEMPT });
    latest().emit({ event: 'agent_state', state: 'reserved', since: '2026-08-11T10:00:00.000Z' });
  });
  return view;
}

/** Bridged — audio is flowing to this agent's socket. The uplink opens here. */
async function onCall() {
  const view = await reserved();
  await act(async () => {
    latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04.000Z' });
    latest().emit({ event: 'agent_state', state: 'on_call', since: '2026-08-11T10:00:04.000Z' });
  });
  // The uplink attaches through an awaited `start()`, so let it settle.
  await act(async () => {});
  return view;
}

/** Push one captured frame through the worklet port, as the real one would. */
function speak() {
  act(() => {
    worklet?.port.emit(capturedFrame());
  });
}

/** Frames the port is holding undelivered — must always be 0 (see `FakePort`). */
function queuedFrames(): number {
  return worklet?.port.depth ?? 0;
}

describe('the microphone is armed on reservation, not on connect', () => {
  it('acquires the microphone when the attempt appears', async () => {
    // ~4s before the customer can answer. Acquiring at `bridged` instead puts
    // `getUserMedia` on the critical path of somebody saying "hello" and clips
    // the first word of every call.
    await reserved();
    expect(gumCalls).toHaveLength(1);
  });

  it('sends NOTHING while the attempt is only reserved', async () => {
    /**
     * The gate that matters most. The API drops browser media until its PSTN leg is
     * live, so an early frame is not audible anywhere — but "the server discards
     * it" is not the reason to send it, and a console that streams from
     * reservation is streaming a room the customer has not joined.
     */
    await reserved();
    speak();
    speak();
    expect(mediaFrames()).toEqual([]);

    /**
     * **And they were DROPPED, not queued** — the half this case used to miss.
     *
     * "Nothing reached the socket" is satisfied both by dropping the frames and by
     * holding them on a disabled port to burst-deliver the moment the uplink
     * opens, and the second is the ringing-window defect: the port stayed disabled
     * until `start()` assigned `onmessage`, so the whole ring accumulated and
     * arrived at once when the customer answered. Staging measured 565 surplus
     * frames against an 11.38 s ring.
     *
     * Asserting the port depth is what separates the two, and it is only
     * assertable because `FakePort` now models the queue.
     */
    expect(queuedFrames()).toBe(0);
  });

  it('opening the uplink delivers nothing that accumulated while reserved', async () => {
    // The burst, end to end at the page level: a ringing window's worth of frames
    // produced while only reserved, then the bridge. The socket must see the
    // frames that follow the bridge and none of the ones that preceded it.
    //
    // Deliberately NOT `reserved()` then `onCall()` — `onCall()` calls
    // `reserved()`, which calls `mounted()`, so that sequence renders a SECOND
    // console and `worklet` follows the new node. The queued frames would sit on
    // the discarded one and the test would pass against the burst it is meant to
    // catch. One mount, driven by hand.
    await mounted();
    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'agent_state', state: 'reserved', since: '2026-08-11T10:00:00.000Z' });
    });

    for (let i = 0; i < 200; i++) speak();
    expect(mediaFrames()).toEqual([]);
    expect(queuedFrames()).toBe(0);

    await act(async () => {
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04.000Z' });
      latest().emit({ event: 'agent_state', state: 'on_call', since: '2026-08-11T10:00:04.000Z' });
    });
    await act(async () => {});

    // Opening the uplink must deliver none of the 200.
    expect(mediaFrames()).toEqual([]);

    // And from here it runs at real time.
    speak();
    expect(mediaFrames()).toHaveLength(1);
  });

  it('does not hold the microphone open before an attempt arrives', async () => {
    // Idle station: no call, no reservation. A recording indicator lit through
    // an agent's whole shift is a different product than the one we shipped.
    await mounted();
    expect(gumCalls).toHaveLength(0);
  });
});

describe('the uplink opens on `bridged` and carries the API’s envelope', () => {
  it('puts captured audio on the socket once bridged', async () => {
    await onCall();
    speak();

    const frames = mediaFrames();
    expect(frames).toHaveLength(1);
    // 320 zeroed samples → 640 zero bytes → 856 base64 'A's with padding. The
    // encoding is asserted as a value rather than by round-tripping our own
    // encoder, which would only prove the encoder agrees with itself.
    expect(frames[0]).toBe(btoa(SILENT_FRAME_BYTES));
  });

  it('writes the frame shape the API’s reader accepts, exactly', async () => {
    // The bridge reader inspects `event` and `media.payload` and
    // nothing else. Asserting the raw JSON catches a renamed key that a
    // payload-only assertion would sail past.
    await onCall();
    speak();

    const raw = latest().sent.find((s) => s.includes('"media"'))!;
    expect(JSON.parse(raw)).toEqual({ event: 'media', media: { payload: expect.any(String) } });
  });

  it('stops sending when the call is released', async () => {
    await onCall();
    speak();
    const during = mediaFrames().length;
    expect(during).toBeGreaterThan(0);

    await act(async () => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'completed',
        requires_disposition: true,
        message: 'Call ended.',
      });
    });
    speak();

    expect(mediaFrames()).toHaveLength(during);
  });

  it('releases the microphone at the end of the call, not at the end of wrap-up', async () => {
    /**
     * `released` with `requires_disposition` keeps the *panel* up so the agent
     * can write the outcome down — it does not keep the *call* up. A console
     * that tore down on `agent_state` leaving `wrapup` instead would hold the
     * microphone open while the agent types a note about a customer who hung up
     * thirty seconds ago.
     */
    await onCall();
    expect(tracks).toHaveLength(1);

    await act(async () => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'completed',
        requires_disposition: true,
        message: 'Call ended.',
      });
    });

    expect(tracks[0]!.stop).toHaveBeenCalled();
  });
});

describe('inbound audio reaches playback instead of the diagnostic sink', () => {
  it('schedules every media frame the API relays', async () => {
    await onCall();
    await act(async () => {
      latest().emit({ event: 'media', media: { payload: btoa(SILENT_FRAME_BYTES) } });
      latest().emit({ event: 'media', media: { payload: btoa(SILENT_FRAME_BYTES) } });
    });
    expect(played).toHaveLength(2);
  });

  it('opens the stream with a jitter cushion rather than at once', async () => {
    /**
     * The first frame lands at `currentTime + AGENCY_PLAYBACK_JITTER_MS`, not at
     * `currentTime`. Without it the schedule sits exactly at the playhead, so
     * the first WebSocket hiccup pushes it into the past and every subsequent
     * frame re-bases — which is continuous clicking, not a conversation.
     *
     * Asserted as a number the AI-call path deliberately does NOT get: that
     * stream is server-paced TTS on a direct socket where added latency is pure
     * cost, and its `jitterMs` stays 0.
     */
    await onCall();
    await act(async () => {
      latest().emit({ event: 'media', media: { payload: btoa(SILENT_FRAME_BYTES) } });
    });
    expect(played[0]).toBeCloseTo(AGENCY_PLAYBACK_JITTER_MS / 1000, 6);
  });

  it('schedules the second frame after the first rather than on top of it', async () => {
    // Contiguity, not a jitter measurement: two frames both scheduled at the same
    // instant is the symptom of a schedule that re-bases on every frame, which
    // sounds like clicking rather than like a conversation.
    await onCall();
    await act(async () => {
      latest().emit({ event: 'media', media: { payload: btoa(SILENT_FRAME_BYTES) } });
      latest().emit({ event: 'media', media: { payload: btoa(SILENT_FRAME_BYTES) } });
    });
    expect(played[1]).toBeGreaterThan(played[0]!);
  });
});

describe('mute', () => {
  it('stays inert through the reserved window and enables only on bridged', async () => {
    /**
     * **Three states, because one cannot tell the implementations apart.**
     *
     * The earlier version asserted `disabled` on an idle console and nothing
     * else. That passes identically against `disabled={!live}`,
     * `disabled={!bridged}`, and a hard-coded `disabled` — none of which is the
     * stated property, which is that the control tracks the *uplink*.
     *
     * The reserved row is the one that discriminates: `live` is set and
     * `bridged` is not, so a `!live` implementation would enable a Mute button
     * while the carrier is still ringing — offering the agent a control over
     * audio that is not flowing yet.
     */
    const view = await mounted();
    expect(screen.getByTestId('mute-toggle').hasAttribute('disabled')).toBe(true);

    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
    });
    expect(screen.getByTestId('mute-toggle').hasAttribute('disabled')).toBe(true);

    await act(async () => {
      latest().emit({
        event: 'bridged',
        attempt_id: 'att-1',
        bridged_at: '2026-08-11T10:00:04.000Z',
      });
    });
    await act(async () => {});
    expect(screen.getByTestId('mute-toggle').hasAttribute('disabled')).toBe(false);

    view.unmount();
  });

  it('stops outbound audio, and unmuting resumes it', async () => {
    await onCall();
    const toggle = screen.getByTestId('mute-toggle');
    expect(toggle.hasAttribute('disabled')).toBe(false);

    speak();
    expect(mediaFrames()).toHaveLength(1);

    act(() => {
      fireEvent.click(toggle);
    });
    speak();
    speak();
    // Not one frame more. A mute that only disables the track still ships silent
    // frames, and a "muted" that depends on the browser honouring `enabled` is
    // not a promise we can make to a customer.
    expect(mediaFrames()).toHaveLength(1);

    act(() => {
      fireEvent.click(screen.getByTestId('mute-toggle'));
    });
    speak();
    expect(mediaFrames()).toHaveLength(2);
  });

  it('disables the track at the source as well as gating the sink', async () => {
    // The other half: the OS recording indicator must reflect what we told the
    // agent. Gating only the sink leaves the microphone hot while the console
    // says "Muted".
    await onCall();
    act(() => {
      fireEvent.click(screen.getByTestId('mute-toggle'));
    });
    expect(tracks[0]!.enabled).toBe(false);
  });

  it('shows the state in the header, not only on the control', async () => {
    // An agent who has to look at a toggle to find out whether they are audible
    // will not look.
    await onCall();
    expect(screen.queryByTestId('muted-pill')).toBeNull();
    act(() => {
      fireEvent.click(screen.getByTestId('mute-toggle'));
    });
    expect(screen.getByTestId('muted-pill')).toBeTruthy();
  });

  it('does not carry a mute into the next customer’s call', async () => {
    /**
     * Both directions are defensible; the tie breaks on which failure is worse.
     * A mute that survives the call means the next customer gets dead air from a
     * control pressed for the previous one — this feature's own bug, re-created
     * by a toggle.
     */
    await onCall();
    act(() => {
      fireEvent.click(screen.getByTestId('mute-toggle'));
    });
    expect(screen.getByTestId('muted-pill')).toBeTruthy();

    await act(async () => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'completed',
        requires_disposition: false,
        message: 'Call ended.',
      });
    });

    expect(screen.queryByTestId('muted-pill')).toBeNull();
  });
});

describe('a microphone that will not open is stated, not left as silence', () => {
  it('names the blockage and the remedy when permission is denied', async () => {
    const denied = new Error('denied');
    denied.name = 'NotAllowedError';
    gumResult = denied;

    await reserved();

    const banner = await screen.findByTestId('mic-failure');
    expect(banner.textContent).toContain('blocked');
    // The remedy is the half that makes it actionable — "audio capture failed"
    // tells the agent nothing they can do.
    expect(banner.textContent).toContain('Allow microphone access');
    // And it says what the customer is experiencing, which is the fact the
    // agent needs in order to decide whether to keep talking.
    expect(banner.textContent).toContain('cannot hear you');
    /**
     * **No in-banner button here.** The recovery control exists for exactly one
     * failure — a suspended `AudioContext`, which any gesture lifts — and a
     * blocked permission is not one a click can fix. Offering one would be a
     * promise the console cannot keep: the agent presses it, nothing changes,
     * and they learn to distrust the banner that is telling them the truth.
     */
    expect(screen.queryByTestId('mic-resume')).toBeNull();
  });

  it('interrupts — this is the one console failure with no other symptom', async () => {
    const denied = new Error('denied');
    denied.name = 'NotAllowedError';
    gumResult = denied;

    await reserved();

    const banner = await screen.findByTestId('mic-failure');
    expect(banner.getAttribute('role')).toBe('alert');
  });

  it('distinguishes no-device from blocked, because the remedies differ', async () => {
    const missing = new Error('none');
    missing.name = 'NotFoundError';
    gumResult = missing;

    await reserved();

    const banner = await screen.findByTestId('mic-failure');
    expect(banner.textContent).toContain('No microphone was found');
    expect(banner.textContent).toContain('Plug in your headset');
  });

  it('surfaces the failure at pre-flight, before a customer is on the line', async () => {
    /**
     * "Go available" is the shift's one reliable user gesture with nobody on the
     * call. Discovering a blocked microphone there costs the agent a minute;
     * discovering it at `bridged` costs a customer a conversation.
     */
    const denied = new Error('denied');
    denied.name = 'NotAllowedError';
    gumResult = denied;

    await mounted();
    act(() => {
      fireEvent.keyDown(document, { key: 'a' });
    });

    const banner = await screen.findByTestId('mic-failure');
    expect(banner.textContent).toContain('blocked');
    // And no attempt was ever reserved — the point is that this happened early.
    expect(screen.queryByText('+919876543210')).toBeNull();
  });

  it('holds no microphone open after a successful pre-flight', async () => {
    // A probe, not an arm. The permission prompt is moved off the moment a
    // customer answers; the microphone is not.
    await mounted();
    await act(async () => {
      fireEvent.keyDown(document, { key: 'a' });
    });

    expect(gumCalls).toHaveLength(1);
    await waitFor(() => expect(tracks[0]!.stop).toHaveBeenCalled());
  });

  /**
   * **DELETED: `'sends nothing when the microphone never opened'`.**
   *
   * It asserted `mediaFrames()` was empty on a run where `getUserMedia` had
   * rejected — so no `AudioWorkletNode` was ever constructed, `speak()` was
   * never called, and nothing could have produced a frame under any
   * implementation. It was vacuously true and would have survived deleting
   * every gate in `sync()`. Its only load-bearing half was the banner, which
   * the three cases above already assert against real copy.
   *
   * A test that cannot fail is worse than no test: it occupies the space where
   * the real one would go and reports green from it.
   */

  it('does not claim to be sending when the microphone never opened', async () => {
    // What the deleted test was reaching for, asserted where it can actually
    // fail: `sending` gates the Mute control, so a console that flipped it on a
    // failed acquire would offer a mute over an uplink that does not exist.
    const denied = new Error('denied');
    denied.name = 'NotAllowedError';
    gumResult = denied;

    await onCall();

    expect(screen.getByTestId('mute-toggle').hasAttribute('disabled')).toBe(true);
    expect(screen.getByTestId('mic-failure')).toBeTruthy();
  });

  it('tells the agent when the headset is unplugged mid-conversation', async () => {
    /**
     * The failure with the sharpest consequence and the least warning: the call
     * is up, the timer is running, the customer is mid-sentence, and the agent's
     * microphone simply stopped existing. `getUserMedia` already resolved, so
     * there is no promise left to reject — the browser's only signal is `ended`
     * on the track.
     *
     * This is the one path that made `AudioCaptureError.kind: 'device_lost'`
     * reachable; without a test it was a case in a switch statement nobody had
     * ever run.
     */
    await onCall();
    expect(screen.queryByTestId('mic-failure')).toBeNull();

    act(() => {
      tracks[0]!.unplug();
    });

    const banner = await screen.findByTestId('mic-failure');
    expect(banner.textContent).toContain('disconnected');
    expect(banner.textContent).toContain('Reconnect your headset');
  });

  it('does not report a device failure when WE stopped the track', async () => {
    // `stop()` can fire `ended` in some implementations. An unguarded listener
    // would post "your microphone disconnected" at the end of every single call.
    await onCall();
    await act(async () => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'completed',
        requires_disposition: false,
        message: 'Call ended.',
      });
    });
    act(() => {
      tracks[0]!.unplug();
    });

    expect(screen.queryByTestId('mic-failure')).toBeNull();
  });

  it('offers no mute when there is no uplink to mute', async () => {
    const denied = new Error('denied');
    denied.name = 'NotAllowedError';
    gumResult = denied;

    await onCall();
    expect(screen.getByTestId('mute-toggle').hasAttribute('disabled')).toBe(true);
  });
});

describe('teardown', () => {
  it('stops every microphone track when the console unmounts mid-call', async () => {
    /**
     * The leak with a visible symptom: a `MediaStream` track that outlives the
     * page keeps the browser's recording indicator lit after the agent has
     * navigated away, with no call and no console to explain it.
     */
    const view = await onCall();
    expect(tracks).toHaveLength(1);

    view.unmount();

    tracks.forEach((track) => expect(track.stop).toHaveBeenCalled());
  });

  it('sends nothing after unmount, even if a captured frame is still in flight', async () => {
    // The worklet port is asynchronous: a frame produced before teardown can be
    // delivered after it.
    const view = await onCall();
    const before = mediaFrames().length;
    const port = worklet!.port;

    view.unmount();
    act(() => {
      port.onmessage?.({ data: capturedFrame() });
    });

    expect(mediaFrames()).toHaveLength(before);
  });
});

describe('a teardown that lands while the permission prompt is still open', () => {
  /**
   * **The window between asking for the microphone and getting it.**
   *
   * `acquire()` cannot publish anything until `getUserMedia` *and*
   * `audioWorklet.addModule` have both resolved, so for that entire span the
   * three refs `stop()` reads are all `null` and `stop()` is a no-op. Whatever
   * resolves afterwards lands in a hook nobody is reading — a live track with no
   * remaining reference and no code path that can ever stop it. The browser's
   * recording indicator stays lit until the tab is closed.
   *
   * Every other teardown test in this file unmounts *after* an awaited acquire,
   * so none of them enters this window. Arming on `reserved` means production
   * enters it on every single call, for as long as the OS prompt is on screen.
   */
  async function reservedWithPromptOpen() {
    gumMode = 'hold';
    const view = await mounted();
    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
    });
    // Asked for, not yet granted.
    expect(gumCalls).toHaveLength(1);
    expect(tracks).toHaveLength(0);
    return view;
  }

  /** The agent answers the OS prompt — after the console has given up. */
  async function answerPrompt() {
    await act(async () => {
      heldPrompts.splice(0).forEach((resolve) => resolve());
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  it('stops a stream that arrives after the console unmounted', async () => {
    const view = await reservedWithPromptOpen();

    view.unmount();
    await answerPrompt();

    // The track exists — the browser granted it — so the only question is
    // whether anything still holds it. Asserting `tracks` is non-empty first,
    // because a run where the grant never happened would pass the `stop`
    // assertion vacuously.
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.stop).toHaveBeenCalled();
  });

  it('stops a stream that arrives after the attempt was released', async () => {
    // The realistic version: no-answer, busy, or a lease expiry inside the four
    // seconds the mic is arming. Nobody navigated anywhere; the agent is simply
    // back to waiting, and without the fix their microphone is still on.
    const view = await reservedWithPromptOpen();

    await act(async () => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'no_answer',
        requires_disposition: false,
        message: 'Nobody picked up.',
      });
    });
    await answerPrompt();

    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.stop).toHaveBeenCalled();

    view.unmount();
  });

  it('closes the AudioContext built around a cancelled stream', async () => {
    // The stream is the visible half; the context is the one that silently
    // accumulates. A browser caps them per page, so a shift of released-while-
    // arming attempts would eventually refuse to create any more.
    const view = await reservedWithPromptOpen();

    view.unmount();
    await answerPrompt();

    const captureContexts = contexts.filter((c) => !c.closed);
    expect(captureContexts).toEqual([]);
  });

  it('re-acquires for a new attempt reserved while the prompt is still open', async () => {
    /**
     * The case `prepare()`'s in-flight memo gets wrong on its own.
     *
     * `prepare()` returns the promise already in flight so concurrent callers
     * share one `getUserMedia`. When `stop()` cancels that acquire, the promise
     * is still sitting in `preparingRef` and is still *pending* — the OS prompt
     * has not been answered. A new `reserved` landing in that window is handed
     * the cancelled promise, waits on it, and gets a resolution that
     * deliberately published nothing. The second customer's microphone is never
     * acquired, silently, and no further attempt in the shift can recover it
     * because the same stale promise keeps being returned.
     *
     * Distinct from the sibling below, where the prompt is answered before the
     * next reservation and `prepare()`'s own `finally` has already cleared the
     * memo — which is why that one passes with or without the clear in `stop()`.
     */
    gumMode = 'hold';
    const view = await mounted();
    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
    });
    expect(gumCalls).toHaveLength(1);

    // Released and immediately re-reserved, both while the prompt is still up.
    await act(async () => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'no_answer',
        requires_disposition: false,
        message: 'Nobody picked up.',
      });
      latest().emit({ event: 'reserved', attempt: { ...ATTEMPT, attempt_id: 'att-2' } });
    });

    // The second attempt asked for its own microphone rather than inheriting a
    // promise that had already been abandoned.
    expect(gumCalls).toHaveLength(2);

    await answerPrompt();
    view.unmount();
  });

  it('re-acquires on the next attempt rather than awaiting the cancelled one', async () => {
    /**
     * The second half of the cancellation, and easy to get wrong: `prepare()`
     * memoises the in-flight promise, so a `stop()` that cancels without also
     * clearing it leaves the *next* `prepare()` awaiting a promise that has
     * already been abandoned. The microphone would then never open again for
     * the rest of the shift, silently, after one badly-timed release.
     */
    const view = await reservedWithPromptOpen();

    await act(async () => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'no_answer',
        requires_disposition: false,
        message: 'Nobody picked up.',
      });
    });
    await answerPrompt();

    // Next customer. The prompt is answered immediately this time.
    gumMode = 'resolve';
    await act(async () => {
      latest().emit({
        event: 'reserved',
        attempt: { ...ATTEMPT, attempt_id: 'att-2' },
      });
    });
    await act(async () => {});

    expect(gumCalls).toHaveLength(2);
    expect(tracks).toHaveLength(2);

    view.unmount();
  });
});

describe('a station that is never coming back releases the microphone', () => {
  /**
   * `live` is cleared by `released` and by nothing else. A terminal close —
   * 4409 when the agent opens the console in a second tab, 4404 when the session
   * is gone — sets `connection` and returns, leaving `live` in place. The page
   * renders a message rather than unmounting, so nothing re-runs the audio gate
   * and the microphone stays open for as long as the tab exists, with Mute the
   * only control on offer and Mute does not release a device.
   */
  it.each([
    ['superseded by another window', 4409],
    ['session gone', 4404],
  ])('releases it on %s', async (_label, code) => {
    const view = await onCall();
    expect(tracks).toHaveLength(1);
    expect(tracks[0]!.stop).not.toHaveBeenCalled();

    await act(async () => {
      latest().onclose?.({ code, reason: '' });
    });

    expect(tracks[0]!.stop).toHaveBeenCalled();

    view.unmount();
  });

  it('keeps it through an ordinary reconnect, which is recoverable', async () => {
    // The distinction that matters: a wifi blip is what `sendMedia`'s socket-ref
    // read exists to survive. Dropping the device there would turn a gap the
    // agent never notices into a permission re-prompt mid-conversation.
    mocks.mintStationToken.mockResolvedValue({
      session_id: 'sess-1',
      station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
      expires_at: 'x',
    });
    const view = await onCall();

    await act(async () => {
      latest().onclose?.({ code: 1006, reason: '' });
    });

    expect(tracks[0]!.stop).not.toHaveBeenCalled();

    view.unmount();
  });

  it('releases it when the reconnect says the call ended while we were away', async () => {
    /**
     * **The rest of the story the test above starts, and the case that shipped
     * broken.** The blip is recoverable and the microphone is rightly kept — but
     * only until the API answers, and the API's answer here is that the call is over.
     *
     * The API sends `missed_release` **exactly** when it holds no attempt
     * (in the station route) and only when the `released` frame could not be
     * delivered (the dialer's `if (!delivered)` branch) — which is precisely the
     * state this test is in: `live` still set from before the drop. `ready` used to
     * apply its fields only when present, so `live` survived a frame whose whole
     * meaning was that it should not: the `audio.sync` effect keys on
     * `live?.attempt.attempt_id`, so the device stayed open with the browser's
     * recording indicator lit and `sending: true`, for a call that had ended.
     *
     * Driven through a **real** reconnect — close, backoff, token mint, new socket —
     * rather than by emitting `ready` onto the old one, because "which socket
     * delivered it" is the only thing that distinguishes this path from a fresh
     * page load, and the fresh-load path is the one the existing coverage already
     * had.
     */
    mocks.mintStationToken.mockResolvedValue({
      session_id: 'sess-1',
      station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
      expires_at: 'x',
    });
    const view = await onCall();
    const socketsBefore = FakeSocket.instances.length;

    await act(async () => {
      latest().onclose?.({ code: 1006, reason: '' });
    });
    // Still held: the blip alone is not evidence the call is over.
    expect(tracks[0]!.stop).not.toHaveBeenCalled();

    // The reconnect actually happens — new socket, fresh token.
    await waitFor(() => expect(FakeSocket.instances.length).toBe(socketsBefore + 1), {
      timeout: 3000,
    });
    await act(async () => {
      latest().open();
    });
    await act(async () => {
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'available',
        missed_release: {
          attempt_id: 'att-1',
          reason: 'remote_hangup',
          requires_disposition: true,
          message: 'The customer hung up.',
          ended_at: '2026-08-11T10:04:00.000Z',
        },
      });
    });

    // The device is released. Nothing in the console had to be changed for this —
    // the audio gate already derives from `live`; it was `live` that was wrong.
    expect(tracks[0]!.stop).toHaveBeenCalled();
    // And the agent is finally told what happened. `panelAttempt` stayed truthy
    // while `live` survived, which suppressed the only component that renders this
    // — so the notice the API had already consumed on read was destroyed, not delayed.
    expect(screen.getByTestId('missed-release').textContent).toContain(
      'While you were disconnected',
    );

    view.unmount();
  });
});

describe('a browser that suspends the audio graph says so', () => {
  /**
   * **The mid-call reload, and the worst failure this feature can produce.**
   *
   * `ready.active_attempt` rehydrates a bridged attempt and the API deliberately
   * does not re-emit `bridged`, so a reload lands the console straight back into
   * a live call. On a fresh page load with no user gesture, `getUserMedia`
   * resolves from the persisted permission — but both `AudioContext`s come up
   * `suspended`, which means the capture worklet never runs and every playback
   * buffer is scheduled onto a stopped timeline.
   *
   * Everything else reports health: talk timer running, connection pill green,
   * Mute enabled, no error. The agent can neither hear nor be heard and has no
   * way to find out except by asking the customer.
   */
  async function reloadedMidCall() {
    audioStartsSuspended = true;
    stickyActivation = false;

    const view = await mounted();
    await act(async () => {
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'on_call',
        active_attempt: { ...ATTEMPT, bridged_at: '2026-08-11T10:00:04.000Z' },
      });
    });
    await act(async () => {});
    return view;
  }

  it('surfaces a banner rather than a silent call', async () => {
    const view = await reloadedMidCall();

    const banner = await screen.findByTestId('mic-failure');
    expect(banner.textContent).toContain('paused by your browser');
    // Both directions, because a suspended context breaks both.
    expect(banner.textContent).toContain('hear or be heard');

    view.unmount();
  });

  it('does not tell the agent to reload — reloading is what caused it', async () => {
    /**
     * The remedy has to be reachable from where the agent is, mid-call. Every
     * other notice in `agencyAudioCopy` ends by *instructing* a reload
     * ("then reload", "Reload the console"), and here that instruction would
     * re-create the exact state it is meant to fix.
     *
     * Matched against the instruction forms rather than the bare word: this copy
     * legitimately *names* a reload as the cause ("This happens after a
     * reload"), and a blanket `/reload/i` cannot tell a diagnosis from an
     * order — it failed on the correct copy first time round.
     */
    const view = await reloadedMidCall();

    const banner = await screen.findByTestId('mic-failure');
    expect(banner.textContent).not.toMatch(/then reload/i);
    expect(banner.textContent).not.toMatch(/reload the console/i);
    // The positive form, so this cannot pass on an empty banner.
    expect(banner.textContent).toContain('Turn audio back on');

    view.unmount();
  });

  it('offers a control that is itself the fix', async () => {
    /**
     * The banner carries a button because a user gesture is the only thing that
     * lifts the policy — so the click that acknowledges the message is the click
     * that repairs it. `stickyActivation` flips to `true` to model exactly that:
     * before the click the page has no sticky activation, after it the browser
     * honours `resume()`.
     */
    const view = await reloadedMidCall();
    const button = await screen.findByTestId('mic-resume');

    stickyActivation = true;
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => expect(screen.queryByTestId('mic-failure')).toBeNull());
    // And it actually ran the graph, rather than only hiding the message.
    expect(contexts.every((c) => c.closed || c.state === 'running')).toBe(true);

    view.unmount();
  });

  it('keeps the banner up when the resume is still refused', async () => {
    // A message that clears itself on a click that changed nothing is worse than
    // no message: the agent concludes the problem is fixed and keeps talking.
    const view = await reloadedMidCall();
    const button = await screen.findByTestId('mic-resume');

    await act(async () => {
      fireEvent.click(button);
    });

    expect(screen.getByTestId('mic-failure')).toBeTruthy();

    view.unmount();
  });

  /**
   * **DELETED: `'offers no such banner when the pre-flight gesture warmed the
   * contexts'`.**
   *
   * It set up a page that had a gesture and then revoked it, so that a console
   * which built its playback context later would find one it could not resume.
   * Browsers do not work that way: sticky activation is granted once per page
   * load and never taken back, so after "Go available" every later `resume()`
   * succeeds whether or not the warm-up exists. Modelled correctly, the test
   * could not tell the two implementations apart — and modelled incorrectly it
   * failed against the *right* code.
   *
   * The warm-up is still pinned, by the test below, on the property that is
   * actually true of it: the playback context exists after the gesture and
   * before any frame. Its remaining value is defence-in-depth and consistency
   * with `useBrowserCall`/`useWebRtcCall`, which is stated rather than
   * over-claimed.
   */

  it('creates the PLAYBACK context on the gesture, not on the first frame', async () => {
    /**
     * `useBrowserCall` and `useWebRtcCall` both call `warmup()` from their click
     * handlers and both say why. The agency console has no "Call" button, so
     * "Go available" carries it — and if it does not, the playback context is
     * first constructed inside a WebSocket `onmessage`, which is by definition
     * not a gesture.
     *
     * Asserted on `role === 'playback'` and not on `contexts.length`: the
     * microphone probe builds a *capture* context on the same click, so a bare
     * count is satisfied whether or not the warm-up exists at all. It was, and
     * the test passed against an implementation with the warm-up removed.
     */
    const view = await mounted();
    expect(contexts).toHaveLength(0);

    await act(async () => {
      fireEvent.keyDown(document, { key: 'a' });
    });
    await act(async () => {});

    expect(contexts.filter((c) => c.role === 'playback')).toHaveLength(1);
    // No frame has arrived, so nothing could have built it from a socket handler.
    expect(played).toEqual([]);

    view.unmount();
  });
});

describe('a blocked pre-flight leaves a banner the agent can actually clear', () => {
  /**
   * **`audioStartsSuspended` combined with the pre-flight gesture — the one
   * combination this file did not have, and the one that reproduces a dead
   * button.**
   *
   * `preflight()` is `prepare().then(() => capture.stop())` by construction: a
   * probe, not an arm. So on a browser that will not run the capture context,
   * the probe sets `audio_blocked` and then immediately closes the context the
   * error is *about*. `stop()` used not to touch `error`, so what the agent got
   * was a banner offering "Turn audio back on" whose click reached
   * `capture.resume()`, returned at once off a null `ctxRef`, and left
   * `capture.error` still winning the `??` in `useAgencyAudio` — so a *successful*
   * playback resume could not clear it either. The banner stayed up for the rest
   * of the shift, announcing a failure nothing on screen could act on, until the
   * next call happened to arm the microphone.
   *
   * Driven with no sticky activation so the probe genuinely fails, then granting
   * it for the click — the same monotonic model the reload tests use.
   */
  async function blockedPreflight() {
    audioStartsSuspended = true;
    stickyActivation = false;

    const view = await mounted();
    await act(async () => {
      fireEvent.keyDown(document, { key: 'a' });
    });
    await act(async () => {});
    return view;
  }

  it('tells the agent at pre-flight, before an attempt exists', async () => {
    const view = await blockedPreflight();

    const banner = await screen.findByTestId('mic-failure');
    expect(banner.textContent).toContain('paused by your browser');
    // No customer is involved yet, which is the entire value of probing here.
    expect(screen.queryByText('+919876543210')).toBeNull();

    view.unmount();
  });

  it('clears the banner when the offered gesture works', async () => {
    const view = await blockedPreflight();
    const button = await screen.findByTestId('mic-resume');

    stickyActivation = true;
    await act(async () => {
      fireEvent.click(button);
    });

    await waitFor(() => expect(screen.queryByTestId('mic-failure')).toBeNull());
    // And it ran the graph rather than only hiding the message — the playback
    // context is the one that still exists at this point, and it is the one the
    // agent needs in order to hear the next customer.
    expect(contexts.filter((c) => c.role === 'playback').every((c) => c.state === 'running')).toBe(
      true,
    );

    view.unmount();
  });

  it('does not hold the probe’s microphone open while the banner is up', async () => {
    // The banner must not be the reason the probe stops being a probe. A blocked
    // graph is still a granted device, and it is released like any other.
    const view = await blockedPreflight();

    await screen.findByTestId('mic-failure');
    await waitFor(() => expect(tracks[0]!.stop).toHaveBeenCalled());

    view.unmount();
  });
});

describe('StrictMode’s double-invoked effects', () => {
  /**
   * `App.tsx` wraps the tree in `React.StrictMode`, which mounts, unmounts and
   * re-mounts every component in development — **on the same fiber, so refs
   * survive**. That is what `preparingRef` in `useAudioCapture` exists for, and
   * it is also why the audio hook's unmount teardown routes through `disarm()`
   * rather than calling `capture.stop()` directly: the direct version releases
   * the device but leaves `armedForRef` holding an attempt id and `sendingRef`
   * still `true`, so the re-mounted hook believes it is already armed and
   * already sending, skips both gates, and never re-acquires the microphone or
   * re-attaches the worklet's sink.
   *
   * **This test does not currently distinguish the two**, and that is reported
   * rather than papered over: StrictMode's double-invoke happens at mount,
   * before any frame has set `live`, so `armedForRef` is still `null` when the
   * teardown runs and both versions behave identically. What it does pin is
   * that the console survives the double-invoke at all and still opens an
   * uplink afterwards — the regression that a *worse* teardown would cause.
   */
  it('still arms and sends after a double-invoked mount', async () => {
    const view = render(
      <StrictMode>
        <MemoryRouter initialEntries={['/station?campaign=camp-1']}>
          <AgentConsolePage />
        </MemoryRouter>
      </StrictMode>,
    );
    await act(async () => {});
    await act(async () => {
      latest().open();
    });
    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({
        event: 'bridged',
        attempt_id: 'att-1',
        bridged_at: '2026-08-11T10:00:04.000Z',
      });
    });
    await act(async () => {});

    speak();
    expect(mediaFrames()).toHaveLength(1);

    view.unmount();
  });

  it('acquires the microphone once, not once per invoked effect', async () => {
    // `preparingRef`'s job. Two `getUserMedia` calls means two MediaStreams, one
    // of which is never stored and therefore never stopped.
    const view = render(
      <StrictMode>
        <MemoryRouter initialEntries={['/station?campaign=camp-1']}>
          <AgentConsolePage />
        </MemoryRouter>
      </StrictMode>,
    );
    await act(async () => {});
    await act(async () => {
      latest().open();
    });
    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
    });
    await act(async () => {});

    expect(gumCalls).toHaveLength(1);

    view.unmount();
    tracks.forEach((track) => expect(track.stop).toHaveBeenCalled());
  });
});

describe('device selection', () => {
  it('follows the system default rather than pinning one', async () => {
    /**
     * No `deviceId` constraint. Pinning stops tracking the OS default, so an
     * agent who switches headsets in system settings keeps capturing from the
     * old one — which presents as "nobody can hear me" with a microphone that
     * tests fine everywhere else.
     */
    await reserved();
    const audio = gumCalls[0]!.audio as MediaTrackConstraints;
    expect('deviceId' in audio).toBe(false);
    expect(audio.channelCount).toBe(1);
    expect(audio.sampleRate).toBe(16000);
  });
});
