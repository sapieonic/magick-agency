import type { ReactNode } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { useGovernance } from '../../contexts/GovernanceContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { isDedicatedAgent } from '../../utils/agencyPersona';
import { AGENT_LANDING_PARAM, agentLandingArrival } from '../../utils/agencyStationExit';

/**
 * Keeps a DEDICATED agent out of `AppLayout`, and sends them to the dialer.
 *
 * ── The problem this is the whole answer to ─────────────────────────────────
 * An `agent` is hierarchy level 5 and holds four `agency.*` permissions and
 * nothing else. Every nav entry in `AppLayout` floors at `viewer` or higher, so an
 * agent who reaches `/app` gets a shell with an empty sidebar around a dashboard
 * of empty panels — §A.1: *"an `agent` … inherits nothing … that is not
 * navigation, it is noise"*.
 *
 * So this wraps `/app`'s element rather than adding a nav link, which is what
 * makes it apply to every `/app/*` path an agent could reach — including the
 * catch-all redirect at the bottom of `App.tsx`, and `HomeRedirect` at `/`, which
 * is where a bare `/` now lands (it used to fall through to that catch-all). Both
 * ways in are covered because the wrapper is on the shell, not on a route.
 *
 * ── Two guards, and BOTH exist because of a regression this file shipped ────
 * A previous revision gated on `agencyPersona(role) === 'agent'`. Because the
 * agent permissions floor at level 5, that predicate is true for `viewer` (10) and
 * `operator` (20) as well — so this component redirected them out of `/app` too.
 * `/dialer` is gated on the `agency` capability, which master's frozen catalog
 * defaults to `false`, so in every tenant that had not bought the dialer those two
 * roles landed on a full-viewport "not available for your account" with no
 * sidebar, no link out, and (logout living only in `TopBar`, inside `AppLayout`)
 * no way to even sign out. Every route back re-entered this component. A `viewer`
 * holds around twenty read permissions; an `operator` runs calls and schedules.
 * Both lost the entire product.
 *
 * Hence:
 *
 * 1. **`isDedicatedAgent`, not the persona.** The question here is not "which
 *    agency job is this person" but "does this person have any navigation to
 *    lose". Only a role below the `viewer` floor answers yes. See
 *    `utils/agencyPersona.ts`, where the two predicates are kept deliberately
 *    apart.
 *
 * 2. **The dialer must actually be reachable before we send anyone to it.** Even
 *    for a dedicated agent, redirecting into a gate that will refuse produces a
 *    dead end rather than a landing page — and `AppLayout`, empty sidebar and all,
 *    is strictly better than that: it has a top bar, so it has a sign-out. A
 *    redirect is only ever an improvement when there is something on the other
 *    side of it.
 *
 * Everyone else renders `AppLayout` untouched, and nothing here fetches for them.
 */
export function AgentLanding({ children }: { children: ReactNode }) {
  const { role } = useTenant();
  const [params] = useSearchParams();
  const { isEnabled: capabilityEnabled, loading: governanceLoading } = useGovernance();
  const { isEnabled: flagEnabled, status: flagStatus } = useFeatureFlags();

  /**
   * `role` is `undefined` for the moment `TenantContext` takes to resolve a
   * membership, so the shell does render in that window on a cold sign-in.
   * Deliberately not gated on it: holding every user's first paint to spare an
   * agent a flash of an empty sidebar is the worse trade.
   */
  if (!isDedicatedAgent(role)) return <>{children}</>;

  /**
   * Wait, rather than guess, while either gate is still resolving.
   *
   * Guessing "enabled" flashes the dialer and bounces back on a refusal; guessing
   * "disabled" flashes the empty shell. Both resolve in one request and this is the
   * only role that sees either, so a brief shell is the cheaper wrong answer —
   * which is what falling through to `children` gives us.
   */
  if (governanceLoading || flagStatus === 'loading') return <>{children}</>;

  /**
   * The dialer is off for this tenant. Render the shell: it is nearly empty for an
   * agent, but it has a top bar and therefore a way out and a way to sign out,
   * which the capability screen at `/dialer` does not.
   *
   * **The shell is no longer silent about it.** This branch used to hand an agent
   * an empty sidebar around a dashboard of empty panels with no explanation
   * anywhere — which reads as a broken product rather than an unbought one, and is
   * indistinguishable, to the agent and to the supervisor who invited them, from a
   * bug. `DashboardPage` now recognises this exact state and renders
   * `DialerUnavailable` in the dashboard's place.
   *
   * The check is repeated there rather than the message being rendered from here,
   * and that is deliberate: the notice has to appear INSIDE `AppLayout` to keep the
   * top bar this branch exists to preserve, and this component sits above the
   * layout wrapping it rather than filling it. Both predicates read the same two
   * gates through the same two contexts, so they cannot disagree about whether the
   * dialer is on — only about where the answer is drawn.
   */
  if (!capabilityEnabled('agency') || !flagEnabled('agency_dialer_enabled')) {
    return <>{children}</>;
  }

  /**
   * The arrival is forwarded rather than dropped. `?left=station` and
   * `?left=refused` are how the console says "do NOT send them straight back in",
   * and `AgentHomePage` is where that is now honoured — so losing the param here
   * would put an agent who just pressed Leave back into the station they left.
   *
   * Validated through `agentLandingArrival` rather than passed through raw, so junk
   * in the URL cannot travel any further than this component.
   */
  const arrival = agentLandingArrival(params.get(AGENT_LANDING_PARAM));
  const to = arrival ? `/dialer?${AGENT_LANDING_PARAM}=${arrival}` : '/dialer';

  return <Navigate to={to} replace />;
}

export default AgentLanding;
