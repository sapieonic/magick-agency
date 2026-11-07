/**
 * Campaign statuses that can still dial, as an SQL list for `status IN ${LIVE_CAMPAIGN}`.
 * A completed or stopped campaign is terminal, so it no longer holds a credential or a
 * number live (it would otherwise block a revoke forever: campaigns are never deleted).
 * Shared by the repositories that ask which campaigns still hold a carrier account.
 */
export const LIVE_CAMPAIGN = `('draft', 'running', 'paused', 'stopping')`;
