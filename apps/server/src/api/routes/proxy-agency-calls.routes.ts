import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sessionMiddleware } from '../../auth/session.middleware.js';
import { tenantContextMiddleware } from '../middleware/tenant-context.middleware.js';
import { requirePermission } from '../../rbac/rbac.middleware.js';
import { callCore } from '../core-dispatch.js';
import { ACCOUNT_HEADER } from '../middleware/headers.js';
import { requireUuidPathParams } from './helpers/path-params.js';
import { createChildLogger } from '@magick-agency/observability';
import { accountSettingsRepository } from '@magick-agency/db/repositories/account-settings.repository';
import { agencyCampaignRepository } from '../../db/repositories/agency.repository.js';
import { DEFAULT_ALLOW_RECORDING, DEFAULT_ANALYZE_CALLS } from '../../settings/agency-account-settings.js';

const log = createChildLogger({ component: 'proxy-agency-calls-routes' });

/*
 * The agency call read, served at the console's paths under `/proxy/agency` (decision
 * B16). Both routes run the internal handler instance's body (`agency-campaigns.routes.ts`,
 * the attempt read and its `/recording`) in-process through `callCore`. Tested in
 * `test/unit/agency/proxy-agency-calls.routes.test.ts`.
 *
 * Entitlement is the per-account settings row of the account that OWNS the campaign
 * (`allow_recording` / `analyze_calls`), read by {@link resolveOwningAccountGrants} below:
 * it drives both the field strip on the detail read and the media route's gate. NULL / no
 * row = off, any failure = off (fail closed). The media refusal is the 403 body
 * `{ error: 'capability_disabled', capability }`.
 */

/**
 * The entitlements of the campaign's OWNING account, from its settings row. The account
 * judged is the campaign's, never the request header's (the same rule as
 * `campaign-behavioral-settings.ts`).
 *
 *  - `resolved` — the campaign is the caller's (same rule as the internal handler's `requireOwned`:
 *    tenant AND account), and these are its owner's two settings, each `true` only when
 *    the column is explicitly true (NULL / no row = the documented default, `false`).
 *  - `not_owned` — no such campaign, or it is another tenant's or another account's.
 *    There is no owning account in the caller's reach whose row could be read.
 *  - `unavailable` — no tenant/account context, or a read threw. Treated as "nothing
 *    granted" by both callers (fail closed).
 *
 * Ids are UUIDs by the time this runs (`requireUuidPathParams` is a plugin hook).
 */
type OwningAccountGrants =
  | { kind: 'resolved'; recording: boolean; analytics: boolean }
  | { kind: 'not_owned' }
  | { kind: 'unavailable' };

/** The internal handler's `requireOwned` refusal (`agency-campaigns.routes.ts`), byte for byte. */
const CAMPAIGN_NOT_FOUND_BODY = {
  error: 'Not Found',
  code: 'campaign_not_found',
  message: 'Campaign not found',
} as const;

async function resolveOwningAccountGrants(
  request: FastifyRequest<{ Params: { id: string } }>,
): Promise<OwningAccountGrants> {
  const tenantId = request.tenantId;
  const accountId = request.accountId;
  if (!tenantId || !accountId) return { kind: 'unavailable' };
  try {
    const campaign = await agencyCampaignRepository.findById(request.params.id);
    if (!campaign || campaign.tenant_id !== tenantId || campaign.account_id !== accountId) {
      return { kind: 'not_owned' };
    }
    const row = await accountSettingsRepository.findByTenantAndAccount(campaign.tenant_id, campaign.account_id);
    return {
      kind: 'resolved',
      recording: (row?.allow_recording ?? DEFAULT_ALLOW_RECORDING) === true,
      analytics: (row?.analyze_calls ?? DEFAULT_ANALYZE_CALLS) === true,
    };
  } catch (err) {
    log.error({ err, tenantId, campaignId: request.params.id }, 'owning-account settings resolve failed — failing closed');
    return { kind: 'unavailable' };
  }
}

/**
 * The media route's recording gate: the owning account's `allow_recording`. Runs after
 * `requirePermission('agency.supervise')`.
 *
 * A campaign that is not the caller's answers the internal handler's own 404
 * (`campaign_not_found`) here, without calling it: there is no owner row the caller may
 * be judged by, and calling the handler without a positive grant would not be failing
 * closed. An unknown id and another account's id stay indistinguishable.
 */
