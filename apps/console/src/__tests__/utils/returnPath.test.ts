import { describe, it, expect } from 'vitest';
import {
  AGENCY_JOIN_PATH,
  AGENCY_LOGIN_PATH,
  LOGIN_PATH,
  RETURN_PATH_PARAM,
  currentPath,
  isAgencySurfacePath,
  isLoginPath,
  loginPathFor,
  loginPathReturningTo,
  safeReturnPath,
  sessionExpiredLoginUrl,
} from '../../utils/returnPath';

/**
 * The post-sign-in destination, and the open-redirect guard on it.
 *
 * ── Why the attack cases are named individually ────────────────────────────
 * The first version of this guard inspected the string (`startsWith('/')`, no
 * `//`, no backslash) and shipped with tests that covered exactly the cases it
 * handled. Two families defeated it and neither was tested:
 *
 *  - **dot segments** — `/..//evil.example` passes every string check and the URL
 *    parser then normalises it to the path `//evil.example`;
 *  - **control characters** — the WHATWG parser strips tab/LF/CR before parsing,
 *    so `/\t/evil.example` (arriving decoded from `%09`) becomes `//evil.example`.
 *
 * Both end with react-router's `push` catching a cross-origin `SecurityError` and
 * falling back to `window.location.assign(url)` — a real navigation to the
 * attacker's site, launched from our domain right after a successful sign-in.
 *
 * So each bypass gets its own case with its own name. A table would let the next
 * person add a variant without understanding which mechanism it exercises, and
 * "the guard rejects a list of strings" is what passed last time.
 *
 * `%XX` forms are written decoded where a decoded value is what the guard actually
 * receives: `URLSearchParams.get` percent-decodes once, so `%09` reaches
 * `safeReturnPath` as a raw tab and `%2e%2e` as `..`.
 */

/** Everything the guard accepts must be a rooted, same-origin path. */
describe('safeReturnPath — what it accepts', () => {
  it('accepts an ordinary in-app path', () => {
    expect(safeReturnPath('/dialer')).toBe('/dialer');
  });

  it('keeps the query string and hash intact', () => {
    // The whole point for `/station?campaign=…`: a path without its query is a
    // different destination, and for the console it is the "No campaign selected."
    // refusal.
    expect(safeReturnPath('/station?campaign=camp-1')).toBe('/station?campaign=camp-1');
    expect(safeReturnPath('/agency/campaigns/x#stats')).toBe('/agency/campaigns/x#stats');
  });

  it('accepts a path that merely shares a prefix with /login', () => {
    expect(safeReturnPath('/loginish')).toBe('/loginish');
  });

  it('returns the CANONICAL form, not the caller’s spelling', () => {
    /**
     * The string handed to `navigate()` must be the string that was validated. A
     * guard that vetted one spelling and returned another would be checking
     * something the browser never sees.
     */
    expect(safeReturnPath('/agency/./campaigns')).toBe('/agency/campaigns');
    expect(safeReturnPath('/agency/x/../campaigns')).toBe('/agency/campaigns');
  });
});

describe('safeReturnPath — the dot-segment bypass', () => {
  /**
   * The bypass that defeated the string-matching version. Each of these normalises
   * to the pathname `//evil.example`, which resolves cross-origin.
   */
  it('refuses /..//host', () => {
    expect(safeReturnPath('/..//evil.example')).toBeNull();
  });

  it('refuses a dot segment nested deeper', () => {
    expect(safeReturnPath('/x/..//evil.example')).toBeNull();
    expect(safeReturnPath('/a/b/../..//evil.example')).toBeNull();
  });

  it('refuses a single-dot segment in front of it', () => {
    expect(safeReturnPath('/./..//evil.example')).toBeNull();
  });

  it('refuses the percent-encoded dot segment', () => {
    // `%2e%2e` is decoded to `..` by the parser and then normalised, so this is the
    // same attack as the plain form: pathname becomes `//evil.example`.
    expect(safeReturnPath('/%2e%2e//evil.example')).toBeNull();
  });

  it('ACCEPTS an encoded slash, because an encoded slash is not a separator', () => {
    /**
     * Worth pinning as an accept rather than leaving untested, because it looks
     * like a bypass and is not. `%2F` is not decoded into a path separator by the
     * URL parser, so `/..%2F/evil.example` has the single segment `..%2F` — no
     * normalisation, no host, origin unchanged. It is an ordinary same-origin path
     * that happens to be ugly, and it lands on the router's catch-all.
     *
     * Refusing it would mean the guard was rejecting on appearance rather than on
     * where the value actually resolves, which is the mistake the whole rewrite
     * was for.
     */
    expect(safeReturnPath('/..%2F/evil.example')).toBe('/..%2F/evil.example');
    expect(new URL(safeReturnPath('/..%2F/evil.example')!, 'https://app.x').origin).toBe(
      'https://app.x',
    );
  });
});

