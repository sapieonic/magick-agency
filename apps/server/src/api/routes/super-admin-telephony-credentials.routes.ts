import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { superAdminMiddleware } from '../../auth/super-admin.middleware.js';
import { recordSuperAdminAudit } from '../../audit/super-admin-audit.js';
import { createChildLogger } from '@magick-agency/observability';
import type { TelephonyCredentialRecord } from '@magick-agency/db/models/telephony-credential.model';
import type {
  TelephonyCredentialErrorCode,
  TelephonyCredentialProvidersResponse,
  TelephonyCredentialSyncNumbersResponse,
} from '@magick-agency/contracts/api/platform/super-admin-telephony-credentials';
import { getTelephonyCredentialService, getTelephonyInboundService } from '../../telephony/credentials/index.js';
import type { ServiceResult, TelephonyCredentialService } from '../../telephony/credentials/credential-service.js';
import type { TelephonyInboundService } from '../../telephony/credentials/inbound-service.js';
import { registerSuperAdminInboundRoutes } from './super-admin-telephony-credentials/inbound.js';
import { credentialSpecs } from '../../telephony/credentials/credential-specs.js';
import { safeIssues } from '../../telephony/credentials/safe-issues.js';
import { invalidateDialableCallerIds } from '../../agency/campaign-dialability.js';

/*
 * Super-admin management of per-tenant carrier credentials (decisions B18–B22). The
 * wire contract is `@magick-agency/contracts/api/platform/super-admin-telephony-credentials`.
 *
 *  - The secret is write-only: no response carries it, only `secret_hint`.
 *  - A 400's `details` carry field paths and messages only, never submitted values.
 *  - Every write is audited with ids, provider, label and version, never the secret.
 *  - Inbound on a credential and its numbers (docs/inbound.md §8): the routes in
 *    `./super-admin-telephony-credentials/inbound.ts`, on the inbound service. A number sync
 *    runs the §8.2 cascade after it lands, unlinking the numbers it retired (`retired_by_sync`).
 *    A disable keeps every link and route: the credential's calls are answered with the closed
 *    message while it is disabled, and an enable answers them as before (docs/inbound.md §10). A
 *    revoke is refused while inbound is enabled (`inbound_enabled`).
 */

const log = createChildLogger({ component: 'super-admin-telephony-credentials' });

const STATUS: Record<TelephonyCredentialErrorCode, number> = {
  credential_store_unavailable: 503,
  // Not a 5xx: the store works, this credential's secret cannot be used (shredded, or
  // sealed under a key the keyring no longer holds). Retrying does not help.
  secret_unavailable: 409,
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
  credential_not_active: 409,
  too_many_numbers: 422,
  inbound_enabled: 409,
  inbound_not_enabled: 409,
  inbound_numbers_linked: 409,
  inbound_previous_token_in_use: 409,
  // The server has no public callback base: an operator fixes the deployment, not the request.
  inbound_unconfigured: 503,
  phone_number_not_found: 404,
  phone_number_not_linkable: 409,
  phone_number_not_linked: 409,
  carrier_number_missing: 409,
  carrier_refused: 422,
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
    details: safeIssues(err.issues),
  });
}

function sendFailure(reply: FastifyReply, r: Extract<ServiceResult<unknown>, { ok: false }>) {
  // The two 5xx codes (carrier unreachable, store unavailable) are reviewed, fixed-shape
  // bodies whose messages the service authors; the app-wide error mask would otherwise
  // replace them with "contact support" and the admin would not know to retry.
  if (STATUS[r.code] >= 500) reply.request.preserveReviewedUpstreamError = true;
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
  opts: { service?: () => TelephonyCredentialService; inbound?: () => TelephonyInboundService } = {},
): Promise<void> {
  const service = opts.service ?? getTelephonyCredentialService;
  const inbound = opts.inbound ?? getTelephonyInboundService;
  const actor = (request: FastifyRequest) => ({ adminId: request.superAdmin!.id, adminEmail: request.superAdmin!.email });
  app.addHook('preHandler', superAdminMiddleware);

  registerSuperAdminInboundRoutes(app, { inbound, sendFailure });

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
  /**
   * POST /super-admin/telephony-credentials/:id/disable — no new dials; live calls still hang up.
   * Inbound is left as it is: the numbers stay linked and on their routes, and their callers hear
   * the closed message (with a Missed row) until the credential is enabled again, which answers
   * them as before (docs/inbound.md §8.2, §10). Unlink a number to send it back to its own app.
   */
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

  /**
   * POST /super-admin/telephony-credentials/:id/sync-numbers — the carrier account's voice
   * numbers become the tenant's numbers on this carrier (added, reactivated, taken over from a
   * revoked registration of the same account, retired);
   * refused unless the credential is active. Audited with the counts and the numbers
   * changed (numbers are not secret).
   */
  app.post('/telephony-credentials/:id/sync-numbers', async (request, reply) => {
    const p = idParams.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found', message: 'Credential not found' });
    const r = await service().syncNumbers(p.data.id, request.superAdmin!.id);
    if (!r.ok) return sendFailure(reply, r);
    // A number retired or reactivated is dialled (or not) from the next dial (PL13).
    invalidateDialableCallerIds();
    const { credential, sync } = r.value;
    // A linked number the sync retired is no longer the account's: out of inbound (§8.2).
    await inbound().reconcileCredential(credential.id, 'retired_by_sync', actor(request));
    log.info({
      credentialId: credential.id, listed: sync.listed, added: sync.added.length, reactivated: sync.reactivated.length,
      takenOver: sync.taken_over.length, retired: sync.retired.length, conflicts: sync.conflicts.length, active: sync.active_numbers,
    }, 'Telephony credential numbers synced');
    audit(request, 'sync_telephony_credential_numbers', credential, {
      listed: sync.listed, active_numbers: sync.active_numbers,
      added: sync.added, reactivated: sync.reactivated, taken_over: sync.taken_over, retired: sync.retired, conflicts: sync.conflicts,
    });
    // `TelephonyCredentialSyncNumbersResponse`; the row's Dates serialise to its ISO strings.
    const body: Omit<TelephonyCredentialSyncNumbersResponse, 'credential'> & { credential: TelephonyCredentialRecord } = { credential, sync };
    return reply.send(body);
  });
}
