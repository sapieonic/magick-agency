/**
 * **NEW.** Inbound calls in the console (`docs/inbound.md` §7, §8): an account's inbound routes
 * and its Missed inbound list. The vocabularies and the route configuration are the dialer
 * contract's (`../../agency/inbound.ts`), re-exported here so a console file needs one import.
 *
 * Routes (under `/proxy/agency`, Firebase session, tenant and account headers; every one also
 * needs the `agency_inbound_enabled` flag, else `403 inbound_disabled`):
 *  - `GET    /inbound/routes`                 `agency.inbound.write` → {@link AgencyInboundRoutesResponse}
 *  - `GET    /inbound/routes/:id`             `agency.inbound.write` → {@link AgencyInboundRouteResponse}
 *  - `POST   /inbound/routes`                 `agency.inbound.write`, {@link AgencyInboundRouteCreateRequest} → 201 {@link AgencyInboundRouteResponse}
 *  - `PATCH  /inbound/routes/:id`             `agency.inbound.write`, {@link AgencyInboundRouteUpdateRequest} → {@link AgencyInboundRouteResponse}
 *  - `DELETE /inbound/routes/:id`             `agency.inbound.write` → 204 (soft delete; its numbers are detached)
 *  - `GET    /inbound/numbers`                `agency.inbound.write` → {@link AgencyInboundNumbersResponse} (the route editor's choices)
 *  - `GET    /inbound/clips`                  `agency.inbound.write` → {@link AgencyInboundClipsResponse} (the account's recordings)
 *  - `POST   /inbound/clips`                  `agency.inbound.write`, `multipart/form-data` (`name`, `file`) → 201
 *    {@link AgencyInboundClipResponse}: a recording, decoded and checked before it is stored
 *    ({@link AGENCY_INBOUND_CLIP_UPLOAD_LIMITS}; `inbound_clip_invalid`, `inbound_clip_name_taken`,
 *    `inbound_clip_storage_unavailable`); audited `agency_inbound_clip.uploaded`
 *  - `DELETE /inbound/clips/:id`              `agency.inbound.write` → 204; `inbound_clip_in_use` (naming the
 *    routes) while a live route plays it, `inbound_clip_not_found`; audited `agency_inbound_clip.deleted`
 *  - `GET    /inbound/missed`                 `agency.inbound.read`, {@link AgencyInboundMissedListQuery} → {@link AgencyInboundMissedPage}
 *  - `POST   /inbound/missed/:id/handled`     `agency.inbound.read`, no body → {@link AgencyInboundMarkHandledResponse}
 *  - `GET    /inbound/missed/:id/voicemail`   `agency.inbound.read` → the row's voicemail, `audio/wav`, streamed (P2;
 *    a `Range` request is answered 206; the Missed list's assignee rule; `inbound_missed_call_not_found` when the
 *    row has none, or it has aged out)
 *
 * Every route read and write carries the route's `warnings` (P2, {@link inboundRouteWarnings}).
 *
 * `agency.inbound.read` floors at `agent`: an agent sees and handles only the rows assigned to
 * them (the route forces `assignee=me`); with `agency.supervise` the caller sees the account's.
 * Refusals are {@link AgencyInboundErrorResponse} (`../../errors.ts` §6); a malformed query (a bad
 * cursor, an unknown filter value) or a body that is not JSON is the agency surface's ordinary 400.
 */

import type { AgencyKeysetPage } from '../../agency/spine';
import type * as Core from '../../agency/inbound';
import type {
  AgencyInboundCallOutcome,
  AgencyInboundClipSlot,
  AgencyInboundFollowUpStatus,
  AgencyInboundMissedReason,
  AgencyInboundRouteConfig,
  AgencyInboundUnconnectedAction,
} from '../../agency/inbound';
import type { AgencyInboundErrorCode } from '../../errors';

