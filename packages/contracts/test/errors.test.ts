import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  AGENCY_ACTION_ERROR_CODES,
  AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES,
  AGENCY_ROSTER_REFUSAL_CODES,
  type AgencyActionErrorCode,
  type AgencyCampaignLifecycleErrorCode,
  type AgencyRosterRefusalCode,
  type AgencyStationErrorCode,
} from '../src/errors';
import type * as Core from '../src/agency';
import { AgencyApi } from '../src/index';
import type { Equals } from './type-equals';

/**
 * SNAPSHOT — written out by hand, deliberately not derived from the list under test.
 *
 * 18 members; any older count of 16 predates `session_on_other_campaign` and
 * `agent_on_live_call`.
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
void [_actionExact, _rosterExact, _lifecycleExact, _actionIsCore, _stationIsCore,
  _consoleActionAgrees, _consoleStationAgrees];

function expectUnique(list: readonly string[]): void {
  expect(new Set(list).size).toBe(list.length);
}

describe('action error codes', () => {
  it('equal the snapshot, in order', () => {
    expect([...AGENCY_ACTION_ERROR_CODES]).toEqual(CORE_FIXTURE_ACTION_ERROR_CODES);
  });

  it('has 18 members, all distinct', () => {
    expect(AGENCY_ACTION_ERROR_CODES).toHaveLength(18);
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
  it('are the seven campaign-lifecycle names, distinct', () => {
    expect([...AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES]).toEqual([
      'another_campaign_running',
      'invalid_campaign_transition',
      'campaign_not_found',
      'campaign_roster_empty',
      'campaign_roster_exhausted',
      'announcement_not_found',
      'analysis_profile_not_found',
    ]);
    expectUnique(AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES);
  });

  it('do not overlap the action union (they were deliberately kept out of it)', () => {
    const action = new Set<string>(AGENCY_ACTION_ERROR_CODES);
    for (const code of AGENCY_CAMPAIGN_LIFECYCLE_ERROR_CODES) expect(action.has(code)).toBe(false);
    for (const code of AGENCY_ROSTER_REFUSAL_CODES) expect(action.has(code)).toBe(false);
  });
});
