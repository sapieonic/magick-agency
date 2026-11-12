import { Navigate } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { agencyLandingPath } from '../../utils/consoleNav';

/**
 * Where `/agency` goes — which depends on who opened it.
 *
 * ── What it replaces ────────────────────────────────────────────────────────
 * `<Route index element={<Navigate to="/agency/campaigns" replace />} />`. One
 * destination for everybody, and wrong for half of them: `/agency/campaigns` reads
 * the campaign list, which floors at `agency.campaigns.read` (`viewer`, 10). An
 * `agent` is level 5 and 403s on it, so the one role the dialer was built for
 * opened the dialer's own workspace and got a permission error.
 *
 * Now each lands where their job is (`agencyLandingPath`):
 *
 *  - **supervisor** → Home (`/agency/home`, B28): what needs them now, the floor
 *    and today so far, across every live campaign. Whoever passes Home's gate
 *    (`canSeeHome`, `agency.supervise`) lands there, so an account switch, which is a
 *    full page load at the new account's home, lands there too.
 *  - **dedicated agent** (`agent`) → `/dialer`, the agent home: the campaigns they
 *    are staffed on and the way into each.
 *  - **viewer and operator** → the campaign list, inside the console. They read it
 *    (`agency.campaigns.read` floors at `viewer`) and hold no `agency.supervise`, so
 *    Home is not theirs. They used to land on `/dialer`, outside the shell, whose
 *    only way out opened Profile and appearance; `/dialer` still serves them, and a
 *    campaign page's "Join as agent" opens its station.
 *
 * ── Why the agent is sent OUT of this shell rather than served inside it ────
 * The console shell's work entries floor at `viewer` or above, so an agent
 * renders its chrome — sidebar, switchers, Settings — around nothing
 * at all. That is the same empty-shell problem `AgentLanding` exists to prevent on
 * Settings and `/app`, and the answer is the same: full-viewport, outside every shell. See
 * `AgentHomePage`.
 *
 * A redirect rather than rendering `AgentHomePage` here, so the agent home has ONE
 * URL. An agent who bookmarks where they land gets `/dialer` — the address they
 * were given — instead of `/agency`, which would put them back inside this shell
 * on the next visit.
 */
export function AgencyHomeRedirect() {
  const { role } = useTenant();
  const landing = agencyLandingPath(role);

  /**
   * `role` is `undefined` for the moment `TenantContext` takes to resolve a
   * membership. Redirecting on that would send every agent to the supervisor's
   * campaign list for one frame and then bounce them — two navigations and a flash
   * of a 403. A spinner is honest and this is the one route where waiting costs
   * nothing, since it renders no content of its own either way.
   *
   * ── Reviewed as a possible permanent spinner, and left as it is ───────────
   * `HomeRedirect` at `/` can now send a reader here automatically, which is the
   * first thing that routes anybody to `/agency` without them clicking it — so
   * "what if `role` never resolves" stopped being hypothetical and was checked.
   * Two reasons it stands:
   *
   *  1. **The branch is not reachable with an unresolved role.** `/agency` sits
   *     inside `RequireFlag flag="agency_dialer_enabled"`, which renders children
   *     only on `status === 'ready'` with the flag true. That needs a successful
   *     `GET /proxy/feature-flags`, which needs a resolved `accountId`, and the server
   *     403s that request unless `tenantContextMiddleware` finds an active
   *     membership for `(tenant, account)` by the same two rules this file's
   *     `role` uses — the account-scoped row, else the tenant-wide one
   *     (`tenantContextMiddleware`). If the server
   *     found one, `role` is defined. The reverse is what would break it: a
   *     membership written AFTER this session's `POST /auth/session` is in
   *     the server's DB but not in `useAuth().memberships`, so the server answers and
   *     the console still reads `undefined` until the session is re-synced. That
   *     staleness window, or `/agency` losing the flag gate, is what would make
   *     this reachable.
   *  2. **It would not be a trap if it were.** This route is `<Route index>`
   *     inside the console shell, so the spinner renders in the shell's outlet, with
   *     the sidebar and the profile menu's sign-out around it. That is the difference from the trap
   *     `HomeRedirect` had to bound: `/` renders no chrome at all, so a spinner
   *     there has no sign-out in it.
   *
   * A guard on `accountResolution !== 'loading'` would bound the wait, and is the
   * fix if this ever does become reachable. It is not written now because there is
   * no demonstrated path to it, and a redirect out of this shell on an
   * unresolvable role would be a new behaviour justified by nothing.
   */
  if (landing === null) return <LoadingSpinner />;
  return <Navigate to={landing} replace />;
}

export default AgencyHomeRedirect;
