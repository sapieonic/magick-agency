import { Link } from 'react-router-dom';
import { Headset } from 'lucide-react';
import styles from './DialerUnavailable.module.css';

/**
 * What a dedicated `agent` is told when the Agency Dialer is off for their tenant.
 *
 * ── The silence this replaces ───────────────────────────────────────────────
 * `AgentLanding` redirects a dedicated agent to `/dialer`, but only once both
 * entitlement gates resolve on: master's `agency` capability and core's
 * `agency_dialer_enabled` flag. **Both default off**, and neither can be turned on
 * from inside the product — the capability is a super-admin governance override
 * and the flag is core's.
 *
 * With either off, `AgentLanding` deliberately falls through to `AppLayout`, and
 * its docstring is right about why: the full-viewport capability screen at
 * `/dialer` has no top bar and therefore no sign-out, so stranding an agent there
 * is worse than the shell. But an `agent` is hierarchy level 5 and inherits no
 * navigation, so what that shell rendered was an empty sidebar around a dashboard
 * of empty panels — **with nothing anywhere saying why**. Every agent we onboarded
 * before the tenant was switched on saw a product that looked broken, and the
 * supervisor who invited them had no way to tell that from a bug.
 *
 * So the fall-through stays (the sign-out is worth keeping) and this fills the hole
 * in it: same shell, same top bar, but the dashboard slot says what is wrong and
 * who fixes it.
 *
 * ── Why it names the administrator rather than offering a retry ─────────────
 * An agent holds four `agency.*` permissions and nothing else. They cannot read
 * the governance map, cannot set an override, and cannot touch a feature flag. A
 * "try again" here would be an instruction to repeat something that cannot work —
 * the same reasoning `AgentHomePage` applies to "you're not assigned to a campaign
 * yet", and the same house rule its disabled affordances follow: a dead end must
 * say who can open it.
 *
 * It deliberately does **not** distinguish the capability from the flag. Which of
 * the two is off is a fact about our rollout, not about this person's day, and both
 * have the same remedy: ask the administrator. Naming them would leak
 * implementation vocabulary into the one screen read by the people least equipped
 * to act on it.
 *
 * The `/dialer` link is offered anyway, and that is not a contradiction: the gates
 * resolve per tenant and per account, so an agent whose administrator switches the
 * capability on while this screen is open needs a way to try it without being told
 * to sign out and back in. If it is still off they land on the capability screen,
 * which is a worse page than this one but no longer a trap — they arrived by
 * choosing to.
 */
export function DialerUnavailable() {
  return (
    <div className={styles.wrap}>
      <div className={styles.card}>
        <span className={styles.icon} aria-hidden="true">
          <Headset size={22} />
        </span>
        <h1 className={styles.title}>The dialer isn’t switched on yet</h1>
        <p className={styles.body}>
          Your account doesn’t have the Agency Dialer enabled, so there’s nothing here
          for you to work on yet. Ask your administrator to turn it on — once they do,
          signing in will take you straight to your campaigns.
        </p>
        <Link className={styles.action} to="/dialer">
          <Headset size={15} aria-hidden="true" />
          Try the dialer
        </Link>
      </div>
    </div>
  );
}

export default DialerUnavailable;
