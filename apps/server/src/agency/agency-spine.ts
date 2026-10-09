/**
 * The attempt spine's public routes.
 *
 * The internal handler owns the query; the public API layer owns the
 * tenant-facing gate, the filter whitelist and the CSV. There is deliberately
 * **no aggregation** here — unlike the activity trail, which merges two audit
 * tables, this is one store and the public routes are thin.
 *
 * A LEAF module: types, constants and pure functions. No fastify, no db.
 */

import { preambleLine, sanitizePreambleValue, toCsvLine } from './agency-csv.js';

/**
 * The query params forwarded to the internal handler, per route.
 *
 * A whitelist rather than `request.query` wholesale. Forwarding everything means
 * the public API cannot say what it accepts, and any param the handler later
 * gives a meaning to becomes reachable through it without anyone deciding it
 * should be — including on the CSV path, where the route sets `cursor` and
 * `limit` itself and a caller-supplied one would fight it.
 *
 * `cursor` and `limit` are on the JSON lists only, for that reason.
 */
export const ATTEMPT_QUERY_PARAMS = [
  'outcome', 'state', 'disposition_code', 'agent_user_id', 'contact_id', 'phone', 'from', 'to',
] as const;

/**
 * The Contacts tab's three chip groups map onto `state`, `suppressed_reason`,
 * and `last_disposition`. The third key shipped in the console before this
 * list learned it: Apply sent `?last_disposition=voicemail` and the route
 * 400'd `unknown_query_params`, leaving the table on the previous page.
 * That is the same class of defect as `phone` — an unknown filter is now
 * visible (400) rather than silently unfiltered, but it is still not a
 * working filter until the key is here.
 *
 * `last_outcome` is a fourth list filter (last attempt `outcome`) the
 * console does not currently offer as chips; keep it forwarded so a
 * URL/API client can still use it. Do not add `disposition` as an alias:
 * the handler's parser reads `last_disposition` only. Attempts use
 * `disposition_code`, not this key — do not put `last_disposition` on
 * `ATTEMPT_QUERY_PARAMS`.
 */
export const CONTACT_QUERY_PARAMS = [
  'state', 'suppressed_reason', 'last_outcome', 'last_disposition', 'phone', 'from', 'to',
] as const;

export const PAGING_QUERY_PARAMS = ['cursor', 'limit'] as const;

/**
 * Read by the CSV handlers and deliberately never forwarded, so it has to
 * be declared as route-consumed rather than left to read as an unknown param.
 * See {@link forwardAllowedQuery}'s `consumedByRoute`.
 */
export const PREAMBLE_QUERY_PARAMS = ['preamble'] as const;

/**
 * The outcome of narrowing a query down to the params a route forwards.
 *
 * A result type rather than a bare record, because an unrecognised param is now
 * a refusal and the caller has to see it. See {@link forwardAllowedQuery}.
 */
export type ForwardQueryResult =
  | { ok: true; query: Record<string, string> }
  | { ok: false; unknown: string[] };

/** The 400 body for a rejected query. Shared so every route refuses alike. */
export function unknownQueryParamsError(unknown: string[]): {
  error: string; code: string; message: string; details: { unknown: string[] };
} {
  return {
    error: 'Validation failed',
    code: 'unknown_query_params',
    message: `Unrecognised query parameter(s): ${unknown.join(', ')}`,
    // `details` is what the error mask treats as structured client feedback, so
    // the offending names survive to the client instead of being flattened.
    details: { unknown },
  };
}

