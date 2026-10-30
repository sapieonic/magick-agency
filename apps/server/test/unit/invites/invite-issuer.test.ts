import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `issueInvite` — mint the token, write the row, send the mail
 * (`src/invites/invite-issuer.ts`).
 *
 * ── Why this exists as its own unit ────────────────────────────────────────
 * Two routes issue invitations: `POST /users/invite` (the first one) and
 * `POST /invites/resend` (every one after). They must produce IDENTICAL
 * artefacts — the same token shape, TTL, join URL, template and counter
 * increment — because a resend that differed in any of them would be a second,
 * subtly different onboarding path that only surfaces when a customer uses it,
 * i.e. when somebody is already having trouble.
 *
 * ── The counters are the point of half these cases ─────────────────────────
 * The invite route answers **201 on every mail outcome** by design: the
 * membership is the durable fact and the email is an accelerant. So
 * `api_requests_total{status}` cannot carry the outcome — every one of these
 * requests is a 201 — and `inviteEmailsTotal` is the only signal that a revoked
 * Mailjet key has stopped every invite. For anybody without an account that
 * mail is their ONLY route in, so the failure mode is a whole dialing floor — or
 * a new workspace's admins — invited and never arriving, with every dashboard
 * green.
 *
 * ── Every role, enumerated from `ROLES` ────────────────────────────────────
 * The production defect was a predicate that answered `agent` only: every other
 * role got no token, no row and no mail. The cases that pin the fix iterate the
 * contract's `ROLES` rather than a hand-written list, so a role added there is
 * covered here without anybody remembering to add it.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const MEMBERSHIP = '22222222-2222-4222-8222-222222222222';
const INVITER = '33333333-3333-4333-8333-333333333333';

const mocks = vi.hoisted(() => ({
  createSupersedingOutstanding: vi.fn(),
  tenantFindById: vi.fn(),
  userFindById: vi.fn(),
  mintInviteToken: vi.fn(),
  inviteSignInUrl: vi.fn(),
  sendInviteEmail: vi.fn(),
  promInc: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../src/db/repositories/membership-invite.repository.js', () => ({
  membershipInviteRepository: {
    createSupersedingOutstanding: mocks.createSupersedingOutstanding,
  },
}));
vi.mock('@magick-agency/db/repositories/tenant.repository', () => ({
  tenantRepository: { findById: mocks.tenantFindById },
}));
vi.mock('@magick-agency/db/repositories/user.repository', () => ({
  userRepository: { findById: mocks.userFindById },
}));
vi.mock('../../../src/notifications/invite-token.js', () => ({
  mintInviteToken: mocks.mintInviteToken,
}));
vi.mock('../../../src/notifications/invite-mailer.js', () => ({
  inviteSignInUrl: mocks.inviteSignInUrl,
  sendInviteEmail: mocks.sendInviteEmail,
}));
vi.mock('@magick-agency/observability/metrics/platform', () => ({
  inviteEmailsTotal: { inc: mocks.promInc },
}));
vi.mock('@magick-agency/observability', () => ({ createChildLogger: () => mocks.log }));

import { issueInvite } from '../../../src/invites/invite-issuer.js';
import { ROLES } from '@magick-agency/contracts/rbac';

const MINTED = {
  token: 'tok-1',
  tokenHash: 'hash-1',
  expiresAt: new Date('2026-01-08T00:00:00Z'),
};

const BASE = {
  membershipId: MEMBERSHIP,
  tenantId: TENANT,
  email: 'newagent@acme.test',
  role: 'agent' as const,
  invitedBy: INVITER,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.mintInviteToken.mockResolvedValue(MINTED);
  mocks.createSupersedingOutstanding.mockImplementation(async (input: any) => ({ id: 'invite-1', ...input }));
  mocks.tenantFindById.mockResolvedValue({ id: TENANT, name: 'Acme Collections' });
  mocks.userFindById.mockResolvedValue({ id: INVITER, display_name: 'Priya Sharma' });
  mocks.inviteSignInUrl.mockResolvedValue('https://app.example.com/agency/join/tok-1');
  mocks.sendInviteEmail.mockResolvedValue({ sent: true, messageId: null });
});

