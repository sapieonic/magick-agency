/**
 * Metric declarations owned by the public API layer (auth, caches, invites,
 * notifications). Instruments are declared through the
 * `counter(meter, name, { description })` facade.
 */
import { meter } from '../meter.js';
import { counter } from '../metric-instruments.js';

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
  | 'cross_tenant_identity';

export const inviteClaimsTotal = counter<'result'>(meter, 'invite_claims_total', {
  description: 'Invitation claim attempts, by outcome',
});

export const notificationSendsTotal = counter<'event_key' | 'result'>(meter, 'notification_sends_total', {
  description: 'Notification send attempts, by event key and outcome',
});