export {
  AGENCY_INBOUND_CALL_OUTCOMES,
  AGENCY_INBOUND_CALL_STATES,
  AGENCY_INBOUND_CATALOG_SOURCES,
  AGENCY_INBOUND_CONNECT_DELAY_MS,
  AGENCY_INBOUND_DISPOSITION_SOURCES,
  AGENCY_INBOUND_OUTCOME_LAPSE_MS,
  AGENCY_INBOUND_TOOK_OVER_DISPOSITION_CODE,
  AGENCY_INBOUND_VOICEMAIL_MAX_SECONDS,
  AGENCY_INBOUND_CLIP_SLOTS,
  AGENCY_INBOUND_FOLLOW_UP_STATUSES,
  AGENCY_INBOUND_MISSED_REASONS,
  AGENCY_INBOUND_ROUTE_DEFAULTS,
  AGENCY_INBOUND_ROUTE_LIMITS,
  AGENCY_INBOUND_STICKY_MODES,
  AGENCY_INBOUND_STICKY_REASONS,
  AGENCY_INBOUND_UNCONNECTED_ACTIONS,
} from '../../agency/inbound';
export type {
  AgencyInboundCall,
  AgencyInboundCallDispositionResponse,
  AgencyInboundCallDncResponse,
  AgencyInboundCallMatch,
  AgencyInboundCallResponse,
  AgencyInboundCallSticky,
  AgencyInboundCatalogSource,
  AgencyInboundDispositionSource,
  AgencyStationCustomerWaitingFrame,
  AgencyStationInboundCallFrame,
  AgencyInboundCallOutcome,
  AgencyInboundCallState,
  AgencyInboundClips,
  AgencyInboundClipSlot,
  AgencyInboundFollowUpStatus,
  AgencyInboundHoliday,
  AgencyInboundHoursInterval,
  AgencyInboundMissedReason,
  AgencyInboundRouteConfig,
  AgencyInboundStickyMode,
  AgencyInboundStickyReason,
  AgencyInboundUnconnectedAction,
} from '../../agency/inbound';
export type { AgencyInboundErrorCode } from '../../errors';
export { AGENCY_INBOUND_ERROR_CODES } from '../../errors';

/** A refusal from an inbound route. */
export interface AgencyInboundErrorResponse {
  /** The HTTP reason (`Bad Request`, `Conflict`, …). */
  error: string;
  code: AgencyInboundErrorCode;
  /** English fallback copy; the console words each code itself. */
  message: string;
  /**
   * `inbound_route_invalid`: one entry per problem, `path` in the body's own terms
   * (`weekly_hours[2].end`, `clips.greeting`, `after_hours_action`).
   */
  details?: Array<{ path: string; message: string }>;
  /** `inbound_number_not_found` / `_not_linked` / `_in_use`: the number refused. */
  phone_number_id?: string;
  /** `inbound_number_in_use`: the route holding it, when it is one of this account's (else absent). */
  route_id?: string;
  /** `inbound_call_live`, and the inbound call routes' refusals: the call refused for. */
  inbound_call_id?: string;
  /** `inbound_disposition_invalid` with `reason: 'unknown_code'`: the codes the call's catalog accepts. */
  allowed_codes?: string[];
  /** `inbound_disposition_invalid`: which rule refused (the soft phone's four). */
  reason?: 'unknown_code' | 'note_required' | 'datetime_required' | 'invalid_callback_at';
  /** `inbound_clip_invalid`: why the upload was refused. */
  upload_reason?: AgencyInboundClipInvalidReason;
  /** `inbound_clip_in_use`: the account's live routes that play the recording. */
  routes?: AgencyInboundClipRouteRef[];
}

/**
 * 409 `inbound_call_live` from the campaign session routes (`available`, `force-available`,
 * `leave`): the session holds an inbound call that is offered, connected or awaiting its outcome.
 * The agent's own console already shows it (the `inbound_call` frame, re-sent after every
 * reconnect); a supervisor is told which call.
 */
export interface AgencyInboundCallLiveRefusal extends AgencyInboundErrorResponse {
  code: 'inbound_call_live';
  inbound_call_id: string;
}

/**
 * The unconnected actions a route may be set to in this build: the callback follow-up (IB3's
 * default) and, since P2 records from our own stream, a voicemail (§7). A create or PATCH that
 * leaves either action on one not listed is refused `inbound_route_invalid` at
 * `after_hours_action` / `overflow_action`, and the console offers only these.
 */
