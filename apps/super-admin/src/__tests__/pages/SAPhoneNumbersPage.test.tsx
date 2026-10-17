import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within, act } from '@testing-library/react';
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

// ── Inventory, filters and stats ─────────────────────────────────────────────

/**
 * A server that honours `provider_id` / `status` the way the real route does:
 * deleted numbers come back only when `status: 'deleted'` is asked for.
 */
function serveInventory(rows: PhoneNumber[]) {
  mocks.listPhoneNumbers.mockImplementation(async (filters?: { provider_id?: string; status?: string }) =>
    rows.filter(pn =>
      (!filters?.provider_id || pn.provider_id === filters.provider_id)
      && (filters?.status ? pn.status === filters.status : pn.status !== 'deleted')),
  );
}

const INVENTORY = [
  makePhone({ id: 'i1', phone_number: '+9101', status: 'active', label: 'Collections' }),
  makePhone({ id: 'i2', phone_number: '+9102', status: 'active', provider_id: 'prov-old', provider_name: 'retired-carrier' }),
  makePhone({ id: 'i3', phone_number: '+9103', status: 'retired' }),
];

describe('SAPhoneNumbersPage — inventory and filters', () => {
  it('shows a load failure with a retry instead of an empty table', async () => {
    mocks.listPhoneNumbers.mockRejectedValueOnce(new Error('inventory down'));
    render(<SAPhoneNumbersPage />);
    await waitFor(() => screen.getByText('inventory down'));
    expect(screen.queryByText('No phone numbers')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => screen.getByText('+918046733449'));
  });

  it('filters the rows by status and by provider', async () => {
    serveInventory(INVENTORY);
    render(<SAPhoneNumbersPage />);
    await waitFor(() => screen.getByText('+9101'));

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'retired' } });
    await waitFor(() => expect(screen.queryByText('+9101')).toBeNull());
    expect(screen.getByText('+9103')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText('Filter by provider'), { target: { value: 'prov-old' } });
    await waitFor(() => expect(screen.queryByText('+9101')).toBeNull());
    await waitFor(() => screen.getByText('+9102'));
    expect(screen.queryByText('+9103')).toBeNull();
  });

  it('searches by number and by label', async () => {
    serveInventory(INVENTORY);
    render(<SAPhoneNumbersPage />);
    await waitFor(() => screen.getByText('+9101'));

    fireEvent.change(screen.getByLabelText('Search phone numbers'), { target: { value: 'collect' } });
    expect(screen.getByText('+9101')).toBeTruthy();
    expect(screen.queryByText('+9102')).toBeNull();

    fireEvent.change(screen.getByLabelText('Search phone numbers'), { target: { value: 'nothing-matches' } });
    expect(screen.getByText('No numbers match the current filters.')).toBeTruthy();
  });

  // The stat cards describe the inventory, not the current filter: narrowing
  // to retired numbers used to report "Active: 0".
  it('counts the stat cards over the whole inventory, whatever the filter', async () => {
    serveInventory(INVENTORY);
    render(<SAPhoneNumbersPage />);
    await waitFor(() => screen.getByText('+9101'));
    expect(screen.getByLabelText('Active: 2')).toBeTruthy();
    expect(screen.getByLabelText('Retired: 1')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'retired' } });
    await waitFor(() => expect(screen.queryByText('+9101')).toBeNull());
    expect(screen.getByLabelText('Active: 2')).toBeTruthy();
    expect(screen.getByLabelText('Retired: 1')).toBeTruthy();
  });

  // The inventory read leaves deleted numbers out, so the Deleted filter
  // fetches them by status; the stat cards still count the inventory.
  it('shows deleted numbers under the Deleted filter, fetched by status', async () => {
    serveInventory([...INVENTORY, makePhone({ id: 'd1', phone_number: '+9199', status: 'deleted' })]);
    render(<SAPhoneNumbersPage />);
    await waitFor(() => screen.getByText('+9101'));
    expect(screen.queryByText('+9199')).toBeNull();

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'deleted' } });
    await waitFor(() => screen.getByText('+9199'));
    expect(screen.queryByText('+9101')).toBeNull();
    expect(screen.queryByText('No numbers match the current filters.')).toBeNull();
    expect(mocks.listPhoneNumbers).toHaveBeenCalledWith({ status: 'deleted' });
    expect(screen.getByLabelText('Active: 2')).toBeTruthy();
    expect(screen.getByLabelText('Retired: 1')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: '' } });
    await waitFor(() => screen.getByText('+9101'));
    expect(screen.queryByText('+9199')).toBeNull();
  });

  // The catalog is static for the page's life: a filter change must not
  // re-request it.
  it('fetches the provider catalog once, not on every filter change', async () => {
    serveInventory(INVENTORY);
    render(<SAPhoneNumbersPage />);
    await waitFor(() => screen.getByText('+9101'));

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'retired' } });
    await waitFor(() => expect(screen.queryByText('+9101')).toBeNull());
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'active' } });
    await waitFor(() => screen.getByText('+9101'));

    expect(mocks.listTelephonyProviders).toHaveBeenCalledTimes(1);
  });
});

