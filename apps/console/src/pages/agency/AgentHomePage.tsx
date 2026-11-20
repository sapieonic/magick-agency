import { useEffect, useId, useState, type ReactNode } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { ArrowRight, CalendarClock, CircleCheck, Clock, Ear, OctagonX, Pause, Phone, RefreshCw } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useOptionalAuth } from '../../contexts/AuthContext';
import { getMyAssignments } from '../../api/agency';
import { getMyDay } from '../../api/agencyStats';
import { AccountUnavailable } from '../../components/common/AccountUnavailable';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { AgentNav } from '../../components/agency/AgentNav';
import { StationFrame } from '../../components/agency/station/StationFrame';
import stationStyles from '../../components/agency/station/Station.module.css';
import { CAMPAIGNS_LANDING_PATH, agencyPersona, isDedicatedAgent } from '../../utils/agencyPersona';
import { assignmentEntry } from '../../utils/agencyAssignmentEntry';
import { AGENT_LANDING_PARAM, agentLandingArrival } from '../../utils/agencyStationExit';
import {
  AGENT_HOME_COPY,
  callLaterLine,
  homeBand,
  workTile,
  type HomeScreen,
  type WorkStatus,
  type WorkTile,
} from '../../utils/agency/agentHome';
import { STATION_COPY } from '../../utils/agency/stationCopy';
import type { AgencyAssignment } from '../../types/agency-campaign';
import type { AgencyMyCallLater } from '@magick-agency/contracts/api/agency/my-day';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { LIVE_LISTEN_FLAG } from '../../utils/listen/liveListenFlag';
import { brand } from '../../brand';
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
 * inside the console shell for the same reason, even though it is an agency surface:
 * that shell's work entries all floor at `viewer` or above, so an agent would
 * render its chrome and none of its contents.
 *
 * ── Supervisors are sent away rather than served an empty list ──────────────
 * A supervisor reaching `/dialer` is asking for the dialer, not for their own
 * staffing — they are usually staffed on nothing, so this page would tell them
 * "nobody has assigned you a campaign", which is true and useless. They get the
 * campaigns workspace, which is what they came for.
 *
 * ── The station's look (spec §3 01, AS1, AS15) ─────────────────────────────
 * It is the step before Start of day, so it wears the station's frame: the top bar with the
 * agent's name, a full-width band that says what this screen is ("Namaste, Sunita", "Work
 * finished for now", "Your work did not open"), and one big tile per list in the station's
 * colours, each with its one way in. A list that can never send a call keeps its tile and loses
 * the way in (hidden, not greyed: AS1), its line saying why. The words are the station's own
 * (`utils/agency/agentHome.ts`): "work" and "list", never "campaign" or "station".
 */

type HomeState =
  | { status: 'loading' }
  | { status: 'ready'; assignments: AgencyAssignment[] }
  | { status: 'error' };

