import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { webrtcCallRepository } from '@magick-agency/db/repositories/agency-call.repository';
import { verifyRecordingToken } from '../../utils/recording-url.js';
import { proxyCallRecording } from '../../utils/recording-proxy.js';
import { createChildLogger } from '@magick-agency/observability';

/*
 * PORT NOTE (magick-agency): ported from core `src/api/routes/webrtc-recordings.routes.ts`
 * (v1.123.2). The token check, tenant/account re-check and 403/404 bodies are
 * core's, verbatim. Changes (PORTING.md): `proxyCallRecording` takes the VoiceLink
 * recording-host allow-list (`allowedHosts` option; empty = refuse every proxy);
 * the prose below describes core's three minters - agency has the third only (the
 * attempt recording-url route, lane B / Phase 8), the softphone minter is deleted.
 */

const log = createChildLogger({ component: 'webrtc-recordings-routes' });

/**
 * Unauthenticated WebRTC recording playback endpoint, protected by a signed query
 * token. The WebRTC analogue of `recordings.routes.ts` (AI calls): the signed URL
 * is issued by the authenticated `GET /api/v1/webrtc-call/:id/recording-url` route,
 * so the raw VoiceLink recording URL can be played directly in an
 * `<audio src>` without forwarding tenant/account headers from the browser. The
 * proxy streams the carrier-hosted MP3 (no upstream credentials).
 *
 * ── Why this route is deliberately scope-agnostic ──────────────────────────
 *
 * It uses the unscoped `findById`, so on its own it would serve an agency
 * power-dialer leg's recording as readily as a softphone call's. That is correct,
 * and the invariant that makes it safe is: **the signed token IS the
 * authorization, and every route that mints one is scope-gated.**
 *
 * There are exactly THREE minters — `signRecordingUrl` is called only from:
 *
 *   1. `calls.routes.ts` — AI calls, a different table entirely.
 *   2. `webrtc-call.routes.ts`'s `GET /:id/recording-url` — reaches its record
 *      through `findByIdScoped(…, 'dialer')`, so it 404s an agency row.
 *   3. `agency-campaigns.routes.ts`'s
 *      `GET /:id/attempts/:attemptId/recording-url` — reaches its record through
 *      the campaign's own ownership check and `findByIdScoped(…, 'agency')`.
 *
 * Each is scope-gated, and the token is bound to one call id (the id is inside
 * the HMAC — see `signRecordingUrl`), so a token cannot be replayed against
 * another row. This route additionally re-checks the record's tenant and account
 * against the token's principal below.
 *
 * So do NOT pin a scope here. This is the shared playback surface every
 * product's signed URLs point at; pinning `'dialer'` would break agency playback
 * while adding no security the minters do not already provide. **If you add a
 * fourth minter, gate it, and update the list above** — the exhaustiveness of
 * that list is the whole argument for leaving an unauthenticated route unscoped,
 * so a stale list is a silently weakened one.
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
