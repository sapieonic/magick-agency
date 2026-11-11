/**
 * The RESERVED break reasons: codes the dialer itself puts an agent on, which no
 * campaign's `break_reasons` catalog may list.
 *
 * All are ordinary breaks to pacing (it reserves only `available` agents) and to
 * occupancy (one more break reason, no new agent state). What makes them reserved is
 * who may enter them: the soft phone only through its switch (flag-checked and
 * audited, SP7), the device-away and phone-call breaks only on the agent app's own say-so
 * that the app is no longer in front of the agent, or that the agent is on a cellular
 * call. A campaign that listed one would let an agent pick it from the break menu and
 * mean something else by it, so the campaign-config write refuses them and
 * `resolveBreakReasons` drops them from a stored catalog.
 *
 * Part of the dialer contract; `../agency.ts` is the barrel and carries the
 * contract's header (freeze rules, vocabulary).
 */

import { SOFTPHONE_BREAK_REASON, SOFTPHONE_BREAK_REASON_LABEL } from './softphone';

/**
 * The break the agent mobile app requests the moment it is backgrounded (the OS can
 * suspend it from then on, so its audio and heartbeat can no longer be relied on).
 *
 * Accepted by `POST /sessions/:id/break` on a CAMPAIGN session although no catalog
 * lists it, with the rules of a break that protects pacing and never overrides the
 * agent's own choice:
 *  - from `available`: applied now;
 *  - from `reserved` / `on_call` / `wrapup`: queued like any break (`pending_state`),
 *    unless another break is already queued, which it never replaces;
 *  - already on `break` with any other reason, `offline` (or no lease), a soft-phone
 *    session or the soft phone's break: nothing changes, the answer is the current
 *    state (200);
 *  - already on it, or already queued: idempotent.
 *
 * The return is the ordinary `POST /sessions/:id/available`, and `break/cancel`
 * withdraws a queued one. Supervisors see it as {@link DEVICE_AWAY_BREAK_REASON_LABEL},
 * and it is still a break for the 30-minute long-break flag: an agent away from the
 * app for half an hour is worth a supervisor's look.
 */
export const DEVICE_AWAY_BREAK_REASON = 'device_away' as const;

/** How the console labels {@link DEVICE_AWAY_BREAK_REASON}. */
export const DEVICE_AWAY_BREAK_REASON_LABEL = 'Away (app in background)';

/**
 * IQ51: the break the agent mobile app requests when a CELLULAR call starts while the agent
 * is `available` (the phone rings or the agent dials out on it), for the length of that
 * call; the app returns the agent with the ordinary `POST /sessions/:id/available` when the
 * call ends, and only a pause the call itself caused. A cellular call during a station call
 * is not one (the audio interruption handles it).
 *
 * Accepted by `POST /sessions/:id/break` on a campaign session exactly as
 * {@link DEVICE_AWAY_BREAK_REASON} is (the same rules: applied from `available`, queued
 * behind a reservation, call or wrap-up, never replacing a break already chosen or
 * queued, a no-op answered with the current state elsewhere, idempotent, `break/cancel`
 * withdraws a queued one). For inbound calls it is an ordinary break: the agent is on
 * another call, so it never counts as one who could take a caller (unlike a fresh
 * `device_away` pause, IQ50). Supervisors see it as {@link PHONE_CALL_BREAK_REASON_LABEL}.
 */
export const PHONE_CALL_BREAK_REASON = 'phone_call' as const;

/** How the console labels {@link PHONE_CALL_BREAK_REASON}. */
export const PHONE_CALL_BREAK_REASON_LABEL = 'On a phone call';

/** Every reserved break code. A campaign's `break_reasons` lists none of them. */
export const RESERVED_BREAK_REASONS = [SOFTPHONE_BREAK_REASON, DEVICE_AWAY_BREAK_REASON, PHONE_CALL_BREAK_REASON] as const;

/**
 * The reserved codes the agent app itself asks `POST /sessions/:id/break` for (IQ50, IQ51),
 * each by the device-away rules (`apps/server/src/api/routes/agency/device-away.ts`).
 */
export const APP_PAUSE_BREAK_REASONS = [DEVICE_AWAY_BREAK_REASON, PHONE_CALL_BREAK_REASON] as const;

export type AgencyAppPauseBreakReason = (typeof APP_PAUSE_BREAK_REASONS)[number];

export type AgencyReservedBreakReason = (typeof RESERVED_BREAK_REASONS)[number];

/**
 * Each reserved code's label. Reserved codes have no catalog entry to carry one, so a
 * console that renders a break reason looks here first and falls back to the catalog.
 */
export const RESERVED_BREAK_REASON_LABELS: Readonly<Record<AgencyReservedBreakReason, string>> = Object.freeze({
  [SOFTPHONE_BREAK_REASON]: SOFTPHONE_BREAK_REASON_LABEL,
  [DEVICE_AWAY_BREAK_REASON]: DEVICE_AWAY_BREAK_REASON_LABEL,
  [PHONE_CALL_BREAK_REASON]: PHONE_CALL_BREAK_REASON_LABEL,
});
