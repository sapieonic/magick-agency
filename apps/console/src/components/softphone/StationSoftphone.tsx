import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Ban, Delete, FileText, Info, ListChecks, MicOff, Phone, PhoneOutgoing, RotateCcw, TriangleAlert } from 'lucide-react';
import type { DispositionPadHandle } from '../../utils/agencyDispositionForm';
import { StationBanner, StationFrame } from '../agency/station/StationFrame';
import { CustomerCardView, LastCallsCard, NoteCard } from '../agency/station/StationCustomer';
import { WhatHappened } from '../agency/station/WhatHappened';
import { StopCallingDialog } from '../agency/station/StationScreens';
import { SinceClock } from '../agency/station/StationClocks';
import {
  OutcomeDueRing,
  RecordedPill,
  SideEndCall,
  SideMute,
  SideSave,
  sideEndCallCopy,
  type SideFrameProps,
} from '../agency/station/SideCall';
import { CallFieldsForm } from './CallFieldsForm';
import { OverrideDialog } from './OverrideDialog';
import { recordingDisclosed } from './SoftphoneHeader';
import { useSoftphoneShortcuts } from './useSoftphoneShortcuts';
import { useFeatureFlagEnabled } from '../../hooks/useFeatureFlagEnabled';
import { INBOUND_FLAG } from '../../utils/inbound/inboundFlag';
import { DIAL_KEYS, DIAL_KEY_LETTERS, formatDialNumber } from '../../utils/softphone/phoneInput';
import { catalogForCall } from '../../utils/softphone/callLabels';
import { callEndSummary } from '../../utils/softphone/callState';
import { dispositionLabel } from '../../utils/agencySpineCopy';
import { findDisposition } from '../../utils/agencyDispositionForm';
import { ATTEMPT_OUTCOME_WORDS, STATION_COPY } from '../../utils/agency/stationCopy';
import { DIAL_BLOCK_WORDS, SIDE_COPY, sideSaveBlockLine } from '../../utils/agency/sideViewCopy';
import { softphoneCustomerCard, softphoneLastCalls } from '../../utils/agency/sideViewCustomer';
import { clockTime, dayMonth, sameDay } from '../../utils/agency/stationFormat';
import { sideViewBand, type SideCallPhase } from '../../utils/agency/stationView';
import type { StationSoftphone as StationSoftphoneState } from '../../pages/agency/station/useStationSoftphone';
import type { SoftphoneState } from '../../hooks/useSoftphone';
import type { ServerClock } from '../../hooks/useServerClock';
import type { StationConnection } from '../../hooks/agencyStation/types';
import type { AgencyManualCall } from '../../types/softphone';
import styles from '../agency/station/Station.module.css';
import side from '../agency/station/SideView.module.css';

/** End call on a soft-phone call: the station's words, its own hint id. */
export const STATION_SOFTPHONE_END_CALL_COPY = sideEndCallCopy('softphone-hangup');

/**
 * The soft phone inside the agent's station (SP7, `docs/softphone.md` §4.2, §7), in the station's
 * look (AS1, spec §3 03–05). The same `useSoftphone` state `/dialer/phone` renders with
 * `SoftphoneView`; only the screen differs:
 *
 *  - **Dial a number**: the number box and a big keypad, Call under it; where the call is saved
 *    and the number it goes from; the call details; My recent calls, each one back into the box.
 *    Back to my calls bottom right (the station's, as the frame left it).
 *  - **Calling** (dialling, ringing): the customer card (the number, and the customer's name and
 *    facts when the number is on the work's list), a warning while ringing on a line that cannot
 *    stop a ringing call (SP3); Mute ring bottom left, End call bottom right.
 *  - **On call**: the card and Last calls left, the note and the call details right; Mute, End call.
 *  - **What happened?**: the station's tiles and follow-ups (`WhatHappened`), the small card, the
 *    note and the call details; Save bottom right.
 *
 * The keys are the soft phone's own (`useSoftphoneShortcuts`, unchanged): digits type the number
 * while ready and pick an outcome once a call is placed, Enter calls or saves, `M`, `N`, `C`, `D`,
 * `E` `E`. Focus moves once per call, to the body, and back to the number box when it settles.
 */
