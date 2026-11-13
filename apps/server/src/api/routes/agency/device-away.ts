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
 * paused as away without it (`decideDeviceAway`'s `switch`).
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
  AgencyAwayRingRefusalCode,
  AgencyBreakReason,
  AgencySessionStateResponse,
} from '@magick-agency/contracts/agency';
import { APP_PAUSE_BREAK_REASONS, AWAY_RING_BREAK_REASON, DEVICE_AWAY_BREAK_REASON } from '@magick-agency/contracts/agency';
import { AWAY_RING_BREAK, breakMustWait, DEVICE_AWAY_BREAK, PHONE_CALL_BREAK } from '@magick-agency/domain/break-manager';
import { agencyAgentSessionRepository } from '../../../db/repositories/agency.repository.js';
import { isCampaignSession, type AgencyAgentSessionRecord } from '../../../db/models/agency.model.js';
import type { AgencyRuntime } from '../../../agency/runtime.js';
import { AGENT_LEASE_MS } from '../../../agency/agent-state-machine.js';
import { awayRingRefusalBody } from '../../../agency/away-ring.js';

/**
 * What a device-away request does, from what the session is doing now.
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
 *  - `switch` (Mode B): a break-to-break move between the app's two away breaks, on `break`:
 *    `away_ring` asked on `device_away` (enter, from `break`), or `device_away` asked on `away_ring`
 *    (`ring = 1`: end it). Never from any other break, so a named catalog break or the soft phone's
 *    never gains `ring = 1` and is never replaced.
 *
 * `away_ring` asked while already on it (`ring`), or queued already, is `unchanged`. A queued
 * `device_away` is replaced by a queued `away_ring` and the other way round: both are the app's,
 * and the latest says what it can do now.
 */
