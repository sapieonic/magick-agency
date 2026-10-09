import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react';
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
import { VISUAL_CUE_SPECS, visualCueSignature } from '../../utils/agencyCues';
import { CUE_PREFS_STORAGE_KEY } from '../../utils/agencyCuePrefs';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';

/**
 *  **escalated-visual mode, at the page.**
 *
 * ── What was actually wrong, and why a page test is the only place to prove it ─
 * An earlier change shipped the audio cues and *one* visual: a single generic flash on
 * connect, keyed off an attribute (`data-connect-flash`) that **no test asserted
 * anywhere**. So the visual channel had exactly one state, was eyeballed rather
 * than pinned, and an agent who could not hear got one flash per call that could
 * equally have meant "ringing", "connected" or "they hung up".
 *
 * Criterion (a) is the one that decides this ticket: *with audio disabled entirely,
 * a connect is distinguishable from a get-ready **and** from a disconnect by sight
 * alone.* A test that asserts each cue "fires" passes with all three rendering the
 * same pixels, which is the failure the ticket was filed against — so every
 * assertion below compares the three treatments to each other rather than checking
 * that a treatment exists.
 *
 * ── Assertion discipline, inherited from `AgentConsolePage.test.tsx` ──────────
 * Nothing here asserts a callback was wired or a prop was passed. Every case drives
 * real socket frames and reads the DOM the agent's browser would paint, and every
 * negative case ("no flash for a hearing agent", "no connect on `answered`") is
 * paired with a positive one in the same test, because an assertion satisfied by
 * *absence* — `queryBy…` returning null when nothing rendered at all — is worth
 * nothing.
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

/**
 * The smallest `AudioContext` the cue sink touches, plus a record of what it
 * scheduled — so "audio disabled entirely" can be tested as *the agent turned the
 * volume down on working hardware*, not merely as a browser with no audio at all.
 *
 * The distinction matters: a page with no `AudioContext` constructor escalates for
 * free, and a criterion-(a) test that relied on that would pass with the volume
 * setting ignored completely.
 */
