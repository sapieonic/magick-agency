import type { RefObject } from 'react';
import { BreakMenu, type BreakMenuHandle } from './BreakMenu';
import { QueuedBreakPill } from './QueuedBreakPill';
import { DncControl, type DncControlHandle } from './DncControl';
import { HoldToConfirmButton } from './HoldToConfirmButton';
import { useRepaintTick } from '../../hooks/useRepaintTick';
import { DISPOSITION_BLOCK_COPY } from '../../utils/agencyDispositionForm';
import type { DncScope } from '../../utils/agencyDncCopy';
import type { AgencyConsoleState } from '../../pages/agency/useAgencyConsole';
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
}: {
  cons: AgencyConsoleState;
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
}) {
  // Tab order within the bar is fixed: Break → Save → Hang up.
  return (
    <div className={styles.actionBar}>
      <BreakMenu
        handleRef={breakMenuRef}
        reasons={cons.breakReasons}
        queuedReasonLabel={cons.pendingBreakLabel}
        busy={cons.breakBusy}
        rejection={cons.breakRejection}
        onSelect={cons.requestBreak}
      />

      {cons.pendingBreakLabel ? (
        <QueuedBreakPill
          reasonLabel={cons.pendingBreakLabel}
          cancelling={cons.cancelling}
          cancelFailed={cons.cancelFailed}
          onCancel={cons.cancelBreak}
        />
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

      <HoldToConfirmButton
        attemptId={cons.station.live?.attempt.attempt_id ?? null}
        enabled={Boolean(cons.station.live)}
        disabledReason={cons.station.live ? null : 'No call in progress'}
        onConfirm={onHangup}
      />

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
    </div>
  );
}
