import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from 'react-router-dom';
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * Campaign settings, at the PAGE level.
 *
 * The point of this page is the round trip: `configFromCampaign` was written and
 * tested for a lossless load, then had no production caller for the whole life
 * of the feature. A unit test of that helper stayed green the entire time and
 * proved nothing about an operator's ability to change a calling window. So
 * every assertion here goes through the page.
 */

const mocks = vi.hoisted(() => ({
  transitionAgencyCampaign: vi.fn(),
  useTenant: vi.fn(),
  getAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
  showToast: vi.fn(),
  isCapabilityEnabled: vi.fn(),
  useCallAnalysisProfiles: vi.fn(),
  getInsightsSummary: vi.fn(),
  getInsightsUploads: vi.fn(),
  getInsightsAllocation: vi.fn(),
  flags: new Set<string>(),
}));
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ isEnabled: (flag: string) => mocks.flags.has(flag) }),
}));

vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../contexts/GovernanceContext', () => ({
  useGovernance: () => ({
    isEnabled: mocks.isCapabilityEnabled,
    map: {},
    loading: false,
    refresh: vi.fn(),
  }),
}));
vi.mock('../../hooks/useCallAnalysisProfiles', () => ({
  useCallAnalysisProfiles: mocks.useCallAnalysisProfiles,
}));
vi.mock('../../hooks/usePhoneNumbers', () => ({
  usePhoneNumbers: () => ({
    phoneNumbers: [
      {
        phone_number_id: 'pn-1',
        phone_number: '+912200000001',
        provider_name: 'voicelink',
        provider_display_name: 'VoiceLink',
        label: null,
        is_default: true,
      },
    ],
    loading: false,
    error: null,
    reload: vi.fn(),
    defaultNumber: '+912200000001',
  }),
}));
// One carrier account (the service's own): the carrier choice stays hidden here; its
// cases are in `AgencyCampaignSettingsPage.carrier.test.tsx`.
vi.mock('../../hooks/useAgencyCarriers', () => ({
  useAgencyCarriers: () => ({
    carriers: [{ telephony_provider: 'voicelink', telephony_credential_id: null, label: null, status: 'active' }],
    error: null,
  }),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
  // The campaign header above the form: its lifecycle controls and lineage strip.
  transitionAgencyCampaign: mocks.transitionAgencyCampaign,
  campaignLineage: async () => ({ root_campaign_id: 'camp-1', campaigns: [] }),
}));
// The lifecycle and upload history under the form (IN13), and the tab bar's overdue-callbacks badge.
vi.mock('../../api/agencyInsights', () => ({
  getInsightsSummary: mocks.getInsightsSummary,
  getInsightsUploads: mocks.getInsightsUploads,
  getInsightsAllocation: mocks.getInsightsAllocation,
}));

function campaign(over: Partial<AgencyCampaign> = {}): AgencyCampaign {
  return {
    id: 'camp-1',
    name: 'Collections — August',
    status: 'paused',
    calling_window_start: '10:00',
    calling_window_end: '18:00',
    calling_days: [1, 2, 3],
    default_timezone: 'Asia/Kolkata',
    wrapup_seconds: 45,
    wrapup_auto_return: false,
    caller_ids: ['+912200000001'],
    disposition_catalog: [
      { code: 'voicemail', label: 'Voicemail' },
      { code: 'callback', label: 'Callback', requires_datetime: true },
      { code: 'do_not_call', label: 'Do not call', suppress: true },
    ],
    retry_policy: {},
    ...over,
  };
}

/** Stands in for search: a push navigation from outside the page. */
function JumpTo({ to }: { to: string }) {
  const navigate = useNavigate();
  return <button type="button" onClick={() => navigate(to)}>Jump</button>;
}

function HashProbe() {
  return <span data-testid="location-hash">{useLocation().hash}</span>;
}

function renderPage(path = '/agency/campaigns/camp-1/settings') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/agency/campaigns/:id/settings" element={<><SettingsPage /><HashProbe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

import SettingsPage from '../../pages/agency/AgencyCampaignSettingsPage';
import { saveSettings } from '../helpers/settingsForm';
import * as insightsSamples from '../helpers/insights';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'tenant_owner',
  });
  mocks.getAgencyCampaign.mockResolvedValue(campaign());
  mocks.updateAgencyCampaign.mockImplementation(async (_id, body) => campaign(body));
  mocks.flags = new Set();
  mocks.getInsightsSummary.mockResolvedValue(insightsSamples.summary('running'));
  mocks.getInsightsUploads.mockResolvedValue(insightsSamples.uploads());
  mocks.getInsightsAllocation.mockResolvedValue(insightsSamples.allocation());
  // Governance fails OPEN, so the default posture here is every capability on —
  // matching a tenant whose map simply doesn't mention these keys.
  mocks.isCapabilityEnabled.mockReturnValue(true);
  mocks.useCallAnalysisProfiles.mockReturnValue({
    profiles: [
      { id: 'prof-1', name: 'Collections QA', is_default: true },
      { id: 'prof-2', name: 'Compliance spot-check', is_default: false },
    ],
    total: 2,
    defaultProfile: { id: 'prof-1', name: 'Collections QA', is_default: true },
    loading: false,
    error: null,
    reload: vi.fn(),
    remove: vi.fn(),
  });
});

/** Turn a named set of capabilities off; everything else stays fail-open. */
function capabilitiesOff(...off: string[]) {
  mocks.isCapabilityEnabled.mockImplementation((key: string) => !off.includes(key));
}

/** Shaped like the `ApiError` the client throws. */
function apiError(statusCode: number, details: unknown) {
  return Object.assign(new Error('ignored'), { statusCode, details });
}

