/*
 * The attempt spine's read surface: the attempt and contact pages (with the CSV export's
 * ownership-proven fast path), one attempt with its call, its recording and recording URL,
 * and one contact. Part of `agency-campaigns.routes.ts`.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getTenantId, getAccountId } from '../../middleware/auth.middleware.js';
import { PROVEN_CAMPAIGN_HEADER } from '../../middleware/headers.js';
import { agencyAttemptRepository, agencyContactRepository } from '../../../db/repositories/agency.repository.js';
import { clampLimit, parseAttemptFilters, parseContactFilters } from '../../../agency/spine-filters.js';
import type { AgencyAttemptRow } from '@magick-agency/contracts/agency';
// The agency-native call read. The `webrtc_calls` repository takes a scope, and
// this plugin reads under `'agency'`.
import { webrtcCallRepository } from '@magick-agency/db/repositories/agency-call.repository';
import { formatWebRtcCallResponse } from '../../responses/webrtc-call.response.js';
import { isDirectRecordingProvider } from '../../../utils/recording-url-resolver.js';
import type { WebRtcCallRecord } from '@magick-agency/db/models/agency-call.model';
import { replyValidationFailed } from '../helpers/parse-or-400.js';
// `?cursor=`, shared with the per-agent attempt record (`agency-agents.routes.ts`).
import { readKeysetCursor } from '../helpers/read-cursor.js';
import { UUID_RE } from '../../../utils/uuid.js';
import { campaignOf, gate, ownedCampaign, requireOwned } from './guards.js';

/*
 * Route params reaching a `::uuid` cast are shape-checked first, against the shared
 * `UUID_RE`: Postgres answers `22P02 invalid input syntax for type uuid` on a malformed
 * one, which the error handler turns into a 500 — so a bad request would look like a
 * broken service on a read route. A 404 is both the honest status and the one that keeps
 * a nonexistent id indistinguishable from a forbidden one.
 */

