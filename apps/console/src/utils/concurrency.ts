/**
 * Run an async mapper over a list with a ceiling on how many are in flight.
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 * `Promise.all(items.map(fn))` starts everything at once. That is fine for a
 * handful and wrong for a list whose length is a property of the tenant's data
 * rather than of the screen: the agency analytics page fans out one `/stats`
 * request per campaign, and `listAgencyCampaigns` is unpaginated, so an account
 * that has run three hundred campaigns over a year opened three hundred
 * simultaneous requests through master and three hundred onward to core. The
 * browser queues them, master does not.
 *
 * ── It behaves like `allSettled`, deliberately ─────────────────────────────
 * Every result is returned as `{ status }` rather than the first rejection
 * winning. Both call sites are decorating a list where one item's failure must
 * annotate that item and leave its siblings intact — on a page somebody opens
 * *because* something looks wrong, one failed campaign must not blank the other
 * four. A rejecting variant would just be `Promise.all` with extra steps.
 *
 * Order is preserved: results are written back by index, so `results[i]`
 * corresponds to `items[i]` regardless of completion order. Callers zip the two
 * together and that has to hold.
 */

export type SettledResult<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

/**
 * The default ceiling.
 *
 * Six, matching the per-host connection limit browsers have used for HTTP/1.1 —
 * so on a connection-limited transport we are not queueing requests the browser
 * would queue anyway, and on HTTP/2 we are bounding work that would otherwise
 * arrive at master all at once. Not tuned against a benchmark; chosen to be
 * obviously-enough rather than a magic number, and overridable per call site.
 */
export const DEFAULT_CONCURRENCY = 6;

export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = DEFAULT_CONCURRENCY,
): Promise<Array<SettledResult<R>>> {
  const results = new Array<SettledResult<R>>(items.length);
  if (items.length === 0) return results;

  // A shared cursor rather than fixed slices: campaigns do not take equal time,
  // and slicing would leave a worker idle while another chewed through a slow
  // tail.
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  async function worker(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await fn(items[index]!, index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
