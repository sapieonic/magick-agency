import { describe, it, expect } from 'vitest';

/**
 * Preference-write validation.
 *
 * The schema validates against the FROZEN catalog rather than restating it, so
 * these cases are really about the `superRefine`: which refusals exist, and that
 * each one carries a `path` and a message. That second half is not cosmetic —
 * `errorMaskHook` passes a 4xx through UNCHANGED only when it carries
 * field-level `details`, so a refusal without them reaches the customer as
 * "contact support and quote this request id" for what is a typo in a checkbox.
 */

// PORT NOTE (magick-agency): `previewDigestSchema` and `runDigestsSchema` are
// deleted from the validator (credits usage digest, plan §3.3/§3.5) with their
// 22 cases (`previewDigestSchema` 2 + 5, `runDigestsSchema` 4 + 11). Agency's
// catalog holds only `agency.campaign.completed`, an immediate event, so cases
// that master wrote against `usage.digest` / `campaign.completed` use that key
// wherever the rule under test does not depend on the event being a digest, and
// the five cases that DO depend on a digest event (or on two distinct live
// events) are deleted, each marked where it stood.
import {
  updateNotificationPreferencesSchema,
} from '../../../src/api/validators/notification.validator.js';

function parse(preferences: unknown[]) {
  return updateNotificationPreferencesSchema.safeParse({ preferences });
}

describe('updateNotificationPreferencesSchema', () => {
  // PORT NOTE (magick-agency): master's 'accepts a digest preference with a
  // cadence' is deleted — agency's catalog has no digest event (plan §3.5).

  it('defaults the channel', () => {
    // Present in the contract from the start rather than added later: a client
    // that has always sent `channel` keeps working when a second one exists.
    const result = parse([{ event_key: 'agency.campaign.completed', enabled: false }]);
    expect(result.success && result.data.preferences[0]?.channel).toBe('email');
  });

  // PORT NOTE (magick-agency): master's 'accepts an explicit null frequency on a
  // digest' is deleted — agency's catalog has no digest event (plan §3.5); the
  // immediate-event null case below still covers an explicit `null`.

  describe('refusals', () => {
    it('refuses an unknown event key, naming it', () => {
      const result = parse([{ event_key: 'usage.digest.monthly', enabled: true }]);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('usage.digest.monthly');
      expect(result.error?.issues[0]?.path).toEqual(['preferences', 0, 'event_key']);
    });

    it('refuses an inherited Object property as an event key', () => {
      // The prototype hazard: a bare object index would resolve `constructor` to
      // a truthy value and validate it as a real event.
      for (const key of ['constructor', '__proto__', 'toString']) {
        expect(parse([{ event_key: key, enabled: true }]).success, key).toBe(false);
      }
    });

    it('refuses an unsupported channel, listing the supported ones', () => {
      const result = parse([{ event_key: 'agency.campaign.completed', channel: 'sms', enabled: true }]);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('email');
    });

    it('refuses a frequency on an immediate event', () => {
      // Accepting and dropping it would leave the client believing it set
      // something the column does not hold.
      const result = parse([{ event_key: 'agency.campaign.completed', enabled: true, frequency: 'daily' }]);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.path).toEqual(['preferences', 0, 'frequency']);
    });

    it('refuses a cadence nothing runs', () => {
      expect(parse([{ event_key: 'agency.campaign.completed', enabled: true, frequency: 'monthly' }]).success)
        .toBe(false);
    });

    it('refuses a duplicate (event, channel) pair', () => {
      // The upsert would apply both in array order, so the stored value would
      // depend on which entry the client happened to put last. A silently
      // non-deterministic save is worse than a 400 naming the repeated key.
      //
      // PORT NOTE (magick-agency): master's entries carry `daily` / `weekly` on
      // `usage.digest`; on agency's one (immediate) event a frequency is its own
      // refusal and would be issue 0, so the duplicate is stated without one.
      const result = parse([
        { event_key: 'agency.campaign.completed', enabled: true },
        { event_key: 'agency.campaign.completed', enabled: false },
      ]);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toContain('Duplicate');
    });

    it('refuses an empty list and an oversized one', () => {
      expect(parse([]).success).toBe(false);
      expect(parse(Array.from({ length: 51 }, () => ({
        event_key: 'agency.campaign.completed', enabled: true,
      }))).success).toBe(false);
    });

    it('refuses a non-boolean enabled', () => {
      expect(parse([{ event_key: 'agency.campaign.completed', enabled: 'yes' }]).success).toBe(false);
    });

    it('reports EVERY bad entry, not just the first', () => {
      // The settings page saves the whole form at once; naming one problem at a
      // time makes fixing three a three-round-trip conversation.
      const result = parse([
        { event_key: 'nope', enabled: true },
        { event_key: 'agency.campaign.completed', enabled: true, frequency: 'daily' },
      ]);
      expect(result.success).toBe(false);
      expect(result.error?.issues.length).toBeGreaterThanOrEqual(2);
    });
  });
});

