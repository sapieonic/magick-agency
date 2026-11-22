import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Settings → Calls (`docs/call-log.md` §5): the account's switch "Every call must belong to a
 * campaign", in the proposal's words. What it needs is listed beside it; an inbound number with no
 * campaign for unknown callers keeps the switch off (here and on the server); agents on no running
 * campaign are told for information. Switching on asks first.
 */

const mocks = vi.hoisted(() => ({
  role: 'account_admin' as string,
  flags: { agency_inbound_enabled: true } as Record<string, boolean>,
  getCallSettings: vi.fn(),
  putCallSettings: vi.fn(),
  showToast: vi.fn(),
}));

vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({ tenantId: 't-1', accountId: 'a-1', role: mocks.role }),
}));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({ useFeatureFlagEnabled: (flag: string) => mocks.flags[flag] === true }));
vi.mock('../../pages/settings/useSettingsNav', () => ({
  useSettingsNav: () => ({ groups: [], names: { accountName: 'Acme Collections', tenantName: 'Acme' }, gate: {} }),
}));
vi.mock('../../components/common/PageDescription', () => ({ PageDescription: () => null }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));
vi.mock('../../api/callSettings', () => ({
  getCallSettings: mocks.getCallSettings,
  putCallSettings: mocks.putCallSettings,
}));

import CallsSettingsPage from '../../pages/settings/CallsSettingsPage';
import type { AgencyCallSettingsResponse } from '../../types/call-settings';

const OFF: AgencyCallSettingsResponse = {
  settings: { require_campaign: false, require_campaign_since: null, updated_at: null },
  readiness: { routes_missing_default: [], agents_without_campaign: [], agents_without_campaign_total: 0, unfiled_calls: 0 },
};
const ON: AgencyCallSettingsResponse = {
  ...OFF,
  settings: { require_campaign: true, require_campaign_since: '2026-11-22T09:30:00.000Z', updated_at: '2026-11-22T09:30:00.000Z' },
};
const BLOCKED: AgencyCallSettingsResponse = {
  ...OFF,
  readiness: {
    routes_missing_default: [{ route_id: 'r-sales', name: 'Sales line' }, { route_id: 'r-support', name: 'Support line' }],
    agents_without_campaign: [
      { user_id: 'u-1', name: 'Arjun Mehta' }, { user_id: 'u-2', name: 'Rohit Bansal' },
      { user_id: 'u-3', name: 'Neha Gupta' }, { user_id: 'u-4', name: 'Sameer Khan' },
    ],
    agents_without_campaign_total: 4,
    unfiled_calls: 41,
  },
};

async function renderPage(data: AgencyCallSettingsResponse = OFF) {
  mocks.getCallSettings.mockResolvedValue(data);
  render(
    <MemoryRouter>
      <CallsSettingsPage />
    </MemoryRouter>,
  );
  await act(async () => {});
}

const theSwitch = () => screen.getByTestId('calls-require-switch') as HTMLButtonElement;

beforeEach(() => {
  mocks.role = 'account_admin';
  mocks.flags = { agency_inbound_enabled: true };
  mocks.getCallSettings.mockReset();
  mocks.putCallSettings.mockReset();
  mocks.showToast.mockReset();
});
afterEach(cleanup);

