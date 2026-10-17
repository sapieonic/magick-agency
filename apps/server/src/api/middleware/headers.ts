// The internal handler modules read the tenant/account/originator headers through
// `auth.middleware.ts`'s getters, and `api/core-dispatch.ts` sets them on the in-process call.
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
/** Optional headers carrying human-readable tenant/account names. */
export const TENANT_NAME_HEADER = 'x-mgkvc-tenant-name';
export const ACCOUNT_NAME_HEADER = 'x-mgkvc-account-name';
/**
 * Internal only: the campaign whose ownership the public-API caller already proved on
 * this request (`CoreCallRequest.provenCampaignId`). Set by `callCore` from its typed
 * argument alone, never forwarded from a caller's headers.
 */
export const PROVEN_CAMPAIGN_HEADER = 'x-mgkvc-proven-campaign';
