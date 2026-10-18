/**
 * The one shape check for an id the schema types `UUID`.
 *
 * A non-UUID string that reaches a `$n::uuid` / `uuid[]` cast is a Postgres
 * `22P02`, which surfaces as a 500 carrying the database's error text for what is
 * a caller's typo — so ids from paths and query strings are checked against this
 * at the edge. Here rather than in a route or agency module so both layers import
 * it without either importing the other.
 */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
