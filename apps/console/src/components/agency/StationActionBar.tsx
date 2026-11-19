import type { RefObject } from 'react';
import { LifeBuoy, Phone } from 'lucide-react';
import { SOFTPHONE_BREAK_REASON } from '../../types/softphone';
import { BreakMenu, type BreakMenuHandle } from './BreakMenu';
import { QueuedBreakPill } from './QueuedBreakPill';
import { CustomerWaitingPill } from './inbound/CustomerWaitingPill';
import { DncControl, type DncControlHandle } from './DncControl';
import { HoldToConfirmButton } from './HoldToConfirmButton';
import { useRepaintTick } from '../../hooks/useRepaintTick';
import { DISPOSITION_BLOCK_COPY } from '../../utils/agencyDispositionForm';
import type { DncScope } from '../../utils/agencyDncCopy';
import type { AgencyConsoleState } from '../../pages/agency/useAgencyConsole';
import type { StationHelp } from '../../pages/agency/station/useStationHelp';
import { STATION_HELP_COPY } from '../../utils/agency/stationHelp';
import styles from './AgentStation.module.css';

/**
 * Save, and the reason it is disabled — the one leaf that repaints for a block
 * reason that changes with time alone.
 *
 * A picked callback time can slide into the past with nobody touching anything,
 * and Save has to disable when it does. This control ticks for that itself, and
 * only while `blockChangesWithTime` (a datetime code is selected); the console
 * root does not, so it is not re-rendered four times a second meanwhile. The
 * shortcut and `submit` re-check at fire time with `clock.now()`.
 */
function SaveDispositionControl({ cons }: { cons: AgencyConsoleState }) {
  useRepaintTick(cons.blockChangesWithTime);
  const block = cons.blockAt(cons.clock.now());
  return (
    <>
      <button
        type="button"
        className={styles.save}
        onClick={cons.submit}
        disabled={!cons.padEnabled || block !== null || cons.submitting}
        aria-describedby={block ? 'submit-block-reason' : undefined}
      >
        {cons.submitting ? 'Saving…' : 'Save disposition'}
        <span className={styles.shortcut} aria-hidden="true">
          Ctrl ↵
        </span>
      </button>

      {/*
        the reason is rendered **next to the submit control**, never as a
        toast — "an agent must not return to `available` believing a disposition
        saved when it did not". Only once the pad is live: before that the pad
        carries its own "available when connected", and two stated reasons for one
        disabled control is noise.
      */}
      {cons.padEnabled && block ? (
        <span id="submit-block-reason" className={styles.blockReason}>
          {DISPOSITION_BLOCK_COPY[block]}
        </span>
      ) : null}
    </>
  );
}

/**
 * The action bar: the things that act on the call in front of the agent.
 *
 * Its order is a tab-order guarantee and part of the geometry rule —
 * Break → Save → … → Hang up — so nothing that does not act on the call is ever
 * inserted here (cue settings and the way out live in the header for that
 * reason).
 */
