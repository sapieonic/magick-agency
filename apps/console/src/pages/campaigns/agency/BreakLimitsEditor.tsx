import { useId } from 'react';
import { FieldError } from '../../../components/common/FieldError';
import {
  breakLimitError,
  breakReasonsIssueCode,
  withBreakLimit,
  type BreakReasonsForm,
} from '../../../utils/agency/breakLimits';
import { reservedBreakReasonLabel } from '../../../utils/agency/reservedBreakReason';
import { AGENCY_BREAK_DEFAULT_LIMIT_MINUTES } from '@magick-agency/contracts/agency';
import styles from './BreakLimitsEditor.module.css';

/**
 * Break limits, in campaign Settings › Agents (LF6, LF20, LF27): an optional limit in minutes per
 * break reason. The agent's station counts down to it, and the Live floor flags a break that runs
 * past it; a reason without one falls back to the floor's 30-minute rule.
 *
 * Only the limit is edited here: each reason keeps its code, label and every other field it has
 * (`breakReasonsPayload`). Emptying a limit clears it (the key is left out). A limit is checked as
 * it is typed by the server's own rule (`isAgencyBreakLimitMinutes`, 1–240 whole minutes), and a
 * refusal the server answers anyway (`details.break_reasons`, which names the reason) is shown on
 * that reason's row. A reserved reason (the soft phone's, the app's pauses) is never offered a
 * limit: one listed by hand is shown as such and left out when the list is saved.
 *
 * A campaign that lists no reasons of its own is offered the built-ins (Tea 15, Lunch 30), as its
 * agents are; the list is saved, and becomes the campaign's own, only once a limit is changed.
 */
export function BreakLimitsEditor({
  value,
  onChange,
  serverError,
  readOnly = false,
}: {
  value: BreakReasonsForm;
  onChange: (next: BreakReasonsForm) => void;
  /** The server's `break_reasons` refusal from the last save, if any. */
  serverError?: string | null;
  readOnly?: boolean;
}) {
  const idBase = useId();
  const serverRow = serverError ? breakReasonsIssueCode(serverError, value) : null;
  return (
    <div className={styles.editor} data-testid="break-limits">
      <h3 className={styles.title} id={`${idBase}-title`}>Break limits</h3>
      <p className={styles.hint}>
        {`How long a break for each reason may last. Agents see the time left; past it, the Live floor flags the break. A reason with no limit is flagged after ${AGENCY_BREAK_DEFAULT_LIMIT_MINUTES} minutes.`}
        {value.builtIn ? ' This campaign uses the standard reasons; changing a limit saves them as its own.' : ''}
      </p>
      <ul className={styles.rows} aria-labelledby={`${idBase}-title`}>
        {value.rows.map((row) => {
          const code = row.reason.code;
          const inputId = `${idBase}-${code.replace(/[^A-Za-z0-9_-]/g, '-')}`;
          const errorId = `${inputId}-error`;
          const label = row.reason.label || reservedBreakReasonLabel(code) || code;
          const typed = row.reserved ? null : breakLimitError(row.limit);
          // The live finding first: the server's answer is about what was sent, and may be fixed since.
          const error = typed ?? (serverRow === code ? serverError ?? null : null);
          return (
            <li key={code} className={styles.row} data-testid={`break-limit-row-${code}`}>
              <label className={styles.reason} htmlFor={row.reserved ? undefined : inputId}>
                {label}
              </label>
              {row.reserved ? (
                <span className={styles.reserved}>Reserved for the dialler: no limit, and not offered to agents</span>
              ) : (
                <span className={styles.field}>
                  <input
                    id={inputId}
                    className={styles.input}
                    type="text"
                    inputMode="numeric"
                    autoComplete="off"
                    placeholder="No limit"
                    value={row.limit}
                    disabled={readOnly}
                    onChange={(event) => onChange(withBreakLimit(value, code, event.target.value))}
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errorId : undefined}
                    aria-label={`Limit for ${label}, in minutes`}
                    data-testid={`break-limit-${code}`}
                  />
                  <span className={styles.unit} aria-hidden="true">min</span>
                </span>
              )}
              {/* `announce` only for the server's answer to a save, never for a live finding. */}
              <FieldError id={errorId} message={error} className={`error-text ${styles.error}`} announce={typed === null} />
            </li>
          );
        })}
      </ul>
      {serverError && serverRow === null ? (
        <FieldError id={`${idBase}-list-error`} message={serverError} className="error-text" />
      ) : null}
    </div>
  );
}
