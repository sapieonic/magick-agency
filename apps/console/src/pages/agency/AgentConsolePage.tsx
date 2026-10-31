import { useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTenant } from '../../contexts/TenantContext';
import { useAuth } from '../../contexts/AuthContext';
import { usePermission } from '../../hooks/usePermission';
import { useAgencyConsole } from './useAgencyConsole';
import { useStationJoin, useLiveSessionTouch } from './station/useStationJoin';
import { useStationExit } from './station/useStationExit';
import { useStationShortcuts } from './station/useStationShortcuts';
import { useHangup } from './station/useHangup';
import { useDncAction } from './station/useDncAction';
import { useStationSoftphone } from './station/useStationSoftphone';
import { SoftphoneView } from '../../components/softphone/SoftphoneView';
import { SoftphoneDisclosures } from '../../components/softphone/SoftphoneHeader';
import { StateRail } from '../../components/agency/StateRail';
import {
  DispositionPad,
  type DispositionPadHandle,
} from '../../components/agency/DispositionPad';
import type { DncControlHandle } from '../../components/agency/DncControl';
import { NotesField } from '../../components/agency/NotesField';
import type { BreakMenuHandle } from '../../components/agency/BreakMenu';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { JoinConflictScreen } from '../../components/agency/JoinConflictScreen';
import { SoftphoneJoinScreen } from '../../components/agency/SoftphoneJoinScreen';
import { StationFatal } from '../../components/agency/StationFatal';
import { StationHeader } from '../../components/agency/StationHeader';
import { ContactPanel } from '../../components/agency/ContactPanel';
import { ContactDetail } from '../../components/agency/ContactDetail';
import { IdleGuide } from '../../components/agency/IdleGuide';
import { StationActionBar } from '../../components/agency/StationActionBar';
import {
  LEAVE_CONFIRM_ACTION,
  LEAVE_CONFIRM_MESSAGE,
  LEAVE_CONFIRM_TITLE,
} from '../../utils/agencyStationExit';
import { agencyAudioNotice } from '../../utils/agencyAudioCopy';
import { resolveContextFields } from '../../utils/agencyContext';
import styles from '../../components/agency/AgentStation.module.css';

/**
 * The Agent Console — Phase 2.
 *
 * Phase 1 shipped this page with a local `describeRail`, a bare "Go available"
 * button and a hang-up. Everything Phase 2 needs already existed as tested
 * components; **nothing composed them**, which is the state this file ends.
 *
 * Three structural rules drive the markup and are each easy to undo by accident:
 *
 *  1. **Geometry is frozen.** Column widths and order never change between
 *     states. A control that moves 12px between "ringing" and "connected" is a
 *     misclick, and a misclick on this screen hangs up on a human being. Every
 *     region renders in every state; only content and colour change.
 *  2. **Only authoritative frames move the UI.** Everything visual is derived
 *     from `useAgencyConsole`, which routes bridge-originated `status`/`ended` to
 *     a diagnostic sink. The connect treatment keys off `bridgedAt` — set by
 *     `bridged` and nothing else.
 *  3. **Tab order is fixed and does not vary by state**: rail →
 *     column 1 → column 2 → column 3 (pad, then notes) → action bar (Break →
 *     Save → Hang up). Inactive controls are `disabled` so they are *skipped*
 *     rather than reordered, which is the mechanism that keeps the order stable —
 *     and the reason every region renders in every state.
 *
 * The `⚙` station menu obeys all three: it is in the **header**
 * beside cue settings — never the action bar, whose Break → Save → Hang up
 * sequence rule 3 pins — and its items are refused in place with a stated reason
 * rather than disappearing, so nothing moves. (They are refused on *different*
 * states: Exit is additionally refused while `available`, because it leaves the
 * agent in the dialable pool with no console attached. The whole argument lives
 * at the predicates in `agencyStationExit.ts`.) There
 * is deliberately no single-key shortcut for either:'s keys are for the
 * call in front of the agent, and a stray keypress that ends a session would be
 * the worst possible thing to bind a letter to.
 *
 * `C` (callback), `D` (mark DNC) and `/` (contact-panel field filter)
 * ARE wired, now — `C` through the pad's handle so the
 * selection and the focus move together, `D` through the DNC control's, so the
 * key opens the same confirmation the button does, and `/` by focusing the
 * filter input directly, since it owns no confirmation and no selection to
 * hand off.
 *
 * ── How the page is put together ─────────────────────────────────────────────
 * The page is the composition and the layout. The flows are hooks under
 * `./station/` (join and the conflict switch, leave/exit, the keyboard map, the
 * hang-up, DNC), the console's state is `useAgencyConsole`, and the regions are
 * components under `components/agency/` (header, contact panel and detail, action
 * bar, the two screens shown instead of a console). The sections below stay here
 * because they ARE the geometry: every region renders in every state.
 */
