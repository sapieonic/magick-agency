import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { vi } from 'vitest';
import Fastify from 'fastify';
import { closeTestPool, truncateAll } from '../setup/test-utils.js';
import {
  insertTenant,
  insertAccount,
  insertUser,
  insertTelephonyProvider,
  insertPhoneNumber,
  insertPhoneAssignment,
  insertPhoneAccountTag,
} from '../../../../../packages/db/test/integration/setup/platform-factories.js';
import { TEST_DB_URL } from '../../../../../packages/db/test/helpers/test-db.js';
import { initDbPool, closePool } from '@magick-agency/db';

/*
 * Runs on the test database (Postgres 5436).
 *  - Harness: `initDbPool` on the test database; the
 *    logger mock targets `@magick-agency/observability`. The session / tenant-context / RBAC are stubbed.
 *  - The two `GET /` cases.
 *  - Not covered: `POST /:assignmentId/tags`, `DELETE /:assignmentId/tags/:accountId`
 *    and `PUT /:assignmentId/account-default`: those routes are not served
 *    (number administration is the super-admin's; see the route file).
 *  - Isolation: another tenant's assignment never appears; an
 *    account-scoped caller sees untagged numbers and its own, never a number tagged only to a
 *    sibling account, and never the sibling's tag on a shared number.
 */

initDbPool({ url: TEST_DB_URL, poolMin: 0, poolMax: 4 });

// Bypass session auth — attach user from header
vi.mock('../../../src/auth/session.middleware.js', () => ({
  sessionMiddleware: async (request: any) => {
    request.user = { id: request.headers['x-user-id'] };
  },
}));

// Bypass tenant context — attach tenantId/accountId from headers
vi.mock('../../../src/api/middleware/tenant-context.middleware.js', () => ({
  tenantContextMiddleware: async (request: any) => {
    request.tenantId = request.headers['x-tenant-id'];
    request.accountId = request.headers['x-account-id'] || undefined;
  },
}));

// Bypass RBAC
vi.mock('../../../src/rbac/rbac.middleware.js', () => ({
  requirePermission: () => async () => {},
}));

// Stub logger
vi.mock('@magick-agency/observability', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@magick-agency/observability')>()),
  createChildLogger: () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() }),
}));

// ── Dynamic import after mocks ─────────────────────────────────────────────────

