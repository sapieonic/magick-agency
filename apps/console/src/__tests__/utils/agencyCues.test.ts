import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ mintStationToken: vi.fn() }));
vi.mock('../../api/agency', () => ({ mintStationToken: mocks.mintStationToken }));

import {
  CueDispatcher,
  escalatedVisualActive,
  fireEscalatedVisualHaptics,
  visualCueSignature,
  CUE_SPECS,
  VISUAL_CUE_SPECS,
  type CueName,
} from '../../utils/agencyCues';
import { WebAudioCueSink, type CueAudioContext } from '../../utils/agencyWebAudioCueSink';
import { useAgencyStation } from '../../hooks/useAgencyStation';
import type {
  AgencyActiveAttempt,
  AgencyReservedAttempt,
  AgencySessionBootstrap,
} from '../../types/agency';

/**
 * `AD-P2-U-02` / §A.4.3.1 — the connect cue.
 *
 * The six assertions §A.4.3.1 requires, each mapping to a way this has failed
 * before, plus the haptics-placement defect found in the prototype.
 *
 * **Assertion 1 must exercise the frame handler, not a re-render** — §A.4.3.1 says
 * so explicitly, "or it passes against the exact implementation it exists to
 * prevent". So the cue tests below drive real frames through `useAgencyStation`
 * rather than calling the dispatcher directly: a `useEffect` watching `bridgedAt`
 * would satisfy a dispatcher-level test and fail the agent by a hundred
 * milliseconds under load.
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

interface Harness {
  played: Array<{ cue: CueName; peakScale: number }>;
  logs: Array<{ event: string; detail: string }>;
  /**
   * Every escalated-visual signal, **with its cue**.
   *
   * It used to be a bare `string[]` of attempt ids, because the escalation fired on
   * connect and nothing else — so a deaf agent got one flash per call that could
   * equally have meant "ringing", "connected" or "they hung up". `AD-P2-U-07` fires
   * it for all three cues, and the cue is the payload that matters: an assertion on
   * attempt ids alone cannot tell three identical flashes from three different ones.
   */
  escalations: Array<{ cue: CueName; attemptId: string }>;
}

function buildDispatcher(
  overrides: {
    volume?: number;
    audible?: boolean;
    setting?: 'auto' | 'always' | 'never';
    /**
     * Wired the way the console wires it: **the escalated-visual callback is the
     * only caller of the haptics.** Passing the navigator through here rather than
     * asserting on a bare mock is what makes the "hearing agents are never buzzed"
     * test able to fail — an earlier version asserted `vibrate` was not called while
     * nothing in the harness could ever have called it, so it would have passed with
     * the vibrate moved back outside the branch, which is the whole defect.
     */
    nav?: Pick<Navigator, 'vibrate'>;
  } = {},
): { dispatcher: CueDispatcher; h: Harness } {
  const played: Array<{ cue: CueName; peakScale: number }> = [];
  const logs: Array<{ event: string; detail: string }> = [];
  const escalations: Array<{ cue: CueName; attemptId: string }> = [];
  const volume = overrides.volume ?? 70;
  const audible = overrides.audible ?? true;

  const dispatcher = new CueDispatcher({
    sink: { play: (cue, peakScale) => played.push({ cue, peakScale }), audible: () => audible },
    volume: () => volume,
    escalated: () =>
      escalatedVisualActive({ setting: overrides.setting ?? 'auto', volume, audible }),
    /**
     * **The real clock, deliberately.** An earlier version injected a fake that
     * advanced 12ms per read, which made the lag a comparison between a fake clock
     * and the station's real `performance.now()` at frame receipt — 493ms of pure
     * harness artefact. Two clocks cannot measure one interval; the assertion looked
     * strict and was measuring nothing.
     */
    now: () => performance.now(),
    log: (event, detail) => logs.push({ event, detail }),
    onEscalatedVisual: ({ attemptId, cue }) => {
      escalations.push({ cue, attemptId });
      /**
       * **The `cue === 'connect'` guard mirrors `useAgencyCues` exactly, and the
       * mirroring is the point.** The haptics assertions below are only able to fail
       * because the harness calls the haptics from the same place production does —
       * an earlier version asserted `vibrate` was not called while nothing in the
       * harness could ever have called it, so it would have passed with the vibrate
       * moved back outside the escalated branch, which is the whole defect.
       *
       * The guard is a **narrowing** of that branch, not a widening. Now that the
       * visual fires for all three cues, an unguarded call here would buzz three
       * times a call instead of once — the ~200-a-day defect at a third of the
       * volume. Moving the call outside the `escalated` branch still fails.
       */
      if (cue === 'connect') fireEscalatedVisualHaptics(overrides.nav);
    },
  });
  return { dispatcher, h: { played, logs, escalations } };
}

