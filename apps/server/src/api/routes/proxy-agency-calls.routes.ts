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
 * PORT NOTE (magick-agency): ported from magick-master@a1f0756a
 * `src/api/routes/proxy-agency-calls.routes.ts`. Changes, each tested in
 * `test/unit/agency/proxy-agency-calls.routes.test.ts`:
 *  - hop collapse (decision B16): `proxyToCore` → `callCore`, same options minus
 *    `coreApiKey`; the `resolveCoreApiKey` lines are gone. Core's handler bodies
 *    (`agency-campaigns.routes.ts`, the attempt read and its `/recording`) run
 *    in-process behind it.
 *  - governance is gone (plan §3.2):
 *     · the section gate `requireCapability('agency')` is deleted (the app IS agency);
 *     · `isCapabilityEnabled(..., 'agency.analytics' | 'agency.recording')` (the field
 *       strip) and `requireCapability('agency.recording')` (the media gate) read the
 *       per-account settings row of the account that OWNS the campaign
 *       (`allow_recording` / `analyze_calls`), through {@link resolveOwningAccountGrants}
 *       below. NULL / no row = off, any failure = off (fail closed). The media refusal
 *       keeps master's 403 body `{ error: 'capability_disabled', capability }`.
 *  - every other line (the envelope check, the allow-list projection, the recording
 *    repoint to the console's `/proxy/agency/...` path, the raw-error decode, the UUID
 *    guard) is master's, verbatim.
 */

/**
 * PORT NOTE (magick-agency): what master's governance resolve answered, now answered by
 * the settings row of the campaign's OWNING account (plan §3.2; lane A's
 * `campaign-behavioral-settings.ts` interface change 1: the account judged is the
 * campaign's, never the request header's).
 *
 *  - `resolved` — the campaign is the caller's (same rule as core's `requireOwned`:
 *    tenant AND account), and these are its owner's two settings, each `true` only when
 *    the column is explicitly true (NULL / no row = the documented default, `false`).
 *  - `not_owned` — no such campaign, or it is another tenant's or another account's.
 *    There is no owning account in the caller's reach whose row could be read.
 *  - `unavailable` — no tenant/account context, or a read threw. Treated as "nothing
 *    granted" by both callers (fail closed), as master's `isCapabilityEnabled` returned
 *    `false` on a resolve error.
 *
 * Ids are UUIDs by the time this runs (`requireUuidPathParams` is a plugin hook).
 */
type OwningAccountGrants =
  | { kind: 'resolved'; recording: boolean; analytics: boolean }
  | { kind: 'not_owned' }
  | { kind: 'unavailable' };

/** Core's `requireOwned` refusal (`agency-campaigns.routes.ts`), byte for byte. */
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
 * PORT NOTE (magick-agency): master's route-level `requireCapability('agency.recording')`
 * on the media route, over the owning account's `allow_recording`. Runs after
 * `requirePermission('agency.supervise')`, where master's ran.
 *
 * A campaign that is not the caller's answers core's own 404 (`campaign_not_found`)
 * here, without reaching core: there is no owner row the caller may be judged by, and
 * reaching core without a positive grant would not be failing closed. With governance
 * this case answered master's 403 for a tenant without recording and core's 404 for one
 * with it; the 404 is now the answer for both (an unknown id and another account's id
 * stay indistinguishable either way).
 */
