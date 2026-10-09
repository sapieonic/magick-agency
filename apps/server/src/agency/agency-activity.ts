import type { AuditLogRecord } from '@magick-agency/db/models/platform/audit.model';
import type { PlatformAuditActorType } from '../audit/platform/catalog.js';
// The CSV primitives, and the formula guard in particular, live in one leaf
// module shared with MAG-159's attempts/roster exports — see that file for why
// a second copy of an injection guard is a defect rather than a duplication.
import { preambleLine, sanitizePreambleValue, toCsvLine } from './agency-csv.js';

/**
 * The campaign activity trail: master's audit rows and core's, merged into one
 * time-ordered stream (MAG-158).
 *
 * ── Why this is application code and not a query ────────────────────────────
 * The two audit stores are separate databases with different schemas. Core's
 * `audit_logs` has `event_type` / `event_category` / `severity` / `event_data` /
 * `actor` / `timestamp`; master's `platform_audit_log` has `action` /
 * `resource_type` / `resource_id` / `details` / `user_id` / `created_at`. They
 * share no connection and no vocabulary, so there is no join to write — master
 * fetches core's page over S2S and interleaves it here.
 *
 * ── The two halves are complementary, not redundant ─────────────────────────
 * Both services write `agency_campaign.paused`, and both rows belong in the
 * trail: master's records that a supervisor pressed Pause, core's records that
 * the campaign actually transitioned. `source` is what tells them apart, which
 * is why it is a first-class field rather than an implementation detail. The
 * rows only core has are the ones a compliance reviewer came for — the
 * auto-pause with its measured abandonment rate — and the rows only master has
 * are the dispositions, DNC marks and staffing changes.
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
 * The three values master persists (`PlatformAuditActorType`) plus `'unknown'`,
 * which is NOT a fourth thing that can be written — it is how a row whose
 * attribution was never recorded reports itself. Two shapes land on it:
 * master's rows from before migration 067 (`actor_type IS NULL`), and core's,
 * which have no equivalent column at all and only ever carried an originator
 * string. Saying `unknown` is the honest report; the alternative — inferring
 * `human` from "there is a name" — is precisely the inference 86d45t7rm exists
 * to stop, one layer up.
 *
 * ⚠️ `'unknown'` appears in NO served vocabulary, and that is a deliberate
 * asymmetry rather than an oversight. `PLATFORM_AUDIT_ACTOR_TYPE_VOCABULARY`
 * (served on `GET /audit-log`) labels only the three values master WRITES,
 * because it is a filter list and "not recorded" is an absence rather than a
 * value to select — it is a date range wearing a different name. This union has
 * a fourth member because it describes what a merged ROW can report, which is a
 * different question. The consequence for a client: the activity trail can hand
 * back an `actor.type` the vocabulary does not label, so cusui owns that string.
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
 * `system: true` used to be the WHOLE of "no human behind this row", and it was
 * computed from `user_id === null`. That inference is no longer sound on
 * master's half: after 86d45t7rm a key-authenticated row deliberately has no
 * `user_id`, and reading it as `system` would report "nothing human was
 * involved" about an action somebody's credential performed — the opposite
 * conclusion, on the one surface whose job is to be believable.
 *
 * So `type` is the recorded fact and `system` is the rendering flag, and on a
 * POST-067 row they agree exactly (`system === (type === 'system')`).
 *
 * ⚠️ **On a PRE-067 row they deliberately disagree**, and a client must not
 * "simplify" one into the other. Such a row reports `type: 'unknown'` — nothing
 * was recorded, and saying otherwise is the invention this whole change removes
 * — while `system` keeps the legacy `user_id === null` reading so the row
 * renders exactly as it always did. Every background write in every campaign
 * trail from before the migration is that shape: `{ type: 'unknown', system:
 * true }`. Rewriting an actor column as `type === 'system'` would flip all of
 * them from "system" to an unhandled `'unknown'`, which is a visible rewrite of
 * history for a change whose whole promise was that history renders unchanged.
 *
 * So: read `system` to decide what to show; read `type` to know whether the
 * human/key distinction was actually captured for that row.
 *
 * `display` carries whatever names the actor best: a person's display name or
 * email, the API key's name, or — for a system row — the mechanism that acted,
 * which is the fact a reviewer needs.
 */
