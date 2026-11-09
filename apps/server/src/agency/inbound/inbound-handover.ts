import { createChildLogger } from '@magick-agency/observability';
import type { AgentStateMachine } from '../agent-state-machine.js';

const log = createChildLogger({ component: 'agency-inbound-handover' });

/**
 * ─── THE IN-FLIGHT CLASH'S HAND-OVER (docs/inbound.md §5.4; P2) ───────────────────────────────
 *
 * The router, at the answer, cancels an outbound dial still ringing the caller's number on a
 * carrier that can (the dialer's `supersedeForInbound`), after {@link InboundHandovers.expect}
 * promised the call to that dial's session; it promises it only to a session the release hook can
 * take (a console station on a campaign, OPEN), so a phone's or a soft-phone session's dial is
 * never cancelled for nothing. No other agent is offered the call meanwhile. The cancelled dial's
 * end releases the session, and the release hook (`InboundConnector.takeOnRelease` →
 * {@link InboundHandovers.take}) takes it for the call first, CAS from `reserved`, so the agent
 * who had the customer's panel gets their call with no `available` instant between: offered at
 * once when the call is queued, else HELD for it (reserved, the `inbound` field set) until its
 * preamble ends, when the connector offers it (`onQueued`). A hand-over the release did not take
 * (a queued break, the station gone, the carrier answering the dial first) is dropped and the
 * caller queues normally; {@link INBOUND_HANDOVER_TIMEOUT_MS} bounds the wait.
 *
 * This module keeps the promises (one per session and one per call) and their timers, and runs the
 * hand-over's steps; the call's state, its serial chain, the agent's reservation and the offer are
 * the connector's, reached through {@link HandoverHost}. Every step that touches a call runs on
 * that call's chain (`host.serial`); {@link take} runs under the account's lock (the release hook's)
 * and never waits on a chain behind a leaving caller's message.
 */

/**
 * How long a call waits for the agent of the dial it superseded to be released before it is
 * offered to anyone (a backstop: the cancelled dial's end releases them within moments).
 */
export const INBOUND_HANDOVER_TIMEOUT_MS = 15_000;

/**
 * A call promised to the agent of the outbound dial it superseded. `held`: that agent is already
 * reserved for it (their dial ended while the call was still in its preamble), and is offered it
 * the moment it queues. Not `held`: the dial is still ending; no other agent is offered the call
 * meanwhile, and {@link INBOUND_HANDOVER_TIMEOUT_MS} bounds the wait.
 */
export interface Handover {
  sessionId: string;
  held: boolean;
  timer: NodeJS.Timeout | null;
}

/** What the hand-over reads of a call the connector holds (the live object: read after every await). */
export interface HandoverCall {
  readonly id: string;
  readonly phase: string;
  readonly leaving: boolean;
  readonly accountKey: string;
}

/** The connector's side of the hand-over: its calls, chains, reservations and offers. */
export interface HandoverHost {
  /** The call, if the connector holds it. */
  call(callId: string): HandoverCall | undefined;
  /** The call is on offer to an agent now. */
  offeredNow(callId: string): boolean;
  /** The release hook may take this session for an inbound call (a console station on a campaign, OPEN). */
  releasable(sessionId: string): boolean;
  /** The connector has stopped taking work. */
  stopped(): boolean;
  /** Run `fn` on the call's serial chain (never rejects). */
  serial<T>(callId: string, fn: () => Promise<T>): Promise<T>;
  /** CAS the session from `reserved` / `on_call` / `wrapup` to this call (`reserveForInbound`). */
  reserve(sessionId: string, callId: string): ReturnType<AgentStateMachine['reserveForInbound']>;
  /** Clear the session's `inbound` field, by this call's id. */
  unreserve(sessionId: string, callId: string): Promise<unknown>;
  /** Offer the queued call to the session already reserved for it (the connector's `offer`). */
  offer(callId: string, sessionId: string): Promise<'offered' | 'call_gone' | 'session_busy'>;
  /** Undo a reservation whose offer was refused (the connector's `giveBack`). */
  giveBack(sessionId: string, callId: string, why: 'call_gone' | 'session_busy'): Promise<void>;
  /** Search the account in the background. */
  search(accountKey: string): void;
  /** The session is held for the call through its preamble: the call names it, the agent is told `reserved`, the lease renewed, the state mirrored. */
  seat(callId: string, sessionId: string, agentUserId: string): Promise<void>;
  /** Undo {@link seat}: the lease stopped, the session no longer the call's. */
  unseat(callId: string, sessionId: string): void;
  /** Return the agent to the pool in the background (`releaseAgent`). */
  returnAgent(sessionId: string): void;
}

