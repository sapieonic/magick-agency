import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { SessionResponse, MeResponse } from '../../types/auth';

/*
 * PORT NOTE (magick-agency), against cusui's suite @ ee5beb44:
 *  - fixtures carry `settings` (the per-account settings map) where cusui's
 *    carried `governance`;
 *  - DELETED: `signUpEmail` (2 cases — no self-serve sign-up, session path 4 is
 *    refused) and "sign-out clears the concurrency-limits cache" (2 cases — the
 *    cache fed the AI broadcast composer and is not ported);
 *  - MODIFIED: "reads pending phone from localStorage…" now pins that the
 *    listener does NOT read the path-4 phone stash; `logout` and
 *    `completeEmailVerification` no longer seed or clear it, and the latter syncs
 *    with the fresh token alone;
 *  - NEW (at the end): the 403 refusal is recorded as `sessionRefusal`, and
 *    `settings` is adopted from the session and refreshed from `/auth/me`.
 */

// ─── hoisted mock state ──────────────────────────────────────────────────────

const testState = vi.hoisted(() => ({
  mockAuth: { currentUser: null as any },
  authCallback: null as ((user: any) => Promise<void> | void) | null,
}));

// ─── module mocks ────────────────────────────────────────────────────────────

vi.mock('firebase/app', () => ({
  initializeApp: vi.fn(() => ({})),
}));

vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => testState.mockAuth),
  onAuthStateChanged: vi.fn((_auth: any, cb: any) => {
    testState.authCallback = cb;
    return vi.fn(); // unsubscribe
  }),
  signInWithEmailAndPassword: vi.fn(),
  createUserWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  sendEmailVerification: vi.fn(),
  signOut: vi.fn(),
  GoogleAuthProvider: vi.fn(),
}));

vi.mock('../../api/auth', () => ({
  createSession: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock('../../api/invites', () => ({
  claimInvite: vi.fn(),
}));

import { AuthProvider, useAuth } from '../../contexts/AuthContext';
import {
  onAuthStateChanged,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  sendEmailVerification,
  signOut,
} from 'firebase/auth';
import { createSession, getMe } from '../../api/auth';
import { claimInvite as claimInviteRequest } from '../../api/invites';
import { JOIN_MAX_AGE_MS } from '../../utils/inviteJoin';
import { ApiError } from '../../api/client';

// ─── fixtures ────────────────────────────────────────────────────────────────

function makeFbUser(overrides: Record<string, unknown> = {}) {
  return {
    emailVerified: true,
    providerData: [{ providerId: 'google.com' }],
    getIdToken: vi.fn().mockResolvedValue('mock-id-token'),
    reload: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const VERIFIED_GOOGLE = makeFbUser();
const VERIFIED_EMAIL = makeFbUser({ providerData: [{ providerId: 'password' }] });
const UNVERIFIED_EMAIL = makeFbUser({
  emailVerified: false,
  providerData: [{ providerId: 'password' }],
});

const SESSION: SessionResponse = {
  user: { id: 'u1', firebase_uid: 'fb1', email: 'a@b.com', display_name: 'A', avatar_url: null, status: 'active', created_at: '', updated_at: '' },
  tenants: [{ id: 't1', name: 'T', slug: 't', settings: {}, status: 'active', created_at: '', updated_at: '' }],
  memberships: [{ id: 'm1', user_id: 'u1', tenant_id: 't1', account_id: null, role: 'tenant_owner', status: 'active', invited_by: null, created_at: '', updated_at: '' }],
  is_new: false,
  settings: {},
};

const ME_RESPONSE: MeResponse = {
  user: { ...SESSION.user, display_name: 'Updated' },
  tenants: SESSION.tenants,
  memberships: SESSION.memberships,
  settings: {},
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

/** Render the hook and settle the initial auth state to "signed out". */
async function renderSettled() {
  const hook = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());
  await act(async () => { testState.authCallback?.(null); });
  return hook;
}

beforeEach(() => {
  vi.clearAllMocks();
  testState.mockAuth.currentUser = null;
  testState.authCallback = null;
  localStorage.clear();
  sessionStorage.clear();
});

// ─── hook guard ──────────────────────────────────────────────────────────────

describe('useAuth', () => {
  it('throws when used outside AuthProvider', () => {
    expect(() => renderHook(() => useAuth())).toThrow(
      'useAuth must be used within AuthProvider',
    );
  });
});

// ─── initial state ───────────────────────────────────────────────────────────

describe('initial state', () => {
  it('starts with loading true', () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    expect(result.current.loading).toBe(true);
    expect(result.current.user).toBeNull();
    expect(result.current.tenants).toEqual([]);
  });
});

// ─── onAuthStateChanged ──────────────────────────────────────────────────────

describe('onAuthStateChanged', () => {
  it('sets unauthenticated state when Firebase emits null', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());

    await act(async () => { testState.authCallback?.(null); });

    expect(result.current.loading).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.firebaseUser).toBeNull();
    expect(result.current.pendingEmailVerification).toBe(false);
  });

  it('syncs session for a verified Google user', async () => {
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());

    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });

    expect(createSession).toHaveBeenCalledWith('mock-id-token', undefined);
    expect(result.current.user).toEqual(SESSION.user);
    expect(result.current.tenants).toEqual(SESSION.tenants);
    expect(result.current.memberships).toEqual(SESSION.memberships);
    expect(result.current.loading).toBe(false);
  });

  it('syncs session for a verified email user', async () => {
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());

    await act(async () => { await testState.authCallback?.(VERIFIED_EMAIL); });

    expect(result.current.user).toEqual(SESSION.user);
    expect(result.current.pendingEmailVerification).toBe(false);
  });

  it('sets pendingEmailVerification for an unverified email user', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());

    await act(async () => { testState.authCallback?.(UNVERIFIED_EMAIL); });

    expect(result.current.pendingEmailVerification).toBe(true);
    expect(result.current.user).toBeNull();
    expect(result.current.loading).toBe(false);
    expect(createSession).not.toHaveBeenCalled();
  });

  it('sets error when session sync fails', async () => {
    vi.mocked(createSession).mockRejectedValue(new Error('server down'));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());

    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });

    expect(result.current.error).toBe('server down');
    expect(result.current.loading).toBe(false);
  });

  it('does NOT read a pending-phone stash: the path-4 signup that wrote it is gone', async () => {
    localStorage.setItem('magick-pending-phone', '+911234567890');
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());

    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });

    expect(vi.mocked(createSession).mock.calls).toEqual([['mock-id-token', undefined]]);
    expect(result.current.user).toEqual(SESSION.user);
  });
});