afterEach(cleanup);

describe('campaign settings — loading an existing campaign', () => {
  it('shows the campaign’s own values, not the new-campaign defaults', async () => {
    renderPage();

    // 10:00–18:00 is this campaign's window. `EMPTY_CAMPAIGN_CONFIG` is
    // 09:00–20:00 — so asserting the real values is what distinguishes a page
    // that loaded the campaign from one that rendered a blank form.
    const name = await screen.findByLabelText(/campaign name/i);
    expect((name as HTMLInputElement).value).toBe('Collections — August');
    await waitFor(() => {
      expect(screen.getByDisplayValue('10:00')).toBeTruthy();
      expect(screen.getByDisplayValue('18:00')).toBeTruthy();
    });
  });

  it('passes the tenant AND account to the read', async () => {
    renderPage();

    await waitFor(() =>
      expect(mocks.getAgencyCampaign).toHaveBeenCalledWith('camp-1', 'tenant-1', 'account-1'),
    );
  });
});

describe('campaign settings — saving', () => {
  it('sends the behaviour block and the name in ONE patch', async () => {
    renderPage();

    const name = await screen.findByLabelText(/campaign name/i);
    fireEvent.change(name, { target: { value: 'Collections — September' } });
    saveSettings();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalledTimes(1));

    const [id, body, tenantId, accountId] = mocks.updateAgencyCampaign.mock.calls[0]!;
    expect(id).toBe('camp-1');
    expect(tenantId).toBe('tenant-1');
    expect(accountId).toBe('account-1');
    // Both in the same write: a rename and a window change cannot half-apply.
    expect(body.name).toBe('Collections — September');
    expect(body.calling_window_start).toBe('10:00');
    expect(body.wrapup_seconds).toBe(45);
  });

  it('re-seeds the form from the response, not from what was sent', async () => {
    // The server normalises the window; if the form kept the submitted value the
    // operator would see one thing and the server would hold another, and the
    // next save would re-submit the stale value.
    mocks.updateAgencyCampaign.mockResolvedValue(
      campaign({ calling_window_start: '11:30', name: 'Normalised name' }),
    );

    renderPage();

    await screen.findByLabelText(/campaign name/i);
    saveSettings();

    await waitFor(() => expect(screen.getByDisplayValue('11:30')).toBeTruthy());
    expect((screen.getByLabelText(/campaign name/i) as HTMLInputElement).value).toBe(
      'Normalised name',
    );
  });

  /**
   * `description` was the field that erased itself on the save that reported
   * success: the server stores no such column, so the re-seed below — which is
   * deliberately from the response, not from what was sent — put the field back
   * empty in front of the operator.
   */
  it('offers no Description field, and sends no `description` key', async () => {
    renderPage();

    await screen.findByLabelText(/campaign name/i);
    expect(screen.queryByLabelText(/description/i)).toBeNull();

    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect('description' in mocks.updateAgencyCampaign.mock.calls[0]![1]).toBe(false);
  });

  it('round-trips wrap-up auto-return through load, save and re-seed', async () => {
    // The fixture campaign holds agents until they click. A load that showed
    // "on" — or a save that wrote `true` back — would silently re-pace an
    // operator's whole floor.
    renderPage();

    const box = (await screen.findByRole('checkbox', {
      name: /send agents back to the pool automatically/i,
    })) as HTMLInputElement;
    expect(box.checked).toBe(false);

    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].wrapup_auto_return).toBe(false);

    // And back off the response, which is what the form re-seeds from.
    await waitFor(() =>
      expect(
        (screen.getByRole('checkbox', {
          name: /send agents back to the pool automatically/i,
        }) as HTMLInputElement).checked,
      ).toBe(false),
    );
  });

  it('round-trips “Allow redial from wrap-up” through load, save and re-seed', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ allow_wrapup_redial: true }));
    renderPage();

    const box = (await screen.findByRole('checkbox', {
      name: /allow redial from wrap-up/i,
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByTestId('allow-wrapup-redial-hint').textContent).toBe(
      'If a connected call drops, the agent can redial the customer up to 2 times from wrap-up before saving the outcome.',
    );

    fireEvent.click(box);
    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].allow_wrapup_redial).toBe(false);

    // Re-seeded off the response, which said off.
    await waitFor(() =>
      expect(
        (screen.getByRole('checkbox', { name: /allow redial from wrap-up/i }) as HTMLInputElement).checked,
      ).toBe(false),
    );
  });

  it('shows the redial setting off for a campaign that does not carry it', async () => {
    renderPage();
    const box = (await screen.findByRole('checkbox', {
      name: /allow redial from wrap-up/i,
    })) as HTMLInputElement;
    expect(box.checked).toBe(false);
  });

  it('loads the campaign’s abandonment limit and PATCHes the one the line is moved to', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ abandonment_ceiling_pct: 4.5 }));
    renderPage();

    const slider = await screen.findByRole('slider', { name: 'Abandonment limit' });
    expect(slider.getAttribute('aria-valuenow')).toBe('4.5');
    expect((screen.getByRole('spinbutton', { name: 'Pause above (%)' }) as HTMLInputElement).value).toBe('4.5');
    // 4.5% is above the common 3% rule: the note says so, and the save still goes.
    expect(screen.getByTestId('abandonment-ceiling-warning')).toBeTruthy();

    fireEvent.keyDown(slider, { key: 'PageDown' });
    fireEvent.keyDown(slider, { key: 'ArrowDown' });
    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].abandonment_ceiling_pct).toBe(3.4);

    // Re-seeded off the response, which echoes what was sent.
    await waitFor(() =>
      expect((screen.getByRole('spinbutton', { name: 'Pause above (%)' }) as HTMLInputElement).value).toBe('3.4'),
    );
  });

  it.each([25, 7.25])(
    'keeps a stored limit of %s outside the offered range, and still saves another edit (AC1)',
    async (stored) => {
      // Set through the API: legal on the server, outside what the console offers.
      mocks.getAgencyCampaign.mockResolvedValue(campaign({ abandonment_ceiling_pct: stored }));
      renderPage();

      const start = await screen.findByDisplayValue('10:00');
      expect(screen.getByTestId('abandonment-meter-value').textContent).toBe(`${stored}%`);
      expect(screen.queryByText('Set the limit between 0.5% and 10%.')).toBeNull();
      expect(screen.queryByText('Use at most one decimal place, like 3.5.')).toBeNull();

      // Only the calling hours change.
      fireEvent.change(start, { target: { value: '11:00' } });
      const save = screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement;
      expect(save.disabled).toBe(false);
      fireEvent.click(save);
      await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalledTimes(1));
      const body = mocks.updateAgencyCampaign.mock.calls[0]![1];
      expect(body.calling_window_start).toBe('11:00');
      expect(body.abandonment_ceiling_pct).toBe(stored);
      expect('abandonmentCeilingStoredPct' in body).toBe(false);

      // Re-seeded from the response: nothing is unsaved, and the stored value is still
      // accepted, so the next edit can be saved.
      await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith('Campaign settings saved.', 'success'));
      expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull();
      fireEvent.change(screen.getByDisplayValue('11:00'), { target: { value: '12:00' } });
      expect((screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement).disabled).toBe(false);

      // A NEW out-of-range value is still refused.
      fireEvent.change(screen.getByRole('spinbutton', { name: 'Pause above (%)' }), { target: { value: '30' } });
      expect(screen.getByText('Set the limit between 0.5% and 10%.')).toBeTruthy();
      expect((screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement).disabled).toBe(true);
    },
  );

  it('refuses to save a campaign with no name, without calling the API', async () => {
    renderPage();

    const name = await screen.findByLabelText(/campaign name/i);
    fireEvent.change(name, { target: { value: '   ' } });
    saveSettings();

    await waitFor(() => expect(screen.getByText(/a campaign needs a name/i)).toBeTruthy());
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
  });
});

