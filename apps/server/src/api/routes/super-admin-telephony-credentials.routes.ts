import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { superAdminMiddleware } from '../../auth/super-admin.middleware.js';
import { recordSuperAdminAudit } from '../../audit/super-admin-audit.js';
import { createChildLogger } from '@magick-agency/observability';
import type { TelephonyCredentialRecord } from '@magick-agency/db/models/telephony-credential.model';
import type {
  TelephonyCredentialErrorCode,
  TelephonyCredentialProvidersResponse,
} from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';
import { getTelephonyCredentialService } from '../../telephony/credentials/index.js';
import type { ServiceResult, TelephonyCredentialService } from '../../telephony/credentials/credential-service.js';
import { credentialSpecs } from '../../telephony/credentials/credential-specs.js';

/*
 * Super-admin management of per-tenant carrier credentials (decisions B18–B22). The
 * wire contract is `@magick-agency/contracts/api/platform/super-admin-telephony-credentials`.
 *
 *  - The secret is write-only: no response carries it, only `secret_hint`.
 *  - A 400's `details` carry field paths and messages only, never submitted values.
 *  - Every write is audited with ids, provider, label and version, never the secret.
 */

const log = createChildLogger({ component: 'super-admin-telephony-credentials' });

const STATUS: Record<TelephonyCredentialErrorCode, number> = {
  credential_store_unavailable: 503,
  unknown_provider: 400,
  invalid_input: 400,
  tenant_not_found: 404,
  not_found: 404,
  duplicate_account: 409,
  duplicate_label: 409,
  carrier_rejected: 422,
  carrier_unreachable: 502,
  version_conflict: 409,
  invalid_transition: 409,
  in_use: 409,
};

const idParams = z.object({ id: z.string().uuid() });
const label = z.string().trim().min(1).max(100);
// Values are bounded but not otherwise inspected here: the provider's spec validates
// them, and nothing below may echo one.
const fields = z.record(z.string().max(64), z.string().max(512)).refine((f) => Object.keys(f).length <= 16, 'Too many fields');

const createBody = z.object({
  tenant_id: z.string().uuid(),
  provider: z.string().trim().min(1).max(50),
  label,
  fields,
}).strict();
const updateBody = z.object({ label }).strict();
const rotateBody = z.object({ fields, expected_version: z.number().int().min(1) }).strict();
const listQuery = z.object({
  tenant_id: z.string().uuid().optional(),
  provider: z.string().max(50).optional(),
  include_revoked: z.enum(['true', 'false']).optional(),
});

function badRequest(reply: FastifyReply, err: z.ZodError) {
  return reply.code(400).send({
    error: 'invalid_input',
    message: 'Invalid request',
    details: err.issues.map((i) => ({ path: i.path.map(String).join('.'), message: i.message })),
  });
}

function sendFailure(reply: FastifyReply, r: Extract<ServiceResult<unknown>, { ok: false }>) {
  return reply.code(STATUS[r.code]).send({ error: r.code, message: r.message, ...(r.details ? { details: r.details } : {}) });
}

function audit(request: FastifyRequest, action: string, row: TelephonyCredentialRecord, extra: Record<string, unknown> = {}) {
  void recordSuperAdminAudit({
    admin_id: request.superAdmin!.id,
    admin_email: request.superAdmin!.email,
    action,
    resource_type: 'telephony_credential',
    resource_id: row.id,
    details: {
      tenant_id: row.tenant_id, provider: row.provider, label: row.label,
      account_ref: row.account_ref, status: row.status, secret_version: row.secret_version, ...extra,
    },
  });
}