/**
 * Copy the named params out of a Fastify query object into the flat
 * `Record<string, string>` `callCore` takes, and REFUSE anything not named.
 *
 * ── Named `forwardAllowedQuery`, and the ALLOWED is the whole point ─────────
 * The query is narrowed to an allowlist and anything else is refused — the
 * opposite of forwarding a query unchanged, so the name says which policy a
 * reader is looking at.
 *
 * Repeats (`?outcome=a&outcome=b`) arrive as an array and are joined with a
 * comma, which is the handler's other accepted spelling (`multiParam` splits on
 * commas) — so a client may use either form and this layer does not have to pick
 * one for them.
 *
 * A blank value is dropped rather than forwarded: `?phone=` is what a cleared
 * form field posts, and forwarding it would make an empty search box look like
 * a filter that matched nothing.
 *
 * ── Why an unknown key is a 400 and not a silent drop ──────────────────────
 *
 * The silent drop would be the defect, not the whitelist. A version that
 * iterates the ALLOWLIST and never looks at the request lets a param it does not
 * know about vanish without trace — and the request still succeeds. That is
 * the worst available outcome for a filter: `?phone=+91…` against a route whose
 * whitelist lacked `phone` would answer **200 with the person's entire unfiltered
 * history**, presented by the console as the calls matching their search. The
 * reader gets more rows than they asked for, every one of them wrong, and
 * nothing on screen says so. A 400 is visible; a wrong answer is not.
 *
 * It is also the safer direction for the security argument the whitelist exists
 * for. An `?agent_user_id=` a client appends to a `/my-attempts` route is
 * refused rather than dropped, which is the same protection plus a signal.
 *
 * The cost, stated plainly: a client that appends anything incidental — a cache
 * buster, a `utm_*` tag, a param added by a future console before the server
 * learns it — gets a 400 rather than being quietly tolerated. That is
 * acceptable here because these routes serve one first-party console over
 * hand-written calls, and a param appearing that the server does not know about is
 * far more likely to be a filter silently doing nothing than deliberate noise.
 * It would be the wrong trade on a public API.
 *
 * `consumedByRoute` names params the ROUTE ITSELF reads and therefore must not be
 * treated as unknown — `?preamble=` on the CSV exports is read by the handler and
 * deliberately never forwarded. Without it, strictness would 400 every
 * export.
 */
export function forwardAllowedQuery(
  query: unknown,
  allowed: readonly string[],
  consumedByRoute: readonly string[] = [],
): ForwardQueryResult {
  const source = (query ?? {}) as Record<string, unknown>;

  const permitted = new Set<string>([...allowed, ...consumedByRoute]);
  const unknown = Object.keys(source).filter((key) => !permitted.has(key));
  if (unknown.length > 0) return { ok: false, unknown: unknown.sort() };

  const out: Record<string, string> = {};
  for (const key of allowed) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    const flat = Array.isArray(value) ? value.map(String).join(',') : String(value);
    if (flat.trim().length === 0) continue;
    out[key] = flat;
  }
  return { ok: true, query: out };
}

// ─── Wire shapes, as the public layer reads them ────────────────────────────
//
// Structural mirrors of the contracts' `AgencyAttemptRow` / `AgencyContactRow`,
// as the handler's JSON body delivers them. Nothing branches on a missing field:
// the CSV writers narrow defensively, because a handler change that adds or
// renames a field must degrade to a blank cell rather than throw mid-export.

export interface SpineAttemptRow {
  id: string;
  contact_id: string;
  attempt_number: number;
  phone_e164: string;
  caller_id: string;
  agent_user_id: string | null;
  /**
   * Added by the public layer — the attempt query reads only the dialer's
   * tables, so the handler can only ever serve the id. `null` means either "no
   * agent was on this attempt" or "that id cannot be identified in this tenant";
   * `agent_user_id` distinguishes the two, which is why both keys are always
   * present.
   */
  agent_name?: string | null;
  state: string;
  outcome: string | null;
  disposition_code: string | null;
  notes: string | null;
  callback_at: string | null;
  dispositioned_by_user_id: string | null;
  dispositioned_at: string | null;
  dispositioned_on_behalf: boolean;
  webrtc_call_id: string | null;
  dialed_at: string | null;
  answered_at: string | null;
  bridged_at: string | null;
  ended_at: string | null;
  talk_seconds: number | null;
  wrapup_seconds: number | null;
  created_at: string;
}

export interface SpineContactRow {
  id: string;
  phone_e164: string;
  state: string;
  attempt_count: number;
  our_fault_attempts: number;
  last_outcome: string | null;
  last_disposition: string | null;
  next_attempt_at: string;
  suppressed_reason: string | null;
  timezone: string | null;
  csv_line_number: number | null;
  created_at: string;
  updated_at: string;
}

export interface SpinePage<TRow> {
  rows: TRow[];
  next_cursor: string | null;
  limit: number;
}

