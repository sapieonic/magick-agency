import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChartNoAxesCombined } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { getMyCampaigns } from '../../api/agencyStats';
import { useAgentPerformance } from '../../hooks/useAgentPerformance';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { AgentSurfaceShell } from '../../components/agency/AgentSurfaceShell';
import { AgentPerformancePanel } from '../../components/agency/AgentPerformancePanel';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
import { agencyPersona } from '../../utils/agencyPersona';
import { assignmentEntry } from '../../utils/agencyAssignmentEntry';
import { trackAgentSurfaceViewed } from '../../analytics/events';
import {
  AGENT_HISTORY_REACH_NOTE,
  campaignNameMap,
  occupancyBreakdown,
  staffingSummary,
  type AgentStatsWindow,
} from '../../utils/agencyAgentPerformance';
import type { AgencyStaffingHistoryEntry } from '../../types/agency-stats';
import styles from './AgentPerformancePage.module.css';

/**
 * "My performance" — one agent's own numbers, at `/dialer/performance`.
 *
 * ── Full-viewport and OUTSIDE both shells ──────────────────────────────────
 * For exactly the reason `/station` and `/dialer` are. An `agent` is hierarchy
 * level 5 and inherits no navigation: `AppLayout`'s nav floors at `viewer` and
 * `AgencyLayout`'s entries do too, so either shell would render its chrome around
 * nothing — §A.1's *"that is not navigation, it is noise"*. The route therefore
 * sits beside `/dialer` in `App.tsx`, gated identically (`RequireAuth` +
 * `RequireCapability capability="agency"` + `RequireFlag
 * flag="agency_dialer_enabled"`, both entitlements default off) and adds nothing
 * to `RequireCapability`'s hand-maintained union, because `agency` is already in
 * it.
 *
 * ── A supervisor is SERVED here, and never SENT here ───────────────────────
 * `AgentHomePage` bounces a supervisor to the campaigns workspace, because a
 * supervisor asking for `/dialer` wants the dialer rather than their own
 * (usually empty) staffing list. This page does the opposite and renders for
 * them: a supervisor who covers shifts has their own calls, their own handle
 * time and their own conversions, and refusing to show them their own numbers
 * because of their role would be a strange thing to do. What this page must not
 * become is their *team* surface — that is the per-agent section on
 * `AgencyAnalyticsPage`, which reads the supervisor twins — so nothing anywhere
 * routes a supervisor here, and the note below points them at the right screen.
 *
 * ── The account-resolution trap, now guarded in ONE place ──────────────────
 * An `agent` is below `account.read`'s `viewer` floor, so `GET /accounts` 403s
 * for them; and a request sent before `TenantContext` resolves carries no
 * `X-Account-Id`, which core answers with a 400 that has nothing to do with the
 * data. So every read waits for BOTH ids — and "resolution settled but there is
 * no account" is an ERROR STATE rather than a permanent spinner, because with no
 * account nothing is in flight and nothing will fire again.
 *
 * That guard, the persona spinner and the header now live in
 * `AgentSurfaceShell`, shared with `/dialer/attempts`. It was inlined here while
 * this was the only page of its kind; the second one is what made a fourth
 * hand-written copy of a guard that `AgentHomePage`, `RequireFlag` and
 * `AgencyAnalyticsPage` each got wrong first a bad trade.
 *
 * ── Its sibling is "My calls", and the link between them is in the header ──
 * `/dialer/attempts` is the same shift told row by row rather than in totals: a
 * headline figure that surprises somebody is a figure they immediately want the
 * dials behind, and the two questions are one conversation. Both pages therefore
 * carry a link to the other in the one piece of chrome they have.
 *
 * ── Deliberately absent from `GlobalSearch` and from `AgencySidebar` ───────
 * The house rule is that a new page joins `GlobalSearch`'s list. This one does
 * not, and the exception is the same rule as above rather than an oversight:
 * `GlobalSearch` lives in `TopBar`, inside `AppLayout`, so the only people who
 * could ever find this through it are the roles that have a shell — and every one
 * of those is a supervisor or above, who must not be SENT here. A dedicated
 * `agent` never renders `AppLayout` at all, so an entry would be invisible to the
 * only person it is for. The link on `AgentHomePage` is the entry point, and it
 * is the one screen every agent passes through.
 *
 * ── The way out is a link, and here that is safe ───────────────────────────
 * The station has no escape route on purpose: clicking away drops the station
 * socket, and for up to 45 seconds after that core still believes the agent is in
 * the dialable pool, so a reservation landing in that window bridges a customer
 * to nobody (`agencyStationExit.ts`). **This page holds no socket and no
 * session.** So a link back to `/dialer` is ordinary navigation rather than a
 * hazard — and it is necessary, since a full-viewport page with no navigation and
 * no link is the trap `DialerUnavailable` exists to document. Nothing here links
 * INTO the station, and nothing was added to the station linking here.
 */

