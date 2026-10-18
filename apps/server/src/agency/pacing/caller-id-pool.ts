/**
 * The campaign's caller-ID pool: which entries can be dialled, and which one the
 * next dial uses. Pure; split out of `pacing-engine.ts`.
 */
import type { AgencyCampaignRecord } from '../../db/models/agency.model.js';

/**
 * Round-robin the caller-ID pool. All entries belong to one provider.
 *
 * **Returns null rather than throwing on an empty pool.** It used to throw, from
 * inside the dial loop's `create({ callerId: … })` argument list — which unwound
 * the whole tick past every unwind path in it, leaving the current agent on the
 * `reserving` marker, the current contact `in_flight`, and *every remaining*
 * reserved agent and claimed contact in the same state. Those agents are then
 * undialable until their lease lapses and the reaper requeues the contacts, and
 * the next tick reproduces it, so an emptied pool took the campaign's whole roster
 * out rather than stopping it cleanly.
 *
 * `PATCH /agency-campaigns/:id` now refuses an empty `caller_ids`, so this should
 * be unreachable — that is the reason for the belt and the braces both. A pool can
 * still empty by a direct DB write or a migration, and the failure mode has to be
 * a halted campaign rather than a leaked one.
 */
export function pickCallerId(pool: readonly string[], offset: number): string | null {
  if (pool.length === 0) return null;
  return pool[(Date.now() + offset) % pool.length]!;
}

/**
 * The caller IDs on this campaign that can actually be dialled.
 *
 * **THE one definition of "usable", shared by the top-of-tick guard and the
 * picker, and they must not diverge.** They did: the guard tested
 * `caller_ids.length === 0` while `pickCallerId` returned a *falsy* `''` for a
 * stored `caller_ids: ['']`. So a length-1 junk pool sailed past the guard,
 * `clearStuck` wiped the latch on the way through, the dial loop then failed on
 * the empty string, and `noteMisconfigured` fired UNLATCHED — restoring the exact
 * 4 Hz spin the guard exists to prevent, plus a `campaign_state` broadcast storm
 * to every joined agent, plus the reservation churn and the fairness-ordering
 * damage. The route validator now refuses `['']` on create and PATCH, but no
 * migration cleans rows already stored that way, so the engine has to cope.
 *
 * Trimmed as well as filtered, because a padded entry is what the route now
 * stores trimmed but older rows may not be.
 */
export function usableCallerIds(campaign: AgencyCampaignRecord): string[] {
  const pool = campaign.caller_ids;
  if (!Array.isArray(pool)) return [];
  return pool
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim());
}
