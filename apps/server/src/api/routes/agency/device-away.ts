/*
 * The agent app's own pauses (`APP_PAUSE_BREAK_REASONS`): what `POST /sessions/:id/break`
 * does with `reason: 'device_away'`, which the agent mobile app sends the moment it is
 * backgrounded, and (IQ51) `reason: 'phone_call'`, which it sends when a cellular call
 * starts while the agent is available. Part of `agency.routes.ts` (the session routes,
 * `./sessions.ts`).
 *
 * The other breaks are the agent's choice from a menu; these are the app saying "I can
 * no longer promise anyone is in front of me" (or "they are on another call"). So they
 * protect pacing and never override a choice: they take an `available` agent out of the
 * pool now, are queued behind a call like any break, and leave every other state exactly
 * as it was (`decideDeviceAway`). Both run the same rules with their own code; neither is
 * ever a campaign catalog's, and the ordinary `POST /sessions/:id/available` lifts either.
 *
 * Mode B (IQ58, IQ67): `reason: 'away_ring'`, the away break whose phone rings for inbound callers,
 * is the third of these pauses. It is checked before anything is read from Redis or written
 * (`AwayRingService.refusalFor`: both flags, the session's station device registered with a token
 * and opted in, the push sender configured, a campaign session) and refused 409 with a typed code
 * otherwise; the app then falls back to `device_away`. It runs the same rules, with one more:
 * `device_away ↔ away_ring` is a break-to-break SWITCH (the app's own two away breaks, never the
 * agent's choice), so an agent already paused as away can be rung, and an agent being rung can be
 * paused as away without it (`decideDeviceAway`'s `enter_ring` and `end_ring`).
 *
 * `device_away` asked while a ring holds the session `reserved` (the away notification's "Stop
 * ringing", IQ79): a ring not yet answered is the agent saying no to it, so it is declined through
 * the ring's one end (`declined`, never a miss) and the absence ended as `device_away` keeping its
 * start (`AwayRingService.declineRingForDeviceAway`), answered as applied. A ring already answered
 * is the agent taking the call: the pause queues behind it, as behind any call. Either away pause
 * left queued is settled by the ring's end or by the switch, never by the release after the
 * agent's next call.
 */
import type {
  AgencyAgentState,
  AgencyAppPauseBreakReason,
  AgencyAwayRingRefusal,
  AgencyBreakReason,
  AgencySessionStateResponse,
} from '@magick-agency/contracts/agency';
import { APP_PAUSE_BREAK_REASONS, AWAY_RING_BREAK_REASON, DEVICE_AWAY_BREAK_REASON } from '@magick-agency/contracts/agency';
import { AWAY_RING_BREAK, breakMustWait, DEVICE_AWAY_BREAK, PHONE_CALL_BREAK } from '@magick-agency/domain/break-manager';
import { agencyAgentSessionRepository } from '../../../db/repositories/agency.repository.js';
import { isCampaignSession, type AgencyAgentSessionRecord } from '../../../db/models/agency.model.js';
import type { AgencyRuntime } from '../../../agency/runtime.js';
import { AGENT_LEASE_MS } from '../../../agency/agent-state-machine.js';
import { AWAY_RING_RETURN_END, awayRingRefusalBody } from '../../../agency/away-ring.js';

