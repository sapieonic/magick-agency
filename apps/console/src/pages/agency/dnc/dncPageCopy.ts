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

/** The fields that say where an entry reaches: its scope, its account (its own or its campaign's) and its campaign. */
type EntryReach = Pick<DncEntry, 'scope' | 'scope_account_id' | 'campaign_id'>;
type NamedReach = EntryReach & Pick<DncEntry, 'account_name' | 'campaign_name'>;

/**
 * Where `other` still blocks the number once `removed` goes (DS5):
 * - `covers`: everywhere `removed` reached. An every-campaign entry covers every entry; an account
 *   entry covers its own account's entry and its campaigns' entries; a campaign entry covers only an
 *   entry for the same campaign.
 * - `within`: in part of `removed`'s reach (an account or campaign inside an every-campaign entry,
 *   a campaign of the removed account's).
 * - `elsewhere`: nowhere `removed` reached (another account, another campaign).
 * An account that cannot be read (a campaign that no longer exists) is never assumed to match, so
 * the dialog never claims a block it cannot show.
 */
export function blockOverlap(removed: EntryReach, other: EntryReach): 'covers' | 'within' | 'elsewhere' {
  const sameAccount = removed.scope_account_id !== null && removed.scope_account_id === other.scope_account_id;
  switch (other.scope) {
    case 'tenant':
      return 'covers';
    case 'account':
      if (removed.scope === 'tenant') return 'within';
      return sameAccount ? 'covers' : 'elsewhere';
    case 'campaign':
      if (removed.scope === 'campaign') {
        return removed.campaign_id !== null && removed.campaign_id === other.campaign_id ? 'covers' : 'elsewhere';
      }
      if (removed.scope === 'tenant') return 'within';
      return sameAccount ? 'within' : 'elsewhere';
  }
}

/** How the number stands where the removed entry reached, once it goes: what the toast says. */
export type StillBlocked = 'covered' | 'partly' | 'no';

/** Of the other entries for the number, which still block it where `removed` reached (DS5). */
export function stillBlocked(removed: EntryReach, others: ReadonlyArray<EntryReach> | null): StillBlocked {
  const overlaps = (others ?? []).map((o) => blockOverlap(removed, o));
  return overlaps.includes('covers') ? 'covered' : overlaps.includes('within') ? 'partly' : 'no';
}

function entryList(entries: ReadonlyArray<Pick<DncEntry, 'scope' | 'account_name' | 'campaign_name'>>): string {
  return entries.map(entryScopeWords).join('; ');
}

/**
 * The removal's confirmation: what it un-blocks, and what still blocks the number (`others`, the
 * other entries for the same number the caller can see; null when they could not be read).
 * Only an entry that reaches where the removed one did is said to keep it blocked (DS5): removing
 * "Campaign: Q4 Renewals" while "Campaign: Summer" stays lets Q4 Renewals dial it, so Summer is
 * named as blocking it elsewhere, not as keeping it blocked.
 * `seesEverything`: a member of the whole organisation, who sees every entry; anyone else sees
 * their account's only, and the copy says so rather than claiming nothing else blocks it.
 */
export function removalCopy(
  entry: Pick<DncEntry, 'phone_e164'> & NamedReach,
  others: ReadonlyArray<NamedReach> | null,
  seesEverything: boolean,
): { title: string; message: string } {
  const who = whoDialsAgain(entry);
  const title = entry.scope === 'tenant' ? 'Let every campaign dial this number again?' : `Let ${who} dial this number again?`;
  let still: string;
  let dialsAgain = `and ${who} will be able to dial it again.`;
  if (others === null) {
    still = 'We couldn’t check whether another entry still blocks it.';
  } else {
    const by = (kind: ReturnType<typeof blockOverlap>) => others.filter((o) => blockOverlap(entry, o) === kind);
    const covering = by('covers');
    const within = by('within');
    const elsewhere = by('elsewhere');
    const one = (list: readonly unknown[], single: string, many: string) => (list.length === 1 ? single : many);
    if (covering.length > 0) {
      // Blocked wherever this entry reached: the others say nothing about this removal.
      dialsAgain = `but ${who} still won’t dial it.`;
      still = `It stays blocked by ${one(covering, 'another entry', 'other entries')}: ${entryList(covering)}.`;
    } else {
      still = within.length > 0
        ? `It stays blocked only where ${one(within, 'another entry applies', 'other entries apply')}: ${entryList(within)}.`
        : others.length === 0
          ? (seesEverything ? 'No other entry blocks it.' : 'No other entry for your account blocks it.')
          : (seesEverything ? 'No other entry blocks it there.' : 'No other entry for your account blocks it there.');
      if (elsewhere.length > 0) {
        still += ` ${one(elsewhere, 'Another entry blocks', 'Other entries block')} it elsewhere: ${entryList(elsewhere)}.`;
      }
    }
  }
  return {
    title,
    message: `${entry.phone_e164} will be removed from the Do Not Call list (${entryScopeWords(entry)}), ${dialsAgain} `
      + `${still} If it was added at a customer’s request, removing it undoes that request.`,
  };
}

/** The toast that outlives the removal. */
export function removedToast(
  entry: Pick<DncEntry, 'phone_e164' | 'scope' | 'account_name' | 'campaign_name'>,
  blocked: StillBlocked,
): string {
  if (blocked === 'covered') return `${entry.phone_e164} removed — another entry still blocks it for ${whoDialsAgain(entry)}.`;
  return `${entry.phone_e164} removed — ${whoDialsAgain(entry)} can dial it again`
    + (blocked === 'partly' ? ', except where another entry still blocks it.' : '.');
}
