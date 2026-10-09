// Real Postgres: `src/connection.js` is pointed at the test pool.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { getTestPool, closeTestPool, truncateAll } from '../setup/test-utils.js';
import { insertTenant, insertUser, insertAccount, insertMembership } from '../setup/platform-factories.js';

vi.mock('../../../src/connection.js', () => ({
  getPool: () => getTestPool(),
}));

const { userRepository } = await import('../../../src/repositories/user.repository.js');

/**
 * `findAddressableMembersInAccount` — the query that decides WHO GETS EMAILED.
 *
 * ── Why this needs its own integration file ─────────────────────────────────
 * It is the only leak-critical SQL in `user.repository.ts`: its output becomes
 * the recipient list of the agency campaign-completion notice
 * (`src/notifications/agency-campaign-completion.ts`), and the unit test for that
 * module mocks this method away — correctly, since what it pins is the RBAC floor
 * applied above the DB layer. So until this file existed, the predicate that
 * decides whether a sibling account's admins receive another account's mail was
 * asserted nowhere at all.
 *
 * Four properties, each chosen because getting it wrong is a disclosure or a
 * silent non-delivery rather than a cosmetic bug:
 *
 *  1. **The two-arm `account_id IS NULL OR = $2::uuid` predicate does not reach a
 *     SIBLING account.** The tenant-level arm exists so a tenant owner hears
 *     about every account; a bug that widened it to every account-scoped
 *     membership would mail account B's admins about account A's campaign.
 *  2. **The tenant predicate holds.** Same address in two tenants is the shape
 *     that catches a dropped `m.tenant_id`.
 *  3. **Only ACTIVE memberships and ACTIVE users are returned.** A revoked or
 *     `inactive` membership, and a `deleted` or `inactive` user, are all people
 *     who should not be told — see the method's own docstring on why this differs
 *     from `findIdentitiesInTenant`.
 *  4. **A non-UUID `accountId` NARROWS and raises no `22P02`.** A campaign
 *     `account_id` historically defaulted to `'default'`, so that is the value a
 *     stale emitter would send. Passed to
 *     Postgres it would be `22P02` inside the read; guessed as "then everyone in
 *     the tenant" it would mail people who cannot see the account. It must do
 *     neither.
 *
 * Needs Docker (`npm run test:integration:up`) like every file in this directory.
 */
