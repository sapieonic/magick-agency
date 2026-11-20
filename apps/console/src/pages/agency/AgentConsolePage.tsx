import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Ban, Check, CircleCheck, Coffee, Info, MessageSquare, MicOff, Play, RefreshCw, TriangleAlert, WifiOff, X } from 'lucide-react';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { useOptionalTheme } from '../../contexts/ThemeContext';
import { usePermission } from '../../hooks/usePermission';
import { useAgencyConsole, type AgencyConsoleState } from './useAgencyConsole';
import { useStationJoin, useLiveSessionTouch, type StationJoin } from './station/useStationJoin';
import { useStationExit } from './station/useStationExit';
import {
  useStationShortcuts,
  type BreakMenuHandle,
  type DncControlHandle,
  type StationScreenKeys,
} from './station/useStationShortcuts';
import { useHangup } from './station/useHangup';
import { useDncAction } from './station/useDncAction';
import { useStationSoftphone } from './station/useStationSoftphone';
import { useStationHelp, type StationHelp } from './station/useStationHelp';
import { useDeviceChecks } from './station/useDeviceChecks';
import { useMyDay } from './station/useMyDay';
import { ScriptOpeningCard, ScriptStepsCard } from '../../components/agency/station/StationScript';
import { fillScript, scriptOrNone, scriptValuesFor } from '../../utils/agency/stationScript';
import { FloorAssistAnnouncer, useFloorAssistAnnouncer } from '../../components/agency/SupervisorMessages';
import { FLOOR_ASSIST_FLAG } from '../../utils/agency/floorAssistFlag';
import { SoftphoneView } from '../../components/softphone/SoftphoneView';
import { InboundCallView, LapseCountdown, TalkTimer } from '../../components/agency/inbound/InboundCallView';
import { useInboundCall } from '../../hooks/useInboundCall';
import { SoftphoneDisclosures } from '../../components/softphone/SoftphoneHeader';
import { CueFlashBand } from '../../components/agency/CueFlashBand';
import type { DispositionPadHandle } from '../../components/agency/DispositionPad';
import { JoinConflictScreen, SoftphoneJoinScreen, StationFatal } from '../../components/agency/station/StationJoinScreens';
import { HoldToConfirmButton, type HoldToConfirmCopy } from '../../components/agency/HoldToConfirmButton';
import { CustomerWaitingPill } from '../../components/agency/inbound/CustomerWaitingPill';
import { CueSettingsFields } from '../../components/agency/CueSettings';
import { StationListenFirstNotice, StationListenNotice } from '../../components/agency/StationListenNotice';
import { MyContactsPanel, myContactsLockReason } from '../../components/agency/MyContactsPanel';
import { MoreMenu, NeedHelpButton, StationBanner, StationFrame } from '../../components/agency/station/StationFrame';
import { KeptCountdown, RetryCountdown, SinceClock, TimeLeftRing } from '../../components/agency/station/StationClocks';
import { CustomerCardView, LastCallsCard, NoteCard } from '../../components/agency/station/StationCustomer';
import { WhatHappened } from '../../components/agency/station/WhatHappened';
import {
  BreakCard,
  CallLaterCard,
  FinishCard,
  DeviceCheckTiles,
  ListenNoticeLine,
  MyDayCard,
  NoInternetCard,
  OtherDeviceCard,
  StartOfDayBody,
  StationDialog,
  StopCallingDialog,
  WaitingCard,
  WhatToDo,
  WhichBreakDialog,
  type WorkMode,
} from '../../components/agency/station/StationScreens';
import stationStyles from '../../components/agency/station/Station.module.css';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { useDialActivityDisplay } from '../../hooks/useDialActivityDisplay';
import { useRepaintTick } from '../../hooks/useRepaintTick';
import { useReadAloud } from '../../hooks/useSpeech';
import { CONTACT_ASSIGNMENT_FLAG } from '../../utils/agencyAssignmentCopy';
import { effectiveQueue, nothingDueCopy } from '../../utils/agencyStationIdle';
import { formatSpineTimestamp } from '../../utils/agencySpineCopy';
import { trackAgencyStationNothingDue } from '../../analytics/events';
import { agencyAudioNotice } from '../../utils/agencyAudioCopy';
import { LIVE_LISTEN_FLAG } from '../../utils/listen/liveListenFlag';
import { hasWrapup, wrapupView } from '../../utils/agencyWrapup';
import { findDisposition } from '../../utils/agencyDispositionForm';
import { SOFTPHONE_BREAK_REASON } from '../../types/softphone';
import { reservedBreakReasonLabel } from '../../utils/agency/reservedBreakReason';
import { messageSender } from '../../utils/agency/stationHelp';
import { brand } from '../../brand';
import {
  STATION_BLOCK_COPY,
  STATION_COPY,
  helpAnsweredLine,
  helpRefusedLine,
  missedReleaseLine,
  releaseBanner,
} from '../../utils/agency/stationCopy';
import { clockTime, runningClock } from '../../utils/agency/stationFormat';
import { customerCard, lastCallRows } from '../../utils/agency/stationCustomer';
import { MAIN_ACTION_KEY, sideViewBand, stationView, type MoreItem, type SideCallPhase, type StationView } from '../../utils/agency/stationView';
import { contactName, softphonePhase } from '../../utils/softphone/callState';
import { formatDialNumber } from '../../utils/softphone/phoneInput';
import { inboundCallerLabel } from '../../utils/inbound/inboundCall';

/**
 * The agent's station (`/station?campaign=…`), redesigned (AS1–AS18, `docs/agent-station.md`;
 * screens and copy in `docs/agent-station/design-spec.md`).
 *
 * ── One state, one screen ────────────────────────────────────────────────────
 * The view model (`utils/agency/stationView.ts`) turns the server's agent state, the socket's
 * connection state and a few client facts into the screen, its band (colour, icon, title,
 * subtitle), its one main action and what Need help and ⋮ More offer. This page composes that
 * screen from the station's existing flows, which are unchanged: the station socket
 * (`useAgencyStation`), the console's sequencing (`useAgencyConsole`), join and its conflicts,
 * the hang-up, the outcome save, notes autosave, breaks, wrap-up redial, DNC, help and supervisor
 * messages, the soft phone and inbound calls.
 *
 * ── The rules that replace "geometry is frozen" (AS1, spec §6.1) ───────────────
 *  1. **Hide, don't disable.** A control that does not belong to the screen is not on it. The one
 *     exception is Save on What happened? before a tile is picked: faded, and pressing it shakes the
 *     tiles and says what is missing.
 *  2. **The main button never moves.** It is the footer's last control, bottom right; End call is
 *     never where another button was a moment ago (Call coming has no button at all, AS11).
 *  3. **Nothing moves while a state is on screen.** Screens change only on a state change.
 *  4. **Only authoritative frames move the screen** (unchanged): the view model reads the station
 *     state, never the bridge's diagnostic `status` frames.
 *  5. **Focus moves once per call** (unchanged): to the station body when a call is coming, never
 *     at connect, keyed on the ringing attempt's id.
 */
export default function AgentConsolePage() {
  const [params] = useSearchParams();
  const campaignId = params.get('campaign') ?? '';
  const { tenantId, accountId, role } = useTenant();

  const join = useStationJoin({ campaignId, tenantId, accountId, role });
  const { bootstrap } = join;
  const cons = useAgencyConsole(bootstrap, tenantId ?? undefined, accountId ?? undefined);
  const { station } = cons;

  // Floor assist (LF4, LF5, LF24–LF26): Need help and supervisors' messages.
  const floorAssistOn = useFeatureFlagEnabled(FLOOR_ASSIST_FLAG);
  const help = useStationHelp({
    offered: floorAssistOn,
    everywhere: true,
    sessionId: bootstrap?.session_id ?? null,
    tenantId: tenantId ?? undefined,
    accountId: accountId ?? undefined,
    station,
  });
  /*
    What supervisors say, out loud (LF25): held here, above every screen, and rendered once after
    it, so moving between screens neither remounts the region nor says anything again.
  */
  const announced = useFloorAssistAnnouncer(station.supervisorMessages, help.announcement);

  return (
    <>
      <StationScreen campaignId={campaignId} join={join} cons={cons} help={help} />
      <FloorAssistAnnouncer lines={announced} />
    </>
  );
}

