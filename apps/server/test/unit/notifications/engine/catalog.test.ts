import { describe, it, expect } from 'vitest';

/**
 * Catalog INVARIANTS — the rules a new event has to satisfy, enforced here
 * because TypeScript cannot state most of them.
 *
 * The same job `test/unit/agency/agency-activity-actions.test.ts` does for the
 * audit vocabulary, and for the same reason: vitest does not type-check, so a
 * compile-time guarantee and a test guarantee are different guarantees, and the
 * ones below are not expressible in the type system at all.
 *
 * Every failure here is a notification that would be BROKEN IN A SILENT WAY — a
 * digest that matches no scheduled run, a settings page that cannot render an
 * event, an audience that resolves to nobody. None of them throws in production.
 */

import {
  NOTIFICATION_CHANNELS,
  NOTIFICATION_EVENTS,
  NOTIFICATION_EVENT_KEYS,
  findNotificationEvent,
  isLiveEventKey,
  isNotificationChannel,
  isNotificationEventKey,
} from '../../../../src/notifications/engine/catalog.js';
import { DIGEST_FREQUENCIES } from '../../../../src/notifications/engine/period.js';
import { ROLE_HIERARCHY, PERMISSION_MATRIX } from '@magick-agency/contracts/rbac';

describe('the notification catalog', () => {
  it('has one definition per declared key, and no extras', () => {
    // The key union and the definition array are two hand-maintained lists.
    // Adding a key without a definition ships an event nothing can render;
    // adding a definition without a key makes it unreferenceable from typed code.
    expect(NOTIFICATION_EVENTS.map((e) => e.key).sort()).toEqual([...NOTIFICATION_EVENT_KEYS].sort());
  });

  it('has no duplicate keys', () => {
    const keys = NOTIFICATION_EVENTS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every event a label and a description', () => {
    // Both are rendered on the settings page. An empty one is a checkbox with no
    // caption — the page still works, and nobody can tell what it does.
    for (const event of NOTIFICATION_EVENTS) {
      expect(event.label.trim(), `${event.key} label`).not.toBe('');
      expect(event.description.trim(), `${event.key} description`).not.toBe('');
    }
  });

  describe('digest events', () => {
    it('every digest declares a default frequency', () => {
      // The failure this prevents is the worst kind available here: a digest
      // preference stored with no cadence matches NO scheduled run, so the user
      // stays `enabled: true` on the settings page and silently receives
      // nothing. It looks like it is working.
      for (const event of NOTIFICATION_EVENTS) {
        if (event.cadence !== 'digest') continue;
        expect(event.defaultFrequency, `${event.key} defaultFrequency`).toBeDefined();
      }
    });

    it('every default frequency is one the scheduler actually runs', () => {
      // `DIGEST_FREQUENCIES` is what `serverless.yml`'s schedules fire and what
      // the runner filters on. A default outside it subscribes everybody to a
      // cadence nothing triggers.
      for (const event of NOTIFICATION_EVENTS) {
        if (!event.defaultFrequency) continue;
        expect(DIGEST_FREQUENCIES, `${event.key}`).toContain(event.defaultFrequency);
      }
    });

    it('no immediate event carries a frequency', () => {
      // A frequency on an immediate event is meaningless and would be stored,
      // served, and eventually believed.
      for (const event of NOTIFICATION_EVENTS) {
        if (event.cadence === 'digest') continue;
        expect(event.defaultFrequency, `${event.key}`).toBeUndefined();
      }
    });
  });

  describe('audiences', () => {
    it('every role_floor names a role in the hierarchy', () => {
      // A floor that is not in `ROLE_HIERARCHY` makes `clearsFloor` compare
      // against `undefined`, which is false for everyone — the event silently
      // reaches nobody, forever, with nothing logged.
      for (const event of NOTIFICATION_EVENTS) {
        if (event.audience.kind !== 'role_floor') continue;
        expect(ROLE_HIERARCHY[event.audience.minimumRole], `${event.key}`).toBeTypeOf('number');
      }
    });

    it('no audience floors at `agent`', () => {
      // `agent` is level 5, BELOW `viewer`, and holds exactly the four agency
      // permissions by design (`src/rbac/roles.ts`). No event in today's catalog
      // is addressed to a dialer agent, and one that were would need its own
      // argument rather than arriving by someone lowering a floor to "make it
      // work" — which is the exact move the hierarchy's own comment warns off.
      for (const event of NOTIFICATION_EVENTS) {
        if (event.audience.kind !== 'role_floor') continue;
        expect(event.audience.minimumRole, `${event.key}`).not.toBe('agent');
      }
    });

    it('the agency event derives its floor from the permission matrix', () => {
      // Pinned so the audience cannot drift from the permission that defines who
      // supervises a campaign. If `agency.supervise` moves, this moves with it —
      // and this assertion is what proves it is still derived rather than having
      // been "simplified" to a literal.
      const event = findNotificationEvent('agency.campaign.completed');
      expect(event?.audience).toEqual({
        kind: 'role_floor',
        minimumRole: PERMISSION_MATRIX['agency.supervise'],
      });
    });
  });

  describe('lookup', () => {
    it('resolves a known key', () => {
      expect(findNotificationEvent('agency.campaign.completed')?.key).toBe('agency.campaign.completed');
      expect(isNotificationEventKey('agency.campaign.completed')).toBe(true);
    });

    it('does not resolve inherited Object properties', () => {
      // The prototype-pollution hazard this repo records at four lookup sites in
      // `src/autopilot/`: with a plain object literal, `EVENTS['constructor']`
      // resolves to `Object` — truthy — so every "unknown event" guard
      // downstream silently passes and a request naming `constructor` is
      // validated as a real event. A `Map` has no prototype chain to walk.
      for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
        expect(findNotificationEvent(key), key).toBeUndefined();
        expect(isNotificationEventKey(key), key).toBe(false);
      }
    });

    it('does not resolve an unknown key', () => {
      expect(findNotificationEvent('usage.digest.weekly')).toBeUndefined();
      expect(isNotificationEventKey('')).toBe(false);
    });
  });

  describe('channels', () => {
    it('recognises exactly the declared channels', () => {
      for (const channel of NOTIFICATION_CHANNELS) expect(isNotificationChannel(channel)).toBe(true);
      expect(isNotificationChannel('sms')).toBe(false);
      expect(isNotificationChannel('EMAIL')).toBe(false);
      // Same prototype hazard, one function over.
      expect(isNotificationChannel('constructor')).toBe(false);
    });
  });

  it('does not list the invite mailer', () => {
    // The invitation carries the token that is somebody's only route into the
    // product. There is no coherent "off" for it — suppressing it does not spare
    // the recipient a mail, it denies them the account — so it must never
    // acquire a toggle. Asserted rather than trusted, because "add every mailer
    // to the catalog" is the obvious next change somebody makes.
    const keys = NOTIFICATION_EVENTS.map((e) => e.key) as string[];
    expect(keys).not.toContain('user.invite');
    expect(keys.some((k) => k.includes('invite'))).toBe(false);
  });
});

