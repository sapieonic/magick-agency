import { useCallback, useEffect, useRef } from 'react';
import type { AgencyTeamPerformance, AgencyTeamPerformanceQuery } from '@magick-agency/contracts/api/agency/team-performance';
import { getTeamPerformance, isRetryableTeamError, teamErrorCode } from '../api/teamPerformance';
import { answerAwaitsFinalRead } from '../utils/agency/team/teamUrl';
import { COMPARE_SETTLE_MS, useCompareRead, useSettledKey } from './useCompareRead';
import { useVisibleInterval } from './useVisibleInterval';
import { useRefetchOnReturn } from './useRefetchOnReturn';

/** How often a window that refreshes on its own is read again while the page is visible (§2 States). */
const TEAM_REFRESH_MS = 60_000;

interface TeamPerformanceRead {
  /** The answer on screen: the current question's, or the last one kept up while the next loads. */
  data: AgencyTeamPerformance | null;
  /** The answer on screen is for the question asked now. */
  current: boolean;
  /** The first read of this question is on its way (filters changed): "Updating…" over the last answer. */
  updating: boolean;
  /**
   * Why the last read of the current question failed (`failed` or `refreshFailed`), else null.
   * Held while a read of the same question asks again (a refresh, Try again), so the page's alert
   * or calm line does not blink away and back each time; cleared once it answers.
   */
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
 * - once `today` (the page's, kept current by its own clock) is past the end of a window whose
 *   answer on screen still runs to now, that question is read once more (`answerAwaitsFinalRead`),
 *   so its last day is shown whole. Only a custom window can get there: a preset's dates move with
 *   the day, so its question changes and is read anew. This follows the page's `today`, not a
 *   midnight timer of its own, so it cannot lose a race with the page's day turning.
 *
 * A null query reads nothing and clears the answer.
 */
export function useTeamPerformance(
  query: AgencyTeamPerformanceQuery | null,
  {
    tenantId,
    accountId,
    autoRefresh,
    today,
    settleMs = COMPARE_SETTLE_MS,
  }: { tenantId: string; accountId: string; autoRefresh: boolean; today: string; settleMs?: number },
): TeamPerformanceRead {
  const key = query ? JSON.stringify(query) : null;
  const askedKey = useSettledKey(key, settleMs);
  const read = useCompareRead(
    askedKey,
    (signal) => getTeamPerformance(JSON.parse(askedKey!) as AgencyTeamPerformanceQuery, tenantId, accountId, signal),
    askedKey !== key,
  );

  // The last failure of the question asked, held while that question is asked again and until it
  // answers or the question changes (derived each render, so it is the same however often React
  // renders).
  const held = useRef<{ key: string; error: unknown } | null>(null);
  if (read.status === 'error' && askedKey !== null && read.doneKey === askedKey) held.current = { key: askedKey, error: read.error };
  else if (read.status !== 'loading' || held.current?.key !== askedKey) held.current = null;
  const failure = held.current;
  const lastFailed = failure !== null;
  const stopped = lastFailed && !refreshMayFollow(failure.error);

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

  const current = read.data !== null && read.dataKey === key;

  // The window has ended under an answer that ran to now: read it once more, once per question
  // while the page is open, whatever that read answers. The answer can still run to then (the
  // server's 30 s cache), and a question asked again after another must not read twice more.
  const finalised = useRef(new Set<string>());
  const awaitsFinal = current && key === askedKey && answerAwaitsFinalRead(read.data!, today);
  useEffect(() => {
    if (!awaitsFinal || key === null || finalised.current.has(key)) return;
    finalised.current.add(key);
    retry();
  }, [awaitsFinal, key, retry]);

  const failedHere = lastFailed && askedKey === key;
  return {
    data: read.data,
    current,
    updating: !current && !failedHere && key !== null,
    error: failedHere ? failure.error : null,
    failed: failedHere && !current,
    refreshFailed: failedHere && current,
    refreshStopped: failedHere && stopped,
    retry,
  };
}
