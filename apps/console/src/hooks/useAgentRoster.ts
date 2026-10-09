import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { getAgencyRoster, type AgencyRosterQuery } from '../api/agencyStats';
import { windowRange, type AgentStatsWindow } from '../utils/agencyAgentPerformance';
import { allRowsHiddenReason, ROSTER_LIMIT } from '../utils/agencyAgentRoster';
import type { AgencyRosterOrder, AgencyRosterPage, AgencyRosterSort } from '../types/agency-stats';

/**
 * The whole floor over one window, ranked — the roster read.
 *
 * ── ONE request, and that is the reason this hook exists ───────────────────
 * `useAgentPerformance` fires three requests on purpose (three ranges, each
 * settling independently). This one fires exactly one, and the difference is not
 * a style choice: fanning `getAgentStats` out over a member list would be N
 * requests, and it still could not answer the question, because a rate is
 * unreadable without the cohort beside it and only the server can compute a
 * percentile over agents this client did not fetch. So the roster is one read
 * whose payload carries the rows AND the benchmark they are measured against.
 *
 * A corollary worth stating: **there is no per-period fan-out here.** The roster
 * is one window at a time, chosen by the reader. Three rosters side by side would
 * be three tables, not three tiles.
 *
 * ── Sorting is a REFETCH, not a client-side re-sort ────────────────────────
 * `sort` and `order` are threaded into `load`'s deps, so pressing a column header
 * issues a new request. That is required rather than merely consistent: `limit`
 * truncates the roster to the top N *of the chosen order*, so re-sorting the rows
 * already in hand would re-rank a page that was selected by a different question.
 * "Slowest handle time" over the hundred agents with the most successes is not the
 * answer to "slowest handle time" — and on a roster that fits under the limit it
 * would look right, which is how it would ship.
 *
 * ── Four distinct states, not a boolean and a maybe ────────────────────────
 * `loading`, `error`, `empty` and `ready` are separate arms of a union rather
 * than `{ data, loading, error }`. On this surface they are four different
 * screens and three of them are easy to conflate: "nobody dialled in this window"
 * (a true, ordinary answer), "we could not ask" (a failure with a retry), and "we
 * are still asking" all render as an empty table if the caller is left to derive
 * them from `rows.length === 0`. The `AgencyAnalyticsPage` family has shipped
 * that confusion twice (see its own notes on `stats={null}`), and a union is what
 * makes it unrepresentable.
 *
 * **`empty` means nothing to show AND nothing hidden.** It keyed on
 * `rows.length === 0` alone, which made an all-departed floor render three
 * sentences at once — see the note where it is decided. Rows-empty-with-rows-hidden
 * is a fifth screen the CALLER renders off `ready`, because the page it needs (the
 * former-members note and the toggle) is exactly the page `ready` carries.
 */

/** The read's four states. `empty` is a real, successful answer. */
export type RosterState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty'; page: AgencyRosterPage }
  | { status: 'ready'; page: AgencyRosterPage };

/**
 * Everything the reader can change, and therefore everything that refetches.
 *
 * All of it is threaded through `load`'s dependency list. A control whose value
 * is read at request time but not declared here is the classic version of this
 * bug: the filter moves, the table does not, and the screen shows the wrong rows
 * under the right controls.
 */
export interface AgentRosterFilters {
  /**
   * The window — the per-agent panel's three to-date periods, plus the two
   * COMPLETED ones the roster adds. See {@link AgentStatsWindow}: a weekly review
   * run on Monday morning cannot be run against a window that is ninety minutes
   * old.
   */
  period: AgentStatsWindow;
  /**
   * One campaign, `null` for every campaign in scope, or `undefined` for **not
   * chosen yet**.
   *
   * Three states rather than two, and the third is load-bearing. The roster's
   * default scope is the most recently active campaign, which the caller can only
   * work out once the campaign list has arrived — and until then there is no
   * question to ask. `undefined` therefore holds the read: firing with `null`
   * first would spend a request on the all-campaigns view, show its
   * mixed-lead-list warning for a frame, and replace it. `null` is a real choice
   * the reader can make and is sent as "no campaign filter".
   */
  campaignId: string | null | undefined;
  sort: AgencyRosterSort;
  order: AgencyRosterOrder;
  /**
   * Show agents who have since left the team.
   *
   * A server-side parameter, not a client filter. It changes which ROWS come back and
   * deliberately does **not** move the benchmark — see `AgencyRosterBenchmark`.
   */
  includeInactive: boolean;
}

