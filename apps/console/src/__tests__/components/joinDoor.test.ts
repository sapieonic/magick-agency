import { describe, it, expect } from 'vitest';
import { matchRoutes } from 'react-router-dom';
import { ROLES } from '@magick-agency/contracts/rbac';
import { JOIN_DOORS, joinDoorFor, joinPathFor } from '../../components/agency/join/joinDoor';
import { RETURN_PATH_PARAM, safeReturnPath } from '../../utils/returnPath';

/**
 * Which invite page a role belongs on, and what each page says.
 *
 * The rule is the console's half of the one the server applies when it builds the
 * emailed link: an `agent` to `/agency/join/:token`, every other role to
 * `/join/:token`. The two sides cannot import each other, so a divergence shows
 * up as a forward between the pages rather than a stranded invitation — but only
 * if every role maps to exactly one door, which is what this pins.
 */
describe('joinDoorFor', () => {
  it.each(ROLES)('sends a %s to exactly one door', (role) => {
    expect(joinDoorFor(role)).toBe(role === 'agent' ? 'agency' : 'workspace');
  });
});

describe('joinPathFor', () => {
  it('re-files a token under the door its role belongs on', () => {
    expect(joinPathFor('agency', 'tok_abc')).toBe('/agency/join/tok_abc');
    expect(joinPathFor('workspace', 'tok_abc')).toBe('/join/tok_abc');
  });

  it('encodes the token, so a stray ? or # cannot truncate it', () => {
    expect(joinPathFor('workspace', 'a?b#c')).toBe('/join/a%3Fb%23c');
  });

  it('builds paths the two routes actually match', () => {
    // Asserted with the real matcher against the paths `App.tsx` declares, so a
    // route renamed on one side cannot leave the forward pointing at a 404.
    const routes = [{ path: '/agency/join/:token' }, { path: '/join/:token' }];
    expect(matchRoutes(routes, joinPathFor('agency', 'tok'))?.[0]?.route.path).toBe('/agency/join/:token');
    expect(matchRoutes(routes, joinPathFor('workspace', 'tok'))?.[0]?.route.path).toBe('/join/:token');
  });
});

describe('JOIN_DOORS', () => {
  it('points each door at its own sign-in page', () => {
    // An agent belongs at the agency door; anybody else at `/login`, which is the
    // shell they are joining. Swapped, an operator is sold a dialer and an agent a
    // shell with nothing in it.
    expect(JOIN_DOORS.agency.signInPath('/dialer')).toBe('/agency/login');
    expect(new URL(JOIN_DOORS.workspace.signInPath('/app'), 'https://x.invalid').pathname).toBe('/login');
  });

  it('brings a workspace sign-in back to the page\'s own landing, not to the dialer', () => {
    /*
      `/login` renders `AgencyLoginPage`, which lands on
      `safeReturnPath(next) ?? '/agency'`. A bare `/login` therefore sent an
      operator who pressed "Sign in instead" or "Go to sign in" into `/agency` —
      the capability-unavailable page at a tenant without the dialer. Read back
      through the login page's own validator, so a `next` it would refuse fails
      here too rather than silently falling back to `/agency`. (Which landing
      `JoinPage` hands in — `/app` — is pinned by `JoinPage.test.tsx`.)
    */
    const url = new URL(JOIN_DOORS.workspace.signInPath('/app'), 'https://x.invalid');
    expect(safeReturnPath(url.searchParams.get(RETURN_PATH_PARAM))).toBe('/app');
  });

  it('never calls a workspace invitation the dialer', () => {
    expect(JOIN_DOORS.workspace.eyebrow).not.toMatch(/dialer|agency/i);
    expect(JOIN_DOORS.agency.eyebrow).toBe('Agency Dialer');
  });
});