export const AGENCY_INBOUND_AVAILABLE_ACTIONS: readonly AgencyInboundUnconnectedAction[] = Object.freeze(['callback', 'voicemail']);

// ─── What callers hear without a recording of the route's own ──────────────

/**
 * Our standard recordings (docs/inbound.md §3.4): what a caller hears when the route has no
 * recording of its own for a message. Recorded once, offline, in a British English voice
 * (`apps/server/assets/inbound/`, regenerated by `apps/server/scripts/generate-inbound-clips.ts`),
 * and played from our stream; a call answered before anything streams (closed, all lines busy and
 * call-back, where nothing else will play) hears the same words spoken by the carrier instead.
 *  - `please_hold`: the opening of a caller who will wait for an agent, when the route has no
 *    greeting (then the hold sound);
 *  - `recording_notice`: before an agent joins a recorded call (IB7), when the route records,
 *    tells callers and has no notice recording;
 *  - `closed`, `busy`, `callback`: the three messages a caller nobody takes is answered with
 *    (a caller who withheld their number, or whose number is on DNC, is never promised a
 *    callback: they hear `closed` instead of `callback`);
 *  - `voicemail_prompt`: before the beep of a voicemail, when the route has no recording for the
 *    message that would prompt it.
 * The hold slot has no standard recording: an unset hold slot plays the built-in hold tone.
 */
export type AgencyInboundStandardRecording =
  | 'please_hold'
  | 'recording_notice'
  | 'closed'
  | 'busy'
  | 'callback'
  | 'voicemail_prompt';

export const AGENCY_INBOUND_STANDARD_RECORDINGS = [
  'please_hold',
  'recording_notice',
  'closed',
  'busy',
  'callback',
  'voicemail_prompt',
] as const satisfies readonly AgencyInboundStandardRecording[];

/** The exact words of each standard recording, and of the carrier's spoken stand-in for it. */
export const AGENCY_INBOUND_STANDARD_WORDS: Readonly<Record<AgencyInboundStandardRecording, string>> = Object.freeze({
  please_hold: 'Thank you for calling. Please hold and we’ll put you through to the next person available.',
  recording_notice: 'This call may be recorded for quality and training purposes.',
  closed: 'Thank you for calling. We’re closed at the moment. Please call again during our opening hours. Goodbye.',
  busy: 'Thank you for calling. All our lines are busy at the moment. Please try again shortly. Goodbye.',
  callback: 'Thank you for calling. Everyone is busy at the moment, so we’ll call you back as soon as we can. Goodbye.',
  voicemail_prompt: 'Please leave your name and a short message after the tone, and we’ll call you back.',
});

/**
 * The standard recording that stands in for each clip slot when the route leaves it unset; null:
 * none (an unset hold slot plays the built-in hold tone). The greeting's stand-in, "please hold",
 * is played only to a caller who will wait for an agent; before a closed, busy or call-back
 * message an unset greeting is simply skipped.
 */
export const AGENCY_INBOUND_SLOT_STANDARD: Readonly<Record<AgencyInboundClipSlot, AgencyInboundStandardRecording | null>> = Object.freeze({
  greeting: 'please_hold',
  hold: null,
  closed: 'closed',
  busy: 'busy',
  recording_notice: 'recording_notice',
  callback: 'callback',
});

// ─── Route warnings ─────────────────────────────────────────────────────────

/**
 * What a route's warning is about (`inboundRouteWarnings`). Advisory: a route is saved whatever
 * they say.
 *  - `no_opening_hours`: the route has no opening hours, so every caller hears the closed message;
 *  - `connect_unavailable`: this deployment cannot put inbound callers through to agents (media
 *    workers are on, IB8), so callers in opening hours are told everyone is busy;
 *  - `recording_without_notice`: calls are recorded and callers are not told (IB7's notice is off).
 */
export type AgencyInboundRouteWarningCode = 'no_opening_hours' | 'connect_unavailable' | 'recording_without_notice';

