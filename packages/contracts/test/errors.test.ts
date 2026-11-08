import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AGENCY_ACTION_ERROR_CODES,
  AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES,
  AGENCY_REPORT_ERROR_CODES,
  AGENCY_ROSTER_REFUSAL_CODES,
  AGENCY_SOFTPHONE_ERROR_CODES,
  type AgencyActionErrorCode,
  type AgencyCampaignLifecycleErrorCode,
  type AgencyReportErrorCode,
  type AgencyRosterRefusalCode,
  type AgencySoftphoneErrorCode,
  type AgencyStationErrorCode,
} from '../src/errors';
import type * as Core from '../src/agency';
import { AgencyApi } from '../src/index';
import type { Equals } from './type-equals';
import {
  CUSTOMER_CALLBACK_STATUSES,
  CUSTOMER_HISTORY_ERROR_CODES,
  CUSTOMER_RECORDING_STATES,
  CUSTOMER_SEARCH_BYS,
  CUSTOMER_SEARCH_NUMBER_ERRORS,
  CUSTOMER_TIMELINE_CHANNELS,
  CUSTOMER_TIMELINE_KINDS,
  type CustomerCallbackStatus,
  type CustomerHistoryErrorCode,
  type CustomerRecordingState,
  type CustomerSearchBy,
  type CustomerSearchNumberError,
  type CustomerTimelineChannel,
  type CustomerTimelineKind,
} from '../src/api/agency/customer-history';

/**
 * SNAPSHOT — written out by hand, deliberately not derived from the list under test.
 *
 * 20 members: 16 before `session_on_other_campaign` and `agent_on_live_call`, 18 before
 * `not_staffed`, 19 before `state_changing`.
 */
const CORE_FIXTURE_ACTION_ERROR_CODES = [
  'missing_actor',
  'not_your_attempt',
  'unknown_disposition_code',
  'invalid_dnc_scope',
  'note_required',
  'datetime_required',
  'invalid_callback_at',
  'attempt_not_dispositionable',
  'already_dispositioned',
  'unknown_break_reason',
  'break_already_applied',
  'session_ended',
  'session_on_other_campaign',
  'agent_on_live_call',
  'no_station',
  'attempt_not_live',
  'campaign_not_running',
  'feature_disabled',
  'not_staffed',
  'state_changing',
  'redial_not_allowed',
  'redial_limit_reached',
  'disposition_already_submitted',
  'redial_blocked_dnc',
  'redial_blocked_calling_hours',
  'redial_blocked',
];

// ── Type-level: the lists are exactly their unions (the runtime twin of the
//    two-sided guards in src/errors.ts; these fail `pnpm lint`, not `pnpm test`).
const _actionExact: Equals<(typeof AGENCY_ACTION_ERROR_CODES)[number], AgencyActionErrorCode> = true;
const _rosterExact: Equals<(typeof AGENCY_ROSTER_REFUSAL_CODES)[number], AgencyRosterRefusalCode> = true;
const _lifecycleExact: Equals<
  (typeof AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES)[number],
  AgencyCampaignLifecycleErrorCode
> = true;
// The errors module re-exports the dialer runtime's unions rather than re-declaring them.
const _actionIsCore: Equals<AgencyActionErrorCode, Core.AgencyActionErrorCode> = true;
const _stationIsCore: Equals<AgencyStationErrorCode, Core.AgencyStationErrorCode> = true;
// The console-facing layer re-exports the same unions.
const _consoleActionAgrees: Equals<AgencyApi.AgencyActionErrorCode, AgencyActionErrorCode> = true;
const _consoleStationAgrees: Equals<AgencyApi.AgencyStationErrorCode, AgencyStationErrorCode> = true;
const _softphoneExact: Equals<(typeof AGENCY_SOFTPHONE_ERROR_CODES)[number], AgencySoftphoneErrorCode> = true;
const _softphoneIsCore: Equals<AgencySoftphoneErrorCode, Core.AgencySoftphoneErrorCode> = true;
const _consoleSoftphoneAgrees: Equals<AgencyApi.AgencySoftphoneErrorCode, AgencySoftphoneErrorCode> = true;
void [_actionExact, _rosterExact, _lifecycleExact, _actionIsCore, _stationIsCore,
  _consoleActionAgrees, _consoleStationAgrees, _softphoneExact, _softphoneIsCore, _consoleSoftphoneAgrees];

