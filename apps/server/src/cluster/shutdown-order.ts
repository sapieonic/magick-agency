/**
 * The order the server's background work stops in, after HTTP has closed (`index.ts`,
 * `docs/scaling.md` §6.4, `docs/operations.md` "Shutdown and grace period"):
 *
 *  1. **Pacing halts** first, before anything that drains: no tick is started, every
 *     campaign lease is given up, ticks in flight are waited for (≤ 5 s), and every media
 *     worker is told no dial may go out. Nothing below can be overtaken by a new dial.
 *  2. **The drains, together**: the media workers (each ends its calls and exits; 30 s,
 *     then SIGKILL and a slot reap) beside the completion-notice drain (≤ 30 s), the
 *     analysis stop (its children requeue their jobs; 15 s) and the report pipeline's stop
 *     (≤ 20 s for all of it, `agency/reports/pipeline.ts`; in one process it runs inside
 *     agency's stop instead, beside the notice drain there). Run one after the other they
 *     would add up past the container's 45 s grace.
 *  3. **The rest, one at a time, in reverse start order**: agency (pacing is already
 *     halted and its notices drained), voice, platform (the audit buffers last).
 *
 * In one process the same plan runs with no media drain: pacing halts, the in-process
 * analysis worker stops, then agency, voice and platform.
 */

export interface ShutdownPlan {
  /** Step 1. Null before the agency runtime has started. */
  haltPacing: (() => Promise<void>) | null;
  /** Step 2: run concurrently. */
  drains: Array<() => Promise<void>>;
  /** Step 3: in start order; run in reverse. */
  stops: Array<() => Promise<void>>;
}

/** Run the plan. A failing step is reported and the next one still runs. */
export async function runShutdownPlan(plan: ShutdownPlan, onError: (err: unknown, step: string) => void): Promise<void> {
  if (plan.haltPacing) await plan.haltPacing().catch((err) => onError(err, 'pacing halt'));
  await Promise.all(plan.drains.map((drain) => drain().catch((err) => onError(err, 'drain'))));
  for (const stop of [...plan.stops].reverse()) {
    await stop().catch((err) => onError(err, 'stop'));
  }
}
