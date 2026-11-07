import type { CarrierAccountPauseReason } from '../db/models/agency.model.js';

/**
 * The pause reasons `carrier-account-pause.ts` writes, for the readers that must tell them
 * from a supervisor's or the abandonment guardrail's (the Insights headline and transitions).
 * Import-free beyond the type, so a reader does not pull in the pause's repository and audit
 * modules.
 */
const CARRIER_ACCOUNT_PAUSE_REASONS: ReadonlySet<string> = new Set<CarrierAccountPauseReason>([
  'carrier_auth', 'carrier_account_unavailable', 'carrier_refusing_calls',
]);

/** Whether a pause reason (a row's, or an audit row's `reason`) is a carrier-account pause. */
export function isCarrierAccountPauseReason(reason: unknown): reason is CarrierAccountPauseReason {
  return typeof reason === 'string' && CARRIER_ACCOUNT_PAUSE_REASONS.has(reason);
}