export function StationSoftphone({
  softphone,
  connection,
  clock,
  frame,
  shortcutsEnabled = true,
}: {
  softphone: StationSoftphoneState;
  connection: StationConnection;
  clock: ServerClock;
  frame: SideFrameProps;
  shortcutsEnabled?: boolean;
}) {
  // Back to my calls, and why it is not offered while a call is live or owes what happened.
  const returnReason = softphone.returnFailure ?? softphone.returnBlockedReason;
  return (
    <SoftphoneScreen
      sp={softphone.sp}
      connection={connection}
      clock={clock}
      frame={frame}
      shortcutsEnabled={shortcutsEnabled}
      inboundNote={SIDE_COPY.inboundNotHere}
      testId="station-softphone"
      wayOut={{
        reason: returnReason ? (
          <span className={styles.footHint} id="return-to-campaign-reason" role={softphone.returnFailure ? 'alert' : undefined} data-testid="return-to-campaign-reason">
            {returnReason}
          </span>
        ) : null,
        button: softphone.returnBlockedReason === null ? (
          <button
            type="button"
            className={`${styles.btn} ${styles.btnBig} ${styles.btnGo}`}
            onClick={() => !softphone.returning && softphone.returnToCampaign()}
            aria-disabled={softphone.returning || undefined}
            aria-describedby={returnReason ? 'return-to-campaign-reason' : undefined}
            data-testid="return-to-campaign"
          >
            {softphone.returning ? STATION_COPY.backingToCalls : STATION_COPY.backToCalls}
          </button>
        ) : null,
      }}
    />
  );
}

/**
 * The soft phone's screen in the station's look, for either host: the campaign station
 * (`StationSoftphone`) and `/dialer/phone` (`SoftphonePage`). The host gives the frame's top bar
 * and banners, its way out (Back to my calls, Close soft phone: bottom right while nothing is
 * dialled, its reason bottom left while a call holds it) and the note on where customers who call
 * us go.
 */