async function requireOwningAccountRecording(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  // No account context: the same 400 the internal handler's `authMiddleware` gives for a
  // missing `x-mgkvc-account`, rather than the 403 the account-level settings read would
  // give (there is no account to read).
  if (!request.accountId) {
    return reply.code(400).send({ error: 'Bad Request', message: `Missing required header: ${ACCOUNT_HEADER}` });
  }
  const grants = await resolveOwningAccountGrants(request);
  if (grants.kind === 'not_owned') {
    return reply.code(404).send({ ...CAMPAIGN_NOT_FOUND_BODY });
  }
  if (grants.kind !== 'resolved' || !grants.recording) {
    return reply.code(403).send({ error: 'capability_disabled', capability: 'agency.recording' });
  }
  return undefined;
}

/**
 * ─── THE AGENCY CALL READ ────────────────────────────────────────────────────
 *
 * The call-detail surface for an agency attempt: what an attempt row in the
 * console links to, keeping the campaign context and the list the reader came
 * from. Two routes, both thin wrappers over the internal handler's
 * `/agency-campaigns/:id/attempts/:attemptId` surface.
 *
 * ── Why its own plugin on `/proxy/agency` ──────────────────────────────────
 *
 * A distinct gating pairing kept side by side on purpose, as with the
 * performance plugin. Everything here is floored at `agency.supervise`, and the
 * media route additionally requires the owning account's `allow_recording` — a
 * pairing that exists nowhere else on this prefix. Keeping it in its own file means the campaigns plugin's hooks do not
 * have to learn about recording consent, and this file can be read end to end to
 * see exactly who may hear an agency call.
 *
 * ── Why the routes are keyed on campaign + attempt, not on a call id ───────
 *
 * Because that is the shape of the thing being read. An agency call is reached
 * through its ATTEMPT: the attempt is what the reader clicked, it is
 * campaign-scoped so the internal handler can prove ownership from the path,
 * and — this is the load-bearing part — **it survives the call.** The
 * attempt→call link (`agency_call_attempts.webrtc_call_id`) is deliberately
 * un-FK'd because both sides purge on independent retention windows, so an
 * attempt routinely outlives its call.
 *
 * A `/proxy/agency/calls/:id` surface could not express that: a bare call id
 * names no campaign to authorise the read, and says nothing at all about an
 * attempt whose call has aged out. The internal handler therefore answers 200
 * with a `call_availability` marker rather than 404, and this route passes that
 * through unchanged.
 *
 * ── Gating, and what each gate actually covers ─────────────────────────────
 *
 * - `agency.supervise` (an RBAC PERMISSION, floored at `account_admin`) — on
 *   every route. Reading someone else's conversation is a
 *   supervisory act. Note the `agent` role sits at level 5, BELOW `viewer`, so an
 *   agent cannot reach these routes; if agents ever need to review their own
 *   calls that is an agency-native route with its own floor, never a change to
 *   the role level.
 * - `allow_recording` (`agency.recording`) — on the media route. Gating only
 *   *enabling* recording on a campaign (`agency/campaign-behavioral-settings.ts`)
 *   would let an account without recording still listen to recordings made
 *   before the setting changed. Gating the config write and not the playback is
 *   gating the wrong end.
 * - `analyze_calls` (`agency.analytics`) — gates the transcript and the summary
 *   as *fields* on the detail response, because they arrive inside the call
 *   object rather than on their own route. See `shapeDetailResponse`.
 *
 * ── There is deliberately no `/recording-url` here ─────────────────────────
 *
 * The internal handler has one, which signs a token against the unauthenticated
 * `/api/v1/webrtc-recordings` playback route. The console does not need it: it
 * plays recordings by fetching the bytes from `/recording` below and creating a
 * blob URL. Exposing the signed URL would be a deliberate new public surface (a
 * bearer link to the recording), and its own piece of work.
 */

/**
 * Analysis content fields, which `agency.analytics` gates.
 *
 * `analysis_sentiment_label` is included even though the internal handler omits it
 * on the detail path today: it is a scalar projected OUT of `call_analysis`, so if that
 * projection ever reaches this read, a sentiment label would survive a strip that
 * removed the blob it came from. Listing it costs nothing and closes that.
 */
