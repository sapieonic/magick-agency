import { useEffect, useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import {
  AGENCY_SCRIPT_OPENING_MAX_CHARS,
  AGENCY_SCRIPT_STEPS_MAX,
  AGENCY_SCRIPT_STEP_MAX_CHARS,
} from '@magick-agency/contracts/agency';
import {
  SCRIPT_OPENING_FIELD,
  SCRIPT_PLACEHOLDER_CHIPS,
  insertAt,
  scriptLength,
  scriptStepField,
  type ScriptForm,
} from '../../../utils/agency/stationSettings';
import { formatCount } from '../../../utils/format/number';
import type { ConfigFieldErrors } from './configFieldErrors';
import styles from './StationSettings.module.css';

/** Which field the chips add to: the opening line, or a step by its index. */
type Target = 'opening' | number;

/**
 * Campaign Settings › Script (agent station BE-8): the opening line agents say first ("First, say
 * this" on Call coming) and up to {@link AGENCY_SCRIPT_STEPS_MAX} numbered steps ("What to say" on
 * the call), each with its count of characters against the server's bound.
 *
 * The chips add a placeholder (`{name}`, `{amount_due}`, …) at the caret of the field last typed
 * in (the opening line until one is), which the station fills from the customer's facts. A word in
 * braces the station cannot fill is said as it is typed, as the server would refuse it. Errors come
 * keyed as the server keys them (`agent_script.opening`, `agent_script.steps[<i>].text`), so the
 * server's refusal lands on the field it is about.
 */
export function ScriptEditor({
  value,
  onChange,
  errors,
  readOnly = false,
}: {
  value: ScriptForm;
  onChange: (next: ScriptForm) => void;
  errors: ConfigFieldErrors;
  readOnly?: boolean;
}) {
  const id = useId();
  const [target, setTarget] = useState<Target>('opening');
  const fields = useRef(new Map<string, HTMLTextAreaElement>());
  /** Where the caret goes once a chip's text is on screen. */
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

  const register = (t: Target) => (node: HTMLTextAreaElement | null) => {
    if (node) fields.current.set(keyOf(t), node);
    else fields.current.delete(keyOf(t));
  };

  const textOf = (t: Target) => (t === 'opening' ? value.opening : value.steps[t] ?? '');
  const setText = (t: Target, text: string) => {
    if (t === 'opening') onChange({ ...value, opening: text });
    else onChange({ ...value, steps: value.steps.map((step, i) => (i === t ? text : step)) });
  };

  const addPlaceholder = (key: string) => {
    // A step removed since it was last typed in: back to the opening line.
    const at: Target = target === 'opening' || target < value.steps.length ? target : 'opening';
    const field = fields.current.get(keyOf(at));
    const text = textOf(at);
    const start = field?.selectionStart ?? text.length;
    const end = field?.selectionEnd ?? text.length;
    const next = insertAt(text, start, end, `{${key}}`);
    caret.current = { key: keyOf(at), at: next.caret };
    setText(at, next.text);
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

  const targetName = target === 'opening' || target >= value.steps.length ? 'the opening line' : `step ${target + 1}`;
  const full = value.steps.length >= AGENCY_SCRIPT_STEPS_MAX;

  return (
    <div className={styles.stack} data-testid="script-editor">
      <p className={styles.hint}>
        What agents read out. The opening line shows while the call connects; the steps show during the call.
        Leave both empty for no script: agents then see the customer’s last calls instead.
      </p>

      {!readOnly ? (
        <div className={styles.chips} role="group" aria-label={`Add to ${targetName}`}>
          <span className={styles.chipsLead}>{`Add to ${targetName}:`}</span>
          {SCRIPT_PLACEHOLDER_CHIPS.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={styles.chip}
              // Keep the caret where it is in the field being typed in.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => addPlaceholder(chip.key)}
              title={`Adds {${chip.key}}`}
              data-testid={`script-chip-${chip.key}`}
            >
              {chip.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="form-group">
        <div className={styles.labelRow}>
          <label htmlFor={`${id}-opening`}>Opening line</label>
          {counter(value.opening, AGENCY_SCRIPT_OPENING_MAX_CHARS)}
        </div>
        <textarea
          id={`${id}-opening`}
          ref={register('opening')}
          className={styles.textarea}
          rows={2}
          value={value.opening}
          placeholder="Hello, am I speaking with {name}? I am calling from …"
          disabled={readOnly}
          onFocus={() => setTarget('opening')}
          onChange={(event) => setText('opening', event.target.value)}
          aria-invalid={errors.message(SCRIPT_OPENING_FIELD) ? true : undefined}
          aria-describedby={errors.describedBy(SCRIPT_OPENING_FIELD)}
          data-testid="script-opening"
        />
        {errors.render(SCRIPT_OPENING_FIELD)}
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
                <textarea
                  id={inputId}
                  ref={register(index)}
                  className={styles.textarea}
                  rows={2}
                  value={step}
                  disabled={readOnly}
                  onFocus={() => setTarget(index)}
                  onChange={(event) => setText(index, event.target.value)}
                  aria-invalid={errors.message(field) ? true : undefined}
                  aria-describedby={errors.describedBy(field)}
                  data-testid={`script-step-${index}`}
                />
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
    </div>
  );
}