export function SoftphoneScreen({
  sp,
  connection,
  clock,
  frame,
  wayOut,
  inboundNote,
  testId,
  shortcutsEnabled = true,
}: {
  sp: SoftphoneState;
  connection: StationConnection;
  clock: ServerClock;
  frame: SideFrameProps;
  wayOut: { button: ReactNode; reason: ReactNode };
  inboundNote: string;
  testId: string;
  shortcutsEnabled?: boolean;
}) {
  const call = sp.call;
  const bodyRef = useRef<HTMLElement>(null);
  const numberInputRef = useRef<HTMLInputElement>(null);
  const callButtonRef = useRef<HTMLButtonElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const tilesRef = useRef<DispositionPadHandle | null>(null);
  const [stopAsk, setStopAsk] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [blockLine, setBlockLine] = useState<string | null>(null);

  // C on the call picks the call-later outcome, so What happened? opens with it chosen.
  const keyPadRef = useRef<DispositionPadHandle | null>(null);
  keyPadRef.current = {
    selectCallback: () => {
      if (tilesRef.current) return tilesRef.current.selectCallback();
      if (!sp.padEnabled) return false;
      const entry = sp.catalog.find((option) => option.requires_datetime);
      if (!entry) return false;
      sp.setForm({ ...sp.form, selectedCode: entry.code }, 'click');
      return true;
    },
  };
  useSoftphoneShortcuts(sp, clock, { numberInputRef, notesRef, padRef: keyPadRef, enabled: shortcutsEnabled && stopAsk === null });

  // Focus once per call, to the body; back to the number box when the call settles.
  const callId = call?.id ?? null;
  const previousCallId = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousCallId.current;
    previousCallId.current = callId;
    if (callId !== null && previous !== callId) bodyRef.current?.focus();
    if (callId === null && previous !== null) (numberInputRef.current ?? bodyRef.current)?.focus();
  }, [callId]);
  useEffect(() => {
    if (sp.focusCallToken > 0) callButtonRef.current?.focus();
  }, [sp.focusCallToken]);
  useEffect(() => {
    setBlockLine(null);
  }, [sp.form.selectedCode, sp.form.callbackAt, sp.form.promiseDate, callId]);

  // The facts follow the call's campaign's own `phone_display` (S3(b)), not the station's; the
  // dialled number stays as typed.
  const card = useMemo(() => (call ? softphoneCustomerCard(call, sp.campaign) : null), [call, sp.campaign]);
  const lastCalls = useMemo(() => (call ? softphoneLastCalls(call, sp.campaign) : []), [call, sp.campaign]);
  const phase: SideCallPhase =
    sp.phase === 'dialing' || sp.phase === 'ringing' ? 'coming' : sp.phase === 'on_call' ? 'on_call' : sp.phase === 'outcome' ? 'happened' : 'idle';
  const number = call ? formatDialNumber(call.destination_e164) : null;
  const band = sideViewBand({ kind: 'softphone', connection, phase, who: phase === 'on_call' ? (card?.name ?? number) : number });
  const live = connection === 'open';
  const selected = findDisposition(sp.catalog, sp.form.selectedCode);

  const trySave = () => {
    if (sp.saving || !call) return;
    const block = sp.saveBlockAt(clock.now());
    if (block !== null) {
      setShake((n) => n + 1);
      setBlockLine(sideSaveBlockLine(block));
      if (block === 'note_required') notesRef.current?.focus();
      return;
    }
    sp.saveOutcome();
  };

  // ── The band's right side ───────────────────────────────────────────────────
  const timerFrom = phase === 'on_call' ? call?.bridged_at ?? null : phase === 'coming' ? call?.dialed_at ?? null : null;
  const bandSide = (
    <span className={styles.bandSide}>
      {frame.cueFlash}
      {(phase === 'coming' || phase === 'on_call') && recordingDisclosed(sp) ? <RecordedPill testId="softphone-recording" /> : null}
      {timerFrom && live ? <SinceClock anchor={timerFrom} clock={clock} className={styles.bandClock} testId="softphone-timer" /> : null}
      {phase === 'happened' && live && call?.outcome_due_at ? (
        <OutcomeDueRing dueAt={call.outcome_due_at} startedAt={call.ended_at} clock={clock} testId="softphone-outcome-due" />
      ) : null}
    </span>
  );

  // ── The call's own banner (one), before the page's ──────────────────────────
  // How the last call ended, once the soft phone is ready again (a call with nothing to save).
  const lastEnded = sp.lastCall && sp.lastCall.state === 'ended' && !sp.lastCall.requires_disposition && call === null ? sp.lastCall : null;
  const callBanner: ReactNode = sp.hangupFailure ? (
    <StationBanner tone="problem" icon={<TriangleAlert size={22} />} role="alert" testId="softphone-hangup-failure">{SIDE_COPY.endCallFailed}</StationBanner>
  ) : sp.dncFailure ? (
    <StationBanner tone="problem" icon={<TriangleAlert size={22} />} role="alert" testId="softphone-dnc-failure">{SIDE_COPY.stopFailed}</StationBanner>
  ) : sp.dncOutcome ? (
    <StationBanner tone="ready" icon={<Ban size={22} />} role="status" testId="softphone-dnc-outcome">{SIDE_COPY.stoppedCalls}</StationBanner>
  ) : phase === 'on_call' && sp.muted ? (
    <StationBanner tone="break" icon={<MicOff size={22} />} testId="softphone-on-mute">{STATION_COPY.onMute}</StationBanner>
  ) : phase === 'idle' && lastEnded ? (
    <StationBanner tone="quiet" icon={<Info size={22} />} role="status" testId="softphone-last-call">
      {SIDE_COPY.lastCallLine(formatDialNumber(lastEnded.destination_e164), callEndSummary(lastEnded))}
    </StationBanner>
  ) : sp.finishOnly && call ? (
    <StationBanner tone="quiet" icon={<Info size={22} />} role="status" testId="softphone-finish-notice">{sp.finishNotice ?? SIDE_COPY.finishCall}</StationBanner>
  ) : null;

  // ── The footer: one main button bottom right (AS1) ──────────────────────────
  // The host's way out, bottom right while nothing is dialled; its reason while a call holds it.
  const returnLine = wayOut.reason;
  let footLeft: ReactNode = returnLine;
  let footRight: ReactNode = null;
  if (phase === 'idle') {
    footRight = wayOut.button;
  } else if (phase === 'coming' || phase === 'on_call') {
    footLeft = (
      <>
        {sp.muteEnabled ? (
          <SideMute
            muted={sp.muted}
            onToggle={sp.toggleMute}
            label={sp.muteTarget === 'ring' ? { off: SIDE_COPY.muteRing, on: SIDE_COPY.unmuteRing } : { off: STATION_COPY.mute, on: STATION_COPY.unmute }}
            testId="softphone-mute"
          />
        ) : null}
        {returnLine}
      </>
    );
    footRight = call ? <SideEndCall callId={call.id} onConfirm={sp.hangup} copy={STATION_SOFTPHONE_END_CALL_COPY} /> : null;
  } else {
    footLeft = (
      <>
        {blockLine ? <span id="softphone-save-block" className={styles.refusal} role="status" data-testid="softphone-save-reason">{blockLine}</span> : null}
        {returnLine}
      </>
    );
    footRight = (
      <SideSave
        blocked={() => sp.saveBlockAt(clock.now()) !== null}
        ticking={Boolean(selected?.requires_datetime)}
        saving={sp.saving}
        onSave={trySave}
        shake={shake}
        describedBy={blockLine ? 'softphone-save-block' : null}
        testId="softphone-save"
      />
    );
  }

  // ── The body ────────────────────────────────────────────────────────────────
  const noteCard = (
    <NoteCard
      ref={notesRef}
      value={sp.notes}
      onAgentEdit={sp.setNotes}
      status={sp.notesStatus}
      enabled={sp.notesEnabled}
      onSubmit={trySave}
      needed={Boolean(selected?.requires_note)}
    />
  );
  // Shown while the account's fields load (a reload mid-call), and once there are fields to fill.
  const detailsCard = sp.fields.length > 0 || sp.bootstrap === null ? (
    <section className={`${styles.card} ${side.details}`} data-testid="call-details">
      <h2 className={styles.cardTitle}><ListChecks size={20} aria-hidden="true" />{SIDE_COPY.callDetails}</h2>
      <CallFieldsForm
        fields={sp.fields}
        values={sp.fieldValues}
        errors={sp.fieldErrors}
        disabled={sp.placing || (sp.finishOnly && !call)}
        loading={sp.bootstrap === null}
        onChange={sp.setFieldValue}
      />
    </section>
  ) : null;

  let bodyClass = styles.body2;
  let body: ReactNode;
  if (sp.bootstrapError && !sp.bootstrap) {
    bodyClass = styles.bodyCenter;
    body = (
      <section className={`${styles.card} ${styles.cardNarrow}`} role="alert" data-testid="softphone-bootstrap-error">
        <p className={side.reason} data-tone="problem">{SIDE_COPY.didNotLoad}</p>
        <button type="button" className={styles.btn} onClick={sp.reloadBootstrap} style={{ marginTop: 16 }}>{SIDE_COPY.tryAgain}</button>
      </section>
    );
  } else if (phase === 'idle' || !call || !card) {
    body = (
      <>
        {sp.finishOnly ? (
          <section className={styles.card}>
            <p className={side.reason} role="status" data-testid="softphone-finish-notice">{sp.finishNotice ?? SIDE_COPY.finishIdle}</p>
          </section>
        ) : sp.noWorkToDial ? (
          // Every call must be saved to a work and this agent is in none that is running: nothing
          // to dial from, so the pad gives way to what to do about it (docs/call-log.md §5).
          <section className={styles.card} role="status" data-testid="softphone-no-work">
            <p className={side.reason}>{sp.noWorkCopy.title}</p>
            {sp.noWorkCopy.body ? <p className={side.hint}>{sp.noWorkCopy.body}</p> : null}
          </section>
        ) : (
          <DialCard sp={sp} connection={connection} numberInputRef={numberInputRef} callButtonRef={callButtonRef} inboundNote={inboundNote} />
        )}
        <div className={styles.col}>
          {sp.finishOnly || sp.noWorkToDial ? null : <SetupCard sp={sp} />}
          {sp.finishOnly || sp.noWorkToDial ? null : detailsCard}
          {sp.finishOnly ? null : <RecentCallsCard sp={sp} />}
        </div>
      </>
    );
  } else if (phase === 'coming') {
    bodyClass = styles.bodyEven;
    body = (
      <>
        <div className={styles.col}>
          <CustomerCardView card={card} />
          <CallingFrom sp={sp} call={call} />
        </div>
        <div className={styles.col}>
          {sp.phase === 'ringing' && call.can_cancel_ringing !== true ? (
            <section className={`${styles.card} ${side.warnCard}`}>
              <h2 className={styles.cardTitle}><TriangleAlert size={20} aria-hidden="true" />{SIDE_COPY.ringing}</h2>
              <p data-testid="ringing-warning">{SIDE_COPY.ringingWarning}</p>
            </section>
          ) : null}
          {call.contact ? <LastCallsCard rows={lastCalls} /> : null}
          {detailsCard}
        </div>
      </>
    );
  } else if (phase === 'on_call') {
    bodyClass = styles.bodyEven;
    body = (
      <>
        <div className={styles.col}>
          <CustomerCardView card={card} showLastSaid={false} />
          {call.contact ? <LastCallsCard rows={lastCalls} /> : null}
        </div>
        <div className={styles.col}>
          {noteCard}
          {detailsCard}
        </div>
      </>
    );
  } else {
    bodyClass = styles.bodyWideLeft;
    // A call-later on a call the list is not waiting on stays on the call: nothing calls back.
    const queued = Boolean(call.contact?.claimed);
    body = (
      <>
        <WhatHappened
          catalog={sp.catalog}
          form={sp.form}
          onChange={(next) => sp.setForm(next, 'click')}
          enabled={sp.padEnabled}
          now={clock.now}
          handleRef={tilesRef}
          amountDue={card.amountDue}
          comesToMe={queued ? false : null}
          callLaterLine={queued ? undefined : SIDE_COPY.callBackYourself}
          rejection={sp.padRejection}
          keysRemapped={false}
          onNeedsNote={() => notesRef.current?.focus()}
          readAloud={frame.readAloud}
          onAskDontCallAgain={(code) => (code ? setStopAsk(code) : sp.openDnc())}
          dontCallAgainOffered={sp.dncEnabled && sp.dncOutcome === null}
          shake={shake}
        />
        <div className={styles.col}>
          <CustomerCardView card={card} compact />
          {noteCard}
          {detailsCard}
        </div>
      </>
    );
  }

  // Where the mark reaches is the server's rule (CL6, docs/call-log.md §5): the work's only when
  // the number is on its list; a call merely saved to a work stops the number for the whole account.
  const stopBody = call?.tag && call.contact ? SIDE_COPY.stopBodyWork(call.tag.campaign_name) : SIDE_COPY.stopBodyAll;

  return (
    <>
      <StationFrame
        view={band}
        agentName={frame.agentName}
        workName={frame.workName}
        brandMark={frame.brandMark}
        needHelp={frame.needHelp}
        // Finish work while nothing is dialled; during a call only Sound and the colour, as on 04.
        menu={frame.menu(phase === 'idle' ? ['sound', 'theme', 'finish'] : ['sound', 'theme'])}
        bandSide={bandSide}
        banners={<>{callBanner}{frame.banners}</>}
        bodyClassName={bodyClass}
        bodyRef={bodyRef}
        footLeft={footLeft}
        footRight={footRight}
        testId={testId}
      >
        {/* The assertive region: the direct result of a button the agent just pressed. */}
        <div className={styles.srOnly} role="alert" aria-live="assertive">{sp.announcement}</div>
        <div className={side.contents} data-testid="softphone-body" data-phase={sp.phase}>
          {body}
        </div>
      </StationFrame>
      <StopCallingDialog
        open={stopAsk !== null || sp.dncConfirmOpen}
        who={card ? [card.name, card.phone].filter(Boolean).join(' · ') : null}
        busy={sp.dncInFlight}
        failure={null}
        body={stopBody}
        onYes={() => {
          if (stopAsk !== null) {
            sp.setForm({ ...sp.form, selectedCode: stopAsk }, 'click');
            setStopAsk(null);
            return;
          }
          sp.confirmDnc();
        }}
        onNo={() => (stopAsk !== null ? setStopAsk(null) : sp.cancelDnc())}
      />
      <OverrideDialog
        prompt={sp.overridePrompt}
        submitting={sp.overrideSubmitting}
        error={sp.overrideError}
        onConfirm={sp.confirmOverride}
        onCancel={sp.cancelOverride}
      />
    </>
  );
}

