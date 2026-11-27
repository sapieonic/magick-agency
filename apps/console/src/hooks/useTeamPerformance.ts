import { useCallback, useRef } from 'react';
import type { AgencyTeamPerformance, AgencyTeamPerformanceQuery } from '@magick-agency/contracts/api/agency/team-performance';
import { getTeamPerformance } from '../api/teamPerformance';
import { COMPARE_SETTLE_MS, useCompareRead, useSettledKey } from './useCompareRead';
import { useVisibleInterval } from './useVisibleInterval';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import { useAtLocalMidnight } from './useAtLocalMidnight';

/** How often a window that holds today is read again while the page is visible (§2 States). */
export const TEAM_REFRESH_MS = 60_000;

export interface TeamPerformanceRead {
  /** The answer on screen: the current question's, or the last one kept up while the next loads. */
  data: AgencyTeamPerformance | null;
  /** The answer on screen is for the question asked now. */
  current: boolean;
  /** The first read of this question is on its way (filters changed): "Updating…" over the last answer. */
  updating: boolean;
  /** The read of the current question failed. */
  error: unknown;
  failed: boolean;
  retry: () => void;
}

/**
 * Team performance's read (`docs/team-performance.md` §2 States), built on Compare's
 * (`useCompareRead` + `useSettledKey`):
 *
 * - the question settles for {@link COMPARE_SETTLE_MS} before it is asked, so a burst of filter
 *   changes sends one read; a read the question has moved on from is cancelled (its slot freed),
 *   and the last answer stays on screen, marked as updating;
 * - a window that holds today (`live`) is read again every {@link TEAM_REFRESH_MS} while the page
 *   is visible, when the reader comes back to it, and at local midnight; those reads keep the
 *   answer up quietly (no "Updating…": the question has not changed).
 *
 * A null query reads nothing and clears the answer.
 */
export function useTeamPerformance(
  query: AgencyTeamPerformanceQuery | null,
  { tenantId, accountId, live, settleMs = COMPARE_SETTLE_MS }: { tenantId: string; accountId: string; live: boolean; settleMs?: number },
): TeamPerformanceRead {
  const key = query ? JSON.stringify(query) : null;
  const askedKey = useSettledKey(key, settleMs);
  const read = useCompareRead(
    askedKey,
    (signal) => getTeamPerformance(JSON.parse(askedKey!) as AgencyTeamPerformanceQuery, tenantId, accountId, signal),
    askedKey !== key,
  );

  // A refresh never stacks on a read in flight: it would cancel it and start the same read again.
  const busy = useRef(false);
  busy.current = read.status === 'loading';
  const { retry } = read;
  const refresh = useCallback(() => {
    if (!busy.current) retry();
  }, [retry]);
  useVisibleInterval(refresh, TEAM_REFRESH_MS, live && askedKey !== null);
  useRefetchOnReturn(() => {
    if (live && askedKey !== null) refresh();
  });
  useAtLocalMidnight(refresh, live && askedKey !== null);

  const current = read.data !== null && read.dataKey === key;
  const failed = read.status === 'error' && read.doneKey === askedKey && askedKey === key;
  return {
    data: read.data,
    current,
    updating: !current && !failed && key !== null,
    error: failed ? read.error : null,
    failed,
    retry,
  };
}