async function requireOwningAccountRecording(
  request: FastifyRequest<{ Params: { id: string } }>,
  reply: FastifyReply,
): Promise<FastifyReply | undefined> {
  // PORT NOTE (magick-agency, Phase 8 review): no account context. Master's capability resolved
  // at TENANT level, so the request reached core, whose `authMiddleware` answered 400 for the
  // missing `x-mgkvc-account`; that observed answer is kept here rather than the 403 the
  // account-level settings read would give (there is no account to read).
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
 * The agency workspace had no call-detail surface anywhere in the stack, so it
 * linked its attempt rows into `/app/calls/dialer/history/:id` — the primary
 * application's shell, gated on the primary application's `calls.dialer`
 * capability, with the campaign context and the list the reader came from both
 * gone. There was nowhere else for that link to point
 * (`docs/reference/magickvoice-platform/docs/agency-dialer-design.md` §7b).
 *
 * This is that somewhere. Two routes, both thin proxies to core's
 * `/agency-campaigns/:id/attempts/:attemptId` surface.
 *
 * **Core merges first.** These routes are inert until core ships the attempt read
 * — the platform's merge order is core → master → cusui and master fails closed
 * on a core call, so until then they answer with core's 404. Same posture as the
 * other cross-service entries in this service; recorded because the dependency is
 * invisible from this file alone.
 *
 * ── Why a fifth plugin on `/proxy/agency` ──────────────────────────────────
 *
 * The same reason the performance plugin is a fourth: a distinct gating pairing
 * kept side by side on purpose. Everything here is floored at
 * `agency.supervise`, and the media route additionally carries the
 * `agency.recording` capability — a pairing that exists nowhere else on this
 * prefix. Keeping it in its own file means the campaigns plugin's hooks do not
 * have to learn about recording consent, and this file can be read end to end to
 * see exactly who may hear an agency call.
 *
 * ── Why the routes are keyed on campaign + attempt, not on a call id ───────
 *
 * Because that is the shape of the thing being read. An agency call is reached
 * through its ATTEMPT: the attempt is what the reader clicked, it is
 * campaign-scoped so core can prove ownership from the path, and — this is the
 * load-bearing part — **it survives the call.** The attempt→call link is
 * deliberately un-FK'd (core migration 076) because both sides purge on
 * independent retention windows, so an attempt routinely outlives its call.
 *
 * A `/proxy/agency/calls/:id` surface could not express that. Master holds no
 * agency rows at all, so given a bare call id it has no way to find the campaign
 * that authorises reading it, and no way to say anything at all about an attempt
 * whose call has aged out. Core therefore answers 200 with a
 * `call_availability` marker rather than 404, and this tier forwards that
 * verbatim.
 *
 * ── Capability gating, and what each capability actually gates ─────────────
 *
 * - `agency` — section gate, at the plugin level. Without the agency product,
 *   none of this exists.
 * - `agency.supervise` (an RBAC PERMISSION, floored at `account_admin`, not a
 *   capability) — on every route. Reading someone else's conversation is a
 *   supervisory act. Note the `agent` role sits at level 5, BELOW `viewer`, so an
 *   agent cannot reach these routes; if agents ever need to review their own
 *   calls that is an agency-native route with its own floor, never a change to
 *   the role level.
 * - `agency.recording` — on the media route. This is the fix for a real gap:
 *   the capability existed but gated only *enabling* recording on a campaign
 *   (`proxy-agency-campaigns.routes.ts`, `assertCampaignBehavioralCapabilities`),
 *   so a tenant who had never been granted recording could still listen to
 *   recordings that predated the grant. Gating the config write and not the
 *   playback is gating the wrong end.
 * - `agency.analytics` — gates the transcript and the summary as *fields* on the
 *   detail response, because they arrive inside the call object rather than on
 *   their own route. See `shapeDetailResponse`.
 *
 * ── There is deliberately no `/recording-url` here ─────────────────────────
 *
 * Core has one, and it mints a token against core's own
 * `/api/v1/webrtc-recordings` playback route. Master has no proxy for that route
 * — there is no `recording-url` anywhere in this service, for AI calls either —
 * so the URL it returns is one a browser cannot reach through master. Shipping it
 * would mean shipping a dead link.
 *
 * The console does not need it: it plays recordings by fetching the bytes from
 * the proxy's own recording route and creating a blob URL, which is exactly what
 * `/recording` below serves. If a signed-URL playback path is ever wanted, it
 * needs a new unauthenticated token-gated proxy plugin on master (mirroring
 * `proxyAgencyStationRoutes`' posture) plus a rewrite of core's returned path —
 * a deliberate new public surface, and its own piece of work.
 */

/**
 * Analysis content fields, which `agency.analytics` gates.
 *
 * `analysis_sentiment_label` is included even though core omits it on the detail
 * path today: it is a scalar core projects OUT of `call_analysis`, so if that
 * projection ever reaches this read, a sentiment label would survive a strip that
 * removed the blob it came from. Listing it costs nothing and closes that.
 */
const ANALYTICS_CONTENT_FIELDS = [
  'call_analysis', 'conversation_log', 'transcript_meta', 'analysis_sentiment_label',
] as const;

/**
 * ─── THE FIELDS A TENANT WITHOUT `agency.analytics` MAY SEE ─────────────────
 *
 * Mirrors core's `formatWebRtcCallResponse` (`src/api/responses/webrtc-call.response.ts`),
 * minus {@link ANALYTICS_CONTENT_FIELDS}. Core's own formatter is already an
 * allow-list — deny-by-default, so a new `webrtc_calls` column is not auto-exposed
 * — and this is the same discipline one hop later, for the same reason.
 *
 * ── Why an allow-list and not a longer deny-list ───────────────────────────
 *
 * Nulling four known keys off a spread of the whole upstream object fails OPEN on
 * a SCHEMA ADDITION: the day core adds another transcript- or summary-derived
 * field inside the same envelope — a `call_summary`, a `sentiment_score`, a
 * `redaction_report` — it reaches a tenant who did not buy analytics, unchanged,
 * and nothing here goes red. That is the same defect class as the envelope
 * fail-open this route already fixed (`isDetailEnvelope`), one level in: the
 * envelope check made an unrecognised SHAPE fail closed, and this makes an
 * unrecognised FIELD fail closed.
 *
 * ── The trade, stated so the next person knows it is deliberate ────────────
 *
 * A new BENIGN core field is invisible to tenants without `agency.analytics`
 * until this list is updated. That is a real cost and it is accepted: the
 * alternative — a field appearing here the moment core ships it — is the one that
 * leaks analysis content to a tenant who did not buy it, and the two failures are
 * not comparable. A missing benign field shows up as a blank cell in the console
 * and is fixed by one line here; a leaked transcript is not fixable after the
 * fact. **Add a field here when core adds one, and never widen the strip to a
 * spread to save the edit.**
 *
 * Note the asymmetry: this governs only the WITHHELD response. A tenant WITH
 * `agency.analytics` still receives core's object as sent, because there is
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
 * leaves this service as JSON rather than as `application/octet-stream`.
 *
 * `rawResponse: true` makes `proxyToCore` buffer EVERY status, core's 4xx
 * included, so `send(result.body)` hands the client a Buffer and Fastify types a
 * Buffer as `application/octet-stream`. The one body on that route a console
 * MUST be able to parse is the refusal: `call_purged` is what lets it say "this
 * recording has aged out" instead of "the platform is broken"
 * (`docs/reference/magickvoice-platform/docs/agency-dialer-design.md` §7b makes that distinction the point of the
 * whole surface), and `no_recording` is a different sentence again. A reader that
 * branches on content type cannot reach either through octet-stream.
 *
 * Same treatment as `super-admin-usage.routes.ts`' export route and
 * `proxy-tts-audio.routes.ts`, both of which decode for this reason. The success
 * path is untouched — those bytes really are audio.
 *
 * A Buffer that is not a JSON object is NOT forwarded as bytes: there is no code
 * in it to branch on, and forwarding it would keep the content type this exists
 * to remove. It becomes a bare envelope, which `errorMaskHook` then rewrites into
 * the support-ticket body — the right answer for an upstream error carrying
 * nothing the caller could act on. That substitute is never read by a client for
 * the same reason: it has no allow-listed `code` and no `details`, so a core 4xx
 * masks it and a 5xx is masked unconditionally. It exists to fix the content
 * type, not to be read.
 *
 * PORT NOTE (magick-agency): `errorMaskHook` is app-wide here too, but only its 5xx branch
 * (lead ruling, Phase 8: the core-forwarded 4xx branch is dropped — `error-mask.middleware.ts`).
 * So a 5xx envelope is masked as in master, and a 4xx envelope reaches the client as
 * written. And `callCore` buffers like `proxyToCore` did (`rawResponse` → `inject`'s
 * `rawPayload`), so the decode is still needed for core's in-process refusals.
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

/** The envelope core's attempt read answers with. */
interface DetailEnvelope {
  attempt: unknown;
  call: Record<string, unknown> | null;
  call_availability: unknown;
}

/**
 * Is this the envelope this route knows how to redact?
 *
 * Checked because the strip below has to fail CLOSED. Every other gate in this
 * file's neighbourhood (`requireCapability`, `assertCapability`,
 * `isCapabilityEnabled`) denies on doubt, and a redaction that silently forwards
 * whatever it does not recognise is the one shape of gate that leaks by default —
 * an array body, a string body (core-client falls back to `response.text()` for a
 * non-JSON content type), or the call nested one level deeper would all sail
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
 * Copy only the named fields out of an upstream object.
 *
 * A key core did not send stays ABSENT rather than becoming `undefined`: the
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
 * Reshape core's response for this tier: repoint the recording at master's own
 * route, and remove what the tenant has not been granted.
 *
 * Core's job is scope — it decides which product owns the call. Master's job is
 * entitlement, and these two live inside the call object rather than behind their
 * own routes, so the enforcement point is a field strip rather than a 403.
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
  // this service. Master is reshaping this response, so it has to understand it.
  if (!isDetailEnvelope(body)) return { ok: false };

  if (body.call === null) return { ok: true, body };

  /*
   * ── The withheld response is BUILT, not filtered ──────────────────────────
   *
   * With `agency.analytics` off, the call object is projected through
   * {@link NON_ANALYTICS_CALL_FIELDS} rather than spread and then patched. A
   * spread-and-null fails open on a schema addition: the next
   * transcript-or-summary-derived field core puts in this envelope would reach an
   * unentitled tenant untouched, and nothing here would notice. Projecting means
   * a field master has not judged is simply not forwarded, which is the same
   * fail-closed posture `isDetailEnvelope` gives the envelope one level out.
   *
   * With the capability ON there is nothing to withhold, so core's object is
   * passed through as sent — an allow-list there would hide new fields from
   * precisely the tenants who bought all of them. See the constant's header for
   * the cost this accepts.
   */
  const nextCall: Record<string, unknown> = grants.analytics
    ? { ...body.call }
    : projectFields(body.call, NON_ANALYTICS_CALL_FIELDS);

  /*
   * Repoint the recording at THIS service.
   *
   * Core sets `recording_url` to its own `/api/v1/agency-campaigns/...` path,
   * which a browser cannot reach — it only ever talks to master. Rewritten here
   * for the same reason `rewriteBrowserWsUrl` and `rewriteStationWsUrl` exist:
   * core names a path in its own address space and master has to translate it.
   *
   * Built from the request's own params rather than by rewriting core's string,
   * so a malformed or unexpected value upstream cannot become a URL this service
   * hands a browser. Core's value is used only as a PRESENCE flag — null there
   * means no recording, and that distinction has to survive.
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
     * entirely, because master cannot claim a field exists that it has never
     * seen.
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
  // PORT NOTE (magick-agency): master's `requireCapability('agency')` section gate is
  // deleted — there is no governance, and the app IS agency (plan §3.2).
  /*
   * ─── THE PATH PARAMS ARE UUIDS, AND THAT IS ENFORCED ─────────────────────
   *
   * Both routes below interpolate `:id` and `:attemptId` into a core path, and
   * find-my-way hands the handler a percent-DECODED param — so `%2F` arrives as a
   * real `/`.
   *
   * ── What was already covered, so this comment does not overclaim ──────────
   *
   * The `..` traversal is not the hole. `proxyToCore` refuses any path that does
   * not survive a WHATWG parse unchanged (`src/proxy/safe-core-path.ts`), which
   * catches `..`, `%2e%2e`, `.%2e`, `#` and `\`. What it allows — correctly — is a
   * bare extra slash, because a path with no dot segments is an ordinary core
   * path.
   *
   * That is what matters here, because `:attemptId` is the TERMINAL segment of
   * the detail route's core path. `attemptId = a%2Frecording` builds
   * `/agency-campaigns/:id/attempts/a/recording` — core's media route — reached
   * through the DETAIL route, which is floored at `agency.supervise` but
   * deliberately does NOT carry `requireCapability('agency.recording')`. That is
   * the one capability this plugin was added to enforce, and appending a segment
   * to an id would have walked around it. (The envelope check would then have
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
   * an attempt id, both `uuid` columns in core — so the tighter guard costs
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
   * The attempt, plus its call when the call still exists. Core reports
   * `call_availability` as `available` | `purged` | `never_placed` and this tier
   * forwards it untouched — a purged call is a 200 with a marker, never a 404,
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
       * Resolved after the core call rather than as preHandlers, because these
       * gate FIELDS on a successful response, not access to the route. A tenant
       * without `agency.analytics` still gets the attempt, the disposition and
       * the notes — which is the point of the surface — just not the transcript.
       */
      // PORT NOTE (magick-agency): master's two `isCapabilityEnabled` resolves, now the
      // owning account's settings row (`resolveOwningAccountGrants`). Anything but a
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
         * Core answered 200 with something this route cannot redact, and the
         * tenant is not entitled to all of it. Refusing is the only safe answer:
         * forwarding would leak whatever the strip failed to reach, and guessing
         * at the shape is how a redaction quietly stops redacting.
         *
         * A 5xx because it is a contract violation between two services and not
         * anything the caller did — and it is masked on the way out, which is
         * correct: the client can do nothing with the detail, and the log below is
         * where an operator finds it.
         */
        log.error(
          { tenantId, campaignId: request.params.id, attemptId: request.params.attemptId },
          'agency call read: core returned an unrecognised envelope and fields had to be withheld',
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
   * Streams the bytes, so the raw auth-gated carrier URL never reaches a client.
   * The softphone's twin cannot serve this: core pins that plugin's reads to the
   * dialer scope and 404s an agency leg by design.
   *
   * `rawResponse` buffers rather than streams — a pre-existing property of
   * `proxyToCore`, shared with every other recording route in this service, not
   * something this route chose. It does buffer core's 4xx too, which is why the
   * refusal is decoded rather than forwarded (`decodeRawErrorBody`).
   */
  app.get<{ Params: { id: string; attemptId: string } }>(
    '/campaigns/:id/attempts/:attemptId/recording',
    {
      preHandler: [
        requirePermission('agency.supervise'),
        // Hearing the call, not configuring it. The capability gated only the
        // campaign config write before this.
        // PORT NOTE (magick-agency): `requireCapability('agency.recording')`, now the
        // owning account's `allow_recording` (see the function's header).
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
      // route whose `call_purged` the design calls load-bearing, and a refusal
      // typed `application/octet-stream` is one no console can parse.
      if (result.status >= 400) {
        return reply.code(result.status).send(decodeRawErrorBody(result.body));
      }

      // Header handling mirrors the AI-call and softphone recording routes.
      const contentType = result.headers.get('content-type') || 'audio/mpeg';
      const contentLength = result.headers.get('content-length');

      reply.header('Content-Type', contentType);
      if (contentLength) reply.header('Content-Length', contentLength);
      reply.header('Cache-Control', 'private, max-age=3600');

      return reply.send(result.body);
    },
  );
}
