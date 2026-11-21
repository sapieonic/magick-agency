import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronUp, GripVertical, Plus, Star, X } from 'lucide-react';
import {
  AGENCY_CONTEXT_FIELD_TYPES,
  AGENCY_FACT_FIELDS_MAX,
  AGENCY_FACT_LABEL_MAX_CHARS,
  type AgencyContextFieldType,
  type AgencyFactField,
  type AgencyPhoneDisplay,
} from '@magick-agency/contracts/agency';
import {
  CONTEXT_TYPE_LABELS,
  FACTS_FIELD,
  FACTS_LIMIT_MESSAGE,
  NAME_FIELD,
  NAME_GUESS_COLUMNS,
  PLACE_FIELD,
  PLACE_GUESS_COLUMNS,
  canMoveFact,
  columnNamed,
  columnType,
  factField,
  firstSample,
  guessedColumn,
  labelLength,
  moveFact,
  nameColumnOf,
  newFact,
  placeColumnOf,
  sameColumn,
  sampleText,
  typeField,
  withColumnType,
  withHighlight,
  type FactsForm,
  type SampleRow,
} from '../../../utils/agency/stationSettings';
import type { ConfigFieldErrors } from './configFieldErrors';
import styles from './StationSettings.module.css';

/** Which control of a row takes focus once a change is on screen. */
type FocusTarget = { key: string; part: 'grip' | 'up' | 'down' | 'label' } | { key: null; part: 'add' };

/**
 * Campaign Settings › What agents see › the customer card (AS19): the column that is the
 * customer's name and the one shown under it (`roles.name`, `roles.place`), then up to
 * {@link AGENCY_FACT_FIELDS_MAX} facts in the order the card draws them, each with the name agents
 * see (at most {@link AGENCY_FACT_LABEL_MAX_CHARS} letters), its script key (`{key}`, made from the
 * column's header when it is added and never changed by a rename), and an optional highlight (one
 * at most, always first). Facts move by drag, by the arrows, or by the arrow keys on a focused
 * grip, and each move is said in a live region. Last, how each column is read (six types).
 *
 * The columns are the customer list's (`useCampaignColumns`); a column hidden from agents is never
 * offered. A fact whose column the latest upload does not have is said on its row, with a select
 * to choose another. A saved fact the script still uses that was taken off the card is offered
 * back ("Put it back"); the page holds Save until the script no longer uses it. Errors come keyed
 * as the server keys them (`context_display.roles.<role>`, `context_display.facts.<i>.<part>`,
 * `context_display.types.<column>`), so the server's refusal lands on the field it is about.
 *
 * Column names match as the server matches them, ignoring case. Ids are made from places in the
 * list, never from column names, so two names an id would spell alike never share one.
 */