beforeEach(() => {
  FakeSocket.instances = [];
  mocks.mintStationToken.mockReset();
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function station(dispatcher: CueDispatcher) {
  const view = renderHook(() => useAgencyStation(BOOTSTRAP, { cues: dispatcher }));
  await act(async () => {});
  act(() => latest().open());
  return view;
}

describe('§A.4.3.1 — the six required assertions, through the frame handler', () => {
  it('1: the cue is scheduled INSIDE the frame handler, before React commits', async () => {
    const { dispatcher, h } = buildDispatcher();
    await station(dispatcher);

    /**
     * **This is the assertion §A.4.3.1 says test 1 must make** — "must exercise the
     * frame handler, not a re-render, or it passes against the exact implementation
     * it exists to prevent".
     *
     * The discriminator is *when*, and it is observable without any timing: inside
     * `act`, React defers effects until the callback returns, so a cue scheduled in
     * the frame handler has already played the moment `emit()` returns, while one
     * scheduled from a `useEffect` on `bridgedAt` has not played at all yet.
     *
     * A latency assertion cannot do this job. A deferred effect in a unit test lands
     * a millisecond late, well inside any budget — the lateness only appears under
     * real load, which is precisely why the spec states the budget as a measurement
     * written to diagnostics rather than as something a test can police.
     */
    let cuesAtEmitReturn: CueName[] = [];
    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04Z' });
      cuesAtEmitReturn = h.played.map((p) => p.cue);
    });

    expect(cuesAtEmitReturn).toEqual(['get_ready', 'connect']);
    expect(h.played.map((p) => p.cue)).toEqual(['get_ready', 'connect']);

    /**
     * The lag entry is the artefact QA asserts against and the answer to "did the
     * agent get told" about one specific call. Asserted as a parsed number under
     * the 150ms budget rather than by substring: a `lag=NaNms` matches
     * /lag=\d+ms/ in neither direction, and a `toContain('lag=')` would pass on it.
     */
    const entry = h.logs.find((l) => l.event === 'cue:connect');
    expect(entry).toBeDefined();
    expect(entry!.detail).toContain('attempt=att-1');
    expect(entry!.detail).toContain('played');
    const lag = Number(/lag=(\d+)ms/.exec(entry!.detail)?.[1]);
    expect(Number.isFinite(lag)).toBe(true);
    expect(lag).toBeLessThanOrEqual(150);
  });

  it('2: a bridge status:answered frame plays nothing and creates no audio node', async () => {
    /**
     * The required negative test. An agent whose cue fires on `answered` is told a
     * human is on the line while they are still on dead air, and they open their
     * greeting into silence. `answered` is the carrier saying the far end went
     * off-hook; `bridged` is audio reaching THIS agent's socket.
     */
    const { dispatcher, h } = buildDispatcher();
    await station(dispatcher);

    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      h.played.length = 0; // discard the legitimate get-ready
      latest().emit({ event: 'status', attempt_id: 'att-1', status: 'answered' });
      latest().emit({ event: 'status', attempt_id: 'att-1', status: 'in_progress' });
    });

    expect(h.played).toEqual([]);
    expect(h.logs.some((l) => l.event === 'cue:connect')).toBe(false);
  });

  it('3: two bridged frames for one attempt play exactly one cue', async () => {
    const { dispatcher, h } = buildDispatcher();
    await station(dispatcher);

    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04Z' });
      // A socket reconnect can re-deliver state. A "customer connected" cue four
      // minutes into a call is worse than silence.
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04Z' });
    });

    expect(h.played.filter((p) => p.cue === 'connect')).toHaveLength(1);
  });

  it('4: ready carrying an active_attempt plays nothing, however live it is', async () => {
    const { dispatcher, h } = buildDispatcher();
    const view = await station(dispatcher);

    const active: AgencyActiveAttempt = {
      ...ATTEMPT,
      bridged_at: '2026-08-11T10:00:04.000Z',
      state: 'bridged',
    };
    act(() => {
      latest().emit({ event: 'ready', session_id: 'sess-1', state: 'on_call', active_attempt: active });
    });

    // A rehydrated socket is not a connect event, under any circumstance.
    expect(h.played).toEqual([]);
    // And the panel IS restored as live — the point of reading `bridged_at` at all.
    expect(view.result.current.live?.bridgedAt).toBe('2026-08-11T10:00:04.000Z');
  });

  it('5: the volume at 0% plays nothing and turns the visual escalation on', async () => {
    const { dispatcher, h } = buildDispatcher({ volume: 0 });
    await station(dispatcher);

    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04Z' });
    });

    // 0% is a permitted setting, not an error: an agent may work in silence and the
    // console's job is to make that safe rather than to argue.
    expect(h.played).toEqual([]);
    // Both cues escalate, each naming itself. An agent working in silence needs to
    // know which of the two things happened, not that one of them did.
    expect(h.escalations).toEqual([
      { cue: 'get_ready', attemptId: 'att-1' },
      { cue: 'connect', attemptId: 'att-1' },
    ]);
    // Still logged — "muted" is itself the answer to "did the agent get told".
    expect(h.logs.find((l) => l.event === 'cue:connect')!.detail).toContain('escalated-visual');
  });

  it('6: a suspended context plays nothing and escalates instead', async () => {
    const { dispatcher, h } = buildDispatcher({ audible: false });
    await station(dispatcher);

    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04Z' });
    });

    expect(h.played).toEqual([]);
    expect(h.escalations).toEqual([
      { cue: 'get_ready', attemptId: 'att-1' },
      { cue: 'connect', attemptId: 'att-1' },
    ]);
  });
});