/**
 * Narrow the handler's untyped body into a CURSOR page, or `null` if it is not one.
 *
 * ── ⚠️ Not a general "is this a page of rows" test. Do not gate a filter on it ─
 * This function refuses a body for reasons that are about PAGING — an
 * unreadable `next_cursor`, a non-numeric `limit` — and both of those are
 * properties of the drain loop below, not of the rows. A caller that only needs
 * to walk `rows` must use {@link pageRows} instead, and the difference is not
 * academic: `limit` arrives as a query param, so a handler that echoes the
 * caller's `?limit=50` back as the STRING `'50'` is refused here. Gating the
 * roster's membership filter on this function is exactly that bug — the page
 * skips the filter entirely and then reports `inactive_omitted: 0` on a page
 * that had hidden people. The rule is: this
 * function for the export drain, which reads the cursor; {@link pageRows} for
 * anything whose subject is the rows.
 *
 * ── An unreadable cursor is NOT end-of-stream ───────────────────────────────
 *
 * The distinction matters more here than the shape check does. `next_cursor`
 * has exactly two legitimate values — a string (more to read) or `null`/absent
 * (that was the last page) — and the export loop breaks on anything falsy. So
 * coercing a malformed cursor to `null` would mean a mid-drain page that came
 * back wrong ends the export **silently and
 * successfully**: the file is served 200, `truncated` is null, the preamble
 * says complete, and the rows after the bad page simply are not there.
 *
 * That is the one outcome this export is built to make impossible. A partial
 * CSV that announces itself is fine — `row_limit` and `deadline` both do that.
 * A partial CSV that claims to be whole is what a supervisor hands to a
 * regulator. So an unrecognised cursor type returns `null` from here, and the
 * caller turns that into a 502 with nothing exported.
 *
 * `limit` is narrowed the same way for the same reason, though it is currently
 * only carried through to the JSON list rather than read by the drain.
 */
export function asSpinePage<TRow>(body: unknown): SpinePage<TRow> | null {
  if (!body || typeof body !== 'object') return null;
  const value = body as Record<string, unknown>;
  if (!Array.isArray(value['rows'])) return null;

  const cursor = value['next_cursor'];
  const cursorAbsent = cursor === null || cursor === undefined;
  if (!cursorAbsent && typeof cursor !== 'string') return null;

  const limit = value['limit'];
  if (limit !== undefined && typeof limit !== 'number') return null;

  return {
    rows: value['rows'] as TRow[],
    next_cursor: cursorAbsent ? null : cursor,
    limit: typeof limit === 'number' ? limit : 0,
  };
}

/**
 * The rows off a body that carries a row array, or `null` when it does not.
 *
 * ── Why this exists beside {@link asSpinePage} ──────────────────────────────
 * Every enrichment and every filter this layer applies to a page of rows needs one
 * fact: is there an array to walk? {@link asSpinePage} answers a strictly
 * narrower question — is this a page a CURSOR DRAIN can read — and it refuses a
 * body whose `next_cursor` is unreadable or whose `limit` is not a number.
 * Those are the right refusals for the export loop and the wrong ones for
 * everything else, because a `limit` reaches the handler as a query param and a
 * handler that echoed it back as `'50'` would be refused for a field the filter
 * never reads.
 *
 * The cost of that confusion is not a missing key. A roster membership filter
 * gated on `asSpinePage` serves such a page UNFILTERED with
 * `inactive_omitted: 0` — a 200 that states, falsely, that nothing was hidden,
 * which is the single outcome this feature's whole comment budget goes on
 * avoiding. Serving unfiltered is only defensible when there is genuinely no row
 * array to walk, and that is the one thing this function tests.
 *
 * An ARRAY body is refused as well as a primitive: `[1, 2]` has no `rows` member
 * and wrapping one to make room for this layer's counters would invent a shape
 * nobody declared (see `withOmissionCounters`).
 */
export function pageRows<TRow>(body: unknown): TRow[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const rows = (body as Record<string, unknown>)['rows'];
  return Array.isArray(rows) ? (rows as TRow[]) : null;
}

// ─── Export budgets ─────────────────────────────────────────────────────────

/**
 * Not the interactive page size: the export loop is draining a campaign, not
 * rendering one, and each page is a handler call. Matches the handler's `limit`
 * ceiling (`SPINE_MAX_LIMIT`, `spine-filters.ts`), so a page cannot be silently
 * shortened.
 */
export const SPINE_EXPORT_PAGE_SIZE = 500;

/**
 * The row ceiling, and unlike the activity trail's it is a **routine** limit
 * rather than a runaway guard: a campaign is sized for 1M contacts, so a whole-campaign export
 * genuinely exceeds it and the truncation notice is the normal outcome for an
 * unfiltered export rather than a rare one. That is why the header and the
 * preamble both say what to do about it (narrow the filters) instead of only
 * reporting that it happened.
 */
export const SPINE_EXPORT_MAX_ROWS = 50_000;

/**
 * Bounds the case the row ceiling cannot: a drain whose pages answer slowly.
 * Checked between pages; a page itself carries no timeout.
 */
export const SPINE_EXPORT_TIME_BUDGET_MS = 60_000;

export const SPINE_EXPORT_MIN_PAGE_TIMEOUT_MS = 5_000;

export type SpineExportTruncation = 'row_limit' | 'deadline';

