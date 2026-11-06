/**
 * Customer history: search one phone number and see every interaction with it across the
 * tenant's campaigns and the soft phone, in the accounts the caller can see
 * (`docs/customer-history.md`, decisions CH1–CH12).
 *
 * | Route | Body | Answer |
 * |---|---|---|
 * | `POST /proxy/agency/customers/search` | {@link CustomerSearchRequest} | {@link CustomerSearchResponse} |
 * | `POST /proxy/agency/customers/timeline` | {@link CustomerTimelineRequest} | {@link CustomerTimelinePage} |
 * | `POST /proxy/agency/customers/export` | {@link CustomerExportRequest} | `text/csv` attachment |
 * | `GET /proxy/agency/customers/options` | — | {@link CustomerSearchOptionsResponse} |
 *
 * ── Rules ───────────────────────────────────────────────────────────────────
 * - **The number never travels in a URL.** The search is a `POST` with the raw text in the
 *   body; it answers a short-lived opaque `search_id` bound to the caller, and the timeline
 *   pages and the export name the search by that id, never by the number (CH6).
 * - **Full numbers only** (CH4). `value` is the raw text the person typed; the server cleans
 *   it with the same rule as the console's preview (`packages/domain/src/customer-search-number.ts`)
 *   and answers the E.164 it searched in `key.value`. A partial number is refused `400
 *   invalid_number` with `number_error: 'too_short'`. Nothing searches by a number's ending.
 * - **Scoped by account, inside the query** (CH2). An account-scoped member sees the campaigns
 *   and calls of the accounts they belong to; a tenant-level member sees every account. Rows of
 *   other accounts are left out entirely, never counted as hidden.
 * - **Designed for more keys** (CH3). `by` is `'phone'` in v1. A later key-column search
 *   (`{ by: 'column', column, value }`) answers the same shapes: nothing below assumes the key
 *   is a phone number, and a contact row carries its own `phone_e164`.
 * - **Visibility follows the existing screens** (CH8). Notes and call fields: a caller who can
 *   read the account's campaigns (`agency.campaigns.read`), or the agent who placed the call;
 *   otherwise `notes` is null and `notes_hidden` says there were some. The call page (recording,
 *   transcript, analysis): `agency.supervise` in the call's account, as today; `call_page` is null
 *   otherwise. Who added a DNC entry and why: `agency.dnc.read` in the entry's account, else
 *   `reason` and `added_by` are null (an agent never sees them).
 * - **Timeline order** is `at DESC, key DESC`, one order across every source; pages are keyset
 *   (`next_cursor`), never offset.
 * - Wire codes are never respelled (`canceled`); console copy is British English.
 */
import type { AgencyAttemptOutcome, AgencyCampaignStatus, AgencyContactState } from '../../agency/enums';
import type { AgencyOverrideKind } from '../../agency/session';
import type { AgencyDncEntryScope } from '../../agency/softphone';
import type { AllListed } from '../../primitives';
import type { DncSource } from './dnc';

// ─── The request ────────────────────────────────────────────────────────────

/** What a search is keyed by. v1: the phone number only (CH3). */
export type CustomerSearchBy = 'phone';
export const CUSTOMER_SEARCH_BYS = ['phone'] as const;

/** `POST /proxy/agency/customers/search`. */
export interface CustomerSearchRequest {
  by: CustomerSearchBy;
  /** The raw text as typed: `098765-43210`, `+91 98765 43210`, … At most 64 characters. */
  value: string;
  /**
   * ISO 3166-1 alpha-2 of the country picked next to the box; absent = the platform default (the
   * only way to name a default the picker does not list, which has no ISO entry).
   */
  country?: string;
}

/**
 * `GET /proxy/agency/customers/options`: what the search box needs before the first search.
 * `default_country_code` is the platform default (`DEFAULT_PHONE_COUNTRY_CODE`, `+91` unless
 * configured), in the soft phone bootstrap's form (`+` and digits); the country picker starts on
 * the listed country with that calling code, else on an entry of its own named by the code
 * (`resolveSearchCountry`).
 */
