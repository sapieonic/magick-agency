import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Ban, Info, MicOff, PhoneIncoming, TriangleAlert, UserRound } from 'lucide-react';
import type { DispositionPadHandle } from '../DispositionPad';
import { StationBanner, StationFrame } from '../station/StationFrame';
import { CustomerCardView, LastCallsCard, NoteCard } from '../station/StationCustomer';
import { WhatHappened } from '../station/WhatHappened';
import { StopCallingDialog } from '../station/StationScreens';
import { SinceClock } from '../station/StationClocks';
import {
  OutcomeDueRing,
  RecordedPill,
  SideEndCall,
  SideMute,
  SideSave,
  sideEndCallCopy,
  type SideFrameProps,
} from '../station/SideCall';
import { useInboundShortcuts } from './useInboundShortcuts';
import { useMatchedComesToMe } from './useMatchedComesToMe';
import { findDisposition } from '../../../utils/agencyDispositionForm';
import { formatDialNumber } from '../../../utils/softphone/phoneInput';
import { STATION_COPY } from '../../../utils/agency/stationCopy';
import { SIDE_COPY, STICKY_WORDS, sideSaveBlockLine, waitedFor } from '../../../utils/agency/sideViewCopy';
import { inboundCustomerCard, inboundLastCalls } from '../../../utils/agency/sideViewCustomer';
import { sideViewBand, type SideCallPhase } from '../../../utils/agency/stationView';
import type { InboundCallState } from '../../../hooks/useInboundCall';
import type { ServerClock } from '../../../hooks/useServerClock';
import type { StationConnection } from '../../../hooks/agencyStation/types';
import type { AgencyInboundCall } from '../../../types/inbound';
import type { AgencyAssignmentMode } from '@magick-agency/contracts/agency';
import type { CustomerCard } from '../../../utils/agency/stationCustomer';
import styles from '../station/Station.module.css';
import side from '../station/SideView.module.css';

/** End call on an inbound call: the station's words, its own hint id. */
export const INBOUND_END_CALL_COPY = sideEndCallCopy('inbound-hangup');

/**
 * An inbound call on the agent's station (P2, `docs/inbound.md` §6), in the station's look (AS1,
 * spec §3 03–05): the frame and its band ("Customer is calling", On call, What happened?), the
 * outbound call's customer card, Last calls and the note, and one main button bottom right.
 *
 *  - **Customer is calling** (the offer, IB1: on screen before the caller's audio binds at
 *    `connects_at`): the card, About this call (the number they called, the line, how long they
 *    waited, their work, whether they are the agent's own customer, asked not to be called) and
 *    Last calls. No button (AS11); "The call connects by itself."
 *  - **On call**: the card and About this call left, Last calls and the note right; Mute bottom
 *    left, End call bottom right, held or `E` twice (AS3).
 *  - **What happened?**: the station's own tiles and follow-ups (`WhatHappened`), the small card
 *    and the note; Save bottom right, faded until it can save (spec §6.1). Don't call again asks
 *    first (05c).
 *
 * Hidden, not disabled (AS1): a control that does nothing now is not on screen. The keys are the
 * panel's own (`useInboundShortcuts`, unchanged): `1`–`9`, `C`, `N`, `Enter`, `M`, `D`, `E` `E`.
 * Focus moves once per call, to the body when the call is offered, never at connect.
 */
