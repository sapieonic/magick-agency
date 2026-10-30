import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The tenants list's create flow: what the super admin is told about the new
 * owner's invitation once the modal closes.
 *
 * `POST /super-admin/tenants` creates the owner's membership and invites them,
 * and answers `invite_email`. The modal promised "invites its owner" while the
 * server issued nothing; now that it does, the page must say whether the mail
 * went — and must not claim either outcome against a server that does not say.
 */

const mocks = vi.hoisted(() => ({
  createTenant: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('../../hooks/useSuperAdminTenants', () => ({
  useSuperAdminTenants: () => ({ tenants: [], loading: false, error: null, reload: mocks.reload }),
}));
vi.mock('../../api/super-admin', () => ({ createTenant: mocks.createTenant }));

import SATenantsPage from '../../pages/super-admin/SATenantsPage';

const TENANT = { id: 't-new', name: 'Fresh Start', slug: 'fresh-start', status: 'active' };

async function create() {
  render(<MemoryRouter><SATenantsPage /></MemoryRouter>);
  fireEvent.click(screen.getAllByRole('button', { name: /add tenant/i })[0]!);
  fireEvent.change(screen.getByLabelText('Organization name'), { target: { value: 'Fresh Start' } });
  fireEvent.change(screen.getByLabelText('Owner email'), { target: { value: 'founder@fresh.test' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create tenant' }));
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => cleanup());

describe('creating a tenant', () => {
  it('says the owner was emailed when the server sent the invitation', async () => {
    mocks.createTenant.mockResolvedValue({ tenant: TENANT, owner_email: 'founder@fresh.test', invite_email: { sent: true } });
    await create();

    const note = await screen.findByRole('status');
    expect(note.textContent).toBe(
      'Created Fresh Start with founder@fresh.test as its owner. The invitation email was sent.',
    );
    expect(screen.queryByRole('alert')).toBeNull();
    expect(mocks.createTenant).toHaveBeenCalledWith({
      name: 'Fresh Start', owner_email: 'founder@fresh.test', owner_name: undefined,
    });
    expect(mocks.reload).toHaveBeenCalled();
  });

  it.each([
    ['failed', /the mail provider did not accept it/],
    ['not_configured', /email is not configured on the server/],
  ])('warns, after the modal closes, when the invitation was not sent (%s)', async (reason, why) => {
    mocks.createTenant.mockResolvedValue({
      tenant: TENANT, owner_email: 'founder@fresh.test', invite_email: { sent: false, reason },
    });
    await create();

    const warning = await screen.findByRole('alert');
    expect(warning.textContent).toMatch(/^Created Fresh Start with founder@fresh\.test as its owner, but the invitation email was not sent/);
    expect(warning.textContent).toMatch(why);
    expect(warning.textContent).toMatch(/founder@fresh\.test has not been told/);
    // The create itself succeeded: the modal is gone, and nothing reads as a failure.
    expect(screen.queryByRole('button', { name: 'Create tenant' })).toBeNull();
    expect(screen.queryByText(/sent\./)).toBeNull();
  });

  it('says only that the tenant was created when an older server answers no invite_email', async () => {
    mocks.createTenant.mockResolvedValue({ tenant: TENANT, owner_email: 'founder@fresh.test' });
    await create();

    const note = await screen.findByRole('status');
    expect(note.textContent).toBe('Created Fresh Start with founder@fresh.test as its owner.');
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
