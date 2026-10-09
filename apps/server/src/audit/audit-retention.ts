import { getPool } from '@magick-agency/db';
import { createChildLogger } from '@magick-agency/observability';
import { TtlCache } from '@magick-agency/db/utils/ttl-cache';

const log = createChildLogger({ component: 'audit-retention' });

/**
 * How far back the audit trail can still answer for.
 *
 * ── Why this is derived, not configured ─────────────────────────────────────
 * `audit_logs` is monthly range-partitioned and
 * `audit/audit-partition-maintenance.ts` DROPs whole partitions older than the
 * cutoff (`config.auditPartitions.retentionDays`). That setting is the policy,
 * not the result: a partition survives until its whole month passes the cutoff,
 * and nothing is dropped until the job has run.
 *
 * So the honest horizon is not a number we hold; it is the lower bound of the
 * oldest partition that still exists. That is a fact about the data rather than
 * a declaration about it, so it cannot drift from what was actually kept —
 * which is the whole point on a surface whose job is to say what it does not
 * have.
 *
 * ── What the answer means, precisely ────────────────────────────────────────
 * `earliest_retained_at` is the earliest timestamp for which the trail may be
 * assumed COMPLETE. Rows before it have been dropped with their partition.
 *
 * Two edges are named rather than smoothed over:
 *  - `unbounded` — some surviving partition starts at MINVALUE, so nothing has
 *    been dropped off the front and there is no horizon to state. A caller must
 *    not render this as "data begins at the epoch".
 *  - `unknown` — the catalog read failed. This is best-effort by construction:
 *    an audit read must not 500 because we could not annotate it. The caller
 *    renders "unknown", never a fabricated date.
 *
 * The DEFAULT partition is deliberately excluded from the minimum. It is
 * row-deleted (not dropped) at the same cutoff, so it can transiently hold rows
 * older than the oldest range partition — including them would report a horizon
 * further back than the one that is actually guaranteed.
 */
export type AuditRetentionSource = 'partition_bound' | 'unbounded' | 'unknown';

export interface AuditRetentionHorizon {
  /** ISO timestamp, or null when the horizon is `unbounded`/`unknown`. */
  earliest_retained_at: string | null;
  source: AuditRetentionSource;
}

const UNKNOWN: AuditRetentionHorizon = { earliest_retained_at: null, source: 'unknown' };

/**
 * Partitions are created and dropped daily at most, so a stale-by-minutes answer
 * is harmless — while an uncached `pg_inherits` join on every audit read is a
 * catalog scan per request for a number that barely moves.
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

const cache = new TtlCache<AuditRetentionHorizon>({
  ttlMs: CACHE_TTL_MS,
  maxEntries: 4,
  name: 'audit-retention',
});

/** `FOR VALUES FROM ('2026-01-01 00:00:00+00') TO ('2026-02-01 00:00:00+00')`. */
const FROM_BOUND = /FROM \('([^']+)'\)/;

export async function getAuditRetentionHorizon(): Promise<AuditRetentionHorizon> {
  // The catch is OUTSIDE `getOrLoad` on purpose. `TtlCache`'s contract is that
  // errors are never cached; swallowing the failure inside the loader would
  // instead cache the `unknown` sentinel, so one transient catalog blip would
  // make every audit read for the next five minutes report "how far back this
  // trail goes could not be checked" — a standing false warning from a
  // momentary fault.
  try {
    return await cache.getOrLoad('audit_logs', loadHorizon);
  } catch (err) {
    log.warn({ err }, 'Could not derive the audit retention horizon');
    return UNKNOWN;
  }
}

/** Test seam — the cache is process-wide and would otherwise leak between cases. */
export function resetAuditRetentionCache(): void {
  cache.clear();
}

/**
 * Deliberately has NO try/catch: a rejection must reach `TtlCache` unswallowed
 * so the failure is not cached. `getAuditRetentionHorizon` converts it to
 * `unknown` for the one request that hit it.
 */
async function loadHorizon(): Promise<AuditRetentionHorizon> {
  const pool = getPool();
  const partitions = await pool.query<{ relname: string; bound: string | null }>(`
    SELECT c.relname, pg_get_expr(c.relpartbound, c.oid) AS bound
    FROM pg_inherits i
    JOIN pg_class c ON c.oid = i.inhrelid
    JOIN pg_class p ON p.oid = i.inhparent
    WHERE p.relname = 'audit_logs'`);

  let earliest: Date | null = null;

  for (const { relname, bound } of partitions.rows) {
    // The DEFAULT partition renders as `DEFAULT` and carries no FROM bound;
    // it is excluded on purpose (see the doc comment above).
    if (relname === 'audit_logs_default' || !bound) continue;
    // A partition open at the low end means nothing has aged out yet.
    if (/FROM \(MINVALUE\)/.test(bound)) {
      return { earliest_retained_at: null, source: 'unbounded' };
    }
    const match = FROM_BOUND.exec(bound);
    if (!match?.[1]) continue;
    const from = new Date(match[1]);
    if (Number.isNaN(from.getTime())) continue;
    if (earliest === null || from < earliest) earliest = from;
  }

  if (earliest === null) {
    // No parseable range partitions. Reporting a horizon we cannot derive
    // would be a guess, and a guess is the one thing this must not be.
    return UNKNOWN;
  }
  return { earliest_retained_at: earliest.toISOString(), source: 'partition_bound' };
}
