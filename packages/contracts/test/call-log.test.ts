import { describe, expect, it } from 'vitest';
import {
  AGENCY_CALL_LOG_STATUSES,
  AGENCY_CALL_LOG_TYPES,
  AGENCY_CALL_LOG_TYPE_FILTERS,
  AGENCY_CALL_LOG_TYPE_LABELS,
  type AgencyCallLogCounts,
  type AgencyCallLogRow,
  type AgencyCallLogStatus,
  type AgencyCallLogType,
} from '../src/api/agency/call-log';
import type { AgencyManualCallListQuery } from '../src/agency';
import { AGENCY_CALL_ORIGIN_LABELS } from '../src/api/agency/listen-history';
import { AgencyApi } from '../src/index';
import type { Equals } from './type-equals';

/** The campaign Call log's vocabulary (docs/call-log.md, CL11). */
describe('the call log', () => {
  it('lists its types in chip order, with All first among the filters', () => {
    expect([...AGENCY_CALL_LOG_TYPES]).toEqual(['dialler', 'soft_phone']);
    expect([...AGENCY_CALL_LOG_TYPE_FILTERS]).toEqual(['all', ...AGENCY_CALL_LOG_TYPES]);
    expect(AgencyApi.AGENCY_CALL_LOG_TYPES).toBe(AGENCY_CALL_LOG_TYPES);
  });

  it('names each type in the words Live calls uses', () => {
    expect(Object.keys(AGENCY_CALL_LOG_TYPE_LABELS).sort()).toEqual([...AGENCY_CALL_LOG_TYPES].sort());
    expect(AGENCY_CALL_LOG_TYPE_LABELS.dialler).toBe(AGENCY_CALL_ORIGIN_LABELS.campaign);
    expect(AGENCY_CALL_LOG_TYPE_LABELS.soft_phone).toBe(AGENCY_CALL_ORIGIN_LABELS.manual);
  });

  it('filters soft-phone calls by the Soft-phone calls list\'s own statuses', () => {
    expect([...AGENCY_CALL_LOG_STATUSES]).toEqual(['live', 'awaiting_outcome', 'settled']);
    const sameAsTheList: Equals<AgencyCallLogStatus, NonNullable<AgencyManualCallListQuery['status']>> = true;
    expect(sameAsTheList).toBe(true);
  });

  it('has a row and a count for every type, and no other (type level)', () => {
    const rowTypes: Equals<AgencyCallLogRow['type'], AgencyCallLogType> = true;
    const countKeys: Equals<keyof AgencyCallLogCounts, 'all' | AgencyCallLogType> = true;
    expect(rowTypes && countKeys).toBe(true);
  });
});
