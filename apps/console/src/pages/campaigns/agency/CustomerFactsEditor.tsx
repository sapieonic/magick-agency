import { Fragment, useId } from 'react';
import {
  AGENCY_CONTEXT_FIELD_TYPES,
  AGENCY_CONTEXT_ROLES,
  type AgencyContextFieldType,
  type AgencyContextRole,
} from '@magick-agency/contracts/agency';
import {
  CONTEXT_ROLE_LABELS,
  CONTEXT_TYPE_LABELS,
  roleField,
  roleFixedType,
  typeField,
  withColumnType,
  type FactsForm,
} from '../../../utils/agency/stationSettings';
import type { ConfigFieldErrors } from './configFieldErrors';
import styles from './StationSettings.module.css';

const ROLE_HINTS: Readonly<Record<AgencyContextRole, string>> = {
  name: 'Shown as the customer’s name, and used for {name} in the script.',
  place: 'Shown under the name, and used for {place}.',
  amount_due: 'Read as money (₹), and used for {amount_due}.',
  due_date: 'Read as a date, and used for {due_date}.',
};

/**
 * Campaign Settings › What agents see › Customer facts (agent station BE-6): which column of the
 * customer list plays each role (name, place, amount due, due date), and how each column is read
 * (text, money or date), so the station shows `₹1,25,000` and `20 Nov` rather than the file's
 * text. The server parses the values; this only says which column is which.
 *
 * The columns are the customer list's (`useCampaignColumns`); a column hidden from agents is never
 * offered a role (the server refuses one). With no list imported yet there is nothing to choose
 * from, and it says so. A column given the amount due or the due date is read as money or a date
 * whatever its type says (the contract's rule), so its type is shown fixed. Errors come keyed as the
 * server keys them (`context_display.roles.<role>`, `context_display.types.<column>`).
 */
export function CustomerFactsEditor({
  value,
  onChange,
  columns,
  hidden,
  loading,
  errors,
  readOnly = false,
}: {
  value: FactsForm;
  onChange: (next: FactsForm) => void;
  /** The customer list's columns, hidden ones included. */
  columns: readonly string[];
  /** The columns hidden from agents (`context_display.hidden`). */
  hidden: readonly string[];
  loading: boolean;
  errors: ConfigFieldErrors;
  readOnly?: boolean;
}) {
  const id = useId();
  const hiddenSet = new Set(hidden.map((c) => c.trim().toLowerCase()));
  const shown = columns.filter((c) => !hiddenSet.has(c.trim().toLowerCase()));
  const fixedTypeOf = (column: string): { role: AgencyContextRole; type: AgencyContextFieldType } | null => {
    for (const role of AGENCY_CONTEXT_ROLES) {
      const fixed = roleFixedType(role);
      if (fixed && value.roles[role].trim().toLowerCase() === column.trim().toLowerCase()) return { role, type: fixed };
    }
    return null;
  };

  if (shown.length === 0) {
    return (
      <div className={styles.stack} data-testid="customer-facts">
        <h3 className={styles.subhead}>Customer facts</h3>
        <p className={styles.hint} data-testid="customer-facts-empty">
          {loading
            ? 'Reading the columns of this campaign’s customer list…'
            : 'Upload a customer list to this campaign first. Then choose here which column is the customer’s name, place, amount due and due date.'}
        </p>
        {AGENCY_CONTEXT_ROLES.map((role) => <Fragment key={role}>{errors.render(roleField(role))}</Fragment>)}
      </div>
    );
  }

  return (
    <div className={styles.stack} data-testid="customer-facts">
      <h3 className={styles.subhead}>Customer facts</h3>
      <p className={styles.hint}>
        Which column of the customer list agents see as each fact. With none chosen, the name and place are guessed from the column names.
      </p>
      <div className={styles.roleGrid}>
        {AGENCY_CONTEXT_ROLES.map((role) => {
          const selectId = `${id}-role-${role}`;
          const field = roleField(role);
          const current = value.roles[role];
          // A column set before that the list no longer offers stays chosen, said as such.
          const missing = current !== '' && !shown.some((c) => c === current);
          return (
            <div key={role} className="form-group">
              <label htmlFor={selectId}>{CONTEXT_ROLE_LABELS[role]}</label>
              <select
                id={selectId}
                value={current}
                disabled={readOnly}
                onChange={(event) => onChange({ ...value, roles: { ...value.roles, [role]: event.target.value } })}
                aria-invalid={errors.message(field) ? true : undefined}
                aria-describedby={[`${selectId}-hint`, errors.describedBy(field)].filter(Boolean).join(' ')}
                data-testid={`fact-role-${role}`}
              >
                <option value="">Not set</option>
                {missing ? <option value={current}>{`${current} (not in the list)`}</option> : null}
                {shown.map((column) => (
                  <option key={column} value={column}>{column}</option>
                ))}
              </select>
              <p id={`${selectId}-hint`} className={styles.hint}>{ROLE_HINTS[role]}</p>
              {errors.render(field)}
            </div>
          );
        })}
      </div>

      <h4 className={styles.minorHead} id={`${id}-types`}>How each column is read</h4>
      <ul className={styles.typeRows} aria-labelledby={`${id}-types`}>
        {shown.map((column) => {
          const selectId = `${id}-type-${column.replace(/[^A-Za-z0-9_-]/g, '-')}`;
          const field = typeField(column);
          const fixed = fixedTypeOf(column);
          const type = fixed?.type ?? value.types[column] ?? 'text';
          return (
            <li key={column} className={styles.typeRow}>
              <label htmlFor={selectId} className={styles.typeColumn}>{column}</label>
              <select
                id={selectId}
                value={type}
                disabled={readOnly || fixed !== null}
                onChange={(event) => onChange(withColumnType(value, column, event.target.value as AgencyContextFieldType))}
                aria-invalid={errors.message(field) ? true : undefined}
                aria-describedby={errors.describedBy(field)}
                data-testid={`fact-type-${column}`}
              >
                {AGENCY_CONTEXT_FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>{CONTEXT_TYPE_LABELS[t]}</option>
                ))}
              </select>
              {fixed ? (
                <span className={styles.typeNote}>{`It is the ${CONTEXT_ROLE_LABELS[fixed.role].toLowerCase()}`}</span>
              ) : null}
              <span className={styles.typeError}>{errors.render(field)}</span>
            </li>
          );
        })}
      </ul>
      {errors.render('context_display.roles')}
      {errors.render('context_display.types')}
      {errors.render('context_display')}
    </div>
  );
}