class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  state: AudioContextState = 'running';
  currentTime = 0;
  sampleRate = 48_000;
  destination = {} as AudioNode;
  oscillators: Array<{ hz: number }> = [];
  readonly options: AudioContextOptions | undefined;

  constructor(options?: AudioContextOptions) {
    this.options = options;
    FakeAudioContext.instances.push(this);
  }
  /** The cue's contexts are the ones built with no options (see the cues test). */
  static cueContexts(): FakeAudioContext[] {
    return FakeAudioContext.instances.filter((c) => c.options === undefined);
  }
  createOscillator(): OscillatorNode {
    const record = { hz: 0 };
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
      start: () => undefined,
      stop: () => undefined,
    } as unknown as OscillatorNode;
  }
  createGain(): GainNode {
    return {
      gain: { setValueAtTime: () => undefined, linearRampToValueAtTime: () => undefined },
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
    return Promise.resolve();
  }
  close(): Promise<void> {
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

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

beforeEach(() => {
  FakeSocket.instances = [];
  FakeAudioContext.instances = [];
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1' });
  mocks.createAgencySession.mockResolvedValue(BOOTSTRAP);
  mocks.setAgentAvailable.mockResolvedValue(undefined);
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  vi.stubGlobal('AudioContext', FakeAudioContext as unknown as typeof AudioContext);
  // The preference is persisted per browser, so a leftover key would carry one
  // test's setting into the next one's defaults.
  window.localStorage.clear();
  /**
   * Fake timers for the whole file, and not as a convenience.
   *
   * The flash is **transient** — each cue is held for its own `durationMs` and then
   * cleared. Under real timers a test that changes a setting and re-emits would still
   * be looking at the *previous* cue's element, so "no flash after `Never`" would
   * either pass for the wrong reason or fail for one. The clock is advanced
   * explicitly wherever a window has to expire.
   */
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.localStorage.clear();
});

async function mounted() {
  const view = render(
    <MemoryRouter initialEntries={['/app/agency/console?campaign=camp-1']}>
      <AgentConsolePage />
    </MemoryRouter>,
  );
  await act(async () => {});
  await act(async () => {
    latest().open();
  });
  return view;
}

/**
 * A real keypress, fired **from wherever focus actually is**.
 *
 * The default is `document.activeElement`, not `document`, because that is what a
 * browser does: a keydown's target is the focused element, and the page's global
 * handler decides whether to act on a single key by inspecting exactly that target
 * (`AgentConsolePage`'s `inTextField`). Firing at `document` walks straight past
 * that branch, so a suite written that way stays green while the keyboard is dead
 * from the position the agent is really in — focus inside the cue-settings radio or
 * volume slider, say, which is where the agent who cannot hear the cues is standing.
 *
 * An explicit `target` is still accepted for the cases where the point of the test
 * is the position (see the `Enter`-from-the-trigger test below).
 */
function press(key: string, target: Element | Document = document.activeElement ?? document) {
  act(() => {
    fireEvent.keyDown(target, { key });
  });
}

/**
 * The shift's one reliable user gesture. Unlocks the cue `AudioContext`, so after
 * this the agent genuinely *can* hear — which is what makes "the volume is at 0"
 * a real test of the setting rather than of a browser with no audio.
 */
async function goAvailable() {
  press('a');
  await act(async () => {});
}

/** Let a flash window expire, so the next assertion reads the next cue's element. */
function expireFlash() {
  act(() => {
    vi.advanceTimersByTime(
      Math.max(...Object.values(VISUAL_CUE_SPECS).map((spec) => spec.durationMs)) + 1,
    );
  });
}

function openSettings() {
  const trigger = screen.getByRole('button', { name: /sound & flash/i });
  act(() => {
    fireEvent.click(trigger);
  });
  return trigger;
}

/** Move a control the agent can actually move, and read the effect off the DOM. */
function setFlashSetting(label: RegExp) {
  const radio = screen.getByRole('radio', { name: label });
  act(() => {
    fireEvent.click(radio);
  });
}

function setVolume(value: number) {
  const slider = screen.getByLabelText('Cue volume') as HTMLInputElement;
  act(() => {
    fireEvent.change(slider, { target: { value: String(value) } });
  });
}

const flash = () => document.querySelector<HTMLElement>('[data-testid="cue-flash"]');

/**
 * What the agent can *see*, as one comparable value: how many pulses, which
 * direction, how long. Read off the rendered element rather than off the spec table,
 * so a page that renders the same thing for every cue fails even with a perfectly
 * differentiated table behind it.
 */
function seenTreatment(): string {
  const element = flash();
  if (!element) return 'nothing rendered';
  return [
    element.dataset['cuePulses'],
    element.dataset['cueTravel'],
    element.style.getPropertyValue('--cue-duration'),
  ].join('/');
}

async function reserved() {
  const view = await mounted();
  await act(async () => {
    latest().emit({ event: 'reserved', attempt: ATTEMPT });
  });
  return view;
}

function bridge(attemptId = 'att-1') {
  act(() => {
    latest().emit({
      event: 'bridged',
      attempt_id: attemptId,
      bridged_at: '2026-08-11T10:00:04.000Z',
    });
  });
}

function release(attemptId = 'att-1') {
  act(() => {
    latest().emit({
      event: 'released',
      attempt_id: attemptId,
      reason: 'remote_hangup',
      requires_disposition: true,
      message: 'The customer hung up.',
    });
  });
}

describe('criterion (a) — with audio off, the three cues are three different sights', () => {
  it('shows a distinct treatment for get-ready, connect and disconnect', async () => {
    /**
     * The ticket's deciding assertion. **Audio disabled entirely**, on hardware that
     * works: the context is unlocked and running, and the agent has set the volume to
     * 0 — the setting explicitly permits.
     */
    await mounted();
    await goAvailable();
    openSettings();
    setVolume(0);

    // Working audio hardware, deliberately: if this escalated because the browser
    // has no `AudioContext`, the volume setting would be doing nothing and the test
    // would pass with it ignored.
    const ctx = FakeAudioContext.cueContexts()[0]!;
    expect(ctx.state).toBe('running');

    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
    });
    const getReadySeen = seenTreatment();
    expect(flash()!.dataset['cueFlash']).toBe('get_ready');

    bridge();
    const connectSeen = seenTreatment();
    expect(flash()!.dataset['cueFlash']).toBe('connect');

    release();
    const disconnectSeen = seenTreatment();
    expect(flash()!.dataset['cueFlash']).toBe('disconnect');

    // Nothing was played — this really was sight alone.
    expect(ctx.oscillators).toEqual([]);

    /**
     * **The assertion the ticket turns on.** Three treatments, three *different*
     * treatments. A single generic flash reused for all three satisfies every
     * "did it fire" assertion above and fails right here.
     */
    expect(new Set([getReadySeen, connectSeen, disconnectSeen]).size).toBe(3);

    // And what the agent saw is the table's own signature — so the DOM cannot drift
    // from `VISUAL_CUE_SPECS` while both halves look fine on their own.
    expect(getReadySeen).toBe('3/still/540ms');
    expect(connectSeen).toBe('1/up/900ms');
    expect(disconnectSeen).toBe('2/down/620ms');
    expect([getReadySeen, connectSeen, disconnectSeen]).toEqual(
      (['get_ready', 'connect', 'disconnect'] as const).map(
        (cue) =>
          `${VISUAL_CUE_SPECS[cue].pulses}/${VISUAL_CUE_SPECS[cue].travel}/${VISUAL_CUE_SPECS[cue].durationMs}ms`,
      ),
    );
  });

  it('separates them on count and direction, not on colour or on one axis', async () => {
    /**
     * Colour is the axis this agent may already have lost — this is an accessibility
     * ticket — so the separation must survive being read in greyscale, and it must
     * not rest on a single bit either. Every pair differs on **both** the pulse count
     * and the travel direction.
     */
    await mounted();
    await goAvailable();
    openSettings();
    setVolume(0);

    const seen: Record<string, { pulses: string; travel: string }> = {};
    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
    });
    seen['get_ready'] = {
      pulses: flash()!.dataset['cuePulses']!,
      travel: flash()!.dataset['cueTravel']!,
    };
    bridge();
    seen['connect'] = {
      pulses: flash()!.dataset['cuePulses']!,
      travel: flash()!.dataset['cueTravel']!,
    };
    release();
    seen['disconnect'] = {
      pulses: flash()!.dataset['cuePulses']!,
      travel: flash()!.dataset['cueTravel']!,
    };

    const pairs: Array<[string, string]> = [
      ['get_ready', 'connect'],
      ['get_ready', 'disconnect'],
      ['connect', 'disconnect'],
    ];
    for (const [a, b] of pairs) {
      expect(seen[a]!.pulses, `${a} vs ${b}: pulse count`).not.toBe(seen[b]!.pulses);
      expect(seen[a]!.travel, `${a} vs ${b}: travel direction`).not.toBe(seen[b]!.travel);
    }

    // No colour anywhere on the element: no inline colour, no per-cue class. The CSS
    // paints all three with one `--accent` precisely so this holds.
    const element = flash()!;
    expect(element.style.color).toBe('');
    expect(element.style.background).toBe('');
    expect(element.getAttribute('style')).not.toMatch(/colou?r|#[0-9a-f]{3}|rgb/i);
  });

  it('is rendered on the rail, silently, and does not shift the console', async () => {
    await mounted();
    await goAvailable();
    openSettings();
    setVolume(0);
    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
    });

    const element = flash()!;
    // On the rail's "single most important component" — not in a corner.
    expect(element.closest('[role="status"]')).toBeTruthy();
    /**
     * `aria-hidden`, and deliberately. The rail is this screen's only polite live
     * region: a labelled element appearing inside it would announce on every ring,
     * connect and hang-up, on top of the assertive region that already says so in
     * words. The flash is for eyes that cannot use the sound, not a third narration.
     */
    expect(element.getAttribute('aria-hidden')).toBe('true');
    expect(element.textContent).toBe('');
  });

  it('clears itself after its own duration, and each cue holds for its own window', async () => {
    await reserved();

    // Get-ready's window is the shortest of the three, so it is the one that proves
    // the duration is per-cue rather than a single shared constant.
    expect(flash()!.dataset['cueFlash']).toBe('get_ready');
    act(() => {
      vi.advanceTimersByTime(VISUAL_CUE_SPECS.get_ready.durationMs - 1);
    });
    expect(flash()!.dataset['cueFlash']).toBe('get_ready');
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(flash()).toBeNull();

    // Connect outlasts it — asserted by still being lit at get-ready's expiry, which
    // a shared constant could not produce.
    bridge();
    expect(flash()!.dataset['cueFlash']).toBe('connect');
    act(() => {
      vi.advanceTimersByTime(VISUAL_CUE_SPECS.get_ready.durationMs + 1);
    });
    expect(flash()!.dataset['cueFlash']).toBe('connect');
    act(() => {
      vi.advanceTimersByTime(VISUAL_CUE_SPECS.connect.durationMs);
    });
    expect(flash()).toBeNull();
  });
});