export class InboundHandovers {
  /** sessionId → the call promised to it, until the session's release takes (or drops) it. */
  private readonly bySession = new Map<string, string>();
  /** callId → its hand-over, until offered, let go or dropped. */
  private readonly byCall = new Map<string, Handover>();

  constructor(private readonly host: HandoverHost, private readonly timeoutMs = INBOUND_HANDOVER_TIMEOUT_MS) {}

  /** The call's hand-over, if it has one. */
  of(callId: string): Readonly<Handover> | null {
    return this.byCall.get(callId) ?? null;
  }

  /** The session is held for this call through its preamble. */
  isHeldFor(callId: string, sessionId: string): boolean {
    const h = this.byCall.get(callId);
    return !!h && h.held && h.sessionId === sessionId;
  }

  /** A call is promised to this session and its release has not taken it yet. */
  hasPending(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }

  /**
   * Promise `callId` (held by the connector, in its preamble or already queued) to `sessionId`,
   * whose outbound dial to the same customer is about to be cancelled (see the header). From now
   * on no other agent is offered the call, and when the dial's end releases the session the
   * session is taken for it whatever the call's phase ({@link take}). Dropped ({@link drop}) when
   * the dial was not cancelled after all, when the release did not reach the hook (a queued break,
   * the station gone), or after {@link INBOUND_HANDOVER_TIMEOUT_MS}: the caller then queues
   * normally.
   *
   * False, and nothing promised: the session cannot be taken by the hook, the call is not held
   * here waiting (ended, offered, overflowing), or one of the two already has a hand-over.
   */
  expect(sessionId: string, callId: string): boolean {
    if (this.host.stopped() || this.bySession.has(sessionId)) return false;
    // Only a session the release hook can take: a phone (Q20), a soft-phone session or a station
    // not OPEN never takes an inbound call, so its dial is left to ring (cancelled, the agent
    // would lose it for nothing and the caller would queue for someone else all the same).
    if (!this.host.releasable(sessionId)) return false;
    const call = this.host.call(callId);
    if (!call || this.byCall.has(callId) || call.leaving || (call.phase !== 'preamble' && call.phase !== 'queued')) return false;
    if (call.phase === 'queued' && this.host.offeredNow(callId)) return false;
    const timer = setTimeout(() => this.drop(sessionId), this.timeoutMs);
    timer.unref?.();
    this.byCall.set(callId, { sessionId, held: false, timer });
    this.bySession.set(sessionId, callId);
    log.info({ inboundCallId: callId, sessionId }, 'Inbound call promised to the agent of the dial it superseded');
    return true;
  }

  /**
   * Drop a hand-over not yet taken by the session's release ({@link expect}): the call queues
   * normally and the account is searched. A no-op once the release took it (the session is
   * reserved for the call then) or when none is pending.
   */
  drop(sessionId: string): void {
    const callId = this.bySession.get(sessionId);
    if (callId === undefined) return;
    this.bySession.delete(sessionId);
    const call = this.host.call(callId);
    const h = this.byCall.get(callId);
    if (!call || h?.sessionId !== sessionId || h.held) return;
    if (h.timer) clearTimeout(h.timer);
    this.byCall.delete(callId);
    log.info({ inboundCallId: callId, sessionId }, 'Hand-over of a superseding inbound call dropped — the caller queues normally');
    if (call.phase === 'queued') this.host.search(call.accountKey);
  }

