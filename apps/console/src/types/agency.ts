/**
 * PORT NOTE (magick-agency): cusui's `src/types/agency.ts` @ ee5beb44 (the mirror of
 * core's agency contracts) now lives in `@magick-agency/contracts`
 * (`api/agency/agency.ts`), the one wire contract the server and the console
 * compile against. This module re-exports it so every ported import path stays
 * unchanged. Phase 8 added the three CONTRACT-DIFF §1 fields the console renders
 * (`AgencyWrapupHold`'s `supervisor_hold`, `AgencyDispositionResponse
 * .callback_requested_at`, `AgencyStationIntervals.deferred_hangup_ms`); other
 * differences from cusui's copy are listed in
 * `packages/contracts/src/api/agency/CONTRACT-DIFF.md`.
 */
export * from '@magick-agency/contracts/api/agency/agency';