/** A route's warning: the field it is about (the editor's path; null: the route as a whole), and what it means, in words. */
export interface AgencyInboundRouteWarning {
  code: AgencyInboundRouteWarningCode;
  path: 'weekly_hours' | 'recording_notice' | null;
  message: string;
}

/**
 * What a route will do that its admin probably does not want (docs/inbound.md §6, §8.4).
 * `connectsAgents`: this deployment puts inbound callers through to agents (the server: one
 * process, IB8; the console reads it from `GET /inbound/clips`, `connects_agents`). A message with
 * no recording is never a warning: our standard recording plays (or the carrier speaks the same
 * words), so no caller is put down in silence.
 */
export function inboundRouteWarnings(
  config: Pick<AgencyInboundRouteConfig, 'weekly_hours' | 'record_calls' | 'recording_notice'>,
  opts: { connectsAgents: boolean },
): AgencyInboundRouteWarning[] {
  const out: AgencyInboundRouteWarning[] = [];
  if (config.weekly_hours.length === 0) {
    out.push({
      code: 'no_opening_hours', path: 'weekly_hours',
      message: 'Closed at all times: callers always hear the closed message. Add opening hours to take calls.',
    });
  }
  if (!opts.connectsAgents) {
    out.push({
      code: 'connect_unavailable', path: null,
      message: 'Calls can’t be put through to agents on this deployment, so callers hear the busy message: everyone is busy and we’ll call them back.',
    });
  }
  if (config.record_calls && !config.recording_notice) {
    out.push({
      code: 'recording_without_notice', path: 'recording_notice',
      message: 'Calls are recorded without telling callers. Turn on the recording notice unless callers are told some other way.',
    });
  }
  return out;
}

// ─── The inbound call routes (P2, §6): the internal bodies without the server-filled actor ──

/** `PATCH /inbound/calls/:id`. */
export type AgencyInboundCallUpdateRequest = Omit<Core.AgencyInboundCallUpdateRequest, 'agent_user_id' | 'on_behalf'>;

/** `POST /inbound/calls/:id/hangup`: no body. */
export type AgencyInboundCallHangupRequest = Record<string, never>;

/** `POST /inbound/calls/:id/disposition`. */
export type AgencyInboundCallDispositionRequest = Omit<Core.AgencyInboundCallDispositionRequest, 'agent_user_id' | 'on_behalf'>;

/** `POST /inbound/calls/:id/dnc`. */
export type AgencyInboundCallDncRequest = Omit<Core.AgencyInboundCallDncRequest, 'agent_user_id' | 'on_behalf'>;

// ─── The supervisor's queue (P2, §6) ────────────────────────────────────────

/**
 * One route's queue as the supervisor's tile shows it (`GET /inbound/queue`, `agency.supervise`,
 * polled every 5 s): what this process's queue holds now. Not paged; one per live route.
 */
export interface AgencyInboundQueueTile {
  route_id: string;
  route_name: string;
  /** The route's hours say open now. */
  open_now: boolean;
  /** Callers queued for an agent (offered calls are not waiting). */
  waiting: number;
  /** The longest current wait, in whole seconds; 0 with nobody waiting. */
  longest_wait_seconds: number;
  /** Calls offered to or connected with an agent now. */
  connected: number;
  /**
   * Agents free now who could take this route's waiting callers, each caller judged by its own
   * account (a caller matched into another account is that account's agents' alone), or, with
   * nobody waiting, this route's next caller.
   */
  eligible_agents: number;
  /**
   * Nobody could take this route's next caller, now or once their current call or wrap-up ends
   * (everyone on a break, offline, on the phone app or outside the route's pool): such a caller
   * hears the overflow message at once instead of waiting. Says nothing of the route's hours.
   */
  no_agents_available: boolean;
}