describe('the connect visual rides `bridged` and nothing else', () => {
  it('stays on get-ready through `answered`, then moves on the bridge', async () => {
    /**
     * The audio half asserts this by dispatching `answered` alone and proving
     * silence; the visual half has to hold the same line. `status:answered` is the
     * carrier saying the far end went off-hook — between it and `bridged` sit the
     * borrowed-socket attach, listener registration and the reserved-agent ownership
     * check, any of which can fail. A connect *flash* on `answered` tells a deaf
     * agent a human is on the line while they are on dead air, and they open their
     * greeting into silence.
     *
     * Asserted as "still showing get-ready", not as "no connect flash": a
     * `queryBy…`-style negative would pass just as well with the whole visual
     * channel deleted.
     */
    await reserved();
    expect(flash()!.dataset['cueFlash']).toBe('get_ready');

    await act(async () => {
      latest().emit({ event: 'status', attempt_id: 'att-1', status: 'answered' });
      latest().emit({ event: 'status', attempt_id: 'att-1', status: 'in_progress' });
    });

    expect(flash()!.dataset['cueFlash']).toBe('get_ready');
    expect(seenTreatment()).toBe('3/still/540ms');

    bridge();
    expect(flash()!.dataset['cueFlash']).toBe('connect');
  });

  it('shows no disconnect for a call that never connected', async () => {
    // A visual for the end of a call that never happened is a report of something
    // that did not happen. Paired with the positive case below so it cannot pass by
    // the flash never working at all.
    await reserved();
    await act(async () => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'no_answer',
        requires_disposition: false,
        message: 'Nobody picked up.',
      });
    });
    expect(flash()!.dataset['cueFlash']).toBe('get_ready');

    await act(async () => {
      latest().emit({ event: 'reserved', attempt: { ...ATTEMPT, attempt_id: 'att-2' } });
    });
    bridge('att-2');
    release('att-2');
    expect(flash()!.dataset['cueFlash']).toBe('disconnect');
  });

  it('does not flash on a reconnect onto a call already in progress', async () => {
    // A "customer connected" signal four minutes into a live conversation tells the
    // agent something happened when nothing did.
    await mounted();
    await act(async () => {
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'on_call',
        active_attempt: { ...ATTEMPT, bridged_at: '2026-08-11T10:00:04.000Z', state: 'bridged' },
      });
    });

    expect(flash()).toBeNull();
    // …and the panel IS restored as live, so the silence above is the dedupe working
    // rather than the frame being dropped.
    expect(screen.getByTestId('rail-label').textContent).toBe('On call');
  });

  it('lights the whole shell for connect, and for neither of the others', async () => {
    /**
     * Scope is the fourth axis. Connect — the one event that means a stranger has
     * started speaking — additionally flashes the console shell; a ring and a hang-up
     * do not earn the whole screen. The two halves of this assertion are what stop
     * that axis being quietly spent on all three.
     */
    const view = await reserved();
    const shell = view.container.firstElementChild as HTMLElement;
    expect(shell.getAttribute('data-connect-flash')).toBeNull();

    bridge();
    expect(shell.getAttribute('data-connect-flash')).toBe('true');

    release();
    expect(shell.getAttribute('data-connect-flash')).toBeNull();
    expect(flash()!.dataset['cueFlash']).toBe('disconnect');
  });
});