// ─── CSV ────────────────────────────────────────────────────────────────────

/**
 * The attempt export's columns.
 *
 * ── `notes` is here, deliberately ───────────────────────────────────────────
 * Agent-typed free text, excluded from the AUDIT trail on purpose (an audit row
 * records the catalog code, not customer content). This is not the audit trail:
 * notes are operational content on the contact record, and "we dialled this
 * number four times and Ravi marked it Not Interested — *because the customer
 * asked us to call after 6pm*" is the answer a compliance question wants. It is
 * a deliberate decision, not a default inherited from spreading the row.
 *
 * ── There is no `context` column, on either export ──────────────────────────
 * The handler does not serve the CSV columns on a list at all — only on the
 * single-contact drill-down — so the exclusion is structural here rather than a
 * column somebody remembered to leave out. See the contracts' `AgencyContactRow`.
 */
export const ATTEMPT_CSV_COLUMNS = [
  'attempt_id',
  'contact_id',
  'attempt_number',
  'phone',
  'caller_id',
  'agent_user_id',
  // Beside the id, not instead of it: the id is the stable join key for a
  // downstream script, the name is what a human reads.
  'agent_name',
  'state',
  'outcome',
  'disposition_code',
  'dispositioned_by_user_id',
  'dispositioned_on_behalf',
  'notes',
  'callback_at',
  'created_at',
  'dialed_at',
  'answered_at',
  'bridged_at',
  'ended_at',
  'talk_seconds',
  'wrapup_seconds',
  'recording_call_id',
] as const;

export const CONTACT_CSV_COLUMNS = [
  'contact_id',
  'phone',
  'state',
  'attempt_count',
  'our_fault_attempts',
  'last_outcome',
  'last_disposition',
  'suppressed_reason',
  'next_attempt_at',
  'timezone',
  'csv_line_number',
  'created_at',
  'updated_at',
] as const;

/** `null`/`undefined` → an empty cell; everything else → its string form. */
function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export function attemptCsvHeader(): string {
  return toCsvLine([...ATTEMPT_CSV_COLUMNS]);
}

export function attemptCsvRow(row: SpineAttemptRow): string {
  return toCsvLine([
    cell(row.id), cell(row.contact_id), cell(row.attempt_number), cell(row.phone_e164),
    cell(row.caller_id), cell(row.agent_user_id), cell(row.agent_name), cell(row.state),
    cell(row.outcome),
    cell(row.disposition_code), cell(row.dispositioned_by_user_id),
    cell(row.dispositioned_on_behalf), cell(row.notes), cell(row.callback_at),
    cell(row.created_at), cell(row.dialed_at), cell(row.answered_at), cell(row.bridged_at),
    cell(row.ended_at), cell(row.talk_seconds), cell(row.wrapup_seconds),
    cell(row.webrtc_call_id),
  ]);
}

export function contactCsvHeader(): string {
  return toCsvLine([...CONTACT_CSV_COLUMNS]);
}

export function contactCsvRow(row: SpineContactRow): string {
  return toCsvLine([
    cell(row.id), cell(row.phone_e164), cell(row.state), cell(row.attempt_count),
    cell(row.our_fault_attempts), cell(row.last_outcome), cell(row.last_disposition),
    cell(row.suppressed_reason), cell(row.next_attempt_at), cell(row.timezone),
    cell(row.csv_line_number), cell(row.created_at), cell(row.updated_at),
  ]);
}

export interface SpineCsvPreambleInput {
  kind: 'attempts' | 'contacts';
  generatedAt: Date;
  campaignId: string;
  campaignName: string | null;
  tenantId: string;
  accountId: string;
  /** The filters actually forwarded, already whitelisted. */
  filters: Record<string, string>;
  rowCount: number;
  truncated: SpineExportTruncation | null;
  rowLimit: number;
}

/**
 * The file's own chain-of-custody note, carried inside the artifact rather than
 * in an email it will get separated from. Same tradeoff as the activity
 * export's: a `#` line is not an RFC-4180 record, so `?preamble=false` opts out.
 *
 * ── It states what is NOT in the file, by name ──────────────────────────────
 * The two lines about `context` and about masking exist because their absence
 * is invisible: a reader with a complete-looking spreadsheet has no way to know
 * a column was withheld, and a compliance answer that silently omits a field is
 * worse than one that names what it omitted and why.
 */