const { phoneNumberRoutes } = await import('../../../src/api/routes/phone-number.routes.js');

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('phone-number routes (integration)', () => {
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    await truncateAll();

    app = Fastify();
    await app.register(phoneNumberRoutes, { prefix: '/phone-numbers' });
    await app.ready();
  });

  afterAll(async () => {
    await closePool();
    await closeTestPool();
  });

  // ── GET / ────────────────────────────────────────────────────────────────────

  describe('GET / — lists assigned phone numbers for tenant', () => {
    it('returns phone numbers with account_tags', async () => {
      const tenant = await insertTenant();
      const account = await insertAccount({ tenant_id: tenant.id });
      const user = await insertUser();
      const provider = await insertTelephonyProvider();
      const phone = await insertPhoneNumber({ provider_id: provider.id });
      const assignment = await insertPhoneAssignment({
        tenant_id: tenant.id,
        phone_number_id: phone.id,
        is_default: true,
      });

      // Tag the phone to the account
      await insertPhoneAccountTag({
        assignment_id: assignment.id,
        account_id: account.id,
        is_default: false,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/phone-numbers',
        headers: {
          'x-tenant-id': tenant.id,
          'x-user-id': user.id,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.phone_numbers).toHaveLength(1);
      expect(body.phone_numbers[0].phone_number).toBe(phone.phone_number);
      expect(body.phone_numbers[0].provider_name).toBe(provider.name);
      expect(Array.isArray(body.phone_numbers[0].account_tags)).toBe(true);
      expect(body.phone_numbers[0].account_tags).toHaveLength(1);
      expect(body.phone_numbers[0].account_tags[0].account_id).toBe(account.id);
    });

    it('returns empty array for tenant with no assignments', async () => {
      const tenant = await insertTenant();
      const user = await insertUser();

      const res = await app.inject({
        method: 'GET',
        url: '/phone-numbers',
        headers: {
          'x-tenant-id': tenant.id,
          'x-user-id': user.id,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.phone_numbers).toHaveLength(0);
    });
  });

  // ── Isolation ───────────────────────────────────

  describe('GET / — tenant and account isolation', () => {
    it("never lists another tenant's assignment, on either query", async () => {
      const tenant = await insertTenant();
      const account = await insertAccount({ tenant_id: tenant.id });
      const other = await insertTenant();
      const otherAccount = await insertAccount({ tenant_id: other.id });
      const user = await insertUser();
      const provider = await insertTelephonyProvider();
      const mine = await insertPhoneNumber({ provider_id: provider.id });
      const theirs = await insertPhoneNumber({ provider_id: provider.id });
      await insertPhoneAssignment({ tenant_id: tenant.id, phone_number_id: mine.id });
      const theirAssignment = await insertPhoneAssignment({ tenant_id: other.id, phone_number_id: theirs.id });
      await insertPhoneAccountTag({ assignment_id: theirAssignment.id, account_id: otherAccount.id });

      for (const headers of [
        { 'x-tenant-id': tenant.id, 'x-user-id': user.id },
        { 'x-tenant-id': tenant.id, 'x-account-id': account.id, 'x-user-id': user.id },
      ]) {
        const res = await app.inject({ method: 'GET', url: '/phone-numbers', headers });
        expect(res.statusCode).toBe(200);
        expect(res.json().phone_numbers.map((p: { phone_number: string }) => p.phone_number)).toEqual([mine.phone_number]);
        expect(res.payload).not.toContain(theirs.phone_number);
        expect(res.payload).not.toContain(otherAccount.id);
      }
    });

    it("an account-scoped caller sees untagged and own-tagged numbers, never a sibling's number or tag", async () => {
      const tenant = await insertTenant();
      const own = await insertAccount({ tenant_id: tenant.id });
      const sibling = await insertAccount({ tenant_id: tenant.id });
      const user = await insertUser();
      const provider = await insertTelephonyProvider();
      const untagged = await insertPhoneNumber({ provider_id: provider.id });
      const ownOnly = await insertPhoneNumber({ provider_id: provider.id });
      const siblingOnly = await insertPhoneNumber({ provider_id: provider.id });
      const shared = await insertPhoneNumber({ provider_id: provider.id });
      await insertPhoneAssignment({ tenant_id: tenant.id, phone_number_id: untagged.id });
      const a2 = await insertPhoneAssignment({ tenant_id: tenant.id, phone_number_id: ownOnly.id });
      const a3 = await insertPhoneAssignment({ tenant_id: tenant.id, phone_number_id: siblingOnly.id });
      const a4 = await insertPhoneAssignment({ tenant_id: tenant.id, phone_number_id: shared.id });
      await insertPhoneAccountTag({ assignment_id: a2.id, account_id: own.id });
      await insertPhoneAccountTag({ assignment_id: a3.id, account_id: sibling.id });
      await insertPhoneAccountTag({ assignment_id: a4.id, account_id: own.id });
      await insertPhoneAccountTag({ assignment_id: a4.id, account_id: sibling.id });

      const res = await app.inject({
        method: 'GET',
        url: '/phone-numbers',
        headers: { 'x-tenant-id': tenant.id, 'x-account-id': own.id, 'x-user-id': user.id },
      });

      expect(res.statusCode).toBe(200);
      const numbers = res.json().phone_numbers as Array<{ phone_number: string; account_tags: Array<{ account_id: string }> }>;
      expect(numbers.map((p) => p.phone_number).sort()).toEqual(
        [untagged.phone_number, ownOnly.phone_number, shared.phone_number].sort(),
      );
      expect(res.payload).not.toContain(siblingOnly.phone_number);
      expect(res.payload).not.toContain(sibling.id);
      const sharedRow = numbers.find((p) => p.phone_number === shared.phone_number)!;
      expect(sharedRow.account_tags.map((t) => t.account_id)).toEqual([own.id]);
    });
  });
});