describe('criterion (b) — haptics stay inside the escalated branch, on connect only', () => {
  it('buzzes once per connect for an escalated agent and never for a hearing one', async () => {
    /**
     * The prototype buzzed a hearing agent on every connect — ~200 times a day —
     * because the `vibrate` call sat outside the escalated branch. The assertion that
     * was supposed to guard it was **vacuous**: nothing in the harness could call
     * `vibrate` at all, so it passed forever.
     *
     * This version proves the negative can fail, in one test, by showing the same spy
     * being called in the escalated case and not in the audible one. A spy that is
     * never called under any conditions cannot distinguish the two.
     */
    const vibrate = vi.fn();
    vi.stubGlobal('navigator', Object.assign(Object.create(navigator), { vibrate }));

    // Escalated: audio unavailable, so the visual — and the buzz — is the channel.
    await reserved();
    bridge();
    expect(vibrate).toHaveBeenCalledTimes(1);
    expect(vibrate).toHaveBeenCalledWith([40, 30, 60]);

    // Three visuals in this call, ONE buzz. Now that the ring and the hang-up flash
    // too, an unguarded call inside the escalated callback would buzz three times a
    // call — the same defect at a third of the volume.
    release();
    expect(flash()!.dataset['cueFlash']).toBe('disconnect');
    expect(vibrate).toHaveBeenCalledTimes(1);

    // A hearing agent with working sound: no flash, no buzz. Same spy, same page.
    cleanup();
    FakeSocket.instances = [];
    FakeAudioContext.instances = [];
    vibrate.mockClear();
    await mounted();
    await goAvailable();
    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
    });
    bridge();

    expect(FakeAudioContext.cueContexts()[0]!.oscillators.map((o) => o.hz)).toEqual([
      523, 523, 523, 660, 990,
    ]);
    expect(flash()).toBeNull();
    expect(vibrate).not.toHaveBeenCalled();
  });
});