/**
 * ── `isLiveEventKey`, and why "inert" is not "deleted" ────────────────────
 *
 * A stored `user_notification_preferences` row names its event as TEXT, not an
 * enum and not an FK (the governance overrides' reasoning, restated at
 * migration 072). So a build that has renamed or retired an event still meets
 * rows naming the old key. Such a row is INERT: never served, never validated
 * against, and — the half that is easy to "tidy up" — never deleted, because a
 * key removed by mistake and restored next release would have taken every
 * customer's preference with it in the meantime and silently reverted them all
 * to the default.
 */
describe('isLiveEventKey', () => {
  it('is true for every key in the catalog', () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(isLiveEventKey(event.key), event.key).toBe(true);
    }
  });

  it('is false for a retired key, so the row is skipped rather than served', () => {
    // `usage.digest.monthly` is the shape a retired key takes: a plausible
    // sibling of a live one. It must not resolve.
    expect(isLiveEventKey('usage.digest.monthly')).toBe(false);
    expect(isLiveEventKey('campaign.started')).toBe(false);
    expect(isLiveEventKey('')).toBe(false);
  });

  it('goes through the same Map, so inherited properties are not "live"', () => {
    // The fourth lookup site. A bare object index would report `constructor` as
    // a live event key, and a stored row naming it would then be served to the
    // settings page as a real toggle.
    for (const key of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
      expect(isLiveEventKey(key), key).toBe(false);
    }
  });

  it('agrees with `isNotificationEventKey` on every input', () => {
    // The two are separate exports with separate call sites (validation vs the
    // preference read) and they must not be able to disagree — one saying a key
    // is live while the other refuses it is a row that is written and then
    // never read back.
    for (const key of [
      ...NOTIFICATION_EVENT_KEYS,
      'usage.digest.monthly', 'constructor', '__proto__', '', 'usage.Digest',
    ]) {
      expect(isLiveEventKey(key), key).toBe(isNotificationEventKey(key));
    }
  });
});

