import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Clock, Users } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useAgentPerformance } from '../../hooks/useAgentPerformance';
import { useAgentRoster, type AgentRosterFilters } from '../../hooks/useAgentRoster';
import { agentDisplayName, type NamedAgent } from '../../utils/agencyAgentFloor';
import {
  AGENT_STATS_WINDOWS,
  AGENT_STATS_WINDOW_LABELS,
  campaignLabel,
  campaignNameMap,
  occupancyBreakdown,
  type AgentStatsWindow,
} from '../../utils/agencyAgentPerformance';
import {
  ROSTER_COLUMNS,
  SORT_LABELS,
  allRowsHiddenReason,
  cohortComparable,
  benchmarkUsable,
  defaultRosterCampaign,
  inactiveNote,
  initialOrder,
  mixedCohortNote,
  rosterAttentionRows,
  rosterCountReadout,
  truncationNote,
} from '../../utils/agencyAgentRoster';
import { compareAvailable, compareMissing } from '../../utils/agencyCompareTray';
import { trackAgentSurfaceViewed } from '../../analytics/events';
import { BestHours } from './BestHours';
import { CampaignContribution } from './CampaignContribution';
import { CompareTray } from './CompareTray';
import { AgentPerformancePanel } from './AgentPerformancePanel';
import { AgentAttemptsPanel } from './AgentAttemptsPanel';
import { RosterTable } from './RosterTable';
import { AccountUnavailable } from '../common/AccountUnavailable';
import { ErrorAlert } from '../common/ErrorAlert';
import { LoadingSpinner } from '../common/LoadingSpinner';
import type { AgencyCampaign } from '../../types/agency-campaign';
import type { AgencyRosterSort } from '../../types/agency-stats';
import styles from './AgentAnalyticsSection.module.css';

/**
 * The floor, then one person — the per-agent half of `AgencyAnalyticsPage`.
 *
 * ── What changed here, and why the dropdown had to go ─────────────────────
 * This section used to open with a `<select>` of colleagues. It answered "show me
 * Ravi" and could not answer the question a supervisor actually arrives with,
 * which is **"who should I be asking about"** — a name picker requires you to
 * already know the answer. It also left the figures behind it unreadable: a 31%
 * connect rate is good or bad only against the floor, and a surface showing one
 * person at a time never shows the floor.
 *
 * So the entry point is now a ranked ROSTER (`RosterTable`), read in one request
 * that carries the cohort's percentiles on the same payload, and a row drills DOWN
 * into the panels that were already here. Nothing about those panels moved.
 *
 * ── The drill-down is the EXISTING panel, deliberately not a new one ───────
 * `AgentPerformancePanel` is shared between an agent's own view and their
 * supervisor's, and its own header explains why: two renderers would let an
 * agent's account of their afternoon and their supervisor's account of it drift
 * apart in wording, in rounding and in what counts as absent — and a coaching
 * conversation held over two different screens about one shift is worse than no
 * screen at all. `AgentAttemptsPanel` is shared through the same subject
 * discriminator. A roster row therefore selects a person and mounts exactly what
 * used to be mounted when one was picked from the dropdown; the roster added a way
 * IN, not a second rendering of anything.
 *
 * ── There is a SECOND drill-down, and it is a different question ───────────
 * A row opens one person. The header's "Who drove …" opens
 * `CampaignContribution` — the grouped read, one row per agent within the campaign
 * already in scope, with the campaign's own total pinned beneath them. It is here
 * rather than as columns on the roster because the two cannot share a payload: a
 * contribution needs the campaign's total, which the roster does not carry, and
 * the roster needs a cohort's percentiles, which the grouped read deliberately does
 * not. Both replace the roster rather than stacking under it, so exactly one read
 * is ever in flight and nothing behind a hidden screen refetches.
 *
 * A contribution ROW opens the same person's screen the roster's row does, and
 * comes back to the contribution table rather than to the roster. It needs nothing
 * fabricated: the panels are built against an id and a name, which is what an
 * `agent`-grouped row carries — so `SelectedAgent` takes a `NamedAgent` and both
 * lists can hand it one. Sending the reader back to the roster to find the same
 * person they were looking at is the alternative, and it is one they would do by
 * hand.
 *
 * ── One request for the roster, not one per agent ──────────────────────────
 * `useAgentRoster` fires a single read. Fanning `getAgentStats` out over a member
 * list would be N requests and still could not answer the question, because only
 * the server can compute a percentile over agents this client has not fetched.
 *
 * That also removed this component's `useTeam()` call. The roster carries
 * `agent_name` on every row (master enriches it in one query on the proxy hop), so
 * there is no longer a reason to read `GET /tenants/:id/members` here — and one
 * fewer request is one fewer thing to 403. It also means the roster shows exactly
 * the people who DIALLED, which is what the old picker could not do: it listed
 * every member of the tenant, most of whom had never held a station.
 *
 * ── The gate is `agency.supervise`, exactly ────────────────────────────────
 * Master floors `GET /agency/agents/stats`, `…/agents/:userId/stats` and
 * `…/attempts` on `agency.supervise`. Anything looser renders a surface whose
 * first read 403s; anything tighter hides it from an `account_admin` who holds it.
 * The gate is the PARENT component rather than an early return inside, because
 * hooks cannot be called conditionally and a check further down would still have
 * fired the roster read for every `viewer`, `operator` and `agent` who opened the
 * page.
 *
 * ── The account-resolution trap, which this section shipped a FOURTH time ──
 * `AgentHomePage`, `RequireFlag` and `AgencyAnalyticsPage` each carry a guard for
 * the same pair of failures, and each got it wrong first: every read here waits
 * for both `tenantId` and `accountId`, so with no account nothing is in flight and
 * **nothing will fire again** — a spinner that never resolves. The second clause
 * is not decoration: resolution can settle at `ready`, `degraded` OR `error` with
 * `accountId === null` (a tenant with genuinely no accounts, or a narrowed
 * fallback list that came back empty), and only the `error` arm is caught by
 * looking at the status alone.
 *
 * On the roster the account matters more than it did: it is a **required
 * predicate** on that route rather than an optional filter, precisely so a
 * tenant-wide roster cannot be obtained by omitting a parameter.
 */