export function AgentHomePage() {
  const { role, tenantId, accountId, accountResolution, accountError, reloadAccounts } =
    useTenant();
  const [params] = useSearchParams();
  const persona = agencyPersona(role);
  const user = useOptionalAuth()?.user ?? null;
  const agentName = user?.display_name?.trim() || user?.email || 'Agent';
  const firstName = (user?.display_name ?? '').trim().split(/\s+/)[0] || null;
  /**
   * Whether to offer a way back to the rest of the product.
   *
   * This page is full-viewport and outside the console shell, which is right for a
   * dedicated `agent` — level 5 has no navigation to return to, and an escape
   * route beside a live call is a misclick that hangs up on a customer.
   *
   * It is wrong for a `viewer` or `operator`. They resolve to the agent persona
   * (they hold every agent permission and no supervisory one) and may come here to
   * take calls, but they land in the console (`agencyLandingPath`) and have
   * campaigns to read there, and stranding them on a page with no link is how an
   * earlier revision of this feature locked them out of it. So: they get a way
   * back, and a dedicated agent does not.
   */
  const canLeaveDialer = !isDedicatedAgent(role) && persona === 'agent';
  /** `null` for an ordinary visit; otherwise why the auto-redirect must not fire. */
  const arrival = agentLandingArrival(params.get(AGENT_LANDING_PARAM));
  /** The standing line of `docs/listening.md` LS2, while the account allows listening. */
  const listenNotice = useFeatureFlagEnabled(LIVE_LISTEN_FLAG);

  const [state, setState] = useState<HomeState>({ status: 'loading' });
  /** Try again after a failed read: bumping it runs the read again. */
  const [attempt, setAttempt] = useState(0);
  /** Each list's call-laters today, by list, from the agent's own day (`GET /my-day`). */
  const [callLaters, setCallLaters] = useState<Record<string, AgencyMyCallLater>>({});

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
      .catch(() => {
        // The station's own words (AS15), never the server's sentence: the screen says what to do.
        if (cancelled) return;
        setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [persona, tenantId, accountId, attempt]);

  const assignments = state.status === 'ready' ? state.assignments : null;
  const redirectTo = assignments ? redirectTarget(assignments, arrival) : null;
  /**
   * The call-laters on each tile that can be opened, once the tiles are on screen (never on the
   * way to a redirect). Best effort: a read that fails, or a server without `/my-day`, leaves the
   * line off its tile, which is the right reading of "we do not know".
   */
  const openIds = assignments && redirectTo === null
    ? assignments.filter((a) => assignmentEntry(a.campaign_status).canEnter).map((a) => a.campaign_id).join(',')
    : '';
  useEffect(() => {
    if (!openIds || !tenantId || !accountId) return undefined;
    let cancelled = false;
    for (const id of openIds.split(',')) {
      getMyDay(id, tenantId, accountId)
        .then((day) => {
          if (cancelled || !day?.call_later) return;
          setCallLaters((was) => ({ ...was, [id]: day.call_later }));
        })
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, [openIds, tenantId, accountId]);

  /**
   * A supervisor came for the dialer, not for their own staffing. Sent to the
   * workspace they actually wanted — see the header.
   */
  if (persona === 'supervisor') return <Navigate to="/agency/campaigns" replace />;

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
   *
   * Checked only once the persona is known: before that (`persona === null`, a role still
   * resolving, or one below the station floor) the page waits, and the effect fires once the
   * role arrives.
   */
  if (persona !== null && (accountResolution === 'error' || (accountResolution !== 'loading' && accountId === null))) {
    return <AccountUnavailable detail={accountError} onRetry={reloadAccounts} />;
  }

  const frame = { agentName, brandMark: brand.shortName };
  const exit = canLeaveDialer ? <ExitToPlatform /> : null;
  const listenLine = listenNotice ? (
    <>
      <Ear size={18} aria-hidden="true" />
      <span data-testid="listen-agent-notice">{STATION_COPY.listenNotice}</span>
    </>
  ) : null;

  if (persona === null || state.status === 'loading') {
    return (
      <HomeFrame {...frame} screen={{ kind: 'loading' }} firstName={firstName}>
        <div className={styles.waiting}><LoadingSpinner /></div>
      </HomeFrame>
    );
  }

  if (state.status === 'error') {
    return (
      <HomeFrame
        {...frame}
        screen={{ kind: 'error' }}
        firstName={firstName}
        footLeft={exit}
        footRight={
          <button
            type="button"
            className={`${stationStyles.btn} ${stationStyles.btnBig} ${stationStyles.btnGo}`}
            onClick={() => setAttempt((n) => n + 1)}
            data-testid="home-try-again"
          >
            <RefreshCw size={24} aria-hidden="true" />
            {AGENT_HOME_COPY.tryAgain}
          </button>
        }
      >
        {/* No history links here: nothing is known about this account yet, so pointing at
            another read of the same backend is an invitation to a second failure. */}
        <p className={styles.lone} role="alert">{AGENT_HOME_COPY.errorBody}</p>
      </HomeFrame>
    );
  }

  const list = state.assignments;

  if (list.length === 0) {
    return (
      <HomeFrame {...frame} screen={{ kind: 'none' }} firstName={firstName} footLeft={exit}>
        <p className={styles.lone}>{AGENT_HOME_COPY.noneBody}</p>
        {/* Offered even here, and deliberately. An agent taken off every list still has a
            shift behind them, and this is otherwise the one screen they can reach. */}
        <SurfaceNav />
      </HomeFrame>
    );
  }

  /**
   * One list and nothing to say about it ⇒ go. The `arrival` guard is what stops the
   * redirect firing again on the way OUT of a station: Finish work navigates here with
   * `?left=station`, the assignment is unchanged, and without the check the agent could
   * never get out. `canEnter` is checked too, so an agent whose one list is stopped lands
   * on the tiles and reads why, instead of being bounced into the station's refusal.
   */
  if (redirectTo) return <Navigate to={redirectTo} replace />;

  return (
    <HomeFrame
      {...frame}
      screen={{ kind: 'list', arrival, count: list.length }}
      firstName={firstName}
      footLeft={exit}
      footHint={listenLine}
    >
      <ul className={styles.tiles} data-testid="work-tiles">
        {list.map((assignment) => (
          <WorkTileCard
            key={assignment.campaign_id}
            tile={workTile(assignment)}
            callLater={callLaterLine(callLaters[assignment.campaign_id])}
          />
        ))}
      </ul>
      {list.length > 1 ? <p className={styles.oneAtATime}>{AGENT_HOME_COPY.oneAtATime}</p> : null}
      <SurfaceNav />
    </HomeFrame>
  );
}

/** Where a visit goes straight to: the one list there is, when it can be opened and nothing else was said. */
function redirectTarget(assignments: AgencyAssignment[], arrival: ReturnType<typeof agentLandingArrival>): string | null {
  const only = assignments.length === 1 ? assignments[0]! : null;
  if (only && arrival === null && assignmentEntry(only.campaign_status).canEnter) return stationPath(only.campaign_id);
  return null;
}

/** The station's frame around every screen of this page: top bar, band, body, footer. */
function HomeFrame({
  agentName,
  brandMark,
  screen,
  firstName,
  children,
  footLeft,
  footRight,
  footHint,
}: {
  agentName: string;
  brandMark: string;
  screen: HomeScreen;
  firstName: string | null;
  children: ReactNode;
  footLeft?: ReactNode;
  footRight?: ReactNode;
  footHint?: ReactNode;
}) {
  return (
    <StationFrame
      view={homeBand(screen, firstName)}
      agentName={agentName}
      workName={null}
      brandMark={brandMark}
      bodyClassName={styles.body}
      footLeft={footLeft}
      footRight={footRight}
      footHint={footHint}
      testId="agent-home"
    >
      {children}
    </StationFrame>
  );
}

const STATUS_ICONS: Record<WorkStatus['icon'], typeof Phone> = {
  phone: Phone,
  pause: Pause,
  clock: Clock,
  stop: OctagonX,
  check: CircleCheck,
};

/**
 * One list, as a big tile: its name, what it is doing, the agent's call-laters today, and its
 * one way in. The whole tile is the link (a big target, spec §6.7), named "Open <list>" with the
 * status read as its description. A list that can never send a call (stopped, completed) keeps
 * its tile with no way in (AS1: hidden, not greyed), its line saying why.
 */
function WorkTileCard({ tile, callLater }: { tile: WorkTile; callLater: string | null }) {
  const id = useId();
  const StatusIcon = tile.status ? STATUS_ICONS[tile.status.icon] : null;
  const described = [tile.status ? `${id}-status` : null, callLater ? `${id}-later` : null].filter(Boolean).join(' ');
  const inner = (
    <>
      <span className={styles.tileName} data-testid="work-tile-name">{tile.name}</span>
      {tile.status && StatusIcon ? (
        <span className={styles.tileStatus} data-tone={tile.status.tone} id={`${id}-status`} data-testid="work-tile-status">
          <StatusIcon size={20} aria-hidden="true" />
          {tile.status.line}
        </span>
      ) : null}
      {callLater ? (
        <span className={styles.tileLater} id={`${id}-later`} data-testid="work-tile-call-later">
          <CalendarClock size={18} aria-hidden="true" />
          {callLater}
        </span>
      ) : null}
    </>
  );
  if (!tile.canOpen) {
    return (
      <li className={styles.tile} data-closed="true" data-testid="work-tile">
        {inner}
      </li>
    );
  }
  return (
    <li className={styles.tileItem} data-testid="work-tile">
      <Link
        className={styles.tile}
        to={stationPath(tile.campaignId)}
        aria-label={AGENT_HOME_COPY.openLabel(tile.name)}
        aria-describedby={described || undefined}
        data-testid="work-tile-open"
      >
        {inner}
        <span className={styles.tileGo} aria-hidden="true">
          {AGENT_HOME_COPY.open}
          <ArrowRight size={22} />
        </span>
      </Link>
    </li>
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
 * tiles, at the weight the links already had — the tiles own the only primary
 * action, and the chooser is no busier than it was.
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
 * The way back for someone who has a console to go back to: a `viewer` or `operator`.
 * It opens the campaign list, which is where `/agency` lands them (`agencyLandingPath`),
 * inside the console shell (decision B28). It used to read "Go to settings" (B17's
 * wording) and open Profile and appearance, which is not where anybody leaving the
 * dialler wants to be. `AgentLanding` will not bounce them: it gates on
 * `isDedicatedAgent`, which is false for exactly the roles that see this link.
 */
function ExitToPlatform() {
  return (
    <Link className={`${stationStyles.btn} ${stationStyles.btnQuiet}`} to={CAMPAIGNS_LANDING_PATH}>
      {AGENT_HOME_COPY.openConsole}
    </Link>
  );
}

/**
 * `?campaign=` stays canonical.
 *
 * `/station` alone lands on `AgentConsolePage`'s "No campaign selected." refusal.
 * A station IS an agent joined to one campaign's pool, so there is no
 * campaign-less station to link to — the same reasoning that keeps a bare
 * `/station` link out of the console sidebar.
 */
function stationPath(campaignId: string): string {
  return `/station?campaign=${encodeURIComponent(campaignId)}`;
}

export default AgentHomePage;
