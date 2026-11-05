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
 * this request (`CoreCallRequest.provenCampaignId`), with the tenant and account it was
 * proved under ({@link provenCampaignProof}). Set by `callCore` from its typed arguments
 * alone, never forwarded from a caller's headers.
 */
export const PROVEN_CAMPAIGN_HEADER = 'x-mgkvc-proven-campaign';
/**
 * Internal only, a RESPONSE header: what a campaign PATCH changed, set by the internal
 * PATCH handler (which holds the row before and after the write) for the public route to
 * audit (`agency_campaign.config_changed`, IN8). base64url JSON; absent when nothing
 * changed. The public route sends only the body on, so it never reaches a client.
 */
export const CONFIG_CHANGE_HEADER = 'x-mgkvc-config-change';

/**
 * The {@link PROVEN_CAMPAIGN_HEADER} value: `<tenant>:<account>:<campaign>`, the account
 * empty when the call has none. `callCore` builds it from the call's tenant, account and
 * `provenCampaignId`; the spine page reads build it from their own tenant context and the
 * campaign in their path, and honour the header only when the two are equal, so a proof
 * made under one tenant or account proves nothing under another.
 */
export function provenCampaignProof(
  tenantId: string,
  accountId: string | undefined,
  campaignId: string,
): string {
  return `${tenantId}:${accountId ?? ''}:${campaignId}`;
}
