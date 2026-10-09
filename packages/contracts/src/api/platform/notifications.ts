/**
 * Notification subscriptions — the public API layer's wire shapes.
 *
 * ── The catalog is SERVED, never mirrored here ────────────────────────────
 *
 * `GET /notifications/preferences` returns the event list AND the caller's
 * values together, so this file describes the shape and holds no copy of the
 * events themselves — no key union, no label table, no "which ones are
 * digests". That is deliberate and follows the audit log's `available_actions`:
 * the server owns the catalog, a copy here would be a second list, and the copy
 * is what drifts. A server build with a new event lights it up in the console
 * with no frontend change at all.
 *
 * So `key` and `category` are plain strings rather than unions. The page groups
 * by whatever categories arrive and renders whatever it is given.
 */

export type NotificationCadence = 'immediate' | 'digest';

export type NotificationFrequency = 'daily' | 'weekly';

export interface NotificationEventPreference {
  /** Stable dotted id, e.g. `usage.digest`. Opaque to this client. */
  key: string;
  label: string;
  description: string;
  /** Display grouping. Unknown values render under their own heading. */
  category: string;
  cadence: NotificationCadence;
  channel: string;
  /** The value that WILL apply — the stored one, or the catalog default. */
  enabled: boolean;
  /** Only meaningful when `cadence` is `digest`. */
  frequency: NotificationFrequency | null;
  default_enabled: boolean;
  default_frequency: NotificationFrequency | null;
  /**
   * True when `enabled`/`frequency` came from the catalog rather than a saved
   * row.
   *
   * The page needs it to be honest: somebody who has never opened this screen is
   * genuinely subscribed, and showing that as "unset" would invite them to turn
   * on something already on.
   */
  is_default: boolean;
}

export interface NotificationPreferencesResponse {
  events: NotificationEventPreference[];
}

/** One entry of a `PUT`. The body is a PATCH — omitted events keep their value. */
export interface NotificationPreferenceUpdate {
  event_key: string;
  channel?: string;
  enabled: boolean;
  frequency?: NotificationFrequency | null;
}

// There is no digest-preview shape (`POST /notifications/digests/preview`): a
// credits-spend digest has no meaning when v1 has no credits and no broadcasts.
//
// Agency-relevant events: the served catalog keeps this file's
// "no key union" rule, and only `agency.campaign.completed`
// (category `agency`, cadence `immediate`, audience: role floor
// `agency.supervise`) is an agency event. The agent invite email is sent on
// every invite and is not a preference. `campaign.dispatched`,
// `campaign.completed` (broadcasts) and `usage.digest` do not exist.
// `NotificationCadence` / `NotificationFrequency` stay because they are part of
// the served preference shape; with no digest event, `frequency` is always null.
