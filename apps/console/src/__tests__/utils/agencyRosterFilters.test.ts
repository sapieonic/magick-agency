import { describe, it, expect } from 'vitest';
import {
  isRosterFiltered,
  rosterFilterGroupCount,
  rosterFiltersFromParams,
  rosterFiltersToParams,
} from '../../utils/agencyRosterFilters';

/**
 * The contacts tab's filters, in the URL.
 *
 * The round trip is the point: the rule is that the query string the
 * supervisor is already looking at BECOMES the retry selector, and that is only
 * literally true if the applied filters live there rather than in a component.
 */

describe('the round trip', () => {
  it('carries last_disposition out to the URL and back unchanged', () => {
    const filters = { last_disposition: ['voicemail', 'callback'] };
    const params = rosterFiltersToParams(filters);

    expect(params.getAll('last_disposition')).toEqual(['voicemail', 'callback']);
    expect(rosterFiltersFromParams(params)).toEqual(filters);
  });

  it('round-trips every filter group at once', () => {
    const filters = {
      state: ['suppressed', 'exhausted'],
      suppressed_reason: ['max_attempts'],
      last_disposition: ['voicemail'],
      phone: '98765',
    };
    expect(rosterFiltersFromParams(rosterFiltersToParams(filters))).toEqual(filters);
  });

  it('parses a hand-typed query string', () => {
    const params = new URLSearchParams(
      'state=suppressed&last_disposition=voicemail&last_disposition=ptp',
    );
    expect(rosterFiltersFromParams(params)).toEqual({
      state: ['suppressed'],
      last_disposition: ['voicemail', 'ptp'],
    });
  });

  it('uses repeated params, never a comma-joined value', () => {
    // Both services accept repeated params; a comma-joined value would lose a
    // disposition code containing a comma a second time, before the request is
    // even built.
    const params = rosterFiltersToParams({ last_disposition: ['a', 'b'] });
    expect(params.toString()).toBe('last_disposition=a&last_disposition=b');
  });
});

describe('what the URL does not carry over', () => {
  it('ignores a key this build does not know', () => {
    // An allow-list on read: forwarding an unknown key to a route that drops it
    // silently is what presented an unfiltered list as a filtered one.
    const params = new URLSearchParams('state=pending&sort=phone&cursor=abc');
    expect(rosterFiltersFromParams(params)).toEqual({ state: ['pending'] });
  });

  it('drops an empty value rather than filtering on nothing', () => {
    const params = new URLSearchParams('phone=&state=&state=pending');
    expect(rosterFiltersFromParams(params)).toEqual({ state: ['pending'] });
  });

  it('writes nothing at all for an empty filter set', () => {
    expect(rosterFiltersToParams({}).toString()).toBe('');
  });

  it('expresses a removal, because it builds fresh rather than merging', () => {
    const applied = rosterFiltersToParams({ state: ['pending'], phone: '123' });
    const cleared = rosterFiltersToParams({ state: ['pending'] });
    expect(applied.has('phone')).toBe(true);
    expect(cleared.has('phone')).toBe(false);
  });
});

describe('the filter badge counts GROUPS, not values', () => {
  it('counts two chips in one group once', () => {
    expect(rosterFilterGroupCount({ state: ['pending', 'suppressed'] })).toBe(1);
  });

  it('counts the disposition group, which is what the badge was missing', () => {
    expect(rosterFilterGroupCount({ state: ['pending'], last_disposition: ['voicemail'] })).toBe(2);
  });

  it('is zero, and unfiltered, for an empty set', () => {
    expect(rosterFilterGroupCount({})).toBe(0);
    expect(isRosterFiltered({})).toBe(false);
    expect(isRosterFiltered({ last_disposition: ['voicemail'] })).toBe(true);
  });
});
