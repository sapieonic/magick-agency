import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor, cleanup } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { SessionResponse } from '../types/auth';

// ─── hoisted mock state ──────────────────────────────────────────────────────
// Reuses the firebase mocking convention from
// src/__tests__/contexts/AuthContext.test.tsx: onAuthStateChanged captures the
// callback so tests can drive auth-state transitions manually.

const testState = vi.hoisted(() => ({
  mockAuth: { currentUser: null as any },
  authCallback: null as ((user: any) => Promise<void> | void) | null,
}));

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
  signOut: vi.fn(async () => {}),
  GoogleAuthProvider: vi.fn(),
}));

vi.mock('../api/auth', () => ({
  createSession: vi.fn(),
  getMe: vi.fn(),
}));

vi.mock('../analytics/posthog', () => ({
  resetAnalytics: vi.fn(),
}));

import { AuthProvider, useAuth } from '../contexts/AuthContext';
import { onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { createSession } from '../api/auth';
import {
  markSessionStart,
  getSessionStart,
  SESSION_MAX_AGE_MS,
  SESSION_EXPIRED_MESSAGE,
} from '../utils/session';

/**
 * Assert an expiry redirect: the login page, the expiry marker, and where the user
 * was.
 *
 * The `next=` half is new. A mid-session expiry — the backend's six-hour cap, or
 * this provider's own watchdog — used to send everyone to `/app`, so an agent lost
 * their station and a supervisor lost the campaign they were watching.
 * `RequireAuth`'s deep-link handling only ever covered the never-signed-in case.
 *
 * Parsed rather than string-compared so the assertion does not depend on parameter
 * order.
 */
function expectExpiryRedirect(href: string, expectedNext: string | null): void {
  const url = new URL(href, 'https://app.example');
  expect(url.pathname).toBe('/login');
  expect(url.searchParams.get('session')).toBe('expired');
  expect(url.searchParams.get('next')).toBe(expectedNext);
}


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

const SESSION: SessionResponse = {
  user: { id: 'u1', firebase_uid: 'fb1', email: 'a@b.com', display_name: 'A', avatar_url: null, status: 'active', created_at: '', updated_at: '' },
  tenants: [{ id: 't1', name: 'T', slug: 't', settings: {}, status: 'active', created_at: '', updated_at: '' }],
  memberships: [{ id: 'm1', user_id: 'u1', tenant_id: 't1', account_id: null, role: 'tenant_owner', status: 'active', invited_by: null, created_at: '', updated_at: '' }],
  is_new: false,
  // PORT NOTE (magick-agency): `settings` (the per-account settings map) where cusui had `governance`.
  settings: {},
};

// ─── helpers ─────────────────────────────────────────────────────────────────

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

/**
 * Replace window.location with a writable stub so expireSession's
 * `window.location.href = ...` redirect can be observed, and `pathname` can be
 * controlled to exercise the /login redirect guard.
 */
function stubLocation(pathname: string) {
  const l = { pathname, href: '' };
  Object.defineProperty(window, 'location', { value: l, writable: true, configurable: true });
  return l;
}

let loc: { pathname: string; href: string };

beforeEach(() => {
  vi.clearAllMocks();
  testState.mockAuth.currentUser = null;
  testState.authCallback = null;
  localStorage.clear();
  vi.spyOn(Date, 'now').mockReturnValue(0);
  loc = stubLocation('/app');
});

afterEach(() => {
  // Unmount any mounted AuthProvider so its watchdog effect removes its global
  // focus/visibilitychange listeners — otherwise stale listeners from earlier
  // renders fire on the shared window and pollute later tests.
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ─── hydration: expired persisted session ────────────────────────────────────

describe('AuthContext — hydration with an expired session', () => {
  it('signs out and surfaces SESSION_EXPIRED_MESSAGE when the stored start is older than the cap', async () => {
    // A session started long ago: now jumps past the 6h cap.
    markSessionStart(0);
    vi.mocked(Date.now).mockReturnValue(SESSION_MAX_AGE_MS + 1);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());

    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });

    // expireSession() ran: signed out, no session re-sync, friendly error.
    expect(signOut).toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(result.current.error).toBe(SESSION_EXPIRED_MESSAGE);
    expect(result.current.user).toBeNull();
    expect(result.current.firebaseUser).toBeNull();
    expect(result.current.loading).toBe(false);
    // Session timestamp cleared so a fresh sign-in re-stamps the clock.
    expect(getSessionStart()).toBeNull();
    // Redirects to login with the expiry marker so the message renders even
    // when the onAuthStateChanged(null) listener races and clears `error`.
    expectExpiryRedirect(loc.href, '/app');
  });

  it('does not redirect when already on the login screen (guards against a loop)', async () => {
    loc = stubLocation('/login');
    markSessionStart(0);
    vi.mocked(Date.now).mockReturnValue(SESSION_MAX_AGE_MS + 1);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());
    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });

    expect(signOut).toHaveBeenCalled();
    expect(result.current.error).toBe(SESSION_EXPIRED_MESSAGE);
    expect(loc.href).toBe('');
  });
});