export interface AgentAnalyticsSectionProps {
  /** `hasPermission(role, 'agency.supervise')`, computed by the page. */
  canSupervise: boolean;
  /**
   * The campaign list the page already holds, or `null` while it is unresolved.
   *
   * ── One list, and it is the list rather than a name map ───────────────────
   * This used to be a `Map<id, name>`, which was everything the two jobs it had
   * needed: filling the campaign filter, and resolving `by_campaign[]`'s ids inside
   * the drill-down. It now has a third job — choosing which campaign the roster
   * OPENS on — and that one needs `status`, because a name map cannot say which
   * campaign is dialing. So the whole list comes down and the name map is derived
   * from it here. That keeps the page's single list single: two lists would be two
   * answers about which campaigns exist.
   *
   * `null` means "not answered yet" and holds the roster read rather than firing it
   * across every campaign in the account — see `defaultRosterCampaign` and
   * `AgentRosterFilters.campaignId`. The page passes an empty array rather than
   * `null` once the list read has FAILED, so a failure resolves the default
   * (to "every campaign", reported as such) instead of leaving a spinner nothing
   * will ever clear.
   */
  campaigns: readonly AgencyCampaign[] | null;
}

export function AgentAnalyticsSection({ canSupervise, campaigns }: AgentAnalyticsSectionProps) {
  const { accountId, accountResolution, accountError, reloadAccounts } = useTenant();

  if (!canSupervise) return null;

  /** Still resolving. A refusal shown for one frame is a refusal users remember. */
  if (accountResolution === 'loading') {
    return (
      <section className={styles.wrap} aria-label="Per-agent analytics">
        <div className={styles.centred} data-testid="agent-analytics-resolving">
          <LoadingSpinner />
        </div>
      </section>
    );
  }

  /**
   * Settled, and there is no account. See the header: every read below waits for
   * both ids, so this is a terminal state rather than a slow one — the spinner
   * would never resolve because nothing is in flight and nothing will fire again.
   */
  if (accountResolution === 'error' || accountId === null) {
    return <AccountUnavailable detail={accountError} onRetry={reloadAccounts} />;
  }

  return <AgentAnalyticsPanel campaigns={campaigns} />;
}