describe('issueInvite for an agent', () => {
  it('stores only the HASH, with the minted expiry and the inviter', async () => {
    const result = await issueInvite(BASE);

    expect(mocks.createSupersedingOutstanding).toHaveBeenCalledWith({
      membership_id: MEMBERSHIP,
      tenant_id: TENANT,
      email: 'newagent@acme.test',
      role: 'agent',
      token_hash: 'hash-1',
      expires_at: MINTED.expiresAt,
      invited_by: INVITER,
    });
    // The raw token reaches the URL and nothing else — never the row.
    expect(JSON.stringify(mocks.createSupersedingOutstanding.mock.calls[0])).not.toContain('tok-1');
    expect(result.invite).toMatchObject({ id: 'invite-1' });
  });

  it('writes the row BEFORE sending — the recoverable failure is the right one', async () => {
    /**
     * A token that has been mailed but not stored is unredeemable: the recipient
     * holds a link that resolves to nothing, and neither they nor the supervisor
     * can tell that from a typo'd address. A token stored but not mailed is
     * merely unused — `POST /invites/resend` revokes it and issues another.
     */
    const order: string[] = [];
    mocks.createSupersedingOutstanding.mockImplementation(async (input: any) => { order.push('row'); return { id: 'i', ...input }; });
    mocks.sendInviteEmail.mockImplementation(async () => { order.push('mail'); return { sent: true, messageId: null }; });

    await issueInvite(BASE);

    expect(order).toEqual(['row', 'mail']);
  });

  it('resolves the URL ONCE and hands the same value to the mail and the caller', async () => {
    // An email whose link disagrees with the one the supervisor is looking at on
    // screen is unfalsifiable from a bug report.
    const result = await issueInvite(BASE);

    expect(mocks.inviteSignInUrl).toHaveBeenCalledWith('agent', 'tok-1');
    expect(result.signInUrl).toBe('https://app.example.com/agency/join/tok-1');
    expect(mocks.sendInviteEmail.mock.calls[0]![0].signInUrl).toBe(result.signInUrl);
  });

  it('passes the tenant name, the inviter and the expiry to the mailer', async () => {
    await issueInvite(BASE);

    expect(mocks.sendInviteEmail.mock.calls[0]![0]).toMatchObject({
      tenantName: 'Acme Collections',
      inviterName: 'Priya Sharma',
      expiresAt: MINTED.expiresAt,
    });
  });

  it('never sends the inviter’s ADDRESS as their name', async () => {
    /**
     * `display_name` only. Naming a supervisor's email to somebody who is not yet
     * a member of anything would disclose it outside the tenant, and the template
     * already has a sentence for the unnamed case that reads correctly rather
     * than inventing an actor.
     */
    mocks.userFindById.mockResolvedValue({ id: INVITER, display_name: null, email: 'priya@acme.test' });

    await issueInvite(BASE);

    expect(mocks.sendInviteEmail.mock.calls[0]![0].inviterName).toBeNull();
  });

  it('still sends when the tenant name cannot be resolved', async () => {
    /**
     * One word of context in one sentence. An invited agent's only route into the
     * product must not be blocked by a `tenants` lookup — the same fail-open
     * reasoning `resolveGovernanceSafe` uses for login.
     */
    mocks.tenantFindById.mockRejectedValue(new Error('db down'));

    const result = await issueInvite(BASE);

    expect(result.inviteEmail).toEqual({ sent: true, messageId: null });
    expect(mocks.sendInviteEmail.mock.calls[0]![0].tenantName).toBeNull();
    expect(mocks.log.warn).toHaveBeenCalled();
  });

  it('still sends when the inviter cannot be resolved', async () => {
    mocks.userFindById.mockRejectedValue(new Error('db down'));

    const result = await issueInvite(BASE);

    expect(result.inviteEmail).toEqual({ sent: true, messageId: null });
    expect(mocks.sendInviteEmail.mock.calls[0]![0].inviterName).toBeNull();
  });

  it('does not look up an inviter it was not given', async () => {
    await issueInvite({ ...BASE, invitedBy: null });

    expect(mocks.userFindById).not.toHaveBeenCalled();
    expect(mocks.createSupersedingOutstanding.mock.calls[0]![0].invited_by).toBeNull();
  });
});

