import { useCallback, useEffect, useRef, useState } from 'react';
import { createAgencySession, leaveAgencySession } from '../../../api/agency';
import { useMountedRef } from '../../../hooks/useMountedRef';
import { errorCode } from '../../../utils/agencyErrors';
import {
  conflictIsMidCall,
  joinConflictFallbackSentence,
  parseJoinConflict,
  switchFailureCopy,
  type SwitchStage,
} from '../../../utils/agencyJoinConflict';
import {
  clearLiveSession,
  coalesceJoin,
  localJoinConflict,
  readLiveSession,
  rememberLiveSessionFromBootstrap,
  rememberLiveSessionFromConflict,
  touchLiveSessionState,
  LIVE_SESSION_TOUCH_MS,
} from '../../../utils/agencyLiveSession';
import { agencyPersona } from '../../../utils/agencyPersona';
import {
  trackAgencyStationJoined,
  trackAgencyStationJoinFailed,
  trackAgencyStationSwitchCampaign,
} from '../../../analytics/events';
import type { StationConnection } from '../../../hooks/useAgencyStation';
import type { Role } from '../../../types/auth';
import type {
  AgencyAgentState,
  AgencySessionBootstrap,
  AgencySessionConflict,
} from '../../../types/agency';

/**
 * Joining the station: the session bootstrap, the two ways a join is refused,
 * and the conflict screen's leave-and-rejoin remedy.
 *
 * Split out of `AgentConsolePage`, which renders what this returns — the console
 * when there is a bootstrap, `JoinConflictScreen` or `StationFatal` when not.
 */
export interface StationJoin {
  bootstrap: AgencySessionBootstrap | null;
  joinError: string | null;
  /**
   * 409 `session_on_softphone`: the agent's live session is a soft-phone session
   * (`docs/softphone.md` §2), which has no campaign to name the way
   * `session_on_other_campaign` does. The remedy is closing the soft phone.
   */
  onSoftphoneElsewhere: boolean;
  joinConflict: AgencySessionConflict | null;
  switchConfirm: boolean;
  switching: boolean;
  switchFailure: string | null;
  /** The conflict screen's button: a fresh switch attempt. */
  beginSwitch: () => void;
  confirmSwitch: () => Promise<void>;
  cancelSwitch: () => void;
}