/** Registered by `agencyCampaignRoutes` on its own instance, after its `authMiddleware`. */
export async function registerCampaignSpineRoutes(app: FastifyInstance): Promise<void> {
  // ── The attempt spine's read surface ────────────────────────────
  //
  // `agency_call_attempts` is the audit spine (one row
  // per dial), and these routes are what read it. The aggregate counters on
  // `/stats` cannot answer per-number questions, and `/app/calls/dialer/history`
  // is a CALL list that structurally cannot show an attempt which never
  // connected, a suppressed contact, or a disposition. A supervisor needs not
  // only "Manas stopped the campaign at 14:22" but "we dialled this number four
  // times and Ravi marked it Not Interested" — and the second is what a
  // compliance request asks for.
  //
  // ── These are TENANT-FACING routes, and they are on the right plugin ───────
  //
  // This is campaign data, not the audit trail. It belongs beside `/stats`, with
  // the same auth, the same feature gate and the same `requireOwned` scoping.
  // Being on THIS plugin is what gives it all three: auth middleware is
  // registered per-route-plugin rather than globally, so a route on a sibling
  // plugin inherits nothing.
  //
  // Getting it wrong here would ship an unauthenticated endpoint serving every
  // customer's phone number. `test/unit/agency/spine-read-routes.test.ts` asserts
  // the middleware runs on both routes rather than trusting this comment.

  /**
   * The two spine page reads' gate and ownership step, with the CSV export's fast path.
   *
   * The public export proves ownership ONCE — a full `GET /:id` (this plugin's gate and
   * `requireOwned`) with the same tenant and account — and then drains up to 100 pages.
   * It names that campaign in `x-mgkvc-proven-campaign` (`callCore`'s typed
   * `provenCampaignId`, never a forwarded header), and a page read for exactly that
   * campaign skips the flag read and the campaign read it would otherwise repeat on every
   * page. Any other request — no header, or a header naming a different campaign — takes
   * the ordinary path. Returns the campaign id to read, or `null` once it has replied.
   */
  async function spinePageCampaignId(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<string | null> {
    const proven = request.headers[PROVEN_CAMPAIGN_HEADER];
    if (typeof proven === 'string' && proven === request.params.id) return request.params.id;
    if (!(await gate(request, reply))) return null;
    const campaign = await requireOwned(request, reply);
    return campaign ? campaign.id : null;
  }

  // ── GET /api/v1/agency-campaigns/:id/attempts ────────────────────────────
  app.get<{ Params: { id: string } }>('/:id/attempts', async (request, reply) => {
    const campaignId = await spinePageCampaignId(request, reply);
    if (!campaignId) return reply;

    const parsed = parseAttemptFilters((request.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) {
      return replyValidationFailed(reply, parsed.issues);
    }
    /*
     * `?agent_user_id=` is shape-checked here. `agency_agent_sessions.agent_user_id`
     * is typed `UUID`, so a non-UUID value would reach `listForCampaign`'s
     * `agent_user_id = $n` as Postgres `22P02` — a 500 on a read route — and the
     * console's spine and CSV export both forward this filter as given (the public API
     * layer's `forwardAllowedQuery`). Refused with the parser's own 400 shape, the
     * answer `parseAttemptFilters` already gives a malformed `contact_id`.
     */
    if (parsed.filters.agentUserId !== undefined && !UUID_RE.test(parsed.filters.agentUserId)) {
      return replyValidationFailed(reply, [{ param: 'agent_user_id', message: 'must be an agent id' }]);
    }
    const cursor = readKeysetCursor(request, reply);
    if (cursor === null) return reply;

    const page = await agencyAttemptRepository.listForCampaign({
      campaignId,
      filters: parsed.filters,
      ...(cursor ? { after: cursor } : {}),
      limit: clampLimit((request.query as { limit?: unknown } | undefined)?.limit),
    });
    return reply.send(page);
  });

  // ── The agency-native call read ──────────────────────────────
  //
  // Without this surface the agency workspace would have to link its attempt rows
  // to a generic call page outside `AgencyLayout`, with the campaign context and
  // the list the reader came from both gone.
  //
  // It reaches the call through the ATTEMPT, which is the right spine for it: the
  // attempt is what the reader clicked, it is campaign-scoped (so ownership is
  // already proved), and it survives the call. Reaching the call by its own id
  // would need a second ownership proof and would still have nothing to say when
  // the row is gone.
  //
  // ── Why the call is fetched separately rather than joined ──────────────────
  //
  // `agency_call_attempts.webrtc_call_id` is deliberately un-FK'd:
  // both sides are on retention purges with independent windows, so either can
  // outlive the other and a cascade in either direction would destroy the other's
  // audit trail. A join would therefore silently drop exactly the attempts whose
  // call has aged out — the rows a compliance request is most likely to be about.
  // Two reads, and the second one being empty is a fact to report rather than an
  // error.

  /** Where this surface serves an agency leg's recording bytes. */
  function agencyRecordingPath(campaignId: string, attemptId: string): string {
    return `/api/v1/agency-campaigns/${campaignId}/attempts/${attemptId}/recording`;
  }

  /**
   * The attempt, plus its call when the call is still there.
   *
   * Returns `null` once it has replied. `call` is null in two different
   * situations and `call_availability` is what tells them apart:
   *
   *  - `never_placed` — the attempt has no `webrtc_call_id`. It failed a pre-dial
   *    gate, or was abandoned before a leg was placed. There was never a call.
   *  - `purged` — there was a call and its row has aged out of retention.
   *  - `available` — the call is there.
   *
   * The distinction is not cosmetic. "We never dialled this number" and "we
   * dialled it and the recording has expired" are different answers to a
   * compliance question, and collapsing them into one empty state would make the
   * spine unable to give either.
   */
  async function readAttemptCall(
    request: FastifyRequest<{ Params: { id: string; attemptId: string } }>,
    reply: FastifyReply,
  ): Promise<{
    attempt: AgencyAttemptRow;
    call: WebRtcCallRecord | null;
    availability: 'available' | 'purged' | 'never_placed';
  } | null> {
    const campaign = campaignOf(request);

    /*
     * Checked before the query, for the same reason the contact route checks its
     * id: `findForCampaign` compares against a `uuid` column, so a malformed
     * attemptId reaches Postgres as `22P02` and the error handler turns it into a
     * 500 — a bad request that looks like a broken service on a read route. A 404
     * is both the honest status and the one that keeps a nonexistent id
     * indistinguishable from one on someone else's campaign.
     */
    if (!UUID_RE.test(request.params.attemptId)) {
      reply.code(404).send({
        error: 'Not Found', code: 'attempt_not_found', message: 'Attempt not found on this campaign',
      });
      return null;
    }

    const attempt = await agencyAttemptRepository.findForCampaign(campaign.id, request.params.attemptId);
    if (!attempt) {
      reply.code(404).send({
        error: 'Not Found', code: 'attempt_not_found', message: 'Attempt not found on this campaign',
      });
      return null;
    }

    if (!attempt.webrtc_call_id) return { attempt, call: null, availability: 'never_placed' };

    /*
     * `'agency'` scope. The repository's scope is a required parameter rather
     * than a hardcoded predicate, so every read states the population it means.
     *
     * Tenant/account still bound, so a campaign whose row was somehow reachable
     * cannot be used to read another tenant's call.
     */
    const call = await webrtcCallRepository.findByIdScoped(
      attempt.webrtc_call_id, getTenantId(request), getAccountId(request), 'agency',
    );
    return call
      ? { attempt, call, availability: 'available' }
      : { attempt, call: null, availability: 'purged' };
  }

  // ── GET /api/v1/agency-campaigns/:id/attempts/:attemptId ──────────────────
  app.get<{ Params: { id: string; attemptId: string } }>(
    '/:id/attempts/:attemptId',
    { preHandler: ownedCampaign({ gated: true }) },
    async (request, reply) => {
      const found = await readAttemptCall(request, reply);
      if (!found) return reply;

      return reply.send({
        attempt: found.attempt,
        call: found.call
          ? formatWebRtcCallResponse(
              found.call,
              agencyRecordingPath(request.params.id, found.attempt.id),
            )
          : null,
        call_availability: found.availability,
      });
    },
  );

  // ── GET /api/v1/agency-campaigns/:id/attempts/:attemptId/recording ────────
  //
  // Streams the recording through the authenticated proxy, so the raw auth-gated
  // carrier URL is never handed to a client.
  app.get<{ Params: { id: string; attemptId: string } }>(
    '/:id/attempts/:attemptId/recording',
    { preHandler: ownedCampaign({ gated: true }) },
    async (request, reply) => {
      const found = await readAttemptCall(request, reply);
      if (!found) return reply;
      if (!found.call) {
        return reply.code(404).send({
          error: 'Not Found',
          code: found.availability === 'purged' ? 'call_purged' : 'call_never_placed',
          message: found.availability === 'purged'
            ? 'The call for this attempt is no longer available'
            : 'No call was placed for this attempt',
        });
      }
      // Dynamic import keeps the config-loading recording-proxy module out of this
      // route module's import graph.
      const { proxyCallRecording } = await import('../../../utils/recording-proxy.js');
      // `proxyCallRecording` takes the recording-host allow-list as a parameter
      // (`config.voicelinkRecording.allowedHosts`, from `VOICELINK_RECORDING_HOSTS`).
      // Same dynamic-import posture for the config.
      const { config } = await import('../../../config/index.js');
      return proxyCallRecording(found.call, request, reply, config.voicelinkRecording.allowedHosts);
    },
  );

  // ── GET /api/v1/agency-campaigns/:id/attempts/:attemptId/recording-url ────
  //
  // Short-lived signed URL, so the console can put an agency recording straight
  // into an `<audio src>` without forwarding tenant/account headers. It resolves
  // against `/api/v1/webrtc-recordings`, the SHARED playback proxy — that route is
  // deliberately scope-agnostic because the signed token IS the authorization, and
  // this route is the agency-gated minter of it (see the header comment on
  // `webrtc-recordings.routes.ts`).
  app.get<{ Params: { id: string; attemptId: string } }>(
    '/:id/attempts/:attemptId/recording-url',
    { preHandler: ownedCampaign({ gated: true }) },
    async (request, reply) => {
      const found = await readAttemptCall(request, reply);
      if (!found) return reply;
      if (!found.call) {
        return reply.code(404).send({
          error: 'Not Found',
          code: found.availability === 'purged' ? 'call_purged' : 'call_never_placed',
          message: found.availability === 'purged'
            ? 'The call for this attempt is no longer available'
            : 'No call was placed for this attempt',
        });
      }
      if (!found.call.recording_url) {
        return reply.code(404).send({
          error: 'Not Found', code: 'no_recording', message: 'No recording available for this call',
        });
      }
      // Direct-recording providers (VoiceLink): signing points playback at the
      // shared proxy, whose egress is firewalled off from the provider's recording
      // host — a 502 where the browser could fetch the file itself. Hand back the
      // raw URL, no expiry (the provider link is the durable resource). The
      // allowlist lives in one place, `isDirectRecordingProvider`.
      if (isDirectRecordingProvider(found.call.provider)) {
        return reply.send({ url: found.call.recording_url, expires_at: null });
      }
      // Dynamic import keeps the config-loading recording-url module out of this
      // route module's import graph.
      const { signRecordingUrl } = await import('../../../utils/recording-url.js');
      const signed = signRecordingUrl({
        callId: found.call.id,
        tenantId: getTenantId(request),
        accountId: getAccountId(request),
        basePath: '/api/v1/webrtc-recordings',
      });
      // `.toISOString()` explicitly. Fastify's default serializer JSON.stringify's
      // a Date to the same characters, so the wire shape is the same either way;
      // what differs is the HANDLER's contract, and that is what breaks the moment
      // someone adds a response schema (which would coerce or reject a Date
      // against `type: 'string'`), asserts on the payload, or forwards the object
      // rather than the response.
      //
      // Formatted at the call site rather than in `signRecordingUrl`, which keeps
      // returning `expiresAt: Date`: the instant is the honest return type for a
      // signer.
      return reply.send({ url: signed.path, expires_at: signed.expiresAt.toISOString() });
    },
  );

  // ── GET /api/v1/agency-campaigns/:id/contacts ────────────────────────────
  //
  // The read of what the roster ingest writes.
  app.get<{ Params: { id: string } }>('/:id/contacts', async (request, reply) => {
    const campaignId = await spinePageCampaignId(request, reply);
    if (!campaignId) return reply;

    const parsed = parseContactFilters((request.query ?? {}) as Record<string, unknown>);
    if (!parsed.ok) {
      return replyValidationFailed(reply, parsed.issues);
    }
    const cursor = readKeysetCursor(request, reply);
    if (cursor === null) return reply;

    const page = await agencyContactRepository.listForCampaign({
      campaignId,
      filters: parsed.filters,
      ...(cursor ? { after: cursor } : {}),
      limit: clampLimit((request.query as { limit?: unknown } | undefined)?.limit),
    });
    return reply.send(page);
  });

  /**
   * GET /api/v1/agency-campaigns/:id/contacts/:contactId — the drill-down's row.
   *
   * The only read that carries `context`. Scoped by BOTH ids in one predicate:
   * `requireOwned` proves the caller owns the campaign and says nothing about
   * the contact, so a contact id from another campaign — or another tenant —
   * would otherwise resolve through a route the caller is legitimately
   * authorised for.
   *
   * A contact outside this campaign is a 404 with the same body as one that does
   * not exist, so the route cannot be used to test whether an id is real.
   */
  app.get<{ Params: { id: string; contactId: string } }>('/:id/contacts/:contactId', {
    preHandler: ownedCampaign({ gated: true }),
  }, async (request, reply) => {
    const campaign = campaignOf(request);

    // Checked before the query: `findDetailScoped` casts to `uuid`, and a
    // non-UUID id would reach Postgres as `22P02` and surface as a 500 — a bad
    // request that looks like a broken service.
    if (!UUID_RE.test(request.params.contactId)) {
      return reply.code(404).send({
        error: 'Not Found', code: 'contact_not_found', message: 'Contact not found',
      });
    }

    const contact = await agencyContactRepository.findDetailScoped(campaign.id, request.params.contactId);
    if (!contact) {
      return reply.code(404).send({
        error: 'Not Found', code: 'contact_not_found', message: 'Contact not found',
      });
    }
    return reply.send(contact);
  });
}
