import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AGENCY_INBOUND_ROUTE_DEFAULTS, type AgencyInboundRoute } from '@magick-agency/contracts/api/agency/inbound';

/**
 * The route editor once the server's build records voicemail (P2): what happens to a call nobody
 * answers is offered from `AGENCY_INBOUND_AVAILABLE_ACTIONS`, so widening that list (one line on
 * the server's side) is all it takes for voicemail to appear here. This suite widens it; the
 * route editor's own suite (`InboundRoutes.test.tsx`) pins the build where it is callback alone
 * and no choice is shown.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getInboundRoute: vi.fn(),
  updateInboundRoute: vi.fn(),
  listInboundNumbers: vi.fn(),
  listInboundClips: vi.fn(),
  listAgencyCampaigns: vi.fn(),
}));

vi.mock('../../types/inbound', async () => {
  const actual = await vi.importActual<typeof import('../../types/inbound')>('../../types/inbound');
  return { ...actual, AGENCY_INBOUND_AVAILABLE_ACTIONS: Object.freeze(['callback', 'voicemail']) };
});
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({ useFeatureFlagEnabled: () => true }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn(), showErrorToast: vi.fn() }) }));
vi.mock('../../components/common/PageDescription', () => ({ PageDescription: () => null }));
vi.mock('../../hooks/useCallAnalysisProfiles', () => ({ useCallAnalysisProfiles: () => ({ profiles: [], loading: false }) }));
vi.mock('../../api/agencyCampaigns', () => ({ listAgencyCampaigns: mocks.listAgencyCampaigns }));
vi.mock('../../api/inbound', async () => {
  const actual = await vi.importActual<typeof import('../../api/inbound')>('../../api/inbound');
  return {
    ...actual,
    getInboundRoute: mocks.getInboundRoute,
    updateInboundRoute: mocks.updateInboundRoute,
    listInboundNumbers: mocks.listInboundNumbers,
    listInboundClips: mocks.listInboundClips,
  };
});

import InboundRouteEditorPage from '../../pages/settings/InboundRouteEditorPage';

const ROUTE: AgencyInboundRoute = {
  ...AGENCY_INBOUND_ROUTE_DEFAULTS,
  clips: { ...AGENCY_INBOUND_ROUTE_DEFAULTS.clips },
  weekly_hours: [{ day: 1, start: '09:00', end: '17:00' }],
  holidays: [],
  pool_campaign_ids: [],
  disposition_catalog: [],
  id: 'r-1', account_id: 'account-1', name: 'Main line', timezone: 'Europe/London',
  numbers: [{ phone_number_id: 'n-1', phone_number: '+441632960001', attached_at: '2026-11-01T00:00:00Z' }],
  created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({ role: 'account_admin', tenantId: 'tenant-1', accountId: 'account-1' });
  mocks.getInboundRoute.mockResolvedValue(ROUTE);
  mocks.listInboundNumbers.mockResolvedValue({
    numbers: [{ phone_number_id: 'n-1', phone_number: '+441632960001', linked: true, route_id: 'r-1', route_name: 'Main line', held_elsewhere: false }],
  });
  mocks.listInboundClips.mockResolvedValue({ clips: [] });
  mocks.listAgencyCampaigns.mockResolvedValue([]);
  mocks.updateInboundRoute.mockImplementation(async (_id: string, patch: object) => ({ ok: true, value: { ...ROUTE, ...patch } }));
});

describe('voicemail, once the server offers it', () => {
  it('offers both actions out of hours and when nobody can answer, and saves only the one changed', async () => {
    render(
      <MemoryRouter initialEntries={['/app/inbound/r-1']}>
        <Routes>
          <Route path="/app/inbound/:routeId" element={<InboundRouteEditorPage />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {});

    expect(screen.queryByTestId('inbound-voicemail-note')).toBeNull();
    const afterHours = within(screen.getByTestId('inbound-after-hours-action'));
    const overflow = within(screen.getByTestId('inbound-overflow-action'));
    expect(screen.getByRole('group', { name: 'Out of hours' })).toBe(screen.getByTestId('inbound-after-hours-action'));
    expect(screen.getByRole('group', { name: 'When nobody can answer' })).toBe(screen.getByTestId('inbound-overflow-action'));
    expect((afterHours.getByRole('radio', { name: /call them back/i }) as HTMLInputElement).checked).toBe(true);
    expect(afterHours.getByRole('radio', { name: /take a voicemail/i })).toBeTruthy();

    fireEvent.click(overflow.getByRole('radio', { name: /take a voicemail/i }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('inbound-route-save'));
    });
    expect(mocks.updateInboundRoute).toHaveBeenCalledWith('r-1', { overflow_action: 'voicemail' }, 'tenant-1', 'account-1');
  });
});
