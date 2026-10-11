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
    expect(screen.getByText('Plivo')).toBeTruthy();
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
