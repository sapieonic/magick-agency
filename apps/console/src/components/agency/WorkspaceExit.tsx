import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

/**
 * The one sanctioned way out of the agency shell and into `/app`.
 *
 * In this console `/app` is the platform zone — Team, Notifications, Call
 * summaries — and nothing in the console links out of Magick Agency. The default
 * wording is "Go to settings".
 *
 * ── Why a component for a one-line `<Link>` ─────────────────────────────────
 * This wraps nothing that `<Link to="/app">` does not already do. It exists so
 * that the *string* `/app` has exactly one home in agency code, which is what
 * makes the boundary mechanically checkable:
 * `src/__tests__/utils/agencyShellBoundary.test.ts` walks `src/pages/agency/`,
 * `src/components/agency/` and `src/pages/campaigns/agency/`, strips comments,
 * and fails if a `/app` route literal survives anywhere but this file. Without a
 * single sanctioned home there is nothing to exempt, so the guard would have to
 * be a reviewer's memory — and prose alone does not hold a boundary: an earlier
 * attempt was enforced only by a reviewer's comment, and it leaked.
 *
 * ── What the guard is actually protecting, and what it is NOT ───────────────
 * The leak it caught was agency pages deep-linking into the platform's call
 * history — a row in a campaign's attempts list pointing at
 * `/app/calls/dialer/history/:id`, for instance. That is a bug even when the data
 * on the far side is correct, because `/app` is a different shell: the reader is
 * thrown out of `AgencyLayout` into `AppLayout`, loses the campaign they were
 * reading, and — for the levels that make up most of the agency's staff — often
 * lands on a capability refusal or on an empty sidebar with no way back. A link
 * that crosses shells is a bug even when the data it lands on is correct,
 * because it strands the reader outside the context they were working in.
 *
 * **`/app` is not, however, off limits.** There are three zones, not two, and the
 * third is the one that gets misread: team and membership (including inviting
 * agents), the tenant audit log, settings, and tenant/account switching are
 * **platform** surfaces. They live at `/app` and living there is *not* a boundary
 * violation. The test for an ambiguous surface is whether it describes **calls**
 * or describes the **tenant**: call-shaped things belong to the agency shell;
 * tenant-shaped things stay in the platform zone.
 *
 * So the deliberate exits out of the agency shell are correct and must survive.
 * `AgencyLayout` holds no team and no settings on purpose and links back to
 * `/app` for them; a pure-agency supervisor legitimately administers in `/app`
 * and operates in `/agency`. Cloning team into the agency shell, purging agency
 * events from the tenant audit log, or deleting these exits would all be
 * over-application of the boundary rather than compliance with it.
 * This component is how those exits stay expressible: it does not remove them,
 * it makes them the *only* ones, and it makes each one announce itself as a
 * deliberate departure rather than read as an ordinary in-shell link.
 *
 * ── Deliberately presentational ────────────────────────────────────────────
 * No styling of its own, no default className, no icon, no confirmation, no
 * telemetry. Every existing call site owns its own appearance through
 * `className` and its own wording through `children`, so adopting this component
 * is a pure refactor with identical rendered output — an exit that changed
 * how it looked the day it became sanctioned would have made the refactor
 * reviewable only by eye. Anything the call sites turn out to share belongs here
 * later; nothing is hoisted speculatively.
 *
 * `to` is a prop, defaulting to `/app`, because the platform zone has several
 * doors — the team page, settings — and a caller that needs
 * one of them must not have to reach for a raw `<Link>` to get it. Passing a
 * path outside the platform zone (`/app/calls/...`, `/app/campaigns/...`) is the
 * violation this file exists to stop and slips past the guard by construction,
 * so keep the destination tenant-shaped.
 */
export interface WorkspaceExitProps {
  /**
   * Where in the platform zone to land. Defaults to `/app`.
   *
   * Keep it tenant-shaped — team, credits, billing, settings, audit log. A
   * call-shaped `/app/...` path is the cross-shell link the guard exists to
   * prevent, and routing it through this component only hides it.
   */
  to?: string;
  /** Passed straight through, so the call site keeps its exact appearance. */
  className?: string;
  /**
   * The link's contents — text, or an icon beside text. Defaults to
   * "Go to settings": the platform zone is where Team, Notifications and Call
   * summaries live.
   */
  children?: ReactNode;
}

export function WorkspaceExit({
  to = '/app',
  className,
  children = 'Go to settings',
}: WorkspaceExitProps) {
  return (
    <Link className={className} to={to}>
      {children}
    </Link>
  );
}

export default WorkspaceExit;
