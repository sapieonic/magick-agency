import type { AuditLogRecord } from '@magick-agency/db/models/platform/audit.model';
import type { PlatformAuditActorType } from '../audit/platform/catalog.js';
// The CSV primitives, and the formula guard in particular, live in one leaf
// module shared with the attempts/roster exports — see that file for why a
// second copy of an injection guard is a defect rather than a duplication.
import { preambleLine, sanitizePreambleValue, toCsvLine } from './agency-csv.js';

/**
 * The campaign activity trail: the two audit tables' rows, merged into one
 * time-ordered stream.
 *
 * ── Why this is application code and not a query ────────────────────────────
 * Two audit tables with different schemas are kept (decision B7). `audit_logs`
 * (the dialer half, source `'core'`) has `event_type` / `event_category` /
 * `severity` / `event_data` / `actor` / `timestamp`; `platform_audit_log` (the
 * console half, source `'master'`) has `action` / `resource_type` /
 * `resource_id` / `details` / `user_id` / `created_at`. They share no
 * vocabulary, so there is no join to write — `agency-activity.service.ts` reads
 * a page from each and interleaves them here.
 *
 * ── The two halves are complementary, not redundant ─────────────────────────
 * Both halves record `agency_campaign.paused`, and both rows belong in the
 * trail: the `platform_audit_log` row records that a supervisor pressed Pause,
 * the `audit_logs` row records that the campaign actually transitioned. `source`
 * is what tells them apart, which is why it is a first-class field rather than an
 * implementation detail. The rows only `audit_logs` has are the ones a compliance
 * reviewer came for — the auto-pause with its measured abandonment rate — and the
 * rows only `platform_audit_log` has are the dispositions, DNC marks and staffing
 * changes.
 *
 * ── Pagination is keyset, and it has to be ──────────────────────────────────
 * Two OFFSET-paginated sources cannot be merged coherently: an OFFSET counts
 * from the top of a set that keeps growing, so a row written mid-pagination
 * shifts every later page by one and one row is silently skipped. Both
 * repositories therefore order by a TOTAL key — `(timestamp, id)` — and accept a
 * `before` position, and the cursor here is simply one such position per source.
 * A row newer than a source's position is outside its window by construction, so
 * concurrent writes cannot inject themselves mid-stream.
 */

export type ActivitySource = 'master' | 'core';

/**
 * What kind of principal a merged row is attributed to.
 *
 * The values `platform_audit_log` persists (`PlatformAuditActorType`) plus
 * `'unknown'`, which is NOT another thing that can be written — it is how a row
 * whose attribution was never recorded reports itself. Two shapes land on it:
 * `platform_audit_log` rows from before the `actor_type` column existed
 * (`actor_type IS NULL`), and `audit_logs` rows, which have no equivalent column
 * at all and only ever carry an originator string. Saying `unknown` is the honest
 * report; the alternative — inferring `human` from "there is a name" — is
 * precisely the inference the `actor_type` column exists to stop, one layer up.
 *
 * ⚠️ `'unknown'` appears in NO served vocabulary, and that is a deliberate
 * asymmetry rather than an oversight. `PLATFORM_AUDIT_ACTOR_TYPE_VOCABULARY`
 * (served on `GET /audit-log`) labels only the values that are WRITTEN, because
 * it is a filter list and "not recorded" is an absence rather than a value to
 * select — it is a date range wearing a different name. This union has an extra
 * member because it describes what a merged ROW can report, which is a different
 * question. The consequence for a client: the activity trail can hand back an
 * `actor.type` the vocabulary does not label, so the console owns that string.
 * Render it as "unattributed" or fall back to `display`; do not render the raw
 * enum, and do not treat it as `system` (see {@link ActivityActor}).
 */
export type ActivityActorType = PlatformAuditActorType | 'unknown';