/** The hang-up's words on the station (AS3): the same hold and `E` `E`, said plainly. */
const END_CALL_COPY: HoldToConfirmCopy = {
  idPrefix: 'hangup',
  labels: {
    idle: STATION_COPY.endCall,
    holding: STATION_COPY.endCallHolding,
    armed: STATION_COPY.endCallArmed,
    ending: STATION_COPY.endCallEnding,
    failed: STATION_COPY.endCall,
  },
  hint: STATION_COPY.endCallHint,
  failedCopy: STATION_COPY.endCallFailed,
  shortcutScope: 'window',
  confirmation: 'external',
  analyticsControl: 'hangup',
};

/** 02b's "The last call did not connect": how long it stays (or until the next call). */
export const LAST_CALL_BANNER_MS = 6_000;

/** The My calls page, opened in a new tab from ⋮ More. */
const MY_CALLS_PATH = '/dialer/attempts';

function StationScreen({
  campaignId,
  join,
  cons,
  help,
}: {
  campaignId: string;
  join: StationJoin;
  cons: AgencyConsoleState;
  help: StationHelp;
}) {
  const { tenantId, accountId, role } = useTenant();
  const { user } = useAuth();
  const themeContext = useOptionalTheme();
  const theme = themeContext?.theme ?? 'light';
  const readAloud = useReadAloud();
  const { bootstrap } = join;

  const bodyRef = useRef<HTMLElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const breakMenuRef = useRef<BreakMenuHandle | null>(null);
  const padRef = useRef<DispositionPadHandle | null>(null);
  const dncRef = useRef<DncControlHandle | null>(null);

  const mayMarkDnc = usePermission('agency.dnc.write');

  const { station, clock, audio } = cons;
  const { connection, agentState, live, release, dialing } = station;
  const micNotice = agencyAudioNotice(audio.error);

  useLiveSessionTouch({ tenantId, bootstrap, agentState, connection });

  // ── The agent's own queue (contact assignment) ──────────────────────────────
  const queue = effectiveQueue(station.queue, bootstrap?.queue);
  const nothingDue = nothingDueCopy(queue, formatSpineTimestamp);
  const nothingDueReason = nothingDue !== null ? queue?.reason ?? null : null;
  useEffect(() => {
    if (!nothingDueReason || !bootstrap) return;
    trackAgencyStationNothingDue({ campaign_id: bootstrap.campaign_id, reason: nothingDueReason });
  }, [nothingDueReason, bootstrap]);

  // ── My customers (today's My contacts panel) ────────────────────────────────
  const assignmentEnabled = useFeatureFlagEnabled(CONTACT_ASSIGNMENT_FLAG);
  const assigns = bootstrap?.assignment_mode !== undefined && bootstrap.assignment_mode !== 'pool';
  const myContactsOffered = assignmentEnabled && bootstrap !== null && (assigns || bootstrap.allow_agent_retry === true);
  const myContactsLock = myContactsLockReason(agentState, connection === 'open');
  const [myContactsOpen, setMyContactsOpen] = useState(false);
  useEffect(() => {
    if (myContactsLock !== null) setMyContactsOpen(false);
  }, [myContactsLock]);
  const myContactsShown = myContactsOpen && myContactsLock === null && bootstrap !== null;

  // ── Focus moves once per call, to the station body, keyed on the ringing attempt's id ──
  const ringingAttemptId = live && live.bridgedAt === null ? live.attempt.attempt_id : null;
  useEffect(() => {
    if (ringingAttemptId !== null) bodyRef.current?.focus();
  }, [ringingAttemptId]);

  const { panelAttempt } = cons;
  const card = useMemo(
    () =>
      panelAttempt
        ? customerCard(panelAttempt, bootstrap?.context_display, { phoneDisplay: bootstrap?.phone_display ?? 'full' })
        : null,
    [panelAttempt, bootstrap?.context_display, bootstrap?.phone_display],
  );
  const script = useMemo(() => scriptOrNone(bootstrap?.script), [bootstrap?.script]);
  const filledScript = useMemo(() => {
    if (!script || !panelAttempt || !card) return null;
    const values = scriptValuesFor(panelAttempt, card, { agentName: user?.display_name, campaignName: bootstrap?.campaign_name });
    return { opening: script.opening ? fillScript(script.opening, values) : null, steps: script.steps.map((line) => fillScript(line, values)) };
  }, [script, panelAttempt, card, user?.display_name, bootstrap?.campaign_name]);
  const lastCalls = useMemo(
    () => (panelAttempt ? lastCallRows(panelAttempt, bootstrap?.disposition_catalog) : []),
    [panelAttempt, bootstrap?.disposition_catalog],
  );

  const exit = useStationExit({ campaignId, bootstrap, tenantId, accountId, role, agentState });
  const { hangup, hangupFailure } = useHangup({ live, bootstrap, tenantId, accountId, clock });
  const dnc = useDncAction({
    // On What happened? the call is over; the number is still the one on screen.
    liveAttemptId: live?.attempt.attempt_id ?? panelAttempt?.attempt_id ?? null,
    panelAttemptId: panelAttempt?.attempt_id ?? null,
    bootstrap,
    tenantId,
    accountId,
  });

  const softphone = useStationSoftphone({
    bootstrap,
    cons,
    tenantId: tenantId ?? undefined,
    accountId: accountId ?? undefined,
    userId: user?.id ?? null,
  });

  // ── An inbound call (P2, `docs/inbound.md` §6): its own view, on this station ──
  const inbound = useInboundCall({
    tenantId: tenantId ?? undefined,
    accountId: accountId ?? undefined,
    sessionId: bootstrap?.session_id ?? null,
    connection,
    frameCall: station.inboundCall,
    clock,
    audio: { muted: audio.muted, sending: audio.sending, toggleMute: audio.toggleMute },
    mayMarkDnc,
  });
  const inboundActive = inbound.call !== null;

  // ── Hidden dials (late binding) ─────────────────────────────────────────────
  const dialActivity = useDialActivityDisplay(
    station.dialActivity,
    agentState === 'available' && dialing && connection === 'open' && panelAttempt === null && !inboundActive,
  );
  const diallingCustomer = dialActivity?.dialling === true;

  // ── Start of day ────────────────────────────────────────────────────────────
  const notWorkingYet = agentState === 'offline' && live === null;
  const checks = useDeviceChecks(notWorkingYet && bootstrap !== null);
  const [workMode, setWorkMode] = useState<WorkMode>('calls_come');
  const { myDay, callLaters } = useMyDay({
    campaignId: bootstrap?.campaign_id ?? null,
    tenantId,
    accountId,
    agentState,
    enabled: bootstrap !== null,
    callLaterFallback: assignmentEnabled && assigns,
  });
  const listenOn = useFeatureFlagEnabled(LIVE_LISTEN_FLAG);

  // ── The screen's own state ──────────────────────────────────────────────────
  const [finishOpen, setFinishOpen] = useState(false);
  const [breakDialog, setBreakDialog] = useState<null | 'now' | 'after_save'>(null);
  const [stopAsk, setStopAsk] = useState<null | { code: string | null; origin: 'shortcut' | 'click' }>(null);
  const [soundOpen, setSoundOpen] = useState(false);
  const [saveShake, setSaveShake] = useState(0);
  const [saveBlock, setSaveBlock] = useState<string | null>(null);

  // A call arriving closes Finish work's question: the agent is working.
  const callOnScreen = live !== null || agentState === 'reserved' || agentState === 'on_call' || agentState === 'wrapup';
  useEffect(() => {
    if (callOnScreen) setFinishOpen(false);
  }, [callOnScreen]);
  // A call coming closes the Sound settings: the agent needs to see who is coming, and focus
  // moves to the station body for it (once per call).
  useEffect(() => {
    if (ringingAttemptId !== null) setSoundOpen(false);
  }, [ringingAttemptId]);
  // A new pick, or a new call, retires the early-Save line.
  useEffect(() => {
    setSaveBlock(null);
  }, [cons.form.selectedCode, cons.form.callbackAt, cons.form.promiseDate, panelAttempt?.attempt_id]);

  // ── What happened? ──────────────────────────────────────────────────────────
  const wrapup = station.wrapup;
  const outcomeOwed =
    live === null &&
    (agentState === 'wrapup' || hasWrapup(wrapup) || (agentState === 'on_call' && release !== null && release.requires_disposition));
  const holding = wrapup ? wrapupView(wrapup, clock.now(), cons.dispositionSubmitted).holding : false;

  // ── Breaks ──────────────────────────────────────────────────────────────────
  const onBreak = agentState === 'break';
  /*
    07 turns into 08 with time alone. The root does not repaint on a clock (the timers are their own
    leaves), so it renders once more at the instant the limit passes, and only then.
  */
  const breakSinceMs = onBreak ? clock.corrected(station.agentStateSince) : null;
  const breakOverAt = breakSinceMs !== null && cons.breakLimitMinutes !== null ? breakSinceMs + cons.breakLimitMinutes * 60_000 : null;
  useRenderAt(breakOverAt === null ? null : breakOverAt + 1);
  const breakElapsedMs = onBreak ? clock.since(station.agentStateSince) : null;
  const reservedBreak = onBreak
    && station.breakReasonCode !== null
    && station.breakReasonCode !== SOFTPHONE_BREAK_REASON
    && reservedBreakReasonLabel(station.breakReasonCode) !== null;

  // ── The call kept through a drop (10) ───────────────────────────────────────
  const [droppedAt, setDroppedAt] = useState<number | null>(null);
  useEffect(() => {
    if (connection === 'open') setDroppedAt(null);
    else if ((connection === 'reconnecting' || connection === 'disconnected') && live !== null) {
      setDroppedAt((was) => was ?? Date.now());
    }
  }, [connection, live]);

  // ── The view model ──────────────────────────────────────────────────────────
  const firstName = (user?.display_name ?? '').trim().split(/\s+/)[0] || null;
  const view: StationView = stationView({
    firstName,
    connection,
    agentState,
    call: live === null ? 'none' : live.bridgedAt === null ? 'ringing' : 'connected',
    outcomeOwed,
    dialing,
    campaignReason: station.campaignReason,
    queue,
    diallingCustomer,
    breakReasonLabel: cons.breakReasonLabel,
    breakLimitMinutes: cons.breakLimitMinutes,
    breakElapsedMs,
    reservedBreak,
    checks,
    finishOpen,
    helpOffered: help.offered,
    helpOpen: help.open,
    helpEverywhere: help.everywhere,
    softphoneAvailable: softphone.available,
    myContactsOffered,
  });
  // The other-device screen the JOIN decided (OS3): the same 12, with the join's own way back.
  const joinOtherDevice = join.onOtherDevice;
  const shownView: StationView = joinOtherDevice
    ? {
      ...view,
      screen: 'other_device',
      tone: 'quiet',
      icon: 'device',
      title: STATION_COPY.otherDeviceTitle,
      subtitle: STATION_COPY.otherDeviceSubtitle,
      needHelp: false,
      menu: [],
      main: 'use_this_computer',
      footHint: null,
    }
    : view;
  const screen = shownView.screen;

  // ── Actions ─────────────────────────────────────────────────────────────────
  const startWork = () => {
    if (cons.presenceBusy) return;
    if (workMode === 'dial_myself' && softphone.available) {
      // The click is the gesture the audio path needs, as Start work's own preflight is.
      audio.preflight();
      cons.requestSoftphone();
    } else {
      cons.goAvailable('click');
    }
  };
  const checkAgain = () => {
    checks.recheck();
    if (connection === 'reconnecting' || connection === 'disconnected') station.reconnect();
  };
  /** Save & next call. Before a tile is picked it says what is missing and shakes the tiles (spec §6.1). */
  const trySave = (): boolean => {
    if (!cons.padEnabled || cons.submitting || cons.dispositionSubmitted) return false;
    const block = cons.blockAt(clock.now());
    if (block !== null) {
      setSaveShake((n) => n + 1);
      setSaveBlock(STATION_BLOCK_COPY[block]);
      if (block === 'note_required') notesRef.current?.focus();
      return false;
    }
    cons.submit();
    return true;
  };
  const saveAndBreak = () => {
    if (!cons.padEnabled || cons.blockAt(clock.now()) !== null) {
      trySave();
      return;
    }
    setBreakDialog('after_save');
  };
  const pickBreak = (code: string) => {
    const afterSave = breakDialog === 'after_save';
    setBreakDialog(null);
    // Save & take break (spec 5.4, backend plan G): book the break first, then save.
    cons.requestBreak(code);
    if (afterSave) trySave();
  };
  const askStop = (code: string | null, origin: 'shortcut' | 'click') => {
    const suppress = code ?? cons.catalog.find((e) => e.suppress)?.code ?? null;
    if (suppress === null && !mayMarkDnc) return;
    setStopAsk({ code: suppress, origin });
  };
  const confirmStop = () => {
    if (!stopAsk) return;
    if (stopAsk.code !== null) {
      // An outcome that stops calls: picking it IS the answer; saving records it.
      cons.noteCodeSelectionMethod('click');
      cons.setForm({ ...cons.form, selectedCode: stopAsk.code });
      setStopAsk(null);
      return;
    }
    dnc.confirm('campaign', stopAsk.origin);
  };
  useEffect(() => {
    if (dnc.outcome) setStopAsk(null);
  }, [dnc.outcome]);

  /*
    The handles the keyboard drives (`useStationShortcuts`): B opens Which break? (AS10: on a call
    it books the break for after it), D asks Don't call again on a call or on What happened?.
  */
  breakMenuRef.current = {
    open: () => {
      if (screen === 'on_break' || screen === 'break_over' || screen === 'finish' || screen === 'other_device' || screen === 'work_ended') return;
      setBreakDialog('now');
    },
  };
  dncRef.current = {
    open: () => {
      if (screen !== 'on_call' && screen !== 'happened' && screen !== 'coming') return;
      if (panelAttempt === null) return;
      askStop(null, 'shortcut');
    },
  };

  /*
    C picks the call-later outcome. On What happened? the tiles own it (and move focus to Call
    when?); on the call, where the tiles are not on screen yet, it is picked so What happened?
    opens with it chosen, as the pad on the old screen did.
  */
  const keyPadRef = useRef<DispositionPadHandle | null>(null);
  keyPadRef.current = {
    selectCallback: () => {
      if (padRef.current) return padRef.current.selectCallback();
      if (!cons.padEnabled) return false;
      const entry = cons.catalog.find((option) => option.requires_datetime);
      if (!entry) return false;
      cons.noteCodeSelectionMethod('click');
      cons.setForm({ ...cons.form, selectedCode: entry.code });
      return true;
    },
  };

  const enterFor: Partial<Record<StationView['screen'], () => void>> = {
    start: startWork,
    check_failed: checkAgain,
    happened: () => void trySave(),
    other_device: joinOtherDevice ? join.useThisWindow : station.reconnect,
  };
  const screenKeys: StationScreenKeys = {
    enter: enterFor[screen] ?? null,
    r: connection !== 'open' && connection !== 'idle' && connection !== 'connecting' ? station.reconnect : null,
    m: audio.sending ? audio.toggleMute : null,
    // While the leave is in flight the question stays: a failure must land on a screen that is there.
    escape: screen === 'finish' ? () => { if (!exit.leaving) setFinishOpen(false); } : null,
  };

  // Suspended under the soft phone and an inbound call (their own keyboards), under My customers,
  // and under the station's own dialogs.
  useStationShortcuts(
    {
      agentState,
      cons,
      bootstrap,
      suspended: softphone.active || inboundActive || myContactsShown || breakDialog !== null || stopAsk !== null || soundOpen,
      screenKeys,
    },
    { breakMenuRef, notesRef, padRef: keyPadRef, dncRef },
  );

  // ── Screens the join decides, in the station's frame ────────────────────────
  const agentName = user?.display_name?.trim() || user?.email || 'Agent';
  const who = { agentName, brandMark: brand.shortName };
  if (join.joinConflict) {
    return (
      <JoinConflictScreen
        who={who}
        conflict={join.joinConflict}
        toCampaign={exit.canExitToCampaign}
        campaignId={exit.stationCampaignId}
        confirming={join.switchConfirm}
        switching={join.switching}
        switchFailure={join.switchFailure}
        onBeginSwitch={join.beginSwitch}
        onConfirmSwitch={() => void join.confirmSwitch()}
        onCancelSwitch={join.cancelSwitch}
      />
    );
  }
  if (join.onSoftphoneElsewhere) {
    return (
      <SoftphoneJoinScreen
        who={who}
        closing={join.closingSoftphone}
        failure={join.closeSoftphoneFailure}
        callPending={join.softphoneCallPending}
        onCloseAndJoin={join.closeSoftphoneAndJoin}
      />
    );
  }
  if (join.joinError) {
    return <StationFatal who={who} message={join.joinError} toCampaign={exit.canExitToCampaign} campaignId={exit.stationCampaignId} />;
  }

  // ── The redesigned station ──────────────────────────────────────────────────
  const workName = bootstrap?.campaign_name ?? null;
  const internet: 'ok' | 'checking' | 'offline' =
    connection === 'open' ? 'ok' : connection === 'reconnecting' || connection === 'disconnected' ? 'offline' : 'checking';

  const onMenu = (item: MoreItem) => {
    switch (item) {
      case 'my_customers': setMyContactsOpen(true); break;
      case 'dial_myself': cons.requestSoftphone(); break;
      case 'sound': setSoundOpen(true); break;
      case 'theme': themeContext?.toggleTheme(); break;
      case 'finish': setFinishOpen(true); break;
      case 'my_calls': break;
    }
  };

  // ── Banners: at most one state banner and one supervisor line (spec §3) ──────
  /*
    The microphone banner stands apart from the one state banner: a microphone that does not work
    is the one failure with no other symptom (the call connects and the customer hears nothing), so
    nothing may outrank it, and it may not hide the answer to the agent's own press either.
  */
  const micBannerNode = micNotice ? (
    <StationBanner
      tone="problem"
      icon={<MicOff size={22} />}
      role="alert"
      testId="mic-failure"
      action={micNotice.action ? (
        <button type="button" className={stationStyles.btn} onClick={audio.resume} data-testid="mic-resume">{STATION_COPY.turnSoundOn}</button>
      ) : undefined}
    >
      <b>{micNotice.headline}</b> <small>{micNotice.remedy}</small>
    </StationBanner>
  ) : null;
  const stateBanner = ((): ReactNode => {
    if (screen === 'happened' && connection !== 'open') {
      return (
        <StationBanner
          tone="problem"
          icon={<WifiOff size={22} />}
          role="status"
          testId="happened-internet"
          action={<button type="button" className={stationStyles.btn} onClick={station.reconnect} data-testid="happened-try-again">{STATION_COPY.tryAgainNow}</button>}
        >
          {STATION_COPY.internetOnHappened}
        </StationBanner>
      );
    }
    if (hangupFailure) {
      return <StationBanner tone="problem" icon={<TriangleAlert size={22} />} role="alert" testId="hangup-failure">{hangupFailure}</StationBanner>;
    }
    if (cons.presenceRefusal) {
      return <StationBanner tone="problem" icon={<TriangleAlert size={22} />} role="alert" testId="presence-refusal">{cons.presenceRefusal}</StationBanner>;
    }
    if (inbound.notice) {
      return <StationBanner tone="quiet" icon={<Info size={22} />} testId="inbound-notice">{inbound.notice}</StationBanner>;
    }
    if (screen === 'happened' && holding && !cons.dispositionSubmitted) {
      const supervisor = wrapup?.heldReason === 'supervisor_hold';
      return (
        <StationBanner tone="over" icon={<TriangleAlert size={22} />} testId={supervisor ? 'supervisor-hold' : 'time-over'}>
          {supervisor ? STATION_COPY.heldBySupervisor : STATION_COPY.timeOverBanner}
        </StationBanner>
      );
    }
    if (screen === 'happened' && release?.reason === 'agent_disconnected') {
      return <StationBanner tone="problem" icon={<WifiOff size={22} />} testId="call-was-cut">{STATION_COPY.callWasCut}</StationBanner>;
    }
    if (screen === 'on_call' && audio.muted) {
      return <StationBanner tone="break" icon={<MicOff size={22} />} testId="on-mute">{STATION_COPY.onMute}</StationBanner>;
    }
    if (cons.lostDispositionNotice && (screen === 'ready' || screen === 'no_calls')) {
      return <StationBanner tone="quiet" icon={<Info size={22} />} testId="lost-disposition">{cons.lostDispositionNotice}</StationBanner>;
    }
    if (station.missedRelease && (screen === 'ready' || screen === 'no_calls' || screen === 'happened')) {
      return <StationBanner tone="quiet" icon={<Info size={22} />} testId="missed-release">{missedReleaseLine(station.missedRelease.reason)}</StationBanner>;
    }
    if (cons.breakAlreadyStarted) {
      return <StationBanner tone="break" icon={<Coffee size={22} />} testId="break-already-started">{STATION_COPY.breakAlreadyStarted}</StationBanner>;
    }
    if (cons.softphoneRejection) {
      return <StationBanner tone="problem" icon={<TriangleAlert size={22} />} role="status" testId="switch-to-softphone-refused">{cons.softphoneRejection}</StationBanner>;
    }
    if (dnc.failure && stopAsk === null) {
      return <StationBanner tone="problem" icon={<TriangleAlert size={22} />} role="alert" testId="dnc-failure">{dnc.failure}</StationBanner>;
    }
    if (dnc.outcome) {
      return <StationBanner tone="ready" icon={<Ban size={22} />} role="status" testId="dnc-outcome">{dnc.outcome}</StationBanner>;
    }
    if (release && (screen === 'ready' || screen === 'no_calls')) {
      // A call that ended owing an outcome but whose wrap-up never came (the server went straight
      // back to the pool): said until the next call, so the agent knows what became of it.
      if (release.requires_disposition) {
        return <StationBanner tone="quiet" icon={<Info size={22} />} role="status" testId="unexplained-release">{STATION_COPY.lastCallEnded}</StationBanner>;
      }
      const line = releaseBanner(release.reason);
      if (line) return <TimedBanner key={station.releasedAt ?? 0} at={station.releasedAt} line={line} />;
    }
    if (station.customerWaiting) {
      return (
        <StationBanner tone="coming" icon={<Info size={22} />} testId="customer-waiting-banner">
          <CustomerWaitingPill waiting={station.customerWaiting} />
        </StationBanner>
      );
    }
    return null;
  })();

  /*
    The supervisor line (spec 02b): a supervisor's message, one at a time with the rest counted, OK
    showing the next; else what became of a help request (answered, lapsed) or why it was refused.
  */
  const message = station.supervisorMessages[0] ?? null;
  const helpNotice = station.helpNotice;
  const helpRefusal = help.refusalKind ? helpRefusedLine(help.refusalKind) : null;
  const sentAt = message ? Date.parse(message.sent_at) : NaN;
  const supervisorBanner = message ? (
    <StationBanner
      message
      icon={<MessageSquare size={22} />}
      testId="supervisor-message"
      action={
        <button type="button" className={stationStyles.btn} onClick={() => station.dismissSupervisorMessage(message.id)} data-testid="supervisor-message-ok">
          {STATION_COPY.messageOk}
        </button>
      }
    >
      <small>
        <strong>{messageSender(message.from_name)}</strong> {STATION_COPY.supervisorSuffix}
        {Number.isNaN(sentAt) ? null : <> · <time dateTime={message.sent_at}>{clockTime(sentAt)}</time></>}
      </small>
      <p data-testid="supervisor-message-text">{message.text}</p>
      {station.supervisorMessages.length > 1 ? (
        <small data-testid="supervisor-messages-more">{STATION_COPY.moreMessages(station.supervisorMessages.length - 1)}</small>
      ) : null}
    </StationBanner>
  ) : helpRefusal ? (
    <StationBanner tone="problem" icon={<Info size={22} />} role="status" testId="need-help-refusal">
      {helpRefusal}
    </StationBanner>
  ) : helpNotice ? (
    <StationBanner
      tone={helpNotice.kind === 'answered' ? 'ready' : 'quiet'}
      icon={helpNotice.kind === 'answered' ? <CircleCheck size={22} /> : <Info size={22} />}
      testId="need-help-status"
      action={help.dismissible ? (
        <button type="button" className={stationStyles.btn} onClick={help.dismiss} data-testid="need-help-dismiss">{STATION_COPY.messageOk}</button>
      ) : undefined}
    >
      {helpNotice.kind === 'expired' ? STATION_COPY.helpExpired : helpAnsweredLine(helpNotice.by_name, helpNotice.how)}
    </StationBanner>
  ) : null;

  // ── The band's right side ───────────────────────────────────────────────────
  let bandSide: ReactNode = null;
  if (screen === 'ready' && station.agentStateSince) {
    bandSide = <span className={stationStyles.bandSide}><SinceClock anchor={station.agentStateSince} clock={clock} className={stationStyles.bandClock} testId="waiting-clock" /></span>;
  } else if (screen === 'coming') {
    bandSide = (
      <span className={stationStyles.bandSide}>
        <span className={stationStyles.pill}>{STATION_COPY.connecting}<span className={stationStyles.dots} aria-hidden="true"><i /><i /><i /></span></span>
      </span>
    );
  } else if (screen === 'on_call') {
    bandSide = (
      <span className={stationStyles.bandSide}>
        {bootstrap?.record_calls ? (
          <span className={stationStyles.pill} data-testid="call-recorded"><span className={stationStyles.recDot} aria-hidden="true" />{STATION_COPY.callRecorded}</span>
        ) : null}
        {live?.bridgedAt ? <SinceClock anchor={live.bridgedAt} clock={clock} className={stationStyles.bandClock} testId="talk-timer" /> : null}
      </span>
    );
  } else if (screen === 'happened' && hasWrapup(wrapup) && !cons.redial.countdownStopped) {
    // A redial placed stops the wrap-up's timer on the server, so its ring is withheld.
    bandSide = <span className={stationStyles.bandSide}><TimeLeftRing anchor={wrapup} clock={clock} submitted={cons.dispositionSubmitted} /></span>;
  } else if ((screen === 'on_break' || screen === 'break_over') && station.agentStateSince) {
    bandSide = <span className={stationStyles.bandSide}><SinceClock anchor={station.agentStateSince} clock={clock} className={stationStyles.bandClock} testId="break-clock" /></span>;
  } else if (screen === 'internet') {
    bandSide = <RetryCountdown at={station.nextRetryAt} />;
  } else if (screen === 'call_problem' && droppedAt !== null && bootstrap?.intervals.deferred_hangup_ms) {
    bandSide = <KeptCountdown from={droppedAt} windowMs={bootstrap.intervals.deferred_hangup_ms} />;
  }
  const bandSideWithFlash = (
    <>
      {/* The cue's visual channel, for an agent who cannot hear it (today's three cues, unchanged). */}
      {cons.cueFlash ? <CueFlashBand key={`${cons.cueFlash.cue}:${cons.cueFlash.attemptId}`} flash={cons.cueFlash} /> : null}
      {bandSide}
    </>
  );
  const bandSubtitle: ReactNode | undefined = screen === 'on_call' && card
    ? [card.name ?? card.phone, card.place].filter(Boolean).join(' · ')
    : screen === 'break_over' && breakOverAt !== null
      ? <LateBy overAt={breakOverAt} />
      // Late binding: a hidden dial ringing is said in the band, the station's polite status region.
      : screen === 'ready' && diallingCustomer
        ? STATION_COPY.diallingSubtitle
        : undefined;

  // ── The main action, bottom right (AS1) ─────────────────────────────────────
  const keyHint = (main: NonNullable<StationView['main']>) =>
    MAIN_ACTION_KEY[main] ? <span className={stationStyles.key} aria-hidden="true">{MAIN_ACTION_KEY[main]}</span> : null;
  const big = `${stationStyles.btn} ${stationStyles.btnBig}`;
  let mainButton: ReactNode = null;
  switch (shownView.main) {
    case 'start_work':
      mainButton = (
        <button type="button" className={`${big} ${stationStyles.btnGo}`} onClick={startWork} aria-disabled={cons.presenceBusy || undefined} aria-keyshortcuts="Enter A" data-testid="start-work">
          <Play size={24} aria-hidden="true" />{cons.presenceBusy ? STATION_COPY.starting : STATION_COPY.startWork}{keyHint('start_work')}
        </button>
      );
      break;
    case 'check_again':
      mainButton = (
        <button type="button" className={`${big} ${stationStyles.btnBrand}`} onClick={checkAgain} aria-keyshortcuts="Enter" data-testid="check-again">
          <RefreshCw size={24} aria-hidden="true" />{STATION_COPY.checkAgain}{keyHint('check_again')}
        </button>
      );
      break;
    case 'take_break':
      mainButton = (
        <button type="button" className={`${big} ${stationStyles.btnBreak}`} onClick={() => setBreakDialog('now')} aria-keyshortcuts="B" data-testid="take-break">
          <Coffee size={24} aria-hidden="true" />{STATION_COPY.takeBreak}{keyHint('take_break')}
        </button>
      );
      break;
    case 'end_call':
      mainButton = (
        <span className={stationStyles.endCallWrap}>
          <HoldToConfirmButton
            attemptId={live?.attempt.attempt_id ?? null}
            enabled={Boolean(live)}
            onConfirm={hangup}
            copy={END_CALL_COPY}
            buttonClassName={stationStyles.endCall}
          />
        </span>
      );
      break;
    case 'save_next':
      mainButton = (
        <SaveNextButton
          cons={cons}
          now={clock.now}
          onSave={() => void trySave()}
          blockLine={saveBlock}
          shake={saveShake}
          keyHint={keyHint('save_next')}
        />
      );
      break;
    case 'start_calls':
      mainButton = (
        <button
          type="button"
          className={`${big} ${stationStyles.btnGo}`}
          onClick={() => !cons.presenceBusy && cons.endBreak('click')}
          aria-disabled={cons.presenceBusy || undefined}
          aria-keyshortcuts="A"
          data-testid="start-calls"
        >
          <Play size={24} aria-hidden="true" />{STATION_COPY.startCallsAgain}{keyHint('start_calls')}
        </button>
      );
      break;
    case 'try_again':
      mainButton = (
        <button type="button" className={`${big} ${stationStyles.btnBrand}`} onClick={station.reconnect} aria-keyshortcuts="R" data-testid="try-again">
          <RefreshCw size={24} aria-hidden="true" />{STATION_COPY.tryAgainNow}{keyHint('try_again')}
        </button>
      );
      break;
    case 'keep_working':
      mainButton = (
        <button
          type="button"
          className={`${big} ${stationStyles.btnGo}`}
          onClick={() => !exit.leaving && setFinishOpen(false)}
          aria-disabled={exit.leaving || undefined}
          aria-keyshortcuts="Escape"
          data-testid="keep-working"
        >
          {STATION_COPY.keepWorking}{keyHint('keep_working')}
        </button>
      );
      break;
    case 'use_this_computer':
      mainButton = (
        <button type="button" className={`${big} ${stationStyles.btnBrand}`} onClick={joinOtherDevice ? join.useThisWindow : station.reconnect} aria-keyshortcuts="Enter" data-testid="use-this-computer">
          {STATION_COPY.useThisComputer}{keyHint('use_this_computer')}
        </button>
      );
      break;
    case 'open_work_again':
      mainButton = (
        <button type="button" className={`${big} ${stationStyles.btnBrand}`} onClick={() => window.location.reload()} data-testid="open-work-again">
          {STATION_COPY.openWorkAgain}
        </button>
      );
      break;
    default:
      mainButton = null;
  }

  // ── Secondary actions, bottom left ──────────────────────────────────────────
  /*
    04b: a break booked for after the call is a chip with ✕ (spec §3), in the footer beside the
    call's own controls, so no banner can push it off the screen while it is still going to happen.
  */
  const queuedBreakChip = cons.pendingBreakLabel ? (
    <span className={`${stationStyles.btn} ${stationStyles.btnOn}`} role="status" data-testid="queued-break">
      <Coffee size={20} aria-hidden="true" />
      {cons.pendingSoftphone ? STATION_COPY.dialAfterCall : STATION_COPY.breakAfterCall(cons.pendingBreakLabel)}
      <button
        type="button"
        className={stationStyles.chipClose}
        onClick={() => !cons.cancelling && cons.cancelBreak()}
        aria-label={STATION_COPY.cancelBreakAfterCall}
        aria-disabled={cons.cancelling || undefined}
        data-testid="queued-break-cancel"
      >
        <X size={18} aria-hidden="true" />
      </button>
      {cons.cancelFailed ? <small role="alert">{STATION_COPY.breakCancelFailed}</small> : null}
    </span>
  ) : null;
  let footLeft: ReactNode = null;
  let footHint: ReactNode = shownView.footHint;
  let footRightLead: ReactNode = null;
  if (screen === 'start' && listenOn) footHint = <ListenNoticeLine />;
  if (screen === 'on_call' && audio.sending) {
    // Hidden while there is nothing to mute (AS1): a call whose microphone failed.
    footLeft = (
      <button
        type="button"
        className={`${stationStyles.btn} ${audio.muted ? stationStyles.btnOn : ''}`}
        onClick={audio.toggleMute}
        aria-pressed={audio.muted}
        aria-keyshortcuts="M"
        data-testid="mute-toggle"
      >
        <MicOff size={22} aria-hidden="true" />{audio.muted ? STATION_COPY.unmute : STATION_COPY.mute}
        <span className={stationStyles.key} aria-hidden="true">M</span>
      </button>
    );
  }
  if (screen === 'happened') {
    const redial = cons.redial;
    footLeft = (
      <>
        {!cons.dispositionSubmitted && cons.breakReasons.length > 0 ? (
          <button type="button" className={stationStyles.btn} onClick={saveAndBreak} data-testid="save-and-break">
            <Coffee size={22} aria-hidden="true" />{STATION_COPY.saveAndBreak}
          </button>
        ) : null}
        {redial.offered && (redial.enabled || redial.inFlight) ? (
          <button
            type="button"
            className={stationStyles.btn}
            onClick={() => redial.enabled && redial.redial()}
            aria-disabled={!redial.enabled || undefined}
            data-testid="wrapup-redial"
          >
            <RefreshCw size={22} aria-hidden="true" />
            {redial.inFlight ? STATION_COPY.callingAgain : STATION_COPY.callAgain}
            {redial.remaining !== null && !redial.inFlight ? <>{' '}<small>· {STATION_COPY.callAgainLeft(redial.remaining)}</small></> : null}
          </button>
        ) : null}
        {redial.refusal ? <span className={stationStyles.refusal} role="alert" data-testid="wrapup-redial-refusal">{redial.refusal}</span> : null}
        {saveBlock ? <span id="save-block" className={stationStyles.refusal} role="status" data-testid="save-block">{saveBlock}</span> : null}
      </>
    );
  }
  if (queuedBreakChip && (screen === 'coming' || screen === 'on_call' || screen === 'happened' || screen === 'call_problem')) {
    footLeft = <>{footLeft}{queuedBreakChip}</>;
  }
  if (screen === 'on_break' || screen === 'break_over') {
    footLeft = (
      <button type="button" className={`${stationStyles.btn} ${stationStyles.btnQuiet}`} onClick={() => setFinishOpen(true)} data-testid="break-finish-work">
        {STATION_COPY.menuFinish}
      </button>
    );
  }
  if (screen === 'finish') {
    footRightLead = (
      <button
        type="button"
        className={`${stationStyles.btn} ${stationStyles.btnStopOutline}`}
        onClick={() => !exit.leaving && exit.confirmLeave()}
        aria-disabled={exit.leaving || undefined}
        data-testid="yes-finish"
      >
        {exit.leaving ? STATION_COPY.finishing : STATION_COPY.yesFinish}
      </button>
    );
  }

  // ── The body ────────────────────────────────────────────────────────────────
  const noteCard = (
    <NoteCard
      ref={notesRef}
      value={cons.notes}
      onAgentEdit={cons.onNotesEdit}
      status={cons.notesStatusLine}
      foreignWrite={cons.notesForeignWrite}
      enabled={cons.notesEnabled}
      onSubmit={() => void trySave()}
      needed={Boolean(findDisposition(cons.catalog, cons.form.selectedCode)?.requires_note)}
    />
  );
  const amountDue = card?.amountDue ?? null;
  let body: ReactNode = null;
  let bodyClass: string | undefined = '';
  switch (screen) {
    case 'start':
      bodyClass = stationStyles.bodyCenter;
      body = (
        <StartOfDayBody
          checks={checks}
          internet={internet}
          workName={workName ?? ''}
          myDay={myDay}
          callLaterCount={callLaters ? callLaters.today : null}
          softphoneOffered={softphone.available}
          mode={workMode}
          onMode={setWorkMode}
        />
      );
      break;
    case 'check_failed': {
      const steps =
        connection === 'reconnecting' || connection === 'disconnected'
          ? STATION_COPY.stepsNoInternet
          : checks.microphone === 'blocked'
            ? STATION_COPY.stepsMicBlocked
            : checks.microphone === 'not_found'
              ? STATION_COPY.stepsMicMissing
              : checks.microphone === 'in_use'
                ? STATION_COPY.stepsMicInUse
                : STATION_COPY.stepsMicOther;
      bodyClass = stationStyles.bodyEven;
      body = (
        <>
          <section className={stationStyles.card}><DeviceCheckTiles checks={checks} internet={internet} /></section>
          <WhatToDo steps={steps} />
        </>
      );
      break;
    }
    case 'ready':
    case 'no_calls': {
      const quiet = screen === 'no_calls';
      const showDay = myDay !== null && (myDay.calls !== null || myDay.talkSeconds !== null || myDay.willPay !== null || myDay.dialled !== null);
      const showLater = callLaters !== null && callLaters.rows.length > 0;
      bodyClass = showDay || showLater ? stationStyles.body2 : stationStyles.bodyCenter;
      // "Nothing due now" with no dial ringing leaves the count out too, as the agent app does.
      const unanswered = !quiet && dialActivity ? dialActivity.unansweredInARow : 0;
      body = (
        <>
          <WaitingCard
            quiet={quiet}
            headline={quiet ? STATION_COPY.noCallsBody : diallingCustomer ? STATION_COPY.dialling : STATION_COPY.nextCallComing}
            waiting={station.agentStateSince ? <>{STATION_COPY.waiting}: <b><SinceClock anchor={station.agentStateSince} clock={clock} /></b></> : null}
            line={unanswered > 0 ? STATION_COPY.noAnswerFromLast(unanswered) : null}
          />
          {showDay || showLater ? (
            <div className={stationStyles.col}>
              {showDay ? <MyDayCard day={myDay} /> : null}
              {showLater ? <CallLaterCard list={callLaters} now={clock.now} /> : null}
            </div>
          ) : null}
        </>
      );
      break;
    }
    case 'coming':
      bodyClass = stationStyles.body2;
      body = (
        <>
          {card ? <CustomerCardView card={card} /> : <section className={stationStyles.card} />}
          {filledScript?.opening ? (
            <div className={stationStyles.col}>
              <ScriptOpeningCard line={filledScript.opening} readAloud={readAloud} />
              {panelAttempt ? <LastCallsCard rows={lastCalls} /> : null}
            </div>
          ) : panelAttempt ? (
            <LastCallsCard rows={lastCalls} />
          ) : null}
        </>
      );
      break;
    case 'on_call':
      bodyClass = stationStyles.bodyEven;
      // With the campaign's steps: the card and the last calls left, What to say and the note right.
      // Without (04c): the card left, the last calls and the note right.
      body = filledScript && filledScript.steps.length > 0 ? (
        <>
          <div className={stationStyles.col}>
            {card ? <CustomerCardView card={card} showLastSaid={false} /> : <section className={stationStyles.card} />}
            {panelAttempt ? <LastCallsCard rows={lastCalls} /> : null}
          </div>
          <div className={stationStyles.col}>
            <ScriptStepsCard key={panelAttempt?.attempt_id ?? ''} steps={filledScript.steps} readAloud={readAloud} />
            {noteCard}
          </div>
        </>
      ) : (
        <>
          {card ? <CustomerCardView card={card} showLastSaid={false} /> : <section className={stationStyles.card} />}
          <div className={stationStyles.col}>
            {panelAttempt ? <LastCallsCard rows={lastCalls} /> : null}
            {noteCard}
          </div>
        </>
      );
      break;
    case 'happened':
      bodyClass = stationStyles.bodyWideLeft;
      body = (
        <>
          <WhatHappened
            catalog={cons.catalog}
            form={cons.form}
            onChange={(next) => {
              // Every pick through the tiles is a click; the digits set the form themselves.
              cons.noteCodeSelectionMethod('click');
              cons.setForm(next);
            }}
            enabled={cons.padEnabled}
            now={clock.now}
            handleRef={padRef}
            amountDue={amountDue}
            comesToMe={assigns}
            rejection={cons.padRejection}
            keysRemapped={cons.keysRemapped}
            onNeedsNote={() => notesRef.current?.focus()}
            readAloud={readAloud}
            onAskDontCallAgain={(code) => askStop(code, 'click')}
            dontCallAgainOffered={mayMarkDnc && panelAttempt !== null}
            shake={saveShake}
          />
          <div className={stationStyles.col}>
            {card ? <CustomerCardView card={card} compact /> : null}
            {noteCard}
          </div>
        </>
      );
      break;
    case 'on_break':
    case 'break_over':
      bodyClass = stationStyles.bodyCenter;
      body = (
        <BreakCard
          label={reservedBreak ? null : cons.breakReasonLabel}
          since={station.agentStateSince}
          clock={clock}
          limitMinutes={cons.breakLimitMinutes}
          over={screen === 'break_over'}
        />
      );
      break;
    case 'internet':
      bodyClass = stationStyles.body2;
      body = (
        <>
          <NoInternetCard />
          <WhatToDo steps={STATION_COPY.stepsInternet} />
        </>
      );
      break;
    case 'call_problem':
      bodyClass = stationStyles.bodyEven;
      body = (
        <>
          {card ? <CustomerCardView card={card} showLastSaid={false} /> : <section className={stationStyles.card} />}
          <WhatToDo steps={STATION_COPY.stepsCallProblem} />
        </>
      );
      break;
    case 'finish':
      bodyClass = stationStyles.bodyCenter;
      body = (
        <FinishCard myDay={myDay} callLaters={callLaters} now={clock.now} failure={exit.leaveFailure ? STATION_COPY.finishFailed : null} />
      );
      break;
    case 'other_device':
      bodyClass = stationStyles.bodyCenter;
      body = <OtherDeviceCard title={STATION_COPY.otherDeviceBody} hint={STATION_COPY.otherDeviceHint} />;
      break;
    case 'work_ended':
      bodyClass = stationStyles.bodyCenter;
      body = <OtherDeviceCard title={STATION_COPY.workEndedTitle} hint={STATION_COPY.workEndedSubtitle} />;
      break;
  }

  const needHelp = (
    <>
      {/* LS2: the standing "a supervisor may listen" line, behind its info button (only while the flag is on). */}
      <StationListenNotice />
      {shownView.needHelp ? <NeedHelpButton help={help} raisedAt={station.help?.raised_at ?? null} nowMs={clock.now} /> : null}
    </>
  );
  const menu = (
    <MoreMenu
      items={themeContext ? shownView.menu : shownView.menu.filter((item) => item !== 'theme')}
      theme={theme}
      onSelect={onMenu}
      myCallsTo={MY_CALLS_PATH}
    />
  );

  // ── An inbound call and the soft phone: their own bodies in the station's frame (ruling 2) ──
  const sideNeedHelp = (onCall: boolean) => (
    <>
      <StationListenNotice />
      {help.offered && connection === 'open' && (help.open || help.everywhere || onCall)
        ? <NeedHelpButton help={help} raisedAt={station.help?.raised_at ?? null} nowMs={clock.now} />
        : null}
    </>
  );
  const sideMenu = (items: MoreItem[]) => (
    <MoreMenu items={themeContext ? items : items.filter((item) => item !== 'theme')} theme={theme} onSelect={onMenu} myCallsTo={MY_CALLS_PATH} />
  );
  const cueFlashNode = cons.cueFlash ? <CueFlashBand key={`${cons.cueFlash.cue}:${cons.cueFlash.attemptId}`} flash={cons.cueFlash} /> : null;
  // The way back when the socket is gone or moved: the band says what, this says how.
  const connectionBanner = connection === 'disconnected' ? (
    <StationBanner
      tone="problem"
      icon={<WifiOff size={22} />}
      testId="side-try-again"
      action={<button type="button" className={stationStyles.btn} onClick={station.reconnect} data-testid="try-again">{STATION_COPY.tryAgainNow}</button>}
    >
      {STATION_COPY.internetGaveUpSubtitle}
    </StationBanner>
  ) : connection === 'superseded' ? (
    <StationBanner
      tone="quiet"
      icon={<Info size={22} />}
      testId="side-use-this-computer"
      action={<button type="button" className={stationStyles.btn} onClick={station.reconnect} data-testid="use-this-computer">{STATION_COPY.useThisComputer}</button>}
    >
      {STATION_COPY.otherDeviceSubtitle}
    </StationBanner>
  ) : null;
  const sideBanners = <>{micBannerNode}{connectionBanner}{supervisorBanner}<StationListenFirstNotice /></>;

  let sideFrame: ReactNode = null;
  if (inbound.call) {
    const call = inbound.call;
    const phase: SideCallPhase = inbound.phase === 'offered' ? 'coming' : inbound.phase === 'connected' ? 'on_call' : 'happened';
    const band = sideViewBand({ kind: 'inbound', connection, phase, who: inboundCallerLabel(call) });
    const live = connection === 'open';
    sideFrame = (
      <StationFrame
        view={band}
        agentName={agentName}
        workName={workName}
        brandMark={brand.shortName}
        needHelp={sideNeedHelp(phase === 'on_call' || phase === 'happened')}
        menu={sideMenu(['sound', 'theme'])}
        bandSide={
          <span className={stationStyles.bandSide}>
            {cueFlashNode}
            {live && call.bridged_at && phase === 'on_call' ? <span className={stationStyles.bandClock}><TalkTimer from={call.bridged_at} clock={clock} /></span> : null}
            {live && call.outcome_due_at && phase === 'happened' ? <span className={stationStyles.pill}><LapseCountdown due={call.outcome_due_at} clock={clock} /></span> : null}
          </span>
        }
        banners={<>{inbound.notice ? <StationBanner tone="quiet" icon={<Info size={22} />} testId="inbound-notice">{inbound.notice}</StationBanner> : null}{sideBanners}</>}
        connectFlash={cons.connectFlashAttemptId === call.id}
        bodyClassName={stationStyles.bodySide}
        testId="station-inbound"
      >
        <InboundCallView
          ib={inbound}
          call={call}
          connection={connection}
          clock={clock}
          cueFlash={cons.cueFlash}
          onReconnect={station.reconnect}
          shortcutsEnabled={!soundOpen}
          rail={false}
        />
      </StationFrame>
    );
  } else if (softphone.active && !finishOpen) {
    const call = softphone.sp.call;
    const spPhase = softphonePhase(call);
    const phase: SideCallPhase = spPhase === 'dialing' || spPhase === 'ringing' ? 'coming' : spPhase === 'on_call' ? 'on_call' : spPhase === 'outcome' ? 'happened' : 'idle';
    const named = contactName(call, softphone.sp.campaign?.context_display);
    const number = call ? formatDialNumber(call.destination_e164) : null;
    const band = sideViewBand({ kind: 'softphone', connection, phase, who: phase === 'on_call' ? (named ?? number) : number });
    const timerFrom = phase === 'on_call' ? call?.bridged_at ?? null : phase === 'coming' ? call?.dialed_at ?? null : null;
    const returnReason = softphone.returnFailure ?? softphone.returnBlockedReason;
    sideFrame = (
      <StationFrame
        view={band}
        agentName={agentName}
        workName={workName}
        brandMark={brand.shortName}
        needHelp={sideNeedHelp(phase === 'on_call' || phase === 'happened')}
        // Finish work while nothing is dialled; during a call only Sound and the colour, as on 04.
        menu={sideMenu(phase === 'idle' ? ['sound', 'theme', 'finish'] : ['sound', 'theme'])}
        bandSide={
          <span className={stationStyles.bandSide}>
            {cueFlashNode}
            <SoftphoneDisclosures sp={softphone.sp} showMuted={false} />
            {timerFrom && connection === 'open' ? <SinceClock anchor={timerFrom} clock={clock} className={stationStyles.bandClock} testId="softphone-timer" /> : null}
          </span>
        }
        banners={<>{cons.softphoneRejection ? <StationBanner tone="problem" icon={<TriangleAlert size={22} />} role="status" testId="switch-to-softphone-refused">{cons.softphoneRejection}</StationBanner> : null}{sideBanners}</>}
        bodyClassName={stationStyles.bodySide}
        testId="station-softphone"
        footLeft={returnReason ? (
          <span className={stationStyles.footHint} id="return-to-campaign-reason" role={softphone.returnFailure ? 'alert' : undefined} data-testid="return-to-campaign-reason">
            {returnReason}
          </span>
        ) : null}
        // AS1: hidden while a call is live or owes its outcome; the reason says why.
        footRight={softphone.returnBlockedReason === null ? (
          <button
            type="button"
            className={`${stationStyles.btn} ${stationStyles.btnBig} ${stationStyles.btnGo}`}
            onClick={() => !softphone.returning && softphone.returnToCampaign()}
            aria-disabled={softphone.returning || undefined}
            aria-describedby={returnReason ? 'return-to-campaign-reason' : undefined}
            data-testid="return-to-campaign"
          >
            {softphone.returning ? STATION_COPY.backingToCalls : STATION_COPY.backToCalls}
          </button>
        ) : null}
      >
        <SoftphoneView
          sp={softphone.sp}
          connection={connection}
          clock={clock}
          fromCampaign
          onReconnect={station.reconnect}
          shortcutsEnabled={!soundOpen}
          rail={false}
        />
      </StationFrame>
    );
  }

  return (
    <>
      {sideFrame ?? <StationFrame
        view={shownView}
        agentName={agentName}
        workName={workName}
        brandMark={brand.shortName}
        needHelp={needHelp}
        menu={menu}
        bandSide={bandSideWithFlash}
        bandSubtitle={bandSubtitle}
        banners={<>{micBannerNode}{stateBanner}{supervisorBanner}<StationListenFirstNotice /></>}
        bodyClassName={bodyClass}
        bodyRef={bodyRef}
        connectFlash={cons.connectFlashAttemptId !== null}
        footHint={footHint}
        footLeft={footLeft}
        footRight={footRightLead || mainButton ? <>{footRightLead}{mainButton}</> : null}
      >
        {/* The call's one assertive region: connect, disconnect and the result of the agent's own press. */}
        <div className={stationStyles.srOnly} role="alert" aria-live="assertive">{cons.announcement}</div>
        {body}
      </StationFrame>}

      <WhichBreakDialog
        open={breakDialog !== null}
        reasons={cons.breakReasons}
        busy={cons.breakBusy}
        // The station's own words, never the server's sentence (AS15).
        rejection={cons.breakRejection ? STATION_COPY.breakRefused : null}
        onPick={pickBreak}
        onClose={() => {
          setBreakDialog(null);
          // Back to Take break, never `<body>` (the dialog's own restore runs first and may land there).
          window.setTimeout(() => document.querySelector<HTMLElement>('[data-testid="take-break"]')?.focus(), 0);
        }}
      />
      <StopCallingDialog
        open={stopAsk !== null}
        who={card ? [card.name, card.phone].filter(Boolean).join(' · ') : null}
        busy={dnc.inFlight}
        failure={stopAsk?.code === null ? dnc.failure : null}
        onYes={confirmStop}
        onNo={() => setStopAsk(null)}
      />
      <StationDialog open={soundOpen} onClose={() => setSoundOpen(false)} title={STATION_COPY.soundTitle} small testId="station-sound">
        <CueSettingsFields prefs={cons.cuePrefs} onChange={cons.setCuePrefs} />
        <div className={stationStyles.dialogFoot}>
          <button type="button" className={`${stationStyles.btn} ${stationStyles.btnBig} ${stationStyles.btnGo}`} onClick={() => setSoundOpen(false)}>
            {STATION_COPY.messageOk}
          </button>
        </div>
      </StationDialog>

      {myContactsShown && bootstrap ? (
        <MyContactsPanel
          campaignId={bootstrap.campaign_id}
          campaignName={bootstrap.campaign_name}
          assignmentMode={bootstrap.assignment_mode ?? null}
          sessionId={bootstrap.session_id}
          agentState={agentState}
          dialing={dialing}
          queue={queue}
          onClose={() => setMyContactsOpen(false)}
          onCalled={() => setMyContactsOpen(false)}
        />
      ) : null}
    </>
  );
}