describe('campaign settings — editing a live campaign', () => {
  /**
   * Editing a running campaign is deliberately permitted: the calling window is
   * most often found to be wrong while the campaign is dialing outside it. What
   * must be true is that the operator is TOLD when the change takes effect,
   * because "saved" alone leaves them guessing whether a call in progress is
   * covered.
   */
  it('explains when changes take effect, and does not disable the form', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));

    renderPage();

    expect(await screen.findByText(/calls placed from now on/i)).toBeTruthy();
    const name = await screen.findByLabelText(/campaign name/i);
    expect(name.hasAttribute('disabled')).toBe(false);
    fireEvent.change(name, { target: { value: 'Collections — September' } });
    expect(
      screen.getByRole('button', { name: /save changes/i }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('does not show the live note for a paused campaign', async () => {
    renderPage();

    await screen.findByLabelText(/campaign name/i);
    expect(screen.queryByText(/calls placed from now on/i)).toBeNull();
  });
});

describe('campaign settings — lifecycle and uploads', () => {
  it('shows a supervisor how the campaign was run and loaded, under the form', async () => {
    renderPage();
    await screen.findByLabelText(/campaign name/i);
    expect(await screen.findByTestId('insights-transitions')).toBeTruthy();
    expect(await screen.findByTestId('insights-uploads')).toBeTruthy();
    expect(mocks.getInsightsSummary).toHaveBeenCalledTimes(1);
  });

  it('reads neither for a role below `agency.supervise`, whose reads would 403', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'viewer' });
    renderPage();
    await screen.findByLabelText(/campaign name/i);
    expect(screen.queryByTestId('campaign-history')).toBeNull();
    expect(mocks.getInsightsSummary).not.toHaveBeenCalled();
    expect(mocks.getInsightsUploads).not.toHaveBeenCalled();
    expect(mocks.getInsightsAllocation).not.toHaveBeenCalled();
  });

  it('keeps the Callbacks tab’s overdue badge off the detail page, read once here', async () => {
    renderPage();
    await screen.findByLabelText(/campaign name/i);
    // The fixture has 2 overdue: leaving the detail page must not make the warning look resolved.
    const badge = await screen.findByTestId('campaign-tab-callbacks-alert');
    expect(badge.textContent).toBe('2, 2 overdue');
    expect(mocks.getInsightsAllocation).toHaveBeenCalledTimes(1);
  });
});

describe('campaign settings — permissions', () => {
  it('hides the save control from a role that cannot write', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'viewer',
    });

    renderPage();

    await screen.findByLabelText(/campaign name/i);
    expect(screen.queryByRole('button', { name: /save changes/i })).toBeNull();
  });

  it('shows a role that cannot write the abandonment limit read-only, not as a live slider', async () => {
    mocks.useTenant.mockReturnValue({
      tenantId: 'tenant-1',
      accountId: 'account-1',
      role: 'viewer',
    });
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ abandonment_ceiling_pct: 4.5 }));

    renderPage();

    const box = (await screen.findByRole('spinbutton', { name: 'Pause above (%)' })) as HTMLInputElement;
    expect(box.value).toBe('4.5');
    expect(box.disabled).toBe(true);
    expect(screen.queryByRole('slider', { name: 'Abandonment limit' })).toBeNull();
    expect(screen.getByTestId('abandonment-meter-value').textContent).toBe('4.5%');
  });

  it('keeps the abandonment limit live for a role that can write', async () => {
    renderPage();
    expect(await screen.findByRole('slider', { name: 'Abandonment limit' })).toBeTruthy();
    expect((screen.getByRole('spinbutton', { name: 'Pause above (%)' }) as HTMLInputElement).disabled).toBe(false);
  });
});

