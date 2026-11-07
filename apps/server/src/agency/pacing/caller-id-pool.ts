/**
 * The campaign's caller-ID pool: which entries can be dialled, and which one the
 * next dial uses. Pure; split out of `pacing-engine.ts`.
 *
 * With dedicated caller IDs (decisions DN1–DN3), {@link resolveCallerId} is the one rule every
 * dial path applies (pacing, the agent's own call, the wrap-up redial, the soft phone tagged
 * to a campaign): the contact OWNER's dedicated number while the campaign still has it, else
 * the rotation ({@link rotationCallerIds}: the usable numbers minus the dedicated ones, or all
 * of them when every one is dedicated), picked round-robin by {@link pickCallerId}. The map it
 * decides from is read through `DedicatedCallerIdCache` (`dedicated-caller-ids.ts`), whose
 * `callerIdForContact` is this rule for one contact; a dial path never calls `pickCallerId` over
 * a campaign's numbers itself.
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
export function usableCallerIds(campaign: Pick<AgencyCampaignRecord, 'caller_ids'>): string[] {
  const pool = campaign.caller_ids;
  if (!Array.isArray(pool)) return [];
  return pool
    .filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
    .map((id) => id.trim());
}

/**
 * Dedicated caller IDs (DN1): agent user id → the number dedicated to them on ONE campaign,
 * as stored (`agency_campaign_agent_caller_ids`). A number no longer among the campaign's
 * usable caller IDs is still in this map; the functions below ignore it (DN2's "still usable").
 */
export type DedicatedCallerIds = ReadonlyMap<string, string>;

/** No dedications: every contact dials from the rotation, which is then every usable number. */
export const NO_DEDICATED_CALLER_IDS: DedicatedCallerIds = new Map();

/**
 * The number dedicated to `ownerUserId` on this campaign, when it is still one of `usable`;
 * else null (no owner, no dedication, or a number the campaign no longer has).
 */
export function dedicatedCallerIdOf(
  usable: readonly string[],
  dedicated: DedicatedCallerIds,
  ownerUserId: string | null | undefined,
): string | null {
  if (!ownerUserId) return null;
  const number = dedicated.get(ownerUserId);
  return number !== undefined && usable.includes(number) ? number : null;
}

/**
 * The rotation (DN3): the usable caller IDs minus every dedicated number that is still usable,
 * in stored order. When that leaves nothing (every usable number is dedicated), the whole
 * usable list, so dedications never halt a campaign: the contacts without a dedicated owner
 * number then share the dedicated numbers. Empty only when `usable` is.
 */
export function rotationCallerIds(usable: readonly string[], dedicated: DedicatedCallerIds): string[] {
  if (dedicated.size === 0) return [...usable];
  const taken = new Set(dedicated.values());
  const rest = usable.filter((n) => !taken.has(n));
  return rest.length > 0 ? rest : [...usable];
}

/**
 * THE caller ID a dial to a campaign contact goes out from (DN2), for every dial path: pacing,
 * the agent's own call, the wrap-up redial and the soft phone tagged to the campaign.
 *
 *  1. The contact's OWNER (`assigned_user_id`, not the dialling agent) has a dedicated number
 *     that is still one of the campaign's usable caller IDs → that number.
 *  2. Else `sticky` (the wrap-up redial's previous number, WR7) when it is still in the
 *     rotation: a number since dedicated to someone else is not reused for a contact that is
 *     not theirs.
 *  3. Else the rotation's round-robin pick ({@link pickCallerId} over {@link rotationCallerIds}).
 *
 * Null only when the campaign has no usable caller ID at all ({@link pickCallerId}'s contract:
 * the caller halts or refuses, never throws).
 */
export function resolveCallerId(input: {
  usable: readonly string[];
  dedicated: DedicatedCallerIds;
  ownerUserId: string | null | undefined;
  offset: number;
  sticky?: string | null;
}): string | null {
  const own = dedicatedCallerIdOf(input.usable, input.dedicated, input.ownerUserId);
  if (own) return own;
  const rotation = rotationCallerIds(input.usable, input.dedicated);
  if (input.sticky && rotation.includes(input.sticky)) return input.sticky;
  return pickCallerId(rotation, input.offset);
}
