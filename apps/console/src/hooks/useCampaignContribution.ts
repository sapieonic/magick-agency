import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { getAgencyGroupedStats, type AgencyGroupQuery } from '../api/agencyStats';
import { windowRange, type AgentStatsWindow } from '../utils/agencyAgentPerformance';
import { allRowsHiddenReason } from '../utils/agencyAgentRoster';
import {
  CONTRIBUTION_GROUP_BY,
  CONTRIBUTION_LIMIT,
  CONTRIBUTION_SORT,
  CONTRIBUTION_TOTAL_GROUP_BY,
} from '../utils/agencyCampaignContribution';
import type { AgencyGroupPage, AgencyGroupRow } from '../types/agency-stats';

/**
 * One campaign's numbers, and each agent's contribution to them.
 *
 * ── TWO reads, and neither is derivable from the other ────────────────────
 * The rows are grouped by `agent,campaign`; the campaign's own line is grouped by
 * `campaign` alone. The second is not a sum of the first and must not become one:
 * with `agent` grouped, master drops the rows of people who have since left the
 * team, so the rows add to less than the campaign did. Summing them would
 * redefine "the campaign's total" as "the total of the people still here" —
 * silently, in the one figure a supervisor would never think to doubt. The
 * difference between the two is the point of the screen, and
 * `contributionAsymmetryNote` is what says so.
 *
 * ── Settled TOGETHER rather than independently ────────────────────────────
 * `useAgentPerformance` fires three reads and lets each settle on its own, because
 * its three tiles are three independent answers. These two are one answer: the
 * Share column divides a row by the campaign line, and the asymmetry note compares
 * them, so a state where one has arrived and the other has not is a state with
 * nothing honest to say — and rendering the footer a beat after the rows would
 * flicker the very number the note is about. So they are `allSettled` and the
 * state is written once.
 *
 * The rows read is the one that decides the outcome: a failed CAMPAIGN LINE
 * degrades (the table renders, the Share column says what it is missing, and
 * `totalFailed` lets the caller say so), while a failed rows read is the screen
 * failing and gets an error with a retry. That asymmetry is deliberate — the rows
 * are what the reader came for.
 *
 * ── `include_inactive` goes on the ROWS read only ──────────────────────────
 * It is meaningless on the campaign line (nothing is dropped from a row that
 * belongs to no person), and because it is not sent there, the campaign line
 * cannot move when the reader toggles it. That is the same property the roster's
 * benchmark has and for the same reason: a figure that moved under a row filter
 * would be a different number under the same name. The cost is that toggling
 * re-reads a campaign line that cannot have changed — one request on an explicit
 * action, taken so that the two figures always come from one moment.
 *
 * ── Four states, not a boolean and a maybe ────────────────────────────────
 * The roster's union, for the roster's reasons: "nobody dialled this campaign in
 * this window" is a true, ordinary answer, "we could not ask" is a failure with a
 * retry, and "we are still asking" is neither — and all three render as an empty
 * table if the caller is left to derive them from `rows.length === 0`.
 *
 * **`empty` means nothing to show AND nothing hidden.** A campaign every one of
 * whose dialers has left the team is a fourth screen: it has rows to reveal, so it
 * is `ready` with an empty `rows` and a non-zero `inactive_omitted`, and the
 * caller renders the note and the toggle rather than "nobody dialled".
 */

/** The read's four states. `empty` is a real, successful answer. */
export type CampaignContributionState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | {
      status: 'empty';
      page: AgencyGroupPage;
      total: AgencyGroupRow | null;
      totalFailed: boolean;
    }
  | {
      status: 'ready';
      page: AgencyGroupPage;
      total: AgencyGroupRow | null;
      totalFailed: boolean;
    };

/**
 * Everything the reader can change, and therefore everything that refetches.
 *
 * All of it is threaded through `load`'s dependency list. A control read at
 * request time but not declared here is the classic version of this bug: the
 * filter moves, the table does not, and the screen shows the wrong rows under the
 * right controls.
 */
export interface CampaignContributionFilters {
  /**
   * ONE campaign, and it is required rather than nullable.
   *
   * The screen's premise: "who drove this campaign" has no answer pooled across an
   * account's campaigns, and a share of everything is not a contribution. The
   * caller therefore cannot mount this view without having chosen one — which is
   * a stronger guarantee than a runtime guard, and is why there is no
   * `campaign_id: null` path to get wrong here.
   */
  campaignId: string;
  /** The roster's windows, from the same `windowRange` — including the two completed ones. */
  period: AgentStatsWindow;
  /**
   * Show agents who have since left the team.
   *
   * Master's parameter, not core's, and meaningful only because `agent` is one of
   * the grouped dimensions. It changes which ROWS come back and deliberately does
   * not touch the campaign line.
   */
  includeInactive: boolean;
}

export interface UseCampaignContribution {
  state: CampaignContributionState;
  reload: () => void;
}