describe('campaign settings — caller IDs', () => {
  /**
   * The server rejects an empty `caller_ids` and the pacing engine throws rather than
   * dialing without a pool, so an empty save is not a cosmetic mistake: on a
   * running campaign it leaves the next call unplaceable.
   */
  it('refuses to save with no caller ID, without calling the API', async () => {
    renderPage();

    // Deselect the only number.
    fireEvent.click(await screen.findByRole('checkbox', { name: /\+912200000001/ }));
    saveSettings();

    await waitFor(() =>
      expect(screen.getByText(/needs at least one caller id/i)).toBeTruthy(),
    );
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
  });

  it('sends the pool AND pins a campaign that names no carrier to the service’s own account', async () => {
    renderPage();

    await screen.findByLabelText(/campaign name/i);
    saveSettings();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const [, body] = mocks.updateAgencyCampaign.mock.calls[0]!;
    expect(body.caller_ids).toEqual(['+912200000001']);
    // An older record names no carrier: the save pins the pool to the service's own
    // account explicitly, carrier AND credential (none), so the pool and the carrier
    // it is dialled on cannot disagree.
    expect(body.telephony_provider).toBe('voicelink');
    expect(body.telephony_credential_id).toBeNull();
    // With one carrier account there is nothing to choose.
    expect(screen.queryByLabelText(/^Carrier/)).toBeNull();
  });

  it('loads the campaign’s existing pool as selected', async () => {
    renderPage();

    const box = (await screen.findByRole('checkbox', {
      name: /\+912200000001/,
    })) as HTMLInputElement;
    expect(box.checked).toBe(true);
  });
});

/**
 * Recording + call summary.
 *
 * Both fields already existed on the wire and had no editor anywhere in the SPA
 * — `record_calls` appeared once, read-only, on the agent console; the app
 * never mentioned `analysis_profile_id` on a campaign. The API correctly refuses
 * both to a capability-off tenant,
 * so the two capabilities were guarding a surface that did not exist.
 */
const RECORD_LABEL = /record every call on this campaign/i;

function recordBox() {
  return screen.getByRole('checkbox', { name: RECORD_LABEL }) as HTMLInputElement;
}

describe('campaign settings — recording opt-in', () => {
  it('defaults to off, and sends `record_calls: false` rather than omitting it', async () => {
    renderPage();

    expect((await screen.findByRole('checkbox', { name: RECORD_LABEL })).getAttribute('checked'))
      .toBeNull();
    expect(recordBox().checked).toBe(false);

    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    // Omitting looks harmless because the column defaults to false — and would
    // mean an operator who turned recording on could never turn it back off.
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].record_calls).toBe(false);
  });

  it('turns recording on and round-trips it through save and re-seed', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('checkbox', { name: RECORD_LABEL }));
    saveSettings();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].record_calls).toBe(true);
    await waitFor(() => expect(recordBox().checked).toBe(true));
  });

  it('loads a campaign that already records as on', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ record_calls: true }));
    renderPage();

    await waitFor(() => expect(recordBox().checked).toBe(true));
  });
});

describe('campaign settings — `agency.recording` off', () => {
  it('does not offer switching recording ON, and names the reason', async () => {
    capabilitiesOff('agency.recording');
    renderPage();

    await screen.findByLabelText(/campaign name/i);
    expect(recordBox().disabled).toBe(true);
    // The control must not silently vanish; the notice names the capability so
    // the operator knows what to ask an administrator for.
    expect(screen.getByText(/agency\.recording/)).toBeTruthy();
  });

  it('omits `record_calls` entirely so an unrelated edit still saves', async () => {
    // The server refuses rather than strips, so sending the unchanged `true` would
    // make a capability-off tenant unable to rename their own campaign.
    capabilitiesOff('agency.recording');
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ record_calls: true }));
    renderPage();

    const name = await screen.findByLabelText(/campaign name/i);
    fireEvent.change(name, { target: { value: 'Renamed' } });
    saveSettings();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const [, body] = mocks.updateAgencyCampaign.mock.calls[0]!;
    expect('record_calls' in body).toBe(false);
    expect(body.name).toBe('Renamed');
  });

  /**
   * THE case the whole asymmetry exists for. `record_calls: false` passes
   * the server's guard even with the capability off, deliberately — disabling the
   * control here would trap the tenant in exactly the state the capability
   * exists to prevent, which is worse than not shipping the control at all.
   */
  it('still lets a grandfathered campaign turn recording OFF, and the save succeeds', async () => {
    capabilitiesOff('agency.recording');
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ record_calls: true }));
    renderPage();

    await waitFor(() => expect(recordBox().checked).toBe(true));
    expect(recordBox().disabled).toBe(false);

    fireEvent.click(recordBox());
    expect(recordBox().checked).toBe(false);

    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].record_calls).toBe(false);
    await waitFor(() => expect(mocks.showToast).toHaveBeenCalledWith(
      'Campaign settings saved.',
      'success',
    ));
  });

  it('locks the box again once it has been switched off — on is still refused', async () => {
    capabilitiesOff('agency.recording');
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ record_calls: true }));
    renderPage();

    await waitFor(() => expect(recordBox().checked).toBe(true));
    fireEvent.click(recordBox());
    expect(recordBox().disabled).toBe(true);
  });
});