function AgentAnalyticsPanel({ campaigns }: { campaigns: readonly AgencyCampaign[] | null }) {
  /**
   * The roster's window, scope and order.
   *
   * One object so `useAgentRoster` receives them together and every one of them is
   * a dependency of the read — a control whose value is read at request time but
   * not threaded into the deps is the classic version of this bug: the filter
   * moves, the table does not, and the screen shows the wrong rows under the right
   * controls.
   *
   * The default sort is `successes` desc, matching the route's own default, so the
   * first render and the server agree about what the reader is looking at without a
   * round trip to find out. There is now a Conversions column showing exactly that
   * figure, which there was not: the table opened ranked by a number that appeared
   * nowhere on it, with `aria-sort="none"` on every header.
   *
   * `campaignId` starts `undefined` — not chosen yet. See the effect below.
   */
  const [filters, setFilters] = useState<AgentRosterFilters>({
    period: 'week',
    campaignId: undefined,
    sort: 'successes',
    order: 'desc',
    includeInactive: false,
  });

  /**
   * ONE campaign by default, and this is the most consequential line in the file.
   *
   * The roster used to open with `campaignId: null`. Core applies no campaign
   * predicate when the parameter is absent and master forwards without defaulting,
   * so the DEFAULT screen pooled every campaign in the account — and the median,
   * the middle-half band and the per-row chips were all computed against that pool.
   * A telecaller agency runs several dealerships at once, each with its own lead
   * list and its own intrinsic connectability, so "their conversion rate is below
   * the bottom quarter of the team" was printed beside a named person on the
   * strength of a comparison between different dealers' lists.
   *
   * Applied ONCE, and only once the list has arrived. The ref is what makes it a
   * default rather than a lock: a reader who then picks "All campaigns" keeps that
   * choice, and a later campaign-list refresh does not silently drag them back to
   * one campaign.
   */
  const defaulted = useRef(false);
  useEffect(() => {
    if (defaulted.current || campaigns === null) return;
    /*
      ── It does NOT latch on an EMPTY list ────────────────────────────────────
      `[]` reaches this component from two places and one of them is a failure: the
      page passes `campaigns ?? (error !== null ? [] : null)`, synthesising an empty
      list when the campaign read FAILED, so that this section falls back to "every
      campaign" instead of spinning forever on a `null` nothing will clear.

      Latching on that empty list froze the choice a failure made. `defaultRosterCampaign([])`
      is `null` — the pooled all-campaigns view — so after a successful Retry, with a
      real campaign list in hand, the roster stayed pooled: the median, the band and
      every per-row chip computed across different dealerships' lead lists, which is
      the exact comparison this default exists to prevent, chosen by a transient
      network error rather than by the reader. The most consequential line in the
      file, defeated by the one path nobody re-reads.

      So the ref is set only once there is a real list to default WITHIN. The write
      still happens on the empty list, because unblocking the read is what stops the
      failure becoming a permanent spinner — it just is not remembered.
    */
    if (campaigns.length > 0) defaulted.current = true;
    /*
      And the write bails out when it would change nothing.

      ── Stated honestly: this is defence, not a fix for a live loop ──────────
      The synthetic `[]` is a fresh array literal on every render of the page above,
      so this effect re-runs whenever THAT component re-renders — and the ref no
      longer stops the second pass. It still cannot loop today, because `setFilters`
      re-renders only this component, which does not create a new `campaigns` array
      and therefore does not re-trigger the effect. Returning `prev` unchanged makes
      that independent of the parent's render behaviour rather than dependent on it,
      which is worth two lines on the path a failed campaign read takes.

      There is deliberately no test asserting a loop that cannot currently happen:
      it would pass with this line removed, and a green assertion over an unreachable
      state is the MAG-106 pattern. The test below pins the reachable half — repeated
      renders with the same empty list issue one read.
    */
    setFilters((prev) => {
      const next = defaultRosterCampaign(campaigns);
      return prev.campaignId === next ? prev : { ...prev, campaignId: next };
    });
  }, [campaigns]);

  /**
   * The person being drilled into, or `null` for whichever list is showing.
   *
   * A {@link NamedAgent} — an id and the name master resolved — because that is
   * exactly what the drill-down uses, and re-deriving the name would mean either a
   * second lookup or a blank caption. It used to be the whole roster row, and the
   * row's other twenty fields were never read: widening it to the two that are is
   * what lets a CONTRIBUTION row open the same panels without fabricating a roster
   * row's shape to do it.
   *
   * Either list can set it, so the two drill-downs are no longer mutually
   * exclusive — see the branch order below, which is what makes "back" land where
   * the reader came from.
   */
  const [selected, setSelected] = useState<NamedAgent | null>(null);

  /**
   * The campaign whose contribution is being read, or `null` for the roster.
   *
   * The ID rather than a boolean, so the view has a definite campaign of its own:
   * "who drove this campaign" is a question about ONE campaign, and a view that
   * read the filter live could be re-scoped by a control it does not render.
   *
   * A second drill-down beside {@link selected}. Both replace the roster rather
   * than stacking under it, which is what keeps exactly one read in flight and
   * stops the roster refetching behind a screen nobody is looking at — but they are
   * no longer mutually exclusive, because a contribution row opens a person. When
   * both are set the PERSON is on screen and this is what they return to; see the
   * branch order below.
   *
   * It is also the campaign the contribution view is showing, not merely the one it
   * was opened with: that view's selector reports through `onCampaignChange`, so
   * there is one answer to "which campaign is this" and the label on the way back
   * out of a person's figures can be right.
   */
  const [contributionCampaign, setContributionCampaign] = useState<string | null>(null);

  /**
   * The campaign whose best-hours map is being read, or `null` for the roster.
   *
   * A THIRD screen beside {@link contributionCampaign}, and its own piece of state
   * for the same reason that one is: "when does this campaign connect" is a question
   * about ONE campaign — the read is a 400 without one, because both time dimensions
   * are grouped and the zone is unambiguous only under a single campaign filter — and
   * a view that read the roster's filter live could be re-scoped by a control it does
   * not render.
   *
   * It is mutually exclusive with the contribution screen in practice: both replace
   * the roster, and each is entered from the roster's header, so only one can be set
   * at a time. Written as two independent pieces of state rather than one
   * discriminated union because the union's third arm would exist only to say which
   * of two screens is showing, and the branch order below already says that.
   *
   * Unlike the contribution screen, this one has no way into a person's figures: a
   * weekday-hour cell is not somebody, so there is nothing on it to open. That is why
   * `SelectedAgent`'s back label does not mention it.
   */
  const [bestHoursCampaign, setBestHoursCampaign] = useState<string | null>(null);

  /**
   * Show only the rows carrying a flag — a client-side filter, not a sort.
   *
   * `limit` is the roster's real constraint: this console asks for the contract's
   * maximum (200) and phase 01 has no paging, so on a larger floor the ranking
   * decides who is visible, and under `conversions desc` the rows cut are the
   * lowest converters — the people being triaged. The flag column is deliberately
   * unsortable, so filtering is the affordance that makes a marked row reachable
   * without asking a different question.
   *
   * Deliberately NOT in the URL: query-string state for this surface's tab and
   * filters is a larger change and is deferred.
   */
  const [onlyFlagged, setOnlyFlagged] = useState(false);

  /**
   * The compare tray's own state — held HERE rather than inside it.
   *
   * ── It has to outlive the loading transition ──────────────────────────────
   * The tray is rendered only on a `ready` page, and every refetch goes through
   * `loading`: a column header, the window, the campaign, the inactive toggle, a
   * Retry. With the state inside the component, each of those unmounted the tray and
   * threw the selection away — so a supervisor who picked four people and then
   * re-sorted the table had to build the comparison again, and the tray's own
   * pruning of ids the new page no longer carries was unreachable code, because a
   * selection could never survive to be pruned.
   *
   * Nothing about `useAgentRoster` changed to make this work. The tray is still
   * mounted only on `ready` and still fetches nothing (E7); what moved is the
   * ownership of two values whose whole purpose is to span a refetch.
   */
  const [compareOpen, setCompareOpen] = useState(false);
  const [compareSelected, setCompareSelected] = useState<readonly string[]>([]);

  /**
   * Which period the drill-down's tiles are showing.
   *
   * Held HERE, above the `key={agent_user_id}` remount below, for the same reason it
   * was before the roster existed: "this week" means the same thing whoever is being
   * looked at, and resetting it would fight a supervisor comparing two people over
   * one range.
   *
   * ── It INHERITS the roster's window rather than starting at `today` ────────
   * It used to default to `today` while the roster defaulted to the week, so a
   * row's numbers changed the moment it was opened — the same person, two ranges,
   * one click apart, with nothing on screen saying so. It now follows the roster's
   * window: seeded from it, and re-seeded whenever the reader moves it.
   *
   * That inheritance is now EXACT. It used to run through `windowPeriod`, which
   * folded `last_week` onto "this week" and `last_month` onto "this month",
   * because the panel only had the three to-date tiles — so a supervisor who
   * ranked the floor on last week and opened a row was shown this week's figures
   * for that person, under a heading that still said the roster's window. The
   * panel now renders all five, so the mapping is gone and the drill-down lands
   * on the range the roster was ranked by.
   *
   * Changing the TILE afterwards still sticks across a change of person, which is
   * what a supervisor comparing two people over one range needs.
   */
  const [period, setPeriod] = useState<AgentStatsWindow>('week');
  const rosterWindow = filters.period;
  useEffect(() => {
    setPeriod(rosterWindow);
  }, [rosterWindow]);

  /**
   * Open a person, and re-seed their panel's window from the roster's.
   *
   * ── Why the effect above is not enough ────────────────────────────────────
   * It re-seeds only when `filters.period` CHANGES. So: rank the week, open Priya,
   * switch her tiles to Today, go back. The roster header still says "This week" —
   * and it is telling the truth, the table really is a week — but `period` is now
   * `today`, so the next row opened shows Today's figures under a header one click
   * away that says This week. Two ranges on one screen, no control saying which is
   * which, and the discrepancy reads as the console disagreeing with itself.
   *
   * Re-seeding on the way IN fixes it at the only moment it can be observed: the
   * panel is the sole reader of `period`, so the invariant to hold is "the panel
   * opens on the roster's window", not "period equals the roster's window at all
   * times". Doing it here rather than in `onBack` puts one write on the path into
   * the screen that shows the value, instead of a second write on the way out of it
   * that nothing could observe.
   *
   * It costs the previous behaviour where a chosen tile stuck across a change of
   * person, and that is the ruling: a supervisor comparing two people over one range
   * can still move the tile on each, and having the panel silently contradict the
   * table it was opened from is the worse of the two.
   */
  const openAgent = useCallback(
    (agent: NamedAgent) => {
      // Exactly the roster's window — no longer folded onto a to-date sibling,
      // because the panel renders all five.
      setPeriod(rosterWindow);
      setSelected(agent);
    },
    [rosterWindow],
  );

  const { state, reload } = useAgentRoster(filters);

  /**
   * A column header (or the sort menu) was pressed.
   *
   * Pressing the column already sorted flips the direction; pressing a new one
   * starts it in the direction that column obviously means — descending for a metric
   * ("who dialled most"), ascending for the name ("A–Z"). A uniform default would
   * make one of the two take two presses to do the plain thing.
   *
   * It sets state and nothing else: the refetch is `useAgentRoster`'s, because
   * `limit` truncates to the top N *of the chosen order* and re-sorting the rows in
   * hand would re-rank a page selected by a different question.
   */
  const onSort = useCallback((column: AgencyRosterSort) => {
    setFilters((prev) =>
      prev.sort === column
        ? { ...prev, order: prev.order === 'asc' ? 'desc' : 'asc' }
        : { ...prev, sort: column, order: initialOrder(column) },
    );
  }, []);

  /**
   * Campaign id → name, derived from the one list the page holds.
   *
   * Two consumers: the filter below, and `by_campaign[]`'s ids inside the
   * drill-down. Derived here rather than passed in, so the list and the map cannot
   * describe different sets of campaigns.
   */
  const campaignNames = useMemo(() => campaignNameMap(campaigns ?? []), [campaigns]);

  /** Campaigns this caller can NAME, sorted by that name — the same rule the panel's own scope uses. */
  const campaignOptions = useMemo(
    () =>
      [...campaignNames.entries()]
        .filter((entry): entry is [string, string] => Boolean(entry[1]))
        .sort((a, b) => a[1].localeCompare(b[1])),
    [campaignNames],
  );

  const page = state.status === 'ready' || state.status === 'empty' ? state.page : null;
  /*
    The toggle stays on screen once it has been used. `inactive_omitted` is 0 by
    definition while former members are shown, so a control rendered only on a
    non-zero count could be switched on and never off again.
  */
  const showInactiveToggle = filters.includeInactive || (page?.inactive_omitted ?? 0) > 0;

  /*
    Rows on the page that carry a chip. Computed for the filter's own label and for
    the "nothing to show" case below — the same pure derivation the table applies,
    called twice rather than threaded through a prop, exactly as `truncationNote` is.
  */
  const comparable = page !== null && cohortComparable(page) && benchmarkUsable(page.benchmark);
  const attention =
    page === null ? 0 : rosterAttentionRows(page.rows, page.benchmark, comparable).length;

  /**
   * Prune a compare selection the NEW page no longer carries.
   *
   * Here rather than inside the tray, and that placement is the fix rather than a
   * tidy-up: this component holds a `page` across the `loading` gap the tray is
   * unmounted for, so this is the only place the comparison "the selection contains
   * somebody the page dropped" can actually be made. Inside the tray the selection
   * was always empty on mount and the check was dead.
   *
   * It runs whether or not the tray is open, so a selection made before a narrower
   * window is already correct by the time it is reopened — and the hint's count can
   * never disagree with the columns beneath it, which is the small lie that makes a
   * reader distrust the figures beside it.
   */
  useEffect(() => {
    if (page === null) return;
    const missing = compareMissing(page, compareSelected);
    if (missing.length === 0) return;
    setCompareSelected((prev) => prev.filter((id) => !missing.includes(id)));
  }, [page, compareSelected]);

  /*
    Rows empty, but rows HIDDEN — a third answer, and an ordinary master response
    rather than a shape violation: core returns two revoked agents, master filters
    both and answers `200 { rows: [], inactive_omitted: 2, total_agents: 2 }`. It
    used to render "nobody was handed a call in this window" AND "2 former members
    hidden — they dialled in this window" AND "2 agents dialled", simultaneously.
    `useAgentRoster` now reserves `empty` for "nothing to show and nothing hidden",
    which leaves this case to be said on its own terms.

    ── WHY it is empty is three answers, not one ─────────────────────────────
    This was `rows.length === 0` and the sentence said everyone had left the team.
    Master drops rows for two independent reasons and only one of them is a
    departure: `unattributed_omitted` is an id with no membership record of any
    status, which the toggle CANNOT reveal, so telling the reader to tick it is
    advice that does nothing — and calling those people former colleagues is a
    claim about named individuals drawn from a count that says nothing of the kind.
    `allRowsHiddenReason` is the shared predicate; the three arms below are its
    three answers.
  */
  const hiddenReason = state.status === 'ready' ? allRowsHiddenReason(state.page) : null;
  const allHidden = hiddenReason !== null;

  /*
    A person first, when there is one — and clearing them falls through to whichever
    list they were opened FROM, because the contribution campaign is still set if
    that is where the row was. That is the whole mechanism behind "back lands where
    you came from": no third piece of state saying where, and no way for the two to
    disagree.
  */
  if (selected) {
    return (
      <section className={styles.wrap} aria-label="Per-agent analytics">
        <SelectedAgent
          key={selected.agent_user_id}
          agent={selected}
          period={period}
          onPeriod={setPeriod}
          campaignNames={campaignNames}
          /*
            Named after where it GOES, which is not always the roster now. Coming
            back to a contribution table and being told it was "All agents" would
            describe the wrong screen — and the contribution view keeps its own way
            back to the roster.
          */
          backLabel={
            contributionCampaign === null
              ? 'All agents'
              : `Who drove ${campaignLabel(contributionCampaign, campaignNames)}`
          }
          onBack={() => setSelected(null)}
        />
      </section>
    );
  }

  if (contributionCampaign !== null) {
    return (
      <section className={styles.wrap} aria-label="Per-agent analytics">
        {/*
          Deliberately NOT keyed by the campaign. It used to be, so that the view's
          window and toggle reset when a different campaign was opened — but the
          campaign can now be changed from inside it, and comparing four dealerships
          over ONE range is the reason that control exists. A key here would reset the
          window on every change and defeat it. Entering from the roster is a fresh
          mount anyway (this branch is not rendered while the roster is), so the seeds
          below still do the seeding.

          Its window is SEEDED from the roster's rather than read from it, so this
          screen cannot make the roster behind it refetch.
        */}
        <CampaignContribution
          campaignId={contributionCampaign}
          campaignNames={campaignNames}
          period={filters.period}
          includeInactive={filters.includeInactive}
          /*
            The contribution view's campaign, not the roster's filter: going back has
            to land on the roster the reader left rather than one this screen
            re-scoped behind them.
          */
          onCampaignChange={setContributionCampaign}
          onSelectAgent={openAgent}
          onBack={() => setContributionCampaign(null)}
        />
      </section>
    );
  }

  if (bestHoursCampaign !== null) {
    return (
      <section className={styles.wrap} aria-label="Per-agent analytics">
        {/*
          Not keyed by the campaign, for the contribution screen's reason: the
          campaign can be changed from inside it, and comparing four dealerships'
          hours over ONE range is the reason that control exists — a key here would
          reset the window on every change and defeat it. Entering from the roster is
          a fresh mount anyway (this branch is not rendered while the roster is), so
          the window seed still seeds.

          It replaces the roster rather than stacking under it, so exactly one read is
          ever in flight and nothing behind a hidden screen refetches. There is no
          `onSelectAgent`: a weekday-hour cell is not a person.
        */}
        <BestHours
          campaignId={bestHoursCampaign}
          campaignNames={campaignNames}
          period={filters.period}
          onCampaignChange={setBestHoursCampaign}
          onBack={() => setBestHoursCampaign(null)}
        />
      </section>
    );
  }

  return (
    <section className={styles.wrap} aria-label="Per-agent analytics">
      <div className={styles.header}>
        <div>
          <h2 className={styles.heading}>Everyone who dialled</h2>
          <p className={styles.description}>
            The whole floor over one window, ranked — with the team’s own median and
            middle half beside each person, because a conversion rate on its own says
            nothing. Open a row for that person’s figures and the calls behind them.
          </p>
        </div>
        {/*
          The other question about the campaign already in scope: not "who should I
          be asking about across the floor" but "who drove THIS campaign". It is a
          different read (grouped by agent and campaign, with the campaign's own
          total beside it) and a different screen, so it is a way IN rather than a
          column here.

          Offered only when ONE campaign is in scope, because a share of every
          campaign in the account is not a contribution — the pooled read's own
          note above the table already tells the reader to pick one. The name is in
          the label so the button says which campaign it means.
        */}
        {filters.campaignId != null && (
          <button
            type="button"
            className={styles.contributionEntry}
            data-testid="roster-contribution-entry"
            onClick={() => setContributionCampaign(filters.campaignId ?? null)}
          >
            Who drove {campaignLabel(filters.campaignId, campaignNames)}
            <ArrowRight size={14} aria-hidden="true" />
          </button>
        )}
        {/*
          The third question about the campaign in scope: not "who" but "when". A
          different cut of the same grouped route (weekday × hour rather than agent ×
          campaign), so it is a way IN rather than more columns here — a roster row is
          a person's whole window and cannot carry an hour.

          Offered only when ONE campaign is in scope, and here that is not a
          preference: with both time dimensions grouped there is no room for
          `campaign` in `group_by`, so the read's zone is unambiguous only under a
          single campaign filter and a pooled read is a 400. The button is the only
          way in, which is what makes the unreachable state unreachable rather than
          guarded.
        */}
        {filters.campaignId != null && (
          <button
            type="button"
            className={styles.contributionEntry}
            data-testid="roster-best-hours-entry"
            onClick={() => setBestHoursCampaign(filters.campaignId ?? null)}
          >
            <Clock size={14} aria-hidden="true" />
            When {campaignLabel(filters.campaignId, campaignNames)} connects
          </button>
        )}
        <Users size={18} className={styles.headerIcon} aria-hidden="true" />
      </div>

      <div className={styles.filters} role="group" aria-label="Roster filters">
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="roster-campaign">
            Campaign
          </label>
          {/*
            Defaults to one campaign, not to all of them — see the effect above. The
            "All campaigns" option stays, because "how much did the floor dial this
            week" is a real question; what it loses is the band comparison, which is
            the part that is not true across lead lists.
          */}
          <select
            id="roster-campaign"
            className={styles.control}
            value={filters.campaignId ?? ''}
            data-testid="roster-campaign"
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, campaignId: event.target.value || null }))
            }
          >
            <option value="">All campaigns</option>
            {campaignOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="roster-period">
            Window
          </label>
          {/*
            The per-agent panel's three to-date ranges, from the same `periodRange`,
            plus the two COMPLETED ones the roster needs. A weekly review is run on a
            Monday morning, and "this week" at 09:30 is ninety minutes of dials —
            every row under the rating threshold, every rate "not enough calls",
            every band "no median yet". A screen that is useless at the moment it is
            opened is not a window problem the reader can work around.
          */}
          <select
            id="roster-period"
            className={styles.control}
            value={filters.period}
            data-testid="roster-period"
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, period: event.target.value as AgentStatsWindow }))
            }
          >
            {AGENT_STATS_WINDOWS.map((value) => (
              <option key={value} value={value}>
                {AGENT_STATS_WINDOW_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="roster-sort">
            Sort by
          </label>
          {/*
            A second affordance over the SAME state the column headers write, not a
            second piece of state. It earns its place because the table scrolls
            sideways on a narrow screen — the headers are the better control when
            they are visible and no control at all when they are not — and because
            "sorted by" is the one thing about a truncated roster the reader must be
            able to see without hunting for an arrow.

            Built from `ROSTER_COLUMNS`, the same list the headers come from, so
            every order the reader can choose has a column showing it. It used to be
            built from the whole wire enum and offered two that did not — `successes`
            (the DEFAULT) and `talk_seconds`.
          */}
          <select
            id="roster-sort"
            className={styles.control}
            value={filters.sort}
            data-testid="roster-sort"
            onChange={(event) => onSort(event.target.value as AgencyRosterSort)}
          >
            {ROSTER_COLUMNS.map((column) => (
              <option key={column.sort} value={column.sort}>
                {SORT_LABELS[column.sort]}
              </option>
            ))}
          </select>
        </div>

        {page && page.rows.length > 0 && (
          <label className={styles.toggle} htmlFor="roster-only-flagged">
            <input
              id="roster-only-flagged"
              type="checkbox"
              checked={onlyFlagged}
              data-testid="roster-only-flagged"
              onChange={(event) => setOnlyFlagged(event.target.checked)}
            />
            {/*
              The count is on the control rather than rendered as a fraction of the
              page — the reader wants to know whether pressing it is worth it, and
              "3 of 12" over three independent facts is the shape this surface
              refuses everywhere else.
            */}
            {`Only rows that need attention (${attention})`}
          </label>
        )}

        {page && (
          <p className={styles.countReadout} data-testid="roster-count">
            {rosterCountReadout(page)}
          </p>
        )}
      </div>

      {/*
        How to read what IS on screen, so it sits ABOVE the table. The three notes
        below it are about what is not on screen, which is a question the reader has
        after scanning; a caveat met after the number it qualifies has been read is
        not a caveat.
      */}
      {page && mixedCohortNote(page) && (
        <p className={styles.warning} data-testid="roster-mixed-cohort">
          {mixedCohortNote(page)}
        </p>
      )}

      {state.status === 'loading' && (
        <div className={styles.centred} data-testid="roster-loading">
          <LoadingSpinner />
        </div>
      )}

      {state.status === 'error' && (
        /*
          A failure, with a retry — and distinct from the empty state below it.
          "Nobody dialled in this window" and "we could not ask" are different facts,
          and an empty table for both is how a supervisor concludes their floor did
          nothing.
        */
        <div data-testid="roster-error">
          <ErrorAlert message={state.message} onRetry={reload} />
        </div>
      )}

      {state.status === 'empty' && (
        /*
          "Nobody DIALLED", not "there are no agents". The roster's cohort is agents
          who were handed a call, so somebody who was on the floor all day and never
          got one has no row here at all — the sentence has to say that, or a
          supervisor reads an empty table as "my team does not exist". Who was logged
          in and idle is deliberately a question this surface cannot answer.

          This arm now means "nothing to show AND nothing hidden", so a longer window
          or another campaign really is the remedy. The all-departed case is the
          branch below, where it is not.
        */
        <p className={styles.empty} data-testid="roster-empty">
          Nobody was handed a call in this window, so there is nothing to rank. Anyone
          who was signed in but never dialled has no row here — try a longer window,
          or a different campaign.
        </p>
      )}

      {/*
        Every row hidden, said three different ways — because the remedy differs and
        one of the three has none. A single sentence naming the toggle was advice
        that did nothing on an all-unattributed page, and calling those people former
        colleagues was a statement about named individuals that the count does not
        support.
      */}
      {hiddenReason === 'departed' && (
        <p className={styles.empty} data-testid="roster-all-departed">
          Everyone who dialled in this window has since left the team, so every row was
          hidden. Tick “Show former team members” below to see them.
        </p>
      )}

      {hiddenReason === 'unattributed' && (
        <p className={styles.empty} data-testid="roster-all-unattributed">
          Nobody who dialled in this window could be matched to a member of this team,
          so every row was dropped. “Show former team members” will not reveal them —
          these rows carry no membership record of any kind, which is a different thing
          from having left. The team’s own figures below still include their calls.
        </p>
      )}

      {hiddenReason === 'both' && (
        <p className={styles.empty} data-testid="roster-all-hidden">
          Every row was hidden: some of the people who dialled in this window have since
          left the team, and the rest could not be matched to a member of it at all.
          Tick “Show former team members” below to see the ones who left; the others
          have no membership record to reveal.
        </p>
      )}

      {/*
        ── The filter can empty the table, and then the table must not MOUNT ────
        This branch was `ready && !allHidden` alone, so with the flag filter on and
        nothing flagged it rendered `RosterTable` with an empty `<tbody>`: nine
        column headers, the sticky pinned team footer with the whole floor's figures
        in it, and the "nothing needs a second look" sentence sitting beside them.
        A footer captioned as the team's totals under a table with no rows reads as
        those totals belonging to a selection of nobody.
      */}
      {state.status === 'ready' && !allHidden && !(onlyFlagged && attention === 0) && (
        <RosterTable
          page={state.page}
          /*
            The header arrow comes from the CLIENT's state, not the server's echo,
            and the two are one thing rather than two: `onSort` toggles against this
            same value, so an arrow driven by the echo could point at a column the
            toggle no longer considers current — and pressing the visibly-active
            header would then start it over instead of reversing it.

            They cannot legitimately disagree anyway: `sort` and `order` are always
            sent explicitly, so the server never has a default to substitute, and a
            refetch unmounts the table for the spinner in between. The echo is still
            what the copy below reads, where "what the server actually did" is the
            useful fact — see the truncation note.
          */
          sort={filters.sort}
          order={filters.order}
          onSort={onSort}
          onSelect={openAgent}
          onlyFlagged={onlyFlagged}
          caption={`Everyone who dialled — ${AGENT_STATS_WINDOW_LABELS[
            filters.period
          ].toLowerCase()}, sorted by ${SORT_LABELS[state.page.sort]}`}
        />
      )}

      {/* The filter can empty the table without the page being empty. */}
      {state.status === 'ready' && !allHidden && onlyFlagged && attention === 0 && (
        <p className={styles.empty} data-testid="roster-nothing-flagged">
          Nothing on this page needs a second look. Untick the filter to see the whole
          roster.
        </p>
      )}

      {/*
        The compare tray — two to four of the people above, side by side against the
        floor's band.

        ── It issues ZERO requests ─────────────────────────────────────────────
        It takes the page this section is already rendering and reads its rows and its
        `benchmark`. Nothing is fetched, so nothing in it can disagree with the table
        directly above it — and there was a server-shaped alternative that had to be
        refused: master holds ONE query whitelist shared by `/my-stats` and its
        supervisory twin, so a `compare_to` param for a "vs team" line would expose it
        on the agent's own scorecard in the same edit, and the cohort band is
        supervisor-only.

        ── Suppressed entirely on a pooled cohort ──────────────────────────────
        `compareAvailable` is false for the all-campaigns read, where `mixedCohortNote`
        directly above the table has already told the reader that comparing one person
        against the floor is switched off. A tray is the most emphatic version of
        exactly that comparison, so offering it there would contradict that sentence in
        the loudest way the surface allows. The component checks the same predicate
        itself, so a future caller cannot lose the guard.

        Rendered only on a `ready` page, and outside the `onlyFlagged` branch: the
        picker offers the whole page's rows because the filter hides rows rather than
        changing what the page is.
      */}
      {state.status === 'ready' && !allHidden && compareAvailable(state.page) && (
        <CompareTray
          page={state.page}
          window={filters.period}
          /*
            Its open state and its selection live HERE, so both survive the `loading`
            transition every refetch passes through — see the note where they are
            declared, and `CompareTrayProps` for what was broken while they did not.
          */
          open={compareOpen}
          onOpenChange={setCompareOpen}
          selected={compareSelected}
          onSelectedChange={setCompareSelected}
        />
      )}

      {/*
        The honesty affordances, below the table rather than above it: they are about
        what is NOT on screen, which is a question the reader has after scanning
        rather than before.
      */}
      {page && truncationNote(page) && (
        <p className={styles.note} data-testid="roster-truncated">
          {truncationNote(page)}
        </p>
      )}

      {showInactiveToggle && (
        <div className={styles.inactiveRow}>
          {page && inactiveNote(page) && (
            <p className={styles.note} data-testid="roster-inactive">
              {inactiveNote(page)}
            </p>
          )}
          <label className={styles.toggle} htmlFor="roster-include-inactive">
            <input
              id="roster-include-inactive"
              type="checkbox"
              checked={filters.includeInactive}
              data-testid="roster-include-inactive"
              onChange={(event) =>
                setFilters((prev) => ({ ...prev, includeInactive: event.target.checked }))
              }
            />
            Show former team members
          </label>
        </div>
      )}
    </section>
  );
}

/**
 * One person, drilled into from their roster row.
 *
 * Identical in substance to what the dropdown used to mount — the shared
 * performance panel, then the shared attempts panel — with a way back to the roster
 * added above it. The subject discriminator is what stops either panel from reading
 * the caller-scoped `my-` route and showing the supervisor their own shift under
 * somebody else's name.
 */
function SelectedAgent({
  agent,
  period,
  onPeriod,
  campaignNames,
  backLabel,
  onBack,
}: {
  /**
   * Who is being looked at — an id and the name master resolved, and nothing else.
   *
   * It was the whole roster row, and only these two fields were ever read. Narrowing
   * the prop to what it uses is what lets a CONTRIBUTION row open this screen: a
   * grouped row carries both (the id on its `key`), so nothing about a roster row's
   * twenty other fields has to be invented to get here.
   */
  agent: NamedAgent;
  period: AgentStatsWindow;
  onPeriod: (period: AgentStatsWindow) => void;
  campaignNames: ReadonlyMap<string, string | null>;
  /** Where the way back GOES — the roster, or the contribution table it came from. */
  backLabel: string;
  /*
    There was a `rosterWindow` prop here, carried in for the sole purpose of
    saying when the panel's tiles were a different range from the list behind
    them. The panel now renders every window the roster can be ranked by, so
    there is nothing to disclose and no reason to thread the value down.
  */
  onBack: () => void;
}) {
  const userId = agent.agent_user_id;
  /*
    The name master already resolved, through the same fallback the live floor uses
    — so an unresolvable agent is captioned with a marked-as-an-id stand-in rather
    than a blank, and never with a name this client invented.
  */
  const label = agentDisplayName(agent);

  /**
   * The campaign scope, held here rather than one level up so the caller's
   * `key={agent_user_id}` remount resets it for free. Carrying it across a change of
   * agent would silently scope a new person's figures to a campaign they may never
   * have worked — tiles of honest zeroes that read as a bad shift.
   *
   * Deliberately NOT seeded from the roster's own campaign filter. The roster's
   * filter narrows who is ON the list; this one narrows one person's totals, and
   * inheriting it would mean a supervisor who filtered the roster to find somebody
   * then read that person's whole week as though they had worked only that campaign.
   */
  const [scope, setScope] = useState<string | null>(null);
  const { periods, reload, windows } = useAgentPerformance({ kind: 'agent', userId }, scope);

  /**
   * `agent_surface_viewed`, once per named person — `SelectedAgent` is keyed by
   * `agent_user_id` (see the caller), so a fresh mount is exactly a fresh drill-down
   * and a ref guard is all a once-per-visit firing needs. Both sub-views are on
   * screen together here, so both fire.
   */
  const viewTracked = useRef(false);
  useEffect(() => {
    if (viewTracked.current) return;
    /* Optional for the reason `AgentPerformancePage`'s twin of this effect is:
       `periods` carries only the windows the hook was asked for. */
    const todayState = periods.today;
    if (todayState?.status !== 'ready') return;
    viewTracked.current = true;
    trackAgentSurfaceViewed({
      surface: 'performance',
      subject: 'agent',
      viewer_persona: 'supervisor',
      campaign_scoped: scope !== null,
      occupancy_measured: occupancyBreakdown(todayState.stats.totals.occupancy).measured,
      bucket_count: todayState.stats.buckets.length,
      entry: 'analytics_tab',
    });
    trackAgentSurfaceViewed({
      surface: 'attempts',
      subject: 'agent',
      viewer_persona: 'supervisor',
      // The attempts filters live in `useAgentAttempts`, inside `AgentAttemptsPanel`
      // below, and every mount starts unfiltered.
      campaign_scoped: false,
      // Not meaningful for a row-per-call list — see `AgentAttemptsPage`.
      occupancy_measured: true,
      bucket_count: 0,
      entry: 'analytics_tab',
    });
  }, [periods.today, scope]);

  return (
    <>
      <div className={styles.drilldownHeader}>
        {/*
          A button, not browser history: the roster is component state on a tabbed
          page and there is no URL to go back to. Named after where it goes rather
          than "Back", which on a page with two tabs and a router above it is
          ambiguous about how far back it goes.
        */}
        <button type="button" className={styles.back} onClick={onBack} data-testid="roster-back">
          <ArrowLeft size={14} aria-hidden="true" />
          {backLabel}
        </button>
        <h3 className={styles.drilldownName}>{label}</h3>
      </div>

      {/*
        There used to be a caveat here saying the tiles showed a different range
        from the one the roster was ranked by — `windowPeriodShiftNote`. It is
        gone because the mismatch is: the panel renders all five windows now, so
        a `last_week` roster drills into `last_week`. Removing the note was not
        optional once the mapping went, since it named the three to-date tiles
        explicitly and would have been a false statement about the screen it sat
        on.
      */}
      <AgentPerformancePanel
        periods={periods}
        windows={windows}
        selected={period}
        onSelect={onPeriod}
        campaignNames={campaignNames}
        campaignFilter={{ value: scope, onChange: setScope }}
        onRetry={reload}
      />

      <div className={styles.attempts}>
        <h3 className={styles.attemptsHeading}>Every call they took</h3>
        {/*
          Row by row, beneath the totals rather than on a separate screen. The filters
          are the panel's own and are deliberately NOT wired to the period tiles
          above: the tiles select `today` / `week` / `month` with an EXCLUSIVE end on
          `dialed_at`, while this list takes two days with an INCLUSIVE end on
          `created_at` — see `agencyAttemptFilters.ts`. Driving one from the other
          would silently reinterpret the reader's range, and the reinterpretation
          would be invisible: the rows would simply differ from the count above them
          by a day.
        */}
        <AgentAttemptsPanel
          subject={{ kind: 'agent', userId }}
          campaignNames={campaignNames}
          caption={`Calls taken by ${label}, newest first`}
        />
      </div>
    </>
  );
}

export default AgentAnalyticsSection;