describe('safeReturnPath — the control-character bypass', () => {
  /**
   * Tab, LF and CR are STRIPPED by the URL parser before parsing, so a guard that
   * ran before the parser saw a harmless-looking path and the browser saw a host.
   */
  it.each([
    ['tab', '/\t/evil.example'],
    ['newline', '/\n/evil.example'],
    ['carriage return', '/\r/evil.example'],
  ])('refuses a %s used to smuggle a host', (_label, raw) => {
    expect(safeReturnPath(raw)).toBeNull();
  });

  it('refuses control characters inside the host too', () => {
    expect(safeReturnPath('/\t\t//evil.example')).toBeNull();
    expect(safeReturnPath('//\tevil.example')).toBeNull();
  });

  it('refuses /login with a trailing control character', () => {
    // Sidesteps a string-level `^\/login` check, then normalises back to `/login`
    // and loops. Caught because the anti-loop check now runs on the canonical path.
    expect(safeReturnPath('/login\t')).toBeNull();
    expect(safeReturnPath('/login\n')).toBeNull();
  });
});

describe('safeReturnPath — the cases the first version did get right', () => {
  it('refuses an absolute off-site URL', () => {
    expect(safeReturnPath('https://evil.example/steal')).toBeNull();
    expect(safeReturnPath('http://evil.example')).toBeNull();
  });

  it('refuses a protocol-relative URL', () => {
    expect(safeReturnPath('//evil.example')).toBeNull();
    expect(safeReturnPath('//evil.example/path')).toBeNull();
  });

  it('refuses a backslash, which some browsers normalise to a slash', () => {
    expect(safeReturnPath('/\\evil.example')).toBeNull();
    expect(safeReturnPath('\\\\evil.example')).toBeNull();
  });

  it('refuses a scheme-relative or non-path value', () => {
    expect(safeReturnPath('dialer')).toBeNull();
    expect(safeReturnPath('javascript:alert(1)')).toBeNull();
    expect(safeReturnPath('data:text/html,<script>')).toBeNull();
  });

  it('refuses an absent or empty value', () => {
    expect(safeReturnPath(null)).toBeNull();
    expect(safeReturnPath(undefined)).toBeNull();
    expect(safeReturnPath('')).toBeNull();
  });
});

