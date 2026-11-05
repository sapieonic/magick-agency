import { describe, it, expect } from 'vitest';
import {
  isUnscopedPagePath,
  parseUrlScope,
  scopePrefix,
  scopePrefixOf,
  stripUrlScope,
  withUrlScope,
} from '../../utils/urlScope';

/**
 * The `/t/:tenantId/a/:accountId` prefix every signed-in console URL carries.
 *
 * These helpers are the router's basename, `RequireAuth`'s `?next=` and the
 * `returnPath` guards all at once, so a parse that is too loose puts a page on the
 * wrong account and one that is too strict breaks a shared link.
 */

describe('parseUrlScope', () => {
  it('reads the tenant and account from a scoped path', () => {
    expect(parseUrlScope('/t/t-a/a/acct-1/agency/campaigns')).toEqual({
      tenantId: 't-a',
      accountId: 'acct-1',
    });
  });

  it('reads the bare prefix, and a prefix followed by a query or hash', () => {
    const scope = { tenantId: 't-a', accountId: 'acct-1' };
    expect(parseUrlScope('/t/t-a/a/acct-1')).toEqual(scope);
    expect(parseUrlScope('/t/t-a/a/acct-1/')).toEqual(scope);
    expect(parseUrlScope('/t/t-a/a/acct-1?x=1')).toEqual(scope);
    expect(parseUrlScope('/t/t-a/a/acct-1#top')).toEqual(scope);
  });

  it('decodes percent-encoded ids', () => {
    expect(parseUrlScope('/t/t%20a/a/acct%3A1/dialer')).toEqual({
      tenantId: 't a',
      accountId: 'acct:1',
    });
  });

  it('accepts the markers in any case, as the router’s basename match does', () => {
    expect(parseUrlScope('/T/t-a/A/acct-1/dialer')).toEqual({ tenantId: 't-a', accountId: 'acct-1' });
  });

  it('keeps the ids as written (no case folding)', () => {
    expect(parseUrlScope('/t/Tenant-A/a/Acct-1')).toEqual({ tenantId: 'Tenant-A', accountId: 'Acct-1' });
  });

  it('returns null for an unscoped path', () => {
    expect(parseUrlScope('/agency/campaigns')).toBeNull();
    expect(parseUrlScope('/')).toBeNull();
    expect(parseUrlScope('')).toBeNull();
  });

  it('refuses a tenant with no account', () => {
    expect(parseUrlScope('/t/x')).toBeNull();
    expect(parseUrlScope('/t/x/a')).toBeNull();
    expect(parseUrlScope('/t/x/a/')).toBeNull();
  });

  it('refuses an empty tenant segment', () => {
    expect(parseUrlScope('/t//a/y')).toBeNull();
  });

  it('refuses a marker that merely starts the segment', () => {
    // `/tenants/…` and `/accounts/…` are API prefixes, not scopes.
    expect(parseUrlScope('/tenants/x/accounts/y')).toBeNull();
    expect(parseUrlScope('/t/x/ab/y')).toBeNull();
    expect(parseUrlScope('/tx/x/a/y')).toBeNull();
  });

  it('refuses an id that decodes to something containing a slash', () => {
    // A decoded `/` would split the id across two segments when built back up.
    expect(parseUrlScope('/t/x%2Fy/a/acct-1')).toBeNull();
    expect(parseUrlScope('/t/t-a/a/acct%2f1')).toBeNull();
  });

  it('refuses a malformed percent escape instead of throwing', () => {
    expect(() => parseUrlScope('/t/%E0%A4%A/a/acct-1')).not.toThrow();
    expect(parseUrlScope('/t/%E0%A4%A/a/acct-1')).toBeNull();
    expect(parseUrlScope('/t/t-a/a/%')).toBeNull();
  });
});

describe('scopePrefix', () => {
  it('builds the prefix with no trailing slash, encoding the ids', () => {
    expect(scopePrefix({ tenantId: 't-a', accountId: 'acct-1' })).toBe('/t/t-a/a/acct-1');
    expect(scopePrefix({ tenantId: 't a', accountId: 'x/y' })).toBe('/t/t%20a/a/x%2Fy');
  });

  it('round-trips through parseUrlScope', () => {
    const scope = { tenantId: 'tenant é', accountId: 'acct:1' };
    expect(parseUrlScope(`${scopePrefix(scope)}/dialer`)).toEqual(scope);
  });
});

