import type { DncAddSummary, DncEntry, DncEntryScope } from '../../../types/dnc';
import { dncScopeWhere, dncScopeWords } from '../../../utils/dncScopeWords';

/**
 * The Do Not Call page's words for scope (DS1, DS4, DS5, DS7): what an add will block, what it
 * did, and what a removal un-blocks. Pure, so each sentence is pinned by a test.
 */

/** The scope the operator picked for an add. A campaign choice is complete only with a campaign. */
export type DncAddChoice =
  | { scope: 'tenant' }
  | { scope: 'account'; accountId: string; accountName: string | null }
  | { scope: 'campaign'; campaignId: string; campaignName: string; accountName: string | null };

/** An entry's scope in words: `Every campaign`, `North account`, `Campaign: Q4 Renewals`. */
export function entryScopeWords(entry: Pick<DncEntry, 'scope' | 'account_name' | 'campaign_name'>): string {
  return dncScopeWords(entry.scope, { accountName: entry.account_name, campaignName: entry.campaign_name });
}

/** Said under the scope choice before Add is pressed: who stops dialling, and who does not. */
export function addChoiceHint(choice: DncAddChoice): string {
  switch (choice.scope) {
    case 'tenant':
      return 'No agency campaign in any account of this organisation will dial these numbers, now or in future.';
    case 'account': {
      const account = choice.accountName?.trim() ? `the ${choice.accountName.trim()} account` : 'this account';
      return `No campaign of ${account} will dial these numbers, now or in future. Campaigns in other accounts can still call them.`;
    }
    case 'campaign':
      return `Only ${choice.campaignName} stops dialling these numbers. Every other campaign can still call them.`;
  }
}

/** The request body's scope fields for a choice: always stated (`api/dnc.ts`). */
export function addChoiceBody(choice: DncAddChoice):
  | { scope: 'tenant' }
  | { scope: 'account'; account_id: string }
  | { scope: 'campaign'; campaign_id: string } {
  switch (choice.scope) {
    case 'tenant': return { scope: 'tenant' };
    case 'account': return { scope: 'account', account_id: choice.accountId };
    case 'campaign': return { scope: 'campaign', campaign_id: choice.campaignId };
  }
}

/**
 * "3 added, 2 already listed, 4 already blocked in every campaign, 1 not usable": the per-number
 * breakdown, with the covered numbers (DS4) split by the wider entry that covers them. The
 * covering account is always the add's own (an account entry covers only its campaigns), so it
 * is named from the choice.
 */
export function addSummaryParts(summary: DncAddSummary, choice: DncAddChoice): string[] {
  const parts = [`${summary.added} added`, `${summary.already_present} already listed`];
  const covered = new Map<DncEntryScope, number>();
  for (const r of summary.results) {
    if (r.outcome === 'already_covered') covered.set(r.scope ?? 'tenant', (covered.get(r.scope ?? 'tenant') ?? 0) + 1);
  }
  const accountName = choice.scope === 'tenant' ? null : choice.accountName;
  for (const scope of ['tenant', 'account', 'campaign'] as const) {
    const n = covered.get(scope);
    if (n) {
      parts.push(`${n} already blocked ${dncScopeWhere(scope, {
        accountName,
        campaignName: choice.scope === 'campaign' ? choice.campaignName : null,
      })}`);
    }
  }
  parts.push(`${summary.invalid} not usable`);
  return parts;
}

/** Who can dial the number again once this entry goes, as the subject of a sentence. */
function whoDialsAgain(entry: Pick<DncEntry, 'scope' | 'account_name' | 'campaign_name'>): string {
  switch (entry.scope) {
    case 'tenant':
      return 'agency campaigns in every account';
    case 'account':
      return entry.account_name?.trim() ? `the ${entry.account_name.trim()} account’s campaigns` : 'that account’s campaigns';
    case 'campaign':
      return entry.campaign_name?.trim() ? entry.campaign_name.trim() : 'that campaign';
  }
}

/**
 * The removal's confirmation: what it un-blocks, and what still blocks the number (`others`, the
 * other entries for the same number the caller can see; null when they could not be read).
 * `seesEverything`: a member of the whole organisation, who sees every entry; anyone else sees
 * their account's only, and the copy says so rather than claiming nothing else blocks it.
 */
export function removalCopy(
  entry: Pick<DncEntry, 'phone_e164' | 'scope' | 'account_name' | 'campaign_name'>,
  others: ReadonlyArray<Pick<DncEntry, 'scope' | 'account_name' | 'campaign_name'>> | null,
  seesEverything: boolean,
): { title: string; message: string } {
  const who = whoDialsAgain(entry);
  const title = entry.scope === 'tenant' ? 'Let every campaign dial this number again?' : `Let ${who} dial this number again?`;
  const still = others === null
    ? 'We couldn’t check whether another entry still blocks it.'
    : others.length > 0
      ? `It stays blocked by ${others.length === 1 ? 'another entry' : 'other entries'}: ${others.map(entryScopeWords).join('; ')}.`
      : seesEverything
        ? 'No other entry blocks it.'
        : 'No other entry for your account blocks it.';
  return {
    title,
    message: `${entry.phone_e164} will be removed from the Do Not Call list (${entryScopeWords(entry)}), and ${who} `
      + `will be able to dial it again. ${still} If it was added at a customer’s request, removing it undoes that request.`,
  };
}

/** The toast that outlives the removal. */
export function removedToast(
  entry: Pick<DncEntry, 'phone_e164' | 'scope' | 'account_name' | 'campaign_name'>,
  stillBlocked: boolean,
): string {
  return `${entry.phone_e164} removed — ${whoDialsAgain(entry)} can dial it again`
    + (stillBlocked ? ', except where another entry still blocks it.' : '.');
}
