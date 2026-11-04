import { describe, expect, it } from 'vitest';
import {
  AGENCY_ASSIGNMENT_MODES,
  AGENCY_ASSIGNMENT_REASONS,
  AGENCY_CALLBACK_FALLBACK_VALUES,
  AGENCY_CONTACT_ASSIGNMENT_DEFAULTS,
  AGENCY_ON_UNSTAFF_VALUES,
  AGENCY_OVERRIDE_KINDS,
} from '../src/agency';
import {
  AGENCY_AGENT_RETRY_BLOCKS,
  AGENCY_AGENT_RETRY_ERROR_CODES,
  AGENCY_ASSIGNMENT_AGENTS_MAX,
  AGENCY_ASSIGNMENT_COLUMN_NAME_MAX,
  AGENCY_ASSIGNMENT_COLUMN_VALUE_LENGTH_MAX,
  AGENCY_ASSIGNMENT_COLUMN_VALUES_MAX,
  AGENCY_ASSIGNMENT_COUNT_MAX,
  AGENCY_ASSIGNMENT_ERROR_CODES,
  AGENCY_ASSIGNMENT_KINDS,
  AGENCY_ASSIGNMENT_RANGE_MAX,
  AGENCY_MY_CONTACT_BUCKETS,
} from '../src/api/agency/assignment';

/**
 * SNAPSHOTS, written out by hand. The runtime lists are held equal to their unions at type
 * level (`AllListed` in the sources); these pin the order, which the console and the app
 * render in (buckets) and the mobile literals file mirrors, and the vocabularies the 0009
 * CHECK constraints accept.
 */
describe('contact assignment vocabularies', () => {
  it('modes, unstaff and callback fallback match the 0009 CHECKs', () => {
    expect([...AGENCY_ASSIGNMENT_MODES]).toEqual(['pool', 'strict', 'preferred']);
    expect([...AGENCY_ON_UNSTAFF_VALUES]).toEqual(['return_to_pool', 'keep']);
    expect([...AGENCY_CALLBACK_FALLBACK_VALUES]).toEqual(['pool', 'wait']);
  });

  it('history reasons match ck_agency_assignment_event_reason', () => {
    expect([...AGENCY_ASSIGNMENT_REASONS]).toEqual([
      'manual', 'random_split', 'count', 'filter', 'range', 'rebalance', 'unstaffed', 'reassign',
      'unassign', 'callback', 'callback_fallback', 'superseded', 'inherited',
    ]);
  });

  it('override kinds match ck_agency_attempt_override_applied, and none is DNC', () => {
    expect([...AGENCY_OVERRIDE_KINDS]).toEqual(['extra_attempts', 'retry_delay', 'calling_hours']);
    expect(AGENCY_OVERRIDE_KINDS as readonly string[]).not.toContain('dnc');
  });

  it('defaults are the 0009 column defaults: nothing changes for a campaign that says nothing', () => {
    expect(AGENCY_CONTACT_ASSIGNMENT_DEFAULTS).toEqual({
      assignment_mode: 'pool',
      on_unstaff: 'return_to_pool',
      callback_owner_grace_minutes: 30,
      callback_fallback: 'pool',
      allow_agent_retry: false,
      agent_retry_rounds: 1,
      agent_retry_cooldown_minutes: 30,
    });
    expect(Object.isFrozen(AGENCY_CONTACT_ASSIGNMENT_DEFAULTS)).toBe(true);
  });

  it('operation kinds, buckets and retry blocks keep their order', () => {
    expect([...AGENCY_ASSIGNMENT_KINDS]).toEqual(['random_split', 'count', 'filter', 'range', 'reassign', 'unassign', 'rebalance']);
    expect([...AGENCY_MY_CONTACT_BUCKETS]).toEqual([
      'pending', 'callback', 'not_reached', 'in_progress', 'reached', 'exhausted', 'suppressed',
    ]);
    expect([...AGENCY_AGENT_RETRY_BLOCKS]).toEqual(['retry_disabled', 'not_retryable', 'rounds_used', 'cooldown', 'suppressed']);
  });

  it('refusal codes keep their order and are distinct', () => {
    expect([...AGENCY_ASSIGNMENT_ERROR_CODES]).toEqual([
      'assignment_disabled', 'assignment_invalid', 'agent_not_staffed', 'preview_stale',
      'mode_change_requires_pause', 'contact_not_found', 'campaign_not_found',
    ]);
    expect([...AGENCY_AGENT_RETRY_ERROR_CODES]).toEqual([
      'assignment_disabled', 'not_staffed', 'agent_retry_disabled', 'contact_not_found', 'contact_not_retryable',
      'contact_in_flight', 'campaign_not_running', 'agent_not_available', 'outside_calling_hours',
      'override_note_invalid', 'dnc_listed', 'dnc_unavailable', 'no_caller_id', 'no_station', 'dial_failed',
      'feature_disabled',
    ]);
    expect(new Set(AGENCY_AGENT_RETRY_ERROR_CODES).size).toBe(AGENCY_AGENT_RETRY_ERROR_CODES.length);
  });

  it('operation bounds: the server validator and the console form read these', () => {
    expect({
      range: AGENCY_ASSIGNMENT_RANGE_MAX,
      agents: AGENCY_ASSIGNMENT_AGENTS_MAX,
      count: AGENCY_ASSIGNMENT_COUNT_MAX,
      columnName: AGENCY_ASSIGNMENT_COLUMN_NAME_MAX,
      columnValues: AGENCY_ASSIGNMENT_COLUMN_VALUES_MAX,
      columnValueLength: AGENCY_ASSIGNMENT_COLUMN_VALUE_LENGTH_MAX,
    }).toEqual({ range: 500, agents: 200, count: 1_000_000, columnName: 200, columnValues: 100, columnValueLength: 500 });
  });
});
