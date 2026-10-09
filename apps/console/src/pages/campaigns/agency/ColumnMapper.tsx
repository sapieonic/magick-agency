import {
  MAPPING_BLOCK_COPY,
  ROLE_LABELS,
  countryCodeError,
  heroLimitReached,
  mappingBlockReason,
  phoneColumn,
  phoneValidityLine,
  setDefaultCountryCode,
  setRole,
  timezoneColumn,
  type ColumnRole,
  type MappingState,
} from '../../../utils/agencyColumnMapping';
import type { AgencyColumnAnalysis } from '../../../types/agency-campaign';
import styles from './ColumnMapper.module.css';

/**
 * The column mapping screen (§B.3) — *the most important screen in this wizard*.
 *
 * The phone column will not be called `phone`. Everything here exists so an
 * operator can say which one it is, with enough evidence in front of them to be
 * right: the header **and** three real values, because a file with `Mobile`,
 * `Alt Mobile` and `Ref No` cannot be resolved from headers alone.
 *
 * All rules live in `utils/agencyColumnMapping.ts`; this component is assembly.
 */

const ROLES: ColumnRole[] = ['phone', 'timezone', 'hero', 'detail', 'ignore'];

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

  return (
    <div className={styles.mapper}>
      <p className={styles.fileLine}>
        <strong>{fileName}</strong> — {analysis.rows_sampled.toLocaleString()}
        {analysis.truncated ? '+' : ''} rows, {analysis.columns.length} columns
      </p>

      {/*
        Master withholds the suggestion when two columns are too close to call.
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

      {/* Learned BEFORE the ingest, not after — §B.3. */}
      {validity ? (
        <p className={styles.validity} data-testid="phone-validity">
          {validity}
        </p>
      ) : null}

      {/*
        The country a bare number belongs to, and the reason it is a control
        rather than a constant: master normalises every number that carries no
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
              ? `A number written without a country code will be dialed as +${state.defaultCountryCode.replace(/^\+/, '')}…. The percentage above was worked out before you set this, so the real accepted count may differ.`
              : 'Numbers already written with a + keep their own country. Everything else gets the platform default — India (+91) — so set this if your list is not Indian.'}
          </p>
        )}
      </div>

      {/*
        D4, stated inline next to the timezone role rather than in a help panel:
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