const ANALYTICS_CONTENT_FIELDS = [
  'call_analysis', 'conversation_log', 'transcript_meta', 'analysis_sentiment_label',
] as const;

/**
 * ─── THE FIELDS A TENANT WITHOUT `agency.analytics` MAY SEE ─────────────────
 *
 * Mirrors `formatWebRtcCallResponse` (`src/api/responses/webrtc-call.response.ts`),
 * minus {@link ANALYTICS_CONTENT_FIELDS}. That formatter is already an allow-list
 * — deny-by-default, so a new `webrtc_calls` column is not auto-exposed — and
 * this is the same discipline one layer later, for the same reason.
 *
 * ── Why an allow-list and not a longer deny-list ───────────────────────────
 *
 * Nulling four known keys off a spread of the whole handler object fails OPEN on
 * a SCHEMA ADDITION: the day the formatter adds another transcript- or summary-derived
 * field inside the same envelope — a `call_summary`, a `sentiment_score`, a
 * `redaction_report` — it reaches a tenant who did not buy analytics, unchanged,
 * and nothing here goes red. That is the same defect class as the envelope
 * fail-open this route already fixed (`isDetailEnvelope`), one level in: the
 * envelope check made an unrecognised SHAPE fail closed, and this makes an
 * unrecognised FIELD fail closed.
 *
 * ── The trade, stated so the next person knows it is deliberate ────────────
 *
 * A new BENIGN call field is invisible to tenants without `agency.analytics`
 * until this list is updated. That is a real cost and it is accepted: the
 * alternative — a field appearing here the moment the formatter adds it — is the one that
 * leaks analysis content to a tenant who did not buy it, and the two failures are
 * not comparable. A missing benign field shows up as a blank cell in the console
 * and is fixed by one line here; a leaked transcript is not fixable after the
 * fact. **Add a field here when the formatter adds one, and never widen the strip to a
 * spread to save the edit.**
 *
 * Note the asymmetry: this governs only the WITHHELD response. A tenant WITH
 * `agency.analytics` still receives the handler's object as sent, because there is
 * nothing left to withhold from them and an allow-list on that path would hide
 * new fields from the tenants entitled to everything.
 */
const NON_ANALYTICS_CALL_FIELDS = [
  'id', 'tenant_id', 'account_id', 'caller_id', 'destination_phone',
  'provider', 'provider_call_id', 'status', 'outcome',
  'error_code', 'error_message', 'initiated_by', 'metadata',
  'recording_requested', 'recording_url', 'recording_duration_seconds',
  // Kept when analytics is off: it says whether analysis RAN, not what it found.
  // See `shapeDetailResponse`.
  'analysis_profile_id', 'analysis_status',
  'answered_at', 'ended_at', 'duration_seconds', 'talk_time_seconds',
  'created_at', 'updated_at',
] as const;

/**
 * Decode the error body `rawResponse` buffered, so a refusal on the media route
 * leaves the server as JSON rather than as `application/octet-stream`.
 *
 * `rawResponse: true` makes `callCore` return `inject`'s `rawPayload` for EVERY
 * status, the handler's 4xx included, so `send(result.body)` hands the client a
 * Buffer and Fastify types a Buffer as `application/octet-stream`. The one body
 * on that route a console MUST be able to parse is the refusal: `call_purged` is
 * what lets it say "this recording has aged out" instead of "the platform is
 * broken" (that distinction is the point of the whole surface), and
 * `no_recording` is a different sentence again. A reader that branches on
 * content type cannot reach either through octet-stream.
 *
 * The success path is untouched — those bytes really are audio.
 *
 * A Buffer that is not a JSON object is NOT forwarded as bytes: there is no code
 * in it to branch on, and forwarding it would keep the content type this exists
 * to remove. It becomes a bare envelope with no `code` and no `details`: on a 5xx
 * `errorMaskHook` rewrites it into the support-ticket body, and on a 4xx it
 * reaches the client as written. Either way it carries nothing the caller could
 * act on; it exists to fix the content type, not to be read.
 */