describe('safeReturnPath — the login loop', () => {
  it('refuses /login and anything under it', () => {
    expect(safeReturnPath('/login')).toBeNull();
    expect(safeReturnPath('/login?next=/login')).toBeNull();
    expect(safeReturnPath('/login/reset')).toBeNull();
    expect(safeReturnPath('/login#x')).toBeNull();
  });

  it('refuses /login in any case, because the router matches case-insensitively', () => {
    // `/Login` reaches the same component, so a case-sensitive check would loop.
    expect(safeReturnPath('/Login')).toBeNull();
    expect(safeReturnPath('/LOGIN')).toBeNull();
    expect(safeReturnPath('/LogIn/reset')).toBeNull();
  });

  it('refuses the agency door, which a rule about /login alone would let through', () => {
    // `/agency/login` does not start with `/login`, so the original guard read it
    // as an ordinary in-app path — and an agent bounced to the agency door would
    // have looped between it and itself.
    expect(safeReturnPath('/agency/login')).toBeNull();
    expect(safeReturnPath('/agency/login?next=/agency/login')).toBeNull();
    expect(safeReturnPath('/Agency/Login')).toBeNull();
  });

  it('refuses the invite landing page, whose token is spent by the time we get back', () => {
    /*
      An invite token is SINGLE-USE. Honouring `/agency/join/:token` as a `?next=`
      therefore delivers somebody, freshly signed in, to "This invitation has
      already been used" — a screen whose only affordance is a link back to the
      agency door they have just come through. Same dead-end loop as
      `/agency/login`, arriving the same way: the param is in the URL, so a stale
      bookmark or a forwarded link is enough to produce it.
    */
    expect(safeReturnPath(AGENCY_JOIN_PATH)).toBeNull();
    expect(safeReturnPath('/agency/join/tok_abc123')).toBeNull();
    expect(safeReturnPath('/agency/join/tok_abc123?from=email')).toBeNull();
    expect(safeReturnPath('/agency/join/tok_abc123#x')).toBeNull();
    // Case-insensitive for the reason every other rule here is: react-router
    // matches routes case-insensitively, so `/Agency/Join/…` reaches this page.
    expect(safeReturnPath('/Agency/Join/tok_abc123')).toBeNull();
  });

  it('still accepts the rest of /agency, which is where people are going', () => {
    // The loop guard must not be widened to the `/agency` prefix: the campaign
    // list is the commonest destination a supervisor is carried back to.
    expect(safeReturnPath('/agency/campaigns')).toBe('/agency/campaigns');
    expect(safeReturnPath('/agency')).toBe('/agency');
    // `/agency/loginish` shares a prefix and is an ordinary path.
    expect(safeReturnPath('/agency/loginish')).toBe('/agency/loginish');
    // And `/agency/joinery` is an ordinary path that merely shares a prefix —
    // the boundary is a segment, not a `startsWith`.
    expect(safeReturnPath('/agency/joinery')).toBe('/agency/joinery');
  });
});

/**
 * Which of the two sign-in pages a destination belongs to.
 *
 * ── Why this is a rule about the DESTINATION ───────────────────────────────
 * Both callers run at a moment when there is no session to read a role from:
 * `RequireAuth` has just established there is no user, and `sessionExpiredLoginUrl`
 * runs because the session we had was rejected. The URL being asked for is the only
 * evidence available.
 */
describe('loginPathFor — which door', () => {
  it.each([
    '/agency',
    '/agency/campaigns/abc?tab=stats',
    '/dialer',
    '/station?campaign=1',
    // The invite landing page needs no entry of its own in
    // `AGENCY_SURFACE_PREFIXES`: it already matches through `/agency`, which is
    // why nothing was added there. Pinned so a future tightening of that list
    // cannot quietly send a bounced invite recipient to the marketing page.
    '/agency/join/tok_abc123',
  ])(
    'sends the agency surface %j to the agency door',
    (path) => {
      expect(loginPathFor(path)).toBe(AGENCY_LOGIN_PATH);
    },
  );

  it.each(['/app', '/app/settings', '/onboarding', '/'])(
    'sends the platform surface %j to the primary door',
    (path) => {
      expect(loginPathFor(path)).toBe(LOGIN_PATH);
    },
  );

  it('matches on a segment boundary rather than a bare prefix', () => {
    // `/agencyfoo` and `/dialerish` are ordinary paths that merely share a prefix;
    // sweeping them in would hand platform users the wrong page.
    expect(isAgencySurfacePath('/agencyfoo')).toBe(false);
    expect(isAgencySurfacePath('/dialerish')).toBe(false);
    expect(isAgencySurfacePath('/stationary')).toBe(false);
    expect(isAgencySurfacePath('/agency')).toBe(true);
    expect(isAgencySurfacePath('/agency/campaigns')).toBe(true);
  });

  it('matches case-insensitively, because the router does', () => {
    // `/Dialer` reaches the same component, so it must reach the same door.
    expect(loginPathFor('/Dialer')).toBe(AGENCY_LOGIN_PATH);
    expect(loginPathFor('/STATION')).toBe(AGENCY_LOGIN_PATH);
  });
});