export type DeviceAwayDecision = 'apply' | 'queue' | 'switch' | 'unchanged';

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
  /** The session row's break reason (the break a `break` lease is on). */
  breakReason?: string | null;
}): DeviceAwayDecision {
  if (!input.campaignSession) return 'unchanged';
  const code = input.code ?? DEVICE_AWAY_BREAK_REASON;
  const ring = input.ring === true && input.live === 'break';
  if (input.live === 'available') return 'apply';
  if (input.live === 'break') {
    if (code === AWAY_RING_BREAK_REASON) {
      return !ring && input.breakReason === DEVICE_AWAY_BREAK_REASON ? 'switch' : 'unchanged';
    }
    if (code === DEVICE_AWAY_BREAK_REASON && ring) return 'switch';
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

/**
 * Mode B: the 409 body refusing `away_ring` (`AwayRingService.refusalFor` says why; the app falls
 * back to `device_away`).
 */
export function awayRingRefusal(code: AgencyAwayRingRefusalCode = 'ring_not_allowed'): AgencyAwayRingRefusal {
  return awayRingRefusalBody(code);
}

/** How many times a lost CAS is re-decided before answering 409 state_changing (nothing changed). */
const DEVICE_AWAY_PASSES = 3;

export type DeviceAwayResult =
  | { ok: true; body: AgencySessionStateResponse & { [BREAK_UNCHANGED_KEY]?: true } }
  /** The state kept moving under every pass: nothing changed; the caller answers 409 state_changing. */
  | { ok: false; refused?: undefined }
  /** Mode B: `away_ring` refused before any state was read or written; the caller answers 409 with it. */
  | { ok: false; refused: AgencyAwayRingRefusal };

/**
 * Run an app pause (`code`: `device_away`, by default, or `phone_call`) for `session`
 * (already owned and live, `requireOwnedSession`).
 *
 * Every pass reads Redis once and decides from that one read; only `apply` writes, by
 * CAS, so a reservation or another break that lands between the read and the write is
 * never overwritten — the pass is simply re-decided. A `queue` is re-read once too: a
 * release that ran between the read and the queue would otherwise leave the break
 * queued behind an agent who is already `available` again, and backgrounded.
 */
export async function runDeviceAway(
  runtime: AgencyRuntime,
  session: AgencyAgentSessionRecord,
  code: AgencyAppPauseBreakReason = DEVICE_AWAY_BREAK_REASON,
): Promise<DeviceAwayResult> {
  if (code === AWAY_RING_BREAK_REASON) {
    const refused = await runtime.awayRing.refusalFor(session);
    if (refused) return { ok: false, refused: awayRingRefusal(refused) };
  }
  const reason: AgencyBreakReason = { ...APP_PAUSE_BREAKS[code] };
  let queuedHere = false;
  for (let pass = 0; pass < DEVICE_AWAY_PASSES; pass++) {
    let live = await runtime.agents.get(session.id);
    // ── Mode B: `device_away` during a ring not yet answered: the ring is declined ─────────
    // On the call's chain, through the ring's one end; the absence ends as `device_away`, keeping
    // its start (IQ76). An answered ring (`answered`) is decided below like any call: queued.
    if (code === DEVICE_AWAY_BREAK_REASON && live?.state === 'reserved' && runtime.awayRing.holdsPushOffer(session.id)) {
      const declined = await runtime.awayRing.declineRingForDeviceAway(session.id);
      if (declined === 'declined') {
        live = await runtime.agents.get(session.id);
        if (live?.state === 'break' && !live.ring) {
          // Ours, if one was queued on an earlier pass or request: it has applied now.
          runtime.awayRing.takeQueuedAwayPause(session.id);
          return {
            ok: true,
            body: {
              session_id: session.id, campaign_id: session.campaign_id, kind: session.kind, state: 'break',
              since: new Date(live.since ?? Date.now()).toISOString(), break_reason: reason.code,
            },
          };
        }
      }
    }
    const queued = runtime.breaks.peek(session.id);
    const decision = decideDeviceAway({
      campaignSession: isCampaignSession(session),
      live: live?.state ?? null,
      queued: queued?.code ?? null,
      code,
      ring: live?.ring ?? false,
      breakReason: session.break_reason,
    });
    const now = new Date();
    const since = now.toISOString();
    const applied = (at: string = since): DeviceAwayResult => ({
      ok: true,
      body: { session_id: session.id, campaign_id: session.campaign_id, kind: session.kind, state: 'break', since: at, break_reason: reason.code },
    });

    // ── Mode B: entering `away_ring` (from `available`, or switched from `device_away`) ──────
    if (code === AWAY_RING_BREAK_REASON && (decision === 'apply' || decision === 'switch')) {
      const entered = await runtime.awayRing.enter(session, decision === 'apply' ? ['available'] : ['break']);
      if (!entered.ok) {
        // Lost the compare-and-swap (a reservation, a release): re-decided. Refused by the guard (a
        // soft-phone call, an inbound call held): nothing to do, answered as it stands below.
        if (entered.reason === 'wrong_state' || entered.reason === 'unavailable') continue;
      } else {
        if (queued?.code === reason.code) runtime.breaks.take(session.id);
        // The absence's start, as the station's frame says (the instant Redis and the mirror hold).
        return applied(entered.since);
      }
    }
    // ── Mode B: `device_away` asked while on `away_ring`: the ringing ends, the pause stays ──
    // One absence: the pause keeps its start (`since`), as the station's frame says.
    if (code === DEVICE_AWAY_BREAK_REASON && decision === 'switch') {
      const ended = await runtime.awayRing.endKeepingSince(session.id, null, { offline: false, countAs: 'returned' });
      if (ended.outcome === 'ended') {
        // An away pause still queued from a ring (asked while it held the session) has applied now:
        // left queued, the release after the agent's next call would pause them unasked.
        runtime.awayRing.takeQueuedAwayPause(session.id);
        return applied(ended.since);
      }
      if (ended.outcome === 'not_away_ring' || ended.outcome === 'unavailable') continue;
      // A ring in flight: the connector's. Answered as it stands below.
    }

    if (decision === 'apply' && code !== AWAY_RING_BREAK_REASON) {
      const moved = await runtime.agents.transition(session.id, 'available', 'break', { leaseMs: AGENT_LEASE_MS.break });
      if (!moved) continue;
      // Ours, queued a moment ago and overtaken by a release: it has applied now.
      if (queued?.code === reason.code) runtime.breaks.take(session.id);
      await agencyAgentSessionRepository.setState(session.id, 'break', reason.code);
      runtime.stations.send(session.id, { event: 'agent_state', state: 'break', since, break_reason: reason.code });
      return {
        ok: true,
        body: { session_id: session.id, campaign_id: session.campaign_id, kind: session.kind, state: 'break', since, break_reason: reason.code },
      };
    }

    if (decision === 'queue') {
      runtime.breaks.queue(session.id, reason);
      queuedHere = true;
      // Suppressed under an unannounced dial, as for any queued break (`sessions.ts`).
      if (!runtime.dialer.hasUnannouncedAttempt(session.id)) {
        runtime.stations.send(session.id, {
          event: 'agent_state', state: live!.state, since, pending_state: 'break', pending_break_reason: reason.code,
        });
      }
      continue; // re-read: answered `unchanged`/queued next pass, or applied if released meanwhile
    }

    // `unchanged`: the current state, as the session holds it.
    const state = live?.state ?? 'offline';
    // Queued here, and the queue is empty again on `break`: the release applied ours
    // between two passes (the row read at the start of the request predates it). On
    // `away_ring` already (`ring`): that is its reason, whatever the row read said.
    const breakReason = queuedHere && state === 'break' && !queued
      ? reason.code
      : state === 'break' && live?.ring ? AWAY_RING_BREAK_REASON : session.break_reason;
    const body: AgencySessionStateResponse & { [BREAK_UNCHANGED_KEY]?: true } = {
      session_id: session.id,
      campaign_id: session.campaign_id,
      kind: session.kind,
      state,
      // The instant the lease last moved, when it says; this answer moved nothing.
      since: live?.since ? new Date(live.since).toISOString() : since,
      ...(queued && breakMustWait(state)
        ? { pending_state: 'break' as const, break_reason: queued.code }
        : state === 'break' && breakReason
          ? { break_reason: breakReason }
          : {}),
      ...(queuedHere ? {} : { [BREAK_UNCHANGED_KEY]: true as const }),
    };
    return { ok: true, body };
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