/**
 * What a device-away request does, from what the session is doing now (one read of Redis, and the
 * connector's synchronous push-offer answer).
 *
 *  - `apply`: the agent is `available` — the one state in which pacing can reserve
 *    them — so it applies now (a CAS from `available`, so a reservation that lands
 *    first wins and the request is re-decided as a queued one).
 *  - `queue`: `reserved`, `on_call` or `wrapup` with nothing queued: queued exactly as
 *    any break is (`breakMustWait`), applied by the release at the end of wrap-up.
 *  - `unchanged`: everything else, answered with the current state —
 *    * already queued, or already on it: idempotent;
 *    * another break queued: never replaced (it is the agent's choice, and a queued
 *      switch to the soft phone would otherwise be withdrawn by backgrounding the app);
 *    * on `break` with any other reason (the soft phone's included): already out of the
 *      pool, so there is nothing to protect, and the agent's reason stands;
 *    * `offline`, or no lease at all (`null`: lapsed, or Redis could not answer, which
 *      pacing reads as gone too): not in the pool;
 *    * a soft-phone session: never paced, so nothing to protect.
 *
 * Mode B:
 *  - `enter_ring`: `away_ring` asked on `available` (entered from `available`, by CAS), or on
 *    `device_away` (a break-to-break switch, entered from `break`);
 *  - `end_ring`: `device_away` asked on `away_ring` (`ring = 1`): the ringing ends, the pause stays.
 *    Neither switch runs from any other break, so a named catalog break or the soft phone's never
 *    gains `ring = 1` and is never replaced. Which break the agent is on is Redis's (the hash's
 *    `reason`), and the entry script checks it again in the same step as its write: a break written
 *    over `device_away` after this read (a supervisor's, the agent's own from another tab) is never
 *    replaced, and a `break` written with no reason is never switched from;
 *  - `decline_ring`: `device_away` asked while a ring holds the session `reserved` (`pushOffer`,
 *    the away notification's "Stop ringing", IQ79): a ring not yet answered is declined through the
 *    ring's one end; an answered one is the agent taking the call, and the pause is then re-decided
 *    as queued behind it.
 *
 * `away_ring` asked while already on it (`ring`), or queued already, is `unchanged`. A queued
 * `device_away` is replaced by a queued `away_ring` and the other way round: both are the app's,
 * and the latest says what it can do now.
 */
export type DeviceAwayDecision = 'apply' | 'queue' | 'unchanged' | 'enter_ring' | 'end_ring' | 'decline_ring';

export function decideDeviceAway(input: {
  campaignSession: boolean;
  /** Redis's state; null when there is no lease or it could not be read. */
  live: AgencyAgentState | null;
  /** The code of the break queued for this session, if any. */
  queued: string | null;
  /** The pause asked for; `device_away` when left out. */
  code?: AgencyAppPauseBreakReason;
  /** Redis's `ring` (Mode B): the session is on `away_ring`. */
  ring?: boolean;
  /**
   * Redis's break reason (the agent hash's `reason`: the break a `break` lease is on), never the
   * session row's, which is a mirror read once at the start of the request and may be stale.
   */
  breakReason?: string | null;
  /** Mode B: the session holds a push offer (a ring, or an answered ring in its accept grace). */
  pushOffer?: boolean;
}): DeviceAwayDecision {
  const code = input.code ?? DEVICE_AWAY_BREAK_REASON;
  if (code === DEVICE_AWAY_BREAK_REASON && input.live === 'reserved' && input.pushOffer === true) return 'decline_ring';
  if (!input.campaignSession) return 'unchanged';
  const ring = input.ring === true && input.live === 'break';
  if (input.live === 'available') return code === AWAY_RING_BREAK_REASON ? 'enter_ring' : 'apply';
  if (input.live === 'break') {
    if (code === AWAY_RING_BREAK_REASON) {
      return !ring && input.breakReason === DEVICE_AWAY_BREAK_REASON ? 'enter_ring' : 'unchanged';
    }
    if (code === DEVICE_AWAY_BREAK_REASON && ring) return 'end_ring';
    return 'unchanged';
  }
  if (breakMustWait(input.live)) {
    if (input.queued === null) return 'queue';
    const awayPair = (input.queued === DEVICE_AWAY_BREAK_REASON && code === AWAY_RING_BREAK_REASON)
      || (input.queued === AWAY_RING_BREAK_REASON && code === DEVICE_AWAY_BREAK_REASON);
    return awayPair ? 'queue' : 'unchanged';
  }
  return 'unchanged';
}

/**
 * Set on an internal answer that changed nothing, and taken off by the public layer
 * ({@link takeBreakUnchanged}) before the client sees it: an idempotent repeat or a
 * no-op is not a break, so it writes no `agency_session.break_started` row (the
 * soft-phone switch's `unchanged` rule).
 */
export const BREAK_UNCHANGED_KEY = 'break_unchanged';

/** Remove the no-change marker from an internal answer (mutating it); whether it was there. */
export function takeBreakUnchanged(body: unknown): boolean {
  if (!body || typeof body !== 'object' || !(BREAK_UNCHANGED_KEY in body)) return false;
  const record = body as Record<string, unknown>;
  const unchanged = record[BREAK_UNCHANGED_KEY] === true;
  delete record[BREAK_UNCHANGED_KEY];
  return unchanged;
}

/** Whether `reason` is one of the app's own pauses (`device_away`, `phone_call`, `away_ring`): the device-away rules apply. */
export function isAppPauseBreakReason(reason: unknown): reason is AgencyAppPauseBreakReason {
  return typeof reason === 'string' && (APP_PAUSE_BREAK_REASONS as readonly string[]).includes(reason);
}

