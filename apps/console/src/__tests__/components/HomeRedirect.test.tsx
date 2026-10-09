import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

/**
 * The app root, routed on entitlement (handoff E4).
 *
 * ── What is worth pinning ──────────────────────────────────────────────────
 * The two errors this component can make are not symmetrical, and every case
 * below is written from that asymmetry. Redirecting a tenant that is NOT
 * agency-only strands a paying customer outside the product they opened;
 * failing to redirect one that IS leaves them exactly where they were before
 * this component existed. So the tests are mostly about the second kind — the
 * ways the predicate must refuse to fire — and only one of them is the happy
 * path.
 *
 * There is now a third kind, and it outranks both: never leaving the reader on a
 * screen they cannot get off. `/` renders no chrome of its own, so a permanent
 * spinner here has no sign-out in it. The no-tenant cases at the bottom are that
 * bound.
 *
 * The predicate is exercised twice over: once as a pure function, where an
 * absent key and a `false` key can be told apart without a DOM, and once
 * through the component, where the waiting and the feature-flag clause live.
 */
/*
 * PORT NOTE (magick-agency): `isAgencyOnlyTenant` and `PRIMARY_APP_PRODUCTS` are
 * not ported (every agency tenant is agency-only; the predicate is the dialer
 * flag alone — see `HomeRedirect`), so their seven cases are deleted, and so are
 * "sends an AI-only tenant to the current default" and "defaults when the
 * governance read failed" (there is no AI-only tenant and no governance read).
 * "sends a both-products tenant to the current default" is MODIFIED into the
 * case that pins the new predicate: a capability map that cusui read as
 * both-products still lands in `/agency`. The maps below are kept as fixtures.
 */
const mocks = vi.hoisted(() => ({
  useAuth: vi.fn(),
  useGovernance: vi.fn(),
  useFeatureFlags: vi.fn(),
}));

vi.mock('../../contexts/AuthContext', () => ({ useAuth: mocks.useAuth }));
vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: mocks.useGovernance }));
vi.mock('../../contexts/FeatureFlagsContext', () => ({ useFeatureFlags: mocks.useFeatureFlags }));

import HomeRedirect from '../../components/auth/HomeRedirect';

/**
 * A dense map, the shape master's resolver actually returns — every catalog key
 * present, at the catalog's own defaults. This is the effective map of a tenant
 * with no overrides at all, i.e. an ordinary AI-product tenant.
 */
function governanceMap(over: Record<string, boolean> = {}): Record<string, boolean> {
  return {
    calls: true,
    'calls.analytics': true,
    'calls.recording': true,
    'calls.dialer': false,
    'calls.dialer.analytics': false,
    sip: false,
    messaging: true,
    ivr: true,
    campaigns: true,
    scheduling: true,
    knowledge_bases: false,
    escalation: false,
    agency: false,
    'agency.recording': false,
    'agency.analytics': false,
    ...over,
  };
}

/**
 * The map an operator provisioning a pure-agency tenant produces: `agency` on,
 * and every on-by-default primary-app product explicitly off. The off-by-default
 * grant keys (`calls.dialer`, `sip`, `knowledge_bases`, `escalation`) need no
 * override — they are already `false` above, which is the point made in
 * `HomeRedirect`'s note about what the four extra keys cost.
 */
function agencyOnlyMap(over: Record<string, boolean> = {}): Record<string, boolean> {
  return governanceMap({
    agency: true,
    campaigns: false,
    messaging: false,
    ivr: false,
    scheduling: false,
    ...over,
  });
}

function Where() {
  return <div data-testid="where">{useLocation().pathname}</div>;
}

