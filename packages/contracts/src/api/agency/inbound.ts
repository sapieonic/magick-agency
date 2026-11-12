/**
 * **NEW.** Inbound calls in the console (`docs/inbound.md` §7, §8): an account's inbound routes
 * and its Missed inbound list. The vocabularies and the route configuration are the dialer
 * contract's (`../../agency/inbound.ts`), re-exported here so a console file needs one import.
 *
 * Routes (under `/proxy/agency`, Firebase session, tenant and account headers). The
 * `agency_inbound_enabled` flag (else `403 inbound_disabled`) gates the route editor's routes
 * only: `/inbound/routes*`, `/inbound/numbers` and `/inbound/clips*` (the standard recordings'
 * preview included), and the supervisor's `GET /inbound/queue`. The Missed routes below (the
 * list, the voicemail, Mark handled, reopen, the count, the reassign), `GET /inbound/summary` and
 * the answered call's finish routes (`/inbound/calls/:id*`) are never gated, so the follow-ups of
 * calls taken before the switch stay workable (the kill switch, docs/inbound.md §8.1):
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
 *  - `GET    /inbound/clips/:id/audio`        `agency.inbound.write` → the recording's bytes, as stored (its audio type),
 *    for the editor's preview; the account's own (`inbound_clip_not_found` otherwise); `Cache-Control: private, no-store`
 *  - `GET    /inbound/clips/standard/:recording/audio`  `agency.inbound.write` → one of our standard recordings
 *    ({@link AGENCY_INBOUND_STANDARD_RECORDINGS}), `audio/wav`, for the preview; an unknown name is `inbound_clip_not_found`
 *  - `GET    /inbound/missed`                 `agency.inbound.read`, {@link AgencyInboundMissedListQuery} → {@link AgencyInboundMissedPage}
 *  - `POST   /inbound/missed/:id/handled`     `agency.inbound.read`, no body → {@link AgencyInboundMarkHandledResponse}
 *  - `POST   /inbound/missed/:id/reopen`      `agency.inbound.read`, no body → {@link AgencyInboundReopenResponse}
 *    (a handled row back on the list; the Mark handled rules; audited `agency_inbound_call.reopened`)
 *  - `GET    /inbound/missed/:id/voicemail`   `agency.inbound.read` → the row's voicemail, `audio/wav`, streamed (P2;
 *    a `Range` request is answered 206; the Missed list's assignee rule; `inbound_missed_call_not_found` when the
 *    row has none, or it has aged out; `Cache-Control: private, no-store`, so no copy outlives the retention purge)
 *  - `GET    /inbound/missed/count`           `agency.inbound.read`, {@link AgencyInboundMissedCountQuery} →
 *    {@link AgencyInboundMissedCountResponse} (the nav badge; the list's `assignee` scope, IQ57, and `since`, IQ50;
 *    not behind the flag: Missed rows stay readable with inbound turned off)
 *  - `POST   /inbound/missed/:id/claim`       `agency.inbound.read`, no body → {@link AgencyInboundMissedClaimResponse}
 *    (IQ49: an agent takes an unassigned row from the Team view; `inbound_missed_call_claimed` when someone has it,
 *    `inbound_missed_call_handled` when it is done; not behind the flag; audited `agency_inbound_call.claimed`)
 *  - `POST   /inbound/missed/:id/assign`      `agency.supervise`, {@link AgencyInboundMissedAssignRequest} →
 *    {@link AgencyInboundMissedAssignResponse} (not behind the flag; audited `agency_inbound_call.reassigned`)
 *  - `GET    /inbound/summary`                `agency.supervise`, {@link AgencyInboundSummaryQuery} → {@link AgencyInboundSummary}
 *    (not behind the flag: a report of calls that happened)
 *
 * Every route read and write carries the route's `warnings` (P2, {@link inboundRouteWarnings}).
 *
 * `agency.inbound.read` floors at `agent`: an agent sees and handles only the rows assigned to
 * them (the route forces `assignee=me`), and (IQ49) reads the account's UNASSIGNED rows with
 * `assignee=unassigned` (the Team view) and claims one; with `agency.supervise` the caller sees the
 * account's.
 * Refusals are {@link AgencyInboundErrorResponse} (`../../errors.ts` §6); a malformed query (a bad
 * cursor, an unknown filter value) or a body that is not JSON is the agency surface's ordinary 400.
 */

