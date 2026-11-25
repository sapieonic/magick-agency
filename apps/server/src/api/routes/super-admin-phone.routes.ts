import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { superAdminMiddleware } from '../../auth/super-admin.middleware.js';
import { recordSuperAdminAudit } from '../../audit/super-admin-audit.js';
import { telephonyProviderRepository } from '../../db/repositories/telephony-provider.repository.js';
import { phoneNumberRepository } from '@magick-agency/db/repositories/phone-number.repository';
import { PhoneNumberOtherTenantError, tenantPhoneAssignmentRepository } from '@magick-agency/db/repositories/tenant-phone-assignment.repository';
import { getPool } from '@magick-agency/db';
import { createChildLogger } from '@magick-agency/observability';
import type { PhoneNumberRecord } from '@magick-agency/db/models/phone-number.model';
import type { CampaignHoldingCallerId } from '@magick-agency/db/models/phone-number.model';
import type { PinPhoneNumberErrorCode } from '@magick-agency/contracts/api/platform/super-admin';
import {
  createPhoneNumberSchema,
  updatePhoneNumberSchema,
  assignPhoneNumberSchema,
  pinPhoneNumberSchema,
} from '../validators/phone-number.validator.js';
import { isUuid } from '../../utils/uuid.js';
import { parseOr400 } from './helpers/parse-or-400.js';
import { invalidateDialableCallerIds } from '../../agency/campaign-dialability.js';
import { carrierHasServiceAccount, carrierSupportsInbound, carrierTakesTenantAccounts } from '../../telephony/carrier-catalog.js';
import { carrierNumberSource } from '../../telephony/carrier-number-source.js';
import { getTelephonyInboundService } from '../../telephony/credentials/index.js';
import type { InboundReleaseCause, TelephonyInboundService } from '../../telephony/credentials/inbound-service.js';

const log = createChildLogger({ component: 'super-admin-phone-routes' });

/*
 * The super-admin phone inventory and assignment routes. Which numbers may be added here by
 * hand follows the carrier's account modes (docs/carriers.md CR1, CR6), never its name:
 *  - with no credential, a number on the service's own carrier account: only on a carrier that
 *    has one;
 *  - with `telephony_credential_id`, a number on a tenant's own carrier account, pinned to that
 *    credential: only on a carrier that takes tenant accounts AND whose numbers the carrier
 *    cannot list (`carrierNumberSource` is `manual`). The credential must be `active` and of that
 *    carrier, and the number is assigned untagged to the credential's tenant in the same
 *    transaction (`phoneNumberRepository.createPinned`), as a sync assigns the numbers it adds;
 *  - a carrier whose numbers are synced (`sync`) refuses both: its numbers come only from that
 *    credential's number sync (`POST /super-admin/telephony-credentials/:id/sync-numbers`).
 * A number's pin never changes once set (CR6, CR7): `PUT` takes no credential or carrier, and an
 * assignment of a pinned number to another tenant than its credential's is refused
 * (`PhoneNumberOtherTenantError`, keyed on the credential), whichever way it was pinned. The one
 * way a pin is set after creation is `POST /phone-numbers/:id/pin`: a number on the service's
 * own account (every VoiceLink number registered before tenant accounts existed is one) moved,
 * one way, onto a tenant's own account of the same carrier, on the same rules as a number added
 * by hand onto it, plus: assigned to no other tenant, and held as a caller ID by no
 * service-account campaign that is not finished (CR9). Nothing unpins a number.
 * Deliberately absent:
 *  - Telephony-provider writes: the migrations seed the provider rows (`voicelink`,
 *    and `plivo`, which 0019 activates). `provider_id` still references
 *    `telephony_providers`, so number creation checks it and refuses an inactive
 *    provider, and `GET /telephony-providers` is kept so the super-admin console can
 *    pick the id.
 *  - `pool_eligible` on the wire (create/update input, the create log/audit
 *    field, every response row): it marked numbers for a signup pool, and there
 *    is no pooled number. The column stays in the schema at its default.
 *  - Phone-resolution and metadata cache invalidation: there is no such cache.
 *
 * Inbound (docs/inbound.md §8.2): a number linked to its credential's inbound Application stops
 * being answered here once it is unassigned from the tenant, retired or deleted (the status set
 * by `PUT` included): each of those writes runs the cascade for the number after it lands
 * (`TelephonyInboundService.reconcileNumber`, a no-op for a number that is not linked). Linking
 * and unlinking themselves are the credential routes' (`/phone-numbers/:id/inbound/*`).
 */

/** Synced numbers are never added by hand, with or without a credential (CR6): today's copy. */
const SYNCED_NUMBERS = 'Numbers on this carrier come from the tenant’s carrier account: sync them from its credential instead';