export function buildSpineCsvPreamble(input: SpineCsvPreambleInput): string[] {
  const name = input.campaignName !== null
    ? sanitizePreambleValue(input.campaignName)
    : '(name unavailable)';

  const filters = Object.entries(input.filters);
  const filterLines = filters.length > 0
    ? filters.map(([key, value]) =>
      preambleLine(`Filter — ${sanitizePreambleValue(key)}: ${sanitizePreambleValue(value)}`))
    // Explicit, not omitted: a reviewer must be able to tell "nothing was
    // suppressed" from "suppressed rows were filtered out", and a missing line
    // reads as the former no matter which is true.
    : [preambleLine('Filter — none applied: every row on this campaign is included')];

  const truncated = input.truncated === null
    ? 'no — this is every row matching the filters above'
    : input.truncated === 'row_limit'
      ? `yes — stopped at the ${input.rowLimit.toLocaleString('en-US')}-row export ceiling. `
        + 'A campaign can hold far more than this; narrow the filters (a date range, a state, '
        + 'an outcome) and export again for the rest.'
      : 'yes — stopped after the export\'s time budget; retry to continue past this point';

  return [
    preambleLine(
      input.kind === 'attempts'
        // The product name, decision B17.
        ? 'Magick Agency — campaign call-attempt export (one row per dial)'
        : 'Magick Agency — campaign contact roster export (one row per contact)',
    ),
    preambleLine(`Generated: ${input.generatedAt.toISOString()} (UTC)`),
    preambleLine(`Campaign: ${name} (id: ${sanitizePreambleValue(input.campaignId)})`),
    preambleLine(`Tenant: ${sanitizePreambleValue(input.tenantId)}`),
    preambleLine(`Account: ${sanitizePreambleValue(input.accountId)}`),
    ...filterLines,
    preambleLine(`Rows exported: ${input.rowCount.toLocaleString('en-US')}`),
    preambleLine(`Truncated: ${truncated}`),
    preambleLine(
      'Phone numbers are unmasked. This file is the personal data of everyone listed in it — '
      + 'handle and retain it accordingly.',
    ),
    preambleLine(
      'Not included: the contact\'s uploaded CSV columns. Those are shown one contact at a '
      + 'time in the console and are deliberately not exported in bulk.',
    ),
    ...(input.kind === 'attempts'
      ? [preambleLine(
        'Rows with no agent and no recording are real: an attempt that was abandoned, failed or '
        + 'never answered has neither. They are the rows a call list cannot show.',
      )]
      : [preambleLine(
        'Suppressed contacts appear here with the reason they were suppressed, including ones '
        + 'that were never dialled at all.',
      )]),
    preambleLine(
      'This preamble is not an RFC 4180 data row and some strict CSV parsers will reject it; '
      + 'pass ?preamble=false on this export to omit it.',
    ),
  ];
}

/**
 * Put a person's name on every attempt row.
 *
 * ── Why this is the public layer's job and not the query's ─────────────────
 * The attempt query reads only the dialer's tables, so the furthest it goes is
 * `reserved_agent_id` → `agency_agent_sessions.agent_user_id`. That is already
 * the right resolution — a session id is meaningless to a supervisor — but it
 * stops at a **UUID**, and a column of UUIDs is not a column anyone can read.
 * The public layer resolves identity, and it already does exactly this for the
 * agent floor (`enrichAgencyCampaignStats`'s `enrichAgentNames`).
 *
 * ── Shape rules, inherited from the floor's enrichment ──────────────────────
 * One query for the whole page, never per row. The body is spread rather than
 * rebuilt, so fields the handler adds later still arrive. The KEY is present on every
 * row even when the lookup fails — an absent key is indistinguishable from a
 * client that forgot to read it, while a `null` is an answer. And a failure
 * degrades to nulls rather than failing the read: a name is an improvement on
 * the id, not a precondition for showing the row.
 */
export async function enrichAttemptAgentNames(
  body: unknown,
  tenantId: string,
  resolveNames: (ids: readonly string[], tenantId: string) => Promise<Map<string, string | null>>,
  onError?: (err: unknown) => void,
): Promise<unknown> {
  const rows = pageRows<SpineAttemptRow>(body);
  if (!rows) return body;

  const ids = rows
    .map((row) => row.agent_user_id)
    .filter((id): id is string => typeof id === 'string' && id.length > 0);

  let names = new Map<string, string | null>();
  if (ids.length > 0) {
    try {
      names = await resolveNames(ids, tenantId);
    } catch (err) {
      onError?.(err);
    }
  }

  return {
    ...(body as Record<string, unknown>),
    rows: rows.map((row) => ({
      ...row,
      agent_name: row.agent_user_id ? names.get(row.agent_user_id) ?? null : null,
    })),
  };
}