export default function AgentConsolePage() {
  const [params] = useSearchParams();
  const campaignId = params.get('campaign') ?? '';
  const { tenantId, accountId, role } = useTenant();
  const { user } = useAuth();

  const join = useStationJoin({ campaignId, tenantId, accountId, role });
  const { bootstrap } = join;

  const consoleRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const breakMenuRef = useRef<BreakMenuHandle | null>(null);
  const padRef = useRef<DispositionPadHandle | null>(null);
  const dncRef = useRef<DncControlHandle | null>(null);
  const fieldFilterRef = useRef<HTMLInputElement>(null);

  // Floor is `agent` (level 5), so every agent holds it — but a supervisor
  // watching a station from a lower-privileged membership does not, and a bare
  // greyed button on this screen reads as an outage.
  const mayMarkDnc = usePermission('agency.dnc.write');
  // The tenant-wide escalation is a DIFFERENT, higher floor — `agency.dnc.manage`
  // (`account_admin`), the same permission the server requires to remove an entry.
  // Marking campaign-scoped stays at `agent`; only the wider, harder-to-undo
  // escalation is gated behind this.
  const mayMarkDncTenantWide = usePermission('agency.dnc.manage');

  const cons = useAgencyConsole(bootstrap, tenantId ?? undefined, accountId ?? undefined);
  const { station, clock, audio } = cons;
  const { connection, agentState, live, retainedAttempt, release, dialing, missedPings } = station;
  const micNotice = agencyAudioNotice(audio.error);

  useLiveSessionTouch({ tenantId, bootstrap, agentState, connection });

  /**
   * Focus moves exactly ONCE per call — to the console root, on reservation — and
   * never at connect. Stealing focus at connect would interrupt a screen-reader
   * user mid-sentence at the worst possible moment.
   *
   * **Keyed on the ringing attempt's id, never on `live` itself.** A `ready` on
   * reconnect replaces `live` with a fresh object for the same attempt, and an
   * effect keyed on the object read that as a new call and pulled focus back to
   * the console root a second time, mid-ring, from wherever the agent had put it.
   */
  const ringingAttemptId = live && live.bridgedAt === null ? live.attempt.attempt_id : null;
  useEffect(() => {
    if (ringingAttemptId !== null) consoleRef.current?.focus();
  }, [ringingAttemptId]);

  /** The attempt whose details stay on screen — live, or retained through wrap-up. */
  const panelAttempt = live?.attempt ?? retainedAttempt;

  const resolved = useMemo(
    () => (panelAttempt ? resolveContextFields(panelAttempt.context, bootstrap?.context_display) : null),
    [panelAttempt, bootstrap?.context_display],
  );

  const exit = useStationExit({ campaignId, bootstrap, tenantId, accountId, role, agentState });
  const { hangup, hangupFailure } = useHangup({ live, bootstrap, tenantId, accountId, clock });
  const dnc = useDncAction({
    liveAttemptId: live?.attempt.attempt_id ?? null,
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

  useStationShortcuts(
    { agentState, cons, bootstrap, suspended: softphone.active },
    { breakMenuRef, notesRef, fieldFilterRef, padRef, dncRef },
  );

  /*
    The join conflict, ahead of `joinError` — both are "the station did not
    open", and this one is the case with a remedy in it. One live session per
    agent per TENANT (deliberate: the earlier per-campaign limit was
    superseded), so being refused here means they are still joined
    somewhere else, and the link is the way to the Leave-station control that
    frees them.
  */
  if (join.joinConflict) {
    return (
      <JoinConflictScreen
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

  /*
    The agent's live session is a SOFT-PHONE session (`session_on_softphone`):
    one session per agent per tenant, and that one has no campaign to name, so the
    remedy is closing the soft phone — one click here, unless a call there is not
    finished.
  */
  if (join.onSoftphoneElsewhere) {
    return (
      <SoftphoneJoinScreen
        closing={join.closingSoftphone}
        failure={join.closeSoftphoneFailure}
        callPending={join.softphoneCallPending}
        onCloseAndJoin={join.closeSoftphoneAndJoin}
      />
    );
  }

  if (join.joinError) {
    return (
      <StationFatal
        message={join.joinError}
        toCampaign={exit.canExitToCampaign}
        campaignId={exit.stationCampaignId}
      />
    );
  }

  const micBanner = (
    <>
      {micNotice ? (
        <p className={styles.micFailure} role="alert" data-testid="mic-failure">
          <strong>{micNotice.headline}</strong> {micNotice.remedy}
          {/*
            The button IS the fix, not a link to it. A browser's autoplay policy
            is lifted by any user gesture, so for `audio_blocked` the click that
            dismisses the banner is the same click that resumes both contexts —
            and on a mid-call reload it is the only control the agent has any
            reason to press. `agencyAudioNotice` supplies `action` for exactly
            that one kind; every other failure needs something done outside the
            page, and a button there would be a promise we cannot keep.
          */}
          {micNotice.action ? (
            <button
              type="button"
              className={styles.micFailureAction}
              onClick={audio.resume}
              data-testid="mic-resume"
            >
              {micNotice.action}
            </button>
          ) : null}
        </p>
      ) : null}
    </>
  );

  /*
    ── On the soft phone (SP7) ─────────────────────────────────────────────────
    The session is on `break/soft_phone`: the soft phone renders in place, on this
    station's socket and microphone, under this station's header. Its rail
    replaces the station's — whose break arm offers End break, which a soft-phone
    break must never show — and Return to campaign sits in the header, disabled
    with its reason while a call is live or owes its outcome.
  */
  if (softphone.active) {
    const busy = softphone.sp.call !== null;
    return (
      <div className={styles.shell} data-testid="station-softphone">
        <StationHeader
          user={user}
          campaignName={bootstrap?.campaign_name}
          subline={bootstrap ? `${bootstrap.campaign_name} · Soft phone` : undefined}
          recordCalls={false}
          muted={audio.muted}
          cuePrefs={cons.cuePrefs}
          onCuePrefsChange={cons.setCuePrefs}
          // Leaving while a soft-phone call is unsettled would cut the customer off:
          // the menu's own "finish this call first" rule, read off the call.
          agentState={busy ? 'on_call' : agentState}
          canExit={exit.canExitToCampaign}
          leaving={exit.leaving}
          onLeave={exit.openLeave}
          onExit={exit.exitStation}
          connection={connection}
          missedPings={missedPings}
          extra={
            <>
              <SoftphoneDisclosures sp={softphone.sp} showMuted={false} />
              <button
                type="button"
                className="btn-secondary"
                onClick={softphone.returnToCampaign}
                disabled={softphone.returnBlockedReason !== null || softphone.returning}
                aria-describedby={softphone.returnBlockedReason || softphone.returnFailure ? 'return-to-campaign-reason' : undefined}
                data-testid="return-to-campaign"
              >
                {softphone.returning ? 'Returning…' : 'Return to campaign'}
              </button>
              {softphone.returnFailure || softphone.returnBlockedReason ? (
                <span
                  id="return-to-campaign-reason"
                  className={styles.blockReason}
                  role={softphone.returnFailure ? 'alert' : undefined}
                  data-testid="return-to-campaign-reason"
                >
                  {softphone.returnFailure ?? softphone.returnBlockedReason}
                </span>
              ) : null}
            </>
          }
        />
        {micBanner}
        <SoftphoneView
          sp={softphone.sp}
          connection={connection}
          clock={clock}
          fromCampaign
          onReconnect={station.reconnect}
          shortcutsEnabled={!exit.leaveConfirm}
        />
        <ConfirmDialog
          open={exit.leaveConfirm}
          title={LEAVE_CONFIRM_TITLE}
          message={
            exit.leaveFailure
              ? `Your station is still open — ${exit.leaveFailure}`
              : LEAVE_CONFIRM_MESSAGE
          }
          confirmLabel={exit.leaving ? 'Leaving…' : LEAVE_CONFIRM_ACTION}
          disabled={exit.leaving}
          onConfirm={exit.confirmLeave}
          onCancel={exit.cancelLeave}
        />
      </div>
    );
  }

  return (
    /*
      `data-connect-flash` is set ONLY when the audible cue could not carry the
      connect — a muted console, an `AudioContext` the browser refuses to run, or
      the agent's own `always`. For a hearing agent with working sound it is never
      set, which is the point: an unconditional flash 200 times a day is the visual
      equivalent of the haptics defect.

      **Connect, and only connect, lights the whole shell.** The three cues each get
      a rail flash (`StateRail`, keyed off `VISUAL_CUE_SPECS`); *scope* is the fourth
      axis separating them, and it is spent here, on the one event that means a
      stranger has started speaking to the agent. A ring and a hang-up do not earn
      the whole screen.
    */
    <div
      className={styles.shell}
      data-connect-flash={cons.connectFlashAttemptId !== null ? 'true' : undefined}
    >
      <StationHeader
        user={user}
        campaignName={bootstrap?.campaign_name}
        recordCalls={Boolean(bootstrap?.record_calls)}
        muted={audio.muted}
        cuePrefs={cons.cuePrefs}
        onCuePrefsChange={cons.setCuePrefs}
        agentState={agentState}
        canExit={exit.canExitToCampaign}
        leaving={exit.leaving}
        onLeave={exit.openLeave}
        onExit={exit.exitStation}
        connection={connection}
        missedPings={missedPings}
      />

      {/*
        The microphone banner. `role="alert"` and above the rail, because this is
        the one console failure that is otherwise **completely invisible**: the
        panel populates, `bridged` arrives, the talk timer runs and the agent
        talks into nothing. It is not scoped to a call — a blocked microphone
        found during pre-flight has to be fixable before the first one arrives.
      */}
      {micBanner}

      {/* The rail is the ONLY polite live region on this screen. */}
      <StateRail
        agentState={agentState}
        agentStateSince={station.agentStateSince}
        breakReasonLabel={cons.breakReasonLabel}
        connection={connection}
        live={live}
        release={release}
        wrapup={station.wrapup}
        dispositionSubmitted={cons.dispositionSubmitted}
        dialing={dialing}
        clock={clock}
        presenceBusy={cons.presenceBusy}
        onGoAvailable={cons.goAvailable}
        onEndBreak={cons.endBreak}
        waitingForDialer={cons.waitingForDialer}
        cueFlash={cons.cueFlash}
        // The API's reconnect window.
        deferredHangupMs={bootstrap?.intervals.deferred_hangup_ms ?? null}
        /*
          The way back from `superseded` / `disconnected`. Handed straight from the
          station hook: reclaiming a station and reconnecting to one are the same
          act, because the API gives the station to whoever attaches last.
        */
        onReconnect={station.reconnect}
      />

      {/*
        A refusal is a response, not an alarm: the API declines `/available` while a
        disposition is outstanding, and that refusal is what makes the disposition
        mandatory. Rendered under the rail with the remedy the API stated, never in
        the rail — the rail is the call's state.
      */}
      {cons.presenceRefusal ? (
        <p className={styles.presenceRefusal}>{cons.presenceRefusal}</p>
      ) : null}

      {/* Assertive region, used ONLY for connect, disconnect and the direct
          result of a button the agent just pressed ( — exactly two live
          regions, and this is the second). */}
      <div className={styles.srOnly} role="alert" aria-live="assertive">
        {cons.announcement}
      </div>

      {/*
        ── The retry banner ──────────────────────────────────────────────────
        "Retry 1 of 'Q3 Winback' — these contacts were previously voicemail,
        callback, no answer." One line, above the contact panel, so the agent
        knows before the first call lands that the person they are about to
        speak to has been called before and roughly why they are being called
        again.

        **It does not violate rule 1 (geometry is frozen).** That rule is about
        the console not moving BETWEEN CALL STATES — a control that shifts 12px
        between "ringing" and "connected" is a misclick, and a misclick here
        hangs up on a human being. This is read from the session bootstrap,
        which is fixed at join and never changes for the life of the station, so
        it is present for the whole shift or absent for the whole shift. It
        cannot appear or disappear under a cursor. Anything derived from a FRAME
        must not be placed here.

        **`selection_summary` is rendered as received.** The API builds it from the
        frozen selector on the child campaign's row, so the sentence the agent
        reads and the query that put this contact in front of them cannot
        disagree. Re-deriving it from anything this client holds would be a
        second answer to the same question — and this client does not even have
        the input, because the selector is deliberately not on the bootstrap.

        Not a live region: it is standing context, not an event, and the console
        has exactly two live regions both spent on the call itself.
      */}
      {bootstrap?.retry_context ? (
        <p className={styles.retryBanner} data-testid="retry-context">
          <strong className={styles.retryBannerLead}>
            Retry {bootstrap.retry_context.generation} of “
            {bootstrap.retry_context.parent_campaign_name}”
          </strong>
          <span className={styles.retryBannerBody}>
            — these contacts were previously {bootstrap.retry_context.selection_summary}
          </span>
        </p>
      ) : null}

      <div className={styles.body} ref={consoleRef} tabIndex={-1}>
        <section className={styles.colContact} aria-label="Contact">
          <ContactPanel
            attempt={panelAttempt}
            resolved={resolved}
            contextDisplay={bootstrap?.context_display}
            dialing={dialing}
            release={release}
            missedRelease={station.missedRelease}
            lostDisposition={cons.lostDispositionNotice}
          />
        </section>

        <section className={styles.colDetail} aria-label="Contact detail">
          {panelAttempt && resolved ? (
            /*
              Keyed on the panel's attempt: a genuinely different contact mounts
              a fresh detail column, which is what clears the field filter — on
              the next `reserved`, and NOT at hangup, since the attempt retained
              through wrap-up keeps the same id. See `ContactDetail`.
            */
            <ContactDetail
              key={panelAttempt.attempt_id}
              attempt={panelAttempt}
              resolved={resolved}
              currentCatalog={bootstrap?.disposition_catalog}
              filterInputRef={fieldFilterRef}
            />
          ) : (
            <IdleGuide dialing={dialing} />
          )}
        </section>

        {/* Column 3 — the outcome and the note. Rendered in every state so the
            geometry never shifts; disabled with a stated reason when there is
            nothing to act on. */}
        <section className={styles.colOutcome} aria-label="Outcome">
          <DispositionPad
            catalog={cons.catalog}
            form={cons.form}
            onChange={(next) => {
              // Every change reaching the pad's own `onChange` — a card click,
              // or the `C` shortcut's `selectCallback()`, which reports back
              // through this same prop — is a non-digit selection. Only the
              // digit branch above calls `setForm` directly and marks
              // `number_key` itself; without this, a click AFTER any number
              // key kept reporting `selection_method: 'number_key'` forever,
              // because nothing ever set it back.
              cons.noteCodeSelectionMethod('click');
              cons.setForm(next);
            }}
            enabled={cons.padEnabled}
            disabledReason={cons.padDisabledReason}
            rejection={cons.padRejection}
            keysRemapped={cons.keysRemapped}
            now={clock.now}
            onNeedsNote={() => notesRef.current?.focus()}
            handleRef={padRef}
          />
          <NotesField
            ref={notesRef}
            value={cons.notes}
            onAgentEdit={cons.onNotesEdit}
            status={cons.notesStatusLine}
            foreignWrite={cons.notesForeignWrite}
            enabled={cons.notesEnabled}
            disabledReason={cons.notesDisabledReason}
            onSubmit={cons.submit}
          />
        </section>
      </div>

      <StationActionBar
        cons={cons}
        breakMenuRef={breakMenuRef}
        dncRef={dncRef}
        mayMarkDnc={mayMarkDnc}
        mayMarkDncTenantWide={mayMarkDncTenantWide}
        dnc={dnc}
        onHangup={hangup}
        hangupFailure={hangupFailure}
        softphoneAvailable={softphone.available}
      />

      {/*
        The shared `ConfirmDialog`, not a console-local one: it already owns the
        focus trap, the Escape handling and the focus restore this needs, and its
        footer order is a documented safety property.

        A failed leave replaces the message rather than adding a second line —
        the original sentence describes what confirming will do, and once it has
        failed the only news is that it did not.
      */}
      <ConfirmDialog
        open={exit.leaveConfirm}
        title={LEAVE_CONFIRM_TITLE}
        message={
          exit.leaveFailure
            ? `Your station is still open — ${exit.leaveFailure}`
            : LEAVE_CONFIRM_MESSAGE
        }
        confirmLabel={exit.leaving ? 'Leaving…' : LEAVE_CONFIRM_ACTION}
        disabled={exit.leaving}
        onConfirm={exit.confirmLeave}
        onCancel={exit.cancelLeave}
      />
    </div>
  );
}
