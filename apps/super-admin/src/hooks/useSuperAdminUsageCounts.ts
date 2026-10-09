import { useState, useEffect, useCallback } from 'react';
import { getUsageCounts } from '../api/super-admin';
import { localDayStartIso, localDayEndIso } from '../utils/localDayBounds';
import type { UsageCountsResponse } from '@magick-agency/contracts/api/platform/super-admin-usage';

/**
 * NEW (plan §3.3), replaces cusui's `useSuperAdminUsage` / `useSuperAdminFleet`
 * (credits and fleet usage, deleted with the routes they read).
 */

export type PeriodPreset = '7d' | '30d' | '90d' | 'custom';

export const PRESET_DAYS: Record<Exclude<PeriodPreset, 'custom'>, number> = { '7d': 7, '30d': 30, '90d': 90 };

/**
 * The server's cap (`USAGE_COUNTS_MAX_WINDOW_DAYS` in
 * `apps/server/src/api/validators/super-admin.validator.ts`). Checked here
 * BEFORE any request so the operator reads a sentence, not a 400.
 */
export const USAGE_COUNTS_MAX_WINDOW_DAYS = 400;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface UsageWindow {
  /** ISO-8601, inclusive. */
  from: string;
  /** ISO-8601, EXCLUSIVE (the server counts `dialed_at < to`). */
  to: string;
}

/** `YYYY-MM-DD` in the viewer's local calendar. */
export function toYmd(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/**
 * A rolling preset covers today and the `days - 1` local days before it:
 * `[start of local day (today - days + 1), start of tomorrow)`.
 */
export function presetWindow(days: number, now: Date = new Date()): UsageWindow {
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1 - days);
  return { from: from.toISOString(), to: to.toISOString() };
}

/**
 * A custom range is picked as two INCLUSIVE local days. The server's `to` is
 * exclusive, so the end is the instant after the last millisecond of the picked
 * end day — i.e. the start of the next local day. Returns null for a bad shape.
 */
export function customWindow(fromDay: string, toDay: string): UsageWindow | null {
  const from = localDayStartIso(fromDay);
  const endOfLastDay = localDayEndIso(toDay);
  if (!from || !endOfLastDay) return null;
  return { from, to: new Date(Date.parse(endOfLastDay) + 1).toISOString() };
}

/** A user-facing refusal for a window the server would 400, or null when fine. */
export function windowProblem(w: UsageWindow | null): string | null {
  if (!w) return 'Pick a start and an end date.';
  const span = Date.parse(w.to) - Date.parse(w.from);
  if (!(span > 0)) return 'The start date must be on or before the end date.';
  if (span > USAGE_COUNTS_MAX_WINDOW_DAYS * DAY_MS) {
    return `The range may span at most ${USAGE_COUNTS_MAX_WINDOW_DAYS} days. Shorten it and try again.`;
  }
  return null;
}

export interface UsageCountsFilters {
  window: UsageWindow | null;
  tenantId?: string;
  /** Ignored unless `tenantId` is set: the server refuses `account_id` alone. */
  accountId?: string;
}

export function useSuperAdminUsageCounts({ window: win, tenantId, accountId }: UsageCountsFilters) {
  const [data, setData] = useState<UsageCountsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadNonce, setReloadNonce] = useState(0);

  const windowError = windowProblem(win);
  const from = win?.from;
  const to = win?.to;

  useEffect(() => {
    // Nothing is requested for a window the server would refuse.
    if (windowError || !from || !to) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Drop the previous payload so a failed filter change cannot keep showing
    // the last successful totals under the new labels.
    setData(null);

    getUsageCounts({
      from,
      to,
      ...(tenantId ? { tenant_id: tenantId } : {}),
      ...(tenantId && accountId ? { account_id: accountId } : {}),
    })
      .then((res) => { if (!cancelled) setData(res); })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load usage counts');
      })
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [from, to, tenantId, accountId, windowError, reloadNonce]);

  const reload = useCallback(() => setReloadNonce((n) => n + 1), []);

  return { data, loading, error, windowError, reload };
}