function expectUnique(list: readonly string[]): void {
  expect(new Set(list).size).toBe(list.length);
}

describe('action error codes', () => {
  it('equal the snapshot, in order', () => {
    expect([...AGENCY_ACTION_ERROR_CODES]).toEqual(CORE_FIXTURE_ACTION_ERROR_CODES);
  });

  it('has 26 members, all distinct', () => {
    expect(AGENCY_ACTION_ERROR_CODES).toHaveLength(26);
    expectUnique(AGENCY_ACTION_ERROR_CODES);
  });

  it('is the one list the console layer re-exports, not a copy of it', () => {
    expect(AgencyApi.AGENCY_ACTION_ERROR_CODES).toBe(AGENCY_ACTION_ERROR_CODES);
  });

  it('types a member as the union', () => {
    expectTypeOf<'missing_actor'>().toMatchTypeOf<AgencyActionErrorCode>();
    expectTypeOf<'credits_low'>().not.toMatchTypeOf<AgencyActionErrorCode>();
  });
});

describe('roster refusal codes', () => {
  it('are the three refusals, in order', () => {
    expect([...AGENCY_ROSTER_REFUSAL_CODES]).toEqual([
      'campaign_dialing',
      'attempts_live',
      'contacts_total_mismatch',
    ]);
  });
});

describe('campaign-lifecycle codes', () => {
  it('are the ten campaign-lifecycle names, distinct', () => {
    // `another_campaign_running` is retired (decisions MC6): several campaigns may run per account.
    expect([...AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES]).toEqual([
      'invalid_campaign_transition',
      'campaign_not_found',
      'campaign_roster_empty',
      'campaign_roster_exhausted',
      'announcement_not_found',
      'analysis_profile_not_found',
      'telephony_credential_not_found',
      'telephony_credential_not_active',
      'campaign_caller_ids_unavailable',
      'carrier_capacity_unallocated',
    ]);
    expectUnique(AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES);
  });

  it('do not overlap the action union (they were deliberately kept out of it)', () => {
    const action = new Set<string>(AGENCY_ACTION_ERROR_CODES);
    for (const code of AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES) expect(action.has(code)).toBe(false);
    for (const code of AGENCY_ROSTER_REFUSAL_CODES) expect(action.has(code)).toBe(false);
  });
});

describe('soft-phone codes', () => {
  it('equal the snapshot, in order, distinct (SNAPSHOT, written out by hand)', () => {
    expect([...AGENCY_SOFTPHONE_ERROR_CODES]).toEqual([
      'softphone_disabled',
      'invalid_number',
      'caller_id_not_allowed',
      'campaign_not_taggable',
      'dnc_listed',
      'dnc_unavailable',
      'outside_calling_hours',
      'override_note_invalid',
      'contact_in_flight',
      'session_on_campaign',
      'session_on_softphone',
      'session_not_found',
      'wrong_session_kind',
      'not_on_softphone',
      'manual_call_live',
      'outcome_pending',
      'concurrency_limit',
      'station_unavailable',
      'dial_failed',
      'call_not_found',
      'call_settled',
      'disposition_invalid',
      'fields_invalid',
      'settings_invalid',
      'contact_assigned_elsewhere',
      'carrier_account_unavailable',
    ]);
    expectUnique(AGENCY_SOFTPHONE_ERROR_CODES);
  });

  it('is the one list the console layer re-exports, not a copy of it', () => {
    expect(AgencyApi.AGENCY_SOFTPHONE_ERROR_CODES).toBe(AGENCY_SOFTPHONE_ERROR_CODES);
  });

  it('do not overlap the action union: the campaign session routes answer from both', () => {
    // `available` and `break` answer `wrong_session_kind` / `manual_call_live` beside their
    // action codes, so a console switching on `code` must never find one string in both.
    const action = new Set<string>(AGENCY_ACTION_ERROR_CODES);
    for (const code of AGENCY_SOFTPHONE_ERROR_CODES) expect(action.has(code), code).toBe(false);
  });
});