export function CustomerFactsEditor({
  value,
  onChange,
  columns,
  hidden,
  loading,
  errors,
  samples = [],
  phoneDisplay = 'full',
  removedInUse = [],
  onPutBack,
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
  /** A few customers' rows, for the sample beside each column. */
  samples?: readonly SampleRow[];
  phoneDisplay?: AgencyPhoneDisplay;
  /** Saved facts taken off the card that the script still uses. */
  removedInUse?: readonly AgencyFactField[];
  /** Put a removed saved fact back, by its key. */
  onPutBack?: (key: string) => void;
  readOnly?: boolean;
}) {
  const id = useId();
  const hiddenSet = new Set(hidden.map((c) => c.trim().toLowerCase()));
  const shown = columns.filter((c) => !hiddenSet.has(c.trim().toLowerCase()));
  const list = value.list;
  const full = list.length >= AGENCY_FACT_FIELDS_MAX;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [limitSaid, setLimitSaid] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [typesOpen, setTypesOpen] = useState(false);
  const dragFrom = useRef<number | null>(null);
  const focusAfter = useRef<FocusTarget | null>(null);
  const controls = useRef(new Map<string, HTMLElement>());
  const addButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const pending = focusAfter.current;
    if (!pending) return;
    focusAfter.current = null;
    const target = pending.key === null ? addButton.current : controls.current.get(`${pending.part}:${pending.key}`);
    if (target && !(target as HTMLButtonElement).disabled) target.focus();
    else if (pending.key !== null) controls.current.get(`grip:${pending.key}`)?.focus();
  });

  useEffect(() => {
    if (!full) setLimitSaid(false);
  }, [full]);

  const register = (part: string, key: string) => (node: HTMLElement | null) => {
    if (node) controls.current.set(`${part}:${key}`, node);
    else controls.current.delete(`${part}:${key}`);
  };

  const nameColumn = nameColumnOf(value, shown, hidden);
  const placeColumn = placeColumnOf(value, shown, hidden);
  const usedColumns = [nameColumn, placeColumn, ...list.map((f) => f.column)].filter((c): c is string => Boolean(c));
  const free = shown.filter((c) => !usedColumns.some((u) => sameColumn(u, c)));
  const typeOf = (column: string): AgencyContextFieldType => columnType(value, column);
  const sampleOf = (column: string): string => sampleText(firstSample(samples, column), typeOf(column), phoneDisplay);
  const nameOf = (fact: AgencyFactField): string => fact.label.trim() || fact.column;

  const setList = (next: AgencyFactField[]) => onChange({ ...value, list: next });

  const move = (from: number, to: number, focus: FocusTarget['part']) => {
    const fact = list[from];
    if (!fact) return;
    const next = moveFact(list, from, to);
    const at = next.findIndex((f) => f.key === fact.key);
    if (at === from) return;
    focusAfter.current = { key: fact.key, part: focus } as FocusTarget;
    setAnnouncement(`${nameOf(fact)} moved to position ${at + 1} of ${next.length}.`);
    setList(next);
  };

  const onGripKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    const delta = event.key === 'ArrowUp' ? -1 : 1;
    if (!canMoveFact(list, index, delta)) return;
    move(index, index + delta, 'grip');
  };

  const onDrop = (event: DragEvent<HTMLLIElement>, index: number) => {
    event.preventDefault();
    const from = dragFrom.current;
    dragFrom.current = null;
    if (from === null || from === index) return;
    move(from, index, 'grip');
  };

  const remove = (index: number) => {
    const fact = list[index]!;
    const next = list.filter((_, i) => i !== index);
    const neighbour = next[index] ?? next[index - 1];
    focusAfter.current = neighbour ? { key: neighbour.key, part: 'grip' } : { key: null, part: 'add' };
    setAnnouncement(`${nameOf(fact)} removed from the card.`);
    setList(next);
  };

  const add = (column: string) => {
    const fact = newFact(column, list);
    focusAfter.current = { key: fact.key, part: 'label' };
    setPickerOpen(false);
    setAnnouncement(`${nameOf(fact)} added to the card.`);
    setList([...list, fact]);
  };

  const onAddClick = () => {
    if (full) {
      setLimitSaid(true);
      setPickerOpen(false);
      return;
    }
    setPickerOpen((open) => !open);
  };

  const toggleHighlight = (index: number) => {
    const fact = list[index]!;
    const on = !fact.highlight;
    focusAfter.current = { key: fact.key, part: 'grip' };
    setAnnouncement(on ? `${nameOf(fact)} is highlighted, and shown first.` : `${nameOf(fact)} is no longer highlighted.`);
    setList(withHighlight(list, index, on));
  };

  const columnSelect = (
    selectId: string,
    current: string,
    field: string,
    emptyLabel: string,
    testId: string,
    onPick: (column: string) => void,
    hint: string,
  ) => {
    const listed = current === '' ? undefined : columnNamed(shown, current);
    const missing = current !== '' && listed === undefined;
    return (
      <>
        <select
          id={selectId}
          value={listed ?? current}
          disabled={readOnly}
          onChange={(event) => onPick(event.target.value)}
          aria-invalid={errors.message(field) ? true : undefined}
          aria-describedby={[`${selectId}-hint`, errors.describedBy(field)].filter(Boolean).join(' ')}
          data-testid={testId}
        >
          <option value="">{emptyLabel}</option>
          {missing ? <option value={current}>{`${current} (not in the list)`}</option> : null}
          {shown.map((column) => (
            <option key={column} value={column}>{column}</option>
          ))}
        </select>
        <p id={`${selectId}-hint`} className={styles.hint}>{hint}</p>
        {errors.render(field)}
      </>
    );
  };

  if (shown.length === 0 && list.length === 0) {
    return (
      <div className={styles.stack} data-testid="customer-facts">
        <h3 className={styles.subhead}>The customer card</h3>
        <p className={styles.hint} data-testid="customer-facts-empty">
          {readOnly
            ? 'No customer facts are set for this campaign.'
            : loading
              ? 'Reading the columns of this campaign’s customer list…'
              : 'Upload a customer list to this campaign first. Then choose here which columns agents see on the customer card.'}
        </p>
        {errors.render(NAME_FIELD)}
        {errors.render(PLACE_FIELD)}
        {errors.render(FACTS_FIELD)}
      </div>
    );
  }

  const nameGuess = guessedColumn(shown, NAME_GUESS_COLUMNS, hidden);
  const placeGuess = guessedColumn(shown, PLACE_GUESS_COLUMNS, hidden);
  const typeErrorShown = Object.keys(value.types).some((c) => errors.message(typeField(c)) !== null)
    || shown.some((c) => errors.message(typeField(c)) !== null);

  return (
    <div className={styles.stack} data-testid="customer-facts">
      <h3 className={styles.subhead}>Name and the line under it</h3>
      <div className={styles.roleGrid}>
        <div className="form-group">
          <label htmlFor={`${id}-name`}>Customer’s name</label>
          {columnSelect(
            `${id}-name`,
            value.name,
            NAME_FIELD,
            nameGuess ? `Guess from the column names (${nameGuess})` : 'Guess from the column names',
            'fact-role-name',
            (name) => onChange({ ...value, name }),
            'The heading of the card. {name} in the script.',
          )}
        </div>
        <div className="form-group">
          <label htmlFor={`${id}-place`}>
            Line under the name <span className={styles.optional}>(not required)</span>
          </label>
          {columnSelect(
            `${id}-place`,
            value.place,
            PLACE_FIELD,
            // With nothing chosen the server guesses it from the column names; "None" only when it
            // would find nothing.
            placeGuess ? `Guess from the column names (${placeGuess})` : 'None',
            'fact-role-place',
            (place) => onChange({ ...value, place }),
            'Beside the number. {place} in the script.',
          )}
        </div>
      </div>

      <div className={styles.blockHead}>
        <h3 className={styles.subhead} id={`${id}-facts`}>Facts on the card</h3>
        <span className={styles.count} data-full={full ? '' : undefined} data-testid="facts-count">
          {`${list.length} of ${AGENCY_FACT_FIELDS_MAX} used`}
        </span>
      </div>
      {!readOnly ? (
        <p className={styles.hint} id={`${id}-facts-hint`}>
          Drag to change the order, or use the arrows. With the grip in focus, the up and down arrow keys move the fact.
        </p>
      ) : null}
      {list.length === 0 ? <p className={styles.hint} data-testid="facts-none">No facts on the card yet. Agents see the name and the number only.</p> : null}

      <ol className={styles.factRows} aria-labelledby={`${id}-facts`} data-testid="fact-rows">
        {list.map((fact, index) => {
          const rowId = `${id}-fact-${index}`;
          const labelId = `${rowId}-label`;
          const labelErr = factField(index, 'label');
          const columnErr = factField(index, 'column');
          const keyErr = factField(index, 'key');
          const length = labelLength(fact.label);
          const columnBad = errors.message(columnErr) !== null;
          const type = typeOf(fact.column);
          const raw = firstSample(samples, fact.column);
          const name = nameOf(fact);
          return (
            <li
              key={fact.key}
              className={styles.factRow}
              data-error={errors.message(labelErr) || columnBad ? '' : undefined}
              data-highlight={fact.highlight ? '' : undefined}
              onDragOver={readOnly ? undefined : (event) => event.preventDefault()}
              onDrop={readOnly ? undefined : (event) => onDrop(event, index)}
              data-testid={`fact-row-${index}`}
            >
              {!readOnly ? (
                <button
                  type="button"
                  ref={register('grip', fact.key)}
                  className={styles.grip}
                  draggable={!fact.highlight}
                  onDragStart={(event) => {
                    dragFrom.current = index;
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', fact.key);
                  }}
                  onDragEnd={() => { dragFrom.current = null; }}
                  onKeyDown={(event) => onGripKey(event, index)}
                  aria-label={`Move ${name}. Position ${index + 1} of ${list.length}. Use the arrow keys.`}
                  aria-describedby={`${id}-facts-hint`}
                  aria-disabled={fact.highlight ? true : undefined}
                  title={fact.highlight ? 'The highlighted fact is always first' : 'Drag to move'}
                  data-testid={`fact-grip-${index}`}
                >
                  <GripVertical size={16} aria-hidden="true" />
                </button>
              ) : null}

              <div className={styles.factMain}>
                <div className={styles.factTop}>
                  <div className={styles.labelWrap}>
                    <label htmlFor={labelId} className={styles.srOnly}>{`Name agents see for ${fact.column}`}</label>
                    <input
                      id={labelId}
                      ref={register('label', fact.key)}
                      type="text"
                      className={styles.labelInput}
                      value={fact.label}
                      disabled={readOnly}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setList(list.map((f, i) => (i === index ? { ...f, label: event.target.value } : f)))}
                      aria-invalid={errors.message(labelErr) ? true : undefined}
                      aria-describedby={[`${labelId}-count`, errors.describedBy(labelErr)].filter(Boolean).join(' ')}
                      data-testid={`fact-label-${index}`}
                    />
                    <span
                      id={`${labelId}-count`}
                      className={styles.counter}
                      data-over={length > AGENCY_FACT_LABEL_MAX_CHARS ? '' : undefined}
                      data-testid={`fact-label-count-${index}`}
                    >
                      <span aria-hidden="true">{`${length}/${AGENCY_FACT_LABEL_MAX_CHARS}`}</span>
                      <span className={styles.srOnly}>{`${length} of ${AGENCY_FACT_LABEL_MAX_CHARS} letters`}</span>
                    </span>
                  </div>
                  {!readOnly ? (
                    <div className={styles.factActions}>
                      <button
                        type="button"
                        ref={register('star', fact.key)}
                        className={styles.iconBtn}
                        data-on={fact.highlight ? '' : undefined}
                        aria-pressed={fact.highlight === true}
                        aria-label={`Highlight ${name}`}
                        title={fact.highlight ? 'Highlighted: shown first and wide' : 'Highlight this fact'}
                        onClick={() => toggleHighlight(index)}
                        data-testid={`fact-highlight-${index}`}
                      >
                        <Star size={14} aria-hidden="true" fill={fact.highlight ? 'currentColor' : 'none'} />
                      </button>
                      <button
                        type="button"
                        ref={register('up', fact.key)}
                        className={styles.iconBtn}
                        onClick={() => move(index, index - 1, 'up')}
                        disabled={!canMoveFact(list, index, -1)}
                        aria-label={`Move ${name} up`}
                        data-testid={`fact-up-${index}`}
                      >
                        <ChevronUp size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        ref={register('down', fact.key)}
                        className={styles.iconBtn}
                        onClick={() => move(index, index + 1, 'down')}
                        disabled={!canMoveFact(list, index, 1)}
                        aria-label={`Move ${name} down`}
                        data-testid={`fact-down-${index}`}
                      >
                        <ChevronDown size={14} aria-hidden="true" />
                      </button>
                      <button
                        type="button"
                        className={styles.iconBtn}
                        onClick={() => remove(index)}
                        aria-label={`Remove ${name}`}
                        data-testid={`fact-remove-${index}`}
                      >
                        <X size={14} aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                </div>

                <div className={styles.factFrom}>
                  {columnBad && !readOnly ? (
                    <>
                      <label htmlFor={`${rowId}-column`} className={styles.srOnly}>{`Choose another column for ${name}`}</label>
                      <select
                        id={`${rowId}-column`}
                        value=""
                        onChange={(event) => {
                          if (event.target.value === '') return;
                          setList(list.map((f, i) => (i === index ? { ...f, column: event.target.value } : f)));
                        }}
                        aria-invalid
                        aria-describedby={errors.describedBy(columnErr)}
                        data-testid={`fact-column-${index}`}
                      >
                        <option value="">{`${fact.column}: choose another column`}</option>
                        {free.map((column) => <option key={column} value={column}>{column}</option>)}
                      </select>
                    </>
                  ) : (
                    <span className={styles.fromText}>
                      From <b>{fact.column}</b>
                      {raw !== '' ? (
                        <span className={styles.sample}>
                          {` · ${raw}`}
                          {sampleOf(fact.column) !== raw ? ` → ${sampleOf(fact.column)}` : ''}
                        </span>
                      ) : null}
                    </span>
                  )}
                  <select
                    className={styles.typeSelect}
                    value={type}
                    disabled={readOnly}
                    onChange={(event) => onChange(withColumnType(value, fact.column, event.target.value as AgencyContextFieldType))}
                    aria-label={`How ${fact.column} is read`}
                    data-testid={`fact-row-type-${index}`}
                  >
                    {AGENCY_CONTEXT_FIELD_TYPES.map((t) => (
                      <option key={t} value={t}>{CONTEXT_TYPE_LABELS[t]}</option>
                    ))}
                  </select>
                </div>

                <div className={styles.factMeta}>
                  <span>
                    In the script: <code className={styles.key} data-testid={`fact-key-${index}`}>{`{${fact.key}}`}</code>
                  </span>
                  {fact.highlight ? <span className={styles.pill}>Highlighted, always first</span> : null}
                </div>
                {errors.render(labelErr)}
                {errors.render(columnErr)}
                {errors.render(keyErr)}
              </div>
            </li>
          );
        })}
      </ol>

      {removedInUse.map((fact) => {
        const label = fact.label.trim() || fact.column;
        const blocked = full || list.some((f) => sameColumn(f.column, fact.column));
        const said = `The script uses {${fact.key}}. Take it out of the script first, or keep the fact.`;
        return (
          <div key={fact.key} className={styles.putBack} data-testid={`fact-put-back-${fact.key}`}>
            {/* Said once: not again when the list's own message (what holds Save) already says it. */}
            {errors.message(FACTS_FIELD) !== said ? <span>{said}</span> : null}
            {!readOnly && onPutBack ? (
              <button
                type="button"
                className="btn-secondary"
                disabled={blocked}
                onClick={() => {
                  focusAfter.current = { key: fact.key, part: 'grip' };
                  setAnnouncement(`${label} put back on the card.`);
                  onPutBack(fact.key);
                }}
              >
                {`Put ‘${label}’ back`}
              </button>
            ) : null}
            {blocked && !readOnly ? (
              <span className={styles.hint}>{full ? 'Remove another fact first.' : `${fact.column} is on the card again.`}</span>
            ) : null}
          </div>
        );
      })}
      {errors.render(FACTS_FIELD)}

      {!readOnly ? (
        <div className={styles.addWrap}>
          <button
            ref={addButton}
            type="button"
            className={styles.addButton}
            onClick={onAddClick}
            aria-expanded={pickerOpen}
            aria-controls={`${id}-picker`}
            aria-disabled={full ? true : undefined}
            data-full={full ? '' : undefined}
            data-testid="fact-add"
          >
            <Plus size={14} aria-hidden="true" />
            Add a fact
          </button>
          {limitSaid && full ? (
            <p className={styles.limit} role="alert" data-testid="facts-limit">{FACTS_LIMIT_MESSAGE}</p>
          ) : null}
          {pickerOpen && !full ? (
            <div
              className={styles.picker}
              id={`${id}-picker`}
              onKeyDown={(event) => {
                if (event.key === 'Escape') {
                  event.preventDefault();
                  setPickerOpen(false);
                  addButton.current?.focus();
                }
              }}
              data-testid="fact-picker"
            >
              <h4 className={styles.minorHead} id={`${id}-picker-head`}>Columns of the customer list not on the card</h4>
              {free.length === 0 ? (
                <p className={styles.hint}>Every column agents may see is already on the card.</p>
              ) : (
                <ul className={styles.pickList} aria-labelledby={`${id}-picker-head`}>
                  {free.map((column, i) => {
                    const sample = sampleOf(column);
                    return (
                      <li key={column}>
                        <button
                          type="button"
                          className={styles.pickItem}
                          onClick={() => add(column)}
                          autoFocus={i === 0}
                          data-testid={`fact-pick-${column}`}
                        >
                          <b>{column}</b>
                          <span className={styles.sample}>{sample !== '' ? `e.g. ${sample}` : ''}</span>
                          <span className={styles.pill}>{CONTEXT_TYPE_LABELS[typeOf(column)]}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={styles.srOnly} role="status" aria-live="polite" data-testid="facts-announce">{announcement}</div>

      <details className={styles.types} open={typesOpen || typeErrorShown} onToggle={(event) => setTypesOpen((event.target as HTMLDetailsElement).open)}>
        <summary className={styles.minorHead} id={`${id}-types`}>How each column is read</summary>
        <p className={styles.hint}>One setting per column. Changing it here or on a fact above is the same change.</p>
        <ul className={styles.typeRows} aria-labelledby={`${id}-types`}>
          {shown.map((column, index) => {
            const selectId = `${id}-type-${index}`;
            const field = typeField(column);
            return (
              <li key={column} className={styles.typeRow}>
                <label htmlFor={selectId} className={styles.typeColumn}>{column}</label>
                <select
                  id={selectId}
                  value={typeOf(column)}
                  disabled={readOnly}
                  onChange={(event) => onChange(withColumnType(value, column, event.target.value as AgencyContextFieldType))}
                  aria-invalid={errors.message(field) ? true : undefined}
                  aria-describedby={errors.describedBy(field)}
                  data-testid={`fact-type-${column}`}
                >
                  {AGENCY_CONTEXT_FIELD_TYPES.map((t) => (
                    <option key={t} value={t}>{CONTEXT_TYPE_LABELS[t]}</option>
                  ))}
                </select>
                <span className={styles.typeError}>{errors.render(field)}</span>
              </li>
            );
          })}
        </ul>
      </details>
      {errors.render('context_display.roles')}
      {errors.render('context_display.types')}
      {errors.render('context_display')}
    </div>
  );
}