describe('catalog lookup is a Map, asserted directly', () => {
  it('never returns a definition whose key is not the key asked for', () => {
    // The failure a prototype hit produces is not an exception, it is a
    // definition for the WRONG event — so this checks identity, not truthiness.
    for (const event of NOTIFICATION_EVENTS) {
      expect(findNotificationEvent(event.key)).toBe(event);
    }
  });

  it('is case-sensitive', () => {
    // Keys come off the wire from `PUT /notifications/preferences`. Accepting
    // `USAGE.DIGEST` would let two spellings of one event be stored as two rows
    // under the unique index, and only one of them would ever be read back.
    //
    // The variants are of the one live key, so they are undefined for the right
    // reason rather than because the key is absent.
    expect(findNotificationEvent('AGENCY.CAMPAIGN.COMPLETED')).toBeUndefined();
    expect(findNotificationEvent('Agency.Campaign.Completed')).toBeUndefined();
    expect(findNotificationEvent(' agency.campaign.completed')).toBeUndefined();
    expect(findNotificationEvent('agency.campaign.completed ')).toBeUndefined();
    expect(findNotificationEvent('agency.campaign.completed')).toBeDefined();
  });
});

describe('the agency floor, pinned as a value and not only as a derivation', () => {
  it('is `account_admin` today, and derived from `agency.supervise`', () => {
    // Two assertions doing two different jobs, and the second alone is a
    // tautology: comparing the catalog against `PERMISSION_MATRIX` passes for
    // WHATEVER the matrix holds, including a value somebody lowered by
    // accident. The literal is what would fail on such a change; the derivation
    // check is what proves the entry has not been "simplified" to a literal and
    // then left behind when the matrix moves.
    const event = findNotificationEvent('agency.campaign.completed');
    expect(event?.audience).toEqual({ kind: 'role_floor', minimumRole: 'account_admin' });
    expect(PERMISSION_MATRIX['agency.supervise']).toBe('account_admin');
    expect(event?.audience.kind === 'role_floor' && event.audience.minimumRole)
      .toBe(PERMISSION_MATRIX['agency.supervise']);
  });

  it('sits strictly above `agent` in the hierarchy, so a dialer agent is never mailed', () => {
    // `agent` is level 5 and deliberately BELOW `viewer` (10). The agency
    // notice is addressed to whoever supervises a campaign, never to the people
    // taking its calls.
    for (const event of NOTIFICATION_EVENTS) {
      if (event.audience.kind !== 'role_floor') continue;
      expect(ROLE_HIERARCHY[event.audience.minimumRole], event.key)
        .toBeGreaterThan(ROLE_HIERARCHY['agent']);
    }
  });
});

describe('catalog shape invariants', () => {
  it('gives every event a category the settings page can group under', () => {
    // An event in a category the page does not render is a toggle nobody can
    // find — the row exists, the audience resolves, and the customer cannot
    // turn it off.
    for (const event of NOTIFICATION_EVENTS) {
      expect(['campaigns', 'agency', 'digests'], event.key).toContain(event.category);
    }
  });

  it('declares exactly one cadence per event, from the closed set', () => {
    for (const event of NOTIFICATION_EVENTS) {
      expect(['immediate', 'digest'], event.key).toContain(event.cadence);
    }
  });

  it('declares an audience kind the resolvers actually handle', () => {
    // `resolveRoleFloorAudience` answers `role_floor` and
    // `applyExplicitAudiencePreferences` answers `explicit`. A third kind
    // resolves to nobody in both, silently.
    for (const event of NOTIFICATION_EVENTS) {
      expect(['explicit', 'role_floor'], event.key).toContain(event.audience.kind);
    }
  });

  it('gives every event an explicit boolean default, never an absent one', () => {
    // `defaultEnabled` is what a user with no stored row gets. `undefined` is
    // falsy, so a missing field silently unsubscribes everybody who has never
    // opened the settings page — and nothing anywhere reports it.
    for (const event of NOTIFICATION_EVENTS) {
      expect(typeof event.defaultEnabled, event.key).toBe('boolean');
    }
  });

  it('has exactly the one event this build ships', () => {
    // A count, deliberately: adding an event is meant to be a catalog row plus
    // a renderer, and this is the line that makes the addition visible in a
    // diff rather than arriving as a silent fifth toggle on the settings page.
    //
    // The catalog keeps only `agency.campaign.completed`; this also pins the
    // absence of `campaign.dispatched`, `campaign.completed` and `usage.digest`.
    expect(NOTIFICATION_EVENT_KEYS).toEqual([
      'agency.campaign.completed',
    ]);
    for (const retired of ['campaign.dispatched', 'campaign.completed', 'usage.digest']) {
      expect(findNotificationEvent(retired), retired).toBeUndefined();
    }
  });

  it('offers exactly one channel, and it is `email`', () => {
    expect(NOTIFICATION_CHANNELS).toEqual(['email']);
  });
});
