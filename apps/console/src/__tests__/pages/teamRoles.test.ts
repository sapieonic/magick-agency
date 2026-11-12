import { describe, it, expect } from 'vitest';
import { PERMISSIONS, ROLES, canManageRole, hasPermission, type Permission, type Role } from '@magick-agency/contracts/rbac';
import { CHANGE_ROLES, INVITE_ROLES, ROLE_DESCRIPTIONS } from '../../pages/team/teamRoles';

/**
 * Each role's one-line description (shown where a role is picked) says only what the role can
 * do by the contract's permission table (decision AA7). Every phrase a line may use is a claim,
 * and each claim is checked against the permissions the role holds, so a line that says a role
 * takes calls is wrong unless it holds `agency.station.connect`, and one that says it can't
 * change campaigns is wrong if it holds `agency.campaigns.write`.
 */

const holds = (role: Role, ...permissions: Permission[]) => permissions.every((p) => hasPermission(role, p));
const holdsNone = (role: Role, ...permissions: Permission[]) => permissions.every((p) => !hasPermission(role, p));
const sameAs = (role: Role, other: Role) => PERMISSIONS.every((p) => hasPermission(role, p) === hasPermission(other, p));
const covers = (role: Role, other: Role) => PERMISSIONS.every((p) => !hasPermission(other, p) || hasPermission(role, p));

/** A phrase a description may use, and what must then be true of the role. */
const CLAIMS: Array<{ phrase: RegExp; truth: (role: Role) => boolean }> = [
  { phrase: /take(s)? calls/i, truth: (r) => holds(r, 'agency.station.connect', 'agency.attempts.handle', 'agency.attempts.dispose') },
  { phrase: /follows up their own missed calls/, truth: (r) => holds(r, 'agency.inbound.read') },
  { phrase: /look up a customer’s past calls/, truth: (r) => holds(r, 'agency.customer_history.read') },
  { phrase: /Sees nothing else/, truth: (r) => holdsNone(r, 'agency.campaigns.read', 'tenant.read', 'agency.dnc.read') },
  { phrase: /sees campaigns, results and the Do Not Call list/i, truth: (r) => holds(r, 'agency.campaigns.read', 'agency.dnc.read') },
  {
    phrase: /Can’t change campaigns or settings/,
    truth: (r) => holdsNone(r, 'agency.campaigns.write', 'agency.softphone.manage', 'agency.inbound.write', 'agency.analysis_profiles.write'),
  },
  { phrase: /Runs campaigns and live calls/, truth: (r) => holds(r, 'agency.campaigns.write', 'agency.supervise') },
  {
    phrase: /edits the account’s settings and the Do Not Call list/,
    truth: (r) => holds(r, 'agency.softphone.manage', 'agency.inbound.write', 'agency.analysis_profiles.write', 'agency.dnc.manage'),
  },
  { phrase: /invites people/, truth: (r) => holds(r, 'user.invite') },
  { phrase: /create accounts/, truth: (r) => holds(r, 'account.create') },
  { phrase: /change people’s roles and remove them/, truth: (r) => holds(r, 'user.update_role', 'user.remove') },
  { phrase: /Everything a supervisor does/, truth: (r) => covers(r, 'account_admin') },
  { phrase: /Everything an admin does/, truth: (r) => covers(r, 'tenant_admin') },
  { phrase: /can change or remove admins/, truth: (r) => canManageRole(r, 'tenant_admin') && holds(r, 'user.update_role', 'user.remove') },
  { phrase: /The same as Viewer/, truth: (r) => sameAs(r, 'viewer') },
];

/** The words a line may join its claims with. */
const JOINERS = new Set(['and', 'can', 'Can', 'too', 'also']);

/** What is left of a line with every phrase a claim knows taken out, joining words aside. */
function unclaimed(text: string): string[] {
  const rest = CLAIMS.reduce((left, { phrase }) => left.replace(new RegExp(phrase.source, `${phrase.flags}g`), ' '), text);
  return rest.split(/[\s,.:]+/).filter((word) => word !== '' && !JOINERS.has(word));
}

describe('what each role is described as doing', () => {
  it.each(ROLES)('%s: every claim its line makes holds in the permission table', (role) => {
    const text = ROLE_DESCRIPTIONS[role];
    const made = CLAIMS.filter(({ phrase }) => phrase.test(text));
    expect(made.length).toBeGreaterThan(0);
    for (const { phrase, truth } of made) {
      expect({ role, phrase: phrase.source, holds: truth(role) }).toEqual({ role, phrase: phrase.source, holds: true });
    }
  });

  it.each(ROLES)('%s: its line says nothing the claims do not check', (role) => {
    expect(unclaimed(ROLE_DESCRIPTIONS[role])).toEqual([]);
  });

  it('describes Viewer and Operator alike, because they are the same in the table (AA7)', () => {
    expect(sameAs('operator', 'viewer')).toBe(true);
    expect(ROLE_DESCRIPTIONS.operator).toBe(`The same as Viewer: ${ROLE_DESCRIPTIONS.viewer.charAt(0).toLowerCase()}${ROLE_DESCRIPTIONS.viewer.slice(1)}`);
  });

  it('describes every role either picker offers', () => {
    for (const { value } of [...INVITE_ROLES, ...CHANGE_ROLES]) expect(ROLE_DESCRIPTIONS[value]).toBeTruthy();
  });
});