/**
 * Why a number may not be added by hand on `provider` with `credentialId` (CR1, CR6), or null
 * when it may. A carrier the catalogue does not know allows neither mode.
 */
export function numberModeRefusal(provider: string, credentialId: string | null): string | null {
  const source = carrierNumberSource(provider);
  if (source === 'sync') return SYNCED_NUMBERS;
  if (credentialId === null) {
    if (carrierHasServiceAccount(provider)) return null;
    return source === 'manual'
      ? 'Numbers on this carrier are on a tenant’s own carrier account: choose the credential the number belongs to'
      : 'This carrier is not one this service can dial on';
  }
  if (source === 'manual') return null;
  return 'This carrier has no tenant carrier accounts: add the number without a credential';
}

/**
 * Strips `pool_eligible` from a phone row before it reaches the wire (contract
 * `PhoneNumber`, see the module note). Everything else is the row as stored.
 */
function toWirePhoneNumber<T extends Partial<Pick<PhoneNumberRecord, 'pool_eligible'>>>(row: T): Omit<T, 'pool_eligible'> {
  const { pool_eligible: _poolEligible, ...wire } = row;
  return wire;
}

/** How many of the campaigns blocking a pin its refusal names (as a credential revoke's does). */
export const PIN_REFUSAL_CAMPAIGNS_NAMED = 5;

/**
 * The `phone_number_in_use` refusal: the service-account campaigns that are not finished and use
 * the number as a caller ID, each with its tenant, account and status, at most
 * {@link PIN_REFUSAL_CAMPAIGNS_NAMED}, then how many more.
 */
export function pinInUseMessage(total: number, named: readonly CampaignHoldingCallerId[]): string {
  const items = named.map((c) => `“${c.campaign_name}” (${c.tenant_name} / ${c.account_name ?? 'a removed account'}, ${c.status})`);
  const more = total - named.length;
  if (more > 0) items.push(`${more} more`);
  const list = items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
  const them = total === 1 ? 'it' : 'them';
  return `${total === 1 ? '1 campaign that is not finished uses' : `${total} campaigns that are not finished use`} `
    + `this number as a caller ID on the service’s own carrier account: ${list}. Remove the number from ${them}, or stop ${them}, first.`;
}

/** Whether a number on `provider` may be pinned to a tenant credential by hand (CR6): only a `manual` carrier. */
function carrierTakesPinnedNumbersByHand(provider: string): boolean {
  return carrierTakesTenantAccounts(provider) && carrierNumberSource(provider) === 'manual';
}