export function StationActionBar({
  cons,
  breakMenuRef,
  dncRef,
  mayMarkDnc,
  mayMarkDncTenantWide,
  dnc,
  onHangup,
  hangupFailure,
  softphoneAvailable = false,
  help,
}: {
  cons: AgencyConsoleState;
  /**
   * `agency_softphone_enabled` is on and the caller holds `agency.softphone.dial`:
   * offer **Switch to soft phone** (SP7) beside Break and as the break menu's last
   * entry. Optional so every existing caller and test is unaffected.
   */
  softphoneAvailable?: boolean;
  breakMenuRef: RefObject<BreakMenuHandle | null>;
  dncRef: RefObject<DncControlHandle | null>;
  mayMarkDnc: boolean;
  mayMarkDncTenantWide: boolean;
  dnc: {
    inFlight: boolean;
    outcome: string | null;
    failure: string | null;
    confirm: (scope: DncScope, origin: 'shortcut' | 'click') => void;
  };
  onHangup: () => void;
  hangupFailure: string | null;
  /**
   * Need help (`useStationHelp`, LF4, LF24). Shown only while `agency_floor_assist_enabled` is on
   * (`help.offered`); optional so every existing caller and test is unaffected.
   */
  help?: StationHelp;
}) {
  // Tab order within the bar is fixed: Break → (Soft phone) → Save → Hang up.
  const menuReasons = softphoneAvailable
    ? [...cons.breakReasons, { code: SOFTPHONE_BREAK_REASON, label: 'Switch to soft phone' }]
    : cons.breakReasons;
  return (
    <div className={styles.actionBar}>
      <BreakMenu
        handleRef={breakMenuRef}
        reasons={menuReasons}
        queuedReasonLabel={cons.pendingBreakLabel}
        busy={cons.breakBusy}
        rejection={cons.breakRejection}
        onSelect={(code) => (code === SOFTPHONE_BREAK_REASON ? cons.requestSoftphone() : cons.requestBreak(code))}
      />

      {/*
        Switch to soft phone (SP7). A presence action like Break, so it sits beside
        Break and never between Save and Hang up. While a switch is queued it stays
        where it is — the station disables, it never removes, so nothing after it
        moves — reading "Switching after this call", and the pill below carries the
        ✕. `aria-disabled`, never `disabled`, for the focus reason `BreakMenu` gives.
      */}
      {softphoneAvailable ? (
        <button
          type="button"
          className={styles.mute}
          aria-disabled={cons.breakBusy || cons.pendingSoftphone || undefined}
          onClick={() => {
            if (!cons.breakBusy && !cons.pendingSoftphone) cons.requestSoftphone();
          }}
          data-testid="switch-to-softphone"
        >
          <Phone size={15} aria-hidden="true" style={{ marginRight: 6 }} />
          {cons.pendingSoftphone ? 'Switching after this call' : 'Switch to soft phone'}
        </button>
      ) : null}

      {cons.pendingBreakLabel ? (
        <QueuedBreakPill
          reasonLabel={cons.pendingBreakLabel}
          cancelling={cons.cancelling}
          cancelFailed={cons.cancelFailed}
          onCancel={cons.cancelBreak}
          softphone={cons.pendingSoftphone}
        />
      ) : null}

      {/* A caller sticky to this agent waits for them (P2): the same slot's rules. */}
      {cons.station.customerWaiting ? <CustomerWaitingPill waiting={cons.station.customerWaiting} /> : null}

      {softphoneAvailable && cons.softphoneRejection ? (
        <span className={styles.breakAlreadyStarted} role="status" data-testid="switch-to-softphone-refused">
          {cons.softphoneRejection}
        </span>
      ) : null}

      {/* Not an error: the queued break was promoted to a real one, which is the
          ordinary outcome of pressing ✕ at the end of wrap-up. No danger
          styling, and the recovery is `End break` in the rail. */}
      {cons.breakAlreadyStarted ? (
        <span className={styles.breakAlreadyStarted}>Your break already started.</span>
      ) : null}

      <SaveDispositionControl cons={cons} />

      {/*
        Mark DNC sits before the hang-up in tab order: the sequence that
        actually happens is "take me off your list" *then* the call ends, and
        an agent tabbing forward should meet them in that order.
      */}
      <DncControl
        handleRef={dncRef}
        attemptId={cons.station.live?.attempt.attempt_id ?? null}
        phoneE164={cons.station.live?.attempt.phone_e164 ?? null}
        campaignName={cons.station.live?.attempt.campaign_name ?? null}
        permitted={mayMarkDnc}
        permittedTenantWide={mayMarkDncTenantWide}
        inFlight={dnc.inFlight}
        onConfirm={dnc.confirm}
        failure={dnc.failure}
        outcome={dnc.outcome}
      />

      {/*
        Mute sits between DNC and Hang up, which keeps's stated
        sequence (Break → Save → … → Hang up) intact while putting it beside
        the other control that acts on the live call.

        `aria-pressed` carries the state and the label carries the *action*.
        A label that flips to "Muted" would be a state read as a verb — the
        agent presses a button that says "Muted" expecting to become muted.

        Disabled when the uplink is not open, 's rule that inactive
        controls are disabled so they are skipped rather than reordered.
        Keyed off `audio.sending` rather than `live` alone: a call that is up
        while the microphone failed has nothing to mute, and offering the
        control there would suggest the silence is something the agent did.
      */}
      <button
        type="button"
        className={styles.mute}
        onClick={cons.audio.toggleMute}
        disabled={!cons.audio.sending}
        aria-pressed={cons.audio.muted}
        data-testid="mute-toggle"
      >
        {cons.audio.muted ? 'Unmute' : 'Mute'}
      </button>

      {/* Pushed to the far end of the bar (`.hangup`), away from everything else an agent presses. */}
      <div className={styles.hangup}>
        <HoldToConfirmButton
          attemptId={cons.station.live?.attempt.attempt_id ?? null}
          enabled={Boolean(cons.station.live)}
          disabledReason={cons.station.live ? null : 'No call in progress'}
          reserveReasonLine
          onConfirm={onHangup}
        />
      </div>

      {/*
        `role="alert"`, unlike the DNC outcome's polite region: this says the
        agent is still on a call they believe they ended, and it is the one
        message on this screen that must interrupt.
      */}
      {hangupFailure ? (
        <span className={styles.actionFailure} role="alert" data-testid="hangup-failure">
          {hangupFailure}
        </span>
      ) : null}

      {/*
        Need help (LF4, LF24). Last in the bar, in the DOM and in the tab order, after Hang up: it is
        never a Tab stop between Mute and Hang up, and when the bar runs out of room it is Need help
        that wraps, never Hang up. Bound to no shortcut.

        ONE button for the request's life: it raises, and once a request is open the same node
        cancels it (its label says which), so focus stays where the agent pressed. Not offered off a
        call (the server's `help_not_on_call` rule): `aria-disabled`, never `disabled`, so it stays
        focusable and a keyboard agent can read why. Rendered in every call state (controls
        disable, they never appear and vanish), and only while the flag is on, which does not change
        under a shift. What it says (open, answered, lapsed) sits after it, so nothing before it moves.
      */}
      {help?.offered ? (
        <div className={styles.needHelp} data-testid="need-help">
          <button
            type="button"
            className={`${styles.mute} ${styles.needHelpButton}`}
            data-open={help.open ? 'true' : undefined}
            aria-disabled={help.busy || help.blockedReason !== null || undefined}
            aria-describedby={help.blockedReason ? 'need-help-reason' : undefined}
            title={help.blockedReason ?? (help.open ? undefined : STATION_HELP_COPY.raiseHint)}
            onClick={help.press}
            data-testid="need-help-button"
          >
            <LifeBuoy size={15} aria-hidden="true" style={{ marginRight: 6 }} />
            {help.label}
          </button>
          {help.blockedReason ? (
            <span id="need-help-reason" className={styles.srOnly}>{help.blockedReason}</span>
          ) : null}
          {help.status ? (
            <span className={styles.needHelpStatus} data-tone={help.open ? 'open' : 'notice'} data-testid="need-help-status">
              {help.status}
            </span>
          ) : null}
          {help.dismissible ? (
            <button type="button" className={styles.needHelpDismiss} onClick={help.dismiss} data-testid="need-help-dismiss">
              {STATION_HELP_COPY.dismiss}
            </button>
          ) : null}
          {help.refusal ? (
            <span className={styles.needHelpRefusal} data-testid="need-help-refusal">{help.refusal}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
