/*
 * What the soft phone's internal handlers (`./softphone.ts`) answer, shared with the public
 * routes that read it (`../proxy-agency-softphone/`): the HTTP status of every
 * `AgencySoftphoneErrorCode`, the refusal body, and the success envelope of the audited
 * routes. Part of `agency.routes.ts`.
 */
import type { FastifyReply } from 'fastify';
import type {
  AgencyAgentState,
  AgencyManualCallDncScope,
  AgencySoftphoneErrorCode,
  AgencySoftphoneErrorResponse,
} from '@magick-agency/contracts/agency';
import { softphoneRefusalMessage, type SoftphoneRefusal } from '../../../agency/softphone/types.js';

/**
 * The HTTP status of every soft-phone refusal, as `errors.ts` states it beside each code.
 * A `Record` over the union, so a code added to the contract without a status here is a
 * compile error.
 */
export const SOFTPHONE_REFUSAL_STATUS: Readonly<Record<AgencySoftphoneErrorCode, number>> = {
  softphone_disabled: 403,
  invalid_number: 400,
  caller_id_not_allowed: 400,
  campaign_not_taggable: 403,
  dnc_listed: 409,
  dnc_unavailable: 503,
  outside_calling_hours: 409,
  override_note_invalid: 400,
  contact_in_flight: 409,
  session_on_campaign: 409,
  session_on_softphone: 409,
  session_not_found: 404,
  wrong_session_kind: 409,
  not_on_softphone: 409,
  manual_call_live: 409,
  outcome_pending: 409,
  concurrency_limit: 429,
  station_unavailable: 409,
  dial_failed: 503,
  call_not_found: 404,
  call_settled: 409,
  disposition_invalid: 400,
  fields_invalid: 400,
  settings_invalid: 400,
};

const ERROR_BY_STATUS: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  409: 'Conflict',
  429: 'Too Many Requests',
  503: 'Service Unavailable',
};

/**
 * The refusals the API layer raises itself (the runtime's `SoftphoneRefusal` cannot:
 * `types.ts` lists them). Each carries the fields its narrowed contract body names.
 */
export type SoftphoneApiRefusal =
  | { code: 'softphone_disabled' }
  | { code: 'session_on_campaign'; session_id: string; campaign_id: string; campaign_name: string; state: AgencyAgentState }
  | { code: 'settings_invalid'; details: Array<{ path: string; message: string }> };

const API_MESSAGES: Record<SoftphoneApiRefusal['code'], string> = {
  softphone_disabled: 'The soft phone is not enabled for this account.',
  session_on_campaign:
    'You are live on a campaign. Switch that station to the soft phone instead of opening a second one.',
  settings_invalid: 'Some soft-phone settings are invalid.',
};

/** `{ error, code, message, ...refusal }` with the contract status. */
export function softphoneRefusalBody(
  refusal: SoftphoneRefusal | SoftphoneApiRefusal,
): { status: number; body: AgencySoftphoneErrorResponse & Record<string, unknown> } {
  const status = SOFTPHONE_REFUSAL_STATUS[refusal.code];
  const message = refusal.code === 'softphone_disabled' || refusal.code === 'session_on_campaign'
    || refusal.code === 'settings_invalid'
    ? API_MESSAGES[refusal.code]
    : softphoneRefusalMessage(refusal);
  return {
    status,
    // `error` and `message` first, the refusal's own fields after: a refusal field can
    // never overwrite them because none is named `error` or `message`.
    body: { error: ERROR_BY_STATUS[status] ?? 'Request Failed', message, ...refusal },
  };
}

export function sendSoftphoneRefusal(
  reply: FastifyReply,
  refusal: SoftphoneRefusal | SoftphoneApiRefusal,
): FastifyReply {
  const { status, body } = softphoneRefusalBody(refusal);
  return reply.code(status).send(body);
}

// ─── The success envelope of the audited routes ─────────────────────────────

/**
 * An audited soft-phone handler's success body on the internal instance: the wire answer
 * the console gets, and the facts the public layer's `platform_audit_log` row needs that
 * the wire answer does not carry (who it was on behalf of, the override notes and the
 * DNC entry, the from-state of a switch). The public layer unwraps it (`answer` is what
 * the client receives) and never forwards `audit`. An envelope rather than extra keys on
 * the answer, so a public route that forgot to unwrap fails its own tests on the shape
 * instead of leaking the facts to the browser.
 */
export interface SoftphoneCoreAnswer<TAnswer, TAudit> {
  answer: TAnswer;
  audit: TAudit;
}

