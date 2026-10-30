import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  getSoftphoneSettings: vi.fn(),
  putSoftphoneSettings: vi.fn(),
  showToast: vi.fn(),
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../api/softphone', () => ({
  getSoftphoneSettings: mocks.getSoftphoneSettings,
  putSoftphoneSettings: mocks.putSoftphoneSettings,
}));
vi.mock('../../hooks/useCallAnalysisProfiles', () => ({
  useCallAnalysisProfiles: () => ({ profiles: [{ id: 'prof-1', name: 'General enquiries v2' }], loading: false }),
}));
vi.mock('../../hooks/usePhoneNumbers', () => ({
  usePhoneNumbers: () => ({ phoneNumbers: [{ phone_number: '+912248901120' }, { phone_number: '+912248908888' }] }),
}));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));

import SoftphoneSettingsPage from '../../pages/settings/SoftphoneSettingsPage';
import type { AgencySoftphoneSettings } from '../../types/softphone';

/**
 * Settings → Soft phone: the untagged outcome list (the campaign editor, or the
 * built-in list), the call-fields editor (≤20, the contract's key pattern, keys
 * fixed once saved), summary profile, recording and default caller ID —
 * editable with `agency.softphone.manage`, read-only otherwise.
 */

const SAVED: AgencySoftphoneSettings = {
  disposition_catalog: [],
  call_fields: [{ key: 'customer_name', label: 'Customer name', type: 'text', required: true }],
  analysis_profile_id: null,
  record_calls: false,
  default_caller_id: null,
  updated_at: '2026-10-30T09:00:00Z',
};

async function renderPage(role = 'account_admin') {
  mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role });
  render(
    <MemoryRouter>
      <SoftphoneSettingsPage />
    </MemoryRouter>,
  );
  await act(async () => {});
}

beforeEach(() => {
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.getSoftphoneSettings.mockResolvedValue(SAVED);
});
afterEach(cleanup);

describe('Settings → Soft phone', () => {
  it('is read-only without agency.softphone.manage', async () => {
    await renderPage('operator');
    expect(screen.getByTestId('softphone-settings-readonly')).toBeTruthy();
    expect(screen.queryByTestId('softphone-settings-save')).toBeNull();
    expect((screen.getByTestId('softphone-settings-record') as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByTestId('softphone-settings-customise')).toBeNull();
    expect(screen.queryByTestId('softphone-settings-add-field')).toBeNull();
  });

  it('shows the built-in outcomes when none are set, and the campaign editor once customised', async () => {
    await renderPage();
    const outcomes = screen.getByTestId('softphone-settings-outcomes');
    expect(outcomes.textContent).toMatch(/The built-in outcomes are in use/);
    fireEvent.click(screen.getByTestId('softphone-settings-customise'));
    expect(within(outcomes).getByLabelText('Outcome 1 label')).toBeTruthy();
    expect(within(outcomes).getByRole('button', { name: 'Use the built-in outcomes instead' })).toBeTruthy();
  });

  it('fixes a saved field’s key and lets a new one follow its label', async () => {
    await renderPage();
    expect(screen.getByTestId('field-key-locked-0').textContent).toBe('customer_name');
    fireEvent.click(screen.getByTestId('softphone-settings-add-field'));
    fireEvent.change(screen.getByLabelText('Label', { selector: '#call_fields\\[1\\]-label' }), {
      target: { value: 'Loan account no.' },
    });
    expect((screen.getByTestId('field-key-1') as HTMLInputElement).value).toBe('loan_account_no');
  });

  it('refuses a bad key and a choice with no options before saving', async () => {
    await renderPage();
    fireEvent.click(screen.getByTestId('softphone-settings-add-field'));
    fireEvent.change(screen.getByTestId('field-key-1'), { target: { value: 'Bad Key' } });
    fireEvent.change(screen.getByLabelText('Type', { selector: '#call_fields\\[1\\]-type' }), { target: { value: 'choice' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-settings-save'));
    });
    expect(mocks.putSoftphoneSettings).not.toHaveBeenCalled();
    expect(document.body.textContent).toMatch(/lowercase letters, digits and underscores, starting with a letter/);
    expect(document.body.textContent).toMatch(/A choice needs at least one option/);
    expect(document.body.textContent).toMatch(/Every field needs a label/);
  });

  it('saves the whole row: record, profile, default caller ID, fields', async () => {
    mocks.putSoftphoneSettings.mockImplementation(async (body: Record<string, unknown>) => ({ ok: true, value: { ...SAVED, ...body } }));
    await renderPage();
    fireEvent.click(screen.getByTestId('softphone-settings-record'));
    fireEvent.change(screen.getByTestId('softphone-settings-profile'), { target: { value: 'prof-1' } });
    fireEvent.change(screen.getByTestId('softphone-settings-caller'), { target: { value: '+912248908888' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-settings-save'));
    });
    expect(mocks.putSoftphoneSettings).toHaveBeenCalledWith(
      {
        disposition_catalog: [],
        call_fields: [{ key: 'customer_name', label: 'Customer name', type: 'text', required: true }],
        analysis_profile_id: 'prof-1',
        record_calls: true,
        default_caller_id: '+912248908888',
      },
      't-1',
      'a-1',
    );
    expect(mocks.showToast).toHaveBeenCalledWith('Soft-phone settings saved.', 'success');
  });

  it('puts the server’s settings_invalid details on their fields', async () => {
    mocks.putSoftphoneSettings.mockResolvedValue({
      ok: false,
      refusal: { code: 'settings_invalid', status: 400, message: 'x', details: [{ path: 'default_caller_id', message: 'Not one of the account’s numbers.' }] },
    });
    await renderPage();
    fireEvent.click(screen.getByTestId('softphone-settings-record'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-settings-save'));
    });
    expect(document.body.textContent).toMatch(/Not one of the account’s numbers\./);
    expect(document.body.textContent).toMatch(/Some settings need fixing\./);
  });

  it('warns that removing a saved field keeps its values on past calls', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Customer name' }));
    expect(screen.getByTestId('softphone-settings-removed').textContent).toMatch(
      /Removing ‘customer_name’ stops agents filling it in\. Values already saved on past calls stay on those calls\./,
    );
  });
});