/** Why Call cannot dial yet, keyed on what the soft phone says is missing; null when it can. */
function dialReason(sp: SoftphoneState, connection: StationConnection): string | null {
  if (connection === 'connecting' || connection === 'idle') return SIDE_COPY.connectingPhone;
  if (connection !== 'open') return SIDE_COPY.notConnected;
  if (!sp.bootstrap) return SIDE_COPY.loading;
  // The account asks for a work on every call: Call stays off until one is chosen.
  if (sp.campaignRequired && sp.tagCampaignId === null) return SIDE_COPY.chooseWorkHint;
  if (sp.callerIdOptions.length === 0) return SIDE_COPY.noCallerId;
  if (sp.number.length > 0 && sp.dialBlock) return DIAL_BLOCK_WORDS[sp.dialBlock];
  return null;
}

/**
 * The number box, the keypad and Call. The box is a real `<input>`: typing, selecting and the
 * browser's paste all work, and the keypad writes into the same value; a key pressed anywhere on
 * the page reaches it too (`useSoftphoneShortcuts`). Call stays in place, faded, until it can dial.
 */
function DialCard({
  sp,
  connection,
  numberInputRef,
  callButtonRef,
  inboundNote,
}: {
  sp: SoftphoneState;
  connection: StationConnection;
  numberInputRef: RefObject<HTMLInputElement>;
  callButtonRef: RefObject<HTMLButtonElement>;
  inboundNote: string;
}) {
  const reasonId = useId();
  const reason = dialReason(sp, connection);
  const disabled = !sp.setupEditable;
  const countryCode = sp.bootstrap?.default_country_code ?? '+91';
  const inboundOn = useFeatureFlagEnabled(INBOUND_FLAG);
  return (
    <form
      className={`${styles.card} ${side.dialCard}`}
      aria-label={SIDE_COPY.dialForm}
      onSubmit={(event) => {
        event.preventDefault();
        sp.dial();
      }}
      data-testid="dial-card"
    >
      <h2 className={styles.cardTitle} style={{ marginBottom: 0 }}><Phone size={20} aria-hidden="true" />{SIDE_COPY.number}</h2>
      <div className={side.numberBox}>
        {sp.number.startsWith('+') ? null : (
          <span className={side.countryCode} title={SIDE_COPY.countryCodeHint}>{countryCode}</span>
        )}
        <input
          ref={numberInputRef}
          className={side.numberInput}
          type="tel"
          inputMode="tel"
          autoComplete="off"
          aria-label={SIDE_COPY.number}
          aria-describedby={reason || sp.dialError ? reasonId : undefined}
          placeholder={SIDE_COPY.numberPlaceholder}
          value={sp.number}
          disabled={disabled}
          onChange={(event) => sp.setNumber(event.target.value)}
          data-testid="dial-number"
        />
        <button
          type="button"
          className={side.backspace}
          aria-label={SIDE_COPY.deleteDigit}
          onClick={sp.backspace}
          disabled={disabled || sp.number.length === 0}
        >
          <Delete size={26} aria-hidden="true" />
        </button>
      </div>

      <div className={side.keypad} role="group" aria-label={SIDE_COPY.keypad}>
        {DIAL_KEYS.map((key) => (
          <button
            key={key}
            type="button"
            className={side.key}
            aria-label={DIAL_KEY_LETTERS[key] && key !== '0' ? `${key} ${DIAL_KEY_LETTERS[key]}` : key}
            disabled={disabled}
            onClick={() => sp.pressKey(key)}
            data-testid={`dial-key-${key}`}
          >
            <span className={side.keyDigit} aria-hidden="true">{key}</span>
            <span className={side.keyLetters} aria-hidden="true">{DIAL_KEY_LETTERS[key]}</span>
          </button>
        ))}
      </div>

      <button
        ref={callButtonRef}
        type="submit"
        className={`${styles.btn} ${styles.btnBig} ${styles.btnGo} ${side.callButton}`}
        // Faded, never `disabled`: a press that cannot dial says why, and focus stays here.
        aria-disabled={!sp.canDial || undefined}
        aria-describedby={reason || sp.dialError ? reasonId : undefined}
        aria-keyshortcuts="Enter"
        onClick={(event) => {
          if (!sp.canDial) event.preventDefault();
        }}
        data-testid="dial-call"
      >
        <PhoneOutgoing size={24} aria-hidden="true" />
        {sp.placing ? SIDE_COPY.placing : SIDE_COPY.call}
        <span className={styles.key} aria-hidden="true">Enter</span>
      </button>

      {sp.dialError ? (
        <p id={reasonId} className={side.reason} data-tone="problem" role="alert" data-testid="dial-error">{sp.dialError}</p>
      ) : reason ? (
        <p id={reasonId} className={side.reason} data-testid="dial-reason">{reason}</p>
      ) : (
        <p className={side.hint}>{SIDE_COPY.pasteWorks}</p>
      )}

      {inboundOn ? (
        <p className={side.note} role="note" data-testid="softphone-inbound-notice">
          <Info size={18} aria-hidden="true" />
          {inboundNote}
        </p>
      ) : null}
    </form>
  );
}

