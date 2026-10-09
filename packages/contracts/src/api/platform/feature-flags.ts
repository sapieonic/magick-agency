/**
 * Tenant-facing feature-flag map returned by core's `GET /api/v1/feature-flags`
 * (proxied via master's `/proxy/feature-flags`). Only `clientExposed` flags
 * appear here, resolved for the caller's tenant/account. Values are typed per
 * flag — boolean is the common case (capability gates).
 */
export type FeatureFlagMap = Record<string, boolean | number | string>;

/** Resolution lifecycle for the context — drives the anti-flicker render rule. */
export type FeatureFlagStatus = 'loading' | 'ready' | 'error';

// PORT NOTE (magick-agency): ported verbatim from
// `magick-comms-cusui/src/types/feature-flags.ts`. In Magick Agency the map is
// served by agency itself (permission `agency.flags.read`, floor `agent`) rather
// than proxied from core, and its client-exposed keys are exactly
// `agency_dialer_enabled` and `agency_call_analysis` — see `AgencyClientFlagMap`
// in `../../flags`, the narrowed form. `FeatureFlagMap` stays the open record
// because the console's `FeatureFlagsContext` reads it that way.