/**
 * Actor identity, with every key always present.
 *
 * A sometimes-absent key is a different defect from a null one and a client
 * cannot tell it from a field it forgot to read — the rule
 * `agency-agent-identity.ts` states and this follows.
 *
 * ── `type` is the fact; `system` is what to RENDER, and they can differ ─────
 * `system` is not computed from `user_id === null`. A null `user_id` is not by
 * itself proof that nothing human was behind a `platform_audit_log` row, and
 * reading it as `system` where a person or their credential acted would report
 * "nothing human was involved" — the opposite conclusion, on the one surface
 * whose job is to be believable. `actor_type` records the fact instead.
 *
 * So `type` is the recorded fact and `system` is the rendering flag, and on a
 * row that has an `actor_type` they agree exactly (`system === (type ===
 * 'system')`).
 *
 * ⚠️ **On a row with no `actor_type` they deliberately disagree**, and a client
 * must not "simplify" one into the other. Such a row reports `type: 'unknown'` —
 * nothing was recorded, and saying otherwise is an invention — while `system`
 * keeps the legacy `user_id === null` reading so the row renders exactly as it
 * always did. Every background write in every campaign trail from before the
 * column is that shape: `{ type: 'unknown', system: true }`. Rewriting an actor
 * column as `type === 'system'` would flip all of them from "system" to an
 * unhandled `'unknown'`, which is a visible rewrite of history.
 *
 * So: read `system` to decide what to show; read `type` to know whether the
 * human/key distinction was actually captured for that row.
 *
 * `display` carries whatever names the actor best: a person's display name or
 * email, or — for a system row — the mechanism that acted, which is the fact a
 * reviewer needs.
 */
export interface ActivityActor {
  type: ActivityActorType;
  /**
   * Whether to render this row as having no human behind it.
   *
   * Equals `type === 'system'` on every row that has an `actor_type`. On an
   * older row it is the legacy `user_id === null` reading while `type` is
   * `'unknown'` — see the interface header before assuming the two are
   * interchangeable.
   */
  system: boolean;
  user_id: string | null;
  /**
   * Always `null`: there are no platform API keys in v1 (`docs/decisions.md`,
   * "Platform API keys"). The key stays on the shape because the contracts'
   * `ActivityActor` carries it.
   */
  api_key_id: string | null;
  display: string | null;
}

export interface ActivityRow {
  /** Globally unique across both tables — the per-table ids share no namespace. */
  id: string;
  /** ISO 8601. */
  at: string;
  source: ActivitySource;
  action: string;
  actor: ActivityActor;
  target: { type: string | null; id: string | null };
  detail: Record<string, unknown>;
}

export interface SourcePosition {
  /** ISO 8601 timestamp of the last row emitted from this source. */
  at: string;
  /** That row's id, in that source's own namespace. */
  id: string;
}

export interface ActivityCursor {
  master: SourcePosition | null;
  core: SourcePosition | null;
}

export const ACTIVITY_DEFAULT_LIMIT = 50;

/**
 * The interactive page ceiling — a UI page size, and nothing more.
 *
 * 99 because a supervisor's screen renders tens of rows. The constraint that
 * binds every page size here is the repositories' own clamp:
 *
 *   **`<page size> + 1` must be `<=` `AUDIT_FIND_MAX_LIMIT` (1000).**
 *
 * The merge asks each table for `limit + 1`, and `auditRepository.findFiltered`
 * silently clamps a larger request to its cap — so an over-sized page loses its
 * look-ahead row and the merge reads it as the end of the trail. That applies to
 * {@link ACTIVITY_EXPORT_PAGE_SIZE} as well, and it is pinned by
 * `describe('the page ceiling')` in `test/unit/agency/agency-activity.test.ts`.
 */
export const ACTIVITY_MAX_LIMIT = 99;

/**
 * The page size the CSV export walks with.
 *
 * The export is not paging for a reader, it is draining the whole filtered trail
 * — and every page costs two audit `SELECT`s and one identity lookup. At the
 * interactive page size a 5000-row export would be ~51 of those pages; at 500 it
 * is ~10.
 *
 * Bounded above by the same invariant as {@link ACTIVITY_MAX_LIMIT}: the merge
 * asks each table for `limit + 1`, so `ACTIVITY_EXPORT_PAGE_SIZE + 1` must fit
 * inside both repositories' clamps (1000 each). Overrun them and every full-size
 * page is silently shortened, so the export would stop early while reporting
 * itself complete.
 */
export const ACTIVITY_EXPORT_PAGE_SIZE = 500;

/**
 * Ceiling on a CSV export. A campaign's control trail is tens to low hundreds of
 * rows, so this is a runaway guard rather than a routine limit — but a
 * compliance export that stopped early without saying so would be the exact
 * failure this feature exists to prevent, so hitting it is reported.
 */
