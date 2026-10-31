import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { LoadingSpinner } from '@magick-agency/web-ui/components/LoadingSpinner';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { leaveAgencySession } from '../../api/agency';
import {
  switchToSoftphone,
  type SoftphoneSessionOnCampaignRefusal,
  type SoftphoneSessionOnSoftphoneRefusal,
} from '../../api/softphone';
import { trackAgencySoftphoneSwitch, trackFeatureGateUnavailable } from '../../analytics/events';
import { SOFTPHONE_FLAG, useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { useAgencyAudio } from '../../hooks/useAgencyAudio';
import { useAgencyStation } from '../../hooks/useAgencyStation';
import { useServerClock } from '../../hooks/useServerClock';
import { useSoftphone } from '../../hooks/useSoftphone';
import { hasPermission } from '../../utils/permissions';
import { audioTarget } from '../../utils/softphone/audioTarget';
import { refusalCopy } from '../../utils/softphone/refusalCopy';
import { closeSoftphoneSession } from './softphone/closeSoftphoneSession';
import { agencyAudioNotice } from '../../utils/agencyAudioCopy';
import { readCuePrefs } from '../../utils/agencyCuePrefs';
import { agentLandingPath } from '../../utils/agencyStationExit';
import { AGENCY_FLOOR_STATE_LABELS } from '../../utils/agencyAgentFloor';
import { StationEscape } from '../../components/agency/StationFatal';
import { SoftphoneView } from '../../components/softphone/SoftphoneView';
import { SoftphoneHeader, SOFTPHONE_LEAVE_BLOCKED_COPY } from '../../components/softphone/SoftphoneHeader';
import { CapabilityUnavailable } from '../../components/common/CapabilityUnavailable';
import { useSoftphoneSession } from './softphone/useSoftphoneSession';
import type { StationSocketBootstrap } from '../../hooks/agencyStation/types';
import type { AgencyManualCall, AgencySoftphoneSessionResponse } from '../../types/softphone';
import type { TenantAccount } from '../../types/auth';
import station from '../../components/agency/AgentStation.module.css';

/** The Close soft phone confirmation: where it lands, and how to come back. */
export const SOFTPHONE_CLOSE_CONFIRM_MESSAGE =
  'This ends your soft-phone session and takes you to My campaigns. To call again, choose Soft phone at the top of the page.';

/**
 * `/dialer/phone` — the soft phone for an agent who is not on a campaign
 * (`docs/softphone.md` §2, §7).
 *
 * Full-viewport and outside both shells, gated like `/station`; the page reads
 * `agency_softphone_enabled` itself rather than through `RequireFlag`, because
 * the flag turned off must not take a call away from the agent on it: with the
 * flag off it rehydrates only a soft-phone session that already exists in this
 * account (the server's `rehydrate_only`), into finish mode (`useSoftphone`); one
 * in a sibling account can only be closed (`StrandedScreen`); and it is
 * `CapabilityUnavailable` otherwise, as the route gate was. It opens a soft-phone session (`break/soft_phone`
 * from birth, never `available`, so pacing can never reserve it), connects the
 * station socket for it, and renders `SoftphoneView` on top of that socket, the
 * station's microphone and its playback.
 *
 * An agent already live on a campaign is refused (`session_on_campaign`): one
 * session per agent per tenant, one pair of ears. The answer is not a second
 * session but the switch on that one (§4.2), which this page offers — the
 * station then shows the soft phone in place, on its own socket, and "Return to
 * campaign" takes them back. A soft-phone session open in a sibling account is
 * refused too (`session_on_softphone`, `ElsewhereScreen`): the page closes it
 * there and opens one here.
 */
export default function SoftphonePage() {
  const { tenantId, accountId, role } = useTenant();
  const { user } = useAuth();
  const mayDial = hasPermission(role, 'agency.softphone.dial');
  const flagOn = useFeatureFlagEnabled(SOFTPHONE_FLAG);
  const { state, retry } = useSoftphoneSession({ tenantId, accountId, enabled: mayDial, startAllowed: flagOn });
  const off = state.status === 'off';

  // What `RequireFlag` reported when it gated this route.
  useEffect(() => {
    if (off) trackFeatureGateUnavailable({ gate_type: 'feature_flag', gate: SOFTPHONE_FLAG });
  }, [off]);

  if (role !== undefined && !mayDial) return <CapabilityUnavailable />;

  if (state.status === 'off') return <CapabilityUnavailable />;

  if (state.status === 'off_stranded') {
    return <StrandedScreen sessionId={state.sessionId} call={state.call} tenantId={tenantId} sessionAccountId={state.sessionAccountId} />;
  }

  if (state.status === 'on_campaign') {
    return <CampaignSessionScreen refusal={state.refusal} tenantId={tenantId} accountId={accountId} />;
  }

  if (state.status === 'softphone_elsewhere') {
    return <ElsewhereScreen refusal={state.refusal} tenantId={tenantId} accountId={accountId} onClosed={retry} />;
  }

  if (state.status === 'error') {
    return (
      <div className={station.shell}>
        <div className={station.fatal} role="alert">
          <h1>Can’t open the soft phone</h1>
          <p>{state.message}</p>
          <button type="button" className={station.fatalAction} onClick={retry}>
            Try again
          </button>
          <StationEscape toCampaign={false} campaignId="" />
        </div>
      </div>
    );
  }

  if (state.status === 'loading') {
    return (
      <div className={station.shell}>
        <div className={station.fatal} aria-busy="true">
          <LoadingSpinner />
          <p>Opening your soft phone…</p>
        </div>
      </div>
    );
  }

  return (
    <SoftphoneConsole
      session={state.session}
      socket={state.socket}
      startAllowed={state.startAllowed}
      tenantId={tenantId}
      accountId={accountId}
      user={user}
    />
  );
}

function SoftphoneConsole({
  session,
  socket,
  startAllowed,
  tenantId,
  accountId,
  user,
}: {
  session: AgencySoftphoneSessionResponse;
  socket: StationSocketBootstrap;
  startAllowed: boolean;
  tenantId: string | null;
  accountId: string | null;
  user: ReturnType<typeof useAuth>['user'];
}) {
  const navigate = useNavigate();
  const audio = useAgencyAudio();
  const stationState = useAgencyStation(socket, {
    tenantId: tenantId ?? undefined,
    accountId: accountId ?? undefined,
    audio: audio.sink,
  });
  const clock = useServerClock(stationState.clockOffsetMs);
  const { connection } = stationState;
  const stationIsGone = connection === 'disconnected' || connection === 'session_gone' || connection === 'superseded';

  // One owner for the microphone: arm on the dial, open the uplink on `bridged_at`.
  const target = audioTarget({ stationIsGone, live: stationState.live, manualCall: stationState.manualCall });
  useEffect(() => {
    audio.sync({ attemptId: target.id, bridged: target.bridged, send: stationState.sendMedia });
  }, [audio.sync, target.id, target.bridged, stationState.sendMedia]);

  const cueVolume = useMemo(() => {
    try {
      return readCuePrefs(window.localStorage).volume;
    } catch {
      return readCuePrefs(undefined).volume;
    }
  }, []);

  /**
   * Warm the playback context and probe the microphone on the agent's FIRST
   * gesture on the page — typing the number, a click, a key — so the permission
   * prompt and the autoplay unlock happen before anything is dialled, not while
   * the customer's phone rings. The station does this on "Go available"; this
   * page has no such button, and a context first made from a socket frame is
   * suspended and plays silence (`useAgencyAudio.preflight`). Once per page: the
   * probe releases the microphone straight away, and skips itself while a call
   * holds it (a reload mid-call still needs the playback warmed).
   *
   * The Call press runs it too, for a click that came with no pointer or key
   * before it (assistive tech activating the button directly).
   */
  const preflightedRef = useRef(false);
  const preflightOnce = useCallback(() => {
    if (preflightedRef.current) return;
    preflightedRef.current = true;
    audio.preflight();
  }, [audio.preflight]);
  useEffect(() => {
    const onGesture = () => {
      preflightOnce();
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
    };
    window.addEventListener('pointerdown', onGesture, true);
    window.addEventListener('keydown', onGesture, true);
    return () => {
      window.removeEventListener('pointerdown', onGesture, true);
      window.removeEventListener('keydown', onGesture, true);
    };
  }, [preflightOnce]);
  const { resume: resumeAudio } = audio;
  const softphoneAudio = useMemo(
    () => ({
      muted: audio.muted,
      sending: audio.sending,
      toggleMute: audio.toggleMute,
      resume: () => {
        preflightOnce();
        resumeAudio();
      },
    }),
    [audio.muted, audio.sending, audio.toggleMute, resumeAudio, preflightOnce],
  );

  const sp = useSoftphone({
    tenantId: tenantId ?? undefined,
    accountId: accountId ?? undefined,
    userId: user?.id ?? null,
    sessionId: session.session_id,
    connection,
    frameCall: stationState.manualCall,
    clock,
    audio: softphoneAudio,
    surface: 'softphone_page',
    cueVolume,
    startAllowed,
  });

  const [closeOpen, setCloseOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [closeFailure, setCloseFailure] = useState<string | null>(null);
  const confirmClose = async () => {
    setClosing(true);
    setCloseFailure(null);
    try {
      await leaveAgencySession(session.session_id, tenantId ?? undefined, accountId ?? undefined);
      navigate(agentLandingPath('station'));
    } catch (err) {
      setCloseFailure(err instanceof Error ? err.message : 'Try again in a moment.');
      setClosing(false);
    }
  };

  const micNotice = agencyAudioNotice(audio.error);

  return (
    <div className={station.shell}>
      <SoftphoneHeader
        user={user}
        sp={sp}
        connection={connection}
        missedPings={stationState.missedPings}
        actions={
          <button
            type="button"
            className="btn-secondary"
            onClick={() => setCloseOpen(true)}
            disabled={sp.call !== null}
            title={sp.call ? SOFTPHONE_LEAVE_BLOCKED_COPY : 'End your soft-phone session'}
            data-testid="softphone-close"
          >
            Close soft phone
          </button>
        }
      />

      {micNotice ? (
        <p className={station.micFailure} role="alert" data-testid="mic-failure">
          <strong>{micNotice.headline}</strong> {micNotice.remedy}
          {micNotice.action ? (
            <button type="button" className={station.micFailureAction} onClick={audio.resume}>
              {micNotice.action}
            </button>
          ) : null}
        </p>
      ) : null}

      <SoftphoneView
        sp={sp}
        connection={connection}
        clock={clock}
        fromCampaign={false}
        onReconnect={stationState.reconnect}
        shortcutsEnabled={!closeOpen}
      />

      <ConfirmDialog
        open={closeOpen}
        title="Close the soft phone?"
        message={
          closeFailure
            ? `Your soft phone is still open — ${closeFailure}`
            : SOFTPHONE_CLOSE_CONFIRM_MESSAGE
        }
        confirmLabel={closing ? 'Closing…' : 'Close soft phone'}
        disabled={closing}
        onConfirm={() => void confirmClose()}
        onCancel={() => {
          if (!closing) setCloseOpen(false);
        }}
      />
    </div>
  );
}

/** The soft phone is off here and the agent's session is in another account: what is true, and who can finish it. */
export const SOFTPHONE_STRANDED_COPY = {
  title: 'Your soft phone is open in another account',
  detail: 'The soft phone is turned off for this account, and your soft-phone session is still open in another account of this workspace. Switch to that account to finish there, or close it here.',
  owed: 'Your last call there still needs its outcome. A supervisor can save it for you from Soft-phone calls.',
  close: 'Close the soft phone so you can join a campaign.',
} as const;

/**
 * `off_stranded`: the soft phone is off for this account and the agent's
 * soft-phone session is in a SIBLING account of the tenant, which this account
 * cannot rehydrate (the server rehydrates only a session in the account asked
 * for, docs/softphone.md §6) and cannot open beside (one live session per agent
 * per tenant). The one thing this page can still do is close the session — so
 * the agent is not locked out of campaigns by it — and say who can save an
 * outcome it still owes (a supervisor, on the agent's behalf).
 *
 * The close is sent with the SESSION's account: `leave` is scoped to the
 * session's account, and this account's would be the 404 of a session that does
 * not exist here.
 */
function StrandedScreen({
  sessionId,
  call,
  tenantId,
  sessionAccountId,
}: {
  sessionId: string;
  call: AgencyManualCall | null;
  tenantId: string | null;
  sessionAccountId: string;
}) {
  const navigate = useNavigate();
  const [closing, setClosing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const onClose = async () => {
    setClosing(true);
    setFailure(null);
    try {
      await leaveAgencySession(sessionId, tenantId ?? undefined, sessionAccountId);
      navigate(agentLandingPath('station'));
    } catch (err) {
      setFailure(err instanceof Error ? err.message : 'Try again in a moment.');
      setClosing(false);
    }
  };
  return (
    <div className={station.shell}>
      <div className={station.fatal} role="alert" data-testid="softphone-stranded">
        <h1>{SOFTPHONE_STRANDED_COPY.title}</h1>
        <p>{SOFTPHONE_STRANDED_COPY.detail}</p>
        {call && call.requires_disposition ? <p>{SOFTPHONE_STRANDED_COPY.owed}</p> : null}
        <p>{SOFTPHONE_STRANDED_COPY.close}</p>
        <button
          type="button"
          className={station.fatalAction}
          onClick={() => void onClose()}
          disabled={closing}
          data-testid="softphone-stranded-close"
        >
          {closing ? 'Closing…' : 'Close soft phone'}
        </button>
        {failure ? (
          <p className="error-text" data-testid="softphone-stranded-failure">
            Your soft phone is still open — {failure}
          </p>
        ) : null}
        <StationEscape toCampaign={false} campaignId="" />
      </div>
    </div>
  );
}

/**
 * The account a live-session refusal names, as the console can act on it: its name
 * (the refusal's, else the account list's; null when neither has one) and whether
 * the console can switch to it — the account is in the caller's list, so
 * `setActiveAccountId` lands on an account the switcher shows and the server
 * scopes every call to. Mocked contexts in tests may carry no list.
 */
function siblingAccount(
  accounts: TenantAccount[] | undefined,
  refusal: { account_id: string; account_name: string | null },
): { name: string | null; switchable: boolean } {
  const listed = (accounts ?? []).find((a) => a.id === refusal.account_id) ?? null;
  return { name: refusal.account_name ?? listed?.name ?? null, switchable: listed !== null };
}

/** `softphone_elsewhere`: the soft phone is on here and open in a sibling account. */
export const SOFTPHONE_ELSEWHERE_COPY = {
  title: 'Your soft phone is open in another account',
  detail: (account: string | null) =>
    account
      ? `Your soft-phone session is open in ${account}. You can only have one session at a time.`
      : 'Your soft-phone session is open in another account of this workspace. You can only have one session at a time.',
  close: 'Close it and open the soft phone here',
  callPending: (account: string | null) =>
    `Your soft phone ${account ? `in ${account}` : 'in the other account'} has a call that isn’t finished, so it’s still open. Hang up and save its outcome there first.`,
  goThere: (account: string | null) => (account ? `Use the soft phone in ${account}` : 'Use the soft phone in that account'),
} as const;

/**
 * `softphone_elsewhere`: the soft phone is on for this account, and the agent's
 * soft-phone session is open in a SIBLING account of the tenant. The server never
 * rehydrates it here — every route on it is scoped to its own account, so this
 * console could dial nothing from it — and cannot open a second one beside it (one
 * live session per agent per tenant).
 *
 * The remedy is one click: close that session and open the soft phone here
 * (`closeSoftphoneSession`, the campaign join's close too). It reads and leaves the
 * session with the refusal's `account_id`, and closes nothing while a call there is
 * live or owes its outcome, saying so; then the open is retried. The second way is
 * going to that account (when the console can switch to it), where the same page
 * rehydrates the session — the way to finish a call it still holds.
 */
function ElsewhereScreen({
  refusal,
  tenantId,
  accountId,
  onClosed,
}: {
  refusal: SoftphoneSessionOnSoftphoneRefusal;
  tenantId: string | null;
  accountId: string | null;
  onClosed: () => void;
}) {
  const { accounts, setActiveAccountId } = useTenant();
  const there = siblingAccount(accounts, refusal);
  const [closing, setClosing] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [callPending, setCallPending] = useState(false);
  const goThereRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (callPending) goThereRef.current?.focus();
  }, [callPending]);

  const onClose = async () => {
    if (closing || !tenantId || !accountId) return;
    setClosing(true);
    setFailure(null);
    const closed = await closeSoftphoneSession({
      tenantId,
      accountId,
      sessionId: refusal.session_id,
      sessionAccountId: refusal.account_id,
    });
    if (closed.kind === 'closed') {
      onClosed();
      return;
    }
    setClosing(false);
    if (closed.kind === 'call_pending') setCallPending(true);
    else setFailure(closed.kind === 'failed' ? closed.message : 'Your soft phone is still open. Try again.');
  };

  return (
    <div className={station.shell}>
      <div className={station.fatal} role="alert" data-testid="softphone-elsewhere">
        <h1>{SOFTPHONE_ELSEWHERE_COPY.title}</h1>
        <p>{SOFTPHONE_ELSEWHERE_COPY.detail(there.name)}</p>
        {callPending ? (
          <p className="error-text" data-testid="softphone-elsewhere-call-pending">
            {SOFTPHONE_ELSEWHERE_COPY.callPending(there.name)}
          </p>
        ) : (
          <button
            type="button"
            className={station.fatalAction}
            onClick={() => void onClose()}
            disabled={closing}
            aria-busy={closing || undefined}
            data-testid="softphone-elsewhere-close"
          >
            {closing ? 'Closing…' : SOFTPHONE_ELSEWHERE_COPY.close}
          </button>
        )}
        {failure ? (
          <p className="error-text" data-testid="softphone-elsewhere-failure">
            {failure}
          </p>
        ) : null}
        {there.switchable ? (
          <button
            ref={goThereRef}
            type="button"
            className={callPending ? station.fatalAction : station.fatalEscape}
            onClick={() => setActiveAccountId(refusal.account_id)}
            disabled={closing}
            data-testid="softphone-elsewhere-go-there"
          >
            {SOFTPHONE_ELSEWHERE_COPY.goThere(there.name)}
          </button>
        ) : null}
        <StationEscape toCampaign={false} campaignId="" />
      </div>
    </div>
  );
}

/**
 * The 409 `session_on_campaign` answer: the agent is still at a campaign station.
 * The remedy is switching THAT session to the soft phone (§4.2) — queued behind a
 * call or wrap-up exactly like a break — and the station then shows the soft
 * phone in place.
 */
function CampaignSessionScreen({
  refusal,
  tenantId,
  accountId,
}: {
  refusal: SoftphoneSessionOnCampaignRefusal;
  tenantId: string | null;
  accountId: string | null;
}) {
  const navigate = useNavigate();
  const [switching, setSwitching] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const stationPath = `/station?campaign=${encodeURIComponent(refusal.campaign_id)}`;
  const midCall = refusal.state === 'reserved' || refusal.state === 'on_call' || refusal.state === 'wrapup';
  const stateLabel = AGENCY_FLOOR_STATE_LABELS[refusal.state]?.toLowerCase() ?? refusal.state;

  const onSwitch = async () => {
    setSwitching(true);
    setFailure(null);
    const result = await switchToSoftphone(refusal.session_id, tenantId ?? undefined, accountId ?? undefined);
    trackAgencySoftphoneSwitch({
      action: 'start',
      queued: result.ok ? Boolean(result.value.pending_state) : false,
      outcome: result.ok ? 'accepted' : 'refused',
      code: result.ok ? null : result.refusal.code,
    });
    if (result.ok) {
      navigate(stationPath);
      return;
    }
    setSwitching(false);
    setFailure(refusalCopy(result.refusal));
  };

  return (
    <div className={station.shell}>
      <div className={station.fatal} role="alert" data-testid="softphone-on-campaign">
        <h1>You’re still at the {refusal.campaign_name} station</h1>
        <p>
          You’re joined to {refusal.campaign_name} — {stateLabel}. You can only have one session at a time.
        </p>
        <p>
          {midCall
            ? 'Switch that station to the soft phone and it switches after this call and its wrap-up. You stay on the campaign and can go back to it from the station.'
            : 'Switch that station to the soft phone. You stay on the campaign and can go back to it from the station.'}
        </p>
        <button
          type="button"
          className={station.fatalAction}
          onClick={() => void onSwitch()}
          disabled={switching}
          data-testid="softphone-switch-from-campaign"
        >
          {switching ? 'Switching…' : 'Switch to soft phone'}
        </button>
        {failure ? (
          <p className="error-text" data-testid="softphone-switch-failure">
            {failure}
          </p>
        ) : null}
        <Link className={station.fatalEscape} to={stationPath} data-testid="softphone-go-to-station">
          Go to station
        </Link>
      </div>
    </div>
  );
}