export async function superAdminTelephonyCredentialRoutes(
  app: FastifyInstance,
  opts: { service?: () => TelephonyCredentialService } = {},
): Promise<void> {
  const service = opts.service ?? getTelephonyCredentialService;
  app.addHook('preHandler', superAdminMiddleware);

  /** GET /super-admin/telephony-credential-providers — the carriers that accept tenant credentials, and their forms. */
  app.get('/telephony-credential-providers', async (_request, reply) => {
    const body: TelephonyCredentialProvidersResponse = {
      providers: credentialSpecs().map((s) => ({ provider: s.provider, display_name: s.displayName, fields: s.fields })),
      store_available: service().storeAvailable,
    };
    return reply.send(body);
  });

  /** GET /super-admin/telephony-credentials */
  app.get('/telephony-credentials', async (request, reply) => {
    const q = listQuery.safeParse(request.query ?? {});
    if (!q.success) return badRequest(reply, q.error);
    const credentials = await service().list({
      ...(q.data.tenant_id ? { tenantId: q.data.tenant_id } : {}),
      ...(q.data.provider ? { provider: q.data.provider } : {}),
      includeRevoked: q.data.include_revoked === 'true',
    });
    return reply.send({ credentials });
  });

  /** GET /super-admin/telephony-credentials/:id — with usage. */
  app.get('/telephony-credentials/:id', async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found', message: 'Credential not found' });
    const credential = await service().get(p.data.id);
    if (!credential) return reply.code(404).send({ error: 'not_found', message: 'Credential not found' });
    const usage = await service().usage(p.data.id);
    return reply.send({ credential, usage: { campaigns: usage.campaigns, in_flight_calls: usage.inFlightCalls } });
  });

  /** POST /super-admin/telephony-credentials — verified with the carrier before it is stored. */
  app.post('/telephony-credentials', async (request, reply) => {
    const b = createBody.safeParse(request.body);
    if (!b.success) return badRequest(reply, b.error);
    const r = await service().create({
      tenantId: b.data.tenant_id, provider: b.data.provider, label: b.data.label,
      fields: b.data.fields, adminId: request.superAdmin!.id,
    });
    if (!r.ok) return sendFailure(reply, r);
    log.info({ credentialId: r.value.id, tenantId: r.value.tenant_id, provider: r.value.provider }, 'Telephony credential created');
    audit(request, 'create_telephony_credential', r.value);
    return reply.code(201).send({ credential: r.value });
  });

  /** PATCH /super-admin/telephony-credentials/:id — label only. */
  app.patch('/telephony-credentials/:id', async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found', message: 'Credential not found' });
    const b = updateBody.safeParse(request.body);
    if (!b.success) return badRequest(reply, b.error);
    const r = await service().rename(p.data.id, b.data.label, request.superAdmin!.id);
    if (!r.ok) return sendFailure(reply, r);
    audit(request, 'update_telephony_credential', r.value);
    return reply.send({ credential: r.value });
  });

  /** PUT /super-admin/telephony-credentials/:id/secret — rotate; verified with the carrier first. */
  app.put('/telephony-credentials/:id/secret', async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found', message: 'Credential not found' });
    const b = rotateBody.safeParse(request.body);
    if (!b.success) return badRequest(reply, b.error);
    const r = await service().rotate(p.data.id, {
      fields: b.data.fields, expectedVersion: b.data.expected_version, adminId: request.superAdmin!.id,
    });
    if (!r.ok) return sendFailure(reply, r);
    log.info({ credentialId: r.value.id, secretVersion: r.value.secret_version }, 'Telephony credential secret rotated');
    audit(request, 'rotate_telephony_credential', r.value);
    return reply.send({ credential: r.value });
  });

  // Paths stay literal at each `app.post` (the super-admin UI's route check reads them).
  const transition = (action: string, run: (s: TelephonyCredentialService, id: string, adminId: string) => Promise<ServiceResult<TelephonyCredentialRecord>>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const p = idParams.safeParse(request.params);
      if (!p.success) return reply.code(404).send({ error: 'not_found', message: 'Credential not found' });
      const r = await run(service(), p.data.id, request.superAdmin!.id);
      if (!r.ok) return sendFailure(reply, r);
      audit(request, action, r.value);
      return reply.send({ credential: r.value });
    };

  /** POST /super-admin/telephony-credentials/:id/verify — re-ask the carrier; a refusal marks it invalid. */
  app.post('/telephony-credentials/:id/verify', transition('verify_telephony_credential', (s, id, admin) => s.verify(id, admin)));
  /** POST /super-admin/telephony-credentials/:id/disable — no new dials; live calls still hang up. */
  app.post('/telephony-credentials/:id/disable', transition('disable_telephony_credential', (s, id, admin) => s.disable(id, admin)));
  /** POST /super-admin/telephony-credentials/:id/enable */
  app.post('/telephony-credentials/:id/enable', transition('enable_telephony_credential', (s, id, admin) => s.enable(id, admin)));

  /** POST /super-admin/telephony-credentials/:id/revoke — terminal; refused while a campaign pins it. */
  app.post('/telephony-credentials/:id/revoke', async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found', message: 'Credential not found' });
    const r = await service().revoke(p.data.id, request.superAdmin!.id);
    if (!r.ok) return sendFailure(reply, r);
    log.info({ credentialId: r.value.credential.id, shredded: r.value.shredded }, 'Telephony credential revoked');
    audit(request, 'revoke_telephony_credential', r.value.credential, { shredded: r.value.shredded });
    return reply.send({ credential: r.value.credential });
  });
}