  /**
   * The release hook's hand-over (under the account's lock): reserve `sessionId` for the call
   * promised to it (CAS from `reserved` / `on_call` / `wrapup`) and offer it, or hold the session
   * for it while the call's preamble plays. True: the session was taken; false: the hand-over is
   * gone (none pending, the call left, or the CAS lost) and the release goes on as it would have.
   */
  async take(sessionId: string, agentUserId: string): Promise<boolean> {
    const callId = this.bySession.get(sessionId);
    if (callId === undefined) return false;
    this.bySession.delete(sessionId);
    const call = this.host.call(callId);
    const h = this.byCall.get(callId);
    if (!call || h?.sessionId !== sessionId) return false;
    if (h.timer) clearTimeout(h.timer);
    const reserved = call.phase === 'preamble' || call.phase === 'queued'
      ? await this.host.reserve(sessionId, callId)
      : null;
    if (!reserved?.ok) {
      this.byCall.delete(callId);
      if (reserved) log.warn({ inboundCallId: callId, sessionId, reserved }, 'Could not take the superseded dial\'s agent for its customer\'s call');
      if (call.phase === 'queued') this.host.search(call.accountKey);
      return false;
    }
    if (call.leaving) {
      // Overflowing meanwhile (the maximum wait): never wait on its chain under the lock.
      this.byCall.delete(callId);
      await this.host.unreserve(sessionId, callId);
      return false;
    }
    // On the call's chain: the preamble's end (`onQueued`) and the call's end are serialised with it.
    return this.host.serial(callId, async () => {
      if (call.phase === 'queued') {
        this.byCall.delete(callId);
        const offered = await this.host.offer(callId, sessionId);
        if (offered === 'offered') return true;
        await this.host.giveBack(sessionId, callId, offered);
        return false;
      }
      if (call.phase !== 'preamble') {
        this.byCall.delete(callId);
        await this.host.unreserve(sessionId, callId);
        return false;
      }
      // Held through the preamble (Q5: no agent is bound during the greeting or the notice).
      this.byCall.set(callId, { sessionId, held: true, timer: null });
      await this.host.seat(callId, sessionId, agentUserId);
      log.info({ inboundCallId: callId, sessionId }, 'Superseded dial\'s agent held for its customer\'s call until the preamble ends');
      return true;
    });
  }

  /**
   * The call's preamble ended with a session held for it: the hand-over is spent and the session
   * named, for the connector to offer it the call. Null: no session held for it.
   */
  takeHeld(callId: string): string | null {
    const h = this.byCall.get(callId);
    if (!h?.held) return null;
    this.byCall.delete(callId);
    return h.sessionId;
  }

  /**
   * Let go of a session held for this call through its preamble, if any: unseated, the
   * reservation's `inbound` field cleared and, with `returnAgent`, the agent returned to the pool
   * in the background. A hand-over not yet taken is just dropped. On the call's chain.
   */
  async release(callId: string, opts: { returnAgent: boolean }): Promise<void> {
    const h = this.byCall.get(callId);
    if (!h) return;
    this.byCall.delete(callId);
    if (h.timer) clearTimeout(h.timer);
    if (this.bySession.get(h.sessionId) === callId) this.bySession.delete(h.sessionId);
    if (!h.held) return;
    this.host.unseat(callId, h.sessionId);
    await this.host.unreserve(h.sessionId, callId);
    if (opts.returnAgent) this.host.returnAgent(h.sessionId);
  }

  /** The call left the connector: its hand-over, if any, forgotten (every path that ends a held one releases its session first). */
  forget(callId: string): void {
    const h = this.byCall.get(callId);
    if (!h) return;
    if (h.timer) clearTimeout(h.timer);
    if (this.bySession.get(h.sessionId) === callId) this.bySession.delete(h.sessionId);
    this.byCall.delete(callId);
  }

  /** Every timer cleared (the connector's stop): no hand-over is dropped by its backstop any more. */
  clearTimers(): void {
    for (const h of this.byCall.values()) {
      if (h.timer) clearTimeout(h.timer);
      h.timer = null;
    }
  }
}
