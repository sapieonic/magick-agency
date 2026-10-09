import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

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
 * **The disposition pad's unlock, and the frame it must stop depending on.**
 *
 * Wrap-up used to be derived from one thing: `agent_state{state:'wrapup'}`. Core
 * did not emit that frame at all until this week, and while it was missing the pad
 * greyed out the instant a call ended and stayed grey — `/available` then 409s
 * `attempt_not_dispositionable`, so the agent was stuck until the `no_disposition`
 * sweep closed the attempt, and **every disposition on a `requires_disposition`
 * campaign was lost that way**. Nothing errored; the pad simply looked disabled.
 *
 * So there are now three independent routes to the same unlock, and this file
 * exercises each one **in isolation** — a test that emits all three frames proves
 * nothing about any of them. The last two cases are the other half: the pad must
 * still LOCK, because a pad that never locks is a different bug, not a fix.
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
  serverClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
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

const RELEASED_NEEDING_DISPOSITION = {
  event: 'released',
  attempt_id: 'att-1',
  reason: 'remote_hangup',
  requires_disposition: true,
  message: 'Call ended.',
};

const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1]!;

beforeEach(() => {
  FakeSocket.instances = [];
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
  vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
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

/**
 * A **real** drop and reconnect: same mount, second socket, re-minted token.
 *
 * The distinction from a fresh mount is not pedantry — it is the root cause of the
 * `missed_release` defect. Both of that field's original tests emitted `ready` from
 * a fresh mount with everything already `null`, so they exercised the page-reload
 * path only and a handler that could add state but never remove it passed them
 * both. A reconnect keeps every belief the previous socket installed, which is the
 * only condition under which reconciliation is observable.
 */
async function reconnected(): Promise<void> {
  mocks.mintStationToken.mockResolvedValue({
    session_id: 'sess-1',
    station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
    expires_at: '2026-08-11T10:05:00.000Z',
  });
  const before = FakeSocket.instances.length;
  act(() => latest().serverClose(1006, ''));
  await waitFor(() => expect(FakeSocket.instances.length).toBe(before + 1), { timeout: 3000 });
  act(() => latest().open());
}

async function onCall() {
  const view = await opened();
  act(() => {
    latest().emit({ event: 'reserved', attempt: ATTEMPT });
    latest().emit({
      event: 'bridged',
      attempt_id: 'att-1',
      bridged_at: '2026-08-11T10:00:04.000Z',
    });
    latest().emit({ event: 'agent_state', state: 'on_call', since: '2026-08-11T10:00:04.000Z' });
  });
  return view;
}

describe('the disposition pad unlocks through three independent routes', () => {
  it('(b) the `released` frame alone opens it — before any `agent_state` arrives', async () => {
    /**
     * The belt-and-braces route, and the one that matters most.
     *
     * Core's ordering on a connected call is `released` → `agent_state{wrapup}` →
     * `wrapup`, so this route opens the pad a tick earlier than (a) — and, more
     * importantly, it still opens it when `agent_state` never comes at all, which
     * is precisely the world this console shipped into.
     */
    const view = await onCall();
    act(() => latest().emit(RELEASED_NEEDING_DISPOSITION));

    expect(view.result.current.station.agentState).toBe('on_call');
    expect(view.result.current.station.wrapup).toBeNull();
    expect(view.result.current.padEnabled).toBe(true);
  });

  it('(a) `agent_state{wrapup}` alone opens it, with no wrap-up frame behind it', async () => {
    // `wrapup_seconds: 0` with no disposition required emits no `wrapup` frame at
    // all, so this route cannot depend on one.
    const view = await onCall();
    act(() => {
      latest().emit(RELEASED_NEEDING_DISPOSITION);
      latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:05:00.000Z' });
    });

    expect(view.result.current.station.wrapup).toBeNull();
    expect(view.result.current.padEnabled).toBe(true);
  });

  it('(c) a reconnected wrap-up opens it with NO released and NO retained attempt', async () => {
    /**
     * The route a reconnecting socket has, and the only one it has. `ready` carries
     * `active_wrapup` and no attempt payload — core has nothing to hand back for a
     * call that already ended — so both `live` and `retainedAttempt` are null while
     * the agent still owes a disposition core will refuse `/available` over.
     */
    const view = await opened();
    act(() =>
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'wrapup',
        active_wrapup: {
          attempt_id: 'att-1',
          ends_at: '2026-08-11T10:05:30.000Z',
          requires_disposition: true,
          disposition_submitted: false,
          auto_return: true,
        },
      }),
    );

    expect(view.result.current.station.retainedAttempt).toBeNull();
    expect(view.result.current.station.release).toBeNull();
    expect(view.result.current.padEnabled).toBe(true);
    // And it has something to submit against, which is the point of unlocking.
    expect(view.result.current.station.currentAttemptId).toBe('att-1');
  });

  it('stays LOCKED for a release that needs no disposition', async () => {
    // The pad that never locks is the other bug. `no_answer` produces no wrap-up
    // and no frame; nothing here may open on the mere presence of a `released`.
    const view = await onCall();
    act(() =>
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'no_answer',
        requires_disposition: false,
        message: 'Nobody picked up.',
      }),
    );

    expect(view.result.current.padEnabled).toBe(false);
    expect(view.result.current.padDisabledReason).toBe('available when connected');
  });

  it('locks again when `agent_state` leaves wrap-up, closing all three routes at once', async () => {
    /**
     * The routes share their OFF switch rather than each owning one — which is why
     * they cannot disagree into a stuck pad. `agent_state` leaving `wrapup` clears
     * both the retained attempt (killing (a) and (b)) and the anchor (killing (c)).
     *
     * **The two OFF switches are asserted directly rather than through `release`.**
     * This used to assert `release` was still standing "for its copy", which was a
     * proxy for "route (b) was closed by `retainedAttempt`, not by the frame behind
     * it". `release` is now cleared here too (core `#290`: it survives wrap-up only
     * when there was no wrap-up, so the idle panel can tell the truncated path from
     * a finished one), and a `padEnabled: false` that could be explained by a null
     * `release` would no longer catch a handler that stopped clearing the retained
     * attempt. Naming both fields is stronger than the proxy was.
     */
    const view = await onCall();
    act(() => {
      latest().emit(RELEASED_NEEDING_DISPOSITION);
      latest().emit({
        event: 'wrapup',
        wrapup: {
          attempt_id: 'att-1',
          ends_at: '2026-08-11T10:05:30.000Z',
          requires_disposition: true,
          disposition_submitted: false,
          auto_return: true,
        },
      });
      latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:05:00.000Z' });
    });
    expect(view.result.current.padEnabled).toBe(true);

    act(() =>
      latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-11T10:05:40.000Z' }),
    );

    expect(view.result.current.station.retainedAttempt).toBeNull();
    expect(view.result.current.station.wrapup).toBeNull();
    expect(view.result.current.padEnabled).toBe(false);
  });

  describe('a reconnect must not leave the pad open over a window core has closed', () => {
    /**
     * **A regression this file's own route (b) introduced.**
     *
     * `release` and `retainedAttempt` were cleared only by `agent_state` and by
     * `reserved`; `ready` cleared neither. So: `released{requires_disposition:true}`
     * → the socket drops → the wrap-up lapses server-side → core emits
     * `agent_state{available}` **into the dead socket** → the console reconnects and
     * `ready{state:'available'}` restored `agentState` and nothing else. Route (a)
     * went off, route (b) stayed **on**: pad enabled, `currentAttemptId` still the
     * finished attempt. The agent wrote up the call and the submit 409'd.
     *
     * Before route (b) existed this locked correctly, which is what makes it a
     * regression rather than a gap — and it was doing exactly what this file's own
     * comment gives as the reason `missedRelease` is not a fourth route.
     */
    it('locks when `ready` reports the agent back in the pool', async () => {
      const view = await onCall();
      act(() => latest().emit(RELEASED_NEEDING_DISPOSITION));
      // Route (b) alone, which is the state the drop happens in.
      expect(view.result.current.padEnabled).toBe(true);

      act(() => latest().emit({ event: 'ready', session_id: 'sess-1', state: 'available' }));

      expect(view.result.current.padEnabled).toBe(false);
      expect(view.result.current.station.currentAttemptId).toBeNull();
      // A true stated reason, not the waiting-for-dialer lock: there is simply no
      // call to write up.
      expect(view.result.current.padDisabledReason).toBe('available when connected');
    });

    it('locks even when a stale wrap-up anchor is also standing (route (c))', async () => {
      // The same path reaches route (c) through `wrapup.attemptId`, so clearing only
      // the retained attempt would move the defect rather than fix it.
      const view = await onCall();
      act(() => {
        latest().emit(RELEASED_NEEDING_DISPOSITION);
        latest().emit({
          event: 'wrapup',
          wrapup: {
            attempt_id: 'att-1',
            ends_at: '2026-08-11T10:05:30.000Z',
            requires_disposition: true,
            disposition_submitted: false,
            auto_return: true,
          },
        });
        latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:05:00.000Z' });
      });
      expect(view.result.current.padEnabled).toBe(true);

      act(() => latest().emit({ event: 'ready', session_id: 'sess-1', state: 'available' }));

      expect(view.result.current.station.wrapup).toBeNull();
      expect(view.result.current.padEnabled).toBe(false);
    });

    it('but stays OPEN when the reconnect says the agent is still in wrap-up', async () => {
      /**
       * The other direction, and the reason this is a reconciliation rather than a
       * blanket clear. `ready.state` comes from Redis and is authoritative across
       * replicas; `active_wrapup` comes from an in-process map. A reconnect onto a
       * different replica says `wrapup` with no anchor — and the agent still owes the
       * disposition, so locking there would recreate the original lost-disposition
       * bug from the opposite side.
       */
      const view = await onCall();
      act(() => {
        latest().emit(RELEASED_NEEDING_DISPOSITION);
        latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:05:00.000Z' });
      });

      act(() => latest().emit({ event: 'ready', session_id: 'sess-1', state: 'wrapup' }));

      expect(view.result.current.padEnabled).toBe(true);
      expect(view.result.current.station.currentAttemptId).toBe('att-1');
    });
  });

  it('locks again when the next customer arrives', async () => {
    const view = await onCall();
    act(() => {
      latest().emit(RELEASED_NEEDING_DISPOSITION);
      latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:05:00.000Z' });
    });
    expect(view.result.current.padEnabled).toBe(true);

    // A new reservation always wins (§A.8.4) and the next call has not bridged
    // yet, so the pad must be shut even though the previous one earned it.
    act(() =>
      latest().emit({
        event: 'reserved',
        attempt: { ...ATTEMPT, attempt_id: 'att-2', contact_id: 'c-2' },
      }),
    );

    expect(view.result.current.padEnabled).toBe(false);
  });
});

