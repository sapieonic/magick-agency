/*
 * The account's recordings for inbound routes, internal handlers (docs/inbound.md §8.4), on the
 * internal handler instance under `/api/v1/agency` (decision B16), beside `./inbound.ts`:
 *
 *  - `POST /inbound/clips`: record a recording the public layer has already checked, decoded and
 *    stored (`agency/inbound/inbound-recordings.ts`; the bytes never travel through `callCore`,
 *    which buffers JSON). The key must be one the public layer mints for THIS tenant and account
 *    (`isInboundRecordingKey`), so a request can never record another account's object as its own.
 *    A name the account already uses is `inbound_clip_name_taken` (the table's unique name).
 *  - `DELETE /inbound/clips/:id`: delete one, refused `inbound_clip_in_use` (naming the routes)
 *    while a live route or an active announcement uses it (`deleteUnused`, under the file's row
 *    lock). The object's key goes back in the audit envelope for the public layer to remove once
 *    this has committed.
 *  - `GET /inbound/clips/:id/audio`: where one of the account's recordings is stored, for the
 *    public layer to stream it to the route editor's preview (the bytes never travel through
 *    `callCore`). Tenant AND account scoped (`findByIdScoped`): another account's id is
 *    `inbound_clip_not_found`, as an unknown one is.
 *
 * `GET /inbound/clips` stays in `./inbound.ts` with the other route editor choices.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  AGENCY_INBOUND_CLIP_UPLOAD_LIMITS as LIMITS,
  type AgencyInboundClipResponse,
} from '@magick-agency/contracts/api/agency/inbound';
import { getPool } from '@magick-agency/db';
import { isUniqueViolation } from '@magick-agency/db/pg-errors';
import { withTransaction } from '@magick-agency/db/utils/transaction';
import { audioFileRepository } from '@magick-agency/db/repositories/audio-file.repository';
import { getAccountId, getTenantId } from '../../middleware/auth.middleware.js';
import { agencyInboundClipRepository } from '../../../db/repositories/agency.repository.js';
import { isInboundRecordingKey } from '../../../agency/inbound/inbound-recordings.js';
import { UUID_RE } from '../../../utils/uuid.js';
import { sendRefusal } from '../helpers/refusal.js';
import {
  sendInboundAnswer,
  sendInboundRefusal,
  type InboundClipDeletedAudit,
  type InboundClipUploadedAudit,
  type InboundRefusal,
} from './inbound-answer.js';
import { queryActor } from './inbound.js';

/** Where a recording's bytes are, for the public layer's preview stream (`GET /inbound/clips/:id/audio`). */
export interface InboundClipAudioLocation {
  clip_id: string;
  s3_key: string;
  content_type: string;
}

/** The unique name of `audio_files` (tenant, account, name). */
const AUDIO_FILE_NAME_UNIQUE = 'audio_files_tenant_account_name_key';

/** What the public layer sends once the object is stored. */
const recordBody = z.object({
  name: z.string().trim().min(1).max(LIMITS.name_max),
  slug: z.string().min(1).max(255),
  original_filename: z.string().min(1).max(500),
  content_type: z.enum(['audio/wav', 'audio/mpeg', 'audio/ogg']),
  size_bytes: z.number().int().min(1).max(LIMITS.max_bytes),
  s3_key: z.string().min(1).max(1000),
  duration_seconds: z.number().positive().max(LIMITS.max_seconds),
  pcm_audio_hash: z.string().regex(/^[0-9a-f]{40}$/),
  pcm_sample_rate: z.number().int().positive(),
}).strict();

export async function registerInboundClipRoutes(sub: FastifyInstance): Promise<void> {
  // ── POST /inbound/clips — record a stored recording ───────────────────────
  sub.post('/inbound/clips', async (request, reply) => {
    if (!queryActor(request, reply)) return reply;
    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);
    const parsed = recordBody.safeParse(request.body);
    if (!parsed.success || !isInboundRecordingKey(parsed.data.s3_key, tenantId, accountId)) {
      // A contract violation between the two layers, never a user's mistake: the public layer
      // validated the file and minted the key.
      return sendRefusal(reply, 400, 'invalid_recording', 'The recording to record is invalid.');
    }
    const b = parsed.data;
    let id: string;
    try {
      const row = await audioFileRepository.create({
        tenant_id: tenantId, account_id: accountId, name: b.name, slug: b.slug,
        original_filename: b.original_filename, content_type: b.content_type, size_bytes: b.size_bytes,
        s3_key: b.s3_key, duration_seconds: b.duration_seconds,
        pcm_audio_hash: b.pcm_audio_hash, pcm_sample_rate: b.pcm_sample_rate, pcm_channels: 1,
      });
      id = row.id;
    } catch (err) {
      if (isUniqueViolation(err, AUDIO_FILE_NAME_UNIQUE)) return sendInboundRefusal(reply, { code: 'inbound_clip_name_taken' });
      throw err;
    }
    const clip = await agencyInboundClipRepository.findOption(tenantId, accountId, id);
    if (!clip) return sendInboundRefusal(reply, { code: 'inbound_clip_not_found' });
    const audit: InboundClipUploadedAudit = { clip_id: id, size_bytes: b.size_bytes, duration_seconds: b.duration_seconds };
    return sendInboundAnswer<AgencyInboundClipResponse, InboundClipUploadedAudit>(reply, 201, { clip }, audit);
  });

  // ── GET /inbound/clips/:id/audio — where a recording is stored, for its preview ──
  sub.get<{ Params: { id: string } }>('/inbound/clips/:id/audio', async (request, reply) => {
    const id = request.params.id;
    if (!UUID_RE.test(id)) return sendInboundRefusal(reply, { code: 'inbound_clip_not_found' });
    const file = await audioFileRepository.findByIdScoped(id.toLowerCase(), getTenantId(request), getAccountId(request));
    if (!file) return sendInboundRefusal(reply, { code: 'inbound_clip_not_found' });
    const where: InboundClipAudioLocation = { clip_id: file.id, s3_key: file.s3_key, content_type: file.content_type };
    return reply.send(where);
  });

  // ── DELETE /inbound/clips/:id — refused while something uses it ───────────
  sub.delete<{ Params: { id: string } }>('/inbound/clips/:id', async (request, reply) => {
    if (!queryActor(request, reply)) return reply;
    const id = request.params.id;
    if (!UUID_RE.test(id)) return sendInboundRefusal(reply, { code: 'inbound_clip_not_found' });
    const tenantId = getTenantId(request);
    const accountId = getAccountId(request);
    const out = await withTransaction(
      (client) => agencyInboundClipRepository.deleteUnused(client, tenantId, accountId, id.toLowerCase()),
      { pool: getPool() },
    );
    if (out.result === 'not_found') return sendInboundRefusal(reply, { code: 'inbound_clip_not_found' });
    if (out.result === 'in_use') {
      const refusal: InboundRefusal = { code: 'inbound_clip_in_use', routes: out.routes };
      return sendInboundRefusal(reply, refusal);
    }
    const audit: InboundClipDeletedAudit = { clip_id: id.toLowerCase(), s3_key: out.s3Key };
    return sendInboundAnswer(reply, 200, null, audit);
  });
}
