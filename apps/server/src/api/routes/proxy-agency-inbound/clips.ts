/*
 * The account's recordings for inbound routes (docs/inbound.md §8.4): upload one from the route
 * editor, delete one no route uses. `agency.inbound.write` (whoever may edit the routes) and the
 * flag, as the routes. Part of `proxy-agency-inbound.routes.ts`; `GET /inbound/clips` (the list)
 * is with the routes (`./routes.ts`).
 *
 * ── Upload: checked before anything is stored ────────────────────────────────────
 * Multipart is registered in a sub-plugin for this one route (as the roster upload's), so no
 * other inbound route has a body parser in front of it, and its file size limit is the
 * contract's (`AGENCY_INBOUND_CLIP_UPLOAD_LIMITS.max_bytes`; over it: 413 `inbound_clip_invalid`,
 * `too_large`). In order: the deployment has audio storage (else 503
 * `inbound_clip_storage_unavailable`, before the body is read); the file is read and decoded
 * whole (`prepareInboundRecording`: type, name, length; an undecodable file is refused 400
 * `inbound_clip_invalid` with its `upload_reason`); the object is stored under a fresh key of this
 * tenant and account; the internal handler records the row (`./../agency/inbound-clips.ts`). A row
 * that cannot be written (the name taken, a fault) deletes the object again, best-effort, so no
 * object is left that nothing names. Audited `agency_inbound_clip.uploaded`.
 *
 * ── Delete ───────────────────────────────────────────────────────────────────────
 * The internal handler deletes the row unless a live route (or an active announcement) uses it
 * (409 `inbound_clip_in_use`, naming the routes); then the object is removed here, best-effort
 * (a failure is logged: the row is gone, so nothing plays it). Audited `agency_inbound_clip.deleted`.
 * A malformed id is `inbound_clip_not_found`, answered here before any internal path is built.
 */
import type { FastifyInstance } from 'fastify';
import { AGENCY_INBOUND_CLIP_UPLOAD_LIMITS as LIMITS } from '@magick-agency/contracts/api/agency/inbound';
import { createChildLogger } from '@magick-agency/observability';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { resolvedUserAuditActor } from '../../../audit/platform/audit-actor.js';
import { deleteFile, isStorageConfigured, uploadFile } from '../../../storage/s3.js';
import { UUID_RE } from '../../../utils/uuid.js';
import {
  inboundRecordingKey,
  inboundRecordingRefusalMessage,
  inboundRecordingSlug,
  prepareInboundRecording,
} from '../../../agency/inbound/inbound-recordings.js';
import { callCore } from '../../core-dispatch.js';
import { inboundRefusalBody, type InboundClipDeletedAudit, type InboundClipUploadedAudit } from '../agency/inbound-answer.js';
import {
  actorQuery,
  inboundActorOrRefuse,
  inboundAuditTenancy,
  requireInboundEnabled,
  unwrapInboundAnswer,
} from './shared.js';

const log = createChildLogger({ component: 'proxy-agency-inbound' });

/** Remove an object nothing names any more; a failure is logged, never thrown. */
async function discardObject(key: string, why: string): Promise<void> {
  await deleteFile(key).catch((err: unknown) => log.warn({ err, key, why }, 'Could not delete an inbound recording object'));
}

