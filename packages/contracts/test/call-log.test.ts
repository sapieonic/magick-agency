import { describe, expect, it } from 'vitest';
import {
  AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTERS,
  AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTER_LABELS,
  AGENCY_CALL_LOG_STATUSES,
  AGENCY_CALL_LOG_TYPES,
  AGENCY_CALL_LOG_TYPE_FILTERS,
  AGENCY_CALL_LOG_TYPE_LABELS,
  type AgencyCallLogCounts,
  type AgencyCallLogRow,
  type AgencyCallLogStatus,
  type AgencyCallLogType,
  type AgencyCallLogTypeFilter,
} from '../src/api/agency/call-log';
import { AGENCY_INBOUND_CAMPAIGN_SOURCES, type AgencyManualCallListQuery } from '../src/agency';
import { ATTEMPT_OUTCOME_LABELS } from '../src/api/agency/agency-spine';
import { AGENCY_CALL_ORIGIN_LABELS } from '../src/api/agency/listen-history';
import { AgencyApi } from '../src/index';
import type { Equals } from './type-equals';

/** The campaign Call log's vocabulary (docs/call-log.md, CL11). */
describe('the call log', () => {
  it('lists its types in chip order, with All first among the filters', () => {
    expect([...AGENCY_CALL_LOG_TYPES]).toEqual(['dialler', 'soft_phone', 'inbound']);
    // To follow up is a view of the list (the open Missed rows), after the types.
    expect([...AGENCY_CALL_LOG_TYPE_FILTERS]).toEqual(['all', ...AGENCY_CALL_LOG_TYPES, 'to_follow_up']);
    expect(AgencyApi.AGENCY_CALL_LOG_TYPES).toBe(AGENCY_CALL_LOG_TYPES);
  });

  it('names each type in the words Live calls uses', () => {
    expect(Object.keys(AGENCY_CALL_LOG_TYPE_LABELS).sort()).toEqual([...AGENCY_CALL_LOG_TYPES].sort());
    expect(AGENCY_CALL_LOG_TYPE_LABELS.dialler).toBe(AGENCY_CALL_ORIGIN_LABELS.campaign);
    expect(AGENCY_CALL_LOG_TYPE_LABELS.soft_phone).toBe(AGENCY_CALL_ORIGIN_LABELS.manual);
    expect(AGENCY_CALL_LOG_TYPE_LABELS.inbound).toBe(AGENCY_CALL_ORIGIN_LABELS.inbound);
  });

  it('adds what only an inbound call can have happened to it, under words no attempt outcome uses', () => {
    expect([...AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTERS]).toEqual(['missed', 'voicemail', 'abandoned_in_queue']);
    expect(Object.keys(AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTER_LABELS)).toEqual([...AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTERS]);
    // One `?outcome=` list holds both vocabularies, so a value must belong to exactly one.
    for (const value of AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTERS) {
      expect(Object.keys(ATTEMPT_OUTCOME_LABELS)).not.toContain(value);
    }
  });

  it('files an inbound call under a campaign by one of four sources', () => {
    expect([...AGENCY_INBOUND_CAMPAIGN_SOURCES]).toEqual(['contact', 'route', 'agent', 'supervisor']);
  });

  it('filters soft-phone calls by the Soft-phone calls list\'s own statuses', () => {
    expect([...AGENCY_CALL_LOG_STATUSES]).toEqual(['live', 'awaiting_outcome', 'settled']);
    const sameAsTheList: Equals<AgencyCallLogStatus, NonNullable<AgencyManualCallListQuery['status']>> = true;
    expect(sameAsTheList).toBe(true);
  });

  it('has a row and a count for every type, and no other (type level)', () => {
    const rowTypes: Equals<AgencyCallLogRow['type'], AgencyCallLogType> = true;
    // The counts are keyed as the chips are: every `type` filter has its number.
    const countKeys: Equals<keyof AgencyCallLogCounts, AgencyCallLogTypeFilter> = true;
    expect(rowTypes && countKeys).toBe(true);
  });
});