/**
 * The property, asserted end to end rather than per-case: whatever the input, an
 * accepted value must resolve to the SAME origin the app is on. This is the
 * invariant the per-case tests above are examples of, and it is what would catch a
 * bypass family nobody has thought of yet.
 */
describe('safeReturnPath — the invariant', () => {
  const ORIGIN = 'https://app.example.com';
  const CANDIDATES = [
    '/dialer',
    '/station?campaign=1',
    '/..//evil.example',
    '/x/..//evil.example',
    '/%2e%2e//evil.example',
    '/\t/evil.example',
    '/\n//evil.example',
    '//evil.example',
    '/\\evil.example',
    'https://evil.example',
    '/./../..//evil.example',
    '/login',
    '/agency/join/tok_abc123',
  ];

  it.each(CANDIDATES)('an accepted %j never leaves our origin', (raw) => {
    const accepted = safeReturnPath(raw);
    if (accepted === null) return; // refused — nothing to check
    expect(new URL(accepted, ORIGIN).origin).toBe(ORIGIN);
    expect(new URL(accepted, ORIGIN).pathname.startsWith('//')).toBe(false);
  });

  it('refuses every off-site candidate in that list', () => {
    // Guards the test above against becoming vacuous: if a bypass started being
    // accepted, the origin assertion would catch it — but if EVERYTHING started
    // being refused, the suite would go green for the wrong reason.
    const offSite = CANDIDATES.filter(
      (c) => !c.startsWith('/dialer') && !c.startsWith('/station'),
    );
    for (const raw of offSite) expect(safeReturnPath(raw)).toBeNull();
    expect(safeReturnPath('/dialer')).toBe('/dialer');
  });
});

/**
 * The predicate the two 401 guards share.
 *
 * Both used to ask `pathname.startsWith('/login')`, which is `false` for
 * `/agency/login` — so the second door had no guard, and a 401 there reloaded the
 * page the user was standing on, wiping the form and replacing the real error with
 * a generic expiry notice. See the docstring on `isLoginPath`.
 */
describe('isLoginPath', () => {
  it.each(['/login', '/login/', '/LOGIN', '/agency/login', '/agency/login/', '/Agency/Login'])(
    'recognises %j as a sign-in page',
    (path) => {
      expect(isLoginPath(path)).toBe(true);
    },
  );

  it.each(['/agency/join/tok_abc123', '/agency/join', '/Agency/Join/tok_abc123'])(
    'covers the invite landing page %j too, which is what keeps its 401 survivable',
    (path) => {
      /*
        The invite page is not a sign-in page and belongs in this set anyway,
        because it fails the same way and worse. It is reached from an email BY
        SOMEBODY WITH NO ACCOUNT, and a 401 there is routine rather than
        exceptional: the API answers one for a Firebase token it will not accept,
        seconds after the visitor created their very first credential. Outside
        this set, that 401 makes both guards set
        `window.location.href = sessionExpiredLoginUrl()` — discarding the
        single-use token URL, which is the one thing on that screen the visitor
        cannot get back without asking their supervisor for another invite.
      */
      expect(isLoginPath(path)).toBe(true);
    },
  );

  it.each([
    '/loginish',
    '/agency/loginish',
    '/agency/joinery',
    '/agency',
    '/agency/campaigns',
    '/app',
    '/station',
  ])(
    'does not mistake %j for one',
    (path) => {
      // `startsWith('/login')` treated `/loginish` as the login page and suppressed
      // the bounce, leaving a 401 there on a dead page with no sign-in prompt.
      expect(isLoginPath(path)).toBe(false);
    },
  );
});