export interface UseAgentRoster {
  state: RosterState;
  reload: () => void;
}

export function useAgentRoster(filters: AgentRosterFilters): UseAgentRoster {
  const { tenantId, accountId } = useTenant();
  const [state, setState] = useState<RosterState>({ status: 'loading' });

  /**
   * The in-flight generation, and whether there is anything to render into.
   *
   * Two guards rather than one, for the reasons `useAgentPerformance` and
   * `AgencyAnalyticsPage` both spell out at their own: the counter answers "is
   * this result still the newest?" — and it has to, because `reload` is also the
   * retry handler and `useEffect` only ever holds the cleanup of the call it made
   * itself, so a manual retry's `cancelled` flag can never be set — while the
   * mounted flag answers "is there still a component here?".
   *
   * The stale window is not hypothetical on this surface: every column header is
   * a refetch, and a supervisor comparing two orderings presses two of them
   * inside a second. Without the counter the slower response lands last and the
   * table is sorted by something other than the header that looks pressed.
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

  /*
    The filters as primitives, so `load`'s identity does not change on every
    render because the caller passed a fresh object literal — which is what every
    caller naturally does, and which would otherwise refetch the whole roster on
    each keystroke elsewhere on the page.
  */
  const { period, campaignId, sort, order, includeInactive } = filters;

  const load = useCallback(() => {
    /**
     * Both ids, for the reason every agency surface waits for both: `TenantContext`
     * resolves the account asynchronously, and a request sent in that window
     * carries no `X-Account-Id`, which the API answers with a 400 about a header this
     * client never sent.
     *
     * The account is a **required predicate** on this route rather than an
     * optional filter — a tenant-wide roster is a different question and must not
     * be reachable by omitting a parameter — so there is no degraded read to fall
     * back to here. The caller renders `AccountUnavailable` when resolution
     * settles without an account, which is what stops this early return from
     * becoming a permanent spinner.
     */
    if (!tenantId || !accountId) return;

    /*
      The scope has not been decided yet — the caller is still waiting for the
      campaign list that names the default. Holding here rather than reading the
      whole account is the point: see `AgentRosterFilters.campaignId`. The state
      stays `loading`, which is the truth, and the caller's own guard is what stops
      it becoming permanent.
    */
    if (campaignId === undefined) return;

    const mine = (generation.current += 1);
    const stale = () => generation.current !== mine || !mounted.current;

    setState({ status: 'loading' });

    /*
      One `now` for the range, read here rather than inside `periodRange` so a
      re-render cannot shift the window under a reader who did not touch a
      control — and so a retry asks the same question again rather than a slightly
      later one.
    */
    const query: AgencyRosterQuery = {
      ...windowRange(period, new Date()),
      sort,
      order,
      /*
        Explicit, and the contract's MAXIMUM. Sending none applied the API's default
        of 100, so a 180-agent agency silently lost 80 rows — and under
        `conversions desc` the eighty cut are the lowest converters, the exact
        population a supervisor opens this screen to find. There is no server-side
        paging in phase 01, so this is the only lever, and `truncationNote` plus
        the flag filter are what handle a floor larger than it.
      */
      limit: ROSTER_LIMIT,
      // Omitted rather than sent empty: the API whitelists this route's params and
      // answers an unknown or malformed one with a 400, so a blank `campaign_id`
      // would be a validation error about a filter nobody asked for.
      ...(campaignId ? { campaign_id: campaignId } : {}),
      ...(includeInactive ? { include_inactive: true } : {}),
    };

    getAgencyRoster(query, tenantId, accountId)
      .then((page) => {
        if (stale()) return;

        /**
         * The one shape check this hook makes, and it is here rather than in the
         * table for a reason.
         *
         * `rosterCountReadout` reads `page.benchmark.attempts` and the pinned team
         * row reads a dozen more fields off it, so a body without a `benchmark`
         * throws `TypeError` DURING RENDER — and there is no error boundary on this
         * surface, so the whole roster section disappears rather than degrading.
         * Every other absence on this payload degrades gracefully; that one is a
         * blank screen, which is the worst outcome available and the only one the
         * reader cannot act on.
         *
         * It is a realistic arrival rather than a hypothetical: the API forwards
         * the API's body through a spread, and phase 02 swaps the data source
         * underneath a console already built against this payload — a rollup that
         * produces rows without a cohort is exactly how this shows up. `error`
         * gives the reader a sentence and a retry, which is what a contract
         * violation deserves.
         *
         * Narrowed by `typeof` plus a null and array check rather than by trusting
         * the type: the type is a hand-mirrored claim about the wire, and this
         * branch exists precisely for the case where the wire disagrees with it.
         */
        const benchmark: unknown = page?.benchmark;
        if (
          !page ||
          !Array.isArray(page.rows) ||
          typeof benchmark !== 'object' ||
          benchmark === null ||
          Array.isArray(benchmark)
        ) {
          setState({
            status: 'error',
            message:
              'The roster came back without the team’s own figures, so there is nothing to ' +
              'read these numbers against.',
          });
          return;
        }

        /*
          `empty` is decided here, once, rather than by every consumer looking at
          `rows.length`. It is a successful answer — nobody dialled in this window
          — and the screen for it says so, which is not the screen for a failure
          and not the screen for a read still in flight.

          ── `empty` means nothing to show AND nothing HIDDEN ──────────────────
          It used to key on `rows.length === 0` alone, and `page` is bound for both
          `ready` and `empty`, so an all-departed floor rendered three sentences at
          once: "nobody was handed a call in this window", "2 former members
          hidden — they dialled in this window", and "2 agents dialled". That is an
          an ordinary server response, not a shape violation: the dialer runtime returns two
          revoked agents, the API filters both and answers `200 { rows: [],
          inactive_omitted: 2, total_agents: 2 }`. Rows-empty-with-rows-hidden is a
          third answer and the caller renders it as one — the former-members note
          and the toggle that reveals them, without the sentence saying nobody
          dialled.

          ── And `inactive_omitted` was only HALF the predicate ────────────────
          It keyed on that count alone, so `{ rows: [], unattributed_omitted: 3 }`
          — the API dropped three ids it could not attribute to any member (the third
          state) — took the `empty` arm and rendered "Nobody was handed a
          call in this window" directly beneath a readout saying three agents
          dialled. `allRowsHiddenReason` is the shared predicate over both counts,
          so the roster and the contribution screen cannot come to disagree about
          what an empty page means; see its docstring for why the two causes are
          not interchangeable.
        */
        setState(
          page.rows.length === 0 && allRowsHiddenReason(page) === null
            ? { status: 'empty', page }
            : { status: 'ready', page },
        );
      })
      .catch((err: unknown) => {
        if (stale()) return;
        setState({
          status: 'error',
          // The server's own sentence: these failures are mostly permission- or
          // connectivity-shaped and ours would be a guess.
          message: err instanceof Error ? err.message : 'Could not load the roster.',
        });
      });
  }, [tenantId, accountId, period, campaignId, sort, order, includeInactive]);

  useEffect(load, [load]);

  return useMemo(() => ({ state, reload: load }), [state, load]);
}