// ─── signInEmail ─────────────────────────────────────────────────────────────

describe('signInEmail', () => {
  it('syncs session for a verified user and returns the session', async () => {
    vi.mocked(signInWithEmailAndPassword).mockResolvedValue({ user: VERIFIED_EMAIL } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const { result } = await renderSettled();

    let session: SessionResponse | null = null;
    await act(async () => {
      session = await result.current.signInEmail('a@b.com', 'pw');
    });

    expect(signInWithEmailAndPassword).toHaveBeenCalled();
    expect(result.current.user).toEqual(SESSION.user);
    expect(session).toEqual(SESSION);
  });

  it('sends verification email and returns null for unverified user', async () => {
    vi.mocked(signInWithEmailAndPassword).mockResolvedValue({ user: UNVERIFIED_EMAIL } as any);

    const { result } = await renderSettled();

    let session: SessionResponse | null;
    await act(async () => {
      session = await result.current.signInEmail('a@b.com', 'pw');
    });

    expect(sendEmailVerification).toHaveBeenCalledWith(UNVERIFIED_EMAIL);
    expect(result.current.pendingEmailVerification).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(session!).toBeNull();
    expect(createSession).not.toHaveBeenCalled();
  });

  it('sets error and re-throws on failure', async () => {
    vi.mocked(signInWithEmailAndPassword).mockRejectedValue(new Error('wrong pw'));

    const { result } = await renderSettled();

    let caught: Error | undefined;
    await act(async () => {
      try { await result.current.signInEmail('a@b.com', 'bad'); } catch (e) { caught = e as Error; }
    });

    expect(caught?.message).toBe('wrong pw');
    expect(result.current.error).toBe('wrong pw');
    expect(result.current.loading).toBe(false);
  });

  it('prevents onAuthStateChanged race during sign-in', async () => {
    // signInWithEmailAndPassword triggers the captured auth callback mid-flight
    vi.mocked(signInWithEmailAndPassword).mockImplementation(async () => {
      testState.authCallback?.(VERIFIED_EMAIL);
      return { user: VERIFIED_EMAIL } as any;
    });
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const { result } = await renderSettled();

    await act(async () => {
      await result.current.signInEmail('a@b.com', 'pw');
    });

    // createSession should be called once (by signInEmail), not twice (not also by onAuthStateChanged)
    expect(createSession).toHaveBeenCalledTimes(1);
    expect(result.current.user).toEqual(SESSION.user);
  });
});

// ─── signInGoogle ─────────────────────────────────────────────────────────────

describe('signInGoogle', () => {
  it('signs in with Google popup and syncs session', async () => {
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const { result } = await renderSettled();

    let session: SessionResponse | undefined;
    await act(async () => {
      session = await result.current.signInGoogle();
    });

    expect(signInWithPopup).toHaveBeenCalled();
    expect(result.current.user).toEqual(SESSION.user);
    expect(session).toEqual(SESSION);
  });

  it('passes phone number to session sync', async () => {
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const { result } = await renderSettled();

    await act(async () => {
      await result.current.signInGoogle('+919999999999');
    });

    expect(createSession).toHaveBeenCalledWith('mock-id-token', '+919999999999');
  });

  it('sets error and re-throws on failure', async () => {
    vi.mocked(signInWithPopup).mockRejectedValue(new Error('popup closed'));

    const { result } = await renderSettled();

    let caught: Error | undefined;
    await act(async () => {
      try { await result.current.signInGoogle(); } catch (e) { caught = e as Error; }
    });

    expect(caught?.message).toBe('popup closed');
    expect(result.current.error).toBe('popup closed');
  });
});

// ─── logout ──────────────────────────────────────────────────────────────────

describe('logout', () => {
  it('signs out of Firebase and resets all state', async () => {
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const { result } = await renderSettled();

    // Sign in first
    await act(async () => { await result.current.signInGoogle(); });
    expect(result.current.user).not.toBeNull();

    // Logout
    await act(async () => { await result.current.logout(); });

    expect(signOut).toHaveBeenCalled();
    expect(result.current.user).toBeNull();
    expect(result.current.firebaseUser).toBeNull();
    expect(result.current.tenants).toEqual([]);
    expect(result.current.memberships).toEqual([]);
    expect(result.current.loading).toBe(false);
    expect(result.current.pendingEmailVerification).toBe(false);
    expect(result.current.settings).toEqual({});
  });
});

// ─── refreshSession ──────────────────────────────────────────────────────────

describe('refreshSession', () => {
  it('updates user, tenants, and memberships from getMe', async () => {
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);
    vi.mocked(getMe).mockResolvedValue(ME_RESPONSE);

    const { result } = await renderSettled();
    await act(async () => { await result.current.signInGoogle(); });

    await act(async () => { await result.current.refreshSession(); });

    expect(getMe).toHaveBeenCalled();
    expect(result.current.user?.display_name).toBe('Updated');
  });

  it('silently fails without setting an error', async () => {
    vi.mocked(getMe).mockRejectedValue(new Error('network'));

    const { result } = await renderSettled();

    await act(async () => { await result.current.refreshSession(); });

    // Error should NOT be surfaced — refreshSession swallows errors
    expect(result.current.error).toBeNull();
  });
});

