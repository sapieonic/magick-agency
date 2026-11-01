/**
 * The RESERVED break reasons: codes the dialer itself puts an agent on, which no
 * campaign's `break_reasons` catalog may list.
 *
 * Both are ordinary breaks to pacing (it reserves only `available` agents) and to
 * occupancy (one more break reason, no new agent state). What makes them reserved is
 * who may enter them: the soft phone only through its switch (flag-checked and
 * audited, SP7), the device-away break only on the agency's own say-so that the app
 * is no longer in front of the agent. A campaign that listed either would let an agent
 * pick it from the break menu and mean something else by it, so the campaign-config
 * write refuses both and `resolveBreakReasons` drops both from a stored catalog.
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

/** Every reserved break code. A campaign's `break_reasons` lists none of them. */
export const RESERVED_BREAK_REASONS = [SOFTPHONE_BREAK_REASON, DEVICE_AWAY_BREAK_REASON] as const;

export type AgencyReservedBreakReason = (typeof RESERVED_BREAK_REASONS)[number];

/**
 * Each reserved code's label. Reserved codes have no catalog entry to carry one, so a
 * console that renders a break reason looks here first and falls back to the catalog.
 */
export const RESERVED_BREAK_REASON_LABELS: Readonly<Record<AgencyReservedBreakReason, string>> = Object.freeze({
  [SOFTPHONE_BREAK_REASON]: SOFTPHONE_BREAK_REASON_LABEL,
  [DEVICE_AWAY_BREAK_REASON]: DEVICE_AWAY_BREAK_REASON_LABEL,
});