/** Where the call is saved (its work, which fixes its outcomes and numbers) and the number it goes from. */
function SetupCard({ sp }: { sp: SoftphoneState }) {
  const tagId = useId();
  const fromId = useId();
  const editable = sp.setupEditable;
  const hint = callFromHint(sp);
  return (
    <section className={styles.card} data-testid="log-to">
      <div className={side.field}>
        <label className={side.fieldLabel} htmlFor={tagId}>
          {SIDE_COPY.saveTo}
          {sp.campaignRequired ? <span data-testid="log-to-required"> {SIDE_COPY.required}</span> : null}
        </label>
        <select
          id={tagId}
          className={side.select}
          value={sp.tagCampaignId ?? ''}
          disabled={!editable}
          required={sp.campaignRequired}
          aria-required={sp.campaignRequired}
          onChange={(event) => sp.setTagCampaignId(event.target.value || null)}
          data-testid="log-to-select"
        >
          {/* With every call needing a work there is no "Not in any work": the empty choice only asks. */}
          {sp.campaignRequired
            ? <option value="" disabled={sp.tagCampaignId !== null}>{SIDE_COPY.chooseWork}</option>
            : <option value="">{SIDE_COPY.noWorkOption}</option>}
          {sp.taggableCampaigns.map((c) => (
            <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_name}</option>
          ))}
        </select>
        {editable && sp.setupNote ? <p className={side.hint} role="status" data-testid="log-to-note">{sp.setupNote}</p> : null}
        {editable && sp.campaign && !sp.campaign.calling_window_open ? (
          <p className={side.hint} data-testid="window-closed-hint">{SIDE_COPY.outsideHours}</p>
        ) : null}
      </div>
      <div className={side.field}>
        <label className={side.fieldLabel} htmlFor={fromId}>{SIDE_COPY.callFrom}</label>
        <select
          id={fromId}
          className={side.select}
          value={sp.callerId ?? ''}
          disabled={!editable || sp.callerIdOptions.length === 0}
          onChange={(event) => sp.setCallerId(event.target.value || null)}
          data-testid="caller-id"
        >
          {sp.callerIdOptions.length === 0 ? <option value="">{SIDE_COPY.noNumbers}</option> : null}
          {sp.callerIdAutomatic ? <option value="">{SIDE_COPY.automatic}</option> : null}
          {sp.callerIdOptions.map((id) => (
            <option key={id} value={id}>{formatDialNumber(id)}</option>
          ))}
        </select>
        {hint ? <p className={side.hint} data-testid="caller-id-hint">{hint}</p> : null}
      </div>
    </section>
  );
}

