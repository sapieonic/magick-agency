import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { TelephonyCredential } from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';

const mocks = vi.hoisted(() => ({
  listTelephonyCredentials: vi.fn(),
  listTelephonyCredentialProviders: vi.fn(),
  getTelephonyCredential: vi.fn(),
  createTelephonyCredential: vi.fn(),
  renameTelephonyCredential: vi.fn(),
  rotateTelephonyCredentialSecret: vi.fn(),
  verifyTelephonyCredential: vi.fn(),
  disableTelephonyCredential: vi.fn(),
  enableTelephonyCredential: vi.fn(),
  revokeTelephonyCredential: vi.fn(),
  syncTelephonyCredentialNumbers: vi.fn(),
  listTenants: vi.fn(),
}));

vi.mock('../../api/super-admin', () => ({ ...mocks }));

import SATelephonyCredentialsPage from '../../pages/super-admin/SATelephonyCredentialsPage';

const TENANT = { id: '11111111-1111-4111-8111-111111111111', name: 'Acme', slug: 'acme' };

function makeCred(over: Partial<TelephonyCredential> = {}): TelephonyCredential {
  return {
    id: 'cred-1', tenant_id: TENANT.id, provider: 'plivo', label: 'Acme main', status: 'active',
    account_ref: 'MAXXXXXXXXXXXXXXXXXX', public_config: { auth_id: 'MAXXXXXXXXXXXXXXXXXX' },
    secret_version: 2, secret_hint: 'ab12', verified_at: '2026-10-10T00:00:00Z', last_error: null,
    created_by: null, updated_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-10T00:00:00Z',
    revoked_at: null, shredded_at: null, ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.listTenants.mockResolvedValue({ tenants: [TENANT] });
  mocks.listTelephonyCredentials.mockResolvedValue([makeCred()]);
  mocks.listTelephonyCredentialProviders.mockResolvedValue({
    store_available: true,
    providers: [{
      provider: 'plivo', display_name: 'Plivo',
      fields: [
        { key: 'auth_id', label: 'Auth ID', secret: false },
        { key: 'auth_token', label: 'Auth Token', secret: true },
      ],
    }],
  });
  mocks.getTelephonyCredential.mockResolvedValue({ credential: makeCred(), usage: { campaigns: 1, in_flight_calls: 0 } });
  mocks.createTelephonyCredential.mockResolvedValue(makeCred({ id: 'cred-2' }));
  mocks.rotateTelephonyCredentialSecret.mockResolvedValue(makeCred({ secret_version: 3, secret_hint: 'zz99' }));
  mocks.disableTelephonyCredential.mockResolvedValue(makeCred({ status: 'disabled' }));
  mocks.revokeTelephonyCredential.mockResolvedValue(makeCred({ status: 'revoked', revoked_at: '2026-10-11T00:00:00Z' }));
});
afterEach(() => cleanup());