function decodeRawErrorBody(body: unknown): unknown {
  if (!Buffer.isBuffer(body)) return body;
  try {
    const parsed: unknown = JSON.parse(body.toString('utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {
    // Not JSON — fall through to the envelope below.
  }
  return { error: 'Upstream Error', message: 'The recording could not be returned.' };
}

/** The envelope the internal handler's attempt read answers with. */
interface DetailEnvelope {
  attempt: unknown;
  call: Record<string, unknown> | null;
  call_availability: unknown;
}

/**
 * Is this the envelope this route knows how to redact?
 *
 * Checked because the strip below has to fail CLOSED. Every other gate in this
 * file (`resolveOwningAccountGrants`, `requireOwningAccountRecording`) denies on
 * doubt, and a redaction that silently forwards whatever it does not recognise
 * is the one shape of gate that leaks by default — an array body, a string body
 * (`callCore` returns the raw payload string for a non-JSON content type), or
 * the call nested one level deeper would all sail
 * straight through a `body.call` lookup.
 */
function isDetailEnvelope(body: unknown): body is DetailEnvelope {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  if (!('attempt' in record) || !('call' in record) || !('call_availability' in record)) return false;
  const call = record['call'];
  // `null` is the purged/never-placed case and is expected.
  return call === null || (typeof call === 'object' && !Array.isArray(call));
}

/**
 * Copy only the named fields out of a response object.
 *
 * A key the handler did not send stays ABSENT rather than becoming `undefined`: the
 * response is serialised by Fastify, and while `JSON.stringify` drops an
 * `undefined` value anyway, an object carrying the key makes `'x' in call` true
 * for a field that was never there — and the only reader of this shape is a
 * console that branches on presence.
 */
function projectFields(
  source: Record<string, unknown>,
  fields: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in source) out[field] = source[field];
  }
  return out;
}

/**
 * Reshape the internal handler's response for the console: repoint the recording
 * at this plugin's own route, and remove what the account has not been granted.
 *
 * The internal handler's job is scope — it decides which product owns the call.
 * This route's job is entitlement, and these two live inside the call object
 * rather than behind their own routes, so the enforcement point is a field strip
 * rather than a 403.
 *
 * `analysis_status` is deliberately KEPT when `agency.analytics` is off. It says
 * whether analysis ran, not what it found, and keeping it lets the console show
 * "analysis is not included in your plan" rather than the same blank panel it
 * shows while analysis is still pending. Withholding the content without
 * withholding its existence is the honest cut.
 *
 * `recording_url` is nulled when `agency.recording` is off, for the same reason
 * the media route 403s: a link the tenant may not follow should not be
 * advertised. The route is the enforcement; this stops the UI offering a button
 * that will 403.
 */
function shapeDetailResponse(
  body: unknown,
  grants: { analytics: boolean; recording: boolean },
  recordingPath: string,
): { ok: true; body: unknown } | { ok: false } {
  // The envelope is always required, because there is always a transform: even a
  // fully entitled tenant needs `recording_url` moved onto a path that exists on
  // this plugin. This route is reshaping the response, so it has to understand it.
  if (!isDetailEnvelope(body)) return { ok: false };

  if (body.call === null) return { ok: true, body };

  /*
   * ── The withheld response is BUILT, not filtered ──────────────────────────
   *
   * With `agency.analytics` off, the call object is projected through
   * {@link NON_ANALYTICS_CALL_FIELDS} rather than spread and then patched. A
   * spread-and-null fails open on a schema addition: the next
   * transcript-or-summary-derived field added to this envelope would reach an
   * unentitled tenant untouched, and nothing here would notice. Projecting means
   * a field this route has not judged is simply not forwarded, which is the same
   * fail-closed posture `isDetailEnvelope` gives the envelope one level out.
   *
   * With analytics ON there is nothing to withhold, so the handler's object is
   * passed through as sent — an allow-list there would hide new fields from
   * precisely the tenants who bought all of them. See the constant's header for
   * the cost this accepts.
   */
  const nextCall: Record<string, unknown> = grants.analytics
    ? { ...body.call }
    : projectFields(body.call, NON_ANALYTICS_CALL_FIELDS);

  /*
   * Repoint the recording at THIS plugin.
   *
   * The internal handler sets `recording_url` to its own
   * `/api/v1/agency-campaigns/...` path, which is not a route on the public app.
   * Rewritten here for the same reason `rewriteStationWsUrl` exists: the handler
   * names a path in its own address space and the console needs the public one.
   *
   * Built from the request's own params rather than by rewriting the handler's
   * string, so a malformed or unexpected value cannot become a URL the server
   * hands a browser. The handler's value is used only as a PRESENCE flag — null
   * there means no recording, and that distinction has to survive.
   */
  if (nextCall['recording_url'] !== null && nextCall['recording_url'] !== undefined) {
    nextCall['recording_url'] = recordingPath;
  }

  if (!grants.analytics) {
    /*
     * The four known analytics keys are re-added as explicit `null`s rather than
     * left absent by the projection above. Absent and null are different
     * statements to a console: null says "this field exists and you were not
     * given its content", which is what lets it render "not included in your
     * plan" instead of treating the panel as broken. Only the fields on this
     * list get that courtesy — an UNRECOGNISED analytics field is dropped
     * entirely, because this route cannot claim a field exists that it has
     * never seen.
     */
    for (const field of ANALYTICS_CONTENT_FIELDS) nextCall[field] = null;
  }
  if (!grants.recording) {
    // A link the tenant may not follow must not be advertised. The media route is
    // the real enforcement; this stops the console rendering a button that 403s.
    nextCall['recording_url'] = null;
  }
  return { ok: true, body: { ...body, call: nextCall } };
}

