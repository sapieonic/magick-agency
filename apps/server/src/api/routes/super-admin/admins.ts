/*
 * Other super admins (create, list, delete, reactivate, reset password) and the audit
 * log. Part of `super-admin.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { superAdminRepository } from '@magick-agency/db/repositories/super-admin.repository';
import { superAdminAuditRepository } from '@magick-agency/db/repositories/super-admin-audit.repository';
import { recordSuperAdminAudit } from '../../../audit/super-admin-audit.js';
import { createChildLogger } from '@magick-agency/observability';
import {
  createSuperAdminSchema,
  resetAdminPasswordSchema,
  superAdminAuditQuerySchema,
} from '../../validators/super-admin.validator.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import { BCRYPT_ROUNDS } from './account.js';

const log = createChildLogger({ component: 'super-admin-routes' });

/**
 * Registered by `superAdminRoutes` inside its authenticated scope (`authApp`, the one
 * carrying `superAdminMiddleware`), so every route here runs behind it.
 */
export async function registerSuperAdminAdminRoutes(authApp: FastifyInstance): Promise<void> {
  /**
   * POST /super-admin/admins
   * Create another super admin.
   */
  authApp.post('/admins', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseOr400(createSuperAdminSchema, request.body, reply, 'platform');
    if (!parsed) return reply;

    const { email, password, name } = parsed.data;

    // Check uniqueness
    const existing = await superAdminRepository.findByEmail(email);
    if (existing) {
      return reply.code(409).send({ error: 'Conflict', message: 'Email already registered as super admin' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const admin = await superAdminRepository.create({
      email,
      password_hash: passwordHash,
      name,
    });

    log.info({ adminId: admin.id, email }, 'Super admin created new admin');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id, admin_email: request.superAdmin!.email,
      action: 'create_admin', resource_type: 'super_admin', resource_id: admin.id,
      details: { email, name },
    });

    return reply.code(201).send({ admin });
  });

  /**
   * GET /super-admin/admins
   * List all super admins (no password_hash).
   */
  authApp.get('/admins', async (_request: FastifyRequest, reply: FastifyReply) => {
    const admins = await superAdminRepository.findAll();
    return reply.send({ admins });
  });

  /**
   * DELETE /super-admin/admins/:id
   * Deactivate a super admin. System-seeded admin cannot be removed.
   * Cannot remove yourself.
   */
  authApp.delete('/admins/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;

    if (id === request.superAdmin!.id) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Cannot remove yourself' });
    }

    const target = await superAdminRepository.findById(id);
    if (!target) {
      return reply.code(404).send({ error: 'Not Found', message: 'Admin not found' });
    }

    if (target.is_system) {
      return reply.code(403).send({ error: 'Forbidden', message: 'System admin cannot be removed' });
    }

    await superAdminRepository.deactivate(id);

    log.info({ adminId: id, removedBy: request.superAdmin!.id }, 'Super admin removed another admin');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id, admin_email: request.superAdmin!.email,
      action: 'remove_admin', resource_type: 'super_admin', resource_id: id,
      details: { email: target.email, name: target.name },
    });

    return reply.send({ success: true, admin_id: id });
  });

  /**
   * POST /super-admin/admins/:id/reactivate
   * Reactivate an inactive super admin. System admin cannot be modified.
   */
  authApp.post('/admins/:id/reactivate', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;

    const target = await superAdminRepository.findById(id);
    if (!target) {
      return reply.code(404).send({ error: 'Not Found', message: 'Admin not found' });
    }
    if (target.is_system) {
      return reply.code(403).send({ error: 'Forbidden', message: 'System admin cannot be modified' });
    }
    if (target.status !== 'inactive') {
      return reply.code(400).send({ error: 'Bad Request', message: 'Can only reactivate inactive admins' });
    }

    const admin = await superAdminRepository.reactivate(id);
    if (!admin) {
      // Lost a TOCTOU race: the row was flipped out of 'inactive' between our
      // findById check and the UPDATE. Nothing changed — don't audit a phantom
      // reactivation.
      return reply.code(409).send({ error: 'Conflict', message: 'Admin is no longer inactive' });
    }

    log.info({ adminId: id, reactivatedBy: request.superAdmin!.id }, 'Super admin reactivated another admin');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id, admin_email: request.superAdmin!.email,
      action: 'reactivate_admin', resource_type: 'super_admin', resource_id: id,
      details: { email: target.email, name: target.name },
    });

    return reply.send({ admin });
  });

  /**
   * PUT /super-admin/admins/:id/password
   * Reset ANOTHER admin's password. Requires the acting admin's own password
   * (re-auth). Cannot target self (use change-password) or the system admin.
   */
  authApp.put('/admins/:id/password', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const parsed = parseOr400(resetAdminPasswordSchema, request.body, reply, 'platform');
    if (!parsed) return reply;

    const { id } = request.params;
    const { admin_password, new_password } = parsed.data;

    if (id === request.superAdmin!.id) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Use change-password for your own account' });
    }

    const target = await superAdminRepository.findById(id);
    if (!target) {
      return reply.code(404).send({ error: 'Not Found', message: 'Admin not found' });
    }
    if (target.is_system) {
      return reply.code(403).send({ error: 'Forbidden', message: 'System admin cannot be modified' });
    }

    const actor = await superAdminRepository.findByIdWithHash(request.superAdmin!.id);
    if (!actor) {
      return reply.code(404).send({ error: 'Not Found', message: 'Admin not found' });
    }
    const valid = await bcrypt.compare(admin_password, actor.password_hash);
    if (!valid) {
      // 422 (not 401) is deliberate: the super-admin console's saFetch treats every
      // 401 as session-expiry and force-logs-out the admin. A wrong re-auth password
      // is a business validation failure that must surface inline in the modal — so
      // 422.
      return reply.code(422).send({ error: 'Unprocessable Entity', message: 'Your password is incorrect' });
    }

    const newHash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
    await superAdminRepository.updatePasswordHash(id, newHash);

    log.info({ adminId: id, resetBy: request.superAdmin!.id }, 'Super admin reset another admin password');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id, admin_email: request.superAdmin!.email,
      action: 'reset_admin_password', resource_type: 'super_admin', resource_id: id,
      details: { email: target.email },
    });

    return reply.send({ success: true });
  });

  /**
   * GET /super-admin/audit
   * Admin audit log — visible to all super admins. Filters are server-side: a
   * page-local search would scan only the current 50 rows.
   */
  authApp.get('/audit', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseOr400(superAdminAuditQuerySchema, request.query, reply, 'platform');
    if (!parsed) return reply;
    const { limit, offset, ...filters } = parsed.data;
    const result = await superAdminAuditRepository.list(limit, offset, filters);
    return reply.send(result);
  });
}