describe('loginPathReturningTo', () => {
  it('encodes the destination whole, so its query is not read as login’s own', () => {
    expect(loginPathReturningTo('/station?campaign=camp-1')).toBe(
      `${AGENCY_LOGIN_PATH}?${RETURN_PATH_PARAM}=%2Fstation%3Fcampaign%3Dcamp-1`,
    );
  });

  it('picks the door from the destination', () => {
    expect(loginPathReturningTo('/app/settings').startsWith(LOGIN_PATH)).toBe(true);
    expect(loginPathReturningTo('/dialer').startsWith(AGENCY_LOGIN_PATH)).toBe(true);
  });

  it('round-trips through safeReturnPath', () => {
    const original = '/agency/campaigns/abc?tab=stats#floor';
    const url = new URL(loginPathReturningTo(original), 'https://app.example');
    expect(safeReturnPath(url.searchParams.get(RETURN_PATH_PARAM))).toBe(original);
  });
});

describe('currentPath', () => {
  it('joins the three parts a destination needs', () => {
    expect(currentPath({ pathname: '/dialer', search: '?left=station', hash: '' })).toBe(
      '/dialer?left=station',
    );
  });

  it('tolerates absent search and hash', () => {
    expect(currentPath({ pathname: '/dialer' })).toBe('/dialer');
  });
});

describe('sessionExpiredLoginUrl', () => {
  /**
   * The commoner door. `RequireAuth` handles "never signed in"; this handles a
   * mid-shift 401 from the backend's six-hour expiry — which for an agent on a
   * station is the sign-out that actually happens, and which used to drop everyone
   * on `/app`.
   */
  const setLocation = (pathname: string, search = '', hash = '') => {
    Object.defineProperty(window, 'location', {
      value: { pathname, search, hash },
      writable: true,
      configurable: true,
    });
  };

  it('carries where the user was, alongside the expiry notice', () => {
    setLocation('/station', '?campaign=camp-1');

    const url = new URL(sessionExpiredLoginUrl(), 'https://app.x');

    // The agency door, because the session lapsed on an agency surface. This is
    // the entrance that matters most for the wrong-page failure: an agent
    // re-authenticating mid-shift with a customer waiting must not be met by the
    // primary app's signup pitch.
    expect(url.pathname).toBe(AGENCY_LOGIN_PATH);
    expect(url.searchParams.get('session')).toBe('expired');
    expect(url.searchParams.get(RETURN_PATH_PARAM)).toBe('/station?campaign=camp-1');
  });

  it('uses the primary door when the session lapsed on a platform surface', () => {
    setLocation('/app/settings');

    const url = new URL(sessionExpiredLoginUrl(), 'https://app.x');

    expect(url.pathname).toBe(LOGIN_PATH);
    expect(url.searchParams.get(RETURN_PATH_PARAM)).toBe('/app/settings');
  });

  it('picks the door from the pathname even when there is no return path to carry', () => {
    /*
      The door is chosen from `window.location.pathname`, not from `next` — and
      these are exactly the cases where `next` is absent, so a rule that read
      `next` would hand an agent the primary page precisely when their station URL
      had been refused. `/..//evil.example` is not an agency surface, so the
      primary door is right here; what is being pinned is that the choice still
      HAPPENS with no param in play.
    */
    setLocation('/agency/login', '?session=expired');
    expect(new URL(sessionExpiredLoginUrl(), 'https://app.x').pathname).toBe(AGENCY_LOGIN_PATH);
    expect(new URL(sessionExpiredLoginUrl(), 'https://app.x').searchParams.has(RETURN_PATH_PARAM)).toBe(false);
  });

  it('keeps the expiry notice when there is nothing safe to return to', () => {
    // Already on /login: a return path here would loop. The notice still has to
    // render, so the param is omitted rather than the whole URL changed.
    setLocation('/login', '?session=expired');

    const url = new URL(sessionExpiredLoginUrl(), 'https://app.x');

    expect(url.searchParams.get('session')).toBe('expired');
    expect(url.searchParams.has(RETURN_PATH_PARAM)).toBe(false);
  });

  it('routes the current URL through the same guard', () => {
    // The current location is normally trustworthy, but it is still user-controlled
    // (anyone can be sent a crafted link), so it goes through `safeReturnPath` like
    // any other candidate rather than being trusted for being "ours".
    setLocation('/..//evil.example');

    const url = new URL(sessionExpiredLoginUrl(), 'https://app.x');

    expect(url.searchParams.has(RETURN_PATH_PARAM)).toBe(false);
  });
});
