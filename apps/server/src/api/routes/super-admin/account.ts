/*
 * The signed-in super admin's own account: `/me` and `/change-password`, and the bcrypt
 * cost the admin routes share. Part of `super-admin.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { superAdminRepository } from '@magick-agency/db/repositories/super-admin.repository';
import { recordSuperAdminAudit } from '../../../audit/super-admin-audit.js';
import { createChildLogger } from '@magick-agency/observability';
import { changePasswordSchema } from '../../validators/super-admin.validator.js';
import { parseOr400 } from '../helpers/parse-or-400.js';

const log = createChildLogger({ component: 'super-admin-routes' });

export const BCRYPT_ROUNDS = 10;

/**
 * Registered by `superAdminRoutes` inside its authenticated scope (`authApp`, the one
 * carrying `superAdminMiddleware`), so every route here runs behind it.
 */
export async function registerSuperAdminAccountRoutes(authApp: FastifyInstance): Promise<void> {
  /**
   * GET /super-admin/me
   */
  authApp.get('/me', async (request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({ admin: request.superAdmin });
  });

  /**
   * PUT /super-admin/change-password
   * Change own password (requires current password).
   */
  authApp.put('/change-password', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseOr400(changePasswordSchema, request.body, reply, 'platform');
    if (!parsed) return reply;

    const { current_password, new_password } = parsed.data;
    const adminId = request.superAdmin!.id;

    const admin = await superAdminRepository.findByIdWithHash(adminId);
    if (!admin) {
      return reply.code(404).send({ error: 'Not Found', message: 'Admin not found' });
    }

    const valid = await bcrypt.compare(current_password, admin.password_hash);
    if (!valid) {
      return reply.code(401).send({ error: 'Unauthorized', message: 'Current password is incorrect' });
    }

    const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    await superAdminRepository.updatePasswordHash(adminId, newHash);

    log.info({ adminId }, 'Super admin changed own password');
    void recordSuperAdminAudit({
      admin_id: adminId, admin_email: request.superAdmin!.email,
      action: 'change_password', resource_type: 'super_admin', resource_id: adminId,
      details: {},
    });

    return reply.send({ success: true });
  });
}
