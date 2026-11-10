/*
 * What the inbound internal handlers (`./inbound.ts`) answer, shared with the public routes that
 * read it (`../proxy-agency-inbound/`): the HTTP status and body of every
 * `AgencyInboundErrorCode`, the success envelope of the audited routes, and the console shapes
 * of a route and a Missed inbound row. Part of `agency.routes.ts`.
 */
import type { FastifyReply } from 'fastify';
import type {
  AgencyInboundClipInvalidReason,
  AgencyInboundClipRouteRef,
  AgencyInboundErrorCode,
  AgencyInboundErrorResponse,
  AgencyInboundMissedCall,
  AgencyInboundRoute,
  AgencyInboundRouteConfig,
} from '@magick-agency/contracts/api/agency/inbound';
import type { AgencyInboundMissedRow } from '../../../db/repositories/agency.repository.js';
import type { InboundCallRefusal } from '../../../agency/inbound/inbound-disposition.js';

/**
 * The HTTP status of every inbound refusal, as `errors.ts` §6 states it beside each code. A
 * `Record` over the union, so a code added to the contract without a status here is a compile
 * error.
 */
export const INBOUND_REFUSAL_STATUS: Readonly<Record<AgencyInboundErrorCode, number>> = {
  inbound_disabled: 403,
  inbound_route_invalid: 400,
  inbound_route_not_found: 404,
  inbound_route_name_taken: 409,
  inbound_number_not_found: 409,
  inbound_number_not_linked: 409,
  inbound_number_in_use: 409,
  inbound_missed_call_not_found: 404,
  inbound_call_live: 409,
  inbound_call_not_found: 404,
  inbound_call_not_dispositionable: 409,
  inbound_disposition_invalid: 400,
  inbound_outcome_already_saved: 409,
  inbound_clip_not_found: 404,
  inbound_clip_in_use: 409,
  inbound_clip_invalid: 400,
  inbound_clip_name_taken: 409,
  inbound_clip_storage_unavailable: 503,
  inbound_missed_call_handled: 409,
  inbound_assignee_invalid: 400,
};

/** English fallback copy, British spelling. The console words each code itself. */
const INBOUND_REFUSAL_MESSAGES: Readonly<Record<AgencyInboundErrorCode, string>> = {
  inbound_disabled: 'Inbound calls are not turned on for this account.',
  inbound_route_invalid: 'Some of the inbound route’s settings are invalid.',
  inbound_route_not_found: 'Inbound route not found.',
  inbound_route_name_taken: 'Another inbound route in this account already has that name.',
  inbound_number_not_found: 'That number is not one of the numbers this account can use.',
  inbound_number_not_linked: 'That number is not linked to inbound calls. Contact support to have it linked.',
  inbound_number_in_use: 'That number already answers another inbound route.',
  inbound_missed_call_not_found: 'Missed call not found.',
  inbound_call_live: 'An inbound call is in progress or still needs its outcome.',
  inbound_call_not_found: 'Inbound call not found.',
  inbound_call_not_dispositionable: 'This call cannot take an outcome: it has not ended, or it never reached an agent.',
  inbound_disposition_invalid: 'That outcome cannot be saved as submitted.',
  inbound_outcome_already_saved: 'This call’s outcome is already saved, or has lapsed.',
  inbound_clip_not_found: 'Recording not found.',
  inbound_clip_in_use: 'This recording is in use, so it cannot be deleted. Choose another recording where it is used first.',
  inbound_clip_invalid: 'That file cannot be used as a recording.',
  inbound_clip_name_taken: 'Another recording in this account already has that name.',
  inbound_clip_storage_unavailable: 'Recordings cannot be uploaded on this deployment: it has no audio storage.',
  inbound_missed_call_handled: 'This missed call is already handled.',
  inbound_assignee_invalid: 'That person cannot work this account’s missed calls.',
};

const ERROR_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  413: 'Payload Too Large',
  503: 'Service Unavailable',
};

