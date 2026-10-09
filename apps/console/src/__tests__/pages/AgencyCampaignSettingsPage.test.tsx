import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
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
  useTenant: vi.fn(),
  getAgencyCampaign: vi.fn(),
  updateAgencyCampaign: vi.fn(),
  showToast: vi.fn(),
  isCapabilityEnabled: vi.fn(),
  useCallAnalysisProfiles: vi.fn(),
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
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));
vi.mock('../../api/agencyCampaigns', () => ({
  getAgencyCampaign: mocks.getAgencyCampaign,
  updateAgencyCampaign: mocks.updateAgencyCampaign,
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/agency/campaigns/camp-1/settings']}>
      <Routes>
        <Route path="/agency/campaigns/:id/settings" element={<SettingsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

import SettingsPage from '../../pages/agency/AgencyCampaignSettingsPage';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.useTenant.mockReturnValue({
    tenantId: 'tenant-1',
    accountId: 'account-1',
    role: 'tenant_owner',
  });
  mocks.getAgencyCampaign.mockResolvedValue(campaign());
  mocks.updateAgencyCampaign.mockImplementation(async (_id, body) => campaign(body));
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
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

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
    // Master normalises the window; if the form kept the submitted value the
    // operator would see one thing and the server would hold another, and the
    // next save would re-submit the stale value.
    mocks.updateAgencyCampaign.mockResolvedValue(
      campaign({ calling_window_start: '11:30', name: 'Normalised name' }),
    );

    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(screen.getByDisplayValue('11:30')).toBeTruthy());
    expect((screen.getByLabelText(/campaign name/i) as HTMLInputElement).value).toBe(
      'Normalised name',
    );
  });

  /**
   * `description` was the field that erased itself on the save that reported
   * success: core stores no such column, so the re-seed below — which is
   * deliberately from the response, not from what was sent — put the field back
   * empty in front of the operator.
   */
  it('offers no Description field, and sends no `description` key', async () => {
    renderPage();

    await screen.findByLabelText(/campaign name/i);
    expect(screen.queryByLabelText(/description/i)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
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

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
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

  it('refuses to save a campaign with no name, without calling the API', async () => {
    renderPage();

    const name = await screen.findByLabelText(/campaign name/i);
    fireEvent.change(name, { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

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
    expect((await screen.findByLabelText(/campaign name/i)).hasAttribute('disabled')).toBe(false);
    expect(
      screen.getByRole('button', { name: /save settings/i }).hasAttribute('disabled'),
    ).toBe(false);
  });

  it('does not show the live note for a paused campaign', async () => {
    renderPage();

    await screen.findByLabelText(/campaign name/i);
    expect(screen.queryByText(/calls placed from now on/i)).toBeNull();
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
    expect(screen.queryByRole('button', { name: /save settings/i })).toBeNull();
  });
});

describe('campaign settings — caller IDs', () => {
  /**
   * Core rejects an empty `caller_ids` and the pacing engine throws rather than
   * dialing without a pool, so an empty save is not a cosmetic mistake: on a
   * running campaign it leaves the next call unplaceable.
   */
  it('refuses to save with no caller ID, without calling the API', async () => {
    renderPage();

    // Deselect the only number.
    fireEvent.click(await screen.findByRole('checkbox', { name: /\+912200000001/ }));
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() =>
      expect(screen.getByText(/needs at least one caller id/i)).toBeTruthy(),
    );
    expect(mocks.updateAgencyCampaign).not.toHaveBeenCalled();
  });

  it('sends the pool AND pins the provider to voicelink', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const [, body] = mocks.updateAgencyCampaign.mock.calls[0]!;
    expect(body.caller_ids).toEqual(['+912200000001']);
    // Core's column defaults to 'vobiz', so an omitted provider would point a
    // VoiceLink pool at the wrong carrier.
    expect(body.telephony_provider).toBe('voicelink');
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
 * Recording + call summary (`MAG-147`).
 *
 * Both fields already existed on the wire and had no editor anywhere in the SPA
 * — `record_calls` appeared once, read-only, on the agent console; the whole
 * repo never mentioned `analysis_profile_id` on a campaign. As of
 * magick-master#197 the API correctly refuses both to a capability-off tenant,
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

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    // Omitting looks harmless because the column defaults to false — and would
    // mean an operator who turned recording on could never turn it back off.
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].record_calls).toBe(false);
  });

  it('turns recording on and round-trips it through save and re-seed', async () => {
    renderPage();

    fireEvent.click(await screen.findByRole('checkbox', { name: RECORD_LABEL }));
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

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
    // Master refuses rather than strips, so sending the unchanged `true` would
    // make a capability-off tenant unable to rename their own campaign.
    capabilitiesOff('agency.recording');
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ record_calls: true }));
    renderPage();

    const name = await screen.findByLabelText(/campaign name/i);
    fireEvent.change(name, { target: { value: 'Renamed' } });
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    const [, body] = mocks.updateAgencyCampaign.mock.calls[0]!;
    expect('record_calls' in body).toBe(false);
    expect(body.name).toBe('Renamed');
  });

  /**
   * THE case the whole asymmetry exists for. `record_calls: false` passes
   * master's guard even with the capability off, deliberately — disabling the
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

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
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

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].analysis_profile_id).toBeNull();
  });

  it('sends the chosen profile id', async () => {
    renderPage();

    fireEvent.change(await screen.findByLabelText(/call summary/i), {
      target: { value: 'prof-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].analysis_profile_id).toBe('prof-2');
  });

  it('keeps a stored profile the list no longer returns, rather than resaving it as none', async () => {
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ analysis_profile_id: 'prof-gone' }));
    renderPage();

    const select = (await screen.findByLabelText(/call summary/i)) as HTMLSelectElement;
    expect(select.value).toBe('prof-gone');
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].analysis_profile_id).toBe('prof-gone');
  });

  /**
   * `MAG-152`: `unlistedProfile` used to be computed from `analysisProfiles`
   * alone, and `useCallAnalysisProfiles` initialises that list to `[]` — so a
   * fetch still in flight was indistinguishable from a list that genuinely
   * lacked the campaign's profile. The three cases below — pending, failed, and
   * settled-and-absent — must each read differently.
   */
  describe('the picker while the profiles fetch has not settled successfully (MAG-152)', () => {
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
    // Same asymmetry as recording: `analysis_profile_id: null` passes master's
    // guard with the capability off.
    capabilitiesOff('agency.analytics');
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ analysis_profile_id: 'prof-1' }));
    renderPage();

    expect(await screen.findByText(/agency\.analytics/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /remove summary profile/i }));
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect(mocks.updateAgencyCampaign.mock.calls[0]![1].analysis_profile_id).toBeNull();
  });

  it('omits the field when `agency.analytics` is off and a profile is left alone', async () => {
    capabilitiesOff('agency.analytics');
    mocks.getAgencyCampaign.mockResolvedValue(campaign({ analysis_profile_id: 'prof-1' }));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(mocks.updateAgencyCampaign).toHaveBeenCalled());
    expect('analysis_profile_id' in mocks.updateAgencyCampaign.mock.calls[0]![1]).toBe(false);
  });

  /**
   * PORT NOTE (magick-agency): MODIFIED. cusui's "names `calls.dialer.analytics`
   * when the list cannot be read" pinned master's split between the profile-LIST
   * capability and the field's `agency.analytics`. Agency has one gate, so this
   * pins the opposite: with `agency.analytics` on, the list is fetched, and a
   * capability agency does not have changes nothing.
   */
  it('lists the profiles whenever `agency.analytics` is on — there is no separate list capability', async () => {
    capabilitiesOff('calls.dialer.analytics');
    renderPage();

    await screen.findByRole('button', { name: /save settings/i });
    expect(screen.queryByText(/calls\.dialer\.analytics/)).toBeNull();
    expect(mocks.useCallAnalysisProfiles).toHaveBeenCalledWith({ enabled: true });
    expect(mocks.useCallAnalysisProfiles).not.toHaveBeenCalledWith({ enabled: false });
  });
});