// ── Customer history (src/api/agency/customer-history.ts): each list is exactly its union, both
//    ways (the module's own `AllListed` guards are one-sided: a stray listed value would pass them).
const _chCodesExact: Equals<(typeof CUSTOMER_HISTORY_ERROR_CODES)[number], CustomerHistoryErrorCode> = true;
const _chNumberExact: Equals<(typeof CUSTOMER_SEARCH_NUMBER_ERRORS)[number], CustomerSearchNumberError> = true;
const _chBysExact: Equals<(typeof CUSTOMER_SEARCH_BYS)[number], CustomerSearchBy> = true;
const _chChannelsExact: Equals<(typeof CUSTOMER_TIMELINE_CHANNELS)[number], CustomerTimelineChannel> = true;
const _chKindsExact: Equals<(typeof CUSTOMER_TIMELINE_KINDS)[number], CustomerTimelineKind> = true;
const _chRecordingExact: Equals<(typeof CUSTOMER_RECORDING_STATES)[number], CustomerRecordingState> = true;
const _chCallbackExact: Equals<(typeof CUSTOMER_CALLBACK_STATUSES)[number], CustomerCallbackStatus> = true;
void [_chCodesExact, _chNumberExact, _chBysExact, _chChannelsExact, _chKindsExact, _chRecordingExact, _chCallbackExact];

describe('customer-history codes', () => {
  it('the refusal codes equal the snapshot, in order, distinct (SNAPSHOT, written out by hand)', () => {
    expect([...CUSTOMER_HISTORY_ERROR_CODES]).toEqual([
      'invalid_number',
      'invalid_search_request',
      'invalid_cursor',
      'search_expired',
    ]);
    expectUnique(CUSTOMER_HISTORY_ERROR_CODES);
  });

  it('the number refusals equal the snapshot, in order, distinct (SNAPSHOT, written out by hand)', () => {
    expect([...CUSTOMER_SEARCH_NUMBER_ERRORS]).toEqual([
      'empty',
      'invalid_characters',
      'spreadsheet_number',
      'too_short',
      'invalid_for_country',
    ]);
    expectUnique(CUSTOMER_SEARCH_NUMBER_ERRORS);
  });

  it('the vocabularies the app switches on equal their snapshots (SNAPSHOT, written out by hand)', () => {
    expect([...CUSTOMER_SEARCH_BYS]).toEqual(['phone']);
    expect([...CUSTOMER_TIMELINE_CHANNELS]).toEqual(['campaign', 'softphone']);
    expect([...CUSTOMER_TIMELINE_KINDS]).toEqual(['campaign_call', 'softphone_call', 'callback', 'dnc_mark', 'roster_entry']);
    expect([...CUSTOMER_RECORDING_STATES]).toEqual(['available', 'not_recorded', 'expired', 'no_call']);
    expect([...CUSTOMER_CALLBACK_STATUSES]).toEqual(['kept', 'late', 'missed', 'upcoming', 'due']);
    for (const list of [CUSTOMER_SEARCH_BYS, CUSTOMER_TIMELINE_CHANNELS, CUSTOMER_TIMELINE_KINDS, CUSTOMER_RECORDING_STATES, CUSTOMER_CALLBACK_STATUSES]) {
      expectUnique(list);
    }
  });

});

// ── Reports (src/errors.ts §5, re-exported by src/api/agency/reports.ts; docs/reports.md).
const _reportExact: Equals<(typeof AGENCY_REPORT_ERROR_CODES)[number], AgencyReportErrorCode> = true;
const _consoleReportAgrees: Equals<AgencyApi.AgencyReportErrorCode, AgencyReportErrorCode> = true;
void [_reportExact, _consoleReportAgrees];

describe('report codes', () => {
  it('equal the snapshot, in order, distinct (SNAPSHOT, written out by hand)', () => {
    expect([...AGENCY_REPORT_ERROR_CODES]).toEqual([
      'report_window_invalid',
      'report_window_too_long',
      'report_timezone_invalid',
      'report_subject_not_found',
      'report_queue_full',
      'report_rate_limited',
      'report_not_found',
      'report_not_ready',
      'report_expired',
      'report_format_unavailable',
      'report_subscription_not_found',
      'report_subscription_invalid',
      'report_recipient_invalid',
    ]);
    expectUnique(AGENCY_REPORT_ERROR_CODES);
  });

  it('is the one list the console layer re-exports, not a copy of it', () => {
    expect(AgencyApi.AGENCY_REPORT_ERROR_CODES).toBe(AGENCY_REPORT_ERROR_CODES);
  });

  it('do not overlap the action or soft-phone unions', () => {
    const others = new Set<string>([...AGENCY_ACTION_ERROR_CODES, ...AGENCY_SOFTPHONE_ERROR_CODES]);
    for (const code of AGENCY_REPORT_ERROR_CODES) expect(others.has(code), code).toBe(false);
  });
});
