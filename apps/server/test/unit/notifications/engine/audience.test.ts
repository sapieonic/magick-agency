import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Audience and preference resolution — the rules that decide who is mailed.
 *
 * Every case here is a way somebody gets mail they turned off, or fails to get
 * mail they asked for, and neither failure is visible from the outside. The two
 * collapse rules in particular (one user with several memberships; several users
 * with one address) exist because `memberships` permits both shapes and
 * `users.email` carries only a NON-unique index — migration 069 says so in as
 * many words.
 */

const mocks = vi.hoisted(() => ({
  findNotifiableMembers: vi.fn(),
  findForUsersAndEvent: vi.fn(),
  findNotificationEvent: vi.fn(),
}));

// `audience.ts` does not import this repository; the mock is inert.
vi.mock('../../../../src/db/repositories/notification-preference.repository.js', () => ({
  notificationPreferenceRepository: {
    findNotifiableMembers: mocks.findNotifiableMembers,
    findForUsersAndEvent: mocks.findForUsersAndEvent,
  },
}));

/**
 * The catalog is REAL here, with `findNotificationEvent` wrapped in a spy that
 * delegates to it.
 *
 * Two reasons for the wrapper rather than a hand-written stand-in catalog.
 * Nearly every case below is about the real defaults — `usage.digest` floored
 * at `account_admin`, on, weekly — and a fake catalog would stop pinning them.
 * But a handful of branches in `audience.ts` exist for a catalog entry that is
 * MALFORMED (a digest event with no `defaultFrequency`), and the real catalog
 * cannot produce one: `catalog.test.ts` asserts that it never does. Those
 * branches are the safety net for the day somebody adds a digest event and
 * forgets the cadence, so they are driven by overriding this one lookup for one
 * call — `mockReturnValueOnce` — and never by editing the catalog.
 *
 * `vi.clearAllMocks()` clears calls, not implementations, so the delegation set
 * up here survives every `beforeEach`.
 */
vi.mock('../../../../src/notifications/engine/catalog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../src/notifications/engine/catalog.js')>();
  mocks.findNotificationEvent.mockImplementation(actual.findNotificationEvent);
  return { ...actual, findNotificationEvent: mocks.findNotificationEvent };
});

import {
  applyExplicitAudiencePreferences,
  defaultPreferenceFor,
  isEventAddressableToRole,
  resolveEffectivePreferences,
} from '../../../../src/notifications/engine/audience.js';
import {
  NOTIFICATION_EVENTS,
  findNotificationEvent,
} from '../../../../src/notifications/engine/catalog.js';
import type { NotificationEventDefinition } from '../../../../src/notifications/engine/catalog.js';
import type { MembershipRole } from '@magick-agency/db/models/membership.model';
import type { NotifiableMember, NotificationPreferenceRecord } from '../../../../src/db/models/notification.model.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_A = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_B = '33333333-3333-4333-8333-333333333333';

function member(over: Partial<NotifiableMember> & { user_id: string; email: string }): NotifiableMember {
  return { role: 'account_admin', account_id: null, ...over };
}

