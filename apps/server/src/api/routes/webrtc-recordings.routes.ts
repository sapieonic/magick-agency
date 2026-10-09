import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { webrtcCallRepository } from '@magick-agency/db/repositories/agency-call.repository';
import { verifyRecordingToken } from '../../utils/recording-url.js';
import { proxyCallRecording } from '../../utils/recording-proxy.js';
import { createChildLogger } from '@magick-agency/observability';

/*
 * `proxyCallRecording` takes the VoiceLink recording-host allow-list (`allowedHosts`
 * option; empty = refuse every proxy).
 */

const log = createChildLogger({ component: 'webrtc-recordings-routes' });

/**
 * Unauthenticated WebRTC recording playback endpoint, protected by a signed query
 * token. The signed URL is issued by the authenticated
 * `GET /api/v1/agency-campaigns/:id/attempts/:attemptId/recording-url` route, so
 * the raw VoiceLink recording URL can be played directly in an `<audio src>`
 * without forwarding tenant/account headers from the browser. The proxy streams
 * the carrier-hosted MP3 (no upstream credentials).
 *
 * ── Why this route is deliberately scope-agnostic ──────────────────────────
 *
 * It uses the unscoped `findById`, so on its own it would serve any leg's
 * recording, whatever its scope. That is correct, and the invariant that makes it
 * safe is: **the signed token IS the authorization, and every route that mints
 * one is scope-gated.**
 *
 * There is exactly ONE minter — `signRecordingUrl` is called only from
 * `agency-campaigns.routes.ts`'s `GET /:id/attempts/:attemptId/recording-url`,
 * which reaches its record through the campaign's own ownership check and
 * `findByIdScoped(…, 'agency')`.
 *
 * It is scope-gated, and the token is bound to one call id (the id is inside
 * the HMAC — see `signRecordingUrl`), so a token cannot be replayed against
 * another row. This route additionally re-checks the record's tenant and account
 * against the token's principal below.
 *
 * So do NOT pin a scope here: this is the shared playback surface signed URLs
 * point at, and a pinned scope adds no security the minter does not already
 * provide. **If you add a second minter, gate it, and update the list above** —
 * the exhaustiveness of that list is the whole argument for leaving an
 * unauthenticated route unscoped, so a stale list is a silently weakened one.
 */
export interface WebrtcRecordingsRoutesOptions {
  /** VoiceLink recording hosts the proxy may fetch from (`voicelinkRecording.allowedHosts`). */
  allowedHosts?: readonly string[];
}

export async function webrtcRecordingsRoutes(
  app: FastifyInstance,
  opts: WebrtcRecordingsRoutesOptions = {},
): Promise<void> {
  const allowedHosts = opts.allowedHosts ?? [];
  app.get('/:id', async (
    request: FastifyRequest<{
      Params: { id: string };
      Querystring: { tenant?: string; account?: string; exp?: string; sig?: string };
    }>,
    reply: FastifyReply,
  ) => {
    const { id } = request.params;
    const principal = verifyRecordingToken(id, request.query);
    if (!principal) {
      log.warn({ callId: id }, 'WebRTC recording URL signature invalid or expired');
      return reply.code(403).send({ error: 'Forbidden', message: 'Invalid or expired URL' });
    }

    const callRecord = await webrtcCallRepository.findById(id);
    if (
      !callRecord ||
      callRecord.tenant_id !== principal.tenantId ||
      callRecord.account_id !== principal.accountId
    ) {
      return reply.code(404).send({ error: 'Not Found', message: 'WebRTC call not found' });
    }

    return proxyCallRecording(callRecord, request, reply, allowedHosts);
  });
}