/** 02b's "The last call did not connect": shown for {@link LAST_CALL_BANNER_MS}, or until the next call. */
function TimedBanner({ at, line }: { at: number | null; line: string }) {
  useRepaintTick(at !== null);
  if (at === null || Date.now() - at > LAST_CALL_BANNER_MS) return null;
  return <StationBanner tone="quiet" icon={<Info size={22} />} role="status" testId="last-call-banner">{line}</StationBanner>;
}

/**
 * Renders its caller once more at `at` (a local epoch ms), and never otherwise: what turns 07 into
 * 08 without a clock on the station's root.
 */
function useRenderAt(at: number | null): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (at === null) return undefined;
    const wait = at - Date.now();
    if (wait <= 0) return undefined;
    const timer = window.setTimeout(() => setTick((n) => n + 1), wait);
    return () => window.clearTimeout(timer);
  }, [at]);
}

/** 08's subtitle, "You are 2:05 late. Start calls now.": a leaf, because it counts. */
function LateBy({ overAt }: { overAt: number }) {
  useRepaintTick();
  return <>{STATION_COPY.breakOverSubtitle(runningClock(Date.now() - overAt))}</>;
}

/**
 * Save & next call, the main action on What happened?, as its own leaf: a picked call-later time
 * can slide into the past with nobody touching anything, and Save has to fade when it does. It
 * repaints for that itself, only while a time-bound outcome is picked; the root does not.
 *
 * AS1's one exception: it stays in place, faded, until it can save (spec §6.1); pressing it then
 * shakes the tiles and says what is missing.
 */
function SaveNextButton({
  cons,
  now,
  onSave,
  blockLine,
  shake,
  keyHint,
}: {
  cons: AgencyConsoleState;
  now: () => number;
  onSave: () => void;
  blockLine: string | null;
  shake: number;
  keyHint: ReactNode;
}) {
  useRepaintTick(cons.blockChangesWithTime);
  const saved = cons.dispositionSubmitted || cons.waitingForDialer !== null;
  const block = cons.blockAt(now());
  return (
    <button
      type="button"
      className={`${stationStyles.btn} ${stationStyles.btnBig} ${stationStyles.btnGo}`}
      onClick={onSave}
      aria-disabled={block !== null || !cons.padEnabled || cons.submitting || saved || undefined}
      aria-describedby={blockLine ? 'save-block' : undefined}
      aria-keyshortcuts="Enter Control+Enter"
      data-shake={shake > 0 && blockLine ? 'true' : undefined}
      key={`save-${shake}`}
      data-block={block ?? undefined}
      data-testid="save-next"
    >
      <Check size={24} aria-hidden="true" />
      {cons.submitting ? STATION_COPY.saving : saved ? STATION_COPY.saved : STATION_COPY.saveAndNext}
      {keyHint}
    </button>
  );
}