export interface CustomerSearchOptionsResponse {
  default_country_code: string;
}

/** Which channel a call came through. */
export type CustomerTimelineChannel = 'campaign' | 'softphone';
export const CUSTOMER_TIMELINE_CHANNELS = ['campaign', 'softphone'] as const;

/**
 * The timeline's filters. `campaign_ids` names ROOT campaigns: a retry campaign is filtered
 * with its parent (CH7). `from` / `to` are ISO-8601 instants, half-open `[from, to)`. The
 * call-only filters (`outcomes`, `disposition_codes`, `agent_user_ids`, `connected_only`,
 * `channel`) keep only call entries (`campaign_call`, `softphone_call`). Each list takes at most
 * {@link CUSTOMER_FILTER_LIST_MAX} values, and each disposition code 1 to
 * {@link CUSTOMER_FILTER_CODE_MAX} characters; past that the request is `400 invalid_search_request`.
 */
export interface CustomerTimelineFilters {
  campaign_ids?: string[];
  from?: string;
  to?: string;
  outcomes?: AgencyAttemptOutcome[];
  disposition_codes?: string[];
  agent_user_ids?: string[];
  connected_only?: boolean;
  channel?: CustomerTimelineChannel;
}

/** `POST /proxy/agency/customers/timeline`: a later page, or the first page under new filters. */
export interface CustomerTimelineRequest {
  search_id: string;
  filters?: CustomerTimelineFilters;
  /** `next_cursor` of the previous page; absent for the first page. */
  cursor?: string;
  /** 1–100, default {@link CUSTOMER_TIMELINE_PAGE_SIZE}. */
  limit?: number;
}

/** `POST /proxy/agency/customers/export`: the whole history the caller can see, as CSV. */
export interface CustomerExportRequest {
  search_id: string;
  filters?: CustomerTimelineFilters;
}

export const CUSTOMER_TIMELINE_PAGE_SIZE = 50;
/** The most values one list filter of {@link CustomerTimelineFilters} takes. */
export const CUSTOMER_FILTER_LIST_MAX = 100;
/** The longest disposition code a filter takes (`agency_call_attempts.disposition_code` is 50). */
export const CUSTOMER_FILTER_CODE_MAX = 50;
export const CUSTOMER_TIMELINE_PAGE_MAX = 100;
/** The longest raw search text the server reads. */
export const CUSTOMER_SEARCH_VALUE_MAX = 64;

// ─── Refusals ───────────────────────────────────────────────────────────────

/**
 * Why the number was refused (`400 invalid_number`'s `number_error`). The console and the app
 * show the same message for each (`searchNumberErrorMessage` in `packages/domain`, and its Dart
 * port); the server's `message` is that text.
 */
export type CustomerSearchNumberError =
  | 'empty'
  | 'invalid_characters'
  | 'spreadsheet_number'
  | 'too_short'
  | 'invalid_for_country';
export const CUSTOMER_SEARCH_NUMBER_ERRORS = [
  'empty',
  'invalid_characters',
  'spreadsheet_number',
  'too_short',
  'invalid_for_country',
] as const;

/**
 * The family's refusal codes (`400` unless noted):
 * - `invalid_number`: the number could not be read; `number_error` says why.
 * - `invalid_search_request`: a malformed body (an unknown `by`, a bad filter, a `limit` out of range).
 * - `invalid_cursor`: a `cursor` this server did not mint.
 * - `search_expired` (`404`): the `search_id` is unknown, expired, or another user's. Search again.
 */
export type CustomerHistoryErrorCode =
  | 'invalid_number'
  | 'invalid_search_request'
  | 'invalid_cursor'
  | 'search_expired';
export const CUSTOMER_HISTORY_ERROR_CODES = [
  'invalid_number',
  'invalid_search_request',
  'invalid_cursor',
  'search_expired',
] as const;

export interface CustomerHistoryErrorResponse {
  error: string;
  code: CustomerHistoryErrorCode;
  message: string;
  /** With `invalid_number` only. */
  number_error?: CustomerSearchNumberError;
}

// ─── Shared pieces ──────────────────────────────────────────────────────────