describe('Settings → Calls', () => {
  it('says what the switch does, in the proposal’s words, and that it is off', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { level: 1, name: 'Calls' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Every call must belong to a campaign' })).toBeTruthy();
    expect(document.body.textContent).toContain(
      'When this is on, agents cannot dial from the soft phone without choosing a campaign, and every customer who rings is filed under a campaign. '
      + 'Calls made before you switch it on are not changed.',
    );
    expect(screen.getByTestId('calls-require-state').textContent).toBe('Off: calls can be made and saved without a campaign.');
    expect(theSwitch().getAttribute('role')).toBe('switch');
    expect(theSwitch().getAttribute('aria-checked')).toBe('false');
    expect(screen.getByTestId('calls-check-softphone').textContent).toContain('Soft phone: agents will be asked to choose a campaign.');
    expect(screen.getByTestId('calls-check-inbound').getAttribute('data-kind')).toBe('ready');
    expect(screen.queryByTestId('calls-check-agents')).toBeNull();
    expect(screen.getByTestId('calls-unfiled-count').textContent).toBe('In the last 30 days, every call was filed under a campaign.');
    expect(mocks.getCallSettings).toHaveBeenCalledWith('t-1', 'a-1');
  });

  it('switching on asks first, naming the account; Cancel changes nothing; Switch on saves and says so', async () => {
    mocks.putCallSettings.mockResolvedValue({ ok: true, value: ON });
    await renderPage();
    expect(screen.queryByTestId('calls-confirm')).toBeNull();
    fireEvent.click(theSwitch());
    const confirm = screen.getByTestId('calls-confirm');
    expect(confirm.textContent).toContain('Switch on for Acme Collections?');
    expect(confirm.textContent).toContain('From now, no call can be made or saved without a campaign.');
    expect(mocks.putCallSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('calls-confirm-cancel'));
    expect(screen.queryByTestId('calls-confirm')).toBeNull();
    expect(mocks.putCallSettings).not.toHaveBeenCalled();

    fireEvent.click(theSwitch());
    await act(async () => {
      fireEvent.click(screen.getByTestId('calls-confirm-on'));
    });
    expect(mocks.putCallSettings).toHaveBeenCalledWith(true, 't-1', 'a-1');
    expect(theSwitch().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('calls-require-state').textContent).toBe('On: every new call needs a campaign.');
    expect(screen.getByTestId('calls-check-softphone').textContent).toContain('agents are asked to choose a campaign before they dial');
    expect(screen.queryByTestId('calls-confirm')).toBeNull();
    expect(mocks.showToast).toHaveBeenCalledWith('Every call must now belong to a campaign.', 'success');
  });

  it('switching off does not ask', async () => {
    mocks.putCallSettings.mockResolvedValue({ ok: true, value: OFF });
    await renderPage(ON);
    expect(theSwitch().textContent).toBe('Switch off');
    await act(async () => {
      fireEvent.click(theSwitch());
    });
    expect(mocks.putCallSettings).toHaveBeenCalledWith(false, 't-1', 'a-1');
    expect(theSwitch().getAttribute('aria-checked')).toBe('false');
  });

  it('an inbound number with no campaign for unknown callers keeps the switch off, names the numbers and links to them', async () => {
    await renderPage(BLOCKED);
    expect(theSwitch().disabled).toBe(true);
    const inbound = screen.getByTestId('calls-check-inbound');
    expect(inbound.getAttribute('data-kind')).toBe('blocked');
    expect(inbound.textContent).toContain('2 inbound numbers have no campaign for unknown callers: Sales line, Support line.');
    expect(within(inbound).getByRole('link', { name: 'Choose a campaign for Sales line' }).getAttribute('href')).toBe('/settings/inbound/r-sales');
    expect(within(inbound).getByRole('link', { name: 'Choose a campaign for Support line' }).getAttribute('href')).toBe('/settings/inbound/r-support');
    expect(screen.getByTestId('calls-choose-campaign').getAttribute('href')).toBe('/settings/inbound/r-sales');
    // The switch points at why it is off.
    expect(theSwitch().getAttribute('aria-describedby')).toBe(inbound.id);
    fireEvent.click(theSwitch());
    expect(screen.queryByTestId('calls-confirm')).toBeNull();
  });

  it('agents on no running campaign are listed for information and do not hold the switch', async () => {
    await renderPage({ ...BLOCKED, readiness: { ...BLOCKED.readiness, routes_missing_default: [] } });
    const agents = screen.getByTestId('calls-check-agents');
    expect(agents.getAttribute('data-kind')).toBe('info');
    expect(agents.textContent).toContain(
      '4 agents are not on any running campaign and will not be able to dial: Arjun Mehta, Rohit Bansal, Neha Gupta, Sameer Khan.',
    );
    expect(theSwitch().disabled).toBe(false);
    expect(screen.getByTestId('calls-unfiled-count').textContent).toBe('In the last 30 days, 41 calls were not filed under a campaign.');
  });

  it('more agents than are named: "and N more"; one agent and one number read in the singular', async () => {
    await renderPage({
      ...BLOCKED,
      readiness: {
        routes_missing_default: [{ route_id: 'r-sales', name: 'Sales line' }],
        agents_without_campaign: [{ user_id: 'u-1', name: 'Arjun Mehta' }, { user_id: 'u-2', name: null }],
        agents_without_campaign_total: 14,
        unfiled_calls: 1,
      },
    });
    expect(screen.getByTestId('calls-check-agents').textContent).toContain(
      '14 agents are not on any running campaign and will not be able to dial: Arjun Mehta, Someone with no name, and 12 more.',
    );
    expect(screen.getByTestId('calls-check-inbound').textContent).toContain('1 inbound number has no campaign for unknown callers: Sales line.');
    expect(screen.getByTestId('calls-unfiled-count').textContent).toBe('In the last 30 days, 1 call was not filed under a campaign.');
  });

  it('a number lost its campaign since the page was read: the server refuses, and the page shows which', async () => {
    mocks.putCallSettings.mockResolvedValue({
      ok: false,
      refusal: { code: 'default_campaign_required', status: 422, message: 'x', routes: [{ route_id: 'r-new', name: 'New line' }] },
    });
    await renderPage();
    fireEvent.click(theSwitch());
    await act(async () => {
      fireEvent.click(screen.getByTestId('calls-confirm-on'));
    });
    expect(screen.queryByTestId('calls-confirm')).toBeNull();
    expect(theSwitch().getAttribute('aria-checked')).toBe('false');
    expect(theSwitch().disabled).toBe(true);
    expect(screen.getByTestId('calls-check-inbound').textContent).toContain('1 inbound number has no campaign for unknown callers: New line.');
    expect(document.body.textContent).toContain('This cannot be switched on yet. Choose a campaign for unknown callers on each inbound number first.');
    expect(mocks.showToast).not.toHaveBeenCalled();
  });

  it('without the right to edit inbound routes, or with inbound off, the numbers are named but not linked', async () => {
    mocks.flags = { agency_inbound_enabled: false };
    await renderPage(BLOCKED);
    const inbound = screen.getByTestId('calls-check-inbound');
    expect(inbound.textContent).toContain('Sales line, Support line.');
    expect(within(inbound).queryByRole('link')).toBeNull();
  });

  it('is an account admin’s: anyone below reads nothing and nothing is asked of the server', async () => {
    mocks.role = 'operator';
    await renderPage();
    expect(document.body.textContent).toContain('Only an account admin can see and change the call settings.');
    expect(screen.queryByTestId('calls-require-switch')).toBeNull();
    expect(mocks.getCallSettings).not.toHaveBeenCalled();
  });

  it('a read that fails offers to try again', async () => {
    mocks.getCallSettings.mockRejectedValue(new Error('boom'));
    render(<MemoryRouter><CallsSettingsPage /></MemoryRouter>);
    await act(async () => {});
    expect(screen.queryByTestId('calls-require-switch')).toBeNull();
    mocks.getCallSettings.mockResolvedValue(OFF);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /try again|retry/i }));
    });
    expect(screen.getByTestId('calls-require-switch')).toBeTruthy();
  });
});
