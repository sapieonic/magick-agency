import type { InboundRefusal } from '../../api/inbound';
import { statClock } from '../format/duration';
import {
  AGENCY_INBOUND_CLIP_UPLOAD_LIMITS,
  AGENCY_INBOUND_ROUTE_LIMITS,
  AGENCY_INBOUND_STANDARD_WORDS,
  type AgencyInboundClipInvalidReason,
  type AgencyInboundStandardRecording,
} from '../../types/inbound';
import type {
  AgencyInboundErrorCode,
  AgencyInboundMissedListQuery,
  AgencyInboundMissedReason,
  AgencyInboundStickyMode,
  AgencyInboundClipSlot,
} from '../../types/inbound';

/**
 * Inbound calls' words (British English). Keyed by the wire's codes, so a code added to the
 * contract fails to compile here until it has words.
 */

export const INBOUND_REFUSAL_COPY: Record<AgencyInboundErrorCode, string> = {
  inbound_disabled: 'Inbound calls aren’t turned on for this account.',
  inbound_route_invalid: 'Some settings need fixing. They’re marked below.',
  inbound_route_not_found: 'This route no longer exists. Someone may have deleted it.',
  inbound_route_name_taken: 'Another route in this account already has that name. Choose another.',
  inbound_number_not_found: 'One of the numbers can’t be used by this account any more. Remove it and save again.',
  inbound_number_not_linked: 'One of the numbers isn’t linked to inbound calls. Contact support to have it linked.',
  inbound_number_in_use: 'One of the numbers already answers another route. Remove it there first, or choose another number.',
  inbound_missed_call_not_found: 'This missed call isn’t yours to handle, or it no longer exists.',
  inbound_call_live: 'An inbound call is in progress or still needs its outcome. Save the outcome first.',
  inbound_call_not_found: 'We can’t find that call any more — it may already be closed.',
  inbound_call_not_dispositionable: 'This call can’t take an outcome: it hasn’t ended, or nobody spoke to the caller.',
  inbound_disposition_invalid: 'That outcome can’t be saved. Check the outcome, its note and its callback time.',
  inbound_outcome_already_saved: 'This call’s outcome is already saved.',
  inbound_clip_not_found: 'This recording no longer exists. Someone may have deleted it.',
  inbound_clip_in_use: 'This recording is in use. Choose another recording where it’s used, then delete it.',
  inbound_clip_invalid: 'That file can’t be used as a recording.',
  inbound_clip_name_taken: 'Another recording in this account already has that name. Choose another.',
  inbound_clip_storage_unavailable: 'Recordings can’t be uploaded here yet: this service has no audio storage set up. Contact support.',
  inbound_missed_call_handled: 'This call has already been handled, so there’s nothing to reassign.',
  inbound_assignee_invalid: 'That person can’t take this account’s missed calls any more. Choose someone else.',
};

/** Why an upload was refused, in the editor's words. */
export const RECORDING_UPLOAD_REFUSAL_COPY: Record<AgencyInboundClipInvalidReason, string> = {
  no_file: 'Choose a file to upload.',
  unsupported_type: 'Upload a WAV, MP3 or OGG file.',
  too_large: `That file is too large. Recordings can be up to ${AGENCY_INBOUND_CLIP_UPLOAD_LIMITS.max_bytes / (1024 * 1024)} MB.`,
  too_long: `That recording is too long. Recordings can be up to ${AGENCY_INBOUND_CLIP_UPLOAD_LIMITS.max_seconds / 60} minutes.`,
  empty: 'That file has no audio in it, or it’s too short to be a recording.',
  undecodable: 'That file couldn’t be read as audio. It may be damaged, or not the type its name says.',
  name_invalid: `Give the recording a name of up to ${AGENCY_INBOUND_CLIP_UPLOAD_LIMITS.name_max} characters.`,
};

/** A refusal in the console's words, naming the number when there is one. */
export function inboundRefusalCopy(refusal: InboundRefusal, numberLabel?: (id: string) => string | null): string {
  if (refusal.code === 'unknown') return refusal.message;
  const base = INBOUND_REFUSAL_COPY[refusal.code];
  const label = refusal.phoneNumberId ? numberLabel?.(refusal.phoneNumberId) : null;
  return label ? `${base} (${label})` : base;
}

export const MISSED_REASON_LABELS: Record<AgencyInboundMissedReason, string> = {
  closed: 'Out of hours',
  abandoned_in_queue: 'Hung up while waiting',
  overflow: 'Nobody free to answer',
  overflow_no_capacity: 'All lines busy',
  failed: 'Couldn’t be answered',
};

export const STICKY_MODE_LABELS: Record<AgencyInboundStickyMode, { label: string; hint: string }> = {
  loose: {
    label: 'Prefer their agent',
    hint: 'Offer the caller to the agent who last dealt with them for a short wait, then to the team.',
  },
  strict: {
    label: 'Wait for their agent',
    hint: 'While their agent is on a call or finishing one, the caller waits for them, up to the longest wait; if nobody answers, the follow-up is theirs. If their agent is offline, on a break or on the phone app, the team answers at once.',
  },
  off: { label: 'Off', hint: 'Every caller goes to the team, longest idle agent first.' },
};

