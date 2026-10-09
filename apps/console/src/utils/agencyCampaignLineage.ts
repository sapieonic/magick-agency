import type { AgencyCampaignLineage, AgencyCampaignLineageEntry } from '../types/agency-campaign';

/**
 * The campaign header's lineage strip, as data.
 *
 * ── Why the header and not an eighth tab ────────────────────────────────────
 * `agencyCampaignTabs.ts` states the workspace's own rule: the header holds
 * what *changes* the campaign, and each tab answers one question. Lineage
 * answers no question — it is navigation, one line naming the other passes of
 * the same list. A tab would make it a destination a supervisor has to visit to
 * discover that the campaign they are reading is a retry, which is the one fact
 * about it they need before reading anything else on the page.
 *
 * ── Pure, because the copy is the feature ──────────────────────────────────
 * "Retry 1 of Q3 Winback" and "2 retries" are two different sentences about the
 * same chain, chosen by where the campaign sits in it, and both are wrong in
 * ways a rendering test would not catch — an off-by-one generation, a parent
 * counting itself among its own retries, a chain of one announcing that a
 * campaign is its own ancestor.
 */

export interface LineageStripEntry {
  id: string;
  /** "Original" or "Retry 2" — its position in the chain, not its name. */
  position: string;
  name: string;
  status: string;
  contactsTotal: number;
  isCurrent: boolean;
}

export interface LineageStripModel {
  /**
   * The line above the links. Names what this campaign IS within the chain.
   *
   * On a child: "Retry 1 of Q3 Winback" — the generation and the ROOT's name,
   * not the immediate parent's, because on a chain of three "Retry 2 of Q3
   * Winback — Retry 1" is a sentence nobody can parse and the root is the name
   * everyone knows the work by.
   *
   * On a root that has been retried: "Retried 2 times" — a count, because there
   * is no single other campaign to name.
   */
  headline: string;
  entries: LineageStripEntry[];
}

/** "Original" for generation 0, "Retry n" for anything above it. */
export function lineagePositionLabel(generation: number): string {
  return generation <= 0 ? 'Original' : `Retry ${generation}`;
}

/**
 * `null` when there is nothing to say — which is the 100% case today and must
 * render as no strip at all rather than as an empty one.
 *
 * Two shapes reach it and both mean "this campaign is not part of a chain": the
 * lineage route answering with the campaign itself as the only entry (its
 * documented answer for a campaign in no chain — **not** a 404), and a lineage
 * that does not contain the campaign asked about, which can only be a response
 * for a different campaign arriving late.
 */
export function lineageStripModel(
  lineage: AgencyCampaignLineage | null,
  currentCampaignId: string,
): LineageStripModel | null {
  if (!lineage || lineage.campaigns.length <= 1) return null;

  const current = lineage.campaigns.find((entry) => entry.id === currentCampaignId);
  if (!current) return null;

  const entries: LineageStripEntry[] = lineage.campaigns.map((entry) => ({
    id: entry.id,
    position: lineagePositionLabel(entry.retry_generation),
    name: entry.name,
    status: entry.status,
    contactsTotal: entry.contacts_total,
    isCurrent: entry.id === currentCampaignId,
  }));

  return { headline: headlineFor(lineage.campaigns, current), entries };
}

function headlineFor(
  campaigns: readonly AgencyCampaignLineageEntry[],
  current: AgencyCampaignLineageEntry,
): string {
  if (current.retry_generation > 0) {
    /*
      The root's name, found by generation rather than by `root_campaign_id`:
      the chain is already ordered root-first and every entry in it shares one
      root by construction, so the lowest generation IS the root — and reading
      it from the list cannot disagree with the list being rendered underneath.
    */
    const root = campaigns.reduce((lowest, entry) =>
      entry.retry_generation < lowest.retry_generation ? entry : lowest,
    );
    return `${lineagePositionLabel(current.retry_generation)} of ${root.name}`;
  }

  // A root: count the retries BELOW it, never the chain's length. A parent is
  // not one of its own retries.
  const retries = campaigns.filter((entry) => entry.id !== current.id).length;
  return `Retried ${retries} time${retries === 1 ? '' : 's'}`;
}
