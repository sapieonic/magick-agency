import { useId } from 'react';
import {
  carrierKey,
  type CarrierChoice,
  type CarrierOption,
} from '../../utils/agencyCarriers';
import styles from './CampaignCarrierField.module.css';

/**
 * "Carrier": which carrier account a campaign dials on, shared by the create wizard and
 * the campaign settings page. The page renders it only when there is a choice to make
 * (more than one option); with one, the campaign simply takes that one.
 *
 * Options are named by alias and, for a tenant's own account, its label
 * (`carrierName`), never by the API's carrier identifier.
 */
export function CampaignCarrierField(props: {
  options: readonly CarrierOption[];
  value: CarrierChoice;
  onChange: (next: CarrierChoice) => void;
  disabled?: boolean;
  /** Said under the select, e.g. why it is locked. */
  notice?: string | null;
  error?: string;
}) {
  const { options, value, onChange, disabled = false, notice = null, error } = props;
  const id = useId();
  const selectId = `${id}-carrier`;
  const current = options.find((o) => o.key === carrierKey(value));
  const describedBy = [`${id}-hint`, notice && `${id}-notice`, error && `${id}-error`]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="form-group">
      <label htmlFor={selectId}>
        Carrier<span className="required-star">*</span>
      </label>
      <select
        id={selectId}
        value={carrierKey(value)}
        disabled={disabled}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
        onChange={(event) => {
          const next = options.find((o) => o.key === event.target.value);
          if (next) {
            onChange({
              telephony_provider: next.telephony_provider,
              telephony_credential_id: next.telephony_credential_id,
            });
          }
        }}
      >
        {options.map((option) => (
          <option key={option.key} value={option.key} disabled={option.unavailable && option.key !== current?.key}>
            {option.name}
          </option>
        ))}
      </select>
      <p id={`${id}-hint`} className={styles.hint}>
        Calls are placed on this carrier account, so only its numbers can be caller IDs.
        Changing it clears the selected numbers that are not on it.
      </p>
      {current?.unavailable && (
        <p className={styles.notice} role="note" data-testid="carrier-unavailable">
          This carrier account is no longer active, so the campaign cannot dial on it. Choose
          another carrier, or ask your administrator to re-enable it.
        </p>
      )}
      {notice && (
        <p id={`${id}-notice`} className={styles.notice} role="note">
          {notice}
        </p>
      )}
      {error && <p id={`${id}-error`} className={styles.fieldError}>{error}</p>}
    </div>
  );
}
