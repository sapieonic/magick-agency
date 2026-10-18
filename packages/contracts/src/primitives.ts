/**
 * Small wire and type-level primitives the contract files share, each declared
 * once here instead of once per file. Imports nothing, so every contract file
 * may import it.
 */

/** Sort direction on every list route that takes `order`. */
export type SortOrder = 'asc' | 'desc';

/** How a stats series is bucketed. There is deliberately no `hour` and no `year`. */
export const STATS_BUCKET_UNITS = ['day', 'week', 'month'] as const;

/** One of {@link STATS_BUCKET_UNITS}. */
export type StatsBucketUnit = (typeof STATS_BUCKET_UNITS)[number];

/**
 * The paging fields of an OFFSET-paged list response. The rows ride beside them
 * under the route's own key (`entries`, `profiles`, …).
 */
export interface OffsetPage {
  total: number;
  limit: number;
  offset: number;
}

/**
 * The second half of the two-sided exhaustiveness check for an `as const` list
 * of a closed union `U`:
 *
 *   1. `as const satisfies readonly U[]` on the list proves every LISTED value
 *      is a member of `U`;
 *   2. `const _x: AllListed<U, typeof LIST> = true` proves every MEMBER of `U` is
 *      listed. It is `true` only when nothing is missing; otherwise it is the
 *      missing members, so the compile error names them.
 *
 * Either direction drifting is a `tsc --noEmit` failure, i.e. `pnpm lint`.
 */
export type AllListed<U, L extends readonly unknown[]> = [Exclude<U, L[number]>] extends [never]
  ? true
  : Exclude<U, L[number]>;
