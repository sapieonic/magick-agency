import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';

vi.mock('../../api/super-admin', () => ({
  superAdminLogin: vi.fn(),
  getSuperAdminMe: vi.fn(),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  hasToken: vi.fn(),
}));

import { SuperAdminProvider, useSuperAdmin } from '../../contexts/SuperAdminContext';
import {
  superAdminLogin,
  getSuperAdminMe,
  setToken,
  clearToken,
  hasToken,
} from '../../api/super-admin';

const ADMIN = {
  id: 'sa-1',
  email: 'admin@test.com',
  name: 'Super Admin',
  status: 'active' as const,
  is_system: false,
  created_at: '2024-01-01T00:00:00Z',
  updated_at: '2024-01-01T00:00:00Z',
};

const LOGIN_RESPONSE = {
  token: 'jwt-tok',
  admin: { id: ADMIN.id, email: ADMIN.email, name: ADMIN.name },
};

function wrapper({ children }: { children: ReactNode }) {
  return <SuperAdminProvider>{children}</SuperAdminProvider>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── hook guard ──────────────────────────────────────────────────────────────

describe('useSuperAdmin', () => {
  it('throws when used outside SuperAdminProvider', () => {
    expect(() => renderHook(() => useSuperAdmin())).toThrow(
      'useSuperAdmin must be used within SuperAdminProvider',
    );
  });
});

// ─── mount behaviour ─────────────────────────────────────────────────────────

describe('SuperAdminProvider — mount', () => {
  it('sets admin null and loading false when no token exists', async () => {
    vi.mocked(hasToken).mockReturnValue(false);

    const { result } = renderHook(() => useSuperAdmin(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.admin).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.error).toBeNull();
    expect(getSuperAdminMe).not.toHaveBeenCalled();
  });

  it('validates existing token and loads admin profile', async () => {
    vi.mocked(hasToken).mockReturnValue(true);
    vi.mocked(getSuperAdminMe).mockResolvedValue({ admin: ADMIN });

    const { result } = renderHook(() => useSuperAdmin(), { wrapper });

    expect(result.current.loading).toBe(true);
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.admin).toEqual(ADMIN);
    expect(result.current.isAuthenticated).toBe(true);
  });

  it('clears token and resets state when token validation fails', async () => {
    vi.mocked(hasToken).mockReturnValue(true);
    vi.mocked(getSuperAdminMe).mockRejectedValue(new Error('expired'));

    const { result } = renderHook(() => useSuperAdmin(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(clearToken).toHaveBeenCalled();
    expect(result.current.admin).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

// ─── login ───────────────────────────────────────────────────────────────────

describe('login', () => {
  beforeEach(() => {
    vi.mocked(hasToken).mockReturnValue(false);
  });

  it('sets token, fetches admin profile, and returns the login response', async () => {
    vi.mocked(superAdminLogin).mockResolvedValue(LOGIN_RESPONSE);
    vi.mocked(getSuperAdminMe).mockResolvedValue({ admin: ADMIN });

    const { result } = renderHook(() => useSuperAdmin(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let response: unknown;
    await act(async () => {
      response = await result.current.login('admin@test.com', 'pass');
    });

    expect(superAdminLogin).toHaveBeenCalledWith('admin@test.com', 'pass');
    expect(setToken).toHaveBeenCalledWith('jwt-tok');
    expect(getSuperAdminMe).toHaveBeenCalled();
    expect(result.current.admin).toEqual(ADMIN);
    expect(result.current.isAuthenticated).toBe(true);
    expect(result.current.error).toBeNull();
    expect(response).toEqual(LOGIN_RESPONSE);
  });

  it('sets loading true while login is in progress', async () => {
    let resolveLogin!: (v: typeof LOGIN_RESPONSE) => void;
    vi.mocked(superAdminLogin).mockImplementation(
      () => new Promise((res) => { resolveLogin = res; }),
    );
    vi.mocked(getSuperAdminMe).mockResolvedValue({ admin: ADMIN });

    const { result } = renderHook(() => useSuperAdmin(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    // Start login — should set loading
    let loginPromise: Promise<unknown>;
    act(() => {
      loginPromise = result.current.login('a@b.com', 'p');
    });
    await waitFor(() => expect(result.current.loading).toBe(true));

    // Resolve login
    await act(async () => {
      resolveLogin(LOGIN_RESPONSE);
      await loginPromise!;
    });
    expect(result.current.loading).toBe(false);
  });

  it('sets error and re-throws when superAdminLogin rejects', async () => {
    vi.mocked(superAdminLogin).mockRejectedValue(new Error('bad creds'));

    const { result } = renderHook(() => useSuperAdmin(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let caught: Error | undefined;
    await act(async () => {
      try {
        await result.current.login('x@y.com', 'wrong');
      } catch (e) {
        caught = e as Error;
      }
    });

    expect(caught?.message).toBe('bad creds');
    expect(result.current.error).toBe('bad creds');
    expect(result.current.admin).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(setToken).not.toHaveBeenCalled();
  });

  it('sets error when getSuperAdminMe fails after successful login', async () => {
    vi.mocked(superAdminLogin).mockResolvedValue(LOGIN_RESPONSE);
    vi.mocked(getSuperAdminMe).mockRejectedValue(new Error('profile fetch failed'));

    const { result } = renderHook(() => useSuperAdmin(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    let caught: Error | undefined;
    await act(async () => {
      try {
        await result.current.login('a@b.com', 'p');
      } catch (e) {
        caught = e as Error;
      }
    });

    // Token was already set before the error
    expect(setToken).toHaveBeenCalledWith('jwt-tok');
    expect(caught?.message).toBe('profile fetch failed');
    expect(result.current.error).toBe('profile fetch failed');
    expect(result.current.admin).toBeNull();
  });

  it('uses generic message when error is not an Error instance', async () => {
    vi.mocked(superAdminLogin).mockRejectedValue('string-error');

    const { result } = renderHook(() => useSuperAdmin(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      try {
        await result.current.login('a@b.com', 'p');
      } catch { /* expected */ }
    });

    expect(result.current.error).toBe('Login failed');
  });
});

// ─── logout ──────────────────────────────────────────────────────────────────

describe('logout', () => {
  it('clears token and resets state', async () => {
    vi.mocked(hasToken).mockReturnValue(true);
    vi.mocked(getSuperAdminMe).mockResolvedValue({ admin: ADMIN });

    const { result } = renderHook(() => useSuperAdmin(), { wrapper });
    await waitFor(() => expect(result.current.isAuthenticated).toBe(true));

    act(() => {
      result.current.logout();
    });

    expect(clearToken).toHaveBeenCalled();
    expect(result.current.admin).toBeNull();
    expect(result.current.isAuthenticated).toBe(false);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });
});

// ─── isAuthenticated ─────────────────────────────────────────────────────────

describe('isAuthenticated', () => {
  it('is false when admin is null', async () => {
    vi.mocked(hasToken).mockReturnValue(false);

    const { result } = renderHook(() => useSuperAdmin(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isAuthenticated).toBe(false);
  });

  it('is true when admin is set', async () => {
    vi.mocked(hasToken).mockReturnValue(true);
    vi.mocked(getSuperAdminMe).mockResolvedValue({ admin: ADMIN });

    const { result } = renderHook(() => useSuperAdmin(), { wrapper });
    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.isAuthenticated).toBe(true);
  });
});
