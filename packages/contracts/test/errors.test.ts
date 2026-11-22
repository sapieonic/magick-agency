import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AGENCY_ACTION_ERROR_CODES,
  AGENCY_CAMPAIGN_ARCHIVE_ERROR_CODES,
  AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES,
  AGENCY_COMPARE_ERROR_CODES,
  AGENCY_COMPARE_ERROR_STATUS,
  AGENCY_FLOOR_ASSIST_ERROR_CODES,
  AGENCY_INBOUND_ERROR_CODES,
  AGENCY_LISTEN_ERROR_CODES,
  AGENCY_LIVE_CALL_NUMBER_ERROR_CODES,
  AGENCY_REPORT_ERROR_CODES,
  AGENCY_ROSTER_REFUSAL_CODES,
  AGENCY_SOFTPHONE_ERROR_CODES,
  type AgencyActionErrorCode,
  type AgencyCampaignArchiveErrorCode,
  type AgencyCampaignLifecycleErrorCode,
  type AgencyCompareErrorCode,
  type AgencyFloorAssistErrorCode,
  type AgencyInboundErrorCode,
  type AgencyListenErrorCode,
  type AgencyLiveCallNumberErrorCode,
  type AgencyReportErrorCode,
  type AgencyRosterRefusalCode,
  type AgencySoftphoneErrorCode,
  type AgencyStationErrorCode,
} from '../src/errors';
import type * as Core from '../src/agency';
import { AGENCY_AWAY_RING_REFUSAL_CODES, type AgencyAwayRingRefusalCode } from '../src/agency';
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
 * 33 members: 16 before `session_on_other_campaign` and `agent_on_live_call`, 18 before
 * `not_staffed`, 19 before `state_changing`, 20 before the six wrap-up redial codes, 26 before
 * `station_on_other_device` and `session_in_other_tenant`, 28 before `agent_away_ring`, 29
 * before the four promise-to-pay codes.
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
  'station_on_other_device',
  'session_in_other_tenant',
  'agent_away_ring',
  'promise_required',
  'invalid_promise_date',
  'invalid_promise_amount',
  'promise_not_expected',
];

// ── Type-level: the lists are exactly their unions (the runtime twin of the
//    two-sided guards in src/errors.ts; these fail `pnpm lint`, not `pnpm test`).
const _actionExact: Equals<(typeof AGENCY_ACTION_ERROR_CODES)[number], AgencyActionErrorCode> = true;
const _rosterExact: Equals<(typeof AGENCY_ROSTER_REFUSAL_CODES)[number], AgencyRosterRefusalCode> = true;
const _lifecycleExact: Equals<
  (typeof AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES)[number],
  AgencyCampaignLifecycleErrorCode
> = true;
const _archiveExact: Equals<(typeof AGENCY_CAMPAIGN_ARCHIVE_ERROR_CODES)[number], AgencyCampaignArchiveErrorCode> = true;
void _archiveExact;
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

  it('has 33 members, all distinct', () => {
    expect(AGENCY_ACTION_ERROR_CODES).toHaveLength(33);
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
  it('are the eleven campaign-lifecycle names, distinct', () => {
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
      // Start on an archived draft (AR2).
      'campaign_archived',
    ]);
    expectUnique(AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES);
  });

  it('do not overlap the action union (they were deliberately kept out of it)', () => {
    const action = new Set<string>(AGENCY_ACTION_ERROR_CODES);
    for (const code of AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES) expect(action.has(code)).toBe(false);
    for (const code of AGENCY_ROSTER_REFUSAL_CODES) expect(action.has(code)).toBe(false);
  });
});

