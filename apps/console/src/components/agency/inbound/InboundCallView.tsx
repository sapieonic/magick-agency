import { useEffect, useMemo, useRef, type RefObject } from 'react';
import { PhoneIncoming } from 'lucide-react';
import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { DispositionPad, type DispositionPadHandle } from '../DispositionPad';
import { NotesField } from '../NotesField';
import { ContactDetail } from '../ContactDetail';
import { CueFlashBand } from '../StateRail';
import { HoldToConfirmButton, HANGUP_COPY, type HoldToConfirmCopy } from '../HoldToConfirmButton';
import { formatDuration } from '../../../utils/agencyClock';
import { resolveContextFields } from '../../../utils/agencyContext';
import { findDisposition } from '../../../utils/agencyDispositionForm';
import { formatDialNumber } from '../../../utils/softphone/phoneInput';
import {
  INBOUND_DNC_BADGE,
  INBOUND_DNC_ENQUIRY_COPY,
  INBOUND_DNC_WITHHELD_COPY,
  INBOUND_HANGUP_CONNECTING_COPY,
  INBOUND_HANGUP_ENDED_COPY,
  LAPSE_PREFIX,
  NUMBER_WITHHELD,
  catalogHint,
  describeInboundRail,
  inboundCallerNumber,
  inboundMatchName,
  matchLine,
  stickyLine,
  waitedLine,
} from '../../../utils/inbound/inboundCall';
import { useRepaintTick } from '../../../hooks/useRepaintTick';
import { INBOUND_SAVE_BLOCK_COPY, type InboundCallState } from '../../../hooks/useInboundCall';
import { useInboundShortcuts } from './useInboundShortcuts';
import type { ServerClock } from '../../../hooks/useServerClock';
import type { StationConnection } from '../../../hooks/agencyStation/types';
import type { CueFlash } from '../../../hooks/useAgencyCues';
import type { AgencyInboundCall } from '../../../types/inbound';
import station from '../AgentStation.module.css';
import rail from '../StateRail.module.css';
import sp from '../../softphone/SoftphoneView.module.css';
import styles from './InboundCallView.module.css';

/** The station's hang-up gesture, with its own id prefix so two buttons never share a hint id. */
export const INBOUND_HANGUP_COPY: HoldToConfirmCopy = {
  ...HANGUP_COPY,
  idPrefix: 'inbound-hangup',
  labels: { ...HANGUP_COPY.labels, idle: 'Hold to hang up', failed: 'Hold to hang up' },
};

/**
 * An inbound call on the agent's station (P2, `docs/inbound.md` §6), in place of the campaign's
 * panel, under the station's own header: rail, three columns, action bar. The station's frozen
 * geometry (`AgentConsolePage`'s rules, the soft phone's `SoftphoneView`):
 *
 *  1. **Every region renders in every state** (offered, connected, outcome needed) and only its
 *     content changes, so nothing moves under the agent's cursor as the caller's audio binds.
 *  2. **Every control renders in every state**, disabled with a stated reason when there is
 *     nothing to act on, so the tab order is fixed: column 1 → column 2 → the pad and notes →
 *     Save outcome → Mark DNC → Mute → Hang up (the station's and the soft phone's order).
 *  3. **Focus moves once per call**, to the body when the call is offered, never at connect:
 *     stealing focus as the caller starts speaking would cut a screen-reader user off.
 *
 * IB1: the panel is on screen before the caller's audio. The station renders it on the offer
 * frame; the server binds audio at `connects_at`, 1.5 s later.
 */