describe('campaign settings — call-summary profile', () => {
  it('offers the profiles from `useCallAnalysisProfiles`, not a second fetch path', async () => {
    renderPage();

    const select = (await screen.findByLabelText(/call summary/i)) as HTMLSelectElement;
    expect(mocks.useCallAnalysisProfiles).toHaveBeenCalled();
    expect([...select.options].map((o) => o.textContent)).toEqual([
      'No summary',
      'Collections QA (default)',
      'Compliance spot-check',
    ]);
  });

  it('defaults to no profile and sends an explicit null', async () => {
    renderPage();

    const select = (await screen.findByLabelText(/call summary/i)) as HTMLSelectElement;
    expect(select.value).toBe('__none__');

    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].analysis_profile_id).toBeNull();
  });

  it('sends the chosen profile id', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/call summary/i), {
      target: { value: 'prof-2' },
    });
    saveSettings();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].analysis_profile_id).toBe('prof-2');
  });

  it('keeps a stored profile the list no longer returns, rather than resaving it as none', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ analysis_profile_id: 'prof-gone' }));
    renderPage();

    const select = (await screen.findByLabelText(/call summary/i)) as HTMLSelectElement;
    expect(select.value).toBe('prof-gone');
    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].analysis_profile_id).toBe('prof-gone');
  });

  /**
   * `unlistedProfile` used to be computed from `analysisProfiles`
   * alone, and `useCallAnalysisProfiles` initialises that list to `[]` — so a
   * fetch still in flight was indistinguishable from a list that genuinely
   * lacked the campaign's profile. The three cases below — pending, failed, and
   * settled-and-absent — must each read differently.
   */
  describe('the picker while the profiles fetch has not settled successfully', () => {
    it('does NOT flash "no longer listed" while the fetch is still pending', async () => {
      mocks.getAgencyCampaign.mockResolvedValue(campaign({ analysis_profile_id: 'prof-1' }));
      // `[]` — exactly what the hook holds before the fetch resolves.
      mocks.useCallAnalysisProfiles.mockReturnValue({
        profiles: [],
        total: 0,
        defaultProfile: null,
        loading: true,
        error: null,
        reload: vi.fn(),
        remove: vi.fn(),
      });
      renderPage();

      const select = (await screen.findByLabelText(/call summary/i)) as HTMLSelectElement;
      expect(select.value).toBe('prof-1');
      expect(screen.queryByText(/no longer listed/i)).toBeNull();
    });

    it('does NOT flash "no longer listed" when the fetch failed, and blames the fetch instead', async () => {
      mocks.getAgencyCampaign.mockResolvedValue(campaign({ analysis_profile_id: 'prof-1' }));
      mocks.useCallAnalysisProfiles.mockReturnValue({
        profiles: [],
        total: 0,
        defaultProfile: null,
        loading: false,
        error: 'Network error',
        reload: vi.fn(),
        remove: vi.fn(),
      });
      renderPage();

      const select = (await screen.findByLabelText(/call summary/i)) as HTMLSelectElement;
      expect(select.value).toBe('prof-1');
      expect(screen.queryByText(/no longer listed/i)).toBeNull();
      // The failure notice names the FETCH as the problem, not the profile.
      expect(await screen.findByText(/could not load your summary profiles/i)).toBeTruthy();
    });

    it('still shows "no longer listed" once the fetch SETTLED successfully and the profile really is absent', async () => {
      // The real case (acceptance 3) — this must keep working.
      mocks.getAgencyCampaign.mockResolvedValue(campaign({ analysis_profile_id: 'prof-gone' }));
      renderPage();

      expect(await screen.findByText(/no longer listed/i)).toBeTruthy();
    });
  });

  it('hides the picker when `agency.analytics` is off and nothing is set', async () => {
    capabilitiesOff('agency.analytics');
    renderPage();

    await screen.findByLabelText(/campaign name/i);
    expect(screen.queryByLabelText(/call summary/i)).toBeNull();
  });

  it('still offers removal when `agency.analytics` is off but a profile is set', async () => {
    // Same asymmetry as recording: `analysis_profile_id: null` passes the server's
    // guard with the capability off.
    capabilitiesOff('agency.analytics');
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ analysis_profile_id: 'prof-1' }));
    renderPage();

    expect(await screen.findByText(/agency\.analytics/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /remove summary profile/i }));
    saveSettings();

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].analysis_profile_id).toBeNull();
  });

  it('omits the field when `agency.analytics` is off and a profile is left alone', async () => {
    capabilitiesOff('agency.analytics');
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ analysis_profile_id: 'prof-1' }));
    renderPage();

    await screen.findByLabelText(/campaign name/i);
    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect('analysis_profile_id' in mocks.updateAgencyCampaign.mock.calls[0]![1]).toBe(false);
  });

  /**
   * There is one gate, not a split between a profile-LIST capability and the
   * field's `agency.analytics`: with `agency.analytics` on, the list is fetched,
   * and an unrelated capability changes nothing.
   */
  it('lists the profiles whenever `agency.analytics` is on — there is no separate list capability', async () => {
    capabilitiesOff('calls.dialer.analytics');
    renderPage();

    await screen.findByLabelText(/campaign name/i);
    expect(screen.queryByText(/calls\.dialer\.analytics/)).toBeNull();
    expect(mocks.useCallAnalysisProfiles).toHaveBeenCalledWith({ enabled: true });
    expect(mocks.useCallAnalysisProfiles).not.toHaveBeenCalledWith({ enabled: false });
  });
});

