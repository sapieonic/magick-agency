import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import type { PhoneNumber } from '@magick-agency/contracts/api/platform/super-admin';

const mocks = vi.hoisted(() => ({
  listPhoneNumbers: vi.fn(),
  listTelephonyProviders: vi.fn(),
  createPhoneNumber: vi.fn(),
  getPhoneNumberDetail: vi.fn(),
  updatePhoneNumber: vi.fn(),
  retirePhoneNumber: vi.fn(),
  reactivatePhoneNumber: vi.fn(),
  deletePhoneNumber: vi.fn(),
}));

vi.mock('../../api/super-admin', () => ({
  listPhoneNumbers: mocks.listPhoneNumbers,
  listTelephonyProviders: mocks.listTelephonyProviders,
  createPhoneNumber: mocks.createPhoneNumber,
  getPhoneNumberDetail: mocks.getPhoneNumberDetail,
  updatePhoneNumber: mocks.updatePhoneNumber,
  retirePhoneNumber: mocks.retirePhoneNumber,
  reactivatePhoneNumber: mocks.reactivatePhoneNumber,
  deletePhoneNumber: mocks.deletePhoneNumber,
}));

import SAPhoneNumbersPage from '../../pages/super-admin/SAPhoneNumbersPage';

function makePhone(overrides: Partial<PhoneNumber>): PhoneNumber {
  return {
    id: 'pn-1',
    phone_number: '+910000000001',
    provider_id: 'prov-1',
    provider_name: 'voicelink',
    provider_display_name: 'VoiceLink',
    label: null,
    capabilities: ['voice'],
    region: null,
    max_concurrent_calls: 1,
    status: 'active',
    notes: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    assignment_count: 0,
    ...overrides,
  };
}

const first = makePhone({ id: 'pn-first', phone_number: '+918046733449' });
const second = makePhone({ id: 'pn-second', phone_number: '+910000000002' });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPhoneNumbers.mockResolvedValue([first, second]);
  mocks.listTelephonyProviders.mockResolvedValue([
    { id: 'prov-1', name: 'voicelink', display_name: 'VoiceLink', status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
    { id: 'prov-old', name: 'retired-carrier', display_name: 'Retired', status: 'inactive', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' },
  ]);
  mocks.createPhoneNumber.mockResolvedValue(makePhone({}));
  mocks.updatePhoneNumber.mockResolvedValue(makePhone({}));
  mocks.getPhoneNumberDetail.mockResolvedValue({ phone_number: second, assignments: [] });
});
afterEach(() => cleanup());

/*
 * There is no signup pool, so no `pool_eligible` cases. The create form picks
 * `provider_id` from `GET /super-admin/telephony-providers`.
 */
