import type { DigestFrequency } from '../../notifications/engine/period.js';
import type { MembershipRole } from '@magick-agency/db/models/membership.model';

/**
 * A stored preference — a SPARSE override of the catalog default.
 *
 * `event_key` and `channel` are plain strings rather than the catalog's unions:
 * this is what came out of the database, and a row naming a retired key is a
 * state the type has to be able to represent. Narrowing happens at the point of
 * use (`findNotificationEvent`), never at the row boundary, so a stale row is
 * inert instead of a parse failure that takes the whole read with it.
 */
export interface NotificationPreferenceRecord {
  id: string;
  user_id: string;
  tenant_id: string;
  event_key: string;
  channel: string;
  enabled: boolean;
  /** NULL on immediate-cadence events: "not applicable", not "unset". */
  frequency: DigestFrequency | null;
  created_at: Date;
  updated_at: Date;
}

/** One upsert. Absent `frequency` clears the column rather than leaving it. */
export interface UpsertNotificationPreferenceInput {
  user_id: string;
  tenant_id: string;
  event_key: string;
  channel: string;
  enabled: boolean;
  frequency?: DigestFrequency | null;
}

/**
 * A member who could be notified, with everything the engine needs about them
 * in one row.
 *
 * `account_id` is the membership's own scope and is what decides which slice of
 * the workspace their digest covers — NEVER an `X-Account-Id` header, which is
 * unauthenticated and does not exist on a scheduled run at all.
 */
export interface NotifiableMember {
  user_id: string;
  email: string;
  role: MembershipRole;
  /** NULL ⇒ a tenant-level membership, which reaches every account. */
  account_id: string | null;
}

export type NotificationDeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';

export interface NotificationDeliveryClaim {
  id: string;
  recipient: string;
}