// ── Single-row lifecycle actions ─────────────────────────────────────────────

describe('SAPhoneNumbersPage — single-row actions', () => {
  async function expand(number: string) {
    await waitFor(() => screen.getByText(number));
    fireEvent.click(screen.getByText(number));
    await waitFor(() => expect(mocks.getPhoneNumberDetail).toHaveBeenCalled());
    await waitFor(() => screen.getByText('Assigned tenants'));
  }

  it('retires an active number after confirmation', async () => {
    serveInventory(INVENTORY);
    mocks.getPhoneNumberDetail.mockResolvedValue({ phone_number: INVENTORY[0], assignments: [] });
    mocks.retirePhoneNumber.mockResolvedValue(undefined);
    render(<SAPhoneNumbersPage />);
    await expand('+9101');
    await waitFor(() => screen.getByText('No tenants assigned.'));

    fireEvent.click(screen.getByRole('button', { name: /^retire$/i }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/can be reactivated later/i)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'Retire' }));

    await waitFor(() => expect(mocks.retirePhoneNumber).toHaveBeenCalledWith('i1'));
    expect(mocks.reactivatePhoneNumber).not.toHaveBeenCalled();
    expect(mocks.deletePhoneNumber).not.toHaveBeenCalled();
  });

  it('blocks retiring a number that still has tenants, and calls nothing', async () => {
    serveInventory(INVENTORY);
    mocks.getPhoneNumberDetail.mockResolvedValue({
      phone_number: INVENTORY[0],
      assignments: [{ tenant_id: 't-9', tenant_name: 'Acme', is_default: true, assigned_at: '2026-01-01T00:00:00Z' }],
    });
    render(<SAPhoneNumbersPage />);
    await expand('+9101');
    await waitFor(() => screen.getByText('Acme'));

    fireEvent.click(screen.getByRole('button', { name: /^retire$/i }));
    expect(screen.getByText('Cannot retire phone number')).toBeTruthy();
    // The blocked notice opens instead of the retire confirmation.
    expect(screen.queryByText(/can be reactivated later/i)).toBeNull();
    expect(mocks.retirePhoneNumber).not.toHaveBeenCalled();
  });

  it('reactivates and deletes a retired number, each behind its own confirmation', async () => {
    serveInventory(INVENTORY);
    mocks.getPhoneNumberDetail.mockResolvedValue({ phone_number: INVENTORY[2], assignments: [] });
    mocks.reactivatePhoneNumber.mockResolvedValue(undefined);
    mocks.deletePhoneNumber.mockResolvedValue(undefined);
    render(<SAPhoneNumbersPage />);
    await expand('+9103');

    fireEvent.click(screen.getByRole('button', { name: /^reactivate$/i }));
    let dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/available for assignment again/i)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(mocks.reactivatePhoneNumber).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /delete permanently/i }));
    dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/irreversible/i)).toBeTruthy();
    fireEvent.click(dialog.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(mocks.deletePhoneNumber).toHaveBeenCalledWith('i3'));
    expect(mocks.reactivatePhoneNumber).not.toHaveBeenCalled();
  });

  it('shows a failed single-row action as an error above the table', async () => {
    serveInventory(INVENTORY);
    mocks.getPhoneNumberDetail.mockResolvedValue({ phone_number: INVENTORY[0], assignments: [] });
    mocks.retirePhoneNumber.mockRejectedValue(new Error('carrier says no'));
    render(<SAPhoneNumbersPage />);
    await expand('+9101');
    await waitFor(() => screen.getByText('No tenants assigned.'));

    fireEvent.click(screen.getByRole('button', { name: /^retire$/i }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Retire' }));
    await waitFor(() => screen.getByText('carrier says no'));
    expect(screen.getByText('+9101')).toBeTruthy();
  });
});

describe('SAPhoneNumbersPage — bulk concurrency', () => {
  // `Promise.allSettled` over every selected row fired them all at once; the
  // bulk run is bounded like every other fan-out (`mapWithConcurrency`).
  it('keeps at most six retire requests in flight', async () => {
    const rows = Array.from({ length: 10 }, (_, i) =>
      makePhone({ id: `b${i}`, phone_number: `+92${i}`, status: 'active', assignment_count: 0 }));
    serveInventory(rows);
    let inFlight = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    mocks.retirePhoneNumber.mockImplementation(() => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      return new Promise<void>(resolve => release.push(() => { inFlight -= 1; resolve(); }));
    });

    render(<SAPhoneNumbersPage />);
    await waitFor(() => screen.getByText('+920'));
    fireEvent.click(screen.getByRole('checkbox', { name: /select all/i }));
    fireEvent.click(screen.getByRole('button', { name: /retire \(10\)/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Retire' }));

    // Release whatever is in flight, round by round, until all ten have run.
    while (mocks.retirePhoneNumber.mock.calls.length < 10 || release.length > 0) {
      await waitFor(() => expect(release.length).toBeGreaterThan(0));
      const pending = release.splice(0);
      await act(async () => { pending.forEach(fn => fn()); });
    }

    expect(mocks.retirePhoneNumber).toHaveBeenCalledTimes(10);
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1);
  });
});