type HistoryState =
  | { status: 'loading' }
  | { status: 'ready'; entries: AgencyStaffingHistoryEntry[] }
  | { status: 'error'; message: string };

/**
 * Keyed by the workspace, and that is the whole of this component.
 *
 * ── What it fixes ───────────────────────────────────────────────────────────
 * The campaign scope below is a campaign id belonging to ONE tenant and account.
 * Held in plain state with no reset, it survived a workspace switch: every
 * periods stayed scoped to a campaign in the tenant the reader had just left,
 * that id was absent from the new options list so the selector could not
 * deselect it, and the note reading "Every figure below counts this campaign
 * only" stayed on screen naming nothing. The figures were a real campaign's, in
 * a workspace whose campaign list did not contain it.
 *
 * ── Why a key rather than a reset effect ───────────────────────────────────
 * An effect that cleared the scope would run AFTER the render that had already
 * read was issued with the stale id — so the wrong request goes out and its
 * answer is on screen until the corrected one lands. A remount means the first
 * read of the new workspace is already unscoped. `AgentAnalyticsSection` gets the
 * same property free from its `key={userId}`, for the same reason and with its
 * own test; this is that pattern on the other axis.
 *
 * ── Why it wraps the whole page and not just the panel ─────────────────────
 * The reads have to stay ABOVE `AgentSurfaceShell`. The shell renders a spinner
 * instead of its children while the role is unresolved, and the reads depend on
 * the two ids rather than on the role — so a hook moved inside the children would
 * delay every agent's first paint by a round trip to spare a role below the
 * station floor a single 403. `AgentPerformancePage.test.tsx` pins that
 * deliberately; see its persona-spinner case.
 *
 * The staffing history and the selected period are remounted too, and both are
 * right: the history is another workspace's, and "Today" is a reasonable place
 * to land in a workspace the reader has just arrived in.
 */
export function AgentPerformancePage() {
  const { tenantId, accountId } = useTenant();
  return <AgentPerformanceWorkspace key={`${tenantId ?? ''}:${accountId ?? ''}`} />;
}