export const ACTIVITY_EXPORT_MAX_ROWS = 5000;

/**
 * Wall-clock budget for the export loop.
 *
 * The row ceiling bounds how much is written, not how long the writing takes:
 * every page is a set of live database reads, and a database that is answering
 * slowly rather than failing keeps the loop legal and unbounded. Without a
 * deadline the handler holds its Fastify connection and its Postgres clients for
 * as long as the reads take — and a compliance export is exactly the request an
 * operator retries when nothing comes back, so the slow case multiplies itself.
 *
 * 30s is chosen against the reader: it sits inside the browser's patience, so the
 * export gives up on its own terms rather than being cut off mid-file. The
 * deadline is checked between pages, at the bottom of the loop. Expiry is
 * reported like the row ceiling — a short file must never be handed over as a
 * complete one — and carries its own reason, because "narrow the date range" is
 * the wrong remedy for a slow dependency.
 */
export const ACTIVITY_EXPORT_TIME_BUDGET_MS = 30_000;

/**
 * Floor on a per-page timeout derived from the export budget.
 *
 * Nothing in `src/` reads this today: the export loop applies no per-page
 * timeout, because `fetchActivityPage` is two database reads with no
 * `AbortSignal` to arm. The bound on a slow export is the between-pages deadline
 * check against {@link ACTIVITY_EXPORT_TIME_BUDGET_MS}, which runs at the BOTTOM
 * of the loop so the budget can never expire before any work has been done.
 */
export const ACTIVITY_EXPORT_MIN_PAGE_TIMEOUT_MS = 5_000;

/**
 * Bound for the ownership probe — the campaign read that runs BEFORE either
 * audit read on both activity routes.
 *
 * Not applied to any call in `src/` today. The probe is `callCore` into the
 * internal handler's campaign read, which runs in-process: there is no transport
 * to time out (`timeoutMs` is accepted and ignored), and a failing read
 * propagates rather than landing on a degraded branch. The figure stays as the
 * reference other budgets are compared against (`TRANSITION_ACTOR_LOOKUP_TIMEOUT_MS`
 * is argued against it, and the suites compare to it).
 *
 * Its reasoning still holds for any bound placed on the probe: it is its own
 * budget, not a draw against the export's, because the probe is not part of the
 * export — it runs identically on the JSON route, which has no wall-clock budget,
 * and on the CSV route a probe that consumed the export's allowance would produce
 * a `time_limit` truncation whose stated remedy describes a trail that was never
 * reached. And it is shorter than the export budget because it is one small read
 * of one row with everything downstream still ahead.
 */
export const ACTIVITY_OWNERSHIP_PROBE_TIMEOUT_MS = 10_000;

/** Why an export stopped before the trail ran out. Reported, never swallowed. */
export type ActivityExportTruncation = 'row_limit' | 'time_limit';

/** Actor prefix the dialer runtime stamps on `audit_logs` rows with no caller behind them. */
const SYSTEM_ACTOR_PREFIX = 'system:';

// ── Normalisation ───────────────────────────────────────────────────────────

/**
 * One `platform_audit_log` row.
 *
 * `display` is resolved by the caller, which holds the user and API-key tables;
 * an unresolvable id yields `null` rather than dropping the row. A deleted
 * user's — or a revoked key's — actions are still part of the trail, and hiding
 * them would be the one omission an audit cannot afford.
 *
 * ── The attribution is READ from the row, not inferred ──────────────────────
 * `system` is not computed as `user_id === null`, which is sound only while a
 * null `user_id` has exactly one cause (a background write). `row.actor_type` is
 * the answer, and it is written at every audited call site in the service.
 *
 * ── …except on rows that predate the column, which keep the old reading ─────
 * `actor_type IS NULL` means "written before the column existed", and there is
 * nothing to read. Those rows fall back to the `user_id === null` inference, so
 * historical rows render as they always rendered — a display change on old rows
 * would look like the trail being rewritten. `type` reports `'unknown'` for them
 * regardless, so a client that wants to know whether the distinction was actually
 * recorded can ask, while `system`/`display` stay bit-for-bit what they were.
 */
