import { useEffect, useRef } from 'react';
import {
  TEAM_PERFORMANCE_CACHE_TTL_MS,
  type AgencyTeamPerformance,
  type AgencyTeamPerformanceQuery,
} from '@magick-agency/contracts/api/agency/team-performance';
import { getTeamPerformance, teamErrors } from '../api/teamPerformance';
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
  return teamErrors.isRetryable(error) && teamErrors.code(error) !== 'team_timed_out';
}

/**
 * The answer was worked out less than the server's cache life ago (`as_of`), so asking the same
 * question again now would get the same answer back. A clock behind the server's counts as not.
 */
function withinCache(data: AgencyTeamPerformance, nowMs: number): boolean {
  const age = nowMs - Date.parse(data.as_of);
  return age >= 0 && age < TEAM_PERFORMANCE_CACHE_TTL_MS;
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
 *   is visible, and when the reader comes back to it unless the answer on screen is younger than
 *   the server's cache ({@link withinCache}). Those reads keep the answer up quietly (no
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

  // The last failure of the question asked: `useCompareRead` keeps it while the same question is
  // asked again, until it answers or the question changes.
  const failure = read.doneKey === askedKey ? read.error : null;
  const stopped = failure !== null && !refreshMayFollow(failure);
  const current = read.data !== null && read.dataKey === key;

  // A refresh never stacks on a read in flight (it would cancel it and start the same read again),
  // and never follows a failure it may not (refreshMayFollow). Both hooks read it through a ref,
  // so this render's closure is the one called.
  const { retry } = read;
  const on = autoRefresh && askedKey !== null;
  const refresh = () => {
    if (on && read.status !== 'loading' && !stopped) retry();
  };
  useVisibleInterval(refresh, TEAM_REFRESH_MS, on);
  // Coming back to an answer younger than the server's cache would be answered from it: nothing
  // new to show, so only the minute's refresh reads it again.
  useRefetchOnReturn(() => {
    if (!(current && withinCache(read.data!, Date.now()))) refresh();
  });

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

  const failedHere = failure !== null && askedKey === key;
  return {
    data: read.data,
    current,
    updating: !current && !failedHere && key !== null,
    error: failedHere ? failure : null,
    failed: failedHere && !current,
    refreshFailed: failedHere && current,
    refreshStopped: stopped && askedKey === key,
    retry,
  };
}