describe('the disconnect cue only reports something that happened', () => {
  it('falls after a call that bridged', async () => {
    const { dispatcher, h } = buildDispatcher();
    await station(dispatcher);
    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04Z' });
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'remote_hangup',
        requires_disposition: true,
        message: 'Call ended.',
      });
    });

    expect(h.played.map((p) => p.cue)).toEqual(['get_ready', 'connect', 'disconnect']);
  });

  it('stays silent for an attempt that never connected', async () => {
    const { dispatcher, h } = buildDispatcher();
    await station(dispatcher);
    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      // No answer: rang out and was released without ever bridging.
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'no_answer',
        requires_disposition: false,
        message: 'No answer.',
      });
    });

    expect(h.played.map((p) => p.cue)).toEqual(['get_ready']);
  });
});

describe('haptics sit inside the escalated-visual branch', () => {
  /**
   * The prototype's defect, and the ticket says the same mistake is easy to repeat
   * here: `navigator.vibrate` sat **outside** the escalated branch, so a hearing
   * agent with working sound was buzzed on every connect — ~200 times a day.
   */
  it('a hearing agent with working sound is never buzzed, across four connects', async () => {
    const vibrate = vi.fn();
    const { dispatcher, h } = buildDispatcher({ volume: 70, audible: true, nav: { vibrate } });
    await station(dispatcher);

    for (const id of ['att-1', 'att-2', 'att-3', 'att-4']) {
      act(() => {
        latest().emit({ event: 'reserved', attempt: { ...ATTEMPT, attempt_id: id } });
        latest().emit({ event: 'bridged', attempt_id: id, bridged_at: '2026-08-11T10:00:04Z' });
      });
    }

    // Four connects, four cues, and the escalation callback — the ONLY caller of the
    // haptics — never reached. ~200 calls a day is what the prototype's version of
    // this buzzed through.
    expect(h.played.filter((p) => p.cue === 'connect')).toHaveLength(4);
    expect(h.escalations).toEqual([]);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it('an escalated agent gets exactly one buzz per connect', async () => {
    const vibrate = vi.fn();
    const { dispatcher, h } = buildDispatcher({ volume: 0, audible: true, nav: { vibrate } });
    await station(dispatcher);

    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04Z' });
      // A duplicate must not buzz again, for the same reason it must not re-cue.
      latest().emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-11T10:00:04Z' });
    });

    // Two visuals — the ring and the connect — and exactly ONE buzz, on the connect.
    // Three buzzes a call is the ~200-a-day defect at a third of the volume.
    expect(h.escalations.map((e) => e.cue)).toEqual(['get_ready', 'connect']);
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith([40, 30, 60]);
  });

  it('fires once for an escalated agent, and swallows an un-consented refusal', () => {
    const vibrate = vi.fn();
    expect(fireEscalatedVisualHaptics({ vibrate } as unknown as Navigator)).toBe(true);
    expect(vibrate).toHaveBeenCalledWith([40, 30, 60]);

    /**
     * An un-consented `vibrate` throws or warns on every single call, and a console
     * full of benign errors is where a real one goes unnoticed — the haptics defect
     * above surfaced *only* because console noise was being treated as a signal.
     */
    const throwing = vi.fn(() => {
      throw new Error('vibrate blocked without user engagement');
    });
    expect(() =>
      fireEscalatedVisualHaptics({ vibrate: throwing } as unknown as Navigator),
    ).not.toThrow();
    // Absent on desktop Chrome: a bonus channel, never the mitigation.
    expect(fireEscalatedVisualHaptics(undefined)).toBe(false);
    expect(fireEscalatedVisualHaptics({} as unknown as Navigator)).toBe(false);
  });
});