export interface AgencyInboundQueueResponse {
  /** By route name. */
  tiles: AgencyInboundQueueTile[];
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/** A number answering a route: its active attachment. */
export interface AgencyInboundRouteNumber {
  phone_number_id: string;
  /** E.164. */
  phone_number: string;
  attached_at: string;
}

/** A live route of the account, as every route read and write answers it. */
export interface AgencyInboundRoute extends AgencyInboundRouteConfig {
  id: string;
  account_id: string;
  /** Live attachments only, by number. */
  numbers: AgencyInboundRouteNumber[];
  created_at: string;
  updated_at: string;
  /**
   * P2: what the route will do that its admin probably does not want
   * (`inboundRouteWarnings`; advisory, never a refusal). Served on every route read and write;
   * absent from a build that does not compute them.
   */
  warnings?: AgencyInboundRouteWarning[];
}

export interface AgencyInboundRoutesResponse {
  /** Oldest first. An account has a handful, so the list is not paged. */
  routes: AgencyInboundRoute[];
}

export interface AgencyInboundRouteResponse {
  route: AgencyInboundRoute;
}

/**
 * `POST /inbound/routes`. `name` and `timezone` are required; every other field takes its
 * `AGENCY_INBOUND_ROUTE_DEFAULTS` value when left out (`clips` per slot). `phone_number_ids`
 * attaches numbers in the same request: each must be one of the tenant's active numbers the
 * account may use, linked to inbound by a super-admin, and on no other live route.
 */
export type AgencyInboundRouteCreateRequest =
  Pick<AgencyInboundRouteConfig, 'name' | 'timezone'>
  & Partial<Omit<AgencyInboundRouteConfig, 'name' | 'timezone' | 'clips'>>
  & {
    clips?: Partial<AgencyInboundRouteConfig['clips']>;
    phone_number_ids?: string[];
  };

/**
 * `PATCH /inbound/routes/:id`: the fields present replace the stored ones (`clips` per slot).
 * `phone_number_ids`, when present, is the route's whole set: numbers left out are detached.
 */
export type AgencyInboundRouteUpdateRequest =
  Partial<Omit<AgencyInboundRouteConfig, 'clips'>>
  & {
    clips?: Partial<AgencyInboundRouteConfig['clips']>;
    phone_number_ids?: string[];
  };

// ─── The route editor's choices ─────────────────────────────────────────────

/**
 * One of the tenant's active numbers this account may use (untagged, or tagged to it), as the
 * route editor offers it. A number can be put on a route only when it is `linked` (a super-admin
 * linked it to inbound, IB6), not `held_elsewhere`, and on no other route of this account
 * (`route_id` null or the route being edited).
 */
export interface AgencyInboundNumberOption {
  phone_number_id: string;
  /** E.164. */
  phone_number: string;
  /** Linked to inbound calls by the service's operators. Unlinked: "contact support" (PL15). */
  linked: boolean;
  /** The live route of THIS account answering it, or null. */
  route_id: string | null;
  route_name: string | null;
  /** It answers a live route of another account of the tenant (an untagged number is shared). */
  held_elsewhere: boolean;
}

export interface AgencyInboundNumbersResponse {
  /** By number. */
  numbers: AgencyInboundNumberOption[];
}

/** A live route of the account that plays a recording (`AgencyInboundClipOption.routes`, `inbound_clip_in_use`). */
export interface AgencyInboundClipRouteRef {
  route_id: string;
  name: string;
}

/** One of the account's audio files (a recording), as a clip slot offers it. */
export interface AgencyInboundClipOption {
  id: string;
  name: string;
  duration_seconds: number | null;
  /** When it was uploaded (ISO-8601). */
  created_at: string;
  /** The account's live routes that play it, by name: a recording in use cannot be deleted. */
  routes: AgencyInboundClipRouteRef[];
}

/**
 * `GET /inbound/clips`: the account's recordings and what this deployment can do with them, the
 * route editor's audio state.
 */
export interface AgencyInboundClipsResponse {
  /** Newest first; at most {@link AGENCY_INBOUND_CLIPS_MAX}. */
  clips: AgencyInboundClipOption[];
  /** Recordings can be uploaded here (the deployment has audio storage). False: `inbound_clip_storage_unavailable`. */
  upload_available: boolean;
  /** This deployment puts inbound callers through to agents (`connect_unavailable`, {@link inboundRouteWarnings}). */
  connects_agents: boolean;
}

/** How many audio files `GET /inbound/clips` lists. */
export const AGENCY_INBOUND_CLIPS_MAX = 200;

/**
 * What `POST /inbound/clips` takes: one file (`multipart/form-data`, field `file`, and an
 * optional `name` field sent BEFORE the file, else the file's name without its extension) of
 * these types, decoded and checked before it is stored. The length is the audio decoder's own
 * maximum (120 s).
 */
export const AGENCY_INBOUND_CLIP_UPLOAD_LIMITS = Object.freeze({
  max_bytes: 5 * 1024 * 1024,
  max_seconds: 120,
  /** The file name extensions a file may have, lower case, with the dot (the `accept` of a file input). */
  extensions: Object.freeze(['.wav', '.mp3', '.ogg']) as readonly string[],
  /** Longest recording name. */
  name_max: 120,
});

/** `POST /inbound/clips` → 201. */
export interface AgencyInboundClipResponse {
  clip: AgencyInboundClipOption;
}

/**
 * Why an upload was refused (`inbound_clip_invalid`'s `upload_reason`):
 *  - `no_file`: no file in the form; `unsupported_type`: not WAV, MP3 or OGG;
 *  - `too_large`: over {@link AGENCY_INBOUND_CLIP_UPLOAD_LIMITS}`.max_bytes`;
 *  - `too_long`: over `max_seconds` of audio; `empty`: no audio in it, or too short to be a recording;
 *  - `undecodable`: the file could not be read as audio (damaged, or not what its type says);
 *  - `name_invalid`: the name is empty or too long.
 */
export type AgencyInboundClipInvalidReason =
  | 'no_file'
  | 'unsupported_type'
  | 'too_large'
  | 'too_long'
  | 'empty'
  | 'undecodable'
  | 'name_invalid';

// ─── The Missed inbound list (§7) ───────────────────────────────────────────

/** One call that reached nobody. */
export interface AgencyInboundMissedCall {
  id: string;
  /** NULL: the tenant default (the number has no route). */
  account_id: string | null;
  route_id: string | null;
  route_name: string | null;
  /** E.164; NULL when the caller withheld their number. */
  from_e164: string | null;
  /** The number they rang, E.164. */
  to_e164: string;
  arrived_at: string;
  ended_at: string;
  reason: AgencyInboundMissedReason;
  outcome: AgencyInboundCallOutcome;
  /** The caller's number is on a DNC list: never dialled automatically; the agent decides. */
  caller_dnc: boolean;
  matched_contact_id: string | null;
  matched_campaign_id: string | null;
  matched_campaign_name: string | null;
  /** When the callback this call booked on the matched contact is due; NULL: none was booked. */
  callback_due_at: string | null;
  has_voicemail: boolean;
  /**
   * P2: where the voicemail plays from (`GET /inbound/missed/:id/voicemail`, relative to the
   * proxy), when `has_voicemail`. Absent from a build that serves no voicemail.
   */
  voicemail_url?: string;
  /** NULL: the account (anyone with the list). */
  assignee_user_id: string | null;
  assignee_name: string | null;
  status: AgencyInboundFollowUpStatus;
  handled_by_user_id: string | null;
  handled_by_name: string | null;
  handled_at: string | null;
}

/**
 * `GET /inbound/missed`. Newest first, keyset paged on (`arrived_at`, `id`). `status` defaults to
 * `open`. `assignee`: `me`, `unassigned`, or a user id (supervise only; without
 * `agency.supervise` the list is always the caller's own and the value is ignored). `reason`
 * narrows to one reason. `from` / `to` bound `arrived_at` (inclusive, exclusive; ISO-8601).
 * `limit` 1–100, default 50.
 */
export interface AgencyInboundMissedListQuery {
  status?: AgencyInboundFollowUpStatus;
  assignee?: string;
  reason?: AgencyInboundMissedReason;
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}

export type AgencyInboundMissedPage = AgencyKeysetPage<AgencyInboundMissedCall>;

/**
 * `POST /inbound/missed/:id/handled`, no body. Idempotent: marking a handled row again answers it
 * as it is, with its first handler and time.
 */
export interface AgencyInboundMarkHandledResponse {
  call: AgencyInboundMissedCall;
}
