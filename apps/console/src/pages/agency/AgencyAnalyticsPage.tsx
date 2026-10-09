import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChartNoAxesCombined, Plus } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { listAgencyCampaigns, getAgencyCampaignStats } from '../../api/agencyCampaigns';
import { hasPermission } from '../../utils/permissions';
import { EmptyState } from '../../components/common/EmptyState';
import { ErrorAlert } from '../../components/common/ErrorAlert';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { PageDescription } from '../../components/common/PageDescription';
import { mapWithConcurrency } from '../../utils/concurrency';
import { CampaignHealthStrip } from '../../components/agency/CampaignHealthStrip';
import { CampaignPerformance } from '../../components/agency/CampaignPerformance';
import { AgentAnalyticsSection } from '../../components/agency/AgentAnalyticsSection';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
import type { AgencyCampaign, AgencyCampaignStats } from '../../types/agency-campaign';
import styles from './AgencyAnalyticsPage.module.css';

/**
 * The supervisor's numbers — every campaign on one screen, and any one person on
 * another. The other half of the workspace, beside campaign setup.
 *
 * ── Why this exists, and why the sidebar's old note is now spent ────────────
 * `AgencySidebar` used to carry a comment explaining that the Supervisor
 * Dashboard was "deliberately absent rather than present-and-empty", because
 * the API's stats payload produced no `pacing_state`, `stall_reason`, per-agent rows
 * or connect split — and "a health strip with no diagnosis in it is worse than no
 * health strip: it reads as *nothing wrong* when the truth is *nothing measured*".
 *
 * That reasoning was right and its premise has since expired. All four arrived,
 * and the campaign DETAIL page already renders them (`CampaignHealthStrip`,
 * `CampaignPerformance`, `AgentFloor`). So the remaining gap was never the data —
 * it was that a supervisor watching four campaigns had to visit four URLs to find
 * out which one was in trouble.
 *
 * ── The N round trips, stated rather than hidden ────────────────────────────
 * Stats are per-campaign (`GET /campaigns/:id/stats`), so this page costs one
 * request per campaign and there is no batch route to use instead. The campaign
 * LIST deliberately does not pay that (its own comment: "firing N of them to
 * decorate a list would be N round trips for numbers nobody reads at this
 * level") — and the difference is the point of this page rather than an
 * inconsistency: here the numbers ARE what the reader came for.
 *
 * They are fetched concurrently, and each independently: `allSettled`, not `all`.
 * One campaign whose stats read fails — the API deleted it, a 500, a timeout — annotates
 * its own card and leaves every other campaign's figures on screen. With `all`,
 * the first failure would blank the whole page, which for a page a supervisor
 * opens *because* something looks wrong is the worst possible failure mode.
 *
 * ── The second tab: the floor, then one person ─────────────────────────────
 * This page used to be campaign-only, and this docstring used to say so. It no
 * longer is: the server now serves per-agent history (`GET /agency/agents/:userId/
 * stats`, the supervisor twin of the route an agent reads about themselves), and
 * a supervisor's second question after "which campaign needs me" is "which
 * person". Before this there was nowhere in the product to ask it — the attempts
 * spine could be filtered by agent, but a filtered list of dials is not a
 * measurement, and the campaign figures aggregate exactly the dimension the
 * question is about.
 *
 * The tab opened with a dropdown of colleagues at first, and that was the wrong
 * shape twice over: it answered "show me Ravi" when the question a supervisor
 * arrives with is "who should I be asking about", and it showed one person's rate
 * with nothing to read it against. It now opens on a ranked ROSTER
 * (`GET /agency/agents/stats`, one request carrying the cohort's percentiles on
 * the same payload) and a row drills into the per-agent panels that were already
 * there. See `AgentAnalyticsSection`.
 *
 * It is a TAB rather than a section stacked below the campaigns, and that is
 * about cost rather than layout: the campaign tab already pays one `/stats`
 * request per campaign, and mounting the roster underneath it would add another
 * to every page view, for a surface most visits do not scroll to. A tab mounts
 * when it is chosen.
 *
 * Gated on `hasPermission(role, 'agency.supervise')` — the server's exact floor on
 * both twins. Anything looser renders a tab whose first read 403s; anything
 * tighter hides it from an `account_admin` who holds it.
 *
 * ── What is deliberately NOT here ──────────────────────────────────────────
 * No `AgentFloor`. The floor is a live per-agent table with force-available
 * controls on it, and it belongs where a supervisor has one campaign's context in
 * front of them; stacking four of them would be four polling tables competing for
 * the same screen. This page answers "which campaign needs me", and the campaign
 * name links to the page that answers "what do I do about it".
 *
 * **The per-agent tab is not that reasoning being reversed.** Live floor state
 * and historical per-agent numbers are different things: the floor is a polling
 * table of who is on a call *right now* with an intervention control on each row,
 * and the tab is a settled record of one named person's week with no controls at
 * all. Neither can substitute for the other, and the note above stays true.
 */

