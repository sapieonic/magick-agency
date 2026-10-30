import { useId } from 'react';
import { fieldInputValue, fieldValueFromInput, type CallFieldValue } from '../../utils/softphone/callFields';
import type { AgencyCallField, AgencyCallFieldValues } from '../../types/softphone';
import styles from './SoftphoneView.module.css';

/**
 * The account's call fields, rendered from their declared types.
 *
 * A required field carries a visible marker and `aria-required`; its error is
 * tied to the input with `aria-describedby`, so a screen reader hears why with
 * the field rather than as a stray alert. Required fields may be empty while the
 * call is live — the rule bites when the outcome is saved
 * (`validateCallFieldValues`, `requireFilled`).
 */
export function CallFieldsForm({
  fields,
  values,
  errors,
  disabled,
  loading = false,
  onChange,
}: {
  fields: readonly AgencyCallField[];
  /** The field set is not known yet (the bootstrap is on its way): no fields is not "none". */
  loading?: boolean;
  values: AgencyCallFieldValues;
  errors: Record<string, string>;
  disabled: boolean;
  onChange: (key: string, value: CallFieldValue) => void;
}) {
  const idBase = useId();
  if (fields.length === 0 && loading) {
    return (
      <p className={styles.emptyFields} data-testid="call-fields-loading">
        Loading the call details…
      </p>
    );
  }
  if (fields.length === 0) {
    return (
      <p className={styles.emptyFields} data-testid="call-fields-empty">
        Your account has no call details to fill in. An admin can add them in Settings → Soft phone.
      </p>
    );
  }
  return (
    <div className={styles.fieldsGrid} data-testid="call-fields">
      {fields.map((field) => {
        const id = `${idBase}-${field.key}`;
        const errorId = `${id}-error`;
        const error = errors[field.key] ?? null;
        const value = values[field.key];
        const common = {
          id,
          disabled,
          'aria-invalid': error ? true : undefined,
          'aria-describedby': error ? errorId : undefined,
          'aria-required': field.required ? true : undefined,
          'data-testid': `call-field-${field.key}`,
        } as const;
        const label = (
          <label htmlFor={id}>
            {field.label}
            {field.required ? (
              <span className={styles.required} aria-hidden="true">
                *
              </span>
            ) : null}
          </label>
        );
        let control;
        switch (field.type) {
          case 'choice':
            control = (
              <select
                {...common}
                value={fieldInputValue(value)}
                onChange={(event) => onChange(field.key, fieldValueFromInput(field, event.target.value))}
              >
                <option value="">Choose…</option>
                {(field.options ?? []).map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            );
            break;
          case 'boolean':
            return (
              <div key={field.key} className={`${styles.field} ${styles.fieldFull}`}>
                <span className={styles.fieldLabel} id={`${id}-label`}>
                  {field.label}
                  {field.required ? (
                    <span className={styles.required} aria-hidden="true">
                      *
                    </span>
                  ) : null}
                </span>
                <label className={styles.toggleRow} htmlFor={id}>
                  <input
                    {...common}
                    type="checkbox"
                    role="switch"
                    aria-labelledby={`${id}-label`}
                    checked={value === true}
                    onChange={(event) => onChange(field.key, event.target.checked)}
                  />
                  {value === true ? 'Yes' : 'No'}
                </label>
                {error ? (
                  <p id={errorId} className={styles.fieldError}>
                    {error}
                  </p>
                ) : null}
              </div>
            );
          case 'number':
            control = (
              <input
                {...common}
                type="number"
                step="any"
                inputMode="decimal"
                value={fieldInputValue(value)}
                onChange={(event) => onChange(field.key, fieldValueFromInput(field, event.target.value))}
              />
            );
            break;
          case 'date':
            control = (
              <input
                {...common}
                type="date"
                value={fieldInputValue(value)}
                onChange={(event) => onChange(field.key, fieldValueFromInput(field, event.target.value))}
              />
            );
            break;
          case 'text':
          default:
            control = (
              <input
                {...common}
                type="text"
                value={fieldInputValue(value)}
                onChange={(event) => onChange(field.key, fieldValueFromInput(field, event.target.value))}
              />
            );
        }
        return (
          <div key={field.key} className={styles.field}>
            {label}
            {control}
            {error ? (
              <p id={errorId} className={styles.fieldError}>
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
