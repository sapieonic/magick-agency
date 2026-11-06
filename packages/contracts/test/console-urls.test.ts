import { describe, expect, it } from 'vitest';
import {
  CONSOLE_SCOPE_PREFIX_RE,
  consoleScopePrefix,
} from '../src/api/platform/console-urls';
import { PlatformApi } from '../src/index';

/**
 * The console URL scope (B26) is built by the server (emailed links) and parsed by
 * the console's router. Both import these two names, so this pins the one shape
 * they agree on.
 */
describe('console URL scope (B26)', () => {
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const accountId = '22222222-2222-4222-8222-222222222222';

  it('builds /t/<tenant>/a/<account> with no trailing slash', () => {
    expect(consoleScopePrefix({ tenantId, accountId })).toBe(`/t/${tenantId}/a/${accountId}`);
  });

  it('percent-encodes each id as one segment', () => {
    expect(consoleScopePrefix({ tenantId: 'a/b', accountId: 'c d' })).toBe('/t/a%2Fb/a/c%20d');
  });

  it('matches what it builds, giving back each segment', () => {
    const match = CONSOLE_SCOPE_PREFIX_RE.exec(`${consoleScopePrefix({ tenantId, accountId })}/agency/campaigns/x`);
    expect(match?.[0]).toBe(`/t/${tenantId}/a/${accountId}`);
    expect(match?.[1]).toBe(tenantId);
    expect(match?.[2]).toBe(accountId);
  });

  it.each(['/t/x/a/y', '/t/x/a/y/', '/t/x/a/y?q=1', '/t/x/a/y#h', '/T/x/A/y/agency'])('matches %s', (path) => {
    expect(CONSOLE_SCOPE_PREFIX_RE.test(path)).toBe(true);
  });

  it.each(['/t/x/a/', '/t/x', '/x/t/x/a/y', '/tenants/x/accounts/y', '/t/x/ab/y', '/tx/a/y'])(
    'does not match %s',
    (path) => {
      expect(CONSOLE_SCOPE_PREFIX_RE.test(path)).toBe(false);
    },
  );

  it('is part of the PlatformApi namespace', () => {
    expect(PlatformApi.consoleScopePrefix).toBe(consoleScopePrefix);
    expect(PlatformApi.CONSOLE_SCOPE_PREFIX_RE).toBe(CONSOLE_SCOPE_PREFIX_RE);
  });
});