export function InboundCallView({
  ib,
  call,
  connection,
  clock,
  frame,
  connectFlash,
  station,
  shortcutsEnabled = true,
}: {
  ib: InboundCallState;
  /** `ib.call`, narrowed by the host: the view renders only with a call on the station. */
  call: AgencyInboundCall;
  connection: StationConnection;
  clock: ServerClock;
  frame: SideFrameProps;
  connectFlash: boolean;
  /** The station's own campaign and its routing, for whether a matched caller's call-later comes back (AS8). */
  station: { campaignId: string | null; assignmentMode: AgencyAssignmentMode | null };
  shortcutsEnabled?: boolean;
}) {
  const bodyRef = useRef<HTMLElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const tilesRef = useRef<DispositionPadHandle | null>(null);
  const [stopAsk, setStopAsk] = useState<string | null>(null);
  const [shake, setShake] = useState(0);
  const [blockLine, setBlockLine] = useState<string | null>(null);

  /*
    C picks the call-later outcome. On What happened? the tiles own it (and move focus to Call
    when?); on the call, where the tiles are not on screen yet, it is picked so What happened?
    opens with it chosen, as the old pad did.
  */
  const keyPadRef = useRef<DispositionPadHandle | null>(null);
  keyPadRef.current = {
    selectCallback: () => {
      if (tilesRef.current) return tilesRef.current.selectCallback();
      if (!ib.padEnabled) return false;
      const entry = ib.catalog.find((option) => option.requires_datetime);
      if (!entry) return false;
      ib.setForm({ ...ib.form, selectedCode: entry.code });
      return true;
    },
  };
  useInboundShortcuts(ib, clock, { notesRef, padRef: keyPadRef, enabled: shortcutsEnabled && stopAsk === null });

  useEffect(() => {
    bodyRef.current?.focus();
  }, [call.id]);
  // A new pick retires the early-Save line.
  useEffect(() => {
    setBlockLine(null);
  }, [ib.form.selectedCode, ib.form.callbackAt, ib.form.promiseDate, call.id]);

  const card = useMemo(() => inboundCustomerCard(call, frame.phoneDisplay), [call, frame.phoneDisplay]);
  const lastCalls = useMemo(() => inboundLastCalls(call), [call]);
  const phase: SideCallPhase = ib.phase === 'offered' ? 'coming' : ib.phase === 'connected' ? 'on_call' : 'happened';
  const band = sideViewBand({ kind: 'inbound', connection, phase, who: card.name ?? card.phone });
  const live = connection === 'open';
  const selected = findDisposition(ib.catalog, ib.form.selectedCode);
  const comesToMe = useMatchedComesToMe({
    campaignId: call.match?.campaign_id ?? null,
    stationCampaignId: station.campaignId,
    stationMode: station.assignmentMode,
    enabled: phase === 'happened',
  });

  const trySave = () => {
    if (ib.saving) return;
    const block = ib.saveBlockAt(clock.now());
    if (block !== null) {
      setShake((n) => n + 1);
      setBlockLine(sideSaveBlockLine(block));
      if (block === 'note_required') notesRef.current?.focus();
      return;
    }
    ib.saveOutcome();
  };

  // ── The band's right side ───────────────────────────────────────────────────
  const bandSide = (
    <span className={styles.bandSide}>
      {frame.cueFlash}
      {phase === 'coming' && live ? (
        <span className={styles.pill}>{STATION_COPY.connecting}<span className={styles.dots} aria-hidden="true"><i /><i /><i /></span></span>
      ) : null}
      {(phase === 'coming' || phase === 'on_call') && call.recording ? <RecordedPill testId="inbound-recording" /> : null}
      {phase === 'on_call' && live && call.bridged_at ? (
        <SinceClock anchor={call.bridged_at} clock={clock} className={styles.bandClock} testId="inbound-talk-timer" />
      ) : null}
      {phase === 'happened' && live && call.outcome_due_at ? (
        <OutcomeDueRing dueAt={call.outcome_due_at} startedAt={call.ended_at} clock={clock} testId="inbound-lapse" />
      ) : null}
    </span>
  );

  // ── The call's own banner (one), before the page's ──────────────────────────
  const callBanner: ReactNode = ib.hangupFailure ? (
    <StationBanner tone="problem" icon={<TriangleAlert size={22} />} role="alert" testId="inbound-hangup-failure">{SIDE_COPY.endCallFailed}</StationBanner>
  ) : ib.dncFailure ? (
    <StationBanner tone="problem" icon={<TriangleAlert size={22} />} role="alert" testId="inbound-dnc-failure">{SIDE_COPY.stopFailed}</StationBanner>
  ) : ib.dncOutcome ? (
    <StationBanner tone="ready" icon={<Ban size={22} />} role="status" testId="inbound-dnc-outcome">{SIDE_COPY.stoppedCalls}</StationBanner>
  ) : phase === 'on_call' && ib.muted ? (
    <StationBanner tone="break" icon={<MicOff size={22} />} testId="inbound-on-mute">{STATION_COPY.onMute}</StationBanner>
  ) : null;

  // ── The footer: one main button bottom right (AS1) ──────────────────────────
  let footLeft: ReactNode = null;
  let footRight: ReactNode = null;
  let footHint: ReactNode = null;
  if (phase === 'coming') {
    footHint = STATION_COPY.connectsByItself;
  } else if (phase === 'on_call') {
    footLeft = ib.muteEnabled ? (
      <SideMute muted={ib.muted} onToggle={ib.toggleMute} label={{ off: STATION_COPY.mute, on: STATION_COPY.unmute }} testId="inbound-mute" />
    ) : null;
    footRight = ib.hangupEnabled ? <SideEndCall callId={call.id} onConfirm={ib.hangup} copy={INBOUND_END_CALL_COPY} /> : null;
  } else {
    footLeft = blockLine ? <span id="inbound-save-block" className={styles.refusal} role="status" data-testid="inbound-save-reason">{blockLine}</span> : null;
    footRight = (
      <SideSave
        blocked={() => ib.saveBlockAt(clock.now()) !== null}
        ticking={Boolean(selected?.requires_datetime)}
        saving={ib.saving}
        onSave={trySave}
        shake={shake}
        describedBy={blockLine ? 'inbound-save-block' : null}
        testId="inbound-save"
      />
    );
  }

  // ── The body ────────────────────────────────────────────────────────────────
  const noteCard = (
    <NoteCard
      ref={notesRef}
      value={ib.notes}
      onAgentEdit={ib.setNotes}
      status={ib.notesStatus}
      enabled={ib.notesEnabled}
      onSubmit={trySave}
      needed={Boolean(selected?.requires_note)}
    />
  );
  const about = <AboutCallCard call={call} />;
  let bodyClass = styles.body2;
  let body: ReactNode;
  if (phase === 'coming') {
    body = (
      <>
        <CustomerCardView card={card} />
        <div className={styles.col}>
          {about}
          {call.match ? <LastCallsCard rows={lastCalls} /> : null}
        </div>
      </>
    );
  } else if (phase === 'on_call') {
    bodyClass = styles.bodyEven;
    body = (
      <>
        <div className={styles.col}>
          <CustomerCardView card={card} showLastSaid={false} />
          {about}
        </div>
        <div className={styles.col}>
          {call.match ? <LastCallsCard rows={lastCalls} /> : null}
          {noteCard}
        </div>
      </>
    );
  } else {
    bodyClass = styles.bodyWideLeft;
    body = (
      <>
        <WhatHappened
          catalog={ib.catalog}
          form={ib.form}
          onChange={ib.setForm}
          enabled={ib.padEnabled}
          now={clock.now}
          handleRef={tilesRef}
          amountDue={card.amountDue}
          // A matched caller's call-later follows their work's routing (AS8); a caller on no list
          // is called back by the agent.
          comesToMe={call.match ? comesToMe : null}
          callLaterLine={call.match ? undefined : SIDE_COPY.callBackYourself}
          rejection={ib.padRejection}
          keysRemapped={false}
          onNeedsNote={() => notesRef.current?.focus()}
          readAloud={frame.readAloud}
          onAskDontCallAgain={(code) => (code ? setStopAsk(code) : ib.openDnc())}
          dontCallAgainOffered={ib.dncEnabled && ib.dncOutcome === null}
          shake={shake}
        />
        <div className={styles.col}>
          <CustomerCardView card={card} compact />
          {noteCard}
        </div>
      </>
    );
  }

  // Marking the number reaches the matched work, else the whole account; an outcome, its list's.
  const stopBody = stopAsk !== null
    ? call.match ? STATION_COPY.stopCallingBody : SIDE_COPY.stopBodyAll
    : call.match ? SIDE_COPY.stopBodyWork(call.match.campaign_name) : SIDE_COPY.stopBodyAll;

  return (
    <>
      <StationFrame
        view={band}
        agentName={frame.agentName}
        workName={frame.workName}
        brandMark={frame.brandMark}
        needHelp={frame.needHelp}
        // During a call and on What happened? only Sound and the colour, as on 04 and 05.
        menu={frame.menu(['sound', 'theme'])}
        bandSide={bandSide}
        banners={<>{callBanner}{frame.banners}</>}
        connectFlash={connectFlash}
        bodyClassName={bodyClass}
        bodyRef={bodyRef}
        footHint={footHint}
        footLeft={footLeft}
        footRight={footRight}
        testId="station-inbound"
      >
        {/* The assertive region: the direct result of a button the agent just pressed. */}
        <div className={styles.srOnly} role="alert" aria-live="assertive">{ib.announcement}</div>
        <div className={side.contents} data-testid="inbound-body" data-phase={ib.phase ?? 'none'}>
          {body}
        </div>
      </StationFrame>
      <StopCallingDialog
        open={stopAsk !== null || ib.dncConfirmOpen}
        who={whoLine(card)}
        busy={ib.dncInFlight}
        failure={null}
        body={stopBody}
        onYes={() => {
          if (stopAsk !== null) {
            ib.setForm({ ...ib.form, selectedCode: stopAsk });
            setStopAsk(null);
            return;
          }
          ib.confirmDnc();
        }}
        onNo={() => (stopAsk !== null ? setStopAsk(null) : ib.cancelDnc())}
      />
    </>
  );
}