export function normalizeMasterRow(
  row: AuditLogRecord,
  displayNames: ReadonlyMap<string, string | null>,
): ActivityRow {
  // The legacy reading, used ONLY to keep rows with no `actor_type` rendering unchanged.
  const legacySystem = row.user_id === null;
  const isSystem = row.actor_type === null ? legacySystem : row.actor_type === 'system';

  return {
    id: `master:${row.id}`,
    at: new Date(row.created_at).toISOString(),
    source: 'master',
    action: row.action,
    actor: {
      type: row.actor_type ?? 'unknown',
      system: isSystem,
      user_id: row.user_id,
      // No platform API keys in v1. The wire shape still carries the key, always
      // null, so `@magick-agency/contracts/api/agency` `ActivityActor` is met.
      api_key_id: null,
      display: resolveMasterDisplay(row, isSystem, displayNames),
    },
    target: { type: row.resource_type ?? null, id: row.resource_id ?? null },
    detail: row.details ?? {},
  };
}

/**
 * What to show in the actor column for one `platform_audit_log` row.
 *
 * A system row shows `'system'`. Otherwise the resolved name for `user_id`, or
 * `null` when there is no user or the id does not resolve — never a raw uuid,
 * for the reason `resolveDisplayNames` gives: a uuid identifies nobody, and
 * `user_id` is on the row for anyone who needs the id itself.
 */
function resolveMasterDisplay(
  row: AuditLogRecord,
  isSystem: boolean,
  displayNames: ReadonlyMap<string, string | null>,
): string | null {
  if (isSystem) return 'system';
  return row.user_id === null ? null : displayNames.get(row.user_id) ?? null;
}

/** One `audit_logs` row, as `readCore` (`agency-activity.service.ts`) enumerates it. */
export interface CoreAuditLogRow {
  id: string;
  timestamp: string;
  event_type: string;
  event_category?: string;
  severity?: string;
  actor: string | null;
  call_id: string | null;
  request_id?: string | null;
  event_data: Record<string, unknown>;
}

/**
 * One `audit_logs` row.
 *
 * `audit_logs` has no `resource_type`/`resource_id` columns, so the target is
 * derived: an agency row carries the campaign in `event_data.campaign_id` (which
 * is what `idx_audit_logs_campaign_id` covers), and a call-scoped row carries
 * `call_id`. Neither is invented — a row with no derivable target reports
 * nulls rather than being filed against the campaign by assumption.
 *
 * `severity` is folded into `detail` rather than promoted to a column of its
 * own: `platform_audit_log` has no equivalent, and a field that exists on half a
 * merged stream reads as missing data on the other half.
 */
export function normalizeCoreRow(row: CoreAuditLogRow): ActivityRow {
  const actor = row.actor ?? null;
  const campaignId = typeof row.event_data?.['campaign_id'] === 'string'
    ? (row.event_data['campaign_id'] as string)
    : null;

  const target = campaignId !== null
    ? { type: 'agency_campaign', id: campaignId }
    : row.call_id !== null
      ? { type: 'call', id: row.call_id }
      : { type: null, id: null };

  return {
    id: `core:${row.id}`,
    at: new Date(row.timestamp).toISOString(),
    source: 'core',
    action: row.event_type,
    actor: {
      // The dialer runtime stamps `system:<mechanism>` when nothing human
      // triggered the write. A bare actor is an originator string, not a user id
      // — `audit_logs.actor` is free text — so `user_id` stays null and the
      // string is the display, which is the whole of the identity the row
      // offers.
      //
      // A non-system `audit_logs` actor is `'unknown'`, NOT `'human'`. The
      // originator string cannot say whether a person was behind the call —
      // claiming `human` would be manufacturing exactly the fact
      // `platform_audit_log.actor_type` exists to record. `audit_logs` carries
      // no such discriminator today.
      //
      // ── `type` and `system` DIVERGE on a null actor, deliberately ─────────
      // Only the explicit `system:` prefix PROVES the write was automatic. A
      // null actor is the row having recorded nothing, and "I could not work
      // out who" is not "no caller existed". Reading it as `system` is the
      // strongest claim on the enum manufactured out of missing data — the same
      // ambiguity a null `last_transition_by` carries on the campaign row
      // (`proxy-agency-campaigns.routes.ts` states it at length: `system` and
      // `unattributed` are opposite conclusions for an incident).
      //
      // `system` keeps the legacy reading unchanged, exactly as
      // `normalizeMasterRow` does for a NULL `actor_type`: it is what the page
      // renders from, and a display shift on historical rows reads as the audit
      // being rewritten. So: read `system` to RENDER, `type` to know whether the
      // distinction was actually captured.
      type: actor !== null && actor.startsWith(SYSTEM_ACTOR_PREFIX) ? 'system' : 'unknown',
      system: actor === null || actor.startsWith(SYSTEM_ACTOR_PREFIX),
      user_id: null,
      api_key_id: null,
      display: actor,
    },
    target,
    detail: {
      ...row.event_data,
      ...(row.severity ? { severity: row.severity } : {}),
    },
  };
}

