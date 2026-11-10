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
 *
 * ── Preview: what a recording sounds like ────────────────────────────────────────
 * The editor's play buttons (§8.4). Same roles and flag as the list (`GET /inbound/clips`), the
 * account named (`account_scope_required` otherwise), no automatic HEAD (it would open a stream
 * for nothing), `Cache-Control: private, no-store` (the console fetches each into a blob URL
 * when it is played, as a voicemail; nothing is left in a browser or proxy cache), and
 * `X-Content-Type-Options: nosniff`. The whole file, no ranges: a recording is at most
 * {@link LIMITS} `max_bytes`, and the console never asks for part of one.
 *  - `GET /inbound/clips/:id/audio`: one of the account's recordings, streamed from the bucket.
 *    The internal handler says where it is, tenant AND account scoped (another account's id, an
 *    unknown or malformed one, or an object gone from the bucket: `inbound_clip_not_found`).
 *  - `GET /inbound/clips/standard/:recording/audio`: one of our standard recordings
 *    (`AGENCY_INBOUND_STANDARD_RECORDINGS`, the WAVs under `assets/inbound/` that callers hear when
 *    a message has no recording of its own), streamed from the image. An unknown name is 404
 *    `inbound_clip_not_found`; a file missing from the image is logged and 503.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  AGENCY_INBOUND_CLIP_UPLOAD_LIMITS as LIMITS,
  AGENCY_INBOUND_STANDARD_RECORDINGS,
  type AgencyInboundStandardRecording,
} from '@magick-agency/contracts/api/agency/inbound';
import { createChildLogger } from '@magick-agency/observability';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { platformAuditLogger } from '../../../audit/platform/audit-logger.js';
import { resolvedUserAuditActor } from '../../../audit/platform/audit-actor.js';
import { deleteFile, getFileStream, isS3NotFound, isStorageConfigured, uploadFile } from '../../../storage/s3.js';
import { UUID_RE } from '../../../utils/uuid.js';
import { sendRefusal } from '../helpers/refusal.js';
import {
  inboundRecordingKey,
  inboundRecordingRefusalMessage,
  inboundRecordingSlug,
  prepareInboundRecording,
} from '../../../agency/inbound/inbound-recordings.js';
import { INBOUND_STANDARD_CLIP_FILES, inboundStandardClipDir } from '../../../agency/inbound/inbound-standard-clip-files.js';
import { callCore } from '../../core-dispatch.js';
import type { InboundClipAudioLocation } from '../agency/inbound-clips.js';
import { inboundRefusalBody, type InboundClipDeletedAudit, type InboundClipUploadedAudit } from '../agency/inbound-answer.js';
import {
  actorQuery,
  inboundAccountOrRefuse,
  inboundActorOrRefuse,
  inboundAuditTenancy,
  requireInboundEnabled,
  sendAudited,
  unwrapInboundAnswer,
} from './shared.js';

const log = createChildLogger({ component: 'proxy-agency-inbound' });

const STANDARD_RECORDINGS: ReadonlySet<string> = new Set(AGENCY_INBOUND_STANDARD_RECORDINGS);

/** The preview's headers: never kept by a browser or a proxy, never sniffed as anything but its type. */
function previewHeaders(reply: FastifyReply, contentType: string, length: number | undefined): void {
  // A recording is stored with an audio type of ours; anything else is served as bytes, never markup.
  reply.header('Content-Type', /^audio\/[a-z0-9.+-]+$/i.test(contentType) ? contentType : 'application/octet-stream');
  reply.header('Cache-Control', 'private, no-store');
  reply.header('X-Content-Type-Options', 'nosniff');
  if (length !== undefined) reply.header('Content-Length', String(length));
}

