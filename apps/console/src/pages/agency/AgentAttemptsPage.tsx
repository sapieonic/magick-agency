import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useSoftphoneAvailable } from '../../components/agency/AgentNav';
import { SoftphoneCallsList } from '../../components/softphone/SoftphoneCallsList';
import { PhoneOutgoing } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { getMyCampaigns } from '../../api/agencyStats';
import { agencyPersona } from '../../utils/agencyPersona';
import { campaignNameMap } from '../../utils/agencyAgentPerformance';
import { AgentSurfaceShell } from '../../components/agency/AgentSurfaceShell';
import { AgentAttemptsPanel } from '../../components/agency/AgentAttemptsPanel';
import { trackAgentSurfaceViewed } from '../../analytics/events';
import type { AgencyStaffingHistoryEntry } from '../../types/agency-stats';

/**
 * "My calls" — one row per dial the signed-in person placed, at
 * `/dialer/attempts`.
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
 * ── Full-viewport and OUTSIDE both shells ─────────────────────────────────
 * For exactly the reason `/station`, `/dialer` and `/dialer/performance` are: an
 * `agent` is hierarchy level 5 and inherits no navigation, so `AppLayout`'s nav
 * (floored at `viewer`) and `AgencyLayout`'s entries would each render chrome
 * around nothing's *"that is not navigation, it is noise"*. The route sits
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
 * forgotten step: `GlobalSearch` lives in `TopBar`, inside `AppLayout`, so a
 * dedicated `agent` never renders it and the entry would be invisible to its only
 * audience — while everybody who COULD find it there is a supervisor or above, who
 * must not be sent to an agent-scoped page. `dialerEntryRoutes.test.tsx` pins it.
 *
 * ── Why the staffing history is fetched here ──────────────────────────────
 * `AgencyAttempt` carries `campaign_id` and no campaign NAME — the API has the name,
 * the row does not — and this list is cross-campaign, so the campaign column is the
 * one column that cannot be derived from the URL. `getMyCampaigns` is the id→name
 * source: it is floored at `agency.station.connect` (one of the very few reads an
 * `agent` can make at all) and it returns the whole staffing HISTORY including
 * ENDED assignments, which matters because a campaign somebody was unstaffed from
 * still has their attempts on it. One request for the whole list, never one per row.
 *
 * A failure here does **not** withhold the calls. The names are a courtesy; the
 * dials are the point. An unresolved id degrades to a shortened id inside the panel
 * rather than to a blank cell — see `AgentAttemptsPanel`.
 */

type HistoryState =
  | { status: 'loading' }
  | { status: 'ready'; entries: AgencyStaffingHistoryEntry[] }
  | { status: 'error' };

export function AgentAttemptsPage() {
  const { role, tenantId, accountId } = useTenant();
  const persona = agencyPersona(role);
  const supervisor = persona === 'supervisor';
  const [history, setHistory] = useState<HistoryState>({ status: 'loading' });

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

  useEffect(() => {
    /**
     * Both ids, for the reason every agency surface waits for both: an `agent` is
     * below `account.read`'s `viewer` floor so `GET /accounts` 403s for them, and a
     * request sent before `TenantContext` resolves carries no `X-Account-Id`, which
     * the API answers with a 400 about a header this client never sent. This cannot
     * become a permanent spinner — `AgentSurfaceShell` renders `AccountUnavailable`
     * once resolution settles without an account, and the panel below renders its
     * own three states regardless of what this read does.
     */
    if (!tenantId || !accountId) return undefined;

    let cancelled = false;
    setHistory({ status: 'loading' });
    getMyCampaigns(tenantId, accountId)
      .then((entries) => {
        if (cancelled) return;
        setHistory({ status: 'ready', entries });
      })
      .catch(() => {
        if (cancelled) return;
        /*
          No message kept, and no alert raised. The names this read supplies are a
          courtesy on top of the calls, and an error banner over a table that
          loaded perfectly well would tell the reader their history failed when it
          did not. The campaign column says what it can instead.
        */
        setHistory({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
  }, [tenantId, accountId]);

  const entries = history.status === 'ready' ? history.entries : [];

  /*
    ── Soft-phone calls: a tab, not a merged list ─────────────────────────────
    A manual call is not an attempt (`docs/softphone.md` §2): no try number, no
    roster contact of its own, an outcome from a different catalog when it is not
    logged to a campaign, and a call-details record an attempt does not have.
    Interleaving the two would make every column mean two things, so the agent's
    soft-phone calls are the second tab of the same page — reachable as
    `?view=softphone` — and only when the soft phone is on for them.
  */
  const softphone = useSoftphoneAvailable();
  const [params, setParams] = useSearchParams();
  const view = softphone && params.get('view') === 'softphone' ? 'softphone' : 'campaign';
  const choose = (next: 'campaign' | 'softphone') => {
    const updated = new URLSearchParams(params);
    if (next === 'softphone') updated.set('view', 'softphone');
    else updated.delete('view');
    setParams(updated, { replace: true });
  };
  const onTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const next = view === 'campaign' ? 'softphone' : 'campaign';
    choose(next);
    document.getElementById(`my-calls-tab-${next}`)?.focus();
  };

  const campaignPanel = (
    <AgentAttemptsPanel
      subject={{ kind: 'me' }}
      campaignNames={campaignNameMap(entries)}
      caption="Calls you have taken, newest first"
    />
  );

  return (
    <AgentSurfaceShell
      icon={<PhoneOutgoing size={20} />}
      title="My calls"
      subtitle="Every dial in your name, newest first — across every campaign you’ve worked, including the ones that never connected."
      current="attempts"
      note={
        supervisor ? (
          <>
            These are your own calls. For your team’s, open{' '}
            <Link to="/agency/analytics">Analytics</Link> in the campaigns workspace.
          </>
        ) : undefined
      }
    >
      {softphone ? (
        <>
          <div role="tablist" aria-label="Which calls" style={{ display: 'flex', gap: 8 }}>
            {(['campaign', 'softphone'] as const).map((id) => (
              <button
                key={id}
                id={`my-calls-tab-${id}`}
                type="button"
                role="tab"
                aria-selected={view === id}
                aria-controls={`my-calls-panel-${id}`}
                tabIndex={view === id ? 0 : -1}
                className={view === id ? 'btn-primary' : 'btn-secondary'}
                onClick={() => choose(id)}
                onKeyDown={onTabKey}
                data-testid={`my-calls-tab-${id}`}
              >
                {id === 'campaign' ? 'Campaign calls' : 'Soft-phone calls'}
              </button>
            ))}
          </div>
          <div role="tabpanel" id={`my-calls-panel-${view}`} aria-labelledby={`my-calls-tab-${view}`}>
            {view === 'campaign' ? campaignPanel : <MySoftphoneCalls />}
          </div>
        </>
      ) : (
        campaignPanel
      )}
    </AgentSurfaceShell>
  );
}

/** The agent's own soft-phone calls — scoped to their user id, whatever their role. */
function MySoftphoneCalls() {
  const { user } = useAuth();
  return (
    <SoftphoneCallsList
      scope="me"
      userId={user?.id ?? null}
      caption="Soft-phone calls you have made, newest first"
    />
  );
}

export default AgentAttemptsPage;
