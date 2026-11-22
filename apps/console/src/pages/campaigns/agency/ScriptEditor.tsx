import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, Plus, Trash2 } from 'lucide-react';
import {
  AGENCY_FACT_FIELDS_MAX,
  AGENCY_SCRIPT_OPENING_MAX_CHARS,
  AGENCY_SCRIPT_STEPS_MAX,
  AGENCY_SCRIPT_STEP_MAX_CHARS,
  type AgencyPhoneDisplay,
} from '@magick-agency/contracts/agency';
import { factKeyFromColumn, scriptPieces, unknownPlaceholdersIn } from '@magick-agency/domain/fact-fields';
import {
  SCRIPT_OPENING_FIELD,
  columnType,
  firstSample,
  insertAt,
  keyLabel,
  nameColumnOf,
  placeColumnOf,
  replaceToken,
  sameColumn,
  sampleRaw,
  sampleText,
  scriptLength,
  scriptStepField,
  type FactsForm,
  type RemovedFact,
  type SampleRow,
  type ScriptForm,
} from '../../../utils/agency/stationSettings';
import { formatCount } from '../../../utils/format/number';
import type { ConfigFieldErrors } from './configFieldErrors';
import styles from './StationSettings.module.css';

/** Which field the chips add to: the opening line, or a step by its index. */
type Target = 'opening' | number;

/** The `{` list while it is open: in which field, where its `{` is, what is typed after it. */
interface Pick {
  target: Target;
  start: number;
  query: string;
  active: number;
}

/** One key the editor offers: its key, its name, and this customer's value. */
interface KeyOption {
  key: string;
  label: string;
  sample: string;
}

const QUERY = /^[A-Za-z0-9_]*$/;

/**
 * Campaign Settings › Script (agent station BE-8, AS19): the opening line agents say first ("First,
 * say this" on Call coming) and up to {@link AGENCY_SCRIPT_STEPS_MAX} numbered steps ("What to say"
 * on the call), each with its count of characters against the server's bound.
 *
 * The keys a script may use are this campaign's: `{name}`, `{place}`, `{agent_name}`,
 * `{campaign_name}`, and each fact's on the card (`offered`). In the text a known key is tinted and
 * a `{word}` the card has no fact for is underlined in red, with a fix under its field: add the
 * column it names as a fact (when the card has room; when it has none, the row says so), use
 * another key, or take it out; or put a fact taken off the card back (disabled, with the reason,
 * when it cannot go back). The tint is a layer behind the field's own box only, re-measured and
 * re-scrolled with it on every render; the field grows with its text, so it never scrolls away
 * from the tint (AS19 S9). Typing `{` opens a list of the keys under the field, with each one's
 * name and sample value, filtered as more is typed (↑ ↓ to move, Enter or Tab to add, Esc to
 * close); the field names it (`aria-haspopup`, `aria-expanded`, `aria-controls` while it is open,
 * `aria-activedescendant`) and a live region says how many keys it shows. The chips under the
 * fields add a key at the caret of the field last typed in. "As the agent reads it" fills the keys
 * from a sample customer as the station would (R5): on a card with chosen facts an empty one reads
 * "<name> not given"; on a campaign still on the old model it is left out. The stored text stays
 * plain `{key}` text.
 *
 * Errors come keyed as the server keys them (`agent_script.opening`, `agent_script.steps[<i>].text`),
 * so the server's refusal lands on the field it is about.
 */