export interface ActivityActor {
  type: ActivityActorType;
  /**
   * Whether to render this row as having no human behind it.
   *
   * Equals `type === 'system'` on every row written since migration 067. On an
   * older row it is the legacy `user_id === null` reading while `type` is
   * `'unknown'` — see the interface header before assuming the two are
   * interchangeable.
   */
  system: boolean;
  user_id: string | null;
  /**
   * The platform API key that acted, when `type === 'api_key'`. Null otherwise —
   * including on core's rows, which have no notion of master's credentials.
   *
   * The person who MINTED the key is deliberately not here and is not `user_id`:
   * that is `platform_api_keys.created_by`, a fact about the credential rather
   * than about this action. Copying it into an actor field is the defect this
   * whole field exists to replace.
   */
  api_key_id: string | null;
  display: string | null;
}

export interface ActivityRow {
  /** Globally unique across both stores — the per-store ids share no namespace. */
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
 * It was 99 rather than 100 because core's `/internal/audit-logs` capped a
 * request at 100 and the merge asks each source for `limit + 1`, so a merged
 * limit of 100 asked core for 101, got a 400, and degraded every full-size page
 * to `partial` — a failure that looked exactly like core being down. Core's cap
 * is now 1000, so 99 is no longer forced by it; it stays because a supervisor's
 * screen renders tens of rows, and the constraint it was chosen for still binds
 * every page size here:
 *
 *   **`<page size> + 1` must be `<=` core's `/internal/audit-logs` cap.**
 *
 * That applies to {@link ACTIVITY_EXPORT_PAGE_SIZE} as well, and it is pinned by
 * `describe('the page ceiling')` in `test/unit/agency/agency-activity.test.ts`.
 */
export const ACTIVITY_MAX_LIMIT = 99;

/**
 * The page size the CSV export walks with.
 *
 * The export is not paging for a reader, it is draining the whole filtered trail
 * — and every page costs one master `SELECT`, one S2S round trip to core and one
 * identity lookup, all in series. At the interactive page size a 5000-row export
 * was ~51 of those trips end to end; at 500 it is ~10.
 *
 * Bounded above by the same invariant as {@link ACTIVITY_MAX_LIMIT}: the merge
 * asks each source for `limit + 1`, so `ACTIVITY_EXPORT_PAGE_SIZE + 1` must fit
 * inside core's request cap (1000) and inside master's own repository ceiling.
 * Overrun core's and every full-size page 400s into `partial`, which on this
 * route is a 424 refusal of the whole export.
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
 * every page is a live round trip to core, and a core that is answering slowly
 * rather than failing keeps the loop legal and unbounded. Without a deadline the
 * handler holds its Fastify connection, its Postgres client and an undici socket
 * for as long as core cares to take — and a compliance export is exactly the
 * request an operator retries when nothing comes back, so the slow case
 * multiplies itself.
 *
 * 30s is chosen against the reader, not against core: it sits inside the
 * browser's patience and well inside the 300s undici header timeout the proxy
 * layer runs with, so the export gives up on its own terms rather than being cut
 * off mid-file by a socket. Expiry is reported like the row ceiling — a short
 * file must never be handed over as a complete one — and carries its own
 * reason, because "narrow the date range" is the wrong remedy for a slow
 * dependency.
 */
export const ACTIVITY_EXPORT_TIME_BUDGET_MS = 30_000;

/**
 * Floor on the per-page core timeout the export derives from its budget.
 *
 * The export's deadline check runs at the BOTTOM of its loop, deliberately, so
 * the budget can never expire before any work has been done — which means the
 * first page is entitled to run even if the clock has somehow already passed the
 * deadline when it starts. Without a floor, "entitled to run" would mean
 * "entitled to run under `AbortSignal.timeout(0)`", i.e. an instantly-aborted
 * page reported as a truncated EMPTY export, which is the outcome that check
 * exists to prevent.
 *
 * It applies to the first page only. Every later page is reached through that
 * bottom check, so its remainder is already positive and is used verbatim — a
 * page starting with 1ms left should abort at once, because the deadline is the
 * answer at that point.
 *
 * So the honest statement of the bound is `budget + one floor`, not `budget`.
 * What matters is that it is nowhere near the 300s undici header timeout a core
 * call falls back to with no `timeoutMs` at all, which is the hole this constant
 * exists alongside closing.
 */
export const ACTIVITY_EXPORT_MIN_PAGE_TIMEOUT_MS = 5_000;

/**
 * Bound on the ownership probe — the campaign read that runs BEFORE either
 * audit read on both activity routes.
 *
 * **Its own budget, not a draw against the export's, and the reason is that the
 * probe is not part of the export.** It runs identically on the JSON route,
 * which has no wall-clock budget to draw from; and on the CSV route a probe that
 * consumed the export's allowance would produce a `time_limit` truncation whose
 * stated remedy ("retry to continue past this point") describes a trail that was
 * never reached at all. Two bounds, each answering for its own call, is the only
 * arrangement where the reported reason is true.
 *
 * Shorter than the export budget because it is one small read of one row, and
 * because everything downstream of it is still ahead: a probe allowed to eat 30s
 * leaves nothing for the pages it exists to authorise.
 *
 * A probe that times out lands on `proxyToCore`'s catch, i.e. the UNVERIFIED
 * branch — master-side scoping, `partial` on the JSON route and a 424 refusal on
 * the CSV one. That is the correct outcome and not a truncation: a core too slow
 * to confirm who owns the campaign has not told us the trail is short, it has
 * told us nothing, and an export cannot be assembled from that.
 */
export const ACTIVITY_OWNERSHIP_PROBE_TIMEOUT_MS = 10_000;

/** Why an export stopped before the trail ran out. Reported, never swallowed. */
export type ActivityExportTruncation = 'row_limit' | 'time_limit';

/** Actor prefix core uses for rows with no HTTP caller behind them. */
const SYSTEM_ACTOR_PREFIX = 'system:';

// ── Normalisation ───────────────────────────────────────────────────────────

/**
 * One of master's rows.
 *
 * `display` is resolved by the caller, which holds the user and API-key tables;
 * an unresolvable id yields `null` rather than dropping the row. A deleted
 * user's — or a revoked key's — actions are still part of the trail, and hiding
 * them would be the one omission an audit cannot afford.
 *
 * ── The attribution is READ from the row, no longer inferred ────────────────
 * This used to compute `system` as `user_id === null`, which was sound only
 * while a null `user_id` had exactly one cause (a background write). Since
 * 86d45t7rm it has two: a key-authenticated action deliberately records the
 * CREDENTIAL and no user, and rendering that as `system` would tell a reviewer
 * nothing human was involved in an action somebody's key performed.
 * `row.actor_type` is now the answer, and it is written at every audited call
 * site in the service.
 *
 * ── …except on rows that predate the column, which keep the old reading ─────
 * `actor_type IS NULL` means "written before migration 067", and there is
 * nothing to read. Those rows fall back to the exact inference this function
 * made before the column existed, so historical rows render today as they
 * rendered yesterday — a display change on old rows would look like the trail
 * being rewritten. `type` reports `'unknown'` for them regardless, so a client
 * that wants to know whether the distinction was actually recorded can ask,
 * while `system`/`display` stay bit-for-bit what they were.
 */
export function normalizeMasterRow(
  row: AuditLogRecord,
  displayNames: ReadonlyMap<string, string | null>,
): ActivityRow {
  // The legacy reading, used ONLY to keep pre-067 rows rendering unchanged.
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
      // PORT NOTE (magick-agency): no API keys (decision #5). The wire shape still carries the
      // key, always null, so `@magick-agency/contracts/api/agency` `ActivityActor` is met.
      api_key_id: null,
      display: resolveMasterDisplay(row, isSystem, displayNames),
    },
    target: { type: row.resource_type ?? null, id: row.resource_id ?? null },
    detail: row.details ?? {},
  };
}