describe('the visual cues are three different things, not one flash three times', () => {
  /**
   * `AD-P2-U-07`'s criterion (a), at the table.
   *
   * The shipped state was **one** generic flash fired on connect only. That
   * satisfies "a visual exists" and fails the requirement, which is that an agent
   * who cannot hear can tell *which* event happened — the same reason §A.4.3.1 gave
   * the audio distinct rhythm and contour rather than distinct pitch.
   *
   * These assertions are what the "collapse the three treatments into one" mutation
   * has to fail against.
   */
  const CUES: CueName[] = ['get_ready', 'connect', 'disconnect'];
  const pairs: Array<[CueName, CueName]> = [
    ['get_ready', 'connect'],
    ['get_ready', 'disconnect'],
    ['connect', 'disconnect'],
  ];

  it('separates every pair on all three structural axes', () => {
    for (const [a, b] of pairs) {
      const left = VISUAL_CUE_SPECS[a];
      const right = VISUAL_CUE_SPECS[b];
      // Asserted axis by axis rather than by comparing the whole object: a single
      // differing field would satisfy `not.toEqual` while leaving two cues that an
      // agent who has lost one axis — motion reduced, or a display that swallows a
      // 100ms difference — still cannot tell apart.
      expect(left.pulses, `${a} vs ${b}: pulse count`).not.toBe(right.pulses);
      expect(left.travel, `${a} vs ${b}: travel direction`).not.toBe(right.travel);
      expect(left.durationMs, `${a} vs ${b}: duration`).not.toBe(right.durationMs);
    }
  });

  it('mirrors the audio: get-ready has no direction, connect rises, disconnect falls', () => {
    // The visual channel carries the same information as the audio's contour, so an
    // agent switching between them is not learning two vocabularies.
    expect(VISUAL_CUE_SPECS.get_ready.travel).toBe('still');
    expect(VISUAL_CUE_SPECS.connect.travel).toBe('up');
    expect(VISUAL_CUE_SPECS.disconnect.travel).toBe('down');

    // Get-ready's rhythm is the audio's three even knocks, exactly.
    expect(VISUAL_CUE_SPECS.get_ready.pulses).toBe(CUE_SPECS.get_ready.tones.length);

    // Connect is the longest of the three. It is the event the whole subsystem
    // exists for and it must not be the subtlest thing on the rail.
    for (const cue of CUES.filter((c) => c !== 'connect')) {
      expect(VISUAL_CUE_SPECS.connect.durationMs).toBeGreaterThan(
        VISUAL_CUE_SPECS[cue].durationMs,
      );
    }
  });

  it('carries no colour, so a colour-blind agent loses nothing', () => {
    /**
     * The visual channel's version of "never by pitch alone". Colour is the axis an
     * agent may already have lost, and this is the channel that exists for an agent
     * who has lost one — so a `colour`/`tone`/`hue` field here would be a
     * distinction that looks real and is not, for exactly the people it is for.
     */
    for (const cue of CUES) {
      const keys = Object.keys(VISUAL_CUE_SPECS[cue]).map((k) => k.toLowerCase());
      expect(keys).toEqual(['pulses', 'travel', 'durationms']);
      expect(keys.some((k) => /colou?r|hue|tint|tone/.test(k))).toBe(false);
    }
  });

  it('gives all three a distinct signature, which is what the DOM renders from', () => {
    const signatures = CUES.map(visualCueSignature);
    expect(new Set(signatures).size).toBe(3);
    // Named, not just counted: a `Set` of size 3 over three empty strings is not
    // possible, but a Set of size 3 over three *colours* would be — so pin the
    // shape the CSS actually consumes.
    expect(signatures).toEqual(['3x-still-540ms', '1x-up-900ms', '2x-down-620ms']);
  });
});