// ── Ordering ────────────────────────────────────────────────────────────────

/**
 * Newest first, with a deterministic tie-break.
 *
 * Ties are the common case, not the rare one: both audit loggers batch, one
 * flush is one transaction, and `now()` is fixed for a transaction — so every
 * row in a flush shares a timestamp to the microsecond. Without a total order,
 * "page 2" is not a well-defined question.
 *
 * The within-source arm (`id` descending) matches what both repositories'
 * `ORDER BY` produces, so a page assembled here and a page assembled by SQL
 * agree. The cross-source arm is `source` ascending — arbitrary, but fixed, and
 * fixed is the only property that matters.
 */
export function compareActivityRows(a: ActivityRow, b: ActivityRow): number {
  if (a.at !== b.at) return a.at < b.at ? 1 : -1;
  if (a.source !== b.source) return a.source < b.source ? -1 : 1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

// ── Merge ───────────────────────────────────────────────────────────────────

export interface MergeInput {
  masterRows: ActivityRow[];
  coreRows: ActivityRow[];
  limit: number;
  /** The cursor this page was requested with; carried forward per source. */
  cursor: ActivityCursor;
}

export interface MergeResult {
  rows: ActivityRow[];
  /** `null` when the stream is exhausted. */
  nextCursor: ActivityCursor | null;
}

/**
 * Interleave one page.
 *
 * Callers must fetch `limit + 1` from each source: the merged page's first
 * `limit` rows are drawn from the union of the two prefixes, and one extra per
 * side is exactly what distinguishes "exhausted" from "more to come" without a
 * second query.
 *
 * A source that contributed nothing to this page keeps its previous position
 * rather than being reset — it may simply have no rows left in the window, and
 * discarding its cursor would restart it from the top on the next page.
 */
export function mergeActivityPage(input: MergeInput): MergeResult {
  const merged = [...input.masterRows, ...input.coreRows].sort(compareActivityRows);
  const rows = merged.slice(0, input.limit);
  const hasMore = merged.length > input.limit;

  if (!hasMore) return { rows, nextCursor: null };

  return {
    rows,
    nextCursor: {
      master: lastPositionFrom(rows, 'master') ?? input.cursor.master,
      core: lastPositionFrom(rows, 'core') ?? input.cursor.core,
    },
  };
}

function lastPositionFrom(rows: readonly ActivityRow[], source: ActivitySource): SourcePosition | null {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]!;
    // The prefix is this module's own (`master:` / `core:`); the repositories
    // are handed the table's own id, so it has to come back off here.
    if (row.source === source) return { at: row.at, id: row.id.slice(source.length + 1) };
  }
  return null;
}

// ── Cursor codec ────────────────────────────────────────────────────────────

/**
 * Cursors are opaque base64url. Not for secrecy — the contents are two
 * timestamps and two ids the caller already has — but so the shape can change
 * without a client that parsed it silently paging wrong.
 */
export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cursor }), 'utf8').toString('base64url');
}

/**
 * Returns `null` for anything that is not a cursor this build wrote. The caller
 * refuses the request rather than falling back to page one: a cursor that
 * quietly resets restarts the trail from the top, which reads as duplicate rows
 * to a reviewer scrolling through it.
 */
export function decodeActivityCursor(raw: string): ActivityCursor | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const value = parsed as Record<string, unknown>;
  if (value['v'] !== 1) return null;

  const master = parsePosition(value['master']);
  const core = parsePosition(value['core']);
  if (master === undefined || core === undefined) return null;
  return { master, core };
}