describe('issueInvite for every role', () => {
  it.each(ROLES)('mints a token, writes the row and mails %s', async (role) => {
    /**
     * The same artefact for every role — that is the whole fix. This module used
     * to issue a token only where a `roleGetsTokenInvite` switch answered
     * `role === 'agent'`; every other role got no token, no row and no mail. The
     * switch is gone, so this sweep is what pins every role to the row, the URL
     * and the mail. The ROLE travels
     * into the row (so `GET /invites/:token` can name it and the claim activates
     * exactly that membership), into the URL resolution (which picks the claim
     * page) and into the mail (which picks the invitation's wording). Nothing
     * else about the issue differs.
     */
    const url = role === 'agent'
      ? 'https://app.example.com/agency/join/tok-1'
      : 'https://app.example.com/join/tok-1';
    mocks.inviteSignInUrl.mockResolvedValue(url);

    const result = await issueInvite({ ...BASE, email: `${role}@acme.test`, role });

    expect(mocks.mintInviteToken).toHaveBeenCalledTimes(1);
    expect(mocks.createSupersedingOutstanding).toHaveBeenCalledWith({
      membership_id: MEMBERSHIP,
      tenant_id: TENANT,
      email: `${role}@acme.test`,
      role,
      token_hash: 'hash-1',
      expires_at: MINTED.expiresAt,
      invited_by: INVITER,
    });
    // The TOKEN is what reaches the URL rule — never `undefined`, which is the
    // `/login` fallback this defect consisted of.
    expect(mocks.inviteSignInUrl).toHaveBeenCalledWith(role, 'tok-1');
    expect(mocks.sendInviteEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendInviteEmail.mock.calls[0]![0]).toMatchObject({
      email: `${role}@acme.test`,
      role,
      tenantId: TENANT,
      signInUrl: url,
      tenantName: 'Acme Collections',
      inviterName: 'Priya Sharma',
      expiresAt: MINTED.expiresAt,
    });
    expect(result).toEqual({
      invite: expect.objectContaining({ id: 'invite-1', role }),
      signInUrl: url,
      inviteEmail: { sent: true, messageId: null },
    });
    expect(mocks.promInc).toHaveBeenCalledWith({ role, result: 'sent' });
  });

  it.each(ROLES)('writes the row BEFORE mailing %s', async (role) => {
    // The ordering argument in the agent block holds for every role: a mailed
    // but unstored token is unredeemable; a stored but unmailed one is resendable.
    const order: string[] = [];
    mocks.createSupersedingOutstanding.mockImplementation(async (input: any) => { order.push('row'); return { id: 'i', ...input }; });
    mocks.sendInviteEmail.mockImplementation(async () => { order.push('mail'); return { sent: true, messageId: null }; });

    await issueInvite({ ...BASE, role });

    expect(order).toEqual(['row', 'mail']);
  });
});

describe('the outcome counters', () => {
  it.each([
    [{ sent: true, messageId: null }, 'sent'],
    [{ sent: false, reason: 'not_configured' }, 'not_configured'],
    [{ sent: false, reason: 'failed' }, 'failed'],
  ])('records %j as result=%s', async (mailResult, label) => {
    /**
     * Every outcome, always — a code path that records none has produced a
     * metric nothing can alert on, which is the exact blind spot this counter
     * exists to close. (One instrument feeds both the local scrape and Grafana.)
     */
    mocks.sendInviteEmail.mockResolvedValue(mailResult);

    await issueInvite(BASE);

    expect(mocks.promInc).toHaveBeenCalledWith({ role: 'agent', result: label });
  });

  it('labels by ROLE, so a failure confined to one invitation is visible', async () => {
    /**
     * The agent and workspace invitations are different templates, so one can
     * break while the other sends. Without the label the two lines are summed
     * and a broken workspace mail hides under a healthy dialing floor — which is
     * what the `not_implemented` baseline used to do to the agent line, the other
     * way round.
     */
    mocks.sendInviteEmail.mockResolvedValue({ sent: false, reason: 'failed' });

    await issueInvite({ ...BASE, role: 'operator' });

    expect(mocks.promInc).toHaveBeenCalledWith({ role: 'operator', result: 'failed' });
  });

  it('counts a mailer that REJECTS, and reports it as failed without throwing', async () => {
    /**
     * `sendInviteEmail` is documented total and is guarded anyway. What the guard
     * protects is not the request — the route wraps this whole module — but
     * `signInUrl`: a throw past this point would leave `sign_in_url: null` on a
     * response where the URL had already resolved, taking away the link the
     * supervisor needs in order to hand it over by hand. That fallback is the one
     * thing that still works when mail does not.
     */
    mocks.sendInviteEmail.mockRejectedValue(new Error('transport exploded'));

    const result = await issueInvite(BASE);

    expect(result.inviteEmail).toEqual({ sent: false, reason: 'failed' });
    expect(result.signInUrl).toBe('https://app.example.com/agency/join/tok-1');
    expect(result.invite).toMatchObject({ id: 'invite-1' });
    expect(mocks.promInc).toHaveBeenCalledWith({ role: 'agent', result: 'failed' });
    expect(mocks.log.error).toHaveBeenCalled();
  });

  it('leaves a DATABASE failure to the caller rather than reporting a reason', async () => {
    /**
     * Deliberately not swallowed, because the two callers owe their users
     * different answers: `POST /users/invite` has already written a membership
     * and must still answer 201 (its own try/catch guarantees that), while
     * `POST /invites/resend` has written nothing and should answer 500 so the
     * supervisor knows to press the button again. A returned reason here would
     * make the second one lie.
     *
     * `LiveInviteConflictError` — the loser of two concurrent resends, refused by
     * the partial unique index — travels the same way and is caught by name in
     * the resend route, which turns it into a 409. What matters on THIS side is
     * the line below: nothing is mailed when the row was not written, so a race
     * cannot put two links in one inbox.
     */
    mocks.createSupersedingOutstanding.mockRejectedValue(new Error('insert failed'));

    await expect(issueInvite(BASE)).rejects.toThrow('insert failed');
    expect(mocks.sendInviteEmail).not.toHaveBeenCalled();
    expect(mocks.promInc).not.toHaveBeenCalled();
  });
});