describe('a queued break survives the console that did not request it', () => {
  it('shows the pill from an `agent_state` frame alone', async () => {
    /**
     * The pill's only source used to be the HTTP response that queued the break, so
     * a break queued by a supervisor, from another window, or by this console
     * before a socket blip was invisible — and an invisible queued break is an
     * uncancellable one.
     */
    const view = await onCall();
    act(() =>
      latest().emit({
        event: 'agent_state',
        state: 'wrapup',
        since: '2026-08-11T10:05:00.000Z',
        pending_state: 'break',
        pending_break_reason: 'lunch',
      }),
    );

    // The catalog label, not the raw code — an agent is never shown an enum.
    expect(view.result.current.pendingBreakLabel).toBe('Lunch');
  });

  it('takes the pill back down when a later transition says the queue is empty', async () => {
    // `/break/cancel` emits an `agent_state` with the pending fields omitted for
    // exactly this purpose, so absence has to be able to clear.
    const view = await onCall();
    act(() =>
      latest().emit({
        event: 'agent_state',
        state: 'wrapup',
        since: '2026-08-11T10:05:00.000Z',
        pending_state: 'break',
        pending_break_reason: 'lunch',
      }),
    );
    expect(view.result.current.pendingBreakLabel).toBe('Lunch');

    act(() =>
      latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:05:10.000Z' }),
    );

    expect(view.result.current.pendingBreakLabel).toBeNull();
  });

  it('reads `break_reason` off the HTTP response, which is what core actually sends', async () => {
    /**
     * The mirror said `pending_break_reason` on this body and core has never sent
     * that name — it builds `AgencySessionStateResponse` with `break_reason`, and
     * master proxies it unchanged. The read was `undefined` every time; only the
     * `?? code` fallback kept the pill alive. This mock is core's real shape, so
     * the fallback cannot be what passes it.
     */
    mocks.setAgentBreak.mockResolvedValue({
      session_id: 'sess-1',
      state: 'on_call',
      since: '2026-08-11T10:01:00.000Z',
      pending_state: 'break',
      break_reason: 'lunch',
    });

    const view = await onCall();
    await act(async () => {
      view.result.current.requestBreak('lunch');
    });

    expect(view.result.current.pendingBreakLabel).toBe('Lunch');
  });

  /**
   * **The reconnect half, which core only started answering this week (`4f59d8b`).**
   *
   * The two sources above both require *this* console to have witnessed something:
   * the HTTP response it issued, or a transition frame delivered to a socket it
   * still owned. A drop takes both away, and the next `agent_state` the agent gets
   * is the one `releaseAgent` sends when the break has **already been applied** —
   * so the whole wrap-up window was a blind spot, and core `peek`s the queue rather
   * than taking it, which means the break lands regardless of what the console shows.
   */
  const WRAPUP_ANCHOR = {
    attempt_id: 'att-1',
    ends_at: '2026-08-11T10:05:30.000Z',
    requires_disposition: true,
    disposition_submitted: false,
    auto_return: true,
  };

  it('restores the pill after a genuine drop and reconnect, from `ready` alone', async () => {
    // The primary case: a socket this console owned, dropped mid-call, back on a
    // second socket with every prior belief intact.
    const view = await onCall();
    act(() => latest().emit(RELEASED_NEEDING_DISPOSITION));
    expect(view.result.current.pendingBreakLabel).toBeNull();

    await reconnected();
    act(() =>
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'wrapup',
        active_wrapup: WRAPUP_ANCHOR,
        pending_state: 'break',
        pending_break_reason: 'lunch',
      }),
    );

    expect(view.result.current.pendingBreakLabel).toBe('Lunch');
    // Both reconciliations on one frame, and neither costs the other: the pad is
    // open on route (c) for the disposition the agent still owes.
    expect(view.result.current.padEnabled).toBe(true);
    expect(view.result.current.station.currentAttemptId).toBe('att-1');
  });

  it('shows it after a page reload too, where no transition frame has ever landed', async () => {
    /**
     * The reload path, kept as its own case because the console's mirror used to be
     * gated on `agentStateSince` — and `ready` carries no `since`, deliberately, so
     * that guard rejected the only frame a reloaded console gets. The pill was
     * therefore still invisible here after the hook itself was fixed: an agent about
     * to be pulled out of the pool, shown nothing, on the most ordinary recovery
     * there is.
     */
    const view = await opened();
    act(() =>
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'wrapup',
        active_wrapup: WRAPUP_ANCHOR,
        pending_state: 'break',
        pending_break_reason: 'lunch',
      }),
    );

    expect(view.result.current.station.agentStateSince).toBeNull();
    expect(view.result.current.pendingBreakLabel).toBe('Lunch');
  });

  it('takes the pill down when the reconnect says the queue is empty', async () => {
    // Absence is a statement on `ready` exactly as it is on `agent_state`: the break
    // was cancelled from another window, or has already landed. Leaving the pill up
    // offers a ✕ whose subject no longer exists.
    const view = await onCall();
    act(() =>
      latest().emit({
        event: 'agent_state',
        state: 'wrapup',
        since: '2026-08-11T10:05:00.000Z',
        pending_state: 'break',
        pending_break_reason: 'lunch',
      }),
    );
    expect(view.result.current.pendingBreakLabel).toBe('Lunch');

    await reconnected();
    act(() =>
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'wrapup',
        active_wrapup: WRAPUP_ANCHOR,
      }),
    );

    expect(view.result.current.pendingBreakLabel).toBeNull();
    // And the pad is still open. Clearing the queue says nothing about the wrap-up.
    expect(view.result.current.padEnabled).toBe(true);
  });

  it('takes down a pill only the HTTP response ever confirmed', async () => {
    /**
     * **The case a value-keyed reconciliation cannot reach, and it is not exotic.**
     *
     * `/break` answers on HTTP *and* pushes an `agent_state` — but the push goes to
     * a socket that may already be dying, and the response comes back on a
     * different connection, so "the pill is up from the response and no frame ever
     * carried it" is a reachable state. If the break is then cancelled from another
     * window while this console is offline, the reconnect's `ready` reports an empty
     * queue — with the station's own value going `null` → `null` and no transition
     * marker moving. Keyed on either of those, the effect never re-runs and the ✕
     * stays on screen over a break that no longer exists.
     */
    mocks.setAgentBreak.mockResolvedValue({
      session_id: 'sess-1',
      state: 'on_call',
      since: '2026-08-11T10:01:00.000Z',
      pending_state: 'break',
      break_reason: 'lunch',
    });
    const view = await onCall();
    await act(async () => {
      view.result.current.requestBreak('lunch');
    });
    expect(view.result.current.pendingBreakLabel).toBe('Lunch');
    // The frame that would have confirmed it never arrived on this socket.
    expect(view.result.current.station.pendingBreakCode).toBeNull();

    await reconnected();
    act(() =>
      latest().emit({
        event: 'ready',
        session_id: 'sess-1',
        state: 'on_call',
        active_attempt: {
          ...ATTEMPT,
          bridged_at: '2026-08-11T10:00:04.000Z',
          state: 'bridged',
        },
      }),
    );

    expect(view.result.current.pendingBreakLabel).toBeNull();
  });
});