// ─── completeEmailVerification ───────────────────────────────────────────────

describe('completeEmailVerification', () => {
  it('reloads user and syncs session with the fresh token alone', async () => {
    const verifiable = makeFbUser({
      emailVerified: false,
      providerData: [{ providerId: 'password' }],
      reload: vi.fn(async function (this: any) { this.emailVerified = true; }),
      getIdToken: vi.fn().mockResolvedValue('fresh-token'),
    });
    testState.mockAuth.currentUser = verifiable;
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const { result } = await renderSettled();

    let session: SessionResponse | undefined;
    await act(async () => {
      session = await result.current.completeEmailVerification();
    });

    expect(verifiable.reload).toHaveBeenCalled();
    expect(verifiable.getIdToken).toHaveBeenCalledWith(true);
    expect(vi.mocked(createSession).mock.calls).toEqual([['fresh-token']]);
    expect(result.current.pendingEmailVerification).toBe(false);
    expect(result.current.user).toEqual(SESSION.user);
    expect(session).toEqual(SESSION);
  });

  it('throws when there is no authenticated user', async () => {
    testState.mockAuth.currentUser = null;
    const { result } = await renderSettled();

    let caught: Error | undefined;
    await act(async () => {
      try { await result.current.completeEmailVerification(); } catch (e) { caught = e as Error; }
    });

    expect(caught?.message).toBe('No authenticated user');
  });

  it('throws when email is still not verified after reload', async () => {
    const stillUnverified = makeFbUser({ emailVerified: false, providerData: [{ providerId: 'password' }] });
    testState.mockAuth.currentUser = stillUnverified;
    const { result } = await renderSettled();

    let caught: Error | undefined;
    await act(async () => {
      try { await result.current.completeEmailVerification(); } catch (e) { caught = e as Error; }
    });

    expect(caught?.message).toBe('Email not verified yet');
  });
});

