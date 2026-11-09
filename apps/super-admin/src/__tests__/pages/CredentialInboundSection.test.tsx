import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import type { TelephonyCredential } from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';
import type { TelephonyCredentialInboundResponse } from '@magick-agency/contracts/api/platform/super-admin-inbound';

const mocks = vi.hoisted(() => ({
  getCredentialInbound: vi.fn(),
  enableCredentialInbound: vi.fn(),
  disableCredentialInbound: vi.fn(),
  repointCredentialInbound: vi.fn(),
  checkCredentialInboundHealth: vi.fn(),
}));
vi.mock('../../api/super-admin', () => ({ ...mocks }));

import { CredentialInboundSection } from '../../pages/super-admin/telephony-credentials/CredentialInboundSection';

const CRED: TelephonyCredential = {
  id: 'cred-1', tenant_id: 't-1', provider: 'plivo', label: 'Acme main', status: 'active',
  account_ref: 'MAXXXXXXXXXXXXXXXXXX', public_config: {}, secret_version: 1, secret_hint: 'ab12', verified_at: null,
  last_error: null, created_by: null, updated_by: null, created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z',
  revoked_at: null, shredded_at: null,
};

const OFF: TelephonyCredentialInboundResponse = {
  inbound: { enabled: false, app_id: null, enabled_at: null, linked_numbers: 0, previous_token_expires_at: null },
  webhook_base_configured: true,
  connects_agents: true,
  numbers: [{
    phone_number_id: 'pn-1', phone_number: '+14155550101', status: 'active', assigned: true,
    link: { linked: false, linked_at: null, previous_app_id: null, route: null },
  }],
};
const ON = (linked = 0): TelephonyCredentialInboundResponse => ({
  inbound: { enabled: true, app_id: '20372631212782780', enabled_at: '2026-11-09T10:00:00Z', linked_numbers: linked, previous_token_expires_at: null },
  webhook_base_configured: true,
  connects_agents: true,
  numbers: [{
    phone_number_id: 'pn-1', phone_number: '+14155550101', status: 'active', assigned: true,
    link: linked
      ? { linked: true, linked_at: '2026-11-09T10:05:00Z', previous_app_id: '18000000000000001', route: { id: 'r-1', name: 'Main line', account_id: 'a-1' } }
      : { linked: false, linked_at: null, previous_app_id: null, route: null },
  }],
});

const refusal = (error: string, message = 'server says no') => Object.assign(new Error(message), { details: { error, message } });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getCredentialInbound.mockResolvedValue(OFF);
});
afterEach(() => cleanup());

async function confirmDialog(label: string) {
  const dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: label }));
}