export function useCampaignContribution(
  filters: CampaignContributionFilters,
): UseCampaignContribution {
  const { tenantId, accountId } = useTenant();
  const [state, setState] = useState<CampaignContributionState>({ status: 'loading' });

  /**
   * The in-flight generation, and whether there is anything to render into.
   *
   * Two guards rather than one, exactly as `useAgentRoster` carries them: the
   * counter answers "is this result still the newest?" — and it has to, because
   * `reload` is also the retry handler and `useEffect` only ever holds the cleanup
   * of the call it made itself, so a manual retry's `cancelled` flag can never be
   * set — while the mounted flag answers "is there still a component here?".
   */
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    /*
      Set on the way IN as well as cleared on the way out. `React.StrictMode` runs
      every effect setup → cleanup → setup, so a cleanup-only effect leaves this
      `false` while the component is very much mounted — every response is then
      discarded as stale and the surface spins forever. A defect that exists only
      in development is still the build every reviewer sees.
    */
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /* The filters as primitives, so `load`'s identity does not change because the
     caller passed a fresh object literal — which is what every caller naturally
     does. */
  const { campaignId, period, includeInactive } = filters;

  const load = useCallback(() => {
    /*
      Both ids, for the reason every agency surface waits for both: `TenantContext`
      resolves the account asynchronously, and a request sent in that window carries
      no `X-Account-Id` — which master answers with `400 account_scope_required`
      before it even resolves the tenant's core key. The account is a REQUIRED
      predicate on this route rather than an optional filter, so there is no
      degraded read to fall back to; the caller's own guard is what stops this early
      return from becoming a permanent spinner.
    */
    if (!tenantId || !accountId) return;

    const mine = (generation.current += 1);
    const stale = () => generation.current !== mine || !mounted.current;

    setState({ status: 'loading' });

    /*
      One `now` for both reads, read here rather than inside `windowRange`, so the
      rows and the campaign line describe the same window to the millisecond — and
      so a retry asks the same question again rather than a slightly later one.
    */
    const range = windowRange(period, new Date());

    const rowsQuery: AgencyGroupQuery = {
      ...range,
      campaign_id: campaignId,
      group_by: CONTRIBUTION_GROUP_BY,
      sort: CONTRIBUTION_SORT,
      order: 'desc',
      limit: CONTRIBUTION_LIMIT,
      // Omitted rather than sent as `false`: master accepts only `true|false|1|0`
      // and 400s otherwise, and an explicit `false` is one more thing for the
      // whitelist to agree about for no gain.
      ...(includeInactive ? { include_inactive: true } : {}),
    };

    const totalQuery: AgencyGroupQuery = {
      ...range,
      campaign_id: campaignId,
      group_by: CONTRIBUTION_TOTAL_GROUP_BY,
      /*
        One row exists at most — one campaign filtered, grouped by campaign — so
        the limit is 1 and states that rather than leaving the route's default of
        200 to imply a page. No `include_inactive`: see the header.
      */
      limit: 1,
    };

    Promise.allSettled([
      getAgencyGroupedStats(rowsQuery, tenantId, accountId),
      getAgencyGroupedStats(totalQuery, tenantId, accountId),
    ])
      .then(([rowsOutcome, totalOutcome]) => {
        if (stale()) return;

        if (rowsOutcome.status === 'rejected') {
          const err: unknown = rowsOutcome.reason;
          setState({
            status: 'error',
            // The server's own sentence: these failures are mostly permission- or
            // connectivity-shaped and ours would be a guess.
            message:
              err instanceof Error ? err.message : 'Could not load this campaign’s contribution.',
          });
          return;
        }

        const page = rowsOutcome.value;
        /*
          The one shape check, narrowed by `Array.isArray` rather than by trusting
          the type — the type is a hand-mirrored claim about the wire and this
          branch exists precisely for the case where the wire disagrees. `rows` is
          mapped during render and `.map` of `undefined` takes the section down with
          no error boundary above it, which is the worst outcome available and the
          only one the reader cannot act on.
        */
        if (!page || !Array.isArray(page.rows)) {
          setState({
            status: 'error',
            message:
              'This campaign’s contribution came back in a shape this page does not ' +
              'understand, so there is nothing to show.',
          });
          return;
        }

        /*
          The campaign line degrades — but a MALFORMED one is a failure, not an
          absence.

          ── The distinction the previous shape lost ─────────────────────────
          `totalFailed` was `totalOutcome.status === 'rejected'`, so a fulfilled
          response whose body this page cannot read — no body at all, or `rows`
          not an array — produced `total: null` with `totalFailed: false`. The
          caller then said "no total to divide by", which is the sentence for a
          campaign that had no dials in the window: an ANSWER, and one a reader
          acts on by widening the window. The truth was that the read came back
          unusable and should be retried. A degrade path that reports a failure as
          a successful nothing is the same class of defect as a 200 claiming
          nothing was hidden.

          ── What stays an answer ────────────────────────────────────────────
          `rows: []` on a well-formed body. A campaign with no dials in the window
          has no group to return, so an empty array is the server correctly saying
          "nothing here" — `totalFailed` stays false and `total` is `null`. That is
          the one case this must NOT reclassify, which is why the array check is
          separate from the emptiness of it.
        */
        const totalPage = totalOutcome.status === 'fulfilled' ? totalOutcome.value : null;
        const totalUsable = Boolean(totalPage) && Array.isArray(totalPage?.rows);
        const total = totalUsable ? totalPage?.rows[0] ?? null : null;
        const totalFailed = !totalUsable;

        /*
          `empty` is decided here, once, rather than by every consumer looking at
          `rows.length`. Rows-empty-with-rows-hidden is a different screen — every
          agent who dialled this campaign has since left the team — and it is
          `ready`, because the page it needs is the one that carries the note and
          the toggle.
        */
        setState({
          status:
            page.rows.length === 0 && allRowsHiddenReason(page) === null ? 'empty' : 'ready',
          page,
          total,
          totalFailed,
        });
      })
      /*
        `allSettled` does not reject, so this is unreachable through a failed
        request — it is here for a throw inside the handler above, which would
        otherwise be an unhandled rejection and a surface stuck on its spinner.
      */
      .catch(() => {
        if (stale()) return;
        setState({
          status: 'error',
          message: 'Could not load this campaign’s contribution.',
        });
      });
  }, [tenantId, accountId, campaignId, period, includeInactive]);

  useEffect(load, [load]);

  return useMemo(() => ({ state, reload: load }), [state, load]);
}