export function ScriptEditor({
  value,
  onChange,
  errors,
  readOnly = false,
  facts,
  offered,
  allowed,
  columns = [],
  uploaded,
  hidden = [],
  samples = [],
  phoneDisplay = 'full',
  campaignName = '',
  removedInUse = [],
  onPutBack,
  onAddFact,
  legacy = false,
  keysHint = 'The script can use only what the agent sees on the card.',
}: {
  value: ScriptForm;
  onChange: (next: ScriptForm) => void;
  errors: ConfigFieldErrors;
  readOnly?: boolean;
  /** The card on the form: each key's name and column. */
  facts: FactsForm;
  /** The keys offered (the chips and the `{` list), in order. */
  offered: readonly string[];
  /** The keys the script may use as things stand: anything else is underlined. */
  allowed: readonly string[];
  /** The customer list's columns (for "Add … as a fact"). */
  columns?: readonly string[];
  /** The latest upload's columns: "Add … as a fact" offers only these (absent: every column). */
  uploaded?: readonly string[];
  hidden?: readonly string[];
  samples?: readonly SampleRow[];
  phoneDisplay?: AgencyPhoneDisplay;
  campaignName?: string;
  /** Saved facts taken off the card that the script still uses, each with why it cannot go back. */
  removedInUse?: readonly RemovedFact[];
  onPutBack?: (key: string) => void;
  /** Put `column` on the card for the script's `token`; the page adds the fact and fixes the text. */
  onAddFact?: (column: string, token: string) => void;
  /**
   * The script is filled as on a campaign still on the old model (R5): a key with no value is
   * left out, not "not given".
   */
  legacy?: boolean;
  /** What the script may use, said under the hint (a campaign's card by default; a template has none). */
  keysHint?: string;
}) {
  const id = useId();
  const [target, setTarget] = useState<Target>('opening');
  const [pick, setPick] = useState<Pick | null>(null);
  const [sampleAt, setSampleAt] = useState(0);
  const fields = useRef(new Map<string, HTMLTextAreaElement>());
  /** Where the caret goes once a change's text is on screen. */
  const caret = useRef<{ key: string; at: number } | null>(null);
  const keyOf = (t: Target) => (t === 'opening' ? 'opening' : `step-${t}`);

  useEffect(() => {
    const pending = caret.current;
    if (!pending) return;
    caret.current = null;
    const field = fields.current.get(pending.key);
    if (!field) return;
    field.focus();
    field.setSelectionRange(pending.at, pending.at);
  });

  /*
    S9: the tint lies behind each field's own box and must keep to its text. Every render, each
    field grows to its text (so it has no scroll of its own to drift from), and its tint takes the
    field's scroll all the same, should one be left (a field typed into faster than it grows).
  */
  useLayoutEffect(() => {
    for (const field of fields.current.values()) {
      if (field.scrollHeight > 0) {
        field.style.height = 'auto';
        const border = field.offsetHeight - field.clientHeight;
        field.style.height = `${field.scrollHeight + Math.max(0, border)}px`;
      }
      const back = field.previousElementSibling as HTMLElement | null;
      if (back) {
        back.scrollTop = field.scrollTop;
        back.scrollLeft = field.scrollLeft;
      }
    }
  });

  const register = (t: Target) => (node: HTMLTextAreaElement | null) => {
    if (node) fields.current.set(keyOf(t), node);
    else fields.current.delete(keyOf(t));
  };

  const hiddenSet = new Set(hidden.map((c) => c.trim().toLowerCase()));
  const shown = columns.filter((c) => !hiddenSet.has(c.trim().toLowerCase()));
  const row: SampleRow | undefined = samples.length > 0 ? samples[Math.min(sampleAt, samples.length - 1)] : undefined;
  const nameColumn = nameColumnOf(facts, shown, hidden);
  const placeColumn = placeColumnOf(facts, shown, hidden);

  /** A key's value for a row: the formatted value, `''` when the customer has none, null when it has no source. */
  const valueOf = (key: string, from: SampleRow | undefined): string | null => {
    if (key === 'campaign_name') return campaignName.trim() || null;
    if (key === 'agent_name') return null;
    if (!from) return null;
    if (key === 'name') return nameColumn ? sampleRaw(from, nameColumn) : '';
    if (key === 'place') return placeColumn ? sampleRaw(from, placeColumn) : '';
    const fact = facts.list.find((f) => f.key === key);
    if (!fact) return null;
    return sampleText(sampleRaw(from, fact.column), columnType(facts, fact.column), phoneDisplay);
  };

  const options: KeyOption[] = offered.map((key) => {
    const fact = facts.list.find((f) => f.key === key);
    const sample = key === 'name' || key === 'place' || !fact
      ? valueOf(key, row) ?? ''
      : sampleText(firstSample(samples, fact.column), columnType(facts, fact.column), phoneDisplay);
    return { key, label: keyLabel(key, facts), sample };
  });

  const textOf = (t: Target) => (t === 'opening' ? value.opening : value.steps[t] ?? '');
  const withText = (t: Target, text: string): ScriptForm => (t === 'opening'
    ? { ...value, opening: text }
    : { ...value, steps: value.steps.map((step, i) => (i === t ? text : step)) });

  const addKey = (key: string) => {
    // A step removed since it was last typed in: back to the opening line.
    const at: Target = target === 'opening' || target < value.steps.length ? target : 'opening';
    const field = fields.current.get(keyOf(at));
    const text = textOf(at);
    const start = field?.selectionStart ?? text.length;
    const end = field?.selectionEnd ?? text.length;
    const next = insertAt(text, start, end, `{${key}}`);
    caret.current = { key: keyOf(at), at: next.caret };
    setPick(null);
    onChange(withText(at, next.text));
  };

  const filtered = (query: string): KeyOption[] => {
    const q = query.toLowerCase();
    return q === '' ? options : options.filter((o) => o.key.includes(q) || o.label.toLowerCase().includes(q));
  };

  const choose = (p: Pick, key: string) => {
    const text = textOf(p.target);
    const field = fields.current.get(keyOf(p.target));
    const end = field?.selectionEnd ?? p.start + 1 + p.query.length;
    const after = text.slice(end).startsWith('}') ? end + 1 : end;
    const put = `{${key}}`;
    caret.current = { key: keyOf(p.target), at: p.start + put.length };
    setPick(null);
    onChange(withText(p.target, `${text.slice(0, p.start)}${put}${text.slice(after)}`));
  };

  const onType = (t: Target, text: string, at: number) => {
    const before = textOf(t);
    // Something was typed or pasted that ends at the caret with a `{`.
    const typedBrace = text.length > before.length && at > 0 && text[at - 1] === '{';
    if (typedBrace && options.length > 0) {
      setPick({ target: t, start: at - 1, query: '', active: 0 });
    } else if (pick && pick.target === t) {
      const query = text.slice(pick.start + 1, at);
      if (text[pick.start] !== '{' || at <= pick.start || !QUERY.test(query)) setPick(null);
      else setPick({ ...pick, query, active: Math.min(pick.active, Math.max(0, filtered(query).length - 1)) });
    }
    onChange(withText(t, text));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, t: Target) => {
    if (!pick || pick.target !== t) return;
    const list = filtered(pick.query);
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setPick(null);
      return;
    }
    if (list.length === 0) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setPick({ ...pick, active: (pick.active + delta + list.length) % list.length });
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      choose(pick, list[Math.min(pick.active, list.length - 1)]!.key);
    }
  };

  const addStep = () => {
    caret.current = { key: keyOf(value.steps.length), at: 0 };
    setTarget(value.steps.length);
    onChange({ ...value, steps: [...value.steps, ''] });
  };

  const removeStep = (index: number) => {
    onChange({ ...value, steps: value.steps.filter((_, i) => i !== index) });
    setTarget('opening');
  };

  const moveStep = (index: number, delta: -1 | 1) => {
    const to = index + delta;
    if (to < 0 || to >= value.steps.length) return;
    const steps = [...value.steps];
    [steps[index], steps[to]] = [steps[to]!, steps[index]!];
    onChange({ ...value, steps });
    setTarget(to);
  };

  const counter = (text: string, max: number) => {
    const length = scriptLength(text);
    return (
      <span className={styles.counter} data-over={length > max ? '' : undefined} aria-hidden="true">
        {`${formatCount(length)} / ${formatCount(max)}`}
      </span>
    );
  };

  /** The column a `{word}` names, when it could go on the card: on the list, shown, not used. */
  const columnFor = (token: string): string | undefined => {
    const word = token.slice(1, -1).trim();
    const used = [nameColumn, placeColumn, ...facts.list.map((f) => f.column)].filter((c): c is string => Boolean(c));
    return shown.find((c) => !used.some((u) => sameColumn(u, c))
      && (uploaded === undefined || uploaded.some((u) => sameColumn(u, c)))
      && (sameColumn(c, word) || factKeyFromColumn(c) === word.toLowerCase()));
  };
  const cardFull = facts.list.length >= AGENCY_FACT_FIELDS_MAX;

  /** The fix row under a field for each `{word}` the card has no fact for. */
  const fixes = (t: Target, text: string) => {
    const unknown = unknownPlaceholdersIn(text, allowed);
    if (unknown.length === 0 || readOnly) return null;
    return unknown.map((token) => {
      const word = token.slice(1, -1).trim();
      const removed = removedInUse.find((r) => r.fact.key === word);
      const column = removed ? undefined : columnFor(token);
      const testId = `script-fix-${keyOf(t)}-${word}`;
      const reasonId = `${id}-${keyOf(t)}-${word}-reason`;
      return (
        <div key={token} className={styles.fix} data-testid={testId}>
          <code className={styles.keyBad}>{token}</code>
          {/* S9: a card with no room says so in full, in place of the button it cannot offer. */}
          {column && cardFull ? (
            <span className={styles.fixNote} data-testid={`${testId}-full`}>
              {`The card is full (${AGENCY_FACT_FIELDS_MAX} of ${AGENCY_FACT_FIELDS_MAX}), so ‘${column}’ cannot be added. Use another key or take it out.`}
            </span>
          ) : null}
          {removed && onPutBack ? (
            <button
              type="button"
              className={styles.fixBtn}
              disabled={removed.blocked !== null}
              aria-describedby={removed.blocked !== null ? reasonId : undefined}
              onClick={() => onPutBack(removed.fact.key)}
              data-testid={`${testId}-put-back`}
            >
              {`Put ‘${removed.fact.label.trim() || removed.fact.column}’ back`}
            </button>
          ) : null}
          {removed && onPutBack && removed.blocked !== null ? (
            <span id={reasonId} className={styles.fixNote}>{removed.blocked}</span>
          ) : null}
          {column && onAddFact && !cardFull ? (
            <button type="button" className={styles.fixBtn} onClick={() => onAddFact(column, token)} data-testid={`${testId}-add`}>
              {`Add ‘${column}’ as a fact`}
            </button>
          ) : null}
          <select
            className={styles.fixSelect}
            value=""
            aria-label={`Use another key in place of ${token}`}
            onChange={(event) => {
              if (event.target.value === '') return;
              onChange(replaceToken(value, token, `{${event.target.value}}`));
            }}
            data-testid={`${testId}-use`}
          >
            <option value="">Use another key…</option>
            {options.map((o) => <option key={o.key} value={o.key}>{`${o.label} {${o.key}}`}</option>)}
          </select>
          <button type="button" className={styles.fixBtn} onClick={() => onChange(replaceToken(value, token, ''))} data-testid={`${testId}-remove`}>
            Take it out
          </button>
        </div>
      );
    });
  };

  /**
   * A field with its keys tinted behind the text, and the `{` list under it. The tint layer is the
   * field's own box (`tokField`), so it can never reach past the field; the list is outside it,
   * after it and above it.
   */
  const keyedField = (t: Target, inputId: string, field: string, rows: number, placeholder?: string) => {
    const text = textOf(t);
    const open = pick && pick.target === t ? pick : null;
    const list = open ? filtered(open.query) : [];
    const listId = `${inputId}-keys`;
    const activeId = open && list.length > 0 ? `${listId}-${Math.min(open.active, list.length - 1)}` : undefined;
    return (
      <div className={styles.tokWrap}>
        <div className={styles.tokField}>
          <div className={styles.tokBack} aria-hidden="true" data-testid={`script-tint-${keyOf(t)}`}>
            {scriptPieces(text, allowed).map((piece, i) => (
              piece.kind === 'text'
                ? <Fragment key={i}>{piece.text}</Fragment>
                : piece.kind === 'key'
                  ? <mark key={i} className={styles.tokKey}>{`{${piece.key}}`}</mark>
                  : <mark key={i} className={styles.tokBad} data-unknown="">{piece.token}</mark>
            ))}
            {'\n'}
          </div>
          <textarea
            id={inputId}
            ref={register(t)}
            className={`${styles.textarea} ${styles.tokArea}`}
            rows={rows}
            value={text}
            placeholder={placeholder}
            disabled={readOnly}
            spellCheck={false}
            autoComplete="off"
            onFocus={() => setTarget(t)}
            onBlur={() => setPick((p) => (p && p.target === t ? null : p))}
            onScroll={(event) => {
              const back = event.currentTarget.previousElementSibling as HTMLElement | null;
              if (back) {
                back.scrollTop = event.currentTarget.scrollTop;
                back.scrollLeft = event.currentTarget.scrollLeft;
              }
            }}
            onChange={(event) => onType(t, event.target.value, event.target.selectionStart ?? event.target.value.length)}
            onKeyDown={(event) => onKeyDown(event, t)}
            aria-invalid={errors.message(field) || unknownPlaceholdersIn(text, allowed).length > 0 ? true : undefined}
            aria-describedby={errors.describedBy(field)}
            // A text field with a `{` list (S9): no combobox role; the list it opens, while it is open.
            aria-haspopup="listbox"
            aria-expanded={open !== null}
            aria-controls={open && list.length > 0 ? listId : undefined}
            aria-activedescendant={activeId}
            data-testid={t === 'opening' ? 'script-opening' : `script-step-${t}`}
          />
        </div>
        {open ? (
          <div className={styles.keyPick} data-testid="script-key-pick">
            <div className={styles.keyPickHead}>Keys of this campaign · ↑ ↓ to move, Enter to add, Esc to close</div>
            {list.length > 0 ? (
              <ul role="listbox" id={listId} aria-label="Keys of this campaign" data-testid="script-key-list">
                {list.map((option, i) => (
                  <li
                    key={option.key}
                    id={`${listId}-${i}`}
                    role="option"
                    aria-selected={i === Math.min(open.active, list.length - 1)}
                    className={styles.keyOption}
                    // Keep the caret in the field.
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => choose(open, option.key)}
                    data-testid={`script-key-option-${option.key}`}
                  >
                    <b>{option.label}</b>
                    <span className={styles.sample}>{option.sample || ' '}</span>
                    <code className={styles.key}>{`{${option.key}}`}</code>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.keyPickNone}>{`No key matches “${open.query}”.`}</p>
            )}
          </div>
        ) : null}
      </div>
    );
  };

  /**
   * A text as the agent reads it for the sample customer (R5): a value as the station writes it; a
   * key with no value "<name> not given" on a card with chosen facts, left out on one still on the
   * old model, and `{campaign_name}` with none left out always. `{agent_name}` (whoever takes the
   * call) and, with no sample customer, every customer key show their names.
   */
  const readAloud = (text: string): ReactNode => scriptPieces(text, allowed).map((piece, i) => {
    if (piece.kind === 'text') return <Fragment key={i}>{piece.text}</Fragment>;
    if (piece.kind === 'unknown') return <Fragment key={i}>{piece.token}</Fragment>;
    const filled = valueOf(piece.key, row);
    const label = keyLabel(piece.key, facts);
    if (piece.key === 'campaign_name' && !filled) return null;
    if (filled === null) return <span key={i} className={styles.readKey}>{label}</span>;
    if (filled === '') {
      return legacy ? null : <span key={i} className={styles.notGiven} data-testid="script-not-given">{`${label} not given`}</span>;
    }
    return <span key={i} className={styles.readValue}>{filled}</span>;
  });

  /** What the `{` list shows, said in the live region (S9). */
  const listSaid = (() => {
    if (!pick) return '';
    const shownKeys = filtered(pick.query);
    if (shownKeys.length === 0) return `No key matches “${pick.query}”.`;
    const count = shownKeys.length === 1 ? '1 key' : `${shownKeys.length} keys`;
    return `${count} of this campaign. Up and down arrows to move, Enter to add, Escape to close.`;
  })();

  const targetName = target === 'opening' || target >= value.steps.length ? 'the opening line' : `step ${target + 1}`;
  const full = value.steps.length >= AGENCY_SCRIPT_STEPS_MAX;
  const hasScript = value.opening.trim() !== '' || value.steps.some((s) => s.trim() !== '');

  return (
    <div className={styles.stack} data-testid="script-editor">
      <p className={styles.hint}>
        What agents read out. The opening line shows while the call connects; the steps show during the call.
        Leave both empty for no script: agents then see the customer’s last calls instead.
      </p>
      {!readOnly ? (
        <p className={styles.hint}>
          Type <code className={styles.key}>{'{'}</code> to pick one of this campaign’s keys, or press a key below to add it where the cursor is.
          {keysHint}
        </p>
      ) : null}

      <div className="form-group">
        <div className={styles.labelRow}>
          <label htmlFor={`${id}-opening`}>Opening line</label>
          {counter(value.opening, AGENCY_SCRIPT_OPENING_MAX_CHARS)}
        </div>
        {keyedField('opening', `${id}-opening`, SCRIPT_OPENING_FIELD, 2, 'Hello, am I speaking with {name}? I am calling from …')}
        {errors.render(SCRIPT_OPENING_FIELD)}
        {fixes('opening', value.opening)}
      </div>

      <div className={styles.stepsHead}>
        <span className={styles.legend} id={`${id}-steps`}>Steps</span>
        <span className={styles.hint}>{`${formatCount(value.steps.length)} of ${formatCount(AGENCY_SCRIPT_STEPS_MAX)}`}</span>
      </div>
      {value.steps.length === 0 ? <p className={styles.hint}>No steps yet.</p> : null}
      <ol className={styles.steps} aria-labelledby={`${id}-steps`}>
        {value.steps.map((step, index) => {
          const field = scriptStepField(index);
          const inputId = `${id}-step-${index}`;
          return (
            // Positional keys, as the outcome list: every field is controlled and a move swaps by index.
            <li key={index} className={styles.step}>
              <div className={styles.labelRow}>
                <label htmlFor={inputId}>{`Step ${index + 1}`}</label>
                {counter(step, AGENCY_SCRIPT_STEP_MAX_CHARS)}
              </div>
              <div className={styles.stepRow}>
                {keyedField(index, inputId, field, 2)}
                {!readOnly ? (
                  <div className={styles.stepActions}>
                    <button type="button" className={styles.iconBtn} onClick={() => moveStep(index, -1)} disabled={index === 0} aria-label={`Move step ${index + 1} up`}>
                      <ArrowUp size={14} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      onClick={() => moveStep(index, 1)}
                      disabled={index === value.steps.length - 1}
                      aria-label={`Move step ${index + 1} down`}
                    >
                      <ArrowDown size={14} aria-hidden="true" />
                    </button>
                    <button type="button" className={styles.iconBtn} onClick={() => removeStep(index)} aria-label={`Remove step ${index + 1}`}>
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </div>
                ) : null}
              </div>
              {errors.render(field)}
              {fixes(index, step)}
            </li>
          );
        })}
      </ol>
      {errors.render('agent_script.steps')}
      {errors.render('agent_script')}

      {!readOnly ? (
        <div>
          <button type="button" className={styles.addButton} onClick={addStep} disabled={full} data-testid="script-add-step">
            <Plus size={14} aria-hidden="true" />
            Add a step
          </button>
          {full ? <p className={styles.hint}>{`A script can have at most ${AGENCY_SCRIPT_STEPS_MAX} steps.`}</p> : null}
        </div>
      ) : null}

      {!readOnly ? (
        <div className={styles.chips} role="group" aria-label={`Add a key to ${targetName}`}>
          <span className={styles.chipsLead}>{`Add to ${targetName}:`}</span>
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              className={styles.chip}
              // Keep the caret where it is in the field being typed in.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => addKey(option.key)}
              title={option.sample ? `${option.label}: ${option.sample}` : option.label}
              data-testid={`script-chip-${option.key}`}
            >
              {`{${option.key}}`}
            </button>
          ))}
        </div>
      ) : null}

      {hasScript ? (
        <section className={styles.hear} aria-labelledby={`${id}-hear`} data-testid="script-preview">
          <div className={styles.hearHead}>
            <h4 className={styles.minorHead} id={`${id}-hear`}>
              {row ? `As the agent reads it · sample customer ${Math.min(sampleAt, samples.length - 1) + 1} of ${samples.length}` : 'As the agent reads it'}
            </h4>
            {samples.length > 1 ? (
              <div className={styles.inline}>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => setSampleAt((n) => (n - 1 + samples.length) % samples.length)}
                  aria-label="Previous sample customer"
                >
                  <ChevronLeft size={14} aria-hidden="true" />
                </button>
                <button
                  type="button"
                  className={styles.iconBtn}
                  onClick={() => setSampleAt((n) => (n + 1) % samples.length)}
                  aria-label="Next sample customer"
                >
                  <ChevronRight size={14} aria-hidden="true" />
                </button>
              </div>
            ) : null}
          </div>
          {value.opening.trim() !== '' ? <p className={styles.hearOpening} data-testid="script-preview-opening">{readAloud(value.opening.trim())}</p> : null}
          {value.steps.some((s) => s.trim() !== '') ? (
            <ol className={styles.hearSteps}>
              {value.steps.map((step, i) => (step.trim() !== '' ? <li key={i} data-testid={`script-preview-step-${i}`}>{readAloud(step.trim())}</li> : null))}
            </ol>
          ) : null}
          <p className={styles.hint}>
            {!row
              ? 'There is no customer in this campaign yet, so each key shows its name.'
              : legacy
                ? 'A key this customer has no value for is left out, as agents see it until the customer card is saved here.'
                : 'A fact this customer has no value for shows its name and “not given”, so the agent asks or skips it.'}
          </p>
        </section>
      ) : null}
      <div className={styles.srOnly} role="status" aria-live="polite" data-testid="script-key-announce">{listSaid}</div>
    </div>
  );
}
