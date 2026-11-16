/*
 * Live call listening's shared pieces of the public and internal layers (docs/listening.md):
 * the refusal body for each code (`packages/contracts/src/errors.ts` §7, statuses LS14), the
 * flag gate's `403 feature_disabled`, and a call's listen sessions for the call detail pages
 * ("Listened to by", LS13).
 */
import type { FastifyReply } from 'fastify';
import { createChildLogger } from '@magick-agency/observability';
import type { AgencyListenErrorCode } from '@magick-agency/contracts/errors';
import type { AgencyCallListenSession, AgencyLiveCallNumberErrorResponse } from '@magick-agency/contracts/api/agency/live-calls';
import { agencyListenSessionRepository } from '../../../db/repositories/agency.repository.js';
import { agentNamesOrNone } from '../../../agency/agency-agent-identity.js';
import { UUID_RE } from '../../../utils/uuid.js';

const log = createChildLogger({ component: 'agency-listen-routes' });

/** The HTTP status of each listen refusal (LS14). */
export const LISTEN_ERROR_STATUS: Record<AgencyListenErrorCode, number> = {
  listen_call_not_live: 404,
  listen_recording_off: 409,
  listen_limit_call: 409,
  listen_limit_server: 503,
  listen_own_call: 409,
  listen_unavailable: 503,
};

/** English fallback copy per code (the console shows its own for a known code). British English. */
export const LISTEN_ERROR_MESSAGES: Record<AgencyListenErrorCode, string> = {
  listen_call_not_live: 'That call is not in progress.',
  listen_recording_off: 'Listening is turned off for unrecorded calls.',
  listen_limit_call: 'Two supervisors are already listening to this call.',
  listen_limit_server: 'Too many listens are open right now. Try again shortly.',
  listen_own_call: 'You are on this call.',
  listen_unavailable: 'Listening could not be started. Try again.',
};

const ERROR_LABEL: Record<number, string> = { 404: 'Not Found', 409: 'Conflict', 503: 'Service Unavailable' };

/** The refusal body for `code`, without sending it. */
export function listenRefusalBody(code: AgencyListenErrorCode): { error: string; code: AgencyListenErrorCode; message: string } {
  return { error: ERROR_LABEL[LISTEN_ERROR_STATUS[code]] ?? 'Error', code, message: LISTEN_ERROR_MESSAGES[code] };
}

/**
 * `{ error, code, message }` with the code's status (or `status`, the owning process's answer).
 * The 503s (`listen_limit_server`, `listen_unavailable`) are reviewed fixed-shape bodies the
 * console reads by code (the refused grant's toast says why), so they are let through the
 * app-wide error mask (`error-mask.middleware.ts`) as the soft phone's reviewed 503s are; the body
 * is always {@link listenRefusalBody}'s, never forwarded text.
 */
export function sendListenRefusal(reply: FastifyReply, code: AgencyListenErrorCode, status = LISTEN_ERROR_STATUS[code]): FastifyReply {
  if (status >= 500) reply.request.preserveReviewedUpstreamError = true;
  return reply.code(status).send(listenRefusalBody(code));
}

/** Is this a listen refusal body (`{ code }` one of §7's)? */
export function listenRefusalCode(body: unknown): AgencyListenErrorCode | null {
  if (!body || typeof body !== 'object') return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' && code in LISTEN_ERROR_STATUS ? code as AgencyListenErrorCode : null;
}

/**
 * A number the caller withheld: an inbound caller with no readable number is stored as `''`
 * (`plivoNumberToE164` gave none). No digit at all, so neither a masked nor a full number exists.
 */
export function isWithheldNumber(phone: string | null): boolean {
  return phone === null || !/\d/.test(phone);
}

/** The number reveal's refusal for a withheld number (`AgencyLiveCallNumberErrorResponse`, 404). */
export const LIVE_CALL_NUMBER_WITHHELD_BODY = {
  error: 'Not Found', code: 'live_call_number_withheld', message: 'The caller withheld their number.',
} as const satisfies AgencyLiveCallNumberErrorResponse;

/** The flag gate's refusal: the dialer gate's body shape (`dialer-gate.ts`), for live calls. */
export const LIVE_LISTEN_DISABLED_BODY = {
  error: 'Feature Not Enabled', code: 'feature_disabled', message: 'Live call listening is not enabled for this account.',
} as const;

/**
 * One call's listen sessions for its detail page (LS13), earliest first, with the supervisors'
 * names. Null when they could not be read: the detail answers without the field rather than
 * failing, and never says nobody listened when it does not know.
 */
export async function callListenSessions(
  tenantId: string,
  accountId: string,
  callId: string,
): Promise<AgencyCallListenSession[] | null> {
  try {
    const rows = await agencyListenSessionRepository.listForCall(tenantId, accountId, callId);
    const names = await agentNamesOrNone(rows.map((r) => r.listener_user_id), tenantId, 'call listen sessions');
    return rows.map((r) => ({
      listen_id: r.id,
      listener_user_id: r.listener_user_id,
      listener_name: names.get(r.listener_user_id) ?? null,
      started_at: new Date(r.started_at).toISOString(),
      ended_at: r.ended_at ? new Date(r.ended_at).toISOString() : null,
      end_reason: r.end_reason,
      duration_seconds: r.ended_at
        ? Math.max(0, Math.round((new Date(r.ended_at).getTime() - new Date(r.started_at).getTime()) / 1000))
        : null,
    }));
  } catch (err) {
    log.warn({ err, tenantId, callId }, 'Could not read the call\'s listen sessions — answering the detail without them');
    return null;
  }
}

/** Is `v` a UUID (either case, `utils/uuid.ts`)? Ids are checked at the edge: a non-UUID reaching a `uuid` cast is `22P02`. */
export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}