function whoLine(card: CustomerCard): string {
  return [card.name, card.phone].filter(Boolean).join(' · ');
}

/**
 * About this call: what only an inbound call has. Whether the caller asked not to be called (a
 * customer's own call is an enquiry: help them, do not call back), whether they are the agent's own
 * customer, the number they called, the line, how long they waited and their work. A caller we
 * do not know is asked their name.
 */
function AboutCallCard({ call }: { call: AgencyInboundCall }) {
  const sticky = call.sticky ? (call.sticky.is_you ? STICKY_WORDS[call.sticky.reason] : SIDE_COPY.otherAgentsCustomer) : null;
  return (
    <section className={styles.card} aria-label={SIDE_COPY.aboutCall} data-testid="inbound-about">
      <h2 className={styles.cardTitle}><PhoneIncoming size={20} aria-hidden="true" />{SIDE_COPY.aboutCall}</h2>
      {call.caller_dnc || sticky ? (
        <div className={side.tags}>
          {call.caller_dnc ? (
            <span className={`${styles.tag} ${side.tagStop}`} data-testid="inbound-dnc-badge"><Ban size={16} aria-hidden="true" />{SIDE_COPY.dncBadge}</span>
          ) : null}
          {sticky ? (
            <span className={`${styles.tag} ${call.sticky?.is_you ? '' : side.tagQuiet}`} data-testid="inbound-sticky"><UserRound size={16} aria-hidden="true" />{sticky}</span>
          ) : null}
        </div>
      ) : null}
      {call.caller_dnc ? <p className={side.warnLine} data-testid="inbound-dnc-enquiry">{SIDE_COPY.dncEnquiry}</p> : null}
      <dl className={side.about}>
        <div>
          <dt>{SIDE_COPY.theyCalled}</dt>
          <dd data-testid="inbound-to">{formatDialNumber(call.to_e164)}</dd>
        </div>
        {call.route ? (
          <div>
            <dt>{SIDE_COPY.line}</dt>
            <dd data-testid="inbound-route">{call.route.name}</dd>
          </div>
        ) : null}
        <div>
          <dt>{SIDE_COPY.waited}</dt>
          <dd data-testid="inbound-waited">{waitedFor(call.waited_seconds)}</dd>
        </div>
        <div>
          <dt>{SIDE_COPY.work}</dt>
          <dd data-testid="inbound-campaign">{call.match?.campaign_name ?? SIDE_COPY.noWork}</dd>
        </div>
      </dl>
      {call.match ? null : (
        <p className={styles.fine} data-testid="inbound-no-match">
          <Info size={16} aria-hidden="true" />
          {call.from_e164 ? SIDE_COPY.newCaller : SIDE_COPY.hiddenCaller}
        </p>
      )}
    </section>
  );
}