export async function proxyAgencyCallsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', sessionMiddleware);
  app.addHook('preHandler', tenantContextMiddleware);
  // No section gate: the app is the agency product.
  /*
   * ─── THE PATH PARAMS ARE UUIDS, AND THAT IS ENFORCED ─────────────────────
   *
   * Both routes below interpolate `:id` and `:attemptId` into an internal handler path, and
   * find-my-way hands the handler a percent-DECODED param — so `%2F` arrives as a
   * real `/`.
   *
   * ── What was already covered, so this comment does not overclaim ──────────
   *
   * The `..` traversal is not the hole. `callCore` refuses any path that does
   * not survive a WHATWG parse unchanged (`isUnsafeCorePath`,
   * `src/proxy/safe-core-path.ts`), which catches `..`, `%2e%2e`, `.%2e`, `#` and
   * `\`. What it allows — correctly — is a bare extra slash, because a path with
   * no dot segments is an ordinary handler path.
   *
   * That is what matters here, because `:attemptId` is the TERMINAL segment of
   * the detail route's handler path. `attemptId = a%2Frecording` builds
   * `/agency-campaigns/:id/attempts/a/recording` — the handler's media route —
   * reached through the DETAIL route, which is floored at `agency.supervise` but
   * deliberately does NOT carry the `allow_recording` gate. That is the one gate
   * this plugin exists to enforce, and appending a segment to an id would walk
   * around it. (The envelope check would then have
   * turned the audio into a 502 rather than leaking it — `shapeDetailResponse`
   * fails closed on a shape it does not recognise — but relying on a redaction
   * to catch a routing error is relying on the wrong layer.)
   *
   * ── Why the uuid check rather than the shared character guard ─────────────
   *
   * `helpers/path-params.ts` offers both. `rejectPathEscapingParams` is the
   * minimal, behaviour-preserving one and is what the pre-existing agency plugins
   * get, because their ids are not all uuids and tightening them is a separate
   * change. Here every id IS a uuid on every real call path — a campaign id and
   * an attempt id, both `uuid` columns — so the tighter guard costs
   * nothing and buys two things: it refuses the whole space of malformed ids
   * rather than the characters that happen to be exploitable, and it answers
   * "expected a UUID", which is an error about the caller's id rather than about
   * path separators. It is also what the sibling agency plugins already do with a
   * Zod `z.string().uuid()` params schema (`proxy-agency-performance.routes.ts`,
   * `proxy-agency-staffing.routes.ts`); this is that convention hoisted to a
   * plugin hook so a route added later inherits it instead of remembering it.
   */
  app.addHook('preHandler', requireUuidPathParams());

  /**
   * GET /proxy/agency/campaigns/:id/attempts/:attemptId
   *
   * The attempt, plus its call when the call still exists. The internal handler
   * reports `call_availability` as `available` | `purged` | `never_placed` and
   * this route passes it through untouched — a purged call is a 200 with a marker, never a 404,
   * because "this attempt never happened" is a different and false statement.
   */
  app.get<{ Params: { id: string; attemptId: string } }>(
    '/campaigns/:id/attempts/:attemptId',
    { preHandler: [requirePermission('agency.supervise')] },
    async (request, reply) => {
      const tenantId = request.tenantId!;

      const result = await callCore({
        method: 'GET',
        path: `/agency-campaigns/${request.params.id}/attempts/${request.params.attemptId}`,
        tenantId,
        accountId: request.accountId,
        metricPath: '/agency-campaigns/:id/attempts/:id',
      });

      if (result.status >= 400) return reply.code(result.status).send(result.body);

      /*
       * Resolved after `callCore` rather than as preHandlers, because these
       * gate FIELDS on a successful response, not access to the route. A tenant
       * without `agency.analytics` still gets the attempt, the disposition and
       * the notes — which is the point of the surface — just not the transcript.
       */
      // The owning account's settings row (`resolveOwningAccountGrants`). Anything but a
      // resolved row grants nothing, so the strip withholds (fail closed).
      const grants = await resolveOwningAccountGrants(request);
      const analytics = grants.kind === 'resolved' && grants.analytics;
      const recording = grants.kind === 'resolved' && grants.recording;

      const stripped = shapeDetailResponse(
        result.body,
        { analytics, recording },
        `/proxy/agency/campaigns/${request.params.id}/attempts/${request.params.attemptId}/recording`,
      );
      if (!stripped.ok) {
        /*
         * The internal handler answered 200 with something this route cannot redact, and the
         * tenant is not entitled to all of it. Refusing is the only safe answer:
         * forwarding would leak whatever the strip failed to reach, and guessing
         * at the shape is how a redaction quietly stops redacting.
         *
         * A 5xx because it is a contract violation between this route and the
         * handler, not anything the caller did — and it is masked on the way out, which is
         * correct: the client can do nothing with the detail, and the log below is
         * where an operator finds it.
         */
        log.error(
          { tenantId, campaignId: request.params.id, attemptId: request.params.attemptId },
          'agency call read: the internal handler returned an unrecognised envelope and fields had to be withheld',
        );
        return reply.code(502).send({
          error: 'Bad Gateway',
          code: 'core_response_unrecognised',
          message: 'The call could not be returned.',
        });
      }

      return reply.send(stripped.body);
    },
  );

  /**
   * GET /proxy/agency/campaigns/:id/attempts/:attemptId/recording
   *
   * Serves the bytes, so the raw auth-gated carrier URL never reaches a client.
   *
   * `rawResponse` buffers rather than streams: `callCore` returns `inject`'s
   * `rawPayload`. It buffers the handler's 4xx too, which is why the refusal is
   * decoded rather than forwarded (`decodeRawErrorBody`).
   */
  app.get<{ Params: { id: string; attemptId: string } }>(
    '/campaigns/:id/attempts/:attemptId/recording',
    {
      preHandler: [
        requirePermission('agency.supervise'),
        // Hearing the call, not configuring it: the owning account's
        // `allow_recording` (see the function's header).
        requireOwningAccountRecording,
      ],
    },
    async (request, reply) => {
      const tenantId = request.tenantId!;

      const result = await callCore({
        method: 'GET',
        path: `/agency-campaigns/${request.params.id}/attempts/${request.params.attemptId}/recording`,
        tenantId,
        accountId: request.accountId,
        rawResponse: true,
        metricPath: '/agency-campaigns/:id/attempts/:id/recording',
      });

      // Decoded, not forwarded as bytes — see `decodeRawErrorBody`. This is the
      // route whose `call_purged` is load-bearing for the console, and a refusal
      // typed `application/octet-stream` is one no console can parse.
      if (result.status >= 400) {
        return reply.code(result.status).send(decodeRawErrorBody(result.body));
      }

      const contentType = result.headers.get('content-type') || 'audio/mpeg';
      const contentLength = result.headers.get('content-length');

      reply.header('Content-Type', contentType);
      if (contentLength) reply.header('Content-Length', contentLength);
      reply.header('Cache-Control', 'private, max-age=3600');

      return reply.send(result.body);
    },
  );
}