import type { AgencyKeysetPage } from '../../agency/spine';
import type * as Core from '../../agency/inbound';
import type {
  AgencyInboundCallOutcome,
  AgencyInboundClipSlot,
  AgencyInboundClosedCause,
  AgencyInboundFollowUpStatus,
  AgencyInboundHandledReason,
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
  AGENCY_INBOUND_CLOSED_CAUSES,
  AGENCY_INBOUND_FOLLOW_UP_STATUSES,
  AGENCY_INBOUND_HANDLED_REASONS,
  AGENCY_INBOUND_MISSED_REASONS,
  AGENCY_INBOUND_ROUTE_DEFAULTS,
  AGENCY_INBOUND_ROUTE_LIMITS,
  AGENCY_INBOUND_STICKY_MODES,
  AGENCY_INBOUND_STICKY_REASONS,
  AGENCY_INBOUND_UNCONNECTED_ACTIONS,
  AGENCY_INBOUND_OFFER_CHANNELS,
  AGENCY_INBOUND_RING_MS,
  AGENCY_INBOUND_ACCEPT_GRACE_MS,
  AGENCY_INBOUND_RING_MAX_MISSES,
  AGENCY_INBOUND_RING_RESULTS,
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
  AgencyInboundClosedCause,
  AgencyInboundFollowUpStatus,
  AgencyInboundHandledReason,
  AgencyInboundHoliday,
  AgencyInboundHoursInterval,
  AgencyInboundMissedReason,
  AgencyInboundRouteConfig,
  AgencyInboundStickyMode,
  AgencyInboundStickyReason,
  AgencyInboundUnconnectedAction,
  AgencyInboundOfferChannel,
  AgencyInboundRingResult,
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
 *    callback: in opening hours they hear `busy` instead of `callback`);
 *  - `voicemail_prompt`: before the beep of a voicemail, when the route has no recording for the
 *    message that would prompt it;
 *  - `voicemail_prompt_neutral`: before the beep of a voicemail left by a caller who may not be
 *    promised a callback (withheld, DNC): it asks for their number and promises nothing.
 * The hold slot has no standard recording: an unset hold slot plays the built-in hold tone.
 */
export type AgencyInboundStandardRecording =
  | 'please_hold'
  | 'recording_notice'
  | 'closed'
  | 'busy'
  | 'callback'
  | 'voicemail_prompt'
  | 'voicemail_prompt_neutral';

export const AGENCY_INBOUND_STANDARD_RECORDINGS = [
  'please_hold',
  'recording_notice',
  'closed',
  'busy',
  'callback',
  'voicemail_prompt',
  'voicemail_prompt_neutral',
] as const satisfies readonly AgencyInboundStandardRecording[];

/** The exact words of each standard recording, and of the carrier's spoken stand-in for it. */
export const AGENCY_INBOUND_STANDARD_WORDS: Readonly<Record<AgencyInboundStandardRecording, string>> = Object.freeze({
  please_hold: 'Thank you for calling. Please hold and we’ll put you through to the next person available.',
  recording_notice: 'This call may be recorded for quality and training purposes.',
  closed: 'Thank you for calling. We’re closed at the moment. Please call again during our opening hours. Goodbye.',
  busy: 'Thank you for calling. All our lines are busy at the moment. Please try again shortly. Goodbye.',
  callback: 'Thank you for calling. Everyone is busy at the moment, so we’ll call you back as soon as we can. Goodbye.',
  voicemail_prompt: 'Please leave your name and a short message after the tone, and we’ll call you back.',
  voicemail_prompt_neutral: 'Please leave your name, your number and a short message after the tone.',
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
 *    workers are on, IB8), so nobody is put through: callers in opening hours hear the call-back
 *    message (the busy message, for a caller who may not be promised a callback);
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
      message: 'Calls can’t be put through to agents on this deployment, so nobody is put through: in opening hours, callers hear our “we’ll call you back” message (or, if they withheld their number or are on your do-not-call list, our “all lines busy” message).',
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
  /**
   * With `reason` `closed`: why the caller was answered as closed (0030): out of `hours`, inbound
   * `switched_off` for the account, `no_route` for the number, or the carrier credential
   * `credential_inactive`. NULL on another reason's row, or a closed row from before it was recorded.
   */
  closed_cause: AgencyInboundClosedCause | null;
  outcome: AgencyInboundCallOutcome;
  /** The caller's number is on a DNC list: never dialled automatically; the agent decides. */
  caller_dnc: boolean;
  /**
   * IQ54: the matched contact's display name (the roster's `name`, `full_name`, `customer_name` or
   * `first_name` column, the first that has one, trimmed, at most 100 characters: the name the
   * "customer is waiting" notice shows); null when the caller matched no contact, withheld their
   * number, or the contact has no name. Shown above the number.
   */
  match_name: string | null;
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
  /**
   * The assignee is no longer an active member who can work the account's rows (removed,
   * deactivated): the console shows "Former member" and offers a supervisor Reassign. False when
   * the row is the account's. Filled by the public layer.
   */
  assignee_departed: boolean;
  status: AgencyInboundFollowUpStatus;
  /**
   * How it was handled: `marked` by a person, or `reached` (the customer was put through to an
   * agent of the account afterwards; `handled_by_user_id` is that agent). NULL while open.
   */
  handled_reason: AgencyInboundHandledReason | null;
  handled_by_user_id: string | null;
  handled_by_name: string | null;
  handled_at: string | null;
}

