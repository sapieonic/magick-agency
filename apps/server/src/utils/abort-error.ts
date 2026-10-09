/**
 * Was a rejection the `AbortSignal.timeout` we installed ourselves?
 *
 * ── Why this is not `err instanceof Error && err.name === 'TimeoutError'` ──
 *
 * Two things break that shorter form, and both were observed in this codebase
 * before this helper existed:
 *
 *  1. `AbortSignal.timeout` rejects with a **`DOMException`**, whose
 *     relationship to `Error` differs by runtime. An `instanceof Error`
 *     narrowing that happens to be false silently reclassifies every deadline
 *     abort as an unexplained transport fault — the exact wrong direction for a
 *     caller whose next decision is "may this be retried?".
 *  2. **undici wraps it.** Depending on where in the request the abort lands the
 *     real reason arrives on `.cause`, under an `AbortError` or a `TypeError` on
 *     top. So one level of `cause` is unwrapped rather than trusting the outer
 *     name.
 *
 * `AbortError` is accepted alongside `TimeoutError` because a signal aborted by
 * other means reports that name, and every caller here installs exactly one
 * signal — so anything aborted is that deadline.
 *
 * Duck-typed on `name` throughout, for reason (1).
 *
 * ── Two private copies predate this module ────────────────────────────────
 *
 * `isAbortFromTimeout` in `src/agency/agency-activity.service.ts` and
 * `isAbortError` in `src/api/routes/proxy-agency-campaigns.routes.ts` are the
 * same predicate, arrived at independently. This is their shared home; they
 * should migrate here rather than a fourth copy being written. They are left in
 * place for now because each is pinned by its own suite and neither belongs to
 * the change that extracted this.
 */
export function isAbortFromTimeout(err: unknown): boolean {
  for (let current: unknown = err, depth = 0; depth < 2; depth += 1) {
    if (current === null || typeof current !== 'object') return false;
    const name = (current as { name?: unknown }).name;
    if (name === 'TimeoutError' || name === 'AbortError') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
