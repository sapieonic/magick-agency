import { useEffect, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { getMyAssignments } from '../../api/agency';
import { AccountUnavailable } from '../../components/common/AccountUnavailable';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { WorkspaceExit } from '../../components/agency/WorkspaceExit';
import { AgencyCampaignStatusBadge } from './AgencyCampaignStatusBadge';
import { AgentNav } from '../../components/agency/AgentNav';
import { agencyPersona, isDedicatedAgent } from '../../utils/agencyPersona';
import { assignmentEntry } from '../../utils/agencyAssignmentEntry';
import { AGENT_LANDING_PARAM, agentLandingArrival } from '../../utils/agencyStationExit';
import type { AgencyAssignment } from '../../types/agency-campaign';
import styles from './AgentHomePage.module.css';

/**
 * The agent's home — every campaign they are staffed on, and the way into each.
 *
 * ── What this replaces, and why a page rather than a redirect ───────────────
 * `AgentLanding` used to resolve ONE assignment and bounce the agent straight to
 * `/station?campaign=<id>`. That was the right shape while the server allowed one
 * active assignment per person: with a single destination there is nothing to
 * choose, so a chooser would have been a click in front of the only answer.
 *
 * The server now allows several, because an agency runs Renewals
 * in the morning and Collections after lunch and the old rule made the second
 * assignment silently destroy the first. Once an agent can hold two, "which one?"
 * is a question only they can answer — a supervisor's staffing list says what they
 * MAY work, not what they are working at 2pm. So this is a page.
 *
 * **The single-assignment case still redirects.** That is not a special case
 * bolted on; it is the same rule as before, and preserving it matters more than
 * consistency: the overwhelmingly common shift is one campaign, and making those
 * agents click past a list of one every morning would be a regression dressed as
 * a feature.
 *
 * ── Full-viewport, outside every shell ─────────────────────────────────────
 * For the reason `/station` is and `AgentLanding` before it: an `agent` is
 * hierarchy level 5 and inherits no navigation, so a shell around this would be an
 * empty sidebar — "that is not navigation, it is noise". It is deliberately NOT
 * inside `AgencyLayout` for the same reason, even though it is an agency surface:
 * that shell's three nav entries all floor at `viewer` or above, so an agent would
 * render its chrome and none of its contents.
 *
 * ── Supervisors are sent away rather than served an empty list ──────────────
 * A supervisor reaching `/dialer` is asking for the dialer, not for their own
 * staffing — they are usually staffed on nothing, so this page would tell them
 * "nobody has assigned you a campaign", which is true and useless. They get the
 * campaigns workspace, which is what they came for.
 */

type HomeState =
  | { status: 'loading' }
  | { status: 'ready'; assignments: AgencyAssignment[] }
  | { status: 'error'; message: string };

export function AgentHomePage() {
  const { role, tenantId, accountId, accountResolution, accountError, reloadAccounts } =
    useTenant();
  const [params] = useSearchParams();
  const persona = agencyPersona(role);
  /**
   * Whether to offer a way back to the rest of the product.
   *
   * This page is full-viewport and outside both shells, which is right for a
   * dedicated `agent` — level 5 has no navigation to return to, and an escape
   * route beside a live call is a misclick that hangs up on a customer.
   *
   * It is wrong for a `viewer` or `operator`. They resolve to the agent persona
   * (they hold every agent permission and no supervisory one) and are sent here on
   * purpose, but they also own a populated platform — calls, schedules, contact
   * lists — and stranding them on a page with no link is how an earlier revision
   * of this feature locked them out of it. So: they get a way back, and a
   * dedicated agent does not.
   */
  const canLeaveDialer = !isDedicatedAgent(role) && persona === 'agent';
  /** `null` for an ordinary visit; otherwise why the auto-redirect must not fire. */
  const arrival = agentLandingArrival(params.get(AGENT_LANDING_PARAM));

  const [state, setState] = useState<HomeState>({ status: 'loading' });

  useEffect(() => {
    if (persona !== 'agent') return undefined;
    /**
     * Both ids, for the reason `AgentConsolePage` spells out at its own join:
     * `TenantContext` resolves the account asynchronously, and a request sent in
     * that window carries no `X-Account-Id`, which the server answers with a 400 that
     * has nothing to do with the agent's assignments.
     */
    if (!tenantId || !accountId) return undefined;

    let cancelled = false;
    setState({ status: 'loading' });
    getMyAssignments(tenantId, accountId)
      .then((assignments) => {
        if (cancelled) return;
        setState({ status: 'ready', assignments });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({
          status: 'error',
          message: err instanceof Error ? err.message : 'Could not check your campaigns.',
        });
      });
    return () => {
      cancelled = true;
    };
  }, [persona, tenantId, accountId]);

  /**
   * A supervisor came for the dialer, not for their own staffing. Sent to the
   * workspace they actually wanted — see the header.
   */
  if (persona === 'supervisor') return <Navigate to="/agency/campaigns" replace />;

  /**
   * Nobody the Agency Dialer has a place for. Reachable only if a role below the
   * station floor is ever added, or before `TenantContext` resolves a membership —
   * so it renders the spinner rather than a refusal, and the effect above will
   * fire once the role arrives.
   */
  if (persona === null) {
    return (
      <div className={styles.shell}>
        <div className={`${styles.card} ${styles.cardCentred}`}>
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  /**
   * An account that could not be resolved is not a slow account.
   *
   * The effect above waits for both ids, so with no account there is nothing in
   * flight and the spinner would be **permanent**. This precise bug used to hit an
   * `agent` on every sign-in — level 5 is below `account.read`'s `viewer` floor, so
   * `GET /accounts` 403s for them — and `RequireFlag` carries the same guard, for
   * the same reason, with the same comment. (`AgentLanding` does NOT: it resolves no
   * account, holding only the persona check and the entitlement gate.) The second
   * clause is not decoration: resolution can settle without producing an account (a
   * tenant with genuinely zero accounts, or a `'degraded'` fallback whose narrowed
   * list came back empty), and nothing will fire again to set one.
   */
  if (accountResolution === 'error' || (accountResolution !== 'loading' && accountId === null)) {
    return <AccountUnavailable detail={accountError} onRetry={reloadAccounts} />;
  }

  if (state.status === 'loading') {
    return (
      <div className={styles.shell}>
        <div className={`${styles.card} ${styles.cardCentred}`}>
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <Centred
        title="We couldn’t check your campaigns"
        // The server's own sentence, because these failures are mostly
        // permission- or connectivity-shaped and ours would be a guess.
        body={state.message}
        showExit={canLeaveDialer}
      />
    );
  }

  const { assignments } = state;

  if (assignments.length === 0) {
    return (
      <Centred
        title="You’re not assigned to a campaign yet"
        /* Names who fixes it. An agent holds no permission that could staff
           them, so a "try again" here would be an instruction to repeat
           something that cannot work. */
        body="Ask your supervisor to add you to one."
        showExit={canLeaveDialer}
        /* Offered even here, and deliberately. An agent taken off every campaign
           still has a shift behind them, and this is otherwise the one screen
           they can reach — so without the link their own history becomes
           unreachable at exactly the moment they most want to look at it. */
        showPerformance
      />
    );
  }

  /**
   * One campaign and nothing to say about it ⇒ go. The `arrival` guard is what
   * stops the redirect firing again on the way OUT of a station: Leave navigates
   * here with `?left=station`, the assignment is unchanged, and without the check
   * the agent could never get out. `canEnter` is checked too, so an agent whose one
   * campaign is paused lands on the list and reads why, instead of being bounced
   * into the console's refusal.
   */
  const only = assignments.length === 1 ? assignments[0]! : null;
  if (only && arrival === null && assignmentEntry(only.campaign_status).canEnter) {
    return <Navigate to={stationPath(only.campaign_id)} replace />;
  }

  return (
    <div className={styles.shell}>
      <div className={styles.card}>
        <h1 className={styles.title}>{headingFor(arrival, assignments.length)}</h1>
        <p className={styles.body}>{bodyFor(arrival, assignments.length)}</p>

        <ul className={styles.list}>
          {assignments.map((assignment) => (
            <AssignmentRow key={assignment.campaign_id} assignment={assignment} />
          ))}
        </ul>

        {assignments.length > 1 && (
          <p className={styles.footer}>
            You can only be on one campaign at a time. Leave the one you’re on before
            starting another.
          </p>
        )}

        <SurfaceNav />

        {canLeaveDialer && <ExitToPlatform />}
      </div>
    </div>
  );
}

/** One campaign, its state, and the way in — or the reason there isn't one. */
function AssignmentRow({ assignment }: { assignment: AgencyAssignment }) {
  const { canEnter, note } = assignmentEntry(assignment.campaign_status);

  return (
    <li className={styles.row}>
      <div className={styles.rowMain}>
        <span className={styles.name}>{campaignName(assignment)}</span>
        <span className={styles.meta}>
          {/* The badge renders an unrecognised status as-is rather than
              mapping it to a default, which is what lets the server forward the dialer runtime's
              value without this client mirroring the API's lifecycle. */}
          {assignment.campaign_status ? (
            <AgencyCampaignStatusBadge status={assignment.campaign_status} />
          ) : null}
          {note ? ` ${note}` : ''}
        </span>
      </div>
      {canEnter ? (
        <Link className={styles.action} to={stationPath(assignment.campaign_id)}>
          Enter station
        </Link>
      ) : (
        /* Terminal only — a stopped or completed campaign will never send a call,
           so there is nothing to enter. The reason sits beside it in `.meta`: a
           greyed control with no explanation reads as an outage or a lost
           permission, the house rule the console's disabled affordances follow. */
        <span className={styles.actionMuted}>Closed</span>
      )}
    </li>
  );
}

/** The single-message layout the three terminal states share. */
function Centred({
  title,
  body,
  showExit = false,
  showPerformance = false,
}: {
  title: string;
  body: string;
  showExit?: boolean;
  showPerformance?: boolean;
}) {
  return (
    <div className={styles.shell}>
      <div className={`${styles.card} ${styles.cardCentred}`}>
        <h1 className={styles.title}>{title}</h1>
        <p className={styles.body}>{body}</p>
        {showPerformance && <SurfaceNav />}
        {showExit && <ExitToPlatform />}
      </div>
    </div>
  );
}

/**
 * The way to the agent's own history — their numbers, and the calls behind them.
 *
 * ── Same-tab here, and NEW-TAB on the station ─────────────────────────────
 * `AgentHomePage` holds no socket and no session, so these are ordinary links.
 * The station is the opposite: navigating away from the console closes the
 * station socket, and for up to 45 seconds afterwards the API still has the agent in
 * the dialable pool with no screen attached — a reservation landing in that
 * window bridges a customer to nobody (`agencyStationExit.ts`, and the reason
 * Exit refuses while `available`). A same-tab "check your stats" link beside a
 * live call is that bug with a friendly label, and it stays refused.
 *
 * This page is nevertheless **not** the only place these two destinations are
 * reachable from any more, and the reason is that it is not a screen most agents
 * see: the single-assignment redirect above sends anyone with one enterable
 * campaign — "the overwhelmingly common shift" — straight past it into the
 * station. So their own numbers used to cost them a Leave, i.e. their place in
 * the queue. The console's station menu now carries the same two destinations as
 * `target="_blank"` links (`STATION_HISTORY_LINKS`), because a new tab is not a
 * navigation: the console keeps rendering, the socket stays open and the
 * heartbeat keeps renewing the lease. That is an addition to the reasoning above
 * rather than a softening of it — same-tab links on the station are still the
 * defect this paragraph describes.
 *
 * Shown to every persona that reaches this page, including the `viewer` and
 * `operator` who also get `ExitToPlatform` — they take dialer calls too, so their
 * history is as real as an agent's.
 *
 * ── It is `AgentNav` now, and it names this page too ──────────────────────
 * It was called `HistoryLinks` while it rendered two links AWAY from here.
 * It now renders the whole set including this page's own entry, so the name
 * described neither what it draws nor where it points.
 *
 * This was a hand-written pair of links — "See how I'm doing" and "See my
 * calls" — and the two history pages each carried their own hand-written way
 * back plus one sibling. Three lists, none of which showed the whole set, so
 * what an agent could reach depended on where they were standing.
 *
 * The nav is that set, rendered identically on all three surfaces with the
 * current one marked. On this page the current entry is "My campaigns", which
 * is the part that could not be expressed before: the old links pointed AWAY
 * and nothing said what this screen was. It stays one quiet row beneath the
 * campaign rows, at the weight the links already had — the rows own the only
 * primary action, and the chooser is no busier than it was.
 *
 * Reaching `/dialer/attempts` only through `/dialer/performance` was rejected
 * before and is not reachable now anyway: "which calls did I take" is the more
 * concrete of the two questions and often the only one somebody wants after a
 * bad afternoon, so hiding it behind a page of aggregates hides the plain
 * answer behind the summary of it.
 */
function SurfaceNav() {
  return <AgentNav current="campaigns" />;
}

/**
 * The way back for someone who has a platform to go back to.
 *
 * Decision B17: the wording is "Go to settings". `/app` here is this console's platform zone,
 * which for a `viewer` or `operator` opens on Notifications (and Call summaries
 * where analysis is on) — so "settings" says where the link goes. Kept rather
 * than replaced with a sign-out: these roles have a real in-product destination.
 *
 * Points at `/app` rather than `/agency`: the caller is a `viewer` or `operator`
 * whose own workspace is the main product, and `/agency` would put them one click
 * from being sent back here. `AgentLanding` will not bounce them — it gates on
 * `isDedicatedAgent`, which is false for exactly the roles that see this link.
 *
 * ── Why the destination goes through `WorkspaceExit` ───────────────────────
 * The `/app` above is deliberate and correct:
 * the platform zone — team and membership, credits, billing, the tenant audit
 * log, API keys, settings, tenant/account switching — is shared by both products
 * by design, so an agency surface linking there is not a boundary violation. The
 * violation to avoid is the *other* kind of `/app` link, the call-shaped deep
 * link that dumps a supervisor out of `AgencyLayout` and loses the campaign they
 * were reading.
 *
 * Telling those two apart by review failed once already, so it is now mechanical:
 * `WorkspaceExit` is the single sanctioned home for the `/app` string in agency
 * code, and `src/__tests__/utils/agencyShellBoundary.test.ts` fails on any `/app`
 * route literal that appears under the agency roots outside it. Hence a component
 * for what is otherwise one `<Link>` — see its header for the full reasoning.
 *
 * `styles.exit` and the wording stay here rather than moving into the component,
 * which is purely presentational: this renders byte-for-byte what it did before.
 */
function ExitToPlatform() {
  return <WorkspaceExit className={styles.exit}>Go to settings</WorkspaceExit>;
}

/**
 * `?campaign=` stays canonical.
 *
 * `/station` alone lands on `AgentConsolePage`'s "No campaign selected." refusal.
 * A station IS an agent joined to one campaign's pool, so there is no
 * campaign-less station to link to — the same reasoning that keeps a bare
 * `/station` link out of `AgencySidebar`.
 */
function stationPath(campaignId: string): string {
  return `/station?campaign=${encodeURIComponent(campaignId)}`;
}

/**
 * The campaign's name, or a stand-in.
 *
 * `campaign_name` is nullable on the server's wire — a best-effort API lookup,
 * documented null for an API outage or a deleted campaign. Rendered unguarded, a
 * brief outage produced rows with empty names and a link reading "Enter station"
 * beside nothing, which reads as a broken app rather than a transient upstream.
 */
function campaignName(assignment: AgencyAssignment): string {
  return assignment.campaign_name ?? 'Unnamed campaign';
}

/**
 * The heading.
 *
 * The two arrivals are different news and must not share a sentence: one agent
 * chose to stop taking calls, the other was refused entry by a campaign that is
 * paused or stopped. Telling the second they "left" is a false account of what
 * just happened to them.
 */
function headingFor(arrival: 'station' | 'refused' | null, count: number): string {
  if (arrival === 'refused') return 'That station didn’t open';
  if (arrival === 'station') return 'You’ve left the station';
  return count > 1 ? 'Pick a campaign' : 'Your campaign';
}

function bodyFor(arrival: 'station' | 'refused' | null, count: number): string {
  if (arrival === 'refused') {
    return 'You’re not taking calls right now. Here’s where you’re assigned — ask your supervisor if a campaign stays closed.';
  }
  if (arrival === 'station') {
    return 'You’re not taking calls right now. Your campaigns are still yours whenever you’re ready.';
  }
  return count > 1
    ? 'You’re assigned to more than one. Choose the one you’re working now.'
    : 'Start taking calls when you’re ready.';
}

export default AgentHomePage;