export async function registerInboundClipRoutes(app: FastifyInstance): Promise<void> {
  const write = [requirePermission('agency.inbound.write'), requireInboundEnabled];

  await app.register(async function inboundClipUploadPlugin(sub) {
    // A child of the inbound plugin: its session, tenant and path-param hooks apply already.
    await sub.register(import('@fastify/multipart'), {
      limits: { fileSize: LIMITS.max_bytes, files: 1, fields: 2, fieldSize: 1024 },
    });

    /** POST /proxy/agency/inbound/clips — 201 `{ clip }`. */
    sub.post('/inbound/clips', { preHandler: write }, async (request, reply) => {
      const actor = inboundActorOrRefuse(request, reply);
      if (!actor) return reply;
      if (!isStorageConfigured()) {
        // A reviewed, fixed-shape 503 of ours: the error mask passes it, so the console reads its code.
        request.preserveReviewedUpstreamError = true;
        const { status, body } = inboundRefusalBody({ code: 'inbound_clip_storage_unavailable' });
        return reply.code(status).send(body);
      }
      const refuse = (reason: Parameters<typeof inboundRecordingRefusalMessage>[0]) => {
        const { status, body } = inboundRefusalBody({
          code: 'inbound_clip_invalid', upload_reason: reason, message: inboundRecordingRefusalMessage(reason),
        });
        return reply.code(status).send(body);
      };

      let file;
      let bytes: Buffer;
      try {
        file = await request.file();
        if (!file) return refuse('no_file');
        bytes = await file.toBuffer();
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code === 'FST_REQ_FILE_TOO_LARGE') return refuse('too_large');
        if (code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') return refuse('no_file');
        // A body cut off mid-part (busboy's `Unexpected end of form`) or over the parts limits: the
        // caller's malformed upload, as the roster upload answers it. Anything with its own status
        // keeps it.
        if (typeof (err as { statusCode?: unknown }).statusCode === 'number') throw err;
        log.warn({ err, tenantId: request.tenantId }, 'Inbound recording upload refused: malformed multipart body');
        return refuse('undecodable');
      }
      const nameField = file.fields['name'];
      const name = nameField && !Array.isArray(nameField) && nameField.type === 'field' && typeof nameField.value === 'string'
        ? nameField.value
        : undefined;

      const prepared = await prepareInboundRecording({ bytes, filename: file.filename, mimetype: file.mimetype, name });
      if (!prepared.ok) return refuse(prepared.reason);
      const rec = prepared.recording;

      const key = inboundRecordingKey(request.tenantId!, request.accountId!, rec.ext);
      await uploadFile(key, rec.bytes, rec.contentType);
      let result;
      try {
        result = await callCore({
          method: 'POST', path: '/agency/inbound/clips', query: actorQuery(actor),
          body: {
            name: rec.name, slug: inboundRecordingSlug(rec.name), original_filename: rec.originalFilename,
            content_type: rec.contentType, size_bytes: rec.bytes.length, s3_key: key,
            duration_seconds: rec.durationSeconds, pcm_audio_hash: rec.pcmHash, pcm_sample_rate: rec.pcmSampleRate,
          },
          tenantId: request.tenantId!, accountId: request.accountId,
        });
      } catch (err) {
        await discardObject(key, 'record failed');
        throw err;
      }
      if (result.status >= 400) {
        await discardObject(key, 'record refused');
        return reply.code(result.status).send(result.body);
      }
      const unwrapped = unwrapInboundAnswer<InboundClipUploadedAudit>(reply, result, 'POST /inbound/clips');
      if (!unwrapped) {
        await discardObject(key, 'record unrecognised');
        return reply;
      }
      platformAuditLogger.log({
        ...inboundAuditTenancy(request),
        ...resolvedUserAuditActor(request, actor.userId),
        action: 'agency_inbound_clip.uploaded',
        resource_type: 'agency_inbound_clip',
        resource_id: unwrapped.audit.clip_id,
        details: { size_bytes: unwrapped.audit.size_bytes, duration_seconds: unwrapped.audit.duration_seconds },
      });
      return reply.code(201).send(unwrapped.answer);
    });
  });

  /** DELETE /proxy/agency/inbound/clips/:id — 204; refused while a live route plays it. */
  app.delete<{ Params: { id: string } }>('/inbound/clips/:id', { preHandler: write }, async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) {
      const { status, body } = inboundRefusalBody({ code: 'inbound_clip_not_found' });
      return reply.code(status).send(body);
    }
    const actor = inboundActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'DELETE', path: `/agency/inbound/clips/${request.params.id}`, query: actorQuery(actor),
      tenantId: request.tenantId!, accountId: request.accountId,
    });
    if (result.status >= 400) return reply.code(result.status).send(result.body);
    const unwrapped = unwrapInboundAnswer<InboundClipDeletedAudit>(reply, result, 'DELETE /inbound/clips/:id');
    if (!unwrapped) return reply;
    await discardObject(unwrapped.audit.s3_key, 'deleted');
    platformAuditLogger.log({
      ...inboundAuditTenancy(request),
      ...resolvedUserAuditActor(request, actor.userId),
      action: 'agency_inbound_clip.deleted',
      resource_type: 'agency_inbound_clip',
      resource_id: unwrapped.audit.clip_id,
      details: {},
    });
    return reply.code(204).send();
  });
}
