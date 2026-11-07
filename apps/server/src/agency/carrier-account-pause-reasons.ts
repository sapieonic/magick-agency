import { CARRIER_ACCOUNT_PAUSE_REASONS } from '@magick-agency/contracts/agency';
import type { CarrierAccountPauseReason } from '../db/models/agency.model.js';

/**
 * Whether a pause reason (a row's, or an audit row's `reason`) is one `carrier-account-pause.ts`
 * writes, read off the contract's single list (`CARRIER_ACCOUNT_PAUSE_REASONS`), for the
 * readers that must tell it from a supervisor's or the abandonment guardrail's (the Insights
 * headline and transitions). Import-free beyond the contract, so a reader does not pull in the
 * pause's repository and audit modules.
 */
export function isCarrierAccountPauseReason(reason: unknown): reason is CarrierAccountPauseReason {
  return typeof reason === 'string' && (CARRIER_ACCOUNT_PAUSE_REASONS as readonly string[]).includes(reason);
}