describe('CredentialInboundSection', () => {
  it('shows inbound not enabled with the credential`s numbers, and enables it after a confirmation', async () => {
    render(<CredentialInboundSection credential={CRED} />);
    expect(await screen.findByText('Not enabled')).toBeTruthy();
    expect(screen.getByText('+14155550101')).toBeTruthy();
    mocks.enableCredentialInbound.mockResolvedValue(ON());
    fireEvent.click(screen.getByRole('button', { name: /Enable inbound/ }));
    // The dialog names the carrier as operators know it (PL16).
    expect(within(await screen.findByRole('dialog')).getByText(/Pravah \(Plivo\) account/)).toBeTruthy();
    await confirmDialog('Enable inbound');
    await waitFor(() => expect(mocks.enableCredentialInbound).toHaveBeenCalledWith('cred-1'));
    expect(await screen.findByText('Enabled')).toBeTruthy();
    expect(screen.getByText('20372631212782780')).toBeTruthy();
  });

  it('cannot enable on a credential that is not active, or with no callback address', async () => {
    const { unmount } = render(<CredentialInboundSection credential={{ ...CRED, status: 'disabled' }} />);
    expect((await screen.findByRole('button', { name: /Enable inbound/ }) as HTMLButtonElement).disabled).toBe(true);
    unmount();
    mocks.getCredentialInbound.mockResolvedValue({ ...OFF, webhook_base_configured: false });
    render(<CredentialInboundSection credential={CRED} />);
    expect(await screen.findByText(/no public callback address/)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Enable inbound/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Disable is offered only once no number is linked; the linked number shows its route', async () => {
    mocks.getCredentialInbound.mockResolvedValue(ON(1));
    render(<CredentialInboundSection credential={CRED} />);
    const disable = await screen.findByRole('button', { name: /Disable inbound/ }) as HTMLButtonElement;
    expect(disable.disabled).toBe(true);
    expect(disable.title).toBe('Unlink every number first');
    expect(screen.getByText('Linked')).toBeTruthy();
    expect(screen.getByText(/Main line/)).toBeTruthy();
  });

  it('disables after a confirmation', async () => {
    mocks.getCredentialInbound.mockResolvedValue(ON(0));
    mocks.disableCredentialInbound.mockResolvedValue(OFF);
    render(<CredentialInboundSection credential={CRED} />);
    fireEvent.click(await screen.findByRole('button', { name: /Disable inbound/ }));
    await confirmDialog('Disable inbound');
    await waitFor(() => expect(mocks.disableCredentialInbound).toHaveBeenCalledWith('cred-1'));
    expect(await screen.findByText('Not enabled')).toBeTruthy();
  });

  it.each([
    ['ok', [], true, /Healthy/],
    ['url_mismatch', ['answer_url', 'hangup_url'], true, /answer URL, hangup URL were changed in Pravah \(Plivo\)\. Re-point/],
    ['app_missing', [], true, /no longer has this Application/],
    ['unreachable', [], true, /could not be reached/],
    ['ok', [], false, /callback URLs have changed since.*Re-point/],
  ])('Check health %s (%j, stored URLs current: %s) says what to do', async (health, mismatched, current, text) => {
    mocks.getCredentialInbound.mockResolvedValue(ON(0));
    mocks.checkCredentialInboundHealth.mockResolvedValue({
      inbound: ON(0).inbound, health: { health, mismatched, stored_urls_current: current, checked_at: '2026-11-09T10:10:00Z' },
    });
    render(<CredentialInboundSection credential={CRED} />);
    fireEvent.click(await screen.findByRole('button', { name: /Check health/ }));
    expect((await screen.findByTestId('inbound-health')).textContent).toMatch(text);
  });

  it('re-points after a confirmation', async () => {
    mocks.getCredentialInbound.mockResolvedValue(ON(1));
    mocks.repointCredentialInbound.mockResolvedValue({ ...ON(1), inbound: { ...ON(1).inbound, previous_token_expires_at: '2099-01-01T00:00:00Z' } });
    render(<CredentialInboundSection credential={CRED} />);
    fireEvent.click(await screen.findByRole('button', { name: /Re-point/ }));
    await confirmDialog('Re-point');
    await waitFor(() => expect(mocks.repointCredentialInbound).toHaveBeenCalledWith('cred-1'));
    expect(await screen.findByText('Previous token accepted until')).toBeTruthy();
  });

  it.each([
    ['inbound_unconfigured', /no public callback address/],
    ['carrier_unreachable', /could not be reached\. Nothing was changed/],
    ['something_else', /server says no/],
  ])('a refusal %s is said in words an operator can act on', async (code, text) => {
    mocks.enableCredentialInbound.mockRejectedValue(refusal(code));
    render(<CredentialInboundSection credential={CRED} />);
    fireEvent.click(await screen.findByRole('button', { name: /Enable inbound/ }));
    await confirmDialog('Enable inbound');
    expect((await screen.findByTestId('inbound-error')).textContent).toMatch(text);
  });

  it('says plainly when this deployment cannot put callers through to agents (media workers on), only with inbound enabled', async () => {
    mocks.getCredentialInbound.mockResolvedValue({ ...ON(1), connects_agents: false });
    render(<CredentialInboundSection credential={CRED} />);
    expect((await screen.findByTestId('inbound-no-connect')).textContent).toMatch(/Calls can’t be put through to agents: media workers are on/);
    cleanup();
    mocks.getCredentialInbound.mockResolvedValue(ON(1));
    render(<CredentialInboundSection credential={CRED} />);
    expect(await screen.findByText('Enabled')).toBeTruthy();
    expect(screen.queryByTestId('inbound-no-connect')).toBeNull();
    cleanup();
    mocks.getCredentialInbound.mockResolvedValue({ ...OFF, connects_agents: false });
    render(<CredentialInboundSection credential={CRED} />);
    expect(await screen.findByText('Not enabled')).toBeTruthy();
    expect(screen.queryByTestId('inbound-no-connect')).toBeNull();
  });

  it('marks a linked number no route answers', async () => {
    const on = ON(1);
    on.numbers[0]!.link = { ...on.numbers[0]!.link, route: null };
    mocks.getCredentialInbound.mockResolvedValue(on);
    render(<CredentialInboundSection credential={CRED} />);
    expect(await screen.findByText('no route: callers hear the closed message')).toBeTruthy();
  });
});
