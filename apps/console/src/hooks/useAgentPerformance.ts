import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { getAgentStats, getMyStats, type AgencyStatsQuery } from '../api/agencyStats';
import {
  AGENT_STATS_WINDOWS,
  windowRange,
  type AgentStatsWindow,
} from '../utils/agencyAgentPerformance';
import type { AgencyAgentStats } from '../types/agency-stats';

/**
 * One agent's figures for each window the caller asks for, fetched together.
 *
 * ── Whose numbers, decided by a discriminated subject ──────────────────────
 * `{ kind: 'me' }` reads `GET /agency/my-stats`, which is floored so a bare
 * `agent` can call it and is scoped to the caller **server-side**.
 * `{ kind: 'agent', userId }` reads the supervisor twin, floored at
 * `agency.supervise`. A union rather than an optional `userId` on one call: an
 * optional subject is a subject a caller can supply by accident, and the whole
 * point of the paired routes is that an agent cannot form a request for somebody
 * else's shift. Callers of the `agent` form **must** gate on
 * `hasPermission(role, 'agency.supervise')` — master's exact floor.
 *
 * ── One request per window, not one summed locally ─────────────────────────
 * Day buckets are cut in each campaign's own timezone, so a client that summed a
 * month of buckets into "today" would produce a today belonging to a campaign's
 * clock. Every range is defined by the server; see `windowRange`.
 *
 * ── Each window settles independently ──────────────────────────────────────
 * `Promise.all` here would let one failed range blank all of them, on a page
 * whose whole purpose is telling somebody how their shift went. So each window
 * holds its own state and its own message — the same reasoning
 * `AgencyAnalyticsPage` applies to its per-campaign stats reads, and the same
 * conclusion.
 *
 * ── The caller chooses which windows, and that is why this is a Partial ────
 * It used to be a total `Record` over the three to-date periods, which is what
 * made "the panel shows three tiles" a fact about the TYPE rather than about the
 * layout — and so the reason an agent could not ask what they did last month.
 * `windows` defaults to all five; a caller wanting fewer passes fewer, and reads
 * back only the keys it asked for. Indexing a window that was not requested
 * gives `undefined`, which the panel already renders as its own state.
 *
 * Callers do NOT have to pass a stable array. The load effect depends on the
 * window list's CONTENTS (`windows.join()`), not on its identity, so an inline
 * literal is safe. That is deliberate: the natural way to ask for two windows is
 * `useAgentPerformance(subject, scope, ['today', 'week'])`, and under an
 * identity dependency that is an infinite refetch loop — two requests per render,
 * forever — which typechecks, reviews clean, and cannot be caught by any test
 * that does not pass the prop. A documented "callers must remember" was the only
 * thing standing between this API and that bug; keying on contents removes the
 * need to remember.
 *
 * What a caller DOES have to do is render the same list it asked for. The hook
 * returns `windows` for that purpose; pass it to `AgentPerformancePanel` rather
 * than letting the panel default separately. See {@link UseAgentPerformance}.
 */

export type AgentPerformanceSubject = { kind: 'me' } | { kind: 'agent'; userId: string };

export type PeriodState =
  | { status: 'loading' }
  | { status: 'ready'; stats: AgencyAgentStats }
  | { status: 'error'; message: string };

export type PeriodStates = Partial<Record<AgentStatsWindow, PeriodState>>;

/** Every requested window, at `loading`. Built per call — the key set varies. */
function loadingFor(windows: readonly AgentStatsWindow[]): PeriodStates {
  const states: PeriodStates = {};
  for (const window of windows) states[window] = { status: 'loading' };
  return states;
}

export interface UseAgentPerformance {
  periods: PeriodStates;
  reload: () => void;
  /**
   * The windows this hook actually asked for, to be handed straight to
   * `AgentPerformancePanel`'s `windows` prop.
   *
   * It is returned rather than left to the caller because the panel and this
   * hook each used to default to `AGENT_STATS_WINDOWS` INDEPENDENTLY, with
   * nothing tying them together. Two defaults that agree today are not a
   * contract: give the panel a window the hook was not asked for and its tile
   * reads `periods[window] ?? { status: 'loading' }` and spins forever; ask the
   * hook for one the panel does not render and the request is made for nothing.
   * The `?? loading` is a crash guard, not an agreement.
   *
   * Identity is stable across renders for equal contents, so a caller may pass
   * an inline literal in and hand this straight back out.
   */
  windows: readonly AgentStatsWindow[];
}

/**
 * One campaign's id to scope every period to, or `null` for the whole record.
 *
 * `by_campaign[]` and `buckets[]` are two foldings of one row set, so the payload
 * answers "which campaigns" and "which days" but never "which days ON this
 * campaign" — the cross-tab is a third folding and no response carries it. Core's
 * stats query has always accepted `campaign_id` (`parseAgentStatsQuery`) and
 * master forwards it (`AGENT_STATS_QUERY_PARAMS`); scoping the request is
 * therefore how that combination is asked for, and re-folding it in the client
 * is not — a client that summed a campaign's days out of a cross-campaign bucket
 * could not, because a bucket carries no campaign.
 *
 * Threaded through `load`'s deps so a change re-reads every window. It has to be
 * every one: the tiles sit side by side, and leaving some cross-campaign while
 * another is scoped would put different questions under one heading.
 */
