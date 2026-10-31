/*
 * The soft phone's reads: bootstrap, the call list, the call detail and its recording
 * (docs/softphone.md §6). Part of `proxy-agency-softphone.routes.ts`.
 *
 * An agent reads their own calls; an `agency.supervise` holder every call in the account
 * (the internal handler applies it from the actor). A call's MEDIA — the recording, the
 * transcript and the AI analysis — is `agency.supervise`'s even on the caller's own call,
 * as a campaign call's is (`rbac.ts`): an agent's detail carries `media: null` and the
 * recording route floors at `agency.supervise`. Enrichment here: `agent_name` on the
 * list, the detail and bootstrap's call, and the dispositioned-by name on the detail
 * (`users`, one query, degrading to NULL). The detail's media leg gets the attempt
 * detail's entitlement strip (`shapeMediaCall`) and the recording route its gate.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AgencyManualCall } from '@magick-agency/contracts/agency';
import { requirePermission } from '../../../rbac/rbac.middleware.js';
import { callCore } from '../../core-dispatch.js';
import { parseOr400 } from '../helpers/parse-or-400.js';
import { softphoneListQuerySchema, softphoneListQueryString } from '../helpers/softphone-list-query.js';
import { decodeRawErrorBody, shapeMediaCall } from '../proxy-agency-calls.routes.js';
import {
  accountMediaGrants,
  actorQuery,
  isManualCallRow,
  namesInTenant,
  requireSoftphoneEnabled,
  softphoneActorOrRefuse,
  withAgentName,
} from './shared.js';

/** Where the console fetches a manual call's recording bytes (this plugin's route). */
export function publicRecordingPath(callId: string): string {
  return `/proxy/agency/softphone/calls/${callId}/recording`;
}

/**
 * The recording route's gate: the account's `allow_recording`, the attempt recording's
 * 403 body (`capability_disabled`). Hearing a call, not configuring one.
 */
async function requireAccountRecording(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const grants = await accountMediaGrants(request);
  if (!grants.recording) {
    return reply.code(403).send({ error: 'capability_disabled', capability: 'agency.recording' }) as unknown as void;
  }
}

interface DetailEnvelope {
  call: AgencyManualCall;
  overrides: unknown;
  media: Record<string, unknown> | null;
  call_availability: unknown;
}

/** The internal detail's shape; anything else fails closed (502), as the attempt read's does. */
function isDetailEnvelope(body: unknown): body is DetailEnvelope {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const r = body as Record<string, unknown>;
  const media = r['media'];
  return isManualCallRow(r['call']) && 'overrides' in r && 'call_availability' in r
    && (media === null || (typeof media === 'object' && !Array.isArray(media)));
}

