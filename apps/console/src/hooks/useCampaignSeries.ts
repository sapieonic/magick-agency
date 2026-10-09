import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTenant } from '../contexts/TenantContext';
import { getAgencyCampaignSeries } from '../api/agencyCampaignSeries';
import {
  campaignLifespan,
  campaignSeriesRange,
  defaultCampaignSeriesWindow,
  type CampaignSeriesRange,
  type CampaignSeriesWindow,
} from '../utils/agencyCampaignSeries';
import type { AgencyCampaign } from '../types/agency-campaign';
import type { AgencyCampaignSeries } from '../types/agency-campaign-series';

/**
 * One campaign's day-by-day numbers, for the two charts on the workspace.
 *
 * ── The window is derived, never seeded into state by an effect ────────────
 * `defaultCampaignSeriesWindow` depends on the campaign, which loads
 * asynchronously — so the obvious shape (a `useState` seeded from it, plus an
 * effect that re-seeds when the campaign arrives) has the defect this repo has
 * hit twice: the effect runs after a render that already issued a request for
 * the wrong window, and it cannot tell a stale default from a choice the
 * supervisor made in the meantime, so it clobbers it.
 *
 * Instead the chosen window is `null` until somebody picks one, and the window
 * in force is `chosen ?? default`. There is no effect, nothing to clobber, and a
 * campaign that finishes loading simply changes the default under a supervisor
 * who has not expressed an opinion — which is the correct behaviour and is what
 * the effect was trying and failing to do.
 *
 * ── It does not poll ───────────────────────────────────────────────────────
 * The counters beside it poll every 10s because they are a live position. This
 * is a shape over days: re-drawing it every ten seconds would move nothing a
 * supervisor can see and would re-request up to 92 buckets to prove it. It
 * reloads when the window changes, and on {@link UseCampaignSeries.reload},
 * which `CampaignSeriesSection` drives from its `reloadToken` prop — bumped by
 * the page's Refresh control alongside the stats read, and deliberately not by
 * the poll.
 *
 * ── The range travels WITH the answer ──────────────────────────────────────
 * `range` in the returned state is the one the in-flight request was built
 * from, not one recomputed at render. The notes beside the chart ("today is
 * still in progress", "showing the most recent 92 days") describe the data on
 * screen, and a range recomputed from a fresh `new Date()` on every render can
 * describe a different one — across midnight, it does.
 */

export type CampaignSeriesState =
  | { status: 'idle' }
  | { status: 'loading' }
  | {
    status: 'ready';
    series: AgencyCampaignSeries;
    range: CampaignSeriesRange;
    /** A newer read is in flight; what is on screen is the previous one. */
    stale?: boolean;
  }
  | { status: 'error'; message: string };

export interface UseCampaignSeries {
  state: CampaignSeriesState;
  /** The window in force — the supervisor's choice, or the campaign's default. */
  window: CampaignSeriesWindow;
  setWindow: (next: CampaignSeriesWindow) => void;
  reload: () => void;
}

export function useCampaignSeries(
  campaignId: string | undefined,
  campaign: AgencyCampaign | null,
): UseCampaignSeries {
  const { tenantId, accountId } = useTenant();
  const [chosen, setChosen] = useState<CampaignSeriesWindow | null>(null);
  const [state, setState] = useState<CampaignSeriesState>({ status: 'idle' });
  const [nonce, setNonce] = useState(0);

  const window = chosen ?? defaultCampaignSeriesWindow(campaignLifespan(campaign));

  /*
    The two campaign fields the range depends on, as primitives. `campaign` is a
    fresh object on every poll of the page above (the stats read re-renders it),
    so depending on the object would re-request 92 buckets every ten seconds —
    the exact cost the "it does not poll" note above says this avoids.
  */
  const startedAt = campaign?.started_at ?? null;
  const endedAt = campaign?.ended_at ?? null;
  /*
    The STATUS travels too, and it is the field that decides whether the campaign
    has finished — `ended_at` is optional on the row and an API that predates
    the lifecycle timestamps does not send it.

    Carried as a boolean so the object handed to the pure function stays exactly
    what that function reads.

    Leaving it out of this object was a silent hole: `campaignSeriesRange` then
    saw a campaign with no status, concluded it was live, and set
    `partialToday` on EVERY campaign — so a range that ended weeks ago still
    carried "Today is still in progress, so its figures are partial." The pure
    function was correct and tested; the caller handed it two thirds of its
    input.
  */
  /*
    The DERIVED fact, not the raw status string.

    The range only ever asks whether the campaign has finished. Depending on the
    string re-ran the read on `running → paused`, `paused → running` and
    `running → stopping` — three transitions that do not move a single boundary —
    and Pause is the control a supervisor presses while watching this very page.
    `running → stopped` still changes both the default window and `partialToday`,
    and still re-reads.
  */
  const finished = campaignLifespan(campaign).finished === true;

  /** Both guards, for the reasons `useAgentPerformance` sets out at its own. */
  const generation = useRef(0);
  const mounted = useRef(true);
  useEffect(() => {
    // Set on the way IN as well as cleared on the way out: StrictMode runs every
    // effect setup → cleanup → setup, and a cleanup-only flag leaves this false
    // while the component is very much mounted, which spins forever in dev.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const load = useCallback(() => {
    /*
      Both ids, for the reason every agency surface waits for both: a request
      sent before `TenantContext` resolves carries no `X-Account-Id`, which the API
      answers with a 400 about a header this client never sent. The caller
      renders `AccountUnavailable` when resolution settles with no account, so
      this can never become a permanent spinner.
    */
    if (!campaignId || !tenantId || !accountId) return;

    const mine = (generation.current += 1);
    const stale = () => generation.current !== mine || !mounted.current;

    // One `now`, read here and kept: the range that goes on the wire is the one
    // the notes beside the chart will describe. See the module note.
    const range = campaignSeriesRange(
      window,
      { started_at: startedAt, ended_at: endedAt, finished },
      new Date(),
    );

    /*
      A REFETCH keeps whatever is already on screen. Dropping straight to
      `loading` unmounted the chart in favour of a skeleton for the length of a
      network round-trip — on a section whose own note says it avoids churn, and
      at the moment a supervisor presses Refresh or changes the range. The
      counters beside it already work this way.

      Only the FIRST load of a section shows the skeleton, because there is
      genuinely nothing behind it yet.
    */
    setState((prev) => (prev.status === 'ready' ? { ...prev, stale: true } : { status: 'loading' }));
    getAgencyCampaignSeries(
      campaignId,
      { from: range.from, to: range.to, bucket: 'day' },
      tenantId,
      accountId,
    )
      .then((series) => {
        if (stale()) return;
        setState({ status: 'ready', series, range });
      })
      .catch((err: unknown) => {
        if (stale()) return;
        setState({
          status: 'error',
          // The server's own sentence: a failure here is permission- or
          // connectivity-shaped, and ours would be a guess. An API that
          // predates the route answers 404, and that message is the truthful
          // one to show — this console cannot tell it from a typo'd id.
          message: err instanceof Error ? err.message : 'Could not load the day-by-day figures.',
        });
      });
  }, [campaignId, tenantId, accountId, window, startedAt, endedAt, finished, nonce]);

  useEffect(load, [load]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  return useMemo(
    () => ({ state, window, setWindow: setChosen, reload }),
    [state, window, reload],
  );
}
