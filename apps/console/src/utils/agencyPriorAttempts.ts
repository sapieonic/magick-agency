import type { AgencyDisposition, AgencyPriorAttempt } from '../types/agency';

/**
 * The agent's prior-attempt history, once it spans a retry lineage.
 *
 * A LEAF module — pure, no React — because everything below is a decision about
 * what an agent is shown three seconds before they speak to a customer, and
 * those decisions are worth testing without a socket.
 *
 * ── What changed, and why a flat list stopped working ───────────────────────
 * The server's prior-attempt read used to be `WHERE contact_id = $1 ORDER BY
 * attempt_number DESC`. On a retry campaign it becomes lineage-scoped —
 * `WHERE root_contact_id = $1` — and re-orders onto `ended_at DESC NULLS LAST`,
 * because **`attempt_number` is per-contact-row and resets in every retry
 * campaign** (retry design DR-2). Two passes' worth of "attempt 1, attempt 2"
 * interleaved by number is nonsense, so the number is no longer an ordering and
 * this file never presents it as one.
 *
 * Grouping by campaign is the other half. "Attempt 2" means nothing once the
 * attempts come from two campaigns; "the second time we called them on the
 * original campaign" does.
 */

export interface PriorAttemptGroup {
  /**
   * The campaign these attempts belong to. Empty only in the degenerate case
   * where the server sent no id at all — see {@link groupPriorAttempts}.
   */
  campaignId: string;
  /** The heading. Never a code, never blank — see the fallback rules below. */
  campaignName: string;
  /**
   * Whether this is the campaign the agent is signed into right now.
   *
   * Drives the heading copy AND the disposition-label fallback: only this
   * campaign's catalog is on the bootstrap, so a code from any other group is
   * one this console structurally cannot name.
   */
  isCurrent: boolean;
  attempts: AgencyPriorAttempt[];
}

/**
 * Break a newest-first list of prior attempts into per-campaign groups: this
 * campaign first, then every other campaign in the order its most recent
 * attempt appears — which, on a list the server already ordered newest-first, is
 * newest-first.
 *
 * ── Input order is preserved and NOT re-sorted ──────────────────────────────
 * The server orders by `ended_at DESC NULLS LAST, attempt_number DESC`, which keeps a
 * never-ended attempt (reaped, orphaned) at the bottom rather than at the top
 * where a null date would otherwise sort. Re-sorting here would be a second
 * answer to that question, and the two would disagree the first time either
 * changed — the same single-definition rule the abandonment predicate follows.
 * A stable partition preserves it exactly.
 *
 * ── A missing `campaign_id` means THIS campaign ─────────────────────────────
 * Not a defensive shrug: before the lineage read existed, every prior attempt
 * came from the contact's own row on the campaign the agent is joined to, so
 * "this campaign" is the only thing an older the server could have meant. That is
 * what makes the 100% non-retry case degrade to exactly today's flat list —
 * one group, headed by the campaign the agent is already looking at — rather
 * than to a group headed by nothing.
 */
export function groupPriorAttempts(
  attempts: readonly AgencyPriorAttempt[],
  currentCampaignId: string,
  currentCampaignName: string,
): PriorAttemptGroup[] {
  const groups: PriorAttemptGroup[] = [];
  const byId = new Map<string, PriorAttemptGroup>();

  for (const attempt of attempts) {
    const rawId = attempt.campaign_id ?? '';
    const campaignId = rawId === '' ? currentCampaignId : rawId;
    const isCurrent = campaignId === currentCampaignId;

    let group = byId.get(campaignId);
    if (!group) {
      group = {
        campaignId,
        /*
          The name the server sent, then the one the agent is already looking at, then
          nothing dressed up: a campaign the agent has no name for is headed
          "Another campaign" rather than by a UUID. A bare id is unusable and a
          blank heading reads as a rendering fault, and both would be the FIRST
          thing on a panel a customer is waiting behind.
        */
        campaignName:
          attempt.campaign_name || (isCurrent ? currentCampaignName : 'Another campaign'),
        isCurrent,
        attempts: [],
      };
      byId.set(campaignId, group);
      groups.push(group);
    }
    group.attempts.push(attempt);
  }

  // The current campaign is hoisted rather than left where its newest attempt
  // happened to fall. The agent's own pass is the context for the call they are
  // about to take; an ancestor's is background, however recent it is.
  return groups.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent));
}

/**
 * A prior attempt's disposition, in words.
 *
 * ── The catalog only ever names THIS campaign's codes ───────────────────────
 * `AgencySessionBootstrap.disposition_catalog` is the campaign the agent is
 * joined to, and nothing else. Once history spans a lineage, a code the parent
 * campaign had and the child does not is routine — an operator dropping an
 * outcome between passes is the ordinary reason to author a retry at all — and
 * the old behaviour rendered every one of them as the literal words "Unknown
 * outcome".
 *
 * That is worse than the raw code in the one place it matters: an agent reading
 * "Unknown outcome" concludes the platform lost the write-up, when in fact the
 * write-up is right there and only its label is missing. So an unresolved code
 * is shown **as the code**, beside the campaign name that explains why it has no
 * label. `null` still reads as "No disposition", which is a fact rather than a
 * failure — plenty of attempts end without one.
 *
 * ── What is deliberately NOT done ───────────────────────────────────────────
 * The parent's catalog is not shipped to the agent to resolve these. That would
 * mean an agent-floored payload carrying another campaign's configuration, and
 * the `agent` role sits at level 5 holding exactly four `agency.*` permissions
 * precisely so that nothing on this screen reaches beyond the campaign they are
 * joined to. The label is not worth the widening; the code says enough.
 */
export function priorDispositionLabel(
  code: string | null,
  catalog: readonly AgencyDisposition[] | undefined,
): string {
  if (!code) return 'No disposition';
  return catalog?.find((entry) => entry.code === code)?.label ?? code;
}

/**
 * Whether {@link priorDispositionLabel} fell back to the raw code, so the render
 * can style it as one rather than passing an enum off as prose.
 */
export function priorDispositionIsRaw(
  code: string | null,
  catalog: readonly AgencyDisposition[] | undefined,
): boolean {
  if (!code) return false;
  return !catalog?.some((entry) => entry.code === code);
}
