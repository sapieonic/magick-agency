import { describe, it, expect } from 'vitest';
import {
  CAMPAIGN_ACTIVITY_ACTIONS,
  CORE_AGENCY_EVENT_TYPES,
} from '../../../src/agency/agency-activity-actions.js';
import { PLATFORM_AUDIT_ACTIONS } from '../../../src/audit/platform/catalog.js';

/**
 * The vocabulary cusui's action filter is now built from.
 *
 * It replaced a hand-maintained copy in that repository, so the guarantee has to
 * live here instead: master's half is checked against the catalog it comes from,
 * and the served list is checked for entries nothing writes. Neither check can
 * reach core — see the transcription note on `CORE_AGENCY_EVENT_TYPES`.
 *
 * The type-level guards in the module catch both directions at `npm run lint`
 * already. These tests exist because vitest does not type-check: a source file
 * with a type error still runs, so without them `npm test` would pass on exactly
 * the drift the module is here to prevent.
 */

/**
 * Everything master writes about a campaign is `agency_*` or `dnc_*`. The
 * catalog's other entries are `schedule.*`/`recurring_schedule.*`, which carry
 * no campaign scope and would be a filter that always returns nothing.
 */
const CAMPAIGN_SCOPED = /^(agency_|dnc_)/;

const served = new Set(CAMPAIGN_ACTIVITY_ACTIONS.map((action) => action.value));

describe('the campaign activity action vocabulary', () => {
  /**
   * The check the hand-maintained copy could never have. Adding an
   * `agency_*`/`dnc_*` action to `PLATFORM_AUDIT_ACTIONS` and not here ships a
   * filter that cannot select rows master is already writing to the trail.
   */
  it('offers every campaign-scoped action master writes', () => {
    const missing = PLATFORM_AUDIT_ACTIONS
      .filter((action) => CAMPAIGN_SCOPED.test(action))
      .filter((action) => !(served as ReadonlySet<string>).has(action)); // PORT NOTE: type-only cast (master does not type-check tests)

    expect(
      missing,
      `in PLATFORM_AUDIT_ACTIONS but not offered as a filter: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  /** The transcription of core's writes, held to the same standard. */
  it('offers every agency event type core writes', () => {
    const missing = CORE_AGENCY_EVENT_TYPES.filter((event) => !served.has(event));

    expect(
      missing,
      `written by core but not offered as a filter: ${missing.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * The other direction, and the worse failure: a checkbox that always returns
   * an empty trail reads to an operator as "this never happened".
   */
  it('offers nothing neither store writes', () => {
    const written = new Set<string>([
      ...PLATFORM_AUDIT_ACTIONS.filter((action) => CAMPAIGN_SCOPED.test(action)),
      ...CORE_AGENCY_EVENT_TYPES,
    ]);
    const unwritten = [...served].filter((action) => !written.has(action));

    expect(
      unwritten,
      `offered as a filter but written by neither store: ${unwritten.join(', ')}`,
    ).toEqual([]);
  });

  /**
   * The scheduler's actions are in the catalog and must stay OUT of this list —
   * they are tenant-wide and never carry a campaign, so every one of them would
   * be a control that returns nothing on this screen.
   */
  // PORT NOTE: agency's catalog has no `schedule.*` actions (decision: no scheduler), so the
  // "not campaign-scoped" set is now the `user.*` actions; the assertion is unchanged.
  it('leaves the scheduler actions out', () => {
    const schedulerActions = PLATFORM_AUDIT_ACTIONS.filter((action) => !CAMPAIGN_SCOPED.test(action));

    expect(schedulerActions.length).toBeGreaterThan(0);
    expect(schedulerActions.filter((action) => (served as ReadonlySet<string>).has(action))).toEqual([]);
  });

  /**
   * `paused` and `stopped` are written by both services, and one action name is
   * one filter option — the two rows it selects are told apart by `source`, not
   * by a duplicated checkbox.
   */
  it('lists each action once, even where both stores write it', () => {
    expect(served.size).toBe(CAMPAIGN_ACTIVITY_ACTIONS.length);
    expect(served.has('agency_campaign.paused')).toBe(true);
    expect(served.has('agency_campaign.stopped')).toBe(true);
  });

  /**
   * The filter is rendered from this list verbatim, so an entry with no label
   * would render as a nameless checkbox rather than as an obvious bug.
   */
  it('gives every entry a label and one of the three groups', () => {
    for (const action of CAMPAIGN_ACTIVITY_ACTIONS) {
      expect(action.label.trim(), action.value).not.toBe('');
      expect(['Campaign', 'Calls', 'Staffing'], action.value).toContain(action.group);
    }
  });
});