/**
 * Both audit tables key on `UUID`, and the id goes straight into a keyset
 * predicate. A non-uuid string reaches Postgres as `22P02 invalid input syntax
 * for type uuid`, which nothing catches — so a hand-edited cursor turns a route
 * whose stated contract is "never a 500" into exactly that, with the body
 * replaced by a support-ticket message. Validated here so it lands on the
 * route's existing 400 "Malformed cursor" instead.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `undefined` signals malformed; `null` is a legitimate "this source has no position yet". */
function parsePosition(value: unknown): SourcePosition | null | undefined {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object') return undefined;
  const position = value as Record<string, unknown>;
  const at = position['at'];
  const id = position['id'];
  if (typeof at !== 'string' || typeof id !== 'string') return undefined;
  if (!UUID_RE.test(id)) return undefined;
  if (Number.isNaN(new Date(at).getTime())) return undefined;
  return { at, id };
}

// ── CSV ─────────────────────────────────────────────────────────────────────

export const ACTIVITY_CSV_COLUMNS = [
  'at',
  'source',
  'action',
  'actor',
  'actor_user_id',
  'target_type',
  'target_id',
  'detail',
  // ── The two actor-type columns are APPENDED, and that placement is the point ──
  //
  // They belong beside `actor`: `actor_type` says how to read the identity
  // columns — an empty `actor_user_id` under `system` is a complete attribution,
  // the same empty cell under `human` is a name that could not be resolved, and
  // under `unknown` the distinction was never recorded — and nothing else in the
  // row distinguishes those. (`actor_api_key_id` is always empty: there are no
  // platform API keys in v1.) That is a real legibility argument and it lost to a
  // bigger one.
  //
  // This file calls the column set "a fixed contract a spreadsheet reads", and
  // that is not decoration: this is the COMPLIANCE export. Inserting a column at
  // index 3 shifts `target_type`, `target_id` and `detail` right by one, so every
  // consumer that maps by POSITION — a saved Excel/Sheets template, a downstream
  // parser — silently reads `target_type` where it expects `detail`, with no
  // error anywhere. Appending cannot do that: indices 0-7 keep their meaning, and
  // a positional consumer that never learns about the new columns simply carries
  // on reading the eight it knows.
  //
  // So the identity columns are read together via the HEADER, which every
  // spreadsheet import maps by anyway, and the preamble carries the explanation.
  // If this export is ever versioned, revisit the ordering there rather than by
  // moving columns underneath readers who have no way to notice.
  'actor_type',
  'actor_api_key_id',
] as const;

export function activityCsvHeader(): string {
  return toCsvLine([...ACTIVITY_CSV_COLUMNS]);
}

/**
 * One CSV row.
 *
 * `detail` is emitted as JSON in one column rather than exploded into columns
 * per key: the key set differs per action (a disposition has `disposition_code`,
 * an auto-pause has `measured_pct`), so a flattened export would be a sparse
 * matrix whose shape depended on which actions happened to occur in the window.
 * A reviewer opening it in Excel gets a stable header either way.
 */
export function activityCsvRow(row: ActivityRow): string {
  return toCsvLine([
    row.at,
    row.source,
    row.action,
    row.actor.display ?? '',
    row.actor.user_id ?? '',
    row.target.type ?? '',
    row.target.id ?? '',
    JSON.stringify(row.detail),
    row.actor.type,
    row.actor.api_key_id ?? '',
  ]);
}

// ── CSV preamble ────────────────────────────────────────────────────────────

/**
 * A `#`-prefixed comment block the export writes ahead of the header row,
 * on by default (`?preamble=false` on the route omits it).
 *
 * ── Why a CSV needs this at all ──────────────────────────────────────────────
 * Ten columns and nothing else answers "what happened", but a file that
 * reaches a regulator with no campaign, no tenant, no filters and no
 * generation time cannot answer "is this the whole trail, and the trail of
 * what?" — the preamble is the file's own chain-of-custody note, carried
 * inside the artifact rather than in an email it will get separated from.
 *
 * ── The tradeoff, stated where the decision is made ─────────────────────────
 * A `#` line is not an RFC-4180 record — it is one more line before the real
 * header, and a parser with no concept of a comment reads it as a malformed
 * first row (wrong column count) rather than skipping it. Some strict parsers
 * refuse the whole file over that. That is a real cost, not a bug, which is
 * exactly why `?preamble=false` exists as a first-class option rather than a
 * workaround — a caller who knows their downstream tooling is strict opts out
 * per request instead of the platform choosing for them.
 */