describe('campaign settings — the refusals reach the operator legibly', () => {
  it('names the capability on the server’s `capability_disabled` 403', async () => {
    // `ApiError` reduces this body to the message `'capability_disabled'`, which
    // is a wire token. A bare "something went wrong" fails this outright.
    mocks.updateAgencyCampaign.mockRejectedValue(
      apiError(403, { error: 'capability_disabled', capability: 'agency.recording' }),
    );
    renderPage();

    await screen.findByLabelText(/campaign name/i);
    saveSettings();

    const alert = await screen.findByText(/agency\.recording/);
    expect(alert.textContent).toContain('Ask an administrator');
    expect(screen.queryByText(/^capability_disabled$/)).toBeNull();
  });

  it('surfaces the server’s `Feature Not Enabled` message for the analysis flag', async () => {
    mocks.updateAgencyCampaign.mockRejectedValue(
      apiError(403, {
        error: 'Feature Not Enabled',
        message: 'Dialer call analysis is not enabled for this account.',
      }),
    );
    renderPage();

    fireEvent.change(await screen.findByLabelText(/call summary/i), {
      target: { value: 'prof-2' },
    });
    saveSettings();

    expect(
      await screen.findByText(/dialer call analysis is not enabled for this account/i),
    ).toBeTruthy();
  });

  it('explains a MASKED 404 as a missing profile, because the body cannot', async () => {
    // The server's error-mask hook rewrites the dialer runtime's
    // `{ error: 'Not Found', message: 'Analysis profile not found' }` into the
    // generic support-ticket body — `'Not Found'` is not on its allow-list and
    // the payload carries no `details`. Only the id we sent identifies the cause.
    mocks.updateAgencyCampaign.mockRejectedValue(
      apiError(404, {
        error: 'Request Failed',
        message: 'Something went wrong while processing your request.',
        statusCode: 404,
        requestId: 'req-1',
      }),
    );
    renderPage();

    fireEvent.change(await screen.findByLabelText(/call summary/i), {
      target: { value: 'prof-2' },
    });
    saveSettings();

    expect(await screen.findByText(/no longer available on this account/i)).toBeTruthy();
  });

  it('lands the 400 on the field that caused it, not in a banner', async () => {
    mocks.updateAgencyCampaign.mockRejectedValue(
      apiError(400, {
        error: 'Validation failed',
        details: {
          analysis_profile_id: 'must be a call-analysis profile id, or null to clear it',
        },
      }),
    );
    renderPage();

    await screen.findByLabelText(/campaign name/i);
    saveSettings();

    expect(
      await screen.findByText(/must be a call-analysis profile id, or null to clear it/i),
    ).toBeTruthy();
  });
});

/**
 * ── This screen is a section of the campaign workspace ──────────
 *
 * The bar is what makes it one, and it is rendered by each page rather than by
 * a shared route layout — so without an assertion here it could be deleted
 * from this one file and every suite in the repo would stay green. That is the
 * whole reason this test exists.
 */
describe('the campaign section bar', () => {
  it('renders the bar and marks Settings as the current section', async () => {
    renderPage();

    const tab = await screen.findByTestId('campaign-tab-settings');
    expect(tab.getAttribute('aria-current')).toBe('page');
    // Its neighbours are reachable from here — the point of the bar is that
    // getting to another section does not mean going back through the campaign.
    expect(screen.getByTestId('campaign-tab-overview').getAttribute('aria-current')).toBeNull();
  });
});

/**
 * ── The campaign's header, as on its Monitor tabs ──────────────────────────
 * Settings is where "who changed the caller ID?" is asked, so History is here; and the
 * campaign's name and its lifecycle controls, which the assignment notice tells people to use.
 */
describe('the campaign header on Settings', () => {
  it('names the campaign, shows its status, the lifecycle controls and History', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));
    renderPage();

    expect(await screen.findByRole('heading', { level: 1, name: 'Collections — August' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /pause/i })).toBeTruthy();
    expect(screen.getByTestId('campaign-history-link').getAttribute('href')).toBe('/agency/campaigns/camp-1/activity');
  });

  it('leaves out the controls and History below their gates', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'agent' });
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ status: 'running' }));
    renderPage();

    await screen.findByRole('heading', { level: 1, name: 'Collections — August' });
    expect(screen.queryByRole('button', { name: /pause/i })).toBeNull();
    expect(screen.queryByTestId('campaign-history-link')).toBeNull();
  });

  it('pauses the campaign without touching edits in progress', async () => {
    // Loaded running; read again (after the pause) as paused.
    mocks.getAgencyCampaign.mockResolvedValueOnce(campaign({ status: 'running' }))
      .mockResolvedValue(campaign({ status: 'paused' }));
    mocks.transitionAgencyCampaign.mockResolvedValue(campaign({ status: 'paused' }));
    renderPage();

    const name = (await screen.findByLabelText(/campaign name/i)) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Collections — September' } });
    fireEvent.click(screen.getByRole('button', { name: /pause/i }));

    await waitFor(() => expect(mocks.transitionAgencyCampaign)
      .toHaveBeenCalledWith('camp-1', 'pause', 'tenant-1', 'account-1'));
    expect(await screen.findByRole('button', { name: /resume/i })).toBeTruthy();
    expect((screen.getByLabelText(/campaign name/i) as HTMLInputElement).value).toBe('Collections — September');
  });
});

/**
 * ── Unsaved changes ───────────────────────────────────────────────────────────
 * Save is a bar stuck to the bottom of the view, there only while something is unsaved, with
 * a count of the settings that differ; leaving with unsaved edits asks first.
 */
