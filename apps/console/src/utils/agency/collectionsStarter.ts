import { AGENCY_COLLECTIONS_STARTER_CATALOG } from '@magick-agency/contracts/agency';
import type { AgencyDispositionEntry } from '../../types/agency-campaign';
import type { CampaignConfigState } from '../agencyCampaignConfigForm';

/**
 * New campaign's "Start with the Collections set" (agent station AS4): the six outcomes of
 * `AGENCY_COLLECTIONS_STARTER_CATALOG` (Will pay, Call later, No one spoke, Refused, Wrong number,
 * Don't call again, each with its tile picture) in place of the outcomes on the form. A starting
 * point: the supervisor edits it like any catalogue before saving, and the save sends it as the
 * campaign's `disposition_catalog`. Pure.
 */

/** A fresh, unshared copy of the set: the contract's entries are frozen, and a form edits its own. */
export function collectionsStarterOutcomes(): AgencyDispositionEntry[] {
  return AGENCY_COLLECTIONS_STARTER_CATALOG.map((entry) => ({
    ...entry,
    ...('retry' in entry && entry.retry ? { retry: { ...entry.retry } } : {}),
  }));
}

/**
 * The config with the set's outcomes in place. An automatic outcome for unanswered calls that
 * names a code the set does not have is dropped (the server refuses a mapping to a missing code);
 * every other setting is kept.
 */
export function withCollectionsStarter(config: CampaignConfigState): CampaignConfigState {
  const dispositions = collectionsStarterOutcomes();
  const codes = new Set(dispositions.map((d) => d.code));
  const outcomeDispositions = Object.fromEntries(
    Object.entries(config.outcomeDispositions).filter(([, code]) => typeof code === 'string' && codes.has(code)),
  ) as CampaignConfigState['outcomeDispositions'];
  return { ...config, dispositions, outcomeDispositions };
}

/**
 * The set's outcomes named in a sentence, "Will pay, Call later, … and Don't call again": their
 * labels exactly as the set writes them (so the offer never spells one differently from the tile
 * it puts on the form).
 */
export function collectionsStarterNames(): string {
  const labels = AGENCY_COLLECTIONS_STARTER_CATALOG.map((entry) => entry.label);
  return labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** Whether the outcomes on the form are the set as offered, untouched (the offer then says so). */
export function isCollectionsStarter(dispositions: readonly AgencyDispositionEntry[]): boolean {
  return JSON.stringify(dispositions) === JSON.stringify(collectionsStarterOutcomes());
}