describe('campaign archive codes (AR1–AR7)', () => {
  it('equal the snapshot, in order, distinct (SNAPSHOT, written out by hand)', () => {
    expect([...AGENCY_CAMPAIGN_ARCHIVE_ERROR_CODES]).toEqual([
      'campaign_not_archivable',
      'campaign_archived',
      'campaign_not_archived',
    ]);
    expectUnique(AGENCY_CAMPAIGN_ARCHIVE_ERROR_CODES);
  });

  it('share only `campaign_archived` with the lifecycle codes, the refusal of Start on an archived draft', () => {
    const lifecycle = new Set<string>(AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES);
    expect(AGENCY_CAMPAIGN_ARCHIVE_ERROR_CODES.filter((c) => lifecycle.has(c))).toEqual(['campaign_archived']);
  });

  it('is the one list the console layer re-exports, not a copy of it', () => {
    expect(AgencyApi.AGENCY_CAMPAIGN_ARCHIVE_ERROR_CODES).toBe(AGENCY_CAMPAIGN_ARCHIVE_ERROR_CODES);
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
      'customer_on_inbound_call',
      // "Every call must belong to a campaign" (docs/call-log.md §5).
      'campaign_required',
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

// ── Inbound (src/errors.ts §6, re-exported by src/api/agency/inbound.ts; docs/inbound.md).
const _inboundExact: Equals<(typeof AGENCY_INBOUND_ERROR_CODES)[number], AgencyInboundErrorCode> = true;
const _consoleInboundAgrees: Equals<AgencyApi.AgencyInboundErrorCode, AgencyInboundErrorCode> = true;
void [_inboundExact, _consoleInboundAgrees];

describe('inbound codes', () => {
  it('equal the snapshot, in order, distinct (SNAPSHOT, written out by hand)', () => {
    expect([...AGENCY_INBOUND_ERROR_CODES]).toEqual([
      'inbound_disabled',
      'inbound_route_invalid',
      'inbound_route_not_found',
      'inbound_route_name_taken',
      'inbound_number_not_found',
      'inbound_number_not_linked',
      'inbound_number_in_use',
      'inbound_missed_call_not_found',
      'inbound_call_live',
      'inbound_call_not_found',
      'inbound_call_not_dispositionable',
      'inbound_disposition_invalid',
      'inbound_outcome_already_saved',
      'inbound_clip_not_found',
      'inbound_clip_in_use',
      'inbound_clip_invalid',
      'inbound_clip_name_taken',
      'inbound_clip_storage_unavailable',
      'inbound_missed_call_handled',
      'inbound_assignee_invalid',
      'inbound_missed_call_claimed',
      // Mode B's ring routes (IQ71).
      'ring_not_offered',
      'ring_expired',
      'already_accepted',
      // "Every call must belong to a campaign" (docs/call-log.md §5).
      'default_campaign_required',
      'inbound_campaign_fixed',
      'inbound_campaign_not_allowed',
    ]);
    expectUnique(AGENCY_INBOUND_ERROR_CODES);
  });

  it('is the one list the console layer re-exports, not a copy of it', () => {
    expect(AgencyApi.AGENCY_INBOUND_ERROR_CODES).toBe(AGENCY_INBOUND_ERROR_CODES);
  });

  it('do not overlap the action, soft-phone or report unions', () => {
    const others = new Set<string>([...AGENCY_ACTION_ERROR_CODES, ...AGENCY_SOFTPHONE_ERROR_CODES, ...AGENCY_REPORT_ERROR_CODES]);
    for (const code of AGENCY_INBOUND_ERROR_CODES) expect(others.has(code), code).toBe(false);
  });
});

// ── Away-ring refusals (src/agency/push-devices.ts, Mode B): the 409s of `POST /sessions/:id/break
//    {reason:'away_ring'}`, answered beside the action codes.
const _awayRingExact: Equals<(typeof AGENCY_AWAY_RING_REFUSAL_CODES)[number], AgencyAwayRingRefusalCode> = true;
void _awayRingExact;

describe('away-ring refusal codes', () => {
  it('equal the snapshot, in order, distinct (SNAPSHOT, written out by hand)', () => {
    expect([...AGENCY_AWAY_RING_REFUSAL_CODES]).toEqual([
      'ring_not_allowed',
      'push_unavailable',
      'no_push_device',
      'ring_disabled',
    ]);
    expectUnique(AGENCY_AWAY_RING_REFUSAL_CODES);
  });

  it('do not overlap the action, soft-phone, inbound or report unions: the break route answers beside them', () => {
    const others = new Set<string>([
      ...AGENCY_ACTION_ERROR_CODES, ...AGENCY_SOFTPHONE_ERROR_CODES, ...AGENCY_INBOUND_ERROR_CODES, ...AGENCY_REPORT_ERROR_CODES,
    ]);
    for (const code of AGENCY_AWAY_RING_REFUSAL_CODES) expect(others.has(code), code).toBe(false);
  });
});

// ── Live call listening (src/errors.ts §7, re-exported by src/api/agency/live-calls.ts; docs/listening.md).
const _listenExact: Equals<(typeof AGENCY_LISTEN_ERROR_CODES)[number], AgencyListenErrorCode> = true;
const _consoleListenAgrees: Equals<AgencyApi.AgencyListenErrorCode, AgencyListenErrorCode> = true;
// A live row's reason is the refusal its grant would answer.
const _notListenableIsACode: AgencyApi.AgencyLiveCallNotListenableReason extends AgencyListenErrorCode ? true : false = true;
// The row's spine id and its campaign's AHT (added with the server side, for "Open call" and the
// amber timer): present, and of these types.
const _rowCorrelation: Equals<AgencyApi.AgencyLiveCall['correlation_id'], string> = true;
const _rowAht: Equals<AgencyApi.AgencyLiveCall['aht_seconds'], number | null> = true;
// A withheld number is said so, not shown as `****` (LS22 i): additive, a boolean.
const _rowWithheld: Equals<AgencyApi.AgencyLiveCall['customer_phone_withheld'], boolean | undefined> = true;
const _numberExact: Equals<(typeof AGENCY_LIVE_CALL_NUMBER_ERROR_CODES)[number], AgencyLiveCallNumberErrorCode> = true;
const _consoleNumberAgrees: Equals<AgencyApi.AgencyLiveCallNumberErrorCode, AgencyLiveCallNumberErrorCode> = true;
void [_listenExact, _consoleListenAgrees, _notListenableIsACode, _rowCorrelation, _rowAht, _rowWithheld, _numberExact, _consoleNumberAgrees];

describe('listen codes', () => {
  it('equal the snapshot, in order, distinct (SNAPSHOT, written out by hand)', () => {
    expect([...AGENCY_LISTEN_ERROR_CODES]).toEqual([
      'listen_call_not_live',
      'listen_recording_off',
      'listen_limit_call',
      'listen_limit_server',
      'listen_own_call',
      'listen_unavailable',
    ]);
    expectUnique(AGENCY_LISTEN_ERROR_CODES);
  });

  it('is the one list the console layer re-exports, not a copy of it', () => {
    expect(AgencyApi.AGENCY_LISTEN_ERROR_CODES).toBe(AGENCY_LISTEN_ERROR_CODES);
  });

  it('a live row\'s not-listenable reasons are three of them (SNAPSHOT, written out by hand)', () => {
    expect([...AgencyApi.AGENCY_LIVE_CALL_NOT_LISTENABLE_REASONS]).toEqual([
      'listen_recording_off',
      'listen_limit_call',
      'listen_own_call',
    ]);
    for (const reason of AgencyApi.AGENCY_LIVE_CALL_NOT_LISTENABLE_REASONS) {
      expect(AGENCY_LISTEN_ERROR_CODES as readonly string[], reason).toContain(reason);
    }
  });

  it('do not overlap the action, soft-phone, report or inbound unions', () => {
    const others = new Set<string>([
      ...AGENCY_ACTION_ERROR_CODES, ...AGENCY_SOFTPHONE_ERROR_CODES, ...AGENCY_REPORT_ERROR_CODES, ...AGENCY_INBOUND_ERROR_CODES,
    ]);
    for (const code of AGENCY_LISTEN_ERROR_CODES) expect(others.has(code), code).toBe(false);
  });

  it('the number reveal\'s own refusal is one code, apart from the listen codes (SNAPSHOT, written out by hand)', () => {
    expect([...AGENCY_LIVE_CALL_NUMBER_ERROR_CODES]).toEqual(['live_call_number_withheld']);
    expect(AgencyApi.AGENCY_LIVE_CALL_NUMBER_ERROR_CODES).toBe(AGENCY_LIVE_CALL_NUMBER_ERROR_CODES);
    const others = new Set<string>([
      ...AGENCY_LISTEN_ERROR_CODES, ...AGENCY_ACTION_ERROR_CODES, ...AGENCY_SOFTPHONE_ERROR_CODES, ...AGENCY_REPORT_ERROR_CODES,
      ...AGENCY_INBOUND_ERROR_CODES,
    ]);
    for (const code of AGENCY_LIVE_CALL_NUMBER_ERROR_CODES) expect(others.has(code), code).toBe(false);
  });
});

// ── Floor assist: Need help and supervisor messages (src/errors.ts §8, LF4, LF5).
const _floorAssistExact: Equals<(typeof AGENCY_FLOOR_ASSIST_ERROR_CODES)[number], AgencyFloorAssistErrorCode> = true;
const _floorAssistCoreAgrees: Equals<Core.AgencyFloorAssistErrorCode, AgencyFloorAssistErrorCode> = true;
void [_floorAssistExact, _floorAssistCoreAgrees];

describe('floor assist codes', () => {
  it('equal the snapshot, in order, distinct (SNAPSHOT, written out by hand)', () => {
    expect([...AGENCY_FLOOR_ASSIST_ERROR_CODES]).toEqual([
      'floor_assist_disabled',
      'help_not_on_call',
      'agent_not_live',
      'message_invalid',
    ]);
    expectUnique(AGENCY_FLOOR_ASSIST_ERROR_CODES);
  });

  it('is the one list the dialer barrel re-exports, not a copy of it', async () => {
    const core = await import('../src/agency');
    expect(core.AGENCY_FLOOR_ASSIST_ERROR_CODES).toBe(AGENCY_FLOOR_ASSIST_ERROR_CODES);
  });

  it('do not overlap the action, soft-phone, inbound, report or listen unions: the session routes answer beside them', () => {
    const others = new Set<string>([
      ...AGENCY_ACTION_ERROR_CODES, ...AGENCY_SOFTPHONE_ERROR_CODES, ...AGENCY_INBOUND_ERROR_CODES, ...AGENCY_REPORT_ERROR_CODES,
      ...AGENCY_LISTEN_ERROR_CODES,
    ]);
    for (const code of AGENCY_FLOOR_ASSIST_ERROR_CODES) expect(others.has(code), code).toBe(false);
  });
});

// ── Compare agents (src/errors.ts §9, re-exported by src/api/agency/compare.ts; docs/compare-agents.md).
const _compareExact: Equals<(typeof AGENCY_COMPARE_ERROR_CODES)[number], AgencyCompareErrorCode> = true;
const _consoleCompareAgrees: Equals<AgencyApi.AgencyCompareErrorCode, AgencyCompareErrorCode> = true;
const _compareStatusKeys: Equals<keyof typeof AGENCY_COMPARE_ERROR_STATUS, AgencyCompareErrorCode> = true;
void [_compareExact, _consoleCompareAgrees, _compareStatusKeys];

describe('compare codes', () => {
  it('equal the snapshot, in order, distinct (SNAPSHOT, written out by hand)', () => {
    expect([...AGENCY_COMPARE_ERROR_CODES]).toEqual([
      'compare_campaign_required',
      'compare_campaign_not_found',
      'compare_too_many_agents',
      'compare_too_many_metrics',
      'compare_metric_invalid',
      'compare_window_invalid',
      'compare_timezone_invalid',
      'compare_agent_not_in_cohort',
      'compare_busy',
      'compare_timed_out',
      'compare_view_not_found',
      'compare_view_invalid',
      'compare_view_limit',
    ]);
    expectUnique(AGENCY_COMPARE_ERROR_CODES);
  });

  it('answer these statuses (SNAPSHOT, written out by hand)', () => {
    expect(AGENCY_COMPARE_ERROR_STATUS).toEqual({
      compare_campaign_required: 400,
      compare_campaign_not_found: 404,
      compare_too_many_agents: 400,
      compare_too_many_metrics: 400,
      compare_metric_invalid: 400,
      compare_window_invalid: 400,
      compare_timezone_invalid: 400,
      compare_agent_not_in_cohort: 404,
      compare_busy: 429,
      compare_timed_out: 503,
      compare_view_not_found: 404,
      compare_view_invalid: 400,
      compare_view_limit: 409,
    });
  });

  it('is the one list the console layer re-exports, not a copy of it', () => {
    expect(AgencyApi.AGENCY_COMPARE_ERROR_CODES).toBe(AGENCY_COMPARE_ERROR_CODES);
    expect(AgencyApi.AGENCY_COMPARE_ERROR_STATUS).toBe(AGENCY_COMPARE_ERROR_STATUS);
  });

  it('do not overlap the action, soft-phone, report, inbound, listen or floor assist unions', () => {
    const others = new Set<string>([
      ...AGENCY_ACTION_ERROR_CODES, ...AGENCY_SOFTPHONE_ERROR_CODES, ...AGENCY_REPORT_ERROR_CODES, ...AGENCY_INBOUND_ERROR_CODES,
      ...AGENCY_LISTEN_ERROR_CODES, ...AGENCY_FLOOR_ASSIST_ERROR_CODES,
    ]);
    for (const code of AGENCY_COMPARE_ERROR_CODES) expect(others.has(code), code).toBe(false);
  });
});
