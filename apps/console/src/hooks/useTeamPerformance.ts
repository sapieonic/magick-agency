import { useCallback, useRef } from 'react';
import type { AgencyTeamPerformance, AgencyTeamPerformanceQuery } from '@magick-agency/contracts/api/agency/team-performance';
import { getTeamPerformance, isRetryableTeamError, teamErrorCode } from '../api/teamPerformance';
import { COMPARE_SETTLE_MS, useCompareRead, useSettledKey } from './useCompareRead';
import { useVisibleInterval } from './useVisibleInterval';
import { useRefetchOnReturn } from './useRefetchOnReturn';
import { useAtLocalMidnight } from './useAtLocalMidnight';

/** How often a window that refreshes on its own is read again while the page is visible (§2 States). */
export const TEAM_REFRESH_MS = 60_000;

export interface TeamPerformanceRead {
  /** The answer on screen: the current question's, or the last one kept up while the next loads. */
  data: AgencyTeamPerformance | null;
  /** The answer on screen is for the question asked now. */
  current: boolean;
  /** The first read of this question is on its way (filters changed): "Updating…" over the last answer. */
  updating: boolean;
  /** Why the last read of the current question failed (`failed` or `refreshFailed`), else null. */
  error: unknown;
  /** The read of the current question failed and none of its figures are on screen. */
  failed: boolean;
  /**
   * The current question's figures are on screen and a quiet refresh of them failed: the page
   * keeps them up and says so calmly (no alert). The next tick reads again when the failure can
   * clear by itself, unless it timed out (`refreshStopped`).
   */
  refreshFailed: boolean;
  /** After the last failure nothing is read on its own until the filters change or the reader asks. */
  refreshStopped: boolean;
  retry: () => void;
}

/**
 * Whether a quiet refresh may follow this failure: only one that can clear by itself (busy, 5xx,
 * the network), and not a timeout. A refusal that is not retryable (404, 400, 403,
 * `feature_disabled`) would only be refused again; `team_timed_out` says the read is too heavy
 * right now, and asking again every minute would only load the database further. Either waits for
 * the filters to change or for the reader's Try again.
 */
function refreshMayFollow(error: unknown): boolean {
  return isRetryableTeamError(error) && teamErrorCode(error) !== 'team_timed_out';
}

/**
 * Team performance's read (`docs/team-performance.md` §2 States), built on Compare's
 * (`useCompareRead` + `useSettledKey`):
 *
 * - the question settles for {@link COMPARE_SETTLE_MS} before it is asked, so a burst of filter
 *   changes sends one read; a read the question has moved on from is cancelled (its slot freed),
 *   and the last answer stays on screen, marked as updating;
 * - `autoRefresh` (the page's rule, `windowAutoRefreshes`: the window holds today and spans at
 *   most 7 local days) reads the same question again every {@link TEAM_REFRESH_MS} while the page
 *   is visible and when the reader comes back to it. Those reads keep the answer up quietly (no
 *   "Updating…": the question has not changed), and a failed one leaves the figures up
 *   (`refreshFailed`). After a failure that asking again would only repeat, or a timeout, nothing
 *   is read on its own until the question changes or the reader presses Try again
 *   (`refreshStopped`);
 * - `refreshAtMidnight` also reads it again at local midnight. The page asks for that only for a
 *   custom window: a preset's dates move with the day, so at midnight its question changes and is
 *   read anew, and re-reading the old question too would be a read wasted.
 *
 * A null query reads nothing and clears the answer.
 */
export function useTeamPerformance(
  query: AgencyTeamPerformanceQuery | null,
  {
    tenantId,
    accountId,
    autoRefresh,
    refreshAtMidnight = false,
    settleMs = COMPARE_SETTLE_MS,
  }: { tenantId: string; accountId: string; autoRefresh: boolean; refreshAtMidnight?: boolean; settleMs?: number },
): TeamPerformanceRead {
  const key = query ? JSON.stringify(query) : null;
  const askedKey = useSettledKey(key, settleMs);
  const read = useCompareRead(
    askedKey,
    (signal) => getTeamPerformance(JSON.parse(askedKey!) as AgencyTeamPerformanceQuery, tenantId, accountId, signal),
    askedKey !== key,
  );

  const lastFailed = read.status === 'error' && read.doneKey === askedKey;
  const stopped = lastFailed && !refreshMayFollow(read.error);

  // A refresh never stacks on a read in flight (it would cancel it and start the same read again),
  // and never follows a failure it may not (refreshMayFollow).
  const blocked = useRef(false);
  blocked.current = read.status === 'loading' || stopped;
  const { retry } = read;
  const refresh = useCallback(() => {
    if (!blocked.current) retry();
  }, [retry]);
  const on = autoRefresh && askedKey !== null;
  useVisibleInterval(refresh, TEAM_REFRESH_MS, on);
  useRefetchOnReturn(() => {
    if (on) refresh();
  });
  useAtLocalMidnight(refresh, on && refreshAtMidnight);

  const current = read.data !== null && read.dataKey === key;
  const failedHere = lastFailed && askedKey === key;
  return {
    data: read.data,
    current,
    updating: !current && !failedHere && key !== null,
    error: failedHere ? read.error : null,
    failed: failedHere && !current,
    refreshFailed: failedHere && current,
    refreshStopped: failedHere && stopped,
    retry,
  };
}
