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
  AMOUNT_DUE_KEY,
  COLUMNS_LOADING_MESSAGE,
  CONTEXT_TYPE_LABELS,
  FACTS_FIELD,
  FACTS_LIMIT_MESSAGE,
  NAME_FIELD,
  PLACE_FIELD,
  canMoveFact,
  columnNamed,
  columnType,
  factField,
  firstSample,
  sampleRaw,
  labelLength,
  moreShown,
  moreTypeOf,
  moveFact,
  nameColumnOf,
  newFact,
  placeColumnOf,
  sameColumn,
  sampleText,
  typeField,
  withAmountDue,
  withColumnType,
  withHighlight,
  withMoreAll,
  withMoreShown,
  withMoreType,
  type FactsForm,
  type RemovedFact,
  type SampleRow,
} from '../../../utils/agency/stationSettings';
import type { ConfigFieldErrors } from './configFieldErrors';
import { looksLikePhoneNumber } from '@magick-agency/domain/more-details';
import styles from './StationSettings.module.css';

/** A control of a fact's row that can take focus. */
export type FactRowPart = 'grip' | 'up' | 'down' | 'label' | 'amount';

/** Which control of a row takes focus once a change is on screen. */
type FocusTarget = { key: string; part: FactRowPart } | { key: null; part: 'add' };

/**
 * A fact the page put on the card from elsewhere (the script's "Put it back" or "Add … as a
 * fact", AS19 S9): the control of its row to focus once it is on screen, and what to announce. A
 * new object for each request.
 */
export interface FactFocusRequest {
  key: string;
  part: FactRowPart;
  said: string;
}

/** Where the customer list's columns are: being read, the read failed, or read (none: no upload). */
export type ColumnsRead = 'loading' | 'failed' | 'done';

/** The line-under-the-name select's value for "None" (the form's null): never a CSV header. */
const PLACE_NONE = '\u0000none';

/**
 * Campaign Settings › What agents see › the customer card (AS19): the column that is the
 * customer's name and the one shown under it (`roles.name`, `roles.place`), then up to
 * {@link AGENCY_FACT_FIELDS_MAX} facts in the order the card draws them, each with the name agents
 * see (at most {@link AGENCY_FACT_LABEL_MAX_CHARS} letters), its script key (`{key}`, made from the
 * column's header when it is added and never changed by a rename), and an optional highlight (one
 * at most, always first). Facts move by drag, by the arrows, or by the arrow keys on a focused
 * grip, and each move is said in a live region. Last, how each column is read (six types).
 *
 * The name and the line under it default to the domain's one guess from the column names (S1),
 * which a save writes as the role; the line under it may also be "None" (S2). A column read as a
 * phone number is never offered for either (S3(e)). A money fact may be the one used for Full and
 * Half on What happened? (its key then `{amount_due}`, S9).
 *
 * The columns are the customer list's (`useCampaignColumns`); a column hidden from agents is never
 * offered, and a fact is added from the latest upload's columns only (`uploaded`: the newest
 * import's), never from a column only the stored settings name. While they are read, or when the
 * read failed, the picker says so (with "Try again"); a card on the old model is not shown at all
 * until they are read (`waitForColumns`), since it is opened from them. A sample is drawn as the
 * station draws it, and a phone number only so, never as its digits beside it. A fact whose column
 * the latest upload does not have is said on its row, with a select to choose another. A saved
 * fact the script still uses that was taken off the card is offered back ("Put it back", disabled
 * with its reason when it cannot go back), under the one message that holds Save. Errors come
 * keyed as the server keys them (`context_display.roles.<role>`, `context_display.facts.<i>.<part>`,
 * `context_display.types.<column>`), so the server's refusal lands on the field it is about.
 *
 * AS20: under the facts, More details lists every other column of the latest upload (not the
 * name, the line under it or a fact), each shown to agents unless ticked off (`more_hidden`), with
 * its sample as agents will see it and how it is read; a column read as a phone number only
 * because its values look like one says so, and Text or Number takes that back.
 *
 * Column names match as the server matches them, ignoring case. Ids are made from places in the
 * list, never from column names, so two names an id would spell alike never share one.
 */
