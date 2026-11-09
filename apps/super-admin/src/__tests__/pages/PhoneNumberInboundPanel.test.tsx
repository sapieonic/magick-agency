import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';
import type { PhoneNumberInboundResponse } from '@magick-agency/contracts/api/platform/super-admin-inbound';

const mocks = vi.hoisted(() => ({
  getPhoneNumberInbound: vi.fn(),
  linkPhoneNumberInbound: vi.fn(),
  unlinkPhoneNumberInbound: vi.fn(),
}));
vi.mock('../../api/super-admin', () => ({ ...mocks }));

import { PhoneNumberInboundPanel } from '../../pages/super-admin/phone-numbers/PhoneNumberInboundPanel';

const BASE: PhoneNumberInboundResponse = {
  phone_number_id: 'pn-1', phone_number: '+14155550101',
  link: { linked: false, linked_at: null, previous_app_id: null, route: null },
  credential: { id: 'cred-1', label: 'Acme main', status: 'active', inbound_enabled: true },
  link_blocker: null,
  unrouted_missed: { open: 0, latest_at: null, latest_from: null },
};
const LINKED: PhoneNumberInboundResponse = {
  ...BASE,
  link: { linked: true, linked_at: '2026-11-09T10:05:00Z', previous_app_id: '18000000000000001', route: { id: 'r-1', name: 'Main line', account_id: 'a-1' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getPhoneNumberInbound.mockResolvedValue(BASE);
});
afterEach(() => cleanup());

const panel = (onChanged = vi.fn()) => render(<PhoneNumberInboundPanel phoneNumberId="pn-1" provider="plivo" onChanged={onChanged} />);

describe('PhoneNumberInboundPanel', () => {
  it('links after a confirmation that says the current app is remembered, then tells the page', async () => {
    const onChanged = vi.fn();
    mocks.linkPhoneNumberInbound.mockResolvedValue(LINKED);
    panel(onChanged);
    expect(await screen.findByText('Not linked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Link to inbound/ }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/remembered, so Unlink can put it back/)).toBeTruthy();
    // M7: until a route takes the number, its callers hear the closed message; the operator is told before linking.
    expect(within(dialog).getByText(/Until an account admin adds it to an inbound route, callers hear the closed message/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Link' }));
    await waitFor(() => expect(mocks.linkPhoneNumberInbound).toHaveBeenCalledWith('pn-1'));
    expect(await screen.findByText('Linked')).toBeTruthy();
    expect(screen.getByText('Main line')).toBeTruthy();
    expect(screen.getByText(/Unlink puts it back on Pravah \(Plivo\) app 18000000000000001/)).toBeTruthy();
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('unlinks after a confirmation', async () => {
    mocks.getPhoneNumberInbound.mockResolvedValue(LINKED);
    mocks.unlinkPhoneNumberInbound.mockResolvedValue(BASE);
    panel();
    fireEvent.click(await screen.findByRole('button', { name: /Unlink from inbound/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Unlink' }));
    await waitFor(() => expect(mocks.unlinkPhoneNumberInbound).toHaveBeenCalledWith('pn-1'));
    expect(await screen.findByText('Not linked')).toBeTruthy();
  });

  it.each([
    ['inbound_not_enabled', /enable them on the Telephony Credentials page first/],
    ['not_assigned', /not assigned to its carrier account’s tenant/],
    ['credential_not_active', /credential is not active/],
  ] as const)('says why it cannot be linked (%s) and offers no Link', async (blocker, text) => {
    mocks.getPhoneNumberInbound.mockResolvedValue({ ...BASE, link_blocker: blocker });
    panel();
    expect(await screen.findByText(text)).toBeTruthy();
    expect((screen.getByRole('button', { name: /Link to inbound/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows nothing for a number on the service`s own carrier account', async () => {
    mocks.getPhoneNumberInbound.mockResolvedValue({ ...BASE, credential: null, link_blocker: 'not_synced' });
    panel();
    await waitFor(() => expect(mocks.getPhoneNumberInbound).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId('number-inbound')).toBeNull());
  });

  it('a carrier refusal changes nothing and says what to do', async () => {
    const onChanged = vi.fn();
    mocks.linkPhoneNumberInbound.mockRejectedValue(Object.assign(new Error('x'), { details: { error: 'carrier_number_missing' } }));
    panel(onChanged);
    fireEvent.click(await screen.findByRole('button', { name: /Link to inbound/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Link' }));
    expect((await screen.findByTestId('number-inbound-error')).textContent).toMatch(/no longer has this number.*Sync the credential’s numbers/);
    expect(onChanged).not.toHaveBeenCalled();
    expect(screen.getByText('Not linked')).toBeTruthy();
  });

  it('a linked number no route answers says its callers hear the closed message', async () => {
    mocks.getPhoneNumberInbound.mockResolvedValue({ ...LINKED, link: { ...LINKED.link, route: null } });
    panel();
    expect((await screen.findByTestId('number-inbound-no-route')).textContent).toMatch(/callers hear the closed message/);
  });

  it('shows the number`s Missed calls that reached no account: how many, and the latest', async () => {
    mocks.getPhoneNumberInbound.mockResolvedValue({ ...LINKED, unrouted_missed: { open: 3, latest_at: '2026-11-08T10:00:00Z', latest_from: null } });
    panel();
    const line = await screen.findByTestId('number-inbound-unrouted');
    expect(line.textContent).toMatch(/3 missed calls reached no account/);
    expect(line.textContent).toMatch(/from a withheld number/);
    cleanup();
    mocks.getPhoneNumberInbound.mockResolvedValue({ ...LINKED, unrouted_missed: { open: 1, latest_at: '2026-11-08T10:00:00Z', latest_from: '+447700900123' } });
    panel();
    expect((await screen.findByTestId('number-inbound-unrouted')).textContent).toMatch(/1 missed call reached no account.*from \+447700900123/);
    cleanup();
    mocks.getPhoneNumberInbound.mockResolvedValue(LINKED);
    panel();
    expect(await screen.findByText('Linked')).toBeTruthy();
    expect(screen.queryByTestId('number-inbound-unrouted')).toBeNull();
  });
});