/** A refusal: its code and the fields its body carries. */
export type InboundRefusal =
  | {
    code: Exclude<
      AgencyInboundErrorCode,
      'inbound_route_invalid' | 'inbound_number_not_found' | 'inbound_number_not_linked' | 'inbound_number_in_use'
      | 'inbound_call_live' | 'inbound_disposition_invalid' | 'inbound_clip_in_use' | 'inbound_clip_invalid'
    >;
  }
  | { code: 'inbound_clip_in_use'; routes: AgencyInboundClipRouteRef[] }
  | { code: 'inbound_clip_invalid'; upload_reason: AgencyInboundClipInvalidReason; message?: string }
  | { code: 'inbound_call_live'; inbound_call_id: string }
  // The call operations' own (`inbound_disposition_invalid` with its reason), stated once there.
  | InboundCallRefusal
  | { code: 'inbound_route_invalid'; details: Array<{ path: string; message: string }> }
  | { code: 'inbound_number_not_found' | 'inbound_number_not_linked'; phone_number_id: string }
  | { code: 'inbound_number_in_use'; phone_number_id: string; route_id?: string };

/**
 * `{ error, code, message, ...fields }` with the contract status. An upload refused for its size
 * is 413, as the multipart limit answers it; a refusal that carries its own `message` (an upload's
 * reason) says that instead of the code's.
 */
export function inboundRefusalBody(refusal: InboundRefusal): { status: number; body: AgencyInboundErrorResponse & Record<string, unknown> } {
  const status = refusal.code === 'inbound_clip_invalid' && refusal.upload_reason === 'too_large'
    ? 413
    : INBOUND_REFUSAL_STATUS[refusal.code];
  return {
    status,
    // `error` and `message` first, the refusal's own fields after; none is named either.
    body: { error: ERROR_BY_STATUS[status] ?? 'Request Failed', message: INBOUND_REFUSAL_MESSAGES[refusal.code], ...refusal },
  };
}

export function sendInboundRefusal(reply: FastifyReply, refusal: InboundRefusal): FastifyReply {
  const { status, body } = inboundRefusalBody(refusal);
  return reply.code(status).send(body);
}

// ─── The success envelope of the audited routes ─────────────────────────────

/**
 * An audited inbound handler's success body on the internal instance: the wire answer the
 * console gets, and the facts the public layer's `platform_audit_log` row needs. The public
 * layer sends `answer` and never forwards `audit` (the soft phone's envelope, for its reason).
 */
export interface InboundCoreAnswer<TAnswer, TAudit> {
  answer: TAnswer;
  audit: TAudit;
}

/** Send the {@link InboundCoreAnswer} envelope with `status`. */
export function sendInboundAnswer<TAnswer, TAudit>(reply: FastifyReply, status: number, body: TAnswer, audit: TAudit): FastifyReply {
  const envelope: InboundCoreAnswer<TAnswer, TAudit> = { answer: body, audit };
  return reply.code(status).send(envelope);
}

/** `POST /inbound/routes`. */
export interface InboundRouteCreatedAudit {
  route_id: string;
  numbers_added: string[];
}

/** `PATCH /inbound/routes/:id`: the fields whose value changed and the numbers moved. */
export interface InboundRouteUpdatedAudit {
  route_id: string;
  fields: string[];
  numbers_added: string[];
  numbers_removed: string[];
}

/** `DELETE /inbound/routes/:id`: the numbers it held, now detached. */
export interface InboundRouteDeletedAudit {
  route_id: string;
  numbers_removed: string[];
}

/** `POST /inbound/missed/:id/assign`: whether this request moved it, and from whom to whom (null: the account). */
export interface InboundCallReassignedAudit {
  call_id: string;
  changed: boolean;
  from: string | null;
  to: string | null;
}

/** `POST /inbound/missed/:id/handled`: whether this request marked it (false: already handled). */
export interface InboundCallHandledAudit {
  call_id: string;
  changed: boolean;
  reason: string;
}

/**
 * `POST /inbound/missed/:id/reopen`: whether this request reopened it (false: it was open), and
 * how and by whom it had been handled (`reason` `marked` for a row handled before 0028).
 */
export interface InboundCallReopenedAudit {
  call_id: string;
  changed: boolean;
  handled_reason: string | null;
  handled_by_user_id: string | null;
}

/**
 * `GET /inbound/missed/:id/voicemail` (internal): where the row's voicemail is stored, for the
 * public route to stream (never served to a client: the key is a bucket path).
 */
export interface InboundVoicemailLocation {
  call_id: string;
  voicemail_key: string;
  voicemail_seconds: number | null;
}

/** The voicemail's path under `/proxy/agency`, as a Missed row names it (`voicemail_url`). */
export function voicemailPath(callId: string): string {
  return `/inbound/missed/${callId}/voicemail`;
}

/** A DNC row a mark landed on (`created`: newly listed), with its scope. */
export interface InboundDncEntryAudit {
  id: string;
  created: boolean;
  scope: 'campaign' | 'account';
}