// ─── resendVerificationEmail ─────────────────────────────────────────────────

describe('resendVerificationEmail', () => {
  it('sends verification email when user is unverified', async () => {
    testState.mockAuth.currentUser = UNVERIFIED_EMAIL;
    const { result } = await renderSettled();

    await act(async () => { await result.current.resendVerificationEmail(); });

    expect(sendEmailVerification).toHaveBeenCalledWith(UNVERIFIED_EMAIL);
  });

  it('does nothing when there is no current user', async () => {
    testState.mockAuth.currentUser = null;
    const { result } = await renderSettled();

    await act(async () => { await result.current.resendVerificationEmail(); });

    expect(sendEmailVerification).not.toHaveBeenCalled();
  });

  it('does nothing when user is already verified', async () => {
    testState.mockAuth.currentUser = VERIFIED_EMAIL;
    const { result } = await renderSettled();

    await act(async () => { await result.current.resendVerificationEmail(); });

    expect(sendEmailVerification).not.toHaveBeenCalled();
  });
});

// ─── the invite claim ────────────────────────────────────────────────────────

/**
 * `establishInviteCredential` + `claimInvite`, and the one property they exist to
 * hold: **a Firebase credential established for an invitation must never reach
 * `POST /auth/session`.**
 *
 * ── Why that is the whole game ────────────────────────────────────────────
 * Master provisions a BRAND-NEW TENANT for an address it does not recognise
 * (`auth.routes.ts`, path 4). The provider's own `onAuthStateChanged` listener
 * syncs any credential it sees, and a Google user is always `emailVerified`, so
 * the listener firing on an invite credential is not a race with a cosmetic
 * outcome — it silently creates a private empty workspace, credits and a core API
 * key for somebody who was invited to an existing one, leaves the real membership
 * unclaimed, and permanently binds their Google uid to the new row so the real
 * claim afterwards fails with `identity_in_use` forever. That is the exact defect
 * `/agency/join/:token` was built to abolish.
 *
 * The suppression is in two halves because the hazard has two shapes, and only
 * the first half existed before: `manualAuthInProgress` covers the window inside
 * one page's life, and the `sessionStorage` marker covers a PAGE LOAD — Firebase
 * persists the credential in localStorage and a ref does not survive a reload, so
 * an agent who reloads while the page waits on the address-mismatch confirmation
 * (a screen that deliberately waits for a human) was landing in the stray tenant
 * with the page's own protection wiped out.
 */
