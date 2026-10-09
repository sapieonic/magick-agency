import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Scrapes `src/bootstrap/agency.ts` (the background-work file, docs/seams.md), where the
 * boot wiring lives.
 *
 * `startAgencyIngestReaper()` must actually be CALLED, and the interval must be
 * cleared on shutdown.
 *
 * ── Why this file exists: the fix repeated the bug it was fixing ─────────────
 * The original defect was that the periodic sweep did not exist, so a boot-time
 * one-shot reap found nothing (a job orphaned seconds ago is nowhere near the
 * 10-minute staleness threshold) and no future reap was ever scheduled — the
 * wizard polled a job that would never move. The fix added
 * `startAgencyIngestReaper()` with its own unit tests.
 *
 * Those tests exercise the function. Nothing asserted that anything calls it.
 * Measured: **deleting the single `agencyIngestReapInterval = startAgencyIngestReaper()`
 * line from `src/index.ts` passed all 239 files / 4,691 tests, green.** That is
 * the same shape as the original bug — a method that exists, is unit-tested, and
 * is never invoked — reintroduced one layer up by the fix for it.
 *
 * ── Why a source scrape ─────────────────────────────────────────────────────
 * This repo already reached this conclusion once and wrote down the technique:
 * `test/unit/api/trust-proxy-wiring.test.ts` asserts `src/index.ts`'s
 * `trustProxy` wiring as text because that file builds its app inside `main()`
 * against live config and a real `listen()`, so there is no factory a test can
 * instantiate and no seam to observe. The same is true here, and the countermeasure
 * was available and simply not applied. Same technique, same reason, same file
 * shape — see also `test/unit/utils/metric-path.templates.test.ts`.
 *
 * A source assertion cannot prove the call runs at the right moment; it proves the
 * call has not been deleted or orphaned, which is the failure that actually
 * happened both times.
 */
describe('src/bootstrap/agency.ts agency ingest reaper wiring', () => {
  const source = readFileSync(resolve(process.cwd(), 'src/bootstrap/agency.ts'), 'utf8');

  it('imports the reaper starter', () => {
    // Assert the import too, so a rename that leaves a stale local variable
    // assignment cannot look wired.
    expect(source).toMatch(/\bstartAgencyIngestReaper\b/);
  });

  it('CALLS it, and keeps the handle', () => {
    /**
     * The whole point. `startAgencyIngestReaper` returns the interval handle, and
     * the handle has to be stored or the shutdown path below cannot clear it — so
     * the assertion covers the assignment, not merely the call. A bare
     * `startAgencyIngestReaper();` would leak the timer past shutdown and hang a
     * graceful stop.
     */
    expect(source).toMatch(/agencyIngestReapInterval\s*=\s*startAgencyIngestReaper\(\)/);
  });

  it('does the immediate boot-time reap as well as the interval', () => {
    // The two are complementary and were designed that way: the immediate call
    // catches jobs orphaned by a PRIOR outage (already past the staleness
    // threshold), the interval catches jobs orphaned AFTER this replica booted.
    // Either one alone leaves a hole, so both are pinned.
    expect(source).toMatch(/agencyIngestJobRepository\.reapStaleJobs\(\)/);
  });

  it('clears the interval on graceful shutdown', () => {
    // An interval that outlives the shutdown sequence keeps the event loop alive,
    // so `process.exit(0)` is reached by force rather than by the process
    // finishing — and on the way it can fire a sweep against a closed pool.
    expect(source).toMatch(/if\s*\(agencyIngestReapInterval\)\s*clearInterval\(agencyIngestReapInterval\)/);
  });
});
