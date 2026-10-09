import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { getAgencyGroupedStats, type AgencyGroupQuery } from '../api/agencyStats';
import { windowRange, type AgentStatsWindow } from '../utils/agencyAgentPerformance';
import { BEST_HOURS_GROUP_BY } from '../utils/agencyBestHours';
import type { AgencyGroupPage } from '../types/agency-stats';

/**
 * One campaign's week, cut into weekday × hour — the best-hours read.
 *
 * ── ONE request, and the view is not part of it ───────────────────────────
 * `group_by=day_of_week,hour_of_day` is the route's two-dimension cap and 7 × 24 =
 * 168 rows fits under its default `limit` of 200, so the whole map is a single read.
 * The three views (connect rate, volume, conversion rate) are all on the payload
 * already, which is why `view` is **not** an input here: a view switch is a
 * re-render, and a hook that took it would refetch and let the three views disagree
 * about one campaign's week.
 *
 * That is not a micro-optimisation. Two reads a second apart straddle a dial, so a
 * reader flipping from "connect rate" to "volume" and back could watch the map
 * change under a control that is supposed to be re-colouring the same numbers.
 *
 * ── `campaign_id` is REQUIRED, and there is no pooled path to get wrong ────
 * Both time dimensions are spent, so `campaign` cannot also be grouped, and the
 * read's zone is unambiguous only because exactly one campaign is filtered.
 * Upstream answers a pooled read with `400 timezone_ambiguous` — and this hook must
 * never "handle" that by retrying in UTC: an Asia/Kolkata campaign's real connect
 * peak sits five and a half hours from where a UTC fallback would draw it, and the
 * only visible symptom is a rostering decision that is quietly wrong. So the
 * campaign is a required field rather than a nullable filter with a guard, exactly
 * as `useCampaignContribution` makes it.
 *
 * ── No `limit`, no `sort`, no `order` ─────────────────────────────────────
 * A matrix renders every cell, so no order is meaningful and the client offers no
 * sort. `limit` is left at the route's default: sending `limit=168` would be a magic
 * number describing this client's arithmetic, and it would silently truncate the map
 * the day a seventh `day_of_week` value appears. If the read is ever cut, that is a
 * fact the surface can state — see `total_groups` against the cells on screen.
 *
 * ── Four states, the roster's union ──────────────────────────────────────
 * "Nobody dialled this campaign in this window" is a true, ordinary answer; "we
 * could not ask" is a failure with a retry; "we are still asking" is neither. All
 * three render as an empty grid if the caller is left to derive them from
 * `rows.length === 0`.
 */

/** The read's four states. `empty` is a real, successful answer. */
export type BestHoursState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'empty'; page: AgencyGroupPage }
  | { status: 'ready'; page: AgencyGroupPage };

export interface BestHoursFilters {
  /**
   * ONE campaign, required. See the header: a pooled read is a 400 upstream, and
   * the caller only offers the way in with a campaign in scope.
   */
  campaignId: string;
  /** The roster's windows, from the same `windowRange` — including the two completed ones. */
  period: AgentStatsWindow;
}

export interface UseBestHours {
  state: BestHoursState;
  reload: () => void;
}

export function useBestHours(filters: BestHoursFilters): UseBestHours {
  const { tenantId, accountId } = useTenant();
  const [state, setState] = useState<BestHoursState>({ status: 'loading' });

  /**
   * The in-flight generation, and whether there is anything to render into.
   *
   * Two guards rather than one, exactly as `useCampaignContribution` and
   * `useAgentRoster` carry them: the counter answers "is this result still the
   * newest?" — and it has to, because `reload` is also the retry handler and
   * `useEffect` only ever holds the cleanup of the call it made itself — while the
   * mounted flag answers "is there still a component here?".
   */
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    /*
      Set on the way IN as well as cleared on the way out. `React.StrictMode` runs
      every effect setup → cleanup → setup, so a cleanup-only effect leaves this
      `false` while the component is very much mounted — every response is then
      discarded as stale and the surface spins forever.
    */
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /* The filters as primitives, so `load`'s identity does not change because the
     caller passed a fresh object literal — which is what every caller does. */
  const { campaignId, period } = filters;

  const load = useCallback(() => {
    /*
      Both ids, for the reason every agency surface waits for both: `TenantContext`
      resolves the account asynchronously, and a request sent in that window carries
      no `X-Account-Id` — which master answers with `400 account_scope_required`
      before it even resolves the tenant's core key. The account is a REQUIRED
      predicate on this route rather than an optional filter, so there is no
      degraded read to fall back to.
    */
    if (!tenantId || !accountId) return;

    const mine = (generation.current += 1);
    /*
      A blank campaign is REFUSED rather than sent. `groupQuery` drops a falsy
      `campaign_id` — correctly, because a cleared selector's empty string would
      otherwise read as a filter matching nothing — and dropping it here would turn
      this into the POOLED read, which upstream answers `400 timezone_ambiguous`
      because both time dimensions are grouped. E2 says the client must not send that
      request at all, so it does not: the state is unreachable through the caller (the
      entry button only appears with a campaign in scope, and this surface's selector
      has no "all campaigns" option), and this makes it a refusal rather than a
      pooled read if it ever becomes reachable.
    */
    if (campaignId.trim() === '') {
      setState({
        status: 'error',
        message:
          'This map is about one campaign, and no campaign is in scope — so there is ' +
          'nothing to read. Pick a campaign and try again.',
      });
      return;
    }
    const stale = () => generation.current !== mine || !mounted.current;

    setState({ status: 'loading' });

    const query: AgencyGroupQuery = {
      ...windowRange(period, new Date()),
      // Required, not optional — the read is a 400 without it.
      campaign_id: campaignId,
      group_by: BEST_HOURS_GROUP_BY,
      /*
        Nothing else. No `sort` and no `order` (every cell is rendered, so no order
        is meaningful and the surface offers none), and deliberately no `limit`: the
        route's default of 200 covers 168 cells, and a hard-coded 168 would be this
        client's arithmetic on the wire.
      */
    };

    getAgencyGroupedStats(query, tenantId, accountId)
      .then((page) => {
        if (stale()) return;
        /*
          The one shape check, narrowed by `Array.isArray` rather than by trusting
          the type — the type is a hand-mirrored claim about the wire and this branch
          exists precisely for the case where the wire disagrees. `rows` is walked
          during render and `.map` of `undefined` takes the section down with no
          error boundary above it, which is the worst outcome available and the only
          one the reader cannot act on.
        */
        if (!page || !Array.isArray(page.rows)) {
          setState({
            status: 'error',
            message:
              'This campaign’s hours came back in a shape this page does not ' +
              'understand, so there is nothing to show.',
          });
          return;
        }
        /*
          `empty` is decided here, once, rather than by every consumer looking at
          `rows.length`. Nothing is ever hidden from this read — no dimension is
          `agent`, so master has nobody to drop — which is why this union has three
          arms where the roster's has four.
        */
        setState({ status: page.rows.length === 0 ? 'empty' : 'ready', page });
      })
      .catch((error: unknown) => {
        if (stale()) return;
        setState({
          status: 'error',
          // The server's own sentence: these failures are mostly permission- or
          // connectivity-shaped and ours would be a guess. A `timezone_ambiguous`
          // 400 would arrive here too — and is NOT retried with a UTC fallback.
          message:
            error instanceof Error
              ? error.message
              : 'Could not load this campaign’s best hours.',
        });
      });
  }, [tenantId, accountId, campaignId, period]);

  useEffect(load, [load]);

  return useMemo(() => ({ state, reload: load }), [state, load]);
}