/** Each app pause's reason entry (the break queue holds it; no catalog carries it). */
const APP_PAUSE_BREAKS: Readonly<Record<AgencyAppPauseBreakReason, Readonly<AgencyBreakReason>>> = {
  device_away: DEVICE_AWAY_BREAK,
  phone_call: PHONE_CALL_BREAK,
  away_ring: AWAY_RING_BREAK,
};

/** How many times a lost CAS is re-decided before answering 409 state_changing (nothing changed). */
const DEVICE_AWAY_PASSES = 3;

export type DeviceAwayResult =
  | { ok: true; body: AgencySessionStateResponse & { [BREAK_UNCHANGED_KEY]?: true } }
  /** The state kept moving under every pass: nothing changed; the caller answers 409 state_changing. */
  | { ok: false; refused?: undefined }
  /** Mode B: `away_ring` refused before any state was read or written; the caller answers 409 with it. */
  | { ok: false; refused: AgencyAwayRingRefusal };

/**
 * Run an app pause (`code`: `device_away`, by default, `phone_call` or `away_ring`) for `session`
 * (already owned and live, `requireOwnedSession`).
 *
 * Every pass reads Redis once and decides from that one read ({@link decideDeviceAway}); only the
 * writes it decides run, each by compare-and-swap (or the away break's own scripts), so a
 * reservation or another break that lands between the read and the write is never overwritten —
 * the pass is simply re-decided. A `queue` is re-read once too: a release that ran between the read
 * and the queue would otherwise leave the break queued behind an agent who is already `available`
 * again, and backgrounded. A ring's decline is tried once per request and is no lost pass: the
 * request is re-decided from what the ring's end left.
 */
