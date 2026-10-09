/**
 * The agency wire types live in `@magick-agency/contracts`
 * (`api/agency/agency.ts`), the one contract the server and the console
 * compile against. This module re-exports it so every import path stays
 * unchanged. The console renders three fields beyond the baseline shapes
 * (`AgencyWrapupHold`'s `supervisor_hold`, `AgencyDispositionResponse
 * .callback_requested_at`, `AgencyStationIntervals.deferred_hangup_ms`).
 */
export * from '@magick-agency/contracts/api/agency/agency';
