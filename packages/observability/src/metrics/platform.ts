/**
 * Metric declarations owned by the public API layer (auth, caches, invites,
 * notifications, the push senders). Instruments are declared through the
 * `counter(meter, name, { description })` facade.
 */
import { meter } from '../meter.js';
import { counter, histogram } from '../metric-instruments.js';

export const authAttemptsTotal = counter<'method' | 'status'>(meter, 'auth_attempts_total', {
  description: 'Total authentication attempts',
});

export const localCacheOperationsTotal = counter<'family' | 'result'>(meter, 'local_cache_operations_total', {
  description: 'In-process cache lookups by key family and outcome',
});

// Local entries dropped by a cross-instance invalidation broadcast.
export const localCacheInvalidationsTotal = counter<'source'>(meter, 'local_cache_invalidations_total', {
  description: 'In-process cache invalidation messages processed, by source',
});

// `tenant_id` is bounded by the tenant count (a deliberate exception to the no-tenant-label rule).
export const agencyCampaignNotificationsTotal = counter<'tenant_id' | 'result'>(
  meter,
  'agency_campaign_notifications_total',
  { description: 'Agency campaign-completion notifications, by outcome' },
);

// `result` mirrors `InviteEmailResult`; no `tenant_id`.
export const inviteEmailsTotal = counter<'role' | 'result'>(meter, 'invite_emails_total', {
  description: 'Invite emails attempted, by role and outcome',
});

/** The closed set `POST /invites/:token/claim` can answer. */
export type InviteClaimResult =
  | 'claimed'
  | 'bad_request'
  | 'not_found'
  | 'expired'
  | 'already_claimed'
  | 'revoked'
  | 'unauthorized'
  | 'identity_in_use'
  | 'identity_already_bound'
  | 'cross_tenant_identity'
  // An `account_admin`-or-above invitation presented by a sign-in whose email is
  // not the invited address (decision B25). Refused before anything binds.
  | 'address_required';

export const inviteClaimsTotal = counter<'result'>(meter, 'invite_claims_total', {
  description: 'Invitation claim attempts, by outcome',
});

export const notificationSendsTotal = counter<'event_key' | 'result'>(meter, 'notification_sends_total', {
  description: 'Notification send attempts, by event key and outcome',
});

// ─── Push senders (Mode B: apps/server/src/notifications/push/, docs/seams.md §3.6) ──────────

/** The push platforms (the contract's `AgencyPushPlatform`). */
export type PushMetricPlatform = 'android' | 'ios';

/**
 * How one send through the push seam ended: `ok` (the carrier accepted it), `skipped` (not sent by
 * design: iOS gets no VoIP push that is not a call), or the seam's failure reason (the contract's
 * `AgencyPushFailureReason`). `rate_limited` includes a send held back unsent while the carrier's
 * `Retry-After` for the device runs.
 */
export type PushSendMetricResult =
  | 'ok' | 'skipped' | 'unregistered' | 'invalid' | 'rate_limited' | 'unavailable' | 'unconfigured';

export const agencyPushSendsTotal = counter<'platform' | 'result'>(meter, 'agency_push_sends_total', {
  description: 'Ring pushes to agents\' phones, by platform (android, ios) and result: ok, skipped (not sent: iOS gets ring and test_ring only), unregistered, invalid, rate_limited, unavailable or unconfigured',
});

export const agencyPushSendSeconds = histogram<'platform'>(meter, 'agency_push_send_seconds', {
  description: 'Seconds a push send that reached for its carrier took, the OAuth or provider token included, by platform',
  unit: 's',
  buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5],
});

/**
 * One send through the push seam. `seconds` only when the sender reached for the carrier (not for
 * a skipped, unconfigured or held-back send).
 */
export function trackPushSend(platform: PushMetricPlatform, result: PushSendMetricResult, seconds?: number): void {
  agencyPushSendsTotal.inc({ platform, result });
  if (seconds !== undefined) agencyPushSendSeconds.observe({ platform }, Math.max(0, seconds));
}
