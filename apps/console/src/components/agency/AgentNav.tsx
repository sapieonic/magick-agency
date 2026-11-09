import { useId } from 'react';
import { Link } from 'react-router-dom';
import { AppVersion } from '@magick-agency/web-ui/components/AppVersion';
import { ChartNoAxesCombined, FileText, ListChecks, Phone, PhoneIncoming, PhoneOutgoing, Search } from 'lucide-react';
import { agentSurfacesFor, type AgentSurfaceId } from '../../utils/agencyAgentSurfaces';
import { useTenant } from '../../contexts/TenantContext';
import { hasPermission } from '../../utils/permissions';
import { SOFTPHONE_FLAG, useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { INBOUND_FLAG } from '../../utils/inbound/inboundFlag';
import { useReportsAccess } from '../../hooks/useReportsAccess';
import styles from './AgentNav.module.css';

/**
 * The agent's map — every screen they have, on every screen they have.
 *
 * ── What this replaces ─────────────────────────────────────────────────────
 * Each agent surface used to carry a hand-written way back and, sometimes, one
 * sibling link: `/dialer` offered "See how I'm doing" and "See my calls",
 * `/dialer/performance` offered "My calls" and a back link, `/dialer/attempts`
 * the mirror of it. Three lists, maintained separately, none of them saying what
 * the whole set was. An agent could reach everything only by knowing where to
 * stand, and nothing on any screen told them the third one existed.
 *
 * A `<nav>` of plain `Link`s, deliberately not `role="tablist"` — these are page
 * navigations, not tabs over one region — and deliberately not `NavLink`, whose
 * default prefix matching would mark `/dialer` current on `/dialer/attempts`
 * too. The current surface is passed in rather than read from the router,
 * because every one of these pages already knows which it is and a component
 * that guesses from `useLocation` would be a second, weaker answer.
 *
 * ── The current entry is rendered, not linked ──────────────────────────────
 * A link to the page you are on is a control that does nothing, and here it
 * would do something slightly worse than nothing: `/dialer` redirects an agent
 * with one enterable assignment into their station, so a "My campaigns" link
 * pressed while already on `/dialer` is a link that sometimes navigates into a
 * call. It renders as a labelled `aria-current="page"` span instead.
 */

const ICONS: Record<AgentSurfaceId, typeof ListChecks> = {
  campaigns: ListChecks,
  phone: Phone,
  performance: ChartNoAxesCombined,
  attempts: PhoneOutgoing,
  customers: Search,
  reports: FileText,
  missed: PhoneIncoming,
};

/**
 * The caller's role, failing closed (`undefined`) with no provider above, the same
 * reasoning as `useFeatureFlagEnabled`: `useTenant` reads its context before it
 * throws, so the hook order is stable.
 */
function useRoleOrNone(): ReturnType<typeof useTenant>['role'] {
  try {
    return useTenant().role;
  } catch {
    return undefined;
  }
}

/** Whether this caller may search customer history (`agency.customer_history.read`, CH1). */
export function useCustomerHistoryAvailable(): boolean {
  return hasPermission(useRoleOrNone(), 'agency.customer_history.read');
}

/** Whether this caller gets "Missed calls": `agency_inbound_enabled` on for the account, and `agency.inbound.read`. */
export function useMissedCallsAvailable(): boolean {
  const role = useRoleOrNone();
  const flagOn = useFeatureFlagEnabled(INBOUND_FLAG);
  return flagOn && hasPermission(role, 'agency.inbound.read');
}

/** Whether this caller gets the soft phone: the flag on for the account, and `agency.softphone.dial`. */
export function useSoftphoneAvailable(): boolean {
  const role = useRoleOrNone();
  const flagOn = useFeatureFlagEnabled(SOFTPHONE_FLAG);
  return flagOn && hasPermission(role, 'agency.softphone.dial');
}

export function AgentNav({
  current,
  variant = 'pills',
  lockedReason = null,
  leaveHint = null,
}: {
  current: AgentSurfaceId;
  /** `header`: the compact row in the soft phone's header bar, with no version label. */
  variant?: 'pills' | 'header';
  /**
   * Set while leaving would cut a customer off (a soft-phone call that is live or
   * owes its outcome): the other entries render as text with this as their
   * reason instead of as links, so the page cannot be navigated away under a call.
   */
  lockedReason?: string | null;
  /**
   * What following a link leaves behind (the soft phone, still open): read as
   * each link's description, so it is heard before the agent goes, and shown as
   * its tooltip. Ignored while `lockedReason` is set.
   */
  leaveHint?: string | null;
}) {
  const softphone = useSoftphoneAvailable();
  const customers = useCustomerHistoryAvailable();
  // "My reports": the reports flag on and the caller can open a station (their own
  // review is the one report they may run, RP5). Fails closed without the providers.
  const reportsAccess = useReportsAccess();
  const reports = reportsAccess.enabled && reportsAccess.canSelf;
  const hintId = useId();
  const hint = lockedReason ? null : leaveHint;
  const missed = useMissedCallsAvailable();
  const surfaces = agentSurfacesFor({ softphone, customers, reports, missed });
  return (
    <nav className={variant === 'header' ? styles.headerNav : styles.nav} aria-label="Your screens">
      {surfaces.map((surface) => {
        const Icon = ICONS[surface.id];
        const active = surface.id === current;

        if (active) {
          return (
            <span
              key={surface.id}
              className={`${styles.item} ${styles.current}`}
              aria-current="page"
              data-testid={`agent-nav-${surface.id}`}
              data-current="true"
            >
              <Icon size={15} aria-hidden="true" />
              {surface.label}
            </span>
          );
        }

        if (lockedReason) {
          return (
            <span
              key={surface.id}
              className={`${styles.item} ${styles.locked}`}
              aria-disabled="true"
              title={lockedReason}
              data-testid={`agent-nav-${surface.id}`}
              data-current="false"
              data-locked="true"
            >
              <Icon size={15} aria-hidden="true" />
              {surface.label}
            </span>
          );
        }

        return (
          <Link
            key={surface.id}
            className={styles.item}
            to={surface.to}
            title={hint ?? undefined}
            aria-describedby={hint ? hintId : undefined}
            data-testid={`agent-nav-${surface.id}`}
            data-current="false"
          >
            <Icon size={15} aria-hidden="true" />
            {surface.label}
          </Link>
        );
      })}
      {/* These pages have no sidebar to carry it, and agents are the ones who report from the
          field. Not a link, so it adds nothing to the tab order. The soft phone's header
          carries its own. */}
      {variant === 'pills' ? <AppVersion version={__APP_VERSION__} variant="inline" /> : null}
      {hint ? (
        <span id={hintId} hidden>
          {hint}
        </span>
      ) : null}
    </nav>
  );
}
