import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ issueInvite: vi.fn(), error: vi.fn() }));
vi.mock('../../../src/invites/invite-issuer.js', () => ({ issueInvite: mocks.issueInvite }));
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.error, debug: vi.fn() }),
}));

import {
  isDemotionFromAgent,
  issueInviteReportingFailure,
  pendingStubUid,
  unverifiedAddressHolderBody,
} from '../../../src/invites/membership-provisioning.js';
import { PENDING_UID_PREFIX, UNVERIFIED_ADDRESS_HOLDER } from '../../../src/auth/firebase-identity.js';

/**
 * The pure halves of the membership-provisioning service. Its three writes are exercised
 * through the routes against real Postgres (`test/integration/api/user.routes.test.ts`,
 * `super-admin.routes.test.ts`, `invite-security-audit.test.ts`,
 * `platform-onboarding.e2e.test.ts`) and against a doubled client in
 * `test/unit/api/routes/super-admin-memberships.test.ts`.
 */
const INPUT = { membershipId: 'm1', tenantId: 't1', email: 'a@b.test', role: 'agent' as const, invitedBy: null };

beforeEach(() => vi.clearAllMocks());

describe('issueInviteReportingFailure', () => {
  it('reports what issueInvite issued', async () => {
    mocks.issueInvite.mockResolvedValue({
      invite: { id: 'inv-1' }, signInUrl: 'https://x/join/t', inviteEmail: { sent: true },
    });
    await expect(issueInviteReportingFailure(INPUT, 'u1')).resolves.toEqual({
      signInUrl: 'https://x/join/t', inviteEmail: { sent: true }, inviteId: 'inv-1',
    });
  });

  it('a role with no token reports no invite id', async () => {
    mocks.issueInvite.mockResolvedValue({ invite: null, signInUrl: null, inviteEmail: { sent: true } });
    expect((await issueInviteReportingFailure(INPUT, 'u1')).inviteId).toBeNull();
  });

  it('never throws: a throw is logged at ERROR and reported as an unsent invite', async () => {
    mocks.issueInvite.mockRejectedValue(new Error('mail provider down'));
    await expect(issueInviteReportingFailure(INPUT, 'u1')).resolves.toEqual({
      signInUrl: null, inviteEmail: { sent: false, reason: 'failed' }, inviteId: null,
    });
    expect(mocks.error).toHaveBeenCalledWith(
      { tenantId: 't1', invitedUserId: 'u1', err: 'mail provider down' },
      'Invite issuance threw; the membership stands and the invite is reported unsent',
    );
  });
});

describe('the shared refusals and predicates', () => {
  it('unverifiedAddressHolderBody names the caller\'s own next step', () => {
    expect(unverifiedAddressHolderBody('add them again')).toEqual({
      error: 'Conflict',
      code: UNVERIFIED_ADDRESS_HOLDER,
      message: 'That email belongs to an account that has not verified this address. '
        + 'Ask them to sign in and verify it, then add them again.',
    });
  });

  it('isDemotionFromAgent is true only for a change AWAY from agent', () => {
    expect(isDemotionFromAgent('agent', 'viewer')).toBe(true);
    expect(isDemotionFromAgent('viewer', 'agent')).toBe(false);
    expect(isDemotionFromAgent('agent', 'agent')).toBe(false);
    expect(isDemotionFromAgent('operator', 'account_admin')).toBe(false);
  });

  it('pendingStubUid uses the shared prefix and a fresh uuid each time', () => {
    const a = pendingStubUid();
    expect(a).toMatch(new RegExp(`^${PENDING_UID_PREFIX}[0-9a-f-]{36}$`));
    expect(pendingStubUid()).not.toBe(a);
  });
});
