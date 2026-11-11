import { useRef } from 'react';
import {
  MAPPING_BLOCK_COPY,
  ROLE_LABELS,
  addDedupeKey,
  canAddDedupeKey,
  combinationLine,
  countryCodeError,
  dedupeKeyLabel,
  dedupeKeyOptions,
  dedupeKeys,
  heroLimitReached,
  mappingBlockReason,
  phoneColumn,
  phoneUniquenessLine,
  phoneValidityLine,
  removeDedupeKey,
  setDedupe,
  setDedupeKey,
  setDefaultCountryCode,
  setRole,
  timezoneColumn,
  uniquenessLine,
  type ColumnRole,
  type DedupeKey,
  type MappingState,
} from '../../../utils/agencyColumnMapping';
import type { AgencyColumnAnalysis } from '../../../types/agency-campaign';
import styles from './ColumnMapper.module.css';

/**
 * The column mapping screen — *the most important screen in this wizard*.
 *
 * The phone column will not be called `phone`. Everything here exists so an
 * operator can say which one it is, with enough evidence in front of them to be
 * right: the header **and** three real values, because a file with `Mobile`,
 * `Alt Mobile` and `Ref No` cannot be resolved from headers alone.
 *
 * All rules live in `utils/agencyColumnMapping.ts`; this component is assembly.
 */

const ROLES: ColumnRole[] = ['phone', 'timezone', 'hero', 'detail', 'ignore'];

/**
 * The duplicate selects' option values. A column is prefixed so a header that is
 * literally called `phone` or `none` cannot be mistaken for those two choices.
 */
const COLUMN_PREFIX = 'column:';

function keyValue(key: DedupeKey): string {
  return key.kind === 'column' ? `${COLUMN_PREFIX}${key.column}` : 'phone';
}

function keyOf(value: string): DedupeKey {
  return value.startsWith(COLUMN_PREFIX) ? { kind: 'column', column: value.slice(COLUMN_PREFIX.length) } : { kind: 'phone' };
}

const NEVER_TWICE = 'The dialler never calls one number twice at the same time.';

/** Why the choice matters, under the selects: what the sample shows, then what the rule keeps. */
function dedupeNote(analysis: AgencyColumnAnalysis, state: MappingState, phone: string | null): string {
  if (state.dedupe.mode === 'none') {
    return `Rows are kept even when they repeat a number or any other value; only an exact copy of an earlier row (the same number and the same value in every column not set to Ignore) is skipped. ${NEVER_TWICE}`;
  }
  const keys = state.dedupe.keys;
  const onPhone = keys.some((key) => key.kind === 'phone');
  const lead = keys.length > 1
    ? combinationLine(analysis, state)
    : onPhone ? phoneUniquenessLine(analysis, phone) : uniquenessLine(analysis, dedupeKeyLabel(keys[0]!, phone));
  const tail = !onPhone
    ? `Rows that share a phone number are all kept. ${NEVER_TWICE}`
    : keys.length > 1
      ? `Rows on one number are kept when the other columns differ. ${NEVER_TWICE}`
      : 'A row whose number already appeared earlier in the file is dropped. If one person can have several rows (two loans, two policies), check duplicates on that number instead, or combine columns.';
  return [lead, tail].filter(Boolean).join(' ');
}

export interface ColumnMapperProps {
  analysis: AgencyColumnAnalysis;
  state: MappingState;
  onChange: (next: MappingState) => void;
  fileName: string;
  disabled?: boolean;
}

