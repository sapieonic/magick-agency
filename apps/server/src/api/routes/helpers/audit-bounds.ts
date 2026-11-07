/*
 * Bounding a caller-controlled selector or filter set for an audit row, a truncation marked rather
 * than silently cut. Shared by the retry route (`proxy-agency-campaigns/retry.ts`) and the
 * customer-history export (`proxy-agency-customers/export.ts`).
 */
import { AUDIT_FILTER_VALUE_MAX_CHARS } from '../proxy-agency-campaigns/spine.js';

/** Selector dimensions kept on the audit row. The dialer runtime's vocabulary has seven. */
const AUDIT_SELECTOR_MAX_KEYS = 20;

/** Values kept per array dimension, e.g. `last_outcome: [...]`. */
const AUDIT_SELECTOR_MAX_ARRAY_ITEMS = 50;

/**
 * Bound a retry selector (or the customer-history export's filters) before it lands on the
 * compliance trail.
 *
 * The selector belongs on the row — it is the operator's INTENT, the record of
 * which cohort somebody chose to re-dial — but it is caller-controlled and open
 * (`z.record(z.unknown())`), so it can carry a dumped phone roster, a 10k
 * disposition string, or a few thousand keys.
 *
 * The campaigns family already paid for exactly that once: `boundedFilters` (`spine.ts`) and
 * `AUDIT_FILTER_VALUE_MAX_CHARS` exist because a 200KB filter value landed
 * unclipped, repeatably, on the one trail a compliance reader depends on. The
 * retry row is worse in one respect: it is written on every successful create,
 * it must survive the child being deleted, and `platform_audit_log` partitions
 * drop only by age — nothing purges a wide row early.
 *
 * Same treatment, same constants where they apply. Keys are KEPT (an unknown
 * dimension is itself a fact worth recording) and values are bounded; a
 * truncation is MARKED rather than silently cut, so a reader can never mistake a
 * clipped list for the whole selection. A nested object is replaced by its type
 * rather than walked: the legal vocabulary is strings, arrays of strings,
 * numbers and booleans, so anything else is already not a selector the trail needs
 * to reproduce.
 */
export function boundedSelector(selector: Record<string, unknown>): Record<string, unknown> {
  const clip = (value: string): string =>
    value.length > AUDIT_FILTER_VALUE_MAX_CHARS
      ? `${value.slice(0, AUDIT_FILTER_VALUE_MAX_CHARS)}…[truncated]`
      : value;

  const bound = (value: unknown): unknown => {
    if (typeof value === 'string') return clip(value);
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
    if (Array.isArray(value)) {
      const kept = value.slice(0, AUDIT_SELECTOR_MAX_ARRAY_ITEMS).map(bound);
      return value.length > AUDIT_SELECTOR_MAX_ARRAY_ITEMS
        ? [...kept, `…[${value.length - AUDIT_SELECTOR_MAX_ARRAY_ITEMS} more truncated]`]
        : kept;
    }
    return `[${typeof value}]`;
  };

  const entries = Object.entries(selector);
  const out: Record<string, unknown> = Object.fromEntries(
    entries.slice(0, AUDIT_SELECTOR_MAX_KEYS).map(([key, value]) => [clip(key), bound(value)]),
  );
  if (entries.length > AUDIT_SELECTOR_MAX_KEYS) {
    out['…truncated'] = `${entries.length - AUDIT_SELECTOR_MAX_KEYS} more dimensions`;
  }
  return out;
}
