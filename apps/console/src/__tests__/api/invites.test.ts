import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The two public invite endpoints, and the boundary they sit on.
 *
 * ── What is worth pinning here ────────────────────────────────────────────
 * Not that `fetch` was called. Three things, each of which is a way agency
 * onboarding fails rather than a way the code could be rearranged:
 *
 *  1. **Master's conflicts are told apart.** `claimed` / `expired` / `revoked` /
 *     `not_found` / `identity_already_bound` mean the INVITATION cannot be used
 *     and the page switches to that status's screen. `identity_in_use` means the
 *     ACCOUNT cannot be used and the invitation is untouched — master leaves it
 *     outstanding on purpose — so it must not switch screens, because the screen
 *     it would leave carries the only control that signs out.
 *  2. **A modelled outcome is not an API error.** These endpoints answer 404 and
 *     409 in ordinary use; reporting those to the `api_error` funnel would bury a
 *     real outage under a stream of expired invitations.
 *  3. **The token is not in what IS reported.** The URL carries a live invite
 *     token, and `captureApiError` sends its path to PostHog.
 */

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  trackApiErrorEvent: vi.fn(),
  apiFetch: vi.fn(),
}));

vi.stubGlobal('fetch', mocks.fetch);

vi.mock('../../analytics/events', () => ({
  trackApiErrorEvent: mocks.trackApiErrorEvent,
}));

vi.mock('../../api/client', () => ({
  apiFetch: mocks.apiFetch,
}));

import {
  getInvite,
  claimInvite,
  resendInvite,
  InviteIdentityInUseError,
  InviteUnavailableError,
} from '../../api/invites';

/** 43 base64url characters, the shape master mints. */
const TOKEN = 'Xk8sQ2vLp7NmR4tYwZ1aB3cD5eF6gH9jK0lM2nO4pQ6';

const INVITE = {
  email: 'priya@acme.com',
  role: 'agent',
  tenant_name: 'Acme Collections',
  inviter_name: 'Priya Sharma',
  product_name: 'Magick Agency Dialer',
  expires_at: '2026-09-12T09:00:00.000Z',
};

/**
 * A fresh `Response` per call, not one shared object: a body can only be read
 * once, so a `mockResolvedValue` would answer the second call of a test with an
 * already-consumed stream and silently take a different branch.
 */
function respondWith(status: number, body: unknown): void {
  mocks.fetch.mockImplementation(async () => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'x-request-id': 'req-1' },
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getInvite', () => {
  it('reads a pending invitation', async () => {
    respondWith(200, { status: 'pending', invite: INVITE });

    await expect(getInvite(TOKEN)).resolves.toEqual({ status: 'pending', invite: INVITE });
    expect(mocks.trackApiErrorEvent).not.toHaveBeenCalled();
  });

  it('answers a 404 as a VALUE, and reports nothing', async () => {
    // An email client wrapped the link — the commonest way one of these arrives,
    // with its own screen and its own advice. `agency_invite_viewed` carries it.
    respondWith(404, { status: 'not_found' });

    await expect(getInvite(TOKEN)).resolves.toEqual({ status: 'not_found' });
    expect(mocks.trackApiErrorEvent).not.toHaveBeenCalled();
  });

  it('answers a BODYLESS 404 as not_found too', async () => {
    /*
      What made the case above a value was `body.status`, not the 404 — so the
      contract held exactly as far as master's own JSON. A 404 carrying
      `{ error: 'Not Found' }`, an empty body, or a gateway's HTML error page fell
      through to the throw, and the page rendered "We could not open your
      invitation — try again" instead of the not-found screen and its advice
      ("copy the whole link"). That is the commonest damaged-link case on a page
      reached from an email, on the one failure retrying cannot fix — and the
      network between here and master is not ours to assume anything about.
    */
    mocks.fetch.mockImplementation(async () => new Response(null, { status: 404 }));

    await expect(getInvite(TOKEN)).resolves.toEqual({ status: 'not_found' });
    // Still an outcome rather than an outage: reporting it would bury a real one.
    expect(mocks.trackApiErrorEvent).not.toHaveBeenCalled();
  });

  it('lets a 404 that names a different status keep its own name', async () => {
    // The HTTP status makes it a value; the body only refines WHICH value, so a
    // status master does name is taken at its word rather than flattened.
    respondWith(404, { status: 'revoked' });

    await expect(getInvite(TOKEN)).resolves.toEqual({ status: 'revoked' });
  });

  it('reports a genuine failure — with the token taken out of the path', async () => {
    respondWith(500, { error: 'Internal Error' });

    await expect(getInvite(TOKEN)).rejects.toThrow();
    expect(mocks.trackApiErrorEvent).toHaveBeenCalledTimes(1);
    const props = mocks.trackApiErrorEvent.mock.calls[0]![0] as { path: string };
    expect(props.path).toBe('/invites/:token');
    expect(props.path).not.toContain(TOKEN);
  });
});

