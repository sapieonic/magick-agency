import { PERMISSION_MATRIX } from '@magick-agency/contracts/rbac';
import type { MembershipRole } from '@magick-agency/db/models/membership.model';
import type { DigestFrequency } from './period.js';

/**
 * The notification event catalog — every kind of mail this platform sends on a
 * customer's behalf, in one frozen list.
 *
 * ── Why a catalog at all ───────────────────────────────────────────────────
 *
 * A mailer that knows its own audience, renders its own HTML and calls the
 * transport directly is a private answer to four shared questions (who gets
 * this, can they decline it, has it already been sent, what is it called on a
 * settings page) — and the fourth has no answer at all without an enumeration of
 * the mailers.
 *
 * This is the enumeration. Everything else in `engine/` is a primitive that
 * takes a definition from here; adding an event is a row plus a renderer, and
 * the settings page, the preference validation and the suppression check all
 * pick it up with no further edit.
 *
 * ── Frozen defaults in code, sparse overrides in the database ──────────────
 *
 * A user who has never opened the settings page has no rows at all, and their
 * behaviour is whatever `defaultEnabled` says here. Changing a default therefore changes it
 * for everybody who never expressed a preference, and for nobody who did —
 * which is the property that makes shipping a new event safe.
 *
 * ── NOT in this catalog, deliberately: the invite mailer ───────────────────
 *
 * `invite-mailer.ts` sends the token that is somebody's only route into the
 * product. There is no coherent "off" for it: suppressing it does not spare the
 * recipient a mail, it denies them the account. A credential delivery is not a
 * subscription, and putting it here would offer a toggle that must never be
 * honoured. Password-reset-shaped mail belongs in the same excluded class if it
 * is ever added.
 */

// One event today (see the note at the end of
// `packages/contracts/src/api/platform/notifications.ts`). A stored preference
// row naming any other key is inert by `isLiveEventKey`'s rule below — never
// served, never validated against, never deleted.
/** Stable dotted ids. Adding one is additive; renaming one orphans stored rows. */
export const NOTIFICATION_EVENT_KEYS = [
  'agency.campaign.completed',
] as const;

export type NotificationEventKey = (typeof NOTIFICATION_EVENT_KEYS)[number];

/**
 * The only channel today.
 *
 * A column in the database and a field on a preference, but NOT an array on the
 * definition: a per-event list of channels would be copies of `['email']` that no
 * code branches on. The seam that actually matters is the stored
 * `channel`, because that is what a second channel would need to be keyed by
 * without migrating anyone's existing preference. The definition grows a
 * `channels` field on the day there is a second value to put in it.
 */
export const NOTIFICATION_CHANNELS = ['email'] as const;

export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/**
 * How the recipients of an event are found.
 *
 * `explicit` — the addresses travel on the thing that triggered the event, typed
 * by a human into a campaign form. They may not be platform users at all.
 *
 * `role_floor` — derived from `memberships`. The floor is a MembershipRole, and
 * where an existing permission already answers "who is responsible for this
 * kind of thing", the entry reads the floor out of `PERMISSION_MATRIX` rather
 * than restating it, so the audience moves if the matrix does.
 */
export type NotificationAudience =
  | { kind: 'explicit' }
  | { kind: 'role_floor'; minimumRole: MembershipRole };

export type NotificationCadence = 'immediate' | 'digest';

export interface NotificationEventDefinition {
  key: NotificationEventKey;
  /** Settings-page heading. Customer vocabulary, not the enum's. */
  label: string;
  /** One sentence, rendered under the label. Says what arrives and when. */
  description: string;
  /** Display grouping on the settings page. */
  category: 'campaigns' | 'agency' | 'digests';
  cadence: NotificationCadence;
  audience: NotificationAudience;
  /** Effective value when the user has no stored override. */
  defaultEnabled: boolean;
  /**
   * Digest-cadence events only, and required for them (pinned by test).
   *
   * There is no per-event list of ALLOWED frequencies: every digest event offers
   * the same global `DIGEST_FREQUENCIES`, and a second list here would be a
   * copy whose only job is to stay equal to the first one.
   */
  defaultFrequency?: DigestFrequency;
}

/**
 * FROZEN catalog — array order is display order on the settings page.
 */
export const NOTIFICATION_EVENTS: readonly NotificationEventDefinition[] = [
  {
    key: 'agency.campaign.completed',
    label: 'Agency campaign finished',
    description: 'Sent to supervisors when a dialer campaign completes or is stopped.',
    category: 'agency',
    cadence: 'immediate',
    // Derived, never restated: `agency.supervise` is already this platform's
    // answer to "who runs agency campaigns". `agency-campaign-completion.ts`
    // computes the same floor the same way; this entry is the second reader of
    // one decision rather than a second decision.
    audience: { kind: 'role_floor', minimumRole: PERMISSION_MATRIX['agency.supervise'] },
    defaultEnabled: true,
  },
  // No digest event exists today. The `digest` cadence, `defaultFrequency` and
  // the `campaigns` / `digests` categories stay in the types above because the
  // preference shape, the validator and `audience.ts` still branch on them.
];

/**
 * Look a definition up by key.
 *
 * A `Map` rather than an object index, and that is not a micro-optimisation.
 * This function is reached with strings that came off the wire (`PUT
 * /notifications/preferences`) and out of the database (a stored row for a
 * retired key). A plain object literal inherits from `Object.prototype`, so
 * `EVENTS['constructor']` resolves to a truthy value and every "unknown key"
 * guard downstream of a bare index silently passes. A `Map` has no prototype
 * chain to walk into.
 */
const EVENTS_BY_KEY = new Map<string, NotificationEventDefinition>(
  NOTIFICATION_EVENTS.map((event) => [event.key, event]),
);

export function findNotificationEvent(key: string): NotificationEventDefinition | undefined {
  return EVENTS_BY_KEY.get(key);
}

export function isNotificationEventKey(key: string): key is NotificationEventKey {
  return EVENTS_BY_KEY.has(key);
}

export function isNotificationChannel(value: string): value is NotificationChannel {
  return (NOTIFICATION_CHANNELS as readonly string[]).includes(value);
}

/**
 * A stored preference row can name a key this build no longer has (an event was
 * renamed or retired while the row survived). Such a row is INERT — it is never
 * served, never validated against, and never deleted by this code.
 *
 * Deleting it would be the tidier-looking option and is the wrong one: a key
 * removed by mistake and restored in the next release would have taken every
 * customer's preference with it in the meantime, silently reverting them all to
 * the default. Leaving the row costs one dead tuple per user per retired event.
 */
export function isLiveEventKey(key: string): boolean {
  return EVENTS_BY_KEY.has(key);
}
