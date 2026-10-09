import { ROLE_HIERARCHY } from '@magick-agency/contracts/rbac';
import { findNotificationEvent } from './catalog.js';
import { isDigestFrequency, type DigestFrequency } from './period.js';
import type { MembershipRole } from '@magick-agency/db/models/membership.model';
import type {
  NotifiableMember,
  NotificationPreferenceRecord,
} from '../../db/models/notification.model.js';
import type { NotificationEventDefinition } from './catalog.js';

/**
 * Who gets an event, and whether they still want it.
 *
 * These are deliberately small composable functions rather than one
 * `dispatchNotification(...)` that does audience, preferences, claiming,
 * rendering and sending behind a callback. Mailers resolve their audience at
 * different points and in different shapes, and forcing them through a single
 * `render(recipient)` seam would mean rewriting `agency-campaign-completion.ts`,
 * with its own discriminated result type, in order to gain nothing it does not
 * already have.
 *
 * "New events are cheap to add" comes from the catalog entry plus these
 * primitives, not from a god function.
 */

/** An address that survived preference filtering, with why it survived. */
export interface ResolvedRecipient {
  /** Lower-cased. The claim and the send both key on this form. */
  email: string;
  /**
   * The users behind the address. Usually one; more than one is legal, because
   * `users.email` carries only a NON-unique index (migration 069 says so).
   * Empty for an explicit-audience address that matches no platform user.
   */
  userIds: string[];
  /**
   * The account this recipient's content should be scoped to. NULL ⇒ the whole
   * tenant. The WIDEST scope among their memberships wins — see
   * {@link resolveRoleFloorAudience}.
   */
  accountId: string | null;
  /** For digest events: the cadence this recipient chose. */
  frequency: DigestFrequency | null;
}

/**
 * The effective preference for one user and one event: the stored override if
 * there is one, otherwise the catalog default.
 *
 * Exported because it is what the settings page renders — the page must show the
 * value that WILL apply, not "unset", or a user who has never touched it cannot
 * tell whether they are subscribed.
 */
export interface EffectivePreference {
  eventKey: string;
  channel: string;
  enabled: boolean;
  frequency: DigestFrequency | null;
  /** True when this came from the catalog rather than a stored row. */
  isDefault: boolean;
}

export function defaultPreferenceFor(event: NotificationEventDefinition): EffectivePreference {
  return {
    eventKey: event.key,
    channel: 'email',
    enabled: event.defaultEnabled,
    frequency: event.cadence === 'digest' ? (event.defaultFrequency ?? null) : null,
    isDefault: true,
  };
}

/**
 * Merge a user's stored rows over the catalog.
 *
 * A stored row whose `frequency` is missing or unrecognised on a digest event
 * falls back to the catalog default rather than to "no cadence". The distinction
 * matters: a NULL frequency on a digest event would match no scheduled period at
 * all, so the user would stay `enabled: true` on a settings page while silently
 * receiving nothing — the worst of the three possible outcomes, because it looks
 * like it is working.
 */
export function resolveEffectivePreferences(
  stored: readonly NotificationPreferenceRecord[],
  events: readonly NotificationEventDefinition[],
): EffectivePreference[] {
  const byKey = new Map<string, NotificationPreferenceRecord>();
  for (const row of stored) {
    byKey.set(`${row.event_key}:${row.channel}`, row);
  }

  return events.map((event) => {
    const row = byKey.get(`${event.key}:email`);
    if (!row) return defaultPreferenceFor(event);

    return {
      eventKey: event.key,
      channel: row.channel,
      enabled: row.enabled,
      frequency:
        event.cadence === 'digest'
          ? (isDigestFrequency(row.frequency) ? row.frequency : (event.defaultFrequency ?? null))
          : null,
      isDefault: false,
    };
  });
}

/**
 * Can a member holding `role` ever RECEIVE this event?
 *
 * Only `role_floor` events are role-gated. An `explicit`-audience event is
 * addressed to whatever addresses were typed into a campaign form, which may be
 * anybody's — including an `agent`'s, and including people who are not platform
 * users at all — so its suppression toggle is meaningful to every role and stays
 * visible to all of them.
 *
 * This exists so the settings page can refuse to offer a toggle that cannot do
 * anything: a toggle that changes nothing is worse than no toggle, because it is
 * a promise the product does not keep.
 */
export function isEventAddressableToRole(
  event: NotificationEventDefinition,
  role: MembershipRole,
): boolean {
  if (event.audience.kind !== 'role_floor') return true;
  return clearsFloor(role, event.audience.minimumRole);
}

/** Does this role clear the event's floor? */
function clearsFloor(role: MembershipRole, minimumRole: MembershipRole): boolean {
  const level = ROLE_HIERARCHY[role];
  return level !== undefined && level >= ROLE_HIERARCHY[minimumRole];
}

/**
 * There is no role-floor audience resolver here. The agency completion notice
 * derives its role-floor audience in `agency-campaign-completion.ts` from
 * `findAddressableMembersInAccount` and filters it through
 * `applyExplicitAudiencePreferences` below — through a DYNAMIC import inside
 * `suppressUnsubscribed`, so a search for a static import finds no caller.
 */

/**
 * Filter an EXPLICIT audience — addresses a human typed into a campaign form.
 *
 * The rule is the inverse of the role-floor one, and deliberately so: the
 * default is to SEND.
 *
 * An address here was nominated by the person who composed the campaign, and
 * most of them are not platform users at all — a client's operations inbox, a
 * shared alias, somebody's phone. There is no preference for such an address and
 * there is no user whose choice could speak for it, so it is always sent to.
 * Suppressing it would be this service overriding an explicit instruction on
 * behalf of nobody.
 *
 * An address that DOES resolve to platform users is suppressed only when EVERY
 * active user behind it has turned the event off. Any one of them still wanting
 * it means the mail goes: the address is an inbox, and the person who asked for
 * it is entitled to be told unless everyone who could read it has declined.
 *
 * `members` is the tenant's roster, already fetched by the caller — this does no
 * I/O of its own, so a mailer can call it without adding a round trip.
 */
export function applyExplicitAudiencePreferences(
  eventKey: string,
  addresses: readonly string[],
  members: readonly NotifiableMember[],
  stored: readonly NotificationPreferenceRecord[],
): ResolvedRecipient[] {
  const event = findNotificationEvent(eventKey);
  if (!event) return [];

  const usersByEmail = new Map<string, string[]>();
  for (const member of members) {
    const email = member.email.trim().toLowerCase();
    if (email === '') continue;
    const list = usersByEmail.get(email);
    if (list) {
      if (!list.includes(member.user_id)) list.push(member.user_id);
    } else {
      usersByEmail.set(email, [member.user_id]);
    }
  }

  const storedByUser = new Map(stored.map((row) => [row.user_id, row]));
  const seen = new Set<string>();
  const out: ResolvedRecipient[] = [];

  for (const raw of addresses) {
    const email = raw.trim().toLowerCase();
    if (email === '' || seen.has(email)) continue;
    seen.add(email);

    const userIds = usersByEmail.get(email) ?? [];

    // No platform user behind it ⇒ the author's instruction stands, unfiltered.
    if (userIds.length === 0) {
      out.push({ email, userIds: [], accountId: null, frequency: null });
      continue;
    }

    const anyWants = userIds.some((userId) => {
      const row = storedByUser.get(userId);
      return row ? row.enabled : event.defaultEnabled;
    });
    if (!anyWants) continue;

    out.push({ email, userIds, accountId: null, frequency: null });
  }

  return out;
}
