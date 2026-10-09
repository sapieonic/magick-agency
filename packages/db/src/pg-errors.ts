/**
 * Postgres error-code predicates, in one place.
 *
 * A deliberately IMPORT-FREE leaf module, like `usage-status-values.ts` and
 * `agency-s2s-contract` beside it: a repository catch arm must be able to ask
 * "was this a unique violation?" without pulling `db/connection` — and through
 * it `src/config`, whose module body can `process.exit(1)` — into the graph of
 * every test that exercises the failure path.
 */

/** `unique_violation` — https://www.postgresql.org/docs/16/errcodes-appendix.html */
export const UNIQUE_VIOLATION = '23505';

/**
 * Was this a unique-index violation, and (when named) from THAT index?
 *
 * ⚠️ Pass the `constraint` whenever the caller intends to swallow the error.
 * A bare `23505` says only "some unique index refused this statement", and a
 * table generally carries several — so a catch arm that treats any of them as
 * its own expected collision silently converts an unrelated constraint failure
 * into a success. The match is on the CONSTRAINT NAME, never on the message
 * text: `err.detail`/`err.message` carry the offending VALUES (phone numbers,
 * client-supplied keys) and their wording is a Postgres implementation detail
 * that has changed between major versions.
 *
 * `err` is `unknown` because that is what a `catch` binding is under
 * `useUnknownInCatchVariables`, and duck-typing rather than `instanceof
 * DatabaseError` because `pg` re-exports that class from a nested dependency —
 * two copies in one process would make the check fail for one of them.
 */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if ((err as { code?: string } | null)?.code !== UNIQUE_VIOLATION) return false;
  if (!constraint) return true;
  return (err as { constraint?: string }).constraint === constraint;
}