export type AgentPerformanceScope = string | null;

export function useAgentPerformance(
  subject: AgentPerformanceSubject,
  campaignId: AgentPerformanceScope = null,
  windows: readonly AgentStatsWindow[] = AGENT_STATS_WINDOWS,
): UseAgentPerformance {
  const { tenantId, accountId } = useTenant();
  const [periods, setPeriods] = useState<PeriodStates>(() => loadingFor(windows));
  /** Content identity for the window list — see the dependency note on `load`. */
  const windowsKey = windows.join(',');

  /**
   * The in-flight generation, and whether there is anything to render into.
   *
   * Two guards rather than one, for the reasons `AgencyAnalyticsPage` spells out
   * at its own: the counter answers "is this result still the newest?" (a manual
   * reload's cleanup is never handed to `useEffect`, so its `cancelled` flag can
   * never be set), and the mounted flag answers "is there still a component
   * here?" — a navigate-away shortly after a reload otherwise leaves a chain that
   * still calls `setState`.
   *
   * The mounted flag is SET on mount as well as cleared on unmount, in that
   * order and both explicitly. See the effect below: the setup half is the whole
   * difference between a working page and one that never leaves its spinner in
   * development.
   */
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    /*
      Set on the way IN as well as cleared on the way out. `React.StrictMode`
      (which `main.tsx` wraps the whole app in) runs every effect setup →
      cleanup → setup in development, so a cleanup-only effect leaves this
      `false` while the component is very much mounted — every response is then
      discarded as stale and the surface spins forever. A defect that exists
      only in development is still a defect: it is the build every reviewer and
      every developer sees.
    */
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * The subject as two primitives, so `load`'s identity does not change on every
   * render just because the caller passed a fresh object literal — which is what
   * every caller naturally does, and which would otherwise re-fetch every range
   * on each keystroke elsewhere on the page.
   *
   * Two values rather than one encoded string: a `\`agent:${id}\`` key has to be
   * taken apart again at the call, and an id that happened to contain the
   * separator would silently address the wrong person.
   */
  const subjectKind = subject.kind;
  const subjectUserId = subject.kind === 'agent' ? subject.userId : null;

  const load = useCallback(() => {
    /**
     * Both ids, for the reason every agency surface waits for both: `TenantContext`
     * resolves the account asynchronously, and a request sent in that window
     * carries no `X-Account-Id`, which core answers with a 400 about a header this
     * client never sent — an error with nothing to do with the data being asked
     * for. The caller renders `AccountUnavailable` when resolution settles without
     * an account, so this early return can never become a permanent spinner.
     */
    if (!tenantId || !accountId) return;

    const mine = (generation.current += 1);
    const stale = () => generation.current !== mine || !mounted.current;

    setPeriods(loadingFor(windows));
    /**
     * One `now` for every range. Read once rather than per window so the `to`
     * values are the same instant — otherwise "today" and "this month" can end
     * milliseconds apart and a call landing between them appears in one and not
     * the other, which is a discrepancy nobody can explain. It matters more now
     * that completed windows are in the set: `last_week`'s `to` and `week`'s
     * `from` are both the start of this week, and two `now`s either duplicate a
     * dial across the pair or lose it between them.
     */
    const now = new Date();

    for (const period of windows) {
      const query: AgencyStatsQuery = {
        ...windowRange(period, now),
        bucket: 'day',
        // Omitted rather than sent as null: master forwards only the params it
        // finds, and an empty `campaign_id` reaching core is a validation issue
        // about a filter nobody asked for.
        ...(campaignId ? { campaign_id: campaignId } : {}),
      };
      const request =
        subjectKind === 'me' || subjectUserId === null
          ? getMyStats(query, tenantId, accountId)
          : getAgentStats(subjectUserId, query, tenantId, accountId);

      request
        .then((stats) => {
          if (stale()) return;
          setPeriods((prev) => ({ ...prev, [period]: { status: 'ready', stats } }));
        })
        .catch((err: unknown) => {
          if (stale()) return;
          setPeriods((prev) => ({
            ...prev,
            [period]: {
              status: 'error',
              // The server's own sentence: these failures are mostly
              // permission- or connectivity-shaped and ours would be a guess.
              message: err instanceof Error ? err.message : 'Could not load these numbers.',
            },
          }));
        });
    }
    // `windowsKey`, not `windows`: the effect depends on WHICH windows were asked
    // for, and a caller passing an inline literal must not mean a new dependency
    // on every render. See the note on `windows` above.
  }, [tenantId, accountId, subjectKind, subjectUserId, campaignId, windowsKey]);

  useEffect(load, [load]);

  /*
   * Keyed on contents, like `load` itself — so a caller passing a fresh literal
   * gets one stable array back rather than a new identity every render.
   */
  const stableWindows = useMemo(() => windows, [windowsKey]);

  return useMemo(
    () => ({ periods, reload: load, windows: stableWindows }),
    [periods, load, stableWindows],
  );
}
