import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { superAdminMiddleware } from '../../auth/super-admin.middleware.js';
import { recordSuperAdminAudit } from '../../audit/super-admin-audit.js';
import { telephonyProviderRepository } from '../../db/repositories/telephony-provider.repository.js';
import { phoneNumberRepository } from '@magick-agency/db/repositories/phone-number.repository';
import { tenantPhoneAssignmentRepository } from '@magick-agency/db/repositories/tenant-phone-assignment.repository';
import { getPool } from '@magick-agency/db';
import { createChildLogger } from '@magick-agency/observability';
import type { PhoneNumberRecord } from '@magick-agency/db/models/phone-number.model';
import {
  createPhoneNumberSchema,
  updatePhoneNumberSchema,
  assignPhoneNumberSchema,
} from '../validators/phone-number.validator.js';

const log = createChildLogger({ component: 'super-admin-phone-routes' });

/*
 * The super-admin phone inventory and assignment routes for the one VoiceLink
 * account. Deliberately absent:
 *  - Telephony-provider writes: the baseline seeds the single `voicelink`
 *    provider row. `provider_id` still references `telephony_providers`, so
 *    number creation still checks it, and `GET /telephony-providers` is kept so
 *    the super-admin console can pick that id.
 *  - `pool_eligible` on the wire (create/update input, the create log/audit
 *    field, every response row): it marked numbers for a signup pool, and there
 *    is no pooled number. The column stays in the schema at its default.
 *  - Phone-resolution and metadata cache invalidation: there is no such cache.
 *  - An inbound-routing cascade on unassign: there are no inbound configs
 *    (inbound calls to agency numbers play a message and hang up).
 */

/**
 * Strips `pool_eligible` from a phone row before it reaches the wire (contract
 * `PhoneNumber`, see the module note). Everything else is the row as stored.
 */
function toWirePhoneNumber<T extends Partial<Pick<PhoneNumberRecord, 'pool_eligible'>>>(row: T): Omit<T, 'pool_eligible'> {
  const { pool_eligible: _poolEligible, ...wire } = row;
  return wire;
}