// ─── hydration: fresh persisted session ──────────────────────────────────────

describe('AuthContext — hydration with a non-expired session', () => {
  it('syncs the session and sets the user; does not sign out', async () => {
    // Session started just now (well within the cap).
    markSessionStart(0);
    vi.mocked(Date.now).mockReturnValue(1000);
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());

    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });

    expect(createSession).toHaveBeenCalledWith('mock-id-token', undefined);
    expect(result.current.user).toEqual(SESSION.user);
    expect(signOut).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
    // markSessionStart is idempotent — original start time is preserved.
    expect(getSessionStart()).toBe(0);
  });

  it('stamps a session start when none exists yet (first sign-in)', async () => {
    vi.mocked(Date.now).mockReturnValue(5000);
    vi.mocked(createSession).mockResolvedValue(SESSION);
    expect(getSessionStart()).toBeNull();

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());

    await act(async () => { await testState.authCallback?.(VERIFIED_GOOGLE); });

    expect(result.current.user).toEqual(SESSION.user);
    expect(getSessionStart()).toBe(5000);
  });
});

// ─── watchdog interval ───────────────────────────────────────────────────────

describe('AuthContext — watchdog', () => {
  // NOTE: we exercise the watchdog via its tab-focus listener rather than the
  // 60s setInterval. Driving the interval requires fake timers, which deadlock
  // against the real-timer `waitFor`/async sign-in flow used to reach a
  // logged-in state (the interval, focus, and visibilitychange listeners all
  // share the same `check()` → expireSession path, so the focus event covers
  // the same logic without timer fragility).
  it('expires the session on tab focus once the cap has elapsed while logged in', async () => {
    vi.mocked(Date.now).mockReturnValue(0);
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());

    // Settle to signed-out, then sign in (mounts the watchdog effect + listeners).
    await act(async () => { testState.authCallback?.(null); });
    await act(async () => { await result.current.signInGoogle(); });
    expect(result.current.user).toEqual(SESSION.user);
    expect(signOut).not.toHaveBeenCalled();

    // Age the session past the cap, then simulate the user refocusing the tab.
    vi.mocked(Date.now).mockReturnValue(SESSION_MAX_AGE_MS + 1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      // expireSession() awaits signOut(); let the macrotask queue drain.
      await new Promise((r) => setTimeout(r, 0));
    });

    await waitFor(() => expect(result.current.user).toBeNull());
    expect(signOut).toHaveBeenCalled();
    expect(result.current.error).toBe(SESSION_EXPIRED_MESSAGE);
    expectExpiryRedirect(loc.href, '/app');
  });

  it('does NOT expire the session on focus while still within the cap', async () => {
    vi.mocked(Date.now).mockReturnValue(0);
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());
    await act(async () => { testState.authCallback?.(null); });
    await act(async () => { await result.current.signInGoogle(); });

    // Advance, but stay just under the cap.
    vi.mocked(Date.now).mockReturnValue(SESSION_MAX_AGE_MS - 1);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(signOut).not.toHaveBeenCalled();
    expect(result.current.user).toEqual(SESSION.user);
  });
});

// ─── logout clears the session timestamp ─────────────────────────────────────

describe('AuthContext — logout', () => {
  it('clears the session start timestamp', async () => {
    vi.mocked(Date.now).mockReturnValue(1000);
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());
    await act(async () => { testState.authCallback?.(null); });

    await act(async () => { await result.current.signInGoogle(); });
    expect(getSessionStart()).toBe(1000);

    await act(async () => { await result.current.logout(); });

    expect(getSessionStart()).toBeNull();
    expect(result.current.user).toBeNull();
  });
});

// ─── sign-in resets a stale clock (user switch without logout) ────────────────

describe('AuthContext — sign-in resets the session clock', () => {
  it('stamps a fresh start on sign-in even if a stale timestamp is present', async () => {
    // A leftover timestamp from a prior user who never explicitly logged out.
    markSessionStart(0);
    vi.mocked(Date.now).mockReturnValue(5000);
    vi.mocked(signInWithPopup).mockResolvedValue({ user: VERIFIED_GOOGLE } as any);
    vi.mocked(createSession).mockResolvedValue(SESSION);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(onAuthStateChanged).toHaveBeenCalled());
    await act(async () => { testState.authCallback?.(null); });

    await act(async () => { await result.current.signInGoogle(); });

    // clearSessionStart() wiped the stale 0; markSessionStart() re-stamped at 5000.
    expect(getSessionStart()).toBe(5000);
  });
});