/** `POST /softphone/calls`. */
export interface SoftphonePlaceAudit {
  session_id: string;
  /** The tag; NULL when untagged. */
  campaign_id: string | null;
  /** SP1: the override used to place it. */
  dnc_override: { note: string; entry_id: string } | null;
  /** SP2. */
  hours_override_note: string | null;
}

/** `hangup`, `disposition`, `dnc`: whether the actor acted on someone else's call. */
export interface SoftphoneCallActAudit {
  on_behalf: boolean;
  campaign_id: string | null;
}

/**
 * The `dnc_entries` row a soft-phone mark landed on, for `dnc_entry.created` (written only
 * when `created`: a number already listed at that scope recorded nothing new).
 */
export interface SoftphoneDncEntryAudit {
  id: string;
  created: boolean;
  scope: AgencyManualCallDncScope;
}

/**
 * `hangup`: whether a hang-up was issued (false: the call had already ended, or is a
 * live row this process does not hold; nothing to audit).
 */
export interface SoftphoneHangupAudit extends SoftphoneCallActAudit {
  hung_up: boolean;
}

export interface SoftphoneDispositionAudit extends SoftphoneCallActAudit {
  disposition_code: string;
  /** The same code again: nothing settled a second time. */
  replay: boolean;
  /** A suppress code's DNC row; null when the code does not suppress, or on a replay. */
  dnc_entry: SoftphoneDncEntryAudit | null;
}

export interface SoftphoneDncAudit extends SoftphoneCallActAudit {
  scope: AgencyManualCallDncScope;
  dnc_recorded: boolean;
  /** Null when nothing was recorded. */
  dnc_entry: SoftphoneDncEntryAudit | null;
}

/** `POST /sessions/:id/softphone` and `/softphone/return`. */
export interface SoftphoneSwitchAudit {
  campaign_id: string;
  from_state: AgencyAgentState | null;
  /** The start was deferred behind a reservation, a call or wrap-up. */
  queued: boolean;
  /** `return` only: a still-queued switch was withdrawn rather than a break ended. */
  withdrawn: boolean;
  /** The switch only: an idempotent repeat that changed nothing (already on, or already queued). Not audited. */
  unchanged: boolean;
}

/** `PUT /softphone/settings`: which top-level settings changed. */
export interface SoftphoneSettingsAudit {
  changed: string[];
}

/** Is this an envelope? Checked by the public layer, which refuses (502) a body that is not. */
export function isSoftphoneCoreAnswer(body: unknown): body is SoftphoneCoreAnswer<unknown, Record<string, unknown>> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  const audit = record['audit'];
  return 'answer' in record && audit !== null && typeof audit === 'object' && !Array.isArray(audit);
}

// ─── The campaign session routes leaving the soft phone ──────────────────────

/**
 * What a CAMPAIGN session route (`available`, `break`, `break/cancel`,
 * `force-available`) adds to its answer when it took the session off the `soft_phone`
 * break, or withdrew a switch to it still queued: the facts the public layer's
 * `agency_session.softphone_ended` row needs (SP7, `softphone-audit.ts`).
 *
 * A key on the answer, under {@link SOFTPHONE_SESSION_AUDIT_KEY}, not the soft-phone
 * routes' envelope: those four routes answer `AgencySessionStateResponse` to every
 * caller, and the key is present only on the one answer that left the soft phone. The
 * public layer always takes it off before sending ({@link takeSoftphoneSessionAudit}),
 * and its tests assert the client never sees it.
 */
export interface SoftphoneSessionExitAudit {
  campaign_id: string;
  from_state: AgencyAgentState | null;
  /**
   * `break_cancel` withdrew a queued switch; `break` ended the break, or (with
   * `withdrawn`) replaced a queued switch with another queued reason; the others
   * ended the break.
   */
  via: 'available' | 'break' | 'force_available' | 'break_cancel';
  withdrawn: boolean;
  /** `via: 'break'`: the reason the session went on instead. */
  break_reason?: string;
}

export const SOFTPHONE_SESSION_AUDIT_KEY = 'softphone_audit';

/** Remove the exit facts from an internal answer (mutating it) and return them, or null. */
export function takeSoftphoneSessionAudit(body: unknown): SoftphoneSessionExitAudit | null {
  if (!body || typeof body !== 'object' || !(SOFTPHONE_SESSION_AUDIT_KEY in body)) return null;
  const record = body as Record<string, unknown>;
  const audit = record[SOFTPHONE_SESSION_AUDIT_KEY] as SoftphoneSessionExitAudit;
  delete record[SOFTPHONE_SESSION_AUDIT_KEY];
  return audit && typeof audit === 'object' && typeof audit.campaign_id === 'string' ? audit : null;
}