/** Per-campaign stats: resolved, still loading, or failed on its own. */
type StatsState =
  | { status: 'loading' }
  | { status: 'ready'; stats: AgencyCampaignStats }
  | { status: 'error' };

/**
 * The statuses whose health strip means anything.
 *
 * The strip diagnoses a LIVE campaign — pacing stalls, concurrency ceilings, a
 * 24-hour abandonment rate against its limit. On a `draft` or `stopped` campaign
 * every one of those is either absent or frozen at whatever it was when dialing
 * ended, and rendering it anyway would show a supervisor a clean bill of health
 * for a campaign that is simply not running. Performance figures below it are
 * historical and do stay meaningful, so those render for every campaign.
 */
const LIVE_STATUSES: ReadonlySet<string> = new Set(['running', 'paused', 'stopping']);

/** The two questions this page answers. */
type AnalyticsTab = 'campaigns' | 'agents';

export function AgencyAnalyticsPage() {
  const { tenantId, accountId, role } = useTenant();
  const [campaigns, setCampaigns] = useState<AgencyCampaign[] | null>(null);
  const [stats, setStats] = useState<Record<string, StatsState>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /**
   * Which half of the page is on screen.
   *
   * Component state rather than a URL param: `SAUsagePage`'s rule is that view
   * state worth sharing belongs in the URL, and this is one control with two
   * values on a page whose campaign half is the default for everybody. A param
   * for it would restore half a view, which that page's own comment calls worse
   * than none.
   */
  const [tab, setTab] = useState<AnalyticsTab>('campaigns');

  /**
   * The in-flight generation. Incremented by every `load()`, so a result can ask
   * "am I still the newest?" before writing state.
   *
   * A per-call `cancelled` closure is not enough on its own here, because `load`
   * is ALSO the retry handler (`onRetry={load}`) and `useEffect` only ever holds
   * the cleanup of the call it made itself — a manual retry's cleanup is
   * discarded, so its `cancelled` flag could never be set. Without the counter, a
   * slow retry could land after a newer load and overwrite fresher data, or write
   * to an unmounted component.
   */
  const generation = useRef(0);

  /**
   * False once this component has unmounted.
   *
   * The generation counter above prevents a stale load from OVERWRITING a newer
   * one's results; it does not prevent a resolved promise writing into an unmounted
   * component, because nothing bumps it on unmount — and `load` is also the retry
   * handler, whose cleanup `useEffect` never receives. So a navigate-away shortly
   * after pressing Retry left a chain that still called `setState` (raised in review).
   *
   * Two guards rather than one because they answer different questions: "is this
   * result still the newest?" and "is there still anything to render into?".
   *
   * Set on mount as well as cleared on unmount. `React.StrictMode` runs every
   * effect setup → cleanup → setup, so a cleanup-only effect leaves this `false`
   * for the life of the page and every campaign read is thrown away — a
   * permanent spinner in development, and only in development.
   */
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

  const load = useCallback(() => {
    /**
     * No account to scope the reads to. `loading` MUST be cleared here: the render
     * below shows a spinner while `loading && campaigns === null`, and
     * `accountResolution` can settle at `ready`/`degraded`/`error` with
     * `accountId === null` (a tenant with no accounts, or a narrowed fallback that
     * came back empty) with nothing firing again. Returning early without this is
     * how the previous revision spun forever — the same defect `AgentHomePage` and
     * `RequireFlag` both carry explicit guards against.
     */
    if (!tenantId || !accountId) {
      setLoading(false);
      /**
       * Cleared, not merely left alone. Without this, whatever the previous context
       * loaded stays on screen — so a tenant/account that resolves to nothing would
       * show the LAST account's campaigns and figures, which is worse than an empty
       * page because it looks like data about the account you are now in.
       *
       * Unreachable through `AgencyLayout` today, which renders no `Outlet` at all
       * without an account and keys it by `accountId` so a switch remounts this
       * page. That makes this defensive — but the correctness of a page should not
       * rest on a parent's gate, and the cost here is three setState calls on a path
       * that renders nothing.
       */
      setCampaigns(null);
      setStats({});
      setError(null);
      return undefined;
    }

    const mine = (generation.current += 1);
    const isStale = () => generation.current !== mine;
    let cancelled = false;
    setLoading(true);
    setError(null);

    listAgencyCampaigns(tenantId, accountId)
      .then(async (rows) => {
        if (cancelled || isStale() || !mounted.current) return;
        setCampaigns(rows);
        setStats(Object.fromEntries(rows.map((c) => [c.id, { status: 'loading' } as StatsState])));

        /**
         * Settled per campaign and CAPPED — see `mapWithConcurrency`. One
         * campaign's failure must annotate its own card and leave its siblings'
         * figures on screen; and `listAgencyCampaigns` is unpaginated, so the
         * length of this list is a property of the account's history rather than
         * of the screen. An account with three hundred lifetime campaigns used to
         * open three hundred simultaneous requests here.
         */
        const settled = await mapWithConcurrency(rows, (c) =>
          getAgencyCampaignStats(c.id, tenantId, accountId),
        );
        if (cancelled || isStale() || !mounted.current) return;
        setStats(
          Object.fromEntries(
            rows.map((c, i) => {
              const outcome = settled[i]!;
              return [
                c.id,
                outcome.status === 'fulfilled'
                  ? ({ status: 'ready', stats: outcome.value } as StatsState)
                  : ({ status: 'error' } as StatsState),
              ];
            }),
          ),
        );
      })
      .catch((err: unknown) => {
        if (cancelled || isStale() || !mounted.current) return;
        // Only the campaign LIST failing reaches here, and that one genuinely is
        // the whole page: with no campaigns there is nothing to show stats for.
        setError(err instanceof Error ? err.message : 'Could not load campaigns.');
      })
      .finally(() => {
        if (!cancelled && !isStale() && mounted.current) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tenantId, accountId]);

  useEffect(load, [load]);

  const canCreate = hasPermission(role, 'agency.campaigns.write');
  /**
   * **Must be `agency.supervise` and nothing else.** It is the exact permission
   * the server floors `GET /agency/agents/:userId/{stats,attempts}` on. A looser gate
   * (say `agency.campaigns.read`, which is what the campaign half of this page
   * needs) renders a tab whose first read 403s for a `viewer`; a tighter one
   * hides it from an `account_admin`, the very role the permission floors at.
   */
  const canSupervise = hasPermission(role, 'agency.supervise');

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Analytics</h1>
        {/*
          Only rendered for someone who holds the permission the agent reads are
          floored on — a tab that 403s on its first click is worse than no tab,
          because it reads as a broken product rather than an absent one.
        */}
        {canSupervise && (
          <div className={styles.tabs} role="tablist" aria-label="Analytics view">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'campaigns'}
              aria-controls="agency-analytics-view"
              className={styles.tab}
              data-selected={tab === 'campaigns' ? 'true' : 'false'}
              onClick={() => setTab('campaigns')}
            >
              By campaign
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'agents'}
              aria-controls="agency-analytics-view"
              className={styles.tab}
              data-selected={tab === 'agents' ? 'true' : 'false'}
              data-testid="tab-agents"
              onClick={() => setTab('agents')}
            >
              By agent
            </button>
          </div>
        )}
      </div>

      <PageDescription
        pageKey="agency-analytics"
        description={
          'Every campaign’s numbers side by side, so you can see which one needs you without opening each in turn.\n' +
          'Health warnings appear only for campaigns that are running, paused or stopping — a campaign that isn’t dialing has nothing to diagnose.'
        }
        tips={[
          'Open a campaign’s name for its contacts, attempts and the agents currently on it.',
          'Connect rate, handle time and wrap-up are derived figures — each can be legitimately absent when a campaign has not produced enough calls to divide by.',
        ]}
      />

      {error && <ErrorAlert message={error} onRetry={load} />}

      {/*
        The agent tab renders INSTEAD of the campaign list rather than beside it.
        The campaign half costs one `/stats` request per campaign and the agent
        half one roster read (plus three more once a row is opened); showing both
        at once would pay for a surface the reader is not looking at.

        The campaign LIST itself is still fetched either way — it is what resolves
        the campaign ids in the per-agent breakdown into names, and it is one
        request the page has already made.
      */}
      <div id="agency-analytics-view" role="tabpanel" className={styles.view}>
        {tab === 'agents' ? (
          <AgentAnalyticsSection
            canSupervise={canSupervise}
            /*
              The list itself, not a name map derived from it. The roster needs each
              campaign's `status` to decide which one to OPEN on — a name map cannot
              say which campaign is dialing — and the section derives its own name
              map from this one list, so the filter, the drill-down's id resolution
              and the default scope cannot disagree about which campaigns exist.

              `null` means "not answered yet" and holds the roster read rather than
              spending it on every campaign in the account. A FAILED list read
              resolves to `[]` instead: the section then defaults to "every
              campaign" and says so, where `null` would leave a spinner that nothing
              clears — the same trap this page carries three other guards against,
              and the `ErrorAlert` above already explains the failure.
            */
            campaigns={campaigns ?? (error !== null ? [] : null)}
          />
        ) : (
          <>
          {loading && campaigns === null && <LoadingSpinner />}

          {campaigns !== null && campaigns.length === 0 && (
            <EmptyState
              icon={<ChartNoAxesCombined size={28} />}
              title="No campaigns yet"
              description="Numbers appear here once a campaign exists and has started dialing."
              action={
                canCreate ? (
                  <Link to="/agency/campaigns/new" className="btn-primary">
                    <Plus size={16} />
                    New campaign
                  </Link>
                ) : undefined
              }
            />
          )}

          {campaigns !== null && campaigns.length > 0 && (
            <div className={styles.list}>
              {campaigns.map((campaign) => {
                const state = stats[campaign.id] ?? { status: 'loading' as const };
                const resolved = state.status === 'ready' ? state.stats : null;

                return (
                  <section key={campaign.id} className={styles.campaign}>
                    <div className={styles.campaignHeader}>
                      <div className={styles.campaignName}>
                        <Link to={`/agency/campaigns/${campaign.id}`} className={styles.campaignLink}>
                          {campaign.name}
                        </Link>
                        <AgencyCampaignStatusBadge status={campaign.status} />
                      </div>
                    </div>

                    {/*
                      `stats={null}` is what both components already take for "the
                      first load is in flight, or the read failed", so a loading and a
                      failed campaign render their own absent-value handling rather
                      than anything invented here. The note below says which of the
                      two it was, because "not measured yet" and "we could not ask"
                      are different facts.
                    */}
                    {LIVE_STATUSES.has(campaign.status) && (
                      <CampaignHealthStrip
                        stats={resolved}
                        mode="diagnosis"
                        campaignId={campaign.id}
                        campaignStatus={campaign.status}
                        /*
                          The role this page already holds. Omitting it renders
                          NEITHER remediation link — `hasPermission(undefined, …)`
                          is false by design — and this strip appears only for
                          LIVE campaigns, which is exactly when a supervisor
                          wants "Open the floor". Failing closed is the right
                          default for a caller that cannot establish the role;
                          this one can.
                        */
                        role={role}
                      />
                    )}

                    <CampaignPerformance stats={resolved} wrapupSeconds={campaign.wrapup_seconds} />

                    {state.status === 'error' && (
                      <p className={styles.statsError}>
                        We couldn’t load this campaign’s numbers. Its setup and contacts are
                        unaffected — open the campaign to try again.
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
          )}
          </>
        )}
      </div>
    </div>
  );
}

export default AgencyAnalyticsPage;
