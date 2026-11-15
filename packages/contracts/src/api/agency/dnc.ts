/**
 * Do Not Call list types (`/dnc`, the Do Not Call page).
 *
 * One table, `dnc_entries`, and no copy of it anywhere (decision B8): the dial-time check, the
 * roster import and the soft phone all read the table itself, each widened by scope. So every
 * scope written here is enforced: a tenant-wide entry (no account, no campaign) in every
 * campaign, an account entry in that account's campaigns, a campaign entry in that campaign.
 */

import type { OffsetPage } from '../../primitives';
import type { AgencyDncEntryScope } from '../../agency/softphone';

/**
 * How a number got onto the list: `dnc_entries.source`, mirroring
 * `ck_dnc_entries_source`. The server's validators build their `z.enum` from it.
 */
export const DNC_SOURCES = ['agent', 'import', 'api', 'regulator'] as const;

/** One of {@link DNC_SOURCES}. */
export type DncSource = (typeof DNC_SOURCES)[number];

/** Labels for the four sources. `agent` is the one an operator will see most. */
export const DNC_SOURCE_LABELS: Record<DncSource, string> = {
  agent: 'Marked by an agent',
  import: 'Imported',
  api: 'Added via API',
  regulator: 'Regulator list',
};

/**
 * How far an entry reaches: `tenant` every campaign in the organisation, `account` every campaign
 * of one account, `campaign` one campaign. The soft phone and customer history use the same type.
 */
export type DncEntryScope = AgencyDncEntryScope;

/** The scopes the Do Not Call page can add at, widest first. */
export const DNC_ENTRY_SCOPES = ['tenant', 'account', 'campaign'] as const satisfies readonly DncEntryScope[];

export interface DncEntry {
  id: string;
  tenant_id: string;
  /** The stored column: NULL for a tenant-wide entry, and for a campaign entry (its campaign names the account). */
  account_id: string | null;
  /** NULL ⇒ every campaign of its account (or of the organisation, with no account). */
  campaign_id: string | null;
  phone_e164: string;
  source: DncSource;
  reason: string | null;
  added_by: string | null;
  created_at: string;
  /** How far it reaches, read from the row. */
  scope: DncEntryScope;
  /** The account it belongs to: its own, or its campaign's. NULL for a tenant-wide entry, or a campaign that no longer exists. */
  scope_account_id: string | null;
  /** That account's name, when it can be read. */
  account_name: string | null;
  /** The campaign's name; NULL when there is no campaign, or it no longer exists. */
  campaign_name: string | null;
}

export interface DncListResponse extends OffsetPage {
  entries: DncEntry[];
}

/**
 * `already_present`: listed at exactly this scope already. `already_covered`: a WIDER entry
 * (every campaign, or the campaign's account) already blocks it where asked, so nothing was
 * written. Both are successes.
 */
export type DncAddOutcome = 'added' | 'already_present' | 'already_covered' | 'invalid_phone';

/**
 * One number's outcome.
 *
 * `already_present` and `already_covered` are **successes**, not conflicts: the
 * number is blocked where the caller asked. The UI must not render them as
 * errors, or an operator re-uploading a regulator list sees hundreds of failures
 * that are not failures.
 */
export interface DncAddResult {
  /** The input string unchanged, so the UI can point at the row they typed. */
  input: string;
  outcome: DncAddOutcome;
  phone_e164?: string;
  /** The entry on the list for it: the one written, the same-scope one, or the wider one covering it. */
  entry_id?: string;
  /** That entry's campaign (NULL for none). Read from the row, never echoed from the request. */
  campaign_id?: string | null;
  /** That entry's reach: on `already_covered`, the wider entry's ("already blocked in every campaign"). */
  scope?: DncEntryScope;
}

export interface DncAddSummary {
  added: number;
  already_present: number;
  already_covered: number;
  invalid: number;
  results: DncAddResult[];
}

/**
 * `POST /dnc`. The scope is stated, never implied by what is left out:
 *  - `scope: 'tenant'`: every campaign in the organisation. Only a member of the whole
 *    organisation who may manage the list (`agency.dnc.manage` on a membership with no account).
 *  - `scope: 'account'` with `account_id`: every campaign of that account.
 *  - `scope: 'campaign'` with `campaign_id`: that campaign alone. It must be one of this
 *    organisation's campaigns, in an account the caller manages, else 404.
 * `scope` absent reads the ids as before (neither ⇒ tenant-wide), for a caller that predates it;
 * present, it must agree with them or the request is refused (`invalid_dnc_scope`).
 */
export interface DncAddRequest {
  phone_numbers: string[];
  scope?: DncEntryScope;
  account_id?: string | null;
  campaign_id?: string | null;
  source?: DncSource;
  reason?: string;
}

/**
 * `'tenant'` means "rows with a NULL column"; a uuid means that value; `undefined`
 * means no filter at all. The literal exists because a bare empty query param is
 * indistinguishable from an absent one.
 */
export type DncScopeFilter = string;

export interface DncListParams {
  phone?: string;
  account_id?: DncScopeFilter;
  campaign_id?: DncScopeFilter;
  /** Only entries of this reach. `tenant` (every campaign) is refused for an account-scoped caller, who lists only their account's entries. */
  scope?: DncEntryScope;
  source?: DncSource;
  limit?: number;
  offset?: number;
}
