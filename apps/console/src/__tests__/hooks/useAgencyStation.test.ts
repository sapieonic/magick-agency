import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ mintStationToken: vi.fn() }));
vi.mock('../../api/agency', () => ({ mintStationToken: mocks.mintStationToken }));

import { useAgencyStation } from '../../hooks/useAgencyStation';
import type { AgencySessionBootstrap, AgencyReservedAttempt } from '../../types/agency';

/**
 * The rule this file exists to protect: **`bridged` and nothing else opens the
 * call.** `status: 'answered'` means the carrier says the far end went
 * off-hook; `bridged` means audio is flowing to THIS agent's socket. An agent
 * whose connect cue fires on `answered` is told a human is on the line while
 * still on dead air.
 */

/** Minimal fake WebSocket that lets a test drive the server side. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  // The full set the production code compares against. With only `OPEN`, every
  // `readyState === WebSocket.CONNECTING` test in the hook evaluated
  // `0 === undefined` — so `abandon()`'s CONNECTING arm, which is what stops a
  // still-upgrading socket from leaking past its generation, was dead in the
  // entire suite. `useWebRtcCall.test.ts` already declares these.
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closedWith: { code: number; reason: string } | null = null;

  constructor(public url: string) {
    FakeSocket.instances.push(this);
  }

  /**
   * Opt-in: answer every `ping` with its `pong`, as the server does.
   *
   * Off by default because most tests assert on `sent`. It exists so that "the
   * line recovered" can be modelled as *the server answering again* rather than
   * as a hand-emitted pong — which is the difference between a test that can see
   * whether the client is still pinging and one that cannot.
   */
  autoPong = false;

  send(data: string): void {
    this.sent.push(data);
    if (!this.autoPong) return;
    try {
      const frame = JSON.parse(data);
      if (frame?.event === 'ping') this.emit({ event: 'pong', ts: frame.ts, server_ts: frame.ts });
    } catch { /* media/binary */ }
  }

  close(code = 1000, reason = ''): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  // ── test drivers ──
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  emit(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  emitRaw(data: string): void {
    this.onmessage?.({ data });
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

function latest(): FakeSocket {
  return FakeSocket.instances[FakeSocket.instances.length - 1]!;
}

/**
 * A **genuine** socket drop and reconnect: the same mount, a second `FakeSocket`,
 * a re-minted token — what a wifi blip actually produces.
 *
 * Not interchangeable with a fresh `renderHook`, and the difference has already
 * cost this file a defect. A fresh mount is the *page reload* path: every field
 * starts empty, so a `ready` that fails to clear something looks identical to one
 * that clears it correctly. Both original tests for `missed_release` were written
 * that way, which is why nothing caught a `ready` handler that could add state and
 * never remove it. A reconnect keeps everything the previous socket taught this
 * console, and that is the only shape in which reconciliation can be observed.
 */
async function reconnected(): Promise<void> {
  mocks.mintStationToken.mockResolvedValue({
    session_id: 'sess-1',
    station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
    expires_at: '2026-08-11T10:05:00.000Z',
  });
  const before = FakeSocket.instances.length;
  // 1006, an abnormal close: the ordinary drop, and the only one that retries.
  act(() => latest().serverClose(1006, ''));
  await waitFor(() => expect(FakeSocket.instances.length).toBe(before + 1), { timeout: 3000 });
  act(() => latest().open());
}

describe('useAgencyStation', () => {
  beforeEach(() => {
    FakeSocket.instances = [];
    mocks.mintStationToken.mockReset();
    vi.stubGlobal('WebSocket', FakeSocket as unknown as typeof WebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function mounted() {
    const view = renderHook(() => useAgencyStation(BOOTSTRAP));
    await waitFor(() => expect(FakeSocket.instances.length).toBe(1));
    act(() => latest().open());
    await waitFor(() => expect(view.result.current.connection).toBe('open'));
    return view;
  }

  describe('the connect rule', () => {
    it('does NOT open the call on a bridge `status: answered` frame', async () => {
      // The single most important assertion in this feature.
      const view = await mounted();
      act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
      act(() => latest().emit({ event: 'status', status: 'answered' }));

      expect(view.result.current.live?.bridgedAt).toBeNull();
    });

    it('opens the call ONLY on `bridged`, carrying the server anchor', async () => {
      const view = await mounted();
      act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
      act(() =>
        latest().emit({
          event: 'bridged',
          attempt_id: 'att-1',
          bridged_at: '2026-08-11T10:00:00.000Z',
        }),
      );

      // The talk timer counts from the SERVER anchor, never local receipt time.
      expect(view.result.current.live?.bridgedAt).toBe('2026-08-11T10:00:00.000Z');
    });

    it('ignores a `bridged` for a different attempt', async () => {
      const view = await mounted();
      act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
      act(() => latest().emit({ event: 'bridged', attempt_id: 'other', bridged_at: 'x' }));
      expect(view.result.current.live?.bridgedAt).toBeNull();
    });
  });

  describe('diagnostic frames never move the UI', () => {
    it.each([
      { event: 'status', status: 'ringing' },
      { event: 'status', status: 'completed' },
      { event: 'ended', reason: 'remote_hangup' },
    ])('routes %o to diagnostics and leaves state untouched', async (frame) => {
      const view = await mounted();
      act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
      const before = view.result.current.live;

      act(() => latest().emit(frame));

      expect(view.result.current.live).toEqual(before);
      expect(view.result.current.release).toBeNull();
      expect(view.result.current.diagnostics.at(-1)?.event).toBe(frame.event);
    });

    it('does NOT clear the panel on a bridge `ended` frame', async () => {
      // `ended` carries no requires_disposition and no agency reason, so a
      // console that clears on it will sometimes clear a call that still needs
      // a disposition, and always without being able to say why.
      const view = await mounted();
      act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
      act(() => latest().emit({ event: 'ended', reason: 'completed' }));
      expect(view.result.current.live).not.toBeNull();
    });

    it('routes an unknown future frame to diagnostics without throwing', async () => {
      // The server ships independently; an unrecognised frame is expected traffic.
      const view = await mounted();
      expect(() =>
        act(() => latest().emit({ event: 'something_added_next_quarter', payload: 1 })),
      ).not.toThrow();
      expect(view.result.current.connection).toBe('open');
      expect(view.result.current.diagnostics.at(-1)?.event).toBe(
        'something_added_next_quarter',
      );
    });

    it('survives non-JSON and malformed frames', async () => {
      const view = await mounted();
      act(() => latest().emitRaw('not json at all'));
      act(() => latest().emitRaw('{"no":"event"}'));
      expect(view.result.current.connection).toBe('open');
    });
  });

  describe('authoritative frames', () => {
    it('takes agent state only from `agent_state`', async () => {
      const view = await mounted();
      expect(view.result.current.agentState).toBe('offline');
      act(() => latest().emit({ event: 'agent_state', state: 'available', since: 'now' }));
      expect(view.result.current.agentState).toBe('available');
    });

    it('renders the context panel from `reserved` with no HTTP call', async () => {
      const view = await mounted();
      act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
      // The data arrived WITH the event — there is no request that could lose
      // the race against the carrier answering.
      expect(view.result.current.live?.attempt.context).toEqual({ 'First Name': 'Asha' });
      expect(mocks.mintStationToken).not.toHaveBeenCalled();
    });

    it('treats `countdown` as a frame nobody sends — diagnostics only, panel untouched', async () => {
      /**
       * This used to assert that `countdown` drove `live.secondsRemaining` and
       * `live.ringing`, and it passed — for a frame **the server emits from nowhere**,
       * into two fields **nothing read**. a search of the server source for `'countdown'`
       * finds the contract type, `intervals.countdown_ms` and prose, and no `send`;
       * `StateRail` has always derived "Ringing — get ready" from
       * `bridgedAt === null`. So the green test proved a handler, not a countdown.
       *
       * The replacement asserts the property that is actually true and that a
       * re-added handler would break: the frame moves nothing and is logged like
       * any other unrecognised traffic. Deliberately not
       * `expect(live.secondsRemaining).toBeUndefined()` — that is satisfied by
       * absence and equally satisfied if the hook stopped working entirely.
       */
      const view = await mounted();
      act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
      const before = view.result.current.live;

      act(() => latest().emit({ event: 'countdown', attempt_id: 'att-1', seconds_remaining: 3 }));

      expect(view.result.current.live).toEqual(before);
      expect(view.result.current.live?.bridgedAt).toBeNull();
      expect(view.result.current.diagnostics.at(-1)?.event).toBe('countdown');
    });

    it('clears the panel on `released` and keeps the frame for its copy', async () => {
      const view = await mounted();
      act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
      act(() =>
        latest().emit({
          event: 'released',
          attempt_id: 'att-1',
          reason: 'no_answer',
          requires_disposition: false,
          message: 'Nobody picked up.',
        }),
      );

      expect(view.result.current.live).toBeNull();
      expect(view.result.current.release?.reason).toBe('no_answer');
    });

    it('rehydrates a live attempt from `ready` after a reconnect', async () => {
      // Otherwise the agent stares at an empty panel while a customer talks.
      const view = await mounted();
      act(() =>
        latest().emit({
          event: 'ready',
          session_id: 'sess-1',
          state: 'on_call',
          active_attempt: ATTEMPT,
        }),
      );
      expect(view.result.current.live?.attempt.attempt_id).toBe('att-1');
      expect(view.result.current.agentState).toBe('on_call');
    });

    /**
     * The three fields the server sends on the wire that this mirror used to drop. Each
     * one has a consequence for an agent whose socket blipped, and each was
     * invisible: the frames arrived, parsed, and fell into the `ready` /
     * `agent_state` handlers where nothing read them.
     */
    describe('the reconnect fields on `ready` and `agent_state`', () => {
      const WRAPUP = {
        attempt_id: 'att-1',
        ends_at: '2026-08-11T10:05:30.000Z',
        requires_disposition: true,
        disposition_submitted: false,
        auto_return: true,
      };

      it('resumes the wrap-up window from `ready.active_wrapup`', async () => {
        /**
         * The server's wrap-up countdown is an in-process timer, so it survives the
         * socket drop — but the `wrapup` frame that opened it does not, and the server
         * deliberately does not re-emit one. Dropped, a reconnecting agent gets no
         * deadline, no held-reason, and (see `currentAttemptId` below) nothing to
         * submit a disposition against.
         */
        const view = await mounted();
        act(() =>
          latest().emit({
            event: 'ready',
            session_id: 'sess-1',
            state: 'wrapup',
            active_wrapup: WRAPUP,
          }),
        );

        expect(view.result.current.wrapup?.attemptId).toBe('att-1');
        expect(view.result.current.wrapup?.requiresDisposition).toBe(true);
        // The absolute deadline, read off the frame rather than reconstructed.
        expect(view.result.current.wrapup?.deadlineMs).toBe(Date.parse(WRAPUP.ends_at));
      });

      it('holds the attempt id through a reconnected wrap-up, so a disposition can still be sent', async () => {
        // `live` and `retainedAttempt` are both null here — the server has no attempt
        // payload for a call that already ended. Without the wrap-up anchor as a
        // third source, `submit()` returns early on a null attempt id and the agent
        // owes a disposition they cannot send.
        const view = await mounted();
        act(() =>
          latest().emit({
            event: 'ready',
            session_id: 'sess-1',
            state: 'wrapup',
            active_wrapup: WRAPUP,
          }),
        );

        expect(view.result.current.live).toBeNull();
        expect(view.result.current.retainedAttempt).toBeNull();
        expect(view.result.current.currentAttemptId).toBe('att-1');
      });

      it('keeps `missed_release` — the server consumes it on read, so this frame is the only offer', async () => {
        /**
         * `takeMissedRelease` clears as it reads on the server's side. Dropping this does
         * not delay the information, it destroys it: the agent comes back to an
         * empty station with no account of the call they were on.
         */
        const view = await mounted();
        act(() =>
          latest().emit({
            event: 'ready',
            session_id: 'sess-1',
            state: 'available',
            missed_release: {
              attempt_id: 'att-1',
              reason: 'remote_hangup',
              requires_disposition: false,
              message: 'The customer hung up.',
              ended_at: '2026-08-11T10:04:00.000Z',
            },
          }),
        );

        expect(view.result.current.missedRelease?.attempt_id).toBe('att-1');
        expect(view.result.current.missedRelease?.reason).toBe('remote_hangup');
      });

      it('CLEARS the live attempt a `missed_release` says has ended', async () => {
        /**
         * **This test used to assert the opposite, and the opposite was the bug.**
         *
         * It emitted `ready{state:'on_call', missed_release}` with no
         * `active_attempt` and checked that `live` *survived* — using a frame
         * combination the server cannot produce. The server sends `missed_release` **exactly**
         * when it holds no attempt (`agency.routes.ts:880`:
         * `activeAttempt ? null : takeMissedRelease(...)`) and only when the
         * `released` frame could not be delivered (`agency-dialer.ts:646`:
         * `if (!delivered)`). Those two conditions together mean: this console's
         * `live` is still set from before the drop, and the attempt it names is over.
         *
         * So the property under test is the reverse of what was written. Keeping
         * `live` held a dead call open in every visible respect — microphone armed
         * with the recording indicator lit, talk timer running, pad unlocked — and
         * `panelAttempt` stayed truthy, which suppressed the only component that
         * renders the missed-release notice. The server had already consumed the record, so
         * it was destroyed rather than delayed.
         */
        const view = await mounted();
        act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
        act(() =>
          latest().emit({
            event: 'bridged',
            attempt_id: 'att-1',
            bridged_at: '2026-08-11T10:00:04.000Z',
          }),
        );
        // A bridged call, exactly as it stands when the wifi goes.
        expect(view.result.current.live?.bridgedAt).toBe('2026-08-11T10:00:04.000Z');

        act(() =>
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
          }),
        );

        // The call is over. This is what disarms the microphone and lets the idle
        // panel — and therefore the notice — mount.
        expect(view.result.current.live).toBeNull();
        expect(view.result.current.missedRelease?.attempt_id).toBe('att-1');
        // Still not routed through the live `released` handler: no disconnect cue, no
        // wrap-up opened, and `release` stays null so the panel does not render a
        // transition that did not happen on this socket.
        expect(view.result.current.release).toBeNull();
        expect(view.result.current.retainedAttempt).toBeNull();
        expect(view.result.current.wrapup).toBeNull();
      });

      /**
       * **`ready` is a snapshot, so every field must replace OR clear.**
       *
       * The handler used to apply each field only when present, which made a
       * reconnect purely additive: everything the console believed from the previous
       * socket's frames survived a `ready` that contradicted it. That is not a
       * cosmetic asymmetry — the server cannot contradict this console any other way,
       * because the frames that would have (`released`, `agent_state`) went into the
       * socket that had already gone.
       */
      describe('`ready` reconciles rather than only adding', () => {
        it('clears a wrap-up that lapsed while the socket was away', async () => {
          /**
           * The regression this exists to catch, step by step: a `released` needing a
           * disposition, then a drop, then the wrap-up lapses server-side, then the server
           * emits `agent_state{available}` into the dead socket, then we reconnect.
           * `ready{state:'available'}` used to set `agentState` and nothing else, so
           * the retained attempt, the release frame and the wrap-up anchor all
           * survived — and the pad stayed unlocked over a window the server had closed.
           */
          const view = await mounted();
          act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
          act(() =>
            latest().emit({
              event: 'bridged',
              attempt_id: 'att-1',
              bridged_at: '2026-08-11T10:00:04.000Z',
            }),
          );
          act(() => {
            latest().emit({
              event: 'released',
              attempt_id: 'att-1',
              reason: 'remote_hangup',
              requires_disposition: true,
              message: 'The customer hung up.',
            });
            latest().emit({ event: 'wrapup', wrapup: WRAPUP });
            latest().emit({
              event: 'agent_state',
              state: 'wrapup',
              since: '2026-08-11T10:05:00.000Z',
            });
          });
          expect(view.result.current.retainedAttempt?.attempt_id).toBe('att-1');
          expect(view.result.current.wrapup).not.toBeNull();

          // The reconnect. The server says the agent is back in the pool.
          act(() =>
            latest().emit({ event: 'ready', session_id: 'sess-1', state: 'available' }),
          );

          expect(view.result.current.retainedAttempt).toBeNull();
          expect(view.result.current.release).toBeNull();
          expect(view.result.current.wrapup).toBeNull();
          // Nothing left pointing at the finished attempt, so a submit cannot be
          // aimed at it.
          expect(view.result.current.currentAttemptId).toBeNull();
        });

        it('keeps the wrap-up when the server still says `wrapup`, even with no anchor', async () => {
          /**
           * The other direction, and the reason absence of `active_wrapup` must not be
           * read as "the window closed". `frame.state` comes from Redis
           * (`runtime.ts:124-126`) and is authoritative across replicas;
           * `active_wrapup` comes from an in-process `Map`
           * (`wrapup-manager.ts:65-68`). A reconnect that lands on a **different
           * replica** therefore reports `wrapup` with no anchor while the agent is
           * genuinely still in wrap-up and still owes a disposition.
           *
           * The anchor we already hold is kept (its deadline is still true) and none
           * is invented.
           */
          const view = await mounted();
          act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
          act(() =>
            latest().emit({
              event: 'bridged',
              attempt_id: 'att-1',
              bridged_at: '2026-08-11T10:00:04.000Z',
            }),
          );
          act(() => {
            latest().emit({
              event: 'released',
              attempt_id: 'att-1',
              reason: 'remote_hangup',
              requires_disposition: true,
              message: 'The customer hung up.',
            });
            latest().emit({ event: 'wrapup', wrapup: WRAPUP });
            latest().emit({
              event: 'agent_state',
              state: 'wrapup',
              since: '2026-08-11T10:05:00.000Z',
            });
          });

          act(() => latest().emit({ event: 'ready', session_id: 'sess-1', state: 'wrapup' }));

          expect(view.result.current.retainedAttempt?.attempt_id).toBe('att-1');
          expect(view.result.current.wrapup?.attemptId).toBe('att-1');
          expect(view.result.current.currentAttemptId).toBe('att-1');
        });

        it('drops a retained attempt the anchor contradicts', async () => {
          // A consistency check with a rare but real subject: the server naming a different
          // attempt's wrap-up means ours finished while the socket was away, and the
          // contact details beside the pad belong to the wrong customer.
          const view = await mounted();
          act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
          act(() =>
            latest().emit({
              event: 'bridged',
              attempt_id: 'att-1',
              bridged_at: '2026-08-11T10:00:04.000Z',
            }),
          );
          act(() =>
            latest().emit({
              event: 'released',
              attempt_id: 'att-1',
              reason: 'remote_hangup',
              requires_disposition: true,
              message: 'The customer hung up.',
            }),
          );
          expect(view.result.current.retainedAttempt?.attempt_id).toBe('att-1');

          act(() =>
            latest().emit({
              event: 'ready',
              session_id: 'sess-1',
              state: 'wrapup',
              active_wrapup: { ...WRAPUP, attempt_id: 'att-9' },
            }),
          );

          expect(view.result.current.retainedAttempt).toBeNull();
          expect(view.result.current.wrapup?.attemptId).toBe('att-9');
        });

        it('clears a stale missed release when the reconnect carries none', async () => {
          // Same rule as every other field: a reconnect that says nothing about a
          // missed call is the server saying there is none.
          const view = await mounted();
          act(() =>
            latest().emit({
              event: 'ready',
              session_id: 'sess-1',
              state: 'available',
              missed_release: {
                attempt_id: 'att-1',
                reason: 'remote_hangup',
                requires_disposition: false,
                message: 'The customer hung up.',
                ended_at: '2026-08-11T10:04:00.000Z',
              },
            }),
          );
          expect(view.result.current.missedRelease).not.toBeNull();

          act(() => latest().emit({ event: 'ready', session_id: 'sess-1', state: 'available' }));

          expect(view.result.current.missedRelease).toBeNull();
        });

        /**
         * ── The release `ready` used to delete, and the consumer it forgot ─────────
         *
         * `ready`'s wrap-up-is-over branch cleared `wrapup`, `retainedAttempt` **and**
         * `release` unconditionally, on reasoning that was sound while the wrap-up rail
         * was `release`'s only consumer: the rail is being cleared anyway, and after a
         * reconnect "what happened while you were away" belongs to `missed_release`.
         *
         * `IdlePanel` is a second consumer with a longer lifetime. On the server's truncated
         * path (`#290`) the agent dispositioned mid-call, `WrapupManager.enter` returns
         * early, and `agent_state{wrapup}`/`wrapup` are never sent — so the release
         * frame is the console's whole account of the call, and it sits in the idle
         * panel until the next `reserved`. This console **witnessed** that release while
         * connected, which is exactly the condition under which the server hands back **no**
         * `missed_release` (`if (!delivered)`). A three-second blip in the idle window
         * therefore deleted the only explanation the agent was ever going to get.
         *
         * These two pin the rule: newer wins, and nothing-newer keeps.
         */
        it('keeps a release no wrap-up ever explained, so a blip cannot delete it', async () => {
          const view = await mounted();
          act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
          act(() =>
            latest().emit({
              event: 'bridged',
              attempt_id: 'att-1',
              bridged_at: '2026-08-11T10:00:04.000Z',
            }),
          );
          act(() =>
            latest().emit({
              event: 'agent_state',
              state: 'on_call',
              since: '2026-08-11T10:00:04.000Z',
            }),
          );
          // The server's early return, as frames: a `released`, then straight back
          // into the pool. No wrap-up was ever announced, so nothing has explained
          // this call to the agent yet.
          act(() => {
            latest().emit({
              event: 'released',
              attempt_id: 'att-1',
              reason: 'completed',
              requires_disposition: true,
              message: 'Call ended.',
            });
            latest().emit({
              event: 'agent_state',
              state: 'available',
              since: '2026-08-11T10:05:00.000Z',
            });
          });
          // The state `IdlePanel` renders `releaseAccount(release)` from.
          expect(view.result.current.release?.attempt_id).toBe('att-1');
          expect(view.result.current.retainedAttempt).toBeNull();
          expect(view.result.current.wrapup).toBeNull();

          // A real drop and reconnect — not a fresh mount, which would start with
          // `release` already null and could not observe this at all.
          await reconnected();
          act(() => latest().emit({ event: 'ready', session_id: 'sess-1', state: 'available' }));

          expect(view.result.current.release?.attempt_id).toBe('att-1');
          // The server has nothing to offer here, and that is the point: the frame WAS
          // delivered, so there is no `missed_release` standing in for it.
          expect(view.result.current.missedRelease).toBeNull();

          // The lifetime has not grown past "until the next call".
          act(() =>
            latest().emit({ event: 'reserved', attempt: { ...ATTEMPT, attempt_id: 'att-2' } }),
          );
          expect(view.result.current.release).toBeNull();
        });

        it('lets the server’s `missed_release` supersede the release it holds', async () => {
          // The other half of the rule. Two accounts of two different calls render in
          // the same slot, so the newer one — the server's, which this session did not see —
          // must not have to compete with a frame we are merely still holding.
          const view = await mounted();
          act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
          act(() =>
            latest().emit({
              event: 'bridged',
              attempt_id: 'att-1',
              bridged_at: '2026-08-11T10:00:04.000Z',
            }),
          );
          act(() => {
            latest().emit({
              event: 'released',
              attempt_id: 'att-1',
              reason: 'completed',
              requires_disposition: true,
              message: 'Call ended.',
            });
            latest().emit({
              event: 'agent_state',
              state: 'available',
              since: '2026-08-11T10:05:00.000Z',
            });
          });
          expect(view.result.current.release?.attempt_id).toBe('att-1');

          await reconnected();
          act(() =>
            latest().emit({
              event: 'ready',
              session_id: 'sess-1',
              state: 'available',
              missed_release: {
                attempt_id: 'att-2',
                reason: 'remote_hangup',
                requires_disposition: false,
                message: 'The customer hung up.',
                ended_at: '2026-08-11T10:06:00.000Z',
              },
            }),
          );

          expect(view.result.current.release).toBeNull();
          expect(view.result.current.missedRelease?.attempt_id).toBe('att-2');
        });

        it('still rehydrates a genuinely live attempt', async () => {
          // The reconciliation must not cost the case `ready` was built for.
          const view = await mounted();
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

          expect(view.result.current.live?.bridgedAt).toBe('2026-08-11T10:00:04.000Z');
          expect(view.result.current.currentAttemptId).toBe('att-1');
        });
      });

      it('surfaces a queued break from `agent_state.pending_state`', async () => {
        // Before this the pill had exactly one source — the HTTP response that
        // queued the break — so a break queued by a supervisor, by another window,
        // or by this console before a socket blip was invisible and therefore
        // uncancellable.
        const view = await mounted();
        act(() =>
          latest().emit({
            event: 'agent_state',
            state: 'wrapup',
            since: '2026-08-11T10:05:00.000Z',
            pending_state: 'break',
            pending_break_reason: 'lunch',
          }),
        );

        expect(view.result.current.pendingBreakCode).toBe('lunch');
      });

      it('clears the queue when a transition omits the pending fields', async () => {
        // Absence is a statement: the server's `/break/cancel` emits an `agent_state`
        // with these fields omitted for precisely this purpose. Reading absence as
        // "no change" leaves a pill up for a break already taken back.
        const view = await mounted();
        act(() =>
          latest().emit({
            event: 'agent_state',
            state: 'on_call',
            since: '2026-08-11T10:04:00.000Z',
            pending_state: 'break',
            pending_break_reason: 'lunch',
          }),
        );
        expect(view.result.current.pendingBreakCode).toBe('lunch');

        act(() =>
          latest().emit({
            event: 'agent_state',
            state: 'on_call',
            since: '2026-08-11T10:04:30.000Z',
          }),
        );
        expect(view.result.current.pendingBreakCode).toBeNull();
      });

      it('does not confuse the break in effect with a queued one', async () => {
        // `break_reason` and `pending_break_reason` sit side by side on the frame
        // and mean opposite things — one is the break you are on, the other the
        // break you are waiting for.
        const view = await mounted();
        act(() =>
          latest().emit({
            event: 'agent_state',
            state: 'break',
            since: '2026-08-11T10:06:00.000Z',
            break_reason: 'lunch',
          }),
        );

        expect(view.result.current.breakReasonCode).toBe('lunch');
        expect(view.result.current.pendingBreakCode).toBeNull();
      });

      /**
       * **The queued break on `ready` — the gap this mirror recorded, now closed.**
       *
       * This console reconciled the `ready` frame field by field and noted that a
       * socket reconnecting *during* wrap-up still got `ready` with no pending
       * fields, so a break queued before the drop stayed invisible until the next
       * transition frame — which is the one `releaseAgent` sends **after** applying
       * it. The server closed that gap and reads the queue with `peek`, not
       * `take`: the break still lands when wrap-up ends. The badge is not a
       * reminder of a request, it is notice that the agent is about to be pulled out
       * of the pool.
       *
       * Every case here drives a real drop and reconnect through `reconnected()`.
       */
      describe('the queued break on `ready`', () => {
        it('restores a break this socket was never told about', async () => {
          const view = await mounted();
          act(() =>
            latest().emit({
              event: 'agent_state',
              state: 'on_call',
              since: '2026-08-11T10:00:04.000Z',
            }),
          );
          // Nothing queued as far as this console knows — the request that queued it
          // (a supervisor's, or another window's) was answered into a socket this
          // console does not own.
          expect(view.result.current.pendingBreakCode).toBeNull();

          await reconnected();
          act(() =>
            latest().emit({
              event: 'ready',
              session_id: 'sess-1',
              state: 'wrapup',
              active_wrapup: WRAPUP,
              pending_state: 'break',
              pending_break_reason: 'lunch',
            }),
          );

          expect(view.result.current.pendingBreakCode).toBe('lunch');
          // And the statement is countable, which is what lets a consumer holding its
          // own copy tell "the server says the queue is empty" from "no frame has spoken".
          expect(view.result.current.pendingBreakStatements).toBeGreaterThan(0);
        });

        it('clears a queue that emptied while the socket was away', async () => {
          // The direction absence has to reach: the server omits the fields to say nothing
          // is queued, so a reconnect must be able to take the badge back down. The
          // break may have been cancelled from another window, or already applied.
          const view = await mounted();
          act(() =>
            latest().emit({
              event: 'agent_state',
              state: 'wrapup',
              since: '2026-08-11T10:05:00.000Z',
              pending_state: 'break',
              pending_break_reason: 'lunch',
            }),
          );
          expect(view.result.current.pendingBreakCode).toBe('lunch');

          await reconnected();
          act(() =>
            latest().emit({
              event: 'ready',
              session_id: 'sess-1',
              state: 'wrapup',
              active_wrapup: WRAPUP,
            }),
          );

          expect(view.result.current.pendingBreakCode).toBeNull();
          // The clearing is confined to the queue: the wrap-up this agent is still in
          // — and still owes a disposition for — is untouched by it.
          expect(view.result.current.wrapup?.attemptId).toBe('att-1');
        });

        it('rides on a reconnect that carries an attempt, not only a wrap-up', async () => {
          /**
           * The server emits these fields unconditionally rather than beside
           * `active_wrapup`, because `breakMustWait` defers from `reserved` and
           * `on_call` too (`break-manager.ts`, `DEFERRING_STATES`) — and those
           * reconnects arrive carrying `active_attempt` instead. A console that only
           * read them next to a wrap-up would go blind for the whole conversation.
           */
          const view = await mounted();
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
              pending_state: 'break',
              pending_break_reason: 'lunch',
            }),
          );

          expect(view.result.current.pendingBreakCode).toBe('lunch');
          // The live call is unaffected — the badge is about what happens after it.
          expect(view.result.current.live?.bridgedAt).toBe('2026-08-11T10:00:04.000Z');
          expect(view.result.current.wrapup).toBeNull();
        });

        it('a badge on the frame does not keep a closed wrap-up alive', async () => {
          /**
           * The interaction the last two defects in this handler lived in: one
           * `ready` now installs a pending break *and* clears the wrap-up fields, and
           * neither reconciliation may lend the other authority.
           *
           * The frame combination is one the server can produce, which is what makes it
           * worth pinning rather than inventing: `/available` "operates on the current
           * state and leaves `pending_state` untouched" (`contracts.ts`), so an agent
           * whose wrap-up ended through that route is `available` with the break still
           * in the registry — and `peek` reports it here.
           */
          const view = await mounted();
          act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
          act(() =>
            latest().emit({
              event: 'released',
              attempt_id: 'att-1',
              reason: 'remote_hangup',
              requires_disposition: true,
              message: 'The customer hung up.',
            }),
          );
          act(() => {
            latest().emit({ event: 'wrapup', wrapup: WRAPUP });
            latest().emit({
              event: 'agent_state',
              state: 'wrapup',
              since: '2026-08-11T10:05:00.000Z',
            });
          });
          expect(view.result.current.wrapup).not.toBeNull();
          // Nothing queued yet, so the badge below can only have come off the frame.
          expect(view.result.current.pendingBreakCode).toBeNull();

          await reconnected();
          act(() =>
            latest().emit({
              event: 'ready',
              session_id: 'sess-1',
              state: 'available',
              pending_state: 'break',
              pending_break_reason: 'lunch',
            }),
          );

          // The badge goes up, because the server says a break is still queued …
          expect(view.result.current.pendingBreakCode).toBe('lunch');
          // … and it buys the wrap-up nothing. Every anchor the pad unlocks from is
          // gone, so there is nothing left to submit a disposition against.
          expect(view.result.current.wrapup).toBeNull();
          expect(view.result.current.retainedAttempt).toBeNull();
          expect(view.result.current.release).toBeNull();
          expect(view.result.current.currentAttemptId).toBeNull();
        });

        it('a resumed wrap-up does not keep the badge alive once the break lands', async () => {
          /**
           * The other direction of the same interaction. A reconnect mid-wrap-up
           * carries `state`, `active_wrapup` **and** the pending break; when the
           * window ends, `releaseAgent` `take`s the break and sends one
           * `agent_state{break}` with `break_reason` and no pending fields
           * (`agency-dialer.ts`). The badge's subject no longer exists at that
           * point, and the wrap-up it arrived beside must not hold it open.
           */
          const view = await mounted();
          await reconnected();
          act(() =>
            latest().emit({
              event: 'ready',
              session_id: 'sess-1',
              state: 'wrapup',
              active_wrapup: WRAPUP,
              pending_state: 'break',
              pending_break_reason: 'lunch',
            }),
          );
          expect(view.result.current.pendingBreakCode).toBe('lunch');
          expect(view.result.current.wrapup?.attemptId).toBe('att-1');

          act(() =>
            latest().emit({
              event: 'agent_state',
              state: 'break',
              since: '2026-08-11T10:06:00.000Z',
              break_reason: 'lunch',
            }),
          );

          // Queued became in-effect: one field, and it is the other one now.
          expect(view.result.current.pendingBreakCode).toBeNull();
          expect(view.result.current.breakReasonCode).toBe('lunch');
          expect(view.result.current.wrapup).toBeNull();
        });
      });
    });

    it('drives idle copy from campaign_state.dialing, not status', async () => {
      const view = await mounted();
      expect(view.result.current.dialing).toBe(true);
      act(() =>
        latest().emit({
          event: 'campaign_state',
          campaign_id: 'camp-1',
          status: 'paused',
          reason: 'paused_by_supervisor',
          dialing: false,
          message: 'paused',
        }),
      );
      expect(view.result.current.dialing).toBe(false);
    });

    it('records an `error` frame without closing the socket', async () => {
      const view = await mounted();
      act(() =>
        latest().emit({ event: 'error', code: 'not_your_attempt', message: 'not yours' }),
      );
      expect(view.result.current.lastError?.code).toBe('not_your_attempt');
      expect(view.result.current.connection).toBe('open');
    });
  });

  describe('close codes drive different recoveries', () => {
    it('4404 is terminal — re-bootstrap, do not retry', async () => {
      const view = await mounted();
      act(() => latest().serverClose(4404, 'session gone'));
      await waitFor(() => expect(view.result.current.connection).toBe('session_gone'));
      expect(FakeSocket.instances).toHaveLength(1);
    });

    it('4409 is terminal — another window took the session', async () => {
      const view = await mounted();
      act(() => latest().serverClose(4409, 'superseded'));
      await waitFor(() => expect(view.result.current.connection).toBe('superseded'));
      expect(FakeSocket.instances).toHaveLength(1);
    });

    it('4401 re-mints a token and reconnects', async () => {
      // The token authenticates the UPGRADE and is single-use, so a reconnect
      // always needs a fresh one.
      mocks.mintStationToken.mockResolvedValue({
        session_id: 'sess-1',
        station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
        expires_at: '2026-08-11T10:05:00.000Z',
      });
      const view = await mounted();
      act(() => latest().serverClose(4401, 'token expired'));

      await waitFor(() => expect(view.result.current.connection).toBe('reconnecting'));
      await waitFor(() => expect(mocks.mintStationToken).toHaveBeenCalledWith('sess-1', undefined, undefined), {
        timeout: 3000,
      });
      await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 3000 });
      expect(latest().url).toContain('token=FRESH');
    });

    it('reports reconnecting rather than "ended" on an ordinary drop', async () => {
      // Never say "call ended" while a reconnect is still possible.
      mocks.mintStationToken.mockResolvedValue({
        session_id: 'sess-1',
        station_ws_url: '/proxy/agency/station/sess-1?token=t2',
        expires_at: 'x',
      });
      const view = await mounted();
      act(() => latest().serverClose(1006, ''));
      await waitFor(() => expect(view.result.current.connection).toBe('reconnecting'));

      /**
       * **Unmounted here, explicitly, because this case arms a live timer.**
       *
       * A 1006 close schedules a 500ms reconnect. Left mounted, that timer fired
       * during the NEXT `describe`, minted a token and opened a second
       * `FakeSocket` — which then became `latest()`, the socket the heartbeat
       * block asserts `sent[0]` on. Those assertions were reading a socket this
       * test created after this test had finished; the ~1-in-7 flake in this file
       * was that race resolving on the other side.
       *
       * `src/__tests__/setup.ts` now unmounts globally, which fixes the class. This
       * stays anyway, and asserts rather than merely tidies: the count below is
       * what makes "the reconnect did not happen" a checked property instead of an
       * assumption about teardown ordering.
       */
      const socketsAtDrop = FakeSocket.instances.length;
      view.unmount();
      await new Promise((r) => setTimeout(r, 600));
      expect(FakeSocket.instances).toHaveLength(socketsAtDrop);
    });
  });

  /**
   * ── The shape none of the above could see ──────────────────────────────────
   *
   * Every test before this block drives ONE socket, and
   * `close codes drive different recoveries` even asserts
   * `FakeSocket.instances` stays at 1. That is why a five-defect reconnect loop
   * shipped and ran in production for half an hour across three agents: the hook kept its heartbeat timer, its socket pointer and its
   * retry counter in refs shared by every socket it ever opened, and nothing
   * checked which socket a callback belonged to.
   *
   * So these tests are all the same question — **two sockets, and which one owns
   * the hook** — and each one fails on the pre-fix code.
   */
  describe('two sockets, and which one owns the hook', () => {
    /** A second socket for the same mount, the way a real reconnect makes one. */
    async function secondSocket(): Promise<{ stale: FakeSocket; live: FakeSocket }> {
      mocks.mintStationToken.mockResolvedValue({
        session_id: 'sess-1',
        station_ws_url: '/proxy/agency/station/sess-1?token=SECOND',
        expires_at: '2026-08-11T10:05:00.000Z',
      });
      const stale = latest();
      const before = FakeSocket.instances.length;
      act(() => stale.serverClose(1006, ''));
      await waitFor(() => expect(FakeSocket.instances.length).toBe(before + 1), { timeout: 3000 });
      const live = latest();
      act(() => live.open());
      return { stale, live };
    }

    it('a stale socket closing after a newer one opened does nothing at all', async () => {
      const view = await mounted();
      const { stale, live } = await secondSocket();
      const socketCount = FakeSocket.instances.length;

      // The close that used to cascade: it cleared the live socket's heartbeat,
      // nulled the pointer `sendMedia` reads, and scheduled another connect —
      // which is the whole loop, from one late close.
      act(() => stale.serverClose(1006, 'late'));

      expect(view.result.current.connection).toBe('open');
      // No third socket, now or after the shortest backoff would have fired.
      await new Promise((resolve) => setTimeout(resolve, 700));
      expect(FakeSocket.instances).toHaveLength(socketCount);
      // And the live socket's heartbeat still exists, which is the half that was
      // invisible: `connection` stayed 'open' either way while the console went
      // deaf and mute.
      expect(view.result.current.sendMedia('AAAA')).toBe(true);
      expect(live.readyState).toBe(1);
    });

    it('a stale socket opening late cannot report `open` over the live one', async () => {
      // The mirror image, and the one the original diagnosis missed: `onopen`
      // was as unguarded as `onclose`, so a loser socket overwrote
      // `heartbeatRef` and leaked the winner's interval to fire forever.
      const view = await mounted();
      const { stale } = await secondSocket();
      act(() => stale.serverClose(4409, 'superseded'));
      await waitFor(() => expect(view.result.current.connection).toBe('open'));

      act(() => stale.open());
      expect(view.result.current.connection).toBe('open');
    });

    it('a stale socket cannot write agent state over the live socket', async () => {
      const view = await mounted();
      act(() =>
        latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-16T10:00:00.000Z' }),
      );
      const { stale } = await secondSocket();
      act(() =>
        latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-16T10:00:00.000Z' }),
      );
      await waitFor(() => expect(view.result.current.agentState).toBe('available'));

      // A superseded socket replaying its own view of the session. `handleFrame`
      // writes agent state, the break queue, the live attempt and the cues, so
      // this is not merely uninteresting — it is the live socket's state being
      // overwritten by a dead one's.
      act(() => stale.emit({ event: 'agent_state', state: 'offline', since: '2026-08-16T09:00:00.000Z' }));

      expect(view.result.current.agentState).toBe('available');
    });

    it('never replays the single-use bootstrap token', async () => {
      /**
       * The re-mint was gated on `retryCount > 0`, so any path that reached
       * `connect()` with the counter at zero replayed the token bootstrap had
       * already spent, and the server refused it `4401`.
       *
       * `reconnect()` is that path — it zeroes the counter by design — and it is
       * how the `pageshow` restore comes back, which is why the burst in
       * production opened with a 4401. Asserted through `reconnect()` rather than
       * through an ordinary retry, because an ordinary retry has already
       * incremented the counter and mints correctly even on the old code.
       */
      const view = await mounted();
      expect(latest().url).toContain('token=t1');
      mocks.mintStationToken.mockResolvedValue({
        session_id: 'sess-1',
        station_ws_url: '/proxy/agency/station/sess-1?token=SECOND',
        expires_at: '2026-08-11T10:05:00.000Z',
      });

      act(() => view.result.current.reconnect());

      await waitFor(() => expect(FakeSocket.instances.length).toBe(2));
      expect(latest().url).toContain('token=SECOND');
      expect(latest().url).not.toContain('token=t1');
    });
  });

  describe('backoff', () => {
    /**
     * The ladder is `BACKOFF_MS` = 500/1000/2000/5000/…, and before this fix it
     * was 500/500/500/500: `onopen` reset the counter, so a socket that opened
     * and was immediately superseded counted as a success. That is why the
     * production cadence held at ~1/s for 31 minutes instead of backing off.
     */
    it('ladders when a socket opens but never proves liveness', async () => {
      vi.useFakeTimers();
      try {
        mocks.mintStationToken.mockResolvedValue({
          session_id: 'sess-1',
          station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
          expires_at: '2026-08-11T10:05:00.000Z',
        });
        renderHook(() => useAgencyStation(BOOTSTRAP));
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));

        for (const expected of [500, 1000, 2000]) {
          const count = FakeSocket.instances.length;
          // Open, so the old code would call this a success, then die.
          act(() => latest().open());
          act(() => latest().serverClose(1006, ''));

          // One tick short of the expected delay: still nothing.
          await act(async () => {
            await vi.advanceTimersByTimeAsync(expected - 1);
          });
          expect(FakeSocket.instances.length).toBe(count);

          await act(async () => {
            await vi.advanceTimersByTimeAsync(50);
          });
          await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(count + 1));
        }
      } finally {
        vi.useRealTimers();
      }
    });

    it('a `pong` — not merely opening — is what resets the ladder', async () => {
      /**
       * Structured so it FAILS when the `pong` reset is removed, which an earlier
       * version did not: it climbed no rungs first, so with or without the reset
       * the delay under test was `backoffFor(0)` either way, and it passed against
       * the pre-fix code AND against the fix with the reset deleted.
       *
       * The negative assertion is what gives it teeth. `vi.waitFor` ADVANCES fake
       * timers while polling, so `advanceTimersByTimeAsync(560)` followed by a
       * `waitFor` tolerates a pending delay of well over a second — the 560 is
       * decorative on its own.
       */
      vi.useFakeTimers();
      try {
        mocks.mintStationToken.mockResolvedValue({
          session_id: 'sess-1',
          station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
          expires_at: '2026-08-11T10:05:00.000Z',
        });
        renderHook(() => useAgencyStation(BOOTSTRAP));
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));

        // Rung 0 → 1: this socket opens and dies WITHOUT a round trip.
        act(() => latest().open());
        act(() => latest().serverClose(1006, ''));
        await act(async () => { await vi.advanceTimersByTimeAsync(600); });
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(2));

        // This one does a round trip, so the ladder must go back to its bottom
        // rung. Without the `pong` reset the counter is still 1 and the next wait
        // is 1000ms, which the assertions below reject.
        act(() => latest().open());
        act(() => latest().emit({ event: 'pong', ts: Date.now(), server_ts: Date.now() }));
        act(() => latest().serverClose(1006, ''));

        await act(async () => { await vi.advanceTimersByTimeAsync(450); });
        expect(FakeSocket.instances).toHaveLength(2);

        await act(async () => { await vi.advanceTimersByTimeAsync(120); });
        expect(FakeSocket.instances).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a stale socket’s `pong` does not reset the live ladder', async () => {
      /**
       * The guard this protects is `onmessage`'s generation check: moving the
       * backoff reset onto `pong` is only sound while a superseded socket's pong
       * cannot reach `handleFrame`.
       *
       * Measured on the delay of the retry that comes AFTER the stale pong, not
       * the one already pending — `scheduleRetry` reads the counter at schedule
       * time, so a pending timer's delay cannot change and an earlier version of
       * this test could not observe the thing it was named for. It stayed green
       * with the guard deleted.
       */
      vi.useFakeTimers();
      try {
        mocks.mintStationToken.mockResolvedValue({
          session_id: 'sess-1',
          station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
          expires_at: '2026-08-11T10:05:00.000Z',
        });
        renderHook(() => useAgencyStation(BOOTSTRAP));
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
        const stale = latest();

        // Climb to rung 1 without ever proving liveness.
        act(() => stale.open());
        act(() => stale.serverClose(1006, ''));
        await act(async () => { await vi.advanceTimersByTimeAsync(600); });
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(2));

        act(() => latest().open());
        // The dead socket answers a ping from a previous life. If that were
        // credited the counter would drop to 0 and the next wait would be 500ms.
        act(() => stale.emit({ event: 'pong', ts: Date.now(), server_ts: Date.now() }));
        act(() => latest().serverClose(1006, ''));

        // 500ms would have been enough; 1000ms is correct.
        await act(async () => { await vi.advanceTimersByTimeAsync(700); });
        expect(FakeSocket.instances).toHaveLength(2);

        await act(async () => { await vi.advanceTimersByTimeAsync(400); });
        expect(FakeSocket.instances).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('giving up, and the way back', () => {
    it('three missed pings is `disconnected`, and closes the socket', async () => {
      //'s third row. Before this, `missedPings` only advanced when a ping
      // was actually SENT, so a socket the browser had moved to CLOSING stopped
      // counting and the specified state was unreachable.
      vi.useFakeTimers();
      try {
        const view = renderHook(() => useAgencyStation(BOOTSTRAP));
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
        const socket = latest();
        act(() => socket.open());

        // Three heartbeat intervals with no `pong` in reply.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });

        await vi.waitFor(() => expect(view.result.current.connection).toBe('disconnected'));
        // Closed, so the server's registry stops claiming a station this console
        // cannot use — otherwise `/available` keeps succeeding against it.
        expect(socket.closedWith).not.toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('`reconnect()` is a real way back from `disconnected`', async () => {
      vi.useFakeTimers();
      try {
        mocks.mintStationToken.mockResolvedValue({
          session_id: 'sess-1',
          station_ws_url: '/proxy/agency/station/sess-1?token=RECLAIM',
          expires_at: '2026-08-11T10:05:00.000Z',
        });
        const view = renderHook(() => useAgencyStation(BOOTSTRAP));
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
        act(() => latest().open());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000);
        });
        await vi.waitFor(() => expect(view.result.current.connection).toBe('disconnected'));

        const before = FakeSocket.instances.length;
        act(() => view.result.current.reconnect());
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(before + 1));
        act(() => latest().open());
        await vi.waitFor(() => expect(view.result.current.connection).toBe('open'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('stops retrying once the connection is flapping rather than failing', async () => {
      // The cap the ticket asks for. `BACKOFF_MS` alone cannot bound this,
      // because the loop that produced the incident kept RESETTING the ladder.
      vi.useFakeTimers();
      try {
        mocks.mintStationToken.mockResolvedValue({
          session_id: 'sess-1',
          station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
          expires_at: '2026-08-11T10:05:00.000Z',
        });
        const view = renderHook(() => useAgencyStation(BOOTSTRAP));
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));

        // Open → pong → die, over and over: every lap proves liveness, so the
        // ladder stays at its bottom rung and only the cap can stop it.
        for (let lap = 0; lap < 8; lap += 1) {
          if (view.result.current.connection === 'disconnected') break;
          act(() => latest().open());
          act(() => latest().emit({ event: 'pong', ts: Date.now(), server_ts: Date.now() }));
          act(() => latest().serverClose(1006, ''));
          await act(async () => {
            await vi.advanceTimersByTimeAsync(600);
          });
        }

        expect(view.result.current.connection).toBe('disconnected');
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * ── THE GUARD THAT KEEPS A LIVE CALL OUT OF THIS ───────────────────────
     *
     * The socket carries the agent's voice, and media frames produce no `pong`.
     * The server answers a ping only after a database read, so a slow-but-successful
     * read stops the pongs on a socket whose audio is flowing perfectly — and
     * the server's own silent-station sweep refuses to close such a socket for exactly
     * that reason. Without a matching guard here, a server database slowdown became
     * a floor-wide simultaneous call drop.
     */
    it('does not tear down a live call on three missed pings', async () => {
      vi.useFakeTimers();
      try {
        const view = renderHook(() => useAgencyStation(BOOTSTRAP));
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
        const socket = latest();
        act(() => socket.open());
        act(() => socket.emit({ event: 'reserved', attempt: ATTEMPT }));
        act(() => socket.emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-16T10:00:00.000Z' }));
        await vi.waitFor(() => expect(view.result.current.live?.bridgedAt).not.toBeNull());

        // Well past the three-miss threshold, with no pong at all.
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });

        expect(view.result.current.connection).toBe('open');
        expect(socket.closedWith).toBeNull();
        expect(view.result.current.sendMedia('QUJD')).toBe(true);
        // The counting continues, so the pill still escalates.
        expect(view.result.current.missedPings).toBeGreaterThanOrEqual(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives up as soon as the call it was protecting has ended', async () => {
      // The other half: the guard defers the decision, it does not cancel it.
      vi.useFakeTimers();
      try {
        const view = renderHook(() => useAgencyStation(BOOTSTRAP));
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
        const socket = latest();
        act(() => socket.open());
        act(() => socket.emit({ event: 'reserved', attempt: ATTEMPT }));
        act(() => socket.emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-16T10:00:00.000Z' }));
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(view.result.current.connection).toBe('open');

        act(() => socket.emit({
          event: 'released',
          attempt_id: 'att-1',
          reason: 'remote_hangup',
          requires_disposition: false,
        }));
        // At most one heartbeat interval away.
        await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });

        await vi.waitFor(() => expect(view.result.current.connection).toBe('disconnected'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps pinging while it is holding a live call', async () => {
      /**
       * The hold defers the give-up. It must not stop the heartbeat — and it did.
       *
       * The `return` that skipped the decision also skipped the `ping` send below
       * it, which made the guard self-defeating in the worst available way: no
       * ping, so no `pong`, so the miss counter could never clear, so the moment
       * `released` cleared the live attempt the very next tick gave up. A guard
       * written to protect a live call instead guaranteed the station died the
       * instant the call ended, whether or not the line had recovered.
       */
      vi.useFakeTimers();
      try {
        const view = renderHook(() => useAgencyStation(BOOTSTRAP));
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
        const socket = latest();
        act(() => socket.open());
        act(() => socket.emit({ event: 'reserved', attempt: ATTEMPT }));
        act(() => socket.emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-16T10:00:00.000Z' }));
        await vi.waitFor(() => expect(view.result.current.live?.bridgedAt).not.toBeNull());

        const pings = (): number => socket.sent.filter((f) => f.includes('"ping"')).length;

        await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
        expect(view.result.current.connection).toBe('open');
        expect(view.result.current.missedPings).toBeGreaterThanOrEqual(3);
        const duringHold = pings();

        await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
        expect(pings()).toBeGreaterThan(duringHold);
      } finally {
        vi.useRealTimers();
      }
    });

    it('survives the call when the line recovers during the hold', async () => {
      // The consequence, end to end, and the reason the test above matters: a
      // stall that clears mid-call must leave the station alive after the call.
      // Only reachable because the hold keeps pinging — with the old `return`,
      // `autoPong` never sees a ping to answer and this ends `disconnected`.
      vi.useFakeTimers();
      try {
        const view = renderHook(() => useAgencyStation(BOOTSTRAP));
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
        const socket = latest();
        act(() => socket.open());
        act(() => socket.emit({ event: 'reserved', attempt: ATTEMPT }));
        act(() => socket.emit({ event: 'bridged', attempt_id: 'att-1', bridged_at: '2026-08-16T10:00:00.000Z' }));
        await vi.waitFor(() => expect(view.result.current.live?.bridgedAt).not.toBeNull());

        await act(async () => { await vi.advanceTimersByTimeAsync(40_000); });
        expect(view.result.current.missedPings).toBeGreaterThanOrEqual(3);

        // The server starts answering again — a slow database read that finished.
        socket.autoPong = true;
        await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
        expect(view.result.current.missedPings).toBe(0);

        act(() => socket.emit({
          event: 'released',
          attempt_id: 'att-1',
          reason: 'remote_hangup',
          requires_disposition: false,
        }));
        await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });

        expect(view.result.current.connection).toBe('open');
        expect(socket.closedWith).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('gives up on a throttled tab by elapsed silence, not by a third tick', async () => {
      /**
       *'s threshold is 30 SECONDS of silence. Gating the decision on three
       * ticks as well made it mean "three intervals fired", and a background tab is
       * throttled to about one timer a minute — so a dead line took roughly three
       * minutes to report, three times the stated grace.
       *
       * The clock now measures how long a ping WE SENT has gone unanswered, which
       * is the only quantity that is evidence of anything: time in which nothing
       * was asked is not silence from the server. Both halves are asserted here,
       * because each is the other's safety rail — it must not report before a ping
       * has had its grace, however many ticks have fired, and it must report once
       * one has, however few.
       */
      vi.useFakeTimers();
      try {
        const view = renderHook(() => useAgencyStation(BOOTSTRAP));
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
        const socket = latest();
        act(() => socket.open());
        await vi.waitFor(() => expect(view.result.current.connection).toBe('open'));

        // One tick on the ordinary cadence: 10 s, well inside the 30 s grace. A ping
        // is outstanding and unanswered, and that is not yet a verdict.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(BOOTSTRAP.intervals.heartbeat_ms);
        });
        expect(view.result.current.missedPings).toBeGreaterThanOrEqual(1);
        expect(view.result.current.connection).toBe('open');

        // Now throttled: the wall clock moves while no timer is due, then one tick
        // fires — which is what a browser does to a hidden tab. By the time it runs,
        // a ping we sent has been unanswered for over a minute, so it is this tick
        // that must decide.
        //
        // The miss count here is TWO. That is the whole point of the assertion: it
        // is below `MISSED_PING_LIMIT`, so a rule that also required three ticks
        // would sit on its hands for another two throttled minutes. Advancing far
        // enough for the count to reach three would let both rules pass and prove
        // nothing.
        vi.setSystemTime(Date.now() + 50_000);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(BOOTSTRAP.intervals.heartbeat_ms);
        });
        expect(view.result.current.missedPings).toBeLessThan(3);
        expect(view.result.current.connection).toBe('disconnected');
      } finally {
        vi.useRealTimers();
      }
    });

    it('rides out a long outage instead of parking the agent behind a click', async () => {
      /**
       * The flap cap counts proven-live-then-died sockets, NOT connect attempts.
       * Counting attempts capped a healthy console during any outage past ~34 s —
       * `BACKOFF_MS` puts the seventh cold attempt at 33.5 s — so a rolling
       * deploy, a pod restart or an LB drain landed every agent on the floor on
       * "Disconnected" at once, each needing a manual press. A server that is
       * simply unreachable never proves liveness, so it must keep retrying.
       */
      vi.useFakeTimers();
      try {
        mocks.mintStationToken.mockResolvedValue({
          session_id: 'sess-1',
          station_ws_url: '/proxy/agency/station/sess-1?token=FRESH',
          expires_at: '2026-08-11T10:05:00.000Z',
        });
        const view = renderHook(() => useAgencyStation(BOOTSTRAP));
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));

        /**
         * The ladder must drive the cadence, not the test. Advancing a fixed
         * 16 s per lap spread seven attempts over 112 s and so never filled the
         * 60 s window — the test passed even with the old count-every-connect
         * rule, which is the regression it exists to catch. Stepping finely and
         * failing each socket the moment it appears reproduces the real cold
         * walk: t = 0, 0.5, 1.5, 3.5, 8.5, 18.5, 33.5 s — seven attempts inside
         * the window, which is exactly what used to trip the cap.
         */
        let seen = FakeSocket.instances.length;
        for (let elapsed = 0; elapsed < 50_000; elapsed += 250) {
          if (FakeSocket.instances.length > seen - 1) {
            act(() => latest().serverClose(1006, ''));
            seen = FakeSocket.instances.length + 1;
          }
          await act(async () => { await vi.advanceTimersByTimeAsync(250); });
        }
        // The cold walk really did get past seven attempts in the window.
        expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(7);

        expect(view.result.current.connection).toBe('reconnecting');
        // And it recovers on its own the moment the server comes back.
        act(() => latest().open());
        act(() => latest().emit({ event: 'pong', ts: Date.now(), server_ts: Date.now() }));
        await vi.waitFor(() => expect(view.result.current.connection).toBe('open'));
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not hang forever on a token mint that never settles', async () => {
      /**
       * `apiFetch` carries no timeout, and BOTH safety nets live inside
       * `connect()` — so a hung mint left no socket, no heartbeat, no pending
       * retry and `connection: 'reconnecting'`, the one state the rail
       * deliberately offers no button in. Reload was the only way out, which is
       * the failure this whole change exists to remove.
       */
      vi.useFakeTimers();
      try {
        renderHook(() => useAgencyStation(BOOTSTRAP));
        await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
        // Force a re-mint, then never answer it.
        mocks.mintStationToken.mockReturnValue(new Promise(() => {}));
        act(() => latest().open());
        act(() => latest().serverClose(1006, ''));

        await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
        expect(FakeSocket.instances).toHaveLength(1);

        // The mint's own deadline fires and the ordinary retry ladder resumes.
        mocks.mintStationToken.mockResolvedValue({
          session_id: 'sess-1',
          station_ws_url: '/proxy/agency/station/sess-1?token=AFTER_TIMEOUT',
          expires_at: '2026-08-11T10:05:00.000Z',
        });
        await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

        await vi.waitFor(() => expect(FakeSocket.instances.length).toBeGreaterThan(1));
        expect(latest().url).toContain('token=AFTER_TIMEOUT');
      } finally {
        vi.useRealTimers();
      }
    });

    it('treats the server’s 4408 as a retry, not a terminal state', async () => {
      // The server's heartbeat-grace sweep closes a silent socket with 4408. The
      // contract's stated safety property — a client that does not recognise the
      // code falls through to its ordinary retry, which is what makes it safe to
      // deploy ahead of any console change — was asserted nowhere.
      const view = await mounted();
      mocks.mintStationToken.mockResolvedValue({
        session_id: 'sess-1',
        station_ws_url: '/proxy/agency/station/sess-1?token=AFTER_4408',
        expires_at: '2026-08-11T10:05:00.000Z',
      });

      act(() => latest().serverClose(4408, 'station_heartbeat_timeout'));

      await waitFor(() => expect(view.result.current.connection).toBe('reconnecting'));
      await waitFor(() => expect(FakeSocket.instances.length).toBe(2), { timeout: 3000 });
    });
  });

  describe('heartbeat', () => {
    it('pings on the SERVER cadence and clears misses on pong', async () => {
      vi.useFakeTimers();
      const view = renderHook(() => useAgencyStation(BOOTSTRAP));
      await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
      act(() => latest().open());

      act(() => {
        vi.advanceTimersByTime(BOOTSTRAP.intervals.heartbeat_ms);
      });
      expect(JSON.parse(latest().sent[0]!).event).toBe('ping');
      expect(view.result.current.missedPings).toBe(1);

      act(() => latest().emit({ event: 'pong', server_ts: 1 }));
      expect(view.result.current.missedPings).toBe(0);
    });
  });

  describe('hangup is not a socket frame', () => {
    // Needed to drive the heartbeat: the assertion is about what the socket
    // carries, so it has to carry something first.
    beforeEach(() => {
      vi.useFakeTimers();
    });

    /**
     * These two cases used to assert that `hangup()` sent
     * `{event:'hangup', attempt_id}` — and they passed, for a frame **the server reads
     * nowhere**. Its station socket registers exactly two `message` listeners
     * while an attempt is live: one acting only on `ping`, one only on `media`.
     * The frame fell off the end of both, so a green test proved the send, not
     * the hang-up, and the agent's button did nothing.
     *
     * That is why the replacement asserts what the socket carries rather than
     * that a method is gone: `expect(result.current.hangup).toBeUndefined()`
     * would be a status-only assertion — satisfied by absence, and equally
     * satisfied if the hook broke entirely.
     */
    it('sends nothing but heartbeats, even with a live attempt', async () => {
      // Mounted the heartbeat group's way, not via `mounted()`: that helper
      // awaits real timers, which fake timers stall forever.
      const view = renderHook(() => useAgencyStation(BOOTSTRAP));
      await vi.waitFor(() => expect(FakeSocket.instances.length).toBe(1));
      act(() => latest().open());
      act(() => latest().emit({ event: 'reserved', attempt: ATTEMPT }));
      act(() => {
        vi.advanceTimersByTime(BOOTSTRAP.intervals.heartbeat_ms);
      });

      // Proves a run happened rather than passing on an empty array.
      expect(latest().sent.length).toBeGreaterThan(0);
      const events = latest().sent.map((raw) => JSON.parse(raw).event);
      expect(new Set(events)).toEqual(new Set(['ping']));
      expect(view.result.current.live?.attempt.attempt_id).toBe('att-1');
    });
  });

  describe('teardown', () => {
    it('closes with 1000 so the server can tell a leave from a drop', async () => {
      const view = await mounted();
      const socket = latest();
      view.unmount();
      expect(socket.closedWith?.code).toBe(1000);
    });

    it('does not reconnect after a deliberate unmount', async () => {
      const view = await mounted();
      view.unmount();
      await new Promise((r) => setTimeout(r, 50));
      expect(FakeSocket.instances).toHaveLength(1);
    });
  });

  /**
   * Leaving the page.
   *
   * ── The case this file did not have, and the defect it let through ─────────
   * The first cut asserted `defaultPrevented` and the close reason, and never
   * exercised a **cancel**. So it was green while `beforeunload` closed the
   * socket synchronously — before the browser had even shown the dialog — and an
   * agent who chose *Stay* mid-call was left on a live page with a dead console
   * that reported "Connecting". Asserting that a prompt was requested says
   * nothing about the state the page is left in when the agent accepts it.
   *
   * So the split: `beforeunload` may only prompt, `pagehide` does the close.
   */
  describe('leaving the page', () => {
    function beforeUnload(): Event {
      const event = new Event('beforeunload', { cancelable: true });
      act(() => {
        window.dispatchEvent(event);
      });
      return event;
    }

    function pageHide(): void {
      act(() => {
        window.dispatchEvent(new Event('pagehide'));
      });
    }

    it.each(['reserved', 'on_call', 'wrapup'])('asks the browser to confirm while %s', async (state) => {
      await mounted();
      act(() => latest().emit({ event: 'agent_state', state, since: '2026-08-16T10:00:00.000Z' }));

      const event = beforeUnload();
      expect(event.defaultPrevented).toBe(true);
      // Safari, and Firefox before 131, ignore `preventDefault()` alone.
      expect((event as BeforeUnloadEvent).returnValue).toBe('');
    });

    it.each(['offline', 'available', 'break'])(
      'does not interrupt a tab close while %s',
      async (state) => {
        // Nobody is on the line and nothing is owed. A confirm on every close
        // trains the agent to dismiss the one that matters.
        await mounted();
        act(() => latest().emit({ event: 'agent_state', state, since: '2026-08-16T10:00:00.000Z' }));

        expect(beforeUnload().defaultPrevented).toBe(false);
      },
    );

    /**
     * **The cancel path.** The agent pressed Ctrl-W mid-call and chose *Stay*.
     *
     * Nothing about the console may have changed: the page is still here, so the
     * socket, the heartbeat and the media path must still be here too. This is
     * the assertion whose absence let a live call be silently cut.
     */
    it.each(['reserved', 'on_call', 'wrapup'])(
      'leaves a working console when the agent cancels the unload in %s',
      async (state) => {
        const view = await mounted();
        const socket = latest();
        act(() => latest().emit({ event: 'agent_state', state, since: '2026-08-16T10:00:00.000Z' }));

        beforeUnload();

        expect(socket.closedWith).toBeNull();
        expect(view.result.current.connection).toBe('open');
        // Not merely open — still carrying frames. A socket object that survived
        // a `close()` call would satisfy the two assertions above in a fake and
        // fail an agent in a browser.
        act(() =>
          latest().emit({
            event: 'bridged',
            attempt_id: 'att-1',
            bridged_at: '2026-08-11T10:00:00.000Z',
          }),
        );
        act(() => latest().emit({ event: 'agent_state', state: 'available', since: '2026-08-16T10:01:00.000Z' }));
        expect(view.result.current.agentState).toBe('available');
      },
    );

    it('does not close the socket on beforeunload in any state', async () => {
      // The general form of the above: `beforeunload` is a question, and a
      // question must not have side effects.
      await mounted();
      const socket = latest();

      beforeUnload();

      expect(socket.closedWith).toBeNull();
    });

    it.each(['on_call', 'available'])(
      'closes the socket on pagehide while %s, so the server hears immediately',
      async (state) => {
        // The hangup reasoning, moved to the event that actually means the page
        // is going away: an unloading tab that told the server nothing leaves a
        // customer on dead air until the heartbeat grace expires.
        await mounted();
        const socket = latest();
        act(() => latest().emit({ event: 'agent_state', state, since: '2026-08-16T10:00:00.000Z' }));

        pageHide();

        expect(socket.closedWith).toEqual({ code: 1000, reason: 'unload' });
      },
    );

    it('reconnects when the page comes back out of the back/forward cache', async () => {
      // A restored page is alive with the socket `pagehide` closed and a retired
      // generation that suppresses retries — the same dead console by another
      // route.
      //
      // The mint mock is required HERE and was not before, which is the point:
      // this path used to replay bootstrap's single-use token and eat a `4401`
      // plus a retry lap for it (the lone 4401 at the head of the production
      // burst). It now mints, so a restore costs nothing.
      mocks.mintStationToken.mockResolvedValue({
        session_id: 'sess-1',
        station_ws_url: '/proxy/agency/station/sess-1?token=RESTORED',
        expires_at: '2026-08-11T10:05:00.000Z',
      });
      await mounted();
      pageHide();
      const before = FakeSocket.instances.length;

      act(() => {
        const event = new Event('pageshow');
        Object.defineProperty(event, 'persisted', { value: true });
        window.dispatchEvent(event);
      });

      await waitFor(() => expect(FakeSocket.instances.length).toBe(before + 1));
      expect(latest().url).toContain('token=RESTORED');
    });

    it('does not reconnect on an ordinary (non-restored) pageshow', async () => {
      // Fired on every normal load. Reconnecting there would race the mount
      // effect into a second socket.
      await mounted();
      const before = FakeSocket.instances.length;

      act(() => {
        window.dispatchEvent(new Event('pageshow'));
      });

      await new Promise((r) => setTimeout(r, 30));
      expect(FakeSocket.instances).toHaveLength(before);
    });
  });
});

// `toAbsoluteWsUrl`'s tests moved to `agencyStationWsUrl.test.ts`, which mocks
// `API_BASE` — the thing that decides which HOST the socket addresses, and the
// thing the assertions here could not see. They checked that a path had become
// a URL and that the path survived, so they passed against a resolver aimed at
// the wrong origin entirely.