export async function superAdminPhoneRoutes(
  app: FastifyInstance,
  opts: { inbound?: () => TelephonyInboundService } = {},
): Promise<void> {
  const inbound = opts.inbound ?? getTelephonyInboundService;
  /** The §8.2 cascade for one number after a write to it; never throws. */
  const cascade = (request: FastifyRequest, phoneNumberId: string, cause: Exclude<InboundReleaseCause, 'unlinked' | 'retired_by_sync'>) =>
    inbound().reconcileNumber(phoneNumberId, cause, { adminId: request.superAdmin!.id, adminEmail: request.superAdmin!.email });
  app.addHook('preHandler', superAdminMiddleware);

  // ── Phone Numbers ───────────────────────────────────────

  /**
   * GET /super-admin/telephony-providers
   * List all telephony providers. Optional ?status=active filter. Each carries what its
   * catalogue entry declares (contract `TelephonyProvider`): `service_account`,
   * `tenant_accounts` (and its older name `takes_tenant_credentials`), `number_source` and
   * `supports_inbound`, so "Add number" offers exactly what `POST /phone-numbers` accepts.
   */
  app.get('/telephony-providers', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as Record<string, string>;
    const status = query['status'] || undefined;
    const providers = (await telephonyProviderRepository.findAll(status)).map((p) => ({
      ...p,
      takes_tenant_credentials: carrierTakesTenantAccounts(p.name),
      service_account: carrierHasServiceAccount(p.name),
      tenant_accounts: carrierTakesTenantAccounts(p.name),
      number_source: carrierNumberSource(p.name),
      supports_inbound: carrierSupportsInbound(p.name),
    }));
    return reply.send({ providers });
  });

  /**
   * POST /super-admin/phone-numbers
   * Create a new phone number.
   */
  app.post('/phone-numbers', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseOr400(createPhoneNumberSchema, request.body, reply, 'platform');
    if (!parsed) return reply;

    const input = parsed.data;

    // Verify provider exists
    const provider = await telephonyProviderRepository.findById(input.provider_id);
    if (!provider) {
      return reply.code(400).send({ error: 'Bad Request', message: 'Telephony provider not found' });
    }
    if (provider.status === 'inactive') {
      return reply.code(400).send({ error: 'Bad Request', message: 'Telephony provider is not active' });
    }
    // The account mode (CR1, CR6), from the catalogue, never the carrier's name.
    const { telephony_credential_id: credentialId = null, ...fields } = input;
    const modeRefusal = numberModeRefusal(provider.name, credentialId);
    if (modeRefusal) return reply.code(400).send({ error: 'Bad Request', message: modeRefusal });

    // Check phone number uniqueness
    const existing = await phoneNumberRepository.findByPhoneNumber(input.phone_number);
    if (existing) {
      return reply.code(409).send({ error: 'Conflict', message: `Phone number ${input.phone_number} already exists` });
    }

    let phoneNumber: PhoneNumberRecord;
    let tenantId: string | null = null;
    if (credentialId === null) {
      phoneNumber = await phoneNumberRepository.create({ ...fields, created_by: request.superAdmin!.id });
    } else {
      // The credential is locked, judged and the number assigned to its tenant in one
      // transaction (`createPinned`): a disable or revoke cannot land between the check and
      // the write.
      const created = await phoneNumberRepository.createPinned({ ...fields, created_by: request.superAdmin!.id }, credentialId);
      if (!created.ok) {
        switch (created.reason) {
          case 'credential_not_found':
            return reply.code(404).send({
              error: 'Not Found', code: 'telephony_credential_not_found',
              message: 'telephony_credential_id does not name a carrier account on this carrier.',
            });
          case 'credential_not_active':
            return reply.code(409).send({
              error: 'Conflict', code: 'telephony_credential_not_active',
              message: `The carrier account is ${created.status}, so a number cannot be added to it. Enable it first.`,
            });
          case 'duplicate':
            return reply.code(409).send({ error: 'Conflict', message: `Phone number ${input.phone_number} already exists` });
        }
      }
      phoneNumber = created.phoneNumber;
      tenantId = created.tenantId;
      // A new number can be a caller ID for the credential's campaigns at once.
      invalidateDialableCallerIds();
    }

    log.info(
      { phoneNumberId: phoneNumber.id, phone: input.phone_number, telephonyCredentialId: credentialId },
      'Phone number created',
    );
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id,
      admin_email: request.superAdmin!.email,
      action: 'create_phone_number',
      resource_type: 'phone_number',
      resource_id: phoneNumber.id,
      details: {
        phone_number: input.phone_number, provider_id: input.provider_id, telephony_credential_id: credentialId,
        ...(tenantId ? { tenant_id: tenantId } : {}),
      },
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
    const parsed = parseOr400(updatePhoneNumberSchema, request.body, reply, 'platform');
    if (!parsed) return reply;

    const phoneNumber = await phoneNumberRepository.update(id, parsed.data);
    if (!phoneNumber) {
      return reply.code(404).send({ error: 'Not Found', message: 'Phone number not found' });
    }
    if (phoneNumber.status === 'retired' || phoneNumber.status === 'deleted') await cascade(request, id, phoneNumber.status);

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

    // Campaigns naming it stop dialling from it now, not when the cached read lapses (PL13).
    invalidateDialableCallerIds();
    await cascade(request, id, 'retired');
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

    invalidateDialableCallerIds();
    await cascade(request, id, 'deleted');
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

  /**
   * POST /super-admin/phone-numbers/:id/pin
   * Move a number on the service's own carrier account onto a tenant's own account of the same
   * carrier (CR6; module note): pinned to `telephony_credential_id` and assigned untagged to its
   * tenant, in one transaction with the number and the credential locked
   * (`phoneNumberRepository.pinToCredential`). One way. Refusals: contract
   * `PinPhoneNumberErrorCode`.
   */
  app.post<{ Params: { id: string } }>('/phone-numbers/:id/pin', async (request, reply) => {
    const { id } = request.params;
    const refuse = (status: number, code: PinPhoneNumberErrorCode, message: string, extra: Record<string, unknown> = {}) =>
      reply.code(status).send({ error: status === 404 ? 'Not Found' : 'Conflict', code, message, ...extra });
    if (!isUuid(id)) return refuse(404, 'phone_number_not_found', 'Phone number not found');
    const parsed = parseOr400(pinPhoneNumberSchema, request.body, reply, 'platform');
    if (!parsed) return reply;
    const credentialId = parsed.data.telephony_credential_id;

    // The carrier's rule, from the catalogue (a number's carrier never changes, so it is read
    // outside the lock). Everything else is judged under it.
    const current = await phoneNumberRepository.findById(id);
    if (!current) return refuse(404, 'phone_number_not_found', 'Phone number not found');
    if (current.telephony_credential_id) {
      return refuse(409, 'phone_number_already_pinned', 'This number is already on a tenant’s own carrier account, and that never changes');
    }
    const provider = current.provider_name ?? '';
    if (!carrierTakesPinnedNumbersByHand(provider)) {
      return refuse(409, 'carrier_numbers_not_pinned_by_hand',
        carrierTakesTenantAccounts(provider)
          ? SYNCED_NUMBERS
          : 'This carrier has no tenant carrier accounts, so its numbers stay on the service’s own account');
    }

    const result = await phoneNumberRepository.pinToCredential(id, credentialId, request.superAdmin!.id, {
      campaignsNamed: PIN_REFUSAL_CAMPAIGNS_NAMED,
    });
    if (!result.ok) {
      switch (result.reason) {
        case 'phone_number_not_found':
          return refuse(404, 'phone_number_not_found', 'Phone number not found');
        case 'phone_number_not_active':
          return refuse(409, 'phone_number_not_active', `The number is ${result.status}, so it cannot be moved. Reactivate it first.`, { status: result.status });
        case 'already_pinned':
          return refuse(409, 'phone_number_already_pinned', 'This number is already on a tenant’s own carrier account, and that never changes');
        case 'credential_not_found':
          return refuse(404, 'telephony_credential_not_found', 'telephony_credential_id does not name a carrier account on this number’s carrier.');
        case 'credential_not_active':
          return refuse(409, 'telephony_credential_not_active',
            `The carrier account is ${result.status}, so a number cannot be moved onto it. Enable it first.`, { status: result.status });
        case 'assigned_elsewhere':
          return refuse(409, 'phone_number_assigned_elsewhere',
            `This number is assigned to ${result.tenantCount === 1 ? '1 other tenant' : `${result.tenantCount} other tenants`}. `
            + `Unassign it from ${result.tenantCount === 1 ? 'that tenant' : 'them'} first.`,
            { tenant_count: result.tenantCount });
        case 'in_use':
          return refuse(409, 'phone_number_in_use', pinInUseMessage(result.total, result.campaigns), {
            campaigns_total: result.total, campaigns: result.campaigns,
          });
      }
    }

    // Campaigns on the credential may dial from it now; the service's own campaigns never did.
    invalidateDialableCallerIds();
    log.info({ phoneNumberId: id, telephonyCredentialId: credentialId, tenantId: result.tenantId }, 'Phone number moved onto a tenant carrier account');
    void recordSuperAdminAudit({
      admin_id: request.superAdmin!.id,
      admin_email: request.superAdmin!.email,
      action: 'pin_phone_number',
      resource_type: 'phone_number',
      resource_id: id,
      details: { phone_number: result.phoneNumber.phone_number, telephony_credential_id: credentialId, tenant_id: result.tenantId },
    });
    return reply.send({ phone_number: toWirePhoneNumber(result.phoneNumber), tenant_id: result.tenantId });
  });

  // ── Assignments ─────────────────────────────────────────

  /**
   * POST /super-admin/phone-numbers/:id/assign
   * Assign a phone number to a tenant.
   */
  app.post('/phone-numbers/:id/assign', async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = request.params;
    const parsed = parseOr400(assignPhoneNumberSchema, request.body, reply, 'platform');
    if (!parsed) return reply;

    const { tenant_id, is_default } = parsed.data;

    // Verify phone number exists and is active
    const phoneNumber = await phoneNumberRepository.findById(id);
    if (!phoneNumber) {
      return reply.code(404).send({ error: 'Not Found', message: 'Phone number not found' });
    }
    if (phoneNumber.status !== 'active') {
      return reply.code(400).send({ error: 'Bad Request', message: 'Phone number is not active' });
    }
    // A number pinned to a tenant's carrier account (synced, or added by hand onto it, CR7)
    // belongs to that tenant: assigning it to another would let that tenant's calls present a
    // number billed to, and dialled on, someone else's account. The repository's insert
    // enforces it on the credential (`PhoneNumberOtherTenantError`), for every caller.
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
      if (err instanceof PhoneNumberOtherTenantError) {
        return reply.code(409).send({
          error: 'Conflict',
          message: 'This number is on another tenant’s own carrier account and can only be assigned to that tenant',
        });
      }
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
   * Unassign a phone number from a tenant. A number linked to inbound on its credential's tenant
   * is unlinked (the §8.2 cascade, module note).
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

    invalidateDialableCallerIds();
    await cascade(request, id, 'unassigned');
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