describe('the invite claim', () => {
  it('establishes a credential without creating a session from it', async () => {
    // The listener fires mid-flight, exactly as Firebase does on a real popup.
    const personal = makeFbUser({ email: 'p.sharma@gmail.com' });
    vi.mocked(signInWithPopup).mockImplementation(async () => {
      testState.authCallback?.(personal);
      return { user: personal } as any;
    });

    const { result } = await renderSettled();

    let credential: { email: string | null } | undefined;
    await act(async () => {
      credential = await result.current.establishInviteCredential({ method: 'google' });
    });

    /*
      The address comes back and nothing else does — the page compares it with the
      invited one, and that comparison is the entire address-mismatch screen. No
      id token: it is minted at claim time instead, so no caller can hold a stale
      one across the pause that screen is.
    */
    expect(credential).toEqual({ email: 'p.sharma@gmail.com' });
    expect(createSession).not.toHaveBeenCalled();
  });

  it('records the join so a RELOAD cannot sync it either', async () => {
    /*
      The half of the suppression a `useRef` cannot provide. Simulated the only
      way a page load can be: the provider is torn down and mounted again, and
      Firebase replays the persisted credential to the new listener. Before the
      marker, this is where the stray tenant was created — with nobody having
      pressed anything.
    */
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const first = await renderSettled();
    await act(async () => {
      await first.result.current.establishInviteCredential({ method: 'google' });
    });
    first.unmount();

    // A fresh page: new provider, new listener, the ref born `false`.
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalledTimes(2));
    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });

    expect(createSession).not.toHaveBeenCalled();
    // The orphaned credential is DROPPED rather than merely ignored: left in
    // place, the next thing to read the auth state provisions the tenant, and the
    // next Google popup silently re-selects the account that did not match.
    expect(signOut).toHaveBeenCalled();
    expect(result.current.user).toBeNull();
    expect(result.current.loading).toBe(false);
    // …and no "your session expired" for somebody who never had one.
    expect(result.current.error).toBeNull();
  });

  it('consumes the record, so the suppression cannot outlive its cause', async () => {
    /*
      Read-and-clear rather than read: a marker that somehow survived every other
      clear path would otherwise sign somebody out of that tab on every load,
      forever. It costs one signed-out page load and then no longer exists.
    */
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const first = await renderSettled();
    await act(async () => {
      await first.result.current.establishInviteCredential({ method: 'google' });
    });
    first.unmount();

    const second = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalledTimes(2));
    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });
    second.unmount();

    // The load after that is an ordinary one.
    renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalledTimes(3));
    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });

    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('claims with a FRESH id token, and ends the join', async () => {
    /*
      The token is minted at claim time rather than captured when the credential
      was established. Firebase id tokens last an hour and the screen between the
      two is an explicit pause for a human to read two addresses and decide, so a
      captured one can be expired by the time the button is pressed — a 401 the
      visitor can do nothing about.
    */
    vi.mocked(claimInviteRequest).mockResolvedValue(SESSION);
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    testState.mockAuth.currentUser = VERIFIED_GOOGLE;

    const { result } = await renderSettled();
    await act(async () => {
      await result.current.establishInviteCredential({ method: 'google' });
    });
    VERIFIED_GOOGLE.getIdToken.mockClear();

    await act(async () => { await result.current.claimInvite('tok_abc123'); });

    expect(VERIFIED_GOOGLE.getIdToken).toHaveBeenCalled();
    expect(claimInviteRequest).toHaveBeenCalledWith('tok_abc123', 'mock-id-token');
    // Adopted identically to a sign-in…
    expect(result.current.user).toEqual(SESSION.user);
    expect(result.current.loading).toBe(false);

    // …and the join is over, so an ordinary reload syncs like any other session
    // rather than being suppressed and signed out.
    const { result: reloaded } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalledTimes(2));
    vi.mocked(createSession).mockResolvedValue(SESSION);
    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(reloaded.current.user).toEqual(SESSION.user);
  });

  it('keeps the suppression when the claim FAILS', async () => {
    /*
      A refused claim leaves a live credential and no session — the state the
      marker exists for. Releasing it here would reopen the hole for exactly the
      visitor most likely to reload: the one who just watched something go wrong.
    */
    vi.mocked(claimInviteRequest).mockRejectedValue(new Error('Conflict'));
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);
    testState.mockAuth.currentUser = VERIFIED_GOOGLE;

    const first = await renderSettled();
    await act(async () => {
      await first.result.current.establishInviteCredential({ method: 'google' });
    });

    let caught: Error | undefined;
    await act(async () => {
      try { await first.result.current.claimInvite('tok_abc123'); } catch (e) { caught = e as Error; }
    });
    expect(caught?.message).toBe('Conflict');
    expect(first.result.current.loading).toBe(false);
    first.unmount();

    renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalledTimes(2));
    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });

    expect(createSession).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalled();
  });

  it('signing out clears the record, so the next load is ordinary', async () => {
    // The mismatch screen's "Use a different account", and the invite page's
    // unmount, both go through `logout()`.
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const first = await renderSettled();
    await act(async () => {
      await first.result.current.establishInviteCredential({ method: 'google' });
    });
    await act(async () => { await first.result.current.logout(); });
    first.unmount();

    renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalledTimes(2));
    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });

    expect(createSession).toHaveBeenCalledTimes(1);
  });
});

