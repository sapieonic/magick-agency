import { Navigate } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { agencyPersona } from '../../utils/agencyPersona';

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
 * Now the two personas land where their job is:
 *
 *  - **supervisor** → the campaign list. Setting campaigns up and watching them is
 *    the job, and every campaign's own page carries its health strip, performance
 *    readouts and agent floor.
 *  - **agent** → `/dialer`, the agent home: the campaigns they are staffed on and
 *    the way into each.
 *
 * ── Why the agent is sent OUT of this shell rather than served inside it ────
 * `AgencyLayout`'s three nav entries floor at `viewer` or above, so an agent
 * renders its chrome — sidebar, switchers, "Team & settings" — around nothing
 * at all. That is the same empty-shell problem `AgentLanding` exists to prevent at
 * `/app`, and the answer is the same: full-viewport, outside every shell. See
 * `AgentHomePage`.
 *
 * A redirect rather than rendering `AgentHomePage` here, so the agent home has ONE
 * URL. An agent who bookmarks where they land gets `/dialer` — the address they
 * were given — instead of `/agency`, which would put them back inside this shell
 * on the next visit.
 */
export function AgencyHomeRedirect() {
  const { role } = useTenant();
  const persona = agencyPersona(role);

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
   *     `GET /proxy/feature-flags`, which needs a resolved `accountId`, and master
   *     403s that request unless `tenantContextMiddleware` finds an active
   *     membership for `(tenant, account)` by the same two rules this file's
   *     `role` uses — the account-scoped row, else the tenant-wide one
   *     (`master/src/api/middleware/tenant-context.middleware.ts`). If master
   *     found one, `role` is defined. The reverse is what would break it: a
   *     membership written AFTER this session's `POST /auth/session` is in
   *     master's DB but not in `useAuth().memberships`, so master answers and
   *     cusui still reads `undefined` until the session is re-synced. That
   *     staleness window, or `/agency` losing the flag gate, is what would make
   *     this reachable.
   *  2. **It would not be a trap if it were.** This route is `<Route index>`
   *     inside `AgencyLayout`, so the spinner renders in the shell's outlet, with
   *     "Team & settings" beside it. That is the difference from the trap
   *     `HomeRedirect` had to bound: `/` renders no chrome at all, so a spinner
   *     there has no sign-out in it.
   *
   * A guard on `accountResolution !== 'loading'` would bound the wait, and is the
   * fix if this ever does become reachable. It is not written now because there is
   * no demonstrated path to it, and a redirect out of this shell on an
   * unresolvable role would be a new behaviour justified by nothing.
   */
  if (persona === null) return <LoadingSpinner />;

  return <Navigate to={persona === 'supervisor' ? '/agency/campaigns' : '/dialer'} replace />;
}

export default AgencyHomeRedirect;
