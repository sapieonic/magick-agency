import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requirePermission } from '../../../src/rbac/rbac.middleware.js';
import type { MembershipRole } from '@magick-agency/db/models/membership.model';

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    user: undefined,
    membership: undefined,
    ...overrides,
  } as unknown as import('fastify').FastifyRequest;
}

function makeReply() {
  const send = vi.fn().mockReturnValue(undefined);
  const code = vi.fn().mockReturnValue({ send });
  return { code, send, _send: send } as unknown as import('fastify').FastifyReply;
}

function makeMembership(role: MembershipRole) {
  return {
    id: 'membership-1',
    user_id: 'user-1',
    tenant_id: 'tenant-1',
    account_id: 'account-1',
    role,
    status: 'active',
    invited_by: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

describe('requirePermission', () => {
  describe('no membership', () => {
    it('should return 403 when membership is missing', async () => {
      const handler = requirePermission('tenant.read');
      const req = makeRequest({ user: { id: 'user-1' }, membership: undefined });
      const reply = makeReply();

      await handler(req, reply);

      expect(reply.code).toHaveBeenCalledWith(403);
    });

    it('should include descriptive error message', async () => {
      const handler = requirePermission('tenant.read');
      const req = makeRequest({ user: { id: 'user-1' }, membership: undefined });
      const mockSend = vi.fn();
      const reply = { code: vi.fn().mockReturnValue({ send: mockSend }) } as unknown as import('fastify').FastifyReply;

      await handler(req, reply);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ error: 'Forbidden' }),
      );
    });
  });

  describe('insufficient role', () => {

    it('should include permission name in error message', async () => {
      // `user.update_role` is floored at `tenant_admin`.
      const handler = requirePermission('user.update_role');
      const req = makeRequest({
        user: { id: 'user-1' },
        membership: makeMembership('operator'),
      });
      const mockSend = vi.fn();
      const reply = { code: vi.fn().mockReturnValue({ send: mockSend }) } as unknown as import('fastify').FastifyReply;

      await handler(req, reply);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining('user.update_role') }),
      );
    });

    it('should return 403 when account_admin tries tenant_admin permission', async () => {
      // `user.remove` is floored at `tenant_admin`.
      const handler = requirePermission('user.remove');
      const req = makeRequest({
        user: { id: 'user-1' },
        membership: makeMembership('account_admin'),
      });
      const reply = makeReply();

      await handler(req, reply);

      expect(reply.code).toHaveBeenCalledWith(403);
    });
  });

  describe('sufficient role', () => {
    it('should pass when viewer has viewer permission', async () => {
      const handler = requirePermission('tenant.read');
      const req = makeRequest({
        user: { id: 'user-1' },
        membership: makeMembership('viewer'),
      });
      const reply = makeReply();

      await handler(req, reply);

      expect(reply.code).not.toHaveBeenCalled();
    });

    it('should pass when tenant_owner uses any permission', async () => {
      // `audit.read` is the only permission checked here.
      const permissions = ['audit.read'] as const;
      for (const perm of permissions) {
        const handler = requirePermission(perm);
        const req = makeRequest({
          user: { id: 'user-1' },
          membership: makeMembership('tenant_owner'),
        });
        const reply = makeReply();

        await handler(req, reply);

        expect(reply.code).not.toHaveBeenCalled();
      }
    });

    it('should pass when higher role uses lower permission', async () => {
      const handler = requirePermission('tenant.read'); // viewer permission
      const req = makeRequest({
        user: { id: 'user-1' },
        membership: makeMembership('tenant_owner'),
      });
      const reply = makeReply();

      await handler(req, reply);

      expect(reply.code).not.toHaveBeenCalled();
    });
  });
});