/**
 * The invite guard, as ONE mechanism rather than five patches.
 *
 * ── What is being guarded, and against what ───────────────────────────────
 * A Firebase credential established for an invite claim must never reach `POST
 * /auth/session` (master's path 4 provisions a tenant for it, binds the uid, and
 * the real claim then fails `identity_in_use` forever) — and it must not be
 * DESTROYED while a page is still going to claim with it, because that answers a
 * visitor who did nothing wrong with "No authenticated user" on a token they
 * cannot use twice.
 *
 * Those two requirements pull in opposite directions, which is why the guard is
 * three facts and not one flag:
 *
 *  1. `manualAuthInProgress` — a credential call is running right now.
 *  2. `holdsInviteCredential` — THIS page life established one and no claim has
 *     spent it. Its answer is "skip the sync", never "sign out".
 *  3. The marker (`utils/inviteJoin.ts`) — a join is outstanding on this ORIGIN,
 *     for at most an hour. `localStorage`, because the credential it guards is
 *     `localStorage`-scoped and every tab can see it; with a per-tab half saying
 *     which tab may clean up, because a tab that is not the one mid-join may only
 *     suppress.
 *
 * Every case below is a way one of the three was missing or was applied where
 * another belonged.
 */
describe('the invite guard', () => {
  /** Establish a Google credential on a provider that stays mounted. */
  async function establishOnLivePage() {
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);
    const page = await renderSettled();
    await act(async () => {
      await page.result.current.establishInviteCredential({ method: 'google' });
    });
    return page;
  }

  /** Mount another provider and replay the persisted credential into it. */
  async function anotherProvider(expectedSubscriptions: number) {
    const view = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalledTimes(expectedSubscriptions));
    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });
    return view;
  }

  it('a second provider on the same credential still provisions nothing', async () => {
    /*
      The marker was `sessionStorage` — per TAB — and the credential it guards is
      `browserLocalPersistence`: `localStorage`, shared by every tab on the
      origin, replayed into each of them through the `storage` event. Nothing in
      `src/` calls `setPersistence`, so that is not a configuration this could
      have differed on.

      So a tab that had the app open — a previous `/agency/login`, a supervisor
      checking the mailed link, an email client that opened the invite beside an
      existing session — saw the join page's credential with no marker in front of
      it, and synced it. The stray tenant, created in a tab nobody was even
      looking at, while the join page sat on its confirmation screen.
    */
    const first = await establishOnLivePage();

    // A second provider WITHOUT unmounting the first: two live listeners over one
    // credential, which is what a second tab is.
    await anotherProvider(2);

    expect(createSession).not.toHaveBeenCalled();
    first.unmount();
  });

  it('a tab that is not the one joining suppresses WITHOUT signing out', async () => {
    /*
      The other half of that, and the reason the marker is two keys rather than
      one. A foreign tab must not sync — but it must not sign out either: the join
      may be on screen in the tab that owns it, and `signOut` is origin-wide. A
      guard that dropped the credential from any tab would destroy the very claim
      it exists to protect, and the visitor would watch their invitation fail
      while they were reading the confirmation.

      A second tab is exactly this: the same `localStorage`, its own empty
      `sessionStorage`.
    */
    const first = await establishOnLivePage();
    sessionStorage.clear();

    const second = await anotherProvider(2);

    expect(createSession).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    // Settled and signed out, rather than left spinning: a `RequireAuth` route in
    // that tab has to be able to send the visitor somewhere.
    expect(second.result.current.loading).toBe(false);
    expect(second.result.current.user).toBeNull();
    first.unmount();
  });

  it('the record EXPIRES, so it cannot suppress an ordinary sign-in later', async () => {
    /*
      What `sessionStorage` was buying — a marker that cannot follow somebody into
      next week — and the reason it can be given up. The timestamp was already
      being written and simply never read; `isJoinInProgress` was existence-only.
      Without the TTL, an origin-wide marker left behind by a join nothing cleaned
      up (the tab crashed, the browser was killed) would sign the visitor out of a
      real session the next morning.
    */
    const first = await establishOnLivePage();
    first.unmount();

    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + JOIN_MAX_AGE_MS + 1);
    try {
      const { result } = await anotherProvider(2);

      expect(createSession).toHaveBeenCalledTimes(1);
      expect(signOut).not.toHaveBeenCalled();
      expect(result.current.user).toEqual(SESSION.user);
    } finally {
      clock.mockRestore();
    }
  });

  it('a sign-out that FAILED does not release the suppression', async () => {
    /*
      The clear used to run BEFORE `signOut`, defended as "a credential we could
      not drop is still one nothing will sync". True of that one listener call and
      of nothing else: `signOut` rejects on a network blip,
      `browserLocalPersistence` keeps the user, and the very next
      `onAuthStateChanged` then found a live credential with the marker already
      gone. The stray tenant, arrived by the failure path of the code whose whole
      job is to prevent it.
    */
    vi.mocked(signOut).mockRejectedValue(new Error('auth/network-request-failed'));
    const first = await establishOnLivePage();
    first.unmount();

    // The load that tries to drop it, and cannot.
    const second = await anotherProvider(2);
    expect(signOut).toHaveBeenCalledTimes(1);
    second.unmount();

    // The load after that: still suppressed, and still trying.
    await anotherProvider(3);

    expect(createSession).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalledTimes(2);
  });

  it('a logout whose sign-out failed leaves the join suppressed', async () => {
    /*
      `logout()` had the same ordering, and it is the path the invite page's own
      escape hatches take — declining the address mismatch, and leaving the page
      mid-join. The page's existing test ("clears the confirmation even when
      signing out fails") passes straight through this: it never remounts the
      provider, which is where the consequence is.
    */
    const first = await establishOnLivePage();
    vi.mocked(signOut).mockRejectedValue(new Error('auth/network-request-failed'));

    await act(async () => {
      await expect(first.result.current.logout()).rejects.toThrow();
    });
    first.unmount();

    vi.mocked(signOut).mockResolvedValue(undefined);
    await anotherProvider(2);

    expect(createSession).not.toHaveBeenCalled();
    // Dropped on this load instead, which is the marker doing its job rather than
    // the sign-out having quietly worked.
    expect(signOut).toHaveBeenCalled();
  });

  it('a credential call that FAILED leaves nothing suppressing a real session', async () => {
    /*
      The marker is written BEFORE the Firebase call, because the popup is a place
      pages get reloaded — but `signInWithPopup` throws routinely
      (`auth/popup-closed-by-user`, `auth/popup-blocked`, a network failure) and
      then no credential exists at all. Left standing, that marker was worse than
      the hole it covered: a supervisor who is ALREADY SIGNED IN opens the invite
      to check it, closes the Google window, and goes back to the app — where the
      guard found their real user behind a marker for a credential that was never
      created and signed them out of a genuine session.
    */
    vi.mocked(signInWithPopup).mockRejectedValue(
      Object.assign(new Error('closed'), { code: 'auth/popup-closed-by-user' }),
    );
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const first = await renderSettled();
    await act(async () => {
      await expect(
        first.result.current.establishInviteCredential({ method: 'google' }),
      ).rejects.toThrow();
    });
    first.unmount();

    const { result } = await anotherProvider(2);

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(signOut).not.toHaveBeenCalled();
    expect(result.current.user).toEqual(SESSION.user);
  });

  it('keeps the suppression when an EARLIER credential is still live', async () => {
    /*
      The narrow case that stops the fix above from being a new hole. A Google
      credential whose claim was refused leaves the visitor back at the two
      options, still signed into Firebase; if they then try the password path and
      THAT fails, the failure must not take away a marker that is still describing
      a real, live credential.
    */
    const first = await establishOnLivePage();
    vi.mocked(createUserWithEmailAndPassword).mockRejectedValue(
      Object.assign(new Error('in use'), { code: 'auth/email-already-in-use' }),
    );

    await act(async () => {
      await expect(
        first.result.current.establishInviteCredential({
          method: 'create',
          email: 'priya@acme.com',
          password: 'correct horse battery',
        }),
      ).rejects.toThrow();
    });
    first.unmount();

    await anotherProvider(2);

    expect(createSession).not.toHaveBeenCalled();
    expect(signOut).toHaveBeenCalled();
  });

  it('a second notification on the SAME page does not sign the visitor out', async () => {
    /*
      `onAuthStateChanged` is not called once. Firebase notifies around the
      persistence write and again as the id token is confirmed, and StrictMode and
      HMR re-subscribe. By then `manualAuthInProgress` is back to `false` and the
      marker is still set — so a guard that read "marker set ⇒ discard" signed the
      visitor out WHILE THEY WERE READING the address-mismatch confirmation, or in
      the gap between the credential resolving and `claimInvite`, where the claim
      then failed with "No authenticated user" on the one path (a matching
      address) where nothing had gone wrong.

      The marker means "do not provision a session". It does not mean "destroy the
      credential this page is about to claim with".
    */
    const { result } = await establishOnLivePage();

    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });

    expect(createSession).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();

    // And the credential is still there, so the claim it was established for
    // still works.
    testState.mockAuth.currentUser = VERIFIED_GOOGLE;
    vi.mocked(claimInviteRequest).mockResolvedValue(SESSION);
    await act(async () => { await result.current.claimInvite('tok_abc123'); });

    expect(result.current.user).toEqual(SESSION.user);
  });
});

