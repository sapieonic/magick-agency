import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { AgencyCampaign } from '../../types/agency-campaign';

/**
 * The retry dialog's "Keep the parent's assignments" (contact assignment): on by
 * default, sent as `keep_assignments`, and neither shown nor sent with the flag
 * off. The rest of the dialog is `AgencyRetryDialog.test.tsx`'s.
 */

const carrierMocks = vi.hoisted(() => ({ listAgencyCarriers: vi.fn(async () => [] as unknown[]) }));
const mocks = vi.hoisted(() => ({
  retryPreview: vi.fn(),
  createRetry: vi.fn(),
  useTenant: vi.fn(),
  flag: vi.fn(),
}));

vi.mock('../../api/agencyCampaigns', () => ({
  retryPreview: mocks.retryPreview,
  createRetry: mocks.createRetry,
}));
vi.mock('../../contexts/TenantContext', () => ({ useTenant: mocks.useTenant }));
// The dialog reads the carriers list for the parent's carrier account (its label, and
// whether it is still active).
vi.mock('../../api/agencyCarriers', () => ({ listAgencyCarriers: carrierMocks.listAgencyCarriers }));
vi.mock('../../hooks/usePhoneNumbers', () => ({
  usePhoneNumbers: () => ({
    phoneNumbers: [{
      id: 'a-1', phone_number: '+911234567890', phone_number_id: 'phone-1', provider_name: 'voicelink',
      provider_display_name: 'VoiceLink', label: 'Main', is_default: true, max_concurrent_calls: 5,
      capabilities: ['outbound'], region: 'IN',
    }],
    loading: false, error: null, reload: vi.fn(), defaultNumber: '+911234567890',
  }),
}));
vi.mock('../../hooks/useFeatureFlagEnabled', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../hooks/useFeatureFlagEnabled')>()),
  useFeatureFlagEnabled: mocks.flag,
}));

import { AgencyRetryDialog } from '../../components/agency/AgencyRetryDialog';
import { DEFAULT_RETRY_SELECTOR } from '../../utils/agencyRetrySelector';

const PARENT: AgencyCampaign = {
  id: 'camp-parent', name: 'Q3 Winback', status: 'completed', retry_generation: 0,
  caller_ids: ['+911234567890'], calling_window_start: '09:00:00', calling_window_end: '20:00:00',
  disposition_catalog: [],
};

function renderDialog() {
  render(
    <MemoryRouter>
      <AgencyRetryDialog
        open
        campaign={PARENT}
        selector={DEFAULT_RETRY_SELECTOR}
        origin="campaign"
        onClose={vi.fn()}
        onCreated={vi.fn()}
      />
    </MemoryRouter>,
  );
}

/** The `E`,`E` confirm gesture, awaited as `AgencyRetryDialog.test.tsx` explains. */
async function confirmCreate() {
  const button = (await screen.findByText('Create retry campaign')).closest('button')!;
  await waitFor(() => expect(button.getAttribute('aria-disabled')).toBeNull());
  fireEvent.keyDown(button, { key: 'e' });
  const again = await screen.findByText('Press E again to create');
  fireEvent.keyDown(again.closest('button')!, { key: 'e' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.flag.mockReturnValue(true);
  mocks.useTenant.mockReturnValue({ tenantId: 'tenant-1', accountId: 'account-1', role: 'account_admin' });
  mocks.retryPreview.mockResolvedValue({
    matched: 10, by_last_outcome: {}, by_last_disposition: {}, excluded: { dnc: 0, invalid: 0 },
    parent_contacts_total: 20, retry_generation: 0, max_seed_rows: 100_000,
  });
  mocks.createRetry.mockResolvedValue({
    campaign: { id: 'camp-child', name: 'Q3 Winback — Retry 1', status: 'draft' },
    contacts_seeded: 10, excluded: { dnc: 0, invalid: 0 },
  });
});

afterEach(() => cleanup());

describe('Keep the parent’s assignments', () => {
  it('is on by default and sent as keep_assignments: true', async () => {
    renderDialog();
    await screen.findByTestId('retry-matched');
    expect((screen.getByTestId('retry-keep-assignments') as HTMLInputElement).checked).toBe(true);
    await confirmCreate();
    await waitFor(() => expect(mocks.createRetry).toHaveBeenCalled());
    expect(mocks.createRetry.mock.calls[0]![1].keep_assignments).toBe(true);
  });

  it('unticked, every copied contact starts in the pool', async () => {
    renderDialog();
    await screen.findByTestId('retry-matched');
    fireEvent.click(screen.getByTestId('retry-keep-assignments'));
    expect(screen.getByText('Every contact starts in the pool, unassigned.')).toBeTruthy();
    await confirmCreate();
    await waitFor(() => expect(mocks.createRetry).toHaveBeenCalled());
    expect(mocks.createRetry.mock.calls[0]![1].keep_assignments).toBe(false);
  });

  it('is neither shown nor sent with the flag off', async () => {
    mocks.flag.mockReturnValue(false);
    renderDialog();
    await screen.findByTestId('retry-matched');
    expect(screen.queryByTestId('retry-keep-assignments')).toBeNull();
    await confirmCreate();
    await waitFor(() => expect(mocks.createRetry).toHaveBeenCalled());
    expect(mocks.createRetry.mock.calls[0]![1]).not.toHaveProperty('keep_assignments');
  });
});