describe('userRepository.findAddressableMembersInAccount (integration)', () => {
  let tenant: any;
  let accountA: any;
  let accountB: any;

  beforeEach(async () => {
    await truncateAll();
    tenant = await insertTenant();
    accountA = await insertAccount({ tenant_id: tenant.id });
    accountB = await insertAccount({ tenant_id: tenant.id });
  });

  afterAll(async () => {
    await closeTestPool();
  });

  /** One active user with one membership, returning the address for assertions. */
  async function addMember(fields: {
    account_id?: string | null;
    role?: string;
    status?: string;
    userStatus?: string;
    tenant_id?: string;
  }): Promise<string> {
    const user = await insertUser({ status: fields.userStatus ?? 'active' });
    await insertMembership({
      user_id: user.id,
      tenant_id: fields.tenant_id ?? tenant.id,
      account_id: fields.account_id ?? null,
      role: fields.role ?? 'account_admin',
      status: fields.status ?? 'active',
    });
    return user.email as string;
  }

  const emails = (rows: Array<{ email: string }>) => rows.map((r) => r.email).sort();

  describe('the two-arm account predicate', () => {
    it('never reaches a sibling account', async () => {
      const inA = await addMember({ account_id: accountA.id });
      const inB = await addMember({ account_id: accountB.id });

      const rows = await userRepository.findAddressableMembersInAccount(tenant.id, accountA.id);

      expect(emails(rows)).toEqual([inA]);
      expect(emails(rows)).not.toContain(inB);
    });

    /**
     * The tenant-level arm is the reason the predicate has two halves at all:
     * `memberships.account_id IS NULL` is the tenant-wide form, and those people
     * administer every account. Dropping it would silently skip the owner on a
     * single-account tenant, which is the common shape.
     */
    it('includes tenant-level memberships alongside the account-scoped ones', async () => {
      const scoped = await addMember({ account_id: accountA.id });
      const tenantWide = await addMember({ account_id: null, role: 'tenant_owner' });

      const rows = await userRepository.findAddressableMembersInAccount(tenant.id, accountA.id);

      expect(emails(rows)).toEqual([scoped, tenantWide].sort());
    });

    it('carries the role each membership grants, so the caller can apply a floor', async () => {
      await addMember({ account_id: accountA.id, role: 'agent' });
      await addMember({ account_id: accountA.id, role: 'tenant_admin' });

      const rows = await userRepository.findAddressableMembersInAccount(tenant.id, accountA.id);

      expect(rows.map((r) => r.role).sort()).toEqual(['agent', 'tenant_admin']);
    });
  });

  describe('the tenant predicate', () => {
    it('does not reach another tenant', async () => {
      const other = await insertTenant();
      const mine = await addMember({ account_id: null });
      const theirs = await addMember({ tenant_id: other.id, account_id: null });

      const rows = await userRepository.findAddressableMembersInAccount(tenant.id, accountA.id);

      expect(emails(rows)).toEqual([mine]);
      expect(emails(rows)).not.toContain(theirs);
    });

    it('returns nothing for a tenant id that is not a UUID', async () => {
      await addMember({ account_id: null });
      expect(await userRepository.findAddressableMembersInAccount('default', accountA.id)).toEqual([]);
    });
  });

  describe('only people who should be told', () => {
    it.each([['inactive'], ['revoked']])(
      'excludes a %s membership',
      async (status) => {
        const active = await addMember({ account_id: accountA.id });
        const excluded = await addMember({ account_id: accountA.id, status });

        const rows = await userRepository.findAddressableMembersInAccount(tenant.id, accountA.id);

        expect(emails(rows)).toEqual([active]);
        expect(emails(rows)).not.toContain(excluded);
      },
    );

    /**
     * `u.status = 'active'`, not `<> 'deleted'`. An `inactive` user is a mailbox
     * the users table itself says nobody is reading — the looser predicate belongs on
     * `findIdentitiesInTenant`, which answers "who was this".
     */
    it.each([['inactive'], ['deleted']])(
      'excludes a %s user even with an active membership',
      async (userStatus) => {
        const active = await addMember({ account_id: accountA.id });
        const excluded = await addMember({ account_id: accountA.id, userStatus });

        const rows = await userRepository.findAddressableMembersInAccount(tenant.id, accountA.id);

        expect(emails(rows)).toEqual([active]);
        expect(emails(rows)).not.toContain(excluded);
      },
    );

    /** One person, two memberships, two rows — de-duplication is the caller's. */
    it('returns one row per membership, not per person', async () => {
      const user = await insertUser();
      await insertMembership({
        user_id: user.id, tenant_id: tenant.id, account_id: null, role: 'tenant_owner',
      });
      await insertMembership({
        user_id: user.id, tenant_id: tenant.id, account_id: accountA.id, role: 'account_admin',
      });

      const rows = await userRepository.findAddressableMembersInAccount(tenant.id, accountA.id);

      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.role).sort()).toEqual(['account_admin', 'tenant_owner']);
    });
  });

  describe('an accountId Postgres cannot cast', () => {
    /**
     * `'default'` is not a hypothetical: it was the historical column default for
     * `agency_campaigns.account_id`, so it is what a stale emitter would send.
     */
    it.each([['default'], ['not-a-uuid'], ['']])(
      'narrows to the tenant-level arm for %o, and raises no 22P02',
      async (accountId) => {
        const tenantWide = await addMember({ account_id: null, role: 'tenant_owner' });
        const scoped = await addMember({ account_id: accountA.id });

        const rows = await userRepository.findAddressableMembersInAccount(tenant.id, accountId);

        expect(emails(rows)).toEqual([tenantWide]);
        expect(emails(rows)).not.toContain(scoped);
      },
    );

    it('narrows the same way for an omitted accountId', async () => {
      const tenantWide = await addMember({ account_id: null, role: 'tenant_owner' });
      await addMember({ account_id: accountA.id });

      expect(emails(await userRepository.findAddressableMembersInAccount(tenant.id)))
        .toEqual([tenantWide]);
      expect(emails(await userRepository.findAddressableMembersInAccount(tenant.id, null)))
        .toEqual([tenantWide]);
    });

    /**
     * The narrowing's real cost, stated as an assertion so nobody "fixes" it by
     * widening: a tenant whose supervisors are all account-scoped is told NOTHING
     * when the account id does not resolve. That is why the notifier reports
     * `account_not_addressable` rather than `no_recipients` — the empty list is a
     * fact about the payload, not about the customer's staffing.
     */
    it('returns nothing when every membership is account-scoped', async () => {
      await addMember({ account_id: accountA.id });
      await addMember({ account_id: accountB.id });

      expect(await userRepository.findAddressableMembersInAccount(tenant.id, 'default')).toEqual([]);
    });
  });
});
