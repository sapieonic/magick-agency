/**
 * ─── AGENCY DIALER — WHAT COUNTS AS A CONVERSION ────────────────────────────
 *
 * A LEAF module: one exported SQL fragment builder, no imports, no I/O. Same
 * shape and same reasoning as `ABANDONED_ATTEMPT_PREDICATE_SQL` in
 * `abandonment-predicate.ts` — the definition of a counted thing lives in one
 * exported string so two queries that must agree cannot drift.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 *
 * `AgencyDisposition.is_success` has existed on every disposition-catalog entry
 * since migration 072, is settable in the campaign builder, and is styled on the
 * agent's disposition pad. **Nothing counted it.** Its only other reference was a type check in `campaign-config.ts`'s validation loop — i.e. the
 * platform verified the operator's answer was a boolean and then threw it away.
 * An operator could mark `Sale` as a success, watch agents submit it all day, and
 * find no number anywhere that had noticed. A declared-but-dead contract field is
 * worse than an absent one: the console renders the checkbox, so the operator has
 * every reason to believe it means something.
 */

/**
 * The SQL predicate for "this attempt's disposition maps to a catalog entry
 * flagged `is_success`".
 *
 * `attempt` is the alias holding `disposition_code`; `catalog` is any SQL
 * expression yielding the campaign's `disposition_catalog` JSONB (a joined
 * `c.disposition_catalog`, or a scalar subquery).
 *
 * ── `EXISTS`, never a JOIN — and that is a correctness choice ───────────────
 *
 * `jsonb_array_elements` is set-returning. Joined against the attempts, a catalog
 * carrying the same `code` twice — which nothing prevents; the column is only
 * CHECKed to be an array — would produce two rows per attempt and DOUBLE the
 * success count. `EXISTS` asks whether any entry matches and stops there, so a
 * duplicated code is harmless. It also short-circuits, which matters on a
 * per-attempt predicate.
 *
 * ── Defensive on shape, exactly as `resolveDisposition` is ──────────────────
 *
 * The column's only constraint is `jsonb_typeof(disposition_catalog) = 'array'`
 * (migration 072). **Its ELEMENTS are unconstrained**, so a catalog written
 * directly against the internal handlers — or by a client that got the shape wrong — can hold
 * strings, numbers, nulls or nested arrays. `resolveDisposition` filters elements
 * to objects with a non-empty string `code` for precisely this reason: a malformed
 * catalog must not 500 an agent's submission. The same rule applies here, one step
 * harder, because a stats read must not 500 either:
 *
 *   * `jsonb_typeof(e) = 'object'` first, so `e->>'code'` is only asked of objects.
 *   * **`e->'is_success' = 'true'::jsonb` and NOT `(e->>'is_success')::boolean`.**
 *     The cast is the trap: `'{"is_success":"maybe"}'` raises `22P02 invalid input
 *     syntax for type boolean`, nothing maps that to a status, and the whole stats
 *     payload becomes a 500 carrying the database's error text — for one bad
 *     character in one operator's config. The `jsonb` comparison cannot throw on
 *     any input.
 *
 * The comparison is therefore STRICT: only the JSON literal `true` counts. `1`,
 * `"true"` and `"yes"` are read as "not a success" rather than coerced. That is
 * the safe direction (a conversion is never invented from a value nobody meant as
 * one) and it matches what the console writes — a checkbox serialises to `true`.
 * A catalog holding `"true"` under-counts silently, which is why the campaign
 * config validator's `is_success` type check is worth keeping rather than
 * loosening.
 *
 * `disposition_code IS NOT NULL` is left to the caller's surrounding predicate:
 * a NULL code matches no entry here anyway (`e->>'code' = NULL` is NULL, never
 * true), so adding it would be a redundant clause that reads like a guard.
 */
export function successDispositionSql(aliases: { attempt: string; catalog: string }): string {
  return `EXISTS (
    SELECT 1 FROM jsonb_array_elements(${aliases.catalog}) e
     WHERE jsonb_typeof(e) = 'object'
       AND e->>'code' = ${aliases.attempt}.disposition_code
       AND e->'is_success' = 'true'::jsonb
  )`;
}
