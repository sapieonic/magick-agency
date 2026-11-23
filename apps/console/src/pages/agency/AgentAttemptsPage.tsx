import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useSoftphoneAvailable } from '../../components/agency/AgentNav';
import { PhoneOutgoing } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useMissedCallsAccess } from '../../hooks/useMissedCallsAccess';
import { agencyPersona } from '../../utils/agencyPersona';
import { AgentSurfaceShell } from '../../components/agency/AgentSurfaceShell';
import { MyCallsList } from '../../components/agency/MyCallsList';
import { MY_CALLS_SUBTITLE } from '../../utils/agency/myCalls';
import { trackAgentSurfaceViewed } from '../../analytics/events';

/**
 * "My calls" — one row per call the signed-in person made or took, at
 * `/dialer/attempts` (`docs/call-log.md` §7).
 *
 * ── What this is, next to the campaign's Attempts view ────────────────────
 * `/agency/campaigns/:id/attempts` is the same spine scoped to ONE campaign and
 * floored at `agency.supervise`, so an agent cannot read even their own rows
 * through it. A CALL list would not do either: an attempt that was abandoned
 * because no agent was free, or that failed before it dialled, has no call row
 * at all. This page is CROSS-campaign, scoped to the caller by the server, and built on the attempt table so
 * the dials that never connected appear. It is the only surface that answers "what
 * did I actually do today" for somebody who worked Renewals in the morning and
 * Collections after lunch.
 *
 * ── Full-viewport and OUTSIDE the console shell ───────────────────────────
 * For exactly the reason `/station`, `/dialer` and `/dialer/performance` are: an
 * `agent` is hierarchy level 5 and inherits no navigation, so the console shell's
 * nav (floored at `viewer`) would render chrome around nothing's *"that is not navigation, it is noise"*. The route sits
 * beside `/dialer` in `App.tsx`, gated identically (`RequireAuth` +
 * `RequireCapability capability="agency"` + `RequireFlag
 * flag="agency_dialer_enabled"`, both entitlements default off) and adds nothing to
 * `RequireCapability`'s hand-maintained union, because `agency` is already in it.
 *
 * `AgentSurfaceShell` carries the frame and — more importantly — the
 * account-resolution guard that `AgentHomePage`, `RequireFlag` and
 * `AgencyAnalyticsPage` each carry separately and each got wrong first.
 *
 * ── A supervisor is SERVED here, and never SENT here ──────────────────────
 * Same rule as `/dialer/performance`, and the note below points them at the right
 * screen. A supervisor who covers shifts has their own calls; refusing to show
 * somebody their own history because of their role would be strange. What this page
 * must not become is their TEAM surface — that is the per-agent section on
 * `AgencyAnalyticsPage`, which reads the supervisor twin of this very route through
 * the same panel.
 *
 * ── Deliberately absent from `GlobalSearch` ───────────────────────────────
 * The house rule is that a new page joins `GlobalSearch`'s list. This one does not,
 * and it is the same documented exception `AgentPerformancePage` made rather than a
 * forgotten step: `GlobalSearch` lives in the console shell, so a
 * dedicated `agent` never renders it and the entry would be invisible to its only
 * audience — while everybody who COULD find it there is a supervisor or above, who
 * must not be sent to an agent-scoped page. `dialerEntryRoutes.test.tsx` pins it.
 *
 * ── The campaign's name comes with the row ─────────────────────────────────
 * The list is cross-campaign, so the campaign column cannot come from the URL. Each row of
 * `GET /proxy/agency/my-calls` names its own campaign, so no second read is made for names.
 */

export function AgentAttemptsPage() {
  const { role } = useTenant();
  const persona = agencyPersona(role);
  const supervisor = persona === 'supervisor';

  /**
   * `agent_surface_viewed`, fired once per page visit — guarded rather than a
   * bare `[]` effect because `role` (and so `persona`) resolves asynchronously;
   * see `AgentPerformancePage`'s twin of this effect for the same reasoning.
   */
  const viewTracked = useRef(false);
  useEffect(() => {
    if (viewTracked.current) return;
    if (persona === null) return;
    viewTracked.current = true;
    trackAgentSurfaceViewed({
      surface: 'attempts',
      subject: 'me',
      viewer_persona: persona,
      // The applied filters live one layer down, in `useAgentAttempts` (behind
      // `AgentAttemptsPanel`), and every mount starts unfiltered — there is
      // nothing here to be scoped by yet.
      campaign_scoped: false,
      // Occupancy is a performance-page concept and does not apply to a
      // row-per-call list; `true` is the neutral default so this reads as
      // "nothing unmeasured" rather than implying a real gap.
      occupancy_measured: true,
      // Day-bucketing does not apply to this surface.
      bucket_count: 0,
      // See `AgentPerformancePage`'s note on `entry` — no arrival is tagged
      // today, so this defaults to 'direct'.
      entry: 'direct',
    });
  }, [persona]);

  /*
    ── One list, with chips (CL9) ─────────────────────────────────────────────
    My calls used to be two tabs, Campaign calls and Soft-phone calls, with Missed calls a page
    of its own. It is one list now (`MyCallsList`): the type is a chip and a column, answered
    inbound calls are in it, and To follow up (the missed calls that are this person's to ring
    back, then their callbacks due) is the first chip. `?view=softphone`, the old tab's URL,
    opens the Soft phone chip.
  */
  const softphone = useSoftphoneAvailable();
  const missedAccess = useMissedCallsAccess();
  const missed = missedAccess.available;
  // An agent's Missed calls badge counts their own open rows, the rows To follow up counts; a
  // supervisor's counts the account's, which says nothing of their own.
  const missedOpen = supervisor ? null : missedAccess.count?.open ?? null;

  return (
    <AgentSurfaceShell
      icon={<PhoneOutgoing size={20} />}
      title="My calls"
      subtitle={MY_CALLS_SUBTITLE}
      current="attempts"
      note={
        supervisor ? (
          <>
            These are your own calls. For your team’s, open{' '}
            <Link to="/agency/analytics">Analytics</Link> under Reports.
          </>
        ) : undefined
      }
    >
      <MyCallsList softphone={softphone} inbound={missed} missedOpen={missedOpen} />
    </AgentSurfaceShell>
  );
}

export default AgentAttemptsPage;