export async function superAdminPhoneRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', superAdminMiddleware);

  // ── Phone Numbers ───────────────────────────────────────

  /**
   * GET /super-admin/telephony-providers
   * List all telephony providers. Optional ?status=active filter.
   */
  app.get('/telephony-providers', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string>;
    const status = query['status'] || undefined;
    const providers = await telephonyProviderRepository.findAll(status);
    return reply.send({ providers });
  });

  /**
   * POST /super-admin/phone-numbers
   * Create a new phone number.
   */
  app.post('/phone-numbers', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = createPhoneNumberSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }

    const input = parsed.data;

    // Verify provider exists
    const provider = await telephonyProviderRepository.findById(input.provider_id);
    if (!provider) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Telephony provider not found' });
    }

    // Check phone number uniqueness
    const existing = await phoneNumberRepository.findByPhoneNumber(input.phone_number);
    if (existing) {
      return reply.code(409).send({ error: 'Conflict', message: `Phone number ${input.phone_number} already exists` });
    }

    const phoneNumber = await phoneNumberRepository.create({
      ...input,
      created_by: request.superAdmin!.id,
    });

    log.info(
      { phoneNumberId: phoneNumber.id, phone: input.phone_number },
      'Phone number created',
    );
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id,
      admin_email: request.superAdmin!.email,
      action: 'create_phone_number',
      resource_type: 'phone_number',
      resource_id: phoneNumber.id,
      details: { phone_number: input.phone_number, provider_id: input.provider_id },
    });

    return reply.code(201).send({ phone_number: toWirePhoneNumber(phoneNumber) });
  });

  /**
   * GET /super-admin/phone-numbers
   * List phone numbers with optional filters and assignment counts.
   */
  app.get('/phone-numbers', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string>;
    const filters: { provider_id?: string; status?: string; region?: string } = {};
    if (query['provider_id']) filters.provider_id = query['provider_id'];
    if (query['status']) filters.status = query['status'];
    if (query['region']) filters.region = query['region'];

    const phoneNumbers = await phoneNumberRepository.findAll(filters);

    // Enrich with assignment counts
    const pool = getPool();
    const countResult = await pool.query<{ phone_number_id: string; count: string }>(
      `SELECT phone_number_id, COUNT(*)::text AS count
       FROM tenant_phone_assignments
       GROUP BY phone_number_id`,
    );
    const countMap = new Map(countResult.rows.map(r => [r.phone_number_id, parseInt(r.count, 10)]));

    const enriched = phoneNumbers.map(pn => ({
      ...toWirePhoneNumber(pn),
      assignment_count: countMap.get(pn.id) || 0,
    }));

    return reply.send({ phone_numbers: enriched });
  });

  /**
   * GET /super-admin/phone-numbers/:id
   * Phone number detail with assigned tenants.
   */
  app.get('/phone-numbers/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    const phoneNumber = await phoneNumberRepository.findById(id);
    if (!phoneNumber) {
      return reply.code(404).send({ error: 'Not Found', message: 'Phone number not found' });
    }

    const assignments = await tenantPhoneAssignmentRepository.findByPhoneNumberId(id);

    return reply.send({ phone_number: toWirePhoneNumber(phoneNumber), assignments });
  });

  /**
   * PUT /super-admin/phone-numbers/:id
   * Update a phone number.
   */
  app.put('/phone-numbers/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    const parsed = updatePhoneNumberSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }

    const phoneNumber = await phoneNumberRepository.update(id, parsed.data);
    if (!phoneNumber) {
      return reply.code(404).send({ error: 'Not Found', message: 'Phone number not found' });
    }

    log.info({ phoneNumberId: id }, 'Phone number updated');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id,
      admin_email: request.superAdmin!.email,
      action: 'update_phone_number',
      resource_type: 'phone_number',
      resource_id: id,
      details: parsed.data,
    });

    return reply.send({ phone_number: toWirePhoneNumber(phoneNumber) });
  });

  /**
   * DELETE /super-admin/phone-numbers/:id
   * Retire a phone number. Blocked if active tenant assignments exist.
   */
  app.delete('/phone-numbers/:id', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;

    const phoneNumber = await phoneNumberRepository.findById(id);
    if (!phoneNumber) {
      return reply.code(404).send({ error: 'Not Found', message: 'Phone number not found' });
    }
    if (phoneNumber.status !== 'active') {
      return reply.code(409).send({ error: 'Conflict', message: `Cannot retire a phone number with status '${phoneNumber.status}'` });
    }

    // Check for active assignments
    const assignmentCount = await phoneNumberRepository.countAssignments(id);
    if (assignmentCount > 0) {
      const assignments = await tenantPhoneAssignmentRepository.findByPhoneNumberId(id);
      return reply.code(409).send({
        error: 'Conflict',
        message: `Cannot retire: ${assignmentCount} tenant(s) are using this number. Unassign them first.`,
        tenants: assignments.map(a => ({ tenant_id: a.tenant_id, tenant_name: (a as any).tenant_name })),
      });
    }

    const retired = await phoneNumberRepository.retire(id);
    if (!retired) {
      return reply.code(500).send({ error: 'Internal', message: 'Failed to retire phone number' });
    }

    log.info({ phoneNumberId: id }, 'Phone number retired');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id,
      admin_email: request.superAdmin!.email,
      action: 'retire_phone_number',
      resource_type: 'phone_number',
      resource_id: id,
      details: { phone_number: phoneNumber.phone_number },
    });

    return reply.send({ message: 'Phone number retired' });
  });

  /**
   * POST /super-admin/phone-numbers/:id/reactivate
   * Reactivate a retired phone number.
   */
  app.post('/phone-numbers/:id/reactivate', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;

    const phoneNumber = await phoneNumberRepository.findById(id);
    if (!phoneNumber) {
      return reply.code(404).send({ error: 'Not Found', message: 'Phone number not found' });
    }
    if (phoneNumber.status !== 'retired') {
      return reply.code(409).send({ error: 'Conflict', message: `Can only reactivate retired numbers. Current status: '${phoneNumber.status}'` });
    }

    const reactivated = await phoneNumberRepository.reactivate(id);
    if (!reactivated) {
      return reply.code(500).send({ error: 'Internal', message: 'Failed to reactivate phone number' });
    }

    log.info({ phoneNumberId: id }, 'Phone number reactivated');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id,
      admin_email: request.superAdmin!.email,
      action: 'reactivate_phone_number',
      resource_type: 'phone_number',
      resource_id: id,
      details: { phone_number: phoneNumber.phone_number },
    });

    return reply.send({ message: 'Phone number reactivated' });
  });

  /**
   * POST /super-admin/phone-numbers/:id/delete
   * Permanently soft-delete a retired phone number. Irreversible.
   */
  app.post('/phone-numbers/:id/delete', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;

    const phoneNumber = await phoneNumberRepository.findById(id);
    if (!phoneNumber) {
      return reply.code(404).send({ error: 'Not Found', message: 'Phone number not found' });
    }
    if (phoneNumber.status !== 'retired') {
      return reply.code(409).send({ error: 'Conflict', message: `Can only delete retired numbers. Current status: '${phoneNumber.status}'` });
    }

    const deleted = await phoneNumberRepository.softDelete(id);
    if (!deleted) {
      return reply.code(500).send({ error: 'Internal', message: 'Failed to delete phone number' });
    }

    log.info({ phoneNumberId: id }, 'Phone number soft-deleted');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id,
      admin_email: request.superAdmin!.email,
      action: 'delete_phone_number',
      resource_type: 'phone_number',
      resource_id: id,
      details: { phone_number: phoneNumber.phone_number },
    });

    return reply.send({ message: 'Phone number permanently deleted' });
  });

  // ── Assignments ─────────────────────────────────────────

  /**
   * POST /super-admin/phone-numbers/:id/assign
   * Assign a phone number to a tenant.
   */
  app.post('/phone-numbers/:id/assign', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    const parsed = assignPhoneNumberSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Bad Request', details: parsed.error.issues });
    }

    const { tenant_id, is_default } = parsed.data;

    // Verify phone number exists and is active
    const phoneNumber = await phoneNumberRepository.findById(id);
    if (!phoneNumber) {
      return reply.code(404).send({ error: 'Not Found', message: 'Phone number not found' });
    }
    if (phoneNumber.status !== 'active') {
      return reply.code(400).send({ error: 'Bad Request', message: 'Phone number is not active' });
    }

    try {
      const assignment = await tenantPhoneAssignmentRepository.assign(
        tenant_id,
        id,
        is_default,
        request.superAdmin!.id,
      );

      log.info({ phoneNumberId: id, tenantId: tenant_id }, 'Phone number assigned to tenant');
      void recordSuperAdminAudit({
        admin_id: request.superAdmin!.id,
        admin_email: request.superAdmin!.email,
        action: 'assign_phone_number',
        resource_type: 'tenant_phone_assignment',
        resource_id: assignment.id,
        details: { phone_number_id: id, tenant_id, is_default },
      });

      return reply.code(201).send({ assignment });
    } catch (err: any) {
      // Handle unique constraint violation (already assigned)
      if (err.code === '23505') {
        return reply.code(409).send({ error: 'Conflict', message: 'Phone number already assigned to this tenant' });
      }
      // Handle FK violation (tenant doesn't exist)
      if (err.code === '23503') {
        return reply.code(400).send({ error: 'Bad Request', message: 'Tenant not found' });
      }
      throw err;
    }
  });

  /**
   * DELETE /super-admin/phone-numbers/:id/assign/:tenantId
   * Unassign a phone number from a tenant.
   *
   * No inbound-config cascade and no cache invalidation (module note).
   */
  app.delete<{ Params: { id: string; tenantId: string } }>('/phone-numbers/:id/assign/:tenantId', async (
    request,
    reply: FastifyReply,
  ) => {
    const { id, tenantId } = request.params;

    const removed = await tenantPhoneAssignmentRepository.unassign(tenantId, id);
    if (!removed) {
      return reply.code(404).send({ error: 'Not Found', message: 'Assignment not found' });
    }

    log.info({ phoneNumberId: id, tenantId }, 'Phone number unassigned from tenant');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id,
      admin_email: request.superAdmin!.email,
      action: 'unassign_phone_number',
      resource_type: 'tenant_phone_assignment',
      resource_id: id,
      details: { phone_number_id: id, tenant_id: tenantId },
    });

    return reply.send({ message: 'Phone number unassigned from tenant' });
  });

  /**
   * GET /super-admin/tenants/:id/phone-numbers
   * List phone numbers assigned to a tenant, with account tags.
   */
  app.get('/tenants/:id/phone-numbers', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    const assignments = await tenantPhoneAssignmentRepository.findByTenantId(id);

    // Enrich each assignment with account tags
    const enriched = await Promise.all(
      assignments.map(async (assignment) => {
        const tags = await tenantPhoneAssignmentRepository.findTagsForAssignment(assignment.id);
        return { ...assignment, account_tags: tags };
      }),
    );

    return reply.send({ phone_numbers: enriched });
  });
}
