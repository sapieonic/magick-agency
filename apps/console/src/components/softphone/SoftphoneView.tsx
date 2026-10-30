import { useEffect, useRef } from 'react';
import { SoftphoneRail } from './SoftphoneRail';
import { DialPad } from './DialPad';
import { CallDetailsColumn } from './CallDetailsColumn';
import { OutcomeColumn } from './OutcomeColumn';
import { SoftphoneActionBar } from './SoftphoneActionBar';
import { OverrideDialog } from './OverrideDialog';
import { useSoftphoneShortcuts } from './useSoftphoneShortcuts';
import { contactName } from '../../utils/softphone/callState';
import type { DispositionPadHandle } from '../agency/DispositionPad';
import type { SoftphoneState } from '../../hooks/useSoftphone';
import type { ServerClock } from '../../hooks/useServerClock';
import type { StationConnection } from '../../hooks/agencyStation/types';
import station from '../agency/AgentStation.module.css';

/**
 * The soft phone: rail, three columns, action bar — the station's frozen
 * geometry (`docs/softphone.md` §7) — rendered inside a host's shell and below
 * the host's header.
 *
 * Two hosts mount it: `/dialer/phone` (a soft-phone session) and the campaign
 * station once its `agent_state` reports `break/soft_phone` (SP7). Both hand it
 * the same `useSoftphone` state; the socket, the microphone and the header are
 * theirs.
 *
 * ── Focus ────────────────────────────────────────────────────────────────────
 * Pressing Call replaces the dial pad with the call, so the button that had
 * focus is gone: focus moves once per call to the body (as the station's does on
 * a reservation), never on later frames of the same call, and back to the
 * number field when the call settles, ready for the next one.
 */
export function SoftphoneView({
  sp,
  connection,
  clock,
  fromCampaign,
  onReconnect,
  shortcutsEnabled = true,
}: {
  sp: SoftphoneState;
  connection: StationConnection;
  clock: ServerClock;
  /** A campaign session switched to the soft phone (SP7). */
  fromCampaign: boolean;
  onReconnect?: () => void;
  shortcutsEnabled?: boolean;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const numberInputRef = useRef<HTMLInputElement>(null);
  const callButtonRef = useRef<HTMLButtonElement>(null);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const padRef = useRef<DispositionPadHandle | null>(null);

  useSoftphoneShortcuts(sp, clock, { numberInputRef, notesRef, padRef, enabled: shortcutsEnabled });

  const callId = sp.call?.id ?? null;
  const previousCallId = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousCallId.current;
    previousCallId.current = callId;
    if (callId !== null && previous !== callId) bodyRef.current?.focus();
    if (callId === null && previous !== null) numberInputRef.current?.focus();
  }, [callId]);

  useEffect(() => {
    if (sp.focusCallToken > 0) callButtonRef.current?.focus();
  }, [sp.focusCallToken]);

  const name = contactName(sp.call, sp.campaign?.context_display);

  return (
    <>
      <SoftphoneRail
        connection={connection}
        call={sp.call}
        lastCall={sp.lastCall}
        fromCampaign={fromCampaign}
        contactName={name}
        clock={clock}
        onReconnect={onReconnect}
      />

      {sp.bootstrapError && !sp.bootstrap ? (
        <p className={station.presenceRefusal} role="alert" data-testid="softphone-bootstrap-error">
          We couldn’t load the soft phone: {sp.bootstrapError}{' '}
          <button type="button" className="btn-secondary" onClick={sp.reloadBootstrap}>
            Try again
          </button>
        </p>
      ) : null}

      {/* The assertive region: the direct result of a button the agent just pressed. */}
      <div className={station.srOnly} role="alert" aria-live="assertive">
        {sp.announcement}
      </div>

      <div className={station.body} ref={bodyRef} tabIndex={-1} data-testid="softphone-body" data-phase={sp.phase}>
        <section className={station.colContact} aria-label="Dial">
          <DialPad sp={sp} clock={clock} numberInputRef={numberInputRef} callButtonRef={callButtonRef} />
        </section>
        <section className={station.colDetail} aria-label="Call details">
          <CallDetailsColumn sp={sp} />
        </section>
        <section className={station.colOutcome} aria-label={sp.phase === 'ready' ? 'Recent calls' : 'Outcome'}>
          <OutcomeColumn sp={sp} clock={clock} padRef={padRef} notesRef={notesRef} />
        </section>
      </div>

      <SoftphoneActionBar sp={sp} clock={clock} />

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
