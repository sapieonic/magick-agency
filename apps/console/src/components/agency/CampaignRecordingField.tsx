import { useId } from 'react';
import { recordingGate } from '../../utils/agencyCampaignRecording';
import styles from './CampaignRecordingField.module.css';

/**
 * "Record every call on this campaign": the one recording control, shared by the
 * create wizard and the campaign settings page.
 *
 * `capabilityEnabled` is the account's `agency.recording` (`allow_recording`). The
 * box locks only in the off→on direction the API refuses, so a campaign whose
 * account lost the capability can still be switched off (see
 * `utils/agencyCampaignRecording.ts`).
 */
export function CampaignRecordingField(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  capabilityEnabled: boolean;
  /** No edit permission: locked in both directions. */
  readOnly?: boolean;
  error?: string;
}) {
  const { checked, onChange, capabilityEnabled, readOnly = false, error } = props;
  const gate = recordingGate({ enabled: capabilityEnabled, current: checked });
  const locked = readOnly || (!gate.canEnable && !checked);
  const id = useId();
  // Read out with the box, so a screen reader hears why it is locked or refused.
  const describedBy = [`${id}-hint`, gate.notice && `${id}-notice`, error && `${id}-error`]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="form-group">
      <label className={styles.flag}>
        <input
          type="checkbox"
          checked={checked}
          disabled={locked}
          aria-describedby={describedBy}
          aria-invalid={error ? true : undefined}
          onChange={(event) => onChange(event.target.checked)}
        />
        Record every call on this campaign
      </label>
      <p id={`${id}-hint`} className={styles.hint}>
        {checked
          ? 'Agents and the people they reach are both on the recording. Make sure your ' +
            'agents announce it, and that you are entitled to record in every region this ' +
            'campaign dials.'
          : 'Off by default. A campaign call is human-to-human, so recording one is ' +
            'consent-sensitive in a way an AI call is not.'}
      </p>
      {gate.notice && (
        <p id={`${id}-notice`} className={styles.gateNotice} role="note">
          {gate.notice}
        </p>
      )}
      {error && <p id={`${id}-error`} className={styles.fieldError}>{error}</p>}
    </div>
  );
}
