import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, cleanup, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * Settings → Soft phone with campaign templates on (CT11): the outcome list follows the account's
 * default campaign template, named, while the soft phone lists none of its own ("Follow campaign
 * template (<name>)", saved as the empty list), or is the soft phone's own ("Set for the soft
 * phone"). The server names what Follow gives whether or not the soft phone has its own list, in
 * the read and in the save's answer; the fixtures are its answers as sent (`{ settings,
 * outcomes_template }`), read through the real client. Without the field (an older server), it
 * follows the built-in outcomes; with the flag off, the page is as it was.
 */

const mocks = vi.hoisted(() => ({
  useTenant: vi.fn(),
  apiFetch: vi.fn(),
  showToast: vi.fn(),
  flags: { agency_campaign_templates_enabled: true } as Record<string, boolean>,
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({ useFeatureFlagEnabled: (flag: string) => mocks.flags[flag] === true }));
vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('../../hooks/useCallAnalysisProfiles', () => ({ useCallAnalysisProfiles: () => ({ profiles: [], loading: false }) }));
vi.mock('../../hooks/usePhoneNumbers', () => ({ usePhoneNumbers: () => ({ phoneNumbers: [] }) }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }),
}));

import SoftphoneSettingsPage from '../../pages/settings/SoftphoneSettingsPage';
import type { AgencySoftphoneSettings } from '../../types/softphone';

const SAVED: AgencySoftphoneSettings = {
  disposition_catalog: [],
  call_fields: [],
  analysis_profile_id: null,
  record_calls: false,
  default_caller_id: null,
  updated_at: '2026-10-30T09:00:00Z',
};

const FOLLOWS = {
  template: { id: 'tp-1', name: 'Collections', version: 3, scope: 'account' as const },
  disposition_catalog: [
    { code: 'will_pay', label: 'Will pay' },
    { code: 'call_later', label: 'Call later' },
  ],
};

/** What the server answers when no template is in the chain: the built-in outcomes, unnamed. */
const BUILT_IN = { template: null, disposition_catalog: [{ code: 'interested', label: 'Interested' }] };

const NOT_SENT = Symbol('not sent');

/** The server's answer to GET and PUT `/settings`. */
function answer(settings: AgencySoftphoneSettings, outcomesTemplate: unknown) {
  return outcomesTemplate === NOT_SENT ? { settings } : { settings, outcomes_template: outcomesTemplate };
}

/** PUT answers with what was sent, naming what Follow gives as `outcomesTemplate`. */
function putAnswers(outcomesTemplate: unknown) {
  mocks.apiFetch.mockImplementation(async (_url: string, init: RequestInit = {}) => {
    if (init.method === 'PUT') return answer({ ...SAVED, ...JSON.parse(init.body as string) }, outcomesTemplate);
    throw new Error('not expected');
  });
}

const puts = () =>
  mocks.apiFetch.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
    .map(([, init]) => JSON.parse((init as RequestInit).body as string));

async function renderPage(outcomesTemplate: unknown = FOLLOWS, settings: AgencySoftphoneSettings = SAVED) {
  mocks.useTenant.mockReturnValue({ tenantId: 't-1', accountId: 'a-1', role: 'account_admin' });
  mocks.apiFetch.mockResolvedValue(answer(settings, outcomesTemplate));
  render(
    <MemoryRouter>
      <SoftphoneSettingsPage />
    </MemoryRouter>,
  );
  await act(async () => {});
  putAnswers(outcomesTemplate);
}

beforeEach(() => {
  mocks.flags = { agency_campaign_templates_enabled: true };
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Settings → Soft phone, with campaign templates', () => {
  it('follows the account’s default template while the soft phone lists no outcomes', async () => {
    await renderPage();
    const outcomes = screen.getByTestId('softphone-settings-outcomes');
    const group = within(outcomes).getByRole('radiogroup', { name: 'Where the outcomes come from' });
    expect((within(group).getByRole('radio', { name: 'Follow campaign template (Collections)' }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId('softphone-outcomes-following').textContent).toContain('Untagged calls use the outcomes of Collections');
    expect(within(outcomes).getByRole('list').textContent).toBe('1Will pay2Call later');
  });

  it('sets the soft phone’s own list from the followed one, and saves the empty list to follow again', async () => {
    await renderPage();
    fireEvent.click(screen.getByRole('radio', { name: 'Set for the soft phone' }));
    expect((screen.getByLabelText('Outcome 1 label') as HTMLInputElement).value).toBe('Will pay');
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-settings-save'));
    });
    expect(puts()[0].disposition_catalog.map((d: { code: string }) => d.code)).toEqual(['will_pay', 'call_later']);

    fireEvent.click(screen.getByRole('radio', { name: 'Follow campaign template (Collections)' }));
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-settings-save'));
    });
    expect(puts()[1].disposition_catalog).toEqual([]);
  });

  it('opens on “Set for the soft phone” when it has its own list, naming the template Follow would give', async () => {
    await renderPage(FOLLOWS, { ...SAVED, disposition_catalog: [{ code: 'sold', label: 'Sold' }] });
    expect((screen.getByRole('radio', { name: 'Set for the soft phone' }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Outcome 1 label') as HTMLInputElement).value).toBe('Sold');
    fireEvent.click(screen.getByRole('radio', { name: 'Follow campaign template (Collections)' }));
    expect(screen.getByTestId('softphone-outcomes-following').textContent).toContain('Untagged calls use the outcomes of Collections');
    expect(within(screen.getByTestId('softphone-settings-outcomes')).getByRole('list').textContent).toBe('1Will pay2Call later');
  });

  it('names the built-in outcomes when no template is in the chain, with the list the server gives', async () => {
    await renderPage(BUILT_IN, { ...SAVED, disposition_catalog: [{ code: 'sold', label: 'Sold' }] });
    fireEvent.click(screen.getByRole('radio', { name: 'Follow the built-in outcomes' }));
    expect(screen.getByTestId('softphone-outcomes-following').textContent).toContain('Untagged calls use the built-in outcomes.');
    expect(within(screen.getByTestId('softphone-settings-outcomes')).getByRole('list').textContent).toBe('1Interested');
  });

  it('follows the built-in outcomes when the read does not say (an older server)', async () => {
    await renderPage(NOT_SENT);
    expect(screen.getByRole('radio', { name: 'Follow the built-in outcomes' })).toBeTruthy();
    expect(screen.getByTestId('softphone-outcomes-following').textContent).toContain('Untagged calls use the built-in outcomes.');
  });

  it('keeps what the save’s answer says Follow gives', async () => {
    await renderPage(FOLLOWS, { ...SAVED, disposition_catalog: [{ code: 'sold', label: 'Sold' }] });
    putAnswers({ template: { id: 'tp-2', name: 'Recovery', version: 1, scope: 'organisation' }, disposition_catalog: [{ code: 'paid', label: 'Paid' }] });
    fireEvent.change(screen.getByLabelText('Outcome 1 label'), { target: { value: 'Sold out' } });
    await act(async () => {
      fireEvent.click(screen.getByTestId('softphone-settings-save'));
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Follow campaign template (Recovery)' }));
    expect(screen.getByTestId('softphone-outcomes-following').textContent).toContain(
      'Untagged calls use the outcomes of Recovery, the organisation’s default campaign template.',
    );
  });

  it('is as it was with the flag off', async () => {
    mocks.flags = {};
    await renderPage();
    expect(screen.queryByRole('radiogroup', { name: 'Where the outcomes come from' })).toBeNull();
    expect(screen.getByTestId('softphone-settings-outcomes').textContent).toMatch(/The built-in outcomes are in use/);
  });
});