describe('claimInvite', () => {
  it('returns the session master answers with', async () => {
    const session = { user: { id: 'u1' }, tenants: [], memberships: [], is_new: false };
    respondWith(200, session);

    await expect(claimInvite(TOKEN, 'id-token')).resolves.toEqual(session);
    expect(mocks.trackApiErrorEvent).not.toHaveBeenCalled();
  });

  it.each([
    'claimed',
    'expired',
    'revoked',
    'not_found',
    'identity_already_bound',
  ] as const)('raises %s as an unusable invitation', async (status) => {
    respondWith(409, { error: 'Conflict', status, message: 'no' });

    await expect(claimInvite(TOKEN, 'id-token')).rejects.toBeInstanceOf(InviteUnavailableError);
    await expect(claimInvite(TOKEN, 'id-token')).rejects.toMatchObject({ status });
    // A state change, not an outage.
    expect(mocks.trackApiErrorEvent).not.toHaveBeenCalled();
  });

  it('raises identity_in_use as its own thing, carrying master’s advice', async () => {
    /*
      The Firebase account already belongs to a different user row here. The
      invitation is fine and another account still claims it, so this is NOT an
      `InviteUnavailableError`: raising it as one would replace the page with a
      terminal screen and take the sign-out with it, leaving the visitor looping
      on the account that just collided.
    */
    const message =
      'That sign-in already belongs to a different account here. Sign in with it directly, '
      + 'or ask for an invitation to be sent to that address.';
    respondWith(409, { error: 'Conflict', status: 'identity_in_use', message });

    const err = await claimInvite(TOKEN, 'id-token').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InviteIdentityInUseError);
    expect(err).not.toBeInstanceOf(InviteUnavailableError);
    expect((err as Error).message).toBe(message);
    expect(mocks.trackApiErrorEvent).not.toHaveBeenCalled();
  });

  it('raises a bodyless 404 as an unusable invitation, not as an outage', async () => {
    // The same defect as the lookup's, on the same token: without this the page
    // leaves an error under a form that can no longer succeed.
    mocks.fetch.mockImplementation(async () => new Response(null, { status: 404 }));

    const err = await claimInvite(TOKEN, 'id-token').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InviteUnavailableError);
    expect(err).toMatchObject({ status: 'not_found' });
    expect(mocks.trackApiErrorEvent).not.toHaveBeenCalled();
  });

  it('reports anything else, with the token out of the path', async () => {
    respondWith(503, { error: 'Request Failed' });

    await expect(claimInvite(TOKEN, 'id-token')).rejects.toThrow();
    const props = mocks.trackApiErrorEvent.mock.calls[0]![0] as { path: string; status: number };
    expect(props.status).toBe(503);
    expect(props.path).toBe('/invites/:token/claim');
    expect(props.path).not.toContain(TOKEN);
  });
});

describe('resendInvite', () => {
  it('names the MEMBERSHIP, which is what makes a resend possible at all', async () => {
    /*
      `POST /users/invite` answers `409 User already has a membership in this
      context` for an address that is already a member, which is every expired
      invitation — so re-inviting is not a recovery. This route takes the
      membership id and re-issues against the row that exists.

      Through `apiFetch`, unlike the two above: a supervisor pressing this has a
      session, and a 401 here really does mean it lapsed.
    */
    mocks.apiFetch.mockResolvedValue({ invite_email: { sent: true }, sign_in_url: 'https://app/agency/join/x' });

    await expect(resendInvite('tenant-1', 'mem-9')).resolves.toEqual({
      invite_email: { sent: true },
      sign_in_url: 'https://app/agency/join/x',
    });

    const [url, init, tenantId] = mocks.apiFetch.mock.calls[0]!;
    expect(url).toMatch(/\/invites\/resend$/);
    expect((init as RequestInit).method).toBe('POST');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({ membership_id: 'mem-9' });
    // Tenant-scoped: master resolves the membership inside the caller's tenant.
    expect(tenantId).toBe('tenant-1');
  });
});