function AgentPerformanceWorkspace() {
  const { role, tenantId, accountId } = useTenant();
  const persona = agencyPersona(role);
  const [period, setPeriod] = useState<AgentStatsWindow>('today');
  const [history, setHistory] = useState<HistoryState>({ status: 'loading' });
  /**
   * Which campaign the period tiles are counting, or `null` for all of
   * them.
   *
   * Held on the page rather than in the panel for the same reason the attempts
   * list holds its filters in a hook: the value is a REQUEST parameter, and state
   * that decides a request does not belong to the component that renders the
   * answer. Reset by the remount above on a workspace switch.
   */
  const [scope, setScope] = useState<string | null>(null);

  const { periods, reload, windows } = useAgentPerformance({ kind: 'me' }, scope);

  /**
   * `agent_surface_viewed`, fired once per workspace visit — not on mount, on
   * FIRST READY DATA. `AgentPerformanceWorkspace` is remounted whenever the
   * tenant:account key above changes, so a `useRef` guard here is exactly a
   * once-per-visit firing without needing `[]` deps to race the still-loading
   * `periods.today` (persona can also still be `null` for the first frame — see
   * `AgentPerformancePage.test.tsx`'s role-resolution case). `bucket_count` and
   * `occupancy_measured` are read off `today`, the period the panel opens on.
   */
  const viewTracked = useRef(false);
  useEffect(() => {
    if (viewTracked.current) return;
    if (persona === null) return;
    /*
      `periods` is keyed by the windows the hook was asked for, so this is
      `undefined` for a caller that did not request `today`. This page always
      does — it is the window the panel opens on — but the read is guarded
      rather than asserted, because the alternative to a guard here is a
      TypeError inside an analytics effect taking the page down.
    */
    const todayState = periods.today;
    if (todayState?.status !== 'ready') return;
    viewTracked.current = true;
    trackAgentSurfaceViewed({
      surface: 'performance',
      subject: 'me',
      viewer_persona: persona,
      campaign_scoped: scope !== null,
      occupancy_measured: occupancyBreakdown(todayState.stats.totals.occupancy).measured,
      bucket_count: todayState.stats.buckets.length,
      // No wiring today distinguishes a station-menu / agent-home arrival from a
      // direct one (see `agencyStationExit.ts`'s `STATION_HISTORY_LINKS`, which
      // carries no query param and is pinned verbatim by
      // `AgentConsolePage.stationExit.test.tsx`). Tagging that link would be a
      // safe, additive change but is left for a follow-up rather than bundled
      // with an analytics-only pass.
      entry: 'direct',
    });
  }, [persona, periods.today, scope]);

  useEffect(() => {
    // Both ids, for the reason in the header. `my-campaigns` is floored at
    // `agency.station.connect`, so this is one of the few reads an `agent` can
    // make at all — and it is fetched because `by_campaign[]` carries ids and no
    // names, so without it the breakdown is a column of uuids.
    if (!tenantId || !accountId) return undefined;

    let cancelled = false;
    setHistory({ status: 'loading' });
    getMyCampaigns(tenantId, accountId)
      .then((entries) => {
        if (cancelled) return;
        setHistory({ status: 'ready', entries });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setHistory({
          status: 'error',
          message: err instanceof Error ? err.message : 'Could not load your campaigns.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, accountId]);

  const entries = history.status === 'ready' ? history.entries : [];

  return (
    <AgentSurfaceShell
      icon={<ChartNoAxesCombined size={20} />}
      title="My performance"
      subtitle="Your own calls — what you dialled, who you spoke to, and how the time went."
      /* The way back. Safe here and necessary here — see the header. */
      current="performance"
      note={
        /*
          Served, not bounced — but told which screen answers the other question,
          because a supervisor who opens "My performance" and finds their own
          eleven calls will otherwise conclude the dialer has lost their team's
          numbers.
        */
        persona === 'supervisor' ? (
          <>
            These are your own calls. For your team’s, open{' '}
            <Link to="/agency/analytics">Analytics</Link> in the campaigns workspace.
          </>
        ) : undefined
      }
    >
      <AgentPerformancePanel
        periods={periods}
        windows={windows}
        selected={period}
        onSelect={setPeriod}
        reachNote={AGENT_HISTORY_REACH_NOTE}
        campaignNames={campaignNameMap(entries)}
        campaignFilter={{ value: scope, onChange: setScope }}
        onRetry={reload}
      />

      <StaffingHistory state={history} />
    </AgentSurfaceShell>
  );
}

/**
 * Every campaign this person has been part of, ended assignments included.
 *
 * ── Why the history and not the entry list ─────────────────────────────────
 * `GET /agency/my-assignments` is right to hide an ended assignment: it answers
 * "where may I go now", and offering a campaign somebody was taken off would be
 * an affordance that fails. This section answers a different question — "what
 * have I worked" — which is the question the per-campaign breakdown above raises
 * the moment it names a campaign the agent is no longer staffed on.
 *
 * ── One mapping from status to meaning, not two ────────────────────────────
 * `assignmentEntry` already owns "can this campaign still be entered, and what
 * should be said about it if not". It is reused verbatim rather than re-derived:
 * its shape is an allow-list of BLOCKS, so a lifecycle state core adds is treated
 * as ordinary instead of as finished, and a second copy here is the one that goes
 * stale. `AgencyCampaignStatusBadge` keeps the other half of that property — it
 * renders an unrecognised status verbatim, which is what lets master forward
 * core's lifecycle without this client mirroring it.
 */
function StaffingHistory({ state }: { state: HistoryState }) {
  if (state.status === 'loading') {
    return (
      <section className={styles.section} aria-label="Campaigns you have worked">
        <h2 className={styles.sectionHeading}>Campaigns you’ve worked</h2>
        <div className={styles.centred}>
          <LoadingSpinner />
        </div>
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section className={styles.section} aria-label="Campaigns you have worked">
        <h2 className={styles.sectionHeading}>Campaigns you’ve worked</h2>
        {/* The server's own sentence: these failures are mostly permission- or
            connectivity-shaped and ours would be a guess. */}
        <p className={styles.note} data-testid="history-error">
          We couldn’t load your campaigns. {state.message}
        </p>
      </section>
    );
  }

  const { entries } = state;
  const summary = staffingSummary(entries);

  return (
    <section className={styles.section} aria-label="Campaigns you have worked">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionHeading}>Campaigns you’ve worked</h2>
        {/*
          ── One axis per chain, because the two do not add up ────────────────
          The chain used to read "N in total · N current · N waiting · N
          finished", and three of those count CAMPAIGNS while "current" counts
          ASSIGNMENT ROWS. They overlap by construction: a paused campaign an
          agent is still staffed on is one of the `waiting` and one of the
          `current`, so the four numbers sat in a middot chain that invited an
          addition producing more campaigns than the agent has ever seen.

          So the chain is campaigns only — a total and two of its subsets, which
          do subtract sensibly — and the assignment count is a separate element
          beside it with its own word. Nothing was relabelled to achieve that;
          the two axes were simply stopped from sharing a line.

          `waiting` is labelled "waiting" rather than "paused" because it merges
          `paused`, `draft` and `stopping`: three statuses that differ in why
          nothing is dialing but not in whether the agent can do anything about
          it. Calling it "paused" would be a narrower claim than the number
          supports, so the exact statuses go in the `title` and the badges below
          stay the place where one campaign's own status is read.
        */}
        <span
          className={styles.sectionMeta}
          data-testid="staffing-summary"
          title={
            summary.waiting > 0
              ? 'Waiting covers campaigns that are paused, still in draft, or stopping.'
              : undefined
          }
        >
          {summary.campaigns === 0
            ? 'None yet'
            : `${summary.campaigns} in total · ${summary.waiting} waiting · `
              + `${summary.finished} finished`}
        </span>
      </div>
      {/*
        The other axis, on its own line and in its own words. "Assignments"
        rather than "campaigns" is the whole reason it is not in the chain above:
        an agent can hold two stints on one campaign, and master's `active` flag
        is per assignment row.
      */}
      {summary.campaigns > 0 && (
        <p className={styles.note} data-testid="staffing-active">
          {summary.active === 1
            ? 'You’re currently assigned to 1 of them.'
            : `You’re currently assigned to ${summary.active.toLocaleString()} of them.`}
        </p>
      )}

      {entries.length === 0 ? (
        <p className={styles.note} data-testid="history-empty">
          {/* Names who fixes it. An agent holds no permission that could staff
              them, so a "try again" here would be an instruction to repeat
              something that cannot work. */}
          You haven’t been put on a campaign yet. Ask your supervisor to add you to one.
        </p>
      ) : (
        <ul className={styles.list}>
          {entries.map((entry) => (
            <HistoryRow key={`${entry.campaign_id}:${entry.assigned_at}`} entry={entry} />
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryRow({ entry }: { entry: AgencyStaffingHistoryEntry }) {
  const { note } = assignmentEntry(entry.campaign_status);

  return (
    <li className={styles.row} data-testid={`history-row-${entry.campaign_id}`}>
      <div className={styles.rowMain}>
        <span className={styles.rowName}>{entry.campaign_name ?? 'Unnamed campaign'}</span>
        <span className={styles.rowMeta}>
          {entry.campaign_status ? (
            <AgencyCampaignStatusBadge status={entry.campaign_status} />
          ) : null}
          {note ? <span className={styles.rowNote}>{note}</span> : null}
        </span>
      </div>
      {/*
        `active` is master's own flag rather than `unassigned_at === null`.
        Master owns the staffing table and may end an assignment in ways this
        client has no business modelling; two sources for one boolean is two
        answers.
      */}
      <span className={entry.active ? styles.badgeActive : styles.badgeEnded}>
        {entry.active ? 'Still assigned' : 'No longer assigned'}
      </span>
    </li>
  );
}

export default AgentPerformancePage;
