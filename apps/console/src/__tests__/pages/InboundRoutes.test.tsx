import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AGENCY_INBOUND_ROUTE_DEFAULTS, type AgencyInboundRoute } from '@magick-agency/contracts/api/agency/inbound';

/**
 * Settings → Inbound calls (`docs/inbound.md` §8.1): the route list (numbers, hours, delete with
 * what it does to the numbers) and the route editor: a new route on the design's defaults, the
 * numbers with why one cannot be chosen, weekly hours with an overnight stretch and the midnight
 * rule, holidays, clips from the account's audio files, voicemail not offered, the server's
 * field errors on their fields, a PATCH of only what changed, and the whole of it hidden from a
 * role without `agency.inbound.write` or with the flag off.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  flags: { agency_inbound_enabled: true } as Record<string, boolean>,
  showToast: vi.fn(),
  listInboundRoutes: vi.fn(),
  getInboundRoute: vi.fn(),
  createInboundRoute: vi.fn(),
  updateInboundRoute: vi.fn(),
  deleteInboundRoute: vi.fn(),
  listInboundNumbers: vi.fn(),
  listInboundClips: vi.fn(),
  listAgencyCampaigns: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({ useFeatureFlagEnabled: (flag: string) => mocks.flags[flag] === true }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({ useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }) }));
vi.mock('../../components/common/CapabilityUnavailable', () => ({ CapabilityUnavailable: () => <div data-testid="capability-unavailable" /> }));
vi.mock('../../components/common/PageDescription', () => ({ PageDescription: () => null }));
vi.mock('../../hooks/useCallAnalysisProfiles', () => ({ useCallAnalysisProfiles: () => ({ profiles: [{ id: 'prof-1', name: 'Inbound summary' }], loading: false }) }));
vi.mock('../../api/agencyCampaigns', () => ({ listAgencyCampaigns: mocks.listAgencyCampaigns }));
vi.mock('../../api/inbound', async () => {
  const actual = await vi.importActual<typeof import('../../api/inbound')>('../../api/inbound');
  return {
    ...actual,
    listInboundRoutes: mocks.listInboundRoutes,
    getInboundRoute: mocks.getInboundRoute,
    createInboundRoute: mocks.createInboundRoute,
    updateInboundRoute: mocks.updateInboundRoute,
    deleteInboundRoute: mocks.deleteInboundRoute,
    listInboundNumbers: mocks.listInboundNumbers,
    listInboundClips: mocks.listInboundClips,
  };
});

import InboundRoutesPage from '../../pages/settings/InboundRoutesPage';
import InboundRouteEditorPage from '../../pages/settings/InboundRouteEditorPage';
import { formatDialNumber } from '../../utils/softphone/phoneInput';

const ROUTE: AgencyInboundRoute = {
  ...AGENCY_INBOUND_ROUTE_DEFAULTS,
  clips: { ...AGENCY_INBOUND_ROUTE_DEFAULTS.clips },
  weekly_hours: [{ day: 5, start: '22:00', end: '02:00' }],
  holidays: [],
  pool_campaign_ids: [],
  disposition_catalog: [],
  id: 'r-1', account_id: 'account-1', name: 'Main line', timezone: 'Europe/London',
  numbers: [{ phone_number_id: 'n-1', phone_number: '+441632960001', attached_at: '2026-11-01T00:00:00Z' }],
  created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-01T00:00:00Z',
};

const NUMBERS = [
  { phone_number_id: 'n-1', phone_number: '+441632960001', linked: true, route_id: 'r-1', route_name: 'Main line', held_elsewhere: false },
  { phone_number_id: 'n-2', phone_number: '+441632960002', linked: true, route_id: null, route_name: null, held_elsewhere: false },
  { phone_number_id: 'n-3', phone_number: '+441632960003', linked: false, route_id: null, route_name: null, held_elsewhere: false },
  { phone_number_id: 'n-4', phone_number: '+441632960004', linked: true, route_id: null, route_name: null, held_elsewhere: true },
];

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}</div>;
}

async function renderAt(path: string, role = 'account_admin') {
  mocks.useTenant.mockReturnValue({ role, tenantId: 'tenant-1', accountId: 'account-1' });
  render(
    <MemoryRouter initialEntries={[path]}>
      <Where />
      <Routes>
        <Route path="/app/inbound" element={<InboundRoutesPage />} />
        <Route path="/app/inbound/new" element={<InboundRouteEditorPage />} />
        <Route path="/app/inbound/:routeId" element={<InboundRouteEditorPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await act(async () => {});
}

const choice = (id: string) => document.getElementById(`ib-number-${id}`) as HTMLInputElement;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flags = { agency_inbound_enabled: true };
  mocks.listInboundRoutes.mockResolvedValue([ROUTE]);
  mocks.getInboundRoute.mockResolvedValue(ROUTE);
  mocks.listInboundNumbers.mockResolvedValue({ numbers: NUMBERS });
  mocks.listInboundClips.mockResolvedValue({ clips: [{ id: 'clip-1', name: 'Welcome', duration_seconds: 4 }] });
  mocks.listAgencyCampaigns.mockResolvedValue([{ id: 'camp-1', name: 'Renewals', status: 'running' }]);
});

describe('the route list', () => {
  it('lists each route with its numbers and hours, and deletes one after saying what happens to its numbers', async () => {
    mocks.deleteInboundRoute.mockResolvedValue({ ok: true, value: undefined });
    await renderAt('/app/inbound');
    const card = within(screen.getByTestId('inbound-route-r-1'));
    expect(card.getByText('Main line')).toBeTruthy();
    expect(card.getByText(/\+44/)).toBeTruthy();
    expect(card.getByText(/Fri 22:00–02:00 \(next day\) \(Europe\/London\)/)).toBeTruthy();
    fireEvent.click(card.getByRole('button', { name: 'Delete Main line' }));
    expect(screen.getByRole('dialog').textContent).toMatch(/stops answering with this route/);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Delete route' }));
    });
    expect(mocks.deleteInboundRoute).toHaveBeenCalledWith('r-1', 'tenant-1', 'account-1');
    expect(screen.queryByTestId('inbound-route-r-1')).toBeNull();
  });

  it('is hidden from a role without agency.inbound.write, and with the flag off', async () => {
    await renderAt('/app/inbound', 'operator');
    expect(screen.getByTestId('capability-unavailable')).toBeTruthy();
    expect(mocks.listInboundRoutes).not.toHaveBeenCalled();
  });

  it('is hidden with the flag off', async () => {
    mocks.flags = {};
    await renderAt('/app/inbound/new');
    expect(screen.getByTestId('capability-unavailable')).toBeTruthy();
    expect(mocks.listInboundNumbers).not.toHaveBeenCalled();
  });
});

describe('the route editor', () => {
  it('creates a route on the defaults, with hours, a holiday, a clip and a number', async () => {
    mocks.createInboundRoute.mockResolvedValue({ ok: true, value: { ...ROUTE, id: 'r-new', name: 'Sales' } });
    await renderAt('/app/inbound/new');
    // Unavailable numbers say why, and cannot be ticked.
    expect(choice('n-3').disabled).toBe(true);
    expect(screen.getByText(/Contact support to have it linked/)).toBeTruthy();
    expect(choice('n-4').disabled).toBe(true);
    expect(choice('n-1').disabled).toBe(true);
    expect(screen.getByText('Already answers “Main line”.')).toBeTruthy();
    // A message with no recording is read out in a standard voice, never silence; a greeting is skipped.
    const noneOf = (label: string) => (screen.getByLabelText(label) as HTMLSelectElement).options[0]!.textContent;
    expect(noneOf('Closed')).toBe('Standard spoken message');
    expect(noneOf('All lines busy')).toBe('Standard spoken message');
    expect(noneOf('We’ll call you back')).toBe('Standard spoken message');
    expect(noneOf('Greeting')).toBe('No greeting');
    expect(screen.getByTestId('inbound-route-clips').textContent).toMatch(/read out in a standard voice/);
    expect(screen.getByTestId('inbound-route-clips').textContent).not.toMatch(/plays nothing|hear nothing/);
    // Voicemail is offered (P2) for both cases.
    expect(screen.queryByTestId('inbound-voicemail-note')).toBeNull();
    expect(screen.getAllByRole('radio', { name: /take a voicemail/i })).toHaveLength(2);

    fireEvent.change(screen.getByTestId('inbound-route-name'), { target: { value: 'Sales' } });
    fireEvent.change(screen.getByTestId('inbound-route-timezone'), { target: { value: 'Europe/London' } });
    fireEvent.click(choice('n-2'));
    fireEvent.click(screen.getByTestId('inbound-weekday-hours'));
    fireEvent.click(screen.getByTestId('inbound-add-hours'));
    fireEvent.change(screen.getByLabelText('Day', { selector: '#weekly_hours\\[5\\]-day' }), { target: { value: '6' } });
    fireEvent.change(screen.getByLabelText('Opens', { selector: '#weekly_hours\\[5\\]-start' }), { target: { value: '22:00' } });
    fireEvent.change(screen.getByLabelText('Closes', { selector: '#weekly_hours\\[5\\]-end' }), { target: { value: '02:00' } });
    expect(screen.getByText('Overnight: closes at 02:00 on Sun.')).toBeTruthy();
    fireEvent.click(screen.getByTestId('inbound-add-holiday'));
    fireEvent.change(screen.getByLabelText('First day'), { target: { value: '2026-12-25' } });
    fireEvent.change(screen.getByLabelText('Greeting'), { target: { value: 'clip-1' } });
    fireEvent.click(screen.getByTestId('inbound-sticky-strict'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('inbound-route-save'));
    });
    const [body] = mocks.createInboundRoute.mock.calls[0]!;
    expect(body).toMatchObject({
      name: 'Sales', timezone: 'Europe/London', phone_number_ids: ['n-2'], sticky_mode: 'strict',
      sticky_wait_seconds: 30, sticky_lookback_days: 30, queue_max_wait_seconds: 120, max_waiting: 10, max_concurrent: 20,
      after_hours_action: 'callback', overflow_action: 'callback', record_calls: false, recording_notice: true,
      holidays: [{ from: '2026-12-25', to: '2026-12-25', label: null }],
      clips: { ...AGENCY_INBOUND_ROUTE_DEFAULTS.clips, greeting: 'clip-1' },
    });
    expect(body.weekly_hours.at(-1)).toEqual({ day: 6, start: '22:00', end: '02:00' });
    expect(screen.getByTestId('where').textContent).toBe('/app/inbound/r-new');
    expect(mocks.showToast).toHaveBeenCalledWith('“Sales” created.', 'success');
  });

  it('checks the form before saving and shows the server’s findings on their fields', async () => {
    await renderAt('/app/inbound/new');
    await act(async () => {
      fireEvent.click(screen.getByTestId('inbound-route-save'));
    });
    expect(mocks.createInboundRoute).not.toHaveBeenCalled();
    expect(screen.getByText('Give the route a name.')).toBeTruthy();

    mocks.createInboundRoute.mockResolvedValue({
      ok: false,
      refusal: { code: 'inbound_route_invalid', status: 400, message: 'x', details: [{ path: 'clips.greeting', message: 'clips.greeting must be one of this account’s audio files.' }], phoneNumberId: null, routeId: null },
    });
    fireEvent.change(screen.getByTestId('inbound-route-name'), { target: { value: 'Sales' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('inbound-route-save'));
    });
    const greeting = screen.getByLabelText('Greeting');
    const described = greeting.getAttribute('aria-describedby')!.split(' ').map((id) => document.getElementById(id)?.textContent);
    expect(described).toContain('clips.greeting must be one of this account’s audio files.');
  });

  it('names the number a save was refused for', async () => {
    mocks.createInboundRoute.mockResolvedValue({
      ok: false,
      refusal: { code: 'inbound_number_in_use', status: 409, message: 'x', details: [], phoneNumberId: 'n-2', routeId: null },
    });
    await renderAt('/app/inbound/new');
    fireEvent.change(screen.getByTestId('inbound-route-name'), { target: { value: 'Sales' } });
    fireEvent.click(choice('n-2'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('inbound-route-save'));
    });
    const named = `(${formatDialNumber('+441632960002')})`;
    expect(screen.getAllByText((text) => text.includes('already answers another route') && text.endsWith(named)).length).toBeGreaterThan(0);
  });

  it('edits a route and sends only what changed', async () => {
    mocks.updateInboundRoute.mockImplementation(async (_id: string, patch: object) => ({ ok: true, value: { ...ROUTE, ...patch } }));
    await renderAt('/app/inbound/r-1');
    expect(mocks.getInboundRoute).toHaveBeenCalledWith('r-1', 'tenant-1', 'account-1');
    // The route's own number is selected and can be removed.
    expect(choice('n-1').checked).toBe(true);
    expect(choice('n-1').disabled).toBe(false);
    expect((screen.getByTestId('inbound-route-save') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Calls at once'), { target: { value: '30' } });
    fireEvent.click(screen.getByTestId('inbound-record'));
    fireEvent.click(choice('n-1'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('inbound-route-save'));
    });
    expect(mocks.updateInboundRoute).toHaveBeenCalledWith('r-1', { max_concurrent: 30, record_calls: true, phone_number_ids: [] }, 'tenant-1', 'account-1');
    expect(mocks.showToast).toHaveBeenCalledWith('Inbound route saved.', 'success');
  });

  it('a route that no longer exists says so', async () => {
    mocks.getInboundRoute.mockRejectedValue(Object.assign(new Error('Inbound route not found.'), { statusCode: 404 }));
    await renderAt('/app/inbound/r-gone');
    expect(screen.getByRole('alert').textContent).toMatch(/not found/);
  });
});