/** A person in the tenant (an agent, the owner of a contact, who booked a callback). */
export interface CustomerHistoryUser {
  user_id: string;
  /** NULL when the user row is gone. */
  name: string | null;
}

/** A campaign as the history names it. A retry campaign carries its chain's root. */
export interface CustomerHistoryCampaign {
  id: string;
  name: string;
  status: AgencyCampaignStatus;
  account_id: string;
  /** The first campaign of its retry chain (itself for an original campaign). */
  root_id: string;
  /** 0 for an original campaign, 1 for its first retry, … */
  retry_generation: number;
}

/**
 * What the call's recording looks like from here:
 * `available` (recorded, the call page plays it), `not_recorded`, `expired` (deleted by
 * retention: "Recording expired", never a broken player), `no_call` (nothing was placed).
 */
export type CustomerRecordingState = 'available' | 'not_recorded' | 'expired' | 'no_call';
export const CUSTOMER_RECORDING_STATES = ['available', 'not_recorded', 'expired', 'no_call'] as const;

// ─── The summary ────────────────────────────────────────────────────────────

/** One column of a roster row, as the campaign displays it (`context_display.hero`). */
export interface CustomerHistoryField {
  column: string;
  value: string;
}

/**
 * One roster row carrying the number: who the number belongs to in that campaign. Several
 * people on one number (a household line) are several rows, never merged. A contact and its
 * retry copies are ONE row (CH7): `campaign` is the newest campaign of the chain the contact is
 * in, `campaigns` every campaign of the chain the contact appears in, oldest first.
 */
export interface CustomerHistoryContact {
  /** The newest row of the chain. */
  contact_id: string;
  root_contact_id: string;
  account_id: string;
  account_name: string | null;
  phone_e164: string;
  campaign: CustomerHistoryCampaign;
  campaigns: CustomerHistoryCampaign[];
  state: AgencyContactState;
  /** `dnc | invalid | max_attempts | manual` when `state` is `suppressed`. */
  suppressed_reason: string | null;
  /** Placed calls across the chain. */
  attempt_count: number;
  /** The row's hero columns (the campaign's `context_display.hero`), else its first columns. */
  fields: CustomerHistoryField[];
  /** The agent the contact is assigned to (contact assignment); NULL = the shared pool. */
  assigned_to: CustomerHistoryUser | null;
  /** When the number entered the chain's first campaign. */
  entered_at: string;
  /**
   * The roster upload the row most likely came from: the campaign's import whose run covered
   * `entered_at`. NULL when none matches (a row added by the API).
   */
  upload_file_name: string | null;
}

/**
 * A DNC entry that covers the number, at its level. `account_id` is the account the entry belongs
 * to: its own, or its campaign's for a campaign mark (stored without one); NULL only for a
 * tenant-wide entry.
 */
export interface CustomerHistoryDncEntry {
  id: string;
  scope: AgencyDncEntryScope;
  account_id: string | null;
  account_name: string | null;
  campaign: { id: string; name: string | null } | null;
  source: DncSource;
  /** NULL when the caller lacks `agency.dnc.read` in the entry's account (a tenant-wide entry: in their highest role in the tenant) (CH8). */
  reason: string | null;
  /**
   * The person who added it, resolved from a user id; else the stored text (an import, an API key).
   * NULL when the caller lacks `agency.dnc.read` there, as `reason`.
   */
  added_by: string | null;
  created_at: string;
}

/** A callback booked and not yet dialled. */
export interface CustomerHistoryOpenCallback {
  contact_id: string;
  campaign: CustomerHistoryCampaign;
  due_at: string;
  /** The contact's owner, who the callback is routed to first; NULL = the pool. */
  owner: CustomerHistoryUser | null;
  booked_by: CustomerHistoryUser | null;
  disposition_code: string | null;
}

/** An outcome that granted the contact an override (Promise To Pay and the like), not yet spent. */
export interface CustomerHistoryOpenOverride {
  contact_id: string;
  campaign: CustomerHistoryCampaign;
  disposition_code: string;
  granted_at: string;
  /** The follow-up: when the contact is next due to be dialled (`next_attempt_at`); NULL when none is scheduled. */
  follow_up_at: string | null;
  extra_attempts: number;
  retry_delay: boolean;
  calling_hours: boolean;
}