export function CustomerFactsEditor({
  value,
  onChange,
  columns,
  uploaded,
  hidden,
  columnsRead = 'done',
  onRetryColumns,
  waitForColumns = false,
  errors,
  samples = [],
  phoneDisplay = 'full',
  removedInUse = [],
  onPutBack,
  focusRequest = null,
  readOnly = false,
}: {
  value: FactsForm;
  onChange: (next: FactsForm) => void;
  /** The customer list's columns, hidden ones included. */
  columns: readonly string[];
  /**
   * The latest upload's columns (AS19 R12, S9: the newest import's): the only ones a fact may be
   * added from or moved to, so a column only the stored settings name is never offered. Absent:
   * every column of `columns`.
   */
  uploaded?: readonly string[];
  /** The columns hidden from agents (`context_display.hidden`). */
  hidden: readonly string[];
  /** Where the read of the customer list's columns is. */
  columnsRead?: ColumnsRead;
  /** Read the columns again, after a failure. */
  onRetryColumns?: () => void;
  /** The card is on the old model and is opened from the columns: shown only once they are read. */
  waitForColumns?: boolean;
  errors: ConfigFieldErrors;
  /** A few customers' rows, for the sample beside each column. */
  samples?: readonly SampleRow[];
  phoneDisplay?: AgencyPhoneDisplay;
  /** Saved facts taken off the card that the script still uses, each with why it cannot go back. */
  removedInUse?: readonly RemovedFact[];
  /** Put a removed saved fact back, by its key (the page then asks for its row's focus). */
  onPutBack?: (key: string) => void;
  /** A fact the page put on the card: focus its row and say so. */
  focusRequest?: FactFocusRequest | null;
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

  // S9: after "Put it back" or "Add … as a fact", the fact's row takes focus and the change is said.
  useEffect(() => {
    if (!focusRequest) return;
    const target = controls.current.get(`${focusRequest.part}:${focusRequest.key}`) ?? controls.current.get(`grip:${focusRequest.key}`);
    target?.focus();
    setAnnouncement(focusRequest.said);
  }, [focusRequest]);

  const register = (part: string, key: string) => (node: HTMLElement | null) => {
    if (node) controls.current.set(`${part}:${key}`, node);
    else controls.current.delete(`${part}:${key}`);
  };

  const nameColumn = nameColumnOf(value, shown, hidden);
  const placeColumn = placeColumnOf(value, shown, hidden);
  const usedColumns = [nameColumn, placeColumn, ...list.map((f) => f.column)].filter((c): c is string => Boolean(c));
  const offerable = uploaded === undefined ? shown : shown.filter((c) => uploaded.some((u) => sameColumn(u, c)));
  const free = offerable.filter((c) => !usedColumns.some((u) => sameColumn(u, c)));
  const typeOf = (column: string): AgencyContextFieldType => columnType(value, column);
  // AS20: More details lists the latest upload's columns that are not the name, the line under it or a fact.
  const moreColumns = free;
  const moreOn = moreColumns.filter((c) => moreShown(value, c));
  const isMore = (column: string): boolean => moreColumns.some((c) => sameColumn(c, column));
  // A More details column's sample values: the server reads each customer's own (AS20).
  const samplesOf = (column: string): string[] => samples.map((row) => sampleRaw(row, column)).filter((raw) => raw !== '');
  const moreTypeFor = (column: string): AgencyContextFieldType => moreTypeOf(value, column, samplesOf(column));
  const sampleOf = (column: string): string => sampleText(firstSample(samples, column), typeOf(column), phoneDisplay);
  const nameOf = (fact: AgencyFactField): string => fact.label.trim() || fact.column;

  const setList = (next: AgencyFactField[]) => onChange({ ...value, list: next });

  const move = (from: number, to: number, focus: FactRowPart) => {
    const fact = list[from];
    if (!fact) return;
    const next = moveFact(list, from, to);
    const at = next.findIndex((f) => f.key === fact.key);
    if (at === from) return;
    focusAfter.current = { key: fact.key, part: focus };
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

  const toggleAmount = (index: number, on: boolean) => {
    const fact = list[index]!;
    const next = withAmountDue(list, index, on);
    // The key changes, and the row with it: focus follows the row to its new key.
    focusAfter.current = { key: next[index]!.key, part: 'amount' };
    setAnnouncement(on ? `${nameOf(fact)} is used for Full and Half.` : `${nameOf(fact)} is no longer used for Full and Half.`);
    setList(next);
  };

  /**
   * A select of the columns for the name or the line under it: `lead` first (the guess, "None"),
   * then each column. `current` is a column or a lead's value. A column read as a phone number is
   * offered disabled (S3(e)) unless it is the one chosen (its error then says why).
   */
  const columnSelect = (
    selectId: string,
    current: string,
    lead: ReadonlyArray<{ value: string; label: string }>,
    field: string,
    testId: string,
    onPick: (column: string) => void,
    hint: string,
  ) => {
    const isLead = lead.some((o) => o.value === current);
    const listed = isLead ? undefined : columnNamed(shown, current);
    const missing = !isLead && listed === undefined;
    return (
      <>
        <select
          id={selectId}
          className={styles.roleSelect}
          value={listed ?? current}
          disabled={readOnly}
          onChange={(event) => onPick(event.target.value)}
          aria-invalid={errors.message(field) ? true : undefined}
          aria-describedby={[`${selectId}-hint`, errors.describedBy(field)].filter(Boolean).join(' ')}
          data-testid={testId}
        >
          {lead.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          {missing ? <option value={current}>{`${current} (not in the list)`}</option> : null}
          {shown.map((column) => {
            const phone = typeOf(column) === 'phone';
            return (
              <option key={column} value={column} disabled={phone && column !== listed}>
                {phone ? `${column} (phone number)` : column}
              </option>
            );
          })}
        </select>
        <p id={`${selectId}-hint`} className={styles.hint}>{hint}</p>
        {errors.render(field)}
      </>
    );
  };

  /** Why the columns are not here: being read, or the read failed (with "Try again"). */
  const columnsState = (testId: string) => (columnsRead === 'failed' ? (
    <div className={styles.columnsState} role="alert" data-testid={testId}>
      <span>Could not read the customer list’s columns.</span>
      {onRetryColumns ? (
        <button type="button" className={styles.fixBtn} onClick={onRetryColumns} data-testid={`${testId}-retry`}>Try again</button>
      ) : null}
    </div>
  ) : (
    <p className={styles.hint} role="status" data-testid={testId}>{COLUMNS_LOADING_MESSAGE}</p>
  ));

  // S9: a card on the old model is opened from the columns, so it waits for them (and is not saved).
  if (!readOnly && columnsRead !== 'done' && (waitForColumns || (shown.length === 0 && list.length === 0))) {
    return (
      <div className={styles.stack} data-testid="customer-facts">
        <h3 className={styles.subhead}>The customer card</h3>
        {columnsState('customer-facts-columns')}
      </div>
    );
  }

  if (shown.length === 0 && list.length === 0) {
    return (
      <div className={styles.stack} data-testid="customer-facts">
        <h3 className={styles.subhead}>The customer card</h3>
        <p className={styles.hint} data-testid="customer-facts-empty">
          {readOnly
            ? 'No customer facts are set for this campaign.'
            : 'Upload a customer list to this campaign first. Then choose here which columns agents see on the customer card.'}
        </p>
        {errors.render(NAME_FIELD)}
        {errors.render(PLACE_FIELD)}
        {errors.render(FACTS_FIELD)}
      </div>
    );
  }

  // What "Guess" picks now (S1), and so what a save writes (R1, S2).
  const nameGuess = nameColumnOf({ ...value, name: '' }, shown, hidden);
  const placeGuess = placeColumnOf({ ...value, place: '' }, shown, hidden);
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
            [{ value: '', label: nameGuess ? `Guess (${nameGuess})` : 'Guess from the column names' }],
            NAME_FIELD,
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
            // "Guess" with nothing to guess reads as "None": neither writes a line under the name.
            value.place === null || (value.place === '' && !placeGuess) ? PLACE_NONE : value.place,
            [...(placeGuess ? [{ value: '', label: `Guess (${placeGuess})` }] : []), { value: PLACE_NONE, label: 'None' }],
            PLACE_FIELD,
            'fact-role-place',
            (place) => onChange({ ...value, place: place === PLACE_NONE ? null : place }),
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
                        <span className={styles.sample} data-testid={`fact-sample-${index}`}>
                          {/* A phone number only as agents see it (AS19 R12): its digits never beside it. */}
                          {type === 'phone' || sampleOf(fact.column) === raw
                            ? ` · ${sampleOf(fact.column)}`
                            : ` · ${raw} → ${sampleOf(fact.column)}`}
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
                  {/* S9: a money fact may be the one the Full and Half amounts on What happened? read (one at most). */}
                  {type === 'money' || fact.key === AMOUNT_DUE_KEY ? (
                    <label className={styles.amountToggle} title="The Full and Half amounts on What happened? come from this fact.">
                      <input
                        type="checkbox"
                        ref={register('amount', fact.key)}
                        checked={fact.key === AMOUNT_DUE_KEY}
                        disabled={readOnly}
                        onChange={(event) => toggleAmount(index, event.target.checked)}
                        data-testid={`fact-amount-${index}`}
                      />
                      Use for Full and Half
                    </label>
                  ) : null}
                </div>
                {errors.render(labelErr)}
                {errors.render(columnErr)}
                {errors.render(keyErr)}
              </div>
            </li>
          );
        })}
      </ol>

      {/* The one message that holds Save (the server's words), then a way back for each fact it names. */}
      {errors.render(FACTS_FIELD)}
      {!readOnly && onPutBack ? removedInUse.map(({ fact, blocked }) => {
        const label = fact.label.trim() || fact.column;
        const reasonId = `${id}-put-back-${fact.key}`;
        return (
          <div key={fact.key} className={styles.putBack} data-testid={`fact-put-back-${fact.key}`}>
            <button
              type="button"
              className="btn-secondary"
              disabled={blocked !== null}
              aria-describedby={blocked !== null ? reasonId : undefined}
              onClick={() => onPutBack(fact.key)}
            >
              {`Put ‘${label}’ back`}
            </button>
            {blocked !== null ? <span id={reasonId} className={styles.hint}>{blocked}</span> : null}
          </div>
        );
      }) : null}

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
              <h4 className={styles.minorHead} id={`${id}-picker-head`}>Columns of the latest upload not on the card</h4>
              {/* S9: reading, a failed read and no upload are three different things to say. */}
              {columnsRead !== 'done' ? columnsState('fact-picker-columns') : free.length === 0 ? (
                <p className={styles.hint} data-testid="fact-picker-none">
                  {offerable.length === 0
                    ? 'This campaign has no customer list yet. Upload one first.'
                    : 'Every column agents may see is already on the card.'}
                </p>
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

      {/* AS20: every other column of the latest upload, which agents open under the card. */}
      <section className={styles.more} aria-labelledby={`${id}-more`} data-testid="more-details-settings">
        <div className={styles.moreHead}>
          <h4 className={styles.minorHead} id={`${id}-more`}>More details</h4>
          {columnsRead === 'done' && moreColumns.length > 0 ? (
            <span className={styles.hint} data-testid="more-details-shown">{`${moreOn.length} of ${moreColumns.length} shown`}</span>
          ) : null}
        </div>
        <p className={styles.hint}>
          Agents open these under the card, below its facts. Every other column of the customer list is
          shown to them unless it is turned off here. A column turned off is hidden from agents only:
          supervisors still see it on the contact page.
        </p>
        {columnsRead !== 'done' ? columnsState('more-details-columns') : moreColumns.length === 0 ? (
          <p className={styles.hint} data-testid="more-details-none">
            {readOnly
              ? value.moreHidden.length > 0
                ? `Turned off for agents: ${value.moreHidden.join(', ')}.`
                : 'Agents see every other column of the customer list.'
              : (uploaded ?? shown).length === 0
                ? 'This campaign has no customer list yet. Upload one first.'
                : 'Every column agents may see is already on the card.'}
          </p>
        ) : (
          <>
            {readOnly ? null : (
              <div className={styles.moreAll}>
                <button
                  type="button"
                  className={styles.fixBtn}
                  disabled={moreOn.length === moreColumns.length}
                  onClick={() => onChange(withMoreAll(value, moreColumns, true))}
                  data-testid="more-details-all-on"
                >
                  Show all
                </button>
                <button
                  type="button"
                  className={styles.fixBtn}
                  disabled={moreOn.length === 0}
                  onClick={() => onChange(withMoreAll(value, moreColumns, false))}
                  data-testid="more-details-all-off"
                >
                  Hide all
                </button>
              </div>
            )}
            <ul className={styles.typeRows} aria-labelledby={`${id}-more`}>
              {moreColumns.map((column, index) => {
                const checkId = `${id}-more-${index}`;
                const typeId = `${id}-more-type-${index}`;
                const noteId = `${id}-more-note-${index}`;
                const values = samplesOf(column);
                const type = moreTypeFor(column);
                // The sample shown is one that reads as a phone number when the note says some do.
                const raw = (type === 'phone' ? values.find((v) => looksLikePhoneNumber(v)) : undefined) ?? values[0] ?? '';
                const sample = sampleText(raw, type, phoneDisplay);
                const looksPhone = type === 'phone' && typeOf(column) !== 'phone';
                const on = moreShown(value, column);
                return (
                  <li key={column} className={styles.moreRow} data-testid={`more-detail-setting-${column}`}>
                    <label htmlFor={checkId} className={styles.moreCheck}>
                      <input
                        id={checkId}
                        type="checkbox"
                        checked={on}
                        disabled={readOnly}
                        onChange={(event) => onChange(withMoreShown(value, column, event.target.checked))}
                        aria-describedby={looksPhone ? noteId : undefined}
                        data-testid={`more-detail-show-${column}`}
                      />
                      <b>{column}</b>
                      <span className={styles.sample}>{sample !== '' ? `e.g. ${sample}` : ''}</span>
                    </label>
                    <label htmlFor={typeId} className={styles.srOnly}>{`How ${column} is read`}</label>
                    <select
                      id={typeId}
                      className={styles.typeSelect}
                      value={type}
                      disabled={readOnly}
                      onChange={(event) => onChange(withMoreType(value, column, event.target.value as AgencyContextFieldType))}
                      aria-describedby={looksPhone ? noteId : undefined}
                      data-testid={`more-detail-type-${column}`}
                    >
                      {AGENCY_CONTEXT_FIELD_TYPES.map((t) => (
                        <option key={t} value={t}>{CONTEXT_TYPE_LABELS[t]}</option>
                      ))}
                    </select>
                    {looksPhone ? (
                      <span id={noteId} className={styles.typeError} data-testid={`more-detail-phone-note-${column}`}>
                        This looks like a phone number, so agents see it as one{phoneDisplay === 'masked' ? ', with the middle digits hidden' : ''}. Choose Text or Number if it is not.
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {errors.render('context_display.more_hidden')}
      </section>

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
                  value={isMore(column) ? moreTypeFor(column) : typeOf(column)}
                  disabled={readOnly}
                  onChange={(event) => {
                    const type = event.target.value as AgencyContextFieldType;
                    // A More details column is read as More details reads it (AS20), the same select as there.
                    onChange(isMore(column) ? withMoreType(value, column, type) : withColumnType(value, column, type));
                  }}
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