describe('updateNotificationPreferencesSchema, further cases', () => {
  // PORT NOTE (magick-agency): master's 'accepts a digest preference with NO
  // frequency at all' and 'accepts every cadence the scheduler runs' are deleted
  // — agency's catalog has no digest event (plan §3.5).

  it('accepts an immediate event with an explicit NULL frequency', () => {
    // `null` is "not applicable", which is exactly what an immediate event's
    // column holds. Only a real cadence on an immediate event is a mistake.
    expect(parse([{ event_key: 'agency.campaign.completed', enabled: true, frequency: null }]).success)
      .toBe(true);
  });

  it('accepts every event in the catalog with `enabled` alone', () => {
    // The unsubscribe-everything shape a settings page sends. Every catalog key
    // must be writable without the client knowing which are digests.
    //
    // PORT NOTE (magick-agency): master lists its four events; agency's catalog
    // holds one (plan §3.5).
    const result = parse([
      { event_key: 'agency.campaign.completed', enabled: false },
    ]);
    expect(result.success).toBe(true);
  });

  it('treats an entry with the default channel as a duplicate of an explicit `email` one', () => {
    // The default is applied BEFORE `superRefine` runs, so the two entries
    // collide on `usage.digest:email`. Were the default applied afterwards, the
    // upsert would receive both and the stored value would depend on array
    // order — the silently non-deterministic save this refusal exists to stop.
    const result = parse([
      { event_key: 'agency.campaign.completed', enabled: true },
      { event_key: 'agency.campaign.completed', channel: 'email', enabled: false },
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('Duplicate');
    expect(result.error?.issues[0]?.path).toEqual(['preferences', 1, 'event_key']);
  });

  // PORT NOTE (magick-agency): master's 'does not treat two DIFFERENT events as
  // duplicates' is deleted — it needs two live event keys and agency's catalog
  // holds one (plan §3.5).

  it('reports only the FIRST problem for one entry, not a cascade', () => {
    // Each refusal `return`s, so an entry with an unknown key is reported once
    // rather than also being reported for its channel and its frequency. Three
    // messages about one typo is a settings page that looks broken.
    const result = parse([{ event_key: 'nope', channel: 'carrier-pigeon', enabled: true, frequency: 'daily' }]);
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]?.message).toContain('Unknown notification event');
  });

  it('does not check the channel of an entry whose event is unknown', () => {
    const result = parse([{ event_key: '__proto__', channel: 'sms', enabled: true }]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['preferences', 0, 'event_key']);
  });

  it('names the offending channel AND the supported set', () => {
    // `errorMaskHook` passes a 4xx through UNCHANGED only when it carries
    // field-level `details`. A bare message reaches the customer as "contact
    // support and quote this request id" for what is a typo in a checkbox.
    const result = parse([{ event_key: 'agency.campaign.completed', channel: 'webhook', enabled: true }]);
    expect(result.error?.issues[0]?.message).toContain('webhook');
    expect(result.error?.issues[0]?.message).toContain('email');
    expect(result.error?.issues[0]?.path).toEqual(['preferences', 0, 'channel']);
  });

  it('refuses an empty or oversized channel before the catalog is consulted', () => {
    expect(parse([{ event_key: 'agency.campaign.completed', channel: '', enabled: true }]).success).toBe(false);
    expect(parse([{ event_key: 'agency.campaign.completed', channel: 'x'.repeat(31), enabled: true }]).success)
      .toBe(false);
  });

  it('refuses an empty or oversized event key', () => {
    expect(parse([{ event_key: '', enabled: true }]).success).toBe(false);
    expect(parse([{ event_key: 'a'.repeat(101), enabled: true }]).success).toBe(false);
  });

  it('accepts exactly 50 entries and refuses 51', () => {
    // The bound is on the array, so the boundary is worth stating: 50 is more
    // than the catalog holds, and the cap is there to stop an unbounded upsert
    // rather than to limit a legitimate save.
    const entry = (_i: number) => ({
      // PORT NOTE (magick-agency): master alternates `usage.digest` /
      // `campaign.completed`; agency's catalog holds one event, so all 50 share one
      // identity — the 50 still fail on the DUPLICATE rule, not the size rule.
      event_key: 'agency.campaign.completed' as const,
      enabled: true,
    });
    // 50 entries, but only two distinct identities — so this must fail on the
    // DUPLICATE rule, not on the size rule.
    const fifty = parse(Array.from({ length: 50 }, (_, i) => entry(i)));
    expect(fifty.success).toBe(false);
    expect(fifty.error?.issues[0]?.message).toContain('Duplicate');

    const fiftyOne = parse(Array.from({ length: 51 }, (_, i) => entry(i)));
    expect(fiftyOne.success).toBe(false);
    expect(fiftyOne.error?.issues.some((i) => i.path.join('.') === 'preferences')).toBe(true);
  });

  it('refuses a missing `preferences` key and a non-array one', () => {
    expect(updateNotificationPreferencesSchema.safeParse({}).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse({ preferences: 'all' }).success).toBe(false);
    expect(updateNotificationPreferencesSchema.safeParse(null).success).toBe(false);
  });

  it('refuses a missing `enabled`, which is the whole point of the write', () => {
    expect(parse([{ event_key: 'agency.campaign.completed' }]).success).toBe(false);
    expect(parse([{ event_key: 'agency.campaign.completed', enabled: null }]).success).toBe(false);
  });

  it('STRIPS an unknown key rather than refusing the write', () => {
    // Zod objects are non-strict here deliberately: this is a PATCH-shaped
    // upsert, and a client built against a newer build sending a field this one
    // has not heard of must not have its whole save refused. The unknown field
    // simply does not reach the repository.
    const result = parse([{ event_key: 'agency.campaign.completed', enabled: true, digest_hour: 9 }]);
    expect(result.success).toBe(true);
    expect(result.success && result.data.preferences[0]).toEqual({
      event_key: 'agency.campaign.completed', channel: 'email', enabled: true,
    });
  });

  it('refuses a frequency on the agency notice, which is immediate', () => {
    // The third immediate event, checked separately from the campaign pair
    // because it is the one whose audience is derived rather than explicit —
    // and a reader could reasonably expect a derived audience to be digestible.
    const result = parse([
      { event_key: 'agency.campaign.completed', enabled: true, frequency: 'weekly' },
    ]);
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('is not a digest');
    expect(result.error?.issues[0]?.path).toEqual(['preferences', 0, 'frequency']);
  });

  it('gives every refusal a `path`, so `errorMaskHook` lets the message through', () => {
    // The property that decides whether a customer sees "unknown event
    // 'usage.digestt'" or "contact support and quote this request id".
    const cases: unknown[][] = [
      [{ event_key: 'nope', enabled: true }],
      [{ event_key: 'agency.campaign.completed', channel: 'sms', enabled: true }],
      [{ event_key: 'agency.campaign.completed', enabled: true, frequency: 'daily' }],
      [{ event_key: 'agency.campaign.completed', enabled: true }, { event_key: 'agency.campaign.completed', enabled: false }],
    ];
    for (const preferences of cases) {
      const result = parse(preferences);
      expect(result.success).toBe(false);
      for (const issue of result.error!.issues) {
        expect(issue.path.length, JSON.stringify(preferences)).toBeGreaterThan(0);
        expect(issue.message.trim(), JSON.stringify(preferences)).not.toBe('');
      }
    }
  });
});
