import { useId } from 'react';
import { FieldError } from '../../../components/common/FieldError';
import {
  breakLimitError,
  breakReasonsFieldCode,
  breakReasonsIssueCode,
  withBreakIcon,
  withBreakLimit,
  type BreakReasonsForm,
} from '../../../utils/agency/breakLimits';
import { TileIconPicker } from '../../../components/agency/TileIconPicker';
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
 *
 * Each reason also takes its tile picture on the station's Which break? screen (agent station
 * BE-13, `icon`; `TileIconPicker`), or none, when the page passes `icons`. A refusal of one
 * (`break_reasons[<i>].icon`, the index counting what was sent) is shown on its row.
 */
export function BreakLimitsEditor({
  value,
  onChange,
  serverError,
  readOnly = false,
  icons = false,
  fieldErrors,
}: {
  value: BreakReasonsForm;
  onChange: (next: BreakReasonsForm) => void;
  /** The server's `break_reasons` refusal from the last save, if any. */
  serverError?: string | null;
  readOnly?: boolean;
  /** Offer each reason's tile picture (BE-13). */
  icons?: boolean;
  /** The last save's refusals by field, for the pictures' (`break_reasons[<i>].icon`). */
  fieldErrors?: Readonly<Record<string, string>>;
}) {
  const idBase = useId();
  const serverRow = serverError ? breakReasonsIssueCode(serverError, value) : null;
  // A picture's refusal, by the row it is about.
  const iconErrors = new Map<string, string>();
  for (const [field, message] of Object.entries(fieldErrors ?? {})) {
    if (!/^break_reasons\[\d+\]\.icon$/.test(field)) continue;
    const code = breakReasonsFieldCode(field, value);
    if (code !== null) iconErrors.set(code, message);
  }
  return (
    <div className={styles.editor} data-testid="break-limits">
      <h3 className={styles.title} id={`${idBase}-title`}>Break limits</h3>
      <p className={styles.hint}>
        {`How long a break for each reason may last. Agents see the time left; past it, the Live floor flags the break. A reason with no limit is flagged after ${AGENCY_BREAK_DEFAULT_LIMIT_MINUTES} minutes.`}
        {icons ? ' The picture is what agents see on the reason’s button.' : ''}
        {value.builtIn
          ? ` This campaign uses the standard reasons; changing a limit${icons ? ' or a picture' : ''} saves them as its own.`
          : ''}
      </p>
      <ul className={styles.rows} aria-labelledby={`${idBase}-title`}>
        {value.rows.map((row) => {
          const code = row.reason.code;
          const inputId = `${idBase}-${code.replace(/[^A-Za-z0-9_-]/g, '-')}`;
          const errorId = `${inputId}-error`;
          const label = row.reason.label || reservedBreakReasonLabel(code) || code;
          const typed = row.reserved ? null : breakLimitError(row.limit);
          // The live finding first: the server's answer is about what was sent, and may be fixed since.
          const error = typed ?? (serverRow === code ? serverError ?? null : null) ?? iconErrors.get(code) ?? null;
          return (
            <li key={code} className={styles.row} data-testid={`break-limit-row-${code}`}>
              <span className={styles.named}>
                {icons && !row.reserved ? (
                  <TileIconPicker
                    value={(row.reason as { icon?: string }).icon}
                    name={label}
                    disabled={readOnly}
                    onChange={(icon) => onChange(withBreakIcon(value, code, icon))}
                    describedBy={iconErrors.has(code) ? errorId : undefined}
                    testId={`break-icon-${code}`}
                  />
                ) : null}
                <label className={styles.reason} htmlFor={row.reserved ? undefined : inputId}>
                  {label}
                </label>
              </span>
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