export async function registerSoftphoneReadRoutes(app: FastifyInstance): Promise<void> {
  const dial = [requirePermission('agency.softphone.dial'), requireSoftphoneEnabled];

  /**
   * GET /proxy/agency/softphone/bootstrap — taggable campaigns (an agent's active
   * staffing; every campaign of the account for a supervisor), the untagged caller IDs
   * and catalog, the call fields, the default country code, the caller's live session
   * (`on_softphone`, a queued switch) and its live or unsettled call.
   */
  app.get('/softphone/bootstrap', { preHandler: dial }, async (request, reply) => {
    const actor = softphoneActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'GET',
      path: '/agency/softphone/bootstrap',
      query: actorQuery(actor),
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status >= 400) return reply.code(result.status).send(result.body);
    const body = result.body as { call?: unknown };
    if (isManualCallRow(body.call)) {
      const names = await namesInTenant([body.call.agent_user_id], request.tenantId!);
      body.call = withAgentName(body.call, names);
    }
    return reply.send(body);
  });

  /**
   * GET /proxy/agency/softphone/calls — keyset pages, newest first. The query is the
   * console's: `limit, cursor, agent_user_id, campaign_id (uuid | 'untagged'), outcome,
   * phone (digits), from, to (exclusive)`, plus the contract's `status` and
   * `disposition_code`. An agent naming another agent is refused (403).
   */
  app.get('/softphone/calls', { preHandler: dial }, async (request, reply) => {
    const parsed = parseOr400(softphoneListQuerySchema, request.query ?? {}, reply, 'agency');
    if (!parsed) return reply;
    const actor = softphoneActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'GET',
      path: '/agency/softphone/calls',
      query: { ...softphoneListQueryString(parsed.data), ...actorQuery(actor) },
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status >= 400) return reply.code(result.status).send(result.body);
    const page = result.body as { rows?: unknown };
    if (Array.isArray(page.rows)) {
      const rows = page.rows.filter(isManualCallRow);
      const names = await namesInTenant(rows.map((r) => r.agent_user_id), request.tenantId!);
      page.rows = page.rows.map((row) => (isManualCallRow(row) ? withAgentName(row, names) : row));
    }
    return reply.send(page);
  });

  /**
   * GET /proxy/agency/softphone/calls/:id — the call (contact context and prior
   * attempts), its override notes, and — for an `agency.supervise` holder only — its
   * media leg in the attempt detail's envelope (`call_availability`: `available` |
   * `purged` | `never_placed`; `media` is null for an agent, whose own call is the
   * record only). 404 `call_not_found` for another agent's call (unless supervising),
   * another account's or tenant's, or none.
   */
  app.get<{ Params: { id: string } }>('/softphone/calls/:id', { preHandler: dial }, async (request, reply) => {
    const actor = softphoneActorOrRefuse(request, reply);
    if (!actor) return reply;
    const result = await callCore({
      method: 'GET',
      path: `/agency/softphone/calls/${request.params.id}`,
      query: actorQuery(actor),
      tenantId: request.tenantId!,
      accountId: request.accountId,
    });
    if (result.status >= 400) return reply.code(result.status).send(result.body);
    if (!isDetailEnvelope(result.body)) {
      return reply.code(502).send({
        error: 'Bad Gateway', code: 'core_response_unrecognised', message: 'The call could not be returned.',
      });
    }
    const detail = result.body;
    // Defence in depth on the internal handler's rule: no media leg without supervise.
    const media = actor.supervise ? detail.media : null;
    const names = await namesInTenant(
      [detail.call.agent_user_id, detail.call.dispositioned_by_user_id], request.tenantId!,
    );
    const grants = media ? await accountMediaGrants(request) : { recording: false, analytics: false };
    return reply.send({
      ...detail,
      call: withAgentName(detail.call, names),
      dispositioned_by_name: detail.call.dispositioned_by_user_id
        ? names.get(detail.call.dispositioned_by_user_id) ?? null
        : null,
      media: media ? shapeMediaCall(media, grants, publicRecordingPath(request.params.id)) : null,
    });
  });

  /**
   * GET /proxy/agency/softphone/calls/:id/recording — the bytes (buffered by `callCore`),
   * so the carrier URL never reaches a client and no signed link is minted. Floors at
   * `agency.supervise` (any call in the account), as a campaign call's recording does: an
   * agent does not hear recordings, their own included. Refusals as the attempt
   * recording's: 403 `capability_disabled` without `allow_recording`; 404 `call_purged` /
   * `call_never_placed`, or the proxy's no-recording 404; decoded to JSON, never bytes.
   */
  app.get<{ Params: { id: string } }>('/softphone/calls/:id/recording', {
    preHandler: [
      requirePermission('agency.softphone.dial'), requirePermission('agency.supervise'),
      requireSoftphoneEnabled, requireAccountRecording,
    ],
  }, async (request, reply) => {
    const actor = softphoneActorOrRefuse(request, reply);
    if (!actor) return reply;
    const range = request.headers['range'];
    const result = await callCore({
      method: 'GET',
      path: `/agency/softphone/calls/${request.params.id}/recording`,
      query: actorQuery(actor),
      tenantId: request.tenantId!,
      accountId: request.accountId,
      rawResponse: true,
      ...(typeof range === 'string' && range.length > 0 ? { headers: { range } } : {}),
    });
    if (result.status >= 400) return reply.code(result.status).send(decodeRawErrorBody(result.body));
    reply.code(result.status);
    reply.header('Content-Type', result.headers.get('content-type') || 'audio/mpeg');
    const contentLength = result.headers.get('content-length');
    if (contentLength) reply.header('Content-Length', contentLength);
    const contentRange = result.headers.get('content-range');
    if (contentRange) reply.header('Content-Range', contentRange);
    reply.header('Accept-Ranges', result.headers.get('accept-ranges') || 'bytes');
    reply.header('Cache-Control', 'private, max-age=3600');
    return reply.send(result.body);
  });
}
