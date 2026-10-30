import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

/**
 * The Members tab's add-user flow: what the super admin is told about the
 * invitation email once the modal closes.
 *
 * `POST /super-admin/tenants/:id/users` issues the invitation and answers
 * `invite_email`. Before, it answered `{ membership }` only and the tab said
 * nothing, so a person added on a server with no mail transport was never told
 * and the super admin could not know. The three answers are the server's
 * (sent / not sent with a reason) and an older server's (absent).
 */

const mocks = vi.hoisted(() => ({ addUserToTenant: vi.fn(), reload: vi.fn() }));

vi.mock('../../api/super-admin', () => ({
  addUserToTenant: mocks.addUserToTenant,
  changeMembershipRole: vi.fn(),
  revokeMembership: vi.fn(),
}));

import { TenantMembersTab } from '../../pages/super-admin/tenant-detail/TenantMembersTab';

const MEMBERSHIP = { id: 'm-1', tenant_id: 't-1', user_id: 'u-1', role: 'operator', status: 'active' };

async function addOperator() {
  render(
    <TenantMembersTab
      tenantId="t-1"
      tenantName="Acme"
      members={[]}
      accounts={[]}
      refreshError={null}
      reload={mocks.reload}
    />,
  );
  fireEvent.click(screen.getAllByRole('button', { name: /add user/i })[0]!);
  fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'pat@acme.test' } });
  fireEvent.change(screen.getByLabelText('Role'), { target: { value: 'operator' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add User' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reload.mockResolvedValue(undefined);
});
afterEach(() => cleanup());

describe('adding a user', () => {
  it('says the invitation email was sent when the server sent it', async () => {
    mocks.addUserToTenant.mockResolvedValue({ membership: MEMBERSHIP, invite_email: { sent: true } });
    await addOperator();

    const note = await screen.findByRole('status');
    expect(note.textContent).toBe('Added pat@acme.test as Operator. The invitation email was sent.');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mocks.addUserToTenant).toHaveBeenCalledWith('t-1', { email: 'pat@acme.test', role: 'operator', name: undefined });
  });

  it('warns that the person was added but not emailed when the send failed', async () => {
    mocks.addUserToTenant.mockResolvedValue({
      membership: MEMBERSHIP, invite_email: { sent: false, reason: 'failed' },
    });
    await addOperator();

    const warning = await screen.findByRole('alert');
    expect(warning.textContent).toBe(
      'Added pat@acme.test as Operator, but the invitation email was not sent '
      + '(the mail provider did not accept it). pat@acme.test has not been told they were added.',
    );
    // The add succeeded: the modal closed and no success note claims the mail went.
    expect(screen.queryByRole('button', { name: 'Add User' })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('names a missing mail configuration as the reason', async () => {
    mocks.addUserToTenant.mockResolvedValue({
      membership: MEMBERSHIP, invite_email: { sent: false, reason: 'not_configured' },
    });
    await addOperator();

    expect((await screen.findByRole('alert')).textContent).toMatch(/email is not configured on the server/);
  });

  it('says only that the user was added when an older server answers no invite_email', async () => {
    mocks.addUserToTenant.mockResolvedValue({ membership: MEMBERSHIP });
    await addOperator();

    const note = await screen.findByRole('status');
    expect(note.textContent).toBe('Added pat@acme.test as Operator.');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