describe('unsaved changes', () => {
  const bar = () => screen.queryByTestId('unsaved-changes-bar');
  const nameField = () => screen.getByLabelText(/campaign name/i) as HTMLInputElement;

  function renderWithExit() {
    return render(
      <MemoryRouter initialEntries={['/agency/campaigns/camp-1/settings']}>
        <Routes>
          <Route path="/agency/campaigns/:id/settings" element={<SettingsPage />} />
          <Route path="*" element={<p>Somewhere else</p>} />
        </Routes>
        <JumpTo to="/agency/campaigns/camp-1/overview" />
      </MemoryRouter>,
    );
  }

  it('shows no bar until something is edited, then counts each changed setting', async () => {
    renderPage();
    await screen.findByLabelText(/campaign name/i);
    expect(bar()).toBeNull();
    expect(screen.getByTestId('unsaved-changes-status').textContent).toBe('');

    fireEvent.change(nameField(), { target: { value: 'Collections — September' } });
    expect(bar()?.textContent).toContain('1 unsaved change');
    expect(screen.getByTestId('unsaved-changes-status').textContent).toBe('1 unsaved change');

    fireEvent.change(screen.getByDisplayValue('10:00'), { target: { value: '11:00' } });
    expect(bar()?.textContent).toContain('2 unsaved changes');

    // Put back by hand: nothing unsaved any more.
    fireEvent.change(nameField(), { target: { value: 'Collections — August' } });
    fireEvent.change(screen.getByDisplayValue('11:00'), { target: { value: '10:00' } });
    expect(bar()).toBeNull();
  });

  it('Discard puts back what is saved, and the bar goes', async () => {
    renderPage();
    await screen.findByLabelText(/campaign name/i);
    fireEvent.change(nameField(), { target: { value: 'Collections — September' } });
    fireEvent.change(screen.getByDisplayValue('10:00'), { target: { value: '11:00' } });

    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(nameField().value).toBe('Collections — August');
    expect(screen.getByDisplayValue('10:00')).toBeTruthy();
    expect(bar()).toBeNull();
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
  });

  it('Save sends the edits and clears the bar', async () => {
    renderPage();
    await screen.findByLabelText(/campaign name/i);
    fireEvent.change(nameField(), { target: { value: 'Collections — September' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(bar()).toBeNull());
    expect(nameField().value).toBe('Collections — September');
  });

  it('keeps Save back, saying why, while a field must be fixed', async () => {
    renderPage();
    await screen.findByLabelText(/campaign name/i);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Pause above (%)' }), { target: { value: '30' } });
    expect((screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(bar()?.textContent).toMatch(/fix/i);
  });

  it('asks before leaving with unsaved edits; Cancel stays with them', async () => {
    renderWithExit();
    await screen.findByLabelText(/campaign name/i);
    fireEvent.change(nameField(), { target: { value: 'Collections — September' } });

    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(screen.getByRole('dialog', { name: 'Leave without saving?' })).toBeTruthy();
    expect(screen.getByText(/1 unsaved change to this campaign’s settings/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(nameField().value).toBe('Collections — September');
  });

  it('leaves on "Leave without saving"', async () => {
    renderWithExit();
    await screen.findByLabelText(/campaign name/i);
    fireEvent.change(nameField(), { target: { value: 'Collections — September' } });

    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    fireEvent.click(screen.getByRole('button', { name: 'Leave without saving' }));
    expect(screen.getByText('Somewhere else')).toBeTruthy();
  });

  it('does not ask when nothing is unsaved, nor after Save or Discard', async () => {
    renderWithExit();
    await screen.findByLabelText(/campaign name/i);
    fireEvent.change(nameField(), { target: { value: 'Collections — September' } });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByText('Somewhere else')).toBeTruthy();
  });

  it('lets the section nav move about the page with unsaved edits', async () => {
    Element.prototype.scrollIntoView = () => {};
    try {
      renderPage();
      await screen.findByTestId('settings-section-nav');
      fireEvent.change(nameField(), { target: { value: 'Collections — September' } });
      fireEvent.click(screen.getByTestId('settings-section-link-recording'));
      expect(screen.getByTestId('location-hash').textContent).toBe('#recording');
      expect(screen.queryByRole('dialog')).toBeNull();
    } finally {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });
});

describe('inbound calls (P2): “Put callers through to their agent”', () => {
  it('is offered with the inbound flag on, round-trips through save, and goes back off the response', async () => {
    mocks.flags = new Set(['agency_inbound_enabled']);
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ inbound_sticky_enabled: true }));
    renderPage();
    const box = (await screen.findByRole('checkbox', { name: /put callers through to their agent/i })) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.getByTestId('inbound-sticky-hint').textContent).toMatch(/agent they last spoke to first/);
    fireEvent.click(box);
    expect(screen.getByTestId('inbound-sticky-hint').textContent).toMatch(/next free agent/);
    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].inbound_sticky_enabled).toBe(false);
  });

  it('is hidden with the flag off, and the stored value is sent back as it came', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ inbound_sticky_enabled: false }));
    renderPage();
    await screen.findByRole('checkbox', { name: /allow redial from wrap-up/i });
    expect(screen.queryByRole('checkbox', { name: /put callers through to their agent/i })).toBeNull();
    saveSettings();
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].inbound_sticky_enabled).toBe(false);
  });
});

/**
 * ── The page's sections (decision IN14) ──────────────────────────────────────
 * `CAMPAIGN_SETTINGS_SECTIONS` is the list a section nav, a link (`…/settings#id`) and search
 * all name; the page must have a section for every entry it lists, list every section it has,
 * and open at the one a link names.
 */