/** A call to the number live right now. */
export interface CustomerHistoryLiveCall {
  channel: CustomerTimelineChannel;
  campaign: CustomerHistoryCampaign | null;
  agent: CustomerHistoryUser | null;
  started_at: string;
}

export interface CustomerHistoryTotals {
  /** Calls placed, campaign and soft phone. */
  calls: number;
  connected: number;
  last_contacted: {
    at: string;
    channel: CustomerTimelineChannel;
    agent: CustomerHistoryUser | null;
    outcome: AgencyAttemptOutcome | null;
    disposition_code: string | null;
  } | null;
}

export interface CustomerHistorySummary {
  /** Newest first, at most 2,000 roster rows (`CUSTOMER_HISTORY_MAX_CONTACT_ROWS` on the server). */
  contacts: CustomerHistoryContact[];
  /**
   * Present, and `true`, only when the number is on more than 2,000 roster rows in the accounts the
   * caller can see (a placeholder number pasted into rosters thousands of times): this history
   * covers the 2,000 most recent of them. The summary, the totals, the timeline and the export
   * alike leave out the older rows and the calls reached only through them (campaign calls are);
   * every soft-phone call dialled to the number is still included.
   */
  contacts_truncated?: true;
  totals: CustomerHistoryTotals;
  /** Every entry covering the number at tenant, account or campaign level; empty = not on DNC. */
  dnc: CustomerHistoryDncEntry[];
  open: {
    callbacks: CustomerHistoryOpenCallback[];
    overrides: CustomerHistoryOpenOverride[];
    live_calls: CustomerHistoryLiveCall[];
  };
  /** What the filters can offer: root campaigns, agents, outcomes and codes seen. */
  filter_options: {
    campaigns: Array<{ id: string; name: string }>;
    agents: CustomerHistoryUser[];
    outcomes: AgencyAttemptOutcome[];
    disposition_codes: string[];
  };
}

// ─── The timeline ───────────────────────────────────────────────────────────

export type CustomerTimelineKind = 'campaign_call' | 'softphone_call' | 'callback' | 'dnc_mark' | 'roster_entry';
export const CUSTOMER_TIMELINE_KINDS = ['campaign_call', 'softphone_call', 'callback', 'dnc_mark', 'roster_entry'] as const;

interface CustomerTimelineBase {
  /** Unique across kinds: `<kind>:<id>`. The tie-break of the order. */
  key: string;
  kind: CustomerTimelineKind;
  at: string;
  account_id: string | null;
}

/** A campaign call (a pacing dial, an agent's manual dial on a contact, a wrap-up redial). */
export interface CustomerTimelineCampaignCall extends CustomerTimelineBase {
  kind: 'campaign_call';
  attempt_id: string;
  contact_id: string;
  campaign: CustomerHistoryCampaign;
  attempt_number: number;
  agent: CustomerHistoryUser | null;
  outcome: AgencyAttemptOutcome | null;
  disposition_code: string | null;
  talk_seconds: number | null;
  notes: string | null;
  notes_hidden: boolean;
  callback_at: string | null;
  /** The wrap-up redial chain: the attempt this redialled, and the chain's first attempt. */
  redial_of_attempt_id: string | null;
  chain_attempt_id: string;
  redial_number: number;
  /** Overrides spent on this dial (`extra_attempts | retry_delay | calling_hours`) and the agent's note. */
  override_applied: AgencyOverrideKind[];
  override_note: string | null;
  recording: CustomerRecordingState;
  /** Where the call page lives; NULL when the caller cannot open it (CH8). */
  call_page: { account_id: string; campaign_id: string; attempt_id: string } | null;
}