describe('criterion (c) — the preference is settable, not just readable', () => {
  it('`Never` switches the flash off even with no audio at all', async () => {
    // The escalation had exactly one route before this: an `AudioContext` the browser
    // refused. Proving the setting works means changing the outcome of a case that
    // otherwise escalates.
    await reserved();
    expect(flash()!.dataset['cueFlash']).toBe('get_ready');

    openSettings();
    setFlashSetting(/never show the flash/i);
    // The previous cue's window has to close first, or the element still on screen
    // would be the one this test just proved works.
    expireFlash();
    expect(flash()).toBeNull();

    await act(async () => {
      latest().emit({ event: 'reserved', attempt: { ...ATTEMPT, attempt_id: 'att-2' } });
    });
    bridge('att-2');
    expect(flash()).toBeNull();
  });

  it('`Always` shows the flash to an agent who can hear perfectly well', async () => {
    /**
     * The other direction, and the one an agent in a noisy room reaches for. It also
     * proves the dispatcher reads the *current* setting rather than the value it
     * closed over at construction — a preference read from the closure would be
     * frozen at the defaults, and the popover would appear to work while changing
     * nothing.
     */
    await mounted();
    await goAvailable();
    const ctx = FakeAudioContext.cueContexts()[0]!;
    expect(ctx.state).toBe('running');

    openSettings();
    setFlashSetting(/always show the flash/i);

    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
    });
    bridge();

    // Both channels: the cue was audible AND the flash showed, because the agent
    // asked for it.
    expect(ctx.oscillators.map((o) => o.hz)).toEqual([523, 523, 523, 660, 990]);
    expect(flash()!.dataset['cueFlash']).toBe('connect');
  });

  it('the volume slider actually reaches the dispatcher', async () => {
    await mounted();
    await goAvailable();
    const ctx = FakeAudioContext.cueContexts()[0]!;

    openSettings();
    setVolume(0);
    expect(screen.getByText('Cues are silent. The rail flash is your only call signal.')).toBeTruthy();

    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
    });
    // Silent, on hardware that is running — so this is the setting, not the browser.
    expect(ctx.oscillators).toEqual([]);
    expect(flash()!.dataset['cueFlash']).toBe('get_ready');

    // And back up again: a one-way control would pass the assertion above.
    //
    // The popover has to be re-opened, because the reservation above closed it: the
    // console moves focus to itself when a call arrives, focus left the popover, and
    // a settings panel sitting over a live call is not what the agent wants.
    expect(screen.queryByRole('dialog')).toBeNull();
    openSettings();
    setVolume(70);
    await act(async () => {
      latest().emit({ event: 'reserved', attempt: { ...ATTEMPT, attempt_id: 'att-2' } });
    });
    expect(ctx.oscillators.map((o) => o.hz)).toEqual([523, 523, 523]);
  });

  it('says so when the agent has turned off both channels at once', async () => {
    // Silence plus `Never` is zero channels. The agent is allowed to choose it — but
    // not by accident, and the warning has to name the consequence rather than
    // refusing the setting.
    await mounted();
    openSettings();
    setVolume(0);
    setFlashSetting(/never show the flash/i);

    expect(
      screen.getByText('Cues are silent and the flash is off — nothing will signal a call.'),
    ).toBeTruthy();
  });

  it('persists per browser and is read back on the next shift', async () => {
    await mounted();
    openSettings();
    setFlashSetting(/always show the flash/i);
    setVolume(25);

    // The stored value, not merely "something was stored".
    expect(JSON.parse(window.localStorage.getItem(CUE_PREFS_STORAGE_KEY)!)).toEqual({
      volume: 25,
      connectFlash: 'always',
    });

    // A fresh console reads it back: the control shows the agent's choice, and the
    // behaviour follows it without them touching the popover again.
    cleanup();
    FakeSocket.instances = [];
    FakeAudioContext.instances = [];
    await mounted();
    await goAvailable();
    openSettings();
    expect((screen.getByRole('radio', { name: /always show the flash/i }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByLabelText('Cue volume') as HTMLInputElement).value).toBe('25');

    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
    });
    // `always`, restored from storage, on audible hardware.
    expect(flash()!.dataset['cueFlash']).toBe('get_ready');
  });

  it('changing a preference does not re-open the station socket', async () => {
    /**
     * The structural hazard the whole cue subsystem is built around: the dispatcher is
     * handed to `useAgencyStation`, whose `handleFrame` → `connect` → connect-effect
     * chain would tear the socket down if the dispatcher's identity changed. Reading
     * the settings through a ref is what keeps it stable — a rebuild on every
     * preference change would re-mint a token and reset the dedupe sets that stop the
     * cue re-firing.
     */
    await mounted();
    expect(FakeSocket.instances).toHaveLength(1);

    openSettings();
    setVolume(0);
    setFlashSetting(/always show the flash/i);
    setVolume(90);

    expect(FakeSocket.instances).toHaveLength(1);
    expect(mocks.mintStationToken).not.toHaveBeenCalled();
  });
});