/**
 * `GET /inbound/missed`. Newest first, keyset paged on (`arrived_at`, `id`). `status` defaults to
 * `open`. `assignee` ({@link AGENCY_INBOUND_MISSED_ASSIGNEE_ME}, {@link AGENCY_INBOUND_MISSED_ASSIGNEE_UNASSIGNED}
 * or a user id):
 *  - `unassigned`: the account's rows assigned to nobody (an unmatched or withheld caller nobody
 *    answered), for ANY caller with the list, an agent included (IQ49, the "Team" view);
 *  - `me`: the caller's own rows;
 *  - a user id: that person's rows, with `agency.supervise` only;
 *  - absent: the account's rows with `agency.supervise`.
 * Without `agency.supervise` every value but `unassigned` reads the caller's own rows. `reason`
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

/** `assignee=me` on the Missed list and its count: the caller's own rows. */
export const AGENCY_INBOUND_MISSED_ASSIGNEE_ME = 'me';
/** `assignee=unassigned` on the Missed list and its count: the account's rows assigned to nobody (IQ49's Team view). */
export const AGENCY_INBOUND_MISSED_ASSIGNEE_UNASSIGNED = 'unassigned';

/**
 * `POST /inbound/missed/:id/claim`, no body (IQ49): the caller takes an OPEN row that is assigned
 * to nobody; it is assigned to them and moves to their own list. Any caller with the list may
 * claim (an agent, from the Team view). A compare-and-set: only while the row is unassigned.
 * Claiming a row already the caller's answers it as it is (idempotent); one someone else has is
 * `409 inbound_missed_call_claimed`; a handled row is `409 inbound_missed_call_handled`; a row
 * that is not the account's is `404 inbound_missed_call_not_found`. Audited
 * `agency_inbound_call.claimed` when it changed.
 */
export interface AgencyInboundMissedClaimResponse {
  call: AgencyInboundMissedCall;
}

/**
 * `POST /inbound/missed/:id/handled`, no body. Idempotent: marking a handled row again answers it
 * as it is, with its first handler and time.
 */
export interface AgencyInboundMarkHandledResponse {
  call: AgencyInboundMissedCall;
}

/**
 * `POST /inbound/missed/:id/reopen`, no body: put a HANDLED row back on the list (`open`, its
 * `handled_reason`, handler and time cleared), for a row marked by mistake or closed as reached
 * when the customer was not. Mark handled's rules: an agent reopens only the rows assigned to
 * them, a supervisor any of the account's; the assignee is kept. Idempotent: an open row is
 * answered as it is. Audited `agency_inbound_call.reopened` (how and by whom it had been handled)
 * when it changed. Not behind the flag.
 */
export interface AgencyInboundReopenResponse {
  call: AgencyInboundMissedCall;
}

/**
 * `POST /inbound/missed/:id/assign` (`agency.supervise`): give an OPEN Missed row to a member of
 * the account, or to the account (`null`). The member must be active and able to work the
 * account's rows (`inbound_assignee_invalid`); a handled row is refused
 * (`inbound_missed_call_handled`). Assigning a row to whom it is already assigned answers it as
 * it is. Audited `agency_inbound_call.reassigned` (`from`, `to`) when it changed.
 */
export interface AgencyInboundMissedAssignRequest {
  assignee_user_id: string | null;
}

export interface AgencyInboundMissedAssignResponse {
  call: AgencyInboundMissedCall;
}

/** The open Missed rows `GET /inbound/missed/count` counts before it stops. */
export const AGENCY_INBOUND_MISSED_COUNT_CAP = 100;

