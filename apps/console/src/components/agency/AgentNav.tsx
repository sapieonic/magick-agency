import { Link } from 'react-router-dom';
import { ChartNoAxesCombined, ListChecks, PhoneOutgoing } from 'lucide-react';
import { AGENT_SURFACES, type AgentSurfaceId } from '../../utils/agencyAgentSurfaces';
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
  performance: ChartNoAxesCombined,
  attempts: PhoneOutgoing,
};

export function AgentNav({ current }: { current: AgentSurfaceId }) {
  return (
    <nav className={styles.nav} aria-label="Your screens">
      {AGENT_SURFACES.map((surface) => {
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

        return (
          <Link
            key={surface.id}
            className={styles.item}
            to={surface.to}
            data-testid={`agent-nav-${surface.id}`}
            data-current="false"
          >
            <Icon size={15} aria-hidden="true" />
            {surface.label}
          </Link>
        );
      })}
    </nav>
  );
}
