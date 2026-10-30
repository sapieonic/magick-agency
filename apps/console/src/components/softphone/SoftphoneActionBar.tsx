import { ConfirmDialog } from '@magick-agency/web-ui/components/ConfirmDialog';
import { HoldToConfirmButton, HANGUP_COPY, type HoldToConfirmCopy } from '../agency/HoldToConfirmButton';
import { useRepaintTick } from '../../hooks/useRepaintTick';
import { isCallLive } from '../../utils/softphone/callState';
import { formatDialNumber } from '../../utils/softphone/phoneInput';
import { findDisposition } from '../../utils/agencyDispositionForm';
import { SAVE_BLOCK_COPY, type SoftphoneState } from '../../hooks/useSoftphone';
import type { ServerClock } from '../../hooks/useServerClock';
import station from '../agency/AgentStation.module.css';
import styles from './SoftphoneView.module.css';

/** The station's gesture, unchanged — only the soft phone's id prefix, so two buttons never share a hint id. */
export const SOFTPHONE_HANGUP_COPY: HoldToConfirmCopy = {
  ...HANGUP_COPY,
  idPrefix: 'softphone-hangup',
  labels: { ...HANGUP_COPY.labels, idle: 'Hold to hang up', failed: 'Hold to hang up' },
};

/**
 * The soft phone's action bar: Mute → Mark DNC → Save outcome → Hang up, in that
 * order in every state.
 *
 * The station's rule 3: every control renders in every state and is disabled
 * with a stated reason when there is nothing to act on, so the tab order and the
 * positions never change between Ready, Ringing, On call and Outcome needed. Hang
 * up is the station's hold-to-confirm gesture (500 ms, or `E` twice) — on a
 * ringing call that matters more, not less (SP3).
 */
export function SoftphoneActionBar({ sp, clock }: { sp: SoftphoneState; clock: ServerClock }) {
  const call = sp.call;
  const live = isCallLive(call);
  const number = call ? formatDialNumber(call.destination_e164) : '';
  const dncScope = call?.tag ? `for ${call.tag.campaign_name}` : 'for the whole workspace';

  return (
    <div className={styles.actionBar} data-testid="softphone-action-bar">
      <button
        type="button"
        className={station.mute}
        onClick={sp.toggleMute}
        disabled={!sp.muteEnabled}
        aria-pressed={sp.muted}
        aria-keyshortcuts="m"
        data-testid="softphone-mute"
      >
        {sp.muted ? 'Unmute' : 'Mute'}
        <span className={styles.kbd} aria-hidden="true" style={{ marginLeft: 8 }}>
          M
        </span>
      </button>

      <button
        type="button"
        className={station.mute}
        onClick={sp.openDnc}
        disabled={!sp.dncEnabled || sp.dncInFlight || sp.dncOutcome !== null}
        data-testid="softphone-dnc"
      >
        {sp.dncInFlight ? 'Adding to Do Not Call…' : sp.dncOutcome ? 'On Do Not Call' : 'Mark DNC'}
      </button>

      <span className={styles.spacer} />

      <SaveControl sp={sp} clock={clock} />

      <div className={styles.hangupSlot}>
        <HoldToConfirmButton
          attemptId={live ? call!.id : null}
          enabled={live}
          disabledReason={live ? null : 'No call in progress'}
          onConfirm={sp.hangup}
          copy={SOFTPHONE_HANGUP_COPY}
        />
      </div>

      {sp.hangupFailure ? (
        <p className={styles.actionFailure} role="alert" data-testid="softphone-hangup-failure">
          {sp.hangupFailure}
        </p>
      ) : null}
      {sp.dncOutcome ? (
        <p className={styles.actionNotice} data-testid="softphone-dnc-outcome">
          {sp.dncOutcome}
        </p>
      ) : null}
      {sp.dncFailure ? (
        <p className={styles.actionFailure} data-testid="softphone-dnc-failure">
          {sp.dncFailure}
        </p>
      ) : null}

      <ConfirmDialog
        open={sp.dncConfirmOpen}
        title="Add this number to Do Not Call?"
        message={`${number} won’t be called again ${dncScope}. Do this when the customer asks not to be called.`}
        confirmLabel={sp.dncInFlight ? 'Adding…' : 'Add to Do Not Call'}
        danger
        disabled={sp.dncInFlight}
        onConfirm={sp.confirmDnc}
        onCancel={sp.cancelDnc}
      />
    </div>
  );
}

/**
 * Save, and the reason it is disabled. Repaints itself while a callback code is
 * selected, because a picked time can slide into the past with nobody touching
 * anything — the station's `SaveDispositionControl`, for the same reason.
 */
function SaveControl({ sp, clock }: { sp: SoftphoneState; clock: ServerClock }) {
  const selected = findDisposition(sp.catalog, sp.form.selectedCode);
  useRepaintTick(Boolean(selected?.requires_datetime));
  const block = sp.call ? sp.saveBlockAt(clock.now()) : null;
  const disabled = !sp.call || block !== null || sp.saving;
  return (
    <>
      {sp.call && block ? (
        <span id="softphone-save-reason" className={styles.actionStatus} data-testid="softphone-save-reason">
          {SAVE_BLOCK_COPY[block]}
        </span>
      ) : null}
      <button
        type="button"
        className={station.save}
        onClick={sp.saveOutcome}
        disabled={disabled}
        aria-describedby={sp.call && block ? 'softphone-save-reason' : undefined}
        aria-keyshortcuts="Enter"
        data-testid="softphone-save"
      >
        {sp.saving ? 'Saving…' : 'Save outcome'}
        <span className={station.shortcut} aria-hidden="true">
          Enter
        </span>
      </button>
    </>
  );
}
