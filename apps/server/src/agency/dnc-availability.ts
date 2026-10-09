import { DncRegistry } from './dnc-registry.js';

/**
 * The campaign health strip's DNC input, after the collapse (decision B8).
 *
 * Core's `GET /agency-campaigns/:id/stats` read `runtime.dnc.appliedVersion(tenantId)`:
 * the version of the tenant's Redis DNC set, `null` when Redis could not answer or the
 * tenant had never synced. `campaignHealth` turns `null` into the `dnc_unavailable` stall,
 * because the pre-dial gate fails CLOSED on exactly those conditions (core
 * `campaign-health.ts`, diagnosis 2).
 *
 * There is no set and no version any more: the gate is one read of `dnc_entries`
 * (`DncRegistry.check`), and it halts only when that read throws. So the strip's question
 * — "would the gate halt right now?" — is answered by making the gate's own read for the
 * tenant: `null` exactly when `check` answers `unavailable`, and `1` (a constant standing
 * where a version stood; nothing reads it as a number) otherwise. Asking through the same
 * method the pacing engine calls is the point: the strip cannot report a halt the gate
 * would not make, or miss one it would.
 *
 * The probe number is a syntactically valid E.164 so `check` reaches the read rather than
 * answering `unverifiable`; whether it is on anybody's list is irrelevant.
 */
export const DNC_PROBE_PHONE = '+10000000000';

export function dncAvailabilityProbe(
  registry: Pick<DncRegistry, 'check'> = new DncRegistry(),
): { appliedVersion(tenantId: string): Promise<number | null> } {
  return {
    async appliedVersion(tenantId: string): Promise<number | null> {
      const result = await registry.check(tenantId, DNC_PROBE_PHONE, { accountId: null, campaignId: null });
      return result === 'unavailable' ? null : 1;
    },
  };
}
