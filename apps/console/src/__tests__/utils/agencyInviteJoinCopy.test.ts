import { describe, it, expect } from 'vitest';
import {
  ROLE_LABELS,
  STRENGTH_LABELS,
  UNAVAILABLE_COPY,
  WORKSPACE_UNAVAILABLE_COPY,
  analyticsRole,
  assessPassword,
  credentialMessage,
  firebaseCode,
  roleLabel,
  sameAddress,
} from '../../utils/agencyInviteJoinCopy';
import type { Role } from '../../types/auth';
import { ROLES } from '@magick-agency/contracts/rbac';
import type { InviteUnavailableStatus } from '../../types/invite';

/**
 * The invite page's pure rules, each on its own. `AgencyJoinPage.test.tsx` still
 * drives them through the page; these pin the edges a page test would have to
 * stage a whole flow to reach.
 */

const fbError = (code: string, message = `Firebase: Error (${code}).`) =>
  Object.assign(new Error(message), { code });

describe('roleLabel / analyticsRole', () => {
  it('labels every role, and a role the client has never heard of as itself', () => {
    for (const role of Object.keys(ROLE_LABELS) as Role[]) {
      expect(roleLabel(role)).toBe(ROLE_LABELS[role]);
    }
    expect(roleLabel('agent')).toBe('Agent');
    expect(roleLabel('supervisor_next_year' as Role)).toBe('supervisor_next_year');
  });

  it.each(ROLES)('reports %s to the invite funnels as itself', (role) => {
    // `tenant_owner` included: a super admin's tenant create invites the owner,
    // and this answered `null` for them on the belief that no invite could.
    expect(analyticsRole(role)).toBe(role);
  });
});

describe('sameAddress', () => {
  it('ignores case and surrounding space', () => {
    expect(sameAddress('  Priya@Acme.com ', 'priya@acme.com')).toBe(true);
  });

  it('does NOT fold Gmail dots or +tags — the server matches the exact string', () => {
    expect(sameAddress('p.riya@gmail.com', 'priya@gmail.com')).toBe(false);
    expect(sameAddress('priya+work@gmail.com', 'priya@gmail.com')).toBe(false);
  });

  it('is false with no address at all', () => {
    expect(sameAddress(null, 'priya@acme.com')).toBe(false);
  });
});

describe('firebaseCode / credentialMessage', () => {
  it('reads the stable code, never the localised message', () => {
    expect(firebaseCode(fbError('auth/wrong-password'))).toBe('auth/wrong-password');
    expect(firebaseCode({ code: 7 })).toBe('');
    expect(firebaseCode('auth/wrong-password')).toBe('');
    expect(firebaseCode(null)).toBe('');
  });

  it.each([
    ['auth/wrong-password', 'That password does not match this address. Try again, or use Google instead.'],
    ['auth/invalid-credential', 'That password does not match this address. Try again, or use Google instead.'],
    ['auth/user-not-found', 'That address has no password yet. Create one below.'],
    ['auth/too-many-requests', 'Too many attempts. Wait a minute and try again.'],
    ['auth/popup-closed-by-user', 'The Google window closed before you finished. Try again.'],
    ['auth/popup-blocked', 'Your browser blocked the Google window. Allow pop-ups for this site, or create a password instead.'],
    ['auth/network-request-failed', 'We could not reach the network. Check your connection and try again.'],
    ['auth/weak-password', 'That password is too easy to guess. Make it longer.'],
  ])('%s reads as a sentence', (code, sentence) => {
    expect(credentialMessage(fbError(code))).toBe(sentence);
  });

  it('passes an unrecognised failure through as itself — quotable beats generic', () => {
    expect(credentialMessage(new Error('Something specific broke'))).toBe('Something specific broke');
  });
});

describe('assessPassword', () => {
  const EMAIL = 'priya@acme.com';

  it('asks for a password, then counts down to the floor of eight', () => {
    expect(assessPassword('', EMAIL)).toEqual({ score: 0, blocker: 'Choose a password.', hint: 'At least 8 characters.' });
    expect(assessPassword('abcdefg', EMAIL).blocker).toBe('At least 8 characters — 1 to go.');
    expect(assessPassword('abcdefgh', EMAIL).blocker).toBeNull();
  });

  it('refuses the address’s own local part, whatever the case', () => {
    const a = assessPassword('PRIYA2026!', EMAIL);
    expect(a.blocker).toBe('That contains your own address. Pick something unrelated to it.');
    expect(a.score).toBe(1);
  });

  it('does not apply the address rule to a local part under three characters', () => {
    expect(assessPassword('xyabcdefgh', 'xy@acme.com').blocker).toBeNull();
  });

  it('scores above the floor as advice, never as a refusal', () => {
    // Long, mixed case, a digit and a symbol: every rung.
    const strong = assessPassword('Tangerine-Lamp-42', EMAIL);
    expect(strong).toEqual({
      score: 4,
      blocker: null,
      hint: 'Strong enough. You will not be asked for it again on this device.',
    });
    // Eight lowercase letters: allowed, and pointed at length first.
    const plain = assessPassword('lanterns', EMAIL);
    expect(plain.blocker).toBeNull();
    expect(plain.score).toBe(1);
    expect(plain.hint).toBe('Longer is the easiest way to make this stronger — try three unrelated words.');
    // Long but one class: pointed at a number or symbol.
    expect(assessPassword('lanternsandlamps', EMAIL).hint).toBe('Add a number or a symbol to make this stronger.');
  });

  it('has a label for every score the meter can show', () => {
    expect(STRENGTH_LABELS).toHaveLength(5);
  });
});

describe('UNAVAILABLE_COPY', () => {
  it('gives every status its own title, and a sign-in only where signing in is the remedy', () => {
    const statuses: InviteUnavailableStatus[] = ['expired', 'claimed', 'revoked', 'not_found', 'identity_already_bound'];
    const titles = new Set(statuses.map((s) => UNAVAILABLE_COPY[s].title));
    expect(titles.size).toBe(statuses.length);
    expect(statuses.filter((s) => UNAVAILABLE_COPY[s].action === 'sign_in')).toEqual([
      'claimed',
      'identity_already_bound',
    ]);
  });
});

describe('WORKSPACE_UNAVAILABLE_COPY', () => {
  const statuses: InviteUnavailableStatus[] = ['expired', 'claimed', 'revoked', 'not_found', 'identity_already_bound'];

  it('cures the same statuses by signing in as the agency page does', () => {
    // The facts and remedies are the page-independent half; only the sentences
    // differ. A status that sends an agent to sign in and leaves an operator with
    // nothing to press would be the two pages disagreeing about the server.
    for (const status of statuses) {
      expect(WORKSPACE_UNAVAILABLE_COPY[status].action).toBe(UNAVAILABLE_COPY[status].action);
    }
    const titles = new Set(statuses.map((s) => WORKSPACE_UNAVAILABLE_COPY[s].title));
    expect(titles.size).toBe(statuses.length);
  });

  it('promises no station and names no supervisor', () => {
    // An operator or an account admin has neither. The agency table's "your
    // station will open" and "ask your supervisor" are wrong on this page.
    for (const status of statuses) {
      const { title, body } = WORKSPACE_UNAVAILABLE_COPY[status];
      expect(`${title} ${body}`).not.toMatch(/station|supervisor|dialer|agent/i);
    }
  });
});