/** `POST /inbound/calls/:id/hangup`: `hung_up` false when the call had already ended (not audited). */
export interface InboundCallHangupAudit {
  call_id: string;
  on_behalf: boolean;
  campaign_id: string | null;
  hung_up: boolean;
}

/** `POST /inbound/calls/:id/disposition`. */
export interface InboundCallDispositionAudit {
  call_id: string;
  on_behalf: boolean;
  campaign_id: string | null;
  disposition_code: string;
  /** The same code again: nothing settled a second time. */
  replay: boolean;
  dnc_entry: InboundDncEntryAudit | null;
}

/** `POST /inbound/calls/:id/dnc`. */
export interface InboundCallDncAudit {
  call_id: string;
  on_behalf: boolean;
  campaign_id: string | null;
  scope: 'campaign' | 'account';
  dnc_recorded: boolean;
  dnc_entry: InboundDncEntryAudit | null;
}

/** Is this an envelope? Checked by the public layer, which refuses (502) a body that is not. */
export function isInboundCoreAnswer(body: unknown): body is InboundCoreAnswer<unknown, Record<string, unknown>> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  const audit = record['audit'];
  return 'answer' in record && audit !== null && typeof audit === 'object' && !Array.isArray(audit);
}

// ─── Console shapes ─────────────────────────────────────────────────────────

/** A wire route's configuration alone: what a PATCH is judged against. */
export function inboundRouteConfigOf(route: AgencyInboundRoute): AgencyInboundRouteConfig {
  const { id: _id, account_id: _account, numbers: _numbers, created_at: _created, updated_at: _updated, ...config } = route;
  return config;
}

/**
 * A Missed inbound row as the console reads it. `assignee_name` / `handled_by_name` and
 * `assignee_departed` are the public layer's enrichment (`names`, and the assignees who can no
 * longer work the account's rows, `departed`); the internal handler answers them NULL and false.
 * A row handled before 0028 has no `handled_reason`: a person marked it.
 */
export function inboundMissedToWire(
  row: AgencyInboundMissedRow,
  names: ReadonlyMap<string, string | null> = new Map(),
  departed: ReadonlySet<string> = new Set(),
): AgencyInboundMissedCall {
  const iso = (d: Date | string | null) => (d === null ? null : new Date(d).toISOString());
  return {
    id: row.id,
    account_id: row.account_id,
    route_id: row.route_id,
    route_name: row.route_name,
    from_e164: row.from_e164,
    to_e164: row.to_e164,
    arrived_at: iso(row.arrived_at)!,
    // A Missed row exists only on an ended call (`ck_agency_inbound_calls_follow_up`).
    ended_at: iso(row.ended_at)!,
    reason: row.follow_up_reason!,
    // Why a `closed` row was closed (0030); none on another reason's row.
    closed_cause: row.follow_up_reason === 'closed' ? (row.closed_cause ?? null) : null,
    outcome: row.outcome!,
    caller_dnc: row.caller_dnc,
    matched_contact_id: row.matched_contact_id,
    matched_campaign_id: row.matched_campaign_id,
    matched_campaign_name: row.matched_campaign_name,
    callback_due_at: iso(row.callback_due_at),
    has_voicemail: row.voicemail_key !== null,
    // Relative to the proxy, as the console resolves it (`voicemailFetchUrl`).
    ...(row.voicemail_key !== null ? { voicemail_url: voicemailPath(row.id) } : {}),
    assignee_user_id: row.follow_up_assignee_user_id,
    assignee_name: row.follow_up_assignee_user_id ? (names.get(row.follow_up_assignee_user_id) ?? null) : null,
    assignee_departed: row.follow_up_assignee_user_id !== null && departed.has(row.follow_up_assignee_user_id),
    status: row.follow_up_status!,
    handled_reason: row.follow_up_status === 'handled' ? (row.handled_reason ?? 'marked') : null,
    handled_by_user_id: row.handled_by_user_id,
    handled_by_name: row.handled_by_user_id ? (names.get(row.handled_by_user_id) ?? null) : null,
    handled_at: iso(row.handled_at),
  };
}

/** `POST /inbound/clips` (internal): the recording recorded. Ids and numbers only. */
export interface InboundClipUploadedAudit {
  clip_id: string;
  size_bytes: number;
  duration_seconds: number;
}

/** `DELETE /inbound/clips/:id` (internal): the recording deleted, and its object for the public layer to remove. */
export interface InboundClipDeletedAudit {
  clip_id: string;
  s3_key: string;
}
