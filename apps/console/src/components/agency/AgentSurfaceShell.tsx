import type { ReactNode } from 'react';
import { useTenant } from '../../contexts/TenantContext';
import { agencyPersona } from '../../utils/agencyPersona';
import { AgentNav } from './AgentNav';
import type { AgentSurfaceId } from '../../utils/agencyAgentSurfaces';
import { AccountUnavailable } from '../common/AccountUnavailable';
import { LoadingSpinner } from '../common/LoadingSpinner';
import styles from './AgentSurfaceShell.module.css';

/**
 * The frame every full-viewport agent-facing surface outside both shells shares —
 * "My performance" at `/dialer/performance` and "My calls" at `/dialer/attempts`.
 *
 * ── Why these pages have no shell, and therefore need this one ─────────────
 * An `agent` is hierarchy level 5 and inherits no navigation. `AppLayout`'s nav
 * floors at `viewer` (10) and every entry in `AgencyLayout` floors at `viewer` or
 * above, so either shell would render its chrome around nothing — §A.1's *"that is
 * not navigation, it is noise"*. `/station` and `/dialer` sit outside both for the
 * same reason, and these two sit beside them.
 *
 * That leaves a page with no chrome at all, which is the trap `DialerUnavailable`
 * exists to document: a full-viewport screen with no navigation and no link is a
 * dead end. So this component supplies the small amount of frame those pages do
 * need — a heading, and `AgentNav`: every screen the agent has, on every screen
 * the agent has — once, rather than twice with two headers that drift.
 *
 * ── The nav replaced a `back` link and a `siblings` list ──────────────────
 * Those were per-page props, so what an agent could reach depended on which page
 * they were standing on and no screen ever showed the whole set. `AgentNav`
 * renders `AGENT_SURFACES` identically everywhere and marks the current one, so
 * the frame answers "where am I" and "what else is there" rather than only
 * "how do I get back". Callers name their surface; they no longer author links.
 *
 * ── The way out is a link, and on THESE pages that is safe ────────────────
 * The station deliberately has no escape route: navigating away drops the station
 * socket, and for up to 45 seconds afterwards core still believes the agent is in
 * the dialable pool, so a reservation landing in that window bridges a customer to
 * nobody (`agencyStationExit.ts`). **Neither page that uses this shell holds a
 * socket or a session.** So the nav is ordinary navigation here. Nothing that
 * uses this component may ever be mounted inside the console — inside it, these
 * same destinations must open in a new tab (`STATION_HISTORY_LINKS`).
 *
 * ── The account-resolution trap, guarded once instead of twice ────────────
 * An `agent` is below `account.read`'s `viewer` floor, so `GET /accounts` 403s for
 * them; and a request sent before `TenantContext` resolves carries no
 * `X-Account-Id`, which core answers with a 400 that has nothing to do with the
 * data. So every read on these pages waits for BOTH ids — and "resolution settled
 * but there is no account" must be an ERROR STATE rather than a spinner, because
 * with no account nothing is in flight and nothing will fire again.
 *
 * `AgentHomePage`, `RequireFlag` and `AgencyAnalyticsPage` each carry this guard
 * separately, and **all three got it wrong first** — which is the argument for it
 * living here rather than being copied a fourth time. A page built on this shell
 * cannot ship the permanent spinner, because the shell refuses to render its
 * children without an account.
 *
 * ── The persona spinner is not the same check ─────────────────────────────
 * `TenantContext` fills `role` in asynchronously, so a refusal keyed on the role
 * would flash for one frame on every cold sign-in — and a refusal shown for one
 * frame is a refusal the user remembers. `persona === null` therefore spins.
 * It does NOT hold the reads back: children mount as soon as both ids resolve, so
 * an agent's first paint is not delayed by a round trip to spare a role below the
 * station floor — which does not exist today — a single 403. `AgentLanding` makes
 * the same trade for the same reason.
 */

export interface AgentSurfaceShellProps {
  icon: ReactNode;
  title: string;
  /** One line on what this page is, in the second person. */
  subtitle: string;
  /**
   * Which of `AGENT_SURFACES` this page is. Drives `AgentNav`'s current entry —
   * and is the whole of what a caller says about navigation now.
   *
   * This replaced a `back` link plus a `siblings` list, both authored per page.
   * Those let each surface decide what its neighbours were, which is how an
   * agent ended up able to reach everything only from the right starting point.
   * A caller naming itself cannot produce that: the set of destinations is
   * `AGENT_SURFACES`, identical everywhere, and the only per-page fact is which
   * one is current. See the header: safe here, never on the station.
   */
  current: AgentSurfaceId;
  /**
   * Shown to a supervisor who is SERVED one of these pages rather than sent to it.
   *
   * Wrapped here so both pages say it in the same voice and carry the same test
   * id. A supervisor who opens their own agent surface and finds their own eleven
   * calls will otherwise conclude the dialer has lost their team's numbers.
   */
  note?: ReactNode;
  children: ReactNode;
}

export function AgentSurfaceShell({
  icon,
  title,
  subtitle,
  current,
  note,
  children,
}: AgentSurfaceShellProps) {
  const { role, accountId, accountResolution, accountError, reloadAccounts } = useTenant();
  const persona = agencyPersona(role);

  /** Nobody the dialer has a place for — far more often, a role that has not
      resolved yet. A spinner rather than a refusal; see the header. */
  if (persona === null) {
    return (
      <div className={styles.shell}>
        <div className={styles.centred}>
          <LoadingSpinner />
        </div>
      </div>
    );
  }

  /**
   * An account that could not be resolved is not a slow account. The second
   * clause is not decoration — resolution can settle without producing an account
   * (a tenant with zero accounts, or a `'degraded'` fallback whose narrowed list
   * came back empty) and nothing fires again.
   */
  if (accountResolution === 'error' || (accountResolution !== 'loading' && accountId === null)) {
    return <AccountUnavailable detail={accountError} onRetry={reloadAccounts} />;
  }

  return (
    <div className={styles.shell}>
      <div className={styles.page}>
        <header className={styles.header}>
          <div className={styles.headerMain}>
            <span className={styles.icon} aria-hidden="true">
              {icon}
            </span>
            <div>
              <h1 className={styles.title}>{title}</h1>
              <p className={styles.subtitle}>{subtitle}</p>
            </div>
          </div>

          {/*
            Below the heading rather than beside it, which is where the old back
            and sibling links sat. Three pills do not fit next to a title at a
            narrow width without either wrapping into the heading's line box or
            squeezing it, and this is the one piece of chrome these pages have —
            it should not be the piece that degrades first.

            The placement lives in `.header` (`flex-direction: column`), NOT here.
            Worth knowing, because this comment once described a column while the
            stylesheet still said row: the rule was written for the two text links
            this replaced and nothing about a flex row stops compiling when its
            second child grows.
          */}
          <AgentNav current={current} />
        </header>

        {note && (
          <p className={styles.note} data-testid="supervisor-note">
            {note}
          </p>
        )}

        {children}
      </div>
    </div>
  );
}

export default AgentSurfaceShell;