function pref(over: Partial<NotificationPreferenceRecord> & { user_id: string }): NotificationPreferenceRecord {
  return {
    id: 'p', tenant_id: TENANT, event_key: 'usage.digest', channel: 'email',
    enabled: true, frequency: 'weekly', created_at: new Date(), updated_at: new Date(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.findNotifiableMembers.mockResolvedValue([]);
  mocks.findForUsersAndEvent.mockResolvedValue([]);
});

/**
 * The catalog holds only `agency.campaign.completed`. These cases pin
 * `resolveEffectivePreferences`, `defaultPreferenceFor` and
 * `isEventAddressableToRole` against further entries — an
 * explicit-audience immediate event and a role-floor DIGEST — so those branches
 * of `audience.ts` stay covered. All three functions take the definition as
 * an argument, so those entries are restated here as fixtures, and
 * `MASTER_EVENTS` lists them in order in place of the catalog's own list. Cases
 * that look an event up BY KEY (`applyExplicitAudiencePreferences`) use
 * `agency.campaign.completed`, the key the one caller passes.
 */
const CAMPAIGN_DISPATCHED: NotificationEventDefinition = {
  key: 'campaign.dispatched' as NotificationEventDefinition['key'],
  label: 'Campaign started',
  description:
    'Sent once when every batch of a campaign has been handed off and calls are going out.',
  category: 'campaigns',
  cadence: 'immediate',
  audience: { kind: 'explicit' },
  defaultEnabled: true,
};
const CAMPAIGN_COMPLETED: NotificationEventDefinition = {
  key: 'campaign.completed' as NotificationEventDefinition['key'],
  label: 'Campaign finished',
  description: 'Sent when every call or message in a campaign has finished, with the results.',
  category: 'campaigns',
  cadence: 'immediate',
  audience: { kind: 'explicit' },
  defaultEnabled: true,
};
const USAGE_DIGEST: NotificationEventDefinition = {
  key: 'usage.digest' as NotificationEventDefinition['key'],
  label: 'Usage digest',
  description:
    'A summary of calls, messages, campaigns and credits for your workspace, with the change on the period before.',
  category: 'digests',
  cadence: 'digest',
  audience: { kind: 'role_floor', minimumRole: 'account_admin' },
  defaultEnabled: true,
  defaultFrequency: 'weekly',
};
const MASTER_EVENTS: readonly NotificationEventDefinition[] = [
  CAMPAIGN_DISPATCHED,
  CAMPAIGN_COMPLETED,
  ...NOTIFICATION_EVENTS,
  USAGE_DIGEST,
];
const MASTER_FIXTURES: Record<string, NotificationEventDefinition> = {
  'campaign.dispatched': CAMPAIGN_DISPATCHED,
  'campaign.completed': CAMPAIGN_COMPLETED,
  'usage.digest': USAGE_DIGEST,
};

describe('resolveEffectivePreferences', () => {
  it('falls back to the catalog when nothing is stored', () => {
    // A user who has never opened the settings page is genuinely subscribed to
    // whatever the catalog says. Reporting that as "unset" would invite them to
    // "turn on" something already on.
    const effective = resolveEffectivePreferences([], MASTER_EVENTS);
    const digest = effective.find((p) => p.eventKey === 'usage.digest');
    expect(digest).toEqual({
      eventKey: 'usage.digest', channel: 'email',
      enabled: true, frequency: 'weekly', isDefault: true,
    });
  });

  it('a stored row overrides the default and is marked as not-default', () => {
    const effective = resolveEffectivePreferences(
      [pref({ user_id: 'u1', enabled: false, frequency: 'daily' })],
      MASTER_EVENTS,
    );
    const digest = effective.find((p) => p.eventKey === 'usage.digest');
    expect(digest?.enabled).toBe(false);
    expect(digest?.isDefault).toBe(false);
  });

  it('repairs a digest row whose frequency is missing', () => {
    // THE failure this guards: a NULL cadence on a digest event matches no
    // scheduled run, so the user stays `enabled` on the settings page and
    // silently receives nothing — it looks like it is working. Falling back to
    // the catalog default keeps them subscribed to something that actually fires.
    const effective = resolveEffectivePreferences(
      [pref({ user_id: 'u1', frequency: null })],
      MASTER_EVENTS,
    );
    expect(effective.find((p) => p.eventKey === 'usage.digest')?.frequency).toBe('weekly');
  });

  it('repairs a digest row whose frequency is not a cadence we run', () => {
    const effective = resolveEffectivePreferences(
      [pref({ user_id: 'u1', frequency: 'monthly' as never })],
      MASTER_EVENTS,
    );
    expect(effective.find((p) => p.eventKey === 'usage.digest')?.frequency).toBe('weekly');
  });

  it('never reports a frequency on an immediate event', () => {
    const effective = resolveEffectivePreferences(
      [pref({ user_id: 'u1', event_key: 'campaign.completed', frequency: 'daily' })],
      MASTER_EVENTS,
    );
    expect(effective.find((p) => p.eventKey === 'campaign.completed')?.frequency).toBeNull();
  });

  it('ignores a row for a retired event key', () => {
    // A stored row naming a key this build no longer has must be INERT — never
    // served, never a parse failure that takes the whole read with it.
    const effective = resolveEffectivePreferences(
      [pref({ user_id: 'u1', event_key: 'usage.digest.monthly', enabled: false })],
      MASTER_EVENTS,
    );
    expect(effective.map((p) => p.eventKey)).not.toContain('usage.digest.monthly');
    expect(effective.find((p) => p.eventKey === 'usage.digest')?.enabled).toBe(true);
  });
});

describe('defaultPreferenceFor', () => {
  it('mirrors the catalog entry', () => {
    const event = MASTER_FIXTURES['campaign.dispatched']!;
    expect(defaultPreferenceFor(event)).toEqual({
      eventKey: 'campaign.dispatched', channel: 'email',
      enabled: true, frequency: null, isDefault: true,
    });
  });
});

describe('applyExplicitAudiencePreferences', () => {
  // `agency.campaign.completed` is the key the one caller passes.
  const EVENT = 'agency.campaign.completed';

  it('always sends to an address that names no platform user', () => {
    // The default for an explicit audience is to SEND. These addresses were
    // nominated by whoever composed the campaign and most are not platform users
    // at all — a client's ops inbox, a shared alias. There is no user whose
    // preference could speak for them, and suppressing would be this service
    // overriding an explicit instruction on behalf of nobody.
    const out = applyExplicitAudiencePreferences(EVENT, ['client@elsewhere.com'], [], []);
    expect(out.map((r) => r.email)).toEqual(['client@elsewhere.com']);
    expect(out[0]?.userIds).toEqual([]);
  });

  it('suppresses an address whose only user turned the event off', () => {
    const out = applyExplicitAudiencePreferences(
      EVENT,
      ['a@x.com'],
      [member({ user_id: 'u1', email: 'a@x.com' })],
      [pref({ user_id: 'u1', event_key: EVENT, enabled: false })],
    );
    expect(out).toEqual([]);
  });

  it('sends when one of several users behind an address still wants it', () => {
    const out = applyExplicitAudiencePreferences(
      EVENT,
      ['ops@x.com'],
      [member({ user_id: 'u1', email: 'ops@x.com' }), member({ user_id: 'u2', email: 'ops@x.com' })],
      [pref({ user_id: 'u1', event_key: EVENT, enabled: false })],
    );
    expect(out.map((r) => r.email)).toEqual(['ops@x.com']);
  });

  it('matches case-insensitively and de-duplicates', () => {
    const out = applyExplicitAudiencePreferences(
      EVENT,
      ['Ops@X.com', 'ops@x.com', '  ops@x.com  '],
      [member({ user_id: 'u1', email: 'ops@x.com' })],
      [],
    );
    expect(out.map((r) => r.email)).toEqual(['ops@x.com']);
  });

  it('drops empty and whitespace-only entries', () => {
    expect(applyExplicitAudiencePreferences(EVENT, ['', '   '], [], [])).toEqual([]);
  });

  it('returns nothing for an unknown event', () => {
    expect(applyExplicitAudiencePreferences('nope', ['a@x.com'], [], [])).toEqual([]);
  });
});

/**
 * A digest event whose catalog entry has NO `defaultFrequency`.
 *
 * `catalog.test.ts` asserts the real catalog never contains one, so this is the
 * safety net for the day somebody adds a second digest event and forgets the
 * cadence. What the net must do is fall back to `null` — an absent cadence —
 * rather than invent `weekly`: a recipient with a null cadence is dropped by
 * every cadence-narrowed run, which is a digest that does not arrive. Inventing
 * a cadence instead would mail everybody on a schedule nobody chose, and would
 * hide the catalog bug for good.
 */
const MALFORMED_DIGEST: NotificationEventDefinition = {
  key: 'usage.digest' as NotificationEventDefinition['key'], // not a catalog key; cast like the fixtures above
  label: 'Usage digest',
  description: 'A digest whose catalog entry lost its cadence.',
  category: 'digests',
  cadence: 'digest',
  audience: { kind: 'role_floor', minimumRole: 'account_admin' },
  defaultEnabled: true,
  // defaultFrequency deliberately absent.
};

describe('a digest event with no default cadence', () => {
  it('gives `defaultPreferenceFor` a NULL frequency rather than a made-up one', () => {
    expect(defaultPreferenceFor(MALFORMED_DIGEST)).toEqual({
      eventKey: 'usage.digest', channel: 'email',
      enabled: true, frequency: null, isDefault: true,
    });
  });

  it('leaves a stored row with an unusable cadence at NULL', () => {
    // The repair path has nothing to repair TO. It must not fall through to the
    // stored garbage either — `'monthly'` reaching the runner would be filtered
    // against `'daily'`/`'weekly'` and match neither, but it would also be
    // written back to the settings page as a cadence the product does not offer.
    const effective = resolveEffectivePreferences(
      [pref({ user_id: 'u1', frequency: 'monthly' as never })],
      [MALFORMED_DIGEST],
    );
    expect(effective[0]?.frequency).toBeNull();
    expect(effective[0]?.isDefault).toBe(false);
  });
});

describe('resolveEffectivePreferences leaves a retired row alone', () => {
  it('does not mutate or remove the stored rows it was given', () => {
    // "Inert" has two halves and only one is about what is served. The other is
    // that nothing here DELETES the row: a key removed by mistake and restored
    // next release would otherwise have taken every customer's preference with
    // it and silently reverted them all to the default. This function is pure,
    // and that is what makes the repository's "never delete" rule safe.
    const stored = [
      pref({ user_id: 'u1', event_key: 'usage.digest.monthly', enabled: false }),
      pref({ user_id: 'u1', enabled: false }),
    ];
    const snapshot = JSON.stringify(stored);

    resolveEffectivePreferences(stored, MASTER_EVENTS);

    expect(stored).toHaveLength(2);
    expect(JSON.stringify(stored)).toBe(snapshot);
  });

  it('returns one entry per catalog event, in catalog order, whatever is stored', () => {
    // The settings page renders this array directly, so its length and order
    // are the page's own. A stored row for a retired key must not add a row and
    // a missing row must not remove one.
    const effective = resolveEffectivePreferences(
      [pref({ user_id: 'u1', event_key: 'usage.digest.monthly' })],
      MASTER_EVENTS,
    );
    expect(effective.map((p) => p.eventKey)).toEqual([
      'campaign.dispatched', 'campaign.completed', 'agency.campaign.completed', 'usage.digest',
    ]);
  });

  it('matches a stored row on (event_key, channel), not on event_key alone', () => {
    // The stored `channel` is the seam a second channel would arrive on. A row
    // for a channel that is not `email` must not override the email preference,
    // or adding SMS later would silently rewrite everybody's mail settings.
    const effective = resolveEffectivePreferences(
      [pref({ user_id: 'u1', channel: 'sms', enabled: false })],
      MASTER_EVENTS,
    );
    const digest = effective.find((p) => p.eventKey === 'usage.digest');
    expect(digest?.enabled).toBe(true);
    expect(digest?.isDefault).toBe(true);
  });
});

/**
 * `isEventAddressableToRole` — what the settings page is allowed to offer.
 *
 * `GET /notifications/preferences` filters on this, and it did not: the handler
 * mapped the whole catalog, so a `viewer` or an `operator` — both below
 * `usage.digest`'s `account_admin` floor — was shown a live "Usage digest · On"
 * toggle with a frequency picker, for mail that could never reach them. A
 * toggle that changes nothing is worse than no toggle: it is a promise the
 * product does not keep.
 */
describe('isEventAddressableToRole', () => {
  const ROLES: MembershipRole[] = [
    'agent', 'viewer', 'operator', 'account_admin', 'tenant_admin', 'tenant_owner',
  ];

  it('gates a role_floor event on the floor, exactly', () => {
    // `usage.digest` floors at `account_admin` (level 30). The interesting pair
    // is `operator` (20) and `account_admin` (30) — one below the floor and one
    // exactly ON it. An off-by-one in `clearsFloor` (`>` instead of `>=`) shows
    // up here and nowhere else, and it would silently unsubscribe every
    // account_admin on the platform.
    const event = MASTER_FIXTURES['usage.digest']!;
    expect(isEventAddressableToRole(event, 'operator')).toBe(false);
    expect(isEventAddressableToRole(event, 'account_admin')).toBe(true);
    expect(isEventAddressableToRole(event, 'tenant_admin')).toBe(true);
    expect(isEventAddressableToRole(event, 'tenant_owner')).toBe(true);
    expect(isEventAddressableToRole(event, 'viewer')).toBe(false);
    expect(isEventAddressableToRole(event, 'agent')).toBe(false);
  });

  it('gates the agency notice at the same floor', () => {
    const event = findNotificationEvent('agency.campaign.completed')!;
    expect(isEventAddressableToRole(event, 'agent')).toBe(false);
    expect(isEventAddressableToRole(event, 'viewer')).toBe(false);
    expect(isEventAddressableToRole(event, 'operator')).toBe(false);
    expect(isEventAddressableToRole(event, 'account_admin')).toBe(true);
  });

  it('shows an EXPLICIT-audience event to every role, including `agent`', () => {
    // The inverse rule. A `campaign.*` address is typed into a campaign form and
    // may be anybody's — including an agent's, and including people who are not
    // platform users at all. Its suppression toggle is meaningful to every role,
    // so filtering it by role would hide somebody's own unsubscribe from them.
    for (const key of ['campaign.dispatched', 'campaign.completed'] as const) {
      const event = MASTER_FIXTURES[key]!;
      for (const role of ROLES) {
        expect(isEventAddressableToRole(event, role), `${key} / ${role}`).toBe(true);
      }
    }
  });

  it('refuses a role that is not in the hierarchy at all', () => {
    // `clearsFloor` compares `ROLE_HIERARCHY[role]` against the floor, and an
    // unknown role gives `undefined`. The guard makes that FALSE rather than
    // letting `undefined >= 30` decide — which is also false, but only by
    // accident of coercion, and `undefined >= 0` would not be.
    const event = MASTER_FIXTURES['usage.digest']!;
    expect(isEventAddressableToRole(event, 'superuser' as MembershipRole)).toBe(false);
  });
});

describe('applyExplicitAudiencePreferences, further edges', () => {
  // `agency.campaign.completed` is the key the one caller passes.
  const EVENT = 'agency.campaign.completed';

  it('drops a member row with an empty email rather than indexing the empty key', () => {
    // A member with no address would occupy the `''` key in the lookup, and any
    // explicit address that trimmed to `''` would then resolve to that user's
    // preference — one person's unsubscribe suppressing a blank address.
    const out = applyExplicitAudiencePreferences(
      EVENT,
      ['client@elsewhere.com'],
      [member({ user_id: 'u-blank', email: '' }), member({ user_id: 'u-space', email: '  ' })],
      [pref({ user_id: 'u-blank', event_key: EVENT, enabled: false })],
    );
    expect(out.map((r) => r.email)).toEqual(['client@elsewhere.com']);
  });

  it('lists a user once when they hold two memberships under one address', () => {
    // Same shape as the role-floor collapse: a tenant-level row plus an
    // account-scoped one is legal, and the address must carry the user id once.
    const out = applyExplicitAudiencePreferences(
      EVENT,
      ['a@x.com'],
      [
        member({ user_id: 'u1', email: 'a@x.com', account_id: ACCOUNT_A }),
        member({ user_id: 'u1', email: 'a@x.com', account_id: null }),
      ],
      [],
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.userIds).toEqual(['u1']);
  });

  it('matches a member whose stored address is cased differently from the typed one', () => {
    // The address was typed into a campaign form by hand. If it did not match
    // the member row case-insensitively, that member's unsubscribe would be
    // ignored for every campaign whose author typed their address differently.
    const out = applyExplicitAudiencePreferences(
      EVENT,
      ['Ops@X.COM'],
      [member({ user_id: 'u1', email: 'ops@x.com' })],
      [pref({ user_id: 'u1', event_key: EVENT, enabled: false })],
    );
    expect(out).toEqual([]);
  });

  it('returns the lower-cased form of a typed address, not the typed spelling', () => {
    // Same reasoning as the role-floor collapse: the returned string is what the
    // gate claims on and hands to the transport, so the two spellings of one
    // inbox must collapse to one dedupe key.
    const out = applyExplicitAudiencePreferences(EVENT, ['Client@Elsewhere.COM'], [], []);
    expect(out.map((r) => r.email)).toEqual(['client@elsewhere.com']);
  });

  it('never scopes an explicit recipient to an account', () => {
    // These addresses are not memberships, so there is no account scope to
    // derive. A non-null `accountId` here would key the delivery claim to an
    // account the address has nothing to do with.
    const out = applyExplicitAudiencePreferences(
      EVENT,
      ['a@x.com', 'stranger@elsewhere.com'],
      [member({ user_id: 'u1', email: 'a@x.com', account_id: ACCOUNT_A })],
      [],
    );
    expect(out.map((r) => r.accountId)).toEqual([null, null]);
    expect(out.every((r) => r.frequency === null)).toBe(true);
  });

  it('preserves the order the addresses were typed in', () => {
    // The campaign form's own order. Nothing downstream depends on it, but a
    // reordering here would make the gate's `recipients` list — and therefore
    // several test fixtures and log lines — non-deterministic.
    const out = applyExplicitAudiencePreferences(
      EVENT,
      ['z@x.com', 'a@x.com', 'm@x.com'],
      [],
      [],
    );
    expect(out.map((r) => r.email)).toEqual(['z@x.com', 'a@x.com', 'm@x.com']);
  });

  it('sends to an unresolved address even when the event defaults to OFF', async () => {
    // THE inverse rule, in its strongest form. The role-floor default decides
    // for people the platform knows about; an explicit address was named by a
    // human and there is no user whose choice could speak for it, so it is sent
    // to regardless of the catalog default. A `defaultEnabled: false` event
    // still mails the client's ops inbox.
    const offByDefault: NotificationEventDefinition = {
      ...findNotificationEvent(EVENT)!,
      defaultEnabled: false,
    };
    mocks.findNotificationEvent.mockReturnValueOnce(offByDefault);

    const out = applyExplicitAudiencePreferences(EVENT, ['client@elsewhere.com'], [], []);
    expect(out.map((r) => r.email)).toEqual(['client@elsewhere.com']);
  });

  it('suppresses a RESOLVED address when the event defaults to OFF and nobody opted in', () => {
    // The other half of the same rule: an address that DOES resolve is governed
    // by its users' effective preference, default included.
    const offByDefault: NotificationEventDefinition = {
      ...findNotificationEvent(EVENT)!,
      defaultEnabled: false,
    };
    mocks.findNotificationEvent.mockReturnValueOnce(offByDefault);

    const out = applyExplicitAudiencePreferences(
      EVENT, ['a@x.com'], [member({ user_id: 'u1', email: 'a@x.com' })], [],
    );
    expect(out).toEqual([]);
  });

  it('ignores a stored row for a DIFFERENT user when deciding an address', () => {
    // `storedByUser` is keyed on user id, and the caller passes rows for the
    // whole tenant. A row belonging to somebody else must not suppress this
    // address.
    const out = applyExplicitAudiencePreferences(
      EVENT,
      ['a@x.com'],
      [member({ user_id: 'u1', email: 'a@x.com' })],
      [pref({ user_id: 'u-other', event_key: EVENT, enabled: false })],
    );
    expect(out.map((r) => r.email)).toEqual(['a@x.com']);
  });

  it('keeps the FIRST occurrence when one address is typed twice in different cases', () => {
    const out = applyExplicitAudiencePreferences(
      EVENT, ['A@x.com', 'a@X.com', 'b@x.com'], [], [],
    );
    expect(out.map((r) => r.email)).toEqual(['a@x.com', 'b@x.com']);
  });

  it('returns nothing for an inherited Object property as an event key', () => {
    for (const key of ['constructor', '__proto__', 'toString']) {
      expect(applyExplicitAudiencePreferences(key, ['a@x.com'], [], []), key).toEqual([]);
    }
  });

  it('returns nothing for an empty address list', () => {
    expect(applyExplicitAudiencePreferences(EVENT, [], [], [])).toEqual([]);
  });
});