describe('criterion (d) — the settings surface is reachable without a mouse', () => {
  it('the trigger is in the tab order, not merely in the DOM', async () => {
    await mounted();
    const trigger = screen.getByRole('button', { name: /sound & flash/i });

    /**
     * `el.tabIndex >= 0`, not `[tabindex]:not([tabindex="-1"])`. A
     * `<button tabindex="-1">` matches a `button` selector, renders, reads correctly
     * to a screen reader and cannot be tabbed to — the "operable but unreachable"
     * shape that shipped `End break` broken.
     */
    expect(trigger.tabIndex).toBeGreaterThanOrEqual(0);
    expect(trigger.hasAttribute('disabled')).toBe(false);
    expect(trigger.closest('[aria-hidden="true"]')).toBeNull();
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('opens on Enter from the trigger — the position a keyboard reaches it from', async () => {
    /**
     * Fired at the trigger while the trigger holds focus, which is where a keyboard
     * agent actually is when they press this. Not at `window` (this control owns no
     * global shortcut, deliberately — every free letter would be new muscle memory
     * for a preference set once a shift) and not from inside a text field.
     */
    await mounted();
    const trigger = screen.getByRole('button', { name: /sound & flash/i });
    act(() => {
      trigger.focus();
    });
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByRole('dialog')).toBeNull();

    press('Enter', trigger);

    const dialog = screen.getByRole('dialog', { name: 'Sound and flash' });
    expect(dialog).toBeTruthy();
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    // Focus lands *inside*, on the first control — not on a container the arrow keys
    // do nothing to.
    expect(document.activeElement).toBe(
      screen.getByRole('radio', { name: /always show the flash/i }),
    );
  });

  it('every control inside is reachable and carries a name a screen reader can read', async () => {
    await mounted();
    openSettings();
    const dialog = screen.getByRole('dialog', { name: 'Sound and flash' });

    // Named, not positional: `getByRole` with a name is the assertion a screen reader
    // would make. A div-with-role would not satisfy the radio/slider roles at all.
    const radios = [
      screen.getByRole('radio', { name: /always show the flash/i }),
      screen.getByRole('radio', { name: /only when i can’t hear the sound/i }),
      screen.getByRole('radio', { name: /never show the flash/i }),
    ];
    const slider = screen.getByLabelText('Cue volume');

    for (const control of [...radios, slider]) {
      expect((control as HTMLElement).tabIndex).toBeGreaterThanOrEqual(0);
      expect(control.hasAttribute('disabled')).toBe(false);
      expect(dialog.contains(control)).toBe(true);
    }

    // The group announces as a group, and 0 reads as "Off" rather than as a bare
    // number with no unit.
    expect(screen.getByRole('group', { name: 'Flash on call events' })).toBeTruthy();
    expect(slider.getAttribute('aria-valuetext')).toBe('70 percent');
    setVolume(0);
    expect(screen.getByLabelText('Cue volume').getAttribute('aria-valuetext')).toBe('Off');
  });

  it('Esc closes it and gives focus back to the trigger', async () => {
    // every transient surface returns focus to the control that opened it.
    // A popover that closes and drops focus to `<body>` strands a keyboard agent at
    // the top of the document — on this screen, past the whole contact panel.
    await mounted();
    const trigger = openSettings();
    const dialog = screen.getByRole('dialog', { name: 'Sound and flash' });

    act(() => {
      fireEvent.keyDown(dialog, { key: 'Escape' });
    });

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not steal the console’s own single-key shortcuts', async () => {
    /**
     * `1`–`9` are the disposition pad's and `a`/`b`/`d`/`/` are the page's. A settings
     * popover that bound a letter would reassign a key by context, which is how
     * muscle memory gets destroyed — an agent who has learned "b = break" must not
     * find it means something else whenever a popover happens to be open.
     */
    await mounted();
    openSettings();
    expect(screen.getByRole('dialog')).toBeTruthy();

    // Focus is on the first radio — the popover puts it there on open — so this
    // fires from a radio, which is the position the agent is in. That is the whole
    // test: `press` targets `document.activeElement`, and firing at `document`
    // instead is what let this pass while `b` was in fact being swallowed by the
    // page's text-field guard.
    expect((document.activeElement as HTMLInputElement).type).toBe('radio');

    press('b');
    // The break menu opened, from inside the settings popover's lifetime: the page's
    // shortcut still reaches the page.
    expect(screen.getByRole('menu', { name: 'Break reasons' })).toBeTruthy();
  });

  it('does not steal them from the volume slider either', async () => {
    /**
     * The slider is the other focus position inside this popover, and it is a
     * *different* element type — `<input type="range">` rather than `type="radio"` —
     * so a guard narrowed by accident to just the one would pass the test above and
     * still leave the agent stuck here. `range` responds to the arrow keys; it has no
     * claim on `b`, and's suppression exists for a note that contains the
     * letter, not for a control that cannot type one.
     */
    await mounted();
    openSettings();
    const slider = screen.getByLabelText('Cue volume') as HTMLInputElement;
    act(() => {
      slider.focus();
    });
    expect(document.activeElement).toBe(slider);
    expect(slider.type).toBe('range');

    press('b');

    expect(screen.getByRole('menu', { name: 'Break reasons' })).toBeTruthy();
  });

  it('the signature the CSS consumes is the one the table publishes', async () => {
    /**
     * The tie between the DOM and the pixels. `StateRail.module.css` drives the pulse
     * count and duration from the custom properties this element sets and picks the
     * keyframe from `[data-cue-travel]` — it never keys off the cue's *name*. So two
     * cues with the same triple render identically and two with different triples
     * cannot, which is what makes the DOM comparisons above assertions about what the
     * agent sees.
     *
     * Asserted against the source because a CSS module's cascade is not observable in
     * happy-dom: this is the narrowest check that catches "the table differentiates
     * and the stylesheet ignores it".
     */
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    // Vitest runs with the repo root as cwd, so this resolves without depending on
    // `import.meta.url`'s scheme under the transform.
    const css = readFileSync(join(process.cwd(), 'src/components/agency/StateRail.module.css'), 'utf8')
      // Comments stripped: the check is about rules, and the block above `.cueFlash`
      // explains the no-name-keyed-rule decision by quoting the selector it forbids.
      .replace(/\/\*[\s\S]*?\*\//g, '');

    expect(css).toContain('animation-iteration-count: var(--cue-pulses)');
    expect(css).toContain('animation-duration: var(--cue-pulse-duration)');
    for (const travel of ['still', 'up', 'down']) {
      expect(css).toContain(`[data-cue-travel='${travel}']`);
    }
    // No name-keyed rule, which is the shape that would let the table say three
    // things while the screen showed one.
    expect(css).not.toMatch(/\[data-cue-flash=/);

    await mounted();
    await act(async () => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
    });
    const element = flash()!;
    expect(element.style.getPropertyValue('--cue-pulses')).toBe(
      String(VISUAL_CUE_SPECS.get_ready.pulses),
    );
    expect(element.style.getPropertyValue('--cue-pulse-duration')).toBe('180ms');
    expect(visualCueSignature('get_ready')).toBe('3x-still-540ms');
  });
});
