/**
 * The summary's `roster` block from the repository's one statement (`rosterStatement`), with its
 * reconciliation. Part of `src/agency/insights/` (docs/insights.md "API").
 */
import type { AgencyInsightsRoster } from '@magick-agency/contracts/api/agency/insights';
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';
import {
  agencyInsightsReadRepository,
  ROSTER_BUCKETS,
  type RosterCounts,
} from '../../db/repositories/agency.repository.js';
import { callbackCodes } from '../../db/repositories/agency/assignment-sql.js';
import { reconcile, successCodes } from './shared.js';

/** Reconciliation identifiers of the roster (docs/insights.md "API"). */
export const ROSTER_CHECKS = {
  states: 'contact_states_vs_total',
  attempts: 'attempts_per_contact_vs_attempted',
  waiting: 'waiting_vs_open',
} as const;

/** The campaign's roster counts as of now; `pausedAt` / `windowEndAt` feed the paused headline. */
export function readRoster(
  campaign: Pick<AgencyCampaignRecord, 'id' | 'disposition_catalog'>,
  opts: { pausedAt?: Date | null; windowEndAt?: Date | null } = {},
): Promise<RosterCounts> {
  return agencyInsightsReadRepository.roster({
    campaignId: campaign.id,
    callbackCodes: callbackCodes(campaign.disposition_catalog),
    successCodes: successCodes(campaign.disposition_catalog),
    pausedAt: opts.pausedAt ?? null,
    windowEndAt: opts.windowEndAt ?? null,
  });
}

/**
 * The wire roster. Three checks, each against counts of the same statement:
 *  - `contact_states_vs_total`: the ten buckets (each its own predicate) sum to `count(*)`;
 *  - `attempts_per_contact_vs_attempted`: 1 + 2 + 3 + 4+ dials sum to the attempted contacts;
 *  - `waiting_vs_open`: due now + retry + callback sum to the open contacts (counted on their own).
 */
export function rosterWire(r: RosterCounts): AgencyInsightsRoster {
  const b = r.buckets;
  const bucketSum = ROSTER_BUCKETS.reduce((sum, k) => sum + b[k], 0);
  const attemptsSum = r.attempts.one + r.attempts.two + r.attempts.three + r.attempts.four_plus;
  return {
    total: r.total,
    waiting_due_now: b.waiting_due_now,
    waiting_retry: b.waiting_retry,
    waiting_callback: b.waiting_callback,
    on_call: b.on_call,
    in_wrapup: b.in_wrapup,
    completed: b.completed,
    exhausted: b.exhausted,
    suppressed_dnc: b.suppressed_dnc,
    suppressed_invalid: b.suppressed_invalid,
    suppressed_other: b.suppressed_other,
    attempted: r.attempted,
    attempts_per_contact: { ...r.attempts },
    dials_placed: r.dials_placed,
    reconciliation: [
      reconcile(ROSTER_CHECKS.states, r.total, bucketSum),
      reconcile(ROSTER_CHECKS.attempts, r.attempted, attemptsSum),
      reconcile(ROSTER_CHECKS.waiting, r.open, b.waiting_due_now + b.waiting_retry + b.waiting_callback),
    ],
  };
}
