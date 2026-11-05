import { describe, it, expect } from 'vitest';
import { accountLabel } from '../../pages/team/TeamPage';

/**
 * The Team table's Account cell. With several accounts in a tenant, an id prefix
 * tells a supervisor nothing, so the name is shown whenever the switcher's list has
 * it; the prefix stays as the fallback for an account that list does not carry.
 */
describe('accountLabel', () => {
  const names = new Map([['acct-1111-2222', 'Renewals']]);

  it('names a tenant-wide membership', () => {
    expect(accountLabel(null, names)).toBe('Tenant-level');
  });

  it('shows the account name when it is known', () => {
    expect(accountLabel('acct-1111-2222', names)).toBe('Renewals');
  });

  it('falls back to the id prefix for an account not in the list', () => {
    expect(accountLabel('99999999-aaaa-bbbb', names)).toBe('99999999');
  });
});