// ─── NEW (magick-agency): the session refusal and the settings map ──────────

const SETTINGS = {
  a1: {
    tenant_id: 't1',
    account_id: 'a1',
    allow_recording: true,
    analyze_calls: false,
    max_concurrent_calls: 5,
    webrtc_max_duration_seconds: 1800,
    updated_at: '2026-10-01T00:00:00.000Z',
  },
};

function noMembership() {
  return new ApiError(403, {
    error: 'Forbidden',
    code: 'no_membership',
    message: 'No Magick Agency account exists for this sign-in.',
  });
}

describe('session path 4 is refused, and the refusal is kept (magick-agency)', () => {
  it('records `no_membership` when the LISTENER’s sync is refused — the reload path', async () => {
    vi.mocked(createSession).mockRejectedValue(noMembership());
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());

    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });

    expect(result.current.sessionRefusal).toBe('no_membership');
    expect(result.current.user).toBeNull();
    expect(result.current.tenants).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it('records it on a signInEmail refusal, and still re-throws', async () => {
    vi.mocked(signInWithEmailAndPassword).mockResolvedValue({ user: VERIFIED_EMAIL } as any);
    vi.mocked(createSession).mockRejectedValue(noMembership());
    const { result } = await renderSettled();

    let caught: unknown;
    await act(async () => {
      try { await result.current.signInEmail('a@b.com', 'pw'); } catch (e) { caught = e; }
    });

    expect(caught).toBeInstanceOf(ApiError);
    expect(result.current.sessionRefusal).toBe('no_membership');
  });

  it('records it on a signInGoogle refusal', async () => {
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockRejectedValue(noMembership());
    const { result } = await renderSettled();

    await act(async () => {
      try { await result.current.signInGoogle(); } catch { /* re-thrown */ }
    });

    expect(result.current.sessionRefusal).toBe('no_membership');
  });

  it('a failure that is not a refusal leaves it null', async () => {
    vi.mocked(createSession).mockRejectedValue(new ApiError(403, { error: 'Forbidden', message: 'nope' }));
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());
    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });
    expect(result.current.sessionRefusal).toBeNull();
  });

  it('a later successful session clears it', async () => {
    vi.mocked(createSession).mockRejectedValueOnce(noMembership()).mockResolvedValueOnce(SESSION);
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());
    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });
    expect(result.current.sessionRefusal).toBe('no_membership');

    await act(async () => { await result.current.signInGoogle(); });
    expect(result.current.sessionRefusal).toBeNull();
    expect(result.current.user).toEqual(SESSION.user);
  });
});

describe('the settings map (magick-agency)', () => {
  it('is adopted from the session payload', async () => {
    vi.mocked(createSession).mockResolvedValue({ ...SESSION, settings: SETTINGS });
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());
    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });
    expect(result.current.settings).toEqual(SETTINGS);
  });

  it('is refreshed from GET /auth/me', async () => {
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);
    vi.mocked(getMe).mockResolvedValue({ ...ME_RESPONSE, settings: SETTINGS });
    const { result } = await renderSettled();
    await act(async () => { await result.current.signInGoogle(); });
    expect(result.current.settings).toEqual({});

    await act(async () => { await result.current.refreshSession(); });
    expect(result.current.settings).toEqual(SETTINGS);
  });
});
