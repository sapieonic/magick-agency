import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import type { SessionResponse } from '../../types/auth';

/**
 * Sign-out is in place (`setState(SIGNED_OUT)`), not a page load, so what one person's session
 * left in module stores must be cleared with it: another person signing in to the same account
 * in the same tab must not be shown the last one's campaign list (search) or badge counts.
 */

const testState = vi.hoisted(() => ({
  mockAuth: { currentUser: null as unknown },
  authCallback: null as ((user: unknown) => Promise<void> | void) | null,
}));

const api = vi.hoisted(() => ({
  listAgencyCampaignsPage: vi.fn(),
  getAgencyCampaignStats: vi.fn(),
}));

vi.mock('firebase/app', () => ({ initializeApp: vi.fn(() => ({})) }));
vi.mock('firebase/auth', () => ({
  getAuth: vi.fn(() => testState.mockAuth),
  onAuthStateChanged: vi.fn((_auth: unknown, cb: (user: unknown) => void) => {
    testState.authCallback = cb;
    return vi.fn();
  }),
  signInWithEmailAndPassword: vi.fn(),
  signInWithPopup: vi.fn(),
  sendEmailVerification: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  signOut: vi.fn(),
  GoogleAuthProvider: vi.fn(),
}));
vi.mock('../../api/auth', () => ({ createSession: vi.fn(), getMe: vi.fn() }));
vi.mock('../../api/agencyCampaigns', () => ({
  listAgencyCampaignsPage: api.listAgencyCampaignsPage,
  getAgencyCampaignStats: api.getAgencyCampaignStats,
}));
vi.mock('../../api/agencyInsights', () => ({ getInsightsAllocation: vi.fn(() => new Promise(() => {})) }));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 't1', accountId: 'acc-1' }),
}));

import { AuthProvider, useAuth } from '../../contexts/AuthContext';
import { signInWithPopup } from 'firebase/auth';
import { createSession } from '../../api/auth';
import { useSearchCampaigns } from '../../hooks/useSearchCampaigns';
import { publishCampaignTabBadge, resetCampaignTabBadges, useCampaignTabBadge } from '../../hooks/useCampaignTabBadges';
import { readRecentCampaigns, rememberCampaignVisit } from '../../utils/recentCampaigns';
import { homeAcksKey, resetHomeAcksForTests, useHomeAcks } from '../../hooks/useHomeAcks';
import type { HomeAttentionItem } from '../../utils/agency/home';

function session(id: string): SessionResponse {
  return {
    user: { id, firebase_uid: `fb-${id}`, email: `${id}@b.com`, display_name: id, avatar_url: null, status: 'active', created_at: '', updated_at: '' },
    tenants: [{ id: 't1', name: 'T', slug: 't', settings: {}, status: 'active', created_at: '', updated_at: '' }],
    memberships: [{ id: `m-${id}`, user_id: id, tenant_id: 't1', account_id: null, role: 'tenant_owner', status: 'active', invited_by: null, created_at: '', updated_at: '' }],
    is_new: false,
    settings: {},
  };
}

const fbUser = {
  emailVerified: true,
  providerData: [{ providerId: 'google.com' }],
  getIdToken: vi.fn().mockResolvedValue('token'),
  reload: vi.fn().mockResolvedValue(undefined),
};

function wrapper({ children }: { children: ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}

async function signIn(result: { current: ReturnType<typeof useAuth> }, id: string) {
  vi.mocked(createSession).mockResolvedValue(session(id));
  await act(async () => {
    await result.current.signInGoogle();
  });
  expect(result.current.user?.id).toBe(id);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetCampaignTabBadges();
  resetHomeAcksForTests();
  testState.authCallback = null;
  localStorage.clear();
  vi.mocked(signInWithPopup).mockResolvedValue({ user: fbUser } as never);
  api.listAgencyCampaignsPage.mockResolvedValue({ campaigns: [{ id: 'c-1', name: 'Diwali renewals' }], total: 1 });
  api.getAgencyCampaignStats.mockReturnValue(new Promise(() => {}));
});

describe('sign-out', () => {
  it('empties search’s campaign list, its recent campaigns and the badge counts before the next person signs in', async () => {
    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(testState.authCallback).not.toBeNull());
    await act(async () => {
      await testState.authCallback?.(null);
    });
    await signIn(result, 'u-first');

    // The first person's session fills both stores.
    const firstSearch = renderHook(() => useSearchCampaigns(true, 't1', 'acc-1'));
    await waitFor(() => expect(firstSearch.result.current.status).toBe('ready'));
    firstSearch.unmount();
    act(() => publishCampaignTabBadge('onShift', 't1', 'acc-1', 'c-1', 7));
    const firstBadge = renderHook(() => useCampaignTabBadge('onShift', 'c-1', true));
    expect(firstBadge.result.current).toBe(7);
    firstBadge.unmount();
    rememberCampaignVisit('t1', 'acc-1', 'c-1', 'Diwali renewals');
    expect(readRecentCampaigns('t1', 'acc-1')).toHaveLength(1);

    await act(async () => {
      await result.current.logout();
    });
    await signIn(result, 'u-second');

    // The second person, same account, same tab: nothing held over.
    const secondSearch = renderHook(() => useSearchCampaigns(true, 't1', 'acc-1'));
    expect(secondSearch.result.current).toEqual({ status: 'loading', campaigns: null });
    const secondBadge = renderHook(() => useCampaignTabBadge('onShift', 'c-1', true));
    expect(secondBadge.result.current).toBeNull();
    expect(api.getAgencyCampaignStats).toHaveBeenCalledTimes(1);
    expect(readRecentCampaigns('t1', 'acc-1')).toEqual([]);
  });

  it('forgets Home’s "Got it" rows held in the tab, even for the same person signing back in', async () => {
    const { result } = renderHook(() => ({ auth: useAuth(), home: useHomeAcks('t1', 'acc-1') }), { wrapper });
    const auth = { get current() { return result.current.auth; } };
    await waitFor(() => expect(testState.authCallback).not.toBeNull());
    await act(async () => {
      await testState.authCallback?.(null);
    });
    await signIn(auth, 'u-first');
    act(() => result.current.home.acknowledge({
      id: 'callbacks-overdue:c-1', kind: 'callbacks-overdue', tone: 'danger', count: 2, ackable: true,
    } as HomeAttentionItem));
    expect(Object.keys(result.current.home.acks)).toEqual(['callbacks-overdue:c-1']);
    // Kept under this person's id, and nobody else's.
    expect(localStorage.getItem(homeAcksKey('u-first', 't1', 'acc-1'))).not.toBeNull();
    // As a private window would have: nothing in storage, so only the in-tab copy holds the row.
    localStorage.removeItem(homeAcksKey('u-first', 't1', 'acc-1'));
    expect(Object.keys(result.current.home.acks)).toEqual(['callbacks-overdue:c-1']);

    await act(async () => {
      await result.current.auth.logout();
    });
    await signIn(auth, 'u-first');
    expect(result.current.home.acks).toEqual({});
  });

  it('drops a badge read that was still on its way when the stores were cleared', async () => {
    let answer: (value: { agents: never[] }) => void = () => {};
    api.getAgencyCampaignStats.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const badge = renderHook(() => useCampaignTabBadge('onShift', 'c-1', true));
    expect(api.getAgencyCampaignStats).toHaveBeenCalledTimes(1);
    act(() => resetCampaignTabBadges());
    await act(async () => {
      answer({ agents: [] });
    });
    expect(badge.result.current).toBeNull();
  });
});