describe('withUrlScope', () => {
  const scope = { tenantId: 't-a', accountId: 'acct-1' };

  it('puts an app path under the scope', () => {
    expect(withUrlScope(scope, '/agency/campaigns')).toBe('/t/t-a/a/acct-1/agency/campaigns');
  });

  it('turns the root into the bare prefix, without a trailing slash', () => {
    expect(withUrlScope(scope, '/')).toBe('/t/t-a/a/acct-1');
    expect(withUrlScope(scope, '')).toBe('/t/t-a/a/acct-1');
  });

  it('keeps a query or hash on the root directly after the prefix', () => {
    expect(withUrlScope(scope, '/?tab=2')).toBe('/t/t-a/a/acct-1?tab=2');
    expect(withUrlScope(scope, '/#top')).toBe('/t/t-a/a/acct-1#top');
  });

  it('keeps the query and hash of an ordinary path', () => {
    expect(withUrlScope(scope, '/station?campaign=c1#x')).toBe('/t/t-a/a/acct-1/station?campaign=c1#x');
  });

  it('replaces a scope the path already carries', () => {
    expect(withUrlScope({ tenantId: 't-b', accountId: 'acct-9' }, '/t/t-a/a/acct-1/agency/dnc')).toBe(
      '/t/t-b/a/acct-9/agency/dnc',
    );
    expect(withUrlScope({ tenantId: 't-b', accountId: 'acct-9' }, '/t/t-a/a/acct-1')).toBe('/t/t-b/a/acct-9');
  });

  it('encodes ids that need it', () => {
    expect(withUrlScope({ tenantId: 't a', accountId: 'b' }, '/dialer')).toBe('/t/t%20a/a/b/dialer');
  });
});

describe('stripUrlScope', () => {
  it('removes the prefix, keeping the rest', () => {
    expect(stripUrlScope('/t/t-a/a/acct-1/agency/campaigns?x=1#y')).toBe('/agency/campaigns?x=1#y');
  });

  it('returns the bare prefix as the root', () => {
    expect(stripUrlScope('/t/t-a/a/acct-1')).toBe('/');
    expect(stripUrlScope('/t/t-a/a/acct-1/')).toBe('/');
  });

  it('keeps a query or hash directly after the prefix, rooted', () => {
    expect(stripUrlScope('/t/t-a/a/acct-1?x=1')).toBe('/?x=1');
    expect(stripUrlScope('/t/t-a/a/acct-1#top')).toBe('/#top');
  });

  it('leaves an unscoped path unchanged', () => {
    expect(stripUrlScope('/agency/campaigns')).toBe('/agency/campaigns');
    expect(stripUrlScope('/t/x')).toBe('/t/x');
  });

  it('leaves a path whose prefix does not parse unchanged', () => {
    expect(stripUrlScope('/t/x%2Fy/a/acct-1/dialer')).toBe('/t/x%2Fy/a/acct-1/dialer');
  });
});

describe('scopePrefixOf', () => {
  it('returns the prefix exactly as written, not re-encoded', () => {
    // The router's basename must match the URL byte for byte.
    expect(scopePrefixOf('/t/t%20a/a/acct-1/dialer')).toBe('/t/t%20a/a/acct-1');
    expect(scopePrefixOf('/T/t-a/A/acct-1/dialer')).toBe('/T/t-a/A/acct-1');
  });

  it('returns the empty string for an unscoped or unparseable path', () => {
    expect(scopePrefixOf('/agency/campaigns')).toBe('');
    expect(scopePrefixOf('/t//a/y/dialer')).toBe('');
    expect(scopePrefixOf('/t/x%2Fy/a/acct-1')).toBe('');
    expect(scopePrefixOf('/t/%/a/acct-1')).toBe('');
  });
});

describe('isUnscopedPagePath', () => {
  it('is true for both sign-in doors', () => {
    expect(isUnscopedPagePath('/login')).toBe(true);
    expect(isUnscopedPagePath('/login?next=%2Fdialer')).toBe(true);
    expect(isUnscopedPagePath('/agency/login')).toBe(true);
  });

  it('is true for both invite landings', () => {
    expect(isUnscopedPagePath('/join/tok-1')).toBe(true);
    expect(isUnscopedPagePath('/agency/join/tok-1')).toBe(true);
  });

  it('is true for email verification', () => {
    expect(isUnscopedPagePath('/verify-email')).toBe(true);
  });

  it('reads through a scope prefix', () => {
    expect(isUnscopedPagePath('/t/t-a/a/acct-1/login')).toBe(true);
    expect(isUnscopedPagePath('/t/t-a/a/acct-1/agency/login')).toBe(true);
    expect(isUnscopedPagePath('/t/t-a/a/acct-1/agency/join/tok-1')).toBe(true);
    expect(isUnscopedPagePath('/t/t-a/a/acct-1/verify-email')).toBe(true);
  });

  it('is case-insensitive, as the routes are', () => {
    expect(isUnscopedPagePath('/Login')).toBe(true);
    expect(isUnscopedPagePath('/AGENCY/LOGIN')).toBe(true);
  });

  it('is false for a path that only shares a prefix with one', () => {
    expect(isUnscopedPagePath('/loginish')).toBe(false);
    expect(isUnscopedPagePath('/joined')).toBe(false);
    expect(isUnscopedPagePath('/agency/loginx')).toBe(false);
  });

  it('is false for signed-in pages, scoped or not', () => {
    expect(isUnscopedPagePath('/agency/campaigns')).toBe(false);
    expect(isUnscopedPagePath('/t/t-a/a/acct-1/agency/campaigns')).toBe(false);
    expect(isUnscopedPagePath('/')).toBe(false);
    expect(isUnscopedPagePath('/t/t-a/a/acct-1')).toBe(false);
  });
});
