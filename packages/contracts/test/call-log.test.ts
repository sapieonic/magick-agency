import { describe, expect, it } from 'vitest';
import {
  AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTERS,
  AGENCY_CALL_LOG_INBOUND_OUTCOME_FILTER_LABELS,
  AGENCY_CALL_LOG_STATUSES,
  AGENCY_CALL_LOG_TYPES,
  AGENCY_CALL_LOG_TYPE_FILTERS,
  AGENCY_CALL_LOG_TYPE_LABELS,
  AGENCY_CALLS_BEFORE_THE_RULE_LABEL,
  AGENCY_CALLS_NO_CAMPAIGN,
  AGENCY_CALLS_NO_CAMPAIGN_LABEL,
  AGENCY_CALLS_TYPE_FILTER_LABELS,
  AGENCY_MY_CALLS_NOTHING_TO_FOLLOW_UP,
  AGENCY_MY_CALLS_TYPE_FILTERS,
  agencyCallbackDueLabel,
  agencyNoCampaignLabel,
  AGENCY_CALLS_BY_TYPE_NO_RATE,
  AGENCY_CALLS_BY_TYPE_RATE_LABELS,
  AGENCY_OUTBOUND_CONNECT_RATE_LABEL,
  AGENCY_SYSTEM_OUTCOME_LABELS,
  agencyCallsByTypeFootnote,
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

  describe('Calls by type (P4)', () => {
    it('gives each type its own rate and All calls none', () => {
      expect(AGENCY_CALLS_BY_TYPE_RATE_LABELS).toEqual({
        dialler: 'Dialler connect rate',
        soft_phone: 'Soft-phone connect rate',
        inbound: 'Answer rate, open hours',
      });
      expect(AGENCY_CALLS_BY_TYPE_NO_RATE).toBe('not added');
    });

    it('calls the dialler and the soft phone together Outbound, never All calls (CL7)', () => {
      expect(AGENCY_OUTBOUND_CONNECT_RATE_LABEL).toBe('Outbound connect rate');
    });

    it('has words for the outcome code no catalog lists, the ones Compare agents uses', () => {
      expect(AGENCY_SYSTEM_OUTCOME_LABELS).toEqual({ no_disposition: 'No outcome chosen' });
    });

    it('says the proposal\'s footnote for three types, and names only the types shown', () => {
      expect(agencyCallsByTypeFootnote(['dialler', 'soft_phone', 'inbound'])).toBe(
        'All calls adds the three types. Each call is counted once, under the type it was. Rates are not added together: '
        + 'the dialler’s measures the list and the pacing, the soft phone’s the numbers agents chose, and inbound’s how many callers we answered.',
      );
      // Whatever order they are passed in, they read in the table's order.
      expect(agencyCallsByTypeFootnote(['inbound', 'dialler'])).toBe(
        'All calls adds the two types. Each call is counted once, under the type it was. Rates are not added together: '
        + 'the dialler’s measures the list and the pacing and inbound’s how many callers we answered.',
      );
      expect(agencyCallsByTypeFootnote(['dialler', 'soft_phone'])).not.toContain('inbound');
    });
  });
});

/** The account's All calls and the agent's My calls (docs/call-log.md §7, CL31 onwards). */
describe('All calls and My calls', () => {
  it('My calls puts To follow up first, then All and the three types: the same values as the Call log', () => {
    expect([...AGENCY_MY_CALLS_TYPE_FILTERS]).toEqual(['to_follow_up', 'all', 'dialler', 'soft_phone', 'inbound']);
    expect([...AGENCY_MY_CALLS_TYPE_FILTERS].sort()).toEqual([...AGENCY_CALL_LOG_TYPE_FILTERS].sort());
    expect(AGENCY_MY_CALLS_TYPE_FILTERS.map((f) => AGENCY_CALLS_TYPE_FILTER_LABELS[f]))
      .toEqual(['To follow up', 'All', 'Dialler', 'Soft phone', 'Inbound']);
    for (const type of AGENCY_CALL_LOG_TYPES) expect(AGENCY_CALLS_TYPE_FILTER_LABELS[type]).toBe(AGENCY_CALL_LOG_TYPE_LABELS[type]);
    expect(AGENCY_MY_CALLS_NOTHING_TO_FOLLOW_UP).toBe('Nobody is waiting for a call from you.');
  });

  it('a call filed under no campaign is "No campaign", or "Before the rule" when it is older than the switch-on', () => {
    expect(AGENCY_CALLS_NO_CAMPAIGN).toBe('none');
    const since = '2026-11-20T10:00:00.000Z';
    const on = { require_campaign: true, require_campaign_since: since };
    expect(agencyNoCampaignLabel('2026-11-19T10:00:00.000Z', on)).toBe(AGENCY_CALLS_BEFORE_THE_RULE_LABEL);
    expect(agencyNoCampaignLabel('2026-11-20T10:00:00.000Z', on)).toBe(AGENCY_CALLS_NO_CAMPAIGN_LABEL);
    expect(agencyNoCampaignLabel('2026-11-21T10:00:00.000Z', on)).toBe('No campaign');
    // The rule off (or never on): every such call is "No campaign", however old.
    expect(agencyNoCampaignLabel('2020-01-01T00:00:00.000Z', { require_campaign: false, require_campaign_since: null })).toBe('No campaign');
    expect(agencyNoCampaignLabel('2020-01-01T00:00:00.000Z', { require_campaign: false, require_campaign_since: since })).toBe('No campaign');
    expect(agencyNoCampaignLabel('2020-01-01T00:00:00.000Z', null)).toBe('No campaign');
    expect(AGENCY_CALLS_BEFORE_THE_RULE_LABEL).toBe('Before the rule');
  });

  it('a callback is due at a time, or late by how long', () => {
    const now = new Date('2026-11-22T15:48:00.000Z');
    const label = (dueAt: string) => agencyCallbackDueLabel(dueAt, now, '4:00 PM');
    expect(label('2026-11-22T16:00:00.000Z')).toBe('Due 4:00 PM');
    expect(label('2026-11-22T15:48:00.000Z')).toBe('Due 4:00 PM');
    expect(label('2026-11-22T15:47:30.000Z')).toBe('Late by less than a minute');
    expect(label('2026-11-22T15:47:00.000Z')).toBe('Late by 1 minute');
    expect(label('2026-11-22T15:28:00.000Z')).toBe('Late by 20 minutes');
    expect(label('2026-11-22T14:48:00.000Z')).toBe('Late by 1 hour');
    expect(label('2026-11-22T13:45:00.000Z')).toBe('Late by 2 hours');
    expect(label('2026-11-21T15:48:00.000Z')).toBe('Late by 1 day');
    expect(label('2026-11-19T10:00:00.000Z')).toBe('Late by 3 days');
    expect(label('not a time')).toBe('Due 4:00 PM');
  });
});
