/**
 * Do Not Call list types.
 *
 * Mirrors `magick-master/src/dnc/` — this is a **master-native** surface, not a
 * `/proxy/*` one. Master owns `dnc_entries`; core receives only a derived,
 * tenant-flat Redis set for its dial-time check. So there is no core shape to
 * reconcile against here, unlike everything else under `agency*`.
 */

/** `dnc_entries.source`, as enumerated by `DNC_SOURCES` in master. */
export type DncSource = 'agent' | 'import' | 'api' | 'regulator';

export const DNC_SOURCES: readonly DncSource[] = ['agent', 'import', 'api', 'regulator'];

/** Labels for the four sources. `agent` is the one an operator will see most. */
export const DNC_SOURCE_LABELS: Record<DncSource, string> = {
  agent: 'Marked by an agent',
  import: 'Imported',
  api: 'Added via API',
  regulator: 'Regulator list',
};

export interface DncEntry {
  id: string;
  tenant_id: string;
  /** NULL ⇒ tenant-wide. Only tenant-wide rows reach core's Redis set. */
  account_id: string | null;
  /** NULL ⇒ every campaign. */
  campaign_id: string | null;
  phone_e164: string;
  source: DncSource;
  reason: string | null;
  added_by: string | null;
  created_at: string;
}

export interface DncListResponse {
  entries: DncEntry[];
  total: number;
  limit: number;
  offset: number;
}

export type DncAddOutcome = 'added' | 'already_present' | 'invalid_phone';

/**
 * One number's outcome.
 *
 * `already_present` is a **success**, not a conflict — re-adding a suppressed
 * number leaves the caller's intent satisfied. The UI must not render it as an
 * error, or an operator re-uploading a regulator list sees hundreds of failures
 * that are not failures.
 */
export interface DncAddResult {
  /** The input string verbatim, so the UI can point at the row they typed. */
  input: string;
  outcome: DncAddOutcome;
  phone_e164?: string;
  entry_id?: string;
}

export interface DncAddSummary {
  added: number;
  already_present: number;
  invalid: number;
  results: DncAddResult[];
}

/**
 * `'tenant'` means "rows with a NULL scope"; a uuid means that scope; `undefined`
 * means no filter at all. The literal exists because a bare empty query param is
 * indistinguishable from an absent one, and "show me the tenant-wide rows" — the
 * rows that actually reach core — is the most useful filter on this screen.
 */
export type DncScopeFilter = string;

export interface DncListParams {
  phone?: string;
  account_id?: DncScopeFilter;
  campaign_id?: DncScopeFilter;
  source?: DncSource;
  limit?: number;
  offset?: number;
}