function renderRoot() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route path="/" element={<HomeRedirect />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

function landsOn(): string | null {
  return screen.queryByTestId('where')?.textContent ?? null;
}

beforeEach(() => {
  // The ordinary case: signed in with a tenant, both maps resolved, the flag on.
  // Each test overrides whichever half it is about.
  mocks.useAuth.mockReturnValue({ tenants: [{ id: 'tenant-1' }] });
  mocks.useGovernance.mockReturnValue({ map: governanceMap(), loading: false });
  mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => true, status: 'ready' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('HomeRedirect', () => {
  it('sends an agency-only tenant to the agency workspace', () => {
    mocks.useGovernance.mockReturnValue({ map: agencyOnlyMap(), loading: false });
    renderRoot();
    expect(landsOn()).toBe('/agency');
  });

  it('routes on the dialer flag alone — a map cusui read as both-products still lands in /agency', () => {
    mocks.useGovernance.mockReturnValue({ map: governanceMap({ agency: true }), loading: false });
    renderRoot();
    expect(landsOn()).toBe('/agency');
  });

  it('WAITS while the capability map is loading — it does not flash a shell', () => {
    /**
     * Both halves matter. Nothing has navigated yet (no flash of the wrong
     * shell, and no blank screen either — there is a spinner), and the decision
     * is still to come. Redirecting during `loading` would look like the
     * fail-safe rule and in fact disable the feature: the map is empty until the
     * active-context fetch lands, so "decide now" always means `/app`.
     */
    mocks.useGovernance.mockReturnValue({ map: agencyOnlyMap(), loading: true });
    renderRoot();
    expect(landsOn()).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('waits for the feature-flag map too, for the same reason', () => {
    mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => true, status: 'loading' });
    mocks.useGovernance.mockReturnValue({ map: agencyOnlyMap(), loading: false });
    renderRoot();
    expect(landsOn()).toBeNull();
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('does NOT redirect on the capability alone when core has the flag off', () => {
    /**
     * `/agency` is gated on `agency_dialer_enabled` as well as on the capability,
     * so a redirect that only checked governance would land the reader on a
     * plan-gate refusal with no shell around it — stranded one layer further in
     * than before. `useFeatureFlags` fails closed, so an errored flag map takes
     * the same branch.
     */
    mocks.useGovernance.mockReturnValue({ map: agencyOnlyMap(), loading: false });
    mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => false, status: 'ready' });
    renderRoot();
    expect(landsOn()).toBe('/app');
  });

  it('reads the agency flag by name, not whatever flag it is handed', () => {
    mocks.useGovernance.mockReturnValue({ map: agencyOnlyMap(), loading: false });
    const isEnabled = vi.fn((flag: string) => flag === 'agency_dialer_enabled');
    mocks.useFeatureFlags.mockReturnValue({ isEnabled, status: 'ready' });
    renderRoot();
    expect(isEnabled).toHaveBeenCalledWith('agency_dialer_enabled');
    expect(landsOn()).toBe('/agency');
  });

  it('does not trap a signed-in user who has NO tenant', () => {
    /**
     * The regression this bound closes, and the one failure mode here that is
     * worse than landing on the wrong shell.
     *
     * With no tenant, `TenantContext`'s auto-select effect returns early, so
     * `activeTenantId` stays null, `accountResolution` stays `'loading'` ("nothing
     * to resolve yet") and `FeatureFlagsContext` reports `status: 'loading'` for
     * the life of the session — nothing can ever set the tenant that every other
     * exit needs. Waiting on that renders a full-viewport spinner at a URL with no
     * top bar, so no sign-out: a user whose only membership was revoked could not
     * even leave. `/app` renders `AppLayout`, which has one.
     */
    mocks.useAuth.mockReturnValue({ tenants: [] });
    mocks.useFeatureFlags.mockReturnValue({ isEnabled: () => true, status: 'loading' });
    renderRoot();
    expect(landsOn()).toBe('/app');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('decides for a tenant-less user without waiting on governance either', () => {
    // The bound sits ahead of BOTH waits on purpose: there is no entitlement
    // question without a tenant, so neither map can change the answer. Pinned
    // separately because ordering the guard after the spinner would still pass the
    // case above (where only the flag status is stuck) and reintroduce the trap
    // for anyone whose governance fetch is in flight.
    mocks.useAuth.mockReturnValue({ tenants: [] });
    mocks.useGovernance.mockReturnValue({ map: agencyOnlyMap(), loading: true });
    renderRoot();
    expect(landsOn()).toBe('/app');
    expect(screen.queryByRole('status')).toBeNull();
  });
});