describe('SAPhoneNumbersPage — provider picker', () => {
  it('lists the active providers from the providers route and sends the chosen provider_id', async () => {
    render(<SAPhoneNumbersPage />);
    await waitFor(() => screen.getByText('+918046733449'));

    fireEvent.click(screen.getByRole('button', { name: /add number/i }));
    const scope = within(screen.getByRole('dialog'));
    expect(scope.queryByLabelText(/provider id/i)).toBeNull();
    expect(scope.queryByRole('option', { name: /retired/i })).toBeNull();
    fireEvent.change(scope.getByPlaceholderText('+919876543210'), { target: { value: '+910000000009' } });
    fireEvent.change(scope.getByRole('combobox'), { target: { value: 'prov-1' } });
    fireEvent.click(scope.getByRole('button', { name: /add number/i }));

    await waitFor(() => expect(mocks.createPhoneNumber).toHaveBeenCalledTimes(1));
    const body = mocks.createPhoneNumber.mock.calls[0]![0];
    expect(body).toEqual(expect.objectContaining({ phone_number: '+910000000009', provider_id: 'prov-1' }));
    expect(body).not.toHaveProperty('pool_eligible');
  });

  it('still offers the provider when the inventory is empty (no free-text id)', async () => {
    mocks.listPhoneNumbers.mockResolvedValue([]);
    render(<SAPhoneNumbersPage />);
    await waitFor(() => expect(mocks.listTelephonyProviders).toHaveBeenCalled());

    fireEvent.click(screen.getAllByRole('button', { name: /add number/i })[0]!);
    const scope = within(screen.getByRole('dialog'));
    expect(scope.queryByLabelText(/provider id/i)).toBeNull();
    fireEvent.change(scope.getByPlaceholderText('+919876543210'), { target: { value: '+910000000009' } });
    fireEvent.change(scope.getByRole('combobox'), { target: { value: 'prov-1' } });
    fireEvent.click(scope.getByRole('button', { name: /add number/i }));

    await waitFor(() => expect(mocks.createPhoneNumber).toHaveBeenCalledTimes(1));
    expect(mocks.createPhoneNumber).toHaveBeenCalledWith(expect.objectContaining({ provider_id: 'prov-1' }));
  });

  it('shows no signup-pool UI and sends no pool_eligible on edit', async () => {
    render(<SAPhoneNumbersPage />);
    await waitFor(() => screen.getByText('+910000000002'));
    expect(screen.queryByText(/signup pool/i)).toBeNull();

    fireEvent.click(screen.getByText('+910000000002'));
    await waitFor(() => expect(mocks.getPhoneNumberDetail).toHaveBeenCalledWith('pn-second'));
    fireEvent.click(screen.getByRole('button', { name: /edit/i }));
    const scope = within(screen.getByRole('dialog'));
    expect(scope.queryByRole('checkbox', { name: /pool eligible/i })).toBeNull();
    fireEvent.click(scope.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mocks.updatePhoneNumber).toHaveBeenCalledTimes(1));
    expect(mocks.updatePhoneNumber.mock.calls[0]![1]).not.toHaveProperty('pool_eligible');
  });
});

describe('SAPhoneNumbersPage — bulk lifecycle', () => {
  it('bulk-retires only the eligible (active, unassigned) selected numbers', async () => {
    const active = makePhone({ id: 'a1', phone_number: '+9111', status: 'active', assignment_count: 0 });
    const assigned = makePhone({ id: 'a2', phone_number: '+9122', status: 'active', assignment_count: 2 });
    const retired = makePhone({ id: 'r1', phone_number: '+9133', status: 'retired', assignment_count: 0 });
    mocks.listPhoneNumbers.mockResolvedValue([active, assigned, retired]);
    mocks.retirePhoneNumber.mockResolvedValue(undefined);

    render(<SAPhoneNumbersPage />);
    await waitFor(() => screen.getByText('+9111'));

    fireEvent.click(screen.getByRole('checkbox', { name: /select all/i }));
    // Only the active, unassigned number is retire-eligible (assigned + retired excluded).
    fireEvent.click(screen.getByRole('button', { name: /retire \(1\)/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Retire' })); // confirm

    await waitFor(() => expect(mocks.retirePhoneNumber).toHaveBeenCalledTimes(1));
    expect(mocks.retirePhoneNumber).toHaveBeenCalledWith('a1');
    expect(mocks.reactivatePhoneNumber).not.toHaveBeenCalled();
  });

  it('tolerates partial failure: refetches and reports the tally', async () => {
    const a1 = makePhone({ id: 'a1', phone_number: '+9111', status: 'active', assignment_count: 0 });
    const a2 = makePhone({ id: 'a2', phone_number: '+9122', status: 'active', assignment_count: 0 });
    mocks.listPhoneNumbers.mockResolvedValue([a1, a2]);
    mocks.retirePhoneNumber
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'));

    render(<SAPhoneNumbersPage />);
    await waitFor(() => screen.getByText('+9111'));

    fireEvent.click(screen.getByRole('checkbox', { name: /select all/i }));
    fireEvent.click(screen.getByRole('button', { name: /retire \(2\)/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Retire' })); // confirm

    await waitFor(() => expect(mocks.retirePhoneNumber).toHaveBeenCalledTimes(2));
    // Always refetches so the table reflects server state (initial load + post-bulk).
    await waitFor(() => expect(mocks.listPhoneNumbers).toHaveBeenCalledTimes(2));
    // Surfaces a per-item tally rather than a generic error.
    await waitFor(() => expect(screen.getByText(/1 number retired, 1 failed/i)).toBeTruthy());
  });
});
