import { describe, it, expect, afterEach } from 'vitest';
import {
  AGENCY_LOGIN_PATH,
  LOGIN_PATH,
  RETURN_PATH_PARAM,
  isAgencySurfacePath,
  isLoginPath,
  loginPathFor,
  loginPathReturningTo,
  safeReturnPath,
  sessionExpiredLoginUrl,
} from '../../utils/returnPath';

/**
 * `returnPath` read through the `/t/:tenantId/a/:accountId` scope prefix.
 *
 * `RequireAuth` and `sessionExpiredLoginUrl` now hand these helpers scoped paths.
 * Read naively, every scoped path starts with `/t/`, so none of them would look
 * like an agency surface (wrong door) or a sign-in page (a `?next=` loop).
 */

const PREFIX = '/t/t-a/a/acct-1';

describe('isAgencySurfacePath — scoped', () => {
  it('sees an agency surface through the prefix', () => {
    expect(isAgencySurfacePath(`${PREFIX}/dialer`)).toBe(true);
    expect(isAgencySurfacePath(`${PREFIX}/station?campaign=c1`)).toBe(true);
    expect(isAgencySurfacePath(`${PREFIX}/agency/campaigns`)).toBe(true);
  });

  it('does not sweep in a platform path or the bare prefix', () => {
    expect(isAgencySurfacePath(`${PREFIX}/app/settings`)).toBe(false);
    expect(isAgencySurfacePath(PREFIX)).toBe(false);
    expect(isAgencySurfacePath(`${PREFIX}/dialerish`)).toBe(false);
  });
});

describe('loginPathFor — scoped', () => {
  it('picks the agency door for a scoped agency path', () => {
    expect(loginPathFor(`${PREFIX}/dialer`)).toBe(AGENCY_LOGIN_PATH);
    expect(loginPathFor(`${PREFIX}/agency/dnc`)).toBe(AGENCY_LOGIN_PATH);
  });

  it('picks the primary door for a scoped platform path', () => {
    expect(loginPathFor(`${PREFIX}/app/settings`)).toBe(LOGIN_PATH);
  });

  it('carries the whole scoped path in next, at the right door', () => {
    const url = new URL(loginPathReturningTo(`${PREFIX}/agency/campaigns?x=1`), 'https://app.x');
    expect(url.pathname).toBe(AGENCY_LOGIN_PATH);
    expect(url.searchParams.get(RETURN_PATH_PARAM)).toBe(`${PREFIX}/agency/campaigns?x=1`);
  });
});

describe('isLoginPath — scoped', () => {
  it('sees a sign-in or invite page through the prefix', () => {
    expect(isLoginPath(`${PREFIX}/login`)).toBe(true);
    expect(isLoginPath(`${PREFIX}/agency/login`)).toBe(true);
    expect(isLoginPath(`${PREFIX}/agency/join/tok-1`)).toBe(true);
  });

  it('is false for a scoped app page', () => {
    expect(isLoginPath(`${PREFIX}/dialer`)).toBe(false);
    expect(isLoginPath(PREFIX)).toBe(false);
  });
});

describe('safeReturnPath — scoped', () => {
  it('keeps a scoped next as it stands — the scope is the point of it', () => {
    expect(safeReturnPath(`${PREFIX}/agency/campaigns?x=1#y`)).toBe(`${PREFIX}/agency/campaigns?x=1#y`);
    expect(safeReturnPath(PREFIX)).toBe(PREFIX);
  });

  it('refuses a scoped sign-in page, which would loop', () => {
    expect(safeReturnPath(`${PREFIX}/login`)).toBeNull();
    expect(safeReturnPath(`${PREFIX}/agency/login?next=%2Fdialer`)).toBeNull();
  });

  it('still refuses a cross-origin escape hidden behind a prefix', () => {
    expect(safeReturnPath(`${PREFIX}/../../../..//evil.example`)).toBeNull();
  });
});

describe('sessionExpiredLoginUrl — scoped', () => {
  const original = Object.getOwnPropertyDescriptor(window, 'location');
  afterEach(() => {
    if (original) Object.defineProperty(window, 'location', original);
  });
  const setLocation = (pathname: string, search = '', hash = '') => {
    Object.defineProperty(window, 'location', {
      value: { pathname, search, hash },
      writable: true,
      configurable: true,
    });
  };

  it('keeps the prefix in next and picks the agency door for a scoped agency page', () => {
    setLocation(`${PREFIX}/station`, '?campaign=c1');

    const url = new URL(sessionExpiredLoginUrl(), 'https://app.x');

    expect(url.pathname).toBe(AGENCY_LOGIN_PATH);
    expect(url.searchParams.get('session')).toBe('expired');
    expect(url.searchParams.get(RETURN_PATH_PARAM)).toBe(`${PREFIX}/station?campaign=c1`);
  });

  it('picks the primary door for a scoped platform page, still keeping the prefix', () => {
    setLocation(`${PREFIX}/app/settings`);

    const url = new URL(sessionExpiredLoginUrl(), 'https://app.x');

    expect(url.pathname).toBe(LOGIN_PATH);
    expect(url.searchParams.get(RETURN_PATH_PARAM)).toBe(`${PREFIX}/app/settings`);
  });

  it('carries no next from a scoped sign-in page', () => {
    setLocation(`${PREFIX}/agency/login`);

    const url = new URL(sessionExpiredLoginUrl(), 'https://app.x');

    expect(url.pathname).toBe(AGENCY_LOGIN_PATH);
    expect(url.searchParams.has(RETURN_PATH_PARAM)).toBe(false);
  });
});