export function useStationJoin({
  campaignId,
  tenantId,
  accountId,
  role,
}: {
  campaignId: string;
  tenantId: string | null;
  accountId: string | null;
  role: Role | undefined;
}): StationJoin {
  const [bootstrap, setBootstrap] = useState<AgencySessionBootstrap | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [onSoftphoneElsewhere, setOnSoftphoneElsewhere] = useState(false);
  /**
   * The `409 session_on_other_campaign` refusal, kept apart from `joinError`.
   *
   * Same failure to join, two different screens: `joinError` is a sentence, and
   * this one names a campaign, a state and a link. Collapsing them into one
   * string would throw away the campaign id, which is the only part of the body
   * the agent can act on.
   */
  const [joinConflict, setJoinConflict] = useState<AgencySessionConflict | null>(null);
  /**
   * The join-conflict screen's one-click remedy: leave the other campaign's
   * station and rejoin here, without navigating away first (see
   * `confirmSwitch` below and `agencyJoinConflict.ts`'s `SwitchStage`). Kept
   * apart from `leaveConfirm`/`leaving`/`leaveFailure` — those describe a
   * `Leave station` the agent runs against their OWN, currently-open session,
   * while this one only ever exists on the conflict screen, before any
   * session at all is open here.
   */
  const [switchConfirm, setSwitchConfirm] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [switchFailure, setSwitchFailure] = useState<string | null>(null);
  /**
   * Guards `confirmSwitch`'s `setState` calls against a hard navigation or
   * closed tab mid-chain. The three requests it chains cannot themselves be
   * cancelled — there is no `AbortController` on this API layer (the same gap
   * `onExport`'s CSV download documents elsewhere) — so a leave-and-rejoin
   * that is already in flight still completes server-side either way; this
   * only stops the component from setting state once nothing is listening.
   *
   * Set on the way IN as well as cleared on the way out — see `useMountedRef`
   * for the reason spelled out in full: `React.StrictMode` runs every effect
   * setup → cleanup → setup in
   * development, so a cleanup-only effect left this `false` for the rest of
   * the page's life. `confirmSwitch` would then set `switching` and never
   * clear it — a permanent "Switching…" with Cancel doing nothing, even once
   * the three requests had already committed.
   */
  const mountedRef = useMountedRef();
  /** Analytics-only: which session `agency_station_joined` has already fired for. */
  const stationJoinTrackedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!campaignId) {
      setJoinError('No campaign selected.');
      trackAgencyStationJoinFailed({ reason: 'no_campaign', conflict_state: null });
      return;
    }
    /**
     * Wait for BOTH ids before joining.
     *
     * `TenantContext` resolves the account asynchronously — it is null on first
     * render and again for a moment after a tenant switch. Joining in that
     * window sends no `X-Account-Id`, the server forwards no `x-mgkvc-account`, and
     * the API answers the exact 400 this console was fixed to stop producing.
     *
     * The retry when the account lands then succeeds, which is what made this
     * survivable-looking and is precisely why it was not: `joinError` gates the
     * whole render ahead of `bootstrap`, so the page stayed on the error screen
     * behind a session that had joined perfectly well. Clearing it on entry is
     * the other half of the fix — a guard alone would still strand anyone whose
     * first attempt failed for a real reason that later resolved.
     */
    if (!tenantId || !accountId) return;

    /**
     * Refuse locally when this browser already knows the agent is live on
     * another campaign. The 409 from `POST /sessions` is the API doing its job;
     * firing it from a view that already has the answer is the warning
     * ("already live on another campaign") and the "don't send the
     * click" rule applied to the join path. Resume of the SAME campaign still
     * POSTs — that is a refresh of this station, not a second join.
     */
    const cached = localJoinConflict(tenantId, campaignId);
    if (cached) {
      setJoinError(null);
      setJoinConflict(cached);
      trackAgencyStationJoinFailed({
        reason: 'session_on_other_campaign',
        conflict_state: cached.state,
      });
      return;
    }

    let cancelled = false;
    setJoinError(null);
    setJoinConflict(null);
    const joinKey = `${tenantId}:${accountId}:${campaignId}`;
    coalesceJoin(joinKey, () => createAgencySession(campaignId, tenantId, accountId))
      .then((session) => {
        rememberLiveSessionFromBootstrap(tenantId, session);
        if (!cancelled) setBootstrap(session);
      })
      .catch((err: unknown) => {
        if (cancelled) {
          /**
           * Still write the cache on a cancelled 409: StrictMode's simulated
           * unmount would otherwise drop the only copy of "you are live
           * elsewhere" and the remount would POST again.
           */
          const conflict = parseJoinConflict(err);
          if (conflict) rememberLiveSessionFromConflict(tenantId, conflict);
          return;
        }
        /**
         * The one refusal the tenant-wide live-session rule makes reachable for
         * an ordinary agent: they are still joined to another campaign. It is an
         * answer with a remedy in it, so it must not fall through to the generic
         * message — the API states the campaign and their state there precisely so
         * this screen can name both. See `agencyJoinConflict.ts`.
         */
        if (errorCode(err) === 'session_on_softphone') {
          setOnSoftphoneElsewhere(true);
          trackAgencyStationJoinFailed({ reason: 'api_error', conflict_state: null });
          return;
        }
        const conflict = parseJoinConflict(err);
        if (conflict) {
          rememberLiveSessionFromConflict(tenantId, conflict);
          setJoinConflict(conflict);
          trackAgencyStationJoinFailed({
            reason: 'session_on_other_campaign',
            conflict_state: conflict.state ?? null,
          });
          return;
        }
        /**
         * A conflict body the parser REFUSED — a structured field missing or
         * unreadable — still carries the API's own sentence, and that is a better
         * thing to put in front of an agent than the generic fallback. The
         * parser stays strict on purpose (a conflict screen that names no
         * campaign reads as broken), so the degraded reading is chosen here
         * rather than by loosening it.
         */
        setJoinError(
          joinConflictFallbackSentence(err)
            ?? (err instanceof Error ? err.message : 'Could not join the campaign.'),
        );
        trackAgencyStationJoinFailed({
          reason: joinConflictFallbackSentence(err)
            ? 'conflict_unreadable'
            : (campaignId ? 'api_error' : 'no_campaign'),
          conflict_state: null,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [campaignId, tenantId, accountId]);

  /**
   * `agency_station_joined`, decoupled from the join effect above.
   *
   * `role` comes from tenant membership, which can still be unresolved when
   * `createAgencySession` settles — that effect is keyed on
   * `[campaignId, tenantId, accountId]`, not `role`, so firing the event
   * inline in its `.then()` meant a successful join with a not-yet-resolved
   * role permanently skipped the adoption event, with no later retry. This
   * effect instead fires as soon as BOTH `bootstrap` and a resolvable persona
   * are available, whichever settles second, and is deduped per session id so
   * a later re-render (e.g. `role` changing shape without changing persona)
   * cannot double-fire it.
   */
  useEffect(() => {
    if (!bootstrap) return;
    const persona = agencyPersona(role);
    if (!persona) return;
    if (stationJoinTrackedRef.current === bootstrap.session_id) return;
    stationJoinTrackedRef.current = bootstrap.session_id;
    trackAgencyStationJoined({
      persona,
      campaign_id: bootstrap.campaign_id,
      disposition_count: bootstrap.disposition_catalog.length,
      break_reason_count: bootstrap.break_reasons.length,
      wrapup_seconds: bootstrap.wrapup_seconds,
      wrapup_auto_return: bootstrap.wrapup_auto_return,
      record_calls: bootstrap.record_calls,
      // `AgencySessionBootstrap.context_display` carries only the hero/order/
      // hidden display overrides, not the full set of contact-context fields a
      // campaign's CSV configured — that count is only knowable per-attempt,
      // from the attempt's own `context` keys (`resolveContextFields`). Not
      // available at join time.
      context_field_count: 0,
    });
  }, [bootstrap, role]);

  /**
   * What `confirmSwitch` has actually gotten done, kept across a retry.
   *
   * A rejoin failure used to leave the confirm button retrying the WHOLE
   * chain from `resume` — but by the time `rejoin` can fail, `leave` has
   * already succeeded, so redoing `resume` calls `createAgencySession` on the
   * campaign the agent just left, rejoining it.
   * Reset only where a switch attempt genuinely starts over: `beginSwitch`
   * below, the conflict screen's button (a fresh conflict, nothing done yet) — never inside
   * `confirmSwitch` itself, so a retry after any failure resumes from
   * wherever the chain actually got to.
   */
  const switchProgressRef = useRef<{ otherSessionId: string | null; leftOther: boolean }>({
    otherSessionId: null,
    leftOther: false,
  });

  /**
   * The join-conflict screen's one-click remedy (`agencyJoinConflict.ts`).
   *
   * The conflict body the API sends (`session_on_other_campaign`) names the OTHER
   * campaign and the agent's state there, but never a `session_id` — nothing
   * on that response was ever meant to be a session lookup key. `leaveAgencySession`
   * needs exactly that id, so getting one is the first of three chained
   * requests, not an extra: `createAgencySession(conflict.campaign_id)` for a
   * campaign the agent is ALREADY joined to is the same resume-in-place call
   * `/station?campaign=…` already relies on (a refreshed console tab does the
   * same thing), and it is the only place that id can come from.
   *
   * `conflictIsMidCall` gates whether the BUTTON is offered at all, on
   * `joinConflict.state` — a snapshot from whenever the agent first tried to
   * join, from a page with no socket open to the other campaign to keep it
   * current. It can be stale by the time this actually runs, so the resumed
   * session's OWN `state` — current, because this request just resumed that
   * exact session — is checked again before `leave` ever fires (without this, an agent who went `available` → `on_call`
   * elsewhere could have that live call ended out from under them).
   */
  const confirmSwitch = useCallback(async () => {
    if (!joinConflict) return;
    const conflict = joinConflict;
    setSwitching(true);
    setSwitchFailure(null);
    const progress = switchProgressRef.current;
    /**
     * Analytics only. Fired regardless of mount — it records what actually
     * happened server-side. `agentState` defaults to the conflict's own; only
     * the mid-call abort reports the fresh state that decided it.
     */
    const reportSwitch = (
      outcome: Parameters<typeof trackAgencyStationSwitchCampaign>[0]['outcome'],
      failedStage: SwitchStage | null,
      agentState: AgencySessionConflict['state'] = conflict.state,
    ) =>
      trackAgencyStationSwitchCampaign({
        from_campaign_id: conflict.campaign_id,
        to_campaign_id: campaignId,
        agent_state: agentState,
        outcome,
        failed_stage: failedStage,
      });

    let stage: SwitchStage = 'resume';
    try {
      if (!progress.leftOther) {
        let otherSessionId = progress.otherSessionId;
        if (!otherSessionId) {
          const otherSession = await createAgencySession(
            conflict.campaign_id,
            tenantId ?? undefined,
            accountId ?? undefined,
          );
          if (conflictIsMidCall(otherSession.state)) {
            // Not a request failure — the other campaign answered fine, and
            // it now has a live customer on it. Refreshing `joinConflict`
            // with the state just learned re-renders this same screen
            // honestly: the button disappears (mid-call gate), and the copy
            // stops offering a remedy this screen must not perform.
            if (mountedRef.current) {
              setSwitching(false);
              setSwitchConfirm(false);
              setJoinConflict({ ...conflict, state: otherSession.state });
            }
            reportSwitch('blocked_mid_call', null, otherSession.state);
            return;
          }
          otherSessionId = otherSession.session_id;
          progress.otherSessionId = otherSessionId;
        }
        stage = 'leave';
        await leaveAgencySession(otherSessionId, tenantId ?? undefined, accountId ?? undefined);
        progress.leftOther = true;
        if (tenantId) clearLiveSession(tenantId);
      }

      stage = 'rejoin';
      const session = await createAgencySession(campaignId, tenantId ?? undefined, accountId ?? undefined);
      if (tenantId) rememberLiveSessionFromBootstrap(tenantId, session);

      // Tracking fires regardless of mount — it records what actually
      // happened server-side, which the requests already committed to before
      // this line ran. Only the `setState` calls need the guard.
      if (mountedRef.current) {
        setSwitching(false);
        setSwitchConfirm(false);
        setJoinConflict(null);
        setBootstrap(session);
      }
      reportSwitch('completed', null);
    } catch (err: unknown) {
      if (stage === 'rejoin') {
        /**
         * A conflict on the REJOIN leg means a third campaign's session beat
         * this one to the punch while the switch was in flight — the other
         * station is already closed, so the old screen no longer describes
         * anything real. Replacing `joinConflict` re-renders this same screen
         * for the new one, which is the one honest thing left to show.
         */
        const rejoinConflict = parseJoinConflict(err);
        if (rejoinConflict) {
          // Leave already cleared the previous station. Without writing this
          // conflict, a remount POSTs `/sessions` again and recreates the
          // "already live on another campaign" warning the cache exists to
          // suppress.
          if (tenantId) rememberLiveSessionFromConflict(tenantId, rejoinConflict);
          if (mountedRef.current) {
            setSwitching(false);
            setSwitchConfirm(false);
            setJoinConflict(rejoinConflict);
          }
          reportSwitch('failed', stage);
          return;
        }
        /**
         * An ordinary failure here means `leave` already succeeded — the
         * agent is not "still at" `conflict.campaign_name` any more, so
         * this screen has nothing true left to say and retrying THIS dialog
         * would call `createAgencySession(conflict.campaign_id)` again,
         * rejoining the campaign that was just left. The ordinary join screen is the honest state instead —
         * it already knows how to retry: reloading this route re-runs the
         * plain join effect, which starts clean because the conflict really
         * is gone.
         */
        if (mountedRef.current) {
          setSwitching(false);
          setSwitchConfirm(false);
          setJoinConflict(null);
          setJoinError(switchFailureCopy(stage, conflict.campaign_name, err));
        }
        reportSwitch('failed', stage);
        return;
      }
      if (mountedRef.current) {
        setSwitching(false);
        setSwitchFailure(switchFailureCopy(stage, conflict.campaign_name, err));
      }
      reportSwitch('failed', stage);
    }
  }, [joinConflict, tenantId, accountId, campaignId]);

  const beginSwitch = useCallback(() => {
    // A fresh attempt at a (possibly brand-new, post-swap)
    // conflict always starts from scratch.
    switchProgressRef.current = { otherSessionId: null, leftOther: false };
    setSwitchConfirm(true);
  }, []);

  /**
   * `disabled` is deliberately the only thing guarding a mid-flight request:
   * `onCancel` still fires on Escape/overlay-click, and letting it close the
   * dialog while `confirmSwitch`'s chain is still running would land its eventual
   * rejection on a surface nobody can see.
   */
  const cancelSwitch = useCallback(() => {
    if (switching) return;
    setSwitchConfirm(false);
    setSwitchFailure(null);
  }, [switching]);

  return {
    bootstrap,
    joinError,
    onSoftphoneElsewhere,
    joinConflict,
    switchConfirm,
    switching,
    switchFailure,
    beginSwitch,
    confirmSwitch,
    cancelSwitch,
  };
}

export function useLiveSessionTouch({
  tenantId,
  bootstrap,
  agentState,
  connection,
}: {
  tenantId: string | null;
  bootstrap: AgencySessionBootstrap | null;
  agentState: AgencyAgentState;
  connection: StationConnection;
}): void {
  /**
   * Keep the cached live-session state current while this station is open, so
   * a second tab that reads it can still refuse a mid-call switch. No-ops
   * unless the cache is THIS campaign — a stale conflict record for another
   * campaign must not be rewritten from this console's state.
   *
   * `session_gone` is terminal (4404): the API no longer has this session, and
   * reconnecting cannot help. Touching after that would keep a second campaign
   * refused locally for as long as this page stays mounted. Clear only when
   * the record is still this campaign — another tab may already have written
   * a newer one.
   */
  useEffect(() => {
    if (!tenantId || !bootstrap) return;
    if (connection === 'session_gone') {
      const cached = readLiveSession(tenantId);
      if (cached?.campaignId === bootstrap.campaign_id) clearLiveSession(tenantId);
      return;
    }
    touchLiveSessionState(tenantId, bootstrap.campaign_id, agentState);
    const timer = window.setInterval(() => {
      touchLiveSessionState(tenantId, bootstrap.campaign_id, agentState);
    }, LIVE_SESSION_TOUCH_MS);
    return () => window.clearInterval(timer);
  }, [tenantId, bootstrap, agentState, connection]);
}