export async function runDeviceAway(
  runtime: AgencyRuntime,
  session: AgencyAgentSessionRecord,
  code: AgencyAppPauseBreakReason = DEVICE_AWAY_BREAK_REASON,
): Promise<DeviceAwayResult> {
  if (code === AWAY_RING_BREAK_REASON) {
    const refused = await runtime.awayRing.refusalFor(session);
    if (refused) return { ok: false, refused: awayRingRefusalBody(refused) };
  }
  const reason: AgencyBreakReason = { ...APP_PAUSE_BREAKS[code] };
  /** The answer once the pause holds: `break` on it, since `at` (the absence's start, for the away breaks). */
  const applied = (at: string): DeviceAwayResult => ({
    ok: true,
    body: { session_id: session.id, campaign_id: session.campaign_id, kind: session.kind, state: 'break', since: at, break_reason: reason.code },
  });
  let queuedHere = false;
  let declineTried = false;
  for (let pass = 0; pass < DEVICE_AWAY_PASSES;) {
    const live = await runtime.agents.get(session.id);
    const queued = runtime.breaks.peek(session.id);
    const decision = decideDeviceAway({
      campaignSession: isCampaignSession(session),
      live: live?.state ?? null,
      queued: queued?.code ?? null,
      code,
      ring: live?.ring ?? false,
      breakReason: live?.breakReason ?? null,
      pushOffer: !declineTried && code === DEVICE_AWAY_BREAK_REASON && live?.state === 'reserved'
        && runtime.awayRing.holdsPushOffer(session.id),
    });
    const since = new Date().toISOString();

    switch (decision) {
      case 'decline_ring': {
        // On the call's chain, through the ring's one end; the absence ends as `device_away`,
        // keeping its start (IQ76). An answered ring (`answered`) is re-decided like any call: queued.
        declineTried = true;
        if ((await runtime.awayRing.declineRingForDeviceAway(session.id)) === 'declined') {
          const after = await runtime.agents.get(session.id);
          if (after?.state === 'break' && !after.ring) {
            // Ours, if one was queued on an earlier pass or request: it has applied now.
            runtime.awayRing.takeQueuedAwayPause(session.id);
            return applied(new Date(after.since ?? Date.now()).toISOString());
          }
        }
        continue;
      }
      case 'enter_ring': {
        const entered = await runtime.awayRing.enter(session, live?.state === 'available' ? ['available'] : ['break']);
        if (entered.ok) {
          if (queued?.code === reason.code) runtime.breaks.take(session.id);
          // The absence's start, as the station's frame says (the instant Redis and the mirror hold).
          return applied(entered.since);
        }
        // Lost the compare-and-swap (a reservation, a release): re-decided. Refused by the guard (a
        // soft-phone call, an inbound call held): nothing to do, answered as it stands.
        if (entered.reason === 'wrong_state' || entered.reason === 'unavailable') {
          pass++;
          continue;
        }
        break;
      }
      case 'end_ring': {
        // One absence: the pause keeps its start (`since`), as the station's frame says.
        const ended = await runtime.awayRing.endKeepingSince(session.id, null, AWAY_RING_RETURN_END);
        if (ended.outcome === 'ended') {
          // An away pause still queued from a ring (asked while it held the session) has applied now:
          // left queued, the release after the agent's next call would pause them unasked.
          runtime.awayRing.takeQueuedAwayPause(session.id);
          return applied(ended.since ?? since);
        }
        if (ended.outcome === 'not_away_ring' || ended.outcome === 'unavailable') {
          pass++;
          continue;
        }
        // A ring in flight: the connector's. Answered as it stands.
        break;
      }
      case 'apply': {
        const moved = await runtime.agents.transition(session.id, 'available', 'break', { leaseMs: AGENT_LEASE_MS.break, breakReason: reason.code });
        if (!moved) {
          pass++;
          continue;
        }
        // Ours, queued a moment ago and overtaken by a release: it has applied now.
        if (queued?.code === reason.code) runtime.breaks.take(session.id);
        await agencyAgentSessionRepository.setState(session.id, 'break', reason.code);
        runtime.stations.send(session.id, { event: 'agent_state', state: 'break', since, break_reason: reason.code });
        return applied(since);
      }
      case 'queue': {
        runtime.breaks.queue(session.id, reason);
        queuedHere = true;
        // Suppressed under an unannounced dial, as for any queued break (`sessions.ts`).
        if (!runtime.dialer.hasUnannouncedAttempt(session.id)) {
          runtime.stations.send(session.id, {
            event: 'agent_state', state: live!.state, since, pending_state: 'break', pending_break_reason: reason.code,
          });
        }
        pass++;
        continue; // re-read: answered `unchanged`/queued next pass, or applied if released meanwhile
      }
      case 'unchanged':
        break;
    }
    return asItStands(session, reason.code, live, queued, queuedHere, since);
  }
  // A `queue` on the last pass is still a queued break: answer it rather than 409.
  if (queuedHere && runtime.breaks.peek(session.id)?.code === reason.code) {
    const live = await runtime.agents.get(session.id);
    return {
      ok: true,
      body: {
        session_id: session.id, campaign_id: session.campaign_id, kind: session.kind,
        state: live?.state ?? 'offline', since: new Date().toISOString(),
        pending_state: 'break', break_reason: reason.code,
      },
    };
  }
  return { ok: false };
}

/**
 * The answer of a pass that moved nothing (or whose write was refused): the current state, as the
 * session holds it, marked {@link BREAK_UNCHANGED_KEY} unless this request queued the pause.
 */
function asItStands(
  session: AgencyAgentSessionRecord,
  code: string,
  live: { state: AgencyAgentState; since?: number | null; ring?: boolean; breakReason?: string | null } | null,
  queued: Readonly<AgencyBreakReason> | null,
  queuedHere: boolean,
  now: string,
): DeviceAwayResult {
  const state = live?.state ?? 'offline';
  // Queued here, and the queue is empty again on `break`: the release applied ours
  // between two passes (the row read at the start of the request predates it). On
  // `away_ring` already (`ring`): that is its reason, whatever the row read said. Otherwise Redis's
  // reason when it has one (the row read at the start may be stale), else the row's.
  const breakReason = queuedHere && state === 'break' && !queued
    ? code
    : state === 'break' && live?.ring ? AWAY_RING_BREAK_REASON : live?.breakReason ?? session.break_reason;
  const body: AgencySessionStateResponse & { [BREAK_UNCHANGED_KEY]?: true } = {
    session_id: session.id,
    campaign_id: session.campaign_id,
    kind: session.kind,
    state,
    // The instant the lease last moved, when it says; this answer moved nothing.
    since: live?.since ? new Date(live.since).toISOString() : now,
    ...(queued && breakMustWait(state)
      ? { pending_state: 'break' as const, break_reason: queued.code }
      : state === 'break' && breakReason
        ? { break_reason: breakReason }
        : {}),
    ...(queuedHere ? {} : { [BREAK_UNCHANGED_KEY]: true as const }),
  };
  return { ok: true, body };
}
