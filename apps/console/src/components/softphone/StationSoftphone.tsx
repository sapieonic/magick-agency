import { useEffect, useId, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Ban, Delete, FileText, Info, ListChecks, MicOff, Phone, PhoneOutgoing, RotateCcw, TriangleAlert } from 'lucide-react';
import type { DispositionPadHandle } from '../agency/DispositionPad';
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
  const sp = softphone.sp;
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

  const display = sp.campaign?.context_display;
  const card = useMemo(() => (call ? softphoneCustomerCard(call, display) : null), [call, display]);
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
  const callBanner: ReactNode = sp.hangupFailure ? (
    <StationBanner tone="problem" icon={<TriangleAlert size={22} />} role="alert" testId="softphone-hangup-failure">{SIDE_COPY.endCallFailed}</StationBanner>
  ) : sp.dncFailure ? (
    <StationBanner tone="problem" icon={<TriangleAlert size={22} />} role="alert" testId="softphone-dnc-failure">{SIDE_COPY.stopFailed}</StationBanner>
  ) : sp.dncOutcome ? (
    <StationBanner tone="ready" icon={<Ban size={22} />} role="status" testId="softphone-dnc-outcome">{SIDE_COPY.stoppedCalls}</StationBanner>
  ) : phase === 'on_call' && sp.muted ? (
    <StationBanner tone="break" icon={<MicOff size={22} />} testId="softphone-on-mute">{STATION_COPY.onMute}</StationBanner>
  ) : sp.finishOnly && call ? (
    <StationBanner tone="quiet" icon={<Info size={22} />} role="status" testId="softphone-finish-notice">{SIDE_COPY.finishCall}</StationBanner>
  ) : null;

  // ── The footer: one main button bottom right (AS1) ──────────────────────────
  // Back to my calls, and why it is not offered while a call is live or owes its outcome: as the
  // station's frame has always had it.
  const returnReason = softphone.returnFailure ?? softphone.returnBlockedReason;
  const returnLine = returnReason ? (
    <span className={styles.footHint} id="return-to-campaign-reason" role={softphone.returnFailure ? 'alert' : undefined} data-testid="return-to-campaign-reason">
      {returnReason}
    </span>
  ) : null;
  let footLeft: ReactNode = returnLine;
  let footRight: ReactNode = null;
  if (phase === 'idle') {
    footRight = softphone.returnBlockedReason === null ? (
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
    ) : null;
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
  const detailsCard = sp.fields.length > 0 ? (
    <section className={`${styles.card} ${side.details}`} data-testid="call-details">
      <h2 className={styles.cardTitle}><ListChecks size={20} aria-hidden="true" />{SIDE_COPY.callDetails}</h2>
      <CallFieldsForm
        fields={sp.fields}
        values={sp.fieldValues}
        errors={sp.fieldErrors}
        disabled={sp.placing || (sp.finishOnly && !call)}
        loading={false}
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
            <p className={side.reason} role="status" data-testid="softphone-finish-notice">{SIDE_COPY.finishIdle}</p>
          </section>
        ) : (
          <DialCard sp={sp} connection={connection} numberInputRef={numberInputRef} callButtonRef={callButtonRef} />
        )}
        <div className={styles.col}>
          {sp.finishOnly ? null : <SetupCard sp={sp} />}
          {sp.finishOnly ? null : detailsCard}
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
            <section className={`${styles.card} ${side.warnCard}`} data-testid="ringing-warning">
              <h2 className={styles.cardTitle}><TriangleAlert size={20} aria-hidden="true" />{SIDE_COPY.ringing}</h2>
              <p>{SIDE_COPY.ringingWarning}</p>
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

  const stopBody = call?.tag ? SIDE_COPY.stopBodyWork(call.tag.campaign_name) : SIDE_COPY.stopBodyAll;

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
        testId="station-softphone"
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
  if (connection !== 'open') return SIDE_COPY.notConnected;
  if (!sp.bootstrap) return SIDE_COPY.loading;
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
}: {
  sp: SoftphoneState;
  connection: StationConnection;
  numberInputRef: RefObject<HTMLInputElement>;
  callButtonRef: RefObject<HTMLButtonElement>;
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
          {SIDE_COPY.inboundNotHere}
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
  return (
    <section className={styles.card} data-testid="log-to">
      <div className={side.field}>
        <label className={side.fieldLabel} htmlFor={tagId}>{SIDE_COPY.saveTo}</label>
        <select
          id={tagId}
          className={side.select}
          value={sp.tagCampaignId ?? ''}
          disabled={!editable}
          onChange={(event) => sp.setTagCampaignId(event.target.value || null)}
          data-testid="log-to-select"
        >
          <option value="">{SIDE_COPY.noWorkOption}</option>
          {sp.taggableCampaigns.map((c) => (
            <option key={c.campaign_id} value={c.campaign_id}>{c.campaign_name}</option>
          ))}
        </select>
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
      </div>
    </section>
  );
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
                  <span>{[recentOutcome(row, sp), row.tag?.campaign_name ?? null, when].filter(Boolean).join(' · ')}</span>
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