describe('SATelephonyCredentialsPage', () => {
  it('lists credentials with the tenant name and only a four-character hint of the secret', async () => {
    render(<SATelephonyCredentialsPage />);
    expect(await screen.findByText('Acme main')).toBeTruthy();
    expect(await screen.findByText('Acme')).toBeTruthy();
    expect(screen.getByText('••••ab12')).toBeTruthy();
    // PL16: the alias, then the vendor operators need to find the account in its own console.
    expect(screen.getByText('Pravah (Plivo)')).toBeTruthy();
  });

  it('renders the secret field as a password input and sends the provider fields on create', async () => {
    mocks.listTelephonyCredentials.mockResolvedValue([]);
    render(<SATelephonyCredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add credential/i }));

    // Pick the tenant through the combobox.
    const picker = screen.getByLabelText('Tenant');
    fireEvent.focus(picker);
    fireEvent.change(picker, { target: { value: 'Acme' } });
    fireEvent.click(await screen.findByRole('option', { name: /Acme/ }));

    fireEvent.change(screen.getByLabelText('Label'), { target: { value: 'Acme main' } });
    fireEvent.change(screen.getByLabelText('Auth ID'), { target: { value: 'MAXXXXXXXXXXXXXXXXXX' } });
    const token = screen.getByLabelText('Auth Token') as HTMLInputElement;
    expect(token.type).toBe('password');
    fireEvent.change(token, { target: { value: 'secret-token-value-123' } });
    fireEvent.click(screen.getByRole('button', { name: /verify and save/i }));

    await waitFor(() => expect(mocks.createTelephonyCredential).toHaveBeenCalledWith({
      tenant_id: TENANT.id, provider: 'plivo', label: 'Acme main',
      fields: { auth_id: 'MAXXXXXXXXXXXXXXXXXX', auth_token: 'secret-token-value-123' },
    }));
    // The typed secret is not left on screen.
    await waitFor(() => expect(screen.queryByDisplayValue('secret-token-value-123')).toBeNull());
  });

  it('shows usage only for the row it was fetched for', async () => {
    let answerFirst!: (v: unknown) => void;
    mocks.listTelephonyCredentials.mockResolvedValue([makeCred(), makeCred({ id: 'cred-2', label: 'Acme backup', account_ref: 'MAYYYYYYYYYYYYYYYYYY' })]);
    mocks.getTelephonyCredential
      .mockImplementationOnce(() => new Promise((r) => { answerFirst = r; }))
      .mockResolvedValueOnce({ credential: makeCred({ id: 'cred-2' }), usage: { campaigns: 0, in_flight_calls: 0 } });
    render(<SATelephonyCredentialsPage />);
    fireEvent.click(await screen.findByText('Acme main'));
    fireEvent.click(await screen.findByText('Acme backup'));
    await waitFor(() => expect(mocks.getTelephonyCredential).toHaveBeenCalledTimes(2));
    answerFirst({ credential: makeCred(), usage: { campaigns: 7, in_flight_calls: 0 } });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('7')).toBeNull();
  });

  it('rotates with only the secret fields and the version the form was opened at', async () => {
    render(<SATelephonyCredentialsPage />);
    fireEvent.click(await screen.findByText('Acme main'));
    fireEvent.click(await screen.findByRole('button', { name: /rotate secret/i }));
    expect(screen.queryByLabelText(/Auth ID/)).toBeNull();
    fireEvent.change(screen.getByLabelText('New Auth Token'), { target: { value: 'new-secret-token-456' } });
    fireEvent.click(screen.getByRole('button', { name: /verify and rotate/i }));
    await waitFor(() => expect(mocks.rotateTelephonyCredentialSecret).toHaveBeenCalledWith('cred-1', {
      fields: { auth_token: 'new-secret-token-456' }, expected_version: 2,
    }));
    expect(await screen.findByText('••••zz99')).toBeTruthy();
  });

  it('shows usage on expand and asks before revoking', async () => {
    render(<SATelephonyCredentialsPage />);
    fireEvent.click(await screen.findByText('Acme main'));
    await waitFor(() => expect(mocks.getTelephonyCredential).toHaveBeenCalledWith('cred-1'));
    fireEvent.click(await screen.findByRole('button', { name: /^revoke$/i }));
    expect(mocks.revokeTelephonyCredential).not.toHaveBeenCalled();
    expect(await screen.findByText(/stops dialling for good/)).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: /^revoke$/i });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(mocks.revokeTelephonyCredential).toHaveBeenCalledWith('cred-1'));
    await waitFor(() => expect(screen.queryByText('Acme main')).toBeNull());
  });

  it('expands a row from its label button, which reports aria-expanded (keyboard reachable)', async () => {
    render(<SATelephonyCredentialsPage />);
    const toggle = await screen.findByRole('button', { name: /acme main/i });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('true'));
    // One toggle per activation: the row's own click handler must not undo it.
    expect(mocks.getTelephonyCredential).toHaveBeenCalledTimes(1);
    expect(document.getElementById(toggle.getAttribute('aria-controls')!)).toBeTruthy();
    expect(await screen.findByRole('button', { name: /^revoke$/i })).toBeTruthy();
  });

  it('shows the rows of the latest filter when an earlier load answers last', async () => {
    render(<SATelephonyCredentialsPage />);
    expect(await screen.findByText('Acme main')).toBeTruthy();
    let answerSlow!: (rows: TelephonyCredential[]) => void;
    mocks.listTelephonyCredentials
      .mockImplementationOnce(() => new Promise<TelephonyCredential[]>((r) => { answerSlow = r; }))
      .mockResolvedValueOnce([makeCred({ label: 'Latest filter row' })]);
    const showRevoked = screen.getByRole('checkbox', { name: /show revoked/i });
    fireEvent.click(showRevoked); // load 2: slow
    fireEvent.click(showRevoked); // load 3: answers first
    expect(await screen.findByText('Latest filter row')).toBeTruthy();
    answerSlow([makeCred({ id: 'cred-r', label: 'Superseded row', status: 'revoked' })]);
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByText('Superseded row')).toBeNull();
    expect(screen.getByText('Latest filter row')).toBeTruthy();
  });

  it('refuses to add a credential when the server has no keyring', async () => {
    mocks.listTelephonyCredentialProviders.mockResolvedValue({ store_available: false, providers: [] });
    render(<SATelephonyCredentialsPage />);
    expect(await screen.findByText(/no credential keyring/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: /add credential/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('Sync numbers', () => {
  /** Shaped like the `SuperAdminApiError` `saFetch` throws. */
  function saError(statusCode: number, code: string, message = 'server words') {
    return Object.assign(new Error(message), { statusCode, details: { error: code, message } });
  }

  async function openRow() {
    render(<SATelephonyCredentialsPage />);
    fireEvent.click(await screen.findByText('Acme main'));
  }

  it('syncs an active credential and reads out what changed, reasons included', async () => {
    mocks.syncTelephonyCredentialNumbers.mockResolvedValue({
      credential: makeCred({ verified_at: '2026-10-12T00:00:00Z' }),
      sync: {
        listed: 7,
        added: ['+14155550101', '+14155550102'],
        reactivated: ['+14155550103'],
        taken_over: ['+14155550110'],
        unchanged: ['+14155550104'],
        retired: ['+14155550199'],
        skipped: [
          { number: '14155550105', reason: 'not_voice' }, { number: 'abc', reason: 'invalid_number' },
          { number: '14155550108', reason: 'other_account' },
        ],
        conflicts: [
          { phone_number: '+14155550106', reason: 'registered_elsewhere' },
          { phone_number: '+14155550107', reason: 'deleted' },
        ],
        active_numbers: 4,
        campaigns_holding_retired: [{
          campaign_id: 'camp-1', campaign_name: 'Collections', account_id: 'acct-1', account_name: 'North',
          status: 'running', retired_caller_ids: ['+14155550199'],
        }],
      },
    });
    await openRow();
    fireEvent.click(await screen.findByRole('button', { name: /sync numbers/i }));
    await waitFor(() => expect(mocks.syncTelephonyCredentialNumbers).toHaveBeenCalledWith('cred-1'));

    const result = await screen.findByTestId('sync-result');
    expect(result.textContent).toContain(
      'Synced. 4 active numbers on this account (the carrier listed 7): 2 added, 1 reactivated, 1 taken over, 1 retired, 1 unchanged.',
    );
    // A number moved from a revoked registration of the same account, listed by name.
    expect(result.textContent).toContain('Taken over from a revoked credential of this account+14155550110');
    expect(result.textContent).toContain('+14155550101, +14155550102');
    expect(result.textContent).toContain('+14155550199');
    expect(result.textContent).toContain('14155550105: cannot carry voice calls');
    expect(result.textContent).toContain('abc: not a valid phone number');
    expect(result.textContent).toContain('14155550108: transferred to another account (a subaccount); never taken into this one');
    expect(result.textContent).toContain('+14155550106: already in the inventory on another carrier account');
    expect(result.textContent).toContain('+14155550107: deleted from the inventory; a sync does not bring it back');
    // The campaigns that still name a retired number, so the operator can tell the tenant (PL13).
    const holding = screen.getByTestId('sync-campaigns-holding-retired');
    expect(holding.textContent).toContain('Tell the tenant to replace them');
    expect(holding.textContent).toContain('Collections (North, running): +14155550199');
  });

  it.each([
    ['credential_not_active', 409, /Only an active credential can sync its numbers/],
    ['too_many_numbers', 422, /more numbers than one sync can read, so nothing was changed/],
    ['carrier_rejected', 400, /carrier refused the stored credentials/],
    ['carrier_unreachable', 502, /carrier could not be reached/],
  ])('says what to do when the sync is refused with %s', async (code, status, copy) => {
    mocks.syncTelephonyCredentialNumbers.mockRejectedValue(saError(status, code));
    await openRow();
    fireEvent.click(await screen.findByRole('button', { name: /sync numbers/i }));
    const alert = await screen.findByTestId('sync-error');
    expect(alert.textContent).toMatch(copy);
    expect(screen.queryByTestId('sync-result')).toBeNull();
  });

  it('shows the server’s message for any other refusal', async () => {
    mocks.syncTelephonyCredentialNumbers.mockRejectedValue(saError(503, 'credential_store_unavailable', 'The credential store is unavailable.'));
    await openRow();
    fireEvent.click(await screen.findByRole('button', { name: /sync numbers/i }));
    expect((await screen.findByTestId('sync-error')).textContent).toBe('The credential store is unavailable.');
  });

  it('is offered only on an active credential', async () => {
    mocks.listTelephonyCredentials.mockResolvedValue([makeCred({ status: 'disabled' })]);
    await openRow();
    expect(await screen.findByRole('button', { name: /verify now/i })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /sync numbers/i })).toBeNull();
  });
});

describe('what the page says while an action runs, and before one', () => {
  it('Verify says it is verifying and never relabels Sync numbers "Syncing…"', async () => {
    let answer!: (v: TelephonyCredential) => void;
    mocks.verifyTelephonyCredential.mockImplementation(() => new Promise((r) => { answer = r; }));
    render(<SATelephonyCredentialsPage />);
    fireEvent.click(await screen.findByText('Acme main'));
    fireEvent.click(await screen.findByRole('button', { name: /verify now/i }));
    expect(await screen.findByRole('button', { name: /verifying…/i })).toBeTruthy();
    const sync = screen.getByRole('button', { name: /sync numbers/i }) as HTMLButtonElement;
    expect(sync.textContent).not.toMatch(/Syncing/);
    // Every action on the row waits while one runs.
    expect(sync.disabled).toBe(true);
    answer(makeCred());
    await waitFor(() => expect(screen.getByRole('button', { name: /verify now/i })).toBeTruthy());
  });

  it('Enable relabels neither Verify nor anything else', async () => {
    mocks.listTelephonyCredentials.mockResolvedValue([makeCred({ status: 'disabled' })]);
    let answer!: (v: TelephonyCredential) => void;
    mocks.enableTelephonyCredential.mockImplementation(() => new Promise((r) => { answer = r; }));
    render(<SATelephonyCredentialsPage />);
    fireEvent.click(await screen.findByText('Acme main'));
    fireEvent.click(await screen.findByRole('button', { name: /^enable$/i }));
    await waitFor(() => expect(mocks.enableTelephonyCredential).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: /verify now/i })).toBeTruthy();
    expect(screen.queryByText(/Syncing|Verifying/)).toBeNull();
    answer(makeCred());
  });

  it('the disable confirmation says running campaigns pause and a supervisor resumes them', async () => {
    render(<SATelephonyCredentialsPage />);
    fireEvent.click(await screen.findByText('Acme main'));
    fireEvent.click(await screen.findByRole('button', { name: /^disable$/i }));
    expect(await screen.findByText(/Running campaigns on it pause automatically, and stay paused after you enable it again until a supervisor resumes each one\./)).toBeTruthy();
  });

  it('the usage count does not call a draft "dialling"', async () => {
    render(<SATelephonyCredentialsPage />);
    fireEvent.click(await screen.findByText('Acme main'));
    expect(await screen.findByText('Campaigns using it (not finished)')).toBeTruthy();
    expect(screen.queryByText(/Campaigns dialling/)).toBeNull();
  });

  it('the empty state no longer says the dial path has not shipped', async () => {
    mocks.listTelephonyCredentials.mockResolvedValue([]);
    render(<SATelephonyCredentialsPage />);
    expect(await screen.findByText(/Sync its numbers, then the tenant’s campaigns and soft phone can dial on it\./)).toBeTruthy();
    expect(screen.queryByText(/dial path ships/)).toBeNull();
  });

  it('names the carrier as alias (vendor) in the picker; our own placeholder names no vendor (PL16)', async () => {
    render(<SATelephonyCredentialsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add credential/i }));
    expect(screen.getByRole('option', { name: 'Pravah (Plivo)' })).toBeTruthy();
    expect((screen.getByLabelText('Label') as HTMLInputElement).placeholder).toBe('e.g. Acme main account');
  });
});