/**
 * What to show in the actor column for one of master's rows.
 *
 * A key's row names the KEY ("Zapier integration"), never its creator: naming
 * the creator on the screen is the same misattribution as naming them in the
 * column, and it is the one a reader would actually act on. An unresolvable key
 * falls back to a bare label rather than to a raw uuid, for the reason
 * `resolveDisplayNames` gives about people — a uuid identifies nobody — and
 * `api_key_id` is on the row for anyone who needs the id itself.
 */
function resolveMasterDisplay(
  row: AuditLogRecord,
  isSystem: boolean,
  displayNames: ReadonlyMap<string, string | null>,
): string | null {
  if (isSystem) return 'system';
  return row.user_id === null ? null : displayNames.get(row.user_id) ?? null;
}

/** One row as core's `GET /internal/audit-logs` returns it. */
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
 * One of core's rows.
 *
 * Core has no `resource_type`/`resource_id` columns, so the target is derived:
 * an agency row carries the campaign in `event_data.campaign_id` (which is what
 * migration 094's expression index covers), and a call-scoped row carries
 * `call_id`. Neither is invented — a row with no derivable target reports
 * nulls rather than being filed against the campaign by assumption.
 *
 * `severity` is folded into `detail` rather than promoted to a column of its
 * own: master has no equivalent, and a field that exists on half a merged
 * stream reads as missing data on the other half.
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
      // Core stamps `system:<mechanism>` when nothing human triggered the write.
      // A bare actor is an originator string, not a user id — core has no user
      // table (design D3) — so `user_id` stays null and the string is the
      // display, which is the whole of the identity core can offer.
      //
      // A non-system core actor is `'unknown'`, NOT `'human'`. Core has no
      // notion of master's platform API keys and its originator string cannot
      // say whether a person was behind the call — claiming `human` would be
      // manufacturing exactly the fact master added `actor_type` because nobody
      // had recorded it. Whether core should carry the discriminator too is the
      // open half of 86d45t7rm.
      //
      // ── `type` and `system` DIVERGE on a null actor, deliberately ─────────
      // Only the explicit `system:` prefix PROVES the write was automatic. A
      // null actor is core having recorded nothing — `parseCoreBody` also
      // normalises a non-string to null — and "I could not work out who" is not
      // "no caller existed". Reading it as `system` is the strongest claim on
      // the enum manufactured out of missing data, which is the ambiguity in
      // core's own `last_transition_by` that this ticket exists to stop
      // recreating (`proxy-agency-campaigns.routes.ts` states it at length:
      // `system` and `unattributed` are opposite conclusions for an incident).
      //
      // `system` keeps the pre-067 reading unchanged, exactly as
      // `normalizeMasterRow` does for a NULL `actor_type`: it is what the page
      // renders from, and a display shift on historical core rows reads as the
      // audit being rewritten. So: read `system` to RENDER, `type` to know
      // whether the distinction was actually captured.
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
    // are handed the store's own id, so it has to come back off here.
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
  // ── The two 86d45t7rm columns are APPENDED, and that placement is the point ──
  //
  // They belong beside `actor`: `actor_type` says which of the identity columns
  // to read, because a row reading `api_key` with an empty `actor_user_id` is
  // FULLY attributed (the credential is named), while the same empty cell under
  // `human` is a name that could not be resolved — and nothing else in the row
  // distinguishes those. That is a real legibility argument and it lost to a
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
  /** The account core's rows were scoped to (`ownedCampaign.coreAccountId`), not the raw request header. */
  accountId: string;
  /** `null` means the filter was never supplied — distinct from an (impossible) empty list. */
  actions: string[] | null;
  from: string | null;
  to: string | null;
  rowCount: number;
  truncated: ActivityExportTruncation | null;
  /** Only meaningful when `truncated === 'row_limit'`; mirrors `ACTIVITY_EXPORT_MAX_ROWS`. */
  rowLimit: number;
  /** `null` when core answered but carried no readable retention horizon — reported, not omitted. */
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
    // PORT NOTE (magick-agency, decision B17): "Magick Agency" (master: "MagickVoice platform").
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