describe('the settings sections', () => {
  const navIds = () => screen.getAllByTestId(/^settings-section-link-/)
    .map((link) => link.getAttribute('href'));
  const current = () => screen.getAllByTestId(/^settings-section-link-/)
    .filter((link) => link.getAttribute('aria-current') === 'true')
    .map((link) => link.textContent);

  let scrolled: string[] = [];
  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
      scrolled.push(this.id);
    };
  });
  afterEach(() => {
    delete (Element.prototype as Partial<Element>).scrollIntoView;
    vi.unstubAllGlobals();
  });

  it('lists the sections the page has, in page order, each an anchor on the page', async () => {
    renderPage();
    await screen.findByTestId('settings-section-nav');

    expect(navIds()).toEqual([
      '#general', '#caller-ids', '#calling-hours', '#dialling-retries', '#wrap-up', '#recording', '#roster-uploads',
    ]);
    for (const href of navIds()) {
      expect(document.getElementById(href!.slice(1)), href!).toBeTruthy();
    }
    // Agents has nothing in it with contact assignment and inbound both off, so it is not offered.
    expect(document.getElementById('agents')).toBeNull();
    // The nav and the page agree on order: each anchor follows the one before it.
    const anchors = navIds().map((href) => document.getElementById(href!.slice(1))!);
    for (let i = 1; i < anchors.length; i += 1) {
      expect(anchors[i - 1]!.compareDocumentPosition(anchors[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    expect(current()).toEqual(['General']);
  });

  it('adds Agents with inbound on, holding its field', async () => {
    mocks.flags = new Set(['agency_inbound_enabled']);
    renderPage();
    await screen.findByTestId('settings-section-nav');

    expect(navIds()).toContain('#agents');
    expect(document.getElementById('agents')?.querySelector('[data-testid="inbound-sticky-enabled"]')).toBeTruthy();
  });

  it('puts each field in its section', async () => {
    renderPage();
    await screen.findByTestId('settings-section-nav');

    const inSection = (id: string, selector: string) => document.getElementById(id)?.querySelector(selector);
    expect(inSection('general', '#campaign-name')).toBeTruthy();
    expect(inSection('caller-ids', 'label[for="campaign-caller-ids"]')).toBeTruthy();
    expect(inSection('roster-uploads', '[data-testid="campaign-history"]')).toBeTruthy();
  });

  it('leaves Lifecycle and uploads out below `agency.supervise`', async () => {
    mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'operator' });
    renderPage();
    await screen.findByTestId('settings-section-nav');

    expect(navIds()).not.toContain('#roster-uploads');
    expect(document.getElementById('roster-uploads')).toBeNull();
  });

  it('opens at the section a link names, and highlights it', async () => {
    renderPage('/agency/campaigns/camp-1/settings#calling-hours');
    await screen.findByTestId('settings-section-nav');

    await waitFor(() => expect(scrolled).toEqual(['calling-hours']));
    expect(current()).toEqual(['Calling hours']);
  });

  it('ignores a hash that names no section', async () => {
    renderPage('/agency/campaigns/camp-1/settings#nonsense');
    await screen.findByTestId('settings-section-nav');

    expect(scrolled).toEqual([]);
    expect(current()).toEqual(['General']);
  });

  it('scrolls to a picked section, highlights it and puts it in the URL', async () => {
    renderPage();
    await screen.findByTestId('settings-section-nav');

    fireEvent.click(screen.getByTestId('settings-section-link-recording'));

    expect(scrolled).toEqual(['recording']);
    expect(current()).toEqual(['Recording']);
    expect(screen.getByTestId('location-hash').textContent).toBe('#recording');
  });

  it('opens at a section of another campaign only once that campaign is on the page', async () => {
    let resolveSecond: (value: AgencyCampaign) => void = () => {};
    mocks.getAgencyCampaign.mockImplementation(async (id: string) => (id === 'camp-1'
      ? campaign()
      : new Promise<AgencyCampaign>((resolve) => { resolveSecond = resolve; })));
    render(
      <MemoryRouter initialEntries={['/agency/campaigns/camp-1/settings']}>
        <Routes>
          <Route path="/agency/campaigns/:id/settings" element={<SettingsPage />} />
        </Routes>
        <JumpTo to="/agency/campaigns/camp-2/settings#recording" />
      </MemoryRouter>,
    );
    await screen.findByTestId('settings-section-nav');

    fireEvent.click(screen.getByRole('button', { name: 'Jump' }));
    // Still the first campaign (or a spinner): no scroll to its Recording.
    expect(scrolled).toEqual([]);

    await act(async () => resolveSecond(campaign({ id: 'camp-2', name: 'Renewals' })));
    await waitFor(() => expect(scrolled).toEqual(['recording']));
    expect((screen.getByLabelText(/campaign name/i) as HTMLInputElement).value).toBe('Renewals');
    expect(current()).toEqual(['Recording']);
  });

  it('highlights the section scrolled into view', async () => {
    let report: (entries: Array<{ target: Element; isIntersecting: boolean }>) => void = () => {};
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: typeof report) { report = callback; }
      observe() {}
      disconnect() {}
    });
    renderPage();
    await screen.findByTestId('settings-section-nav');

    act(() => report([
      { target: document.getElementById('general')!, isIntersecting: false },
      { target: document.getElementById('wrap-up')!, isIntersecting: true },
    ]));
    expect(current()).toEqual(['Wrap-up and outcomes']);

    // Two in the band: the upper one is the one being read.
    act(() => report([{ target: document.getElementById('dialling-retries')!, isIntersecting: true }]));
    expect(current()).toEqual(['Dialling and retries']);
  });
});