export function InboundCallView({
  ib,
  call,
  connection,
  clock,
  cueFlash,
  onReconnect,
  shortcutsEnabled = true,
}: {
  ib: InboundCallState;
  /** `ib.call`, narrowed by the host: the view renders only with a call on the station. */
  call: AgencyInboundCall;
  connection: StationConnection;
  clock: ServerClock;
  /** The station's escalated visual cue (connect, disconnect), shown on this rail as on its own. */
  cueFlash: CueFlash | null;
  onReconnect?: () => void;
  shortcutsEnabled?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const padRef = useRef<DispositionPadHandle | null>(null);
  const fieldFilterRef = useRef<HTMLInputElement>(null);

  useInboundShortcuts(ib, clock, { notesRef, padRef, enabled: shortcutsEnabled });

  useEffect(() => {
    bodyRef.current?.focus();
  }, [call.id]);

  return (
    <>
      <InboundRail call={call} connection={connection} clock={clock} cueFlash={cueFlash} onReconnect={onReconnect} />

      {/* The assertive region: the direct result of a button the agent just pressed. */}
      <div className={station.srOnly} role="alert" aria-live="assertive">
        {ib.announcement}
      </div>

      <div
        className={`${station.body} ${styles.body}`}
        ref={bodyRef}
        tabIndex={-1}
        data-testid="inbound-body"
        data-phase={ib.phase ?? 'none'}
      >
        <section className={station.colContact} aria-label="Caller">
          <CallerColumn call={call} />
        </section>
        <section className={station.colDetail} aria-label="Contact">
          <ContactColumn call={call} filterInputRef={fieldFilterRef} />
        </section>
        <section className={station.colOutcome} aria-label="Outcome">
          <DispositionPad
            catalog={ib.catalog}
            form={ib.form}
            onChange={ib.setForm}
            enabled={ib.padEnabled}
            disabledReason={ib.padDisabledReason}
            rejection={ib.padRejection}
            now={clock.now}
            onNeedsNote={() => notesRef.current?.focus()}
            handleRef={padRef}
            hint={catalogHint(call)}
          />
          <NotesField
            ref={notesRef}
            value={ib.notes}
            onAgentEdit={ib.setNotes}
            status={ib.notesStatus}
            enabled={ib.notesEnabled}
            disabledReason={ib.notesEnabled ? null : 'Notes open when a call is offered.'}
            onSubmit={ib.saveOutcome}
          />
        </section>
      </div>

      <InboundActionBar ib={ib} call={call} clock={clock} />
    </>
  );
}

// ─── The rail ───────────────────────────────────────────────────────────────

/**
 * The station's rail for an inbound call: the same 64px band, tints and accent bar as
 * `StateRail`, so the signal is read in the same place. It is the screen's polite live region;
 * the talk timer and the lapse countdown inside it are `aria-hidden` and repaint themselves.
 */
export function InboundRail({
  call,
  connection,
  clock,
  cueFlash,
  onReconnect,
}: {
  call: AgencyInboundCall;
  connection: StationConnection;
  clock: ServerClock;
  cueFlash: CueFlash | null;
  onReconnect?: () => void;
}) {
  const description = describeInboundRail({ connection, call });
  const recoverable = connection === 'disconnected' || connection === 'superseded';
  return (
    <div
      className={`${rail.rail} ${rail[`tone_${description.tone}`]}`}
      role="status"
      aria-live="polite"
      data-tone={description.tone}
      data-testid="inbound-rail"
    >
      {cueFlash ? <CueFlashBand key={`${cueFlash.cue}:${cueFlash.attemptId}`} flash={cueFlash} /> : null}
      <span className={rail.accent} aria-hidden="true" />
      <PhoneIncoming size={18} aria-hidden="true" className={styles.railIcon} />
      <span className={rail.label} data-testid="rail-label">
        {description.label}
      </span>
      {description.detail ? (
        <span className={rail.detail} data-testid="rail-detail">
          {description.detail}
        </span>
      ) : null}
      {description.timerFrom ? <TalkTimer from={description.timerFrom} clock={clock} /> : null}
      {description.lapseAt ? <LapseCountdown due={description.lapseAt} clock={clock} /> : null}
      {recoverable && onReconnect ? (
        <span className={rail.recovery}>
          <button type="button" className={rail.recoveryPrimary} onClick={onReconnect}>
            {connection === 'superseded' ? 'Use this window instead' : 'Reconnect'}
          </button>
        </span>
      ) : null}
    </div>
  );
}

function TalkTimer({ from, clock }: { from: string; clock: ServerClock }) {
  useRepaintTick();
  const ms = clock.since(from);
  if (ms === null) return null;
  return (
    <span className={rail.talkTimer} data-testid="inbound-talk-timer" aria-hidden="true">
      {formatDuration(ms)}
    </span>
  );
}

/**
 * "Without one, it closes in 0:24": the route's wrap-up window (IQ52, 30 s by default) an owed
 * outcome waits before the server closes the call `no_disposition` and returns the agent
 * (`outcome_due_at`). The digits are
 * `aria-hidden` (a countdown inside the live region would announce every second); the time it
 * closes at is said once, in words, for a screen reader.
 */
export function LapseCountdown({ due, clock }: { due: string; clock: ServerClock }) {
  useRepaintTick();
  const ms = clock.until(due);
  const at = clock.corrected(due);
  if (ms === null || at === null) return null;
  const clockTime = new Date(at).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return (
    <span className={styles.lapse} data-testid="inbound-lapse">
      <span aria-hidden="true">
        <span className={styles.lapseLong}>{LAPSE_PREFIX}</span>
        <span className={styles.lapseShort}>Closes in</span>{' '}
        <span className={styles.lapseDigits}>{formatDuration(ms)}</span>
      </span>
      <span className={station.srOnly}>Without an outcome, the call closes at {clockTime}.</span>
    </span>
  );
}

// ─── Column 1: who rang ─────────────────────────────────────────────────────

function CallerColumn({ call }: { call: AgencyInboundCall }) {
  const name = inboundMatchName(call);
  const number = inboundCallerNumber(call.from_e164);
  const sticky = stickyLine(call);
  const matched = matchLine(call);
  return (
    <div className={sp.column}>
      <div className={sp.cardHead}>
        <h2 className={sp.cardTitle}>Caller</h2>
        <p className={sp.hint}>Inbound call</p>
      </div>

      <div>
        {name ? (
          <p className={styles.callerName} data-testid="inbound-caller-name">
            {name}
          </p>
        ) : null}
        <p
          className={`${sp.callingTo} ${call.from_e164 ? '' : styles.withheld}`}
          data-testid="inbound-caller-number"
        >
          {number}
        </p>
      </div>

      <ul className={styles.badges} aria-label="About this call">
        {call.caller_dnc ? (
          <li className={`${sp.pill} ${styles.dncBadge}`} data-testid="inbound-dnc-badge">
            {INBOUND_DNC_BADGE}
          </li>
        ) : null}
        {sticky ? (
          <li className={`${sp.pill} ${call.sticky?.is_you ? sp.pillAccent : ''}`} data-testid="inbound-sticky">
            {sticky}
          </li>
        ) : null}
        <li className={`${sp.pill} ${call.recording ? sp.pillInfo : ''}`} data-testid="inbound-recording">
          {call.recording ? (
            <>
              <span className={styles.recDot} aria-hidden="true" />
              Recording
            </>
          ) : (
            'Not recorded'
          )}
        </li>
      </ul>

      {call.caller_dnc ? (
        <p className={sp.ringWarning} data-testid="inbound-dnc-enquiry">
          {INBOUND_DNC_ENQUIRY_COPY}
        </p>
      ) : null}

      <dl className={sp.factGrid}>
        <div className={sp.fact}>
          <dt className={sp.factLabel}>They rang</dt>
          <dd className={`${sp.factValue} ${sp.mono} ${styles.factNumber}`} data-testid="inbound-to">
            {formatDialNumber(call.to_e164)}
          </dd>
        </div>
        <div className={sp.fact}>
          <dt className={sp.factLabel}>Route</dt>
          <dd className={sp.factValue} data-testid="inbound-route">
            {call.route?.name ?? '—'}
          </dd>
        </div>
        <div className={sp.fact}>
          <dt className={sp.factLabel}>Before you</dt>
          <dd className={sp.factValue} data-testid="inbound-waited">
            {waitedLine(call.waited_seconds)}
          </dd>
        </div>
        <div className={sp.fact}>
          <dt className={sp.factLabel}>Campaign</dt>
          <dd className={sp.factValue} data-testid="inbound-campaign">
            {matched ?? 'Not on a campaign'}
          </dd>
        </div>
      </dl>
    </div>
  );
}

// ─── Column 2: the matched contact ──────────────────────────────────────────

function ContactColumn({ call, filterInputRef }: { call: AgencyInboundCall; filterInputRef: RefObject<HTMLInputElement> }) {
  const match = call.match;
  const resolved = useMemo(
    () => (match ? resolveContextFields(match.context, match.context_display) : null),
    [match],
  );
  const source = useMemo(
    () => (match ? { prior_attempts: match.prior_attempts, campaign_id: match.campaign_id, campaign_name: match.campaign_name } : null),
    [match],
  );

  if (!match || !resolved || !source) {
    return (
      <div className={sp.column} data-testid="inbound-no-match">
        <div className={sp.cardHead}>
          <h2 className={sp.cardTitle}>Contact</h2>
        </div>
        <p className={station.emptyState}>
          {call.from_e164
            ? 'This number isn’t on any campaign’s contacts. Ask who’s calling and note it.'
            : `${NUMBER_WITHHELD}: there is no number to match to a contact. Ask who’s calling and note it.`}
        </p>
      </div>
    );
  }

  return (
    <div data-testid="inbound-match">
      {resolved.hero.length > 0 ? (
        <dl className={station.heroList}>
          {resolved.hero.map((field) => (
            <div key={field.label} className={station.heroField}>
              <dt className={station.heroLabel}>{field.label}</dt>
              <dd className={station.heroValue}>{field.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {/* Keyed on the call: the field filter starts empty for each caller. */}
      <ContactDetail
        key={call.id}
        attempt={source}
        resolved={resolved}
        currentCatalog={call.catalog_source === 'campaign' ? call.disposition_catalog : undefined}
        filterInputRef={filterInputRef}
        nameCurrentCampaign
      />
    </div>
  );
}

// ─── The action bar ─────────────────────────────────────────────────────────

/**
 * Save outcome → Mark DNC → Mute → Hang up, in that order in every state: the station's own
 * order, so nothing the agent reaches for changes sides when an inbound call takes the screen.
 */
function InboundActionBar({ ib, call, clock }: { ib: InboundCallState; call: AgencyInboundCall; clock: ServerClock }) {
  const number = call.from_e164 ? formatDialNumber(call.from_e164) : '';
  const dncScope = call.match ? `for ${call.match.campaign_name}` : 'from this account';
  const hangupReason = ib.hangupEnabled
    ? null
    : ib.phase === 'offered'
      ? INBOUND_HANGUP_CONNECTING_COPY
      : INBOUND_HANGUP_ENDED_COPY;
  const dncTitle = call.from_e164 === null ? INBOUND_DNC_WITHHELD_COPY : undefined;

  return (
    <div className={sp.actionBar} data-testid="inbound-action-bar">
      <span className={sp.spacer} />

      <SaveControl ib={ib} clock={clock} />

      <button
        type="button"
        className={`${station.mute} ${sp.dncButton}`}
        onClick={ib.openDnc}
        disabled={!ib.dncEnabled || ib.dncInFlight || ib.dncOutcome !== null}
        title={dncTitle}
        aria-keyshortcuts="d"
        data-testid="inbound-dnc"
      >
        {ib.dncInFlight ? 'Adding to Do Not Call…' : ib.dncOutcome ? 'On Do Not Call' : 'Mark DNC'}
        <span className={sp.kbd} aria-hidden="true" style={{ marginLeft: 8 }}>
          D
        </span>
      </button>

      <button
        type="button"
        className={`${station.mute} ${sp.muteButton}`}
        onClick={ib.toggleMute}
        disabled={!ib.muteEnabled}
        aria-pressed={ib.muted}
        aria-keyshortcuts="m"
        data-testid="inbound-mute"
      >
        {ib.muted ? 'Unmute' : 'Mute'}
        <span className={sp.kbd} aria-hidden="true" style={{ marginLeft: 8 }}>
          M
        </span>
      </button>

      <div className={sp.hangupSlot}>
        <HoldToConfirmButton
          attemptId={ib.hangupEnabled ? call.id : null}
          enabled={ib.hangupEnabled}
          disabledReason={hangupReason}
          reserveReasonLine
          onConfirm={ib.hangup}
          copy={INBOUND_HANGUP_COPY}
        />
      </div>

      {ib.hangupFailure ? (
        <p className={sp.actionFailure} role="alert" data-testid="inbound-hangup-failure">
          {ib.hangupFailure}
        </p>
      ) : null}
      {ib.dncOutcome ? (
        <p className={sp.actionNotice} data-testid="inbound-dnc-outcome">
          {ib.dncOutcome}
        </p>
      ) : null}
      {ib.dncFailure ? (
        <p className={sp.actionFailure} data-testid="inbound-dnc-failure">
          {ib.dncFailure}
        </p>
      ) : null}

      <ConfirmDialog
        open={ib.dncConfirmOpen}
        title="Add this number to Do Not Call?"
        message={`${number} won’t be called again ${dncScope}. Do this when the customer asks not to be called.`}
        confirmLabel={ib.dncInFlight ? 'Adding…' : 'Add to Do Not Call'}
        danger
        disabled={ib.dncInFlight}
        onConfirm={ib.confirmDnc}
        onCancel={ib.cancelDnc}
      />
    </div>
  );
}

/** Save, and why it is disabled. Repaints while a callback is picked: its time can slide into the past. */
function SaveControl({ ib, clock }: { ib: InboundCallState; clock: ServerClock }) {
  const selected = findDisposition(ib.catalog, ib.form.selectedCode);
  useRepaintTick(Boolean(selected?.requires_datetime));
  const block = ib.saveBlockAt(clock.now());
  const disabled = block !== null || ib.saving;
  return (
    <>
      {block ? (
        <span id="inbound-save-reason" className={sp.actionStatus} data-testid="inbound-save-reason">
          {INBOUND_SAVE_BLOCK_COPY[block]}
        </span>
      ) : null}
      <button
        type="button"
        className={station.save}
        onClick={ib.saveOutcome}
        disabled={disabled}
        aria-describedby={block ? 'inbound-save-reason' : undefined}
        aria-keyshortcuts="Enter"
        data-testid="inbound-save"
      >
        {ib.saving ? 'Saving…' : 'Save outcome'}
        <span className={station.shortcut} aria-hidden="true">
          Enter
        </span>
      </button>
    </>
  );
}