export function ColumnMapper({
  analysis,
  state,
  onChange,
  fileName,
  disabled = false,
}: ColumnMapperProps) {
  const phone = phoneColumn(state);
  const block = mappingBlockReason(state);
  const validity = phoneValidityLine(analysis, phone);
  const heroFull = heroLimitReached(state);
  const countryError = countryCodeError(state.defaultCountryCode);
  const keys = dedupeKeys(state.dedupe);
  const canAddKey = canAddDedupeKey(analysis, state);
  // The options name the phone key "Phone number", not its column.
  const optionLabel = (key: DedupeKey) => dedupeKeyLabel(key, null);
  const renderOptions = (options: DedupeKey[]) => options.map((option) => (
    <option key={keyValue(option)} value={keyValue(option)}>
      {optionLabel(option)}
    </option>
  ));
  const firstSelect = useRef<HTMLSelectElement>(null);
  // A removed key's select leaves the page; focus moves to the first select
  // rather than dropping to the document.
  const removeKey = (index: number) => {
    onChange(removeDedupeKey(state, index));
    firstSelect.current?.focus();
  };
  const removeButton = (key: DedupeKey, index: number) => (
    <button
      type="button"
      className="btn-secondary"
      disabled={disabled}
      aria-label={`Remove ${optionLabel(key)} from the duplicate check`}
      onClick={() => removeKey(index)}
    >
      Remove
    </button>
  );

  return (
    <div className={styles.mapper}>
      <p className={styles.fileLine}>
        <strong>{fileName}</strong> — {analysis.rows_sampled.toLocaleString()}
        {analysis.truncated ? '+' : ''} rows, {analysis.columns.length} columns
      </p>

      {/*
        The server withholds the suggestion when two columns are too close to call.
        Naming them is the whole value: the operator knows which two to look at.
      */}
      {analysis.phone_column_ambiguous ? (
        <p className={styles.ambiguous} role="status" data-testid="phone-ambiguous">
          Two columns look like phone numbers
          {analysis.phone_column_candidates.length > 0
            ? ` (${analysis.phone_column_candidates.join(' and ')})`
            : ''}
          {' '}— pick one.
        </p>
      ) : null}

      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">CSV column</th>
            <th scope="col">Sample</th>
            <th scope="col">Use as</th>
          </tr>
        </thead>
        <tbody>
          {analysis.columns.map((column) => {
            const role = state.roles[column.name] ?? 'detail';
            const heroIndex = state.heroOrder.indexOf(column.name);
            return (
              <tr key={column.name} data-role={role}>
                <th scope="row" className={styles.columnName}>
                  {column.name}
                </th>
                {/* Operator-uploaded file content: rendered as text, always. */}
                <td className={styles.samples}>
                  {column.samples.length > 0 ? column.samples.join(', ') : <em>empty</em>}
                </td>
                <td>
                  <select
                    className={styles.roleSelect}
                    aria-label={`Use ${column.name} as`}
                    value={role}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange(setRole(state, column.name, event.target.value as ColumnRole))
                    }
                  >
                    {ROLES.map((option) => (
                      <option
                        key={option}
                        value={option}
                        // The cap is expressed on the control rather than by
                        // silently ignoring the pick.
                        disabled={option === 'hero' && heroFull && role !== 'hero'}
                      >
                        {option === 'hero' && heroIndex >= 0
                          ? `${ROLE_LABELS[option]} (${heroIndex + 1})`
                          : ROLE_LABELS[option]}
                      </option>
                    ))}
                  </select>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {block ? (
        <p className={styles.block} data-testid="mapping-block">
          {MAPPING_BLOCK_COPY[block]}
        </p>
      ) : null}

      {/* Learned BEFORE the ingest, not after. */}
      {validity ? (
        <p className={styles.validity} data-testid="phone-validity">
          {validity}
        </p>
      ) : null}

      {/*
        The country a bare number belongs to, and the reason it is a control
        rather than a constant: the server normalises every number that carries no
        `+` by prepending a default country code, and that default is an env var
        on the server — `91` unless set. Nothing surfaced it, so a US roster
        imported as "100% accepted" and then dialed India, and the first place an
        operator could have learned that was the carrier bill.

        Left blank it sends nothing, which is exactly what the wizard did before
        this existed. It is deliberately NOT pre-filled with `91`: only the
        server knows what its default is, and asserting one here would be a
        behaviour change dressed as a default.
      */}
      <div className={`form-group ${styles.countryCode}`}>
        <label htmlFor="ingest-country-code">Country code for numbers without one</label>
        <input
          id="ingest-country-code"
          value={state.defaultCountryCode}
          disabled={disabled}
          inputMode="numeric"
          placeholder="Leave blank for the default (91, India)"
          onChange={(event) => onChange(setDefaultCountryCode(state, event.target.value))}
        />
        {countryError ? (
          <p className="error-text" role="alert" data-testid="country-code-error">
            {countryError}
          </p>
        ) : (
          <p className={styles.countryNote} data-testid="country-code-note">
            {state.defaultCountryCode
              ? `A number written without a country code will be dialled as +${state.defaultCountryCode.replace(/^\+/, '')}…. The percentage above was worked out before you set this, so the real accepted count may differ.`
              : 'Numbers already written with a + keep their own country. Everything else gets the platform default — India (+91) — so set this if your list is not Indian.'}
          </p>
        )}
      </div>

      {/*
        What counts as a duplicate. Phone by default, which is what every upload
        did before this control. A loan book needs the loan number: one borrower
        with two loans is two rows on one number, and both loans must be called.
        Up to three columns combine when no one column is unique on its own.
      */}
      <div className={`form-group ${styles.dedupe}`}>
        <label htmlFor="ingest-dedupe">Check duplicates on</label>
        <div className={styles.dedupeKey}>
        <select
          ref={firstSelect}
          id="ingest-dedupe"
          aria-describedby="ingest-dedupe-note"
          value={keys.length > 0 ? keyValue(keys[0]!) : 'none'}
          disabled={disabled}
          onChange={(event) => {
            const value = event.target.value;
            onChange(value === 'none' ? setDedupe(state, { mode: 'none' }) : setDedupeKey(state, 0, keyOf(value)));
          }}
        >
          {/* The current first key is always listed, so the select can show it. */}
          {renderOptions(dedupeKeyOptions(analysis, state, 0))}
          <option value="none">Don&apos;t remove duplicates</option>
        </select>
        {/* Any key can go while two or more remain; the last one goes by "Don't remove duplicates". */}
        {keys.length > 1 ? removeButton(keys[0]!, 0) : null}
        </div>
        {/*
          Keys 2 and 3: a combination. A row is a duplicate only when every key
          matches, so a loan number repeated across branches is checked together
          with the branch rather than dropping the second branch's loan.
        */}
        {keys.slice(1).map((key, offset) => {
          const index = offset + 1;
          return (
            // Keyed by position, not by value: a changed value must not remount
            // the row, or keyboard focus drops out of the select mid-choice.
            <div key={index} className={styles.dedupeKey}>
              <span className={styles.dedupeAnd} aria-hidden="true">and</span>
              <select
                aria-label={`Duplicate check column ${index + 1}`}
                aria-describedby="ingest-dedupe-note"
                value={keyValue(key)}
                disabled={disabled}
                onChange={(event) => onChange(setDedupeKey(state, index, keyOf(event.target.value)))}
              >
                {renderOptions(dedupeKeyOptions(analysis, state, index))}
              </select>
              {removeButton(key, index)}
            </div>
          );
        })}
        {canAddKey ? (
          <button
            type="button"
            className={`btn-secondary ${styles.dedupeAdd}`}
            disabled={disabled}
            onClick={() => onChange(addDedupeKey(analysis, state))}
          >
            Combine with another column
          </button>
        ) : null}
        <p id="ingest-dedupe-note" className={styles.dedupeNote} data-testid="dedupe-note">
          {dedupeNote(analysis, state, phone)}
        </p>
      </div>

      {/*
        Stated inline next to the timezone role rather than in a help panel:
        this is the moment the operator decides whether to map one.
      */}
      <p className={styles.timezoneNote}>
        {timezoneColumn(state)
          ? 'Contacts with an unreadable timezone fall back to the campaign default.'
          : "Numbers alone can't tell us a timezone, so unmapped contacts use the campaign default."}
      </p>

      <p className={styles.ignoreNote}>
        Anything set to <strong>Ignore</strong> is left out of the contact record entirely — use it
        for internal scores and anything an agent should not read to a customer.
      </p>
    </div>
  );
}
