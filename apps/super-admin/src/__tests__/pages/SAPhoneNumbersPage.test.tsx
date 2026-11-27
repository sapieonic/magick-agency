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
  getPhoneNumberInbound: vi.fn(),
  linkPhoneNumberInbound: vi.fn(),
  unlinkPhoneNumberInbound: vi.fn(),
  listTelephonyCredentials: vi.fn(),
  listTenants: vi.fn(),
  pinPhoneNumber: vi.fn(),
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
  getPhoneNumberInbound: mocks.getPhoneNumberInbound,
  linkPhoneNumberInbound: mocks.linkPhoneNumberInbound,
  unlinkPhoneNumberInbound: mocks.unlinkPhoneNumberInbound,
  listTelephonyCredentials: mocks.listTelephonyCredentials,
  listTenants: mocks.listTenants,
  pinPhoneNumber: mocks.pinPhoneNumber,
}));

import SAPhoneNumbersPage from '../../pages/super-admin/SAPhoneNumbersPage';
import type { TelephonyCredential } from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';

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

const AT = { created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
/** Every capability as `GET /super-admin/telephony-providers` sends it (docs/carriers.md CR1, CR6, CR11). */
const PROVIDERS = [
  // The service's own account, and tenants' own with numbers added by hand; no inbound.
  { id: 'prov-1', name: 'voicelink', display_name: 'VoiceLink', status: 'active', takes_tenant_credentials: true, service_account: true, tenant_accounts: true, number_source: 'manual', supports_inbound: false, ...AT },
  { id: 'prov-old', name: 'retired-carrier', display_name: 'Retired', status: 'inactive', takes_tenant_credentials: false, service_account: true, tenant_accounts: false, number_source: null, supports_inbound: false, ...AT },
  // Tenants' own accounts only, numbers synced, inbound taken.
  { id: 'prov-byoc', name: 'plivo', display_name: 'Plivo', status: 'active', takes_tenant_credentials: true, service_account: false, tenant_accounts: true, number_source: 'sync', supports_inbound: true, ...AT },
  // Tenants' own accounts only, numbers added by hand (no such carrier yet: the rule, not a name).
  { id: 'prov-z99', name: 'z99', display_name: 'Z99', status: 'active', takes_tenant_credentials: true, service_account: false, tenant_accounts: true, number_source: 'manual', supports_inbound: false, ...AT },
];

function makeCredential(over: Partial<TelephonyCredential>): TelephonyCredential {
  return {
    id: 'cred-vl', tenant_id: 'tenant-acme', provider: 'voicelink', label: 'Acme direct', status: 'active',
    account_ref: 'acme-direct', public_config: { username: 'acme-direct' }, secret_version: 1, secret_hint: 'ab12',
    verified_at: null, last_error: null, max_concurrent_calls: null, created_by: null, updated_by: null, created_at: AT.created_at, updated_at: AT.updated_at,
    revoked_at: null, shredded_at: null, ...over,
  };
}

const CREDENTIALS: TelephonyCredential[] = [
  makeCredential({}),
  makeCredential({ id: 'cred-vl-zen', tenant_id: 'tenant-zen', label: 'Zen line' }),
  makeCredential({ id: 'cred-vl-off', label: 'Acme old', status: 'disabled' }),
  makeCredential({ id: 'cred-plivo', provider: 'plivo', label: 'Acme main', account_ref: 'MAXXXX' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listPhoneNumbers.mockResolvedValue([first, second]);
  mocks.listTelephonyProviders.mockResolvedValue(PROVIDERS);
  mocks.listTelephonyCredentials.mockResolvedValue(CREDENTIALS);
  mocks.listTenants.mockResolvedValue({ tenants: [{ id: 'tenant-acme', name: 'Acme' }, { id: 'tenant-zen', name: 'Zen' }] });
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

  it('never offers a carrier dialled on tenants\' own accounts, and points to Sync numbers instead', async () => {
    render(<SAPhoneNumbersPage />);
    await waitFor(() => screen.getByText('+918046733449'));
    fireEvent.click(screen.getByRole('button', { name: /add number/i }));
    const scope = within(screen.getByRole('dialog'));
    const options = scope.getAllByRole('option').map((o) => o.getAttribute('value'));
    expect(options).toContain('prov-1');
    expect(options).not.toContain('prov-byoc');
    expect(scope.getByTestId('synced-carriers-hint').textContent)
      .toBe('Numbers on Pravah (Plivo) come from a tenant’s own carrier account: use Sync numbers on its credential under Telephony credentials.');
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

describe('SAPhoneNumbersPage — Add number by account mode (docs/carriers.md CR6)', () => {
  async function openAdd() {
    render(<SAPhoneNumbersPage />);
    await waitFor(() => screen.getByText('+918046733449'));
    fireEvent.click(screen.getByRole('button', { name: /add number/i }));
    const scope = within(screen.getByRole('dialog'));
    await waitFor(() => expect(mocks.listTenants).toHaveBeenCalled());
    return scope;
  }
  const fillNumber = (scope: ReturnType<typeof within>) =>
    fireEvent.change(scope.getByPlaceholderText('+919876543210'), { target: { value: '+910000000009' } });
  const accountOptions = (scope: ReturnType<typeof within>) =>
    Array.from((scope.getByLabelText('Account') as HTMLSelectElement).options).map(o => [o.value, o.textContent]);

  it('offers a carrier with a service account or by-hand tenant numbers, never one whose numbers sync', async () => {
    const scope = await openAdd();
    const offered = Array.from((scope.getByLabelText('Provider') as HTMLSelectElement).options).map(o => o.value);
    expect(offered).toEqual(['', 'prov-1', 'prov-z99']);
    // The synced carrier keeps today's note.
    expect(scope.getByTestId('synced-carriers-hint').textContent)
      .toBe('Numbers on Pravah (Plivo) come from a tenant’s own carrier account: use Sync numbers on its credential under Telephony credentials.');
  });

  it('on a carrier with both: the service’s own account first, then each ACTIVE account of that carrier, named tenant · label', async () => {
    const scope = await openAdd();
    expect(scope.queryByLabelText('Account')).toBeNull();
    fireEvent.change(scope.getByLabelText('Provider'), { target: { value: 'prov-1' } });
    await waitFor(() => expect(accountOptions(scope)).toEqual([
      ['service', 'The service’s own account'],
      ['cred-vl', 'Acme · Acme direct'],
      ['cred-vl-zen', 'Zen · Zen line'],
    ]));
    expect(scope.getByTestId('account-hint').textContent)
      .toBe('A number on a tenant’s own account is assigned to that tenant automatically.');
    expect(scope.queryByTestId('accounts-none')).toBeNull();
  });

  it('sends a null credential for the service’s own account', async () => {
    const scope = await openAdd();
    fillNumber(scope);
    fireEvent.change(scope.getByLabelText('Provider'), { target: { value: 'prov-1' } });
    fireEvent.click(scope.getByRole('button', { name: /add number/i }));
    await waitFor(() => expect(mocks.createPhoneNumber).toHaveBeenCalledTimes(1));
    expect(mocks.createPhoneNumber.mock.calls[0]![0]).toEqual(expect.objectContaining({
      phone_number: '+910000000009', provider_id: 'prov-1', telephony_credential_id: null,
    }));
  });

  it('sends the chosen tenant account’s credential', async () => {
    const scope = await openAdd();
    fillNumber(scope);
    fireEvent.change(scope.getByLabelText('Provider'), { target: { value: 'prov-1' } });
    await waitFor(() => expect(accountOptions(scope)).toHaveLength(3));
    fireEvent.change(scope.getByLabelText('Account'), { target: { value: 'cred-vl-zen' } });
    fireEvent.click(scope.getByRole('button', { name: /add number/i }));
    await waitFor(() => expect(mocks.createPhoneNumber).toHaveBeenCalledTimes(1));
    expect(mocks.createPhoneNumber.mock.calls[0]![0]).toEqual(expect.objectContaining({
      provider_id: 'prov-1', telephony_credential_id: 'cred-vl-zen',
    }));
  });

  it('on a tenant-only carrier the account is required: no service option, nothing sent until one is picked', async () => {
    mocks.listTelephonyCredentials.mockResolvedValue([...CREDENTIALS, makeCredential({ id: 'cred-z99', provider: 'z99', label: 'Acme z' })]);
    const scope = await openAdd();
    fillNumber(scope);
    fireEvent.change(scope.getByLabelText('Provider'), { target: { value: 'prov-z99' } });
    await waitFor(() => expect(accountOptions(scope)).toEqual([
      ['', 'Select a tenant’s account…'],
      ['cred-z99', 'Acme · Acme z'],
    ]));
    expect((scope.getByLabelText('Account') as HTMLSelectElement).value).toBe('');
    expect((scope.getByLabelText('Account') as HTMLSelectElement).required).toBe(true);
    fireEvent.click(scope.getByRole('button', { name: /add number/i }));
    expect(mocks.createPhoneNumber).not.toHaveBeenCalled();

    fireEvent.change(scope.getByLabelText('Account'), { target: { value: 'cred-z99' } });
    fireEvent.click(scope.getByRole('button', { name: /add number/i }));
    await waitFor(() => expect(mocks.createPhoneNumber).toHaveBeenCalledTimes(1));
    expect(mocks.createPhoneNumber.mock.calls[0]![0]).toEqual(expect.objectContaining({
      provider_id: 'prov-z99', telephony_credential_id: 'cred-z99',
    }));
  });

  it('says so when a tenant-only carrier has no active account to add a number to', async () => {
    const scope = await openAdd();
    fireEvent.change(scope.getByLabelText('Provider'), { target: { value: 'prov-z99' } });
    expect((await scope.findByTestId('accounts-none')).textContent)
      .toBe('No tenant has an active Navtara (Z99) account. Add one under Telephony credentials first.');
  });

  it.each([
    ['telephony_credential_not_active', 409, 'That carrier account is not active, so a number cannot be added to it. Enable or verify it under Telephony credentials, then try again.'],
    ['telephony_credential_not_found', 404, 'That carrier account no longer exists on this carrier. Pick another account.'],
  ])('says %s in words and reloads the accounts', async (code, status, copy) => {
    mocks.createPhoneNumber.mockRejectedValue(Object.assign(new Error('server words'), {
      statusCode: status, details: { error: status === 404 ? 'Not Found' : 'Conflict', code, message: 'server words' },
    }));
    const scope = await openAdd();
    fillNumber(scope);
    fireEvent.change(scope.getByLabelText('Provider'), { target: { value: 'prov-1' } });
    await waitFor(() => expect(accountOptions(scope)).toHaveLength(3));
    fireEvent.change(scope.getByLabelText('Account'), { target: { value: 'cred-vl' } });
    const loads = mocks.listTelephonyCredentials.mock.calls.length;
    fireEvent.click(scope.getByRole('button', { name: /add number/i }));
    expect(await scope.findByText(copy)).toBeTruthy();
    expect(scope.queryByText('server words')).toBeNull();
    expect(mocks.listTelephonyCredentials.mock.calls.length).toBe(loads + 1);
  });

  it('shows the server’s sentence for a refusal without a code (a carrier that does not take the mode)', async () => {
    mocks.createPhoneNumber.mockRejectedValue(Object.assign(new Error('This carrier’s numbers come from a credential’s Sync numbers.'), {
      statusCode: 400, details: { error: 'Bad Request', message: 'This carrier’s numbers come from a credential’s Sync numbers.' },
    }));
    const scope = await openAdd();
    fillNumber(scope);
    fireEvent.change(scope.getByLabelText('Provider'), { target: { value: 'prov-1' } });
    fireEvent.click(scope.getByRole('button', { name: /add number/i }));
    expect(await scope.findByText('This carrier’s numbers come from a credential’s Sync numbers.')).toBeTruthy();
  });

  it('reads an older server (no capability fields) as before: tenant-account carriers out, no Account picker', async () => {
    mocks.listTelephonyProviders.mockResolvedValue([
      { id: 'prov-1', name: 'voicelink', display_name: 'VoiceLink', status: 'active', ...AT },
      { id: 'prov-byoc', name: 'plivo', display_name: 'Plivo', status: 'active', takes_tenant_credentials: true, ...AT },
    ]);
    const scope = await openAdd();
    const offered = Array.from((scope.getByLabelText('Provider') as HTMLSelectElement).options).map(o => o.value);
    expect(offered).toEqual(['', 'prov-1']);
    fireEvent.change(scope.getByLabelText('Provider'), { target: { value: 'prov-1' } });
    expect(scope.queryByLabelText('Account')).toBeNull();
  });
});

describe('SAPhoneNumbersPage — the carrier account a number is on (CR6, CR7)', () => {
  const pinned = makePhone({ id: 'pn-vl', phone_number: '+912200000006', telephony_credential_id: 'cred-vl' });

  it('names a pinned number’s tenant account by its label and tenant; the service’s own as Service account', async () => {
    mocks.listPhoneNumbers.mockResolvedValue([pinned, first]);
    mocks.getPhoneNumberDetail.mockResolvedValue({ phone_number: pinned, assignments: [] });
    render(<SAPhoneNumbersPage />);
    const row = (await screen.findByText('+912200000006')).closest('tr')!;
    await waitFor(() => expect(within(row).getByTestId('number-account').textContent).toBe('Acme direct (Acme)'));
    // A number on the service's own account carries no extra line in the list.
    expect(within(screen.getByText('+918046733449').closest('tr')!).queryByTestId('number-account')).toBeNull();

    fireEvent.click(row);
    expect((await screen.findByTestId('number-account-detail')).textContent).toBe('Acme direct (Acme)');
    fireEvent.click(screen.getByText('+918046733449').closest('tr')!);
    await waitFor(() => expect(screen.getByTestId('number-account-detail').textContent).toBe('Service account'));
  });

  it('says a tenant account it cannot name is a tenant’s own, and marks one not active', async () => {
    mocks.listPhoneNumbers.mockResolvedValue([
      { ...pinned, telephony_credential_id: 'cred-unknown' },
      { ...pinned, id: 'pn-off', phone_number: '+912200000007', telephony_credential_id: 'cred-vl-off' },
    ]);
    render(<SAPhoneNumbersPage />);
    const unknown = (await screen.findByText('+912200000006')).closest('tr')!;
    await waitFor(() => expect(mocks.listTelephonyCredentials).toHaveBeenCalled());
    await waitFor(() => expect(within(unknown).getByTestId('number-account').textContent).toBe('A tenant’s own account'));
    const off = screen.getByText('+912200000007').closest('tr')!;
    expect(within(off).getByTestId('number-account').textContent).toBe('Acme old (Acme), disabled');
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

describe('SAPhoneNumbersPage — inbound calls (docs/inbound.md §8.1)', () => {
  const synced = makePhone({
    id: 'pn-synced', phone_number: '+14155550101', provider_id: 'prov-byoc', provider_name: 'plivo', provider_display_name: 'Plivo',
    telephony_credential_id: 'cred-1', inbound_linked_at: '2026-11-09T10:05:00Z', inbound_previous_app_id: null,
  });

  it('badges a linked number, and offers Link/Unlink only on a synced number, refreshing the badge after a change', async () => {
    mocks.listPhoneNumbers.mockResolvedValue([synced, first]);
    mocks.getPhoneNumberDetail.mockResolvedValue({ phone_number: synced, assignments: [] });
    mocks.getPhoneNumberInbound.mockResolvedValue({
      phone_number_id: 'pn-synced', phone_number: '+14155550101',
      link: { linked: true, linked_at: '2026-11-09T10:05:00Z', previous_app_id: null, route: null },
      credential: { id: 'cred-1', label: 'Acme main', status: 'active', inbound_enabled: true }, link_blocker: null,
    });
    mocks.unlinkPhoneNumberInbound.mockResolvedValue({
      phone_number_id: 'pn-synced', phone_number: '+14155550101',
      link: { linked: false, linked_at: null, previous_app_id: null, route: null },
      credential: { id: 'cred-1', label: 'Acme main', status: 'active', inbound_enabled: true }, link_blocker: null,
    });
    render(<SAPhoneNumbersPage />);
    const row = (await screen.findByText('+14155550101')).closest('tr')!;
    expect(within(row).getByText('Inbound')).toBeTruthy();
    expect(within(screen.getByText('+918046733449').closest('tr')!).queryByText('Inbound')).toBeNull();

    fireEvent.click(row);
    const unlink = await screen.findByRole('button', { name: /Unlink from inbound/ });
    mocks.listPhoneNumbers.mockResolvedValue([{ ...synced, inbound_linked_at: null }, first]);
    fireEvent.click(unlink);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(mocks.unlinkPhoneNumberInbound).toHaveBeenCalledWith('pn-synced'));
    await waitFor(() => expect(within(screen.getByText('+14155550101').closest('tr')!).queryByText('Inbound')).toBeNull());
    // The row stays open on the panel.
    expect(await screen.findByRole('button', { name: /Link to inbound/ })).toBeTruthy();

    // A number on the service's own account has no inbound panel.
    fireEvent.click(screen.getByText('+918046733449').closest('tr')!);
    await waitFor(() => expect(screen.queryByTestId('number-inbound')).toBeNull());
    expect(mocks.getPhoneNumberInbound).toHaveBeenCalledTimes(1);
  });

  it('shows no inbound panel for a pinned number on a carrier without inbound, and never asks for its state (CR11)', async () => {
    const voicelinkPinned = makePhone({ id: 'pn-vl', phone_number: '+912200000006', telephony_credential_id: 'cred-vl' });
    mocks.listPhoneNumbers.mockResolvedValue([voicelinkPinned]);
    mocks.getPhoneNumberDetail.mockResolvedValue({ phone_number: voicelinkPinned, assignments: [] });
    render(<SAPhoneNumbersPage />);
    await waitFor(() => expect(mocks.listTelephonyProviders).toHaveBeenCalled());
    fireEvent.click((await screen.findByText('+912200000006')).closest('tr')!);
    await waitFor(() => expect(mocks.getPhoneNumberDetail).toHaveBeenCalledWith('pn-vl'));
    expect(await screen.findByText('No tenants assigned.')).toBeTruthy();
    expect(screen.queryByTestId('number-inbound')).toBeNull();
    expect(mocks.getPhoneNumberInbound).not.toHaveBeenCalled();
  });

  it('flags a linked number no account route answers (its callers hear the closed message); a routed one is a plain badge', async () => {
    mocks.listPhoneNumbers.mockResolvedValue([
      { ...synced, inbound_route_name: null },
      { ...synced, id: 'pn-routed', phone_number: '+14155550102', inbound_route_name: 'Main line' },
      first,
    ]);
    render(<SAPhoneNumbersPage />);
    const unrouted = (await screen.findByText('+14155550101')).closest('tr')!;
    expect(within(unrouted).getByTestId('inbound-no-route').textContent).toBe('Inbound · no route');
    const routed = screen.getByText('+14155550102').closest('tr')!;
    expect(within(routed).getByText('Inbound').getAttribute('title')).toBe('Linked to inbound calls, answered by Main line');
    expect(within(routed).queryByTestId('inbound-no-route')).toBeNull();
  });
});

describe('SAPhoneNumbersPage — Move to a tenant’s account (docs/carriers.md CR6 amended)', () => {
  const service = makePhone({ id: 'pn-svc', phone_number: '+912200000001' });
  const moveButton = () => screen.queryByRole('button', { name: 'Move to a tenant’s account' });

  async function openRow(phone: PhoneNumber) {
    mocks.getPhoneNumberDetail.mockResolvedValue({ phone_number: phone, assignments: [] });
    render(<SAPhoneNumbersPage />);
    await waitFor(() => expect(mocks.listTelephonyProviders).toHaveBeenCalled());
    fireEvent.click((await screen.findByText(phone.phone_number)).closest('tr')!);
    await waitFor(() => expect(mocks.getPhoneNumberDetail).toHaveBeenCalledWith(phone.id));
  }

  async function openDialog() {
    mocks.listPhoneNumbers.mockResolvedValue([service]);
    await openRow(service);
    fireEvent.click(await screen.findByRole('button', { name: 'Move to a tenant’s account' }));
    const scope = within(await screen.findByRole('dialog'));
    await waitFor(() => expect(mocks.listTenants).toHaveBeenCalled());
    return scope;
  }

  it.each([
    ['a number already on a tenant’s account', makePhone({ id: 'pn-x', phone_number: '+912200000009', telephony_credential_id: 'cred-vl' })],
    ['a retired number', makePhone({ id: 'pn-x', phone_number: '+912200000009', status: 'retired' })],
    ['a number on a carrier whose tenant numbers sync', makePhone({ id: 'pn-x', phone_number: '+912200000009', provider_id: 'prov-byoc', provider_name: 'plivo' })],
  ])('is not offered on %s', async (_what, phone) => {
    mocks.listPhoneNumbers.mockResolvedValue([phone]);
    await openRow(phone);
    expect(await screen.findByText('No tenants assigned.')).toBeTruthy();
    expect(moveButton()).toBeNull();
  });

  it('offers the carrier’s active accounts, says it is one way, and moves only once one is picked', async () => {
    const scope = await openDialog();
    await waitFor(() => expect(Array.from((scope.getByLabelText('Account') as HTMLSelectElement).options).map(o => [o.value, o.textContent])).toEqual([
      ['', 'Select a tenant’s account…'],
      ['cred-vl', 'Acme · Acme direct'],
      ['cred-vl-zen', 'Zen · Zen line'],
    ]));
    expect(scope.getByTestId('pin-one-way').textContent)
      .toBe('This cannot be undone: the number moves to that tenant’s own carrier account for good, and is assigned to that tenant.');
    const move = scope.getByRole('button', { name: 'Move number' }) as HTMLButtonElement;
    expect(move.disabled).toBe(true);

    const pinned = { ...service, telephony_credential_id: 'cred-vl' };
    mocks.pinPhoneNumber.mockResolvedValue({ phone_number: pinned, tenant_id: 'tenant-acme' });
    mocks.listPhoneNumbers.mockResolvedValue([pinned]);
    mocks.getPhoneNumberDetail.mockResolvedValue({
      phone_number: pinned, assignments: [{ tenant_id: 'tenant-acme', tenant_name: 'Acme', is_default: false, assigned_at: '2026-11-25T00:00:00Z' }],
    });
    fireEvent.change(scope.getByLabelText('Account'), { target: { value: 'cred-vl' } });
    fireEvent.click(move);
    await waitFor(() => expect(mocks.pinPhoneNumber).toHaveBeenCalledWith('pn-svc', { telephony_credential_id: 'cred-vl' }));
    // The dialog closes, the row says its new account, and the open row shows the new tenant.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(screen.getByTestId('number-account-detail').textContent).toBe('Acme direct (Acme)'));
    expect(await screen.findByText('Acme', { selector: 'span' })).toBeTruthy();
    expect(moveButton()).toBeNull();
  });

  /** Shaped like the `SuperAdminApiError` `saFetch` throws for a pin refusal. */
  const refusal = (status: number, body: Record<string, unknown>) =>
    Object.assign(new Error(String(body['message'] ?? 'server words')), { statusCode: status, details: { error: 'Conflict', message: 'server words', ...body } });

  async function refusedWith(err: unknown) {
    mocks.pinPhoneNumber.mockRejectedValue(err);
    const scope = await openDialog();
    await waitFor(() => expect((scope.getByLabelText('Account') as HTMLSelectElement).options).toHaveLength(3));
    fireEvent.change(scope.getByLabelText('Account'), { target: { value: 'cred-vl' } });
    fireEvent.click(scope.getByRole('button', { name: 'Move number' }));
    return within(await scope.findByTestId('pin-error'));
  }

  it('names the campaigns in the way as “name (tenant / account, status)”, and how many more', async () => {
    const error = await refusedWith(refusal(409, {
      code: 'phone_number_in_use', campaigns_total: 7,
      campaigns: [
        { campaign_id: 'c1', campaign_name: 'Collections', status: 'running', tenant_name: 'Acme', account_name: 'North' },
        { campaign_id: 'c2', campaign_name: 'Renewals', status: 'paused', tenant_name: 'Zen', account_name: null },
      ],
    }));
    expect(error.getByText('Campaigns on the service’s own account still use this number as a caller ID. Remove it from them, or stop them, then move it.')).toBeTruthy();
    expect(error.getAllByRole('listitem').map(li => li.textContent)).toEqual([
      'Collections (Acme / North, running)',
      'Renewals (Zen / account removed, paused)',
      'and 5 more',
    ]);
    expect(error.queryByText('server words')).toBeNull();
  });

  it.each([
    [1, 'This number is assigned to another tenant. Unassign it from that tenant first, then move it.'],
    [3, 'This number is assigned to 3 other tenants. Unassign it from them first, then move it.'],
  ])('says to unassign it from the other tenant(s) first (%i)', async (tenantCount, copy) => {
    const error = await refusedWith(refusal(409, { code: 'phone_number_assigned_elsewhere', tenant_count: tenantCount }));
    expect(error.getByText(copy)).toBeTruthy();
  });

  it.each([
    ['phone_number_not_found', 404, 'This number no longer exists. Refresh the list.'],
    ['phone_number_not_active', 409, 'Only an active number can be moved. Reactivate it first.'],
    ['phone_number_already_pinned', 409, 'This number is already on a tenant’s own carrier account, and that never changes.'],
    ['carrier_numbers_not_pinned_by_hand', 409, 'Numbers on this carrier cannot be moved by hand: a tenant’s numbers on it come from Sync numbers on its credential.'],
  ])('says %s in words', async (code, status, copy) => {
    const error = await refusedWith(refusal(status, { code }));
    expect(error.getByText(copy)).toBeTruthy();
  });

  it.each([
    ['telephony_credential_not_found', 404, 'That carrier account no longer exists on this carrier. Pick another account.'],
    ['telephony_credential_not_active', 409, 'That carrier account is not active, so a number cannot be moved onto it. Enable or verify it under Telephony credentials, then try again.'],
  ])('says %s in words and reloads the accounts', async (code, status, copy) => {
    mocks.pinPhoneNumber.mockRejectedValue(refusal(status, { code }));
    const scope = await openDialog();
    await waitFor(() => expect((scope.getByLabelText('Account') as HTMLSelectElement).options).toHaveLength(3));
    fireEvent.change(scope.getByLabelText('Account'), { target: { value: 'cred-vl' } });
    const loads = mocks.listTelephonyCredentials.mock.calls.length;
    fireEvent.click(scope.getByRole('button', { name: 'Move number' }));
    expect(within(await scope.findByTestId('pin-error')).getByText(copy)).toBeTruthy();
    expect(mocks.listTelephonyCredentials.mock.calls.length).toBe(loads + 1);
  });

  it('shows the server’s sentence for a refusal without a known code', async () => {
    const error = await refusedWith(Object.assign(new Error('telephony_credential_id must be a UUID'), { statusCode: 400, details: { error: 'Bad Request', message: 'telephony_credential_id must be a UUID' } }));
    expect(error.getByText('telephony_credential_id must be a UUID')).toBeTruthy();
  });

  it('says so when no tenant has an active account on the carrier', async () => {
    mocks.listTelephonyCredentials.mockResolvedValue([]);
    const scope = await openDialog();
    expect((await scope.findByTestId('pin-accounts-none')).textContent)
      .toBe('No tenant has an active Swar (VoiceLink) account. Add one under Telephony credentials first.');
  });
});