function clipNotFound(reply: FastifyReply): FastifyReply {
  const { status, body } = inboundRefusalBody({ code: 'inbound_clip_not_found' });
  return reply.code(status).send(body);
}

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
      // The object's key names the account: none, nothing is read or stored (SWE-N5).
      const accountId = inboundAccountOrRefuse(request, reply);
      if (!accountId) return reply;
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

      const key = inboundRecordingKey(request.tenantId!, accountId, rec.ext);
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
          tenantId: request.tenantId!, accountId,
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
        ...resolvedUserAuditActor(request, actor.agent_user_id),
        action: 'agency_inbound_clip.uploaded',
        resource_type: 'agency_inbound_clip',
        resource_id: unwrapped.audit.clip_id,
        details: { size_bytes: unwrapped.audit.size_bytes, duration_seconds: unwrapped.audit.duration_seconds },
      });
      return reply.code(201).send(unwrapped.answer);
    });
  });

  /** GET /proxy/agency/inbound/clips/:id/audio — one of the account's recordings, for its preview. */
  app.get<{ Params: { id: string } }>('/inbound/clips/:id/audio', { preHandler: write, exposeHeadRoute: false }, async (request, reply) => {
    if (!UUID_RE.test(request.params.id)) return clipNotFound(reply);
    const accountId = inboundAccountOrRefuse(request, reply);
    if (!accountId) return reply;
    const result = await callCore({
      method: 'GET', path: `/agency/inbound/clips/${request.params.id}/audio`, tenantId: request.tenantId!, accountId,
    });
    if (result.status !== 200) return reply.code(result.status).send(result.body);
    const where = result.body as Partial<InboundClipAudioLocation> | null;
    if (!where || typeof where.s3_key !== 'string' || typeof where.content_type !== 'string') {
      log.error({ route: 'GET /inbound/clips/:id/audio' }, 'inbound: the internal handler answered without the recording\'s location');
      return sendRefusal(reply, 502, 'core_response_unrecognised', 'The recording could not be read.');
    }
    if (!isStorageConfigured()) {
      log.error({ clipId: where.clip_id }, 'An inbound recording was asked for with no object storage configured');
      return reply.code(503).send({ error: 'Service Unavailable', message: 'Recordings cannot be played right now.' });
    }
    let object: Awaited<ReturnType<typeof getFileStream>>;
    try {
      object = await getFileStream(where.s3_key);
    } catch (err) {
      if (isS3NotFound(err)) return clipNotFound(reply);
      log.error({ err, clipId: where.clip_id }, 'Could not read an inbound recording from storage');
      return reply.code(502).send({ error: 'Bad Gateway', message: 'The recording could not be read.' });
    }
    previewHeaders(reply, where.content_type, object.contentLength);
    return reply.send(object.body);
  });

  /** GET /proxy/agency/inbound/clips/standard/:recording/audio — one of our standard recordings, for its preview. */
  app.get<{ Params: { recording: string } }>(
    '/inbound/clips/standard/:recording/audio',
    { preHandler: write, exposeHeadRoute: false },
    async (request, reply) => {
      const recording = request.params.recording;
      if (!STANDARD_RECORDINGS.has(recording)) return clipNotFound(reply);
      if (!inboundAccountOrRefuse(request, reply)) return reply;
      const file = path.join(inboundStandardClipDir(), INBOUND_STANDARD_CLIP_FILES[recording as AgencyInboundStandardRecording]);
      let size: number;
      try {
        size = (await fs.promises.stat(file)).size;
      } catch (err) {
        log.error({ err, recording, file }, 'A standard inbound recording is missing from this image');
        return reply.code(503).send({ error: 'Service Unavailable', message: 'Our standard recordings cannot be played right now.' });
      }
      previewHeaders(reply, 'audio/wav', size);
      return reply.send(fs.createReadStream(file));
    },
  );

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
    return sendAudited<InboundClipDeletedAudit>(reply, result, 'DELETE /inbound/clips/:id', async (audit) => {
      await discardObject(audit.s3_key, 'deleted');
      platformAuditLogger.log({
        ...inboundAuditTenancy(request),
        ...resolvedUserAuditActor(request, actor.agent_user_id),
        action: 'agency_inbound_clip.deleted',
        resource_type: 'agency_inbound_clip',
        resource_id: audit.clip_id,
        details: {},
      });
    }, () => reply.code(204).send());
  });
}
