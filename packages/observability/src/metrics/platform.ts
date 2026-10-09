/**
 * Metric declarations owned by the platform lane (lane A).
 *
 * Ported from magick-master/src/utils/metrics.ts@a1f0756a: same names, kinds,
 * descriptions (master's `help`) and label keys. Master declares through a
 * prom-client-shaped `new Counter({ name, help, labelNames })` wrapper over one
 * OTel instrument; here the same instrument is declared through core's
 * `counter(meter, name, { description })` facade — the series Grafana receives
 * is the same. The rationale for each label set is master's docstring at the
 * cited line.
 */
import { meter } from '../meter.js';
import { counter } from '../metric-instruments.js';

// master `metrics.ts:127-131`.
export const authAttemptsTotal = counter<'method' | 'status'>(meter, 'auth_attempts_total', {
  description: 'Total authentication attempts',
});

// master `metrics.ts:97-101`.
export const localCacheOperationsTotal = counter<'family' | 'result'>(meter, 'local_cache_operations_total', {
  description: 'In-process cache lookups by key family and outcome',
});

// master `metrics.ts:103-108`. Local entries dropped by a cross-instance invalidation broadcast.
export const localCacheInvalidationsTotal = counter<'source'>(meter, 'local_cache_invalidations_total', {
  description: 'In-process cache invalidation messages processed, by source',
});

// master `metrics.ts:215-219`. `tenant_id` is bounded by the tenant count (master's exception).
export const agencyCampaignNotificationsTotal = counter<'tenant_id' | 'result'>(
  meter,
  'agency_campaign_notifications_total',
  { description: 'Agency campaign-completion notifications, by outcome' },
);

// master `metrics.ts:269-273`. `result` mirrors `InviteEmailResult`; no `tenant_id`.
export const inviteEmailsTotal = counter<'role' | 'result'>(meter, 'invite_emails_total', {
  description: 'Invite emails attempted, by role and outcome',
});

/** master `metrics.ts:334-344` — the closed set `POST /invites/:token/claim` can answer. */
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

// master `metrics.ts:348-352`.
export const inviteClaimsTotal = counter<'result'>(meter, 'invite_claims_total', {
  description: 'Invitation claim attempts, by outcome',
});

// master `metrics.ts:1090-1094`. The closed `result` set is documented at master's declaration.
export const notificationSendsTotal = counter<'event_key' | 'result'>(meter, 'notification_sends_total', {
  description: 'Notification send attempts, by event key and outcome',
});