/** A soft-phone call to the number, logged to a campaign or not. */
export interface CustomerTimelineSoftphoneCall extends CustomerTimelineBase {
  kind: 'softphone_call';
  manual_call_id: string;
  campaign: CustomerHistoryCampaign | null;
  contact_id: string | null;
  agent: CustomerHistoryUser | null;
  outcome: AgencyAttemptOutcome | null;
  disposition_code: string | null;
  talk_seconds: number | null;
  notes: string | null;
  notes_hidden: boolean;
  /** The call details the agent entered, by key; NULL when hidden. */
  fields: Record<string, string | number | boolean | null> | null;
  dnc_override_note: string | null;
  hours_override_note: string | null;
  callback_at: string | null;
  recording: CustomerRecordingState;
  call_page: { account_id: string; manual_call_id: string } | null;
}

/** Whether a booked callback was kept: dialled within 15 minutes of its time, after it, or not yet. */
export type CustomerCallbackStatus = 'kept' | 'late' | 'missed' | 'upcoming' | 'due';
export const CUSTOMER_CALLBACK_STATUSES = ['kept', 'late', 'missed', 'upcoming', 'due'] as const;

/**
 * A callback booked on a call. `at` is the start of the call it was booked on (its place in the
 * timeline, which re-booking never moves); `due_at` is when the callback is due.
 */
export interface CustomerTimelineCallback extends CustomerTimelineBase {
  kind: 'callback';
  /** The call it was booked on. */
  source: { channel: CustomerTimelineChannel; id: string };
  campaign: CustomerHistoryCampaign | null;
  due_at: string;
  booked_by: CustomerHistoryUser | null;
  status: CustomerCallbackStatus;
  /** When the next call to the number was placed, if any. */
  dialled_at: string | null;
}

/** The number put on a DNC list. */
export interface CustomerTimelineDncMark extends CustomerTimelineBase {
  kind: 'dnc_mark';
  entry: CustomerHistoryDncEntry;
}

/** The number entering a campaign's roster. */
export interface CustomerTimelineRosterEntry extends CustomerTimelineBase {
  kind: 'roster_entry';
  contact_id: string;
  campaign: CustomerHistoryCampaign;
  upload_file_name: string | null;
}

export type CustomerTimelineEntry =
  | CustomerTimelineCampaignCall
  | CustomerTimelineSoftphoneCall
  | CustomerTimelineCallback
  | CustomerTimelineDncMark
  | CustomerTimelineRosterEntry;

export interface CustomerTimelinePage {
  entries: CustomerTimelineEntry[];
  next_cursor: string | null;
}

// ─── The answer ─────────────────────────────────────────────────────────────

/** What was searched, as the server read it. */
export interface CustomerSearchKey {
  by: CustomerSearchBy;
  /** The canonical value searched: the E.164 number. */
  value: string;
  /** For display: `+91 98765 43210`. */
  display: string;
}

export interface CustomerSearchResponse {
  /** Names this search for the timeline and the export; bound to the caller. */
  search_id: string;
  expires_at: string;
  key: CustomerSearchKey;
  summary: CustomerHistorySummary;
  /** The first page, unfiltered. */
  timeline: CustomerTimelinePage;
}

const _bysListed: AllListed<CustomerSearchBy, typeof CUSTOMER_SEARCH_BYS> = true;
const _channelsListed: AllListed<CustomerTimelineChannel, typeof CUSTOMER_TIMELINE_CHANNELS> = true;
const _numberErrorsListed: AllListed<CustomerSearchNumberError, typeof CUSTOMER_SEARCH_NUMBER_ERRORS> = true;
const _codesListed: AllListed<CustomerHistoryErrorCode, typeof CUSTOMER_HISTORY_ERROR_CODES> = true;
const _recordingListed: AllListed<CustomerRecordingState, typeof CUSTOMER_RECORDING_STATES> = true;
const _kindsListed: AllListed<CustomerTimelineKind, typeof CUSTOMER_TIMELINE_KINDS> = true;
const _callbackListed: AllListed<CustomerCallbackStatus, typeof CUSTOMER_CALLBACK_STATUSES> = true;
void _bysListed;
void _channelsListed;
void _numberErrorsListed;
void _codesListed;
void _recordingListed;
void _kindsListed;
void _callbackListed;
