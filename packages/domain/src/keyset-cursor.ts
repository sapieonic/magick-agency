/**
 * The opaque cursor the supervisor read surface pages by.
 *
 * A LEAF module: no imports, no I/O. The two routes that use it and the two
 * repository methods behind them all agree on one encoding because there is one
 * copy of it.
 *
 * ── Why the timestamp is carried as a STRING and not a `Date` ────────────────
 *
 * `created_at` is `TIMESTAMPTZ`, i.e. **microsecond** precision. A JS `Date`
 * holds milliseconds. Round-tripping the cursor through a `Date` therefore
 * floors it relative to the row it names, and `(created_at, id) < (cursor, id)`
 * then silently **skips** every row whose true timestamp falls inside the
 * truncated millisecond — rows that were never emitted on any page.
 *
 * That is not exotic here: roster ingest and the attempt batcher both insert in
 * batches inside one transaction, where `now()` is fixed for the whole
 * transaction, so thousands of rows legitimately share a timestamp to the
 * microsecond and differ only in `id`.
 *
 * `audit.repository.ts` solves the same problem the other way — it truncates
 * BOTH sides to milliseconds in SQL — and pays for it with an `ORDER BY` over an
 * expression that no index can serve. That is the right trade there (one
 * campaign's control trail is tens of rows). It is the wrong trade here: this
 * pages a million-row table and the whole point of `idx_agency_attempts_reporting`
 * is that the sort comes free. So the cursor carries the microsecond value
 * verbatim — Postgres renders it with `to_char(... 'US')` and parses it back
 * exactly — and the comparison is against the raw column, which the index serves.
 */

export interface AgencyKeysetPosition {
  /** ISO-8601 UTC with MICROSECOND precision, e.g. `2026-08-17T14:03:11.123456Z`. */
  at: string;
  id: string;
}

/**
 * The SQL that renders a `timestamptz` column into the exact string
 * {@link decodeKeysetCursor} expects back. Projected alongside the row, so the
 * cursor is minted from the value the database holds rather than from the
 * millisecond-precision `Date` the driver hands back.
 *
 * `AT TIME ZONE 'UTC'` first: `to_char` on a `timestamptz` renders in the
 * session's `TimeZone`, so without it two replicas with different settings
 * would mint cursors that disagree about which row they name.
 */
export function keysetAtSql(column: string): string {
  return `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

/** UUID v4-ish shape check. Narrow on purpose — see `decodeKeysetCursor`. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{1,6}Z$/;

/**
 * The shape check above is not a date check, and the difference reaches Postgres.
 *
 * `AT_RE` accepts any two digits where a day belongs, so `2026-02-30` and
 * `2026-04-31` pass it — and JS does not catch them either: `new Date` rolls an
 * overflowing ISO day forward into the next month rather than refusing it
 * (`2026-02-30T…` becomes March 2nd). Postgres does refuse it, from inside the
 * `::timestamptz` cast in `keysetCondition`:
 *
 *   ERROR: date/time field value out of range: "2026-02-30T00:00:00.000000Z"
 *
 * Nothing maps that to a status, so a malformed cursor answers **500 with the
 * database's error text** — the same failure mode the `id` check on the line
 * below exists to prevent, arriving through the other field. A cursor is
 * user-supplied (it is in the URL, it gets bookmarked, it gets hand-edited), so
 * this is an ordinary bad request and has to read as one.
 *
 * Year zero needs its own line because it survives BOTH checks: JS is happy to
 * round-trip `0000-08-17`, and Postgres rejects it, because the proleptic
 * Gregorian calendar it implements has no year 0 — 1 BC is followed by 1 AD.
 */
function isRealCalendarInstant(at: string): boolean {
  // Seconds precision is enough: the fractional part is `\d{1,6}` and no
  // six-digit value can be out of range. Comparing the rendering back against
  // the input is what catches the roll-forward — March 2nd does not spell
  // February 30th.
  const seconds = `${at.slice(0, 19)}Z`;
  const parsed = new Date(seconds);
  if (Number.isNaN(parsed.getTime())) return false;
  if (parsed.getUTCFullYear() < 1) return false;
  return parsed.toISOString().slice(0, 19) === at.slice(0, 19);
}

export function encodeKeysetCursor(position: AgencyKeysetPosition): string {
  return Buffer.from(JSON.stringify(position), 'utf8').toString('base64url');
}

/**
 * `null` for anything that is not a cursor this build minted.
 *
 * **Both fields are validated, and for the same reason.** The decoded values go
 * into a parameterised query, so this is not an injection gate — it is a
 * *failure-mode* gate. Each field has a way of reaching Postgres as an error
 * that nothing maps to a status, and so surfaces as a 500 carrying the
 * database's error text: an `id` that is not a UUID raises `22P02 invalid input
 * syntax`, and a date that is merely well-shaped raises `22008 date/time field
 * value out of range` (see {@link isRealCalendarInstant}). Either way a
 * malformed cursor would look like the service being broken rather than like a
 * bad request.
 *
 * The caller must answer **400** on `null` rather than resetting to page one. A
 * cursor that quietly restarts the list from the top reads as duplicate rows to
 * a supervisor scrolling through, and there is no way to tell that from real
 * duplicates.
 */
export function decodeKeysetCursor(raw: string): AgencyKeysetPosition | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const { at, id } = parsed as Record<string, unknown>;
  if (typeof at !== 'string' || !AT_RE.test(at) || !isRealCalendarInstant(at)) return null;
  if (typeof id !== 'string' || !UUID_RE.test(id)) return null;
  return { at, id };
}