/**
 * `GET /inbound/missed/count`'s query. `assignee` is the list's ({@link AgencyInboundMissedListQuery},
 * the same rules, IQ57): `me` (the caller's own, whoever asks: a supervisor's badge counts what
 * their list shows), `unassigned` (the Team view's rows, for anyone with the list), a user id
 * (supervise only), or absent (an agent's own rows; with `agency.supervise`, the account's, the
 * count before IQ57). `since` (ISO-8601, IQ50): only rows whose call arrived at or after it ("N
 * customers rang while you were away": the app sends when its `device_away` pause began). A
 * malformed value is the agency surface's ordinary 400.
 */
export interface AgencyInboundMissedCountQuery {
  assignee?: string;
  since?: string;
}

/**
 * `GET /inbound/missed/count` (`agency.inbound.read`): the nav badge. The scope is the query's
 * ({@link AgencyInboundMissedCountQuery}); with no `assignee` it is the list's default: an agent's
 * own rows; with `agency.supervise`, the account's.
 */
export interface AgencyInboundMissedCountResponse {
  /** Open rows, at most {@link AGENCY_INBOUND_MISSED_COUNT_CAP}. */
  open: number;
  /** There are more open rows than {@link AGENCY_INBOUND_MISSED_COUNT_CAP}. */
  open_capped: boolean;
  /** The scope (with `since`, those rows) holds any Missed row, open or handled: the list has something to show. */
  has_rows: boolean;
}

/** The longest range `GET /inbound/summary` reads, in days. */
export const AGENCY_INBOUND_SUMMARY_MAX_DAYS = 93;

/**
 * `GET /inbound/summary`: `from` (inclusive) and `to` (exclusive), ISO-8601 instants, `from <
 * to`, at most {@link AGENCY_INBOUND_SUMMARY_MAX_DAYS} days apart. The console sends the
 * viewer's local day boundaries.
 */
export interface AgencyInboundSummaryQuery {
  from: string;
  to: string;
}

/** One agent's inbound work in the range. */
export interface AgencyInboundSummaryAgent {
  user_id: string;
  /** Filled by the public layer; null when the name could not be looked up. */
  name: string | null;
  /** Calls they answered. */
  answered: number;
  talk_seconds: number;
}

/**
 * The account's inbound calls that arrived in the range and have ended (docs/inbound.md §11).
 * Rates are percentages to one decimal, null when their denominator is 0.
 */
export interface AgencyInboundSummary {
  from: string;
  to: string;
  /** Every ended call. */
  calls: number;
  /**
   * Rang while the line was open: not answered with the closed message (after hours, switched off,
   * no route, an inactive credential), not refused at the answer. The rates' denominator.
   */
  open_hours_calls: number;
  /**
   * Rang while the route was closed for its hours or a holiday (the closed message, or a voicemail
   * taken out of hours). Not the calls below, which were also answered with the closed message.
   */
  after_hours: number;
  /** Answered with the closed message because inbound was switched off for the account (the kill switch). */
  switched_off: number;
  /** Rang a number of the account that reaches no route: answered with the closed message. */
  no_route: number;
  answered: number;
  /** answered ÷ open_hours_calls. */
  answer_rate_pct: number | null;
  /** Hung up before anyone answered (`abandoned_in_queue`). */
  abandoned: number;
  /** abandoned ÷ open_hours_calls. */
  abandon_rate_pct: number | null;
  /** From arrival to being put through, over answered calls, in seconds (one decimal). */
  avg_answer_seconds: number | null;
  p90_answer_seconds: number | null;
  voicemails: number;
  /** `nobody_free` + `lines_busy`. */
  overflow: number;
  /**
   * Nobody free to answer (`overflow`): the route's maximum wait or queue length was reached, or
   * nobody in its pool could take calls. The Missed list's "Nobody free to answer".
   */
  nobody_free: number;
  /** Every line busy (`overflow_no_capacity`): over the route's or the account's call limits. The Missed list's "All lines busy". */
  lines_busy: number;
  /**
   * Our side could not serve the call (`failed`), it was turned away at the answer (`rejected`),
   * or the carrier credential it arrived on was not active (answered with the closed message).
   */
  not_served: number;
  /** Open-hours calls that had a sticky agent (§4.1). */
  sticky_calls: number;
  /** Of those, answered by that agent. */
  sticky_answered: number;
  /** sticky_answered ÷ sticky_calls. */
  sticky_hit_rate_pct: number | null;
  /** Missed rows these calls left, and how many are handled. */
  missed: number;
  missed_handled: number;
  /** Busiest first, at most 200. */
  agents: AgencyInboundSummaryAgent[];
}