export interface ActivityCsvPreambleRetention {
  earliest_retained_at: string | null;
  source: string;
}

export interface ActivityCsvPreambleInput {
  generatedAt: Date;
  campaignId: string;
  campaignName: string | null;
  tenantId: string;
  /** The account the `audit_logs` rows were scoped to — the campaign row's own `account_id`, not the raw request header. */
  accountId: string;
  /** `null` means the filter was never supplied — distinct from an (impossible) empty list. */
  actions: string[] | null;
  from: string | null;
  to: string | null;
  rowCount: number;
  truncated: ActivityExportTruncation | null;
  /** Only meaningful when `truncated === 'row_limit'`; mirrors `ACTIVITY_EXPORT_MAX_ROWS`. */
  rowLimit: number;
  /** `null` when no readable retention horizon was available — reported, not omitted. */
  retention: ActivityCsvPreambleRetention | null;
}

/**
 * Renders the preamble. Truncation and the final row count are only known
 * once the export loop finishes — the caller assembles this list last and
 * `unshift`s it ahead of the header, rather than writing a preamble claiming
 * completeness before the loop has run.
 */
export function buildActivityCsvPreamble(input: ActivityCsvPreambleInput): string[] {
  const name = input.campaignName !== null
    ? sanitizePreambleValue(input.campaignName)
    : '(name unavailable)';

  const actionFilter = input.actions && input.actions.length > 0
    ? input.actions.map(sanitizePreambleValue).join(' | ')
    // Explicit, not omitted: a reviewer must be able to tell "there were no
    // DNC marks" from "DNC marks were filtered out", and a missing line reads
    // as the former no matter which is true.
    : 'none applied — every action type is included';
  const fromFilter = input.from !== null ? sanitizePreambleValue(input.from) : 'none applied — no lower bound';
  const toFilter = input.to !== null ? sanitizePreambleValue(input.to) : 'none applied — no upper bound';

  const truncated = input.truncated === null
    ? 'no — this is the complete trail for the filters above'
    : input.truncated === 'row_limit'
      ? `yes — stopped at the ${input.rowLimit}-row export ceiling; narrow the filters and re-export for the rest`
      : 'yes — stopped after the export\'s time budget; retry to continue past this point';

  const retention = input.retention === null
    // Absent or unreadable, and said so rather than left out — silence here
    // reads as "no limit", which is the one thing it must never be mistaken
    // for on a compliance export.
    ? 'unknown — the dialer\'s retention horizon could not be determined for this export'
    : input.retention.source === 'unbounded'
      ? 'unbounded — the dialer reports no retention horizon for this campaign'
      : input.retention.earliest_retained_at !== null
        ? `records retained from ${sanitizePreambleValue(input.retention.earliest_retained_at)} onward `
          + `(source: ${sanitizePreambleValue(input.retention.source)})`
        : `unknown (source: ${sanitizePreambleValue(input.retention.source)})`;

  return [
    // The product name, decision B17.
    preambleLine('Magick Agency — campaign activity export'),
    preambleLine(`Generated: ${input.generatedAt.toISOString()} (UTC)`),
    preambleLine(`Campaign: ${name} (id: ${sanitizePreambleValue(input.campaignId)})`),
    preambleLine(`Tenant: ${sanitizePreambleValue(input.tenantId)}`),
    preambleLine(`Account: ${sanitizePreambleValue(input.accountId)}`),
    preambleLine(`Filter — action: ${actionFilter}`),
    preambleLine(`Filter — from: ${fromFilter}`),
    preambleLine(`Filter — to: ${toFilter}`),
    preambleLine(`Rows exported: ${input.rowCount}`),
    preambleLine(`Truncated: ${truncated}`),
    preambleLine(`Retention: ${retention}`),
    preambleLine(
      "Source column — 'master' rows are recorded by the console (a person acted); 'core' rows are "
      + "recorded by the dialer (what the campaign did). The same action can appear from both — e.g. a "
      + 'pause a supervisor pressed and the pause the campaign then made.',
    ),
    preambleLine(
      'This preamble is not an RFC 4180 data row and some strict CSV parsers will reject it; '
      + 'pass ?preamble=false on this export to omit it.',
    ),
  ];
}
