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

const analyticsMocks = vi.hoisted(() => ({
  trackAgencyDispositionSubmitted: vi.fn(),
}));
// Every other emitter passes through to the real (no-op-without-a-key)
// implementation — only `trackAgencyDispositionSubmitted` is spied on here.
vi.mock('../../analytics/events', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../analytics/events')>();
  return { ...actual, trackAgencyDispositionSubmitted: analyticsMocks.trackAgencyDispositionSubmitted };
});

import {
  useAgencyConsole,
  AGENT_STATE_RECONCILE_MS,
  WAITING_FOR_DIALER_COPY,
} from '../../pages/agency/useAgencyConsole';
import { ApiError } from '../../api/client';
import type { AgencyReservedAttempt, AgencySessionBootstrap } from '../../types/agency';

/**
 * The refusal core actually sends, thrown the way `apiFetch` actually throws it.
 *
 * Deliberately a **real `ApiError`** rather than `Object.assign(new Error(), {…})`.
 * The hand-built version carried `status`/`body`; `ApiError` carries
 * `statusCode`/`details`, and the console read the hand-built names — so these
 * tests passed against a shape the client cannot produce and the 409 was invisible
 * in production. Constructing the real error is what makes them evidence: a
 * rename in `api/client.ts` now fails here instead of shipping.
 */
function dispositionRequiredRefusal(): ApiError {
  return new ApiError(409, {
    error: 'Disposition Required',
    code: 'attempt_not_dispositionable',
    message: 'Submit a disposition for your last call before going available.',
  });
}

/**
 * §A.13.8's "**disposition submitted, no `agent_state` follows**" row, tested
 * where it is consumed — through the real station hook and real frames, not
 * against a hand-built state object. The row is the only place in Phase 2 where
 * the console is licensed to read a disposition response's `agent_state`, and the
 * whole risk is that it reads it *too eagerly*: the field races the socket by
 * design, so a console that reconciles from it whenever it arrives drops the panel
 * for a customer who is already talking.
 *
 * Every assertion here was checked against the code with the clause it names
 * removed. Two of them could not fail and were rewritten rather than kept:
 * asserting "no waiting line after a `reserved` for another attempt" passed while
 * the fire-time guard was deleted, because a second mechanism (cancelling the
 * timer on an attempt change) was covering for it. That second mechanism was
 * removed, which is what gives the guard below something to defend.
 */

/** Minimal fake WebSocket that lets a test drive the server side. */
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

const NEXT_ATTEMPT: AgencyReservedAttempt = { ...ATTEMPT, attempt_id: 'att-2', contact_id: 'c-2' };

