// PORT NOTE (magick-agency): ported from magic-voice-core/src/api/middleware/headers.ts@4850d1d9.
// Lane C carried `TENANT_HEADER` only (the rate limiter's key generator); Phase 8 carries the rest
// verbatim, because core's handler modules read the tenant/account/originator headers through
// `auth.middleware.ts`'s getters and `api/core-dispatch.ts` sets them on the in-process call.
/**
 * Canonical request-header names, in one dependency-free place.
 *
 * Extracted from auth.middleware so header-sensitive code (e.g. the rate limiter's
 * key generator) can import a constant instead of hard-coding the literal — and
 * without pulling in the auth middleware's config-loading import chain.
 */

export const TENANT_HEADER = 'x-mgkvc-tenant';
export const ACCOUNT_HEADER = 'x-mgkvc-account';
/** Optional header identifying where a request/call was originated from. */
export const ORIGINATOR_HEADER = 'x-mgkvc-originator';
/** Optional headers carrying human-readable tenant/account names (magick-master owns them). */
export const TENANT_NAME_HEADER = 'x-mgkvc-tenant-name';
export const ACCOUNT_NAME_HEADER = 'x-mgkvc-account-name';
