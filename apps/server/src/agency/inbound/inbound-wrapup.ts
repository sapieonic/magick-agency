import { AGENCY_INBOUND_OUTCOME_LAPSE_MS, AGENCY_INBOUND_ROUTE_DEFAULTS } from '@magick-agency/contracts/agency';

/**
 * ─── HOW LONG AN ANSWERED INBOUND CALL'S OUTCOME WAITS (docs/inbound.md §6; IQ52) ──────────
 *
 * The inbound wrap-up window is the ROUTE's (IQ52, which replaces IQ32's window): every inbound
 * call on a route, matched to a campaign or not, on a console or a phone, takes the route's
 * `wrapup_seconds` (30 s by default, 10–600 s, set in the route editor), always with auto-return:
 * the outcome lapses `no_disposition` that long after the call ended and the agent is returned to
 * the pool. The matched campaign's own wrap-up rule (`wrapup_seconds`, `wrapup_auto_return`) no
 * longer applies to an inbound call. {@link AGENCY_INBOUND_OUTCOME_LAPSE_MS} (30 minutes) stays the
 * backstop: no outcome waits longer.
 *
 * **The window is captured on the call** (`agency_inbound_calls.wrapup_seconds`, 0032), written
 * from its route when the call arrives, and read from the row from then on. A route edited or
 * deleted while its call is live or its outcome owed does not move the countdown the agent was
 * shown, and the read needs no join (a deleted route's row is kept, but an edit would otherwise
 * change a window already on screen). A call with none (the tenant default's, which no agent
 * takes; a row from before the migration with no route) takes {@link INBOUND_DEFAULT_WRAPUP_SECONDS}.
 *
 * One rule, read in two places that must agree: the panel's `outcome_due_at`
 * (`inbound-call-wire.ts`) and the lapse sweep's SQL (`agencyInboundCallRepository.lapseUnsettled`).
 */

/** The window of a call that captured none: the route's default (IQ52: "start at 30"). */
export const INBOUND_DEFAULT_WRAPUP_SECONDS = AGENCY_INBOUND_ROUTE_DEFAULTS.wrapup_seconds;

/** How long after the call ended its outcome lapses, in ms: the captured window (else the default), never past the backstop. */
export function inboundOutcomeWindowMs(
  call: { wrapup_seconds: number | null },
  backstopMs: number = AGENCY_INBOUND_OUTCOME_LAPSE_MS,
): number {
  const seconds = call.wrapup_seconds ?? INBOUND_DEFAULT_WRAPUP_SECONDS;
  return Math.min(seconds * 1000, backstopMs);
}