describe('escalatedVisualActive', () => {
  it('is on when the cue cannot do the job, and obeys an explicit override', () => {
    // Auto: on exactly when the cue cannot carry the information.
    expect(escalatedVisualActive({ setting: 'auto', volume: 70, audible: true })).toBe(false);
    expect(escalatedVisualActive({ setting: 'auto', volume: 0, audible: true })).toBe(true);
    expect(escalatedVisualActive({ setting: 'auto', volume: 70, audible: false })).toBe(true);

    // Always/Never are the agent's own call and outrank both inputs — including
    // `Never` with no audio at all, which is a choice they are allowed to make.
    expect(escalatedVisualActive({ setting: 'always', volume: 70, audible: true })).toBe(true);
    expect(escalatedVisualActive({ setting: 'never', volume: 0, audible: false })).toBe(false);
  });
});

describe('WebAudioCueSink — the half that touches the hardware', () => {
  function fakeCtx(state: AudioContextState = 'running') {
    const oscillators: Array<Record<string, unknown>> = [];
    const gains: Array<Record<string, unknown>> = [];
    const ramps: Array<{ kind: string; value: number; at: number }> = [];

    const ctx = {
      state,
      currentTime: 10,
      destination: {} as AudioNode,
      createOscillator: () => {
        const osc = {
          type: '',
          frequency: { value: 0 },
          connect: vi.fn(),
          start: vi.fn(),
          stop: vi.fn(),
        };
        oscillators.push(osc as unknown as Record<string, unknown>);
        return osc as unknown as OscillatorNode;
      },
      createGain: () => {
        const gain = {
          gain: {
            setValueAtTime: (value: number, at: number) =>
              ramps.push({ kind: 'set', value, at }),
            linearRampToValueAtTime: (value: number, at: number) =>
              ramps.push({ kind: 'linear', value, at }),
            exponentialRampToValueAtTime: (value: number, at: number) =>
              ramps.push({ kind: 'exponential', value, at }),
          },
          connect: vi.fn(),
        };
        gains.push(gain as unknown as Record<string, unknown>);
        return gain as unknown as GainNode;
      },
      resume: async () => {},
    };
    return { ctx: ctx as unknown as CueAudioContext, oscillators, gains, ramps };
  }

  it('creates one oscillator per tone and stops each at its envelope end', () => {
    const { ctx, oscillators, gains } = fakeCtx();
    new WebAudioCueSink(ctx).play('connect', 1);

    // Two tones, two oscillators, two gains — never one running oscillator gated by
    // a gain node, which in an eight-hour tab is a battery cost and a stuck-tone
    // risk the moment the gain ends up non-zero.
    expect(oscillators).toHaveLength(CUE_SPECS.connect.tones.length);
    expect(gains).toHaveLength(CUE_SPECS.connect.tones.length);
    for (const osc of oscillators) {
      expect(osc['start']).toHaveBeenCalled();
      expect(osc['stop']).toHaveBeenCalled();
    }
  });

  it('rises on connect and falls on disconnect — contour, not pitch alone', () => {
    const rising = fakeCtx();
    new WebAudioCueSink(rising.ctx).play('connect', 1);
    const risingHz = rising.oscillators.map((o) => (o['frequency'] as { value: number }).value);

    const falling = fakeCtx();
    new WebAudioCueSink(falling.ctx).play('disconnect', 1);
    const fallingHz = falling.oscillators.map((o) => (o['frequency'] as { value: number }).value);

    expect(risingHz[1]!).toBeGreaterThan(risingHz[0]!);
    expect(fallingHz[1]!).toBeLessThan(fallingHz[0]!);

    // Get-ready is a RHYTHM: three even knocks at one pitch. §A.4.3.1 supersedes
    // §A.4.2's rising three-tone precisely so it cannot be confused with connect.
    const ready = fakeCtx();
    new WebAudioCueSink(ready.ctx).play('get_ready', 1);
    const readyHz = ready.oscillators.map((o) => (o['frequency'] as { value: number }).value);
    expect(readyHz).toHaveLength(3);
    expect(new Set(readyHz).size).toBe(1);
  });

  it('uses linear ramps only, and returns to exactly zero', () => {
    const { ctx, ramps } = fakeCtx();
    new WebAudioCueSink(ctx).play('connect', 1);

    /**
     * `exponentialRampToValueAtTime` **cannot reach zero** — it leaves a residual
     * tail that clicks on the next cue, and it is the standard bug in this exact
     * code. A hard gate with no envelope is equally wrong: a square-edged sine is a
     * broadband click, and 200 a day is a fatigue source.
     */
    expect(ramps.some((r) => r.kind === 'exponential')).toBe(false);
    expect(ramps.filter((r) => r.kind === 'linear').length).toBeGreaterThan(0);
    expect(ramps.filter((r) => r.value === 0).length).toBeGreaterThan(0);
  });

  it('scales the peak by the agent’s volume, and creates NOTHING when suspended', () => {
    const loud = fakeCtx();
    new WebAudioCueSink(loud.ctx).play('connect', 1);
    const full = loud.ramps.find((r) => r.value > 0)!.value;

    const quiet = fakeCtx();
    new WebAudioCueSink(quiet.ctx).play('connect', 0.5);
    expect(quiet.ramps.find((r) => r.value > 0)!.value).toBeCloseTo(full / 2, 6);

    // The literal "no audio node created" half of assertion 2, at the one layer that
    // could create one.
    const suspended = fakeCtx('suspended');
    new WebAudioCueSink(suspended.ctx).play('connect', 1);
    expect(suspended.oscillators).toHaveLength(0);
    expect(suspended.gains).toHaveLength(0);
  });
});
