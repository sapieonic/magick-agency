/**
 * Automatic outcomes for unanswered calls (decisions OD1–OD8, `docs/decisions.md`): which
 * catalog code, if any, an attempt that ended with `outcome` is stamped with
 * (`agency_call_attempts.auto_disposition_code`).
 *
 * Pure, so the rule is one function the dialer's settle path calls and a unit test pins.
 * The write is `AgencyAttemptRepository.stampAutoDisposition`; the caller is
 * `dialer/contact-settlement.ts`, on the path that charges the customer's allowance only.
 *
 * Not to be confused with `AUTO_DISPOSITION_CODE` (`disposition.ts`): that is the
 * `no_disposition` code the reaper files on a connected call whose wrap-up lapsed, in
 * `disposition_code`. This is a campaign's chosen label for an UNANSWERED call, in its own
 * column.
 *
 * **A label, never a routing decision (OD1).** Nothing here touches the contact: the retry
 * policy has already decided where it goes, and the mapped entry's own `retry`,
 * `requires_datetime` and `override` are deliberately not read.
 */
import type { AgencyAttemptOutcome } from '@magick-agency/contracts/agency';
import { autoDispositionRefusal, isAutoDispositionOutcome } from '@magick-agency/domain/auto-disposition';
import type { AgencyCampaignRecord } from '../db/models/agency.model.js';

/**
 * The code to stamp on an attempt of `campaign` that ended with `outcome`, or null.
 *
 * Re-checks what the campaign write already refused (OD3, OD6) instead of trusting the
 * row: the campaign the dialer settles with is the pacing leader's cached copy, and a row
 * written around the API (a migration, a hand fix) is not validated. A code no longer in
 * the catalog, or one that now suppresses or is terminal, stamps nothing: a label that
 * says "Do not call" on a contact the retry policy will dial again is worse than none.
 */
export function resolveAutoDisposition(
  campaign: Pick<AgencyCampaignRecord, 'outcome_dispositions' | 'disposition_catalog'>,
  outcome: AgencyAttemptOutcome,
): string | null {
  if (!isAutoDispositionOutcome(outcome)) return null;
  const map = campaign.outcome_dispositions;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return null;
  const code = Object.hasOwn(map, outcome) ? map[outcome] : undefined;
  if (typeof code !== 'string' || code === '') return null;
  return autoDispositionRefusal(campaign.disposition_catalog, code) === null ? code : null;
}