/**
 * The seconds a caller is offered to their agent before the team ("Prefer their agent"): its own
 * label, never the strict mode's name. With "Wait for their agent" the longest wait applies instead.
 */
export const STICKY_WAIT_FIELD = {
  label: 'How long to wait for their agent (seconds)',
  hint: `${AGENCY_INBOUND_ROUTE_LIMITS.STICKY_WAIT_SECONDS.min}–${AGENCY_INBOUND_ROUTE_LIMITS.STICKY_WAIT_SECONDS.max}, then the team. No longer than the longest wait.`,
  strictHint: 'With “Wait for their agent”, the caller waits for them while they’re busy, up to the longest wait instead.',
} as const;

/** A standard recording's words, quoted for a hint. */
function quoted(recording: AgencyInboundStandardRecording): string {
  return `“${AGENCY_INBOUND_STANDARD_WORDS[recording]}”`;
}

/**
 * Each clip slot's label, hint, and what the "no recording of your own" choice means for callers:
 * our standard recording of the words quoted (`AGENCY_INBOUND_STANDARD_WORDS`, the server's own
 * words), or for the hold the built-in hold tone. A greeting left out is replaced by our "please
 * hold" only for callers who wait for an agent; before a closed, busy or call-back message it is
 * skipped.
 */
export const CLIP_SLOT_LABELS: Record<AgencyInboundClipSlot, { label: string; hint: string; none: string }> = {
  greeting: {
    label: 'Greeting',
    hint: `Played as soon as the call is answered. Our standard recording, for callers who wait for an agent: ${quoted('please_hold')}`,
    none: 'Our standard recording',
  },
  recording_notice: {
    label: 'Recording notice',
    hint: `Played before an agent joins, when calls are recorded and callers are told. Our standard recording: ${quoted('recording_notice')}`,
    none: 'Our standard recording',
  },
  hold: { label: 'Hold music', hint: 'Looped while the caller waits for an agent.', none: 'Built-in hold tone' },
  closed: {
    label: 'Closed',
    hint: `Played out of hours and on holidays. Our standard recording: ${quoted('closed')}`,
    none: 'Our standard recording',
  },
  busy: {
    label: 'All lines busy',
    hint: `Played when the route already has as many calls as it takes, and, in opening hours, to a caller nobody can answer whom we can’t call back (their number withheld or on your do-not-call list). Our standard recording: ${quoted('busy')}`,
    none: 'Our standard recording',
  },
  callback: {
    label: 'We’ll call you back',
    hint: `Played when nobody can answer, before the call ends with a callback follow-up. Our standard recording: ${quoted('callback')}`,
    none: 'Our standard recording',
  },
};

/**
 * What a caller nobody answers hears, and what follows (the route editor's "When nobody answers").
 * A caller who may not be promised a callback (number withheld, or on DNC) hears the All lines
 * busy message in opening hours, never the call-back one, and never the Closed one while the line
 * is open; their voicemail prompt asks for their number and promises nothing.
 */
export const UNANSWERED_LEAD =
  'Out of hours the caller hears the Closed message, when every line is busy the All lines busy message, and '
  + 'otherwise the We’ll call you back message: your recording, or our standard one. A caller who withheld their '
  + 'number or is on your do-not-call list is never promised a call back: in opening hours they hear the All lines '
  + 'busy message instead. The call then ends, or, if you choose a voicemail below, the caller can leave a message of '
  + 'up to two minutes after a beep (one we can’t call back is asked for their name and number). Either way it '
  + 'appears under Missed calls, assigned to their agent or the account. A customer on a campaign also gets a '
  + 'callback booked for when you next open.';

/** A recording's length, as the list shows it: `0:04`, `1:30`. */
export function recordingLength(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return '';
  return statClock(Math.max(1, seconds));
}

/** Which routes play a recording, in words; empty when none. */
export function recordingUsedBy(routes: ReadonlyArray<{ name: string }>): string {
  if (routes.length === 0) return '';
  const names = routes.map((r) => `“${r.name}”`);
  const list = names.length === 1 ? names[0]! : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `Used by ${list}`;
}

export interface MissedFiltersDraft {
  status: 'open' | 'handled';
  /** '' (everyone), 'me', 'unassigned', or a user id. Supervisors only. */
  assignee: string;
  reason: '' | AgencyInboundMissedReason;
  /** Local dates, `YYYY-MM-DD`, both inclusive. */
  from: string;
  to: string;
}

export const EMPTY_MISSED_FILTERS: MissedFiltersDraft = { status: 'open', assignee: '', reason: '', from: '', to: '' };

/** The list query for the filters: local dates become instants (`to` exclusive, the next midnight). */
export function missedQueryFromDraft(draft: MissedFiltersDraft): AgencyInboundMissedListQuery {
  const query: AgencyInboundMissedListQuery = { status: draft.status };
  if (draft.assignee) query.assignee = draft.assignee;
  if (draft.reason) query.reason = draft.reason;
  if (draft.from) query.from = new Date(`${draft.from}T00:00:00`).toISOString();
  if (draft.to) {
    const end = new Date(`${draft.to}T00:00:00`);
    end.setDate(end.getDate() + 1);
    query.to = end.toISOString();
  }
  return query;
}
