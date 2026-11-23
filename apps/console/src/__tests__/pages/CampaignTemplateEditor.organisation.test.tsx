import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

/**
 * The organisation template editor's save through the real template client: the PUT goes without
 * the account (`X-Account-Id`), so the server judges the reader's organisation-wide seat (CT3), and
 * with the version it opened (CT6). Only `apiFetch` is replaced.
 */

const mocks = vi.hoisted(() => ({ apiFetch: vi.fn(), showToast: vi.fn() }));

vi.mock('../../api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../api/client')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('../../contexts/TenantContext', () => ({
  useTenant: () => ({
    tenantId: 't-1',
    accountId: 'a-1',
    role: 'tenant_admin',
    organisationRole: 'tenant_admin',
    accounts: [{ id: 'a-1', name: 'Pune', tenant_id: 't-1' }],
  }),
}));
vi.mock('../../hooks/useFeatureFlagEnabled', () => ({ useFeatureFlagEnabled: (flag: string) => flag === 'agency_campaign_templates_enabled' }));
vi.mock('../../contexts/GovernanceContext', () => ({ useGovernance: () => ({ isEnabled: () => true, loading: false }) }));
vi.mock('@magick-agency/web-ui/contexts/ToastContext', () => ({ useToast: () => ({ showToast: mocks.showToast, showErrorToast: vi.fn() }) }));
vi.mock('../../hooks/useAgencyCarriers', () => ({ useAgencyCarriers: () => ({ carriers: [], error: null }) }));
vi.mock('../../hooks/usePhoneNumbers', () => ({ usePhoneNumbers: () => ({ phoneNumbers: [], loading: false, error: null, reload: vi.fn() }) }));
vi.mock('../../hooks/useCallAnalysisProfiles', () => ({ useCallAnalysisProfiles: () => ({ profiles: [], loading: false, error: null }) }));

import CampaignTemplateEditorPage from '../../pages/settings/campaign-templates/CampaignTemplateEditorPage';

const ORG = {
  id: 'org-1',
  scope: 'organisation',
  account_id: null,
  name: 'Standard',
  description: null,
  is_default: true,
  version: 2,
  based_on: null,
  sections_set: ['wrapup'],
  created_at: '2026-11-01T09:00:00Z',
  updated_at: '2026-11-18T16:12:00Z',
  updated_by: null,
  archived_at: null,
  archived_by: null,
};
const SECTIONS = { wrapup: { wrapup_seconds: 45, wrapup_auto_return: true, allow_wrapup_redial: false } };

beforeEach(() => {
  mocks.apiFetch.mockImplementation(async (url: string, init: RequestInit = {}) => {
    if (init.method === 'PUT') return { ...ORG, ...JSON.parse(init.body as string), version: 3 };
    if (url.endsWith('/campaign-templates/org-1')) return { ...ORG, sections: SECTIONS, follows: null };
    return { templates: [ORG] };
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the organisation template editor', () => {
  it('saves without the account header, with the version it opened', async () => {
    render(
      <MemoryRouter initialEntries={['/settings/organisation-campaign-templates/org-1']}>
        <Routes>
          <Route path="/settings/organisation-campaign-templates/:id" element={<CampaignTemplateEditorPage scope="organisation" />} />
        </Routes>
      </MemoryRouter>,
    );
    await act(async () => {});
    await act(async () => {});
    // The campaign steps as tabs, less Customers and Name & number: it holds no numbers (CS21, CT15).
    expect(screen.getAllByRole('tab').map((t) => t.getAttribute('aria-label'))).toEqual(['Purpose & buttons', 'Agents & timing']);
    fireEvent.change(screen.getByLabelText('Description (optional)'), { target: { value: 'For everyone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save template' }));
    await act(async () => {});
    const put = mocks.apiFetch.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')!;
    expect(put[0]).toBe('/proxy/agency/campaign-templates/org-1');
    expect(put[2]).toBe('t-1');
    expect(put[3]).toBeUndefined();
    expect(JSON.parse((put[1] as RequestInit).body as string)).toMatchObject({ description: 'For everyone', expected_version: 2 });
    expect(mocks.showToast).toHaveBeenCalledWith('“Standard” saved as version 3.', 'success');
  });
});