describe('campaign settings — the refusals reach the operator legibly', () => {
  it('names the capability on master’s `capability_disabled` 403', async () => {
    // `ApiError` reduces this body to the message `'capability_disabled'`, which
    // is a wire token. A bare "something went wrong" fails this outright.
    mocks.updateAgencyCampaign.mockRejectedValue(
      apiError(403, { error: 'capability_disabled', capability: 'agency.recording' }),
    );
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /save settings/i }));

    const alert = await screen.findByText(/agency\.recording/);
    expect(alert.textContent).toContain('Ask an administrator');
    expect(screen.queryByText(/^capability_disabled$/)).toBeNull();
  });

  it('surfaces core’s `Feature Not Enabled` message for the analysis flag', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    expect(
      await screen.findByText(/dialer call analysis is not enabled for this account/i),
    ).toBeTruthy();
  });

  it('explains a MASKED 404 as a missing profile, because the body cannot', async () => {
    // Master's error-mask hook rewrites core's
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
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

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

    fireEvent.click(await screen.findByRole('button', { name: /save settings/i }));

    expect(
      await screen.findByText(/must be a call-analysis profile id, or null to clear it/i),
    ).toBeTruthy();
  });
});

/**
 * ── This screen is a section of the campaign workspace (`MAG-166`) ──────────
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