const BOOTSTRAP: AgencySessionBootstrap = {
  session_id: 'sess-1',
  campaign_id: 'camp-1',
  campaign_name: 'Renewals',
  agent_user_id: 'u-1',
  state: 'offline',
  campaign_status: 'running',
  station_ws_url: '/proxy/agency/station/sess-1?token=t1',
  disposition_catalog: [
    { code: 'sale', label: 'Sale' },
    { code: 'not_interested', label: 'Not interested' },
  ],
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

/** A saved response. `agentState: null` omits the field — the row's "also absent" arm. */
function savedBody(attemptId: string, agentState: string | null) {
  const body: Record<string, unknown> = {
    attempt_id: attemptId,
    contact_id: 'c-1',
    disposition_code: 'sale',
    contact_state: 'completed',
    next_attempt_at: null,
  };
  if (agentState !== null) body['agent_state'] = agentState;
  return body;
}

function latest(): FakeSocket {
  return FakeSocket.instances[FakeSocket.instances.length - 1]!;
}

describe('useAgencyConsole — the 3s reconciliation window (§A.13.8)', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    Object.values(mocks).forEach((m) => m.mockReset());
    analyticsMocks.trackAgencyDispositionSubmitted.mockReset();
    mocks.saveAttemptNotes.mockResolvedValue({ saved: false, refusal: 'not_hydrated' });
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
    vi.useFakeTimers();
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function opened() {
    const view = renderHook(() => useAgencyConsole(BOOTSTRAP, 'tenant-1', 'account-1'));
    await act(async () => {});
    act(() => latest().open());
    return view;
  }

  /** Bridged and talking: the pad is open because `bridged` opened it. */
  async function onCall() {
    const view = await opened();
    act(() => {
      latest().emit({ event: 'reserved', attempt: ATTEMPT });
      latest().emit({ event: 'agent_state', state: 'reserved', since: '2026-08-11T10:00:00.000Z' });
      latest().emit({
        event: 'bridged',
        attempt_id: 'att-1',
        bridged_at: '2026-08-11T10:00:04.000Z',
      });
      latest().emit({ event: 'agent_state', state: 'on_call', since: '2026-08-11T10:00:04.000Z' });
    });
    return view;
  }

  /** The call has ended and a disposition is owed. */
  async function inWrapup() {
    const view = await onCall();
    act(() => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'customer_hangup',
        requires_disposition: true,
        message: 'Call ended.',
      });
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
    return view;
  }

  type View = Awaited<ReturnType<typeof inWrapup>>;

  async function submitSale(view: View) {
    act(() => view.result.current.setForm({ selectedCode: 'sale', notes: '', callbackAt: null }));
    await act(async () => {
      view.result.current.submit();
    });
  }

  /**
   * Pins two fields on `trackAgencyDispositionSubmitted` that were previously
   * hardcoded (`seconds_to_submit: 0`) or unverified end-to-end
   * (`selection_method`) — see `useAgencyStation.ts`'s `releasedAt` and
   * `useAgencyConsole.ts`'s `noteCodeSelectionMethod`/`selectionMethodRef`.
   */
  it('analytics: seconds_to_submit measures real elapsed time since release, and reports the real code index and selection method', async () => {
    mocks.submitDisposition.mockResolvedValue(savedBody('att-1', null));
    const view = await inWrapup();

    // The agent selected the code with a number key, then took 45s to submit.
    act(() => view.result.current.noteCodeSelectionMethod('number_key'));
    await act(async () => {
      vi.advanceTimersByTime(45_000);
    });
    await submitSale(view);

    expect(analyticsMocks.trackAgencyDispositionSubmitted).toHaveBeenCalledWith(
      expect.objectContaining({
        campaign_id: 'camp-1',
        // 'sale' is BOOTSTRAP.disposition_catalog[0].
        code_index: 0,
        seconds_to_submit: 45,
        selection_method: 'number_key',
      }),
    );
  });

  it('says so when nothing follows the save, and locks the pad without closing the notes', async () => {
    mocks.submitDisposition.mockResolvedValue(savedBody('att-1', null));
    const view = await inWrapup();
    expect(view.result.current.padEnabled).toBe(true);

    await submitSale(view);
    // Nothing is claimed before the window elapses — a console that announced at
    // once would be announcing a silence it has not yet observed.
    expect(view.result.current.waitingForDialer).toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(AGENT_STATE_RECONCILE_MS + 10);
    });

    expect(view.result.current.waitingForDialer).toBe(WAITING_FOR_DIALER_COPY);
    // "with the pad locked so it cannot be submitted twice"
    expect(view.result.current.padEnabled).toBe(false);
    // A disabled control carries a TRUE stated reason. "available when connected"
    // is false here: the call connected, and it is over.
    expect(view.result.current.padDisabledReason).toBe(WAITING_FOR_DIALER_COPY);
    /**
     * The notes route is accepted through wrap-up regardless (§A.13.7), so the
     * lock must not take the field with it. Written as its own assertion because
     * the tempting implementation — `notesEnabled = padEnabled` — passes every
     * other assertion in this test.
     */
    expect(view.result.current.notesEnabled).toBe(true);
    expect(view.result.current.notesDisabledReason).toBeNull();
  });

  it('says the same thing when the response DID carry a state — both arms, one line', async () => {
    /**
     * The coordinator's ruling, pending designer ratification. An earlier revision
     * read §A.13.8's "if that is also absent" as forbidding the copy here, which
     * left the reconcile arm silent — and the agent cannot tell "reconciled, still
     * waiting" from "no frame ever came", because both are a wrap-up rail holding a
     * saved disposition. Silence there is the dead end the copy exists to prevent.
     */
    mocks.submitDisposition.mockResolvedValue(savedBody('att-1', 'available'));
    const view = await inWrapup();
    await submitSale(view);

    await act(async () => {
      vi.advanceTimersByTime(AGENT_STATE_RECONCILE_MS + 10);
    });

    expect(view.result.current.waitingForDialer).toBe(WAITING_FOR_DIALER_COPY);
    // And the response STILL did not move the rail: `agent_state` is the sole
    // authority, and no frame said the agent left wrap-up (§A.13.1). The advisory
    // buys the line, never the state.
    expect(view.result.current.station.agentState).toBe('wrapup');
  });

  it('clears a queued break from the response only — the pill, never the rail', async () => {
    // Core's real body shape: `break_reason`, and a `since`. It does not send
    // `pending_break_reason` on an HTTP response — only on the socket frame.
    mocks.setAgentBreak.mockResolvedValue({
      session_id: 'sess-1',
      state: 'on_call',
      since: '2026-08-11T10:01:00.000Z',
      pending_state: 'break',
      break_reason: 'lunch',
    });
    mocks.submitDisposition.mockResolvedValue(savedBody('att-1', 'break'));

    const view = await onCall();
    await act(async () => {
      view.result.current.requestBreak('lunch');
    });
    expect(view.result.current.pendingBreakLabel).toBe('Lunch');

    act(() => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'customer_hangup',
        requires_disposition: true,
        message: 'Call ended.',
      });
      /**
       * **Wrap-up entry carries the queued break, and this fixture now says so.**
       *
       * Core's `WrapupManager` puts `pending_state`/`pending_break_reason` on this
       * frame deliberately — it is the only transition frame inside the wrap-up
       * window, so omitting it would leave the console unable to answer "am I
       * getting another call after this one". Without them here the console would
       * clear the pill on this frame (absence means "nothing queued") and the
       * assertion below would pass having proved nothing about the advisory state.
       */
      latest().emit({
        event: 'agent_state',
        state: 'wrapup',
        since: '2026-08-11T10:05:00.000Z',
        pending_state: 'break',
        pending_break_reason: 'lunch',
      });
    });
    // Still queued going into the submit — which is what makes the clearing below
    // attributable to the disposition response rather than to the frame.
    expect(view.result.current.pendingBreakLabel).toBe('Lunch');
    await submitSale(view);

    await act(async () => {
      vi.advanceTimersByTime(AGENT_STATE_RECONCILE_MS + 10);
    });

    /**
     * §A.13.6: "the correct post-submit state is `break`, not `available`" — so the
     * queued break was promoted and the pill's subject is gone. This is the only
     * thing the advisory state is allowed to change.
     */
    expect(view.result.current.pendingBreakLabel).toBeNull();
    expect(view.result.current.station.agentState).toBe('wrapup');
  });

  it('an agent_state inside the window ends the wait, even though the attempt never changed', async () => {
    // Submitted mid-call, which the pad allows: the release and wrap-up frames then
    // land inside the window. The attempt is unchanged throughout, so the
    // attempt-identity guard sees nothing and the frame-identity guard is the only
    // thing standing between the agent and a line claiming the dialer went quiet.
    mocks.submitDisposition.mockResolvedValue(savedBody('att-1', null));
    const view = await onCall();
    await submitSale(view);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    act(() => {
      latest().emit({
        event: 'released',
        attempt_id: 'att-1',
        reason: 'customer_hangup',
        requires_disposition: true,
        message: 'Call ended.',
      });
      latest().emit({ event: 'agent_state', state: 'wrapup', since: '2026-08-11T10:05:00.000Z' });
    });
    await act(async () => {
      vi.advanceTimersByTime(AGENT_STATE_RECONCILE_MS);
    });

    expect(view.result.current.station.currentAttemptId).toBe('att-1');
    expect(view.result.current.waitingForDialer).toBeNull();
    expect(view.result.current.padEnabled).toBe(true);
  });

  it('a reserved for the next customer, with no agent_state beside it, never locks their pad', async () => {
    /**
     * The console must not assume `reserved` and `agent_state` travel together.
     * With only `reserved` delivered, the frame-identity guard sees no change — so
     * this is the case the attempt-identity guard exists for, and without it the
     * next customer's pad is locked under a line about the previous call.
     */
    mocks.submitDisposition.mockResolvedValue(savedBody('att-1', null));
    const view = await inWrapup();
    await submitSale(view);

    await act(async () => {
      vi.advanceTimersByTime(1000);
    });
    act(() => latest().emit({ event: 'reserved', attempt: NEXT_ATTEMPT }));
    await act(async () => {
      vi.advanceTimersByTime(AGENT_STATE_RECONCILE_MS);
    });

    expect(view.result.current.station.currentAttemptId).toBe('att-2');
    expect(view.result.current.waitingForDialer).toBeNull();
    expect(view.result.current.padDisabledReason).toBe('available when connected');
  });

  it('drops a line already rendered when the next customer arrives', async () => {
    mocks.submitDisposition.mockResolvedValue(savedBody('att-1', null));
    const view = await inWrapup();
    await submitSale(view);
    await act(async () => {
      vi.advanceTimersByTime(AGENT_STATE_RECONCILE_MS + 10);
    });
    expect(view.result.current.waitingForDialer).toBe(WAITING_FOR_DIALER_COPY);

    act(() => latest().emit({ event: 'reserved', attempt: NEXT_ATTEMPT }));

    expect(view.result.current.waitingForDialer).toBeNull();
  });

  it('states core 409 refusal of /available instead of swallowing it', async () => {
    /**
     * `/sessions/:id/available` refuses with **409 `attempt_not_dispositionable`**
     * while a required disposition is outstanding (core `agency.routes.ts:146`),
     * and that refusal is the entire mechanism making a disposition mandatory.
     * Master forwards it verbatim rather than mirroring the rule.
     *
     * The handler used to catch-and-ignore, on the reasoning that `agent_state`
     * reconciles the rail anyway. It does — and that is exactly the problem: the
     * agent presses the control, the rail correctly does not move, and **nothing
     * is said**. The only reading left to them is that the product is broken, and
     * the remedy is one sentence core already wrote.
     */
    const refusal = dispositionRequiredRefusal();
    mocks.setAgentAvailable.mockRejectedValue(refusal);

    const view = await inWrapup();
    await act(async () => {
      view.result.current.goAvailable();
    });

    expect(view.result.current.presenceRefusal).toBe(
      'Submit a disposition for your last call before going available.',
    );
    // Not an error banner and not a state change: the rail is still whatever
    // `agent_state` last said, because a refusal moves nothing (§A.13.1).
    expect(view.result.current.station.agentState).toBe('wrapup');
  });

  it('retires the refusal once agent_state actually moves', async () => {
    const refusal = dispositionRequiredRefusal();
    mocks.setAgentAvailable.mockRejectedValue(refusal);
    const view = await inWrapup();
    await act(async () => {
      view.result.current.goAvailable();
    });
    expect(view.result.current.presenceRefusal).not.toBeNull();

    act(() => {
      latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-11T10:06:00.000Z' });
    });

    // Left standing, it would tell an agent who IS available that they still owe a
    // disposition — the stale-stated-reason defect, in the one place the agent has
    // no way to check.
    expect(view.result.current.presenceRefusal).toBeNull();
  });

  it('does not send a second disposition for an attempt already recorded', async () => {
    mocks.submitDisposition.mockResolvedValue(savedBody('att-1', null));
    const view = await inWrapup();
    await submitSale(view);
    expect(mocks.submitDisposition).toHaveBeenCalledTimes(1);

    // §A.13.6's second guard. The disabled button is the first, and it is not this
    // one: `Ctrl+Enter` reaches `submit()` without going near the button.
    await submitSale(view);
    expect(mocks.submitDisposition).toHaveBeenCalledTimes(1);
  });
});