/**
 * The line under Call from (DN4): Automatic's while it is the choice; a picked number's only while
 * the call can still change. Once placed, the number is the call's own: no line.
 */
export function callFromHint(
  sp: Pick<SoftphoneState, 'callerIdAutomatic' | 'callerId' | 'setupEditable' | 'campaign'>,
): string | null {
  if (sp.callerIdAutomatic && sp.callerId === null) return SIDE_COPY.automaticHint;
  if (!sp.setupEditable) return null;
  return sp.campaign ? SIDE_COPY.pickedHintWork(sp.campaign.campaign_name) : SIDE_COPY.pickedHintOwn;
}

/** On a placed call: the number it goes from and the work it is saved to, fixed now. */
function CallingFrom({ sp, call }: { sp: SoftphoneState; call: AgencyManualCall }) {
  return (
    <section className={styles.card} data-testid="calling-from">
      <dl className={side.about}>
        <div>
          <dt>{SIDE_COPY.callFrom}</dt>
          <dd>{formatDialNumber(call.caller_id)}</dd>
        </div>
        <div>
          <dt>{SIDE_COPY.work}</dt>
          <dd data-testid="log-to-fixed">{sp.campaign?.campaign_name ?? call.tag?.campaign_name ?? SIDE_COPY.noWork}</dd>
        </div>
      </dl>
    </section>
  );
}

/** My recent calls, newest first; the arrow puts a number back in the box (it never dials). */
function RecentCallsCard({ sp }: { sp: SoftphoneState }) {
  return (
    <section className={styles.card} data-testid="recent-calls">
      <h2 className={styles.cardTitle}><FileText size={20} aria-hidden="true" />{SIDE_COPY.recentCalls}</h2>
      {sp.recentLoading && sp.recent.length === 0 ? (
        <p className={side.hint}>{SIDE_COPY.recentLoading}</p>
      ) : sp.recentError && sp.recent.length === 0 ? (
        <p className={side.hint} data-testid="recent-error">{SIDE_COPY.recentFailed}</p>
      ) : sp.recent.length === 0 ? (
        <p className={side.hint} data-testid="recent-empty">{SIDE_COPY.recentEmpty}</p>
      ) : (
        <ul className={side.recent} aria-label={SIDE_COPY.recentCalls}>
          {sp.recent.map((row) => {
            const shown = formatDialNumber(row.destination_e164);
            const at = Date.parse(row.created_at);
            const when = Number.isFinite(at) ? `${sameDay(at, Date.now()) ? STATION_COPY.today : dayMonth(at)}, ${clockTime(at)}` : null;
            return (
              <li key={row.id} className={side.recentRow} data-testid={`recent-${row.id}`}>
                <span className={side.recentText}>
                  <b>{shown}</b>
                  <span>{[recentOutcome(row, sp), row.tag?.campaign_name ?? SIDE_COPY.noWork, when].filter(Boolean).join(' · ')}</span>
                </span>
                <button
                  type="button"
                  className={side.redial}
                  onClick={() => sp.redial(row)}
                  disabled={!sp.setupEditable}
                  aria-label={SIDE_COPY.redial(shown)}
                  title={SIDE_COPY.redial(shown)}
                >
                  <RotateCcw size={22} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** What happened on a recent call, in the station's words. */
function recentOutcome(call: AgencyManualCall, sp: SoftphoneState): string {
  if (call.disposition_code) return dispositionLabel(call.disposition_code, catalogForCall(call, sp.bootstrap)) ?? call.disposition_code;
  if (call.settled_at === null && call.state === 'ended' && call.requires_disposition) return SIDE_COPY.notSavedYet;
  if (call.state !== 'ended') return SIDE_COPY.onACallNow;
  return call.outcome ? ATTEMPT_OUTCOME_WORDS[call.outcome] : SIDE_COPY.notSavedYet;
}
